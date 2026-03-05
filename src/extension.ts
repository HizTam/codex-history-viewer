import * as path from "node:path";
import * as vscode from "vscode";
import { resolveUiLanguage, t } from "./i18n";
import { getConfig, type CodexHistoryViewerConfig } from "./settings";
import { HistoryService } from "./services/historyService";
import type { SessionSourceFilter, SessionSummary } from "./sessions/sessionTypes";
import { PinnedTreeDataProvider } from "./tree/pinnedTree";
import { HistoryTreeDataProvider } from "./tree/historyTree";
import { SearchTreeDataProvider } from "./tree/searchTree";
import { TranscriptContentProvider } from "./transcript/transcriptProvider";
import { renderResumeContext } from "./transcript/resumeRenderer";
import { promoteSessionCopyToToday } from "./services/promoteService";
import { deleteSessionsWithConfirmation } from "./services/deleteService";
import { PinStore } from "./services/pinStore";
import { type SearchRequest, runSearchFlow } from "./services/searchService";
import { type IndexedSearchRole, SearchIndexService } from "./services/searchIndexService";
import { exportMaskedTranscripts, exportSessions, importSessions } from "./services/importExportService";
import { SearchPresetStore } from "./services/searchPresetStore";
import { SessionAnnotationStore } from "./services/sessionAnnotationStore";
import { UndoService } from "./services/undoService";
import type { TreeNode } from "./tree/treeNodes";
import { DayNode, MissingPinnedNode, MonthNode, SearchHitNode, YearNode, isSessionNode } from "./tree/treeNodes";
import {
  ControlTreeDataProvider,
  StatusTreeDataProvider,
} from "./tree/utilityTrees";
import { ChatPanelManager } from "./chat/chatPanelManager";
import { getDateScopeValue, sanitizeDateScope, type DateScope } from "./types/dateScope";
import { resolveDateTimeSettings } from "./utils/dateTimeSettings";
import { safeDisplayPath } from "./utils/textUtils";
import { normalizeCacheKey, pathExists } from "./utils/fsUtils";

const SEARCH_ROLE_ORDER: IndexedSearchRole[] = ["user", "assistant", "developer", "tool"];

