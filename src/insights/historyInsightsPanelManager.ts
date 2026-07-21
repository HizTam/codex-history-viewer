import * as fs from "node:fs";
import * as vscode from "vscode";
import { SessionAnalysisCancelledError, SessionAnalysisIndexService } from "../analysis/sessionAnalysisIndexService";
import type { SessionAnalysisProgress } from "../analysis/sessionAnalysisTypes";
import type { FileChangeHistoryPanelManager } from "../fileHistory/fileChangeHistoryPanelManager";
import { resolveUiLanguage, t } from "../i18n";
import { sanitizeDebugError } from "../services/debugLogUtils";
import type { HistoryService } from "../services/historyService";
import type { DebugLogger } from "../services/logger";
import type { ProjectAssociationStore } from "../services/projectAssociationStore";
import type { SessionAnnotationStore } from "../services/sessionAnnotationStore";
import type { SessionSummary } from "../sessions/sessionTypes";
import { mapAssociatedProjectPath } from "../services/projectPathMapper";
import { getConfig, type CodexHistoryViewerConfig } from "../settings";
import { getDateTimeSettingsKey, resolveDateTimeSettings } from "../utils/dateTimeSettings";
import { normalizeProjectKey } from "../utils/fsUtils";
import {
  aggregateHistoryInsights,
  buildHistoryInsightsEntityId,
} from "./historyInsightsAggregator";
import { buildHistoryInsightsProjectContext } from "./historyInsightsProjectContext";
import type {
  HistoryInsightsEditableFilter,
  HistoryInsightsFilterApplication,
  HistoryInsightsFilterOption,
  HistoryInsightsFilterPresentation,
  HistoryInsightsFilterSelection,
  HistoryInsightsModel,
  HistoryInsightsSnapshot,
} from "./historyInsightsTypes";
import {
  buildHistoryInsightsFilterOptionMapKey,
  resolveHistoryInsightsFilterApplication,
} from "./historyInsightsFilterSelection";
import {
  HistoryInsightsApplyPreferenceStore,
  sanitizeHistoryInsightsApplyPreference,
} from "./historyInsightsApplyPreference";
import { DelayedProgressNotification } from "./delayedProgressNotification";
import {
  HistoryInsightsLoadIntentTracker,
  type HistoryInsightsLoadIntent,
} from "./historyInsightsLoadIntent";
import { selectVisibleProjectOptionKeys } from "./historyInsightsProjectOptions";
import { resolveHistoryInsightsSnapshot, sanitizeHistoryInsightsSnapshot } from "./historyInsightsSnapshot";

const VIEW_TYPE = "codexHistoryViewer.historyInsights";
const SNAPSHOT_STATE_KEY = "codexHistoryViewer.historyInsights.snapshot.v1";
const LONG_RUNNING_PROGRESS_DELAY_MS = 2_000;

interface HistoryInsightsPanelState {
  snapshot: HistoryInsightsSnapshot;
  generation: number;
  loading: boolean;
  transitioning: boolean;
  loadCancelledByUser: boolean;
  requiresAuthoritativeHistoryIndex: boolean;
  pendingLoadReason?: HistoryInsightsLoadReason;
  cancellation?: vscode.CancellationTokenSource;
  progressNotification?: vscode.Disposable;
  model?: HistoryInsightsModel;
  filePathById: Map<string, string>;
  projectKeyById: Map<string, string>;
  sessionById: Map<string, SessionSummary>;
  filterSelectionByOptionId: Map<string, HistoryInsightsFilterSelection>;
}

type HistoryInsightsLoadReason = "initial" | "refresh" | "current";

export interface HistoryInsightsHistoryIndexSnapshot {
  readonly config: CodexHistoryViewerConfig;
  readonly sessions: readonly SessionSummary[];
}

export interface HistoryInsightsPanelActions {
  waitForCurrentHistoryIndex: (
    isRequestCurrent: () => boolean,
    requireAuthoritative: boolean,
  ) => Promise<HistoryInsightsHistoryIndexSnapshot | null>;
  getCurrentSnapshot: () => HistoryInsightsSnapshot;
  prepareFilters: (
    snapshot: HistoryInsightsSnapshot,
    filters: HistoryInsightsFilterApplication,
  ) => Promise<HistoryInsightsPreparedFilterApplication | null>;
  getProjectDisplayName: (projectCwd: string) => string;
  getCurrentProjectCwd: () => string | null;
  showDayInHistory: (snapshot: HistoryInsightsSnapshot, ymd: string) => Promise<void>;
  showProjectInHistory: (snapshot: HistoryInsightsSnapshot, projectKey: string) => Promise<void>;
  searchProject: (snapshot: HistoryInsightsSnapshot, projectKey: string) => Promise<void>;
  openSession: (session: SessionSummary) => Promise<void>;
}

export interface HistoryInsightsPreparedFilterApplication {
  snapshot: HistoryInsightsSnapshot;
  commitHistory?: () => Promise<void>;
}

export class HistoryInsightsPanelManager implements vscode.Disposable {
  private readonly extensionUri: vscode.Uri;
  private readonly historyService: HistoryService;
  private readonly analysisService: SessionAnalysisIndexService;
  private readonly fileHistoryPanels: FileChangeHistoryPanelManager;
  private readonly projectAssociationStore: ProjectAssociationStore;
  private readonly annotationStore: SessionAnnotationStore;
  private readonly actions: HistoryInsightsPanelActions;
  private readonly workspaceState: vscode.Memento;
  private readonly logger?: DebugLogger;
  private readonly applyPreferenceStore: HistoryInsightsApplyPreferenceStore;
  private panel: vscode.WebviewPanel | null = null;
  private state: HistoryInsightsPanelState | null = null;
  private ready = false;
  private generationCounter = 0;
  private readonly loadIntentTracker = new HistoryInsightsLoadIntentTracker();
  private snapshotPersistence: Promise<void> = Promise.resolve();
  private panelTransition: Promise<void> = Promise.resolve();
  private filterApplication: Promise<void> | null = null;

  constructor(
    extensionUri: vscode.Uri,
    historyService: HistoryService,
    analysisService: SessionAnalysisIndexService,
    fileHistoryPanels: FileChangeHistoryPanelManager,
    projectAssociationStore: ProjectAssociationStore,
    annotationStore: SessionAnnotationStore,
    actions: HistoryInsightsPanelActions,
    workspaceState: vscode.Memento,
    logger?: DebugLogger,
  ) {
    this.extensionUri = extensionUri;
    this.historyService = historyService;
    this.analysisService = analysisService;
    this.fileHistoryPanels = fileHistoryPanels;
    this.projectAssociationStore = projectAssociationStore;
    this.annotationStore = annotationStore;
    this.actions = actions;
    this.workspaceState = workspaceState;
    this.logger = logger;
    this.applyPreferenceStore = new HistoryInsightsApplyPreferenceStore(workspaceState);
  }

