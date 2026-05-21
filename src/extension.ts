import * as path from "node:path";
import * as vscode from "vscode";
import { resolveUiLanguage, t } from "./i18n";
import { getConfig, type CodexHistoryViewerConfig } from "./settings";
import { HistoryService } from "./services/historyService";
import type { ArchiveLocationFilter, SessionSourceFilter, SessionSummary } from "./sessions/sessionTypes";
import { PinnedTreeDataProvider } from "./tree/pinnedTree";
import { HistoryTreeDataProvider, type HistoryViewMode } from "./tree/historyTree";
import { SearchTreeDataProvider } from "./tree/searchTree";
import { TranscriptContentProvider } from "./transcript/transcriptProvider";
import { TranscriptDocumentLinkProvider } from "./transcript/transcriptDocumentLinkProvider";
import { renderResumeContext } from "./transcript/resumeRenderer";
import { promoteSessionCopyToToday } from "./services/promoteService";
import {
  archiveSessionToArchived,
  moveSessionFileNoOverwrite,
  restoreArchivedSessionToActive,
} from "./services/restoreArchivedSessionService";
import { cleanupDeletedSessionUndoBackups, deleteSessionsWithConfirmation } from "./services/deleteService";
import { PinStore, type PinEntry } from "./services/pinStore";
import { BookmarkStore, type BookmarkEntry } from "./services/bookmarkStore";
import { type SearchRequest, runSearchFlow } from "./services/searchService";
import { type IndexedSearchRole, SearchIndexService } from "./services/searchIndexService";
import { exportMaskedTranscripts, exportSessions, importSessions } from "./services/importExportService";
import { SearchPresetStore } from "./services/searchPresetStore";
import { SessionAnnotationStore } from "./services/sessionAnnotationStore";
import {
  getMaxCustomTitleLength,
  isCustomTitleTooLong,
  normalizeCustomTitle,
  SessionTitleOverrideStore,
} from "./services/sessionTitleOverrideStore";
import { AutoRefreshService } from "./services/autoRefreshService";
import { ChatOpenPositionStore } from "./services/chatOpenPositionStore";
import { SessionReferenceRelocator } from "./services/sessionReferenceRelocator";
import { formatDebugFields, safeDebugBasename, sanitizeDebugError } from "./services/debugLogUtils";
import { type UndoCleanupReason, type UndoPostRefreshMode, UndoService } from "./services/undoService";
import { OutputChannelLogger } from "./services/logger";
import {
  type StorageStats,
  collectStorageStats,
  emptyTrashAndCleanupLegacy,
  listLegacyFiles,
} from "./services/storageMaintenanceService";
import {
  type HandoffResult,
  type HandoffTarget,
  buildHandoffPrompt,
  cleanupHandoffs,
  createHandoff,
  resolveHandoffLocation,
} from "./services/handoffService";
import type { TreeNode } from "./tree/treeNodes";
import { DayNode, MissingPinnedNode, MonthNode, SearchHitNode, YearNode, isSessionNode } from "./tree/treeNodes";
import {
  ControlTreeDataProvider,
  StatusTreeDataProvider,
} from "./tree/utilityTrees";
import { ChatPanelManager } from "./chat/chatPanelManager";
import { FileChangeHistoryPanelManager } from "./fileHistory/fileChangeHistoryPanelManager";
import { FileChangeHistoryService } from "./fileHistory/fileChangeHistoryService";
import { getDateScopeValue, sanitizeDateScope, type DateScope } from "./types/dateScope";
import { resolveDateTimeSettings } from "./utils/dateTimeSettings";
import { safeDisplayPath } from "./utils/textUtils";
import { normalizeCacheKey, pathExists } from "./utils/fsUtils";

const SEARCH_ROLE_ORDER: IndexedSearchRole[] = ["user", "assistant", "developer", "tool"];

