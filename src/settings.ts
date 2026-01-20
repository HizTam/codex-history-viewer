import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

// Reads configuration and normalizes values for internal use.
export interface CodexHistoryViewerConfig {
  sessionsRoot: string;
  previewOpenOnSelection: boolean;
  previewMaxMessages: number;
  searchMaxResults: number;
  searchCaseSensitive: boolean;
  deleteUseTrash: boolean;
}

function getDefaultSessionsRoot(): string {
  // Match Codex CLI's default directory across platforms (Windows/Mac/Linux).
  return path.join(os.homedir(), ".codex", "sessions");
}

export function getConfig(): CodexHistoryViewerConfig {
  const cfg = vscode.workspace.getConfiguration("codexHistoryViewer");
  const sessionsRootRaw = (cfg.get<string>("sessionsRoot") ?? "").trim();

  return {
    sessionsRoot: sessionsRootRaw.length > 0 ? sessionsRootRaw : getDefaultSessionsRoot(),
    previewOpenOnSelection: cfg.get<boolean>("preview.openOnSelection") ?? true,
    previewMaxMessages: cfg.get<number>("preview.maxMessages") ?? 6,
    searchMaxResults: cfg.get<number>("search.maxResults") ?? 500,
    searchCaseSensitive: cfg.get<boolean>("search.caseSensitive") ?? false,
    deleteUseTrash: cfg.get<boolean>("delete.useTrash") ?? true,
  };
}
