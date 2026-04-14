import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

export type HistoryDateBasis = "started" | "lastActivity";

export interface CodexHistoryViewerConfig {
  sessionsRoot: string;
  claudeSessionsRoot: string;
  enableCodexSource: boolean;
  enableClaudeSource: boolean;
  previewOpenOnSelection: boolean;
  previewMaxMessages: number;
  searchMaxResults: number;
  searchCaseSensitive: boolean;
  deleteUseTrash: boolean;
  resumeOpenTarget: "sidebar" | "panel";
  historyDateBasis: HistoryDateBasis;
}

function getDefaultSessionsRoot(): string {
  return path.join(os.homedir(), ".codex", "sessions");
}

function getDefaultClaudeSessionsRoot(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

function parseEnabledSources(value: unknown): { enableCodexSource: boolean; enableClaudeSource: boolean } {
  const list = Array.isArray(value) ? value.map((v) => String(v ?? "").trim().toLowerCase()) : [];
  const enableCodexSource = list.includes("codex");
  const enableClaudeSource = list.includes("claude");

  if (!enableCodexSource && !enableClaudeSource) {
    return { enableCodexSource: true, enableClaudeSource: true };
  }
  return { enableCodexSource, enableClaudeSource };
}

export function getConfig(): CodexHistoryViewerConfig {
  const cfg = vscode.workspace.getConfiguration("codexHistoryViewer");
  const sessionsRootRaw = (cfg.get<string>("sessionsRoot") ?? "").trim();
  const claudeSessionsRootRaw = (
    cfg.get<string>("claude.sessionsRoot") ??
    cfg.get<string>("claudeSessionsRoot") ??
    ""
  ).trim();
  const enabledSources = parseEnabledSources(cfg.get<unknown>("sources.enabled"));
  const resumeOpenTargetRaw = (cfg.get<string>("resume.openTarget") ?? "sidebar").trim().toLowerCase();
  const resumeOpenTarget: "sidebar" | "panel" = resumeOpenTargetRaw === "panel" ? "panel" : "sidebar";
  const historyDateBasisRaw = (cfg.get<string>("history.dateBasis") ?? "started").trim().toLowerCase();
  const historyDateBasis: HistoryDateBasis = historyDateBasisRaw === "lastactivity" ? "lastActivity" : "started";

  return {
    sessionsRoot: sessionsRootRaw.length > 0 ? sessionsRootRaw : getDefaultSessionsRoot(),
    claudeSessionsRoot: claudeSessionsRootRaw.length > 0 ? claudeSessionsRootRaw : getDefaultClaudeSessionsRoot(),
    enableCodexSource: enabledSources.enableCodexSource,
    enableClaudeSource: enabledSources.enableClaudeSource,
    previewOpenOnSelection: cfg.get<boolean>("preview.openOnSelection") ?? true,
    previewMaxMessages: cfg.get<number>("preview.maxMessages") ?? 6,
    searchMaxResults: cfg.get<number>("search.maxResults") ?? 500,
    searchCaseSensitive: cfg.get<boolean>("search.caseSensitive") ?? false,
    deleteUseTrash: cfg.get<boolean>("delete.useTrash") ?? true,
    resumeOpenTarget,
    historyDateBasis,
  };
}