  public registerSerializer(subscriptions: vscode.Disposable[]): void {
    subscriptions.push(
      vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
        deserializeWebviewPanel: async (panel, rawState) => {
          const snapshotId = sanitizeRestoreId(rawState, "snapshotId");
          const snapshot = sanitizeHistoryInsightsSnapshot(this.workspaceState.get<unknown>(SNAPSHOT_STATE_KEY));
          if (!snapshotId || !snapshot || snapshot.id !== snapshotId) {
            panel.dispose();
            return;
          }
          this.panel?.dispose();
          this.panel = panel;
          this.ready = false;
          this.initializePanel(panel);
          this.resetState(snapshot, false, true);
          panel.title = t("historyInsights.title");
        },
      }),
    );
  }

  public dispose(): void {
    this.cancelCurrent();
    this.panel?.dispose();
    this.panel = null;
    this.state = null;
  }

  public refreshI18n(): void {
    const panel = this.panel;
    if (!panel) return;
    panel.title = t("historyInsights.title");
    if (this.ready) {
      this.runObservedAsync(
        "i18n",
        () => panel.webview.postMessage({
          type: "i18n",
          i18n: this.buildI18n(),
          language: resolveLanguage(),
          filters: this.state ? this.buildFilterPresentation(this.state.snapshot) : undefined,
        }),
        panel,
      );
    }
  }

  public refreshAnalysis(): void {
    if (!this.panel || !this.state || !this.ready) return;
    this.startLoad("refresh", true);
  }

  public open(snapshot: HistoryInsightsSnapshot): Promise<void> {
    const activeFilterApplication = this.filterApplication;
    return this.enqueuePanelTransition(async () => {
      if (activeFilterApplication) {
        await activeFilterApplication;
        snapshot = this.actions.getCurrentSnapshot();
      }
      const previousState = this.state;
      const previousWasLoading = previousState?.loading === true;
      const previousWasRefreshing = previousState?.model?.refreshing === true;
      const loadIntentRevision = this.beginPanelTransition(previousState);
      if (previousState) {
        this.cancelCurrent();
        previousState.transitioning = true;
      }
      try {
        await this.persistSnapshot(snapshot);
      } catch {
        if (previousState && this.state === previousState) {
          this.restoreInterruptedLoadAfterTransitionFailure(
            previousState,
            previousWasLoading,
            previousWasRefreshing,
            loadIntentRevision,
          );
        }
        this.showObservedMessage("snapshotSaveFailed", "error", "historyInsights.snapshotSaveFailed");
        return;
      }
      const panel = this.getOrCreatePanel();
      const loadCancelledByUser = this.wasCancelledSince(loadIntentRevision);
      this.resetState(snapshot, loadCancelledByUser);
      panel.title = t("historyInsights.title");
      panel.reveal(vscode.ViewColumn.Active, false);
      if (this.ready) {
        if (!(await this.sendBootstrapForCurrentState("open.bootstrap", panel))) return;
        if (loadCancelledByUser) {
          await this.sendCancelledObserved(panel, this.state);
        } else {
          this.startLoad("initial");
        }
      }
    });
  }

  private getOrCreatePanel(): vscode.WebviewPanel {
    if (this.panel) return this.panel;
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      t("historyInsights.title"),
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, "media"),
          vscode.Uri.joinPath(this.extensionUri, "resources"),
        ],
      },
    );
    this.panel = panel;
    this.initializePanel(panel);
    return panel;
  }

  private initializePanel(panel: vscode.WebviewPanel): void {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "media"),
        vscode.Uri.joinPath(this.extensionUri, "resources"),
      ],
    };
    const icon = vscode.Uri.joinPath(this.extensionUri, "resources", "extension-icon.svg");
    panel.iconPath = { light: icon, dark: icon };
    panel.webview.html = this.buildHtml(panel.webview);
    panel.webview.onDidReceiveMessage((message) => {
      this.runObservedAsync(
        "message",
        () => this.handleMessage(panel, message),
        panel,
        "historyInsights.actionFailed",
      );
    });
    panel.onDidDispose(() => {
      if (this.panel !== panel) return;
      this.cancelCurrent();
      this.panel = null;
      this.state = null;
      this.ready = false;
    });
  }

  private resetState(
    snapshot: HistoryInsightsSnapshot,
    loadCancelledByUser = false,
    requiresAuthoritativeHistoryIndex = false,
  ): void {
    this.cancelCurrent();
    this.state = {
      snapshot,
      generation: ++this.generationCounter,
      loading: false,
      transitioning: false,
      loadCancelledByUser,
      requiresAuthoritativeHistoryIndex,
      filePathById: new Map(),
      projectKeyById: new Map(),
      sessionById: new Map(),
      filterSelectionByOptionId: new Map(),
    };
  }

  private async handleMessage(panel: vscode.WebviewPanel, message: unknown): Promise<void> {
    if (this.panel !== panel) return;
    if (!message || typeof message !== "object") return;
    const raw = message as Record<string, unknown>;
    const type = typeof raw.type === "string" ? raw.type : "";
    if (type === "ready") {
      this.ready = true;
      await this.sendBootstrap();
      this.startLoad("initial");
      return;
    }
    if (type === "cancel") {
      this.requestCurrentCancellation();
      return;
    }
    if (type === "retry" || type === "refresh") {
      this.startLoad("refresh", true);
      return;
    }
    if (type === "refreshCurrent") {
      if (!this.state) return;
      await this.enqueuePanelTransition(() => this.refreshCurrent(panel));
      return;
    }
    if (type === "backToHistory") {
      await vscode.commands.executeCommand("codexHistoryViewer.historyView.focus");
      return;
    }
    if (type === "setApplyToHistoryPreference") {
      const enabled = sanitizeHistoryInsightsApplyPreference(raw.enabled);
      const revision = sanitizePreferenceRevision(raw.revision);
      if (enabled === null || revision === null) return;
      const requestPanel = panel;
      const result = await this.applyPreferenceStore.update(enabled);
      if (this.panel !== requestPanel || !this.ready) return;
      await requestPanel.webview.postMessage({
        type: result.ok ? "applyToHistoryPreference" : "applyToHistoryPreferenceError",
        enabled: result.value,
        revision,
        i18n: this.buildI18n(),
      });
      return;
    }
    const state = this.state;
    if (!state) return;
    if (type === "applyFilters") {
      const resolved = resolveHistoryInsightsFilterApplication(raw, state.snapshot.id, state.filterSelectionByOptionId);
      if (!resolved.ok) {
        await this.panel?.webview.postMessage({ type: "filterApplyError", reason: resolved.reason, i18n: this.buildI18n() });
        return;
      }
      const application = this.enqueuePanelTransition(() => this.applyFilters(panel, state, resolved.value));
      this.filterApplication = application;
      try {
        await application;
      } finally {
        if (this.filterApplication === application) this.filterApplication = null;
      }
      return;
    }
    if (type === "openFileHistory" || type === "openFile") {
      const id = sanitizeId(raw.id);
      const fsPath = id ? state.filePathById.get(id) : undefined;
      if (!fsPath) return;
      if (type === "openFileHistory") {
        await this.fileHistoryPanels.openForUri(vscode.Uri.file(fsPath));
        return;
      }
      try {
        const uri = vscode.Uri.file(fsPath);
        const stat = await vscode.workspace.fs.stat(uri);
        if ((stat.type & vscode.FileType.File) === 0) throw new Error("NotFile");
        await vscode.window.showTextDocument(uri, { preview: true });
      } catch {
        this.showObservedMessage("fileOpenFailed", "warning", "historyInsights.fileOpenFailed");
      }
      return;
    }
    if (type === "showDay") {
      const ymd = sanitizeYmd(raw.ymd);
      if (ymd && state.model?.days.some((day) => day.ymd === ymd)) await this.actions.showDayInHistory(state.snapshot, ymd);
      return;
    }
    if (type === "openSession") {
      const id = sanitizeId(raw.id);
      const session = id ? state.sessionById.get(id) : undefined;
      if (!session || !state.model?.activeSessions.some((row) => row.id === id)) {
        this.showObservedMessage("sessionOpenFailed", "warning", "historyInsights.sessionOpenFailed");
        return;
      }
      await this.actions.openSession(session);
      return;
    }
    const id = sanitizeId(raw.id);
    const projectKey = id ? state.projectKeyById.get(id) : undefined;
    if (!projectKey) return;
    if (type === "showProject") await this.actions.showProjectInHistory(state.snapshot, projectKey);
    if (type === "searchProject") await this.actions.searchProject(state.snapshot, projectKey);
  }

  private async refreshCurrent(panel: vscode.WebviewPanel): Promise<void> {
    if (this.panel !== panel || !this.state) return;
    const previousState = this.state;
    const previousWasLoading = previousState.loading;
    const previousWasRefreshing = previousState.model?.refreshing === true;
    const snapshot = this.actions.getCurrentSnapshot();
    const loadIntentRevision = this.beginPanelTransition(previousState);
    this.cancelCurrent();
    previousState.transitioning = true;
    try {
      await this.persistSnapshot(snapshot);
    } catch {
      if (this.panel === panel && this.state === previousState) {
        this.restoreInterruptedLoadAfterTransitionFailure(
          previousState,
          previousWasLoading,
          previousWasRefreshing,
          loadIntentRevision,
        );
      }
      this.showObservedMessage("snapshotSaveFailed", "error", "historyInsights.snapshotSaveFailed");
      return;
    }
    if (this.panel !== panel) return;
    const loadCancelledByUser = this.wasCancelledSince(loadIntentRevision);
    this.resetState(snapshot, loadCancelledByUser);
    if (!(await this.sendBootstrapForCurrentState("refreshCurrent.bootstrap", panel))) return;
    if (loadCancelledByUser) {
      await this.sendCancelledObserved(panel, this.state);
    } else {
      this.startLoad("current");
    }
  }

  private async applyFilters(
    panel: vscode.WebviewPanel,
    requestState: HistoryInsightsPanelState,
    filters: HistoryInsightsFilterApplication,
  ): Promise<void> {
    if (this.panel !== panel || !this.state) return;
    const previousState = this.state;
    const previousWasLoading = previousState.loading;
    const previousWasRefreshing = previousState.model?.refreshing === true;
    const rollbackSnapshot = previousState.snapshot;
    const loadIntentRevision = this.beginPanelTransition(previousState);
    this.cancelCurrent();
    previousState.transitioning = true;
    let prepared: HistoryInsightsPreparedFilterApplication | null = null;
    let snapshotPersisted = false;
    let rollbackFailed = false;
    try {
      prepared = await this.actions.prepareFilters(requestState.snapshot, filters);
      if (!prepared) throw new Error("History Insights filter application was rejected.");
      await this.persistSnapshot(prepared.snapshot);
      snapshotPersisted = true;
      await prepared.commitHistory?.();
    } catch {
      if (snapshotPersisted) {
        try {
          await this.persistSnapshot(rollbackSnapshot);
        } catch {
          rollbackFailed = true;
        }
      }
      if (this.panel === panel && this.state === previousState) {
        const errorMessage = panel.webview.postMessage({
          type: "filterApplyError",
          reason: "invalid",
          i18n: this.buildI18n(),
        });
        this.restoreInterruptedLoadAfterTransitionFailure(
          previousState,
          previousWasLoading,
          previousWasRefreshing,
          loadIntentRevision,
        );
        if (rollbackFailed) {
          this.showObservedMessage("filterRollbackFailed", "error", "historyInsights.filterRollbackFailed");
        }
        await errorMessage;
      } else if (rollbackFailed) {
        this.showObservedMessage("filterRollbackFailed", "error", "historyInsights.filterRollbackFailed");
      }
      return;
    }
    if (!prepared || this.panel !== panel) return;
    const loadCancelledByUser = this.wasCancelledSince(loadIntentRevision);
    this.resetState(prepared.snapshot, loadCancelledByUser);
    if (!(await this.sendBootstrapForCurrentState("applyFilters.bootstrap", panel))) return;
    if (loadCancelledByUser) {
      await this.sendCancelledObserved(panel, this.state);
    } else {
      this.startLoad("current");
    }
  }

  private async load(reason: HistoryInsightsLoadReason, userInitiated = false): Promise<void> {
    const panel = this.panel;
    const state = this.state;
    if (!panel || !state) return;
    if (userInitiated) {
      this.recordLoadIntent("resume");
      state.loadCancelledByUser = false;
    }
    if (state.loadCancelledByUser) return;
    if (state.loading || state.transitioning) {
      this.queuePendingLoad(state, reason);
      return;
    }
    if (state.pendingLoadReason) {
      if (state.pendingLoadReason === "refresh") reason = "refresh";
      state.pendingLoadReason = undefined;
    }
    const currentConfig = getConfig();
    const hasCurrentDateContext = this.hasCurrentDateContext(state.snapshot, currentConfig);
    const hasCurrentHistoryIndex = this.historyService.isCurrentIndexForConfig(currentConfig);
    if (hasCurrentHistoryIndex && !hasCurrentDateContext) {
      this.clearModelCapabilities(state);
      await panel.webview.postMessage({ type: "staleContext", i18n: this.buildI18n() });
      return;
    }
    const hideStaleModelWhileWaiting =
      !hasCurrentHistoryIndex && !hasCurrentDateContext && Boolean(state.model);
    const generation = state.generation;
    const cancellation = new vscode.CancellationTokenSource();
    state.loading = true;
    state.cancellation = cancellation;
    const progressNotification = this.createLongRunningProgressNotification(
      panel,
      state,
      generation,
      cancellation,
      reason === "refresh" && Boolean(state.model)
        ? t("historyInsights.checkingLatest")
        : t("historyInsights.preparing"),
    );
    state.progressNotification = progressNotification;
    try {
      if (hideStaleModelWhileWaiting) {
        this.clearModelCapabilities(state);
        await this.sendBootstrap();
        if (!this.requireActiveLoad(panel, state, generation, cancellation)) return;
      }
      if (reason === "refresh" && state.model) {
        state.model = { ...state.model, refreshing: true };
        await panel.webview.postMessage({
          type: "model",
          model: state.model,
          filters: this.buildFilterPresentation(state.snapshot),
          i18n: this.buildI18n(),
        });
        if (!this.requireActiveLoad(panel, state, generation, cancellation)) return;
      }
      const historyIndex = await this.awaitCurrentHistoryIndex(
        panel,
        state,
        generation,
        cancellation,
        state.requiresAuthoritativeHistoryIndex,
      );
      if (!this.requireActiveLoad(panel, state, generation, cancellation)) return;
      if (!historyIndex) throw new Error("Current History index is unavailable.");
      if (!this.hasCurrentDateContext(state.snapshot, historyIndex.config)) {
        this.clearModelCapabilities(state);
        await panel.webview.postMessage({ type: "staleContext", i18n: this.buildI18n() });
        return;
      }
      await this.sendProgress(panel, state, generation, {
        phase: "collectSessions",
        completed: 0,
        total: state.snapshot.references.length,
        cancellable: true,
        cacheHitCount: 0,
        rebuiltCount: 0,
      });
      if (!this.requireActiveLoad(panel, state, generation, cancellation)) return;
      const activeSessions = historyIndex.sessions;
      const resolved = resolveHistoryInsightsSnapshot(state.snapshot, activeSessions);
      state.snapshot = resolved.snapshot;
      const sessions = resolved.sessions;
      const projectContextBySessionKey = this.buildProjectContextMap(sessions);
      const sessionPresentationByIdentityKey = new Map(sessions.map((session) => [
        session.identityKey,
        { title: session.displayTitle, ...(session.lastActivityAtIso ? { lastActivityAtIso: session.lastActivityAtIso } : {}) },
      ]));
      const drillDownProjectKeys = buildDrillDownProjectKeys(state.snapshot, sessions);
      await this.persistSnapshot(state.snapshot);
      if (!this.requireActiveLoad(panel, state, generation, cancellation)) return;
      state.requiresAuthoritativeHistoryIndex = false;
      const stored = await this.analysisService.getStoredEntries(sessions, historyIndex.config);
      if (!this.requireActiveLoad(panel, state, generation, cancellation)) return;
      if (sessions.length > 0 && stored.entries.length === sessions.length) {
        const cachedModel = aggregateHistoryInsights({
          snapshot: state.snapshot,
          entries: stored.entries,
          cacheHitCount: stored.entries.length,
          rebuiltCount: 0,
          generatedAtIso: stored.generatedAtIso,
          refreshing: true,
          isFileHistoryPathSupported: (fsPath) => Boolean(this.resolveFileHistoryPath(fsPath)),
          isFileOpenSupported: (fsPath) => this.isFileOpenSupported(fsPath),
          projectContextBySessionKey,
          drillDownProjectKeys,
          unknownProjectLabel: t("historyInsights.fileProjectUnknown"),
          sessionPresentationByIdentityKey,
        });
        if (!this.hasCurrentDateContext(state.snapshot, getConfig())) {
          this.clearModelCapabilities(state);
          await panel.webview.postMessage({ type: "staleContext", i18n: this.buildI18n() });
          return;
        }
        state.filePathById = buildFilePathMap(
          stored.entries,
          new Set(cachedModel.files.map((file) => file.id)),
          (fsPath) => this.resolveFileHistoryPath(fsPath),
        );
        state.projectKeyById = buildProjectKeyMap(
          state.snapshot,
          new Set(cachedModel.projects.rows.map((project) => project.id)),
          drillDownProjectKeys,
        );
        state.sessionById = buildSessionMap(sessions, new Set(cachedModel.activeSessions.map((session) => session.id)));
        state.model = cachedModel;
        await panel.webview.postMessage({
          type: "model",
          model: cachedModel,
          filters: this.buildFilterPresentation(state.snapshot),
          i18n: this.buildI18n(),
        });
        if (!this.requireActiveLoad(panel, state, generation, cancellation)) return;
      }
      const analysisActiveSessions = this.historyService.isCurrentIndexForConfig(historyIndex.config)
        ? this.historyService.getIndex().sessions
        : activeSessions;
      const result = await this.analysisService.ensureEntries({
        sessions,
        activeSessions: analysisActiveSessions,
        config: historyIndex.config,
        token: cancellation.token,
        onProgress: (progress) => {
          if (this.isActiveLoad(panel, state, generation, cancellation)) {
            this.runObservedAsync(
              "progress",
              () => this.sendProgress(panel, state, generation, progress),
              panel,
            );
          }
        },
      });
      if (!this.requireActiveLoad(panel, state, generation, cancellation)) return;
      await this.sendProgress(panel, state, generation, {
        phase: "aggregate",
        completed: 0,
        total: sessions.length,
        cancellable: true,
        cacheHitCount: result.cacheHitCount,
        rebuiltCount: result.rebuiltCount,
      });
      if (!this.requireActiveLoad(panel, state, generation, cancellation)) return;
      const model = aggregateHistoryInsights({
        snapshot: state.snapshot,
        entries: result.entries,
        cacheHitCount: result.cacheHitCount,
        rebuiltCount: result.rebuiltCount,
        generatedAtIso: result.generatedAtIso,
        isFileHistoryPathSupported: (fsPath) => Boolean(this.resolveFileHistoryPath(fsPath)),
        isFileOpenSupported: (fsPath) => this.isFileOpenSupported(fsPath),
        projectContextBySessionKey,
        drillDownProjectKeys,
        unknownProjectLabel: t("historyInsights.fileProjectUnknown"),
        sessionPresentationByIdentityKey,
      });
      await this.sendProgress(panel, state, generation, {
        phase: "render",
        completed: sessions.length,
        total: sessions.length,
        cancellable: false,
        cacheHitCount: result.cacheHitCount,
        rebuiltCount: result.rebuiltCount,
      });
      if (!this.requireActiveLoad(panel, state, generation, cancellation)) return;
      if (!this.hasCurrentDateContext(state.snapshot, getConfig())) {
        this.clearModelCapabilities(state);
        await panel.webview.postMessage({ type: "staleContext", i18n: this.buildI18n() });
        return;
      }
      state.filePathById = buildFilePathMap(
        result.entries,
        new Set(model.files.map((file) => file.id)),
        (fsPath) => this.resolveFileHistoryPath(fsPath),
      );
      state.projectKeyById = buildProjectKeyMap(
        state.snapshot,
        new Set(model.projects.rows.map((project) => project.id)),
        drillDownProjectKeys,
      );
      state.sessionById = buildSessionMap(sessions, new Set(model.activeSessions.map((session) => session.id)));
      state.model = model;
      await panel.webview.postMessage({
        type: "model",
        model,
        filters: this.buildFilterPresentation(state.snapshot),
        i18n: this.buildI18n(),
      });
    } catch (error) {
      if (!this.ownsLoad(panel, state, generation, cancellation)) return;
      if (!this.hasCurrentDateContext(state.snapshot, getConfig())) {
        this.clearModelCapabilities(state);
        await panel.webview.postMessage({ type: "staleContext", i18n: this.buildI18n() });
      } else if (error instanceof SessionAnalysisCancelledError || cancellation.token.isCancellationRequested) {
        if (state.model?.refreshing) state.model = { ...state.model, refreshing: false };
        await panel.webview.postMessage({ type: "cancelled", i18n: this.buildI18n() });
      } else if (state.model?.refreshing) {
        state.model = { ...state.model, refreshing: false, stale: true };
        await panel.webview.postMessage({
          type: "model",
          model: state.model,
          filters: this.buildFilterPresentation(state.snapshot),
          i18n: this.buildI18n(),
        });
      } else {
        await panel.webview.postMessage({ type: "error", i18n: this.buildI18n() });
      }
    } finally {
      progressNotification.dispose();
      if (state.progressNotification === progressNotification) {
        state.progressNotification = undefined;
      }
      let shouldDrainPendingLoad = false;
      if (this.ownsLoad(panel, state, generation, cancellation)) {
        state.loading = false;
        state.cancellation = undefined;
        shouldDrainPendingLoad = true;
      }
      cancellation.dispose();
      if (shouldDrainPendingLoad) this.drainPendingLoad(state);
    }
  }

  private async awaitCurrentHistoryIndex(
    panel: vscode.WebviewPanel,
    state: HistoryInsightsPanelState,
    generation: number,
    cancellation: vscode.CancellationTokenSource,
    requireAuthoritative: boolean,
  ): Promise<HistoryInsightsHistoryIndexSnapshot | null> {
    if (!this.isActiveLoad(panel, state, generation, cancellation)) {
      throw new SessionAnalysisCancelledError();
    }
    let cancellationSubscription: vscode.Disposable | undefined;
    const cancellationWait = new Promise<never>((_resolve, reject) => {
      cancellationSubscription = cancellation.token.onCancellationRequested(() => {
        reject(new SessionAnalysisCancelledError());
      });
    });
    try {
      return await Promise.race([
        this.actions.waitForCurrentHistoryIndex(
          () => this.isActiveLoad(panel, state, generation, cancellation),
          requireAuthoritative,
        ),
        cancellationWait,
      ]);
    } finally {
      cancellationSubscription?.dispose();
    }
  }

  private hasCurrentDateContext(
    snapshot: HistoryInsightsSnapshot,
    config: CodexHistoryViewerConfig,
  ): boolean {
    const dateTimeSettingsKey = getDateTimeSettingsKey(resolveDateTimeSettings());
    return snapshot.dateBasis === config.historyDateBasis && snapshot.dateTimeSettingsKey === dateTimeSettingsKey;
  }

  private clearModelCapabilities(state: HistoryInsightsPanelState): void {
    state.model = undefined;
    state.filePathById.clear();
    state.projectKeyById.clear();
    state.sessionById.clear();
  }

  private buildProjectContextMap(
    sessions: readonly SessionSummary[],
  ): ReadonlyMap<string, import("./historyInsightsProjectContext").HistoryInsightsAggregationProjectContext> {
    const contexts = new Map<string, import("./historyInsightsProjectContext").HistoryInsightsAggregationProjectContext>();
    for (const session of sessions) {
      const cwd = typeof session.meta.cwd === "string" ? session.meta.cwd.trim() : "";
      const context = buildHistoryInsightsProjectContext(cwd, this.projectAssociationStore, this.actions.getProjectDisplayName);
      if (!context) continue;
      const resolved = {
        ...context,
        displayName: context.displayName || t("historyInsights.fileProjectUnknown"),
      };
      contexts.set(session.cacheKey, resolved);
      contexts.set(session.identityKey, resolved);
    }
    return contexts;
  }

  private isCurrent(
    panel: vscode.WebviewPanel,
    state: HistoryInsightsPanelState,
    generation: number,
  ): boolean {
    return this.panel === panel && this.state === state && state.generation === generation;
  }

  private ownsLoad(
    panel: vscode.WebviewPanel,
    state: HistoryInsightsPanelState,
    generation: number,
    cancellation: vscode.CancellationTokenSource,
  ): boolean {
    return this.isCurrent(panel, state, generation) && state.cancellation === cancellation;
  }

  private isActiveLoad(
    panel: vscode.WebviewPanel,
    state: HistoryInsightsPanelState,
    generation: number,
    cancellation: vscode.CancellationTokenSource,
  ): boolean {
    return this.ownsLoad(panel, state, generation, cancellation) &&
      !cancellation.token.isCancellationRequested;
  }

  private requireActiveLoad(
    panel: vscode.WebviewPanel,
    state: HistoryInsightsPanelState,
    generation: number,
    cancellation: vscode.CancellationTokenSource,
  ): boolean {
    if (!this.ownsLoad(panel, state, generation, cancellation)) return false;
    if (cancellation.token.isCancellationRequested) throw new SessionAnalysisCancelledError();
    return true;
  }

  private createLongRunningProgressNotification(
    panel: vscode.WebviewPanel,
    state: HistoryInsightsPanelState,
    generation: number,
    cancellation: vscode.CancellationTokenSource,
    title: string,
  ): vscode.Disposable {
    return new DelayedProgressNotification({
      delayMs: LONG_RUNNING_PROGRESS_DELAY_MS,
      isActive: () => this.isActiveLoad(panel, state, generation, cancellation),
      onCancel: () => this.requestCurrentCancellation(),
      show: (task) => vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title,
          cancellable: true,
        },
        (_progress, token) => task(token),
      ),
    });
  }

  private beginPanelTransition(state: HistoryInsightsPanelState | null): number {
    if (state) state.loadCancelledByUser = false;
    return this.loadIntentTracker.captureRevision();
  }

  private restoreInterruptedLoadAfterTransitionFailure(
    state: HistoryInsightsPanelState,
    wasLoading: boolean,
    wasRefreshing: boolean,
    loadIntentRevision: number,
  ): void {
    const cancelledDuringTransition = this.wasCancelledSince(loadIntentRevision);
    state.loadCancelledByUser = cancelledDuringTransition;
    if (state.model?.refreshing) {
      state.model = { ...state.model, refreshing: false };
    }
    if (wasLoading && !cancelledDuringTransition) {
      this.queuePendingLoad(state, wasRefreshing ? "refresh" : "initial");
    }
    state.transitioning = false;
    this.drainPendingLoad(state);
  }

  private wasCancelledSince(revision: number): boolean {
    return this.loadIntentTracker.wasCancelledSince(revision);
  }

  private recordLoadIntent(intent: HistoryInsightsLoadIntent): void {
    this.loadIntentTracker.record(intent);
  }

  private requestCurrentCancellation(): void {
    if (!this.state) return;
    const state = this.state;
    const cancellation = state.cancellation;
    this.recordLoadIntent("cancel");
    state.loadCancelledByUser = true;
    state.pendingLoadReason = undefined;
    state.progressNotification?.dispose();
    state.progressNotification = undefined;
    if (cancellation) {
      cancellation.cancel();
    } else if (this.panel) {
      const panel = this.panel;
      this.runObservedAsync("cancelled", () => this.sendCancelled(panel, state), panel);
    }
  }

  private queuePendingLoad(state: HistoryInsightsPanelState, reason: HistoryInsightsLoadReason): void {
    if (state.pendingLoadReason !== "refresh" || reason === "refresh") {
      state.pendingLoadReason = reason;
    }
  }

  private drainPendingLoad(state: HistoryInsightsPanelState): void {
    if (this.state !== state || !this.panel || state.loading || state.transitioning) return;
    const reason = state.pendingLoadReason;
    if (!reason) return;
    state.pendingLoadReason = undefined;
    this.startLoad(reason);
  }

  private async sendCancelled(
    panel: vscode.WebviewPanel,
    state: HistoryInsightsPanelState | null,
  ): Promise<void> {
    if (!state || this.panel !== panel || this.state !== state) return;
    await panel.webview.postMessage({ type: "cancelled", i18n: this.buildI18n() });
  }

  private cancelCurrent(): void {
    const state = this.state;
    state?.progressNotification?.dispose();
    if (state) state.progressNotification = undefined;
    state?.cancellation?.cancel();
    state?.cancellation?.dispose();
    if (!state) return;
    state.cancellation = undefined;
    state.loading = false;
  }

  private async persistSnapshot(snapshot: HistoryInsightsSnapshot): Promise<void> {
    const pending = this.snapshotPersistence.then(() => this.workspaceState.update(SNAPSHOT_STATE_KEY, snapshot));
    this.snapshotPersistence = pending.catch(() => undefined);
    await pending;
  }

  private enqueuePanelTransition<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.panelTransition.then(operation, operation);
    this.panelTransition = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async sendBootstrap(): Promise<void> {
    if (!this.panel || !this.state || !this.ready) return;
    await this.panel.webview.postMessage({
      type: "bootstrap",
      i18n: this.buildI18n(),
      language: resolveLanguage(),
      extensionIcon: this.buildExtensionIcon(this.panel.webview),
      snapshotId: this.state.snapshot.id,
      filters: this.buildFilterPresentation(this.state.snapshot),
      applyToHistoryPreference: this.applyPreferenceStore.current,
    });
  }

  private async sendBootstrapForCurrentState(
    scope: string,
    panel: vscode.WebviewPanel,
  ): Promise<boolean> {
    const state = this.state;
    if (!state || this.panel !== panel) return false;
    try {
      await this.sendBootstrap();
    } catch (error) {
      this.reportObservedAsyncFailure(
        scope,
        error,
        panel,
        state,
        state.generation,
        "historyInsights.actionFailed",
      );
      return false;
    }
    return this.panel === panel && this.state === state;
  }

  private async sendCancelledObserved(
    panel: vscode.WebviewPanel,
    state: HistoryInsightsPanelState | null,
  ): Promise<void> {
    try {
      await this.sendCancelled(panel, state);
    } catch (error) {
      this.logger?.debug(`historyInsights.cancelled failed error=${sanitizeDebugError(error)}`);
    }
  }

  private async sendProgress(
    panel: vscode.WebviewPanel,
    state: HistoryInsightsPanelState,
    generation: number,
    progress: SessionAnalysisProgress,
  ): Promise<void> {
    if (!this.ready || !this.isCurrent(panel, state, generation)) return;
    await panel.webview.postMessage({ type: "progress", progress, i18n: this.buildI18n() });
  }

  private startLoad(reason: HistoryInsightsLoadReason, userInitiated = false): void {
    const panel = this.panel;
    this.runObservedAsync(
      `load.${reason}`,
      () => this.load(reason, userInitiated),
      panel,
      "historyInsights.error",
    );
  }

  private runObservedAsync(
    scope: string,
    operation: () => PromiseLike<unknown>,
    panel: vscode.WebviewPanel | null,
    notificationKey?: string,
    state: HistoryInsightsPanelState | null = this.state,
  ): void {
    const generation = state?.generation;
    let pending: PromiseLike<unknown>;
    try {
      pending = operation();
    } catch (error) {
      this.reportObservedAsyncFailure(scope, error, panel, state, generation, notificationKey);
      return;
    }
    void Promise.resolve(pending).catch((error) => {
      this.reportObservedAsyncFailure(scope, error, panel, state, generation, notificationKey);
    });
  }

  private reportObservedAsyncFailure(
    scope: string,
    error: unknown,
    panel: vscode.WebviewPanel | null,
    state: HistoryInsightsPanelState | null,
    generation: number | undefined,
    notificationKey?: string,
  ): void {
    this.logger?.debug(`historyInsights.${scope} failed error=${sanitizeDebugError(error)}`);
    if (
      !notificationKey ||
      !panel ||
      !state ||
      this.panel !== panel ||
      this.state !== state ||
      generation === undefined ||
      this.state.generation !== generation ||
      state.generation !== generation ||
      (scope.startsWith("load.") && state.loadCancelledByUser)
    ) {
      return;
    }
    this.showObservedMessage(`${scope}.notification`, "error", notificationKey);
  }

  private showObservedMessage(
    scope: string,
    severity: "error" | "warning",
    key: string,
  ): void {
    this.runObservedAsync(
      `notification.${scope}`,
      () => severity === "error"
        ? vscode.window.showErrorMessage(t(key))
        : vscode.window.showWarningMessage(t(key)),
      null,
    );
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = randomNonce();
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "historyInsights.css"));
    const fileKindCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "sharedFileKind.css"));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "historyInsights.js"));
    const iconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "resources", "extension-icon.svg"));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="${escapeHtml(resolveLanguage())}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${fileKindCssUri}">
  <link rel="stylesheet" href="${cssUri}">
  <title>${escapeHtml(t("historyInsights.title"))}</title>
