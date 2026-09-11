import * as path from "node:path";
import * as vscode from "vscode";
import type { CodexHistoryViewerConfig } from "../settings";
import type { HistoryIndex, SessionSummary } from "../sessions/sessionTypes";
import { t } from "../i18n";
import { normalizeCacheKey } from "../utils/fsUtils";
import { DayNode, MonthNode, SearchHitNode, SearchSessionNode, SessionNode, YearNode } from "../tree/treeNodes";
import type { PinStore } from "./pinStore";
import {
  areCodexRolloutRevisionsRelated,
  collectCodexRolloutDeletionTargets,
  findSessionHistorySource,
} from "../sessions/codexRolloutRevisions";
import {
  findCodexHistoryDeletionBlockers,
  planCodexHistoryDeletionTargets,
} from "../sessions/codexHistoryBase";

export interface DeletedSessionUndoItem {
  originalFsPath: string;
  backupFsPath: string | null;
  restorePrerequisiteFsPaths?: readonly string[];
}

export interface DeleteSessionsResult {
  deleted: number;
  affected?: number;
  undoItems: DeletedSessionUndoItem[];
}

export async function cleanupDeletedSessionUndoBackups(
  undoItems: readonly DeletedSessionUndoItem[],
  options: { requireOriginalExists?: boolean } = {},
): Promise<void> {
  const seenBackups = new Set<string>();
  for (const item of undoItems) {
    const backupFsPath = typeof item.backupFsPath === "string" ? item.backupFsPath.trim() : "";
    if (!backupFsPath) continue;

    const backupKey = normalizeCacheKey(backupFsPath);
    if (seenBackups.has(backupKey)) continue;
    seenBackups.add(backupKey);

    if (options.requireOriginalExists && !(await fileExists(item.originalFsPath))) continue;

    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(backupFsPath), { recursive: false, useTrash: false });
    } catch {
      // Ignore cleanup failures; the manual trash cleanup command can remove leftovers.
    }
  }
}

