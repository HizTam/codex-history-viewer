import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ToolDisplayMode } from "./tools/toolTypes";

export type HistoryDateBasis = "started" | "lastActivity";
export type HistoryTitleSource = "generated" | "nativeWhenAvailable";
export type LongMessageFoldingMode = "off" | "auto" | "always";
export type ChatOpenPosition = "top" | "lastMessage";
export type ImageThumbnailSize = "small" | "medium" | "large";

export interface AutoRefreshConfig {
  enabled: boolean;
  debounceMs: number;
  minIntervalMs: number;
}

export interface ImagesConfig {
  enabled: boolean;
  maxSizeMB: number;
  thumbnailSize: ImageThumbnailSize;
}

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
  historyTitleSource: HistoryTitleSource;
  autoRefresh: AutoRefreshConfig;
  images: ImagesConfig;
  chatOpenPosition: ChatOpenPosition;
  toolDisplayMode: ToolDisplayMode;
  userLongMessageFolding: LongMessageFoldingMode;
  assistantLongMessageFolding: LongMessageFoldingMode;
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

function parseLongMessageFoldingMode(value: unknown): LongMessageFoldingMode {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "always" ? "always" : normalized === "auto" ? "auto" : "off";
}

function parseChatOpenPosition(value: unknown): ChatOpenPosition {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "lastmessage" ? "lastMessage" : "top";
}

function parseImageThumbnailSize(value: unknown): ImageThumbnailSize {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "small" || normalized === "large") return normalized;
  return "medium";
}

function parseBoundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
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
  const historyTitleSourceRaw = (cfg.get<string>("history.titleSource") ?? "generated").trim().toLowerCase();
  const historyTitleSource: HistoryTitleSource =
    historyTitleSourceRaw === "nativewhenavailable" ? "nativeWhenAvailable" : "generated";
  const chatOpenPosition = parseChatOpenPosition(cfg.get<string>("chat.openPosition") ?? "top");
  const toolDisplayModeRaw = (cfg.get<string>("chat.toolDisplayMode") ?? "detailsOnly").trim().toLowerCase();
  const toolDisplayMode: ToolDisplayMode = toolDisplayModeRaw === "compactcards" ? "compactCards" : "detailsOnly";
  const legacyLongMessageFolding = parseLongMessageFoldingMode(cfg.get<string>("chat.longMessageFolding") ?? "off");
  const userLongMessageFolding = parseLongMessageFoldingMode(
    cfg.get<string>("chat.userLongMessageFolding") ?? legacyLongMessageFolding,
  );
  const assistantLongMessageFolding = parseLongMessageFoldingMode(
    cfg.get<string>("chat.assistantLongMessageFolding") ?? legacyLongMessageFolding,
  );
  const autoRefresh: AutoRefreshConfig = {
    enabled: cfg.get<boolean>("autoRefresh.enabled") ?? false,
    debounceMs: parseBoundedNumber(cfg.get<number>("autoRefresh.debounceMs"), 2000, 500, 60_000),
    minIntervalMs: parseBoundedNumber(cfg.get<number>("autoRefresh.minIntervalMs"), 5000, 1000, 300_000),
  };
  const images: ImagesConfig = {
    enabled: cfg.get<boolean>("images.enabled") ?? true,
    maxSizeMB: parseBoundedNumber(cfg.get<number>("images.maxSizeMB"), 20, 1, 100),
    thumbnailSize: parseImageThumbnailSize(cfg.get<string>("images.thumbnailSize") ?? "medium"),
  };

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
    historyTitleSource,
    autoRefresh,
    images,
    chatOpenPosition,
    toolDisplayMode,
    userLongMessageFolding,
    assistantLongMessageFolding,
  };
}