</head>
<body>
  <main id="app">
    <section class="statePanel" aria-live="polite">
      <div class="statePanelTitleRow"><span class="statePanelIcon" style="--state-panel-icon:url('${iconUri}')"></span><h1>${escapeHtml(t("historyInsights.title"))}</h1></div>
      <p>${escapeHtml(t("historyInsights.preparing"))}</p>
      <p class="muted">${escapeHtml(t("historyInsights.progress.loadCache"))}</p>
    </section>
  </main>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }

  private buildExtensionIcon(webview: vscode.Webview): string {
    return String(webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "resources", "extension-icon.svg")));
  }

  private buildI18n(): Record<string, string> {
    const keys = [
      "title", "preparing", "refresh", "refreshHint", "refreshCurrent", "refreshCurrentHint", "cancel", "retry", "backToHistory", "cancelled",
      "error", "staleContext", "lastUpdated", "dataQuality", "unknown", "lowerBoundAria", "notifications", "sessions", "userRequests",
      "inputTokens", "outputTokens", "totalTokens", "distinctFiles", "linesAdded", "linesRemoved", "changeEvents", "reasoningOutputTokens", "activity",
      "activitySessions", "activityRequests", "activityTokens", "activityLines", "activityMetric", "activityGroupUsage", "activityGroupFileChanges",
      "activityInputTokens", "activityOutputTokens", "activityReasoningTokens", "activityTotalTokens", "activityFiles", "activityLinesAdded", "activityLinesRemoved", "activityChangedLines",
      "activityCoverage", "activityCoveragePartial", "activityCoverageUnavailable", "activityYear", "activityMonth", "activityDay", "showInHistory", "topFiles",
      "fileSessions", "fileEvents", "fileListLabel", "fileSelectHint", "openFileHistory", "openFile", "fileHistoryUnavailable", "fileOpenUnavailable", "breakdown", "breakdownMetric", "breakdownGroupUnit", "breakdownOmitted", "breakdownValue", "breakdownPercentage", "sources", "models",
      "modelSessionCountHint", "modelEffortBreakdown", "modelEffortExpand", "modelEffortCollapse", "modelEffortPanelLabel", "modelEffortCoverage", "modelEffortOmitted",
      "projects", "searchProject", "tools", "toolCalls", "toolSessions", "toolMetric", "toolOmitted",
      "activeSessions", "activeSessionMetric", "activeSessionUserRequests", "activeSessionToolCalls", "activeSessionReasoningTokens", "activeSessionTotalTokens",
      "activeSessionChangedLines", "activeSessionOpen", "activeSessionOpenHint", "sessionOpenFailed",
      "usageDetails", "inputCacheDetails", "messageComposition", "turnStates", "fileKindBreakdown", "fileKindBreakdownValue",
      "detail.cachedInputTokens", "detail.cacheReadInputTokens", "detail.cacheCreationInputTokens", "detail.reasoningOutputTokens",
      "detail.userMessages", "detail.assistantMessages", "detail.developerMessages", "detail.toolCalls", "detail.toolOutputs",
      "detail.turns", "detail.completedTurns", "detail.interruptedTurns", "detail.rolledBackTurns",
      "emptyTitle", "emptyHint", "qualityTarget", "qualityAnalyzed", "qualityCacheHits",
      "qualityRebuilt", "qualityFailed", "qualityUnsupported", "qualityPartial", "qualityToken", "qualityFile", "qualityModel", "qualityTool", "progressCount",
      "qualityCoverageBadge", "qualityExplanation", "qualityFileExplanation", "qualityNumericOverflow",
      "qualityAnalysisGroup", "qualityIssuesGroup", "qualityAvailabilityGroup",
      "source.codex", "source.claude", "checkingLatest", "showingPrevious",
      "filters", "filterSource", "filterDate", "filterLocation", "filterProject", "filterProjectScope", "filterTags",
      "filterAll", "filterNone", "filterNotApplicable", "filterScopeAll", "filterScopeCurrentGroup", "filterEditHint",
      "filterSelectAll", "filterSelectionRequired", "filterRemoveSelection", "filterMoreSelections",
      "filterAllProjects", "filterAllProjectsHint", "filterNoTagConstraint",
      "filterFrom", "filterTo", "filterApply", "filterSearchProject", "filterNoOptions", "filterOpen", "filterOpenHint", "filterClose",
      "filterDateInvalidError", "filterDateOrderError", "filterValidationError", "filterApplyError", "filterStaleError", "filterTagCount",
      "filterProjectsNone", "filterProjectGroupCount", "filterProjectGroupAndMemberCount", "filterProjectMembers", "filterCurrentProject",
      "filterProjectSectionCurrent", "filterProjectSectionRelated", "filterProjectSectionProjects",
      "filterApplyToHistory", "filterApplyToHistorySelectedHint", "filterApplyToHistoryUnselectedHint", "filterPreferenceError",
      "filter.source", "filter.date", "filter.dateRangeValue", "filter.openStart", "filter.openEnd", "filter.location", "filter.project", "filter.scope", "filter.tags",
      "filterLocationActive", "filterLocationAll", "filterLocationArchived", "filterLocationActiveChoice", "filterLocationArchivedChoice",
      "fileSort", "fileSortSessions", "fileSortEvents", "fileSortLines", "fileSortRecent", "fileSortName", "fileSortAscending", "fileSortDescending", "fileSortDirectionHint",
      "fileProjectUnknown", "fileProjectHint", "fileOtherProject", "fileOtherProjects", "fileLastChanged", "fileRowAria",
      "fileKind.pdf", "fileKind.word", "fileKind.excel", "fileKind.powerpoint", "fileKind.text", "fileKind.code", "fileKind.archive", "fileKind.image", "fileKind.generic",
      "progress.loadCache", "progress.collectSessions", "progress.analyzeSessions", "progress.aggregate", "progress.render",
    ];
    return Object.fromEntries(keys.map((key) => [key, t(`historyInsights.${key}`)]));
  }

  private resolveFileHistoryPath(recordedPath: string): string | null {
    const directUri = vscode.Uri.file(recordedPath);
    if (vscode.workspace.getWorkspaceFolder(directUri)) return directUri.fsPath;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const mappings = this.projectAssociationStore.getRelocationSourcesForTargetCwd(folder.uri.fsPath).map((source) => ({
        sourceCwd: source.sourceCwd,
        targetCwd: folder.uri.fsPath,
      }));
      const mapped = mapAssociatedProjectPath(recordedPath, mappings);
      if (!mapped) continue;
      const mappedUri = vscode.Uri.file(mapped.fsPath);
      if (vscode.workspace.getWorkspaceFolder(mappedUri)) return mappedUri.fsPath;
    }
    return null;
  }

  private isFileOpenSupported(recordedPath: string): boolean {
    const resolved = this.resolveFileHistoryPath(recordedPath);
    if (!resolved) return false;
    try {
      return fs.statSync(resolved).isFile();
    } catch {
      return false;
    }
  }

  private buildFilterPresentation(snapshot: HistoryInsightsSnapshot): HistoryInsightsFilterPresentation {
    const config = getConfig();
    const codexAvailable = config.enableCodexSource || config.enableCodexArchivedSessions;
    const claudeAvailable = config.enableClaudeSource;
    const projectSelection = snapshot.descriptor.projects;
    const selections = new Map<string, HistoryInsightsFilterSelection>();
    const option = (
      filter: HistoryInsightsEditableFilter,
      identity: string,
      label: string,
      selected: boolean,
      selection: HistoryInsightsFilterSelection,
      presentation: Partial<HistoryInsightsFilterOption> = {},
    ) => {
      const id = buildHistoryInsightsEntityId(`filter\0${filter}\0${identity}`);
      selections.set(buildHistoryInsightsFilterOptionMapKey(filter, id), selection);
      return { id, label, selected, ...presentation };
    };
    const sourceValues = codexAvailable && claudeAvailable
      ? (["codex", "claude"] as const)
      : codexAvailable
        ? (["codex"] as const)
        : claudeAvailable
          ? (["claude"] as const)
          : ([snapshot.descriptor.source === "claude" ? "claude" : "codex"] as const);
    const sourceOptions = sourceValues.map((source) => option(
      "source",
      source,
      t(`historyInsights.source.${source}`),
      snapshot.descriptor.source === "all" || source === snapshot.descriptor.source,
      { filter: "source", source },
      { value: source },
    ));
    const archiveValues = config.enableCodexArchivedSessions
      ? (["activeOnly", "archivedOnly"] as const)
      : (["activeOnly"] as const);
    const archiveOptions = archiveValues.map((archiveLocation) => option(
      "archiveLocation",
      archiveLocation,
      t(`historyInsights.${archiveLocation === "activeOnly" ? "filterLocationActiveChoice" : "filterLocationArchivedChoice"}`),
      snapshot.descriptor.archiveLocation === "all" || archiveLocation === snapshot.descriptor.archiveLocation,
      { filter: "archiveLocation", archiveLocation },
      { value: archiveLocation },
    ));
    const projectOptions: HistoryInsightsFilterOption[] = [option(
      "projects",
      "all",
      t("historyInsights.filterAllProjects"),
      projectSelection.kind === "all",
      { filter: "projects", projects: { kind: "all" } },
      { kind: "all", value: "all", description: t("historyInsights.filterAllProjectsHint") },
    )];
    const selectedProjectKeys = new Set(
      projectSelection.kind === "groups"
        ? projectSelection.groups.map((group) => group.canonicalGroupKey)
        : [],
    );
    const currentCwd = this.actions.getCurrentProjectCwd();
    const currentProjectKey = currentCwd
      ? (this.projectAssociationStore.getGroupCanonicalProjectKey(currentCwd) ?? normalizeProjectKey(currentCwd))
      : "";
    const projectGroups = new Map<string, { representativeCwd: string; members: Set<string>; lastActivity: number }>();
    const appendProjectCandidate = (cwd: string, lastActivity: number): void => {
      const projectKey = this.projectAssociationStore.getGroupCanonicalProjectKey(cwd) ?? normalizeProjectKey(cwd);
      if (!projectKey) return;
      const existing = projectGroups.get(projectKey);
      if (existing) {
        existing.members.add(cwd);
        existing.lastActivity = Math.max(existing.lastActivity, lastActivity);
        return;
      }
      projectGroups.set(projectKey, { representativeCwd: cwd, members: new Set([cwd]), lastActivity });
    };
    for (const session of this.historyService.getIndex().sessions) {
      const cwd = typeof session.meta.cwd === "string" ? session.meta.cwd.trim() : "";
      if (cwd) {
        const lastActivity = Date.parse(session.lastActivityAtIso ?? session.startedAtIso ?? "");
        appendProjectCandidate(cwd, Number.isFinite(lastActivity) ? lastActivity : 0);
      }
    }
    for (const association of this.projectAssociationStore.getAll()) {
      appendProjectCandidate(association.targetCwd, 0);
      appendProjectCandidate(association.sourceCwd, 0);
    }
    if (projectSelection.kind === "groups") {
      for (const group of projectSelection.groups) appendProjectCandidate(group.representativeCwd, Number.MAX_SAFE_INTEGER);
    }
    if (currentCwd) appendProjectCandidate(currentCwd, Number.MAX_SAFE_INTEGER - 1);
    const sortedProjectGroups = Array.from(projectGroups.entries()).sort(([leftKey, left], [rightKey, right]) => {
      const leftSection = leftKey === currentProjectKey ? 0 : left.members.size > 1 ? 1 : 2;
      const rightSection = rightKey === currentProjectKey ? 0 : right.members.size > 1 ? 1 : 2;
      const leftSelected = selectedProjectKeys.has(leftKey) ? 0 : 1;
      const rightSelected = selectedProjectKeys.has(rightKey) ? 0 : 1;
      return leftSection - rightSection || leftSelected - rightSelected || right.lastActivity - left.lastActivity || leftKey.localeCompare(rightKey);
    });
    const requiredProjectKeys = new Set([
      ...selectedProjectKeys,
      ...(currentProjectKey ? [currentProjectKey] : []),
    ]);
    const visibleProjectKeys = selectVisibleProjectOptionKeys(
      sortedProjectGroups.map(([projectKey]) => projectKey),
      requiredProjectKeys,
      250,
    );
    for (const [projectKey, group] of sortedProjectGroups) {
      if (!visibleProjectKeys.has(projectKey)) continue;
      const representativeCwd = this.projectAssociationStore.getRepresentativeTargetCwd(projectKey) ?? group.representativeCwd;
      const memberLabels = Array.from(group.members)
        .map((cwd) => this.actions.getProjectDisplayName(cwd))
        .filter((label, index, labels) => labels.indexOf(label) === index);
      const memberCount = group.members.size;
      const description = memberCount > 1
        ? t("historyInsights.filterProjectMembers", memberCount, memberLabels.slice(0, 3).join(", "))
        : undefined;
      projectOptions.push(option(
        "projects",
        projectKey,
        this.actions.getProjectDisplayName(representativeCwd),
        selectedProjectKeys.has(projectKey),
        { filter: "projects", projects: { kind: "group", group: { canonicalGroupKey: projectKey, representativeCwd } } },
        {
          kind: "group",
          description,
          searchText: [this.actions.getProjectDisplayName(representativeCwd), ...memberLabels].join(" "),
          memberCount,
          current: projectKey === currentProjectKey,
          section: projectKey === currentProjectKey ? "current" : memberCount > 1 ? "related" : "projects",
        },
      ));
    }
    const selectedTagKeys = new Set(snapshot.descriptor.tags.map((tag) => tag.trim().toLocaleLowerCase()).filter(Boolean));
    const tagCandidates = [
      ...snapshot.descriptor.tags,
      ...this.annotationStore.listTagStats().map((entry) => entry.tag),
    ];
    const seenTagKeys = new Set<string>();
    const tagOptions: HistoryInsightsFilterOption[] = [];
    for (const tagValue of tagCandidates) {
      const tag = tagValue.trim();
      const tagKey = tag.toLocaleLowerCase();
      if (!tagKey || seenTagKeys.has(tagKey)) continue;
      seenTagKeys.add(tagKey);
      tagOptions.push(option(
        "tags",
        tagKey,
        `#${tag}`,
        selectedTagKeys.has(tagKey),
        { filter: "tags", tags: [tag] },
      ));
      if (tagOptions.length >= 500) break;
    }
    if (this.state?.snapshot.id === snapshot.id) this.state.filterSelectionByOptionId = selections;
    const selectedProjectMemberCount = projectOptions
      .filter((candidate) => candidate.kind === "group" && candidate.selected)
      .reduce((sum, candidate) => sum + Math.max(1, candidate.memberCount ?? 0), 0);
    return {
      source: snapshot.descriptor.source,
      dateRange: snapshot.descriptor.dateRange,
      archiveLocation: snapshot.descriptor.archiveLocation,
      projectsLabel: projectSelection.kind === "all"
        ? t("historyInsights.filterAll")
        : projectSelection.kind === "none"
          ? t("historyInsights.filterProjectsNone")
          : projectSelection.groups.length === 1
            ? this.actions.getProjectDisplayName(projectSelection.groups[0]!.representativeCwd)
            : t("historyInsights.filterProjectGroupAndMemberCount", projectSelection.groups.length, selectedProjectMemberCount),
      projectSelectionKind: projectSelection.kind,
      tags: snapshot.descriptor.tags.slice(0, 12),
      canEditSource: sourceOptions.length > 1,
      canEditArchiveLocation: config.enableCodexArchivedSessions,
      options: {
        source: sourceOptions,
        archiveLocation: archiveOptions,
        projects: projectOptions,
        tags: tagOptions,
      },
    };
  }
}