// Handles deletion (single / multi-select / bulk). Returns undo metadata when possible.
export async function deleteSessionsWithConfirmation(params: {
  element?: unknown;
  selection?: readonly unknown[];
  historyIndex: HistoryIndex;
  config: CodexHistoryViewerConfig;
  pinStore: PinStore;
  globalStorageUri: vscode.Uri;
  refreshHistoryIndex?: () => Promise<HistoryIndex>;
}): Promise<DeleteSessionsResult | null> {
  const { element, selection, historyIndex, config, globalStorageUri } = params;

  const targets = selection && selection.length >= 1 ? selection : element ? [element] : [];
  const selected = collectSessionsFromTargets(historyIndex, targets).flatMap((session) => {
    const current = findSessionHistorySource(historyIndex, session.cacheKey);
    return current?.identityKey === session.identityKey ? [current] : [];
  });
  if (selected.length === 0) return null;
  let historyInventory = historyIndex.historySources ?? historyIndex.sessions;
  let sessions = collectCodexRolloutDeletionTargets(selected, historyInventory);
  const count = selected.length;
  const includesRevisions = sessions.length > count;
  let deletionPlan = includesRevisions ? undefined : createDeletionPlan(sessions, historyInventory);
  if (!includesRevisions && !deletionPlan) return null;
  const scope = await confirmDeletionScope(count, includesRevisions);
  if (!scope) return null;
  if (scope === "selected") sessions = selected;
  deletionPlan ??= createDeletionPlan(sessions, historyInventory);
  if (!deletionPlan) return null;

  if (params.refreshHistoryIndex) {
    try {
      const refreshed = await params.refreshHistoryIndex();
      const nextSelected = selected.flatMap((session) => {
        const current = findSessionHistorySource(refreshed, session.cacheKey);
        return current?.identityKey === session.identityKey ? [current] : [];
      });
      if (nextSelected.length !== selected.length) {
        throw new Error("The selected history changed.");
      }
      const nextInventory = refreshed.historySources ?? refreshed.sessions;
      const nextSessions = scope === "conversation"
        ? collectCodexRolloutDeletionTargets(nextSelected, nextInventory) : nextSelected;
      // A newly created revision or changed dependency was not part of the user's confirmation.
      if (deletionTargetSignature(nextSessions) !== deletionTargetSignature(sessions) ||
        findCodexHistoryDeletionBlockers(nextSessions, nextInventory).length > 0) {
        throw new Error("The confirmed history changed.");
      }
      const nextPlan = planCodexHistoryDeletionTargets(nextSessions, nextInventory);
      if (!nextPlan) throw new Error("The confirmed dependencies changed.");
      sessions = nextSessions;
      historyInventory = nextInventory;
      deletionPlan = nextPlan;
    } catch {
      void vscode.window.showErrorMessage(t("app.deleteHistoryChanged"));
      return null;
    }
  }

  const useTrash = config.deleteUseTrash;
  const quarantineDir = vscode.Uri.joinPath(globalStorageUri, "deleted");
  const undoDir = vscode.Uri.joinPath(globalStorageUri, "undo-delete");
  await vscode.workspace.fs.createDirectory(quarantineDir);
  await vscode.workspace.fs.createDirectory(undoDir);

  let dependencyBlocked = 0;
  const failedOrSkippedKeys = new Set<string>();
  const targetPathByKey = new Map(
    deletionPlan.orderedTargets.map((session) => [session.cacheKey, session.fsPath] as const),
  );
  const undoItems: DeletedSessionUndoItem[] = [];
  for (const s of deletionPlan.orderedTargets) {
    const dependencyKeys = deletionPlan.dependencyKeysByTarget.get(s.cacheKey) ?? [];
    let dependencyFailed = false;
    for (const cacheKey of dependencyKeys) {
      if (!failedOrSkippedKeys.has(cacheKey)) continue;
      dependencyFailed = true;
      break;
    }
    if (dependencyFailed) {
      failedOrSkippedKeys.add(s.cacheKey);
      dependencyBlocked += 1;
      continue;
    }
    const backupFsPath = await backupForUndo(undoDir, s.fsPath);

    let removed = false;
    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(s.fsPath), { recursive: false, useTrash });
      removed = true;
    } catch {
      // If moving to trash fails, move into quarantine as a safe fallback.
      try {
        const base = path.basename(s.fsPath);
        const safeName = `${Date.now()}-${base}`;
        const dest = vscode.Uri.joinPath(quarantineDir, safeName);
        await vscode.workspace.fs.rename(vscode.Uri.file(s.fsPath), dest, { overwrite: false });
        removed = true;
      } catch {
        try {
          const base = path.basename(s.fsPath);
          const safeName = `${Date.now()}-${base}`;
          const dest = vscode.Uri.joinPath(quarantineDir, safeName);
          await vscode.workspace.fs.copy(vscode.Uri.file(s.fsPath), dest, { overwrite: false });
          await vscode.workspace.fs.delete(vscode.Uri.file(s.fsPath), { recursive: false, useTrash: false });
          removed = true;
        } catch {
          // Keep the original file when all fallback paths fail.
        }
      }
    }

    if (removed) {
      const restorePrerequisiteFsPaths = Array.from(
        deletionPlan.restorePrerequisiteKeysByTarget.get(s.cacheKey) ?? [],
      ).flatMap((cacheKey) => {
        const fsPath = targetPathByKey.get(cacheKey);
        return fsPath ? [fsPath] : [];
      });
      undoItems.push({
        originalFsPath: s.fsPath,
        backupFsPath,
        ...(restorePrerequisiteFsPaths.length > 0 ? { restorePrerequisiteFsPaths } : {}),
      });
    } else {
      failedOrSkippedKeys.add(s.cacheKey);
    }
  }

  if (dependencyBlocked > 0) {
    void vscode.window.showErrorMessage(
      t("app.deleteHistoryBaseDeleteBlocked", dependencyBlocked),
    );
  }
  const removedKeys = new Set(undoItems.map((item) => normalizeCacheKey(item.originalFsPath)));
  const selectedByIdentity = new Map<string, SessionSummary[]>();
  for (const session of selected) {
    const family = selectedByIdentity.get(session.identityKey) ?? [];
    family.push(session);
    selectedByIdentity.set(session.identityKey, family);
  }
  const failedSelections = new Set<string>();
  const affectedSelections = new Set<string>();
  for (const target of sessions) {
    for (const session of selectedByIdentity.get(target.identityKey) ?? []) {
      if (target.cacheKey !== session.cacheKey &&
        !areCodexRolloutRevisionsRelated(session, target, historyInventory)) continue;
      if (removedKeys.has(target.cacheKey)) affectedSelections.add(session.cacheKey);
      else failedSelections.add(session.cacheKey);
    }
  }
  const deleted = selected.filter((session) => !failedSelections.has(session.cacheKey)).length;
  const affected = affectedSelections.size;
  if (deleted < count) void vscode.window.showErrorMessage(t("app.deleteIncomplete", count - deleted));
  else void vscode.window.showInformationMessage(t("app.deleteDone", deleted));
  return { deleted, affected, undoItems };
}

