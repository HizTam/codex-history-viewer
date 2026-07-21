import * as path from "node:path";
import * as vscode from "vscode";
import { resolveUiLanguage, t } from "./i18n";
import { getConfig, type CodexHistoryViewerConfig } from "./settings";
import {
  HistoryService,
  isHistoryOperationSupersededError,
  type HistoryRebuildSnapshot,
} from "./services/historyService";
import type { ArchiveLocationFilter, SessionSourceFilter, SessionSummary } from "./sessions/sessionTypes";
import { PinnedTreeDataProvider, type PinnedSortMode } from "./tree/pinnedTree";
import {
  HistoryTreeDataProvider,
  buildProjectLabel,
  type HistoryRevealIdentity,
  type HistorySortOrder,
  type HistoryViewMode,
} from "./tree/historyTree";
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
import {
  type HistorySearchIndexSnapshot,
  type HistorySearchRefreshState,
  type HistorySearchScopeSnapshot,
  type SearchRequest,
  createHistorySearchScopeSnapshot,
  runSearchFlow,
  waitForCurrentHistorySearchIndex,
} from "./services/searchService";
import { type IndexedSearchRole, SearchIndexService } from "./services/searchIndexService";
import { SearchExecutionCoordinator } from "./services/searchExecutionCoordinator";
import {
  GLOBAL_SEARCH_HISTORY_PROJECT_KEY,
  SearchHistoryStore,
  normalizeSearchHistoryProjectKey,
} from "./services/searchHistoryStore";
import { exportMaskedTranscripts, exportSessions, importSessions } from "./services/importExportService";
import { type SearchPreset, SearchPresetStore } from "./services/searchPresetStore";
import { SessionAnnotationStore } from "./services/sessionAnnotationStore";
import {
  getMaxCustomTitleLength,
  isCustomTitleTooLong,
  normalizeCustomTitle,
  SessionTitleOverrideStore,
} from "./services/sessionTitleOverrideStore";
import {
  getMaxProjectAliasLength,
  isProjectAliasTooLong,
  normalizeProjectAlias,
  ProjectAliasStore,
} from "./services/projectAliasStore";
import {
  ProjectAssociationStore,
  type ProjectAssociation,
  type ProjectAssociationMode,
  type ProjectAssociationModeChangePreflight,
  type ProjectAssociationSetPreflight,
} from "./services/projectAssociationStore";
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
  type HandoffPathRewriteContext,
  type HandoffTarget,
  buildHandoffPrompt,
  cleanupHandoffs,
  createHandoff,
  isHandoffPathRewriteStale,
  readHandoffMetadata,
  resolveHandoffLocation,
} from "./services/handoffService";
import type { TreeNode } from "./tree/treeNodes";
import {
  DayNode,
  MissingPinnedNode,
  MonthNode,
  ProjectNode,
  RelatedGroupNode,
  SearchHitNode,
  SearchSessionNode,
  type SessionPageSearchSeed,
  YearNode,
  isSessionNode,
} from "./tree/treeNodes";
import {
  ControlTreeDataProvider,
  StatusTreeDataProvider,
} from "./tree/utilityTrees";
import { ChatPanelManager } from "./chat/chatPanelManager";
import { FileChangeHistoryPanelManager } from "./fileHistory/fileChangeHistoryPanelManager";
import { FileChangeHistoryService } from "./fileHistory/fileChangeHistoryService";
import { SessionAnalysisCancelledError, SessionAnalysisIndexService } from "./analysis/sessionAnalysisIndexService";
import { HistoryInsightsPanelManager } from "./insights/historyInsightsPanelManager";
import type { HistoryInsightsSnapshot } from "./insights/historyInsightsTypes";
import { ClaudeBranchNavigationService } from "./branchMap/claudeBranchNavigationService";
import { CodexForkNavigationService } from "./branchMap/codexForkNavigationService";
import { getDateScopeValue, isSameDateScope, sanitizeDateScope, type DateScope } from "./types/dateScope";
import {
  createHistoryFilterStateV2,
  HISTORY_FILTER_STATE_V2_KEY,
  parseHistoryFilterStateV2,
  type HistoryFilterStateV2,
} from "./types/historyFilterState";
import {
  getSingleProjectSelectionCwd,
  isSameProjectSelection,
  MAX_PROJECT_SELECTION_GROUPS,
  projectSelectionFromCwds,
  reconcileProjectSelection,
  type ProjectSelection,
} from "./types/projectSelection";
import {
  resolveHistoryProjectFilterState,
  restoreHistoryProjectScopeState,
  type HistoryProjectScopePolicy,
  type ProjectScopeMode,
} from "./types/historyProjectScope";
import {
  buildHistoryInsightsFilterTransition,
  validateHistoryInsightsArchiveLocation,
} from "./insights/historyInsightsFilterTransition";
import {
  getDateTimeSettingsKey,
  resolveDateTimeSettings,
  type DateTimeSettings,
} from "./utils/dateTimeSettings";
import { safeDisplayPath } from "./utils/textUtils";
import { normalizeCacheKey, normalizeProjectKey, pathExists } from "./utils/fsUtils";
import { MementoTransactionError, updateMementoTransaction } from "./storage/mementoTransaction";
import { CodexAgentRunsService } from "./agents/codexAgentRunsService";
import { SessionIconResolver } from "./ui/sessionIconResolver";

const SEARCH_ROLE_ORDER: IndexedSearchRole[] = ["user", "assistant", "developer", "tool"];
// Keep staged rollout internal until the feature behavior is validated with real session data.
const SESSION_ANALYSIS_FEATURES_ENABLED = true;

type ProjectDisplayMode = "list" | "project";

interface CoordinatedCacheRebuildInventory {
  readonly searchSnapshot: HistorySearchIndexSnapshot;
  readonly sessions: readonly SessionSummary[];
}

interface HistorySearchStartSnapshot {
  readonly config: CodexHistoryViewerConfig;
  readonly refreshState: HistorySearchRefreshState;
}

interface CacheMaintenanceProgressContext {
  readonly progress: vscode.Progress<{ message?: string; increment?: number }>;
  readonly token: vscode.CancellationToken;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolveValue!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  return Object.freeze({ promise, resolve: resolveValue });
}