function buildFilePathMap(
  entries: readonly import("../analysis/sessionAnalysisTypes").SessionAnalysisEntry[],
  allowedIds: ReadonlySet<string>,
  resolvePath: (recordedPath: string) => string | null,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of entries) {
    for (const file of entry.fileChangeStats.files) {
      const id = buildHistoryInsightsEntityId(file.normalizedPath);
      if (!allowedIds.has(id)) continue;
      const resolved = resolvePath(file.normalizedPath);
      if (resolved) map.set(id, resolved);
    }
  }
  return map;
}

function buildProjectKeyMap(
  snapshot: HistoryInsightsSnapshot,
  allowedIds: ReadonlySet<string>,
  drillDownProjectKeys: ReadonlySet<string>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const reference of snapshot.references) {
    if (!drillDownProjectKeys.has(reference.projectKey)) continue;
    const id = buildHistoryInsightsEntityId(reference.projectKey);
    if (allowedIds.has(id)) map.set(id, reference.projectKey);
  }
  return map;
}

function buildSessionMap(
  sessions: readonly SessionSummary[],
  allowedIds: ReadonlySet<string>,
): Map<string, SessionSummary> {
  const map = new Map<string, SessionSummary>();
  for (const session of sessions) {
    const id = buildHistoryInsightsEntityId(`session\0${session.identityKey}`);
    if (allowedIds.has(id)) map.set(id, session);
  }
  return map;
}

