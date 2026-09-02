import * as path from "node:path";
import * as vscode from "vscode";
import type { CodexHistoryViewerConfig } from "../settings";
import type { HistoryIndex, SessionSummary } from "../sessions/sessionTypes";
import { t } from "../i18n";
import { normalizeCacheKey } from "../utils/fsUtils";
import { DayNode, MonthNode, SearchHitNode, SearchSessionNode, SessionNode, YearNode } from "../tree/treeNodes";
import type { PinStore } from "./pinStore";
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
}): Promise<DeleteSessionsResult | null> {
  const { element, selection, historyIndex, config, globalStorageUri } = params;

  const targets = selection && selection.length >= 1 ? selection : element ? [element] : [];
  const sessions = collectSessionsFromTargets(historyIndex, targets);
  if (sessions.length === 0) return null;
  const historyInventory = historyIndex.historySources ?? historyIndex.sessions;
  const historyBaseBlockers = findCodexHistoryDeletionBlockers(
    sessions,
    historyInventory,
  );
  if (historyBaseBlockers.length > 0) {
    void vscode.window.showErrorMessage(
      t("app.deleteHistoryBaseReferenced", historyBaseBlockers.length),
    );
    return null;
  }
  const deletionPlan = planCodexHistoryDeletionTargets(sessions, historyInventory);
  if (!deletionPlan) {
    void vscode.window.showErrorMessage(t("app.deleteHistoryBaseDependencyCycle"));
    return null;
  }

  const count = sessions.length;
  const confirmMsg = count === 1 ? t("app.deleteConfirmSingle") : t("app.deleteConfirmMulti", count);
  const choice = await vscode.window.showWarningMessage(confirmMsg, { modal: true }, "OK");
  if (choice !== "OK") return null;

  const useTrash = config.deleteUseTrash;
  const quarantineDir = vscode.Uri.joinPath(globalStorageUri, "deleted");
  const undoDir = vscode.Uri.joinPath(globalStorageUri, "undo-delete");
  await vscode.workspace.fs.createDirectory(quarantineDir);
  await vscode.workspace.fs.createDirectory(undoDir);

  let deleted = 0;
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
      deleted += 1;
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
  void vscode.window.showInformationMessage(t("app.deleteDone", deleted));
  return { deleted, undoItems };
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
