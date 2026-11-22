import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as vscode from "vscode";
import { t } from "../i18n";
import { getConfig } from "../settings";
import type { HistoryIndex, SessionSummary } from "../sessions/sessionTypes";
import type { HistoryService } from "../services/historyService";
import type { SessionMetadataMutationCoordinator } from "../services/sessionMetadataMutationCoordinator";
import { createSessionMetadataBackup, parseSessionMetadataBackup, previewSessionMetadataRestore, restoreSessionMetadata, SessionMetadataRestoreRollbackError, SessionMetadataRestoreStaleError, type SessionMetadataStores } from "../services/sessionMetadataBackupService";

const MAXIMUM_BYTES = 32 * 1024 * 1024;

export async function exportSessionMetadata(index: HistoryIndex, stores: SessionMetadataStores, sessions: readonly SessionSummary[], extensionVersion: string): Promise<void> {
  try {
    const backup = createSessionMetadataBackup(index, stores, sessions, extensionVersion);
    if (!parseSessionMetadataBackup(backup)) throw new Error("Invalid metadata backup.");
    const bytes = Buffer.from(JSON.stringify(backup, null, 2) + "\n", "utf8");
    if (bytes.byteLength > MAXIMUM_BYTES) throw new Error("Metadata backup exceeds its byte limit.");
    const destination = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(os.homedir(), "session-metadata.json")), filters: { JSON: ["json"] }, title: t("metadataBackup.exportTitle") });
    if (!destination) return;
    await vscode.workspace.fs.writeFile(destination, bytes);
    void vscode.window.showInformationMessage(t("metadataBackup.exported", sessions.length));
  } catch { void vscode.window.showErrorMessage(t("metadataBackup.exportFailed")); }
}

export async function importSessionMetadata(history: HistoryService, stores: SessionMetadataStores, coordinator: SessionMetadataMutationCoordinator, refresh: () => Promise<void>): Promise<void> {
  try {
    const selected = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { JSON: ["json"] }, title: t("metadataBackup.importTitle") });
    const uri = selected?.[0]; if (!uri) return;
    if (uri.scheme !== "file") throw new Error("Metadata must be a local file.");
    const handle = await fs.open(uri.fsPath, "r");
    let bytes: Buffer;
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > MAXIMUM_BYTES) throw new Error("Invalid metadata file.");
      const bounded = Buffer.alloc(MAXIMUM_BYTES + 1); let total = 0;
      while (total < bounded.length) {
        const read = await handle.read(bounded, total, bounded.length - total, null); if (!read.bytesRead) break; total += read.bytesRead;
      }
      const after = await handle.stat();
      if (total > MAXIMUM_BYTES || total !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Metadata changed while reading.");
      bytes = bounded.subarray(0, total);
    } finally { await handle.close(); }
    const backup = parseSessionMetadataBackup(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)) as unknown);
    if (!backup) throw new Error("Unsupported metadata backup.");
    await history.refresh({ forceRebuildCache: false });
    const index = history.getIndex();
    const isIndexCurrent = (): boolean => history.getIndex() === index && history.isCurrentIndexForConfig(getConfig());
    const preview = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t("metadataBackup.analyzing"), cancellable: true },
      (progress, token) => previewSessionMetadataRestore(backup, index, { stores, progress, token, isIndexCurrent }));
    if (!preview.matched) { void vscode.window.showInformationMessage(t("metadataBackup.noMatches", preview.unmatched, preview.ambiguous)); return; }
    const detail = [t("metadataBackup.confirm.sourcesWithAntigravity", preview.matchedCodex, preview.matchedClaude, preview.matchedAntigravity),
      t("metadataBackup.mergeChanges", preview.addedTags, preview.restoredNotes, preview.restoredTitles, preview.pinnedSessions, preview.hiddenSessions, preview.restoredBookmarks),
      t("metadataBackup.mergeUnavailable", preview.unmatched, preview.ambiguous, preview.invalidBookmarks), t("metadataBackup.mergeSafety")].join("\n\n");
    const action = { title: t("metadataBackup.mergeAction") };
    const choice = await vscode.window.showWarningMessage(t("metadataBackup.confirm.importTitle", preview.matched), { modal: true, detail }, action);
    if (choice !== action) return;
    // The restore rechecks the exact plan and current inventory under the metadata coordinator.
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t("metadataBackup.analyzing"), cancellable: true },
      (progress, token) => restoreSessionMetadata(backup, index, stores, { coordinator, progress, token, expectedPreview: preview, isIndexCurrent }));
    await refresh();
    void vscode.window.showInformationMessage(t("metadataBackup.restored", result.changedSessions, result.restoredBookmarks, result.unmatched, result.ambiguous));
  } catch (error) {
    if (error instanceof vscode.CancellationError) void vscode.window.showInformationMessage(t("metadataBackup.cancelled"));
    else if (error instanceof SessionMetadataRestoreStaleError) void vscode.window.showWarningMessage(t("metadataBackup.previewStale"));
    else if (error instanceof SessionMetadataRestoreRollbackError) void vscode.window.showErrorMessage(t("metadataBackup.rollbackFailed"));
    else void vscode.window.showErrorMessage(t("metadataBackup.restoreFailed"));
  }
}