// Extension entry point. Initializes core services and tree views.
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const config = getConfig();
  const HISTORY_FILTER_KEY = "codexHistoryViewer.historyFilter.v1";
  const HISTORY_VIEW_MODE_KEY = "codexHistoryViewer.historyViewMode.v1";
  const HISTORY_SORT_ORDER_KEY = "codexHistoryViewer.historySortOrder.v1";
  const HISTORY_PROJECT_FILTER_KEY = "codexHistoryViewer.historyProjectFilter.v1";
  const HISTORY_PROJECT_GROUPED_KEY = "codexHistoryViewer.historyProjectGrouped.v1";
  const HISTORY_PROJECT_DISPLAY_KEY = "codexHistoryViewer.historyProjectDisplay.v1";
  const HISTORY_PROJECT_SCOPE_KEY = "codexHistoryViewer.historyProjectScope.v1";
  const HISTORY_SOURCE_FILTER_KEY = "codexHistoryViewer.historySourceFilter.v1";
  const HISTORY_TAG_FILTER_KEY = "codexHistoryViewer.historyTagFilter.v1";
  const PINNED_FILTER_KEY = "codexHistoryViewer.pinnedFilter.v1";
  const PINNED_SOURCE_FILTER_KEY = "codexHistoryViewer.pinnedSourceFilter.v1";
  const PINNED_PROJECT_FILTER_KEY = "codexHistoryViewer.pinnedProjectFilter.v1";
  const PINNED_PROJECT_GROUPED_KEY = "codexHistoryViewer.pinnedProjectGrouped.v1";
  const PINNED_PROJECT_DISPLAY_KEY = "codexHistoryViewer.pinnedProjectDisplay.v1";
  const PINNED_PROJECT_SCOPE_KEY = "codexHistoryViewer.pinnedProjectScope.v1";
  const PINNED_ARCHIVE_LOCATION_FILTER_KEY = "codexHistoryViewer.pinnedArchiveLocationFilter.v1";
  const PINNED_SORT_MODE_KEY = "codexHistoryViewer.pinnedSortMode.v1";
  const PINNED_TAG_FILTER_KEY = "codexHistoryViewer.pinnedTagFilter.v1";
  const LAST_SEARCH_REQUEST_KEY = "codexHistoryViewer.lastSearchRequest.v1";
  const ARCHIVE_LOCATION_FILTER_KEY = "codexHistoryViewer.archiveLocationFilter.v1";
  const LEGACY_SHOW_ARCHIVED_SESSIONS_KEY = "codexHistoryViewer.showArchivedSessions.v1";
  const SEARCH_DEFAULT_ROLES_CONFIG = "search.defaultRoles";
  const logger = new OutputChannelLogger();
  context.subscriptions.push(logger);
  const commitWorkspaceStateTransaction = async (
    writes: readonly { key: string; value: unknown }[],
  ): Promise<void> => {
    try {
      await updateMementoTransaction(context.workspaceState, writes);
    } catch (error) {
      if (error instanceof MementoTransactionError && error.rollbackFailed) {
        await vscode.window.showErrorMessage(t("history.filterState.rollbackFailed"));
      }
      throw error;
    }
  };
  let archiveLocationFilter: ArchiveLocationFilter = sanitizeArchiveLocationFilter(
    context.workspaceState.get(ARCHIVE_LOCATION_FILTER_KEY),
    context.workspaceState.get(LEGACY_SHOW_ARCHIVED_SESSIONS_KEY),
  );
  const pinnedArchiveLocationRaw = context.workspaceState.get(PINNED_ARCHIVE_LOCATION_FILTER_KEY);
  let pinnedArchiveLocationFilter: ArchiveLocationFilter = sanitizeArchiveLocationFilter(
    pinnedArchiveLocationRaw === undefined ? archiveLocationFilter : pinnedArchiveLocationRaw,
  );
  if (pinnedArchiveLocationRaw === undefined) {
    try {
      await context.workspaceState.update(PINNED_ARCHIVE_LOCATION_FILTER_KEY, pinnedArchiveLocationFilter);
    } catch (error) {
      logger.debug(`pinned.archiveLocation.migration failed error=${sanitizeDebugError(error)}`);
    }
  }
  const pinnedSortModeRaw = context.workspaceState.get(PINNED_SORT_MODE_KEY);
  let pinnedSortMode: PinnedSortMode = sanitizePinnedSortMode(pinnedSortModeRaw, config.historyDateBasis);
  if (isLegacyPinnedSortModeValue(pinnedSortModeRaw)) {
    try {
      await context.workspaceState.update(PINNED_SORT_MODE_KEY, pinnedSortMode);
    } catch (error) {
      logger.debug(`pinned.sortMode.migration failed error=${sanitizeDebugError(error)}`);
    }
  }

  const updateUiLanguageContext = (): void => {
    // Keep the UI language context up to date for menu visibility switching.
    // The value is fixed to "ja"/"en" because package.json `when` clauses depend on it.
    const lang = resolveUiLanguage();
    void vscode.commands.executeCommand("setContext", "codexHistoryViewer.uiLang", lang);
  };
  updateUiLanguageContext();
  void vscode.commands.executeCommand(
    "setContext",
    "codexHistoryViewer.sessionAnalysisFeaturesEnabled",
    SESSION_ANALYSIS_FEATURES_ENABLED,
  );
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
    void vscode.commands.executeCommand(
      "setContext",
      "codexHistoryViewer.pinnedArchiveLocationFilter",
      pinnedArchiveLocationFilter,
    );
  };
  updateArchivedSessionsContext();

  const pinStore = new PinStore(context.globalState);
  const bookmarkStore = new BookmarkStore(context.globalState);
  const annotationStore = new SessionAnnotationStore(context.globalState);
  const titleOverrideStore = new SessionTitleOverrideStore(context.globalState);
  const projectAliasStore = new ProjectAliasStore(context.globalState);
  const projectAssociationStore = new ProjectAssociationStore(context.globalState);
  const searchPresetStore = new SearchPresetStore(context.globalState);
  const searchHistoryStore = new SearchHistoryStore(context.workspaceState);
  void searchHistoryStore.discardLegacyHistory().catch((error) => {
    logger.debug(`searchHistory legacy discard failed error=${sanitizeDebugError(error)}`);
  });
  const chatOpenPositionStore = new ChatOpenPositionStore(context.globalState);
  const sessionReferenceRelocator = new SessionReferenceRelocator(
    annotationStore,
    bookmarkStore,
    chatOpenPositionStore,
    logger,
  );
  const historyService = new HistoryService(context.globalStorageUri, config, titleOverrideStore, logger);
  let historyRefreshQueue: Promise<void> = Promise.resolve();
  const initialAuthoritativeHistoryRefreshSettled = createDeferred<void>();
  let authoritativeHistoryIndexConfig: CodexHistoryViewerConfig | null = null;
  let authoritativeHistoryInventoryGeneration: number | null = null;
  const markAuthoritativeHistoryIndex = (candidateConfig: CodexHistoryViewerConfig): void => {
    if (!historyService.isCurrentIndexForConfig(candidateConfig)) return;
    authoritativeHistoryIndexConfig = Object.freeze({ ...candidateConfig });
    authoritativeHistoryInventoryGeneration = historyService.getIndexInventoryGeneration();
  };
  const codexAgentRuns = new CodexAgentRunsService(historyService, logger);
  const sessionIconResolver = new SessionIconResolver(context.extensionUri);
  const sessionAnalysisIndex = new SessionAnalysisIndexService(context.globalStorageUri, logger);
  const claudeBranchNavigation = new ClaudeBranchNavigationService(
    historyService,
    sessionAnalysisIndex,
    bookmarkStore,
    annotationStore,
  );
  const codexForkNavigation = new CodexForkNavigationService(historyService, {
    getPresentationState: (session, branchStart) => {
      const annotation = annotationStore.get(session.fsPath);
      const isBookmarked = bookmarkStore.getAll().some(
        (entry) =>
          entry.sessionCacheKey === session.cacheKey &&
          entry.kind === "message" &&
          entry.messageIndex === branchStart.chatMessageIndex,
      );
      return {
        isBookmarked,
        hasTags: Boolean(annotation?.tags.length),
        hasNote: Boolean(annotation?.note),
      };
    },
  });
  const searchIndexService = new SearchIndexService(context.globalStorageUri, logger);
  const transcriptProvider = new TranscriptContentProvider(historyService, annotationStore, projectAssociationStore);
  const chatPanels = new ChatPanelManager(
    context.extensionUri,
    historyService,
    annotationStore,
    pinStore,
    projectAssociationStore,
    bookmarkStore,
    chatOpenPositionStore,
    searchHistoryStore,
    claudeBranchNavigation,
    codexForkNavigation,
    codexAgentRuns,
    sessionIconResolver,
    async () => {
      await vscode.commands.executeCommand("codexHistoryViewer.refresh");
    },
    logger,
  );
  const fileChangeHistoryService = new FileChangeHistoryService(projectAssociationStore);
  const fileChangeHistoryPanels = new FileChangeHistoryPanelManager(
    context.extensionUri,
    historyService,
    searchIndexService,
    fileChangeHistoryService,
    projectAssociationStore,
    chatPanels,
    bookmarkStore,
    searchHistoryStore,
    logger,
  );
  chatPanels.setSearchHistoryPeerRefresh(() => fileChangeHistoryPanels.refreshSearchHistoryCandidates());
  if (config.webviewRestoreAfterReload) {
    chatPanels.registerSerializer(context.subscriptions);
    fileChangeHistoryPanels.registerSerializer(context.subscriptions);
  }
  context.subscriptions.push(pinStore, bookmarkStore, annotationStore, chatPanels, fileChangeHistoryPanels);
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
  const searchExecution = new SearchExecutionCoordinator();
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
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.historySortOrder", "createdDesc");
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.historyProjectDisplay", "list");
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.historyProjectScope", "all");
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.pinnedProjectDisplay", "list");
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.pinnedProjectScope", "all");
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.pinnedSortMode", pinnedSortMode);
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.pinnedSourceFilter", "all");
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.pinnedSourceFiltered", false);
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.pinnedSourceSwitchable", true);
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.pinnedFiltered", false);
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.pinnedTagFiltered", false);
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.sourceCodexEnabled", true);
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.sourceClaudeEnabled", true);
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.historySourceSwitchable", true);
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.hasMultiSelection", false);
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.hasMultiSessionSelection", false);
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.canArchiveSelection", false);
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.canRestoreArchivedSelection", false);
  void vscode.commands.executeCommand("setContext", "codexHistoryViewer.hasMixedArchiveSelection", false);

  let historyViewMode: HistoryViewMode = sanitizeHistoryViewMode(context.workspaceState.get(HISTORY_VIEW_MODE_KEY));
  const historySortOrderRaw = context.workspaceState.get(HISTORY_SORT_ORDER_KEY);
  let historySortOrderExplicit = isHistorySortOrderValue(historySortOrderRaw);
  let historySortOrder: HistorySortOrder = sanitizeHistorySortOrder(historySortOrderRaw, config.historyDateBasis);
  let historyFilter: DateScope = sanitizeDateScope(context.workspaceState.get(HISTORY_FILTER_KEY));
  let historyProjectCwd: string | null = sanitizeProjectCwd(context.workspaceState.get(HISTORY_PROJECT_FILTER_KEY));
  const historyProjectDisplayRaw = context.workspaceState.get(HISTORY_PROJECT_DISPLAY_KEY);
  const historyProjectScopeRaw = context.workspaceState.get(HISTORY_PROJECT_SCOPE_KEY);
  const historyLegacyGroupedRaw = context.workspaceState.get(HISTORY_PROJECT_GROUPED_KEY);
  let historyProjectDisplay: ProjectDisplayMode = sanitizeProjectDisplayMode(
    historyProjectDisplayRaw,
    historyLegacyGroupedRaw,
  );
  let historyProjectScope: ProjectScopeMode = sanitizeProjectScopeMode(historyProjectScopeRaw);
  const shouldPersistHistoryProjectMigration = historyProjectDisplayRaw === undefined || historyProjectScopeRaw === undefined;
  const shouldClearHistoryProjectFilterForMigration =
    historyProjectDisplayRaw === undefined && sanitizeProjectGrouped(historyLegacyGroupedRaw) && historyProjectCwd !== null;
  if (shouldClearHistoryProjectFilterForMigration) historyProjectCwd = null;
  let historySourceFilter: SessionSourceFilter = resolveConstrainedHistorySourceFilter(
    sanitizeHistorySourceFilter(context.workspaceState.get(HISTORY_SOURCE_FILTER_KEY)),
    config,
  );
  let historyTagFilter: string[] = sanitizeTagFilter(context.workspaceState.get(HISTORY_TAG_FILTER_KEY));
  let pinnedFilter: DateScope = sanitizeDateScope(context.workspaceState.get(PINNED_FILTER_KEY));
  const pinnedSourceFilterRaw = context.workspaceState.get(PINNED_SOURCE_FILTER_KEY);
  let pinnedSourceFilter: SessionSourceFilter = resolveConstrainedHistorySourceFilter(
    sanitizeHistorySourceFilter(pinnedSourceFilterRaw === undefined ? historySourceFilter : pinnedSourceFilterRaw),
    config,
  );
  if (pinnedSourceFilterRaw === undefined) {
    try {
      await context.workspaceState.update(PINNED_SOURCE_FILTER_KEY, pinnedSourceFilter);
    } catch (error) {
      logger.debug(`pinned.sourceFilter.migration failed error=${sanitizeDebugError(error)}`);
    }
  }
  let pinnedTagFilter: string[] = sanitizeTagFilter(context.workspaceState.get(PINNED_TAG_FILTER_KEY));
  let pinnedProjectCwd: string | null = sanitizeProjectCwd(context.workspaceState.get(PINNED_PROJECT_FILTER_KEY));
  const pinnedProjectDisplayRaw = context.workspaceState.get(PINNED_PROJECT_DISPLAY_KEY);
  const pinnedProjectScopeRaw = context.workspaceState.get(PINNED_PROJECT_SCOPE_KEY);
  const pinnedLegacyGroupedRaw = context.workspaceState.get(PINNED_PROJECT_GROUPED_KEY);
  let pinnedProjectDisplay: ProjectDisplayMode = sanitizeProjectDisplayMode(
    pinnedProjectDisplayRaw,
    pinnedLegacyGroupedRaw,
  );
  let pinnedProjectScope: ProjectScopeMode = sanitizeProjectScopeMode(pinnedProjectScopeRaw);
  const shouldPersistPinnedProjectMigration = pinnedProjectDisplayRaw === undefined || pinnedProjectScopeRaw === undefined;
  const shouldClearPinnedProjectFilterForMigration =
    pinnedProjectDisplayRaw === undefined && sanitizeProjectGrouped(pinnedLegacyGroupedRaw) && pinnedProjectCwd !== null;
  if (shouldClearPinnedProjectFilterForMigration) pinnedProjectCwd = null;
  if (shouldPersistPinnedProjectMigration || shouldClearPinnedProjectFilterForMigration) {
    try {
      await context.workspaceState.update(PINNED_PROJECT_DISPLAY_KEY, pinnedProjectDisplay);
      await context.workspaceState.update(PINNED_PROJECT_SCOPE_KEY, pinnedProjectScope);
      if (shouldClearPinnedProjectFilterForMigration) await context.workspaceState.update(PINNED_PROJECT_FILTER_KEY, "");
    } catch (error) {
      logger.debug(`pinned.projectState.migration failed error=${sanitizeDebugError(error)}`);
    }
  }
  const resolveHistoryProjectGroupKey = (cwd: string): string | null =>
    projectAssociationStore.getGroupCanonicalProjectKey(cwd) ?? normalizeProjectKey(cwd);
  const historyFilterStateRaw = context.workspaceState.get<unknown>(HISTORY_FILTER_STATE_V2_KEY);
  let historyFilterStateCorrupt = false;
  let historyFilterStateToPersist: HistoryFilterStateV2 | null = null;
  let historyProjectScopeToPersist: ProjectScopeMode | null = null;
  let historyProjectSelection: ProjectSelection;
  if (historyFilterStateRaw === undefined) {
    const legacyScopeCwd = historyProjectScope === "currentGroup"
      ? resolveCurrentWorkspaceFolder()?.uri.fsPath ?? null
      : null;
    const migratedProjects = projectSelectionFromCwds(
      historyProjectCwd,
      legacyScopeCwd,
      resolveHistoryProjectGroupKey,
    );
    const restoredProjectState = restoreHistoryProjectScopeState(
      historyProjectScope,
      migratedProjects,
      resolveCurrentHistoryProjectSelection(migratedProjects),
    );
    historyProjectSelection = restoredProjectState.projects;
    if (historyProjectScope !== restoredProjectState.scope) {
      historyProjectScope = restoredProjectState.scope;
      historyProjectScopeToPersist = historyProjectScope;
    }
    historyProjectCwd = getSingleProjectSelectionCwd(historyProjectSelection);
    const migrated = createHistoryFilterStateV2({
      date: historyFilter,
      projects: historyProjectSelection,
      source: historySourceFilter,
      tags: historyTagFilter,
      archiveLocation: historySourceFilter === "claude" ? "all" : archiveLocationFilter,
    });
    historyFilterStateToPersist = migrated;
  } else {
    const parsed = parseHistoryFilterStateV2(historyFilterStateRaw);
    if (!parsed) {
      historyFilterStateCorrupt = true;
      historyFilter = { kind: "all" };
      historyProjectSelection = { kind: "none" };
      historyProjectCwd = null;
      if (historyProjectScope !== "all") historyProjectScopeToPersist = "all";
      historyProjectScope = "all";
      historySourceFilter = resolveConstrainedHistorySourceFilter("all", config);
      historyTagFilter = [];
    } else {
      historyFilter = parsed.date;
      const reconciledProjects = reconcileProjectSelection(parsed.projects, resolveHistoryProjectGroupKey);
      const restoredProjectState = restoreHistoryProjectScopeState(
        historyProjectScope,
        reconciledProjects,
        resolveCurrentHistoryProjectSelection(reconciledProjects),
      );
      historyProjectSelection = restoredProjectState.projects;
      historyProjectCwd = getSingleProjectSelectionCwd(historyProjectSelection);
      if (historyProjectScope !== restoredProjectState.scope) {
        historyProjectScope = restoredProjectState.scope;
        historyProjectScopeToPersist = historyProjectScope;
      }
      historySourceFilter = resolveConstrainedHistorySourceFilter(parsed.source, config);
      historyTagFilter = parsed.tags;
      const parsedCodexArchiveLocation = parsed.source === "claude"
        ? archiveLocationFilter
        : parsed.archiveLocation;
      const effectiveArchiveLocation = historySourceFilter === "claude"
        ? "all"
        : config.enableCodexArchivedSessions
          ? parsedCodexArchiveLocation
          : "activeOnly";
      if (historySourceFilter !== "claude") archiveLocationFilter = effectiveArchiveLocation;
      if (
        !isSameProjectSelection(historyProjectSelection, parsed.projects) ||
        historySourceFilter !== parsed.source ||
        effectiveArchiveLocation !== parsed.archiveLocation
      ) {
        historyFilterStateToPersist = createHistoryFilterStateV2({
          date: historyFilter,
          projects: historyProjectSelection,
          source: historySourceFilter,
          tags: historyTagFilter,
          archiveLocation: effectiveArchiveLocation,
        });
      }
    }
  }
  const shouldPersistArchiveLocation =
    historySourceFilter !== "claude" &&
    sanitizeArchiveLocationFilter(
      context.workspaceState.get(ARCHIVE_LOCATION_FILTER_KEY),
      context.workspaceState.get(LEGACY_SHOW_ARCHIVED_SESSIONS_KEY),
    ) !== archiveLocationFilter;
  if (
    historyFilterStateToPersist ||
    historyProjectScopeToPersist ||
    shouldPersistArchiveLocation ||
    shouldPersistHistoryProjectMigration ||
    shouldClearHistoryProjectFilterForMigration
  ) {
    try {
      await commitWorkspaceStateTransaction([
        ...(shouldPersistArchiveLocation
          ? [{ key: ARCHIVE_LOCATION_FILTER_KEY, value: archiveLocationFilter }]
          : []),
        ...(historyFilterStateToPersist
          ? [{ key: HISTORY_FILTER_STATE_V2_KEY, value: historyFilterStateToPersist }]
          : []),
        ...(shouldPersistHistoryProjectMigration
          ? [{ key: HISTORY_PROJECT_DISPLAY_KEY, value: historyProjectDisplay }]
          : []),
        ...(shouldPersistHistoryProjectMigration || historyProjectScopeToPersist
          ? [{ key: HISTORY_PROJECT_SCOPE_KEY, value: historyProjectScope }]
          : []),
        ...(shouldClearHistoryProjectFilterForMigration
          ? [{ key: HISTORY_PROJECT_FILTER_KEY, value: "" }]
          : []),
      ]);
    } catch (error) {
      logger.debug(`history.filterState.startup persist failed error=${sanitizeDebugError(error)}`);
    }
  }
  updateArchivedSessionsContext();
  if (historyFilterStateCorrupt) {
    void vscode.window.showWarningMessage(t("history.filterState.invalid"));
  }
  const pinnedProvider = new PinnedTreeDataProvider(
    historyService,
    pinStore,
    annotationStore,
    projectAliasStore,
    projectAssociationStore,
    pinnedFilter,
    pinnedSourceFilter,
    pinnedTagFilter,
    pinnedSourceFilter === "claude" ? "all" : pinnedArchiveLocationFilter,
    pinnedProjectCwd,
    resolveProjectScopeCwd(pinnedProjectScope),
    pinnedProjectDisplay === "project",
    pinnedSortMode,
    codexAgentRuns,
    sessionIconResolver,
  );
  const historyProvider = new HistoryTreeDataProvider(
    historyService,
    pinStore,
    annotationStore,
    projectAliasStore,
    projectAssociationStore,
    historyViewMode,
    historySortOrder,
    historyFilter,
    null,
    null,
    historyProjectDisplay === "project",
    historySourceFilter,
    historyTagFilter,
    historySourceFilter === "claude" ? "all" : archiveLocationFilter,
    codexAgentRuns,
    sessionIconResolver,
    historyProjectSelection,
  );
  const searchProvider = new SearchTreeDataProvider(
    pinStore,
    annotationStore,
    projectAliasStore,
    projectAssociationStore,
    codexAgentRuns,
    sessionIconResolver,
  );
  const historyInsightsPanels = new HistoryInsightsPanelManager(
    context.extensionUri,
    historyService,
    sessionAnalysisIndex,
    fileChangeHistoryPanels,
    projectAssociationStore,
    annotationStore,
    {
      waitForCurrentHistoryIndex: async (isRequestCurrent, requireAuthoritative) => {
        if (!requireAuthoritative) {
          return waitForCurrentHistorySearchIndex({
            refreshState: Object.freeze({ queue: historyRefreshQueue }),
            config: Object.freeze({ ...getConfig() }),
            historyService,
            isRequestCurrent,
          });
        }
        await initialAuthoritativeHistoryRefreshSettled.promise;
        if (!isRequestCurrent()) return null;
        const refreshState = Object.freeze({ queue: historyRefreshQueue });
        const currentConfig = Object.freeze({ ...getConfig() });
        await refreshState.queue;
        if (!isRequestCurrent() || !historyService.isCurrentIndexForConfig(currentConfig)) return null;
        const authoritativeConfig = authoritativeHistoryIndexConfig;
        const authoritativeInventoryGeneration = authoritativeHistoryInventoryGeneration;
        const currentInventoryGeneration = historyService.getIndexInventoryGeneration();
        if (
          !authoritativeConfig ||
          authoritativeInventoryGeneration === null ||
          authoritativeInventoryGeneration !== currentInventoryGeneration ||
          !historyService.isCurrentIndexForConfig(authoritativeConfig) ||
          !historyService.isCurrentIndexForConfig(currentConfig)
        ) {
          return null;
        }
        const index = historyService.getIndex();
        return Object.freeze({
          config: currentConfig,
          sessions: Object.freeze(Array.from(index.sessions)),
        });
      },
      getCurrentSnapshot: () =>
        historyProvider.createInsightsSnapshot(getDateTimeSettingsKey(resolveDateTimeSettings())),
      prepareFilters: async (snapshot, filters) => {
        const config = getConfig();
        const nextArchiveLocation = validateHistoryInsightsArchiveLocation(filters, config.enableCodexArchivedSessions);
        if (!nextArchiveLocation) return null;
        const nextTags = sanitizeTagFilter(filters.tags);
        const transition = buildHistoryInsightsFilterTransition({ ...filters, tags: nextTags }, nextArchiveLocation);
        const condition = transition.condition;
        const historyState = transition.historyState;
        const nextSnapshot = historyProvider.createInsightsSnapshot(
          getDateTimeSettingsKey(resolveDateTimeSettings()),
          condition,
        );
        return {
          snapshot: nextSnapshot,
          ...(historyState
            ? {
                commitHistory: async (): Promise<void> => {
                  await applyHistoryFilterState(historyState, {
                    persist: true,
                    rerunSearch: true,
                    projectScopePolicy: "explicitSelection",
                  });
                },
              }
            : {}),
        };
      },
      getProjectDisplayName: (projectCwd) => {
        const displayCwd = projectAssociationStore.getDisplayCwd(projectCwd) ?? projectCwd;
        return projectAliasStore.getAliasByCwd(displayCwd) ?? buildProjectLabel(displayCwd);
      },
      getCurrentProjectCwd: () => resolveCurrentWorkspaceFolder()?.uri.fsPath ?? null,
      showDayInHistory: async (snapshot, ymd) => {
        await applyHistoryFilterState({
          date: { kind: "day", ymd },
          projects: snapshot.descriptor.projects,
          source: snapshot.descriptor.source,
          tags: snapshot.descriptor.tags,
          archiveLocation: snapshot.descriptor.archiveLocation,
        }, { persist: true, rerunSearch: false, projectScopePolicy: "explicitSelection" });
        await vscode.commands.executeCommand("codexHistoryViewer.historyView.focus");
      },
      showProjectInHistory: async (snapshot, projectKey) => {
        const projectCwd = resolveInsightsProjectCwd(snapshot, projectKey, historyService.getIndex().sessions);
        if (!projectCwd) return;
        await applyHistoryFilterState({
          date: snapshot.descriptor.date,
          projects: projectSelectionFromCwds(projectCwd, null, resolveHistoryProjectGroupKey),
          source: snapshot.descriptor.source,
          tags: snapshot.descriptor.tags,
          archiveLocation: snapshot.descriptor.archiveLocation,
        }, { persist: true, rerunSearch: false, projectScopePolicy: "explicitSelection" });
        await vscode.commands.executeCommand("codexHistoryViewer.historyView.focus");
      },
      searchProject: async (snapshot, projectKey) => {
        const projectCwd = resolveInsightsProjectCwd(snapshot, projectKey, historyService.getIndex().sessions);
        if (!projectCwd) return;
        await applyHistoryFilterState({
          date: snapshot.descriptor.date,
          projects: projectSelectionFromCwds(projectCwd, null, resolveHistoryProjectGroupKey),
          source: snapshot.descriptor.source,
          tags: snapshot.descriptor.tags,
          archiveLocation: snapshot.descriptor.archiveLocation,
        }, { persist: true, rerunSearch: false, projectScopePolicy: "explicitSelection" });
        await rerunVisibleSearch();
        await vscode.commands.executeCommand("codexHistoryViewer.searchView.focus");
      },
      openSession: async (session) => {
        if (await chatPanels.revealExistingSessionPanel(session.fsPath, undefined, { promoteReusable: true })) return;
        await chatPanels.openSession(session, { kind: "session" });
      },
    },
    context.workspaceState,
    logger,
  );
  if (config.webviewRestoreAfterReload) {
    historyInsightsPanels.registerSerializer(context.subscriptions);
  }
  let lastHistoryRefreshAt: number | null = null;

  const resolveEffectiveArchiveLocationFilter = (): ArchiveLocationFilter =>
    historySourceFilter === "claude" ? "all" : archiveLocationFilter;

  const resolveEffectivePinnedArchiveLocationFilter = (): ArchiveLocationFilter =>
    pinnedSourceFilter === "claude" ? "all" : pinnedArchiveLocationFilter;

  const syncArchiveLocationFilterToProviders = (): void => {
    historyProvider.setArchiveLocationFilter(resolveEffectiveArchiveLocationFilter());
    pinnedProvider.setArchiveLocationFilter(resolveEffectivePinnedArchiveLocationFilter());
  };

  const syncProjectScopeFiltersToProviders = (): void => {
    let scopeChanged = false;
    if (!resolveCurrentWorkspaceFolder()) {
      if (pinnedProjectScope === "currentGroup") {
        pinnedProjectScope = "all";
        void context.workspaceState.update(PINNED_PROJECT_SCOPE_KEY, pinnedProjectScope);
        scopeChanged = true;
      }
    }
    historyProvider.setProjectSelection(historyProjectSelection);
    pinnedProvider.setProjectScopeFilter(resolveProjectScopeCwd(pinnedProjectScope));
    if (scopeChanged) {
      updateHistoryViewDescription();
      updatePinnedViewDescription();
    }
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

  const buildSourceFilterSummary = (sourceFilter: SessionSourceFilter = historySourceFilter): string => {
    if (sourceFilter === "all") return "";
    const sourceLabel =
      sourceFilter === "codex" ? t("history.filter.source.codex") : t("history.filter.source.claude");
    return t("history.filter.sourceLabel", sourceLabel);
  };

  const buildArchiveLocationFilterSummary = (
    value: ArchiveLocationFilter = archiveLocationFilter,
    sourceFilter: SessionSourceFilter = historySourceFilter,
  ): string => {
    if (sourceFilter === "claude") return "";
    if (value === "activeOnly") return "";
    return t("archiveLocation.summary", getArchiveLocationLabel(value));
  };

  const getProjectDisplayName = (projectCwd: string | null | undefined, maxPathLength = 60): string => {
    const displayCwd =
      typeof projectCwd === "string" && projectCwd.trim() && !projectAssociationStore.isEmpty()
        ? (projectAssociationStore.getDisplayCwd(projectCwd) ?? projectCwd)
        : projectCwd;
    const alias = projectAliasStore.getAliasByCwd(displayCwd);
    if (alias) return alias;
    return safeDisplayPath(String(displayCwd ?? ""), maxPathLength);
  };

  const getCanonicalProjectKey = (projectCwd: string): string | null =>
    projectAssociationStore.isEmpty()
      ? normalizeProjectKey(projectCwd)
      : (projectAssociationStore.getCanonicalProjectKey(projectCwd) ?? normalizeProjectKey(projectCwd));

  function resolveProjectScopeCwd(scope: ProjectScopeMode): string | null {
    if (scope !== "currentGroup") return null;
    const workspaceFolder = resolveCurrentWorkspaceFolder();
    if (!workspaceFolder) return null;
    const rawScopeCwd = resolveCurrentProjectFilterCwd(historyService.getIndex(), workspaceFolder.uri.fsPath);
    if (!rawScopeCwd || projectAssociationStore.isEmpty()) return rawScopeCwd;
    const canonicalKey = projectAssociationStore.getCanonicalProjectKey(rawScopeCwd);
    if (!canonicalKey) return rawScopeCwd;
    return (
      projectAssociationStore.getRepresentativeTargetCwd(canonicalKey) ??
      projectAssociationStore.getDisplayCwd(rawScopeCwd) ??
      rawScopeCwd
    );
  }

  function resolveCurrentHistoryProjectSelection(
    fallbackProjects?: ProjectSelection,
  ): ProjectSelection | null {
    const workspaceFolder = resolveCurrentWorkspaceFolder();
    if (!workspaceFolder) return null;
    const currentScopeCwd = resolveProjectScopeCwd("currentGroup");
    if (!currentScopeCwd) return null;
    const selection = projectSelectionFromCwds(currentScopeCwd, null, resolveHistoryProjectGroupKey);
    if (
      historyService.getIndex().sessions.length === 0 &&
      fallbackProjects?.kind === "groups" &&
      fallbackProjects.groups.length === 1
    ) {
      const fallbackCwd = fallbackProjects.groups[0]!.representativeCwd;
      const fallbackKey = normalizePathForPrefixMatch(fallbackCwd);
      const workspaceKey = normalizePathForPrefixMatch(workspaceFolder.uri.fsPath);
      if (
        fallbackKey &&
        workspaceKey &&
        (
          isSameOrDescendantPath(fallbackKey, workspaceKey) ||
          isSameOrDescendantPath(workspaceKey, fallbackKey)
        )
      ) {
        return fallbackProjects;
      }
    }
    return selection.kind === "groups" && selection.groups.length === 1 ? selection : null;
  }

  const resolveSearchHistoryProjectKeyFromCwd = (projectCwd: string | null | undefined): string => {
    const raw = typeof projectCwd === "string" ? projectCwd.trim() : "";
    if (!raw) return GLOBAL_SEARCH_HISTORY_PROJECT_KEY;
    return normalizeSearchHistoryProjectKey(getCanonicalProjectKey(raw) ?? normalizeProjectKey(raw));
  };

  const resolveSearchHistoryProjectKeyForSelection = (selection: ProjectSelection): string => {
    const selectedCwd = getSingleProjectSelectionCwd(selection);
    if (selectedCwd) return resolveSearchHistoryProjectKeyFromCwd(selectedCwd);
    if (selection.kind === "groups") return GLOBAL_SEARCH_HISTORY_PROJECT_KEY;
    const workspaceFolder = resolveCurrentWorkspaceFolder();
    if (workspaceFolder) return resolveSearchHistoryProjectKeyFromCwd(workspaceFolder.uri.fsPath);
    return GLOBAL_SEARCH_HISTORY_PROJECT_KEY;
  };
  const resolveSearchHistoryProjectKeyForSearch = (): string =>
    resolveSearchHistoryProjectKeyForSelection(historyProjectSelection);

  const buildHistoryViewStateSummary = (): string => {
    const parts: string[] = [];
    if (historyProjectDisplay === "project") parts.push(t("history.project.display.summary.project"));
    if (historyProjectScope === "currentGroup") parts.push(t("history.project.scope.summary.currentGroup"));
    return parts.join(" / ");
  };

  const buildHistoryFilterSummary = (): string => {
    const parts: string[] = [];
    const dateValue = getDateScopeValue(historyFilter);
    if (dateValue) parts.push(dateValue);
    if (historyProjectScope !== "currentGroup") {
      if (historyProjectSelection.kind === "none") {
        parts.push(t("historyInsights.filterProjectsNone"));
      } else if (historyProjectSelection.kind === "groups") {
        parts.push(historyProjectSelection.groups.length === 1
          ? t("history.filter.projectLabel", getProjectDisplayName(historyProjectSelection.groups[0]!.representativeCwd, 60))
          : t("historyInsights.filterProjectGroupCount", historyProjectSelection.groups.length));
      }
    }
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
      currentHistoryTagFilter: historyTagFilter,
      filterSummary: buildHistoryFilterSummary(),
      currentProjectCwd: resolveStatusCurrentProjectCwd(),
      currentProjectLabel: getProjectDisplayName(resolveStatusCurrentProjectCwd(), 64),
      codexSessionsRoot: cfg.sessionsRoot,
      codexArchivedSessionsRoot: cfg.codexArchivedSessionsRoot,
      claudeSessionsRoot: cfg.claudeSessionsRoot,
      lastRefreshAt: lastHistoryRefreshAt,
      extensionVersion: resolveExtensionVersion(context),
    };
  });
  // Provide a virtual document for the session transcript.
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(transcriptProvider.scheme, transcriptProvider),
    vscode.languages.registerDocumentLinkProvider(
      { scheme: transcriptProvider.scheme },
      new TranscriptDocumentLinkProvider(transcriptProvider.scheme, projectAssociationStore),
    ),
  );

  const URI_LIST_MIME = "text/uri-list";
  const PROJECT_ASSOCIATION_DND_MIME = "application/vnd.codex-history-viewer.project-association+json";
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

  type ProjectAssociationDragPayload = {
    version: 1;
    sourceCwd: string;
    sourceKind: "project" | "relatedGroup";
    sourceLabel?: string;
  };

  const resolveProjectAssociationDndTarget = (target: unknown): ProjectNode | RelatedGroupNode | null => {
    if (!(target instanceof ProjectNode || target instanceof RelatedGroupNode)) return null;
    return target.cwd ? target : null;
  };

  const buildProjectAssociationDragPayload = (
    source: readonly unknown[],
  ): ProjectAssociationDragPayload | null => {
    if (source.length !== 1) return null;
    const target = resolveProjectAssociationDndTarget(source[0]);
    if (!target?.cwd) return null;
    return {
      version: 1,
      sourceCwd: target.cwd,
      sourceKind: target instanceof RelatedGroupNode ? "relatedGroup" : "project",
      sourceLabel: target.label,
    };
  };

  const parseProjectAssociationDragPayload = async (
    dataTransfer: vscode.DataTransfer,
  ): Promise<ProjectAssociationDragPayload | null> => {
    const item = dataTransfer.get(PROJECT_ASSOCIATION_DND_MIME);
    if (!item) return null;

    let raw = "";
    try {
      raw = await item.asString();
    } catch {
      return null;
    }

    try {
      const parsed = JSON.parse(String(raw || ""));
      const sourceCwd = typeof parsed?.sourceCwd === "string" ? parsed.sourceCwd.trim() : "";
      const sourceKind =
        parsed?.sourceKind === "relatedGroup" ? "relatedGroup" : parsed?.sourceKind === "project" ? "project" : null;
      if (parsed?.version !== 1 || !sourceCwd || !sourceKind) return null;
      return {
        version: 1,
        sourceCwd,
        sourceKind,
        sourceLabel: typeof parsed.sourceLabel === "string" ? parsed.sourceLabel.trim() : undefined,
      };
    } catch {
      return null;
    }
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
    dragMimeTypes: [URI_LIST_MIME, PROJECT_ASSOCIATION_DND_MIME],
    dropMimeTypes: [PROJECT_ASSOCIATION_DND_MIME],
    handleDrag: (source, dataTransfer) => {
      const projectPayload = buildProjectAssociationDragPayload(source);
      if (projectPayload) {
        dataTransfer.set(PROJECT_ASSOCIATION_DND_MIME, new vscode.DataTransferItem(JSON.stringify(projectPayload)));
        return;
      }

      // Assume source contains all selected items when dragging with multi-selection.
      const fsPaths = collectSessionFsPaths(source);
      if (fsPaths.length === 0) return;
      dataTransfer.set(URI_LIST_MIME, new vscode.DataTransferItem(buildUriList(fsPaths)));
    },
    handleDrop: async (target, dataTransfer) => {
      const dropTarget = resolveProjectAssociationDndTarget(target);
      if (!dropTarget?.cwd) return;

      const payload = await parseProjectAssociationDragPayload(dataTransfer);
      if (!payload?.sourceCwd) return;

      const sourceCwd = payload.sourceCwd.trim();
      const targetCwd = dropTarget.cwd.trim();
      await applyProjectAssociationSet(sourceCwd, targetCwd, t("undo.label.projectAssociationSet"));
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
    historyInsightsPanels,
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
    const viewStateSummary = buildHistoryViewStateSummary();
    const filterSummary = buildHistoryFilterSummary();
    historyView.description = [
      viewStateSummary,
      filterSummary ? t("history.filter.active", filterSummary) : "",
    ].filter(Boolean).join("  ");
    void vscode.commands.executeCommand("setContext", "codexHistoryViewer.historyFiltered", filterSummary.length > 0);
    void vscode.commands.executeCommand("setContext", "codexHistoryViewer.historyTagFiltered", historyTagFilter.length > 0);
    void vscode.commands.executeCommand("setContext", "codexHistoryViewer.historyViewMode", historyViewMode);
    void vscode.commands.executeCommand("setContext", "codexHistoryViewer.historySortOrder", historySortOrder);
    void vscode.commands.executeCommand("setContext", "codexHistoryViewer.historyProjectDisplay", historyProjectDisplay);
    void vscode.commands.executeCommand("setContext", "codexHistoryViewer.historyProjectScope", historyProjectScope);
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

  const buildPinnedViewStateSummary = (): string => {
    const parts: string[] = [];
    if (pinnedProjectDisplay === "project") parts.push(t("pinned.project.display.summary.project"));
    if (pinnedProjectScope === "currentGroup") parts.push(t("pinned.project.scope.summary.currentGroup"));
    return parts.join(" / ");
  };

  const buildPinnedFilterSummary = (): string => {
    const parts: string[] = [];
    const dateValue = getDateScopeValue(pinnedFilter);
    if (dateValue) parts.push(dateValue);
    if (pinnedProjectCwd) parts.push(t("pinned.filter.projectLabel", getProjectDisplayName(pinnedProjectCwd, 60)));
    const sourceSummary = buildSourceFilterSummary(pinnedSourceFilter);
    if (sourceSummary) parts.push(sourceSummary);
    const archiveLocationSummary = buildArchiveLocationFilterSummary(pinnedArchiveLocationFilter, pinnedSourceFilter);
    if (archiveLocationSummary) parts.push(archiveLocationSummary);
    if (pinnedTagFilter.length > 0) {
      parts.push(`tags: ${pinnedTagFilter.map((tag) => `#${tag}`).join(", ")}`);
    }
    return parts.join(" / ");
  };

  const isPinnedFiltered = (): boolean =>
    !!getDateScopeValue(pinnedFilter) ||
    !!pinnedProjectCwd ||
    pinnedSourceFilter !== "all" ||
    pinnedArchiveLocationFilter !== "activeOnly" ||
    pinnedTagFilter.length > 0;

  const updatePinnedViewDescription = (): void => {
    const viewStateSummary = buildPinnedViewStateSummary();
    const filterSummary = buildPinnedFilterSummary();
    pinnedView.description = [viewStateSummary, filterSummary].filter(Boolean).join(" / ");
    void vscode.commands.executeCommand("setContext", "codexHistoryViewer.pinnedFiltered", isPinnedFiltered());
    void vscode.commands.executeCommand("setContext", "codexHistoryViewer.pinnedTagFiltered", pinnedTagFilter.length > 0);
    void vscode.commands.executeCommand("setContext", "codexHistoryViewer.pinnedProjectDisplay", pinnedProjectDisplay);
    void vscode.commands.executeCommand("setContext", "codexHistoryViewer.pinnedProjectScope", pinnedProjectScope);
    void vscode.commands.executeCommand("setContext", "codexHistoryViewer.pinnedSortMode", pinnedSortMode);
    void vscode.commands.executeCommand("setContext", "codexHistoryViewer.pinnedSourceFilter", pinnedSourceFilter);
    void vscode.commands.executeCommand("setContext", "codexHistoryViewer.pinnedSourceFiltered", pinnedSourceFilter !== "all");
    void vscode.commands.executeCommand("setContext", "codexHistoryViewer.pinnedSourceSwitchable", isHistorySourceSwitchable());
  };

  const buildSearchFilterSummary = (): string => {
    const parts: string[] = [];
    if (historyProjectScope === "currentGroup") parts.push(t("history.project.scope.summary.currentGroup"));
    const filterSummary = buildHistoryFilterSummary();
    if (filterSummary) parts.push(t("history.filter.active", filterSummary));
    return parts.join("  ");
  };

  const updateSearchViewDescription = (): void => {
    searchView.description = buildSearchFilterSummary();
  };

  const isSameTagFilter = (left: readonly string[], right: readonly string[]): boolean => {
    if (left.length !== right.length) return false;
    const rightKeys = new Set(right.map((tag) => tag.toLowerCase()));
    for (const tag of left) {
      if (!rightKeys.has(tag.toLowerCase())) return false;
    }
    return true;
  };

  const captureHistoryRevealIdentity = (): HistoryRevealIdentity | null =>
    historyProvider.createRevealIdentity(historyView.selection[0]);

  const revealHistorySelection = async (identity: HistoryRevealIdentity | null): Promise<void> => {
    if (!identity) return;
    const target = historyProvider.resolveRevealTarget(identity);
    if (!target) return;
    try {
      await historyView.reveal(target, { select: true, focus: false, expand: true });
    } catch (error) {
      logger.debug(`history.revealSelection failed error=${sanitizeDebugError(error)}`);
    }
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

  const applyPinnedFilters = async (
    next: {
      date: DateScope;
      projectCwd: string | null;
      source: SessionSourceFilter;
      tags: string[];
      archiveLocation: ArchiveLocationFilter;
    },
    opts: { persist: boolean },
  ): Promise<void> => {
    pinnedFilter = sanitizeDateScope(next.date);
    pinnedProjectCwd = sanitizeProjectCwd(next.projectCwd);
    pinnedSourceFilter = constrainHistorySourceFilter(next.source);
    pinnedTagFilter = sanitizeTagFilter(next.tags);
    pinnedArchiveLocationFilter = sanitizeArchiveLocationFilter(next.archiveLocation);
    pinnedProvider.setFilters(
      pinnedFilter,
      pinnedProjectCwd,
      resolveProjectScopeCwd(pinnedProjectScope),
      pinnedSourceFilter,
      pinnedTagFilter,
      resolveEffectivePinnedArchiveLocationFilter(),
    );
    pinnedProvider.setProjectGrouped(pinnedProjectDisplay === "project");
    pinnedProvider.refresh();
    updateArchivedSessionsContext();
    updatePinnedViewDescription();
    statusProvider.refresh();
    if (opts.persist) {
      await context.workspaceState.update(PINNED_FILTER_KEY, pinnedFilter);
      await context.workspaceState.update(PINNED_PROJECT_FILTER_KEY, pinnedProjectCwd ?? "");
      await context.workspaceState.update(PINNED_SOURCE_FILTER_KEY, pinnedSourceFilter);
      await context.workspaceState.update(PINNED_TAG_FILTER_KEY, pinnedTagFilter);
      await context.workspaceState.update(PINNED_ARCHIVE_LOCATION_FILTER_KEY, pinnedArchiveLocationFilter);
    }
  };

  const applyPinnedSourceFilter = async (nextSource: SessionSourceFilter, opts: { persist: boolean }): Promise<void> => {
    const normalized = constrainHistorySourceFilter(nextSource);
    if (pinnedSourceFilter === normalized) {
      updatePinnedViewDescription();
      return;
    }

    pinnedSourceFilter = normalized;
    pinnedProvider.setSourceFilter(pinnedSourceFilter);
    pinnedProvider.setArchiveLocationFilter(resolveEffectivePinnedArchiveLocationFilter());
    pinnedProvider.refresh();
    updateArchivedSessionsContext();
    updatePinnedViewDescription();
    statusProvider.refresh();
    if (opts.persist) {
      await context.workspaceState.update(PINNED_SOURCE_FILTER_KEY, pinnedSourceFilter);
    }
  };

  const applyPinnedProjectState = async (
    next: { projectCwd?: string | null; display?: ProjectDisplayMode; scope?: ProjectScopeMode },
    opts: { persist: boolean },
  ): Promise<void> => {
    if ("projectCwd" in next) pinnedProjectCwd = sanitizeProjectCwd(next.projectCwd);
    if (next.display) pinnedProjectDisplay = sanitizeProjectDisplayMode(next.display);
    if (next.scope) pinnedProjectScope = sanitizeProjectScopeMode(next.scope);
    pinnedProvider.setProjectFilter(pinnedProjectCwd);
    pinnedProvider.setProjectScopeFilter(resolveProjectScopeCwd(pinnedProjectScope));
    pinnedProvider.setProjectGrouped(pinnedProjectDisplay === "project");
    pinnedProvider.refresh();
    updatePinnedViewDescription();
    statusProvider.refresh();
    if (opts.persist) {
      await context.workspaceState.update(PINNED_PROJECT_FILTER_KEY, pinnedProjectCwd ?? "");
      await context.workspaceState.update(PINNED_PROJECT_DISPLAY_KEY, pinnedProjectDisplay);
      await context.workspaceState.update(PINNED_PROJECT_SCOPE_KEY, pinnedProjectScope);
    }
  };

  const applyPinnedSortMode = async (nextMode: PinnedSortMode, opts: { persist: boolean }): Promise<void> => {
    const normalized = sanitizePinnedSortMode(nextMode, getConfig().historyDateBasis);
    if (pinnedSortMode === normalized) return;

    pinnedSortMode = normalized;
    pinnedProvider.setSortMode(pinnedSortMode);
    pinnedProvider.refresh();
    updatePinnedViewDescription();
    statusProvider.refresh();
    if (opts.persist) {
      await context.workspaceState.update(PINNED_SORT_MODE_KEY, pinnedSortMode);
    }
  };

  const clearPinnedFilters = async (opts: { persist: boolean }): Promise<void> => {
    const dateFilterChanged = !!getDateScopeValue(pinnedFilter);
    const projectCwdChanged = pinnedProjectCwd !== null;
    const sourceFilterChanged = pinnedSourceFilter !== "all";
    const tagFilterChanged = pinnedTagFilter.length > 0;
    const archiveLocationChanged = pinnedArchiveLocationFilter !== "activeOnly";
    if (!dateFilterChanged && !projectCwdChanged && !sourceFilterChanged && !tagFilterChanged && !archiveLocationChanged) {
      updatePinnedViewDescription();
      return;
    }

    pinnedFilter = { kind: "all" };
    pinnedProjectCwd = null;
    pinnedSourceFilter = constrainHistorySourceFilter("all");
    pinnedTagFilter = [];
    pinnedArchiveLocationFilter = "activeOnly";

    pinnedProvider.setFilter(pinnedFilter);
    pinnedProvider.setProjectFilter(null);
    pinnedProvider.setProjectScopeFilter(resolveProjectScopeCwd(pinnedProjectScope));
    pinnedProvider.setSourceFilter(pinnedSourceFilter);
    pinnedProvider.setTagFilter(pinnedTagFilter);
    pinnedProvider.setArchiveLocationFilter(resolveEffectivePinnedArchiveLocationFilter());
    pinnedProvider.refresh();
    updateArchivedSessionsContext();
    updatePinnedViewDescription();
    statusProvider.refresh();

    if (opts.persist) {
      await context.workspaceState.update(PINNED_FILTER_KEY, pinnedFilter);
      await context.workspaceState.update(PINNED_PROJECT_FILTER_KEY, "");
      await context.workspaceState.update(PINNED_SOURCE_FILTER_KEY, pinnedSourceFilter);
      await context.workspaceState.update(PINNED_TAG_FILTER_KEY, pinnedTagFilter);
      await context.workspaceState.update(PINNED_ARCHIVE_LOCATION_FILTER_KEY, pinnedArchiveLocationFilter);
    }
  };

  const applyHistoryViewMode = async (nextMode: HistoryViewMode, opts: { persist: boolean }): Promise<void> => {
    const normalized = sanitizeHistoryViewMode(nextMode);
    if (historyViewMode === normalized) return;

    const revealIdentity = captureHistoryRevealIdentity();
    historyViewMode = normalized;
    historyProvider.setViewMode(historyViewMode);
    historyProvider.refresh();
    updateHistoryViewDescription();
    await revealHistorySelection(revealIdentity);
    if (opts.persist) {
      await context.workspaceState.update(HISTORY_VIEW_MODE_KEY, historyViewMode);
    }
  };

  const applyHistorySortOrder = async (nextOrder: HistorySortOrder, opts: { persist: boolean }): Promise<void> => {
    const normalized = sanitizeHistorySortOrder(nextOrder, getConfig().historyDateBasis);
    if (historySortOrder === normalized && historySortOrderExplicit) return;

    const revealIdentity = captureHistoryRevealIdentity();
    historySortOrder = normalized;
    historySortOrderExplicit = true;
    historyProvider.setSortOrder(historySortOrder);
    historyProvider.refresh();
    updateHistoryViewDescription();
    statusProvider.refresh();
    await revealHistorySelection(revealIdentity);
    if (opts.persist) {
      await context.workspaceState.update(HISTORY_SORT_ORDER_KEY, historySortOrder);
    }
  };

  let historyStateTransitionQueue: Promise<void> = Promise.resolve();
  let historyStateTransitionRevision = 0;
  let historyFilterSearchAbortEpoch = 0;
  const appendHistoryStateTransition = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = historyStateTransitionQueue.then(operation, operation);
    historyStateTransitionQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const enqueueHistoryStateTransition = <T>(
    operation: (rerunAbortEpoch: number) => Promise<T>,
  ): Promise<T> => {
    const rerunAbortEpoch = historyFilterSearchAbortEpoch;
    historyStateTransitionRevision += 1;
    return appendHistoryStateTransition(() => operation(rerunAbortEpoch));
  };
  let historyFilterSearchRerunRequestRevision = 0;
  let historyFilterSearchRerunHandledRevision = 0;
  let historyFilterSearchRerunScheduled = false;
  const scheduleHistoryFilterSearchRerun = (
    expectedAbortEpoch = historyFilterSearchAbortEpoch,
  ): void => {
    if (expectedAbortEpoch !== historyFilterSearchAbortEpoch) return;
    historyFilterSearchRerunRequestRevision += 1;
    if (historyFilterSearchRerunScheduled) return;
    historyFilterSearchRerunScheduled = true;

    const appendDrain = (): void => {
      const scheduledRevision = historyStateTransitionRevision;
      void appendHistoryStateTransition(async () => {
        if (scheduledRevision !== historyStateTransitionRevision) {
          appendDrain();
          return;
        }
        historyFilterSearchRerunScheduled = false;
        if (historyFilterSearchRerunHandledRevision >= historyFilterSearchRerunRequestRevision) return;
        historyFilterSearchRerunHandledRevision = historyFilterSearchRerunRequestRevision;
        void rerunVisibleSearch().catch((error) => {
          logger.debug(`history.filter search rerun failed error=${sanitizeDebugError(error)}`);
        });
      });
    };

    appendDrain();
  };

  const applyHistoryProjectState = (
    next:
      | { projectCwd?: string | null; display?: ProjectDisplayMode; scope?: ProjectScopeMode }
      | (() => { projectCwd?: string | null; display?: ProjectDisplayMode; scope?: ProjectScopeMode }),
    opts: { persist: boolean; rerunSearch?: boolean },
  ): Promise<void> => enqueueHistoryStateTransition(async (rerunAbortEpoch) => {
    const requested = typeof next === "function" ? next() : next;
    const previousProjects = historyProjectSelection;
    const previousProjectScope = historyProjectScope;
    const previousProjectDisplay = historyProjectDisplay;
    let nextProjectCwd = historyProjectCwd;
    let nextProjectSelection = historyProjectSelection;
    let nextProjectScope = historyProjectScope;
    let nextProjectDisplay = historyProjectDisplay;
    if ("projectCwd" in requested) {
      nextProjectCwd = sanitizeProjectCwd(requested.projectCwd);
      nextProjectSelection = projectSelectionFromCwds(nextProjectCwd, null, resolveHistoryProjectGroupKey);
      nextProjectScope = "all";
    }
    if (requested.display) nextProjectDisplay = sanitizeProjectDisplayMode(requested.display);
    if (requested.scope === "currentGroup") {
      const currentCwd = resolveProjectScopeCwd("currentGroup");
      if (!currentCwd) return;
      nextProjectSelection = projectSelectionFromCwds(currentCwd, null, resolveHistoryProjectGroupKey);
      nextProjectCwd = getSingleProjectSelectionCwd(nextProjectSelection);
      nextProjectScope = "currentGroup";
    } else if (
      requested.scope === "all" &&
      previousProjectScope === "currentGroup" &&
      !("projectCwd" in requested)
    ) {
      nextProjectSelection = { kind: "all" };
      nextProjectCwd = null;
      nextProjectScope = "all";
    }
    const projectsChanged = !isSameProjectSelection(previousProjects, nextProjectSelection);
    const scopeChanged = previousProjectScope !== nextProjectScope;
    const displayChanged = previousProjectDisplay !== nextProjectDisplay;
    if (!projectsChanged && !scopeChanged && !displayChanged) return;
    if (opts.persist) {
      await commitWorkspaceStateTransaction([
        ...(projectsChanged
          ? [{
              key: HISTORY_FILTER_STATE_V2_KEY,
              value: createHistoryFilterStateV2({
                date: historyFilter,
                projects: nextProjectSelection,
                source: historySourceFilter,
                tags: historyTagFilter,
                archiveLocation: resolveEffectiveArchiveLocationFilter(),
              }),
            }]
          : []),
        ...(displayChanged
          ? [{ key: HISTORY_PROJECT_DISPLAY_KEY, value: nextProjectDisplay }]
          : []),
        ...(scopeChanged
          ? [{ key: HISTORY_PROJECT_SCOPE_KEY, value: nextProjectScope }]
          : []),
      ]);
    }
    const revealIdentity = captureHistoryRevealIdentity();
    historyProjectCwd = nextProjectCwd;
    historyProjectSelection = nextProjectSelection;
    historyProjectScope = nextProjectScope;
    historyProjectDisplay = nextProjectDisplay;
    const rerunSearch =
      opts.rerunSearch !== false &&
      (projectsChanged || scopeChanged);
    if (rerunSearch) scheduleHistoryFilterSearchRerun(rerunAbortEpoch);
    await refreshCommittedHistoryFilterState(revealIdentity);
  });

  const projectCommittedHistoryFilterState = async (
    revealIdentity: HistoryRevealIdentity | null,
  ): Promise<void> => {
    historyProvider.setFilterState(
      historyFilter,
      historyProjectSelection,
      historySourceFilter,
      historyTagFilter,
      resolveEffectiveArchiveLocationFilter(),
    );
    historyProvider.setProjectGrouped(historyProjectDisplay === "project");
    syncArchiveLocationFilterToProviders();
    historyProvider.refresh();
    updateArchivedSessionsContext();
    updateHistoryViewDescription();
    updateSearchViewDescription();
    statusProvider.refresh();
    await revealHistorySelection(revealIdentity);
  };

  const refreshCommittedHistoryFilterState = async (
    revealIdentity: HistoryRevealIdentity | null,
  ): Promise<void> => {
    try {
      await projectCommittedHistoryFilterState(revealIdentity);
    } catch (error) {
      logger.debug(`history.filter refresh failed error=${sanitizeDebugError(error)}`);
      void (async () => {
        const retryAction = t("history.filterState.refreshRetry");
        const choice = await vscode.window.showWarningMessage(t("history.filterState.refreshFailed"), retryAction);
        if (choice === retryAction) {
          await projectCommittedHistoryFilterState(captureHistoryRevealIdentity());
        }
      })().catch((retryError) => {
        logger.debug(`history.filter refresh retry failed error=${sanitizeDebugError(retryError)}`);
        void vscode.window.showErrorMessage(t("history.filterState.refreshRetryFailed"));
      });
    }
  };

  const commitHistoryFilterState = async (
    state: HistoryFilterStateV2,
    nextSource: SessionSourceFilter,
    nextArchiveLocation: ArchiveLocationFilter,
    nextProjectScope: ProjectScopeMode,
  ): Promise<void> => {
    await commitWorkspaceStateTransaction([
      ...(nextSource === "claude" || archiveLocationFilter === nextArchiveLocation
        ? []
        : [{ key: ARCHIVE_LOCATION_FILTER_KEY, value: nextArchiveLocation }]),
      { key: HISTORY_FILTER_STATE_V2_KEY, value: state },
      ...(historyProjectScope === nextProjectScope
        ? []
        : [{ key: HISTORY_PROJECT_SCOPE_KEY, value: nextProjectScope }]),
    ]);
  };

  const applyHistoryFilterState = (
    next:
      | {
          date: DateScope;
          projects: ProjectSelection;
          source: SessionSourceFilter;
          tags: readonly string[];
          archiveLocation: ArchiveLocationFilter;
        }
      | (() => {
          date: DateScope;
          projects: ProjectSelection;
          source: SessionSourceFilter;
          tags: readonly string[];
          archiveLocation: ArchiveLocationFilter;
        }),
    opts: { persist: boolean; rerunSearch?: boolean; projectScopePolicy: HistoryProjectScopePolicy },
  ): Promise<boolean> => enqueueHistoryStateTransition(async (rerunAbortEpoch) => {
    const requested = typeof next === "function" ? next() : next;
    const nextDate = sanitizeDateScope(requested.date);
    const reconciledProjects = reconcileProjectSelection(requested.projects, resolveHistoryProjectGroupKey);
    const nextProjectState = resolveHistoryProjectFilterState(
      historyProjectScope,
      reconciledProjects,
      resolveCurrentHistoryProjectSelection(historyProjectSelection),
      opts.projectScopePolicy,
    );
    const nextProjects = nextProjectState.projects;
    const nextProjectScope = nextProjectState.scope;
    const nextSource = constrainHistorySourceFilter(requested.source);
    const nextTags = sanitizeTagFilter(requested.tags);
    const nextArchiveLocation = nextSource === "claude"
      ? "all"
      : getConfig().enableCodexArchivedSessions
        ? sanitizeArchiveLocationFilter(requested.archiveLocation)
        : "activeOnly";
    const changed =
      !isSameDateScope(historyFilter, nextDate) ||
      !isSameProjectSelection(historyProjectSelection, nextProjects) ||
      historyProjectScope !== nextProjectScope ||
      historySourceFilter !== nextSource ||
      !isSameTagFilter(historyTagFilter, nextTags) ||
      resolveEffectiveArchiveLocationFilter() !== nextArchiveLocation;
    const persisted = createHistoryFilterStateV2({
      date: nextDate,
      projects: nextProjects,
      source: nextSource,
      tags: nextTags,
      archiveLocation: nextArchiveLocation,
    });
    if (!changed) return false;
    if (opts.persist) {
      await commitHistoryFilterState(persisted, nextSource, nextArchiveLocation, nextProjectScope);
    }

    const revealIdentity = captureHistoryRevealIdentity();
    historyFilter = nextDate;
    historyProjectSelection = nextProjects;
    historyProjectCwd = getSingleProjectSelectionCwd(historyProjectSelection);
    historyProjectScope = nextProjectScope;
    historySourceFilter = nextSource;
    historyTagFilter = nextTags;
    if (nextSource !== "claude") archiveLocationFilter = nextArchiveLocation;
    if (opts.rerunSearch !== false) scheduleHistoryFilterSearchRerun(rerunAbortEpoch);
    await refreshCommittedHistoryFilterState(revealIdentity);
    return true;
  });

  type HistoryFilterPatch = {
    date?: DateScope;
    projects?: ProjectSelection;
    source?: SessionSourceFilter;
    tags?: readonly string[];
  };
  type CurrentHistoryFilterState = {
    date: DateScope;
    projects: ProjectSelection;
    source: SessionSourceFilter;
    tags: readonly string[];
  };

  const applyHistoryFilters = (
    next: HistoryFilterPatch | ((current: CurrentHistoryFilterState) => HistoryFilterPatch),
    opts: { persist: boolean; rerunSearch?: boolean; projectScopePolicy?: HistoryProjectScopePolicy },
  ): Promise<boolean> => {
    const projectScopePolicy = opts.projectScopePolicy ?? "preserve";
    return applyHistoryFilterState(() => {
      const current = {
        date: historyFilter,
        projects: historyProjectSelection,
        source: historySourceFilter,
        tags: historyTagFilter,
      };
      const requested = typeof next === "function" ? next(current) : next;
      const nextSource = constrainHistorySourceFilter(requested.source ?? current.source);
      const nextArchiveLocation = nextSource === "claude"
        ? "all"
        : getConfig().enableCodexArchivedSessions
          ? archiveLocationFilter
          : "activeOnly";
      return {
        date: requested.date ?? current.date,
        projects: projectScopePolicy === "explicitSelection"
          ? requested.projects ?? current.projects
          : current.projects,
        source: nextSource,
        tags: requested.tags ?? current.tags,
        archiveLocation: nextArchiveLocation,
      };
    }, {
      ...opts,
      projectScopePolicy,
    });
  };

  const resolveSourceFilterFromEnabledStates = (codexEnabled: boolean, claudeEnabled: boolean): SessionSourceFilter => {
    if (codexEnabled && claudeEnabled) return "all";
    if (codexEnabled) return "codex";
    if (claudeEnabled) return "claude";
    // Keep at least one source visible to avoid an empty-state trap.
    return "all";
  };

  const toggleHistorySource = async (source: "codex" | "claude"): Promise<void> => {
    await applyHistoryFilters((current) => {
      const codexEnabledNow = isCodexSourceEnabled(current.source);
      const claudeEnabledNow = isClaudeSourceEnabled(current.source);
      const codexEnabledNext = source === "codex" ? !codexEnabledNow : codexEnabledNow;
      const claudeEnabledNext = source === "claude" ? !claudeEnabledNow : claudeEnabledNow;
      return { source: resolveSourceFilterFromEnabledStates(codexEnabledNext, claudeEnabledNext) };
    }, { persist: true });
  };

  const cycleHistorySourceFilter = async (): Promise<void> => {
    await applyHistoryFilters((current) => ({
      source: current.source === "all" ? "codex" : current.source === "codex" ? "claude" : "all",
    }), { persist: true });
  };

  const cyclePinnedSourceFilter = async (): Promise<void> => {
    const nextSource: SessionSourceFilter =
      pinnedSourceFilter === "all" ? "codex" : pinnedSourceFilter === "codex" ? "claude" : "all";
    await applyPinnedSourceFilter(nextSource, { persist: true });
  };

  syncProjectScopeFiltersToProviders();
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

  let historyConfigurationRefreshGeneration = 0;
  let pendingHistoryConfigurationRefreshGeneration: number | null = null;
  let failedHistoryConfigurationRefreshGeneration: number | null = null;
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
      const chatTurnTimelineModeChanged = e.affectsConfiguration("codexHistoryViewer.chat.turnTimeline.mode");
      const toolDisplayModeChanged = e.affectsConfiguration("codexHistoryViewer.chat.toolDisplayMode");
      const userLongMessageFoldingChanged = e.affectsConfiguration("codexHistoryViewer.chat.userLongMessageFolding");
      const assistantLongMessageFoldingChanged = e.affectsConfiguration(
        "codexHistoryViewer.chat.assistantLongMessageFolding",
      );
      const legacyLongMessageFoldingChanged = e.affectsConfiguration("codexHistoryViewer.chat.longMessageFolding");
      const longMessageFoldingChanged =
        userLongMessageFoldingChanged || assistantLongMessageFoldingChanged || legacyLongMessageFoldingChanged;
      const imagesChanged = e.affectsConfiguration("codexHistoryViewer.images");
      const branchNavigationChanged = e.affectsConfiguration("codexHistoryViewer.branchNavigation.enabled");
      const agentRunsChanged = e.affectsConfiguration("codexHistoryViewer.agentRuns.enabled");
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
        !chatTurnTimelineModeChanged &&
        !toolDisplayModeChanged &&
        !longMessageFoldingChanged &&
        !imagesChanged &&
        !branchNavigationChanged &&
        !agentRunsChanged
      ) {
        return;
      }

      const historyIndexConfigChanged =
        sourcesEnabledChanged ||
        sessionsRootChanged ||
        historyDateBasisChanged ||
        historyTitleSourceChanged ||
        previewMaxMessagesChanged;
      const configurationRefreshGeneration = historyIndexConfigChanged
        ? ++historyConfigurationRefreshGeneration
        : historyConfigurationRefreshGeneration;
      if (historyIndexConfigChanged) {
        authoritativeHistoryIndexConfig = null;
        authoritativeHistoryInventoryGeneration = null;
        pendingHistoryConfigurationRefreshGeneration = configurationRefreshGeneration;
        failedHistoryConfigurationRefreshGeneration = null;
      }
      if (historyIndexConfigChanged) historyService.updateConfig(getConfig());
      if (historyIndexConfigChanged && getConfig().agentRunsEnabled) {
        codexAgentRuns.setPresentationEnabled(false);
        chatPanels.setCodexAgentRunsLoading(true);
        refreshViews();
        chatPanels.refreshCodexAgentRuns();
      }

      const historySourceConstraint = sourcesEnabledChanged
        ? applyHistoryFilters(
            (current) => ({ source: constrainHistorySourceFilter(current.source) }),
            { persist: true, rerunSearch: false },
          )
        : null;
      if (sourcesEnabledChanged) {
        const constrainedPinned = constrainHistorySourceFilter(pinnedSourceFilter);
        if (constrainedPinned !== pinnedSourceFilter) {
          pinnedSourceFilter = constrainedPinned;
          pinnedProvider.setSourceFilter(pinnedSourceFilter);
          syncArchiveLocationFilterToProviders();
          pinnedProvider.refresh();
          void context.workspaceState.update(PINNED_SOURCE_FILTER_KEY, pinnedSourceFilter);
        }
      }

      if (historyDateBasisChanged && !historySortOrderExplicit) {
        historySortOrder = defaultHistorySortOrder(getConfig().historyDateBasis);
        historyProvider.setSortOrder(historySortOrder);
      }

      if (uiLanguageChanged) updateUiLanguageContext();
      if (sourcesEnabledChanged || handoffEnabledChanged) updateHandoffMenuContext();
      if (sourcesEnabledChanged || sessionsRootChanged) updateArchivedSessionsContext();
      updateViewTitles();
      updatePinnedViewDescription();
      updateHistoryViewDescription();
      updateSearchViewDescription();
      void autoRefreshService?.configure(getConfig(), computeAutoRefreshConsumerVisible(), vscode.window.state.focused);
      if (uiLanguageChanged || chatTurnTimelineModeChanged || toolDisplayModeChanged || longMessageFoldingChanged || imagesChanged) chatPanels.refreshPanels();
      else chatPanels.refreshI18n();
      if (branchNavigationChanged) {
        chatPanels.refreshBranchNavigation();
      }
      if (agentRunsChanged) {
        runCodexAgentRunsConfigurationChange("configuration");
      }
      if (uiLanguageChanged || timeGuideChanged) fileChangeHistoryPanels.refreshI18n();
      if (uiLanguageChanged) {
        historyInsightsPanels.refreshI18n();
      }
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

      const normalizedHistorySourceConstraint = historySourceConstraint
        ? Promise.resolve(historySourceConstraint).catch((error) => {
            logger.debug(
              `history.configurationSourceConstraint retrying error=${sanitizeDebugError(error)}`,
            );
          })
        : undefined;
      const configurationHistoryRefresh = refreshHistoryIndex(false, normalizedHistorySourceConstraint);
      const configurationRefresh = vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: t("app.loadingHistory") },
        async () => {
          await configurationHistoryRefresh;
          if (configurationRefreshGeneration !== historyConfigurationRefreshGeneration) return;
          refreshViews({ clearSearch: true, reloadProjectAssociations: true });
          controlProvider.refresh();
          chatPanels.refreshTitles();
          failedHistoryConfigurationRefreshGeneration = null;
          pendingHistoryConfigurationRefreshGeneration = null;
        },
      );
      void configurationRefresh.then(
        () => undefined,
        (error) => {
          const isCurrent = configurationRefreshGeneration === historyConfigurationRefreshGeneration;
          logger.debug(
            `history.configurationRefresh failed current=${isCurrent ? 1 : 0} error=${sanitizeDebugError(error)}`,
          );
          if (!isCurrent) return;
          failedHistoryConfigurationRefreshGeneration = configurationRefreshGeneration;
          pendingHistoryConfigurationRefreshGeneration = null;
          settleAgentRunsAfterHistoryRefreshFailure(true);
          const notification = vscode.window.showErrorMessage(t("app.historyRefreshAfterSettingsFailed"));
          void notification.then(
            () => undefined,
            (notificationError) => {
              logger.debug(
                `history.configurationRefresh notification failed error=${sanitizeDebugError(notificationError)}`,
              );
            },
          );
        },
      );
    }),
  );

  const openReusableSessionFromElement = async (element: unknown): Promise<void> => {
    if (!isSessionNode(element)) return;
    const pageSearchSeed = resolvePageSearchSeed(element);
    const reveal = resolveRevealIndex(element, pageSearchSeed);
    if (await chatPanels.revealExistingSessionPanel(element.session.fsPath, reveal, { preserveFocus: true, pageSearchSeed })) return;
    await chatPanels.openSession(element.session, { kind: "reusable", revealMessageIndex: reveal, pageSearchSeed });
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
      void reloadProjectAssociationCacheForRefresh().then(
        () => refreshViews(),
        (error) => {
          logger.debug(`history.workspace project state refresh failed error=${sanitizeDebugError(error)}`);
          refreshViews();
        },
      );
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

  const collectOpenTargets = (
    targets: readonly unknown[],
  ): Array<{ session: SessionSummary; revealMessageIndex?: number; pageSearchSeed?: SessionPageSearchSeed }> => {
    // Deduplicate open targets by session while preserving each row's seed-derived reveal target.
    const byKey = new Map<string, { session: SessionSummary; revealMessageIndex?: number; pageSearchSeed?: SessionPageSearchSeed }>();
    for (const t of targets) {
      if (!isSessionNode(t)) continue;
      const s = t.session;
      const key = normalizeCacheKey(s.fsPath);
      if (byKey.has(key)) continue;
      const pageSearchSeed = resolvePageSearchSeed(t);
      byKey.set(key, {
        session: s,
        revealMessageIndex: resolveRevealIndex(t, pageSearchSeed),
        pageSearchSeed,
      });
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

  const isProjectKeyInside = (candidateKey: string, parentKey: string): boolean => {
    if (!candidateKey || !parentKey) return false;
    if (candidateKey === parentKey) return true;
    if (parentKey === "/" || /^[a-z]:\/$/i.test(parentKey)) return candidateKey.startsWith(parentKey);
    return candidateKey.startsWith(`${parentKey}/`);
  };

  const buildHandoffPathRewriteMappings = (
    recordedCwd: string,
    displayCwd: string,
    relocationSources: readonly ProjectAssociation[],
  ): HandoffPathRewriteContext["mappings"] => {
    const recordedKey = normalizeProjectKey(recordedCwd);
    const mappings: { sourceCwd: string; targetCwd: string }[] = [];
    const seen = new Set<string>();
    const addMapping = (sourceCwd: string, targetCwd: string): void => {
      const sourceKey = normalizeProjectKey(sourceCwd);
      const targetKey = normalizeProjectKey(targetCwd);
      if (!sourceKey || !targetKey || sourceKey === targetKey) return;
      const key = `${sourceKey}\n${targetKey}`;
      if (seen.has(key)) return;
      seen.add(key);
      mappings.push({ sourceCwd, targetCwd });
    };

    addMapping(recordedCwd, displayCwd);
    for (const entry of relocationSources) {
      const sourceKey = normalizeProjectKey(entry.sourceCwd);
      if (!isProjectKeyInside(sourceKey, recordedKey)) continue;
      addMapping(entry.sourceCwd, entry.targetCwd);
    }
    return mappings;
  };

  const buildHandoffPathRewriteContext = (session: SessionSummary): HandoffPathRewriteContext => {
    const recordedCwd = typeof session.meta.cwd === "string" ? session.meta.cwd.trim() : "";
    if (!recordedCwd) return { mode: "recorded", recordedCwd: null, displayCwd: null, mappings: [] };

    const association = projectAssociationStore.getBySourceCwd(recordedCwd);
    const displayCwd = projectAssociationStore.getDisplayCwd(recordedCwd);
    if (
      association?.mode !== "relocate" ||
      !displayCwd ||
      normalizeProjectKey(recordedCwd) === normalizeProjectKey(displayCwd)
    ) {
      return { mode: "recorded", recordedCwd, displayCwd: recordedCwd, mappings: [] };
    }

    const relocationSources = projectAssociationStore.getRelocationSourcesForTargetCwd(displayCwd);
    const mappings = buildHandoffPathRewriteMappings(recordedCwd, displayCwd, relocationSources);
    return {
      mode: "relocated",
      recordedCwd,
      displayCwd,
      mappings,
    };
  };

  const isExistingHandoffStale = async (
    metadataUri: vscode.Uri,
    pathRewrite: HandoffPathRewriteContext,
  ): Promise<boolean> => {
    const metadata = await readHandoffMetadata(metadataUri);
    return isHandoffPathRewriteStale(metadata, pathRewrite);
  };

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

  const confirmExistingHandoffReuse = async (stale: boolean): Promise<"reuse" | "recreate" | "cancel"> => {
    const reuseAction = t("handoff.action.useExistingFile");
    const recreateAction = t("handoff.action.recreateFile");
    const choice = stale
      ? await vscode.window.showWarningMessage(t("handoff.staleConfirm"), recreateAction, reuseAction)
      : await vscode.window.showInformationMessage(t("handoff.existingConfirm"), reuseAction, recreateAction);
    if (choice === reuseAction) return "reuse";
    if (choice === recreateAction) return "recreate";
    return "cancel";
  };

  const confirmStaleHandoffOpen = async (): Promise<"recreate" | "openExisting" | "cancel"> => {
    const recreateAction = t("handoff.action.recreateAndOpenFile");
    const openExistingAction = t("handoff.action.openExistingFile");
    const choice = await vscode.window.showWarningMessage(t("handoff.staleOpenConfirm"), recreateAction, openExistingAction);
    if (choice === recreateAction) return "recreate";
    if (choice === openExistingAction) return "openExisting";
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
    const pathRewrite = buildHandoffPathRewriteContext(session);

    if (await pathExists(location.handoffPath)) {
      const stale = await isExistingHandoffStale(location.metadataUri, pathRewrite);
      if (options?.existing === "reuse" && !stale) return buildExistingHandoffResult(session, target, location);
      const choice = options?.existing === "reuse" ? "recreate" : await confirmExistingHandoffReuse(stale);
      if (choice === "cancel") return null;
      if (choice === "reuse") return buildExistingHandoffResult(session, target, location);
    }

    try {
      return await createHandoff({
        globalStorageUri: context.globalStorageUri,
        session,
        target,
        sourceSessionsRoot,
        pathRewrite,
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
    const target = resolveDefaultHandoffTargetForSource(session.source);
    const pathRewrite = buildHandoffPathRewriteContext(session);
    if (!(await pathExists(location.handoffPath))) {
      const createAction = t("handoff.action.createFile");
      const choice = await vscode.window.showInformationMessage(t("handoff.sessionMissing"), createAction);
      if (choice !== createAction) return false;

      const handoff = await prepareHandoff(session, target, { existing: "reuse" });
      if (!handoff) return false;
      await refreshHandoffStorageState();
      return openHandoffDocument(handoff.handoffUri);
    }

    if (await isExistingHandoffStale(location.metadataUri, pathRewrite)) {
      const choice = await confirmStaleHandoffOpen();
      if (choice === "cancel") return false;
      if (choice === "recreate") {
        const handoff = await prepareHandoff(session, target, { existing: "reuse" });
        if (!handoff) return false;
        await refreshHandoffStorageState();
        return openHandoffDocument(handoff.handoffUri);
      }
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

  const updateHasSearchPresetsContext = (): void => {
    void vscode.commands.executeCommand("setContext", "codexHistoryViewer.hasSearchPresets", searchPresetStore.getAll().length > 0);
  };

  updateHasSearchPresetsContext();

  let cacheMaintenanceQueue: Promise<void> = Promise.resolve();
  let codexAgentRunsActivationGeneration = 0;
  let codexAgentMetadataPartialWarningShown = false;

  const activateCodexAgentRunsPresentation = (): void => {
    codexAgentRuns.setPresentationEnabled(true);
    if (!codexAgentRuns.isPresentationEnabled()) {
      throw new Error("Codex agent graph activation was superseded.");
    }
  };

  const notifyCodexAgentMetadataPartial = (failed: number): void => {
    if (failed <= 0 || codexAgentMetadataPartialWarningShown) return;
    codexAgentMetadataPartialWarningShown = true;
    void vscode.window.showWarningMessage(t("codexAgentRuns.metadataPartial"));
  };

  const hasSameCodexAgentRunsInventoryConfig = (
    left: CodexHistoryViewerConfig,
    right: CodexHistoryViewerConfig,
  ): boolean =>
    left.sessionsRoot === right.sessionsRoot &&
    left.codexArchivedSessionsRoot === right.codexArchivedSessionsRoot &&
    left.claudeSessionsRoot === right.claudeSessionsRoot &&
    left.enableCodexSource === right.enableCodexSource &&
    left.enableCodexArchivedSessions === right.enableCodexArchivedSessions &&
    left.enableClaudeSource === right.enableClaudeSource;

  const hasSameHistoryIndexConfig = (
    left: CodexHistoryViewerConfig,
    right: CodexHistoryViewerConfig,
  ): boolean =>
    hasSameCodexAgentRunsInventoryConfig(left, right) &&
    left.previewMaxMessages === right.previewMaxMessages &&
    left.historyDateBasis === right.historyDateBasis &&
    left.historyTitleSource === right.historyTitleSource;

  const ensureCodexAgentMetadataForCurrentConfig = async (
    activationGeneration: number,
    showProgress: boolean,
  ): Promise<void> => {
    if (!getConfig().agentRunsEnabled || historyService.hasCompleteCodexAgentMetadata()) return;
    const run = async (progress?: vscode.Progress<{ message?: string; increment?: number }>): Promise<void> => {
      const result = await historyService.ensureCodexAgentMetadata({
        shouldApply: () =>
          activationGeneration === codexAgentRunsActivationGeneration && getConfig().agentRunsEnabled,
        onProgress: (completed, total) => {
          if (total > 0) progress?.report({ message: `${completed} / ${total}` });
        },
      });
      if (result.cancelled) return;
      notifyCodexAgentMetadataPartial(result.failed);
    };
    if (showProgress) {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: t("codexAgentRuns.preparingMetadata") },
        run,
      );
    } else {
      await run();
    }
  };

  const handleCodexAgentRunsConfigurationChange = async (): Promise<void> => {
    const activationGeneration = ++codexAgentRunsActivationGeneration;
    const activationConfig = getConfig();
    const historyConfigurationGeneration = historyConfigurationRefreshGeneration;
    const isCurrentActivationRequest = (): boolean => {
      const currentConfig = getConfig();
      return (
        activationGeneration === codexAgentRunsActivationGeneration &&
        historyConfigurationGeneration === historyConfigurationRefreshGeneration &&
        activationConfig.agentRunsEnabled &&
        currentConfig.agentRunsEnabled &&
        hasSameCodexAgentRunsInventoryConfig(activationConfig, currentConfig)
      );
    };
    const getHistoryConfigurationRefreshState = (): "stale" | "pending" | "failed" | "ready" => {
      if (historyConfigurationGeneration !== historyConfigurationRefreshGeneration) return "stale";
      if (pendingHistoryConfigurationRefreshGeneration !== null) return "pending";
      if (failedHistoryConfigurationRefreshGeneration === historyConfigurationGeneration) return "failed";
      return "ready";
    };
    const isCurrentActivation = (): boolean =>
      isCurrentActivationRequest() && getHistoryConfigurationRefreshState() === "ready";
    historyService.updateConfig(activationConfig);
    if (!activationConfig.agentRunsEnabled) {
      codexAgentRuns.setPresentationEnabled(false);
      chatPanels.setCodexAgentRunsLoading(false);
      codexAgentRuns.invalidate();
      refreshViews();
      chatPanels.refreshCodexAgentRuns();
      return;
    }
    const initialHistoryConfigurationRefreshState = getHistoryConfigurationRefreshState();
    if (initialHistoryConfigurationRefreshState === "pending") {
      codexAgentRuns.setPresentationEnabled(false);
      chatPanels.setCodexAgentRunsLoading(true);
      refreshViews();
      chatPanels.refreshCodexAgentRuns();
      return;
    }
    if (initialHistoryConfigurationRefreshState === "stale") return;
    const requiresHistoryRefresh =
      initialHistoryConfigurationRefreshState === "failed" ||
      !historyService.isCurrentIndexForConfig(activationConfig);
    const indexReadyAtStart = !requiresHistoryRefresh;
    const requiresBackfill =
      indexReadyAtStart && !historyService.hasCompleteCodexAgentMetadata();
    let preparationFailed = false;
    try {
      if (indexReadyAtStart && !requiresBackfill) {
        activateCodexAgentRunsPresentation();
      } else {
        codexAgentRuns.setPresentationEnabled(false);
      }
      chatPanels.setCodexAgentRunsLoading(!indexReadyAtStart || requiresBackfill);
      let queued: Promise<void>;
      if (requiresHistoryRefresh) {
        queued = refreshHistoryIndex(false);
      } else {
        queued = historyRefreshQueue.then(
          () => ensureCodexAgentMetadataForCurrentConfig(activationGeneration, requiresBackfill),
          () => ensureCodexAgentMetadataForCurrentConfig(activationGeneration, requiresBackfill),
        );
        historyRefreshQueue = queued.catch(() => undefined);
      }
      await queued;
      if (
        !requiresHistoryRefresh &&
        isCurrentActivation() &&
        historyService.isCurrentIndexForConfig(activationConfig)
      ) {
        activateCodexAgentRunsPresentation();
      }
    } catch (error) {
      preparationFailed = true;
      logger.debug(`codexAgentRuns activation failed error=${sanitizeDebugError(error)}`);
      if (isCurrentActivationRequest()) {
        codexAgentRuns.setPresentationEnabled(false);
        codexAgentRuns.invalidate();
        refreshViews();
        chatPanels.handleCodexAgentRunsLoadFailure();
        void vscode.window.showErrorMessage(t("codexAgentRuns.loadFailed"));
      }
    } finally {
      if (isCurrentActivationRequest()) {
        if (preparationFailed) {
          chatPanels.setCodexAgentRunsLoading(false);
        } else if (requiresHistoryRefresh) {
          refreshViews();
          chatPanels.refreshCodexAgentRuns();
        } else if (!requiresHistoryRefresh) {
          const historyConfigurationRefreshState = getHistoryConfigurationRefreshState();
          if (historyConfigurationRefreshState === "failed") {
            codexAgentRuns.setPresentationEnabled(false);
            codexAgentRuns.invalidate();
            refreshViews();
            chatPanels.handleCodexAgentRunsLoadFailure();
            chatPanels.setCodexAgentRunsLoading(false);
          } else if (historyConfigurationRefreshState === "pending") {
            codexAgentRuns.setPresentationEnabled(false);
            chatPanels.setCodexAgentRunsLoading(true);
            refreshViews();
            chatPanels.refreshCodexAgentRuns();
          } else if (
            isCurrentActivation() &&
            historyService.isCurrentIndexForConfig(activationConfig) &&
            codexAgentRuns.isPresentationEnabled()
          ) {
            chatPanels.setCodexAgentRunsLoading(false);
            refreshViews();
            chatPanels.refreshCodexAgentRuns();
          } else {
            codexAgentRuns.setPresentationEnabled(false);
            chatPanels.setCodexAgentRunsLoading(true);
            refreshViews();
            chatPanels.refreshCodexAgentRuns();
          }
        }
      }
    }
  };
  const runCodexAgentRunsConfigurationChange = (scope: string): void => {
    void handleCodexAgentRunsConfigurationChange().then(
      () => undefined,
      (error) => {
        logger.debug(`codexAgentRuns.${scope} failed error=${sanitizeDebugError(error)}`);
        try {
          if (!getConfig().agentRunsEnabled) return;
          codexAgentRuns.setPresentationEnabled(false);
          codexAgentRuns.invalidate();
          refreshViews();
          chatPanels.handleCodexAgentRunsLoadFailure();
          chatPanels.setCodexAgentRunsLoading(false);
        } catch (settlementError) {
          logger.debug(
            `codexAgentRuns.${scope} settlement failed error=${sanitizeDebugError(settlementError)}`,
          );
        }
      },
    );
  };

  const isCurrentAgentRunsHistoryIndex = (
    config: CodexHistoryViewerConfig,
    activationGeneration: number,
  ): boolean => {
    const currentConfig = getConfig();
    return (
      config.agentRunsEnabled &&
      activationGeneration === codexAgentRunsActivationGeneration &&
      currentConfig.agentRunsEnabled &&
      hasSameCodexAgentRunsInventoryConfig(config, currentConfig) &&
      historyService.isCurrentIndexForConfig(config)
    );
  };

  const transitionAgentRunsToMatchingIndexLoading = (
    config: CodexHistoryViewerConfig,
    activationGeneration: number,
  ): boolean => {
    const currentConfig = getConfig();
    if (
      !config.agentRunsEnabled ||
      activationGeneration !== codexAgentRunsActivationGeneration ||
      !currentConfig.agentRunsEnabled ||
      (
        hasSameCodexAgentRunsInventoryConfig(config, currentConfig) &&
        historyService.isCurrentIndexForConfig(currentConfig)
      )
    ) {
      return false;
    }
    codexAgentRuns.setPresentationEnabled(false);
    chatPanels.setCodexAgentRunsLoading(true);
    refreshViews();
    chatPanels.refreshCodexAgentRuns();
    return true;
  };

  const discardStaleAgentRunsRefresh = (
    config: CodexHistoryViewerConfig,
    activationGeneration: number,
  ): void => {
    if (transitionAgentRunsToMatchingIndexLoading(config, activationGeneration)) return;
    codexAgentRuns.invalidate();
    chatPanels.refreshCodexAgentRuns();
  };

  const finalizeAdoptedHistoryIndex = async (
    config: CodexHistoryViewerConfig,
    activationGeneration: number,
    options: { refreshStorage: boolean },
  ): Promise<number> => {
    if (isCurrentAgentRunsHistoryIndex(config, activationGeneration)) {
      try {
        if (!historyService.hasCompleteCodexAgentMetadata()) {
          await ensureCodexAgentMetadataForCurrentConfig(activationGeneration, false);
        }
        if (!isCurrentAgentRunsHistoryIndex(config, activationGeneration)) {
          discardStaleAgentRunsRefresh(config, activationGeneration);
        } else {
          activateCodexAgentRunsPresentation();
          chatPanels.setCodexAgentRunsLoading(false);
          chatPanels.refreshCodexAgentRuns();
        }
      } catch (error) {
        logger.debug(`codexAgentRuns refresh activation failed error=${sanitizeDebugError(error)}`);
        codexAgentRuns.setPresentationEnabled(false);
        if (isCurrentAgentRunsHistoryIndex(config, activationGeneration)) {
          chatPanels.setCodexAgentRunsLoading(false);
          chatPanels.handleCodexAgentRunsLoadFailure();
          void vscode.window.showErrorMessage(t("codexAgentRuns.loadFailed"));
        } else {
          discardStaleAgentRunsRefresh(config, activationGeneration);
        }
      }
    } else {
      discardStaleAgentRunsRefresh(config, activationGeneration);
    }
    if (!historyService.isCurrentIndexForConfig(config)) return activationGeneration;
    const reconciledPins = await pinStore.reconcile(historyService.getIndex());
    for (const move of reconciledPins.moves) {
      await sessionReferenceRelocator.relocate(move.oldFsPath, move.newFsPath);
    }
    if (!historyService.isCurrentIndexForConfig(config)) return activationGeneration;
    await chatPanels.closeMissingPanels();
    if (!historyService.isCurrentIndexForConfig(config)) return activationGeneration;
    if (getConfig().branchNavigationEnabled) {
      chatPanels.refreshBranchNavigation();
    }
    if (options.refreshStorage) await refreshStorageStats();
    lastHistoryRefreshAt = Date.now();
    return activationGeneration;
  };

  const performHistoryIndexRefresh = async (forceRebuildCache: boolean): Promise<number> => {
    const latestConfig = getConfig();
    const agentRunsActivationGeneration = codexAgentRunsActivationGeneration;
    historyService.updateConfig(latestConfig);
    await applyHistoryFilterState(
      () => {
        const constrainedSource = resolveConstrainedHistorySourceFilter(historySourceFilter, latestConfig);
        const constrainedArchiveLocation = constrainedSource === "claude"
          ? "all"
          : latestConfig.enableCodexArchivedSessions
            ? archiveLocationFilter
            : "activeOnly";
        return {
          date: historyFilter,
          projects: historyProjectSelection,
          source: constrainedSource,
          tags: historyTagFilter,
          archiveLocation: constrainedArchiveLocation,
        };
      },
      { persist: true, rerunSearch: false, projectScopePolicy: "preserve" },
    );
    const constrainedPinnedSource = resolveConstrainedHistorySourceFilter(pinnedSourceFilter, latestConfig);
    if (constrainedPinnedSource !== pinnedSourceFilter) {
      pinnedSourceFilter = constrainedPinnedSource;
      pinnedProvider.setSourceFilter(pinnedSourceFilter);
      pinnedProvider.setArchiveLocationFilter(resolveEffectivePinnedArchiveLocationFilter());
      pinnedProvider.refresh();
      await context.workspaceState.update(PINNED_SOURCE_FILTER_KEY, pinnedSourceFilter);
    }
    if (!hasSameHistoryIndexConfig(latestConfig, getConfig())) {
      return agentRunsActivationGeneration;
    }
    try {
      await historyService.refresh({
        forceRebuildCache,
        shouldStart: () => hasSameHistoryIndexConfig(latestConfig, getConfig()),
      });
      markAuthoritativeHistoryIndex(latestConfig);
    } catch (error) {
      transitionAgentRunsToMatchingIndexLoading(latestConfig, agentRunsActivationGeneration);
      throw error;
    }
    return finalizeAdoptedHistoryIndex(latestConfig, agentRunsActivationGeneration, { refreshStorage: true });
  };
  const settleAgentRunsAfterHistoryRefreshFailure = (force = false): void => {
    const currentConfig = getConfig();
    if (
      !currentConfig.agentRunsEnabled ||
      (!force && historyService.isCurrentIndexForConfig(currentConfig))
    ) {
      return;
    }
    codexAgentRuns.setPresentationEnabled(false);
    refreshViews();
    chatPanels.handleCodexAgentRunsLoadFailure();
    chatPanels.setCodexAgentRunsLoading(false);
  };
  const performCurrentHistoryIndexRefresh = async (forceRebuildCache: boolean): Promise<void> => {
    let retryCount = 0;
    for (;;) {
      let completedAgentRunsActivationGeneration: number;
      try {
        completedAgentRunsActivationGeneration = await performHistoryIndexRefresh(forceRebuildCache);
      } catch (error) {
        if (!isHistoryOperationSupersededError(error)) {
          if (pendingHistoryConfigurationRefreshGeneration === null) {
            settleAgentRunsAfterHistoryRefreshFailure();
          }
          throw error;
        }
        retryCount += 1;
        logger.debug(`history.refresh superseded retry=${retryCount}`);
        continue;
      }
      if (
        completedAgentRunsActivationGeneration === codexAgentRunsActivationGeneration &&
        historyService.isCurrentIndexForConfig(getConfig())
      ) {
        return;
      }
      retryCount += 1;
      logger.debug(`history.refresh staleAfterCompletion retry=${retryCount}`);
    }
  };

  const enqueueHistoryOperation = <T>(
    operation: () => Promise<T>,
    onSuccess?: () => void,
  ): Promise<T> => {
    const nextOperation = historyRefreshQueue.then(operation, operation);
    const completedOperation = nextOperation.then((value) => {
      onSuccess?.();
      return value;
    });
    historyRefreshQueue = completedOperation.then(
      () => undefined,
      () => undefined,
    );
    return completedOperation;
  };

  const refreshHistoryIndex = (
    forceRebuildCache: boolean,
    preparation?: PromiseLike<unknown>,
  ): Promise<void> => {
    const refreshConfigurationGeneration = historyConfigurationRefreshGeneration;
    return enqueueHistoryOperation(
      async () => {
        if (preparation) await preparation;
        await performCurrentHistoryIndexRefresh(forceRebuildCache);
      },
      () => {
        if (refreshConfigurationGeneration === historyConfigurationRefreshGeneration) {
          failedHistoryConfigurationRefreshGeneration = null;
        }
      },
    );
  };

  const rebuildHistorySnapshot = (
    config: CodexHistoryViewerConfig,
    dateTime: DateTimeSettings,
    agentRunsActivationGeneration: number,
    start: Promise<vscode.CancellationToken | null>,
    onRebuilt?: (snapshot: HistoryRebuildSnapshot) => void,
  ): Promise<HistoryRebuildSnapshot> =>
    enqueueHistoryOperation(async () => {
      const token = await start;
      if (!token) throw new vscode.CancellationError();
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      if (hasSameHistoryIndexConfig(config, getConfig())) {
        historyService.updateConfig(config);
      }
      const snapshot = await historyService.rebuildSnapshot(config, token, dateTime);
      onRebuilt?.(snapshot);
      if (snapshot.adopted) {
        markAuthoritativeHistoryIndex(snapshot.config);
        await finalizeAdoptedHistoryIndex(
          snapshot.config,
          agentRunsActivationGeneration,
          { refreshStorage: false },
        );
      }
      return snapshot;
    });

  const enqueueCacheMaintenance = <T>(operation: () => Promise<T>): Promise<T> => {
    const nextMaintenance = cacheMaintenanceQueue.then(operation, operation);
    cacheMaintenanceQueue = nextMaintenance.then(
      () => undefined,
      () => undefined,
    );
    return nextMaintenance;
  };

  const getHistorySearchRefreshState = () => ({
    queue: historyRefreshQueue,
  });

  const captureHistorySearchStartSnapshot = (): HistorySearchStartSnapshot =>
    Object.freeze({
      config: Object.freeze({ ...getConfig() }),
      refreshState: Object.freeze(getHistorySearchRefreshState()),
    });

  const createCoordinatedCacheRebuildInventory = (
    historySnapshot: HistoryRebuildSnapshot,
  ): CoordinatedCacheRebuildInventory => {
    const searchSnapshot: HistorySearchIndexSnapshot = Object.freeze({
      config: historySnapshot.config,
      index: historySnapshot.index,
      sessions: historySnapshot.sessions,
    });
    return Object.freeze({
      searchSnapshot,
      sessions: historySnapshot.sessions,
    });
  };

  const rebuildSearchIndex = async (
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
    token?: vscode.CancellationToken,
    inventory?: CoordinatedCacheRebuildInventory,
    snapshotPromise?: Promise<HistorySearchIndexSnapshot | null>,
    options: { refreshStorage?: boolean } = {},
  ): Promise<void> => {
    const snapshot = inventory?.searchSnapshot ?? (snapshotPromise ? await snapshotPromise : null);
    if (token?.isCancellationRequested) throw new vscode.CancellationError();
    if (!snapshot) throw new Error(t("search.error.historyUnavailable"));
    await searchIndexService.ensureUpToDate({
      index: snapshot.index,
      sessionInventory: inventory?.sessions ?? snapshot.sessions,
      codexSessionsRoot: snapshot.config.sessionsRoot,
      codexArchivedSessionsRoot: snapshot.config.codexArchivedSessionsRoot,
      claudeSessionsRoot: snapshot.config.claudeSessionsRoot,
      includeCodex: snapshot.config.enableCodexSource,
      includeCodexArchived: snapshot.config.enableCodexArchivedSessions,
      includeClaude: snapshot.config.enableClaudeSource,
      indexToolContent: snapshot.config.searchIndexToolContent,
      token,
      progress,
      forceRebuild: true,
    });
    if (token?.isCancellationRequested) throw new vscode.CancellationError();
    if (options.refreshStorage !== false) await refreshStorageStats();
    if (token?.isCancellationRequested) throw new vscode.CancellationError();
    statusProvider.refresh();
  };

  const reloadProjectAssociationCacheForRefresh = (
    options: { followCurrentGroup?: boolean } = {},
  ): Promise<void> =>
    enqueueHistoryStateTransition(async () => {
      projectAssociationStore.invalidateCache();
      const reconciledProjects = reconcileProjectSelection(historyProjectSelection, resolveHistoryProjectGroupKey);
      const currentGroupProjects = resolveCurrentHistoryProjectSelection(
        options.followCurrentGroup ? undefined : reconciledProjects,
      );
      const nextProjectState = restoreHistoryProjectScopeState(
        historyProjectScope,
        reconciledProjects,
        currentGroupProjects,
        options,
      );
      const changed =
        !isSameProjectSelection(historyProjectSelection, nextProjectState.projects) ||
        historyProjectScope !== nextProjectState.scope;
      if (changed) {
        const persisted = createHistoryFilterStateV2({
          date: historyFilter,
          projects: nextProjectState.projects,
          source: historySourceFilter,
          tags: historyTagFilter,
          archiveLocation: resolveEffectiveArchiveLocationFilter(),
        });
        await commitHistoryFilterState(
          persisted,
          historySourceFilter,
          resolveEffectiveArchiveLocationFilter(),
          nextProjectState.scope,
        );
      }
      historyProjectSelection = nextProjectState.projects;
      historyProjectScope = nextProjectState.scope;
      historyProjectCwd = getSingleProjectSelectionCwd(historyProjectSelection);
      historyProvider.setProjectSelection(historyProjectSelection);
      updatePinnedViewDescription();
      updateHistoryViewDescription();
      updateSearchViewDescription();
    });

  const clearVisibleSearchResults = (): void => {
    searchProvider.clear();
    setHasSearchResultsContext(false);
  };

  const refreshViews = (options?: { clearSearch?: boolean; reloadProjectAssociations?: boolean }): void => {
    const clearSearchNow = options?.clearSearch === true && searchExecution.requestClearSearch();
    if (clearSearchNow) clearVisibleSearchResults();
    if (options?.reloadProjectAssociations) {
      void reloadProjectAssociationCacheForRefresh().then(
        () => {
          refreshViews();
          chatPanels.refreshProjectAssociations();
        },
        (error) => {
          logger.debug(`history.filterState.reconcile persist failed error=${sanitizeDebugError(error)}`);
          refreshViews();
          chatPanels.refreshProjectAssociations();
        },
      );
      return;
    }
    syncProjectScopeFiltersToProviders();
    pinnedProvider.refresh();
    historyProvider.refresh();
    if (!clearSearchNow) {
      searchProvider.refresh();
      setHasSearchResultsContext(searchProvider.root !== null);
    }
    statusProvider.refresh();
  };

  const applyArchiveLocationFilter = (
    nextArchiveLocation:
      | ArchiveLocationFilter
      | ((current: ArchiveLocationFilter) => ArchiveLocationFilter),
    options: { persist: boolean; rerunSearch: boolean },
  ): Promise<boolean> => applyHistoryFilterState(() => ({
    date: historyFilter,
    projects: historyProjectSelection,
    source: historySourceFilter,
    tags: historyTagFilter,
    archiveLocation: sanitizeArchiveLocationFilter(
      typeof nextArchiveLocation === "function"
        ? nextArchiveLocation(archiveLocationFilter)
        : nextArchiveLocation,
    ),
  }), { ...options, projectScopePolicy: "preserve" });

  const applyPinnedArchiveLocationFilter = async (
    nextArchiveLocationFilter: ArchiveLocationFilter,
    options: { persist: boolean },
  ): Promise<boolean> => {
    const nextValue = sanitizeArchiveLocationFilter(nextArchiveLocationFilter);
    if (pinnedArchiveLocationFilter === nextValue) return false;

    pinnedArchiveLocationFilter = nextValue;
    pinnedProvider.setArchiveLocationFilter(resolveEffectivePinnedArchiveLocationFilter());
    pinnedProvider.refresh();
    updateArchivedSessionsContext();
    updatePinnedViewDescription();
    statusProvider.refresh();

    if (options.persist) {
      await context.workspaceState.update(PINNED_ARCHIVE_LOCATION_FILTER_KEY, pinnedArchiveLocationFilter);
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
      await reloadProjectAssociationCacheForRefresh();
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

  const refreshAfterProjectAliasChange = (): void => {
    updatePinnedViewDescription();
    updateHistoryViewDescription();
    updateSearchViewDescription();
    refreshViews();
  };

  const captureCurrentHistorySearchScope = (): HistorySearchScopeSnapshot =>
    createHistorySearchScopeSnapshot({
      date: historyFilter,
      projects: historyProjectSelection,
      source: historySourceFilter,
      tags: historyTagFilter,
      archiveLocation: resolveEffectiveArchiveLocationFilter(),
      defaultRoleFilter: getConfiguredDefaultSearchRoles(),
      searchHistoryProjectKey: resolveSearchHistoryProjectKeyForSearch(),
    });

  const executeSearch = async (request?: SearchRequest): Promise<boolean> => {
    const searchGeneration = searchExecution.beginSearch();
    historyFilterSearchRerunHandledRevision = historyFilterSearchRerunRequestRevision;
    const isCurrentSearchGeneration = (): boolean => searchExecution.isCurrent(searchGeneration);
    const config: CodexHistoryViewerConfig = Object.freeze({ ...getConfig() });
    const refreshState = getHistorySearchRefreshState();
    const searchScope = captureCurrentHistorySearchScope();
    const getSearchCanonicalProjectKey = projectAssociationStore.createCanonicalProjectKeyResolver();
    const searchProjectDisplayNames = new Map<string, string>();
    if (searchScope.projects.kind === "groups") {
      for (const group of searchScope.projects.groups) {
        searchProjectDisplayNames.set(
          normalizeProjectKey(group.representativeCwd),
          getProjectDisplayName(group.representativeCwd, 50),
        );
      }
    }
    const getSearchProjectDisplayName = (projectCwd: string): string =>
      searchProjectDisplayNames.get(normalizeProjectKey(projectCwd)) ?? safeDisplayPath(projectCwd, 50);
    let published = false;
    try {
      const snapshot = await waitForCurrentHistorySearchIndex({
        refreshState,
        config,
        historyService,
        isRequestCurrent: isCurrentSearchGeneration,
      });
      if (!snapshot) {
        if (isCurrentSearchGeneration()) {
          void vscode.window.showErrorMessage(t("search.error.historyUnavailable"));
        }
        return false;
      }
      const results = await runSearchFlow(
        snapshot.index,
        snapshot.config,
        searchIndexService,
        annotationStore,
        searchScope.date,
        null,
        searchScope.source,
        {
          request,
          defaultRoleFilter: searchScope.defaultRoleFilter,
          tagFilter: searchScope.tags,
          archiveLocationFilter: searchScope.archiveLocation,
          projectSelection: searchScope.projects,
          getProjectDisplayName: getSearchProjectDisplayName,
          getCanonicalProjectKey: getSearchCanonicalProjectKey,
          isRequestCurrent: isCurrentSearchGeneration,
          sessionInventory: snapshot.sessions,
        },
      );
      if (!results || !isCurrentSearchGeneration()) return false;

      const savedHistory = await searchHistoryStore.save({
        projectKey: searchScope.searchHistoryProjectKey,
        queryInput: results.request.queryInput,
      });
      if (!isCurrentSearchGeneration()) return false;
      if (savedHistory) {
        chatPanels.refreshSearchHistoryCandidates();
        fileChangeHistoryPanels.refreshSearchHistoryCandidates();
      }
      await persistLastSearchRequest(results.request);
      if (!isCurrentSearchGeneration()) return false;
      searchProvider.setResults(results);
      published = true;
      setHasSearchResultsContext(true);
      statusProvider.refresh();
      await searchView.reveal(results.root, { focus: true, expand: true, select: true });
      return true;
    } finally {
      const ownedAtFinish = searchExecution.isCurrent(searchGeneration);
      const settlement = searchExecution.finishSearch(searchGeneration, published);
      if (ownedAtFinish && !published) {
        historyFilterSearchAbortEpoch += 1;
        historyFilterSearchRerunHandledRevision = historyFilterSearchRerunRequestRevision;
      }
      if (settlement.clearSearch) {
        clearVisibleSearchResults();
        statusProvider.refresh();
      }
      if (settlement.rerunAutomatically && lastSearchRequest) {
        scheduleHistoryFilterSearchRerun();
      }
    }
  };

  const rerunVisibleSearch = async (): Promise<void> => {
    if (searchExecution.requestAutomaticRerun() === "deferred") return;
    if (searchProvider.root && lastSearchRequest) {
      await executeSearch(lastSearchRequest);
      return;
    }
    searchProvider.refresh();
    setHasSearchResultsContext(searchProvider.root !== null);
  };

  type SearchHistoryQuickPickItem =
    | (vscode.QuickPickItem & { action: "manual"; queryInput: string })
    | (vscode.QuickPickItem & { action: "history"; entry: ReturnType<SearchHistoryStore["getAll"]>[number] });

  const createSearchHistoryItem = (
    entry: ReturnType<SearchHistoryStore["getAll"]>[number],
    removeButton: vscode.QuickInputButton,
  ): SearchHistoryQuickPickItem => ({
    action: "history",
    label: entry.queryInput,
    buttons: [removeButton],
    entry,
  });

  const runSearchHistoryEntry = async (entry: ReturnType<SearchHistoryStore["getAll"]>[number]): Promise<boolean> =>
    executeSearch({
      queryInput: entry.queryInput,
      roleFilter: getConfiguredDefaultSearchRoles(),
    });

  const promptSearchQuickPick = async (): Promise<void> => {
    const picked = await new Promise<SearchHistoryQuickPickItem | undefined>((resolve) => {
      const qp = vscode.window.createQuickPick<SearchHistoryQuickPickItem>();
      qp.title = t("searchHistory.quickPick.title");
      qp.placeholder = t("searchHistory.quickPick.placeholder");
      qp.matchOnDescription = true;
      qp.matchOnDetail = true;
      qp.canSelectMany = false;
      const removeButton: vscode.QuickInputButton = {
        iconPath: new vscode.ThemeIcon("trash"),
        tooltip: t("searchHistory.remove.button"),
      };

      const updateItems = (): void => {
        const query = qp.value.trim();
        const entries = searchHistoryStore.getAll(resolveSearchHistoryProjectKeyForSearch());
        const filtered = query
          ? entries.filter((entry) => entry.queryInput.toLowerCase().includes(query.toLowerCase()))
          : entries;
        const items: SearchHistoryQuickPickItem[] = [];
        if (query) {
          items.push({
            action: "manual",
            label: t("searchHistory.searchWithInput", query),
            description: t("searchHistory.manualDescription"),
            queryInput: query,
          });
        }
        items.push(...filtered.map((entry) => createSearchHistoryItem(entry, removeButton)));
        qp.items = items;
      };

      let done = false;
      const finish = (value: SearchHistoryQuickPickItem | undefined): void => {
        if (done) return;
        done = true;
        resolve(value);
        qp.dispose();
      };
      qp.onDidChangeValue(updateItems);
      qp.onDidTriggerItemButton((event) => {
        if (event.item.action !== "history") return;
        void removeSearchHistoryEntry(event.item.entry.projectKey, event.item.entry).then(updateItems);
      });
      qp.onDidAccept(() => {
        const active = qp.activeItems[0];
        if (active) {
          finish(active);
          return;
        }
        const query = qp.value.trim();
        finish(query ? { action: "manual", label: t("searchHistory.searchWithInput", query), queryInput: query } : undefined);
      });
      qp.onDidHide(() => finish(undefined));
      updateItems();
      qp.show();
    });

    if (!picked) return;
    if (picked.action === "history") {
      await runSearchHistoryEntry(picked.entry);
      return;
    }
    await executeSearch({
      queryInput: picked.queryInput,
      roleFilter: getConfiguredDefaultSearchRoles(),
    });
  };

  const removeSearchHistoryEntry = async (
    projectKey: string,
    entry: ReturnType<SearchHistoryStore["getAll"]>[number],
  ): Promise<boolean> => {
    const removed = await searchHistoryStore.remove(projectKey, entry.queryInput);
    if (removed) {
      chatPanels.refreshSearchHistoryCandidates();
      fileChangeHistoryPanels.refreshSearchHistoryCandidates();
      void vscode.window.showInformationMessage(t("searchHistory.remove.done", entry.queryInput));
    }
    return removed;
  };

  const clearSearchHistory = async (): Promise<boolean> => {
    const projectKey = resolveSearchHistoryProjectKeyForSearch();
    const entries = searchHistoryStore.getAll(projectKey);
    if (entries.length === 0) {
      void vscode.window.showInformationMessage(t("searchHistory.empty"));
      return false;
    }
    const choice = await vscode.window.showWarningMessage(
      t("searchHistory.clear.confirm", entries.length),
      { modal: true },
      t("searchHistory.clear.button"),
    );
    if (choice !== t("searchHistory.clear.button")) return false;
    await searchHistoryStore.clear(projectKey);
    chatPanels.refreshSearchHistoryCandidates();
    fileChangeHistoryPanels.refreshSearchHistoryCandidates();
    void vscode.window.showInformationMessage(t("searchHistory.clear.done"));
    return true;
  };

  const applyProjectAssociationConsumers = (rerunAbortEpoch: number): void => {
    updatePinnedViewDescription();
    updateHistoryViewDescription();
    updateSearchViewDescription();
    refreshViews();
    statusProvider.refresh();
    chatPanels.refreshProjectAssociations();
    fileChangeHistoryPanels.notifySettingsChanged("association");
    scheduleHistoryFilterSearchRerun(rerunAbortEpoch);
  };

  const refreshProjectAssociationConsumers = async (rerunAbortEpoch: number): Promise<void> => {
    try {
      applyProjectAssociationConsumers(rerunAbortEpoch);
    } catch (error) {
      logger.debug(
        `projectAssociation.consumer refresh failed error=${sanitizeDebugError(error)}`,
      );
      void (async () => {
        const retryAction = t("history.filterState.refreshRetry");
        const choice = await vscode.window.showWarningMessage(
          t("history.filterState.refreshFailed"),
          retryAction,
        );
        if (choice !== retryAction) return;
        try {
          applyProjectAssociationConsumers(rerunAbortEpoch);
        } catch (retryError) {
          logger.debug(
            `projectAssociation.consumer refresh retry failed error=${sanitizeDebugError(retryError)}`,
          );
          void vscode.window.showErrorMessage(t("history.filterState.refreshRetryFailed"));
        }
      })().catch((notificationError) => {
        logger.debug(
          `projectAssociation.consumer refresh notification failed error=${sanitizeDebugError(notificationError)}`,
        );
      });
    }
  };

  const refreshAfterProjectAssociationChange = async (
    rollbackSnapshot?: readonly ProjectAssociation[],
  ): Promise<void> => {
    const rerunAbortEpoch = historyFilterSearchAbortEpoch;
    try {
      await reloadProjectAssociationCacheForRefresh({ followCurrentGroup: true });
    } catch (error) {
      if (!rollbackSnapshot) throw error;
      try {
        await projectAssociationStore.restoreSnapshot(rollbackSnapshot);
        await reloadProjectAssociationCacheForRefresh({ followCurrentGroup: true });
      } catch (rollbackError) {
        logger.debug(
          `projectAssociation.filterState rollback failed error=${sanitizeDebugError(rollbackError)}`,
        );
        void vscode.window.showErrorMessage(t("projectAssociation.filterStateRollbackFailed"));
        throw error;
      }
      await refreshProjectAssociationConsumers(rerunAbortEpoch);
      void vscode.window.showErrorMessage(t("projectAssociation.filterStateSaveFailed"));
      throw error;
    }
    await refreshProjectAssociationConsumers(rerunAbortEpoch);
  };

  const restoreProjectAssociationsAndRefresh = async (
    snapshot: readonly ProjectAssociation[],
  ): Promise<void> => {
    const rollbackSnapshot = projectAssociationStore.getAll();
    await projectAssociationStore.restoreSnapshot(snapshot);
    await refreshAfterProjectAssociationChange(rollbackSnapshot);
  };

  const removeSearchPreset = async (preset: SearchPreset): Promise<boolean> => {
    const deleted = await searchPresetStore.delete(preset.id);
    if (!deleted) return false;
    updateHasSearchPresetsContext();
    statusProvider.refresh();
    void vscode.window.showInformationMessage(t("savedSearches.deleted", preset.queryInput));
    return true;
  };

  type SearchPresetQuickPickItem = vscode.QuickPickItem & { preset: SearchPreset };

  const promptSearchPresetQuickPick = async (): Promise<void> => {
    const presets = searchPresetStore.getAll();
    if (presets.length === 0) {
      void vscode.window.showInformationMessage(t("savedSearches.noPresets"));
      return;
    }

    const picked = await new Promise<SearchPresetQuickPickItem | undefined>((resolve) => {
      const qp = vscode.window.createQuickPick<SearchPresetQuickPickItem>();
      qp.title = t("savedSearches.run.title");
      qp.canSelectMany = false;
      const deleteButton: vscode.QuickInputButton = {
        iconPath: new vscode.ThemeIcon("trash"),
        tooltip: t("savedSearches.delete.tooltip"),
      };

      const updateItems = (): void => {
        const query = qp.value.trim().toLowerCase();
        const nextPresets = searchPresetStore.getAll();
        qp.items = nextPresets
          .filter((preset) => !query || preset.queryInput.toLowerCase().includes(query))
          .map((preset) => ({
            label: preset.queryInput,
            buttons: [deleteButton],
            preset,
          }));
      };

      let done = false;
      const finish = (value: SearchPresetQuickPickItem | undefined): void => {
        if (done) return;
        done = true;
        resolve(value);
        qp.dispose();
      };

      qp.onDidChangeValue(updateItems);
      qp.onDidTriggerItemButton((event) => {
        void removeSearchPreset(event.item.preset).then(() => {
          updateItems();
          if (searchPresetStore.getAll().length === 0) finish(undefined);
        });
      });
      qp.onDidAccept(() => finish(qp.activeItems[0]));
      qp.onDidHide(() => finish(undefined));
      updateItems();
      qp.show();
    });

    if (!picked) return;
    await runSearchPresetById(picked.preset.id);
  };

  const runSearchPresetById = async (presetId: string): Promise<boolean> => {
    const id = presetId.trim();
    if (!id) return false;
    const preset = searchPresetStore.getAll().find((x) => x.id === id);
    if (!preset) {
      void vscode.window.showErrorMessage(t("app.searchPresetNotFound"));
      return false;
    }
    return executeSearch({
      queryInput: preset.queryInput,
      roleFilter: getConfiguredDefaultSearchRoles(),
    });
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
    refreshViews({ clearSearch: true, reloadProjectAssociations: true });
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
    refreshViews({ clearSearch: true, reloadProjectAssociations: true });
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
      refreshViews({ clearSearch: true, reloadProjectAssociations: true });
      controlProvider.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.refreshPinned", async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: t("app.loadingPinned") },
        async () => refreshHistoryIndex(false),
      );
      await reloadProjectAssociationCacheForRefresh();
      syncProjectScopeFiltersToProviders();
      pinnedProvider.refresh();
      statusProvider.refresh();
      chatPanels.refreshProjectAssociations();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.togglePinnedSortMode", async () => {
      await applyPinnedSortMode(nextPinnedSortMode(pinnedSortMode), { persist: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.refreshHistoryPane", async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: t("app.loadingHistoryPane") },
        async () => refreshHistoryIndex(false),
      );
      await reloadProjectAssociationCacheForRefresh();
      syncProjectScopeFiltersToProviders();
      historyProvider.refresh();
      statusProvider.refresh();
      chatPanels.refreshProjectAssociations();
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
    vscode.commands.registerCommand("codexHistoryViewer.toggleHistoryViewMode", async () => {
      await applyHistoryViewMode(historyViewMode === "latest" ? "date" : "latest", { persist: true });
    }),
  );

  const registerHistorySortCommand = (commandId: string, sortOrder: HistorySortOrder): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(commandId, async () => {
        await applyHistorySortOrder(sortOrder, { persist: true });
      }),
    );
  };

  registerHistorySortCommand("codexHistoryViewer.setHistorySortCreatedDesc", "createdDesc");
  registerHistorySortCommand("codexHistoryViewer.setHistorySortCreatedAsc", "createdAsc");
  registerHistorySortCommand("codexHistoryViewer.setHistorySortLastActivityDesc", "lastActivityDesc");
  registerHistorySortCommand("codexHistoryViewer.setHistorySortLastActivityAsc", "lastActivityAsc");
  registerHistorySortCommand("codexHistoryViewer.setHistorySortTitleAsc", "titleAsc");
  registerHistorySortCommand("codexHistoryViewer.setHistorySortTitleDesc", "titleDesc");

  const registerPinnedSortCommand = (commandId: string, sortMode: PinnedSortMode): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(commandId, async () => {
        await applyPinnedSortMode(sortMode, { persist: true });
      }),
    );
  };

  registerPinnedSortCommand("codexHistoryViewer.setPinnedSortPinnedAtDesc", "pinnedAtDesc");
  registerPinnedSortCommand("codexHistoryViewer.setPinnedSortPinnedAtAsc", "pinnedAtAsc");
  registerPinnedSortCommand("codexHistoryViewer.setPinnedSortCreatedDesc", "createdDesc");
  registerPinnedSortCommand("codexHistoryViewer.setPinnedSortCreatedAsc", "createdAsc");
  registerPinnedSortCommand("codexHistoryViewer.setPinnedSortLastActivityDesc", "lastActivityDesc");
  registerPinnedSortCommand("codexHistoryViewer.setPinnedSortLastActivityAsc", "lastActivityAsc");
  registerPinnedSortCommand("codexHistoryViewer.setPinnedSortTitleAsc", "titleAsc");
  registerPinnedSortCommand("codexHistoryViewer.setPinnedSortTitleDesc", "titleDesc");

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.refreshStatusPane", async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: t("app.loadingStatus") },
        async () => refreshHistoryIndex(false),
      );
      await reloadProjectAssociationCacheForRefresh();
      statusProvider.refresh();
      chatPanels.refreshProjectAssociations();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.filterArchiveLocation", async () => {
      return applyArchiveLocationFilter((current) => nextArchiveLocationFilter(current), {
        persist: true,
        rerunSearch: true,
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.filterPinnedArchiveLocation", async () => {
      if (pinnedSourceFilter === "claude") return false;
      await applyPinnedArchiveLocationFilter(nextArchiveLocationFilter(pinnedArchiveLocationFilter), { persist: true });
      return true;
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.toggleArchivedSessionsVisibility", async () => {
      await applyArchiveLocationFilter(
        (current) => current === "activeOnly" ? "all" : "activeOnly",
        { persist: true, rerunSearch: true },
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.rebuildCache", async () => {
      const action = t("app.rebuildCacheAction");
      const choice = await vscode.window.showWarningMessage(
        t("app.rebuildCacheConfirm"),
        { modal: true },
        action,
      );
      if (choice !== action) return;

      const rebuildConfig: CodexHistoryViewerConfig = Object.freeze({ ...getConfig() });
      const rebuildDateTime: DateTimeSettings = Object.freeze({ ...resolveDateTimeSettings() });
      const rebuildAgentRunsActivationGeneration = codexAgentRunsActivationGeneration;
      const historyRebuildState: {
        rebuilt: boolean;
        adoptedConfig: CodexHistoryViewerConfig | null;
      } = {
        rebuilt: false,
        adoptedConfig: null,
      };
      const historyStart = createDeferred<vscode.CancellationToken | null>();
      const historySnapshotPromise = rebuildHistorySnapshot(
        rebuildConfig,
        rebuildDateTime,
        rebuildAgentRunsActivationGeneration,
        historyStart.promise,
        (snapshot) => {
          historyRebuildState.rebuilt = true;
          historyRebuildState.adoptedConfig = snapshot.adopted ? snapshot.config : null;
        },
      );
      const maintenanceStart = createDeferred<CacheMaintenanceProgressContext | null>();
      let outcome: "success" | "cancelled" | "failed" = "success";
      const maintenancePromise = enqueueCacheMaintenance(async () => {
        const progressContext = await maintenanceStart.promise;
        if (!progressContext) {
          historyStart.resolve(null);
          await historySnapshotPromise.catch(() => undefined);
          return;
        }
        const { progress, token } = progressContext;
        historyStart.resolve(token);
        const historySnapshot = await historySnapshotPromise;
        if (token.isCancellationRequested) throw new vscode.CancellationError();
        const inventory = createCoordinatedCacheRebuildInventory(historySnapshot);
        await rebuildSearchIndex(
          progress,
          token,
          inventory,
          undefined,
          { refreshStorage: false },
        );
        if (token.isCancellationRequested) throw new vscode.CancellationError();
        if (!SESSION_ANALYSIS_FEATURES_ENABLED) return;
        await sessionAnalysisIndex.rebuildAll({
          sessions: inventory.sessions,
          activeSessions: inventory.sessions,
          config: inventory.searchSnapshot.config,
          token,
          onProgress: (value) => {
            progress.report({ message: t(`analysis.progress.${value.phase}`) });
          },
        });
        if (token.isCancellationRequested) {
          throw new vscode.CancellationError();
        }
      });
      let progressStarted = false;
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: t("app.rebuildingCache"),
            cancellable: true,
          },
          async (progress, token) => {
            progressStarted = true;
            maintenanceStart.resolve(Object.freeze({ progress, token }));
            return maintenancePromise;
          },
        );
      } catch (error) {
        if (!progressStarted) {
          historyStart.resolve(null);
          maintenanceStart.resolve(null);
        }
        if (error instanceof vscode.CancellationError || error instanceof SessionAnalysisCancelledError) {
          outcome = "cancelled";
        } else {
          outcome = "failed";
          logger.debug(`cache rebuild failed error=${sanitizeDebugError(error)}`);
        }
      } finally {
        if (historyRebuildState.rebuilt) {
          try {
            await refreshStorageStats();
          } catch (error) {
            logger.debug(`cache rebuild storage refresh failed error=${sanitizeDebugError(error)}`);
          }
          if (
            historyRebuildState.adoptedConfig &&
            historyService.isCurrentIndexForConfig(historyRebuildState.adoptedConfig)
          ) {
            refreshViews({ clearSearch: true, reloadProjectAssociations: true });
          } else {
            statusProvider.refresh();
          }
          controlProvider.refresh();
        }
      }
      if (outcome === "success") {
        if (
          historyRebuildState.adoptedConfig &&
          historyService.isCurrentIndexForConfig(historyRebuildState.adoptedConfig)
        ) {
          if (SESSION_ANALYSIS_FEATURES_ENABLED) {
            historyInsightsPanels.refreshAnalysis();
          }
          chatPanels.invalidateBranchNavigation();
        }
        void vscode.window.showInformationMessage(t("app.rebuildCacheDone"));
      } else if (outcome === "cancelled") {
        void vscode.window.showInformationMessage(t("app.rebuildCacheCancelled"));
      } else {
        void vscode.window.showErrorMessage(t("app.rebuildCacheFailed"));
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.rebuildSearchIndex", async () => {
      const startSnapshot = captureHistorySearchStartSnapshot();
      const snapshotPromise = waitForCurrentHistorySearchIndex({
        refreshState: startSnapshot.refreshState,
        config: startSnapshot.config,
        historyService,
        isRequestCurrent: () => true,
      });
      const maintenanceStart = createDeferred<CacheMaintenanceProgressContext | null>();
      const maintenancePromise = enqueueCacheMaintenance(async () => {
        const progressContext = await maintenanceStart.promise;
        if (!progressContext) return;
        const { progress, token } = progressContext;
        await rebuildSearchIndex(progress, token, undefined, snapshotPromise);
      });
      let progressStarted = false;
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t("app.rebuildingSearchIndex"), cancellable: true },
          async (progress, token) => {
            progressStarted = true;
            maintenanceStart.resolve(Object.freeze({ progress, token }));
            return maintenancePromise;
          },
        );
      } catch (error) {
        if (!progressStarted) maintenanceStart.resolve(null);
        throw error;
      }
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
    vscode.commands.registerCommand("codexHistoryViewer.showHistoryInsights", async () => {
      if (!SESSION_ANALYSIS_FEATURES_ENABLED) {
        void vscode.window.showInformationMessage(t("analysis.featureDisabled"));
        return;
      }
      const snapshot = historyProvider.createInsightsSnapshot(getDateTimeSettingsKey(resolveDateTimeSettings()));
      await historyInsightsPanels.open(snapshot);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.openCodexAgentParent", async (element?: unknown) => {
      if (!getConfig().agentRunsEnabled) {
        void vscode.window.showInformationMessage(t("codexAgentRuns.disabled"));
        return;
      }
      const session = isSessionNode(element)
        ? element.session
        : resolveSessionFromElementOrFsPath(historyService, element);
      if (!session || session.source !== "codex") return;
      await chatPanels.openCodexAgentParent(session);
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
        const pageSearchSeed = resolvePageSearchSeed(elementOrArgs);
        if (await chatPanels.revealExistingSessionPanel(session.fsPath, reveal, { promoteReusable: true, pageSearchSeed })) {
          return;
        }
        await chatPanels.openSession(session, { kind: "session", revealMessageIndex: reveal, pageSearchSeed });
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
              pageSearchSeed: it.pageSearchSeed,
            })
          ) {
            continue;
          }
          await chatPanels.openSession(it.session, {
            kind: "session",
            revealMessageIndex: it.revealMessageIndex,
            pageSearchSeed: it.pageSearchSeed,
          });
        }
        return;
      }

      if (openTargets.length === 1) {
        const it = openTargets[0]!;
        if (
          await chatPanels.revealExistingSessionPanel(it.session.fsPath, it.revealMessageIndex, {
            promoteReusable: true,
            pageSearchSeed: it.pageSearchSeed,
          })
        ) {
          return;
        }
        await chatPanels.openSession(it.session, {
          kind: "session",
          revealMessageIndex: it.revealMessageIndex,
          pageSearchSeed: it.pageSearchSeed,
        });
        return;
      }

      const session = resolveSessionFromElementOrActive(historyService, transcriptProvider.scheme, elementOrArgs);
      if (!session) return;
      const pageSearchSeed = resolvePageSearchSeed(elementOrArgs);
      const reveal = resolveRevealIndex(elementOrArgs, pageSearchSeed);
      if (await chatPanels.revealExistingSessionPanel(session.fsPath, reveal, { promoteReusable: true, pageSearchSeed })) {
        return;
      }
      await chatPanels.openSession(session, { kind: "session", revealMessageIndex: reveal, pageSearchSeed });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.openSessionMarkdown", async (elementOrArgs?: unknown) => {
      // Switching from the session Webview passes args (fsPath), so do not prefer bulk-selection handling.
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
      const pageSearchSeed = resolvePageSearchSeed(elementOrArgs);
      const reveal = resolveRevealIndex(elementOrArgs, pageSearchSeed);
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
      await promptSearchQuickPick();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.searchRerun", async () => {
      if (lastSearchRequest) {
        await executeSearch(lastSearchRequest);
        return;
      }
      await promptSearchQuickPick();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.searchClearResults", async () => {
      if (!searchProvider.root) return;
      clearVisibleSearchResults();
      statusProvider.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.searchFilterByTag", async (tagArg?: unknown) => {
      const singleTag = typeof tagArg === "string" ? tagArg.trim() : "";
      const applySearchTagShortcut = async (
        nextTags: readonly string[] | ((currentTags: readonly string[]) => readonly string[]),
      ): Promise<void> => {
        const hadVisibleSearch = !!searchProvider.root;
        const changed = await applyHistoryFilters((current) => ({
          tags: sanitizeTagFilter(
            typeof nextTags === "function" ? nextTags(current.tags) : nextTags,
          ),
        }), { persist: true });
        if (!changed) return;
        if (!hadVisibleSearch) {
          void vscode.window.showInformationMessage(t("search.tagFilter.deferred"));
        }
      };

      if (singleTag) {
        await applySearchTagShortcut((currentTags) => {
          const normalizedCurrent = sanitizeTagFilter(currentTags);
          const isSameSingle =
            normalizedCurrent.length === 1 &&
            normalizedCurrent[0]!.toLowerCase() === singleTag.toLowerCase();
          return isSameSingle ? [] : [singleTag];
        });
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

      await applySearchTagShortcut(picked.map((x) => x.tag));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.clearSearchTagFilter", async () => {
      const hadVisibleSearch = !!searchProvider.root;
      const changed = await applyHistoryFilters({ tags: [] }, { persist: true });
      if (changed && !hadVisibleSearch) {
        void vscode.window.showInformationMessage(t("search.tagFilter.deferred"));
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.filterPinned", async () => {
      const idx = historyService.getIndex();
      const change = await promptHistoryFilter(idx, {
        date: pinnedFilter,
        projectCwd: pinnedProjectCwd,
        source: pinnedSourceFilter,
        sourceOptions: getHistorySourceOptionsForPrompt(),
        archiveLocation: pinnedArchiveLocationFilter,
        tags: pinnedTagFilter,
        availableTags: annotationStore.listTagStats().map((x) => x.tag),
        getProjectDisplayName: (projectCwd) => getProjectDisplayName(projectCwd, 80),
        getCanonicalProjectKey,
        placeholder: t("pinned.filter.placeholder"),
        allDateLabel: t("pinned.filter.all"),
      });
      if (!change) return;
      const next = {
        date: change.kind === "date" ? change.date : pinnedFilter,
        projectCwd: change.kind === "project" ? change.projectCwd : pinnedProjectCwd,
        source: change.kind === "source" ? change.source : pinnedSourceFilter,
        archiveLocation: change.kind === "archiveLocation" ? change.archiveLocation : pinnedArchiveLocationFilter,
        tags: change.kind === "tags" ? change.tags : pinnedTagFilter,
      };
      await applyPinnedFilters(next, { persist: true });
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
    vscode.commands.registerCommand("codexHistoryViewer.clearPinnedFilter", async () => {
      await clearPinnedFilters({ persist: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.filterPinnedCurrentProject", async () => {
      const workspaceFolder = resolveCurrentWorkspaceFolder();
      if (!workspaceFolder) {
        void vscode.window.showInformationMessage(t("pinned.project.scope.noWorkspace"));
        await applyPinnedProjectState({ scope: "all" }, { persist: true });
        return;
      }

      await applyPinnedProjectState(
        { display: "list", scope: pinnedProjectScope === "currentGroup" ? "all" : "currentGroup" },
        { persist: true },
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.showPinnedProjectGrouped", async () => {
      if (pinnedProjectDisplay === "project" && pinnedProjectScope === "all") return;
      await applyPinnedProjectState({ display: "project", scope: "all" }, { persist: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.clearPinnedProjectMode", async () => {
      if (pinnedProjectDisplay === "list" && pinnedProjectScope === "all" && !pinnedProjectCwd) return;
      await applyPinnedProjectState({ projectCwd: null, display: "list", scope: "all" }, { persist: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.togglePinnedProjectDisplay", async () => {
      await applyPinnedProjectState(
        { display: pinnedProjectDisplay === "project" ? "list" : "project" },
        { persist: true },
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.togglePinnedProjectScope", async () => {
      if (pinnedProjectScope === "currentGroup") {
        await applyPinnedProjectState({ scope: "all" }, { persist: true });
        return;
      }
      if (!resolveCurrentWorkspaceFolder()) {
        void vscode.window.showInformationMessage(t("pinned.project.scope.noWorkspace"));
        return;
      }
      await applyPinnedProjectState({ scope: "currentGroup" }, { persist: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.searchRunRecent", async () => {
      await promptSearchQuickPick();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.searchManageHistory", async () => {
      await promptSearchQuickPick();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.searchClearHistory", async () => {
      await clearSearchHistory();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.searchRunPreset", async () => {
      await promptSearchPresetQuickPick();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.searchSavePreset", async () => {
      if (!lastSearchRequest || !searchProvider.root) {
        void vscode.window.showInformationMessage(t("savedSearches.noRequestToSave"));
        return;
      }

      const saved = await searchPresetStore.save({ queryInput: lastSearchRequest.queryInput });
      updateHasSearchPresetsContext();
      statusProvider.refresh();
      void vscode.window.showInformationMessage(t("savedSearches.saved", saved.queryInput));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.searchDeletePreset", async () => {
      await promptSearchPresetQuickPick();
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
      refreshViews({ clearSearch: true, reloadProjectAssociations: true });
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

      const confirmMessage = t("trash.deleteConfirm");
      const choice = await vscode.window.showWarningMessage(confirmMessage, { modal: true }, "OK");
      if (choice !== "OK") return;

      const result = await emptyTrashAndCleanupLegacy(context.globalStorageUri);
      await refreshStorageStats();
      statusProvider.refresh();

      if (result.failedPaths.length > 0) {
        void vscode.window.showWarningMessage(
          t("trash.cleanupPartialFailed", result.failedPaths.length),
        );
        return;
      }

      void vscode.window.showInformationMessage(
        t("trash.removed"),
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
        refreshViews({ clearSearch: true, reloadProjectAssociations: true });
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

  type ProjectTreeTarget = ProjectNode | RelatedGroupNode;

  const resolveProjectAliasTarget = (element?: unknown): ProjectTreeTarget | null => {
    // Project alias commands require an explicit tree target to avoid guessing the wrong workspace.
    return (element instanceof ProjectNode || element instanceof RelatedGroupNode) && element.cwd ? element : null;
  };

  const clearProjectAliasForProject = async (project: ProjectTreeTarget): Promise<boolean> => {
    const cwd = project.cwd;
    if (!cwd) {
      void vscode.window.showInformationMessage(t("projectAlias.noProjectSelected"));
      return false;
    }

    const previous = projectAliasStore.getByCwd(cwd);
    const changed = await projectAliasStore.clearByCwd(cwd);
    if (!changed) {
      void vscode.window.showInformationMessage(t("projectAlias.noChanges"));
      return false;
    }

    refreshAfterProjectAliasChange();
    logger.debug(
      formatDebugFields("projectAlias clear done", {
        project: safeDebugBasename(cwd),
        hadAlias: !!previous?.alias,
      }),
    );
    if (previous?.alias) {
      pushUndoAction(
        t("undo.label.projectAliasClear"),
        async () => {
          await projectAliasStore.set(cwd, previous.alias);
          refreshAfterProjectAliasChange();
        },
        undefined,
        { postUndoRefresh: "none" },
      );
      offerUndo(t("projectAlias.cleared"));
    } else {
      void vscode.window.showInformationMessage(t("projectAlias.cleared"));
    }
    return true;
  };

  const setProjectAliasForProject = async (project: ProjectTreeTarget): Promise<boolean> => {
    const cwd = project.cwd;
    if (!cwd) {
      void vscode.window.showInformationMessage(t("projectAlias.noProjectSelected"));
      return false;
    }

    const currentAlias = normalizeProjectAlias(projectAliasStore.getAliasByCwd(cwd) ?? "");
    const fallbackLabel = normalizeProjectAlias(project.fallbackLabel || project.label);
    const input = await vscode.window.showInputBox({
      title: t("projectAlias.input.title"),
      prompt: t("projectAlias.input.prompt"),
      value: currentAlias || fallbackLabel,
      validateInput: (value) => {
        const normalized = normalizeProjectAlias(value);
        return isProjectAliasTooLong(normalized)
          ? t("projectAlias.error.tooLong", getMaxProjectAliasLength())
          : undefined;
      },
    });
    if (input === undefined) return false;

    const nextAlias = normalizeProjectAlias(input);
    if (isProjectAliasTooLong(nextAlias)) {
      void vscode.window.showErrorMessage(t("projectAlias.error.tooLong", getMaxProjectAliasLength()));
      return false;
    }

    if (!nextAlias || (fallbackLabel && nextAlias === fallbackLabel)) {
      return clearProjectAliasForProject(project);
    }
    if (currentAlias === nextAlias) {
      void vscode.window.showInformationMessage(t("projectAlias.noChanges"));
      return false;
    }

    await projectAliasStore.set(cwd, nextAlias);
    refreshAfterProjectAliasChange();
    logger.debug(
      formatDebugFields("projectAlias set done", {
        project: safeDebugBasename(cwd),
        hadAlias: !!currentAlias,
        length: nextAlias.length,
      }),
    );
    pushUndoAction(
      t("undo.label.projectAliasSet"),
      async () => {
        if (currentAlias) await projectAliasStore.set(cwd, currentAlias);
        else await projectAliasStore.clearByCwd(cwd);
        refreshAfterProjectAliasChange();
      },
      undefined,
      { postUndoRefresh: "none" },
    );
    offerUndo(t("projectAlias.saved"));
    return true;
  };

  const manageProjectAliasForProject = async (project: ProjectTreeTarget): Promise<boolean> => {
    const items: Array<vscode.QuickPickItem & { action: "set" | "clear" }> = [
      {
        label: t("projectAlias.action.set"),
        action: "set",
      },
    ];
    if (projectAliasStore.getAliasByCwd(project.cwd)) {
      items.push({
        label: t("projectAlias.action.clear"),
        description: t("projectAlias.action.clear.description"),
        action: "clear",
      });
    }

    const picked = await vscode.window.showQuickPick(items, {
      title: t("projectAlias.manage.title"),
      placeHolder: t("projectAlias.manage.placeholder"),
    });
    if (!picked) return false;
    return picked.action === "clear" ? clearProjectAliasForProject(project) : setProjectAliasForProject(project);
  };

  const resolveProjectAssociationTarget = (element?: unknown): ProjectTreeTarget | null => {
    return (element instanceof ProjectNode || element instanceof RelatedGroupNode) && element.cwd ? element : null;
  };

  const getProjectAssociationSessionCounts = (cwds: readonly string[]): { active: number; archived: number; total: number } => {
    const keys = new Set(cwds.map((cwd) => normalizeProjectKey(cwd)).filter((key) => key.length > 0));
    let active = 0;
    let archived = 0;
    for (const session of historyService.getIndex().sessions) {
      const cwd = typeof session.meta?.cwd === "string" ? session.meta.cwd.trim() : "";
      if (!cwd || !keys.has(normalizeProjectKey(cwd))) continue;
      if (session.storage.archiveState === "archived") archived += 1;
      else active += 1;
    }
    return { active, archived, total: active + archived };
  };

  const formatProjectAssociationModeLabel = (mode: ProjectAssociationMode): string => {
    return mode === "groupOnly" ? t("projectAssociation.mode.groupOnly") : t("projectAssociation.mode.relocate");
  };

  const formatProjectAssociationModeDescription = (mode: ProjectAssociationMode): string => {
    return mode === "groupOnly"
      ? t("projectAssociation.mode.groupOnly.description")
      : t("projectAssociation.mode.relocate.description");
  };

  const formatProjectAssociationModeNote = (mode: ProjectAssociationMode): string => {
    return mode === "groupOnly"
      ? t("projectAssociation.confirm.associateGroupOnlyNote")
      : t("projectAssociation.confirm.associateRelocateNote");
  };

  const pickProjectAssociationMode = async (
    defaultMode: ProjectAssociationMode = "relocate",
  ): Promise<ProjectAssociationMode | null> => {
    const items: Array<vscode.QuickPickItem & { mode: ProjectAssociationMode }> = ([
      "relocate",
      "groupOnly",
    ] as ProjectAssociationMode[]).map((mode) => ({
      label: formatProjectAssociationModeLabel(mode),
      description: formatProjectAssociationModeDescription(mode),
      picked: mode === defaultMode,
      mode,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: t("projectAssociation.mode.title"),
      placeHolder: t("projectAssociation.mode.title"),
      matchOnDescription: true,
    });
    return picked?.mode ?? null;
  };

  const getImpactedAssociationSourceCwds = (sourceCwd: string): string[] => {
    const sourceKey = normalizeProjectKey(sourceCwd);
    const byKey = new Map<string, string>();
    if (sourceKey) byKey.set(sourceKey, sourceCwd);
    if (!sourceKey) return Array.from(byKey.values()).sort((a, b) => a.localeCompare(b));

    for (const association of projectAssociationStore.getDescendantSourcesForSourceCwd(sourceCwd)) {
      byKey.set(association.sourceKey, association.sourceCwd);
    }
    return Array.from(byKey.values()).sort((a, b) => a.localeCompare(b));
  };

  const showProjectAssociationPreflightMessage = (result: Exclude<ProjectAssociationSetPreflight, "ok">): void => {
    if (result === "invalid") {
      void vscode.window.showInformationMessage(t("projectAssociation.noProjectSelected"));
      return;
    }
    if (result === "circular") {
      void vscode.window.showInformationMessage(t("projectAssociation.error.circular"));
      return;
    }
    if (result === "sameGroup") {
      void vscode.window.showInformationMessage(t("projectAssociation.error.sameGroup"));
      return;
    }
    if (result === "sameTarget") {
      void vscode.window.showInformationMessage(t("projectAssociation.error.sameTarget"));
      return;
    }
    void vscode.window.showInformationMessage(t("projectAssociation.noChanges"));
  };

  const showProjectAssociationModeChangePreflightMessage = (
    result: Exclude<ProjectAssociationModeChangePreflight, "ok">,
  ): void => {
    if (result === "invalid") {
      void vscode.window.showInformationMessage(t("projectAssociation.noProjectSelected"));
      return;
    }
    if (result === "noAssociation") {
      void vscode.window.showInformationMessage(t("projectAssociation.error.noAssociation"));
      return;
    }
    void vscode.window.showInformationMessage(t("projectAssociation.noChanges"));
  };

  const formatAssociationCountDetail = (cwds: readonly string[]): string => {
    const counts = getProjectAssociationSessionCounts(cwds);
    return t("projectAssociation.sessionCountBreakdown", counts.total, counts.active, counts.archived);
  };

  const formatCwdListPreview = (cwds: readonly string[]): string => {
    const max = 5;
    const shown = cwds.slice(0, max);
    const lines = shown.map((cwd) => `- ${cwd}`);
    if (cwds.length > max) lines.push(t("projectAssociation.tooltip.moreSources", cwds.length - max));
    return lines.join("\n");
  };

  const confirmProjectAssociation = async (
    sourceCwd: string,
    targetCwd: string,
    mode: ProjectAssociationMode,
  ): Promise<boolean> => {
    const impacted = getImpactedAssociationSourceCwds(sourceCwd);
    const countDetail = formatAssociationCountDetail(impacted);
    const sourcePreview = formatCwdListPreview(impacted);
    const message = t(
      "projectAssociation.confirm.associate",
      sourceCwd,
      targetCwd,
      formatProjectAssociationModeLabel(mode),
      countDetail,
      sourcePreview,
      formatProjectAssociationModeNote(mode),
    );
    const confirm = t("projectAssociation.button.associate");
    const picked = await vscode.window.showWarningMessage(message, { modal: true }, confirm);
    return picked === confirm;
  };

  const confirmProjectAssociationModeChange = async (
    association: ProjectAssociation,
    mode: ProjectAssociationMode,
  ): Promise<boolean> => {
    const impacted = getImpactedAssociationSourceCwds(association.sourceCwd);
    const countDetail = formatAssociationCountDetail(impacted);
    const sourcePreview = formatCwdListPreview(impacted);
    const message = t(
      "projectAssociation.confirm.changeMode",
      association.sourceCwd,
      association.targetCwd,
      formatProjectAssociationModeLabel(association.mode),
      formatProjectAssociationModeLabel(mode),
      countDetail,
      sourcePreview,
      formatProjectAssociationModeNote(mode),
    );
    const confirm = t("projectAssociation.button.changeMode");
    const picked = await vscode.window.showWarningMessage(message, { modal: true }, confirm);
    return picked === confirm;
  };

  const applyProjectAssociationSet = async (
    sourceCwd: string,
    targetCwd: string,
    undoLabel: string,
    defaultMode: ProjectAssociationMode = "relocate",
  ): Promise<boolean> => {
    const preflight = projectAssociationStore.evaluateSet(sourceCwd, targetCwd);
    if (preflight !== "ok") {
      showProjectAssociationPreflightMessage(preflight);
      return false;
    }
    const mode = await pickProjectAssociationMode(defaultMode);
    if (!mode) return false;
    if (!(await confirmProjectAssociation(sourceCwd, targetCwd, mode))) return false;

    const before = projectAssociationStore.getAll();
    const changed = await projectAssociationStore.set(sourceCwd, targetCwd, mode);
    if (!changed) {
      void vscode.window.showInformationMessage(t("projectAssociation.noChanges"));
      return false;
    }
    await refreshAfterProjectAssociationChange(before);
    pushUndoAction(
      undoLabel,
      async () => {
        await restoreProjectAssociationsAndRefresh(before);
      },
      undefined,
      { postUndoRefresh: "none" },
    );
    offerUndo(t("projectAssociation.saved"));
    return true;
  };

  const pickWorkspaceFolderForProjectAssociation = async (): Promise<string | null> => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      void vscode.window.showInformationMessage(t("projectAssociation.noWorkspace"));
      return null;
    }
    if (folders.length === 1) return folders[0]!.uri.fsPath;

    const active = resolveCurrentWorkspaceFolder();
    const items = folders
      .map((folder) => ({
        label: folder.name,
        description: folder.uri.fsPath,
        fsPath: folder.uri.fsPath,
        picked: active?.uri.fsPath === folder.uri.fsPath,
      }))
      .sort((a, b) => Number(b.picked) - Number(a.picked) || a.label.localeCompare(b.label));
    const picked = await vscode.window.showQuickPick(items, {
      title: t("projectAssociation.workspace.title"),
      placeHolder: t("projectAssociation.workspace.placeholder"),
    });
    return picked?.fsPath ?? null;
  };

  const buildProjectAssociationCandidates = (excludeCwds: readonly string[]): Array<vscode.QuickPickItem & { cwd: string }> => {
    const excludedKeys = new Set(excludeCwds.map((cwd) => getCanonicalProjectKey(cwd)).filter((key): key is string => !!key));
    const byKey = new Map<string, { cwd: string; count: number; latest: string }>();
    for (const session of historyService.getIndex().sessions) {
      const cwd = typeof session.meta?.cwd === "string" ? session.meta.cwd.trim() : "";
      if (!cwd) continue;
      const key = getCanonicalProjectKey(cwd) ?? normalizeProjectKey(cwd);
      if (!key || excludedKeys.has(key)) continue;
      const displayCwd = projectAssociationStore.getRepresentativeTargetCwd(key) ?? projectAssociationStore.getDisplayCwd(cwd) ?? cwd;
      const existing = byKey.get(key);
      if (existing) {
        existing.count += 1;
        if (normalizeProjectKey(displayCwd) === key) existing.cwd = displayCwd;
        continue;
      }
      byKey.set(key, { cwd: displayCwd, count: 1, latest: `${session.localDate} ${session.timeLabel}` });
    }
    return Array.from(byKey.values())
      .sort((a, b) => (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : a.cwd.localeCompare(b.cwd)))
      .map((entry) => ({
        label: getProjectDisplayName(entry.cwd, 80),
        description: t("projectAssociation.candidate.description", entry.count),
        detail: entry.cwd,
        cwd: entry.cwd,
      }));
  };

  const buildProjectAssociationProjectItems = (): Array<vscode.QuickPickItem & { project: ProjectNode }> => {
    const byKey = new Map<string, { cwd: string; count: number; latest: string }>();
    for (const session of historyService.getIndex().sessions) {
      const cwd = typeof session.meta?.cwd === "string" ? session.meta.cwd.trim() : "";
      if (!cwd) continue;
      const key = getCanonicalProjectKey(cwd) ?? normalizeProjectKey(cwd);
      if (!key) continue;
      const displayCwd = projectAssociationStore.getRepresentativeTargetCwd(key) ?? projectAssociationStore.getDisplayCwd(cwd) ?? cwd;
      const existing = byKey.get(key);
      if (existing) {
        existing.count += 1;
        if (normalizeProjectKey(displayCwd) === key) existing.cwd = displayCwd;
        continue;
      }
      byKey.set(key, { cwd: displayCwd, count: 1, latest: `${session.localDate} ${session.timeLabel}` });
    }

    for (const association of projectAssociationStore.getAll()) {
      const key = getCanonicalProjectKey(association.targetCwd) ?? association.targetKey;
      if (!key || byKey.has(key)) continue;
      const displayCwd = projectAssociationStore.getDisplayCwd(association.targetCwd) ?? association.targetCwd;
      byKey.set(key, { cwd: displayCwd, count: 0, latest: "" });
    }

    return Array.from(byKey.entries())
      .sort(([, a], [, b]) => (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : a.cwd.localeCompare(b.cwd)))
      .map(([key, entry]) => {
        const alias = projectAliasStore.getAliasByCwd(entry.cwd) ?? null;
        const label = getProjectDisplayName(entry.cwd, 80);
        const project = new ProjectNode({
          key,
          label,
          cwd: entry.cwd,
          alias,
          fallbackLabel: label,
          sessionCount: entry.count,
          latestLabel: entry.latest,
          description: t("projectAssociation.candidate.description", entry.count),
        });
        return {
          label,
          description: t("projectAssociation.candidate.description", entry.count),
          detail: entry.cwd,
          project,
        };
      });
  };

  const pickProjectAssociationProject = async (): Promise<ProjectNode | null> => {
    const items = buildProjectAssociationProjectItems();
    if (items.length === 0) {
      void vscode.window.showInformationMessage(t("projectAssociation.noCandidates"));
      return null;
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: t("projectAssociation.pickProject.title"),
      placeHolder: t("projectAssociation.pickProject.placeholder"),
      matchOnDescription: true,
      matchOnDetail: true,
    });
    return picked?.project ?? null;
  };

  const associateProjectToWorkspace = async (project: ProjectTreeTarget): Promise<boolean> => {
    const sourceCwd = project.cwd;
    if (!sourceCwd) {
      void vscode.window.showInformationMessage(t("projectAssociation.noProjectSelected"));
      return false;
    }
    const targetCwd = await pickWorkspaceFolderForProjectAssociation();
    if (!targetCwd) return false;
    return applyProjectAssociationSet(sourceCwd, targetCwd, t("undo.label.projectAssociationSet"));
  };

  const associateProjectToAnotherProject = async (sourceCwd: string, targetHint?: string): Promise<boolean> => {
    const candidates = buildProjectAssociationCandidates([sourceCwd]);
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage(t("projectAssociation.noCandidates"));
      return false;
    }
    const picked = await vscode.window.showQuickPick(candidates, {
      title: targetHint ? t("projectAssociation.pickSource.title") : t("projectAssociation.pickTarget.title"),
      placeHolder: targetHint
        ? t("projectAssociation.pickSource.placeholder", targetHint)
        : t("projectAssociation.pickTarget.placeholder"),
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) return false;
    return targetHint
      ? applyProjectAssociationSet(picked.cwd, sourceCwd, t("undo.label.projectAssociationSet"))
      : applyProjectAssociationSet(sourceCwd, picked.cwd, t("undo.label.projectAssociationSet"));
  };

  const clearProjectAssociationForProject = async (project: ProjectTreeTarget): Promise<boolean> => {
    const parentAssociation = project.parentAssociation;
    if (parentAssociation) {
      const before = projectAssociationStore.getAll();
      const detached = getImpactedAssociationSourceCwds(parentAssociation.sourceCwd);
      const confirm = t("projectAssociation.button.clear");
      const message = t(
        "projectAssociation.confirm.clear",
        parentAssociation.sourceCwd,
        parentAssociation.targetCwd,
        formatAssociationCountDetail(detached),
        detached.length,
      );
      if ((await vscode.window.showWarningMessage(message, { modal: true }, confirm)) !== confirm) return false;
      if (!(await projectAssociationStore.removeBySourceCwd(parentAssociation.sourceCwd))) return false;
      await refreshAfterProjectAssociationChange(before);
      pushUndoAction(
        t("undo.label.projectAssociationClear"),
        async () => {
          await restoreProjectAssociationsAndRefresh(before);
        },
        undefined,
        { postUndoRefresh: "none" },
      );
      offerUndo(t("projectAssociation.cleared"));
      return true;
    }

    const targetCwd = project.cwd;
    if (!targetCwd) {
      void vscode.window.showInformationMessage(t("projectAssociation.noProjectSelected"));
      return false;
    }
    const sources = projectAssociationStore.getDirectSourcesForTargetCwd(targetCwd);
    if (sources.length === 0) {
      void vscode.window.showInformationMessage(t("projectAssociation.noChanges"));
      return false;
    }

    const allItem = {
      label: t("projectAssociation.action.clearAll"),
      description: t("projectAssociation.clearAll.description", sources.length),
      source: null as ProjectAssociation | null,
    };
    const sourceItems = sources.map((source) => ({
      label: source.sourceCwd,
      description: `${formatProjectAssociationModeLabel(source.mode)} - ${formatAssociationCountDetail(getImpactedAssociationSourceCwds(source.sourceCwd))}`,
      source,
    }));
    const picked = await vscode.window.showQuickPick([allItem, ...sourceItems], {
      title: t("projectAssociation.clear.title"),
      placeHolder: t("projectAssociation.clear.placeholder"),
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) return false;

    const before = projectAssociationStore.getAll();
    if (picked.source) {
      const confirm = t("projectAssociation.button.clear");
      const detached = getImpactedAssociationSourceCwds(picked.source.sourceCwd);
      const message = t(
        "projectAssociation.confirm.clear",
        picked.source.sourceCwd,
        targetCwd,
        formatAssociationCountDetail(detached),
        detached.length,
      );
      if ((await vscode.window.showWarningMessage(message, { modal: true }, confirm)) !== confirm) return false;
      if (!(await projectAssociationStore.removeBySourceCwd(picked.source.sourceCwd))) return false;
    } else {
      const confirm = t("projectAssociation.button.clear");
      const message = t("projectAssociation.confirm.clearAll", targetCwd, sources.length);
      if ((await vscode.window.showWarningMessage(message, { modal: true }, confirm)) !== confirm) return false;
      await projectAssociationStore.removeDirectSourcesForTargetCwd(targetCwd);
    }
    await refreshAfterProjectAssociationChange(before);
    pushUndoAction(
      picked.source
        ? t("undo.label.projectAssociationClear")
        : t("undo.label.projectAssociationClearAll"),
      async () => {
        await restoreProjectAssociationsAndRefresh(before);
      },
      undefined,
      { postUndoRefresh: "none" },
    );
    offerUndo(t("projectAssociation.cleared"));
    return true;
  };

  const showProjectAssociationsForProject = async (project: ProjectTreeTarget): Promise<boolean> => {
    const directSources = projectAssociationStore.getDirectSourcesForTargetCwd(project.cwd);
    const subtreeSources = projectAssociationStore.getSourcesForTargetCwd(project.cwd);
    if (directSources.length === 0 && subtreeSources.length === 0) {
      void vscode.window.showInformationMessage(t("projectAssociation.noChanges"));
      return false;
    }
    const directKeys = new Set(directSources.map((source) => source.sourceKey));
    const nestedSources = subtreeSources.filter((source) => !directKeys.has(source.sourceKey));
    const lines = [t("projectAssociation.show.directHeader")];
    if (directSources.length === 0) lines.push(t("projectAssociation.show.none"));
    else lines.push(...directSources.map((source) => `${source.sourceCwd} (${formatProjectAssociationModeLabel(source.mode)})`));
    if (nestedSources.length > 0) {
      lines.push("", t("projectAssociation.show.subtreeHeader"));
      lines.push(...nestedSources.map((source) => `${source.sourceCwd} (${formatProjectAssociationModeLabel(source.mode)})`));
    }
    void vscode.window.showInformationMessage(
      t("projectAssociation.show.message", project.cwd ?? "", subtreeSources.length, lines.join("\n")),
    );
    return true;
  };

  const pickDirectAssociationSource = async (
    targetCwd: string,
    title: string,
    placeHolder: string,
  ): Promise<ProjectAssociation | null> => {
    const sources = projectAssociationStore.getDirectSourcesForTargetCwd(targetCwd);
    if (sources.length === 0) return null;
    if (sources.length === 1) return sources[0] ?? null;

    const items = sources.map((source) => ({
      label: source.sourceCwd,
      description: formatProjectAssociationModeLabel(source.mode),
      detail: formatAssociationCountDetail(getImpactedAssociationSourceCwds(source.sourceCwd)),
      source,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title,
      placeHolder,
      matchOnDescription: true,
      matchOnDetail: true,
    });
    return picked?.source ?? null;
  };

  const changeProjectAssociationModeForProject = async (project: ProjectTreeTarget): Promise<boolean> => {
    let association: ProjectAssociation | null = null;
    if (project.parentAssociation) {
      association = projectAssociationStore.getBySourceCwd(project.parentAssociation.sourceCwd);
    } else if (project.cwd) {
      association = await pickDirectAssociationSource(
        project.cwd,
        t("projectAssociation.changeMode.title"),
        t("projectAssociation.changeMode.placeholder"),
      );
    }

    if (!association) {
      void vscode.window.showInformationMessage(t("projectAssociation.error.noAssociation"));
      return false;
    }

    const defaultMode: ProjectAssociationMode = association.mode === "relocate" ? "groupOnly" : "relocate";
    const mode = await pickProjectAssociationMode(defaultMode);
    if (!mode) return false;

    const preflight = projectAssociationStore.evaluateModeChange(association.sourceCwd, mode);
    if (preflight !== "ok") {
      showProjectAssociationModeChangePreflightMessage(preflight);
      return false;
    }
    if (!(await confirmProjectAssociationModeChange(association, mode))) return false;

    const before = projectAssociationStore.getAll();
    const changed = await projectAssociationStore.changeMode(association.sourceCwd, mode);
    if (!changed) {
      void vscode.window.showInformationMessage(t("projectAssociation.noChanges"));
      return false;
    }
    await refreshAfterProjectAssociationChange(before);
    pushUndoAction(
      t("undo.label.projectAssociationChangeMode"),
      async () => {
        await restoreProjectAssociationsAndRefresh(before);
      },
      undefined,
      { postUndoRefresh: "none" },
    );
    offerUndo(t("projectAssociation.saved"));
    return true;
  };

  const changeProjectAssociationTarget = async (project: ProjectTreeTarget): Promise<boolean> => {
    const sourceCwd = project.cwd;
    if (!sourceCwd) {
      void vscode.window.showInformationMessage(t("projectAssociation.noProjectSelected"));
      return false;
    }
    const candidates: Array<vscode.QuickPickItem & { action: "project"; cwd: string }> = buildProjectAssociationCandidates([
      sourceCwd,
    ]).map((item) => ({ ...item, action: "project" as const }));
    const workspaceItems: Array<vscode.QuickPickItem & { action: "workspace"; cwd: null }> =
      (vscode.workspace.workspaceFolders?.length ?? 0) > 0
        ? [{ label: t("projectAssociation.action.associateToWorkspace"), action: "workspace" as const, cwd: null }]
        : [];
    if (candidates.length === 0 && workspaceItems.length === 0) {
      void vscode.window.showInformationMessage(t("projectAssociation.noCandidates"));
      return false;
    }
    const picked = await vscode.window.showQuickPick([...workspaceItems, ...candidates], {
      title: t("projectAssociation.pickTarget.title"),
      placeHolder: t("projectAssociation.pickTarget.placeholder"),
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) return false;
    if (picked.action === "workspace") {
      const targetCwd = await pickWorkspaceFolderForProjectAssociation();
      if (!targetCwd) return false;
      return applyProjectAssociationSet(sourceCwd, targetCwd, t("undo.label.projectAssociationChangeTarget"));
    }
    return applyProjectAssociationSet(sourceCwd, picked.cwd, t("undo.label.projectAssociationChangeTarget"));
  };

  const manageProjectAssociationForProject = async (project: ProjectTreeTarget): Promise<boolean> => {
    if (!project.cwd) {
      void vscode.window.showInformationMessage(t("projectAssociation.noProjectSelected"));
      return false;
    }
    const directSources = projectAssociationStore.getDirectSourcesForTargetCwd(project.cwd);
    const hasModeChangeTargets = !!project.parentAssociation || directSources.length > 0;
    const hasSources = hasModeChangeTargets || projectAssociationStore.getSourcesForTargetCwd(project.cwd).length > 0;
    const items: Array<vscode.QuickPickItem & { action: "workspace" | "target" | "add" | "mode" | "clear" | "show" | "change" }> = hasSources
      ? [
          { label: t("projectAssociation.action.add"), action: "add" },
          ...(hasModeChangeTargets ? [{ label: t("projectAssociation.action.changeMode"), action: "mode" as const }] : []),
          { label: t("projectAssociation.action.clear"), action: "clear" },
          { label: t("projectAssociation.action.show"), action: "show" },
          { label: t("projectAssociation.action.changeTarget"), action: "change" },
        ]
      : [
          { label: t("projectAssociation.action.associateToWorkspace"), action: "workspace" },
          { label: t("projectAssociation.action.associateToProject"), action: "target" },
        ];

    const picked = await vscode.window.showQuickPick(items, {
      title: t("projectAssociation.manage.title"),
      placeHolder: t("projectAssociation.manage.placeholder"),
    });
    if (!picked) return false;
    switch (picked.action) {
      case "workspace":
        return associateProjectToWorkspace(project);
      case "target":
        return associateProjectToAnotherProject(project.cwd);
      case "add":
        return associateProjectToAnotherProject(project.cwd, project.cwd);
      case "mode":
        return changeProjectAssociationModeForProject(project);
      case "clear":
        return clearProjectAssociationForProject(project);
      case "show":
        return showProjectAssociationsForProject(project);
      case "change":
        return changeProjectAssociationTarget(project);
      default:
        return false;
    }
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
    vscode.commands.registerCommand("codexHistoryViewer.setProjectAlias", async (element?: unknown) => {
      const project = resolveProjectAliasTarget(element);
      if (!project) {
        void vscode.window.showInformationMessage(t("projectAlias.noProjectSelected"));
        return false;
      }
      return setProjectAliasForProject(project);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.clearProjectAlias", async (element?: unknown) => {
      const project = resolveProjectAliasTarget(element);
      if (!project) {
        void vscode.window.showInformationMessage(t("projectAlias.noProjectSelected"));
        return false;
      }
      return clearProjectAliasForProject(project);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.manageProjectAlias", async (element?: unknown) => {
      const project = resolveProjectAliasTarget(element);
      if (!project) {
        void vscode.window.showInformationMessage(t("projectAlias.noProjectSelected"));
        return false;
      }
      return manageProjectAliasForProject(project);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.manageProjectAssociation", async (element?: unknown) => {
      const project = resolveProjectAssociationTarget(element) ?? (await pickProjectAssociationProject());
      if (!project) {
        return false;
      }
      return manageProjectAssociationForProject(project);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.clearProjectAssociation", async (element?: unknown) => {
      const project = resolveProjectAssociationTarget(element) ?? (await pickProjectAssociationProject());
      if (!project) {
        return false;
      }
      return clearProjectAssociationForProject(project);
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
        projectSelection: historyProjectSelection,
        source: historySourceFilter,
        sourceOptions: getHistorySourceOptionsForPrompt(),
        archiveLocation: resolveEffectiveArchiveLocationFilter(),
        tags: historyTagFilter,
        availableTags: annotationStore.listTagStats().map((x) => x.tag),
        getProjectDisplayName: (projectCwd) => getProjectDisplayName(projectCwd, 80),
        getCanonicalProjectKey,
      });
      if (!change) return;
      if (change.kind === "projectEdit") {
        const projects = await promptHistoryProjectSelection(idx, {
          selection: historyProjectSelection,
          getProjectDisplayName: (projectCwd) => getProjectDisplayName(projectCwd, 80),
          getCanonicalProjectKey,
        });
        if (!projects) return;
        await applyHistoryFilters(
          { projects },
          { persist: true, projectScopePolicy: "explicitSelection" },
        );
        return;
      }
      if (change.kind === "project") {
        await applyHistoryFilters(
          { projects: projectSelectionFromCwds(change.projectCwd, null, resolveHistoryProjectGroupKey) },
          { persist: true, projectScopePolicy: "explicitSelection" },
        );
        return;
      }
      if (change.kind === "archiveLocation") {
        await applyArchiveLocationFilter(change.archiveLocation, { persist: true, rerunSearch: true });
        return;
      }
      const next: HistoryFilterPatch = change.kind === "date"
        ? { date: change.date }
        : change.kind === "source"
          ? { source: change.source }
          : { tags: change.tags };
      await applyHistoryFilters(next, { persist: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.clearHistoryFilter", async () => {
      await applyHistoryFilterState({
        date: { kind: "all" },
        projects: { kind: "all" },
        source: "all",
        tags: [],
        archiveLocation: "activeOnly",
      }, { persist: true, rerunSearch: true, projectScopePolicy: "clear" });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.filterHistoryByTag", async (tagArg?: unknown) => {
      const singleTag = typeof tagArg === "string" ? tagArg.trim() : "";
      if (singleTag) {
        await applyHistoryFilters(
          (current) => {
            const normalizedCurrent = sanitizeTagFilter(current.tags);
            const isSameSingle =
              normalizedCurrent.length === 1 &&
              normalizedCurrent[0]!.toLowerCase() === singleTag.toLowerCase();
            return { tags: isSameSingle ? [] : [singleTag] };
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
      await applyHistoryFilters({ tags: nextTags }, { persist: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.clearHistoryTagFilter", async () => {
      await applyHistoryFilters({ tags: [] }, { persist: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.filterHistoryCurrentProject", async () => {
      const workspaceFolder = resolveCurrentWorkspaceFolder();
      if (!workspaceFolder) {
        void vscode.window.showInformationMessage(t("history.project.scope.noWorkspace"));
        await applyHistoryProjectState({ scope: "all" }, { persist: true });
        return;
      }

      await applyHistoryProjectState(
        () => ({ display: "list", scope: historyProjectScope === "currentGroup" ? "all" : "currentGroup" }),
        { persist: true },
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.showHistoryProjectGrouped", async () => {
      await applyHistoryProjectState({ display: "project", scope: "all" }, { persist: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.clearHistoryProjectMode", async () => {
      await applyHistoryProjectState({ projectCwd: null, display: "list", scope: "all" }, { persist: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.toggleHistoryProjectDisplay", async () => {
      await applyHistoryProjectState(
        () => ({ display: historyProjectDisplay === "project" ? "list" : "project" }),
        { persist: true },
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.toggleHistoryProjectScope", async () => {
      if (historyProjectScope !== "currentGroup" && !resolveCurrentWorkspaceFolder()) {
        void vscode.window.showInformationMessage(t("history.project.scope.noWorkspace"));
        return;
      }
      await applyHistoryProjectState(
        () => ({ scope: historyProjectScope === "currentGroup" ? "all" : "currentGroup" }),
        { persist: true },
      );
    }),
  );

  const registerHistoryProjectDisplayCommand = (commandId: string, display: ProjectDisplayMode): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(commandId, async () => {
        await applyHistoryProjectState({ display }, { persist: true });
      }),
    );
  };

  registerHistoryProjectDisplayCommand("codexHistoryViewer.setHistoryProjectDisplayList", "list");
  registerHistoryProjectDisplayCommand("codexHistoryViewer.setHistoryProjectDisplayProject", "project");

  const registerHistoryProjectScopeCommand = (commandId: string, scope: ProjectScopeMode): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(commandId, async () => {
        if (scope === "currentGroup" && !resolveCurrentWorkspaceFolder()) {
          void vscode.window.showInformationMessage(t("history.project.scope.noWorkspace"));
          return;
        }
        await applyHistoryProjectState({ scope }, { persist: true });
      }),
    );
  };

  registerHistoryProjectScopeCommand("codexHistoryViewer.setHistoryProjectScopeAll", "all");
  registerHistoryProjectScopeCommand("codexHistoryViewer.setHistoryProjectScopeCurrentGroup", "currentGroup");

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.cycleHistorySourceFilter", async () => {
      await cycleHistorySourceFilter();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.cyclePinnedSourceFilter", async () => {
      await cyclePinnedSourceFilter();
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
      await applyHistoryFilters({ source: "codex" }, { persist: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.filterHistorySourceClaude", async () => {
      await applyHistoryFilters({ source: "claude" }, { persist: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexHistoryViewer.clearHistorySourceFilter", async () => {
      await applyHistoryFilters({ source: "all" }, { persist: true });
    }),
  );

  const registerHistorySourceFilterCommand = (commandId: string, source: SessionSourceFilter): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(commandId, async () => {
        const normalized = constrainHistorySourceFilter(source);
        await applyHistoryFilters({ source: normalized }, { persist: true });
      }),
    );
  };

  registerHistorySourceFilterCommand("codexHistoryViewer.setHistorySourceFilterAll", "all");
  registerHistorySourceFilterCommand("codexHistoryViewer.setHistorySourceFilterCodex", "codex");
  registerHistorySourceFilterCommand("codexHistoryViewer.setHistorySourceFilterClaude", "claude");

  const registerHistoryArchiveLocationCommand = (commandId: string, archiveLocation: ArchiveLocationFilter): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(commandId, async () => {
        return applyArchiveLocationFilter(archiveLocation, { persist: true, rerunSearch: true });
      }),
    );
  };

  registerHistoryArchiveLocationCommand("codexHistoryViewer.setHistoryArchiveLocationActiveOnly", "activeOnly");
  registerHistoryArchiveLocationCommand("codexHistoryViewer.setHistoryArchiveLocationAll", "all");
  registerHistoryArchiveLocationCommand("codexHistoryViewer.setHistoryArchiveLocationArchivedOnly", "archivedOnly");

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
        refreshViews({ clearSearch: true, reloadProjectAssociations: true });
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
      refreshViews({ clearSearch: true, reloadProjectAssociations: true });
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
      const { pinned, skipped, added } = await pinStore.pinSessions(sessions);
      refreshViews();
      const newlyPinned = added.map((pin) => pin.fsPath);
      if (newlyPinned.length > 0) {
        const newlyPinnedTokens = added.map((pin) => ({
          cacheKey: pin.cacheKey,
          identityKey: pin.identityKey,
          pinnedAt: pin.pinnedAt,
        }));
        pushUndoAction(t("undo.label.pin", newlyPinned.length), async () => {
          const relocatedPaths = pinStore
            .getAll()
            .filter((pin) =>
              newlyPinnedTokens.some((token) =>
                pin.pinnedAt === token.pinnedAt &&
                (token.identityKey
                  ? pin.identityKey === token.identityKey
                  : pin.cacheKey === token.cacheKey),
              ),
            )
            .map((pin) => pin.fsPath);
          await pinStore.unpinMany([...newlyPinned, ...relocatedPaths]);
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
        const identityKey = resolveSessionIdentityKeyArgument(element);
        const identityPins = identityKey
          ? pinStore.getAll().filter((pin) => pin.identityKey === identityKey).map((pin) => pin.fsPath)
          : [];
        const currentSession = identityKey ? historyService.getIndex().byIdentityKey.get(identityKey) : undefined;
        const candidates = [...identityPins, currentSession?.fsPath ?? "", fsPath].filter(Boolean);
        fsPaths = Array.from(
          candidates.reduce((byKey, candidate) => {
            byKey.set(normalizeCacheKey(candidate), candidate);
            return byKey;
          }, new Map<string, string>()).values(),
        );
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
      refreshViews({ clearSearch: true, reloadProjectAssociations: true });
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
  registerUiCommandAlias("codexHistoryViewer.ui.ja.showHistoryInsights", "codexHistoryViewer.showHistoryInsights");
  registerUiCommandAlias("codexHistoryViewer.ui.en.showHistoryInsights", "codexHistoryViewer.showHistoryInsights");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.openCodexAgentParent", "codexHistoryViewer.openCodexAgentParent");
  registerUiCommandAlias("codexHistoryViewer.ui.en.openCodexAgentParent", "codexHistoryViewer.openCodexAgentParent");
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
  registerUiCommandAlias("codexHistoryViewer.ui.ja.pinnedArchiveLocationActiveOnly", "codexHistoryViewer.filterPinnedArchiveLocation");
  registerUiCommandAlias("codexHistoryViewer.ui.en.pinnedArchiveLocationActiveOnly", "codexHistoryViewer.filterPinnedArchiveLocation");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.pinnedArchiveLocationAll", "codexHistoryViewer.filterPinnedArchiveLocation");
  registerUiCommandAlias("codexHistoryViewer.ui.en.pinnedArchiveLocationAll", "codexHistoryViewer.filterPinnedArchiveLocation");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.pinnedArchiveLocationArchivedOnly", "codexHistoryViewer.filterPinnedArchiveLocation");
  registerUiCommandAlias("codexHistoryViewer.ui.en.pinnedArchiveLocationArchivedOnly", "codexHistoryViewer.filterPinnedArchiveLocation");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.pinnedArchiveLocationDisabled", "codexHistoryViewer.filterPinnedArchiveLocation");
  registerUiCommandAlias("codexHistoryViewer.ui.en.pinnedArchiveLocationDisabled", "codexHistoryViewer.filterPinnedArchiveLocation");
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
  registerUiCommandAlias("codexHistoryViewer.ui.ja.historyViewLatestCurrent", "codexHistoryViewer.toggleHistoryViewMode");
  registerUiCommandAlias("codexHistoryViewer.ui.en.historyViewLatestCurrent", "codexHistoryViewer.toggleHistoryViewMode");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.historyViewDateCurrent", "codexHistoryViewer.toggleHistoryViewMode");
  registerUiCommandAlias("codexHistoryViewer.ui.en.historyViewDateCurrent", "codexHistoryViewer.toggleHistoryViewMode");

  const registerHistoryMenuAlias = (suffix: string, targetCommand: string): void => {
    for (const lang of ["ja", "en"] as const) {
      registerUiCommandAlias(`codexHistoryViewer.ui.${lang}.${suffix}`, targetCommand);
      registerUiCommandAlias(`codexHistoryViewer.ui.${lang}.${suffix}Checked`, targetCommand);
    }
  };

  registerHistoryMenuAlias("historyMenuSortCreatedDesc", "codexHistoryViewer.setHistorySortCreatedDesc");
  registerHistoryMenuAlias("historyMenuSortCreatedAsc", "codexHistoryViewer.setHistorySortCreatedAsc");
  registerHistoryMenuAlias("historyMenuSortLastActivityDesc", "codexHistoryViewer.setHistorySortLastActivityDesc");
  registerHistoryMenuAlias("historyMenuSortLastActivityAsc", "codexHistoryViewer.setHistorySortLastActivityAsc");
  registerHistoryMenuAlias("historyMenuSortTitleAsc", "codexHistoryViewer.setHistorySortTitleAsc");
  registerHistoryMenuAlias("historyMenuSortTitleDesc", "codexHistoryViewer.setHistorySortTitleDesc");
  registerHistoryMenuAlias("historyMenuViewSessions", "codexHistoryViewer.showHistoryLatestView");
  registerHistoryMenuAlias("historyMenuViewDate", "codexHistoryViewer.showHistoryDateView");
  registerHistoryMenuAlias("historyMenuProjectDisplayList", "codexHistoryViewer.setHistoryProjectDisplayList");
  registerHistoryMenuAlias("historyMenuProjectDisplayProject", "codexHistoryViewer.setHistoryProjectDisplayProject");
  registerHistoryMenuAlias("historyMenuProjectScopeAll", "codexHistoryViewer.setHistoryProjectScopeAll");
  registerHistoryMenuAlias(
    "historyMenuProjectScopeCurrentGroup",
    "codexHistoryViewer.setHistoryProjectScopeCurrentGroup",
  );
  registerHistoryMenuAlias("historyMenuSourceAll", "codexHistoryViewer.setHistorySourceFilterAll");
  registerHistoryMenuAlias("historyMenuSourceCodex", "codexHistoryViewer.setHistorySourceFilterCodex");
  registerHistoryMenuAlias("historyMenuSourceClaude", "codexHistoryViewer.setHistorySourceFilterClaude");
  registerHistoryMenuAlias(
    "historyMenuArchiveLocationActiveOnly",
    "codexHistoryViewer.setHistoryArchiveLocationActiveOnly",
  );
  registerHistoryMenuAlias("historyMenuArchiveLocationAll", "codexHistoryViewer.setHistoryArchiveLocationAll");
  registerHistoryMenuAlias(
    "historyMenuArchiveLocationArchivedOnly",
    "codexHistoryViewer.setHistoryArchiveLocationArchivedOnly",
  );

  const registerPinnedMenuSortAlias = (suffix: string, targetCommand: string): void => {
    for (const lang of ["ja", "en"] as const) {
      registerUiCommandAlias(`codexHistoryViewer.ui.${lang}.${suffix}`, targetCommand);
      registerUiCommandAlias(`codexHistoryViewer.ui.${lang}.${suffix}Checked`, targetCommand);
    }
  };

  registerPinnedMenuSortAlias("pinnedMenuSortPinnedAtDesc", "codexHistoryViewer.setPinnedSortPinnedAtDesc");
  registerPinnedMenuSortAlias("pinnedMenuSortPinnedAtAsc", "codexHistoryViewer.setPinnedSortPinnedAtAsc");
  registerPinnedMenuSortAlias("pinnedMenuSortCreatedDesc", "codexHistoryViewer.setPinnedSortCreatedDesc");
  registerPinnedMenuSortAlias("pinnedMenuSortCreatedAsc", "codexHistoryViewer.setPinnedSortCreatedAsc");
  registerPinnedMenuSortAlias("pinnedMenuSortLastActivityDesc", "codexHistoryViewer.setPinnedSortLastActivityDesc");
  registerPinnedMenuSortAlias("pinnedMenuSortLastActivityAsc", "codexHistoryViewer.setPinnedSortLastActivityAsc");
  registerPinnedMenuSortAlias("pinnedMenuSortTitleAsc", "codexHistoryViewer.setPinnedSortTitleAsc");
  registerPinnedMenuSortAlias("pinnedMenuSortTitleDesc", "codexHistoryViewer.setPinnedSortTitleDesc");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.refreshStatusPane", "codexHistoryViewer.refreshStatusPane");
  registerUiCommandAlias("codexHistoryViewer.ui.en.refreshStatusPane", "codexHistoryViewer.refreshStatusPane");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.search", "codexHistoryViewer.search");
  registerUiCommandAlias("codexHistoryViewer.ui.en.search", "codexHistoryViewer.search");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.searchRerun", "codexHistoryViewer.searchRerun");
  registerUiCommandAlias("codexHistoryViewer.ui.en.searchRerun", "codexHistoryViewer.searchRerun");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.searchRunRecent", "codexHistoryViewer.searchRunRecent");
  registerUiCommandAlias("codexHistoryViewer.ui.en.searchRunRecent", "codexHistoryViewer.searchRunRecent");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.searchClearHistory", "codexHistoryViewer.searchClearHistory");
  registerUiCommandAlias("codexHistoryViewer.ui.en.searchClearHistory", "codexHistoryViewer.searchClearHistory");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.searchManageHistory", "codexHistoryViewer.searchManageHistory");
  registerUiCommandAlias("codexHistoryViewer.ui.en.searchManageHistory", "codexHistoryViewer.searchManageHistory");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.searchClearResults", "codexHistoryViewer.searchClearResults");
  registerUiCommandAlias("codexHistoryViewer.ui.en.searchClearResults", "codexHistoryViewer.searchClearResults");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.searchFilterByTag", "codexHistoryViewer.searchFilterByTag");
  registerUiCommandAlias("codexHistoryViewer.ui.en.searchFilterByTag", "codexHistoryViewer.searchFilterByTag");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.clearSearchTagFilter", "codexHistoryViewer.clearSearchTagFilter");
  registerUiCommandAlias("codexHistoryViewer.ui.en.clearSearchTagFilter", "codexHistoryViewer.clearSearchTagFilter");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.filterPinned", "codexHistoryViewer.filterPinned");
  registerUiCommandAlias("codexHistoryViewer.ui.en.filterPinned", "codexHistoryViewer.filterPinned");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.filterPinnedByTag", "codexHistoryViewer.filterPinnedByTag");
  registerUiCommandAlias("codexHistoryViewer.ui.en.filterPinnedByTag", "codexHistoryViewer.filterPinnedByTag");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.clearPinnedTagFilter", "codexHistoryViewer.clearPinnedTagFilter");
  registerUiCommandAlias("codexHistoryViewer.ui.en.clearPinnedTagFilter", "codexHistoryViewer.clearPinnedTagFilter");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.clearPinnedFilter", "codexHistoryViewer.clearPinnedFilter");
  registerUiCommandAlias("codexHistoryViewer.ui.en.clearPinnedFilter", "codexHistoryViewer.clearPinnedFilter");
  registerUiCommandAlias(
    "codexHistoryViewer.ui.ja.filterPinnedCurrentProject",
    "codexHistoryViewer.filterPinnedCurrentProject",
  );
  registerUiCommandAlias(
    "codexHistoryViewer.ui.en.filterPinnedCurrentProject",
    "codexHistoryViewer.filterPinnedCurrentProject",
  );
  registerUiCommandAlias(
    "codexHistoryViewer.ui.ja.showPinnedProjectGrouped",
    "codexHistoryViewer.showPinnedProjectGrouped",
  );
  registerUiCommandAlias(
    "codexHistoryViewer.ui.en.showPinnedProjectGrouped",
    "codexHistoryViewer.showPinnedProjectGrouped",
  );
  registerUiCommandAlias(
    "codexHistoryViewer.ui.ja.clearPinnedProjectMode",
    "codexHistoryViewer.clearPinnedProjectMode",
  );
  registerUiCommandAlias(
    "codexHistoryViewer.ui.en.clearPinnedProjectMode",
    "codexHistoryViewer.clearPinnedProjectMode",
  );
  registerUiCommandAlias("codexHistoryViewer.ui.ja.pinnedProjectDisplayList", "codexHistoryViewer.togglePinnedProjectDisplay");
  registerUiCommandAlias("codexHistoryViewer.ui.en.pinnedProjectDisplayList", "codexHistoryViewer.togglePinnedProjectDisplay");
  registerUiCommandAlias(
    "codexHistoryViewer.ui.ja.pinnedProjectDisplayProject",
    "codexHistoryViewer.togglePinnedProjectDisplay",
  );
  registerUiCommandAlias(
    "codexHistoryViewer.ui.en.pinnedProjectDisplayProject",
    "codexHistoryViewer.togglePinnedProjectDisplay",
  );
  registerUiCommandAlias("codexHistoryViewer.ui.ja.pinnedProjectScopeAll", "codexHistoryViewer.togglePinnedProjectScope");
  registerUiCommandAlias("codexHistoryViewer.ui.en.pinnedProjectScopeAll", "codexHistoryViewer.togglePinnedProjectScope");
  registerUiCommandAlias(
    "codexHistoryViewer.ui.ja.pinnedProjectScopeCurrentGroup",
    "codexHistoryViewer.togglePinnedProjectScope",
  );
  registerUiCommandAlias(
    "codexHistoryViewer.ui.en.pinnedProjectScopeCurrentGroup",
    "codexHistoryViewer.togglePinnedProjectScope",
  );
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
  registerUiCommandAlias(
    "codexHistoryViewer.ui.ja.showHistoryProjectGrouped",
    "codexHistoryViewer.showHistoryProjectGrouped",
  );
  registerUiCommandAlias(
    "codexHistoryViewer.ui.en.showHistoryProjectGrouped",
    "codexHistoryViewer.showHistoryProjectGrouped",
  );
  registerUiCommandAlias(
    "codexHistoryViewer.ui.ja.clearHistoryProjectMode",
    "codexHistoryViewer.clearHistoryProjectMode",
  );
  registerUiCommandAlias(
    "codexHistoryViewer.ui.en.clearHistoryProjectMode",
    "codexHistoryViewer.clearHistoryProjectMode",
  );
  registerUiCommandAlias("codexHistoryViewer.ui.ja.historyProjectDisplayList", "codexHistoryViewer.toggleHistoryProjectDisplay");
  registerUiCommandAlias("codexHistoryViewer.ui.en.historyProjectDisplayList", "codexHistoryViewer.toggleHistoryProjectDisplay");
  registerUiCommandAlias(
    "codexHistoryViewer.ui.ja.historyProjectDisplayProject",
    "codexHistoryViewer.toggleHistoryProjectDisplay",
  );
  registerUiCommandAlias(
    "codexHistoryViewer.ui.en.historyProjectDisplayProject",
    "codexHistoryViewer.toggleHistoryProjectDisplay",
  );
  registerUiCommandAlias("codexHistoryViewer.ui.ja.historyProjectScopeAll", "codexHistoryViewer.toggleHistoryProjectScope");
  registerUiCommandAlias("codexHistoryViewer.ui.en.historyProjectScopeAll", "codexHistoryViewer.toggleHistoryProjectScope");
  registerUiCommandAlias(
    "codexHistoryViewer.ui.ja.historyProjectScopeCurrentGroup",
    "codexHistoryViewer.toggleHistoryProjectScope",
  );
  registerUiCommandAlias(
    "codexHistoryViewer.ui.en.historyProjectScopeCurrentGroup",
    "codexHistoryViewer.toggleHistoryProjectScope",
  );
  registerUiCommandAlias("codexHistoryViewer.ui.cycleHistorySourceAll", "codexHistoryViewer.cycleHistorySourceFilter");
  registerUiCommandAlias("codexHistoryViewer.ui.cycleHistorySourceCodex", "codexHistoryViewer.cycleHistorySourceFilter");
  registerUiCommandAlias("codexHistoryViewer.ui.cycleHistorySourceClaude", "codexHistoryViewer.cycleHistorySourceFilter");
  registerUiCommandAlias("codexHistoryViewer.ui.pinnedSourceAll", "codexHistoryViewer.cyclePinnedSourceFilter");
  registerUiCommandAlias("codexHistoryViewer.ui.pinnedSourceCodex", "codexHistoryViewer.cyclePinnedSourceFilter");
  registerUiCommandAlias("codexHistoryViewer.ui.pinnedSourceClaude", "codexHistoryViewer.cyclePinnedSourceFilter");
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
  registerUiCommandAlias("codexHistoryViewer.ui.ja.manageProjectAlias", "codexHistoryViewer.manageProjectAlias");
  registerUiCommandAlias("codexHistoryViewer.ui.en.manageProjectAlias", "codexHistoryViewer.manageProjectAlias");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.setProjectAlias", "codexHistoryViewer.setProjectAlias");
  registerUiCommandAlias("codexHistoryViewer.ui.en.setProjectAlias", "codexHistoryViewer.setProjectAlias");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.clearProjectAlias", "codexHistoryViewer.clearProjectAlias");
  registerUiCommandAlias("codexHistoryViewer.ui.en.clearProjectAlias", "codexHistoryViewer.clearProjectAlias");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.manageProjectAssociation", "codexHistoryViewer.manageProjectAssociation");
  registerUiCommandAlias("codexHistoryViewer.ui.en.manageProjectAssociation", "codexHistoryViewer.manageProjectAssociation");
  registerUiCommandAlias("codexHistoryViewer.ui.ja.clearProjectAssociation", "codexHistoryViewer.clearProjectAssociation");
  registerUiCommandAlias("codexHistoryViewer.ui.en.clearProjectAssociation", "codexHistoryViewer.clearProjectAssociation");
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
      } finally {
        initialAuthoritativeHistoryRefreshSettled.resolve(undefined);
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
    try {
      completeInitialTreeLoad();
      runCodexAgentRunsConfigurationChange("activation.cached");
      runInitialBackgroundRefresh();
    } catch (error) {
      initialAuthoritativeHistoryRefreshSettled.resolve(undefined);
      throw error;
    }
  } else {
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: t("app.loadingHistory") },
        async () => {
          await refreshHistoryIndex(false);
        },
      );
    } finally {
      try {
        completeInitialTreeLoad();
      } finally {
        initialAuthoritativeHistoryRefreshSettled.resolve(undefined);
      }
    }
    runCodexAgentRunsConfigurationChange("activation.refreshed");
  }
  await autoRefreshService.configure(getConfig(), computeAutoRefreshConsumerVisible(), vscode.window.state.focused);
}

function sanitizeProjectCwd(value: unknown): string | null {
  const s = typeof value === "string" ? value.trim() : "";
  return s.length > 0 ? s : null;
}

function sanitizeProjectGrouped(value: unknown): boolean {
  return value === true;
}

function sanitizeProjectDisplayMode(value: unknown, legacyGroupedValue?: unknown): ProjectDisplayMode {
  if (value === "project") return "project";
  if (value === "list") return "list";
  return sanitizeProjectGrouped(legacyGroupedValue) ? "project" : "list";
}

function sanitizeProjectScopeMode(value: unknown): ProjectScopeMode {
  return value === "currentGroup" ? "currentGroup" : "all";
}

function sanitizePinnedSortMode(
  value: unknown,
  historyDateBasis: CodexHistoryViewerConfig["historyDateBasis"],
): PinnedSortMode {
  const s = typeof value === "string" ? value.trim() : "";
  switch (s) {
    case "pinnedAtAsc":
    case "createdDesc":
    case "createdAsc":
    case "lastActivityDesc":
    case "lastActivityAsc":
    case "titleAsc":
    case "titleDesc":
      return s;
    case "historyDate":
      return historyDateBasis === "lastActivity" ? "lastActivityDesc" : "createdDesc";
    case "pinnedAt":
    case "pinnedAtDesc":
    default:
      return "pinnedAtDesc";
  }
}

function isLegacyPinnedSortModeValue(value: unknown): boolean {
  const s = typeof value === "string" ? value.trim() : "";
  return s === "pinnedAt" || s === "historyDate";
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
  const v = value as { queryInput?: unknown; roleFilter?: unknown; caseSensitive?: unknown };
  const queryInput = typeof v.queryInput === "string" ? v.queryInput.trim() : "";
  if (!queryInput) return null;
  const roleFilter = sanitizeIndexedSearchRoles(v.roleFilter);
  return {
    queryInput,
    roleFilter,
    ...(typeof v.caseSensitive === "boolean" ? { caseSensitive: v.caseSensitive } : {}),
  };
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

function sanitizeHistorySortOrder(value: unknown, historyDateBasis: CodexHistoryViewerConfig["historyDateBasis"]): HistorySortOrder {
  const s = typeof value === "string" ? value.trim() : "";
  if (isHistorySortOrderValue(s)) return s;
  return defaultHistorySortOrder(historyDateBasis);
}

function isHistorySortOrderValue(value: unknown): value is HistorySortOrder {
  const s = typeof value === "string" ? value.trim() : "";
  switch (s) {
    case "createdDesc":
    case "createdAsc":
    case "lastActivityDesc":
    case "lastActivityAsc":
    case "titleAsc":
    case "titleDesc":
      return true;
    default:
      return false;
  }
}

function defaultHistorySortOrder(historyDateBasis: CodexHistoryViewerConfig["historyDateBasis"]): HistorySortOrder {
  return historyDateBasis === "lastActivity" ? "lastActivityDesc" : "createdDesc";
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

function nextPinnedSortMode(value: PinnedSortMode): PinnedSortMode {
  return value === "pinnedAtDesc" ? "lastActivityDesc" : "pinnedAtDesc";
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
  | { kind: "projectEdit" }
  | { kind: "source"; source: SessionSourceFilter }
  | { kind: "archiveLocation"; archiveLocation: ArchiveLocationFilter }
  | { kind: "tags"; tags: string[] };

type HistoryFilterPick = vscode.QuickPickItem & {
  pickKind?: "date" | "project" | "projectEdit" | "source" | "archiveLocation" | "tags";
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
    projectCwd?: string | null;
    projectSelection?: ProjectSelection;
    source: SessionSourceFilter;
    sourceOptions: SessionSourceFilter[];
    archiveLocation: ArchiveLocationFilter;
    tags: string[];
    availableTags: string[];
    getProjectDisplayName?: (projectCwd: string) => string;
    getCanonicalProjectKey?: (projectCwd: string) => string | null;
    placeholder?: string;
    allDateLabel?: string;
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
    const key = current.getCanonicalProjectKey?.(cwd) ?? normalizeProjectKey(cwd);
    if (seenProjects.has(key)) continue;
    seenProjects.add(key);
    projectCwds.push(resolveProjectCwdForFilterList(cwd, key, idx, current.getCanonicalProjectKey));
    if (projectCwds.length >= MAX_PROJECTS) break;
  }

  const dateItemsBase: HistoryFilterPick[] = [
    { label: t("history.filter.section.date"), kind: vscode.QuickPickItemKind.Separator },
    { label: current.allDateLabel ?? t("history.filter.all"), pickKind: "date", date: { kind: "all" } },
    ...(current.date.kind === "range"
      ? [{
          label: getDateScopeValue(current.date) ?? "",
          description: t("common.current"),
          pickKind: "date" as const,
          date: current.date,
        }]
      : []),
    ...years.map((y) => ({ label: y, pickKind: "date" as const, date: { kind: "year" as const, yyyy: y } })),
    ...yms.map((ym) => ({ label: ym, pickKind: "date" as const, date: { kind: "month" as const, ym } })),
  ];

  const projectItemsBase: HistoryFilterPick[] = current.projectSelection
    ? [
        { label: t("history.filter.section.project"), kind: vscode.QuickPickItemKind.Separator },
        {
          label: t("history.project.editSelection"),
          description: current.projectSelection.kind === "groups"
            ? t("historyInsights.filterProjectGroupCount", current.projectSelection.groups.length)
            : t("history.filter.all"),
          pickKind: "projectEdit" as const,
        },
      ]
    : [
        { label: t("history.filter.section.project"), kind: vscode.QuickPickItemKind.Separator },
        { label: t("history.project.clear"), pickKind: "project" as const, projectCwd: null },
        ...projectCwds.map((cwd) => ({
          label: current.getProjectDisplayName?.(cwd) ?? safeDisplayPath(cwd, 80),
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

  return await new Promise<HistoryFilterChange | null>((resolve) => {
    const qp = vscode.window.createQuickPick<HistoryFilterPick>();
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.placeholder = current.placeholder ?? t("history.filter.placeholder");
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
      if (pickKind === "projectEdit") {
        finish({ kind: "projectEdit" });
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
    const currentProjectKey = current.projectCwd
      ? (current.getCanonicalProjectKey?.(current.projectCwd) ?? normalizeProjectKey(current.projectCwd))
      : null;
    const activeDateItem = dateItemsBase.find((it) => it.pickKind === "date" && it.date && isSameDateScope(it.date, current.date));
    const activeProjectItem = currentProjectKey
      ? projectItemsBase.find(
          (it) =>
            it.pickKind === "project" &&
            it.projectCwd &&
            (current.getCanonicalProjectKey?.(it.projectCwd) ?? normalizeProjectKey(it.projectCwd)) === currentProjectKey,
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

async function promptHistoryProjectSelection(
  idx: import("./sessions/sessionTypes").HistoryIndex,
  current: {
    selection: ProjectSelection;
    getProjectDisplayName: (projectCwd: string) => string;
    getCanonicalProjectKey: (projectCwd: string) => string | null;
  },
): Promise<ProjectSelection | null> {
  type ProjectPick = vscode.QuickPickItem & { group: { canonicalGroupKey: string; representativeCwd: string } };
  const candidates = new Map<string, ProjectPick>();
  const append = (representativeCwd: string, canonicalGroupKey?: string): void => {
    const cwd = representativeCwd.trim();
    const key = (canonicalGroupKey ?? current.getCanonicalProjectKey(cwd) ?? normalizeProjectKey(cwd)).trim();
    if (!cwd || !key || candidates.has(key) || candidates.size >= 250) return;
    candidates.set(key, {
      label: current.getProjectDisplayName(cwd),
      description: t("history.filter.project"),
      group: { canonicalGroupKey: key, representativeCwd: cwd },
    });
  };
  if (current.selection.kind === "groups") {
    for (const group of current.selection.groups) append(group.representativeCwd, group.canonicalGroupKey);
  }
  for (const session of idx.sessions) {
    const cwd = typeof session.meta.cwd === "string" ? session.meta.cwd.trim() : "";
    if (cwd) append(cwd);
    if (candidates.size >= 250) break;
  }
  const items = Array.from(candidates.values());
  return new Promise<ProjectSelection | null>((resolve) => {
    const picker = vscode.window.createQuickPick<ProjectPick>();
    picker.title = t("history.project.editSelection");
    picker.placeholder = t("history.project.multiSelectPlaceholder", MAX_PROJECT_SELECTION_GROUPS);
    picker.canSelectMany = true;
    picker.matchOnDescription = true;
    picker.items = items;
    const selectedKeys = new Set(
      current.selection.kind === "groups"
        ? current.selection.groups.map((group) => group.canonicalGroupKey)
        : [],
    );
    picker.selectedItems = items.filter((item) => selectedKeys.has(item.group.canonicalGroupKey));
    let updating = false;
    picker.onDidChangeSelection((selection) => {
      if (updating || selection.length <= MAX_PROJECT_SELECTION_GROUPS) return;
      updating = true;
      picker.selectedItems = selection.slice(0, MAX_PROJECT_SELECTION_GROUPS);
      updating = false;
    });
    let done = false;
    const finish = (value: ProjectSelection | null): void => {
      if (done) return;
      done = true;
      resolve(value);
      picker.dispose();
    };
    picker.onDidAccept(() => {
      const selected = picker.selectedItems.slice(0, MAX_PROJECT_SELECTION_GROUPS);
      finish(selected.length === 0
        ? { kind: "all" }
        : { kind: "groups", groups: selected.map((item) => item.group) });
    });
    picker.onDidHide(() => finish(null));
    picker.show();
  });
}

function resolveProjectCwdForFilterList(
  fallbackCwd: string,
  canonicalKey: string,
  idx: import("./sessions/sessionTypes").HistoryIndex,
  getCanonicalProjectKey?: (projectCwd: string) => string | null,
): string {
  for (const session of idx.sessions) {
    const cwd = typeof session.meta?.cwd === "string" ? session.meta.cwd.trim() : "";
    if (!cwd) continue;
    if (normalizeProjectKey(cwd) !== canonicalKey) continue;
    return cwd;
  }
  for (const session of idx.sessions) {
    const cwd = typeof session.meta?.cwd === "string" ? session.meta.cwd.trim() : "";
    if (!cwd) continue;
    const key = getCanonicalProjectKey?.(cwd) ?? normalizeProjectKey(cwd);
    if (key === canonicalKey) return cwd;
  }
  return fallbackCwd;
}

function resolveInsightsProjectCwd(
  snapshot: HistoryInsightsSnapshot,
  projectKey: string,
  sessions: readonly SessionSummary[],
): string | null {
  const byCacheKey = new Map(sessions.map((session) => [session.cacheKey, session]));
  const byIdentityKey = new Map(sessions.map((session) => [session.identityKey, session]));
  for (const reference of snapshot.references) {
    if (reference.projectKey !== projectKey) continue;
    const cacheMatch = byCacheKey.get(reference.cacheKey);
    const session = cacheMatch?.identityKey === reference.identityKey
      ? cacheMatch
      : byIdentityKey.get(reference.identityKey);
    const cwd = typeof session?.meta.cwd === "string" ? session.meta.cwd.trim() : "";
    if (cwd) return cwd;
  }
  return null;
}

// Cleanup hook called by VS Code.
export function deactivate(): void {
  // Disposables are already registered in context.subscriptions.
}

function resolveExtensionVersion(context: vscode.ExtensionContext): string {
  const version = (context.extension.packageJSON as { version?: unknown }).version;
  return typeof version === "string" && version.trim().length > 0 ? version.trim() : "unknown";
}

function resolveRevealIndex(element: unknown, pageSearchSeed?: SessionPageSearchSeed): number | undefined {
  if (element instanceof SearchSessionNode) return pageSearchSeed?.preferredMessageIndex;
  if (!(element instanceof SearchHitNode)) return undefined;
  if (element.hit.role !== "user" && element.hit.role !== "assistant") return undefined;
  return element.hit.messageIndex;
}

function resolvePageSearchSeed(element: unknown): SessionPageSearchSeed | undefined {
  if (element instanceof SearchHitNode) return sanitizeSessionPageSearchSeed(element.pageSearchSeed);
  if (element instanceof SearchSessionNode) return sanitizeSessionPageSearchSeed(element.pageSearchSeed);
  if (!element || typeof element !== "object") return undefined;
  return sanitizeSessionPageSearchSeed((element as any).pageSearchSeed);
}

function sanitizeSessionPageSearchSeed(value: unknown): SessionPageSearchSeed | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const queryInput = typeof source.queryInput === "string" ? source.queryInput.trim() : "";
  if (!queryInput) return undefined;
  const preferredMessageIndex =
    typeof source.preferredMessageIndex === "number" && Number.isFinite(source.preferredMessageIndex)
      ? Math.max(0, Math.floor(source.preferredMessageIndex))
      : undefined;
  return {
    queryInput,
    caseSensitive: source.caseSensitive === true,
    ...(typeof preferredMessageIndex === "number" ? { preferredMessageIndex } : {}),
    ...(source.autoOpen === false ? { autoOpen: false } : {}),
  };
}

function resolveRevealIndexFromArgs(args: unknown): number | undefined {
  if (!args || typeof args !== "object") return undefined;
  const v = (args as any).revealMessageIndex;
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : undefined;
}

function resolveSessionFromElementOrFsPath(historyService: HistoryService, elementOrArgs: unknown): SessionSummary | undefined {
  if (isSessionNode(elementOrArgs)) return elementOrArgs.session;
  if (!elementOrArgs || typeof elementOrArgs !== "object") return undefined;
  const identityKey = resolveSessionIdentityKeyArgument(elementOrArgs);
  if (identityKey) {
    const session = historyService.getIndex().byIdentityKey.get(identityKey);
    if (session) return session;
  }
  const fsPath = (elementOrArgs as any).fsPath;
  if (typeof fsPath !== "string" || fsPath.length === 0) return undefined;
  return historyService.findByFsPath(fsPath);
}

function resolveSessionIdentityKeyArgument(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const identityKey = (value as { identityKey?: unknown }).identityKey;
  if (typeof identityKey !== "string") return undefined;
  const normalized = identityKey.trim();
  return normalized &&
    normalized.length <= 1024 &&
    !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : undefined;
}

function resolveSessionFromElementOrActive(
  historyService: HistoryService,
  transcriptScheme: string,
  element?: unknown,
): SessionSummary | undefined {
  if (isSessionNode(element)) return element.session;

  // Allow switching to the session view from an opened Markdown transcript.
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
  const normalized = normalizeProjectKey(fsPath);
  if (normalized === "/") return normalized;
  if (/^[a-z]:\/$/i.test(normalized)) return normalized;
  return normalized.replace(/\/+$/g, "");
}

function isSameOrDescendantPath(candidatePath: string, basePath: string): boolean {
  if (candidatePath === basePath) return true;
  const base = basePath.endsWith("/") ? basePath : `${basePath}/`;
  return candidatePath.startsWith(base);
}
