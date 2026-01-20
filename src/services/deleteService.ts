import * as path from "node:path";
import * as vscode from "vscode";
import type { CodexHistoryViewerConfig } from "../settings";
import type { HistoryIndex, SessionSummary } from "../sessions/sessionTypes";
import { t } from "../i18n";
import { normalizeCacheKey } from "../utils/fsUtils";
import { DayNode, MonthNode, SearchHitNode, SearchSessionNode, SessionNode, YearNode } from "../tree/treeNodes";
import type { PinStore } from "./pinStore";

// Handles deletion (single / multi-select / bulk). Defaults to moving files to the OS trash.

export async function deleteSessionsWithConfirmation(params: {
  element?: unknown;
  selection?: readonly unknown[];
  historyIndex: HistoryIndex;
  config: CodexHistoryViewerConfig;
  pinStore: PinStore;
  globalStorageUri: vscode.Uri;
}): Promise<void> {
  const { element, selection, historyIndex, config, globalStorageUri } = params;

  // In TreeView command execution, element may be undefined, so prefer selection when available.
  const targets = selection && selection.length >= 1 ? selection : element ? [element] : [];
  const sessions = collectSessionsFromTargets(historyIndex, targets);
  if (sessions.length === 0) return;

  const count = sessions.length;
  const confirmMsg = count === 1 ? t("app.deleteConfirmSingle") : t("app.deleteConfirmMulti", count);
  const choice = await vscode.window.showWarningMessage(confirmMsg, { modal: true }, "OK");
  if (choice !== "OK") return;

  const useTrash = config.deleteUseTrash;
  const quarantineDir = vscode.Uri.joinPath(globalStorageUri, "deleted");
  await vscode.workspace.fs.createDirectory(quarantineDir);

  let deleted = 0;
  for (const s of sessions) {
    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(s.fsPath), { recursive: false, useTrash });
      deleted += 1;
    } catch {
      // If moving to trash fails, move into the extension's quarantine folder (safer default).
      try {
        const base = path.basename(s.fsPath);
        const safeName = `${Date.now()}-${base}`;
        const dest = vscode.Uri.joinPath(quarantineDir, safeName);
        await vscode.workspace.fs.rename(vscode.Uri.file(s.fsPath), dest, { overwrite: false });
        deleted += 1;
      } catch {
        // rename may fail across volumes, so fall back to copy → delete.
        try {
          const base = path.basename(s.fsPath);
          const safeName = `${Date.now()}-${base}`;
          const dest = vscode.Uri.joinPath(quarantineDir, safeName);
          await vscode.workspace.fs.copy(vscode.Uri.file(s.fsPath), dest, { overwrite: false });
          await vscode.workspace.fs.delete(vscode.Uri.file(s.fsPath), { recursive: false, useTrash: false });
          deleted += 1;
        } catch {
          // Do not force permanent deletion here to avoid data loss.
        }
      }
    }
  }

  void vscode.window.showInformationMessage(t("app.deleteDone", deleted));
}

function collectSessionsFromTargets(index: HistoryIndex, targets: readonly unknown[]): SessionSummary[] {
  // Collect sessions and deduplicate by cache key.
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
