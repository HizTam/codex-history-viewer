import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ToolDisplayMode } from "./tools/toolTypes";

export type HistoryDateBasis = "started" | "lastActivity";
export type HistoryTitleSource = "generated" | "nativeWhenAvailable";
export type PreviewTooltipMode = "full" | "compact" | "titleOnly";
export type SearchIndexToolContent = "conversationOnly" | "toolCalls" | "toolCallsAndOutputs";
export type LongMessageFoldingMode = "off" | "auto" | "always";
export type ChatOpenPosition = "top" | "lastMessage" | "latest";
export type ChatPerformanceMode = "auto" | "normal" | "simplified";
export type ChatTurnTimelineMode = "off" | "basic" | "live";
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
  codexArchivedSessionsRoot: string;
  claudeSessionsRoot: string;
  enableCodexSource: boolean;
  enableCodexArchivedSessions: boolean;
  enableClaudeSource: boolean;
  handoffEnabled: boolean;
  fileChangeHistoryExplorerContextMenuEnabled: boolean;
  webviewRestoreAfterReload: boolean;
  previewOpenOnSelection: boolean;
  previewMaxMessages: number;
  previewTooltipMode: PreviewTooltipMode;
  searchMaxResults: number;
  searchCaseSensitive: boolean;
  searchIndexToolContent: SearchIndexToolContent;
  deleteUseTrash: boolean;
  resumeOpenTarget: "sidebar" | "panel";
  historyDateBasis: HistoryDateBasis;
  historyTitleSource: HistoryTitleSource;
  autoRefresh: AutoRefreshConfig;
  images: ImagesConfig;
  chatOpenPosition: ChatOpenPosition;
  chatPerformanceMode: ChatPerformanceMode;
  toolDisplayMode: ToolDisplayMode;
  userLongMessageFolding: LongMessageFoldingMode;
  assistantLongMessageFolding: LongMessageFoldingMode;
  stickyUserPrompt: boolean;
  chatTurnTimelineMode: ChatTurnTimelineMode;
  timeGuideEnabled: boolean;
}

function getDefaultSessionsRoot(): string {
  return path.join(os.homedir(), ".codex", "sessions");
}

function getDefaultCodexArchivedSessionsRoot(sessionsRoot: string): string {
  return path.join(path.dirname(path.resolve(sessionsRoot)), "archived_sessions");
}

function getDefaultClaudeSessionsRoot(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

function parseEnabledSources(value: unknown): {
  enableCodexSource: boolean;
  enableClaudeSource: boolean;
} {
  const list = Array.isArray(value) ? value.map((v) => String(v ?? "").trim().toLowerCase()) : [];
  const enableCodexSource = list.includes("codex");
  const enableClaudeSource = list.includes("claude");

  if (list.length === 0 || (!enableCodexSource && !enableClaudeSource)) {
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
  if (normalized === "latest") return "latest";
  return normalized === "lastmessage" ? "lastMessage" : "top";
}

function parseChatPerformanceMode(value: unknown): ChatPerformanceMode {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "normal" || normalized === "simplified") return normalized;
  return "auto";
}

function parseChatTurnTimelineMode(value: unknown): ChatTurnTimelineMode {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "basic" || normalized === "live") return normalized;
  return "off";
}

function parseImageThumbnailSize(value: unknown): ImageThumbnailSize {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "small" || normalized === "large") return normalized;
  return "medium";
}

function parsePreviewTooltipMode(value: unknown): PreviewTooltipMode {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "compact") return "compact";
  if (normalized === "titleonly") return "titleOnly";
  return "full";
}

function parseSearchIndexToolContent(value: unknown): SearchIndexToolContent {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "conversationonly") return "conversationOnly";
  if (normalized === "toolcalls") return "toolCalls";
  return "toolCallsAndOutputs";
}

function parseBoundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function getConfig(): CodexHistoryViewerConfig {
  const cfg = vscode.workspace.getConfiguration("codexHistoryViewer");
  const sessionsRootRaw = (cfg.get<string>("sessionsRoot") ?? "").trim();
  const sessionsRoot = sessionsRootRaw.length > 0 ? sessionsRootRaw : getDefaultSessionsRoot();
  const codexArchivedSessionsRootRaw = (
    cfg.get<string>("codex.archivedSessionsRoot") ??
    cfg.get<string>("codex.archivedSessions.root") ??
    ""
  ).trim();
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
  const chatPerformanceMode = parseChatPerformanceMode(cfg.get<string>("chat.performanceMode") ?? "auto");
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
  const codexArchivedSessionsEnabledSetting = cfg.get<boolean>("codex.archivedSessions.enabled") ?? false;

  return {
    sessionsRoot,
    codexArchivedSessionsRoot:
      codexArchivedSessionsRootRaw.length > 0
        ? codexArchivedSessionsRootRaw
        : getDefaultCodexArchivedSessionsRoot(sessionsRoot),
    claudeSessionsRoot: claudeSessionsRootRaw.length > 0 ? claudeSessionsRootRaw : getDefaultClaudeSessionsRoot(),
    enableCodexSource: enabledSources.enableCodexSource,
    enableCodexArchivedSessions: enabledSources.enableCodexSource && codexArchivedSessionsEnabledSetting,
    enableClaudeSource: enabledSources.enableClaudeSource,
    handoffEnabled: cfg.get<boolean>("handoff.enabled") ?? true,
    fileChangeHistoryExplorerContextMenuEnabled:
      cfg.get<boolean>("fileChangeHistory.explorerContextMenu.enabled") ?? false,
    webviewRestoreAfterReload: cfg.get<boolean>("webview.restoreAfterReload") ?? false,
    previewOpenOnSelection: cfg.get<boolean>("preview.openOnSelection") ?? true,
    previewMaxMessages: parseBoundedNumber(cfg.get<number>("preview.maxMessages"), 6, 1, 50),
    previewTooltipMode: parsePreviewTooltipMode(cfg.get<string>("preview.tooltipMode") ?? "full"),
    searchMaxResults: parseBoundedNumber(cfg.get<number>("search.maxResults"), 500, 1, 10_000),
    searchCaseSensitive: cfg.get<boolean>("search.caseSensitive") ?? false,
    searchIndexToolContent: parseSearchIndexToolContent(
      cfg.get<string>("search.indexToolContent") ?? "toolCallsAndOutputs",
    ),
    deleteUseTrash: cfg.get<boolean>("delete.useTrash") ?? true,
    resumeOpenTarget,
    historyDateBasis,
    historyTitleSource,
    autoRefresh,
    images,
    chatOpenPosition,
    chatPerformanceMode,
    toolDisplayMode,
    userLongMessageFolding,
    assistantLongMessageFolding,
    stickyUserPrompt: cfg.get<boolean>("chat.stickyUserPrompt") ?? true,
    chatTurnTimelineMode: parseChatTurnTimelineMode(cfg.get<string>("chat.turnTimeline.mode") ?? "off"),
    timeGuideEnabled: cfg.get<boolean>("ui.timeGuide.enabled") ?? false,
  };
}