// Extension entry point. Initializes core services and tree views.
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const config = getConfig();
  const HISTORY_FILTER_KEY = "codexHistoryViewer.historyFilter.v1";
  const HISTORY_PROJECT_FILTER_KEY = "codexHistoryViewer.historyProjectFilter.v1";
  const HISTORY_SOURCE_FILTER_KEY = "codexHistoryViewer.historySourceFilter.v1";
  const HISTORY_TAG_FILTER_KEY = "codexHistoryViewer.historyTagFilter.v1";
  const PINNED_TAG_FILTER_KEY = "codexHistoryViewer.pinnedTagFilter.v1";
  const SEARCH_TAG_FILTER_KEY = "codexHistoryViewer.searchTagFilter.v1";
  const LAST_SEARCH_REQUEST_KEY = "codexHistoryViewer.lastSearchRequest.v1";
  const SEARCH_DEFAULT_ROLES_CONFIG = "search.defaultRoles";

  const updateUiLanguageContext = (): void => {
    // Keep the UI language context up to date for menu visibility switching.
    // The value is fixed to "ja"/"en" because package.json `when` clauses depend on it.
    const lang = resolveUiLanguage();
    void vscode.commands.executeCommand("setContext", "codexHistoryViewer.uiLang", lang);
  };
  updateUiLanguageContext();

  // Ensure the global storage directory exists (cache / temp files).
  await vscode.workspace.fs.createDirectory(context.globalStorageUri);

  const pinStore = new PinStore(context.globalState);
  const annotationStore = new SessionAnnotationStore(context.globalState);
  const searchPresetStore = new SearchPresetStore(context.globalState);
  const historyService = new HistoryService(context.globalStorageUri, config);
  const searchIndexService = new SearchIndexService(context.globalStorageUri);
  const transcriptProvider = new TranscriptContentProvider(historyService, annotationStore);
  const chatPanels = new ChatPanelManager(context.extensionUri, historyService, annotationStore, pinStore);
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
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.pinnedTagFiltered", false);
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.searchTagFiltered", false);
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.sourceCodexEnabled", true);
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.sourceClaudeEnabled", true);
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.historySourceSwitchable", true);

  let pinnedTagFilter: string[] = sanitizeTagFilter(context.workspaceState.get(PINNED_TAG_FILTER_KEY));
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
    context.extensionUri,
  );
  const historyProvider = new HistoryTreeDataProvider(
    historyService,
    pinStore,
    annotationStore,
    historyFilter,
    historyProjectCwd,
    historySourceFilter,
    historyTagFilter,
    context.extensionUri,
  );
  const searchProvider = new SearchTreeDataProvider(pinStore, annotationStore, context.extensionUri);
  let lastHistoryRefreshAt: number | null = null;

  const isCodexSourceEnabled = (sourceFilter: SessionSourceFilter): boolean =>
    sourceFilter === "all" || sourceFilter === "codex";

  const isClaudeSourceEnabled = (sourceFilter: SessionSourceFilter): boolean =>
    sourceFilter === "all" || sourceFilter === "claude";

  const constrainHistorySourceFilter = (sourceFilter: SessionSourceFilter): SessionSourceFilter =>
    resolveConstrainedHistorySourceFilter(sourceFilter, getConfig());

  const isHistorySourceSwitchable = (): boolean => resolveLockedHistorySource(getConfig()) === null;

  const getHistorySourceOptionsForPrompt = (): SessionSourceFilter[] => {
    const locked = resolveLockedHistorySource(getConfig());
    if (locked) return [locked];
    return ["all", "codex", "claude"];
  };

  const buildSourceFilterSummary = (): string => {
    if (historySourceFilter === "all") return "";
    const sourceLabel =
      historySourceFilter === "codex" ? t("history.filter.source.codex") : t("history.filter.source.claude");
    return t("history.filter.sourceLabel", sourceLabel);
  };

  const buildHistoryFilterSummary = (): string => {
    const parts: string[] = [];
    const dateValue = getDateScopeValue(historyFilter);
    if (dateValue) parts.push(dateValue);
    if (historyProjectCwd) parts.push(t("history.filter.projectLabel", safeDisplayPath(historyProjectCwd, 60)));
    const sourceSummary = buildSourceFilterSummary();
    if (sourceSummary) parts.push(sourceSummary);
    if (historyTagFilter.length > 0) parts.push(`tags: ${historyTagFilter.map((tag) => `#${tag}`).join(", ")}`);
    return parts.join(" / ");
  };

  const countMissingPins = (): number => {
    const pins = pinStore.getAll();
    let missing = 0;
    for (const p of pins) {
      if (!historyService.findByFsPath(p.fsPath)) missing += 1;
    }
    return missing;
  };

  const controlProvider = new ControlTreeDataProvider();
  const resolveStatusCurrentProjectCwd = (): string | null => {
    if (historyProjectCwd) return historyProjectCwd;
    const folder = resolveCurrentWorkspaceFolder();
    return folder?.uri.fsPath ?? null;
  };
  const resolveStatusCurrentSearchRoles = (): IndexedSearchRole[] => {
    // The status pane displays the currently configured default search roles.
    return getConfiguredDefaultSearchRoles();
  };
  const statusProvider = new StatusTreeDataProvider(() => ({
    sessionCount: historyService.getIndex().sessions.length,
    pinCount: pinStore.getAll().length,
    missingPinCount: countMissingPins(),
    presetCount: searchPresetStore.getAll().length,
    totalTagCount: annotationStore.listTagStats().length,
    searchHitCount: searchProvider.root?.totalHits ?? 0,
    currentSearchRoles: resolveStatusCurrentSearchRoles(),
    currentSearchTagFilter: searchTagFilter,
    filterSummary: buildHistoryFilterSummary(),
    currentProjectCwd: resolveStatusCurrentProjectCwd(),
    sessionsRoot: historyService.getIndex().sessionsRoot,
    lastRefreshAt: lastHistoryRefreshAt,
  }));
  const debugBuild = "2026-01-19.1";

  // Provide a virtual document (conversation log).
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(transcriptProvider.scheme, transcriptProvider),
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
      const candidates = fsPaths
        .map((p) => historyService.findByFsPath(p)?.fsPath)
        .filter((p): p is string => typeof p === "string" && p.length > 0);
      const unique = dedupeFsPaths(candidates);
      if (unique.length === 0) return;

      const { pinned, skipped } = await pinStore.pinMany(unique);
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

  context.subscriptions.push(
    controlView,
    statusView,
    pinnedView,
    historyView,
    searchView,
  );

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
    controlView.title = t("view.control");
    statusView.title = t("view.status");
    pinnedView.title = t("view.pinned");
    historyView.title = t("view.history");
    searchView.title = t("view.search");
  };

  const updateHistoryViewDescription = (): void => {
    const v = buildHistoryFilterSummary();
    historyView.description = v ? t("history.filter.active", v) : "";
    void vscode.commands.executeCommand("setContext", "codexHistoryViewer.historyFiltered", v.length > 0);
    void vscode.commands.executeCommand("setContext", "codexHistoryViewer.historyTagFiltered", historyTagFilter.length > 0);
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
    if (searchTagFilter.length === 0) return "";
    return uiText(`タグ: ${searchTagFilter.map((tag) => `#${tag}`).join(", ")}`, `tags: ${searchTagFilter.map((tag) => `#${tag}`).join(", ")}`);
  };

  const updateSearchViewDescription = (): void => {
    const v = buildSearchTagFilterSummary();
    searchView.description = v;
    void vscode.commands.executeCommand("setContext", "codexHistoryViewer.searchTagFiltered", v.length > 0);
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
      void vscode.window.showInformationMessage(
        uiText(
          "検索条件がまだないため、タグフィルタは次回の検索から適用されます。",
          "No previous search request yet. The tag filter will apply from the next search.",
        ),
      );
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
    vscode.commands.registerCommand("codexHistoryViewer.debugInfo", async () => {
      const uiLang = vscode.workspace.getConfiguration("codexHistoryViewer").get<string>("ui.language") ?? "auto";
      const resolvedUiLang = resolveUiLanguage(uiLang === "ja" || uiLang === "en" || uiLang === "auto" ? uiLang : "auto");
      const lines: string[] = [
        `Extension: ${context.extension.id} v${context.extension.packageJSON.version}`,
        `Build: ${debugBuild}`,
        `VS Code env.language: ${vscode.env.language}`,
        `codexHistoryViewer.ui.language: ${uiLang}`,
        `Resolved UI language: ${resolvedUiLang}`,
        `t(view.history): ${t("view.history")}`,
        `t(chat.button.detailsOff): ${t("chat.button.detailsOff")}`,
        `t(chat.button.toolsOff): ${t("chat.button.toolsOff")}`,
        `History filter: ${formatDateScopeForDebug(historyFilter)}`,
        `History source filter: ${historySourceFilter}`,
      ];
      const text = lines.join("\n");
      await vscode.env.clipboard.writeText(text);
      void vscode.window.showInformationMessage(
        uiText(
          "Codex History Viewer: デバッグ情報をクリップボードにコピーしました。",
          "Codex History Viewer: debug info copied to clipboard.",
        ),
      );
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      const uiLanguageChanged = e.affectsConfiguration("codexHistoryViewer.ui.language");
      const headerActionsChanged = e.affectsConfiguration("codexHistoryViewer.ui.alwaysShowHeaderActions");
      const searchDefaultRolesChanged = e.affectsConfiguration("codexHistoryViewer.search.defaultRoles");
      const sourcesEnabledChanged = e.affectsConfiguration("codexHistoryViewer.sources.enabled");
      if (
        !uiLanguageChanged &&
        !headerActionsChanged &&
        !searchDefaultRolesChanged &&
        !sourcesEnabledChanged
      ) {
        return;
      }

      if (sourcesEnabledChanged) {
        const constrained = constrainHistorySourceFilter(historySourceFilter);
        if (constrained !== historySourceFilter) {
          historySourceFilter = constrained;
          historyProvider.setSourceFilter(historySourceFilter);
          pinnedProvider.setSourceFilter(historySourceFilter);
          void context.workspaceState.update(HISTORY_SOURCE_FILTER_KEY, historySourceFilter);
        }
      }

      if (uiLanguageChanged) updateUiLanguageContext();
      updateViewTitles();
      updatePinnedViewDescription();
      updateHistoryViewDescription();
      updateSearchViewDescription();
      chatPanels.refreshI18n();
      void ensureAlwaysShowHeaderActions();

      // When UI language changes, rebuild history-dependent displays because date/time formatting can also change.
      if (!uiLanguageChanged && !sourcesEnabledChanged) {
        refreshViews();
        controlProvider.refresh();
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

  // Open a session preview on selection (if enabled).
  const tryOpenPreview = async (element: unknown): Promise<void> => {
    const latestConfig = getConfig();
    if (!latestConfig.previewOpenOnSelection) return;
    if (!isSessionNode(element)) return;
    const reveal = element instanceof SearchHitNode ? element.hit.messageIndex : undefined;
    await chatPanels.openSession(element.session, { preview: true, revealMessageIndex: reveal });
  };

  // Track the last interacted view, since multiple views can be visible at the same time.
  let lastSelectionSource: "pinned" | "history" | "search" | null = null;
  context.subscriptions.push(
    pinnedView.onDidChangeSelection((e) => {
      lastSelectionSource = "pinned";
      void tryOpenPreview(e.selection[0]);
    }),
  );
  context.subscriptions.push(
    historyView.onDidChangeSelection((e) => {
      lastSelectionSource = "history";
      void tryOpenPreview(e.selection[0]);
    }),
  );
  context.subscriptions.push(
    searchView.onDidChangeSelection((e) => {
      lastSelectionSource = "search";
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
    const selection = element === undefined ? resolveActiveSelection() : resolveSelectionForElement(element) ?? resolveActiveSelection();
    if (element === undefined) return selection;
    return selection.length > 1 ? selection : [element];
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

  const resolveSingleSessionTarget = (elementOrArgs?: unknown): SessionSummary | undefined => {
    // Prefer an explicit fsPath argument from the webview; otherwise use the selected session.
    const hasDirectFsPath =
      !!elementOrArgs &&
      typeof elementOrArgs === "object" &&
      !isSessionNode(elementOrArgs) &&
      typeof (elementOrArgs as { fsPath?: unknown }).fsPath === "string";
    if (hasDirectFsPath) {
      return resolveSessionFromElementOrFsPath(historyService, elementOrArgs);
    }

    const targets = resolveTargets(elementOrArgs);
    const openTargets = collectOpenTargets(targets);
    if (openTargets.length > 0) return openTargets[0]!.session;

    return resolveSessionFromElementOrActive(historyService, transcriptProvider.scheme, elementOrArgs);
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

  const refreshHistoryIndex = async (forceRebuildCache: boolean): Promise<void> => {
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
    lastHistoryRefreshAt = Date.now();
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

  const pushUndoAction = (label: string, undo: () => Promise<void>): void => {
    undoService.push({ label, undo });
  };

  const offerUndo = (message: string): void => {
    void vscode.window.showInformationMessage(message, "Undo").then(async (picked) => {
      if (picked !== "Undo") return;
      await vscode.commands.executeCommand("codexHistoryViewer.undoLastAction");
    });
  };

  const offerCodexReloadHint = (): void => {
    void vscode.window.showInformationMessage(
      uiText(
        "Codex CLI が起動中の場合、履歴を再読み込みしてください。",
        "If Codex CLI is running, reload its history to reflect file changes.",
      ),
    );
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
      void vscode.window.showErrorMessage(uiText("指定された検索プリセットが見つかりません。", "Search preset not found."));
      return false;
    }
    return executeSearch(preset.request);
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
    vscode.commands.registerCommand("codexHistoryViewer.refreshStatusPane", async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: t("app.loadingStatus") },
        async () => refreshHistoryIndex(false),
      );
      statusProvider.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.rebuildCache", async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: t("app.rebuildingCache") },
        async () => refreshHistoryIndex(true),
      );
      refreshViews({ clearSearch: true });
      controlProvider.refresh();
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
        await chatPanels.openSession(session, { preview: false, revealMessageIndex: reveal });
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
          await chatPanels.openSession(it.session, { preview: false, revealMessageIndex: it.revealMessageIndex });
        }
        return;
      }

      if (openTargets.length === 1) {
        const it = openTargets[0]!;
        await chatPanels.openSession(it.session, { preview: false, revealMessageIndex: it.revealMessageIndex });
        return;
      }

      const session = resolveSessionFromElementOrActive(historyService, transcriptProvider.scheme, elementOrArgs);
      if (!session) return;
      const reveal = resolveRevealIndex(elementOrArgs);
      await chatPanels.openSession(session, { preview: false, revealMessageIndex: reveal });
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
        qp.title = uiText("検索対象ロールの既定値", "Default search roles");
        qp.placeholder = uiText("検索で対象にするロールを選択", "Select roles used by default in Search");
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
      void vscode.window.showInformationMessage(
        uiText(`検索既定ロール: ${next.join(", ")}`, `Search default roles: ${next.join(", ")}`),
      );
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
        void vscode.window.showInformationMessage(uiText("利用可能なタグがありません。", "No tags available."));
        return;
      }

      const items = tagStats.map((x) => ({
        label: `#${x.tag}`,
        description: `${x.count}`,
        tag: x.tag,
      }));

      const picked = await new Promise<readonly (typeof items)[number][] | undefined>((resolve) => {
        const qp = vscode.window.createQuickPick<(typeof items)[number]>();
        qp.title = uiText("検索をタグで絞り込む", "Filter Search by Tags");
        qp.placeholder = uiText("検索対象のタグを選択", "Select tags included in search");
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
        void vscode.window.showInformationMessage(uiText("利用可能なタグがありません。", "No tags available."));
        return;
      }

      const items = tagStats.map((x) => ({
        label: `#${x.tag}`,
        description: `${x.count}`,
        tag: x.tag,
      }));

      const picked = await new Promise<readonly (typeof items)[number][] | undefined>((resolve) => {
        const qp = vscode.window.createQuickPick<(typeof items)[number]>();
        qp.title = uiText("ピン留めをタグで絞り込む", "Filter Pinned by Tags");
        qp.placeholder = uiText("表示するタグを選択", "Select tags shown in Pinned");
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
    vscode.commands.registerCommand("codexHistoryViewer.searchRunPresetById", async (presetIdArg?: unknown) => {
      const presetId =
        typeof presetIdArg === "string"
          ? presetIdArg
          : presetIdArg && typeof presetIdArg === "object" && typeof (presetIdArg as { id?: unknown }).id === "string"
            ? String((presetIdArg as { id: string }).id)
            : "";
      await runSearchPresetById(presetId);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.searchRunPreset", async () => {
      const presets = searchPresetStore.getAll();
      if (presets.length === 0) {
        void vscode.window.showInformationMessage(uiText("保存済み検索がありません。", "No saved search presets."));
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
          title: uiText("保存済み検索を実行", "Run saved search"),
        },
      );
      if (!picked) return;
      await runSearchPresetById(picked.presetId);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.searchSavePreset", async () => {
      if (!lastSearchRequest) {
        void vscode.window.showInformationMessage(
          uiText("保存する検索条件がありません。先に検索を実行してください。", "No search request to save. Run search first."),
        );
        return;
      }

      const suggested = lastSearchRequest.queryInput.slice(0, 80);
      const nameInput = await vscode.window.showInputBox({
        title: uiText("検索プリセットを保存", "Save search preset"),
        prompt: uiText("プリセット名を入力", "Enter a preset name"),
        value: suggested,
        validateInput: (v) => (v.trim().length === 0 ? uiText("名前を入力してください。", "Name is required.") : undefined),
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
      void vscode.window.showInformationMessage(uiText(`保存しました: ${name}`, `Saved: ${name}`));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.searchDeletePreset", async () => {
      const presets = searchPresetStore.getAll();
      if (presets.length === 0) {
        void vscode.window.showInformationMessage(uiText("削除できるプリセットがありません。", "No presets to delete."));
        return;
      }

      const picked = await vscode.window.showQuickPick(
        presets.map((p) => ({
          label: p.name,
          description: p.request.queryInput,
          presetId: p.id,
        })),
        {
          title: uiText("検索プリセットを削除", "Delete search preset"),
        },
      );
      if (!picked) return;

      const deleted = await searchPresetStore.delete(picked.presetId);
      if (!deleted) return;
      statusProvider.refresh();
      void vscode.window.showInformationMessage(uiText(`削除しました: ${picked.label}`, `Deleted: ${picked.label}`));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.exportSessions", async (element?: unknown) => {
      const sessions = collectSessionsFromTargets(resolveTargets(element));
      if (sessions.length === 0) {
        void vscode.window.showInformationMessage(uiText("エクスポート対象がありません。", "No sessions selected."));
        return;
      }

      const mode = await vscode.window.showQuickPick(
        [
          { label: uiText("生JSONLをエクスポート", "Export raw JSONL"), value: "raw" as const },
          { label: uiText("サニタイズ済みMarkdownをエクスポート", "Export sanitized Markdown"), value: "masked" as const },
        ],
        { title: uiText("エクスポート形式を選択", "Select export format") },
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
        uiText(
          `完了: 成功 ${result.exported} / 失敗 ${result.failed} / スキップ ${result.skipped}`,
          `Done: exported ${result.exported}, failed ${result.failed}, skipped ${result.skipped}`,
        ),
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.importSessions", async () => {
      const modePick = await vscode.window.showQuickPick(
        [
          {
            label: uiText("重複IDはスキップ", "Skip duplicate session IDs"),
            mode: "skip" as const,
          },
          {
            label: uiText("重複IDは上書き", "Overwrite duplicate session IDs"),
            mode: "overwrite" as const,
          },
        ],
        { title: uiText("インポート時の重複ID処理", "How to handle duplicate IDs on import") },
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
      if (result.imported > 0 || result.overwritten > 0) offerCodexReloadHint();

      void vscode.window.showInformationMessage(
        uiText(
          `完了: 新規 ${result.imported} / 上書き ${result.overwritten} / 失敗 ${result.failed} / スキップ ${result.skipped}`,
          `Done: imported ${result.imported}, overwritten ${result.overwritten}, failed ${result.failed}, skipped ${result.skipped}`,
        ),
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.cleanupMissingPins", async () => {
      const missingPaths = pinStore
        .getAll()
        .map((x) => x.fsPath)
        .filter((fsPath) => !historyService.findByFsPath(fsPath));
      if (missingPaths.length === 0) {
        void vscode.window.showInformationMessage(uiText("欠損ピンはありません。", "No missing pins."));
        return;
      }

      const choice = await vscode.window.showWarningMessage(
        uiText(`${missingPaths.length} 件の欠損ピンを削除しますか？`, `Remove ${missingPaths.length} missing pin(s)?`),
        { modal: true },
        "OK",
      );
      if (choice !== "OK") return;

      const { unpinned } = await pinStore.unpinMany(missingPaths);
      refreshViews();
      if (unpinned > 0) {
        pushUndoAction(`cleanup missing pins (${unpinned})`, async () => {
          await pinStore.pinMany(missingPaths);
          refreshViews();
        });
        offerUndo(`Removed ${unpinned} missing pin(s).`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.undoLastAction", async () => {
      const action = await undoService.undoLast();
      if (!action) {
        void vscode.window.showInformationMessage(uiText("取り消せる操作がありません。", "Nothing to undo."));
        return;
      }
      await refreshHistoryIndex(false);
      refreshViews({ clearSearch: true });
      void vscode.window.showInformationMessage(uiText(`取り消しました: ${action.label}`, `Undone: ${action.label}`));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.editSessionAnnotation", async (element?: unknown) => {
      const sessions = resolveAnnotationTargets(element);
      if (sessions.length === 0) {
        void vscode.window.showInformationMessage(uiText("対象セッションが選択されていません。", "No session selected."));
        return;
      }

      const action = await vscode.window.showQuickPick(
        [
          { label: uiText("タグとメモを編集", "Edit tags and note"), value: "edit" as const },
          { label: uiText("既存タグを追加", "Add existing tags"), value: "addExisting" as const },
          { label: uiText("タグを削除", "Remove tags"), value: "remove" as const },
        ],
        { title: uiText("注釈の操作を選択", "Choose annotation action") },
      );
      if (!action) return;

      const previous = snapshotAnnotations(sessions);
      const sessionPaths = sessions.map((s) => s.fsPath);
      let changed = 0;

      if (action.value === "edit") {
        const seed = sessions.length === 1 ? annotationStore.get(sessions[0]!.fsPath) : null;
        const tagsInput = await vscode.window.showInputBox({
          title: uiText("セッションタグを編集", "Edit session tags"),
          prompt: uiText("カンマ区切りでタグを入力。空でタグなし。", "Comma-separated tags. Empty means no tags."),
          value: seed?.tags.join(", ") ?? "",
        });
        if (tagsInput === undefined) return;

        const noteInput = await vscode.window.showInputBox({
          title: uiText("セッションメモを編集", "Edit session note"),
          prompt: uiText("任意メモ（最大500文字）。空で削除。", "Optional note (max 500 chars). Empty clears note."),
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
          void vscode.window.showInformationMessage(uiText("利用可能なタグがありません。", "No tags available."));
          return;
        }
        const picked = await vscode.window.showQuickPick(
          tagStats.map((x) => ({
            label: `#${x.tag}`,
            description: `${x.count}`,
            tag: x.tag,
          })),
          { title: uiText("追加するタグを選択", "Select tags to add"), canPickMany: true },
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
          void vscode.window.showInformationMessage(uiText("削除できるタグがありません。", "No tags to remove."));
          return;
        }
        const picked = await vscode.window.showQuickPick(
          Array.from(tagUnion.values()).map((tag) => ({ label: `#${tag}`, tag })),
          { title: uiText("削除するタグを選択", "Select tags to remove"), canPickMany: true },
        );
        if (!picked || picked.length === 0) return;
        changed = await annotationStore.removeTagsMany(sessionPaths, picked.map((x) => x.tag));
      }

      if (changed <= 0) {
        void vscode.window.showInformationMessage(uiText("変更はありませんでした。", "No changes were applied."));
        return;
      }
      refreshViews();

      pushUndoAction(`annotation update (${sessions.length})`, async () => {
        await restoreAnnotations(sessions, previous);
      });
      offerUndo(`Updated annotation for ${changed} session(s).`);
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
      pushUndoAction(`remove tag (${tag})`, async () => {
        await restoreAnnotations(sessions, previous);
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.renameTagGlobally", async () => {
      const tagStats = annotationStore.listTagStats();
      if (tagStats.length === 0) {
        void vscode.window.showInformationMessage(uiText("リネーム対象のタグがありません。", "No tags available to rename."));
        return;
      }

      const sourcePicked = await vscode.window.showQuickPick(
        tagStats.map((x) => ({
          label: `#${x.tag}`,
          description: `${x.count}`,
          tag: x.tag,
        })),
        { title: uiText("置換元のタグを選択", "Select source tag") },
      );
      if (!sourcePicked) return;

      const sourceTag = sourcePicked.tag;
      const nextInput = await vscode.window.showInputBox({
        title: uiText("置換先のタグ名", "Destination tag name"),
        prompt: uiText("新しいタグ名を入力", "Enter the new tag name"),
        value: sourceTag,
        validateInput: (v) => {
          const normalized = normalizeTags([String(v ?? "").replace(/^#+/, "").trim()]);
          return normalized.length > 0 ? undefined : uiText("タグ名を入力してください。", "Tag name is required.");
        },
      });
      if (nextInput === undefined) return;

      const normalized = normalizeTags([String(nextInput ?? "").replace(/^#+/, "").trim()]);
      if (normalized.length === 0) {
        void vscode.window.showErrorMessage(uiText("タグ名が不正です。", "Invalid tag name."));
        return;
      }
      const destinationTag = normalized[0]!;
      if (destinationTag.toLowerCase() === sourceTag.toLowerCase()) {
        void vscode.window.showInformationMessage(uiText("同じタグ名のため変更はありません。", "No changes: the tag name is unchanged."));
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
        void vscode.window.showInformationMessage(uiText("変更対象はありませんでした。", "No matching tags were found."));
        return;
      }

      refreshViews();
      pushUndoAction(`rename tag globally (${sourceTag} -> ${destinationTag})`, async () => {
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
      offerUndo(uiText(
        `タグ #${sourceTag} を #${destinationTag} に変更しました（${changedCount} 件）。`,
        `Renamed #${sourceTag} to #${destinationTag} (${changedCount} sessions).`,
      ));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.deleteTagsGlobally", async () => {
      const tagStats = annotationStore.listTagStats();
      if (tagStats.length === 0) {
        void vscode.window.showInformationMessage(uiText("削除対象のタグがありません。", "No tags available to delete."));
        return;
      }

      const picked = await vscode.window.showQuickPick(
        tagStats.map((x) => ({
          label: `#${x.tag}`,
          description: `${x.count}`,
          tag: x.tag,
        })),
        {
          title: uiText("全セッションから削除するタグを選択", "Select tags to delete from all sessions"),
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
        void vscode.window.showInformationMessage(uiText("変更対象はありませんでした。", "No matching tags were found."));
        return;
      }

      refreshViews();
      pushUndoAction(`delete tags globally (${picked.length})`, async () => {
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
      offerUndo(
        uiText(
          `タグを削除しました（${changedCount} 件のセッション）。`,
          `Deleted tags from ${changedCount} session(s).`,
        ),
      );
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
        tags: historyTagFilter,
        availableTags: annotationStore.listTagStats().map((x) => x.tag),
      });
      if (!change) return;
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
        void vscode.window.showInformationMessage(uiText("利用可能なタグがありません。", "No tags available."));
        return;
      }

      const items = tagStats.map((x) => ({
        label: `#${x.tag}`,
        description: `${x.count}`,
        tag: x.tag,
      }));

      const picked = await new Promise<readonly (typeof items)[number][] | undefined>((resolve) => {
        const qp = vscode.window.createQuickPick<(typeof items)[number]>();
        qp.title = uiText("タグで履歴を絞り込む", "Filter history by tags");
        qp.placeholder = uiText("対象タグを選択", "Select tags");
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
      const sessions = Array.from(byKey.values());
      if (sessions.length === 0) return;

      if (sessions.length === 1) {
        const choice = await vscode.window.showWarningMessage(t("app.promoteConfirm"), { modal: true }, "OK");
        if (choice !== "OK") return;

        const promoted = await promoteSessionCopyToToday(sessions[0]!, historyService, getConfig());
        await vscode.window.showInformationMessage(t("app.promoteDone"));
        pushUndoAction("promote", async () => {
          try {
            await vscode.workspace.fs.delete(vscode.Uri.file(promoted.fsPath), { recursive: false, useTrash: false });
          } catch {
            // Skip if already removed.
          }
        });
        offerUndo("Promoted session created.");

        // Refresh views and open the newly created session.
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: t("app.loadingHistory") },
          async () => refreshHistoryIndex(false),
        );
        refreshViews({ clearSearch: true });
        await transcriptProvider.openSessionTranscript(promoted, { preview: false });
        offerCodexReloadHint();
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
        pushUndoAction(`promote (${promotedPaths.length})`, async () => {
          for (const fsPath of promotedPaths) {
            try {
              await vscode.workspace.fs.delete(vscode.Uri.file(fsPath), { recursive: false, useTrash: false });
            } catch {
              // Ignore files already missing.
            }
          }
        });
        offerUndo(`Promoted ${promotedPaths.length} session(s).`);
      }

      // Refresh views in bulk (viewer restores position after multiple copies).
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: t("app.loadingHistory") },
        async () => refreshHistoryIndex(false),
      );
      refreshViews({ clearSearch: true });
      if (succeeded > 0) offerCodexReloadHint();
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
      let fsPaths: string[] = [];
      if (hasDirectFsPath) {
        const session = resolveSessionFromElementOrFsPath(historyService, element);
        fsPaths = session ? [session.fsPath] : [];
      } else {
        const targets = resolveTargets(element);
        fsPaths = collectSessionFsPaths(targets);
      }
      if (fsPaths.length === 0) return;
      const pinnedBefore = new Set(fsPaths.filter((p) => pinStore.isPinned(p)).map((p) => normalizeCacheKey(p)));
      const { pinned, skipped } = await pinStore.pinMany(fsPaths);
      refreshViews();
      const newlyPinned = fsPaths.filter((p) => !pinnedBefore.has(normalizeCacheKey(p)));
      if (newlyPinned.length > 0) {
        pushUndoAction(`pin (${newlyPinned.length})`, async () => {
          await pinStore.unpinMany(newlyPinned);
        });
        offerUndo(`Pinned ${newlyPinned.length} session(s).`);
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
      const pinnedNow = fsPaths.filter((p) => pinStore.isPinned(p));
      const { unpinned, skipped } = await pinStore.unpinMany(fsPaths);
      refreshViews();
      if (pinnedNow.length > 0) {
        pushUndoAction(`unpin (${pinnedNow.length})`, async () => {
          await pinStore.pinMany(pinnedNow);
        });
        offerUndo(`Unpinned ${pinnedNow.length} session(s).`);
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
      const previousAnnotations = new Map<string, { tags: string[]; note: string } | null>();
      for (const fsPath of deletedPaths) {
        const ann = annotationStore.get(fsPath);
        previousAnnotations.set(normalizeCacheKey(fsPath), ann ? { tags: [...ann.tags], note: ann.note } : null);
      }
      await annotationStore.removeMany(deletedPaths);

      if (result.undoItems.length > 0) {
        pushUndoAction(`delete (${result.deleted})`, async () => {
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
        });
        offerUndo(`Deleted ${result.deleted} session(s).`);
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
  registerUiCommandAlias("codexHistoryViewer.ui.ja.promoteSession", "codexHistoryViewer.promoteSession");
  registerUiCommandAlias("codexHistoryViewer.ui.en.promoteSession", "codexHistoryViewer.promoteSession");
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
  registerUiCommandAlias("codexHistoryViewer.ui.ja.editSessionAnnotation", "codexHistoryViewer.editSessionAnnotation");
  registerUiCommandAlias("codexHistoryViewer.ui.en.editSessionAnnotation", "codexHistoryViewer.editSessionAnnotation");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.renameTagGlobally", "codexHistoryViewer.renameTagGlobally");
  registerUiCommandAlias("codexHistoryViewer.ui.en.renameTagGlobally", "codexHistoryViewer.renameTagGlobally");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.deleteTagsGlobally", "codexHistoryViewer.deleteTagsGlobally");
  registerUiCommandAlias("codexHistoryViewer.ui.en.deleteTagsGlobally", "codexHistoryViewer.deleteTagsGlobally");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.undoLastAction", "codexHistoryViewer.undoLastAction");
  registerUiCommandAlias("codexHistoryViewer.ui.en.undoLastAction", "codexHistoryViewer.undoLastAction");

  // Initial load on activation.
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: t("app.loadingHistory") },
    async () => {
      await refreshHistoryIndex(false);
    },
  );
  refreshViews();
  controlProvider.refresh();
}

function formatDateScopeForDebug(scope: DateScope): string {
  const v = getDateScopeValue(scope);
  return v ? `${scope.kind}:${v}` : "all";
}

function sanitizeProjectCwd(value: unknown): string | null {
  const s = typeof value === "string" ? value.trim() : "";
  return s.length > 0 ? s : null;
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

function resolveLockedHistorySource(config: CodexHistoryViewerConfig): SessionSourceFilter | null {
  if (config.enableCodexSource && !config.enableClaudeSource) return "codex";
  if (!config.enableCodexSource && config.enableClaudeSource) return "claude";
  return null;
}

function resolveConstrainedHistorySourceFilter(
  sourceFilter: SessionSourceFilter,
  config: CodexHistoryViewerConfig,
): SessionSourceFilter {
  const locked = resolveLockedHistorySource(config);
  return locked ?? sanitizeHistorySourceFilter(sourceFilter);
}

function uiText(ja: string, en: string): string {
  return resolveUiLanguage() === "ja" ? ja : en;
}

type HistoryFilterChange =
  | { kind: "date"; date: DateScope }
  | { kind: "project"; projectCwd: string | null }
  | { kind: "source"; source: SessionSourceFilter }
  | { kind: "tags"; tags: string[] };

type HistoryFilterPick = vscode.QuickPickItem & {
  pickKind?: "date" | "project" | "source" | "tags";
  date?: DateScope;
  projectCwd?: string | null;
  source?: SessionSourceFilter;
  tags?: string[];
};

async function promptHistoryFilter(
  idx: import("./sessions/sessionTypes").HistoryIndex,
  current: {
    date: DateScope;
    projectCwd: string | null;
    source: SessionSourceFilter;
    sourceOptions: SessionSourceFilter[];
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

  const tagItemsBase: HistoryFilterPick[] = [
    { label: uiText("タグ", "Tags"), kind: vscode.QuickPickItemKind.Separator },
    { label: uiText("タグフィルターを編集", "Edit tag filter"), pickKind: "tags" as const, tags: current.tags },
    { label: uiText("タグフィルターを解除", "Clear tag filter"), pickKind: "tags" as const, tags: [] },
  ];

  const baseItems: HistoryFilterPick[] = [...dateItemsBase, ...projectItemsBase, ...sourceItemsBase, ...tagItemsBase];

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

      qp.items = [...dateItemsBase, ...dayItems, ...projectItemsBase, ...sourceItemsBase, ...tagItemsBase];
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
    qp.activeItems = activeDateItem
      ? [activeDateItem]
      : activeProjectItem
        ? [activeProjectItem]
        : activeSourceItem
          ? [activeSourceItem]
          : [];
    qp.show();
  });
}

// Cleanup hook called by VS Code.
export function deactivate(): void {
  // Disposables are already registered in context.subscriptions.
}

function resolveRevealIndex(element: unknown): number | undefined {
  if (!(element instanceof SearchHitNode)) return undefined;
  if (element.hit.role !== "user" && element.hit.role !== "assistant") return undefined;
  return element.hit.messageIndex;
}

function resolveRevealIndexFromArgs(args: unknown): number | undefined {
  if (!args || typeof args !== "object") return undefined;
  const v = (args as any).revealMessageIndex;
  return typeof v === "number" ? v : undefined;
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