// Extension entry point. Initializes core services and tree views.
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const config = getConfig();
  const HISTORY_FILTER_KEY = "codexHistoryViewer.historyFilter.v1";
  const HISTORY_VIEW_MODE_KEY = "codexHistoryViewer.historyViewMode.v1";
  const HISTORY_PROJECT_FILTER_KEY = "codexHistoryViewer.historyProjectFilter.v1";
  const HISTORY_SOURCE_FILTER_KEY = "codexHistoryViewer.historySourceFilter.v1";
  const HISTORY_TAG_FILTER_KEY = "codexHistoryViewer.historyTagFilter.v1";
  const PINNED_TAG_FILTER_KEY = "codexHistoryViewer.pinnedTagFilter.v1";
  const SEARCH_TAG_FILTER_KEY = "codexHistoryViewer.searchTagFilter.v1";
  const LAST_SEARCH_REQUEST_KEY = "codexHistoryViewer.lastSearchRequest.v1";
  const ARCHIVE_LOCATION_FILTER_KEY = "codexHistoryViewer.archiveLocationFilter.v1";
  const LEGACY_SHOW_ARCHIVED_SESSIONS_KEY = "codexHistoryViewer.showArchivedSessions.v1";
  const SEARCH_DEFAULT_ROLES_CONFIG = "search.defaultRoles";
  let archiveLocationFilter: ArchiveLocationFilter = sanitizeArchiveLocationFilter(
    context.workspaceState.get(ARCHIVE_LOCATION_FILTER_KEY),
    context.workspaceState.get(LEGACY_SHOW_ARCHIVED_SESSIONS_KEY),
  );

  const updateUiLanguageContext = (): void => {
    // Keep the UI language context up to date for menu visibility switching.
    // The value is fixed to "ja"/"en" because package.json `when` clauses depend on it.
    const lang = resolveUiLanguage();
    void vscode.commands.executeCommand("setContext", "codexHistoryViewer.uiLang", lang);
  };
  updateUiLanguageContext();
  const updateHandoffMenuContext = (): void => {
    const latestConfig = getConfig();
    void vscode.commands.executeCommand("setContext", "codexHistoryViewer.handoffEnabled", latestConfig.handoffEnabled);
    void vscode.commands.executeCommand(
      "setContext",
      "codexHistoryViewer.codexToClaudeHandoffEnabled",
      latestConfig.handoffEnabled && latestConfig.enableCodexSource && latestConfig.enableClaudeSource,
    );
  };
  updateHandoffMenuContext();
  const updateArchivedSessionsContext = (): void => {
    const latestConfig = getConfig();
    const showArchivedSessions = archiveLocationFilter !== "activeOnly";
    void vscode.commands.executeCommand(
      "setContext",
      "codexHistoryViewer.codexArchivedSessionsEnabled",
      latestConfig.enableCodexArchivedSessions,
    );
    void vscode.commands.executeCommand(
      "setContext",
      "codexHistoryViewer.codexSourceConfigured",
      latestConfig.enableCodexSource,
    );
    void vscode.commands.executeCommand(
      "setContext",
      "codexHistoryViewer.archiveLocationFilter",
      archiveLocationFilter,
    );
    void vscode.commands.executeCommand(
      "setContext",
      "codexHistoryViewer.showArchivedSessions",
      showArchivedSessions,
    );
    void vscode.commands.executeCommand(
      "setContext",
      "codexHistoryViewer.archivedOnly",
      archiveLocationFilter === "archivedOnly",
    );
  };
  updateArchivedSessionsContext();

  const pinStore = new PinStore(context.globalState);
  const bookmarkStore = new BookmarkStore(context.globalState);
  const annotationStore = new SessionAnnotationStore(context.globalState);
  const titleOverrideStore = new SessionTitleOverrideStore(context.globalState);
  const searchPresetStore = new SearchPresetStore(context.globalState);
  const chatOpenPositionStore = new ChatOpenPositionStore(context.globalState);
  const logger = new OutputChannelLogger();
  const sessionReferenceRelocator = new SessionReferenceRelocator(
    annotationStore,
    bookmarkStore,
    chatOpenPositionStore,
    logger,
  );
  context.subscriptions.push(logger);
  const historyService = new HistoryService(context.globalStorageUri, config, titleOverrideStore, logger);
  const searchIndexService = new SearchIndexService(context.globalStorageUri, logger);
  const transcriptProvider = new TranscriptContentProvider(historyService, annotationStore);
  const chatPanels = new ChatPanelManager(
    context.extensionUri,
    historyService,
    annotationStore,
    pinStore,
    bookmarkStore,
    chatOpenPositionStore,
    async () => {
      await vscode.commands.executeCommand("codexHistoryViewer.refresh");
    },
    logger,
  );
  const fileChangeHistoryService = new FileChangeHistoryService();
  const fileChangeHistoryPanels = new FileChangeHistoryPanelManager(
    context.extensionUri,
    historyService,
    searchIndexService,
    fileChangeHistoryService,
    chatPanels,
    bookmarkStore,
    logger,
  );
  context.subscriptions.push(bookmarkStore, fileChangeHistoryPanels);
  let storageStats: StorageStats = {
    globalStorageBytes: 0,
    trashFileCount: 0,
    trashBytes: 0,
    handoffCount: 0,
    handoffBytes: 0,
  };
  const refreshStorageStats = async (): Promise<void> => {
    storageStats = await collectStorageStats(context.globalStorageUri);
  };
  let lastSearchRequest: SearchRequest | null = sanitizeSearchRequest(context.workspaceState.get(LAST_SEARCH_REQUEST_KEY));
  const getConfiguredDefaultSearchRoles = (): IndexedSearchRole[] => {
    const raw = vscode.workspace.getConfiguration("codexHistoryViewer").get<unknown>(SEARCH_DEFAULT_ROLES_CONFIG);
    return sanitizeIndexedSearchRoles(raw);
  };
  const persistLastSearchRequest = async (value: SearchRequest | null): Promise<void> => {
    // Persist the latest criteria so the search pane can rerun searches on refresh.
    lastSearchRequest = value;
    await context.workspaceState.update(LAST_SEARCH_REQUEST_KEY, value);
  };
  const undoService = new UndoService((canUndo) => {
    void vscode.commands.executeCommand("setContext", "codexHistoryViewer.canUndo", canUndo);
  });
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.canUndo", false);
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.hasSearchResults", false);
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.historyTagFiltered", false);
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.historyViewMode", "date");
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.pinnedTagFiltered", false);
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.searchTagFiltered", false);
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.sourceCodexEnabled", true);
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.sourceClaudeEnabled", true);
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.historySourceSwitchable", true);
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.hasMultiSelection", false);
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.hasMultiSessionSelection", false);
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.canArchiveSelection", false);
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.canRestoreArchivedSelection", false);
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.hasMixedArchiveSelection", false);

  let pinnedTagFilter: string[] = sanitizeTagFilter(context.workspaceState.get(PINNED_TAG_FILTER_KEY));
  let historyViewMode: HistoryViewMode = sanitizeHistoryViewMode(context.workspaceState.get(HISTORY_VIEW_MODE_KEY));
  let historyFilter: DateScope = sanitizeDateScope(context.workspaceState.get(HISTORY_FILTER_KEY));
  let historyProjectCwd: string | null = sanitizeProjectCwd(context.workspaceState.get(HISTORY_PROJECT_FILTER_KEY));
  let historySourceFilter: SessionSourceFilter = resolveConstrainedHistorySourceFilter(
    sanitizeHistorySourceFilter(context.workspaceState.get(HISTORY_SOURCE_FILTER_KEY)),
    config,
  );
  let historyTagFilter: string[] = sanitizeTagFilter(context.workspaceState.get(HISTORY_TAG_FILTER_KEY));
  let searchTagFilter: string[] = sanitizeTagFilter(context.workspaceState.get(SEARCH_TAG_FILTER_KEY));
  const pinnedProvider = new PinnedTreeDataProvider(
    historyService,
    pinStore,
    annotationStore,
    historySourceFilter,
    pinnedTagFilter,
    historySourceFilter === "claude" ? "all" : archiveLocationFilter,
    context.extensionUri,
  );
  const historyProvider = new HistoryTreeDataProvider(
    historyService,
    pinStore,
    annotationStore,
    historyViewMode,
    historyFilter,
    historyProjectCwd,
    historySourceFilter,
    historyTagFilter,
    historySourceFilter === "claude" ? "all" : archiveLocationFilter,
    context.extensionUri,
  );
  const searchProvider = new SearchTreeDataProvider(
    pinStore,
    annotationStore,
    historySourceFilter === "claude" ? "all" : archiveLocationFilter,
    context.extensionUri,
  );
  let lastHistoryRefreshAt: number | null = null;

  const resolveEffectiveArchiveLocationFilter = (): ArchiveLocationFilter =>
    historySourceFilter === "claude" ? "all" : archiveLocationFilter;

  const syncArchiveLocationFilterToProviders = (): void => {
    const effectiveArchiveLocationFilter = resolveEffectiveArchiveLocationFilter();
    pinnedProvider.setArchiveLocationFilter(effectiveArchiveLocationFilter);
    historyProvider.setArchiveLocationFilter(effectiveArchiveLocationFilter);
    searchProvider.setArchiveLocationFilter(effectiveArchiveLocationFilter);
  };

  const isCodexSourceEnabled = (sourceFilter: SessionSourceFilter): boolean =>
    sourceFilter === "all" || sourceFilter === "codex";

  const isClaudeSourceEnabled = (sourceFilter: SessionSourceFilter): boolean =>
    sourceFilter === "all" || sourceFilter === "claude";

  const constrainHistorySourceFilter = (sourceFilter: SessionSourceFilter): SessionSourceFilter =>
    resolveConstrainedHistorySourceFilter(sourceFilter, getConfig());

  const isHistorySourceSwitchable = (): boolean => resolveLockedHistorySource(getConfig()) === null;

  const getHistorySourceOptionsForPrompt = (): SessionSourceFilter[] => {
    const cfg = getConfig();
    const locked = resolveLockedHistorySource(cfg);
    if (locked) return [locked];
    const out: SessionSourceFilter[] = ["all"];
    if (cfg.enableCodexSource || cfg.enableCodexArchivedSessions) out.push("codex");
    if (cfg.enableClaudeSource) out.push("claude");
    return out;
  };

  const buildSourceFilterSummary = (): string => {
    if (historySourceFilter === "all") return "";
    const sourceLabel =
      historySourceFilter === "codex" ? t("history.filter.source.codex") : t("history.filter.source.claude");
    return t("history.filter.sourceLabel", sourceLabel);
  };

  const buildArchiveLocationFilterSummary = (): string => {
    if (historySourceFilter === "claude") return "";
    if (archiveLocationFilter === "activeOnly") return "";
    return t("archiveLocation.summary", getArchiveLocationLabel(archiveLocationFilter));
  };

  const buildHistoryFilterSummary = (): string => {
    const parts: string[] = [];
    const dateValue = getDateScopeValue(historyFilter);
    if (dateValue) parts.push(dateValue);
    if (historyProjectCwd) parts.push(t("history.filter.projectLabel", safeDisplayPath(historyProjectCwd, 60)));
    const sourceSummary = buildSourceFilterSummary();
    if (sourceSummary) parts.push(sourceSummary);
    const archiveLocationSummary = buildArchiveLocationFilterSummary();
    if (archiveLocationSummary) parts.push(archiveLocationSummary);
    if (historyTagFilter.length > 0) parts.push(`tags: ${historyTagFilter.map((tag) => `#${tag}`).join(", ")}`);
    return parts.join(" / ");
  };

  const resolvePinnedEntrySource = (
    fsPath: string,
    cfg: CodexHistoryViewerConfig,
  ): "codex" | "claude" | null => {
    const session = historyService.findByFsPath(fsPath);
    if (session) return session.source;

    if (isPathInsideRoot(fsPath, cfg.sessionsRoot)) return "codex";
    if (isPathInsideRoot(fsPath, cfg.codexArchivedSessionsRoot)) return "codex";
    if (isPathInsideRoot(fsPath, cfg.claudeSessionsRoot)) return "claude";

    const base = path.basename(fsPath).toLowerCase();
    if (base.startsWith("rollout-")) return "codex";
    if (base.endsWith(".jsonl")) return "claude";
    return null;
  };

  const isSourceEnabledInConfig = (
    source: "codex" | "claude" | null,
    cfg: CodexHistoryViewerConfig,
  ): boolean => {
    if (source === "codex") return cfg.enableCodexSource || cfg.enableCodexArchivedSessions;
    if (source === "claude") return cfg.enableClaudeSource;
    return false;
  };

  const isArchivedPinEntry = (pin: PinEntry, cfg: CodexHistoryViewerConfig): boolean => {
    if (pin.archiveState === "archived") return true;
    if (pin.rootKind === "codexArchivedSessions") return true;
    return isPathInsideRoot(pin.fsPath, cfg.codexArchivedSessionsRoot);
  };

  const isPinVisibleInStatus = (pin: PinEntry, cfg: CodexHistoryViewerConfig): boolean => {
    if (isArchivedPinEntry(pin, cfg) && !cfg.enableCodexArchivedSessions) return false;
    const source = resolvePinnedEntrySource(pin.fsPath, cfg);
    return isSourceEnabledInConfig(source, cfg);
  };

  const countEnabledPins = (cfg: CodexHistoryViewerConfig): { pinCount: number; missingPinCount: number } => {
    const pins = pinStore.getAll();
    let pinCount = 0;
    let missingPinCount = 0;

    for (const p of pins) {
      if (!isPinVisibleInStatus(p, cfg)) continue;
      pinCount += 1;
      if (!historyService.findByFsPath(p.fsPath)) missingPinCount += 1;
    }

    return { pinCount, missingPinCount };
  };

  const controlProvider = new ControlTreeDataProvider(context.extensionUri);
  const resolveStatusCurrentProjectCwd = (): string | null => {
    if (historyProjectCwd) return historyProjectCwd;
    const folder = resolveCurrentWorkspaceFolder();
    return folder?.uri.fsPath ?? null;
  };
  const resolveStatusCurrentSearchRoles = (): IndexedSearchRole[] => {
    // The status pane displays the currently configured default search roles.
    return getConfiguredDefaultSearchRoles();
  };
  const statusProvider = new StatusTreeDataProvider(() => {
    const cfg = getConfig();
    const sessions = historyService.getIndex().sessions;
    const codexSessionCount = sessions.filter((s) => s.source === "codex" && s.storage.archiveState === "active").length;
    const codexArchivedSessionCount = sessions.filter((s) => s.source === "codex" && s.storage.archiveState === "archived").length;
    const claudeSessionCount = sessions.filter((s) => s.source === "claude").length;
    const pinCounters = countEnabledPins(cfg);

    return {
      enableCodexSource: cfg.enableCodexSource,
      enableCodexArchivedSessions: cfg.enableCodexArchivedSessions,
      enableClaudeSource: cfg.enableClaudeSource,
      codexSessionCount,
      codexArchivedSessionCount,
      claudeSessionCount,
      pinCount: pinCounters.pinCount,
      missingPinCount: pinCounters.missingPinCount,
      presetCount: searchPresetStore.getAll().length,
      totalTagCount: annotationStore.listTagStats().length,
      storageBytes: storageStats.globalStorageBytes,
      trashCount: storageStats.trashFileCount,
      handoffCount: storageStats.handoffCount,
      handoffBytes: storageStats.handoffBytes,
      searchHitCount: searchProvider.root ? searchProvider.visibleTotalHits : 0,
      currentSearchRoles: resolveStatusCurrentSearchRoles(),
      currentSearchTagFilter: searchTagFilter,
      filterSummary: buildHistoryFilterSummary(),
      currentProjectCwd: resolveStatusCurrentProjectCwd(),
      codexSessionsRoot: cfg.sessionsRoot,
      codexArchivedSessionsRoot: cfg.codexArchivedSessionsRoot,
      claudeSessionsRoot: cfg.claudeSessionsRoot,
      lastRefreshAt: lastHistoryRefreshAt,
      extensionVersion: resolveExtensionVersion(context),
    };
  });
  // Provide a virtual document (conversation log).
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(transcriptProvider.scheme, transcriptProvider),
    vscode.languages.registerDocumentLinkProvider(
      { scheme: transcriptProvider.scheme },
      new TranscriptDocumentLinkProvider(transcriptProvider.scheme),
    ),
  );

  const URI_LIST_MIME = "text/uri-list";
  const OPEN_MULTI_LIMIT = 10;
  const MAX_DND_ITEMS = 500;
  const RESUME_MAX_MESSAGES = 20;
  const RESUME_MAX_CHARS = 25_000;
  const OPENAI_CODEX_EXTENSION_ID = "openai.chatgpt";
  const OPENAI_CODEX_CUSTOM_EDITOR_VIEW_TYPE = "chatgpt.conversationEditor";
  const OPENAI_CODEX_URI_SCHEME = "openai-codex";
  const OPENAI_CODEX_URI_AUTHORITY = "route";
  const OPENAI_CODEX_OPEN_SIDEBAR_COMMAND = "chatgpt.openSidebar";
  const OPENAI_CODEX_NEW_CHAT_COMMAND = "chatgpt.newChat";
  const CLAUDE_CODE_EXTENSION_ID = "anthropic.claude-code";
  const CLAUDE_CODE_OPEN_COMMAND = "claude-vscode.editor.open";

  const dedupeFsPaths = (fsPaths: readonly string[]): string[] => {
    // Deduplicate paths (normalize Windows case differences).
    const byKey = new Map<string, string>();
    for (const p of fsPaths) {
      const fsPath = typeof p === "string" ? p.trim() : "";
      if (!fsPath) continue;
      const key = normalizeCacheKey(fsPath);
      if (!byKey.has(key)) byKey.set(key, fsPath);
    }
    return Array.from(byKey.values());
  };

  const collectSessionFsPaths = (targets: readonly unknown[]): string[] => {
    const fsPaths: string[] = [];
    for (const t of targets) {
      if (isSessionNode(t)) fsPaths.push(t.session.fsPath);
    }
    return dedupeFsPaths(fsPaths);
  };

  const collectUnpinFsPaths = (targets: readonly unknown[]): string[] => {
    const fsPaths: string[] = [];
    for (const t of targets) {
      if (isSessionNode(t)) fsPaths.push(t.session.fsPath);
      else if (t instanceof MissingPinnedNode) fsPaths.push(t.fsPath);
    }
    return dedupeFsPaths(fsPaths);
  };

  const collectSessionsFromTargets = (targets: readonly unknown[]): SessionSummary[] => {
    const byKey = new Map<string, SessionSummary>();
    const push = (session: SessionSummary): void => {
      if (!matchesArchiveLocationFilter(session, resolveEffectiveArchiveLocationFilter())) return;
      byKey.set(normalizeCacheKey(session.fsPath), session);
    };
    const pushMany = (sessions: readonly SessionSummary[]): void => {
      for (const session of sessions) push(session);
    };

    const index = historyService.getIndex();
    for (const t of targets) {
      if (isSessionNode(t)) {
        push(t.session);
        continue;
      }
      if (t instanceof DayNode) {
        const sessions = index.byY.get(t.year)?.get(t.month)?.get(t.day) ?? [];
        pushMany(sessions);
        continue;
      }
      if (t instanceof MonthNode) {
        const days = index.byY.get(t.year)?.get(t.month);
        if (!days) continue;
        for (const [, sessions] of days) pushMany(sessions);
        continue;
      }
      if (t instanceof YearNode) {
        const months = index.byY.get(t.year);
        if (!months) continue;
        for (const [, days] of months) {
          for (const [, sessions] of days) pushMany(sessions);
        }
      }
    }
    return Array.from(byKey.values());
  };

  const buildUriList = (fsPaths: readonly string[]): string => {
    // CRLF is recommended as the separator for text/uri-list.
    return fsPaths.map((p) => vscode.Uri.file(p).toString()).join("\r\n");
  };

  const parseUriListToFsPaths = async (dataTransfer: vscode.DataTransfer): Promise<string[]> => {
    const item = dataTransfer.get(URI_LIST_MIME);
    if (!item) return [];

    let raw = "";
    try {
      raw = await item.asString();
    } catch {
      return [];
    }

    const lines = String(raw ?? "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));

    const fsPaths: string[] = [];
    for (const line of lines.slice(0, MAX_DND_ITEMS)) {
      try {
        const uri = vscode.Uri.parse(line);
        if (uri.scheme !== "file") continue;
        if (!uri.fsPath) continue;
        fsPaths.push(uri.fsPath);
      } catch {
        // Ignore lines we cannot parse.
      }
    }
    return dedupeFsPaths(fsPaths);
  };

  const historyDragController: vscode.TreeDragAndDropController<TreeNode> = {
    dragMimeTypes: [URI_LIST_MIME],
    dropMimeTypes: [],
    handleDrag: (source, dataTransfer) => {
      // Assume source contains all selected items when dragging with multi-selection.
      const fsPaths = collectSessionFsPaths(source);
      if (fsPaths.length === 0) return;
      dataTransfer.set(URI_LIST_MIME, new vscode.DataTransferItem(buildUriList(fsPaths)));
    },
  };

  const searchDragController: vscode.TreeDragAndDropController<TreeNode> = {
    dragMimeTypes: [URI_LIST_MIME],
    dropMimeTypes: [],
    handleDrag: (source, dataTransfer) => {
      const fsPaths = collectSessionFsPaths(source);
      if (fsPaths.length === 0) return;
      dataTransfer.set(URI_LIST_MIME, new vscode.DataTransferItem(buildUriList(fsPaths)));
    },
  };

  const pinnedDropController: vscode.TreeDragAndDropController<TreeNode> = {
    dragMimeTypes: [],
    dropMimeTypes: [URI_LIST_MIME],
    handleDrop: async (_target, dataTransfer) => {
      const fsPaths = await parseUriListToFsPaths(dataTransfer);
      if (fsPaths.length === 0) return;

      // Only allow pinning sessions present in the history index (prevents mixing in external drag-and-drop items).
      const byKey = new Map<string, SessionSummary>();
      for (const fsPath of fsPaths) {
        const session = historyService.findByFsPath(fsPath);
        if (!session) continue;
        byKey.set(normalizeCacheKey(session.fsPath), session);
      }
      const sessions = Array.from(byKey.values());
      if (sessions.length === 0) return;

      const { pinned, skipped } = await pinStore.pinSessions(sessions);
      refreshViews();

      if (pinned === 1 && skipped === 0) {
        void vscode.window.showInformationMessage(t("app.pinDone"));
      } else if (pinned > 0) {
        void vscode.window.showInformationMessage(t("app.pinDoneMulti", pinned, skipped));
      } else {
        void vscode.window.showInformationMessage(t("app.pinDoneNoop"));
      }
    },
  };

  // Create tree views (enable canSelectMany for multi-delete).
  const controlView = vscode.window.createTreeView("codexHistoryViewer.controlView", {
    treeDataProvider: controlProvider,
  });
  const statusView = vscode.window.createTreeView("codexHistoryViewer.statusView", {
    treeDataProvider: statusProvider,
  });
  const pinnedView = vscode.window.createTreeView("codexHistoryViewer.pinnedView", {
    treeDataProvider: pinnedProvider,
    canSelectMany: true,
    dragAndDropController: pinnedDropController,
  });
  const historyView = vscode.window.createTreeView("codexHistoryViewer.historyView", {
    treeDataProvider: historyProvider,
    canSelectMany: true,
    dragAndDropController: historyDragController,
  });
  const searchView = vscode.window.createTreeView("codexHistoryViewer.searchView", {
    treeDataProvider: searchProvider,
    canSelectMany: true,
    dragAndDropController: searchDragController,
  });
  let autoRefreshService: AutoRefreshService | null = null;

  context.subscriptions.push(
    controlView,
    statusView,
    pinnedView,
    historyView,
    searchView,
    chatPanels,
  );

  // Ensure the global storage directory exists before cache/index operations.
  await vscode.workspace.fs.createDirectory(context.globalStorageUri);

  const ensureAlwaysShowHeaderActions = async (): Promise<void> => {
    // Enable VS Code setting to always show header actions (top-right view icons).
    // Keep the extension running even if updating the setting fails.
    const wbCfg = vscode.workspace.getConfiguration();
    const current = wbCfg.get<boolean>("workbench.view.alwaysShowHeaderActions") ?? false;
    if (current) return;

    try {
      await wbCfg.update("workbench.view.alwaysShowHeaderActions", true, vscode.ConfigurationTarget.Global);
    } catch {
      // Ignore failures when updating settings (permissions/environment differences).
    }
  };

  const updateViewTitles = (): void => {
    controlView.title = t("runtime.view.control");
    statusView.title = t("runtime.view.status");
    pinnedView.title = t("runtime.view.pinned");
    historyView.title = t("runtime.view.history");
    searchView.title = t("runtime.view.search");
  };

  const updateHistoryViewDescription = (): void => {
    const v = buildHistoryFilterSummary();
    historyView.description = v ? t("history.filter.active", v) : "";
    void vscode.commands.executeCommand("setContext", "codexHistoryViewer.historyFiltered", v.length > 0);
    void vscode.commands.executeCommand("setContext", "codexHistoryViewer.historyTagFiltered", historyTagFilter.length > 0);
    void vscode.commands.executeCommand("setContext", "codexHistoryViewer.historyViewMode", historyViewMode);
    void vscode.commands.executeCommand(
      "setContext",
      "codexHistoryViewer.sourceCodexEnabled",
      isCodexSourceEnabled(historySourceFilter),
    );
    void vscode.commands.executeCommand(
      "setContext",
      "codexHistoryViewer.sourceClaudeEnabled",
      isClaudeSourceEnabled(historySourceFilter),
    );
    void vscode.commands.executeCommand(
      "setContext",
      "codexHistoryViewer.historySourceFiltered",
      historySourceFilter !== "all",
    );
    void vscode.commands.executeCommand(
      "setContext",
      "codexHistoryViewer.historySourceFilter",
      historySourceFilter,
    );
    void vscode.commands.executeCommand(
      "setContext",
      "codexHistoryViewer.historySourceSwitchable",
      isHistorySourceSwitchable(),
    );
  };

  const buildPinnedFilterSummary = (): string => {
    const parts: string[] = [];
    const sourceSummary = buildSourceFilterSummary();
    if (sourceSummary) parts.push(sourceSummary);
    const archiveLocationSummary = buildArchiveLocationFilterSummary();
    if (archiveLocationSummary) parts.push(archiveLocationSummary);
    if (pinnedTagFilter.length > 0) {
      parts.push(`tags: ${pinnedTagFilter.map((tag) => `#${tag}`).join(", ")}`);
    }
    return parts.join(" / ");
  };

  const updatePinnedViewDescription = (): void => {
    const v = buildPinnedFilterSummary();
    pinnedView.description = v;
    void vscode.commands.executeCommand("setContext", "codexHistoryViewer.pinnedTagFiltered", pinnedTagFilter.length > 0);
  };

  const buildSearchTagFilterSummary = (): string => {
    const parts: string[] = [];
    const archiveLocationSummary = buildArchiveLocationFilterSummary();
    if (archiveLocationSummary) parts.push(archiveLocationSummary);
    if (searchTagFilter.length > 0) parts.push(t("search.tagFilter.summary", searchTagFilter.map((tag) => `#${tag}`).join(", ")));
    return parts.join(" / ");
  };

  const updateSearchViewDescription = (): void => {
    const v = buildSearchTagFilterSummary();
    searchView.description = v;
    void vscode.commands.executeCommand("setContext", "codexHistoryViewer.searchTagFiltered", searchTagFilter.length > 0);
  };

  const isSameTagFilter = (left: readonly string[], right: readonly string[]): boolean => {
    if (left.length !== right.length) return false;
    const rightKeys = new Set(right.map((tag) => tag.toLowerCase()));
    for (const tag of left) {
      if (!rightKeys.has(tag.toLowerCase())) return false;
    }
    return true;
  };

  const applySearchTagFilter = async (
    nextTags: readonly string[],
    opts: { persist: boolean; rerunSearch: boolean },
  ): Promise<void> => {
    const normalized = sanitizeTagFilter(nextTags);
    const changed = !isSameTagFilter(searchTagFilter, normalized);
    searchTagFilter = normalized;
    updateSearchViewDescription();
    statusProvider.refresh();
    if (opts.persist) {
      await context.workspaceState.update(SEARCH_TAG_FILTER_KEY, searchTagFilter);
    }
    if (!opts.rerunSearch || !changed) return;
    if (!lastSearchRequest) {
      void vscode.window.showInformationMessage(t("search.tagFilter.deferred"));
      return;
    }
    await executeSearch(lastSearchRequest);
  };

  const applyPinnedTagFilter = async (nextTags: readonly string[], opts: { persist: boolean }): Promise<void> => {
    pinnedTagFilter = sanitizeTagFilter(nextTags);
    pinnedProvider.setTagFilter(pinnedTagFilter);
    pinnedProvider.refresh();
    updatePinnedViewDescription();
    statusProvider.refresh();
    if (opts.persist) {
      await context.workspaceState.update(PINNED_TAG_FILTER_KEY, pinnedTagFilter);
    }
  };

  const applyHistoryViewMode = async (nextMode: HistoryViewMode, opts: { persist: boolean }): Promise<void> => {
    const normalized = sanitizeHistoryViewMode(nextMode);
    if (historyViewMode === normalized) return;

    historyViewMode = normalized;
    historyProvider.setViewMode(historyViewMode);
    historyProvider.refresh();
    updateHistoryViewDescription();
    if (opts.persist) {
      await context.workspaceState.update(HISTORY_VIEW_MODE_KEY, historyViewMode);
    }
  };

  const applyHistoryFilters = async (
    next: { date: DateScope; projectCwd: string | null; source: SessionSourceFilter; tags: string[] },
    opts: { persist: boolean },
  ): Promise<void> => {
    historyFilter = next.date;
    historyProjectCwd = next.projectCwd;
    historySourceFilter = constrainHistorySourceFilter(next.source);
    historyTagFilter = sanitizeTagFilter(next.tags);
    historyProvider.setFilters(historyFilter, historyProjectCwd, historySourceFilter, historyTagFilter);
    historyProvider.refresh();
    pinnedProvider.setSourceFilter(historySourceFilter);
    syncArchiveLocationFilterToProviders();
    pinnedProvider.refresh();
    updateHistoryViewDescription();
    updatePinnedViewDescription();
    statusProvider.refresh();
    if (opts.persist) {
      await context.workspaceState.update(HISTORY_FILTER_KEY, next.date);
      await context.workspaceState.update(HISTORY_PROJECT_FILTER_KEY, next.projectCwd ?? "");
      await context.workspaceState.update(HISTORY_SOURCE_FILTER_KEY, historySourceFilter);
      await context.workspaceState.update(HISTORY_TAG_FILTER_KEY, historyTagFilter);
    }
  };

  const resolveSourceFilterFromEnabledStates = (codexEnabled: boolean, claudeEnabled: boolean): SessionSourceFilter => {
    if (codexEnabled && claudeEnabled) return "all";
    if (codexEnabled) return "codex";
    if (claudeEnabled) return "claude";
    // Keep at least one source visible to avoid an empty-state trap.
    return "all";
  };

  const toggleHistorySource = async (source: "codex" | "claude"): Promise<void> => {
    const codexEnabledNow = isCodexSourceEnabled(historySourceFilter);
    const claudeEnabledNow = isClaudeSourceEnabled(historySourceFilter);
    const codexEnabledNext = source === "codex" ? !codexEnabledNow : codexEnabledNow;
    const claudeEnabledNext = source === "claude" ? !claudeEnabledNow : claudeEnabledNow;
    const nextSource = resolveSourceFilterFromEnabledStates(codexEnabledNext, claudeEnabledNext);
    await applyHistoryFilters(
      {
        date: historyFilter,
        projectCwd: historyProjectCwd,
        source: nextSource,
        tags: historyTagFilter,
      },
      { persist: true },
    );
  };

  const cycleHistorySourceFilter = async (): Promise<void> => {
    const nextSource: SessionSourceFilter =
      historySourceFilter === "all" ? "codex" : historySourceFilter === "codex" ? "claude" : "all";
    await applyHistoryFilters(
      {
        date: historyFilter,
        projectCwd: historyProjectCwd,
        source: nextSource,
        tags: historyTagFilter,
      },
      { persist: true },
    );
  };

  updateViewTitles();
  updatePinnedViewDescription();
  updateHistoryViewDescription();
  updateSearchViewDescription();
  await ensureAlwaysShowHeaderActions();

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.copyStatusPath", async (value?: unknown) => {
      const text =
        typeof value === "string"
          ? value.trim()
          : value && typeof value === "object" && typeof (value as { copyValue?: unknown }).copyValue === "string"
            ? String((value as { copyValue: string }).copyValue).trim()
            : "";
      if (!text) return false;

      try {
        await vscode.env.clipboard.writeText(text);
        void vscode.window.showInformationMessage(t("app.copyStatusPathDone"));
        return true;
      } catch {
        void vscode.window.showErrorMessage(t("app.copyStatusPathFailed"));
        return false;
      }
    }),
  );

  const promptSearchIndexRebuild = (): void => {
    const rebuildNow = t("search.indexToolContent.rebuildNow");
    const later = t("search.indexToolContent.later");
    void vscode.window
      .showInformationMessage(t("search.indexToolContent.changed"), rebuildNow, later)
      .then((choice) => {
        if (choice === rebuildNow) void vscode.commands.executeCommand("codexHistoryViewer.rebuildSearchIndex");
      });
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      const uiLanguageChanged = e.affectsConfiguration("codexHistoryViewer.ui.language");
      const headerActionsChanged = e.affectsConfiguration("codexHistoryViewer.ui.alwaysShowHeaderActions");
      const timeGuideChanged = e.affectsConfiguration("codexHistoryViewer.ui.timeGuide.enabled");
      const searchDefaultRolesChanged = e.affectsConfiguration("codexHistoryViewer.search.defaultRoles");
      const searchIndexToolContentChanged = e.affectsConfiguration("codexHistoryViewer.search.indexToolContent");
      const fileChangeHistoryExplorerContextMenuChanged = e.affectsConfiguration(
        "codexHistoryViewer.fileChangeHistory.explorerContextMenu.enabled",
      );
      const sourcesEnabledChanged = e.affectsConfiguration("codexHistoryViewer.sources.enabled");
      const handoffEnabledChanged = e.affectsConfiguration("codexHistoryViewer.handoff.enabled");
      const sessionsRootChanged =
        e.affectsConfiguration("codexHistoryViewer.sessionsRoot") ||
        e.affectsConfiguration("codexHistoryViewer.codex.archivedSessionsRoot") ||
        e.affectsConfiguration("codexHistoryViewer.codex.archivedSessions.root") ||
        e.affectsConfiguration("codexHistoryViewer.codex.archivedSessions.enabled") ||
        e.affectsConfiguration("codexHistoryViewer.claude.sessionsRoot") ||
        e.affectsConfiguration("codexHistoryViewer.claudeSessionsRoot");
      const historyDateBasisChanged = e.affectsConfiguration("codexHistoryViewer.history.dateBasis");
      const historyTitleSourceChanged = e.affectsConfiguration("codexHistoryViewer.history.titleSource");
      const previewMaxMessagesChanged = e.affectsConfiguration("codexHistoryViewer.preview.maxMessages");
      const previewTooltipModeChanged = e.affectsConfiguration("codexHistoryViewer.preview.tooltipMode");
      const autoRefreshChanged = e.affectsConfiguration("codexHistoryViewer.autoRefresh");
      const chatOpenPositionChanged = e.affectsConfiguration("codexHistoryViewer.chat.openPosition");
      const chatPerformanceModeChanged = e.affectsConfiguration("codexHistoryViewer.chat.performanceMode");
      const toolDisplayModeChanged = e.affectsConfiguration("codexHistoryViewer.chat.toolDisplayMode");
      const userLongMessageFoldingChanged = e.affectsConfiguration("codexHistoryViewer.chat.userLongMessageFolding");
      const assistantLongMessageFoldingChanged = e.affectsConfiguration(
        "codexHistoryViewer.chat.assistantLongMessageFolding",
      );
      const legacyLongMessageFoldingChanged = e.affectsConfiguration("codexHistoryViewer.chat.longMessageFolding");
      const longMessageFoldingChanged =
        userLongMessageFoldingChanged || assistantLongMessageFoldingChanged || legacyLongMessageFoldingChanged;
      const imagesChanged = e.affectsConfiguration("codexHistoryViewer.images");
      if (
        !uiLanguageChanged &&
        !headerActionsChanged &&
        !timeGuideChanged &&
        !searchDefaultRolesChanged &&
        !searchIndexToolContentChanged &&
        !fileChangeHistoryExplorerContextMenuChanged &&
        !sourcesEnabledChanged &&
        !handoffEnabledChanged &&
        !sessionsRootChanged &&
        !historyDateBasisChanged &&
        !historyTitleSourceChanged &&
        !previewMaxMessagesChanged &&
        !previewTooltipModeChanged &&
        !autoRefreshChanged &&
        !chatOpenPositionChanged &&
        !chatPerformanceModeChanged &&
        !toolDisplayModeChanged &&
        !longMessageFoldingChanged &&
        !imagesChanged
      ) {
        return;
      }

      if (sourcesEnabledChanged) {
        const constrained = constrainHistorySourceFilter(historySourceFilter);
        if (constrained !== historySourceFilter) {
          historySourceFilter = constrained;
          historyProvider.setSourceFilter(historySourceFilter);
          pinnedProvider.setSourceFilter(historySourceFilter);
          syncArchiveLocationFilterToProviders();
          void context.workspaceState.update(HISTORY_SOURCE_FILTER_KEY, historySourceFilter);
        }
      }

      if (uiLanguageChanged) updateUiLanguageContext();
      if (sourcesEnabledChanged || handoffEnabledChanged) updateHandoffMenuContext();
      if (sourcesEnabledChanged || sessionsRootChanged) updateArchivedSessionsContext();
      updateViewTitles();
      updatePinnedViewDescription();
      updateHistoryViewDescription();
      updateSearchViewDescription();
      void autoRefreshService?.configure(getConfig(), computeAutoRefreshConsumerVisible(), vscode.window.state.focused);
      if (uiLanguageChanged || toolDisplayModeChanged || longMessageFoldingChanged || imagesChanged) chatPanels.refreshPanels();
      else chatPanels.refreshI18n();
      if (uiLanguageChanged || timeGuideChanged) fileChangeHistoryPanels.refreshI18n();
      if (searchIndexToolContentChanged) fileChangeHistoryPanels.notifySettingsChanged("indexToolContent");
      if (sourcesEnabledChanged) fileChangeHistoryPanels.notifySettingsChanged("sources");
      void ensureAlwaysShowHeaderActions();
      if (searchIndexToolContentChanged) promptSearchIndexRebuild();

      // UI language changes only need view rerendering; history cache depends on time zone, not UI language.
      if (
        !uiLanguageChanged &&
        !sourcesEnabledChanged &&
        !sessionsRootChanged &&
        !historyDateBasisChanged &&
        !historyTitleSourceChanged &&
        !previewMaxMessagesChanged
      ) {
        refreshViews();
        controlProvider.refresh();
        return;
      }

      if (
        uiLanguageChanged &&
        !sourcesEnabledChanged &&
        !sessionsRootChanged &&
        !historyDateBasisChanged &&
        !historyTitleSourceChanged &&
        !previewMaxMessagesChanged
      ) {
        refreshViews();
        controlProvider.refresh();
        chatPanels.refreshTitles();
        return;
      }

      void vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: t("app.loadingHistory") }, async () => {
        await refreshHistoryIndex(false);
        refreshViews({ clearSearch: true });
        controlProvider.refresh();
        chatPanels.refreshTitles();
      });
    }),
  );

  const openReusableSessionFromElement = async (element: unknown): Promise<void> => {
    if (!isSessionNode(element)) return;
    const reveal = element instanceof SearchHitNode ? element.hit.messageIndex : undefined;
    if (await chatPanels.revealExistingSessionPanel(element.session.fsPath, reveal, { preserveFocus: true })) return;
    await chatPanels.openSession(element.session, { kind: "reusable", revealMessageIndex: reveal });
  };

  // Open a reusable session tab on selection (if enabled).
  const tryOpenPreview = async (element: unknown): Promise<void> => {
    const latestConfig = getConfig();
    if (!latestConfig.previewOpenOnSelection) return;
    await openReusableSessionFromElement(element);
  };

  const collectSessionSelection = (
    targets: readonly unknown[],
  ): { sessions: SessionSummary[]; invalidCount: number; rawCount: number } => {
    const byKey = new Map<string, SessionSummary>();
    let invalidCount = 0;
    for (const target of targets) {
      if (!isSessionNode(target)) {
        invalidCount += 1;
        continue;
      }
      const session = target.session;
      const key = normalizeCacheKey(session.fsPath);
      if (!byKey.has(key)) byKey.set(key, session);
    }
    return { sessions: Array.from(byKey.values()), invalidCount, rawCount: targets.length };
  };

  const updateArchiveSelectionContext = (selection: readonly unknown[]): void => {
    const { sessions, invalidCount, rawCount } = collectSessionSelection(selection);
    const hasMultiSelection = rawCount > 1;
    const hasMultiSessionSelection = sessions.length > 1;
    const hasInvalidSelection = invalidCount > 0;
    const allActiveCodex =
      hasMultiSelection &&
      !hasInvalidSelection &&
      sessions.length >= 1 &&
      sessions.every((session) => session.source === "codex" && session.storage.archiveState === "active");
    const allArchivedCodex =
      hasMultiSelection &&
      !hasInvalidSelection &&
      sessions.length >= 1 &&
      sessions.every((session) => session.source === "codex" && session.storage.archiveState === "archived");
    const hasMixedArchiveSelection =
      hasMultiSelection && !allActiveCodex && !allArchivedCodex && (hasInvalidSelection || sessions.length > 0);

    void vscode.commands.executeCommand("setContext", "codexHistoryViewer.hasMultiSelection", hasMultiSelection);
    void vscode.commands.executeCommand(
      "setContext",
      "codexHistoryViewer.hasMultiSessionSelection",
      hasMultiSessionSelection,
    );
    void vscode.commands.executeCommand("setContext", "codexHistoryViewer.canArchiveSelection", allActiveCodex);
    void vscode.commands.executeCommand(
      "setContext",
      "codexHistoryViewer.canRestoreArchivedSelection",
      allArchivedCodex,
    );
    void vscode.commands.executeCommand(
      "setContext",
      "codexHistoryViewer.hasMixedArchiveSelection",
      hasMixedArchiveSelection,
    );
  };

  // Track the last interacted view, since multiple views can be visible at the same time.
  let lastSelectionSource: "pinned" | "history" | "search" | null = null;
  context.subscriptions.push(
    pinnedView.onDidChangeSelection((e) => {
      lastSelectionSource = "pinned";
      updateArchiveSelectionContext(e.selection);
      void tryOpenPreview(e.selection[0]);
    }),
  );
  context.subscriptions.push(
    historyView.onDidChangeSelection((e) => {
      lastSelectionSource = "history";
      updateArchiveSelectionContext(e.selection);
      void tryOpenPreview(e.selection[0]);
    }),
  );
  context.subscriptions.push(
    searchView.onDidChangeSelection((e) => {
      lastSelectionSource = "search";
      updateArchiveSelectionContext(e.selection);
      void tryOpenPreview(e.selection[0]);
    }),
  );
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      statusProvider.refresh();
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      statusProvider.refresh();
    }),
  );

  const resolveActiveSelection = (): readonly unknown[] => {
    // Prefer selection from the last interacted view to avoid bulk actions on the wrong view.
    if (lastSelectionSource === "pinned" && pinnedView.selection.length > 0) return pinnedView.selection;
    if (lastSelectionSource === "history" && historyView.selection.length > 0) return historyView.selection;
    if (lastSelectionSource === "search" && searchView.selection.length > 0) return searchView.selection;

    // Fallback when last interaction cannot be determined.
    if (pinnedView.selection.length > 0) return pinnedView.selection;
    if (historyView.selection.length > 0) return historyView.selection;
    if (searchView.selection.length > 0) return searchView.selection;
    return [];
  };

  const resolveSelectionForElement = (element: unknown): readonly unknown[] | null => {
    // To avoid accidental actions from context menus/inline actions, prefer selection from the view the element belongs to.
    if (pinnedView.selection.includes(element as never)) return pinnedView.selection;
    if (historyView.selection.includes(element as never)) return historyView.selection;
    if (searchView.selection.includes(element as never)) return searchView.selection;
    return null;
  };

  const resolveTargets = (element?: unknown): readonly unknown[] => {
    // When invoked from a context menu, element is provided.
    // If there is multi-selection, apply the same operation to the whole selection.
    if (element === undefined) return resolveActiveSelection();
    const selection = resolveSelectionForElement(element);
    return selection && selection.length > 1 ? selection : [element];
  };

  const collectOpenTargets = (targets: readonly unknown[]): Array<{ session: SessionSummary; revealMessageIndex?: number }> => {
    // Deduplicate "Open" targets by session, and for SearchHit use the first hit location.
    const byKey = new Map<string, { session: SessionSummary; revealMessageIndex?: number }>();
    for (const t of targets) {
      if (!isSessionNode(t)) continue;
      const s = t.session;
      const key = normalizeCacheKey(s.fsPath);
      if (byKey.has(key)) continue;
      byKey.set(key, { session: s, revealMessageIndex: resolveRevealIndex(t) });
    }
    return Array.from(byKey.values());
  };

  const hasDirectFsPathArg = (value: unknown): boolean =>
    !!value &&
    typeof value === "object" &&
    !isSessionNode(value) &&
    typeof (value as { fsPath?: unknown }).fsPath === "string";

  const resolveSingleSessionTarget = (elementOrArgs?: unknown): SessionSummary | undefined => {
    // Prefer an explicit fsPath argument from the webview; otherwise use the selected session.
    if (hasDirectFsPathArg(elementOrArgs)) {
      return resolveSessionFromElementOrFsPath(historyService, elementOrArgs);
    }

    const targets = resolveTargets(elementOrArgs);
    const openTargets = collectOpenTargets(targets);
    if (openTargets.length > 0) return openTargets[0]!.session;

    return resolveSessionFromElementOrActive(historyService, transcriptProvider.scheme, elementOrArgs);
  };

  const resolveMoveCommandTargets = (
    elementOrArgs?: unknown,
  ): { sessions: SessionSummary[]; invalidCount: number; direct: boolean } => {
    if (hasDirectFsPathArg(elementOrArgs)) {
      const session = resolveSessionFromElementOrFsPath(historyService, elementOrArgs);
      return { sessions: session ? [session] : [], invalidCount: session ? 0 : 1, direct: true };
    }

    const targets = resolveTargets(elementOrArgs);
    if (targets.length > 0) {
      const selected = collectSessionSelection(targets);
      return { sessions: selected.sessions, invalidCount: selected.invalidCount, direct: false };
    }

    const fallback = resolveSessionFromElementOrActive(historyService, transcriptProvider.scheme, elementOrArgs);
    return { sessions: fallback ? [fallback] : [], invalidCount: fallback ? 0 : 1, direct: false };
  };

  const resolveCodexConversationId = (session: SessionSummary): string | null => {
    // Reject IDs with unsafe characters because the ID is embedded into URI paths.
    const id = typeof session.meta.id === "string" ? session.meta.id.trim() : "";
    if (!id) return null;
    return /^[A-Za-z0-9._:-]+$/.test(id) ? id : null;
  };

  const buildCodexConversationUri = (conversationId: string): vscode.Uri =>
    // URI format accepted by OpenAI Codex custom editor.
    vscode.Uri.from({
      scheme: OPENAI_CODEX_URI_SCHEME,
      authority: OPENAI_CODEX_URI_AUTHORITY,
      path: `/local/${conversationId}`,
    });

  const openSessionInOpenAiCodex = async (session: SessionSummary): Promise<boolean> => {
    const conversationId = resolveCodexConversationId(session);
    if (!conversationId) {
      void vscode.window.showErrorMessage(t("app.resumeSessionInCodexNoSessionId"));
      return false;
    }

    // Show a clear message when the target extension is not installed.
    const codexExtension = vscode.extensions.getExtension(OPENAI_CODEX_EXTENSION_ID);
    if (!codexExtension) {
      void vscode.window.showErrorMessage(t("app.resumeSessionInCodexMissingExtension"));
      return false;
    }

    try {
      await codexExtension.activate();
    } catch {
      void vscode.window.showErrorMessage(t("app.resumeSessionInCodexFailed"));
      return false;
    }

    const resumeTarget = getConfig().resumeOpenTarget;
    if (resumeTarget === "panel") {
      const conversationUri = buildCodexConversationUri(conversationId);
      try {
        await vscode.commands.executeCommand(
          "vscode.openWith",
          conversationUri,
          OPENAI_CODEX_CUSTOM_EDITOR_VIEW_TYPE,
          { preview: false, preserveFocus: false },
        );
        return true;
      } catch {
        void vscode.window.showErrorMessage(t("app.resumeSessionInCodexFailed"));
        return false;
      }
    }

    // Default behavior: resume in the sidebar via onUri deep link.
    try {
      const deepLink = vscode.Uri.parse(`${vscode.env.uriScheme}://${OPENAI_CODEX_EXTENSION_ID}/local/${conversationId}`);
      const opened = await vscode.env.openExternal(deepLink);
      if (opened) return true;
    } catch {
      // Failures are reported by the common error path below.
    }

    void vscode.window.showErrorMessage(t("app.resumeSessionInCodexFailed"));
    return false;
  };

  const resolveClaudeSessionId = (session: SessionSummary): string | null => {
    // Pass through the conversation ID from metadata and reject control characters only.
    if (session.source !== "claude") return null;
    const id = typeof session.meta.id === "string" ? session.meta.id.trim() : "";
    if (!id) return null;
    if (/[\u0000-\u001F\u007F]/.test(id)) return null;
    return id;
  };

  const openSessionInClaudeCode = async (session: SessionSummary): Promise<boolean> => {
    if (session.source !== "claude") {
      void vscode.window.showErrorMessage(t("app.resumeSessionInClaudeWrongSource"));
      return false;
    }

    const sessionId = resolveClaudeSessionId(session);
    if (!sessionId) {
      void vscode.window.showErrorMessage(t("app.resumeSessionInClaudeNoSessionId"));
      return false;
    }

    const claudeExtension = vscode.extensions.getExtension(CLAUDE_CODE_EXTENSION_ID);
    if (!claudeExtension) {
      void vscode.window.showErrorMessage(t("app.resumeSessionInClaudeMissingExtension"));
      return false;
    }

    try {
      await claudeExtension.activate();
      await vscode.commands.executeCommand(CLAUDE_CODE_OPEN_COMMAND, sessionId);
      return true;
    } catch {
      void vscode.window.showErrorMessage(t("app.resumeSessionInClaudeFailed"));
      return false;
    }
  };

  const sourceDisplayLabel = (source: "codex" | "claude"): string =>
    source === "claude" ? t("history.filter.source.claude") : t("history.filter.source.codex");

  const targetDisplayLabel = (target: HandoffTarget): string =>
    target === "claude" ? t("history.filter.source.claude") : t("history.filter.source.codex");

  const resolveDefaultHandoffTargetForSource = (source: SessionSummary["source"]): HandoffTarget =>
    source === "claude" ? "codex" : "claude";

  const ensureCrossHandoffReady = (session: SessionSummary, target: HandoffTarget): boolean => {
    if (!getConfig().handoffEnabled) {
      void vscode.window.showErrorMessage(t("handoff.disabled"));
      return false;
    }

    const expectedSource = target === "codex" ? "claude" : "codex";
    if (session.source !== expectedSource) {
      void vscode.window.showErrorMessage(t("handoff.wrongSource", sourceDisplayLabel(expectedSource), targetDisplayLabel(target)));
      return false;
    }
    return true;
  };

  const openHandoffInCodex = async (): Promise<boolean> => {
    const codexExtension = vscode.extensions.getExtension(OPENAI_CODEX_EXTENSION_ID);
    if (!codexExtension) return false;

    try {
      await codexExtension.activate();
      const commands = new Set(await vscode.commands.getCommands(true));
      let opened = false;
      if (commands.has(OPENAI_CODEX_OPEN_SIDEBAR_COMMAND)) {
        await vscode.commands.executeCommand(OPENAI_CODEX_OPEN_SIDEBAR_COMMAND);
        opened = true;
      }
      if (commands.has(OPENAI_CODEX_NEW_CHAT_COMMAND)) {
        await vscode.commands.executeCommand(OPENAI_CODEX_NEW_CHAT_COMMAND);
        opened = true;
      }
      return opened;
    } catch {
      return false;
    }
  };

  const openHandoffInClaude = async (handoff: HandoffResult): Promise<boolean> => {
    const claudeExtension = vscode.extensions.getExtension(CLAUDE_CODE_EXTENSION_ID);
    if (!claudeExtension) return false;

    try {
      await claudeExtension.activate();
      const commands = new Set(await vscode.commands.getCommands(true));
      if (!commands.has(CLAUDE_CODE_OPEN_COMMAND)) return false;
      await vscode.commands.executeCommand(CLAUDE_CODE_OPEN_COMMAND, undefined, handoff.promptText);
      return true;
    } catch {
      return false;
    }
  };

  const openHandoffDocument = async (handoffUri: vscode.Uri): Promise<boolean> => {
    try {
      await vscode.window.showTextDocument(handoffUri, { preview: false });
      return true;
    } catch {
      void vscode.window.showErrorMessage(t("handoff.openFileFailed"));
      return false;
    }
  };

  const copyHandoffPrompt = async (handoff: HandoffResult): Promise<boolean> => {
    try {
      await vscode.env.clipboard.writeText(handoff.promptText);
      return true;
    } catch {
      return false;
    }
  };

  const showHandoffActions = async (message: string, handoff: HandoffResult): Promise<void> => {
    const openAction = t("handoff.action.openFile");
    const copyAction = t("handoff.action.copyPrompt");
    const choice = await vscode.window.showInformationMessage(message, openAction, copyAction);
    if (choice === openAction) {
      await openHandoffDocument(handoff.handoffUri);
      return;
    }
    if (choice === copyAction) {
      if (await copyHandoffPrompt(handoff)) {
        void vscode.window.showInformationMessage(t("handoff.copyPromptDone"));
      } else {
        void vscode.window.showErrorMessage(t("handoff.copyPromptFailed"));
      }
    }
  };

  const showHandoffPromptCopied = async (message: string, handoff: HandoffResult): Promise<void> => {
    const openAction = t("handoff.action.openFile");
    const choice = await vscode.window.showInformationMessage(message, openAction);
    if (choice === openAction) await openHandoffDocument(handoff.handoffUri);
  };

  const resolveSourceSessionsRootForHandoff = (
    session: SessionSummary,
    cfg: CodexHistoryViewerConfig,
  ): string => session.source === "claude" ? cfg.claudeSessionsRoot : cfg.sessionsRoot;

  const buildExistingHandoffResult = (
    session: SessionSummary,
    target: HandoffTarget,
    location: ReturnType<typeof resolveHandoffLocation>,
  ): HandoffResult => ({
    directoryUri: location.directoryUri,
    handoffUri: location.handoffUri,
    metadataUri: location.metadataUri,
    handoffPath: location.handoffPath,
    promptText: buildHandoffPrompt(location.handoffPath),
    source: session.source,
    target,
    createdAtIso: new Date().toISOString(),
  });

  const confirmExistingHandoffReuse = async (): Promise<"reuse" | "recreate" | "cancel"> => {
    const reuseAction = t("handoff.action.useExistingFile");
    const recreateAction = t("handoff.action.recreateFile");
    const choice = await vscode.window.showInformationMessage(t("handoff.existingConfirm"), reuseAction, recreateAction);
    if (choice === reuseAction) return "reuse";
    if (choice === recreateAction) return "recreate";
    return "cancel";
  };

  const prepareHandoff = async (
    session: SessionSummary,
    target: HandoffTarget,
    options?: { existing?: "confirm" | "reuse" },
  ): Promise<HandoffResult | null> => {
    const latestConfig = getConfig();
    const sourceSessionsRoot = resolveSourceSessionsRootForHandoff(session, latestConfig);
    const location = resolveHandoffLocation({
      globalStorageUri: context.globalStorageUri,
      session,
      sourceSessionsRoot,
      target,
    });

    if (await pathExists(location.handoffPath)) {
      if (options?.existing === "reuse") return buildExistingHandoffResult(session, target, location);
      const choice = await confirmExistingHandoffReuse();
      if (choice === "cancel") return null;
      if (choice === "reuse") return buildExistingHandoffResult(session, target, location);
    }

    try {
      return await createHandoff({
        globalStorageUri: context.globalStorageUri,
        session,
        target,
        sourceSessionsRoot,
      });
    } catch {
      void vscode.window.showErrorMessage(t("handoff.createFailed"));
      return null;
    }
  };

  const refreshHandoffStorageState = async (): Promise<void> => {
    await refreshStorageStats();
    statusProvider.refresh();
  };

  const openSessionHandoff = async (elementOrArgs?: unknown): Promise<boolean> => {
    const session = resolveSingleSessionTarget(elementOrArgs);
    if (!session) return false;
    if (!getConfig().handoffEnabled) {
      void vscode.window.showErrorMessage(t("handoff.disabled"));
      return false;
    }

    const latestConfig = getConfig();
    const location = resolveHandoffLocation({
      globalStorageUri: context.globalStorageUri,
      session,
      sourceSessionsRoot: resolveSourceSessionsRootForHandoff(session, latestConfig),
    });
    if (!(await pathExists(location.handoffPath))) {
      const createAction = t("handoff.action.createFile");
      const choice = await vscode.window.showInformationMessage(t("handoff.sessionMissing"), createAction);
      if (choice !== createAction) return false;

      const target = resolveDefaultHandoffTargetForSource(session.source);
      const handoff = await prepareHandoff(session, target, { existing: "reuse" });
      if (!handoff) return false;
      await refreshHandoffStorageState();
      return openHandoffDocument(handoff.handoffUri);
    }

    return openHandoffDocument(location.handoffUri);
  };

  const copyHandoffPromptToClipboard = async (elementOrArgs?: unknown): Promise<boolean> => {
    const session = resolveSingleSessionTarget(elementOrArgs);
    if (!session) return false;
    if (!getConfig().handoffEnabled) {
      void vscode.window.showErrorMessage(t("handoff.disabled"));
      return false;
    }

    const target = resolveDefaultHandoffTargetForSource(session.source);
    const latestConfig = getConfig();
    const location = resolveHandoffLocation({
      globalStorageUri: context.globalStorageUri,
      session,
      sourceSessionsRoot: resolveSourceSessionsRootForHandoff(session, latestConfig),
      target,
    });
    const existed = await pathExists(location.handoffPath);
    const handoff = await prepareHandoff(session, target, { existing: "reuse" });
    if (!handoff) return false;
    await refreshHandoffStorageState();

    if (await copyHandoffPrompt(handoff)) {
      await showHandoffPromptCopied(t(existed ? "handoff.copyPromptDone" : "handoff.copyPromptCreatedDone"), handoff);
      return true;
    }

    void vscode.window.showErrorMessage(t("handoff.copyPromptFailed"));
    return false;
  };

  const createHandoffFileForSession = async (elementOrArgs?: unknown): Promise<boolean> => {
    const session = resolveSingleSessionTarget(elementOrArgs);
    if (!session) return false;
    if (!getConfig().handoffEnabled) {
      void vscode.window.showErrorMessage(t("handoff.disabled"));
      return false;
    }

    const target = resolveDefaultHandoffTargetForSource(session.source);
    const handoff = await prepareHandoff(session, target);
    if (!handoff) return false;
    await refreshHandoffStorageState();
    await showHandoffActions(t("handoff.fileReady"), handoff);
    return true;
  };

  const runCrossHandoff = async (elementOrArgs: unknown, target: HandoffTarget): Promise<boolean> => {
    const session = resolveSingleSessionTarget(elementOrArgs);
    if (!session) return false;
    if (!ensureCrossHandoffReady(session, target)) return false;

    const handoff = await prepareHandoff(session, target);
    if (!handoff) return false;
    await refreshHandoffStorageState();

    if (target === "codex") {
      const copied = await copyHandoffPrompt(handoff);
      const opened = await openHandoffInCodex();
      const message = opened
        ? copied
          ? t("handoff.codexReady")
          : t("handoff.codexCopyFailed")
        : copied
          ? t("handoff.codexClipboardOnly")
          : t("handoff.codexFallback");
      await showHandoffActions(message, handoff);
      return true;
    }

    const opened = await openHandoffInClaude(handoff);
    await showHandoffActions(opened ? t("handoff.claudeOpened") : t("handoff.claudeFallback"), handoff);
    return true;
  };

  const normalizeTags = (values: readonly string[]): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      const tag = String(value ?? "").trim();
      if (!tag) continue;
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(tag);
      if (out.length >= 12) break;
    }
    return out;
  };

  const setHasSearchResultsContext = (value: boolean): void => {
    void vscode.commands.executeCommand("setContext", "codexHistoryViewer.hasSearchResults", value);
  };

  let historyRefreshQueue: Promise<void> = Promise.resolve();
  const performHistoryIndexRefresh = async (forceRebuildCache: boolean): Promise<void> => {
    const latestConfig = getConfig();
    historyService.updateConfig(latestConfig);
    const constrainedSource = resolveConstrainedHistorySourceFilter(historySourceFilter, latestConfig);
    if (constrainedSource !== historySourceFilter) {
      historySourceFilter = constrainedSource;
      historyProvider.setSourceFilter(historySourceFilter);
      pinnedProvider.setSourceFilter(historySourceFilter);
      await context.workspaceState.update(HISTORY_SOURCE_FILTER_KEY, historySourceFilter);
    }
    await historyService.refresh({ forceRebuildCache });
    const reconciledPins = await pinStore.reconcile(historyService.getIndex());
    for (const move of reconciledPins.moves) {
      await sessionReferenceRelocator.relocate(move.oldFsPath, move.newFsPath);
    }
    await chatPanels.closeMissingPanels();
    await refreshStorageStats();
    lastHistoryRefreshAt = Date.now();
  };
  const refreshHistoryIndex = (forceRebuildCache: boolean): Promise<void> => {
    const nextRefresh = historyRefreshQueue.then(
      () => performHistoryIndexRefresh(forceRebuildCache),
      () => performHistoryIndexRefresh(forceRebuildCache),
    );
    historyRefreshQueue = nextRefresh.catch(() => undefined);
    return nextRefresh;
  };

  const rebuildSearchIndex = async (
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
    token?: vscode.CancellationToken,
  ): Promise<void> => {
    const latestConfig = getConfig();
    await searchIndexService.ensureUpToDate({
      index: historyService.getIndex(),
      codexSessionsRoot: latestConfig.sessionsRoot,
      codexArchivedSessionsRoot: latestConfig.codexArchivedSessionsRoot,
      claudeSessionsRoot: latestConfig.claudeSessionsRoot,
      includeCodex: latestConfig.enableCodexSource,
      includeCodexArchived: latestConfig.enableCodexArchivedSessions,
      includeClaude: latestConfig.enableClaudeSource,
      indexToolContent: latestConfig.searchIndexToolContent,
      token,
      progress,
      forceRebuild: true,
    });
    await refreshStorageStats();
    statusProvider.refresh();
  };

  const refreshViews = (options?: { clearSearch?: boolean }): void => {
    pinnedProvider.refresh();
    historyProvider.refresh();
    if (options?.clearSearch) {
      searchProvider.clear();
      setHasSearchResultsContext(false);
    } else {
      searchProvider.refresh();
      setHasSearchResultsContext(searchProvider.root !== null);
    }
    statusProvider.refresh();
  };

  const applyArchiveLocationFilter = async (
    nextArchiveLocationFilter: ArchiveLocationFilter,
    options: { persist: boolean; rerunSearch: boolean },
  ): Promise<boolean> => {
    const nextValue = sanitizeArchiveLocationFilter(nextArchiveLocationFilter);
    if (archiveLocationFilter === nextValue) return false;

    archiveLocationFilter = nextValue;
    syncArchiveLocationFilterToProviders();
    updateArchivedSessionsContext();
    updatePinnedViewDescription();
    updateHistoryViewDescription();
    updateSearchViewDescription();

    if (options.persist) {
      await context.workspaceState.update(ARCHIVE_LOCATION_FILTER_KEY, archiveLocationFilter);
    }
    if (options.rerunSearch && searchProvider.root && lastSearchRequest) {
      await executeSearch(lastSearchRequest);
    } else {
      refreshViews();
    }
    return true;
  };

  const applyArchivedSessionsVisibility = async (
    nextShowArchivedSessions: boolean,
    options: { persist: boolean },
  ): Promise<boolean> =>
    applyArchiveLocationFilter(nextShowArchivedSessions ? "all" : "activeOnly", {
      persist: options.persist,
      rerunSearch: true,
    });

  const computeAutoRefreshConsumerVisible = (): boolean =>
    historyView.visible || chatPanels.hasOpenAutoRefreshConsumer();

  autoRefreshService = new AutoRefreshService(
    async (changedFsPaths) => {
      await refreshHistoryIndex(false);
      refreshViews();
      chatPanels.refreshTitles();
      chatPanels.refreshAutoRefreshPanels(changedFsPaths);
    },
    () => chatPanels.getAutoRefreshSessionFsPaths(),
    logger,
  );
  context.subscriptions.push(
    autoRefreshService,
    historyView.onDidChangeVisibility((e) => {
      autoRefreshService?.setVisible(computeAutoRefreshConsumerVisible());
    }),
    chatPanels.onDidChangeAutoRefreshConsumerVisibility(() => {
      autoRefreshService?.setVisible(computeAutoRefreshConsumerVisible());
    }),
    vscode.window.onDidChangeWindowState((e) => {
      autoRefreshService?.setFocused(e.focused);
    }),
  );

  const pushUndoAction = (
    label: string,
    undo: () => Promise<void>,
    cleanup?: (reason: UndoCleanupReason) => Promise<void> | void,
    options?: { postUndoRefresh?: UndoPostRefreshMode },
  ): void => {
    undoService.push({ label, undo, cleanup, postUndoRefresh: options?.postUndoRefresh });
  };

  const offerUndo = (message: string): void => {
    const undoChoice = t("undo.action");
    void vscode.window.showInformationMessage(message, undoChoice).then(async (picked) => {
      if (picked !== undoChoice) return;
      await vscode.commands.executeCommand("codexHistoryViewer.undoLastAction");
    });
  };

  const offerHistoryReloadHint = (): void => {
    void vscode.window.showInformationMessage(t("app.historyReloadHint"));
  };

  const resolveAnnotationTargets = (element?: unknown): SessionSummary[] => {
    // Prefer explicit fsPath arguments (from webview actions) over tree selections.
    if (
      element &&
      typeof element === "object" &&
      !isSessionNode(element) &&
      typeof (element as { fsPath?: unknown }).fsPath === "string"
    ) {
      const fsPath = ((element as { fsPath: string }).fsPath ?? "").trim();
      const direct = fsPath ? historyService.findByFsPath(fsPath) : undefined;
      return direct ? [direct] : [];
    }
    return collectSessionsFromTargets(resolveTargets(element));
  };

  type AnnotationSnapshot = Map<string, { tags: string[]; note: string } | null>;

  const snapshotAnnotations = (sessions: readonly SessionSummary[]): AnnotationSnapshot => {
    const snapshot: AnnotationSnapshot = new Map();
    for (const s of sessions) {
      const key = normalizeCacheKey(s.fsPath);
      const ann = annotationStore.get(s.fsPath);
      snapshot.set(key, ann ? { tags: [...ann.tags], note: ann.note } : null);
    }
    return snapshot;
  };

  const restoreAnnotations = async (
    sessions: readonly SessionSummary[],
    snapshot: AnnotationSnapshot,
  ): Promise<void> => {
    for (const s of sessions) {
      const before = snapshot.get(normalizeCacheKey(s.fsPath)) ?? null;
      if (!before) await annotationStore.remove(s.fsPath);
      else await annotationStore.set(s.fsPath, { tags: before.tags, note: before.note });
    }
    refreshViews();
  };

  const isSameAnnotationValue = (
    current: { tags: readonly string[]; note: string } | null,
    nextTags: readonly string[],
    nextNote: string,
  ): boolean => {
    if (!current) return nextTags.length === 0 && nextNote.length === 0;
    if (current.note !== nextNote) return false;
    if (current.tags.length !== nextTags.length) return false;
    for (let i = 0; i < current.tags.length; i += 1) {
      if (String(current.tags[i] ?? "").toLowerCase() !== String(nextTags[i] ?? "").toLowerCase()) return false;
    }
    return true;
  };

  const refreshAfterTitleOverrideChange = async (): Promise<void> => {
    await refreshHistoryIndex(false);
    refreshViews();
    chatPanels.refreshTitles();
  };

  const executeSearch = async (request?: SearchRequest): Promise<boolean> => {
    const latestConfig = getConfig();
    historyService.updateConfig(latestConfig);
    const index = historyService.getIndex();
    const results = await runSearchFlow(
      index,
      latestConfig,
      searchIndexService,
      annotationStore,
      historyFilter,
      historyProjectCwd,
      historySourceFilter,
      {
        request,
        defaultRoleFilter: getConfiguredDefaultSearchRoles(),
        tagFilter: searchTagFilter,
        archiveLocationFilter: resolveEffectiveArchiveLocationFilter(),
      },
    );
    if (!results) return false;

    await persistLastSearchRequest(results.request);
    searchProvider.setResults(results);
    setHasSearchResultsContext(true);
    statusProvider.refresh();
    await searchView.reveal(results.root, { focus: true, expand: true, select: true });
    return true;
  };

  const runSearchPresetById = async (presetId: string): Promise<boolean> => {
    const id = presetId.trim();
    if (!id) return false;
    const preset = searchPresetStore.getAll().find((x) => x.id === id);
    if (!preset) {
      void vscode.window.showErrorMessage(t("app.searchPresetNotFound"));
      return false;
    }
    return executeSearch(preset.request);
  };

  const pushRestoreArchivedUndo = (pairs: Array<{ archivedFsPath: string; activeFsPath: string }>): void => {
    if (pairs.length === 0) return;
    const label = pairs.length === 1 ? t("undo.label.restoreArchived") : t("undo.label.restoreArchivedMulti", pairs.length);
    pushUndoAction(label, async () => {
      for (const pair of pairs) {
        if (!(await pathExists(pair.activeFsPath))) continue;
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(pair.archivedFsPath)));
        await moveSessionFileNoOverwrite(pair.activeFsPath, pair.archivedFsPath);
        await sessionReferenceRelocator.relocate(pair.activeFsPath, pair.archivedFsPath);
      }
    });
  };

  const restoreArchivedSessions = async (
    sessions: readonly SessionSummary[],
  ): Promise<{ activeFsPath?: string; success: boolean }> => {
    if (sessions.length === 0) {
      void vscode.window.showInformationMessage(t("app.restoreArchivedUnsupported"));
      return { success: false };
    }
    if (sessions.some((session) => session.source !== "codex" || session.storage.archiveState !== "archived")) {
      void vscode.window.showInformationMessage(t("app.restoreArchivedUnsupported"));
      return { success: false };
    }

    const confirm = await vscode.window.showWarningMessage(
      sessions.length === 1 ? t("app.restoreArchivedConfirm") : t("app.restoreArchivedConfirmMulti", sessions.length),
      { modal: true },
      t("app.restoreArchivedMove"),
    );
    if (confirm !== t("app.restoreArchivedMove")) return { success: false };

    const latestConfig = getConfig();
    const undoPairs: Array<{ archivedFsPath: string; activeFsPath: string }> = [];
    let restored = 0;
    let alreadyActive = 0;
    let failed = 0;
    let cancelled = 0;
    let firstActiveFsPath: string | undefined;

    await vscode.window.withProgress(
      {
        location: sessions.length === 1 ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification,
        title: sessions.length === 1 ? t("app.restoreArchivedProgress") : t("app.restoreArchivedProgressMulti", sessions.length),
        cancellable: sessions.length > 1,
      },
      async (progress, token) => {
        for (let i = 0; i < sessions.length; i += 1) {
          if (token.isCancellationRequested) {
            cancelled = sessions.length - i;
            break;
          }
          const session = sessions[i]!;
          if (sessions.length > 1) progress.report({ message: `${i + 1}/${sessions.length}` });
          try {
            const result = await restoreArchivedSessionToActive(session, historyService, latestConfig, {
              extensionVersion: resolveExtensionVersion(context),
              logger,
            });
            if (!firstActiveFsPath) firstActiveFsPath = result.activeFsPath;
            if (result.kind === "restored") {
              restored += 1;
              await sessionReferenceRelocator.relocate(result.archivedFsPath, result.activeFsPath);
              if (result.undoable) undoPairs.push({ archivedFsPath: result.archivedFsPath, activeFsPath: result.activeFsPath });
            } else {
              alreadyActive += 1;
            }
          } catch (error) {
            failed += 1;
            logger.debug(
              formatDebugFields("restoreArchivedSession.failed", {
                error: sanitizeDebugError(error),
              }),
            );
          }
        }
      },
    );

    pushRestoreArchivedUndo(undoPairs);
    await refreshHistoryIndex(false);
    refreshViews({ clearSearch: true });
    offerHistoryReloadHint();

    if (sessions.length === 1) {
      if (restored > 0) {
        if (undoPairs.length > 0) offerUndo(t("app.restoreArchivedDone"));
        else void vscode.window.showInformationMessage(t("app.restoreArchivedDone"));
      } else if (alreadyActive > 0) {
        void vscode.window.showInformationMessage(t("app.restoreArchivedAlreadyActive"));
      } else if (failed > 0) {
        void vscode.window.showErrorMessage(t("app.restoreArchivedFailed"));
      }
    } else if (failed > 0 || cancelled > 0 || alreadyActive > 0) {
      void vscode.window.showInformationMessage(
        t("app.restoreArchivedPartialMulti", restored, alreadyActive, failed, cancelled),
      );
    } else {
      if (undoPairs.length > 0) offerUndo(t("app.restoreArchivedDoneMulti", restored));
      else void vscode.window.showInformationMessage(t("app.restoreArchivedDoneMulti", restored));
    }

    return { activeFsPath: firstActiveFsPath, success: restored > 0 || alreadyActive > 0 };
  };

  const archiveSessions = async (sessions: readonly SessionSummary[]): Promise<{ archivedFsPath?: string; success: boolean }> => {
    if (sessions.length === 0) {
      void vscode.window.showInformationMessage(t("app.archiveSessionUnsupported"));
      return { success: false };
    }
    if (sessions.some((session) => session.source !== "codex" || session.storage.archiveState !== "active")) {
      void vscode.window.showInformationMessage(t("app.archiveSessionUnsupported"));
      return { success: false };
    }

    const latestConfig = getConfig();
    if (!latestConfig.enableCodexArchivedSessions) {
      void vscode.window.showInformationMessage(t("app.archiveSessionUnavailable"));
      return { success: false };
    }

    const confirm = await vscode.window.showWarningMessage(
      sessions.length === 1 ? t("app.archiveSessionConfirm") : t("app.archiveSessionConfirmMulti", sessions.length),
      { modal: true },
      t("app.archiveSessionMove"),
    );
    if (confirm !== t("app.archiveSessionMove")) return { success: false };

    let archived = 0;
    let alreadyArchived = 0;
    let failed = 0;
    let cancelled = 0;
    let firstArchivedFsPath: string | undefined;

    await vscode.window.withProgress(
      {
        location: sessions.length === 1 ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification,
        title: sessions.length === 1 ? t("app.archiveSessionProgress") : t("app.archiveSessionProgressMulti", sessions.length),
        cancellable: sessions.length > 1,
      },
      async (progress, token) => {
        for (let i = 0; i < sessions.length; i += 1) {
          if (token.isCancellationRequested) {
            cancelled = sessions.length - i;
            break;
          }
          const session = sessions[i]!;
          if (sessions.length > 1) progress.report({ message: `${i + 1}/${sessions.length}` });
          try {
            const result = await archiveSessionToArchived(session, latestConfig, {
              extensionVersion: resolveExtensionVersion(context),
              logger,
            });
            if (!firstArchivedFsPath) firstArchivedFsPath = result.archivedFsPath;
            if (result.kind === "archived") {
              archived += 1;
              await sessionReferenceRelocator.relocate(result.activeFsPath, result.archivedFsPath);
            } else {
              alreadyArchived += 1;
            }
          } catch (error) {
            failed += 1;
            logger.debug(
              formatDebugFields("archiveSession.failed", {
                error: sanitizeDebugError(error),
              }),
            );
          }
        }
      },
    );

    await refreshHistoryIndex(false);
    refreshViews({ clearSearch: true });
    offerHistoryReloadHint();

    if (sessions.length === 1) {
      if (archived > 0) {
        void vscode.window.showInformationMessage(t("app.archiveSessionDone"));
      } else if (alreadyArchived > 0) {
        void vscode.window.showInformationMessage(t("app.archiveSessionAlreadyArchived"));
      } else if (failed > 0) {
        void vscode.window.showErrorMessage(t("app.archiveSessionFailed"));
      }
    } else if (failed > 0 || cancelled > 0 || alreadyArchived > 0) {
      void vscode.window.showInformationMessage(
        t("app.archiveSessionPartialMulti", archived, alreadyArchived, failed, cancelled),
      );
    } else {
      void vscode.window.showInformationMessage(t("app.archiveSessionDoneMulti", archived));
    }

    return { archivedFsPath: firstArchivedFsPath, success: archived > 0 || alreadyArchived > 0 };
  };

  // Register commands (palette + context menus).
  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.refresh", async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: t("app.loadingHistory") },
        async () => refreshHistoryIndex(false),
      );
      refreshViews({ clearSearch: true });
      controlProvider.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.refreshPinned", async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: t("app.loadingPinned") },
        async () => refreshHistoryIndex(false),
      );
      pinnedProvider.refresh();
      statusProvider.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.refreshHistoryPane", async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: t("app.loadingHistoryPane") },
        async () => refreshHistoryIndex(false),
      );
      historyProvider.refresh();
      statusProvider.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.showHistoryLatestView", async () => {
      await applyHistoryViewMode("latest", { persist: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.showHistoryDateView", async () => {
      await applyHistoryViewMode("date", { persist: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.refreshStatusPane", async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: t("app.loadingStatus") },
        async () => refreshHistoryIndex(false),
      );
      statusProvider.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.filterArchiveLocation", async () => {
      if (historySourceFilter === "claude") return false;
      await applyArchiveLocationFilter(nextArchiveLocationFilter(archiveLocationFilter), {
        persist: true,
        rerunSearch: true,
      });
      return true;
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.toggleArchivedSessionsVisibility", async () => {
      await applyArchivedSessionsVisibility(archiveLocationFilter === "activeOnly", { persist: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.rebuildCache", async () => {
      const choice = await vscode.window.showWarningMessage(
        t("app.rebuildCacheConfirm"),
        { modal: true },
        "OK",
      );
      if (choice !== "OK") return;

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: t("app.rebuildingCache") },
        async (progress, token) => {
          await refreshHistoryIndex(true);
          await rebuildSearchIndex(progress, token);
        },
      );
      refreshViews({ clearSearch: true });
      controlProvider.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.rebuildSearchIndex", async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: t("app.rebuildingSearchIndex"), cancellable: true },
        async (progress, token) => rebuildSearchIndex(progress, token),
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.openSessionReusable", async (element?: unknown) => {
      await openReusableSessionFromElement(element);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.openFileChangeHistory", async (uri?: unknown) => {
      const fileUri = uri instanceof vscode.Uri ? uri : undefined;
      await fileChangeHistoryPanels.openForUri(fileUri);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.openSession", async (elementOrArgs?: unknown) => {
      const hasDirectFsPath =
        !!elementOrArgs &&
        typeof elementOrArgs === "object" &&
        !isSessionNode(elementOrArgs) &&
        typeof (elementOrArgs as { fsPath?: unknown }).fsPath === "string";
      if (hasDirectFsPath) {
        const session = resolveSessionFromElementOrFsPath(historyService, elementOrArgs);
        if (!session) return;
        const reveal = resolveRevealIndexFromArgs(elementOrArgs);
        if (await chatPanels.revealExistingSessionPanel(session.fsPath, reveal, { promoteReusable: true })) {
          return;
        }
        await chatPanels.openSession(session, { kind: "session", revealMessageIndex: reveal });
        return;
      }

      const targets = resolveTargets(elementOrArgs);
      const openTargets = collectOpenTargets(targets);
      if (openTargets.length > 1) {
        const total = openTargets.length;
        const limited = openTargets.slice(0, OPEN_MULTI_LIMIT);
        const msg =
          total > OPEN_MULTI_LIMIT
            ? t("app.openMultiConfirmLimit", total, OPEN_MULTI_LIMIT)
            : t("app.openMultiConfirm", total);
        const choice = await vscode.window.showWarningMessage(msg, { modal: true }, "OK");
        if (choice !== "OK") return;
        for (const it of limited) {
          if (
            await chatPanels.revealExistingSessionPanel(it.session.fsPath, it.revealMessageIndex, {
              promoteReusable: true,
            })
          ) {
            continue;
          }
          await chatPanels.openSession(it.session, { kind: "session", revealMessageIndex: it.revealMessageIndex });
        }
        return;
      }

      if (openTargets.length === 1) {
        const it = openTargets[0]!;
        if (
          await chatPanels.revealExistingSessionPanel(it.session.fsPath, it.revealMessageIndex, {
            promoteReusable: true,
          })
        ) {
          return;
        }
        await chatPanels.openSession(it.session, { kind: "session", revealMessageIndex: it.revealMessageIndex });
        return;
      }

      const session = resolveSessionFromElementOrActive(historyService, transcriptProvider.scheme, elementOrArgs);
      if (!session) return;
      const reveal = resolveRevealIndex(elementOrArgs);
      if (await chatPanels.revealExistingSessionPanel(session.fsPath, reveal, { promoteReusable: true })) {
        return;
      }
      await chatPanels.openSession(session, { kind: "session", revealMessageIndex: reveal });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.openSessionMarkdown", async (elementOrArgs?: unknown) => {
      // Switching from the chat webview passes args (fsPath), so do not prefer bulk-selection handling.
      const hasDirectFsPath =
        !!elementOrArgs &&
        typeof elementOrArgs === "object" &&
        !isSessionNode(elementOrArgs) &&
        typeof (elementOrArgs as { fsPath?: unknown }).fsPath === "string";
      if (hasDirectFsPath) {
        const session = resolveSessionFromElementOrFsPath(historyService, elementOrArgs);
        if (!session) return;
        const reveal = resolveRevealIndexFromArgs(elementOrArgs);
        await transcriptProvider.openSessionTranscript(session, { preview: false, revealMessageIndex: reveal });
        return;
      }

      const targets = resolveTargets(elementOrArgs);
      const openTargets = collectOpenTargets(targets);
      if (openTargets.length > 1) {
        const total = openTargets.length;
        const limited = openTargets.slice(0, OPEN_MULTI_LIMIT);
        const msg =
          total > OPEN_MULTI_LIMIT
            ? t("app.openMultiConfirmLimit", total, OPEN_MULTI_LIMIT)
            : t("app.openMultiConfirm", total);
        const choice = await vscode.window.showWarningMessage(msg, { modal: true }, "OK");
        if (choice !== "OK") return;
        for (const it of limited) {
          await transcriptProvider.openSessionTranscript(it.session, {
            preview: false,
            revealMessageIndex: it.revealMessageIndex,
          });
        }
        return;
      }

      if (openTargets.length === 1) {
        const it = openTargets[0]!;
        await transcriptProvider.openSessionTranscript(it.session, {
          preview: false,
          revealMessageIndex: it.revealMessageIndex,
        });
        return;
      }

      const session = resolveSessionFromElementOrActive(historyService, transcriptProvider.scheme, elementOrArgs);
      if (!session) return;
      const reveal = resolveRevealIndex(elementOrArgs);
      await transcriptProvider.openSessionTranscript(session, { preview: false, revealMessageIndex: reveal });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.copyResumePrompt", async (elementOrArgs?: unknown) => {
      // Resolve exactly one target session from tree selection or webview args, then copy its prompt excerpt.
      const session = resolveSingleSessionTarget(elementOrArgs);
      if (!session) return false;

      try {
        const { timeZone } = resolveDateTimeSettings();
        const excerpt = await renderResumeContext(session.fsPath, {
          timeZone,
          maxMessages: RESUME_MAX_MESSAGES,
          maxChars: RESUME_MAX_CHARS,
          includeContext: false,
        });
        await vscode.env.clipboard.writeText(excerpt);
        void vscode.window.showInformationMessage(t("app.copyResumePromptDone"));
        return true;
      } catch {
        void vscode.window.showErrorMessage(t("app.copyResumePromptFailed"));
        return false;
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.resumeSessionInCodex", async (elementOrArgs?: unknown) => {
      const session = resolveSingleSessionTarget(elementOrArgs);
      if (!session) return false;
      if (session.storage.archiveState === "archived") {
        void vscode.window.showInformationMessage(t("app.resumeArchivedUseRestore"));
        return false;
      }

      const opened = await openSessionInOpenAiCodex(session);
      if (!opened) return false;

      void vscode.window.showInformationMessage(t("app.resumeSessionInCodexDone"));
      return true;
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.resumeSessionInClaude", async (elementOrArgs?: unknown) => {
      const session = resolveSingleSessionTarget(elementOrArgs);
      if (!session) return false;

      const opened = await openSessionInClaudeCode(session);
      if (!opened) return false;

      void vscode.window.showInformationMessage(t("app.resumeSessionInClaudeDone"));
      return true;
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.handoffToCodex", async (elementOrArgs?: unknown) =>
      runCrossHandoff(elementOrArgs, "codex"),
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.handoffToClaude", async (elementOrArgs?: unknown) =>
      runCrossHandoff(elementOrArgs, "claude"),
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.copyHandoffPrompt", copyHandoffPromptToClipboard),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.createHandoffFile", createHandoffFileForSession),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.openSessionHandoff", openSessionHandoff),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.openSettings", async () => {
      // Open the VS Code Settings UI filtered to this extension.
      const extId = context.extension.id;
      await vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${extId}`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.searchConfigureDefaultRoles", async () => {
      const items = SEARCH_ROLE_ORDER.map((role) => ({ label: role, role }));
      const current = new Set(getConfiguredDefaultSearchRoles());
      const picked = await new Promise<readonly (typeof items)[number][] | undefined>((resolve) => {
        const qp = vscode.window.createQuickPick<(typeof items)[number]>();
        qp.title = t("search.roles.defaultTitle");
        qp.placeholder = t("search.roles.defaultPlaceholder");
        qp.canSelectMany = true;
        qp.items = items;
        qp.selectedItems = items.filter((it) => current.has(it.role));
        let done = false;
        const finish = (value: readonly (typeof items)[number][] | undefined): void => {
          if (done) return;
          done = true;
          resolve(value);
          qp.dispose();
        };
        qp.onDidAccept(() => finish(qp.selectedItems));
        qp.onDidHide(() => finish(undefined));
        qp.show();
      });
      if (!picked) return;

      const next = sanitizeIndexedSearchRoles(picked.map((x) => x.role));
      await vscode.workspace
        .getConfiguration("codexHistoryViewer")
        .update(SEARCH_DEFAULT_ROLES_CONFIG, next, vscode.ConfigurationTarget.Global);
      statusProvider.refresh();
      void vscode.window.showInformationMessage(t("search.roles.defaultUpdated", next.join(", ")));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.search", async () => {
      await executeSearch();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.searchRerun", async () => {
      if (lastSearchRequest) {
        await executeSearch(lastSearchRequest);
        return;
      }
      await executeSearch();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.searchClearResults", async () => {
      searchProvider.clear();
      setHasSearchResultsContext(false);
      statusProvider.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.searchFilterByTag", async (tagArg?: unknown) => {
      const singleTag = typeof tagArg === "string" ? tagArg.trim() : "";
      if (singleTag) {
        const isSameSingle =
          searchTagFilter.length === 1 &&
          searchTagFilter[0]!.toLowerCase() === singleTag.toLowerCase();
        await applySearchTagFilter(isSameSingle ? [] : [singleTag], { persist: true, rerunSearch: true });
        return;
      }

      const tagStats = annotationStore.listTagStats();
      if (tagStats.length === 0) {
        void vscode.window.showInformationMessage(t("tag.noTagsAvailable"));
        return;
      }

      const items = tagStats.map((x) => ({
        label: `#${x.tag}`,
        description: `${x.count}`,
        tag: x.tag,
      }));

      const picked = await new Promise<readonly (typeof items)[number][] | undefined>((resolve) => {
        const qp = vscode.window.createQuickPick<(typeof items)[number]>();
        qp.title = t("search.tagFilter.title");
        qp.placeholder = t("search.tagFilter.placeholder");
        qp.canSelectMany = true;
        qp.items = items;
        const currentKeys = new Set(searchTagFilter.map((x) => x.toLowerCase()));
        qp.selectedItems = items.filter((x) => currentKeys.has(x.tag.toLowerCase()));
        let done = false;
        const finish = (value: readonly (typeof items)[number][] | undefined): void => {
          if (done) return;
          done = true;
          resolve(value);
          qp.dispose();
        };
        qp.onDidAccept(() => finish(qp.selectedItems));
        qp.onDidHide(() => finish(undefined));
        qp.show();
      });
      if (!picked) return;

      await applySearchTagFilter(
        picked.map((x) => x.tag),
        { persist: true, rerunSearch: true },
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.clearSearchTagFilter", async () => {
      if (searchTagFilter.length === 0) return;
      await applySearchTagFilter([], { persist: true, rerunSearch: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.filterPinnedByTag", async (tagArg?: unknown) => {
      const singleTag = typeof tagArg === "string" ? tagArg.trim() : "";
      if (singleTag) {
        const isSameSingle =
          pinnedTagFilter.length === 1 &&
          pinnedTagFilter[0]!.toLowerCase() === singleTag.toLowerCase();
        await applyPinnedTagFilter(isSameSingle ? [] : [singleTag], { persist: true });
        return;
      }

      const tagStats = annotationStore.listTagStats();
      if (tagStats.length === 0) {
        void vscode.window.showInformationMessage(t("tag.noTagsAvailable"));
        return;
      }

      const items = tagStats.map((x) => ({
        label: `#${x.tag}`,
        description: `${x.count}`,
        tag: x.tag,
      }));

      const picked = await new Promise<readonly (typeof items)[number][] | undefined>((resolve) => {
        const qp = vscode.window.createQuickPick<(typeof items)[number]>();
        qp.title = t("pinned.tagFilter.title");
        qp.placeholder = t("pinned.tagFilter.placeholder");
        qp.canSelectMany = true;
        qp.items = items;
        const currentKeys = new Set(pinnedTagFilter.map((x) => x.toLowerCase()));
        qp.selectedItems = items.filter((x) => currentKeys.has(x.tag.toLowerCase()));
        let done = false;
        const finish = (value: readonly (typeof items)[number][] | undefined): void => {
          if (done) return;
          done = true;
          resolve(value);
          qp.dispose();
        };
        qp.onDidAccept(() => finish(qp.selectedItems));
        qp.onDidHide(() => finish(undefined));
        qp.show();
      });
      if (!picked) return;

      await applyPinnedTagFilter(picked.map((x) => x.tag), { persist: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.clearPinnedTagFilter", async () => {
      if (pinnedTagFilter.length === 0) return;
      await applyPinnedTagFilter([], { persist: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.searchRunPreset", async () => {
      const presets = searchPresetStore.getAll();
      if (presets.length === 0) {
        void vscode.window.showInformationMessage(t("savedSearches.noPresets"));
        return;
      }
      const picked = await vscode.window.showQuickPick(
        presets.map((p) => ({
          label: p.name,
          description: p.request.queryInput,
          detail: p.request.roleFilter.join(", "),
          presetId: p.id,
        })),
        {
          title: t("savedSearches.run.title"),
        },
      );
      if (!picked) return;
      await runSearchPresetById(picked.presetId);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.searchSavePreset", async () => {
      if (!lastSearchRequest) {
        void vscode.window.showInformationMessage(t("savedSearches.noRequestToSave"));
        return;
      }

      const suggested = lastSearchRequest.queryInput.slice(0, 80);
      const nameInput = await vscode.window.showInputBox({
        title: t("savedSearches.save.title"),
        prompt: t("savedSearches.save.prompt"),
        value: suggested,
        validateInput: (v) => (v.trim().length === 0 ? t("common.nameRequired") : undefined),
      });
      if (nameInput === undefined) return;
      const name = nameInput.trim();
      if (!name) return;

      const existing = searchPresetStore.getAll().find((p) => p.name.toLowerCase() === name.toLowerCase());
      await searchPresetStore.save({
        name,
        request: lastSearchRequest,
        overwriteId: existing?.id,
      });
      statusProvider.refresh();
      void vscode.window.showInformationMessage(t("savedSearches.saved", name));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.searchDeletePreset", async () => {
      const presets = searchPresetStore.getAll();
      if (presets.length === 0) {
        void vscode.window.showInformationMessage(t("savedSearches.noPresetsToDelete"));
        return;
      }

      const picked = await vscode.window.showQuickPick(
        presets.map((p) => ({
          label: p.name,
          description: p.request.queryInput,
          presetId: p.id,
        })),
        {
          title: t("savedSearches.delete.title"),
        },
      );
      if (!picked) return;

      const deleted = await searchPresetStore.delete(picked.presetId);
      if (!deleted) return;
      statusProvider.refresh();
      void vscode.window.showInformationMessage(t("savedSearches.deleted", picked.label));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.exportSessions", async (element?: unknown) => {
      const sessions = collectSessionsFromTargets(resolveTargets(element));
      if (sessions.length === 0) {
        void vscode.window.showInformationMessage(t("export.noSessionsSelected"));
        return;
      }

      const mode = await vscode.window.showQuickPick(
        [
          { label: t("export.format.rawJsonl"), value: "raw" as const },
          { label: t("export.format.sanitizedMarkdown"), value: "masked" as const },
        ],
        { title: t("export.format.title") },
      );
      if (!mode) return;

      const result =
        mode.value === "masked"
          ? await exportMaskedTranscripts({ sessions })
          : await exportSessions({
              sessions,
              codexSessionsRoot: getConfig().sessionsRoot,
              claudeSessionsRoot: getConfig().claudeSessionsRoot,
            });
      if (!result) return;

      void vscode.window.showInformationMessage(
        t("export.done", result.exported, result.failed, result.skipped),
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.importSessions", async () => {
      const modePick = await vscode.window.showQuickPick(
        [
          {
            label: t("import.duplicate.skip"),
            mode: "skip" as const,
          },
          {
            label: t("import.duplicate.overwrite"),
            mode: "overwrite" as const,
          },
        ],
        { title: t("import.duplicate.title") },
      );
      if (!modePick) return;

      const before = historyService.getIndex();
      const latestConfig = getConfig();
      const result = await importSessions({
        codexSessionsRoot: latestConfig.sessionsRoot,
        claudeSessionsRoot: latestConfig.claudeSessionsRoot,
        existingSessions: before.sessions,
        duplicateIdMode: modePick.mode,
      });
      if (!result) return;

      await refreshHistoryIndex(false);
      refreshViews({ clearSearch: true });
      controlProvider.refresh();
      if (result.imported > 0 || result.overwritten > 0) offerHistoryReloadHint();

      void vscode.window.showInformationMessage(
        t("import.done", result.imported, result.overwritten, result.failed, result.skipped),
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.cleanupMissingPins", async () => {
      const missingPins = pinStore
        .getAll()
        .filter((pin) => !historyService.findByFsPath(pin.fsPath));
      const missingPaths = missingPins.map((pin) => pin.fsPath);
      if (missingPaths.length === 0) {
        void vscode.window.showInformationMessage(t("pins.noMissing"));
        return;
      }

      const choice = await vscode.window.showWarningMessage(
        t("pins.removeMissingConfirm", missingPaths.length),
        { modal: true },
        "OK",
      );
      if (choice !== "OK") return;

      const { unpinned } = await pinStore.unpinMany(missingPaths);
      refreshViews();
      if (unpinned > 0) {
        pushUndoAction(t("undo.label.cleanupMissingPins", unpinned), async () => {
          await pinStore.restore(missingPins);
          refreshViews();
        });
        offerUndo(t("app.cleanupMissingPinsDone", unpinned));
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.emptyTrash", async () => {
      await refreshStorageStats();
      const legacyFiles = await listLegacyFiles(context.globalStorageUri);
      const trashCount = storageStats.trashFileCount;

      if (trashCount === 0 && legacyFiles.length === 0) {
        void vscode.window.showInformationMessage(t("trash.empty"));
        return;
      }

      const confirmMessage = t("trash.deleteConfirm", trashCount);
      const choice = await vscode.window.showWarningMessage(confirmMessage, { modal: true }, "OK");
      if (choice !== "OK") return;

      const result = await emptyTrashAndCleanupLegacy(context.globalStorageUri);
      await refreshStorageStats();
      statusProvider.refresh();

      if (result.failedPaths.length > 0) {
        void vscode.window.showWarningMessage(
          t("trash.cleanupPartialFailed", result.removedTrashFiles, result.failedPaths.length),
        );
        return;
      }

      void vscode.window.showInformationMessage(
        t("trash.removed", result.removedTrashFiles),
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.cleanupHandoffs", async () => {
      await refreshStorageStats();
      const handoffCount = storageStats.handoffCount;
      const handoffBytes = storageStats.handoffBytes;

      if (handoffCount === 0) {
        void vscode.window.showInformationMessage(t("handoff.cleanupEmpty"));
        return;
      }

      const choice = await vscode.window.showWarningMessage(
        t("handoff.cleanupConfirm", handoffCount, formatBytesForUi(handoffBytes)),
        { modal: true },
        "OK",
      );
      if (choice !== "OK") return;

      const result = await cleanupHandoffs(context.globalStorageUri, { mode: "all" });
      await refreshStorageStats();
      statusProvider.refresh();

      if (result.failedPaths.length > 0) {
        void vscode.window.showWarningMessage(
          t("handoff.cleanupPartialFailed", result.removedHandoffs, result.failedPaths.length),
        );
        return;
      }

      void vscode.window.showInformationMessage(t("handoff.cleanupRemoved", result.removedHandoffs));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.undoLastAction", async () => {
      const action = await undoService.undoLast();
      if (!action) {
        void vscode.window.showInformationMessage(t("undo.none"));
        return;
      }
      if (action.postUndoRefresh !== "none") {
        await refreshHistoryIndex(false);
        refreshViews({ clearSearch: true });
      }
      void vscode.window.showInformationMessage(t("undo.done", action.label));
    }),
  );

  const resolveCustomTitleSession = (element?: unknown): SessionSummary | undefined =>
    resolveSessionFromElementOrFsPath(historyService, element) ??
    resolveSessionFromElementOrActive(historyService, transcriptProvider.scheme, element);

  const clearCustomTitleForSession = async (session: SessionSummary): Promise<boolean> => {
    const previousTitle = normalizeCustomTitle(titleOverrideStore.getTitle(session) ?? session.customTitle ?? "");
    const changed = await titleOverrideStore.clear(session);
    if (!changed) {
      logger.debug(
        formatDebugFields("customTitle clear noop", {
          session: safeDebugBasename(session.fsPath),
          hadTitle: !!previousTitle,
        }),
      );
      void vscode.window.showInformationMessage(t("customTitle.noChanges"));
      return false;
    }

    await refreshAfterTitleOverrideChange();
    logger.debug(
      formatDebugFields("customTitle clear done", {
        session: safeDebugBasename(session.fsPath),
        hadTitle: !!previousTitle,
      }),
    );
    if (previousTitle) {
      pushUndoAction(
        t("undo.label.customTitleClear"),
        async () => {
          await titleOverrideStore.set(session, previousTitle);
          await refreshAfterTitleOverrideChange();
          logger.debug(
            formatDebugFields("customTitle undoClear done", {
              session: safeDebugBasename(session.fsPath),
            }),
          );
        },
        undefined,
        { postUndoRefresh: "none" },
      );
      offerUndo(t("customTitle.cleared"));
    } else {
      void vscode.window.showInformationMessage(t("customTitle.cleared"));
    }
    return true;
  };

  const setCustomTitleForSession = async (session: SessionSummary): Promise<boolean> => {
    const input = await vscode.window.showInputBox({
      title: t("customTitle.input.title"),
      prompt: t("customTitle.input.prompt"),
      value: session.customTitle ?? session.displayTitle,
      validateInput: (value) => {
        const normalized = normalizeCustomTitle(value);
        return isCustomTitleTooLong(normalized)
          ? t("customTitle.error.tooLong", getMaxCustomTitleLength())
          : undefined;
      },
    });
    if (input === undefined) return false;

    const nextTitle = normalizeCustomTitle(input);
    if (isCustomTitleTooLong(nextTitle)) {
      void vscode.window.showErrorMessage(t("customTitle.error.tooLong", getMaxCustomTitleLength()));
      return false;
    }

    const originalTitle = normalizeCustomTitle(session.originalTitle ?? session.displayTitle);
    const currentTitle = normalizeCustomTitle(session.customTitle ?? "");
    if (!nextTitle || (originalTitle && nextTitle === originalTitle)) {
      return clearCustomTitleForSession(session);
    }

    if (currentTitle === nextTitle) {
      logger.debug(
        formatDebugFields("customTitle set noop", {
          session: safeDebugBasename(session.fsPath),
          hadTitle: !!currentTitle,
        }),
      );
      void vscode.window.showInformationMessage(t("customTitle.noChanges"));
      return false;
    }

    await titleOverrideStore.set(session, nextTitle);
    await refreshAfterTitleOverrideChange();
    logger.debug(
      formatDebugFields("customTitle set done", {
        session: safeDebugBasename(session.fsPath),
        hadTitle: !!currentTitle,
        length: nextTitle.length,
      }),
    );
    void vscode.window.showInformationMessage(t("customTitle.saved"));
    return true;
  };

  const manageCustomTitleForSession = async (session: SessionSummary): Promise<boolean> => {
    const items: Array<vscode.QuickPickItem & { action: "set" | "clear" }> = [
      {
        label: t("customTitle.action.set"),
        action: "set",
      },
    ];
    if (normalizeCustomTitle(session.customTitle ?? "")) {
      items.push({
        label: t("customTitle.action.clear"),
        description: t("customTitle.action.clear.description"),
        action: "clear",
      });
    }

    const picked = await vscode.window.showQuickPick(items, {
      title: t("customTitle.manage.title"),
      placeHolder: t("customTitle.manage.placeholder"),
    });
    if (!picked) return false;
    logger.debug(
      formatDebugFields("customTitle manage pick", {
        session: safeDebugBasename(session.fsPath),
        action: picked.action,
      }),
    );
    return picked.action === "clear" ? clearCustomTitleForSession(session) : setCustomTitleForSession(session);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.setCustomTitle", async (element?: unknown) => {
      const session = resolveCustomTitleSession(element);
      if (!session) {
        void vscode.window.showInformationMessage(t("customTitle.noSessionSelected"));
        return false;
      }
      return setCustomTitleForSession(session);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.clearCustomTitle", async (element?: unknown) => {
      const session = resolveCustomTitleSession(element);
      if (!session) {
        void vscode.window.showInformationMessage(t("customTitle.noSessionSelected"));
        return false;
      }
      return clearCustomTitleForSession(session);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.manageCustomTitle", async (element?: unknown) => {
      const session = resolveCustomTitleSession(element);
      if (!session) {
        void vscode.window.showInformationMessage(t("customTitle.noSessionSelected"));
        return false;
      }
      return manageCustomTitleForSession(session);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.editSessionAnnotation", async (element?: unknown) => {
      const sessions = resolveAnnotationTargets(element);
      if (sessions.length === 0) {
        void vscode.window.showInformationMessage(t("annotation.noSessionSelected"));
        return;
      }

      const action = await vscode.window.showQuickPick(
        [
          { label: t("annotation.action.edit"), value: "edit" as const },
          { label: t("annotation.action.addExisting"), value: "addExisting" as const },
          { label: t("annotation.action.remove"), value: "remove" as const },
        ],
        { title: t("annotation.action.title") },
      );
      if (!action) return;

      const previous = snapshotAnnotations(sessions);
      const sessionPaths = sessions.map((s) => s.fsPath);
      let changed = 0;

      if (action.value === "edit") {
        const seed = sessions.length === 1 ? annotationStore.get(sessions[0]!.fsPath) : null;
        const tagsInput = await vscode.window.showInputBox({
          title: t("annotation.editTags.title"),
          prompt: t("annotation.editTags.prompt"),
          value: seed?.tags.join(", ") ?? "",
        });
        if (tagsInput === undefined) return;

        const noteInput = await vscode.window.showInputBox({
          title: t("annotation.editNote.title"),
          prompt: t("annotation.editNote.prompt"),
          value: seed?.note ?? "",
        });
        if (noteInput === undefined) return;

        const tags = normalizeTags(tagsInput.split(","));
        const note = noteInput.trim();
        for (const s of sessions) {
          const current = annotationStore.get(s.fsPath);
          if (isSameAnnotationValue(current, tags, note)) continue;
          await annotationStore.set(s.fsPath, { tags, note });
          changed += 1;
        }
      } else if (action.value === "addExisting") {
        const tagStats = annotationStore.listTagStats();
        if (tagStats.length === 0) {
          void vscode.window.showInformationMessage(t("tag.noTagsAvailable"));
          return;
        }
        const picked = await vscode.window.showQuickPick(
          tagStats.map((x) => ({
            label: `#${x.tag}`,
            description: `${x.count}`,
            tag: x.tag,
          })),
          { title: t("annotation.addTags.title"), canPickMany: true },
        );
        if (!picked || picked.length === 0) return;
        changed = await annotationStore.addTagsMany(sessionPaths, picked.map((x) => x.tag));
      } else {
        const tagUnion = new Map<string, string>();
        for (const s of sessions) {
          const current = annotationStore.get(s.fsPath);
          for (const tag of current?.tags ?? []) {
            const key = tag.toLowerCase();
            if (!tagUnion.has(key)) tagUnion.set(key, tag);
          }
        }
        if (tagUnion.size === 0) {
          void vscode.window.showInformationMessage(t("annotation.removeTags.noTags"));
          return;
        }
        const picked = await vscode.window.showQuickPick(
          Array.from(tagUnion.values()).map((tag) => ({ label: `#${tag}`, tag })),
          { title: t("annotation.removeTags.title"), canPickMany: true },
        );
        if (!picked || picked.length === 0) return;
        changed = await annotationStore.removeTagsMany(sessionPaths, picked.map((x) => x.tag));
      }

      if (changed <= 0) {
        void vscode.window.showInformationMessage(t("annotation.noChanges"));
        return;
      }
      refreshViews();

      pushUndoAction(t("undo.label.annotationUpdate", sessions.length), async () => {
        await restoreAnnotations(sessions, previous);
      });
      offerUndo(t("undo.offer.annotationUpdate", changed));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.removeSessionTag", async (elementOrArgs?: unknown) => {
      const tag =
        typeof elementOrArgs === "string"
          ? elementOrArgs.trim()
          : elementOrArgs &&
              typeof elementOrArgs === "object" &&
              typeof (elementOrArgs as { tag?: unknown }).tag === "string"
            ? String((elementOrArgs as { tag: string }).tag).trim()
            : "";
      if (!tag) return;

      const sessions = resolveAnnotationTargets(elementOrArgs);
      if (sessions.length === 0) return;

      const previous = snapshotAnnotations(sessions);
      const changed = await annotationStore.removeTagsMany(
        sessions.map((s) => s.fsPath),
        [tag],
      );
      if (changed <= 0) return;

      refreshViews();
      pushUndoAction(t("undo.label.removeTag", tag), async () => {
        await restoreAnnotations(sessions, previous);
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.renameTagGlobally", async () => {
      const tagStats = annotationStore.listTagStats();
      if (tagStats.length === 0) {
        void vscode.window.showInformationMessage(t("tagRename.noTags"));
        return;
      }

      const sourcePicked = await vscode.window.showQuickPick(
        tagStats.map((x) => ({
          label: `#${x.tag}`,
          description: `${x.count}`,
          tag: x.tag,
        })),
        { title: t("tagRename.sourceTitle") },
      );
      if (!sourcePicked) return;

      const sourceTag = sourcePicked.tag;
      const nextInput = await vscode.window.showInputBox({
        title: t("tagRename.destinationTitle"),
        prompt: t("tagRename.destinationPrompt"),
        value: sourceTag,
        validateInput: (v) => {
          const normalized = normalizeTags([String(v ?? "").replace(/^#+/, "").trim()]);
          return normalized.length > 0 ? undefined : t("tagRename.nameRequired");
        },
      });
      if (nextInput === undefined) return;

      const normalized = normalizeTags([String(nextInput ?? "").replace(/^#+/, "").trim()]);
      if (normalized.length === 0) {
        void vscode.window.showErrorMessage(t("tagRename.invalid"));
        return;
      }
      const destinationTag = normalized[0]!;
      if (destinationTag.toLowerCase() === sourceTag.toLowerCase()) {
        void vscode.window.showInformationMessage(t("tagRename.unchanged"));
        return;
      }

      const sourceKey = sourceTag.toLowerCase();
      const annotations = annotationStore.getAll();
      const changed = new Map<string, { fsPath: string; before: { tags: string[]; note: string } | null }>();
      let changedCount = 0;
      for (const ann of annotations) {
        const hasSource = ann.tags.some((tag) => String(tag ?? "").toLowerCase() === sourceKey);
        if (!hasSource) continue;

        const nextTags = normalizeTags(
          ann.tags.map((tag) => (String(tag ?? "").toLowerCase() === sourceKey ? destinationTag : tag)),
        );
        if (isSameAnnotationValue({ tags: ann.tags, note: ann.note }, nextTags, ann.note)) continue;

        const key = normalizeCacheKey(ann.fsPath);
        if (!changed.has(key)) {
          changed.set(key, {
            fsPath: ann.fsPath,
            before: { tags: [...ann.tags], note: ann.note },
          });
        }

        await annotationStore.set(ann.fsPath, { tags: nextTags, note: ann.note });
        changedCount += 1;
      }

      if (changedCount <= 0) {
        void vscode.window.showInformationMessage(t("tag.noMatching"));
        return;
      }

      refreshViews();
      pushUndoAction(t("undo.label.renameTagGlobally", sourceTag, destinationTag), async () => {
        for (const entry of changed.values()) {
          if (!entry.before) {
            await annotationStore.remove(entry.fsPath);
          } else {
            await annotationStore.set(entry.fsPath, {
              tags: entry.before.tags,
              note: entry.before.note,
            });
          }
        }
        refreshViews();
      });
      offerUndo(t("tagRename.done", sourceTag, destinationTag, changedCount));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.deleteTagsGlobally", async () => {
      const tagStats = annotationStore.listTagStats();
      if (tagStats.length === 0) {
        void vscode.window.showInformationMessage(t("tagDelete.noTags"));
        return;
      }

      const picked = await vscode.window.showQuickPick(
        tagStats.map((x) => ({
          label: `#${x.tag}`,
          description: `${x.count}`,
          tag: x.tag,
        })),
        {
          title: t("tagDelete.title"),
          canPickMany: true,
        },
      );
      if (!picked || picked.length === 0) return;

      const removeKeys = new Set(picked.map((x) => x.tag.toLowerCase()));
      const annotations = annotationStore.getAll();
      const changed = new Map<string, { fsPath: string; before: { tags: string[]; note: string } | null }>();
      let changedCount = 0;
      for (const ann of annotations) {
        const nextTags = ann.tags.filter((tag) => !removeKeys.has(String(tag ?? "").toLowerCase()));
        if (isSameAnnotationValue({ tags: ann.tags, note: ann.note }, nextTags, ann.note)) continue;

        const key = normalizeCacheKey(ann.fsPath);
        if (!changed.has(key)) {
          changed.set(key, {
            fsPath: ann.fsPath,
            before: { tags: [...ann.tags], note: ann.note },
          });
        }

        await annotationStore.set(ann.fsPath, { tags: nextTags, note: ann.note });
        changedCount += 1;
      }

      if (changedCount <= 0) {
        void vscode.window.showInformationMessage(t("tag.noMatching"));
        return;
      }

      refreshViews();
      pushUndoAction(t("undo.label.deleteTagsGlobally", picked.length), async () => {
        for (const entry of changed.values()) {
          if (!entry.before) {
            await annotationStore.remove(entry.fsPath);
          } else {
            await annotationStore.set(entry.fsPath, {
              tags: entry.before.tags,
              note: entry.before.note,
            });
          }
        }
        refreshViews();
      });
      offerUndo(t("tagDelete.done", changedCount));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.filterHistory", async () => {
      const idx = historyService.getIndex();
      const change = await promptHistoryFilter(idx, {
        date: historyFilter,
        projectCwd: historyProjectCwd,
        source: historySourceFilter,
        sourceOptions: getHistorySourceOptionsForPrompt(),
        archiveLocation: archiveLocationFilter,
        tags: historyTagFilter,
        availableTags: annotationStore.listTagStats().map((x) => x.tag),
      });
      if (!change) return;
      if (change.kind === "archiveLocation") {
        await applyArchiveLocationFilter(change.archiveLocation, { persist: true, rerunSearch: true });
        return;
      }
      const next = {
        date: change.kind === "date" ? change.date : historyFilter,
        projectCwd: change.kind === "project" ? change.projectCwd : historyProjectCwd,
        source: change.kind === "source" ? change.source : historySourceFilter,
        tags: change.kind === "tags" ? change.tags : historyTagFilter,
      };
      await applyHistoryFilters(next, { persist: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.clearHistoryFilter", async () => {
      await applyHistoryFilters({ date: { kind: "all" }, projectCwd: null, source: "all", tags: [] }, { persist: true });
      await applyArchiveLocationFilter("activeOnly", { persist: true, rerunSearch: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.filterHistoryByTag", async (tagArg?: unknown) => {
      const singleTag = typeof tagArg === "string" ? tagArg.trim() : "";
      if (singleTag) {
        const normalizedCurrent = sanitizeTagFilter(historyTagFilter);
        const isSameSingle =
          normalizedCurrent.length === 1 &&
          normalizedCurrent[0]!.toLowerCase() === singleTag.toLowerCase();
        await applyHistoryFilters(
          {
            date: historyFilter,
            projectCwd: historyProjectCwd,
            source: historySourceFilter,
            tags: isSameSingle ? [] : [singleTag],
          },
          { persist: true },
        );
        return;
      }

      const tagStats = annotationStore.listTagStats();
      if (tagStats.length === 0) {
        void vscode.window.showInformationMessage(t("tag.noTagsAvailable"));
        return;
      }

      const items = tagStats.map((x) => ({
        label: `#${x.tag}`,
        description: `${x.count}`,
        tag: x.tag,
      }));

      const picked = await new Promise<readonly (typeof items)[number][] | undefined>((resolve) => {
        const qp = vscode.window.createQuickPick<(typeof items)[number]>();
        qp.title = t("history.tags.filterTitle");
        qp.placeholder = t("history.tags.placeholder");
        qp.canSelectMany = true;
        qp.items = items;
        const currentKeys = new Set(historyTagFilter.map((x) => x.toLowerCase()));
        qp.selectedItems = items.filter((x) => currentKeys.has(x.tag.toLowerCase()));
        let done = false;
        const finish = (value: readonly (typeof items)[number][] | undefined): void => {
          if (done) return;
          done = true;
          resolve(value);
          qp.dispose();
        };
        qp.onDidAccept(() => finish(qp.selectedItems));
        qp.onDidHide(() => finish(undefined));
        qp.show();
      });
      if (!picked) return;

      const nextTags = sanitizeTagFilter(picked.map((x) => x.tag));
      await applyHistoryFilters(
        {
          date: historyFilter,
          projectCwd: historyProjectCwd,
          source: historySourceFilter,
          tags: nextTags,
        },
        { persist: true },
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.clearHistoryTagFilter", async () => {
      await applyHistoryFilters(
        {
          date: historyFilter,
          projectCwd: historyProjectCwd,
          source: historySourceFilter,
          tags: [],
        },
        { persist: true },
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.filterHistoryCurrentProject", async () => {
      const workspaceFolder = resolveCurrentWorkspaceFolder();
      if (!workspaceFolder) {
        void vscode.window.showInformationMessage(t("history.project.current.noWorkspace"));
        return;
      }

      const idx = historyService.getIndex();
      const targetProjectCwd = resolveCurrentProjectFilterCwd(idx, workspaceFolder.uri.fsPath);
      const sameProject =
        !!historyProjectCwd && normalizeCacheKey(historyProjectCwd) === normalizeCacheKey(targetProjectCwd);

      await applyHistoryFilters(
        {
          date: historyFilter,
          // If the same project filter is already active, allow toggling it off with a second invocation.
          projectCwd: sameProject ? null : targetProjectCwd,
          source: historySourceFilter,
          tags: historyTagFilter,
        },
        { persist: true },
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.cycleHistorySourceFilter", async () => {
      await cycleHistorySourceFilter();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.toggleHistorySourceCodex", async () => {
      await toggleHistorySource("codex");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.toggleHistorySourceClaude", async () => {
      await toggleHistorySource("claude");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.filterHistorySourceCodex", async () => {
      await applyHistoryFilters(
        {
          date: historyFilter,
          projectCwd: historyProjectCwd,
          source: "codex",
          tags: historyTagFilter,
        },
        { persist: true },
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.filterHistorySourceClaude", async () => {
      await applyHistoryFilters(
        {
          date: historyFilter,
          projectCwd: historyProjectCwd,
          source: "claude",
          tags: historyTagFilter,
        },
        { persist: true },
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.clearHistorySourceFilter", async () => {
      await applyHistoryFilters(
        {
          date: historyFilter,
          projectCwd: historyProjectCwd,
          source: "all",
          tags: historyTagFilter,
        },
        { persist: true },
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.restoreArchivedSession", async (elementOrArgs?: unknown) => {
      const { sessions, invalidCount, direct } = resolveMoveCommandTargets(elementOrArgs);
      if (invalidCount > 0 || sessions.length === 0) {
        void vscode.window.showInformationMessage(t("app.restoreArchivedUnsupported"));
        return false;
      }
      const revealMessageIndex = direct ? resolveRevealIndexFromArgs(elementOrArgs) : undefined;
      const result = await restoreArchivedSessions(sessions);
      if (result.activeFsPath && typeof revealMessageIndex === "number") {
        await chatOpenPositionStore.set(result.activeFsPath, revealMessageIndex);
      }
      return result.activeFsPath ? { activeFsPath: result.activeFsPath } : result.success;
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.archiveSession", async (elementOrArgs?: unknown) => {
      const { sessions, invalidCount } = resolveMoveCommandTargets(elementOrArgs);
      if (invalidCount > 0 || sessions.length === 0) {
        void vscode.window.showInformationMessage(t("app.archiveSessionUnsupported"));
        return false;
      }
      const result = await archiveSessions(sessions);
      return result.archivedFsPath ? { archivedFsPath: result.archivedFsPath } : result.success;
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.promoteSession", async (element?: unknown) => {
      // When multiple items are selected, bulk "promote" (copy) the selected sessions to today.
      const targets = resolveTargets(element);
      const byKey = new Map<string, SessionSummary>();
      for (const t of targets) {
        if (!isSessionNode(t)) continue;
        const s = t.session;
        const key = normalizeCacheKey(s.fsPath);
        if (!byKey.has(key)) byKey.set(key, s);
      }
      const selectedSessions = Array.from(byKey.values());
      const sessions = selectedSessions.filter((s) => s.storage.archiveState !== "archived");
      if (sessions.length === 0) {
        if (selectedSessions.length > 0) void vscode.window.showInformationMessage(t("app.promoteArchivedUnsupported"));
        return;
      }

      if (sessions.length === 1) {
        const choice = await vscode.window.showWarningMessage(t("app.promoteConfirm"), { modal: true }, "OK");
        if (choice !== "OK") return;

        const promoted = await promoteSessionCopyToToday(sessions[0]!, historyService, getConfig());
        await vscode.window.showInformationMessage(t("app.promoteDone"));
        pushUndoAction(t("undo.label.promote"), async () => {
          try {
            await vscode.workspace.fs.delete(vscode.Uri.file(promoted.fsPath), { recursive: false, useTrash: false });
          } catch {
            // Skip if already removed.
          }
        });
        offerUndo(t("app.promoteDone"));

        // Refresh views and open the newly created session.
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: t("app.loadingHistory") },
          async () => refreshHistoryIndex(false),
        );
        refreshViews({ clearSearch: true });
        await transcriptProvider.openSessionTranscript(promoted, { preview: false });
        offerHistoryReloadHint();
        return;
      }

      const choice = await vscode.window.showWarningMessage(
        t("app.promoteConfirmMulti", sessions.length),
        { modal: true },
        "OK",
      );
      if (choice !== "OK") return;

      const latestConfig = getConfig();
      let succeeded = 0;
      let failed = 0;
      const promotedPaths: string[] = [];
      for (const s of sessions) {
        try {
          const promoted = await promoteSessionCopyToToday(s, historyService, latestConfig);
          promotedPaths.push(promoted.fsPath);
          succeeded += 1;
        } catch {
          // Continue even if one item fails.
          failed += 1;
        }
      }
      void vscode.window.showInformationMessage(t("app.promoteDoneMulti", succeeded, failed));
      if (promotedPaths.length > 0) {
        pushUndoAction(t("undo.label.promoteMulti", promotedPaths.length), async () => {
          for (const fsPath of promotedPaths) {
            try {
              await vscode.workspace.fs.delete(vscode.Uri.file(fsPath), { recursive: false, useTrash: false });
            } catch {
              // Ignore files already missing.
            }
          }
        });
        offerUndo(t("undo.offer.promoteMulti", promotedPaths.length));
      }

      // Refresh views in bulk (viewer restores position after multiple copies).
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: t("app.loadingHistory") },
        async () => refreshHistoryIndex(false),
      );
      refreshViews({ clearSearch: true });
      if (succeeded > 0) offerHistoryReloadHint();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.pinSession", async (element?: unknown) => {
      // When multiple items are selected, pin the whole selection in one operation.
      const hasDirectFsPath =
        !!element &&
        typeof element === "object" &&
        !isSessionNode(element) &&
        typeof (element as { fsPath?: unknown }).fsPath === "string";
      let sessions: SessionSummary[] = [];
      if (hasDirectFsPath) {
        const session = resolveSessionFromElementOrFsPath(historyService, element);
        sessions = session ? [session] : [];
      } else {
        const targets = resolveTargets(element);
        sessions = collectSessionsFromTargets(targets);
      }
      const fsPaths = sessions.map((session) => session.fsPath);
      if (fsPaths.length === 0) return;
      const pinnedBefore = new Set(fsPaths.filter((p) => pinStore.isPinned(p)).map((p) => normalizeCacheKey(p)));
      const { pinned, skipped } = await pinStore.pinSessions(sessions);
      refreshViews();
      const newlyPinned = fsPaths.filter((p) => !pinnedBefore.has(normalizeCacheKey(p)));
      if (newlyPinned.length > 0) {
        pushUndoAction(t("undo.label.pin", newlyPinned.length), async () => {
          await pinStore.unpinMany(newlyPinned);
        });
        offerUndo(t("undo.offer.pin", newlyPinned.length));
      }
      if (pinned === 1 && skipped === 0) {
        void vscode.window.showInformationMessage(t("app.pinDone"));
      } else if (pinned > 0) {
        void vscode.window.showInformationMessage(t("app.pinDoneMulti", pinned, skipped));
      } else {
        void vscode.window.showInformationMessage(t("app.pinDoneNoop"));
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.unpinSession", async (element?: unknown) => {
      // When multiple items are selected, unpin the whole selection in one operation (including missing pins).
      const hasDirectFsPath =
        !!element &&
        typeof element === "object" &&
        !isSessionNode(element) &&
        typeof (element as { fsPath?: unknown }).fsPath === "string";
      let fsPaths: string[] = [];
      if (hasDirectFsPath) {
        const fsPath = String((element as { fsPath: string }).fsPath ?? "").trim();
        fsPaths = fsPath ? [fsPath] : [];
      } else {
        const targets = resolveTargets(element);
        fsPaths = collectUnpinFsPaths(targets);
      }
      if (fsPaths.length === 0) return;
      const fsPathKeys = new Set(fsPaths.map((p) => normalizeCacheKey(p)));
      const pinnedNow = pinStore.getAll().filter((pin) => fsPathKeys.has(pin.cacheKey));
      const { unpinned, skipped } = await pinStore.unpinMany(fsPaths);
      refreshViews();
      if (pinnedNow.length > 0) {
        pushUndoAction(t("undo.label.unpin", pinnedNow.length), async () => {
          await pinStore.restore(pinnedNow);
        });
        offerUndo(t("undo.offer.unpin", pinnedNow.length));
      }
      if (unpinned === 1 && skipped === 0) {
        void vscode.window.showInformationMessage(t("app.unpinDone"));
      } else if (unpinned > 0) {
        void vscode.window.showInformationMessage(t("app.unpinDoneMulti", unpinned, skipped));
      } else {
        void vscode.window.showInformationMessage(t("app.unpinDoneNoop"));
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.deleteSessions", async (element?: unknown) => {
      // When an element is provided, prefer selection from the view it belongs to (avoid bulk-deleting from the wrong view).
      const viewSelection =
        element === undefined
          ? resolveActiveSelection()
          : resolveSelectionForElement(element) ?? resolveActiveSelection();
      const selection =
        element === undefined
          ? viewSelection.length >= 1
            ? viewSelection
            : undefined
          : viewSelection.length > 1
            ? viewSelection
            : undefined;
      const result = await deleteSessionsWithConfirmation({
        element,
        selection,
        historyIndex: historyService.getIndex(),
        config: getConfig(),
        pinStore,
        globalStorageUri: context.globalStorageUri,
      });
      if (!result) return;

      const deletedPaths = result.undoItems.map((x) => x.originalFsPath);
      chatPanels.closeSessionsByFsPath(deletedPaths);
      const previousAnnotations = new Map<string, { tags: string[]; note: string } | null>();
      for (const fsPath of deletedPaths) {
        const ann = annotationStore.get(fsPath);
        previousAnnotations.set(normalizeCacheKey(fsPath), ann ? { tags: [...ann.tags], note: ann.note } : null);
      }
      await annotationStore.removeMany(deletedPaths);
      let previousBookmarks: BookmarkEntry[] = [];
      try {
        previousBookmarks = await bookmarkStore.removeMany(deletedPaths);
      } catch (error) {
        logger.debug(
          formatDebugFields("bookmark deleteMany failed", {
            count: deletedPaths.length,
            error: sanitizeDebugError(error),
          }),
        );
      }
      try {
        await chatOpenPositionStore.deleteMany(deletedPaths);
      } catch (error) {
        logger.debug(
          formatDebugFields("chatOpenPosition deleteMany failed", {
            count: deletedPaths.length,
            error: sanitizeDebugError(error),
          }),
        );
      }

      if (result.undoItems.length > 0) {
        pushUndoAction(
          t("undo.label.delete", result.deleted),
          async () => {
            for (const item of result.undoItems) {
              if (!item.backupFsPath) continue;
              if (await pathExists(item.originalFsPath)) continue;
              try {
                await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(item.originalFsPath)));
                await vscode.workspace.fs.copy(
                  vscode.Uri.file(item.backupFsPath),
                  vscode.Uri.file(item.originalFsPath),
                  { overwrite: false },
                );
              } catch {
                // Continue restoring remaining files.
              }
            }

            for (const fsPath of deletedPaths) {
              const before = previousAnnotations.get(normalizeCacheKey(fsPath)) ?? null;
              if (!before) continue;
              await annotationStore.set(fsPath, { tags: before.tags, note: before.note });
            }
            await bookmarkStore.restore(previousBookmarks);
          },
          async (reason) => {
            await cleanupDeletedSessionUndoBackups(result.undoItems, {
              requireOriginalExists: reason === "undone",
            });
          },
        );
        offerUndo(t("app.deleteDone", result.deleted));
      }

      await refreshHistoryIndex(false);
      refreshViews({ clearSearch: true });
    }),
  );

  // Register UI command aliases so menu labels can switch by extension language setting.
  // This keeps context menu text independent from VS Code display language.
  const registerUiCommandAlias = (aliasId: string, targetId: string): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(aliasId, async (...args: unknown[]) => {
        await vscode.commands.executeCommand(targetId, ...(args as any[]));
      }),
    );
  };

  registerUiCommandAlias("codexHistoryViewer.ui.ja.openSession", "codexHistoryViewer.openSession");
  registerUiCommandAlias("codexHistoryViewer.ui.en.openSession", "codexHistoryViewer.openSession");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.openSessionMarkdown", "codexHistoryViewer.openSessionMarkdown");
  registerUiCommandAlias("codexHistoryViewer.ui.en.openSessionMarkdown", "codexHistoryViewer.openSessionMarkdown");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.copyResumePrompt", "codexHistoryViewer.copyResumePrompt");
  registerUiCommandAlias("codexHistoryViewer.ui.en.copyResumePrompt", "codexHistoryViewer.copyResumePrompt");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.resumeSessionInCodex", "codexHistoryViewer.resumeSessionInCodex");
  registerUiCommandAlias("codexHistoryViewer.ui.en.resumeSessionInCodex", "codexHistoryViewer.resumeSessionInCodex");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.resumeSessionInClaude", "codexHistoryViewer.resumeSessionInClaude");
  registerUiCommandAlias("codexHistoryViewer.ui.en.resumeSessionInClaude", "codexHistoryViewer.resumeSessionInClaude");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.handoffToCodex", "codexHistoryViewer.handoffToCodex");
  registerUiCommandAlias("codexHistoryViewer.ui.en.handoffToCodex", "codexHistoryViewer.handoffToCodex");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.handoffToClaude", "codexHistoryViewer.handoffToClaude");
  registerUiCommandAlias("codexHistoryViewer.ui.en.handoffToClaude", "codexHistoryViewer.handoffToClaude");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.copyHandoffPrompt", "codexHistoryViewer.copyHandoffPrompt");
  registerUiCommandAlias("codexHistoryViewer.ui.en.copyHandoffPrompt", "codexHistoryViewer.copyHandoffPrompt");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.createHandoffFile", "codexHistoryViewer.createHandoffFile");
  registerUiCommandAlias("codexHistoryViewer.ui.en.createHandoffFile", "codexHistoryViewer.createHandoffFile");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.openSessionHandoff", "codexHistoryViewer.openSessionHandoff");
  registerUiCommandAlias("codexHistoryViewer.ui.en.openSessionHandoff", "codexHistoryViewer.openSessionHandoff");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.promoteSession", "codexHistoryViewer.promoteSession");
  registerUiCommandAlias("codexHistoryViewer.ui.en.promoteSession", "codexHistoryViewer.promoteSession");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.restoreArchivedSession", "codexHistoryViewer.restoreArchivedSession");
  registerUiCommandAlias("codexHistoryViewer.ui.en.restoreArchivedSession", "codexHistoryViewer.restoreArchivedSession");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.archiveSession", "codexHistoryViewer.archiveSession");
  registerUiCommandAlias("codexHistoryViewer.ui.en.archiveSession", "codexHistoryViewer.archiveSession");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.archiveLocationActiveOnly", "codexHistoryViewer.filterArchiveLocation");
  registerUiCommandAlias("codexHistoryViewer.ui.en.archiveLocationActiveOnly", "codexHistoryViewer.filterArchiveLocation");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.archiveLocationAll", "codexHistoryViewer.filterArchiveLocation");
  registerUiCommandAlias("codexHistoryViewer.ui.en.archiveLocationAll", "codexHistoryViewer.filterArchiveLocation");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.archiveLocationArchivedOnly", "codexHistoryViewer.filterArchiveLocation");
  registerUiCommandAlias("codexHistoryViewer.ui.en.archiveLocationArchivedOnly", "codexHistoryViewer.filterArchiveLocation");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.archiveLocationDisabled", "codexHistoryViewer.filterArchiveLocation");
  registerUiCommandAlias("codexHistoryViewer.ui.en.archiveLocationDisabled", "codexHistoryViewer.filterArchiveLocation");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.pinSession", "codexHistoryViewer.pinSession");
  registerUiCommandAlias("codexHistoryViewer.ui.en.pinSession", "codexHistoryViewer.pinSession");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.unpinSession", "codexHistoryViewer.unpinSession");
  registerUiCommandAlias("codexHistoryViewer.ui.en.unpinSession", "codexHistoryViewer.unpinSession");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.deleteSessions", "codexHistoryViewer.deleteSessions");
  registerUiCommandAlias("codexHistoryViewer.ui.en.deleteSessions", "codexHistoryViewer.deleteSessions");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.refresh", "codexHistoryViewer.refresh");
  registerUiCommandAlias("codexHistoryViewer.ui.en.refresh", "codexHistoryViewer.refresh");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.refreshPinned", "codexHistoryViewer.refreshPinned");
  registerUiCommandAlias("codexHistoryViewer.ui.en.refreshPinned", "codexHistoryViewer.refreshPinned");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.refreshHistoryPane", "codexHistoryViewer.refreshHistoryPane");
  registerUiCommandAlias("codexHistoryViewer.ui.en.refreshHistoryPane", "codexHistoryViewer.refreshHistoryPane");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.showHistoryLatestView", "codexHistoryViewer.showHistoryLatestView");
  registerUiCommandAlias("codexHistoryViewer.ui.en.showHistoryLatestView", "codexHistoryViewer.showHistoryLatestView");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.showHistoryDateView", "codexHistoryViewer.showHistoryDateView");
  registerUiCommandAlias("codexHistoryViewer.ui.en.showHistoryDateView", "codexHistoryViewer.showHistoryDateView");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.refreshStatusPane", "codexHistoryViewer.refreshStatusPane");
  registerUiCommandAlias("codexHistoryViewer.ui.en.refreshStatusPane", "codexHistoryViewer.refreshStatusPane");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.search", "codexHistoryViewer.search");
  registerUiCommandAlias("codexHistoryViewer.ui.en.search", "codexHistoryViewer.search");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.searchRerun", "codexHistoryViewer.searchRerun");
  registerUiCommandAlias("codexHistoryViewer.ui.en.searchRerun", "codexHistoryViewer.searchRerun");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.searchClearResults", "codexHistoryViewer.searchClearResults");
  registerUiCommandAlias("codexHistoryViewer.ui.en.searchClearResults", "codexHistoryViewer.searchClearResults");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.searchFilterByTag", "codexHistoryViewer.searchFilterByTag");
  registerUiCommandAlias("codexHistoryViewer.ui.en.searchFilterByTag", "codexHistoryViewer.searchFilterByTag");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.clearSearchTagFilter", "codexHistoryViewer.clearSearchTagFilter");
  registerUiCommandAlias("codexHistoryViewer.ui.en.clearSearchTagFilter", "codexHistoryViewer.clearSearchTagFilter");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.filterPinnedByTag", "codexHistoryViewer.filterPinnedByTag");
  registerUiCommandAlias("codexHistoryViewer.ui.en.filterPinnedByTag", "codexHistoryViewer.filterPinnedByTag");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.clearPinnedTagFilter", "codexHistoryViewer.clearPinnedTagFilter");
  registerUiCommandAlias("codexHistoryViewer.ui.en.clearPinnedTagFilter", "codexHistoryViewer.clearPinnedTagFilter");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.filterHistory", "codexHistoryViewer.filterHistory");
  registerUiCommandAlias("codexHistoryViewer.ui.en.filterHistory", "codexHistoryViewer.filterHistory");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.filterHistoryByTag", "codexHistoryViewer.filterHistoryByTag");
  registerUiCommandAlias("codexHistoryViewer.ui.en.filterHistoryByTag", "codexHistoryViewer.filterHistoryByTag");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.clearHistoryTagFilter", "codexHistoryViewer.clearHistoryTagFilter");
  registerUiCommandAlias("codexHistoryViewer.ui.en.clearHistoryTagFilter", "codexHistoryViewer.clearHistoryTagFilter");
  registerUiCommandAlias(
    "codexHistoryViewer.ui.ja.filterHistoryCurrentProject",
    "codexHistoryViewer.filterHistoryCurrentProject",
  );
  registerUiCommandAlias(
    "codexHistoryViewer.ui.en.filterHistoryCurrentProject",
    "codexHistoryViewer.filterHistoryCurrentProject",
  );
  registerUiCommandAlias("codexHistoryViewer.ui.cycleHistorySourceAll", "codexHistoryViewer.cycleHistorySourceFilter");
  registerUiCommandAlias("codexHistoryViewer.ui.cycleHistorySourceCodex", "codexHistoryViewer.cycleHistorySourceFilter");
  registerUiCommandAlias("codexHistoryViewer.ui.cycleHistorySourceClaude", "codexHistoryViewer.cycleHistorySourceFilter");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.clearHistoryFilter", "codexHistoryViewer.clearHistoryFilter");
  registerUiCommandAlias("codexHistoryViewer.ui.en.clearHistoryFilter", "codexHistoryViewer.clearHistoryFilter");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.openSettings", "codexHistoryViewer.openSettings");
  registerUiCommandAlias("codexHistoryViewer.ui.en.openSettings", "codexHistoryViewer.openSettings");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.rebuildCache", "codexHistoryViewer.rebuildCache");
  registerUiCommandAlias("codexHistoryViewer.ui.en.rebuildCache", "codexHistoryViewer.rebuildCache");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.emptyTrash", "codexHistoryViewer.emptyTrash");
  registerUiCommandAlias("codexHistoryViewer.ui.en.emptyTrash", "codexHistoryViewer.emptyTrash");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.cleanupHandoffs", "codexHistoryViewer.cleanupHandoffs");
  registerUiCommandAlias("codexHistoryViewer.ui.en.cleanupHandoffs", "codexHistoryViewer.cleanupHandoffs");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.cleanupMissingPins", "codexHistoryViewer.cleanupMissingPins");
  registerUiCommandAlias("codexHistoryViewer.ui.en.cleanupMissingPins", "codexHistoryViewer.cleanupMissingPins");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.exportSessions", "codexHistoryViewer.exportSessions");
  registerUiCommandAlias("codexHistoryViewer.ui.en.exportSessions", "codexHistoryViewer.exportSessions");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.importSessions", "codexHistoryViewer.importSessions");
  registerUiCommandAlias("codexHistoryViewer.ui.en.importSessions", "codexHistoryViewer.importSessions");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.searchRunPreset", "codexHistoryViewer.searchRunPreset");
  registerUiCommandAlias("codexHistoryViewer.ui.en.searchRunPreset", "codexHistoryViewer.searchRunPreset");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.searchSavePreset", "codexHistoryViewer.searchSavePreset");
  registerUiCommandAlias("codexHistoryViewer.ui.en.searchSavePreset", "codexHistoryViewer.searchSavePreset");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.searchDeletePreset", "codexHistoryViewer.searchDeletePreset");
  registerUiCommandAlias("codexHistoryViewer.ui.en.searchDeletePreset", "codexHistoryViewer.searchDeletePreset");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.manageCustomTitle", "codexHistoryViewer.manageCustomTitle");
  registerUiCommandAlias("codexHistoryViewer.ui.en.manageCustomTitle", "codexHistoryViewer.manageCustomTitle");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.setCustomTitle", "codexHistoryViewer.setCustomTitle");
  registerUiCommandAlias("codexHistoryViewer.ui.en.setCustomTitle", "codexHistoryViewer.setCustomTitle");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.clearCustomTitle", "codexHistoryViewer.clearCustomTitle");
  registerUiCommandAlias("codexHistoryViewer.ui.en.clearCustomTitle", "codexHistoryViewer.clearCustomTitle");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.editSessionAnnotation", "codexHistoryViewer.editSessionAnnotation");
  registerUiCommandAlias("codexHistoryViewer.ui.en.editSessionAnnotation", "codexHistoryViewer.editSessionAnnotation");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.renameTagGlobally", "codexHistoryViewer.renameTagGlobally");
  registerUiCommandAlias("codexHistoryViewer.ui.en.renameTagGlobally", "codexHistoryViewer.renameTagGlobally");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.deleteTagsGlobally", "codexHistoryViewer.deleteTagsGlobally");
  registerUiCommandAlias("codexHistoryViewer.ui.en.deleteTagsGlobally", "codexHistoryViewer.deleteTagsGlobally");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.undoLastAction", "codexHistoryViewer.undoLastAction");
  registerUiCommandAlias("codexHistoryViewer.ui.en.undoLastAction", "codexHistoryViewer.undoLastAction");

  const completeInitialTreeLoad = (): void => {
    historyProvider.markInitialLoadComplete();
    pinnedProvider.markInitialLoadComplete();
    refreshViews();
    controlProvider.refresh();
  };

  const runInitialBackgroundRefresh = (): void => {
    void (async () => {
      try {
        await refreshHistoryIndex(false);
        refreshViews();
        controlProvider.refresh();
        chatPanels.refreshTitles();
      } catch (error) {
        logger.debug(`history.backgroundRefresh failed error=${sanitizeDebugError(error)}`);
      }
    })();
  };

  // Initial load on activation.
  let loadedCachedIndex = false;
  try {
    loadedCachedIndex = await historyService.loadCachedIndexIfFresh();
  } catch (error) {
    logger.debug(`history.cacheImmediate failed error=${sanitizeDebugError(error)}`);
  }

  if (loadedCachedIndex) {
    completeInitialTreeLoad();
    runInitialBackgroundRefresh();
  } else {
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: t("app.loadingHistory") },
        async () => {
          await refreshHistoryIndex(false);
        },
      );
    } finally {
      completeInitialTreeLoad();
    }
  }
  await autoRefreshService.configure(getConfig(), computeAutoRefreshConsumerVisible(), vscode.window.state.focused);
}

function sanitizeProjectCwd(value: unknown): string | null {
  const s = typeof value === "string" ? value.trim() : "";
  return s.length > 0 ? s : null;
}

function sanitizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function sanitizeIndexedSearchRoles(value: unknown): IndexedSearchRole[] {
  const selected = Array.isArray(value) ? value : [];
  const out: IndexedSearchRole[] = [];
  for (const role of SEARCH_ROLE_ORDER) {
    if (selected.includes(role)) out.push(role);
  }
  if (out.length === 0) return ["user", "assistant"];
  return out;
}

function sanitizeSearchRequest(value: unknown): SearchRequest | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { queryInput?: unknown; roleFilter?: unknown };
  const queryInput = typeof v.queryInput === "string" ? v.queryInput.trim() : "";
  if (!queryInput) return null;
  const roleFilter = sanitizeIndexedSearchRoles(v.roleFilter);
  return { queryInput, roleFilter };
}

function sanitizeTagFilter(value: unknown): string[] {
  const selected = Array.isArray(value) ? value : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of selected) {
    const tag = String(raw ?? "").trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

function sanitizeHistorySourceFilter(value: unknown): SessionSourceFilter {
  const s = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (s === "codex" || s === "claude") return s;
  return "all";
}

function sanitizeHistoryViewMode(value: unknown): HistoryViewMode {
  const s = typeof value === "string" ? value.trim().toLowerCase() : "";
  return s === "latest" ? "latest" : "date";
}

function sanitizeArchiveLocationFilter(value: unknown, legacyShowArchivedSessions?: unknown): ArchiveLocationFilter {
  const s = typeof value === "string" ? value.trim() : "";
  if (s === "activeOnly" || s === "all" || s === "archivedOnly") return s;
  if (legacyShowArchivedSessions !== undefined) {
    return sanitizeBoolean(legacyShowArchivedSessions, false) ? "all" : "activeOnly";
  }
  return "activeOnly";
}

function getArchiveLocationLabel(value: ArchiveLocationFilter): string {
  switch (value) {
    case "all":
      return t("archiveLocation.all");
    case "archivedOnly":
      return t("archiveLocation.archivedOnly");
    case "activeOnly":
    default:
      return t("archiveLocation.activeOnly");
  }
}

function nextArchiveLocationFilter(value: ArchiveLocationFilter): ArchiveLocationFilter {
  switch (value) {
    case "activeOnly":
      return "all";
    case "all":
      return "archivedOnly";
    case "archivedOnly":
    default:
      return "activeOnly";
  }
}

function matchesArchiveLocationFilter(session: SessionSummary, archiveLocationFilter: ArchiveLocationFilter): boolean {
  switch (archiveLocationFilter) {
    case "all":
      return true;
    case "archivedOnly":
      return session.source === "codex" && session.storage.archiveState === "archived";
    case "activeOnly":
    default:
      return session.storage.archiveState !== "archived";
  }
}

function resolveLockedHistorySource(config: CodexHistoryViewerConfig): SessionSourceFilter | null {
  const codexAvailable = config.enableCodexSource || config.enableCodexArchivedSessions;
  if (codexAvailable && !config.enableClaudeSource) return "codex";
  if (!codexAvailable && config.enableClaudeSource) return "claude";
  return null;
}

function resolveConstrainedHistorySourceFilter(
  sourceFilter: SessionSourceFilter,
  config: CodexHistoryViewerConfig,
): SessionSourceFilter {
  const locked = resolveLockedHistorySource(config);
  return locked ?? sanitizeHistorySourceFilter(sourceFilter);
}

function isPathInsideRoot(fsPath: string, rootPath: string): boolean {
  const root = String(rootPath ?? "").trim();
  if (!root) return false;
  const rel = path.relative(root, fsPath);
  if (!rel) return true;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function formatBytesForUi(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return `${rounded} ${units[unitIndex]}`;
}

type HistoryFilterChange =
  | { kind: "date"; date: DateScope }
  | { kind: "project"; projectCwd: string | null }
  | { kind: "source"; source: SessionSourceFilter }
  | { kind: "archiveLocation"; archiveLocation: ArchiveLocationFilter }
  | { kind: "tags"; tags: string[] };

type HistoryFilterPick = vscode.QuickPickItem & {
  pickKind?: "date" | "project" | "source" | "archiveLocation" | "tags";
  date?: DateScope;
  projectCwd?: string | null;
  source?: SessionSourceFilter;
  archiveLocation?: ArchiveLocationFilter;
  tags?: string[];
};

async function promptHistoryFilter(
  idx: import("./sessions/sessionTypes").HistoryIndex,
  current: {
    date: DateScope;
    projectCwd: string | null;
    source: SessionSourceFilter;
    sourceOptions: SessionSourceFilter[];
    archiveLocation: ArchiveLocationFilter;
    tags: string[];
    availableTags: string[];
  },
): Promise<HistoryFilterChange | null> {
  const years = Array.from(idx.byY.keys()).sort((a, b) => (a < b ? 1 : -1));
  const yms: string[] = [];
  const ymds: string[] = Array.from(idx.byYmd.keys()).sort((a, b) => (a < b ? 1 : -1));
  for (const y of years) {
    const months = idx.byY.get(y);
    if (!months) continue;
    for (const m of Array.from(months.keys()).sort((a, b) => (a < b ? 1 : -1))) {
      yms.push(`${y}-${m}`);
    }
  }

  // List session CWDs (projects) in descending recency (cap the list size since it can grow large).
  const MAX_PROJECTS = 250;
  const projectCwds: string[] = [];
  const seenProjects = new Set<string>();
  for (const s of idx.sessions) {
    const cwd = typeof s.meta?.cwd === "string" ? s.meta.cwd.trim() : "";
    if (!cwd) continue;
    const key = normalizeCacheKey(cwd);
    if (seenProjects.has(key)) continue;
    seenProjects.add(key);
    projectCwds.push(cwd);
    if (projectCwds.length >= MAX_PROJECTS) break;
  }

  const dateItemsBase: HistoryFilterPick[] = [
    { label: t("history.filter.section.date"), kind: vscode.QuickPickItemKind.Separator },
    { label: t("history.filter.all"), pickKind: "date", date: { kind: "all" } },
    ...years.map((y) => ({ label: y, pickKind: "date" as const, date: { kind: "year" as const, yyyy: y } })),
    ...yms.map((ym) => ({ label: ym, pickKind: "date" as const, date: { kind: "month" as const, ym } })),
  ];

  const projectItemsBase: HistoryFilterPick[] = [
    { label: t("history.filter.section.project"), kind: vscode.QuickPickItemKind.Separator },
    { label: t("history.project.clear"), pickKind: "project" as const, projectCwd: null },
    ...projectCwds.map((cwd) => ({
      label: safeDisplayPath(cwd, 80),
      description: t("history.filter.project"),
      detail: cwd,
      pickKind: "project" as const,
      projectCwd: cwd,
    })),
  ];

  const sourceLabelByValue = (source: SessionSourceFilter): string => {
    if (source === "codex") return t("history.filter.source.codex");
    if (source === "claude") return t("history.filter.source.claude");
    return t("history.filter.source.all");
  };

  const sourceItemsBase: HistoryFilterPick[] =
    current.sourceOptions.length >= 2
      ? [
          { label: t("history.filter.section.source"), kind: vscode.QuickPickItemKind.Separator },
          ...current.sourceOptions.map((source) => ({
            label: sourceLabelByValue(source),
            pickKind: "source" as const,
            source,
          })),
        ]
      : [];

  const archiveLocationItemsBase: HistoryFilterPick[] = getConfig().enableCodexArchivedSessions
    ? [
        { label: t("history.filter.section.location"), kind: vscode.QuickPickItemKind.Separator },
        ...(["activeOnly", "all", "archivedOnly"] as const).map((archiveLocation) => ({
          label: getArchiveLocationLabel(archiveLocation),
          description: archiveLocation === current.archiveLocation ? t("common.current") : undefined,
          pickKind: "archiveLocation" as const,
          archiveLocation,
        })),
      ]
    : [];

  const tagItemsBase: HistoryFilterPick[] = [
    { label: t("history.tags.separator"), kind: vscode.QuickPickItemKind.Separator },
    { label: t("history.tags.editFilter"), pickKind: "tags" as const, tags: current.tags },
    { label: t("history.tags.clearFilter"), pickKind: "tags" as const, tags: [] },
  ];

  const baseItems: HistoryFilterPick[] = [
    ...dateItemsBase,
    ...projectItemsBase,
    ...sourceItemsBase,
    ...archiveLocationItemsBase,
    ...tagItemsBase,
  ];

  const isSameDateScope = (a: DateScope, b: DateScope): boolean => a.kind === b.kind && getDateScopeValue(a) === getDateScopeValue(b);

  return await new Promise<HistoryFilterChange | null>((resolve) => {
    const qp = vscode.window.createQuickPick<HistoryFilterPick>();
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.placeholder = t("history.filter.placeholder");
    qp.items = baseItems;

    // Default to year-month options; only while typing add year-month-day (YYYY-MM-DD) suggestions.
    const updateItems = (raw: string): void => {
      const v = String(raw ?? "").trim();
      if (!v || v.length < 7 || !v.includes("-")) {
        qp.items = baseItems;
        return;
      }

      const MAX_DAYS = 250;
      const dayKeys = ymds.filter((ymd) => ymd.startsWith(v)).slice(0, MAX_DAYS);
      if (dayKeys.length === 0) {
        qp.items = baseItems;
        return;
      }

      const dayItems: HistoryFilterPick[] = dayKeys.map((ymd) => ({
        label: ymd,
        pickKind: "date" as const,
        date: { kind: "day" as const, ymd },
      }));

      qp.items = [
        ...dateItemsBase,
        ...dayItems,
        ...projectItemsBase,
        ...sourceItemsBase,
        ...archiveLocationItemsBase,
        ...tagItemsBase,
      ];
    };

    let done = false;
    const finish = (v: HistoryFilterChange | null): void => {
      if (done) return;
      done = true;
      resolve(v);
      qp.dispose();
    };

    qp.onDidChangeValue(updateItems);
    qp.onDidAccept(() => {
      const picked = qp.selectedItems[0];
      const pickKind = typeof picked?.pickKind === "string" ? picked.pickKind : "";
      if (pickKind === "date" && picked?.date) {
        finish({ kind: "date", date: picked.date });
        return;
      }
      if (pickKind === "project") {
        finish({ kind: "project", projectCwd: picked?.projectCwd ?? null });
        return;
      }
      if (pickKind === "source") {
        finish({ kind: "source", source: sanitizeHistorySourceFilter(picked?.source) });
        return;
      }
      if (pickKind === "archiveLocation") {
        finish({ kind: "archiveLocation", archiveLocation: sanitizeArchiveLocationFilter(picked?.archiveLocation) });
        return;
      }
      if (pickKind === "tags") {
        finish({ kind: "tags", tags: sanitizeTagFilter(picked?.tags ?? current.tags) });
        return;
      }
      finish(null);
    });
    qp.onDidHide(() => finish(null));

    // Set initial focus based on the current filters.
    const currentProjectKey = current.projectCwd ? normalizeCacheKey(current.projectCwd) : null;
    const activeDateItem = dateItemsBase.find((it) => it.pickKind === "date" && it.date && isSameDateScope(it.date, current.date));
    const activeProjectItem = currentProjectKey
      ? projectItemsBase.find(
          (it) => it.pickKind === "project" && it.projectCwd && normalizeCacheKey(it.projectCwd) === currentProjectKey,
        )
      : undefined;
    const activeSourceItem = sourceItemsBase.find((it) => it.pickKind === "source" && it.source === current.source);
    const activeArchiveLocationItem = archiveLocationItemsBase.find(
      (it) => it.pickKind === "archiveLocation" && it.archiveLocation === current.archiveLocation,
    );
    qp.activeItems = activeDateItem
      ? [activeDateItem]
      : activeProjectItem
        ? [activeProjectItem]
        : activeSourceItem
          ? [activeSourceItem]
          : activeArchiveLocationItem
            ? [activeArchiveLocationItem]
            : [];
    qp.show();
  });
}

// Cleanup hook called by VS Code.
export function deactivate(): void {
  // Disposables are already registered in context.subscriptions.
}

function resolveExtensionVersion(context: vscode.ExtensionContext): string {
  const version = (context.extension.packageJSON as { version?: unknown }).version;
  return typeof version === "string" && version.trim().length > 0 ? version.trim() : "unknown";
}

function resolveRevealIndex(element: unknown): number | undefined {
  if (!(element instanceof SearchHitNode)) return undefined;
  if (element.hit.role !== "user" && element.hit.role !== "assistant") return undefined;
  return element.hit.messageIndex;
}

function resolveRevealIndexFromArgs(args: unknown): number | undefined {
  if (!args || typeof args !== "object") return undefined;
  const v = (args as any).revealMessageIndex;
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : undefined;
}

function resolveSessionFromElementOrFsPath(historyService: HistoryService, elementOrArgs: unknown): SessionSummary | undefined {
  if (isSessionNode(elementOrArgs)) return elementOrArgs.session;
  if (!elementOrArgs || typeof elementOrArgs !== "object") return undefined;
  const fsPath = (elementOrArgs as any).fsPath;
  if (typeof fsPath !== "string" || fsPath.length === 0) return undefined;
  return historyService.findByFsPath(fsPath);
}

function resolveSessionFromElementOrActive(
  historyService: HistoryService,
  transcriptScheme: string,
  element?: unknown,
): SessionSummary | undefined {
  if (isSessionNode(element)) return element.session;

  // Allow "switch to chat view" from an opened Markdown transcript.
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc) return undefined;
  if (doc.uri.scheme !== transcriptScheme) return undefined;
  const params = new URLSearchParams(doc.uri.query);
  const fsPath = params.get("fsPath");
  if (!fsPath) return undefined;
  return historyService.findByFsPath(fsPath);
}

function resolveCurrentWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  // Prefer the active editor's workspace first; otherwise use the first workspace folder.
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri?.scheme === "file") {
    const folder = vscode.workspace.getWorkspaceFolder(activeUri);
    if (folder) return folder;
  }
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0] : undefined;
}

function resolveCurrentProjectFilterCwd(
  idx: import("./sessions/sessionTypes").HistoryIndex,
  workspaceFsPath: string,
): string {
  const workspacePath = workspaceFsPath.trim();
  const workspaceKey = normalizePathForPrefixMatch(workspacePath);
  if (!workspaceKey) return workspacePath;

  let nearestAncestor: { cwd: string; key: string } | null = null;
  for (const session of idx.sessions) {
    const cwd = typeof session.meta?.cwd === "string" ? session.meta.cwd.trim() : "";
    if (!cwd) continue;
    const cwdKey = normalizePathForPrefixMatch(cwd);
    if (!cwdKey) continue;

    if (cwdKey === workspaceKey) return cwd;
    // Prefer history entries executed under the current workspace when available.
    if (isSameOrDescendantPath(cwdKey, workspaceKey)) return cwd;

    // Only if no direct descendant is found, use the nearest ancestor path candidate.
    if (isSameOrDescendantPath(workspaceKey, cwdKey)) {
      if (!nearestAncestor || cwdKey.length > nearestAncestor.key.length) {
        nearestAncestor = { cwd, key: cwdKey };
      }
    }
  }

  return nearestAncestor?.cwd ?? workspacePath;
}

function normalizePathForPrefixMatch(fsPath: string): string {
  const normalized = normalizeCacheKey(fsPath).replace(/\\/g, "/");
  if (normalized === "/") return normalized;
  if (/^[a-z]:\/$/i.test(normalized)) return normalized;
  return normalized.replace(/\/+$/g, "");
}

function isSameOrDescendantPath(candidatePath: string, basePath: string): boolean {
  if (candidatePath === basePath) return true;
  const base = basePath.endsWith("/") ? basePath : `${basePath}/`;
  return candidatePath.startsWith(base);
}