async function confirmDeletionScope(count: number, includesRevisions: boolean): Promise<"selected" | "conversation" | null> {
  if (!includesRevisions) {
    const message = count === 1 ? t("app.deleteConfirmSingle") : t("app.deleteConfirmMulti", count);
    return await vscode.window.showWarningMessage(message, { modal: true }, "OK") === "OK" ? "selected" : null;
  }
  const selectedLabel = count === 1 ? t("app.deleteThisHistoryOnly") : t("app.deleteSelectedHistoriesOnly");
  const allLabel = t("app.deleteAllRevisions");
  const message = count === 1 ? t("app.deleteConfirmSingleWithRevisions") : t("app.deleteConfirmMultiWithRevisions", count);
  const choice = await vscode.window.showWarningMessage(message, {
    modal: true,
    detail: t("app.deleteRevisionScopeDetail"),
  }, selectedLabel, allLabel);
  return choice === selectedLabel ? "selected" : choice === allLabel ? "conversation" : null;
}

function createDeletionPlan(sessions: readonly SessionSummary[], inventory: readonly SessionSummary[]) {
  const blockers = findCodexHistoryDeletionBlockers(sessions, inventory);
  if (blockers.length > 0) {
    void vscode.window.showErrorMessage(t("app.deleteHistoryBaseReferenced", blockers.length));
    return undefined;
  }
  const plan = planCodexHistoryDeletionTargets(sessions, inventory);
  if (!plan) void vscode.window.showErrorMessage(t("app.deleteHistoryBaseDependencyCycle"));
  return plan;
}

function deletionTargetSignature(sessions: readonly SessionSummary[]): string {
  return JSON.stringify(sessions.map((session) => [session.cacheKey, session.identityKey,
    session.storage.rootKind, session.storage.archiveState, normalizeCacheKey(session.storage.rootPath),
    session.meta.codexHistoryBase, session.meta.codexStandaloneHistory]).sort((left, right) =>
    String(left[0]).localeCompare(String(right[0])),
  ));
}

async function backupForUndo(undoDir: vscode.Uri, originalFsPath: string): Promise<string | null> {
  const base = path.basename(originalFsPath);
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const backupFsPath = path.join(undoDir.fsPath, `${stamp}-${base}`);
  try {
    await vscode.workspace.fs.copy(vscode.Uri.file(originalFsPath), vscode.Uri.file(backupFsPath), { overwrite: false });
    return backupFsPath;
  } catch {
    return null;
  }
}

async function fileExists(fsPath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
    return true;
  } catch {
    return false;
  }
}

function collectSessionsFromTargets(index: HistoryIndex, targets: readonly unknown[]): SessionSummary[] {
  const byKey = new Map<string, SessionSummary>();

  for (const target of targets) {
    for (const s of collectSessionsFromTarget(index, target)) {
      byKey.set(normalizeCacheKey(s.fsPath), s);
    }
  }

  return Array.from(byKey.values());
}

function collectSessionsFromTarget(index: HistoryIndex, target: unknown): SessionSummary[] {
  if (target instanceof SessionNode) return [target.session];
  if (target instanceof SearchSessionNode) return [target.session];
  if (target instanceof SearchHitNode) return [target.session];
  if (target instanceof DayNode) {
    const list = index.byY.get(target.year)?.get(target.month)?.get(target.day) ?? [];
    return list.slice();
  }
  if (target instanceof MonthNode) {
    const days = index.byY.get(target.year)?.get(target.month);
    if (!days) return [];
    const out: SessionSummary[] = [];
    for (const [, list] of days) out.push(...list);
    return out;
  }
  if (target instanceof YearNode) {
    const months = index.byY.get(target.year);
    if (!months) return [];
    const out: SessionSummary[] = [];
    for (const [, days] of months) {
      for (const [, list] of days) out.push(...list);
    }
    return out;
  }
  return [];
}