function buildDrillDownProjectKeys(
  snapshot: HistoryInsightsSnapshot,
  sessions: readonly SessionSummary[],
): ReadonlySet<string> {
  const byCacheKey = new Map(sessions.map((session) => [session.cacheKey, session]));
  const byIdentityKey = new Map(sessions.map((session) => [session.identityKey, session]));
  const projectKeys = new Set<string>();
  for (const reference of snapshot.references) {
    const cacheMatch = byCacheKey.get(reference.cacheKey);
    const session = cacheMatch?.identityKey === reference.identityKey
      ? cacheMatch
      : byIdentityKey.get(reference.identityKey);
    const cwd = typeof session?.meta.cwd === "string" ? session.meta.cwd.trim() : "";
    if (!cwd) continue;
    if (reference.projectKey) projectKeys.add(reference.projectKey);
  }
  return projectKeys;
}

function sanitizeId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  return /^[a-f0-9]{24}$/u.test(id) ? id : "";
}

function sanitizeRestoreId(value: unknown, key: string): string {
  if (!value || typeof value !== "object") return "";
  const raw = (value as Record<string, unknown>)[key];
  const id = typeof raw === "string" ? raw.trim() : "";
  return /^[a-z0-9-]{1,128}$/u.test(id) ? id : "";
}

function sanitizePreferenceRevision(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 1 ? Number(value) : null;
}

function sanitizeYmd(value: unknown): string {
  const ymd = typeof value === "string" ? value.trim() : "";
  return /^\d{4}-\d{2}-\d{2}$/u.test(ymd) ? ymd : "";
}

function resolveLanguage(): string {
  return resolveUiLanguage();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function randomNonce(): string {
  return Array.from({ length: 32 }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 62)]).join("");
}
