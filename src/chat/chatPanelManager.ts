import * as path from "node:path";
import * as vscode from "vscode";
import type { HistoryService } from "../services/historyService";
import type { SessionAnnotationStore } from "../services/sessionAnnotationStore";
import type { PinStore } from "../services/pinStore";
import type { ProjectAssociationStore } from "../services/projectAssociationStore";
import {
  GLOBAL_SEARCH_HISTORY_PROJECT_KEY,
  buildSearchHistoryEntryKey,
  normalizeSearchHistoryProjectKey,
  type SearchHistoryEntry,
  type SearchHistoryStore,
} from "../services/searchHistoryStore";
import {
  buildBookmarkKey,
  type BookmarkStore,
  type BookmarkTarget,
  type BookmarkTargetKind,
} from "../services/bookmarkStore";
import type { ChatOpenPositionStore } from "../services/chatOpenPositionStore";
import type { SessionSummary } from "../sessions/sessionTypes";
import { buildSessionSummary } from "../sessions/sessionSummary";
import { isSessionProtocolContextTitle } from "../sessions/sessionTitleResolver";
import { elapsedMs, formatDebugFields, nowMs, safeDebugBasename, sanitizeDebugError } from "../services/debugLogUtils";
import { normalizeCacheKey, normalizeProjectKey } from "../utils/fsUtils";
import { collectLocalLinkBaseDirs, openLinkedFileInEditor, resolveLocalFileLinkTarget } from "../utils/localFileLinks";
import { buildChatPatchEntryDetails, buildChatSessionModel, type ChatPatchEntryDetailTarget } from "./chatModelBuilder";
import { sanitizeAttachmentForChannel } from "./chatAttachments";
import { t } from "../i18n";
import { getConfig } from "../settings";
import { resolveDateTimeSettings } from "../utils/dateTimeSettings";
import { truncateByDisplayWidth } from "../utils/textUtils";
import type { DebugLogger } from "../services/logger";
import type {
  ChatAttachment,
  ChatDocumentAttachment,
  ChatDocumentPayload,
  ChatImageAttachment,
  ChatMessageItem,
  ChatPatchChangeType,
  ChatPatchEntry,
  ChatPatchGroupItem,
  ChatSessionModel,
  ChatTimelineItem,
  ChatToolItem,
  ChatTurnSummary,
  ChatWebviewPathMode,
} from "./chatTypes";
import type { SessionPageSearchSeed } from "../tree/treeNodes";
import type { FileChangeHistoryRevealTarget } from "../fileHistory/fileChangeHistoryTypes";
import {
  buildClaudeBranchChoicePage,
  buildClaudeBranchOverlayPage,
  buildClaudeChatBranchNavigationModel,
  isClaudeBranchTargetInActiveLineage,
  type ClaudeBranchNavigationService,
  type ClaudeBranchNavigationSnapshot,
} from "../branchMap/claudeBranchNavigationService";
import {
  buildCodexForkBranchChoicePage,
  buildCodexForkBranchOverlayPage,
  buildCodexForkChatBranchNavigationModel,
  CodexForkNavigationSupersededError,
  isCodexForkTargetInActiveLineage,
  type CodexForkNavigationService,
} from "../branchMap/codexForkNavigationService";
import type { CodexForkNavigationSnapshot } from "../branchMap/codexForkNavigationTypes";
import type { CodexAgentRunsService } from "../agents/codexAgentRunsService";
import type {
  CodexAgentComponent,
  CodexAgentRunsWebviewModel,
  CodexAgentRunsWebviewNode,
} from "../agents/codexAgentRunsTypes";
import type { SessionIconResolver } from "../ui/sessionIconResolver";

type SaveableChatImage = {
  src: string;
  mimeType: string;
  label: string;
};
type SaveableChatDocument = {
  payload: ChatDocumentPayload;
  mimeType?: string;
  label: string;
  documentKind: ChatDocumentAttachment["documentKind"];
};
type ChatSessionDetailMode = "summary" | "full";
type ChatPerformanceStats = {
  fileSizeBytes: number;
  itemCount: number;
  messageChars: number;
  diffGroupCount: number;
  diffEntryCount: number;
  diffLineEstimate: number;
  imageCount: number;
};
type ChatBookmarkState = {
  model: ChatSessionModel;
  bookmarkKeys: string[];
};

type MissingSessionHandler = (fsPath: string) => Promise<void> | void;
export type ChatPanelKind = "reusable" | "session" | "branch";
export type ChatWebviewAutoRefreshMode = "off" | "preserve" | "follow";
type ChatPanelState = {
  fsPath: string;
  revealMessageIndex?: number;
  revealTarget?: FileChangeHistoryRevealTarget;
  restoreScrollY?: number;
  restoreTopMessageIndex?: number;
  pageSearchSeed?: SessionPageSearchSeed;
  sessionCwd?: string;
  sessionDisplayCwd?: string;
  kind: ChatPanelKind;
  autoRefreshMode: ChatWebviewAutoRefreshMode;
  detailMode?: ChatSessionDetailMode;
  pathMode?: ChatWebviewPathMode;
  pathModeEnabled?: boolean;
  pendingAutoRefresh: boolean;
};
type SearchHistoryWebviewCandidate = SearchHistoryEntry & { key: string };
type ExistingChatPanel = { panel: vscode.WebviewPanel; kind: ChatPanelKind };
type ChatPanelRestoreState = {
  version: 1;
  kind: ChatPanelKind;
  fsPath: string;
  revealMessageIndex?: number;
  revealTarget?: FileChangeHistoryRevealTarget;
  scrollY?: number;
  topMessageIndex?: number;
  autoRefreshMode: ChatWebviewAutoRefreshMode;
  detailMode?: ChatSessionDetailMode;
  pathMode?: ChatWebviewPathMode;
};
type CodexAgentRunsPanelSnapshot = {
  generation: number;
  currentIdentityKey: string;
  relationKey: string;
  navigationTargetByNodeId: ReadonlyMap<string, string>;
  pinTargetByNodeId: ReadonlyMap<string, string>;
  targets: ReadonlyMap<string, SessionSummary>;
  pinTargets: ReadonlyMap<string, SessionSummary>;
};
type BranchNavigationSnapshot = ClaudeBranchNavigationSnapshot | CodexForkNavigationSnapshot;
type BranchSwitchRequest = {
  state: ChatPanelState;
  snapshot: BranchNavigationSnapshot;
  generation: number;
  historyGeneration: number;
  requestSequence: number;
};
type ChatSessionDataOptions = {
  restoreScrollY?: number;
  restoreSelectedMessageIndex?: number;
  preserveUiState?: boolean;
  autoScrollToBottom?: boolean;
  detailMode?: ChatSessionDetailMode;
  stateOverride?: ChatPanelState;
  branchGeneration?: number;
  transitionDirection?: "previous" | "next" | "direct";
  suppressOpenError?: boolean;
  commitStateTransition?: () => boolean;
  validatePreparedState?: () => Promise<boolean>;
  isRequestCurrent?: () => boolean;
  supersedeTransition?: boolean;
};
type ChatSessionDataRequest = {
  sequence: number;
  transition: boolean;
};
type ChatSessionDataTransitionReservation = {
  sequence: number;
  protectedState: ChatPanelState | undefined;
};
const DEFAULT_CHAT_WEBVIEW_AUTO_REFRESH_MODE: ChatWebviewAutoRefreshMode = "off";
const DEFAULT_CHAT_SESSION_DETAIL_MODE: ChatSessionDetailMode = "summary";
const LIVE_RUNNING_STALE_MS = 30 * 60 * 1000;

// Manages chat-like WebviewPanels opened in the editor area.
export class ChatPanelManager implements vscode.Disposable {
  private readonly extensionUri: vscode.Uri;
  private readonly historyService: HistoryService;
  private readonly annotationStore: SessionAnnotationStore;
  private readonly pinStore: PinStore;
  private readonly projectAssociationStore: ProjectAssociationStore;
  private readonly bookmarkStore: BookmarkStore;
  private readonly openPositionStore: ChatOpenPositionStore;
  private readonly searchHistoryStore: SearchHistoryStore;
  private readonly branchNavigation: ClaudeBranchNavigationService;
  private readonly codexForkNavigation: CodexForkNavigationService;
  private readonly codexAgentRuns: CodexAgentRunsService;
  private readonly sessionIconResolver: SessionIconResolver;
  private readonly onMissingSession?: MissingSessionHandler;
  private readonly logger?: DebugLogger;
  private readonly autoRefreshConsumerVisibilityEmitter = new vscode.EventEmitter<void>();
  private readonly bookmarkSubscription: vscode.Disposable;
  private readonly annotationSubscription: vscode.Disposable;
  private readonly pinSubscription: vscode.Disposable;
  private searchHistoryPeerRefresh: (() => void) | undefined;

  private reusablePanel: vscode.WebviewPanel | null = null;
  private readonly panelsByKey = new Map<string, vscode.WebviewPanel>();
  private readonly branchPanels = new Set<vscode.WebviewPanel>();
  private readonly branchPanelRegistration = new WeakSet<vscode.WebviewPanel>();
  private readonly stateByPanel = new WeakMap<vscode.WebviewPanel, ChatPanelState>();
  private readonly bookmarkTargetsByPanel = new WeakMap<vscode.WebviewPanel, Map<string, BookmarkTarget>>();
  private readonly readyByPanel = new WeakMap<vscode.WebviewPanel, boolean>();
  private readonly imageDataByPanel = new WeakMap<vscode.WebviewPanel, Map<string, SaveableChatImage>>();
  private readonly documentDataByPanel = new WeakMap<vscode.WebviewPanel, Map<string, SaveableChatDocument>>();
  private readonly patchEntryDetailRequestsByPanel = new WeakMap<vscode.WebviewPanel, Set<string>>();
  private readonly branchSnapshotByPanel = new WeakMap<vscode.WebviewPanel, BranchNavigationSnapshot>();
  private readonly branchGenerationByPanel = new WeakMap<vscode.WebviewPanel, number>();
  private readonly branchHistoryGenerationByPanel = new WeakMap<vscode.WebviewPanel, number>();
  private readonly branchSwitchSequenceByPanel = new WeakMap<vscode.WebviewPanel, number>();
  private readonly branchSwitchClaimedSequenceByPanel = new WeakMap<vscode.WebviewPanel, number>();
  private readonly branchCancellationByPanel = new WeakMap<vscode.WebviewPanel, vscode.CancellationTokenSource>();
  private readonly codexAgentRunsSnapshotByPanel = new WeakMap<vscode.WebviewPanel, CodexAgentRunsPanelSnapshot>();
  private readonly codexAgentRunsGenerationByPanel = new WeakMap<vscode.WebviewPanel, number>();
  private readonly codexAgentRunNavigationSequenceByPanel = new WeakMap<vscode.WebviewPanel, number>();
  private readonly codexAgentRunNavigationClaimedSequenceByPanel = new WeakMap<vscode.WebviewPanel, number>();
  private readonly codexAgentRunPinSequenceByPanel = new WeakMap<vscode.WebviewPanel, Map<string, number>>();
  private readonly codexAgentRunPinRevisionByPanel = new WeakMap<vscode.WebviewPanel, number>();
  private readonly userMessageIndexesByPanel = new WeakMap<vscode.WebviewPanel, Set<number>>();
  private readonly titleRefreshSequenceByPanel = new WeakMap<vscode.WebviewPanel, number>();
  private readonly sessionDataRequestSequenceByPanel = new WeakMap<vscode.WebviewPanel, number>();
  private readonly sessionDataTransitionByPanel =
    new WeakMap<vscode.WebviewPanel, ChatSessionDataTransitionReservation>();
  private readonly sessionDataCommitSequenceByPanel = new WeakMap<vscode.WebviewPanel, number>();
  private reusableOpenGeneration = 0;
  private codexAgentRunsLoading = false;
  public readonly onDidChangeAutoRefreshConsumerVisibility = this.autoRefreshConsumerVisibilityEmitter.event;

  constructor(
    extensionUri: vscode.Uri,
    historyService: HistoryService,
    annotationStore: SessionAnnotationStore,
    pinStore: PinStore,
    projectAssociationStore: ProjectAssociationStore,
    bookmarkStore: BookmarkStore,
    openPositionStore: ChatOpenPositionStore,
    searchHistoryStore: SearchHistoryStore,
    branchNavigation: ClaudeBranchNavigationService,
    codexForkNavigation: CodexForkNavigationService,
    codexAgentRuns: CodexAgentRunsService,
    sessionIconResolver: SessionIconResolver,
    onMissingSession?: MissingSessionHandler,
    logger?: DebugLogger,
  ) {
    this.extensionUri = extensionUri;
    this.historyService = historyService;
    this.annotationStore = annotationStore;
    this.pinStore = pinStore;
    this.projectAssociationStore = projectAssociationStore;
    this.bookmarkStore = bookmarkStore;
    this.openPositionStore = openPositionStore;
    this.searchHistoryStore = searchHistoryStore;
    this.branchNavigation = branchNavigation;
    this.codexForkNavigation = codexForkNavigation;
    this.codexAgentRuns = codexAgentRuns;
    this.sessionIconResolver = sessionIconResolver;
    this.onMissingSession = onMissingSession;
    this.logger = logger;
    this.bookmarkSubscription = this.bookmarkStore.onDidChange(() => {
      this.refreshBookmarkState();
      this.invalidateClaudeBranchNavigation();
      this.refreshCodexAgentRuns();
    });
    this.annotationSubscription = this.annotationStore.onDidChange(() => {
      this.invalidateClaudeBranchNavigation();
      this.refreshCodexAgentRuns();
    });
    this.pinSubscription = this.pinStore.onDidChange(() => {
      this.refreshPinState();
    });
  }

  public dispose(): void {
    for (const panel of this.getOpenPanels()) this.cancelBranchNavigation(panel);
    this.bookmarkSubscription.dispose();
    this.annotationSubscription.dispose();
    this.pinSubscription.dispose();
    this.autoRefreshConsumerVisibilityEmitter.dispose();
  }

  public registerSerializer(subscriptions: vscode.Disposable[]): void {
    subscriptions.push(
      vscode.window.registerWebviewPanelSerializer("codexHistoryViewer.chat", {
        deserializeWebviewPanel: async (panel, rawState) => {
          await this.restoreSerializedPanel(panel, rawState);
        },
      }),
    );
  }

  public refreshI18n(): void {
    const i18n = this.buildI18n();
    const dateTime = this.buildDateTime();
    const config = getConfig();
    const toolDisplayMode = config.toolDisplayMode;
    const chatPerformanceMode = config.chatPerformanceMode;
    const userLongMessageFolding = config.userLongMessageFolding;
    const assistantLongMessageFolding = config.assistantLongMessageFolding;
    const turnTimelineMode = config.chatTurnTimelineMode;
    const imageSettings = this.buildImageSettings(config);
    const stickyUserPrompt = config.stickyUserPrompt;
    const send = (panel: vscode.WebviewPanel): void => {
      if (!this.readyByPanel.get(panel)) return;
      void panel.webview.postMessage({
        type: "i18n",
        i18n,
        dateTime,
        toolDisplayMode,
        chatPerformanceMode,
        userLongMessageFolding,
        assistantLongMessageFolding,
        turnTimelineMode,
        stickyUserPrompt,
        imageSettings,
        chatOpenPosition: config.chatOpenPosition,
        autoRefreshAvailable: config.autoRefresh.enabled,
        debugLoggingEnabled: this.logger?.isDebugEnabled() ?? false,
        timeGuideEnabled: config.timeGuideEnabled,
      });
    };

    for (const panel of this.getOpenPanels()) send(panel);
  }

  private refreshBookmarkState(): void {
    const send = (panel: vscode.WebviewPanel): void => {
      if (!this.readyByPanel.get(panel)) return;
      void this.sendBookmarkState(panel);
    };
    for (const panel of this.getOpenPanels()) send(panel);
  }

  private async sendBookmarkState(panel: vscode.WebviewPanel): Promise<void> {
    const targets = this.bookmarkTargetsByPanel.get(panel);
    if (!targets || targets.size === 0) {
      await panel.webview.postMessage({ type: "bookmarkState", keys: [] });
      return;
    }
    const keys = Array.from(this.bookmarkStore.getKeysForTargets(Array.from(targets.values())).values());
    await panel.webview.postMessage({ type: "bookmarkState", keys });
  }

  public refreshPanels(): void {
    const refresh = (panel: vscode.WebviewPanel): void => {
      if (!this.readyByPanel.get(panel)) return;
      void this.sendSessionData(panel);
    };

    for (const panel of this.getOpenPanels()) refresh(panel);
  }

  public refreshProjectAssociations(): void {
    const refresh = (panel: vscode.WebviewPanel): void => {
      if (!this.readyByPanel.get(panel)) return;
      void this.sendSessionData(panel, { preserveUiState: true });
    };

    for (const panel of this.getOpenPanels()) refresh(panel);
  }

  public refreshTitles(): void {
    const update = (panel: vscode.WebviewPanel): void => {
      this.nextTitleRefreshSequence(panel);
      const state = this.stateByPanel.get(panel);
      if (!state) return;
      const session = this.historyService.findByFsPath(state.fsPath);
      if (!session) return;
      panel.title = buildPanelTitle(session);
      panel.iconPath = this.resolveSessionIconPath(session);
    };

    for (const panel of this.getOpenPanels()) update(panel);
  }

  public hasOpenAutoRefreshConsumer(): boolean {
    for (const panel of this.getOpenPanels()) {
      const state = this.stateByPanel.get(panel);
      if (!state || state.autoRefreshMode === "off") continue;
      return true;
    }
    return false;
  }

  public getAutoRefreshSessionFsPaths(): string[] {
    const paths = new Map<string, string>();
    for (const panel of this.getOpenPanels()) {
      const state = this.stateByPanel.get(panel);
      if (!state || state.autoRefreshMode === "off") continue;
      paths.set(normalizeCacheKey(state.fsPath), state.fsPath);
    }
    return Array.from(paths.values());
  }

  public refreshAutoRefreshPanels(changedFsPaths: readonly string[]): void {
    if (changedFsPaths.length === 0) return;
    const changedKeys = new Set(changedFsPaths.map((fsPath) => normalizeCacheKey(fsPath)));
    for (const panel of this.getOpenPanels()) {
      const state = this.stateByPanel.get(panel);
      if (!state || state.autoRefreshMode === "off") continue;
      if (!changedKeys.has(normalizeCacheKey(state.fsPath))) continue;

      if (!this.readyByPanel.get(panel)) {
        this.stateByPanel.set(panel, { ...state, pendingAutoRefresh: true });
        continue;
      }
      this.requestAutoRefresh(panel, state.autoRefreshMode);
    }
  }

  public closeSessionsByFsPath(fsPaths: readonly string[]): void {
    const keys = new Set(fsPaths.map((fsPath) => normalizeCacheKey(fsPath)));
    if (keys.size === 0) return;

    for (const panel of this.getOpenPanels()) {
      const state = this.stateByPanel.get(panel);
      if (!state || !keys.has(normalizeCacheKey(state.fsPath))) continue;
      this.disposePanel(panel);
    }
  }

  public async closeMissingPanels(): Promise<void> {
    for (const panel of this.getOpenPanels()) {
      const state = this.stateByPanel.get(panel);
      if (!state) continue;
      if (await this.ensureSessionFileAvailable(state.fsPath)) continue;
      if (this.stateByPanel.get(panel) !== state) continue;
      await this.handleMissingSession(panel, state.fsPath, { showMessage: false, notify: false });
    }
  }

  public async openSession(
    session: SessionSummary,
    options: {
      kind: ChatPanelKind;
      revealMessageIndex?: number;
      revealTarget?: FileChangeHistoryRevealTarget;
      pageSearchSeed?: SessionPageSearchSeed;
      viewColumn?: vscode.ViewColumn;
      preserveFocus?: boolean;
      isRequestCurrent?: () => boolean;
    },
  ): Promise<void> {
    const reusableOpenGeneration = options.kind === "reusable"
      ? ++this.reusableOpenGeneration
      : undefined;
    const isRequestCurrent = (): boolean =>
      (reusableOpenGeneration === undefined || this.reusableOpenGeneration === reusableOpenGeneration) &&
      (!options.isRequestCurrent || options.isRequestCurrent());
    const sessionFileAvailable = await this.ensureSessionFileAvailable(session.fsPath);
    if (!isRequestCurrent()) return;
    if (!sessionFileAvailable) {
      await this.handleMissingSession(null, session.fsPath);
      return;
    }

    const key = normalizeCacheKey(session.fsPath);
    const panel = options.kind === "reusable"
      ? this.getOrCreateReusablePanel()
      : options.kind === "branch"
        ? this.createBranchPanel()
        : this.getOrCreatePanelForKey(key);
    const prevState = this.stateByPanel.get(panel);
    const isSameSession = !!prevState && normalizeCacheKey(prevState.fsPath) === key;
    if (!isSameSession) {
      this.clearSessionBoundPanelData(panel);
    }

    const nextState: ChatPanelState = {
      fsPath: session.fsPath,
      revealMessageIndex: options.revealMessageIndex,
      revealTarget: options.revealTarget,
      pageSearchSeed: sanitizePageSearchSeed(options.pageSearchSeed),
      sessionCwd: isSameSession ? prevState?.sessionCwd : undefined,
      sessionDisplayCwd: isSameSession ? prevState?.sessionDisplayCwd : undefined,
      kind: options.kind,
      autoRefreshMode: isSameSession ? prevState.autoRefreshMode : DEFAULT_CHAT_WEBVIEW_AUTO_REFRESH_MODE,
      detailMode: isSameSession ? prevState.detailMode : undefined,
      pathMode: isSameSession ? prevState.pathMode : undefined,
      pathModeEnabled: isSameSession ? prevState.pathModeEnabled : undefined,
      pendingAutoRefresh: false,
    };
    this.stateByPanel.set(panel, nextState);
    panel.title = buildPanelTitle(session);
    panel.iconPath = this.resolveSessionIconPath(session);
    panel.reveal(options.viewColumn ?? panel.viewColumn, options.preserveFocus ?? options.kind === "reusable");
    this.notifyAutoRefreshConsumerVisibilityChanged();

    // If the webview is already ready, update immediately on selection changes.
    if (this.readyByPanel.get(panel)) {
      await this.sendSessionData(panel, {
        isRequestCurrent,
        supersedeTransition: true,
      });
    }
  }

  public async revealExistingSessionPanel(
    fsPath: string,
    revealMessageIndex?: number,
    options: {
      preserveFocus?: boolean;
      promoteReusable?: boolean;
      revealTarget?: FileChangeHistoryRevealTarget;
      pageSearchSeed?: SessionPageSearchSeed;
      isRequestCurrent?: () => boolean;
    } = {},
  ): Promise<boolean> {
    if (options.isRequestCurrent && !options.isRequestCurrent()) return false;
    const existing = this.findExistingSessionPanel(fsPath);
    if (!existing) return false;
    const { panel } = existing;
    const state = this.stateByPanel.get(panel);
    if (!state) return false;
    if (existing.kind === "reusable") this.reusableOpenGeneration += 1;
    const sessionFileAvailable = await this.ensureSessionFileAvailable(state.fsPath);
    if (options.isRequestCurrent && !options.isRequestCurrent()) return false;
    if (this.stateByPanel.get(panel) !== state) return false;
    if (!sessionFileAvailable) {
      await this.handleMissingSession(panel, state.fsPath);
      return false;
    }

    const nextKind = existing.kind === "reusable" && options.promoteReusable === true ? "session" : state.kind;
    if (state.kind === "reusable" && nextKind === "session") {
      this.promoteReusablePanelToSession(panel, state.fsPath);
    }

    const nextState: ChatPanelState = {
      ...state,
      revealMessageIndex,
      revealTarget: options.revealTarget,
      pageSearchSeed: sanitizePageSearchSeed(options.pageSearchSeed),
      kind: nextKind,
      pendingAutoRefresh: false,
    };
    this.stateByPanel.set(panel, nextState);
    panel.reveal(panel.viewColumn, options.preserveFocus === true);
    this.notifyAutoRefreshConsumerVisibilityChanged();
    if (this.readyByPanel.get(panel)) {
      if (!(await this.sendSessionData(panel, {
        isRequestCurrent: options.isRequestCurrent,
        supersedeTransition: true,
      }))) {
        return false;
      }
    }
    return true;
  }

  public async openSessionByFsPath(
    fsPath: string,
    options: {
      kind: ChatPanelKind;
      revealMessageIndex?: number;
      revealTarget?: FileChangeHistoryRevealTarget;
      pageSearchSeed?: SessionPageSearchSeed;
    },
  ): Promise<void> {
    const session = this.historyService.findByFsPath(fsPath);
    if (!session) {
      void vscode.window.showErrorMessage(t("app.openSessionFailed"));
      return;
    }
    await this.openSession(session, options);
  }

  public refreshSearchHistoryCandidates(): void {
    for (const panel of this.getOpenPanels()) {
      if (!this.readyByPanel.get(panel)) continue;
      const state = this.stateByPanel.get(panel);
      const candidates = this.getSearchHistoryCandidates(this.resolveSearchHistoryProjectKey(state?.sessionCwd));
      void panel.webview.postMessage({ type: "searchHistoryCandidates", candidates });
    }
  }

  public setSearchHistoryPeerRefresh(callback: (() => void) | undefined): void {
    this.searchHistoryPeerRefresh = callback;
  }

  private refreshAllSearchHistoryCandidates(): void {
    this.refreshSearchHistoryCandidates();
    this.searchHistoryPeerRefresh?.();
  }

  private getOrCreateReusablePanel(): vscode.WebviewPanel {
    if (this.reusablePanel) return this.reusablePanel;
    const panel = this.createPanel({ kind: "reusable" });
    this.registerReusablePanel(panel);
    return panel;
  }

  private getOrCreatePanelForKey(key: string): vscode.WebviewPanel {
    const existing = this.panelsByKey.get(key);
    if (existing) return existing;
    const panel = this.createPanel({ kind: "session" });
    this.registerSessionPanel(key, panel);
    return panel;
  }

  private createBranchPanel(): vscode.WebviewPanel {
    const panel = this.createPanel({ kind: "branch" });
    this.registerBranchPanel(panel);
    return panel;
  }

  private findExistingSessionPanel(fsPath: string): ExistingChatPanel | null {
    const key = normalizeCacheKey(fsPath);
    const sessionPanel = this.panelsByKey.get(key);
    if (sessionPanel) return { panel: sessionPanel, kind: "session" };

    if (this.reusablePanel) {
      const state = this.stateByPanel.get(this.reusablePanel);
      if (state && normalizeCacheKey(state.fsPath) === key) return { panel: this.reusablePanel, kind: "reusable" };
    }

    return null;
  }

  private registerBranchPanel(panel: vscode.WebviewPanel): void {
    this.branchPanels.add(panel);
    if (this.branchPanelRegistration.has(panel)) return;
    this.branchPanelRegistration.add(panel);
    panel.onDidDispose(() => {
      this.branchPanels.delete(panel);
      this.cancelBranchNavigation(panel);
      this.clearSessionBoundPanelData(panel);
    });
  }

  private transitionPanelToBranch(panel: vscode.WebviewPanel, previousFsPath?: string): void {
    if (this.reusablePanel === panel) {
      this.reusablePanel = null;
      this.reusableOpenGeneration += 1;
    }
    if (previousFsPath) {
      const key = normalizeCacheKey(previousFsPath);
      if (this.panelsByKey.get(key) === panel) this.panelsByKey.delete(key);
    }
    this.registerBranchPanel(panel);
  }

  private clearSessionBoundPanelData(panel: vscode.WebviewPanel): void {
    this.imageDataByPanel.delete(panel);
    this.documentDataByPanel.delete(panel);
    this.patchEntryDetailRequestsByPanel.delete(panel);
    this.bookmarkTargetsByPanel.delete(panel);
    this.userMessageIndexesByPanel.delete(panel);
    this.branchHistoryGenerationByPanel.delete(panel);
    this.nextCodexAgentRunsGeneration(panel);
    this.codexAgentRunsSnapshotByPanel.delete(panel);
    this.codexAgentRunPinSequenceByPanel.delete(panel);
    this.codexAgentRunPinRevisionByPanel.delete(panel);
  }

  private promoteReusablePanelToSession(panel: vscode.WebviewPanel, fsPath: string): void {
    if (this.reusablePanel === panel) {
      this.reusablePanel = null;
      this.reusableOpenGeneration += 1;
    }
    const key = normalizeCacheKey(fsPath);
    this.panelsByKey.set(key, panel);
    panel.onDidDispose(() => {
      if (this.panelsByKey.get(key) === panel) {
        this.panelsByKey.delete(key);
      }
      this.imageDataByPanel.delete(panel);
      this.documentDataByPanel.delete(panel);
    });
  }

  private createPanel(params: { kind: ChatPanelKind }): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
      "codexHistoryViewer.chat",
      "Codex Session",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: params.kind === "reusable" },
      this.buildWebviewPanelOptions(),
    );

    this.initializePanel(panel);
    return panel;
  }

  private buildWebviewOptions(): vscode.WebviewOptions {
    return {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "media"),
        vscode.Uri.joinPath(this.extensionUri, "node_modules", "markdown-it", "dist"),
      ],
    };
  }

  private buildWebviewPanelOptions(): vscode.WebviewOptions & vscode.WebviewPanelOptions {
    return {
      ...this.buildWebviewOptions(),
      retainContextWhenHidden: true,
    };
  }

  private initializePanel(panel: vscode.WebviewPanel): void {
    panel.webview.options = this.buildWebviewOptions();
    panel.webview.html = this.buildHtml(panel.webview);
    this.readyByPanel.set(panel, false);

    panel.webview.onDidReceiveMessage((msg) => {
      void this.handleMessage(panel, msg).catch((error) => {
        this.logger?.debug(`chat.message failed error=${sanitizeDebugError(error)}`);
      });
    });
    panel.onDidChangeViewState(() => {
      void panel.webview.postMessage({ type: "viewState", visible: panel.visible });
      const state = this.stateByPanel.get(panel);
      if (state && state.pendingAutoRefresh && state.autoRefreshMode !== "off" && this.readyByPanel.get(panel)) {
        this.requestAutoRefresh(panel, state.autoRefreshMode);
      }
      this.notifyAutoRefreshConsumerVisibilityChanged();
    });
    panel.onDidDispose(() => {
      this.cancelBranchNavigation(panel);
      this.stateByPanel.delete(panel);
      this.readyByPanel.delete(panel);
      this.branchSnapshotByPanel.delete(panel);
      this.branchGenerationByPanel.delete(panel);
      this.branchHistoryGenerationByPanel.delete(panel);
      this.codexAgentRunsSnapshotByPanel.delete(panel);
      this.codexAgentRunsGenerationByPanel.delete(panel);
      this.titleRefreshSequenceByPanel.delete(panel);
      this.sessionDataRequestSequenceByPanel.delete(panel);
      this.sessionDataTransitionByPanel.delete(panel);
      this.sessionDataCommitSequenceByPanel.delete(panel);
      this.notifyAutoRefreshConsumerVisibilityChanged();
    });
  }

  private registerReusablePanel(panel: vscode.WebviewPanel): void {
    this.reusablePanel = panel;
    panel.onDidDispose(() => {
      if (this.reusablePanel === panel) {
        this.reusablePanel = null;
        this.reusableOpenGeneration += 1;
      }
    });
  }

  private registerSessionPanel(key: string, panel: vscode.WebviewPanel): void {
    this.panelsByKey.set(key, panel);
    panel.onDidDispose(() => {
      if (this.panelsByKey.get(key) === panel) {
        this.panelsByKey.delete(key);
      }
      this.imageDataByPanel.delete(panel);
      this.documentDataByPanel.delete(panel);
      this.patchEntryDetailRequestsByPanel.delete(panel);
    });
  }

  private async restoreSerializedPanel(panel: vscode.WebviewPanel, rawState: unknown): Promise<void> {
    const restored = sanitizeChatPanelRestoreState(rawState);
    if (!restored) {
      this.disposePanel(panel);
      return;
    }
    if (!(await this.ensureSessionFileAvailable(restored.fsPath))) {
      await this.handleMissingSession(panel, restored.fsPath);
      return;
    }

    if (restored.kind === "reusable") {
      if (this.reusablePanel && this.reusablePanel !== panel) {
        this.disposePanel(panel);
        return;
      }
      this.registerReusablePanel(panel);
    } else if (restored.kind === "session") {
      const key = normalizeCacheKey(restored.fsPath);
      const existing = this.panelsByKey.get(key);
      if (existing && existing !== panel) {
        this.disposePanel(panel);
        return;
      }
      this.registerSessionPanel(key, panel);
    } else {
      this.registerBranchPanel(panel);
    }

    this.initializePanel(panel);
    this.stateByPanel.set(panel, {
      fsPath: restored.fsPath,
      revealMessageIndex: restored.revealMessageIndex,
      revealTarget: restored.revealTarget,
      restoreScrollY: restored.scrollY,
      restoreTopMessageIndex: restored.topMessageIndex,
      kind: restored.kind,
      autoRefreshMode: restored.autoRefreshMode,
      detailMode: restored.detailMode,
      pathMode: restored.pathMode,
      pendingAutoRefresh: false,
    });
    const session = this.historyService.findByFsPath(restored.fsPath);
    if (session) {
      panel.title = buildPanelTitle(session);
      panel.iconPath = this.resolveSessionIconPath(session);
    }
    this.notifyAutoRefreshConsumerVisibilityChanged();
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = randomNonce();
    const sharedTimeGuideCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "sharedTimeGuide.css"),
    );
    const sharedTimeGuideJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "sharedTimeGuide.js"),
    );
    const sharedFileKindCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "sharedFileKind.css"),
    );
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "chatView.css"));
    const pageSearchCoreUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "pageSearchCore.js"),
    );
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "chatView.js"));
    const katexCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "vendor", "katex", "katex.min.css"),
    );
    const katexJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "vendor", "katex", "katex.min.js"),
    );
    const shikiBundleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "chatViewShiki.bundle.js"),
    );
    const markdownItUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "node_modules", "markdown-it", "dist", "markdown-it.min.js"),
    );

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
      `style-src ${webview.cspSource} 'unsafe-inline';`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    // Do not inline log content into HTML. Send it via postMessage (XSS mitigation).
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${katexCssUri}">
  <link rel="stylesheet" href="${sharedTimeGuideCssUri}">
  <link rel="stylesheet" href="${sharedFileKindCssUri}">
  <link rel="stylesheet" href="${cssUri}">
  <title>Codex History Viewer</title>
</head>
<body>
  <div id="toolbar">
    <button id="btnResumeInCodex" type="button"></button>
    <button id="btnPinToggle" type="button" class="toolbarIconBtn"></button>
    <button id="btnCustomTitle" type="button" class="toolbarIconBtn"></button>
    <div id="toolbarSpacer"></div>
    <button id="btnMarkdown" type="button" class="toolbarIconBtn"></button>
    <button id="btnCopyResume" type="button" class="toolbarIconBtn"></button>
    <button id="btnToggleDetails" type="button" class="toolbarIconBtn"></button>
    <button id="btnPathMode" type="button" class="toolbarIconBtn"></button>
    <button id="btnScrollTop" type="button" class="toolbarIconBtn"></button>
    <button id="btnScrollBottom" type="button" class="toolbarIconBtn"></button>
    <button id="btnPageSearch" type="button" class="toolbarIconBtn"></button>
    <button id="btnPerformanceMode" type="button" class="toolbarIconBtn"></button>
    <button id="btnAutoRefresh" type="button" class="toolbarIconBtn" hidden></button>
    <button id="btnAgentRuns" type="button" class="toolbarIconBtn" hidden></button>
    <button id="btnBranchMap" type="button" class="toolbarIconBtn" hidden></button>
    <button id="btnReload" type="button" class="toolbarIconBtn"></button>
  </div>
  <div id="pageSearchBar" hidden>
    <div id="pageSearchResizeHandle" aria-hidden="true"></div>
    <div id="pageSearchInner">
      <div id="pageSearchHeader">
        <div id="pageSearchTitle"></div>
        <div id="pageSearchRoleFilters" role="group" hidden></div>
        <div id="pageSearchActions">
          <button id="btnPageSearchPrev" type="button" class="toolbarIconBtn"></button>
          <button id="btnPageSearchNext" type="button" class="toolbarIconBtn"></button>
          <button id="btnPageSearchClose" type="button" class="toolbarIconBtn"></button>
        </div>
      </div>
      <div id="pageSearchInputRow">
        <input id="pageSearchInput" type="search" spellcheck="false" autocomplete="off" />
        <div id="pageSearchCount" aria-live="polite"></div>
      </div>
      <div id="pageSearchSuggestions" role="listbox" hidden></div>
    </div>
    <div id="pageSearchResults" role="listbox" aria-live="polite"></div>
  </div>
  <div id="scrollRoot">
    <div id="annotation"></div>
    <div id="meta"></div>
    <div id="timeline"></div>
  </div>
  <div id="restoreCover" aria-hidden="true" hidden></div>
  <div id="branchOverlayRoot" hidden></div>
  <div id="agentRunsOverlayRoot" hidden></div>
  <script nonce="${nonce}" src="${markdownItUri}"></script>
  <script nonce="${nonce}" src="${katexJsUri}"></script>
  <script nonce="${nonce}" src="${shikiBundleUri}"></script>
  <script nonce="${nonce}" src="${sharedTimeGuideJsUri}"></script>
  <script nonce="${nonce}" src="${pageSearchCoreUri}"></script>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }

  private async handleMessage(panel: vscode.WebviewPanel, msg: any): Promise<void> {
    const state = this.stateByPanel.get(panel);
    if (!state) return;

    const type = typeof msg?.type === "string" ? msg.type : "";
    const requestSequence = sanitizePositiveSequence(msg?.requestId);
    if (type === "ready") {
      this.branchSwitchSequenceByPanel.delete(panel);
      this.branchSwitchClaimedSequenceByPanel.delete(panel);
      this.codexAgentRunNavigationSequenceByPanel.delete(panel);
      this.codexAgentRunNavigationClaimedSequenceByPanel.delete(panel);
      this.codexAgentRunPinSequenceByPanel.delete(panel);
    } else if (
      type === "switchClaudeBranch" &&
      requestSequence > (this.branchSwitchSequenceByPanel.get(panel) ?? 0)
    ) {
      this.branchSwitchSequenceByPanel.set(panel, requestSequence);
    } else if (
      type === "openCodexAgentRun" &&
      requestSequence > (this.codexAgentRunNavigationSequenceByPanel.get(panel) ?? 0)
    ) {
      this.codexAgentRunNavigationSequenceByPanel.set(panel, requestSequence);
    }
    if (
      type !== "ready" &&
      type !== "copy" &&
      type !== "debug" &&
      type !== "rememberOpenPosition" &&
      type !== "switchClaudeBranch" &&
      type !== "openCodexAgentRun" &&
      type !== "toggleCodexAgentRunPin" &&
      !(await this.ensurePanelSessionFile(panel, state))
    ) {
      return;
    }

    switch (type) {
      case "ready": {
        this.readyByPanel.set(panel, true);
        const detailMode = normalizeChatSessionDetailMode(msg?.detailMode);
        const restoreState = this.stateByPanel.get(panel);
        const shouldRestorePosition =
          restoreState?.restoreScrollY !== undefined || restoreState?.restoreTopMessageIndex !== undefined;
        await this.sendSessionData(panel, {
          detailMode,
          restoreScrollY: restoreState?.restoreScrollY,
          restoreSelectedMessageIndex: restoreState?.restoreTopMessageIndex,
          preserveUiState: shouldRestorePosition,
        });
        return;
      }
      case "openMarkdown": {
        const revealMessageIndex = typeof msg?.revealMessageIndex === "number" ? msg.revealMessageIndex : undefined;
        await vscode.commands.executeCommand("codexHistoryViewer.openSessionMarkdown", {
          fsPath: state.fsPath,
          revealMessageIndex,
        });
        return;
      }
      case "copy": {
        const text = typeof msg?.text === "string" ? msg.text : "";
        if (!text) return;
        await vscode.env.clipboard.writeText(text);
        panel.webview.postMessage({ type: "copied" });
        return;
      }
      case "debug": {
        this.logger?.debug(formatWebviewDebugMessage(msg));
        return;
      }
      case "rememberOpenPosition": {
        const fsPath = typeof msg?.fsPath === "string" ? msg.fsPath : "";
        const messageIndex =
          typeof msg?.messageIndex === "number" && Number.isFinite(msg.messageIndex)
            ? Math.max(0, Math.floor(msg.messageIndex))
            : undefined;
        if (!fsPath || messageIndex === undefined) return;
        const isCurrentPanelSession = normalizeCacheKey(fsPath) === normalizeCacheKey(state.fsPath);
        if (!isCurrentPanelSession && !this.historyService.findByFsPath(fsPath)) {
          return;
        }

        try {
          await this.openPositionStore.set(fsPath, messageIndex);
          this.logger?.debug(`chatOpenPosition remember session=${debugSessionName(fsPath)} index=${messageIndex}`);
        } catch {
          this.logger?.debug("chatOpenPosition remember failed");
        }
        return;
      }
      case "savePageSearchHistory": {
        const queryInput = typeof msg?.queryInput === "string" ? msg.queryInput.trim() : "";
        if (!queryInput) return;
        const saved = await this.searchHistoryStore.save({
          projectKey: this.resolveSearchHistoryProjectKey(state.sessionCwd),
          queryInput,
        });
        if (saved) this.refreshAllSearchHistoryCandidates();
        return;
      }
      case "removePageSearchHistory": {
        const queryInput = typeof msg?.queryInput === "string" ? msg.queryInput.trim() : "";
        if (!queryInput) return;
        const removed = await this.searchHistoryStore.remove(
          this.resolveSearchHistoryProjectKey(state.sessionCwd),
          queryInput,
        );
        if (removed) this.refreshAllSearchHistoryCandidates();
        return;
      }
      case "saveImage": {
        await this.saveImageFromPanel(panel, msg);
        return;
      }
      case "saveAttachment": {
        await this.saveAttachmentFromPanel(panel, msg);
        return;
      }
      case "requestImageData": {
        this.sendImageDataToPanel(panel, msg);
        return;
      }
      case "copyResumePrompt": {
        const copied = await vscode.commands.executeCommand<boolean>("codexHistoryViewer.copyResumePrompt", {
          fsPath: state.fsPath,
        });
        if (copied) panel.webview.postMessage({ type: "copied" });
        return;
      }
      case "resumeInCodex":
      case "resumeInSource": {
        const session = this.historyService.findByFsPath(state.fsPath);
        const commandId =
          session?.source === "claude"
            ? "codexHistoryViewer.resumeSessionInClaude"
            : "codexHistoryViewer.resumeSessionInCodex";
        await vscode.commands.executeCommand(commandId, { fsPath: state.fsPath });
        return;
      }
      case "restoreArchivedSession": {
        const revealMessageIndex =
          typeof msg?.revealMessageIndex === "number" && Number.isFinite(msg.revealMessageIndex)
            ? Math.max(0, Math.floor(msg.revealMessageIndex))
            : undefined;
        const result = await vscode.commands.executeCommand<{ activeFsPath?: string }>(
          "codexHistoryViewer.restoreArchivedSession",
          { fsPath: state.fsPath, reopenInCurrentPanel: true, revealMessageIndex },
        );
        const activeFsPath = typeof result?.activeFsPath === "string" ? result.activeFsPath : "";
        if (activeFsPath) {
          if (this.stateByPanel.get(panel) !== state) return;
          if (normalizeCacheKey(activeFsPath) !== normalizeCacheKey(state.fsPath)) {
            this.clearSessionBoundPanelData(panel);
          }
          this.stateByPanel.set(panel, {
            ...state,
            fsPath: activeFsPath,
            revealMessageIndex,
            sessionCwd: undefined,
            sessionDisplayCwd: undefined,
            pathMode: undefined,
            pathModeEnabled: undefined,
          });
          await this.sendSessionData(panel, {
            preserveUiState: false,
            supersedeTransition: true,
          });
        }
        return;
      }
      case "togglePin": {
        const session = this.historyService.findByFsPath(state.fsPath);
        const commandId = session && isSessionPinned(this.pinStore, session)
          ? "codexHistoryViewer.unpinSession"
          : "codexHistoryViewer.pinSession";
        await vscode.commands.executeCommand(commandId, {
          fsPath: state.fsPath,
          ...(session ? { identityKey: session.identityKey } : {}),
        });
        this.publishCurrentSessionPinState(panel);
        return;
      }
      case "toggleBookmark": {
        const key = typeof msg?.key === "string" ? msg.key.trim() : "";
        const target = key ? this.bookmarkTargetsByPanel.get(panel)?.get(key) : undefined;
        if (!target) {
          await this.sendBookmarkState(panel);
          return;
        }
        try {
          await this.bookmarkStore.toggle(target);
        } catch (error) {
          this.logger?.debug(
            formatDebugFields("bookmark toggle failed", {
              session: safeDebugBasename(state.fsPath),
              error: sanitizeDebugError(error),
            }),
          );
        } finally {
          await this.sendBookmarkState(panel);
        }
        return;
      }
      case "manageCustomTitle": {
        const changed = await vscode.commands.executeCommand<boolean>("codexHistoryViewer.manageCustomTitle", {
          fsPath: state.fsPath,
        });
        if (changed) await this.sendSessionData(panel);
        return;
      }
      case "openLocalFile": {
        await this.openAttachmentTargetFromPanel(panel, msg);
        return;
      }
      case "openAttachment": {
        await this.openAttachmentTargetFromPanel(panel, msg);
        return;
      }
      case "loadPatchEntryDetails": {
        await this.loadPatchEntryDetails(panel, msg);
        return;
      }
      case "reload": {
        // Reload rereads the session file and preserves view position (scroll).
        const restoreScrollY =
          typeof msg?.scrollY === "number" && Number.isFinite(msg.scrollY) ? Math.max(0, msg.scrollY) : undefined;
        const restoreSelectedMessageIndex =
          typeof msg?.selectedMessageIndex === "number" && Number.isFinite(msg.selectedMessageIndex)
            ? msg.selectedMessageIndex
            : undefined;
        const preserveUiState = msg?.preserveUiState === true;
        const autoScrollToBottom = msg?.autoScrollToBottom === true;
        const detailMode = msg?.includeDetails === true ? "full" : DEFAULT_CHAT_SESSION_DETAIL_MODE;
        const sent = await this.sendSessionData(panel, {
          restoreScrollY,
          restoreSelectedMessageIndex,
          preserveUiState,
          autoScrollToBottom,
          detailMode,
        });
        if (!sent) return;
        await this.refreshPanelTitleFromFile(panel);
        return;
      }
      case "setAutoRefreshMode": {
        const autoRefreshMode = normalizeChatWebviewAutoRefreshMode(msg?.mode);
        const nextState: ChatPanelState = {
          ...state,
          autoRefreshMode,
          pendingAutoRefresh: autoRefreshMode === "off" ? false : state.pendingAutoRefresh,
        };
        this.stateByPanel.set(panel, nextState);
        this.notifyAutoRefreshConsumerVisibilityChanged();
        if (nextState.pendingAutoRefresh && nextState.autoRefreshMode !== "off" && this.readyByPanel.get(panel)) {
          this.requestAutoRefresh(panel, nextState.autoRefreshMode);
        }
        return;
      }
      case "setPathMode": {
        const requestedMode = normalizeChatWebviewPathMode(msg?.mode);
        const pathMode = state.pathModeEnabled === true ? requestedMode : "recorded";
        this.stateByPanel.set(panel, { ...state, pathMode });
        return;
      }
      case "filterByTag": {
        const tag = typeof msg?.tag === "string" ? msg.tag.trim() : "";
        if (!tag) return;
        await vscode.commands.executeCommand("codexHistoryViewer.filterHistoryByTag", tag);
        return;
      }
      case "editAnnotation": {
        await vscode.commands.executeCommand("codexHistoryViewer.editSessionAnnotation", { fsPath: state.fsPath });
        await this.sendSessionData(panel);
        return;
      }
      case "removeTag": {
        const tag = typeof msg?.tag === "string" ? msg.tag.trim() : "";
        if (!tag) return;
        await vscode.commands.executeCommand("codexHistoryViewer.removeSessionTag", { fsPath: state.fsPath, tag });
        await this.sendSessionData(panel);
        return;
      }
      case "switchClaudeBranch": {
        await this.handleClaudeBranchSwitch(panel, msg, requestSequence);
        return;
      }
      case "requestClaudeBranchTreePage": {
        this.handleClaudeBranchOverlayPageRequest(panel, msg);
        return;
      }
      case "requestClaudeBranchTreeChoicePage": {
        this.handleClaudeBranchChoicePageRequest(panel, msg);
        return;
      }
      case "openCodexAgentRun": {
        await this.handleOpenCodexAgentRun(panel, msg, requestSequence);
        return;
      }
      case "toggleCodexAgentRunPin": {
        await this.handleToggleCodexAgentRunPin(panel, msg, requestSequence);
        return;
      }
      default:
        return;
    }
  }

  public refreshBranchNavigation(): void {
    const config = getConfig();
    if (!config.branchNavigationEnabled) {
      this.branchNavigation.clearSnapshots();
      this.codexForkNavigation.clearCache();
    }
    for (const panel of this.getOpenPanels()) {
      this.cancelBranchNavigation(panel);
      if (!this.readyByPanel.get(panel)) continue;
      this.scheduleBranchNavigation(panel);
    }
  }

  public refreshClaudeBranchNavigation(): void {
    this.refreshBranchNavigation();
  }

  public invalidateBranchNavigation(): void {
    this.branchNavigation.clearSnapshots();
    this.codexForkNavigation.clearCache();
    for (const panel of this.getOpenPanels()) {
      this.branchSnapshotByPanel.delete(panel);
      this.branchHistoryGenerationByPanel.delete(panel);
    }
    this.refreshBranchNavigation();
  }

  public invalidateClaudeBranchNavigation(): void {
    this.branchNavigation.clearSnapshots();
    for (const panel of this.getOpenPanels()) {
      this.branchSnapshotByPanel.delete(panel);
      this.branchHistoryGenerationByPanel.delete(panel);
    }
    this.refreshBranchNavigation();
  }

  public setCodexAgentRunsLoading(loading: boolean): void {
    if (this.codexAgentRunsLoading === loading) return;
    this.codexAgentRunsLoading = loading;
    this.refreshCodexAgentRuns();
  }

  public refreshCodexAgentRuns(): void {
    if (!getConfig().agentRunsEnabled) this.codexAgentRuns.invalidate();
    for (const panel of this.getOpenPanels()) {
      const state = this.stateByPanel.get(panel);
      const session = state ? this.historyService.findByFsPath(state.fsPath) : undefined;
      if (session) panel.iconPath = this.resolveSessionIconPath(session);
      if (this.readyByPanel.get(panel)) this.publishCodexAgentRuns(panel);
    }
  }

  public handleCodexAgentRunsLoadFailure(): void {
    for (const panel of this.getOpenPanels()) {
      const state = this.stateByPanel.get(panel);
      const session = state ? this.historyService.findByFsPath(state.fsPath) : undefined;
      if (session) panel.iconPath = this.resolveSessionIconPath(session);
      if (!this.readyByPanel.get(panel)) continue;
      const generation = this.nextCodexAgentRunsGeneration(panel);
      this.codexAgentRunsSnapshotByPanel.delete(panel);
      this.codexAgentRunPinSequenceByPanel.delete(panel);
      this.codexAgentRunPinRevisionByPanel.delete(panel);
      this.postCodexAgentRunsMessage(panel, {
        type: "setCodexAgentRunsState",
        version: 1,
        generation,
        state: "disabled",
      }, "loadFailure");
    }
  }

  private refreshPinState(): void {
    for (const panel of this.getOpenPanels()) {
      this.publishCurrentSessionPinState(panel);
      this.publishCodexAgentRunPinState(panel);
    }
  }

  private publishCurrentSessionPinState(panel: vscode.WebviewPanel): void {
    const state = this.stateByPanel.get(panel);
    if (!state || !this.readyByPanel.get(panel)) return;
    const session = this.historyService.findByFsPath(state.fsPath);
    void panel.webview.postMessage({
      type: "pinState",
      isPinned: session ? isSessionPinned(this.pinStore, session) : this.pinStore.isPinned(state.fsPath),
    });
  }

  private publishCodexAgentRunPinState(panel: vscode.WebviewPanel): void {
    const snapshot = this.codexAgentRunsSnapshotByPanel.get(panel);
    if (!snapshot || !this.readyByPanel.get(panel)) return;
    const pinRevision = (this.codexAgentRunPinRevisionByPanel.get(panel) ?? 0) + 1;
    this.codexAgentRunPinRevisionByPanel.set(panel, pinRevision);
    const pinnedSessions = buildPinnedSessionLookup(this.pinStore);
    const states = Array.from(snapshot.pinTargets, ([target, session]) => ({
      target,
      isPinned: isSessionPinnedInLookup(pinnedSessions, session),
    }));
    this.postCodexAgentRunsMessage(panel, {
      type: "setCodexAgentRunPinState",
      version: 1,
      generation: snapshot.generation,
      pinRevision,
      states,
    }, "pinState");
  }

  public async openCodexAgentParent(session: SessionSummary): Promise<void> {
    if (!getConfig().agentRunsEnabled) {
      void vscode.window.showInformationMessage(t("codexAgentRuns.disabled"));
      return;
    }
    const parent = session.source === "codex" ? this.codexAgentRuns.getParentSession(session) : undefined;
    if (!parent) {
      void vscode.window.showInformationMessage(t("codexAgentRuns.parentUnavailable"));
      return;
    }
    if (await this.revealExistingSessionPanel(parent.fsPath, undefined, { preserveFocus: false })) return;
    await this.openSession(parent, { kind: "session", preserveFocus: false });
  }

  private publishCodexAgentRuns(panel: vscode.WebviewPanel): void {
    const state = this.stateByPanel.get(panel);
    const session = state ? this.historyService.findByFsPath(state.fsPath) : undefined;
    const config = getConfig();
    if (!config.agentRunsEnabled || !session || session.source !== "codex") {
      const generation = this.nextCodexAgentRunsGeneration(panel);
      this.codexAgentRunsSnapshotByPanel.delete(panel);
      this.codexAgentRunPinSequenceByPanel.delete(panel);
      this.codexAgentRunPinRevisionByPanel.delete(panel);
      this.postCodexAgentRunsMessage(panel, {
        type: "setCodexAgentRunsState",
        version: 1,
        generation,
        state: "disabled",
      }, "disabled");
      return;
    }
    if (this.codexAgentRunsLoading) {
      const generation = this.nextCodexAgentRunsGeneration(panel);
      this.codexAgentRunsSnapshotByPanel.delete(panel);
      this.codexAgentRunPinSequenceByPanel.delete(panel);
      this.codexAgentRunPinRevisionByPanel.delete(panel);
      this.postCodexAgentRunsMessage(panel, {
        type: "setCodexAgentRunsState",
        version: 1,
        generation,
        state: "loading",
      }, "loading");
      return;
    }
    if (!this.codexAgentRuns.isPresentationEnabled()) return;

    const component = this.codexAgentRuns.buildComponent(session, t("codexAgentRuns.subagent"));
    if (!hasAgentRunsRelation(component)) {
      const generation = this.nextCodexAgentRunsGeneration(panel);
      this.codexAgentRunsSnapshotByPanel.delete(panel);
      this.codexAgentRunPinSequenceByPanel.delete(panel);
      this.codexAgentRunPinRevisionByPanel.delete(panel);
      this.postCodexAgentRunsMessage(panel, {
        type: "setCodexAgentRunsState",
        version: 1,
        generation,
        state: "empty",
        i18n: this.buildI18n(),
      }, "empty");
      return;
    }

    const relationKey = buildCodexAgentRunsRelationKey(component, session.identityKey);
    const previousSnapshot = this.codexAgentRunsSnapshotByPanel.get(panel);
    const reusesRelation = Boolean(
      previousSnapshot &&
      previousSnapshot.currentIdentityKey === session.identityKey &&
      previousSnapshot.relationKey === relationKey,
    );
    const generation = reusesRelation
      ? previousSnapshot!.generation
      : this.nextCodexAgentRunsGeneration(panel);
    const targets = new Map<string, SessionSummary>();
    const pinTargets = new Map<string, SessionSummary>();
    const navigationTargetByNodeId = new Map<string, string>();
    const pinTargetByNodeId = new Map<string, string>();
    const pinnedSessions = buildPinnedSessionLookup(this.pinStore);
    const bookmarkedSessions = new Set(this.bookmarkStore.getAll().map((entry) => entry.sessionCacheKey));
    const nodes: CodexAgentRunsWebviewNode[] = component.nodes.map((node, index) => {
      const target = node.session && !node.isCurrent
        ? (reusesRelation ? previousSnapshot?.navigationTargetByNodeId.get(node.id) : undefined) ??
          `agent-run-${generation}-${index}`
        : undefined;
      if (target && node.session) {
        targets.set(target, node.session);
        navigationTargetByNodeId.set(node.id, target);
      }
      const actionTarget = node.session
        ? (reusesRelation ? previousSnapshot?.pinTargetByNodeId.get(node.id) : undefined) ??
          `agent-pin-${generation}-${index}`
        : undefined;
      if (actionTarget && node.session) {
        pinTargets.set(actionTarget, node.session);
        pinTargetByNodeId.set(node.id, actionTarget);
      }
      const annotation = node.session ? this.annotationStore.get(node.session.fsPath) : null;
      const titleIsCustom = Boolean(node.session?.customTitle);
      const titleFallback = node.unavailableParent
        ? t("codexAgentRuns.parentUnavailable")
        : t("codexAgentRuns.untitled");
      const sanitizedTitle = sanitizeAgentRunWebviewText(node.session?.displayTitle, titleFallback);
      const title = !titleIsCustom && isSessionProtocolContextTitle(sanitizedTitle)
        ? titleFallback
        : sanitizedTitle;
      return {
        id: node.id,
        ...(node.parentId ? { parentId: node.parentId } : {}),
        ...(target ? { navigationTarget: target } : {}),
        ...(actionTarget ? { actionTarget } : {}),
        title,
        titleIsCustom,
        taskLabel: node.isSubagent ? node.taskLabel : "",
        agentRole: node.isSubagent ? node.agentRole : "",
        started: node.session ? formatAgentRunDateTime(node.session.startedLocalDate, node.session.startedTimeLabel) : "",
        lastActivity: node.session
          ? formatAgentRunDateTime(node.session.lastActivityLocalDate, node.session.lastActivityTimeLabel)
          : "",
        directChildCount: Math.max(0, Math.min(1_000_000, node.directChildCount)),
        isCurrent: node.isCurrent,
        isSubagent: node.isSubagent,
        unavailableParent: node.unavailableParent,
        isPinned: Boolean(node.session && isSessionPinnedInLookup(pinnedSessions, node.session)),
        isBookmarked: Boolean(node.session && bookmarkedSessions.has(node.session.cacheKey)),
        hasTags: Boolean(annotation?.tags.length),
        hasNote: Boolean(annotation?.note.trim()),
      };
    });
    const model: CodexAgentRunsWebviewModel = {
      sessionCount: component.sessionCount,
      agentCount: component.agentCount,
      relationPartial: component.relationPartial,
      omittedCount: component.omittedCount,
      pinRevision: reusesRelation ? this.codexAgentRunPinRevisionByPanel.get(panel) ?? 0 : 0,
      nodes,
    };
    if (reusesRelation && previousSnapshot) {
      previousSnapshot.navigationTargetByNodeId = navigationTargetByNodeId;
      previousSnapshot.pinTargetByNodeId = pinTargetByNodeId;
      previousSnapshot.targets = targets;
      previousSnapshot.pinTargets = pinTargets;
    } else {
      this.codexAgentRunPinRevisionByPanel.set(panel, 0);
      this.codexAgentRunPinSequenceByPanel.delete(panel);
      this.codexAgentRunsSnapshotByPanel.set(panel, {
        generation,
        currentIdentityKey: session.identityKey,
        relationKey,
        navigationTargetByNodeId,
        pinTargetByNodeId,
        targets,
        pinTargets,
      });
    }
    this.postCodexAgentRunsMessage(panel, {
      type: "setCodexAgentRunsState",
      version: 1,
      generation,
      state: "ready",
      model,
      i18n: this.buildI18n(),
    }, "ready");
  }

  private postCodexAgentRunsMessage(
    panel: vscode.WebviewPanel,
    message: Record<string, unknown>,
    scope: string,
  ): void {
    let delivery: PromiseLike<boolean>;
    try {
      delivery = panel.webview.postMessage(message);
    } catch (error) {
      this.logger?.debug(`codexAgentRuns.${scope} delivery failed error=${sanitizeDebugError(error)}`);
      return;
    }
    void Promise.resolve(delivery).catch((error) => {
      this.logger?.debug(`codexAgentRuns.${scope} delivery failed error=${sanitizeDebugError(error)}`);
    });
  }

  private nextCodexAgentRunsGeneration(panel: vscode.WebviewPanel): number {
    const generation = (this.codexAgentRunsGenerationByPanel.get(panel) ?? 0) + 1;
    this.codexAgentRunsGenerationByPanel.set(panel, generation);
    return generation;
  }

  private async handleOpenCodexAgentRun(
    panel: vscode.WebviewPanel,
    msg: any,
    requestSequence: number,
  ): Promise<void> {
    if (!getConfig().agentRunsEnabled) {
      void vscode.window.showInformationMessage(t("codexAgentRuns.disabled"));
      return;
    }
    if (!this.codexAgentRuns.isPresentationEnabled()) {
      void vscode.window.showErrorMessage(t("codexAgentRuns.navigationUnavailable"));
      return;
    }
    const generation = Number(msg?.generation);
    const target = typeof msg?.target === "string" && msg.target.length <= 128 ? msg.target : "";
    const snapshot = this.codexAgentRunsSnapshotByPanel.get(panel);
    if (!snapshot || !Number.isSafeInteger(generation) || generation !== snapshot.generation || !target) {
      void vscode.window.showErrorMessage(t("codexAgentRuns.navigationUnavailable"));
      return;
    }
    const state = this.stateByPanel.get(panel);
    if (!state) {
      void vscode.window.showErrorMessage(t("codexAgentRuns.navigationUnavailable"));
      return;
    }
    const currentSession = this.historyService.findByFsPath(state.fsPath);
    if (!currentSession || currentSession.identityKey !== snapshot.currentIdentityKey) {
      void vscode.window.showErrorMessage(t("codexAgentRuns.navigationUnavailable"));
      return;
    }
    const session = snapshot.targets.get(target);
    if (!session || session.source !== "codex" || session.identityKey === snapshot.currentIdentityKey) {
      void vscode.window.showErrorMessage(t("codexAgentRuns.navigationUnavailable"));
      return;
    }
    if (
      requestSequence < 1 ||
      this.codexAgentRunNavigationSequenceByPanel.get(panel) !== requestSequence ||
      requestSequence <= (this.codexAgentRunNavigationClaimedSequenceByPanel.get(panel) ?? 0)
    ) {
      return;
    }
    this.codexAgentRunNavigationClaimedSequenceByPanel.set(panel, requestSequence);
    const showUnavailableIfLatest = (): void => {
      if (this.codexAgentRunNavigationSequenceByPanel.get(panel) === requestSequence) {
        void vscode.window.showErrorMessage(t("codexAgentRuns.navigationUnavailable"));
      }
    };
    const [sourceFileAvailable, sessionFileAvailable] = await Promise.all([
      this.ensureSessionFileAvailable(state.fsPath),
      this.ensureSessionFileAvailable(session.fsPath),
    ]);
    if (!this.isCurrentCodexAgentRunNavigation(
      panel,
      state,
      snapshot,
      generation,
      target,
      session,
      requestSequence,
    )) {
      showUnavailableIfLatest();
      return;
    }
    if (!sourceFileAvailable) {
      await this.handleMissingSession(panel, state.fsPath);
      return;
    }
    if (!sessionFileAvailable) {
      void vscode.window.showErrorMessage(t("codexAgentRuns.sessionMissing"));
      try {
        await this.onMissingSession?.(session.fsPath);
      } catch (error) {
        this.logger?.debug(`codexAgentRuns missing-session refresh failed error=${sanitizeDebugError(error)}`);
      }
      return;
    }
    const isRequestCurrent = () =>
      this.isCurrentCodexAgentRunNavigation(
        panel,
        state,
        snapshot,
        generation,
        target,
        session,
        requestSequence,
      );
    if (
      await this.revealExistingSessionPanel(
        session.fsPath,
        undefined,
        { preserveFocus: false, isRequestCurrent },
      )
    ) {
      return;
    }
    if (!isRequestCurrent()) {
      showUnavailableIfLatest();
      return;
    }
    await this.openSession(session, { kind: "session", preserveFocus: false, isRequestCurrent });
  }

  private async handleToggleCodexAgentRunPin(
    panel: vscode.WebviewPanel,
    msg: any,
    requestSequence: number,
  ): Promise<void> {
    const generation = Number(msg?.generation);
    const target = typeof msg?.target === "string" && msg.target.length <= 128 ? msg.target : "";
    const desiredPinned = typeof msg?.desiredPinned === "boolean" ? msg.desiredPinned : undefined;
    const snapshot = this.codexAgentRunsSnapshotByPanel.get(panel);
    const state = this.stateByPanel.get(panel);
    const session = target ? snapshot?.pinTargets.get(target) : undefined;
    if (
      !getConfig().agentRunsEnabled ||
      !this.codexAgentRuns.isPresentationEnabled() ||
      !snapshot ||
      !state ||
      !session ||
      session.source !== "codex" ||
      !Number.isSafeInteger(generation) ||
      generation !== snapshot.generation ||
      desiredPinned === undefined ||
      requestSequence < 1
    ) {
      this.postCodexAgentRunPinResult(panel, generation, target, requestSequence, false);
      if (snapshot && this.readyByPanel.get(panel)) this.publishCodexAgentRuns(panel);
      return;
    }

    const requests = this.codexAgentRunPinSequenceByPanel.get(panel) ?? new Map<string, number>();
    const latestRequest = requests.get(target) ?? 0;
    if (requestSequence <= latestRequest) {
      this.postCodexAgentRunPinResult(
        panel,
        generation,
        target,
        requestSequence,
        false,
        isSessionPinned(this.pinStore, session),
      );
      return;
    }
    requests.set(target, requestSequence);
    this.codexAgentRunPinSequenceByPanel.set(panel, requests);

    const [sourceFileAvailable, targetFileAvailable] = await Promise.all([
      this.ensureSessionFileAvailable(state.fsPath),
      this.ensureSessionFileAvailable(session.fsPath),
    ]);
    if (!this.isCurrentCodexAgentRunPinRequest(
      panel,
      state,
      snapshot,
      generation,
      target,
      session,
      requestSequence,
    )) {
      this.postCodexAgentRunPinResult(panel, generation, target, requestSequence, false);
      return;
    }
    if (!sourceFileAvailable) {
      this.postCodexAgentRunPinResult(panel, generation, target, requestSequence, false);
      await this.handleMissingSession(panel, state.fsPath);
      return;
    }
    if (!targetFileAvailable) {
      this.postCodexAgentRunPinResult(panel, generation, target, requestSequence, false);
      void vscode.window.showErrorMessage(t("codexAgentRuns.sessionMissing"));
      try {
        await this.onMissingSession?.(session.fsPath);
      } catch (error) {
        this.logger?.debug(`codexAgentRuns pin missing-session refresh failed error=${sanitizeDebugError(error)}`);
      }
      return;
    }

    const pinnedBefore = isSessionPinned(this.pinStore, session);
    try {
      if (pinnedBefore !== desiredPinned) {
        await vscode.commands.executeCommand(
          desiredPinned ? "codexHistoryViewer.pinSession" : "codexHistoryViewer.unpinSession",
          { fsPath: session.fsPath, identityKey: session.identityKey },
        );
      }
      const isPinned = isSessionPinned(this.pinStore, session);
      if (pinnedBefore === desiredPinned || isPinned !== desiredPinned) {
        this.publishCodexAgentRunPinState(panel);
      }
      this.postCodexAgentRunPinResult(
        panel,
        generation,
        target,
        requestSequence,
        isPinned === desiredPinned,
        isPinned,
      );
      if (isPinned !== desiredPinned) {
        void vscode.window.showErrorMessage(t("codexAgentRuns.pinFailed"));
      }
    } catch (error) {
      this.logger?.debug(`codexAgentRuns pin update failed error=${sanitizeDebugError(error)}`);
      this.publishCodexAgentRunPinState(panel);
      this.postCodexAgentRunPinResult(
        panel,
        generation,
        target,
        requestSequence,
        false,
        isSessionPinned(this.pinStore, session),
      );
      void vscode.window.showErrorMessage(t("codexAgentRuns.pinFailed"));
    }
  }

  private isCurrentCodexAgentRunPinRequest(
    panel: vscode.WebviewPanel,
    requestState: ChatPanelState,
    requestSnapshot: CodexAgentRunsPanelSnapshot,
    generation: number,
    target: string,
    session: SessionSummary,
    requestSequence: number,
  ): boolean {
    const snapshot = this.codexAgentRunsSnapshotByPanel.get(panel);
    const state = this.stateByPanel.get(panel);
    const currentSession = state ? this.historyService.findByFsPath(state.fsPath) : undefined;
    return Boolean(
      this.codexAgentRuns.isPresentationEnabled() &&
      snapshot === requestSnapshot &&
      snapshot.generation === generation &&
      isSameCodexAgentRunTarget(snapshot.pinTargets.get(target), session) &&
      this.codexAgentRunPinSequenceByPanel.get(panel)?.get(target) === requestSequence &&
      state &&
      normalizeCacheKey(state.fsPath) === normalizeCacheKey(requestState.fsPath) &&
      currentSession?.identityKey === snapshot.currentIdentityKey,
    );
  }

  private postCodexAgentRunPinResult(
    panel: vscode.WebviewPanel,
    generation: number,
    target: string,
    requestId: number,
    success: boolean,
    isPinned?: boolean,
  ): void {
    this.postCodexAgentRunsMessage(panel, {
      type: "codexAgentRunPinResult",
      version: 1,
      generation,
      target,
      requestId,
      success,
      ...(isPinned !== undefined ? { isPinned } : {}),
    }, "pinResult");
  }

  private isCurrentCodexAgentRunNavigation(
    panel: vscode.WebviewPanel,
    requestState: ChatPanelState,
    requestSnapshot: CodexAgentRunsPanelSnapshot,
    generation: number,
    target: string,
    session: SessionSummary,
    requestSequence: number,
  ): boolean {
    const snapshot = this.codexAgentRunsSnapshotByPanel.get(panel);
    const state = this.stateByPanel.get(panel);
    const currentSession = state ? this.historyService.findByFsPath(state.fsPath) : undefined;
    return Boolean(
      this.codexAgentRuns.isPresentationEnabled() &&
      snapshot === requestSnapshot &&
      snapshot.generation === generation &&
      isSameCodexAgentRunTarget(snapshot.targets.get(target), session) &&
      this.codexAgentRunNavigationSequenceByPanel.get(panel) === requestSequence &&
      state &&
      normalizeCacheKey(state.fsPath) === normalizeCacheKey(requestState.fsPath) &&
      currentSession?.identityKey === snapshot.currentIdentityKey,
    );
  }

  private scheduleBranchNavigation(
    panel: vscode.WebviewPanel,
    codexSupersededRetryCount = 0,
  ): void {
    const state = this.stateByPanel.get(panel);
    const session = state ? this.historyService.findByFsPath(state.fsPath) : undefined;
    this.cancelBranchNavigation(panel);
    const generation = (this.branchGenerationByPanel.get(panel) ?? 0) + 1;
    this.branchGenerationByPanel.set(panel, generation);
    this.branchSnapshotByPanel.delete(panel);
    this.branchHistoryGenerationByPanel.delete(panel);
    const historyGeneration = this.historyService.getIndexGeneration();
    const config = getConfig();
    const enabled =
      Boolean(session && (session.source === "claude" || session.source === "codex")) &&
      config.branchNavigationEnabled;
    if (!state || !session || !enabled) {
      this.branchSnapshotByPanel.delete(panel);
      this.branchHistoryGenerationByPanel.delete(panel);
      void panel.webview.postMessage({ type: "branchNavigationDisabled", generation });
      return;
    }

    const cancellation = new vscode.CancellationTokenSource();
    this.branchCancellationByPanel.set(panel, cancellation);
    void panel.webview.postMessage({ type: "branchNavigationPending", generation });
    if (session.source === "codex") {
      void this.codexForkNavigation.load(session, {
        shouldContinue: () =>
          this.isCurrentBranchPanelRequest(
            panel,
            state.fsPath,
            generation,
            cancellation,
          ),
      }).then((snapshot) => {
        const snapshotHistoryGeneration = snapshot.indexGeneration;
        if (
          !this.isCurrentBranchRequest(
            panel,
            state.fsPath,
            generation,
            snapshotHistoryGeneration,
            cancellation,
          )
        ) {
          return;
        }
        this.publishBranchNavigation(
          panel,
          snapshot,
          generation,
          false,
          snapshotHistoryGeneration,
        );
      }).catch((error) => {
        if (
          !this.isCurrentBranchPanelRequest(
            panel,
            state.fsPath,
            generation,
            cancellation,
          )
        ) {
          return;
        }
        if (
          error instanceof CodexForkNavigationSupersededError &&
          codexSupersededRetryCount < 1
        ) {
          this.scheduleBranchNavigation(panel, codexSupersededRetryCount + 1);
          return;
        }
        this.logger?.debug(
          formatDebugFields("codexFork navigation failed", {
            session: safeDebugBasename(state.fsPath),
            error: sanitizeDebugError(error),
          }),
        );
        void panel.webview.postMessage({
          type: "branchNavigationError",
          generation,
          message: t("codexForks.loadFailed"),
        });
      }).finally(() => {
        if (this.branchCancellationByPanel.get(panel) === cancellation) {
          this.branchCancellationByPanel.delete(panel);
        }
        cancellation.dispose();
      });
      return;
    }

    void this.branchNavigation.load(session, {
      token: cancellation.token,
      onStoredSnapshot: (snapshot) => {
        if (
          !this.isCurrentBranchRequest(
            panel,
            state.fsPath,
            generation,
            historyGeneration,
            cancellation,
          )
        ) {
          return;
        }
        this.publishBranchNavigation(panel, snapshot, generation, true, historyGeneration);
      },
    }).then((snapshot) => {
      if (
        !this.isCurrentBranchRequest(
          panel,
          state.fsPath,
          generation,
          historyGeneration,
          cancellation,
        )
      ) {
        return;
      }
      this.publishBranchNavigation(panel, snapshot, generation, false, historyGeneration);
    }).catch((error) => {
      if (
        !this.isCurrentBranchRequest(
          panel,
          state.fsPath,
          generation,
          historyGeneration,
          cancellation,
        )
      ) {
        return;
      }
      this.logger?.debug(
        formatDebugFields("claudeBranch navigation failed", {
          session: safeDebugBasename(state.fsPath),
          error: sanitizeDebugError(error),
        }),
      );
      void panel.webview.postMessage({
        type: "branchNavigationError",
        generation,
        message: t("claudeBranches.loadFailed"),
      });
    }).finally(() => {
      if (this.branchCancellationByPanel.get(panel) === cancellation) {
        this.branchCancellationByPanel.delete(panel);
      }
      cancellation.dispose();
    });
  }

  private publishBranchNavigation(
    panel: vscode.WebviewPanel,
    snapshot: BranchNavigationSnapshot,
    generation: number,
    checkingLatest: boolean,
    historyGeneration = this.branchHistoryGenerationByPanel.get(panel),
  ): void {
    const state = this.stateByPanel.get(panel);
    if (!state) return;
    const activeSession = this.historyService.findByFsPath(state.fsPath);
    if (
      !getConfig().branchNavigationEnabled ||
      this.branchGenerationByPanel.get(panel) !== generation ||
      historyGeneration === undefined ||
      this.historyService.getIndexGeneration() !== historyGeneration ||
      !activeSession ||
      (isCodexForkNavigationSnapshot(snapshot)
        ? activeSession.source !== "codex"
        : activeSession.source !== "claude")
    ) {
      return;
    }
    const activeSessionCacheKey = activeSession.cacheKey;
    const navigation = isCodexForkNavigationSnapshot(snapshot)
      ? buildCodexForkChatBranchNavigationModel(
          snapshot,
          activeSessionCacheKey,
          generation,
          this.userMessageIndexesByPanel.get(panel),
          state.revealMessageIndex,
        )
      : buildClaudeChatBranchNavigationModel(
          snapshot,
          activeSessionCacheKey,
          generation,
          this.userMessageIndexesByPanel.get(panel),
          state.revealMessageIndex,
        );
    const i18n = this.buildI18n();
    if (isCodexForkNavigationSnapshot(snapshot)) {
      i18n.branchSwitchFailed = t("codexForks.switchFailed");
      i18n.branchNone = t("codexForks.none");
      i18n.branchLoadFailed = t("codexForks.loadFailed");
    }
    this.branchSnapshotByPanel.set(panel, snapshot);
    this.branchHistoryGenerationByPanel.set(panel, historyGeneration);
    void panel.webview.postMessage({
      type: "branchNavigation",
      navigation,
      checkingLatest,
      i18n,
    });
  }

  private handleClaudeBranchOverlayPageRequest(panel: vscode.WebviewPanel, msg: any): void {
    const snapshot = this.branchSnapshotByPanel.get(panel);
    const state = this.stateByPanel.get(panel);
    const generation = sanitizeBranchGeneration(msg?.generation);
    if (
      !getConfig().branchNavigationEnabled ||
      !snapshot ||
      !state ||
      generation !== this.branchGenerationByPanel.get(panel) ||
      this.branchHistoryGenerationByPanel.get(panel) !== this.historyService.getIndexGeneration()
    ) {
      return;
    }
    const session = this.historyService.findByFsPath(state.fsPath);
    if (
      !session ||
      (isCodexForkNavigationSnapshot(snapshot)
        ? session.source !== "codex"
        : session.source !== "claude")
    ) {
      return;
    }
    const cursor = sanitizeBranchCursor(msg?.cursor);
    const focusGroupId = sanitizeBranchModelId(msg?.groupId);
    if (!cursor && !focusGroupId) {
      void panel.webview.postMessage({ type: "branchTreePageError", generation });
      return;
    }
    const options = {
      ...(cursor ? { cursor } : {}),
      ...(focusGroupId ? { focusGroupId } : {}),
      activeChatMessageIndex: state.revealMessageIndex,
    };
    const overlay = isCodexForkNavigationSnapshot(snapshot)
      ? buildCodexForkBranchOverlayPage(snapshot, session.cacheKey, generation, options)
      : buildClaudeBranchOverlayPage(snapshot, session.cacheKey, generation, options);
    void panel.webview.postMessage({ type: "branchTreePage", generation, overlay });
  }

  private handleClaudeBranchChoicePageRequest(panel: vscode.WebviewPanel, msg: any): void {
    const snapshot = this.branchSnapshotByPanel.get(panel);
    const state = this.stateByPanel.get(panel);
    const generation = sanitizeBranchGeneration(msg?.generation);
    if (
      !getConfig().branchNavigationEnabled ||
      !snapshot ||
      !state ||
      generation !== this.branchGenerationByPanel.get(panel) ||
      this.branchHistoryGenerationByPanel.get(panel) !== this.historyService.getIndexGeneration()
    ) {
      return;
    }
    const session = this.historyService.findByFsPath(state.fsPath);
    if (
      !session ||
      (isCodexForkNavigationSnapshot(snapshot)
        ? session.source !== "codex"
        : session.source !== "claude")
    ) {
      return;
    }
    const groupId = sanitizeBranchModelId(msg?.groupId);
    const cursor = sanitizeBranchCursor(msg?.cursor);
    if (!groupId || !cursor) {
      void panel.webview.postMessage({ type: "branchTreePageError", generation });
      return;
    }
    const group = isCodexForkNavigationSnapshot(snapshot)
      ? buildCodexForkBranchChoicePage(
          snapshot,
          session.cacheKey,
          groupId,
          cursor,
          state.revealMessageIndex,
        )
      : buildClaudeBranchChoicePage(
          snapshot,
          session.cacheKey,
          groupId,
          cursor,
          state.revealMessageIndex,
        );
    if (!group) {
      void panel.webview.postMessage({ type: "branchTreePageError", generation });
      return;
    }
    void panel.webview.postMessage({ type: "branchTreeChoicePage", generation, group });
  }

  private isCurrentBranchRequest(
    panel: vscode.WebviewPanel,
    fsPath: string,
    generation: number,
    historyGeneration: number,
    cancellation: vscode.CancellationTokenSource,
  ): boolean {
    return (
      this.isCurrentBranchPanelRequest(panel, fsPath, generation, cancellation) &&
      this.historyService.getIndexGeneration() === historyGeneration
    );
  }

  private isCurrentBranchPanelRequest(
    panel: vscode.WebviewPanel,
    fsPath: string,
    generation: number,
    cancellation: vscode.CancellationTokenSource,
  ): boolean {
    const state = this.stateByPanel.get(panel);
    const session = state ? this.historyService.findByFsPath(state.fsPath) : undefined;
    return Boolean(
      state &&
      session &&
      (session.source === "claude" || session.source === "codex") &&
      getConfig().branchNavigationEnabled &&
      !cancellation.token.isCancellationRequested &&
      this.branchGenerationByPanel.get(panel) === generation &&
      normalizeCacheKey(state.fsPath) === normalizeCacheKey(fsPath),
    );
  }

  private cancelBranchNavigation(panel: vscode.WebviewPanel): void {
    const cancellation = this.branchCancellationByPanel.get(panel);
    cancellation?.cancel();
    cancellation?.dispose();
    this.branchCancellationByPanel.delete(panel);
  }

  private async handleClaudeBranchSwitch(
    panel: vscode.WebviewPanel,
    msg: any,
    requestSequence: number,
  ): Promise<void> {
    const snapshot = this.branchSnapshotByPanel.get(panel);
    const state = this.stateByPanel.get(panel);
    const activeSource = state ? this.historyService.findByFsPath(state.fsPath)?.source : undefined;
    const fail = (
      message = t(activeSource === "codex" ? "codexForks.switchFailed" : "claudeBranches.switchFailed"),
    ): void => {
      if (this.branchSwitchSequenceByPanel.get(panel) !== requestSequence) return;
      void panel.webview.postMessage({
        type: "branchSwitchFailed",
        requestId: requestSequence,
        message,
      });
    };
    if (!snapshot || !state) {
      fail();
      return;
    }
    const historyGeneration = this.branchHistoryGenerationByPanel.get(panel);
    if (
      historyGeneration === undefined ||
      historyGeneration !== this.historyService.getIndexGeneration()
    ) {
      fail();
      return;
    }
    if (isCodexForkNavigationSnapshot(snapshot)) {
      await this.handleCodexForkSwitch(
        panel,
        msg,
        requestSequence,
        state,
        snapshot,
        historyGeneration,
      );
      return;
    }
    if (!getConfig().branchNavigationEnabled) {
      fail();
      return;
    }
    const claudeSnapshot = snapshot as ClaudeBranchNavigationSnapshot;
    const generation = sanitizeBranchGeneration(msg?.generation);
    if (generation !== this.branchGenerationByPanel.get(panel)) {
      fail();
      return;
    }
    const groupId = sanitizeBranchModelId(msg?.groupId);
    const choiceId = sanitizeBranchModelId(msg?.choiceId);
    const occurrenceId = sanitizeBranchOccurrenceId(msg?.occurrenceId);
    const group = claudeSnapshot.model.groups.find((candidate) => candidate.id === groupId);
    const choice = group?.choices.find((candidate) => candidate.id === choiceId);
    if (!group || !choice) {
      fail();
      return;
    }
    const targetOccurrenceId = occurrenceId || (choice.occurrenceIds.length === 1 ? choice.occurrenceIds[0]! : "");
    const activeSession = this.historyService.findByFsPath(state.fsPath);
    if (
      !targetOccurrenceId ||
      !choice.occurrenceIds.includes(targetOccurrenceId) ||
      !activeSession ||
      activeSession.source !== "claude" ||
      !isClaudeBranchTargetInActiveLineage(
        claudeSnapshot,
        activeSession.cacheKey,
        groupId,
        choiceId,
        targetOccurrenceId,
        state.revealMessageIndex,
      )
    ) {
      fail();
      return;
    }
    const occurrence = claudeSnapshot.occurrenceById.get(targetOccurrenceId);
    if (!occurrence || occurrence.chatMessageIndex < 1) {
      fail();
      return;
    }
    const targetKind =
      msg?.targetKind === "historyFirst" ||
      msg?.targetKind === "preBranch" ||
      msg?.targetKind === "historyEnd"
        ? msg.targetKind
        : "branchStart";
    const entry = claudeSnapshot.entryByCacheKey.get(occurrence.sessionCacheKey);
    const targetAnchor =
      targetKind === "historyFirst"
        ? entry?.claudeMessageBounds?.first
        : targetKind === "preBranch"
          ? occurrence.previousVisibleMessage
          : targetKind === "historyEnd"
            ? entry?.claudeMessageBounds?.last
            : occurrence;
    const revealMessageIndex = targetAnchor?.chatMessageIndex;
    if (typeof revealMessageIndex !== "number" || !Number.isSafeInteger(revealMessageIndex) || revealMessageIndex < 1) {
      fail();
      return;
    }
    const direction = msg?.direction === "previous" ? "previous" : msg?.direction === "next" ? "next" : "direct";
    const session = this.historyService.getIndex().byCacheKey.get(occurrence.sessionCacheKey) ??
      this.historyService.getIndex().byIdentityKey.get(occurrence.sessionIdentityKey);
    if (
      requestSequence < 1 ||
      this.branchSwitchSequenceByPanel.get(panel) !== requestSequence ||
      requestSequence <= (this.branchSwitchClaimedSequenceByPanel.get(panel) ?? 0)
    ) {
      return;
    }
    this.branchSwitchClaimedSequenceByPanel.set(panel, requestSequence);
    if (!session || session.source !== "claude") {
      fail(t("claudeBranches.sessionMissing"));
      return;
    }
    const request: BranchSwitchRequest = {
      state,
      snapshot: claudeSnapshot,
      generation,
      historyGeneration,
      requestSequence,
    };
    const sourceFileAvailable = await this.ensureSessionFileAvailable(state.fsPath);
    if (!this.isCurrentClaudeBranchSwitchRequest(panel, request)) {
      this.cancelClaudeBranchSwitchIfLatest(panel, request);
      return;
    }
    if (!sourceFileAvailable) {
      await this.handleMissingSession(panel, state.fsPath);
      return;
    }
    if (normalizeCacheKey(session.fsPath) === normalizeCacheKey(state.fsPath)) {
      this.stateByPanel.set(panel, { ...state, revealMessageIndex });
      this.publishBranchNavigation(panel, claudeSnapshot, generation, false);
      void panel.webview.postMessage({
        type: "branchSwitchSucceeded",
        requestId: requestSequence,
        messageIndex: revealMessageIndex,
      });
      return;
    }
    const switched = await this.switchBranchPanelToSession(
      panel,
      session,
      revealMessageIndex,
      direction,
      request,
    );
    if (switched) {
      void panel.webview.postMessage({
        type: "branchSwitchSucceeded",
        requestId: requestSequence,
        messageIndex: revealMessageIndex,
      });
    }
  }

  private async handleCodexForkSwitch(
    panel: vscode.WebviewPanel,
    msg: any,
    requestSequence: number,
    state: ChatPanelState,
    snapshot: CodexForkNavigationSnapshot,
    historyGeneration: number,
  ): Promise<void> {
    const fail = (message = t("codexForks.switchFailed")): void => {
      if (this.branchSwitchSequenceByPanel.get(panel) !== requestSequence) return;
      void panel.webview.postMessage({
        type: "branchSwitchFailed",
        requestId: requestSequence,
        message,
      });
    };
    if (!getConfig().branchNavigationEnabled) {
      fail();
      return;
    }
    const generation = sanitizeBranchGeneration(msg?.generation);
    if (generation !== this.branchGenerationByPanel.get(panel)) {
      fail();
      return;
    }
    const groupId = sanitizeBranchModelId(msg?.groupId);
    const choiceId = sanitizeBranchModelId(msg?.choiceId);
    const occurrenceId = sanitizeBranchOccurrenceId(msg?.occurrenceId);
    const group = snapshot.groups.find((candidate) => candidate.id === groupId);
    const choice = group?.choices.find((candidate) => candidate.id === choiceId);
    const targetOccurrenceId = occurrenceId || choice?.occurrence.id || "";
    const activeSession = this.historyService.findByFsPath(state.fsPath);
    if (
      !group ||
      !choice ||
      targetOccurrenceId !== choice.occurrence.id ||
      !activeSession ||
      activeSession.source !== "codex" ||
      !isCodexForkTargetInActiveLineage(
        snapshot,
        activeSession.cacheKey,
        groupId,
        choiceId,
        targetOccurrenceId,
        state.revealMessageIndex,
      )
    ) {
      fail();
      return;
    }
    const targetKind =
      msg?.targetKind === "historyFirst" ||
      msg?.targetKind === "preBranch" ||
      msg?.targetKind === "historyEnd"
        ? msg.targetKind
        : "branchStart";
    const targetAnchor =
      targetKind === "historyFirst"
        ? choice.occurrence.historyFirst
        : targetKind === "preBranch"
          ? choice.occurrence.preBranch
          : targetKind === "historyEnd"
            ? choice.occurrence.historyEnd
            : choice.occurrence.branchStart;
    const revealMessageIndex = targetAnchor?.chatMessageIndex;
    if (
      typeof revealMessageIndex !== "number" ||
      !Number.isSafeInteger(revealMessageIndex) ||
      revealMessageIndex < 1
    ) {
      fail();
      return;
    }
    if (
      requestSequence < 1 ||
      this.branchSwitchSequenceByPanel.get(panel) !== requestSequence ||
      requestSequence <= (this.branchSwitchClaimedSequenceByPanel.get(panel) ?? 0)
    ) {
      return;
    }
    this.branchSwitchClaimedSequenceByPanel.set(panel, requestSequence);
    const request: BranchSwitchRequest = {
      state,
      snapshot,
      generation,
      historyGeneration,
      requestSequence,
    };
    const [sourceFileAvailable, resolved] = await Promise.all([
      this.ensureSessionFileAvailable(state.fsPath),
      this.codexForkNavigation.validateTarget(
        snapshot,
        activeSession.cacheKey,
        groupId,
        choiceId,
        targetOccurrenceId,
        state.revealMessageIndex,
      ),
    ]);
    if (!this.isCurrentClaudeBranchSwitchRequest(panel, request)) {
      this.cancelClaudeBranchSwitchIfLatest(panel, request);
      return;
    }
    if (!sourceFileAvailable) {
      await this.handleMissingSession(panel, state.fsPath);
      return;
    }
    if (!resolved || resolved.session.source !== "codex") {
      fail();
      return;
    }
    const direction =
      msg?.direction === "previous" ? "previous" : msg?.direction === "next" ? "next" : "direct";
    const validateResolvedTarget = async (): Promise<boolean> => {
      const revalidated = await this.codexForkNavigation.validateTarget(
        snapshot,
        activeSession.cacheKey,
        groupId,
        choiceId,
        targetOccurrenceId,
        state.revealMessageIndex,
      );
      return Boolean(
        revalidated &&
        revalidated.session.cacheKey === resolved.session.cacheKey &&
        revalidated.session.identityKey === resolved.session.identityKey &&
        normalizeCacheKey(revalidated.session.fsPath) === normalizeCacheKey(resolved.session.fsPath),
      );
    };
    if (normalizeCacheKey(resolved.session.fsPath) === normalizeCacheKey(state.fsPath)) {
      const targetStillValid = await validateResolvedTarget();
      if (!this.isCurrentClaudeBranchSwitchRequest(panel, request)) {
        this.cancelClaudeBranchSwitchIfLatest(panel, request);
        return;
      }
      if (!targetStillValid) {
        fail();
        return;
      }
      this.stateByPanel.set(panel, { ...state, revealMessageIndex });
      this.publishBranchNavigation(panel, snapshot, generation, false);
      void panel.webview.postMessage({
        type: "branchSwitchSucceeded",
        requestId: requestSequence,
        messageIndex: revealMessageIndex,
      });
      return;
    }
    const switched = await this.switchBranchPanelToSession(
      panel,
      resolved.session,
      revealMessageIndex,
      direction,
      request,
      validateResolvedTarget,
    );
    if (switched) {
      void panel.webview.postMessage({
        type: "branchSwitchSucceeded",
        requestId: requestSequence,
        messageIndex: revealMessageIndex,
      });
    }
  }

  private async switchBranchPanelToSession(
    panel: vscode.WebviewPanel,
    session: SessionSummary,
    revealMessageIndex: number,
    direction: "previous" | "next" | "direct",
    request: BranchSwitchRequest,
    validatePreparedState?: () => Promise<boolean>,
  ): Promise<boolean> {
    if (!this.isCurrentClaudeBranchSwitchRequest(panel, request)) {
      this.cancelClaudeBranchSwitchIfLatest(panel, request);
      return false;
    }
    const sessionFileAvailable = await this.ensureSessionFileAvailable(session.fsPath);
    if (!this.isCurrentClaudeBranchSwitchRequest(panel, request)) {
      this.cancelClaudeBranchSwitchIfLatest(panel, request);
      return false;
    }
    if (!sessionFileAvailable) {
      void panel.webview.postMessage({
        type: "branchSwitchFailed",
        requestId: request.requestSequence,
        message: t(
          isCodexForkNavigationSnapshot(request.snapshot)
            ? "codexForks.sessionMissing"
            : "claudeBranches.sessionMissing",
        ),
      });
      return false;
    }
    const candidate: ChatPanelState = {
      fsPath: session.fsPath,
      revealMessageIndex,
      kind: "branch",
      autoRefreshMode: DEFAULT_CHAT_WEBVIEW_AUTO_REFRESH_MODE,
      pendingAutoRefresh: false,
    };
    void panel.webview.postMessage({
      type: "branchSwitchPending",
      requestId: request.requestSequence,
      generation: request.generation,
      direction,
    });
    const sent = await this.sendSessionData(panel, {
      stateOverride: candidate,
      branchGeneration: request.generation,
      transitionDirection: direction,
      suppressOpenError: true,
      validatePreparedState,
      commitStateTransition: () => {
        if (!this.isCurrentClaudeBranchSwitchRequest(panel, request)) return false;
        this.transitionPanelToBranch(panel, request.state.fsPath);
        this.cancelBranchNavigation(panel);
        this.branchSnapshotByPanel.delete(panel);
        this.branchHistoryGenerationByPanel.delete(panel);
        return true;
      },
    });
    if (!sent) {
      if (this.isCurrentClaudeBranchSwitchRequest(panel, request)) {
        void panel.webview.postMessage({
          type: "branchSwitchFailed",
          requestId: request.requestSequence,
          message: t(
            isCodexForkNavigationSnapshot(request.snapshot)
              ? "codexForks.switchFailed"
              : "claudeBranches.switchFailed",
          ),
        });
      } else {
        this.cancelClaudeBranchSwitchIfLatest(panel, request);
      }
      return false;
    }
    panel.title = buildPanelTitle(session);
    panel.iconPath = this.resolveSessionIconPath(session);
    this.notifyAutoRefreshConsumerVisibilityChanged();
    return true;
  }

  private cancelClaudeBranchSwitchIfLatest(
    panel: vscode.WebviewPanel,
    request: BranchSwitchRequest,
  ): void {
    if (this.branchSwitchSequenceByPanel.get(panel) !== request.requestSequence) return;
    void panel.webview.postMessage({
      type: "branchSwitchCancelled",
      requestId: request.requestSequence,
    });
  }

  private isCurrentClaudeBranchSwitchRequest(
    panel: vscode.WebviewPanel,
    request: BranchSwitchRequest,
  ): boolean {
    return (
      this.stateByPanel.get(panel) === request.state &&
      this.branchSnapshotByPanel.get(panel) === request.snapshot &&
      this.branchGenerationByPanel.get(panel) === request.generation &&
      this.branchHistoryGenerationByPanel.get(panel) === request.historyGeneration &&
      this.historyService.getIndexGeneration() === request.historyGeneration &&
      this.branchSwitchSequenceByPanel.get(panel) === request.requestSequence
    );
  }

  private async sendSessionData(
    panel: vscode.WebviewPanel,
    options?: ChatSessionDataOptions,
  ): Promise<boolean> {
    const currentState = this.stateByPanel.get(panel);
    const state = options?.stateOverride ?? currentState;
    if (!state) return false;
    const request = this.beginSessionDataRequest(
      panel,
      options?.stateOverride !== undefined,
      currentState,
      options?.supersedeTransition === true,
    );
    if (!request) return false;
    try {
      return await this.sendSessionDataForRequest(panel, currentState, state, request, options);
    } finally {
      this.completeSessionDataRequest(panel, request);
    }
  }

  private async sendSessionDataForRequest(
    panel: vscode.WebviewPanel,
    currentState: ChatPanelState | undefined,
    state: ChatPanelState,
    request: ChatSessionDataRequest,
    options?: ChatSessionDataOptions,
  ): Promise<boolean> {
    const isCurrent = (): boolean =>
      this.isSessionDataRequestCurrent(panel, request, currentState, options);
    const sessionFileAvailable = await this.ensureSessionFileAvailable(state.fsPath);
    if (!isCurrent()) return false;
    if (!sessionFileAvailable) {
      if (!options?.stateOverride && currentState) {
        await this.handleMissingSession(panel, currentState.fsPath);
      }
      return false;
    }

    const config = getConfig();
    const detailMode = resolveSessionDetailMode(options?.detailMode, state);
    const totalStartedAt = nowMs();
    let buildMs = 0;
    let statsMs = 0;
    this.logger?.debug(
      formatDebugFields("chatSession send start", {
        session: safeDebugBasename(state.fsPath),
        detailMode,
        panelKind: state.kind,
      }),
    );
    let model: Awaited<ReturnType<typeof buildChatSessionModel>>;
    try {
      const buildStartedAt = nowMs();
      model = await buildChatSessionModel(state.fsPath, {
        images: config.images,
        includeDetails: detailMode === "full",
        turnTimelineMode: config.chatTurnTimelineMode,
      });
      buildMs = elapsedMs(buildStartedAt);
    } catch (error) {
      if (!isCurrent()) return false;
      if (!options?.stateOverride && currentState) {
        const stillAvailable = await this.ensureSessionFileAvailable(currentState.fsPath);
        if (!isCurrent()) return false;
        if (!stillAvailable) {
          await this.handleMissingSession(panel, currentState.fsPath);
          return false;
        }
      }
      if (!options?.suppressOpenError) void vscode.window.showErrorMessage(t("app.openSessionFailed"));
      this.logger?.debug(
        formatDebugFields("chatSession send fail", {
          session: safeDebugBasename(state.fsPath),
          detailMode,
          totalMs: elapsedMs(totalStartedAt),
          error: sanitizeDebugError(error),
        }),
      );
      return false;
    }
    if (!isCurrent()) return false;

    const sessionCwd = typeof model.meta?.cwd === "string" ? model.meta.cwd : undefined;
    const sessionDisplayCwd = sessionCwd ? (this.projectAssociationStore.getDisplayCwd(sessionCwd) ?? sessionCwd) : undefined;
    const pathModeState = this.resolveChatPathModeState(
      sessionCwd,
      sessionDisplayCwd,
      state.pathMode,
      state.pathModeEnabled,
    );
    const nextState: ChatPanelState = {
      ...state,
      sessionCwd,
      sessionDisplayCwd,
      detailMode,
      pathMode: pathModeState.mode,
      pathModeEnabled: pathModeState.enabled,
      restoreScrollY: undefined,
      restoreTopMessageIndex: undefined,
    };
    const summary = this.historyService.findByFsPath(nextState.fsPath);
    if (config.chatTurnTimelineMode === "live") {
      model = await this.withLiveRunningTurnStatus(model, nextState, panel, summary, config);
      if (!isCurrent()) return false;
    }
    const statsStartedAt = nowMs();
    const performanceStats = await buildChatPerformanceStats(nextState.fsPath, model);
    statsMs = elapsedMs(statsStartedAt);
    if (!isCurrent()) return false;
    if (options?.validatePreparedState && !await options.validatePreparedState()) return false;
    if (!isCurrent()) return false;
    if (options?.commitStateTransition && !options.commitStateTransition()) return false;
    if (!isCurrent()) return false;
    if (currentState && normalizeCacheKey(currentState.fsPath) !== normalizeCacheKey(nextState.fsPath)) {
      this.clearSessionBoundPanelData(panel);
    }
    const committedState = nextState.pageSearchSeed
      ? { ...nextState, pageSearchSeed: undefined }
      : nextState;
    this.stateByPanel.set(panel, committedState);
    this.markSessionDataTransitionCommitted(panel, request, committedState);
    this.sessionDataCommitSequenceByPanel.set(panel, request.sequence);
    this.imageDataByPanel.set(panel, collectSaveableImages(model));
    this.documentDataByPanel.set(panel, collectSaveableDocuments(model));
    const annotation = this.annotationStore.get(nextState.fsPath);
    const dateTime = this.buildDateTime();
    const savedOpenMessageIndex =
      config.chatOpenPosition === "lastMessage" ? this.openPositionStore.get(nextState.fsPath) : undefined;
    this.logger?.debug(
      `chatOpenPosition send session=${debugSessionName(nextState.fsPath)} mode=${config.chatOpenPosition} panelKind=${nextState.kind} saved=${savedOpenMessageIndex ?? "none"}`,
    );
    const bookmarkState = this.withBookmarkState(toWebviewChatSessionModel(model, detailMode), nextState.fsPath, panel);
    const webviewModel: ChatSessionModel = {
      ...bookmarkState.model,
      meta: {
        ...bookmarkState.model.meta,
        ...(sessionDisplayCwd && sessionCwd && sessionDisplayCwd !== sessionCwd ? { displayCwd: sessionDisplayCwd } : {}),
      },
      ...(summary
        ? {
            sessionLocation: {
              archiveState: summary.storage.archiveState,
              rootKind: summary.storage.rootKind,
            },
          }
        : {}),
    };
    this.userMessageIndexesByPanel.set(
      panel,
      new Set(
        webviewModel.items.flatMap((item) =>
          item.type === "message" && item.role === "user" && typeof item.messageIndex === "number"
            ? [item.messageIndex]
            : [],
        ),
      ),
    );
    const delivery = panel.webview.postMessage({
      type: "sessionData",
      model: {
        ...webviewModel,
        annotation: {
          tags: annotation?.tags ? [...annotation.tags] : [],
          note: annotation?.note ?? "",
        },
      },
      revealMessageIndex: nextState.revealMessageIndex,
      revealTarget: nextState.revealTarget,
      restoreScrollY: options?.restoreScrollY,
      restoreSelectedMessageIndex: options?.restoreSelectedMessageIndex,
      preserveUiState: options?.preserveUiState === true,
      autoScrollToBottom: options?.autoScrollToBottom === true,
      panelKind: nextState.kind,
      isPreview: nextState.kind === "reusable",
      isPinned: (() => {
        const session = this.historyService.findByFsPath(nextState.fsPath);
        return session ? isSessionPinned(this.pinStore, session) : this.pinStore.isPinned(nextState.fsPath);
      })(),
      bookmarks: bookmarkState.bookmarkKeys,
      i18n: this.buildI18n(),
      dateTime,
      chatOpenPosition: config.chatOpenPosition,
      autoRefreshAvailable: config.autoRefresh.enabled,
      autoRefreshMode: nextState.autoRefreshMode,
      pathMode: pathModeState.mode,
      pathModeEnabled: pathModeState.enabled,
      pageSearchSeed: nextState.pageSearchSeed,
      searchHistoryCandidates: this.getSearchHistoryCandidates(this.resolveSearchHistoryProjectKey(nextState.sessionCwd)),
      savedOpenMessageIndex,
      debugLoggingEnabled: this.logger?.isDebugEnabled() ?? false,
      timeGuideEnabled: config.timeGuideEnabled,
      stickyUserPrompt: config.stickyUserPrompt,
      turnTimelineMode: config.chatTurnTimelineMode,
      chatPerformanceMode: config.chatPerformanceMode,
      performanceStats,
      toolDisplayMode: config.toolDisplayMode,
      userLongMessageFolding: config.userLongMessageFolding,
      assistantLongMessageFolding: config.assistantLongMessageFolding,
      imageSettings: this.buildImageSettings(config),
      detailMode,
      detailsLoaded: detailMode === "full",
      transitionDirection: options?.transitionDirection,
      codexAgentRunsGenerationBoundary: this.codexAgentRunsGenerationByPanel.get(panel) ?? 0,
    });
    this.logger?.debug(
      formatDebugFields("chatSession send done", {
        session: safeDebugBasename(nextState.fsPath),
        detailMode,
        panelKind: nextState.kind,
        totalMs: elapsedMs(totalStartedAt),
        buildMs,
        statsMs,
        items: performanceStats.itemCount,
        patchGroups: performanceStats.diffGroupCount,
        patchEntries: performanceStats.diffEntryCount,
        diffLineEstimate: performanceStats.diffLineEstimate,
        images: performanceStats.imageCount,
        fileSizeBytes: performanceStats.fileSizeBytes,
      }),
    );
    this.scheduleBranchNavigation(panel);
    this.publishCodexAgentRuns(panel);
    const delivered = await delivery;
    if (!delivered || this.sessionDataCommitSequenceByPanel.get(panel) !== request.sequence) return false;
    const latestState = this.stateByPanel.get(panel);
    return Boolean(
      latestState &&
      latestState.kind === committedState.kind &&
      normalizeCacheKey(latestState.fsPath) === normalizeCacheKey(committedState.fsPath),
    );
  }

  private beginSessionDataRequest(
    panel: vscode.WebviewPanel,
    transition: boolean,
    startingState: ChatPanelState | undefined,
    supersedeTransition = false,
  ): ChatSessionDataRequest | null {
    const activeTransition = this.sessionDataTransitionByPanel.get(panel);
    if (
      !transition &&
      activeTransition &&
      !supersedeTransition &&
      isSameChatPanelSession(this.stateByPanel.get(panel), activeTransition.protectedState)
    ) {
      return null;
    }
    const sequence = (this.sessionDataRequestSequenceByPanel.get(panel) ?? 0) + 1;
    this.sessionDataRequestSequenceByPanel.set(panel, sequence);
    if (transition) {
      this.sessionDataTransitionByPanel.set(panel, { sequence, protectedState: startingState });
    } else if (activeTransition) {
      this.sessionDataTransitionByPanel.delete(panel);
    }
    return { sequence, transition };
  }

  private isSessionDataRequestCurrent(
    panel: vscode.WebviewPanel,
    request: ChatSessionDataRequest,
    startingState: ChatPanelState | undefined,
    options: ChatSessionDataOptions | undefined,
  ): boolean {
    if (this.sessionDataRequestSequenceByPanel.get(panel) !== request.sequence) return false;
    const transitionReservation = this.sessionDataTransitionByPanel.get(panel);
    if (
      request.transition
        ? transitionReservation?.sequence !== request.sequence
        : transitionReservation !== undefined
    ) {
      return false;
    }
    if (startingState ? this.stateByPanel.get(panel) !== startingState : this.stateByPanel.has(panel)) return false;
    if (
      typeof options?.branchGeneration === "number" &&
      this.branchGenerationByPanel.get(panel) !== options.branchGeneration
    ) {
      return false;
    }
    return !options?.isRequestCurrent || options.isRequestCurrent();
  }

  private markSessionDataTransitionCommitted(
    panel: vscode.WebviewPanel,
    request: ChatSessionDataRequest,
    committedState: ChatPanelState,
  ): void {
    const reservation = this.sessionDataTransitionByPanel.get(panel);
    if (request.transition && reservation?.sequence === request.sequence) {
      reservation.protectedState = committedState;
    }
  }

  private completeSessionDataRequest(
    panel: vscode.WebviewPanel,
    request: ChatSessionDataRequest,
  ): void {
    if (
      request.transition &&
      this.sessionDataTransitionByPanel.get(panel)?.sequence === request.sequence
    ) {
      this.sessionDataTransitionByPanel.delete(panel);
    }
  }

  private withBookmarkState(model: ChatSessionModel, sessionFsPath: string, panel: vscode.WebviewPanel): ChatBookmarkState {
    const sessionCacheKey = normalizeCacheKey(sessionFsPath);
    const targets = new Map<string, BookmarkTarget>();
    const itemTargets = new Map<number, BookmarkTarget>();

    const items = Array.isArray(model.items)
      ? model.items.map((item, itemIndex) => {
          const target = buildChatBookmarkTarget(sessionFsPath, sessionCacheKey, item, itemIndex);
          if (!target) return item;
          targets.set(target.key, target);
          itemTargets.set(itemIndex, target);
          return { ...item, bookmarkKey: target.key };
        })
      : [];

    const bookmarkedKeys = this.bookmarkStore.getKeysForTargets(Array.from(targets.values()));
    const itemsWithState = items.map((item, itemIndex) => {
      const target = itemTargets.get(itemIndex);
      return target ? { ...item, isBookmarked: bookmarkedKeys.has(target.key) } : item;
    });
    this.bookmarkTargetsByPanel.set(panel, targets);
    return {
      model: {
        ...model,
        items: itemsWithState,
      },
      bookmarkKeys: Array.from(bookmarkedKeys.values()),
    };
  }

  private resolveSearchHistoryProjectKey(cwd: string | null | undefined): string {
    const raw = typeof cwd === "string" ? cwd.trim() : "";
    if (!raw) return GLOBAL_SEARCH_HISTORY_PROJECT_KEY;
    const projectKey = this.projectAssociationStore.isEmpty()
      ? normalizeProjectKey(raw)
      : (this.projectAssociationStore.getCanonicalProjectKey(raw) ?? normalizeProjectKey(raw));
    return normalizeSearchHistoryProjectKey(projectKey);
  }

  private getSearchHistoryCandidates(projectKey: string | null | undefined): SearchHistoryWebviewCandidate[] {
    const normalizedProjectKey = normalizeSearchHistoryProjectKey(projectKey);
    return this.searchHistoryStore.getAll(normalizedProjectKey).map((entry) => ({
      ...entry,
      key: buildSearchHistoryEntryKey(entry.projectKey, entry.queryInput),
    }));
  }

  private async loadPatchEntryDetails(panel: vscode.WebviewPanel, msg: any): Promise<void> {
    const state = this.stateByPanel.get(panel);
    if (!state) return;
    if (!(await this.ensurePanelSessionFile(panel, state))) return;
    const startedAt = nowMs();

    const target = sanitizePatchEntryDetailTarget(msg?.entry);
    if (!target) {
      await panel.webview.postMessage({
        type: "patchEntryDetailsFailed",
        fsPath: state.fsPath,
        entryId: "",
        message: t("chat.patch.detailsLoadFailed"),
      });
      this.logger?.debug(
        formatDebugFields("patchDetails fail", {
          session: safeDebugBasename(state.fsPath),
          reason: "invalidTarget",
          totalMs: elapsedMs(startedAt),
        }),
      );
      return;
    }

    const pending = this.patchEntryDetailRequestsByPanel.get(panel) ?? new Set<string>();
    this.patchEntryDetailRequestsByPanel.set(panel, pending);
    if (pending.has(target.entryId)) return;
    pending.add(target.entryId);
    this.logger?.debug(
      formatDebugFields("patchDetails start", {
        session: safeDebugBasename(state.fsPath),
        changeType: target.changeType,
      }),
    );

    try {
      const entry = await buildChatPatchEntryDetails(state.fsPath, target);
      if (this.stateByPanel.get(panel) !== state) return;
      if (!entry) {
        await panel.webview.postMessage({
          type: "patchEntryDetailsFailed",
          fsPath: state.fsPath,
          entryId: target.entryId,
          message: t("chat.patch.detailsLoadFailed"),
        });
        this.logger?.debug(
          formatDebugFields("patchDetails fail", {
            session: safeDebugBasename(state.fsPath),
            reason: "notFound",
            changeType: target.changeType,
            totalMs: elapsedMs(startedAt),
          }),
        );
        return;
      }

      await panel.webview.postMessage({
        type: "patchEntryDetails",
        fsPath: state.fsPath,
        entryId: target.entryId,
        entry: toFullPatchEntry(entry),
      });
      this.logger?.debug(
        formatDebugFields("patchDetails done", {
          session: safeDebugBasename(state.fsPath),
          changeType: entry.changeType,
          added: entry.added,
          removed: entry.removed,
          totalMs: elapsedMs(startedAt),
        }),
      );
    } catch (error) {
      if (this.stateByPanel.get(panel) !== state) return;
      await panel.webview.postMessage({
        type: "patchEntryDetailsFailed",
        fsPath: state.fsPath,
        entryId: target.entryId,
        message: t("chat.patch.detailsLoadFailed"),
      });
      this.logger?.debug(
        formatDebugFields("patchDetails fail", {
          session: safeDebugBasename(state.fsPath),
          changeType: target.changeType,
          totalMs: elapsedMs(startedAt),
          error: sanitizeDebugError(error),
        }),
      );
    } finally {
      pending.delete(target.entryId);
    }
  }

  private buildImageSettings(config: ReturnType<typeof getConfig>): { thumbnailSize: "small" | "medium" | "large" } {
    return {
      thumbnailSize: config.images.thumbnailSize,
    };
  }

  private async saveImageFromPanel(panel: vscode.WebviewPanel, msg: any): Promise<void> {
    const state = this.stateByPanel.get(panel);
    if (!this.isCurrentPanelSessionRequest(state, msg, "saveImage")) return;

    const imageId = typeof msg?.imageId === "string" ? msg.imageId.trim() : "";
    if (!imageId) return;

    const image = this.imageDataByPanel.get(panel)?.get(imageId);
    if (!image) {
      void vscode.window.showErrorMessage(t("chat.image.saveFailed", t("chat.image.invalid")));
      return;
    }

    const decoded = decodeImageDataUri(image.src);
    if (!decoded) {
      void vscode.window.showErrorMessage(t("chat.image.saveFailed", t("chat.image.invalid")));
      return;
    }

    const defaultUri = buildDefaultImageSaveUri(resolveSessionSaveCwd(state), image.label, decoded.extension);
    const targetUri = await vscode.window.showSaveDialog({
      title: t("chat.image.saveDialogTitle"),
      defaultUri,
      filters: {
        [t("chat.image.saveFilter")]: [decoded.extension.slice(1)],
      },
    });
    if (!targetUri) return;

    try {
      await vscode.workspace.fs.writeFile(targetUri, decoded.bytes);
      void vscode.window.showInformationMessage(t("chat.image.saved"));
    } catch (error) {
      void vscode.window.showErrorMessage(t("chat.image.saveFailed", formatError(error)));
    }
  }

  private sendImageDataToPanel(panel: vscode.WebviewPanel, msg: any): void {
    const state = this.stateByPanel.get(panel);
    const imageId = typeof msg?.imageId === "string" ? msg.imageId.trim() : "";
    if (!state || !imageId || imageId.length > 160) return;

    const requestedFsPath = typeof msg?.fsPath === "string" ? msg.fsPath.trim() : "";
    if (requestedFsPath && normalizeCacheKey(requestedFsPath) !== normalizeCacheKey(state.fsPath)) {
      return;
    }

    const image = this.imageDataByPanel.get(panel)?.get(imageId);
    if (!image) {
      void panel.webview.postMessage({ type: "imageDataFailed", fsPath: state.fsPath, imageId });
      return;
    }

    void panel.webview.postMessage({
      type: "imageData",
      fsPath: state.fsPath,
      imageId,
      src: image.src,
      mimeType: image.mimeType,
      label: image.label,
    });
  }

  private async saveAttachmentFromPanel(panel: vscode.WebviewPanel, msg: any): Promise<void> {
    const state = this.stateByPanel.get(panel);
    if (!this.isCurrentPanelSessionRequest(state, msg, "saveAttachment")) return;

    const attachmentId = typeof msg?.attachmentId === "string" ? msg.attachmentId.trim() : "";
    if (!attachmentId) return;

    const document = this.documentDataByPanel.get(panel)?.get(attachmentId);
    if (!document) {
      void vscode.window.showErrorMessage(t("chat.attachment.saveFailed", t("chat.attachment.saveUnavailable")));
      return;
    }

    const decoded = decodeDocumentPayload(document);
    if (!decoded) {
      void vscode.window.showErrorMessage(t("chat.attachment.saveFailed", t("chat.attachment.saveUnavailable")));
      return;
    }

    const defaultUri = buildDefaultAttachmentSaveUri(resolveSessionSaveCwd(state), document.label, decoded.extension);
    const targetUri = await vscode.window.showSaveDialog({
      title: t("chat.attachment.saveDialogTitle"),
      defaultUri,
      filters: {
        [t("chat.attachment.saveFilter")]: [decoded.extension.slice(1)],
      },
    });
    if (!targetUri) return;

    try {
      await vscode.workspace.fs.writeFile(targetUri, decoded.bytes);
      void vscode.window.showInformationMessage(t("chat.attachment.saved"));
    } catch (error) {
      void vscode.window.showErrorMessage(t("chat.attachment.saveFailed", formatError(error)));
    }
  }

  private isCurrentPanelSessionRequest(state: ChatPanelState | undefined, msg: any, operation: string): state is ChatPanelState {
    if (!state) {
      this.logger?.debug(formatDebugFields(`chatAttachment ${operation} ignored`, { reason: "missingState" }));
      return false;
    }

    const requestedFsPath = typeof msg?.fsPath === "string" ? msg.fsPath.trim() : "";
    if (!requestedFsPath) {
      this.logger?.debug(
        formatDebugFields(`chatAttachment ${operation} ignored`, {
          session: safeDebugBasename(state.fsPath),
          reason: "missingFsPath",
        }),
      );
      return false;
    }

    if (normalizeCacheKey(requestedFsPath) !== normalizeCacheKey(state.fsPath)) {
      this.logger?.debug(
        formatDebugFields(`chatAttachment ${operation} ignored`, {
          session: safeDebugBasename(state.fsPath),
          requested: safeDebugBasename(requestedFsPath),
          reason: "staleFsPath",
        }),
      );
      return false;
    }

    return true;
  }

  private async openAttachmentTargetFromPanel(panel: vscode.WebviewPanel, msg: any): Promise<void> {
    const state = this.stateByPanel.get(panel);
    if (!state) return;

    const rawFsPath = typeof msg?.fsPath === "string" ? msg.fsPath.trim() : "";
    if (!rawFsPath) return;

    const requestedLine =
      typeof msg?.line === "number" && Number.isFinite(msg.line) && msg.line >= 1 ? Math.floor(msg.line) : undefined;
    const requestedColumn =
      typeof msg?.column === "number" && Number.isFinite(msg.column) && msg.column >= 1
        ? Math.floor(msg.column)
        : undefined;
    const target = await resolveLocalFileLinkTarget(rawFsPath, {
      requestedLine,
      requestedColumn,
      baseDirs: collectChatLocalLinkBaseDirs(
        state,
        ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
      ),
      projectPathMappings: buildChatProjectPathMappings(state),
    });

    if (!target) {
      void vscode.window.showErrorMessage(t("chat.attachment.openFailed", rawFsPath));
      return;
    }

    const opened =
      typeof target.line === "number" ? await openLinkedFileInEditor(target) : await openFileWithVsCodeOpenCommand(target.fsPath);
    if (!opened) {
      void vscode.window.showErrorMessage(t("chat.attachment.openFailed", rawFsPath));
    }
  }

  private resolveChatPathModeState(
    sessionCwd: string | undefined,
    sessionDisplayCwd: string | undefined,
    requestedMode: ChatWebviewPathMode | undefined,
    previousEnabled: boolean | undefined,
  ): { mode: ChatWebviewPathMode; enabled: boolean } {
    const cwd = typeof sessionCwd === "string" ? sessionCwd.trim() : "";
    const displayCwd = typeof sessionDisplayCwd === "string" ? sessionDisplayCwd.trim() : "";
    const association = cwd ? this.projectAssociationStore.getBySourceCwd(cwd) : null;
    const enabled =
      association?.mode === "relocate" &&
      !!cwd &&
      !!displayCwd &&
      normalizeCacheKey(cwd) !== normalizeCacheKey(displayCwd);
    if (!enabled) return { mode: "recorded", enabled: false };
    const mode = requestedMode === "recorded" && previousEnabled !== false ? "recorded" : "relocated";
    return { mode, enabled: true };
  }

  private buildI18n(): Record<string, string> {
    return {
      resumeInCodex: t("chat.button.resumeInCodex"),
      resumeInCodexTooltip: t("chat.tooltip.resumeInCodex"),
      restoreArchived: t("chat.button.restoreArchived"),
      restoreArchivedTooltip: t("chat.tooltip.restoreArchived"),
      sessionLocationArchived: t("session.location.archived"),
      originalCwd: t("chat.meta.originalCwd"),
      relocatedCwd: t("chat.meta.relocatedCwd"),
      pathModeRecorded: t("chat.pathMode.recorded"),
      pathModeRelocated: t("chat.pathMode.relocated"),
      pathModeRecordedTooltip: t("chat.tooltip.pathModeRecorded"),
      pathModeRelocatedTooltip: t("chat.tooltip.pathModeRelocated"),
      pathModeDisabledTooltip: t("chat.tooltip.pathModeDisabled"),
      resumeInClaude: t("chat.button.resumeInClaude"),
      resumeInClaudeTooltip: t("chat.tooltip.resumeInClaude"),
      pin: t("chat.button.pin"),
      unpin: t("chat.button.unpin"),
      pinTooltip: t("chat.tooltip.pin"),
      unpinTooltip: t("chat.tooltip.unpin"),
      bookmarkAddTooltip: t("chat.tooltip.bookmarkAdd"),
      bookmarkRemoveTooltip: t("chat.tooltip.bookmarkRemove"),
      customTitle: t("chat.button.customTitle"),
      customTitleTooltip: t("chat.tooltip.customTitle"),
      markdown: t("chat.button.markdown"),
      markdownTooltip: t("chat.tooltip.markdown"),
      copyResume: t("chat.button.copyResume"),
      // Tooltip explains the purpose of the "Copy Quick Prompt" action.
      copyResumeTooltip: t("chat.tooltip.copyResume"),
      reload: t("chat.button.reload"),
      reloadTooltip: t("chat.tooltip.reload"),
      scrollTop: t("chat.button.scrollTop"),
      scrollTopTooltip: t("chat.tooltip.scrollTop"),
      scrollBottom: t("chat.button.scrollBottom"),
      scrollBottomTooltip: t("chat.tooltip.scrollBottom"),
      autoRefreshOffTooltip: t("chat.tooltip.autoRefreshOff"),
      autoRefreshPreserveTooltip: t("chat.tooltip.autoRefreshPreserve"),
      autoRefreshFollowTooltip: t("chat.tooltip.autoRefreshFollow"),
      detailsOn: t("chat.button.detailsOn"),
      detailsOff: t("chat.button.detailsOff"),
      detailsOnTooltip: t("chat.tooltip.detailsOn"),
      detailsOffTooltip: t("chat.tooltip.detailsOff"),
      pageSearch: t("chat.pageSearch.title"),
      pageSearchTooltip: t("chat.pageSearch.tooltip"),
      pageSearchPlaceholder: t("chat.pageSearch.placeholder"),
      pageSearchPrevTooltip: t("chat.pageSearch.prevTooltip"),
      pageSearchNextTooltip: t("chat.pageSearch.nextTooltip"),
      pageSearchCloseTooltip: t("chat.pageSearch.closeTooltip"),
      pageSearchNoMatches: t("chat.pageSearch.noMatches"),
      pageSearchTypeToSearch: t("chat.pageSearch.typeToSearch"),
      pageSearchInvalidQuery: t("chat.pageSearch.invalidQuery"),
      pageSearchInvalidRegex: t("chat.pageSearch.invalidRegex"),
      pageSearchNoHistory: t("chat.pageSearch.noHistory"),
      pageSearchCaseSensitive: t("chat.pageSearch.caseSensitive"),
      pageSearchRemoveHistory: t("chat.pageSearch.removeHistory"),
      pageSearchRoleFilters: t("chat.pageSearch.roleFilters"),
      pageSearchRoleFilterOnlyTooltip: t("chat.pageSearch.roleFilterOnlyTooltip"),
      pageSearchRoleFilterAddTooltip: t("chat.pageSearch.roleFilterAddTooltip"),
      pageSearchRoleFilterRemoveTooltip: t("chat.pageSearch.roleFilterRemoveTooltip"),
      pageSearchRoleFilterRemoveToAllTooltip: t("chat.pageSearch.roleFilterRemoveToAllTooltip"),
      memoryCitationSummary: t("chat.memoryCitation.summary"),
      memoryCitationEntryRange: t("chat.memoryCitation.entryRange"),
      memoryCitationEntryLine: t("chat.memoryCitation.entryLine"),
      memoryCitationNote: t("chat.memoryCitation.note"),
      memoryCitationRelatedSessions: t("chat.memoryCitation.relatedSessions"),
      sessionStartContextSummary: t("chat.sessionStartContext.summary"),
      sessionStartContextDescription: t("chat.sessionStartContext.description"),
      timeGuideDates: t("fileChangeHistory.guide.dates"),
      copied: t("chat.toast.copied"),
      restoredLastPosition: t("chat.toast.restoredLastPosition"),
      autoRefreshOffToast: t("chat.toast.autoRefreshOff"),
      autoRefreshPreserveToast: t("chat.toast.autoRefreshPreserve"),
      autoRefreshFollowToast: t("chat.toast.autoRefreshFollow"),
      tool: t("chat.label.tool"),
      arguments: t("chat.label.arguments"),
      output: t("chat.label.output"),
      sessionInfo: t("chat.label.sessionInfo"),
      turnStart: t("chat.turn.start"),
      turnRunning: t("chat.turn.running"),
      turnCompleted: t("chat.turn.completed"),
      turnInterrupted: t("chat.turn.interrupted"),
      turnRolledBack: t("chat.turn.rolledBack"),
      turnIncomplete: t("chat.turn.incomplete"),
      turnUnknown: t("chat.turn.unknown"),
      turnLabel: t("chat.turn.label"),
      turnNumberLabel: t("chat.turn.numberLabel"),
      turnCollapse: t("chat.turn.collapse"),
      turnExpand: t("chat.turn.expand"),
      turnCollapsed: t("chat.turn.collapsed"),
      turnExpandedForSearch: t("chat.turn.expandedForSearch"),
      turnDuration: t("chat.turn.duration"),
      turnElapsed: t("chat.turn.elapsed"),
      turnLastActivity: t("chat.turn.lastActivity"),
      turnObservedAt: t("chat.turn.observedAt"),
      turnEnd: t("chat.turn.end"),
      turnDurationSeconds: t("chat.turn.duration.seconds"),
      turnDurationMinutesSeconds: t("chat.turn.duration.minutesSeconds"),
      turnDurationHoursMinutesSeconds: t("chat.turn.duration.hoursMinutesSeconds"),
      turnRangeLabel: t("chat.turn.rangeLabel"),
      turnJumpToRunning: t("chat.turn.jumpToRunning"),
      turnItemCount: t("chat.turn.items"),
      turnToolCount: t("chat.turn.tools"),
      turnPatchCount: t("chat.turn.patches"),
      turnTokenInput: t("chat.turn.tokens.input"),
      turnTokenOutput: t("chat.turn.tokens.output"),
      turnTokenTotal: t("chat.turn.tokens.total"),
      turnUsageRecords: t("chat.turn.usageRecords"),
      patchFilesEdited: t("chat.patch.filesEdited"),
      patchShowMoreFiles: t("chat.patch.showMoreFiles"),
      patchShowFewerFiles: t("chat.patch.showFewerFiles"),
      patchOpenAllDiffs: t("chat.patch.openAllDiffs"),
      patchCloseAllDiffs: t("chat.patch.closeAllDiffs"),
      patchOpenAllDiffsTooltip: t("chat.patch.openAllDiffsTooltip"),
      patchCloseAllDiffsTooltip: t("chat.patch.closeAllDiffsTooltip"),
      patchRevert: t("chat.patch.revert"),
      usage: t("chat.usage.title"),
      usageTokensInOut: t("chat.usage.tokensInOut"),
      usageTokensIn: t("chat.usage.tokensIn"),
      usageTokensOut: t("chat.usage.tokensOut"),
      usageInput: t("chat.usage.input"),
      usageOutput: t("chat.usage.output"),
      usageCachedInput: t("chat.usage.cachedInput"),
      usageCacheRead: t("chat.usage.cacheRead"),
      usageCacheWrite: t("chat.usage.cacheWrite"),
      usageReasoning: t("chat.usage.reasoning"),
      usageTotal: t("chat.usage.total"),
      usageContextWindow: t("chat.usage.contextWindow"),
      usageContextUsed: t("chat.usage.contextUsed"),
      usageContextUsedValue: t("chat.usage.contextUsedValue"),
      usageServiceTier: t("chat.usage.serviceTier"),
      usageSpeed: t("chat.usage.speed"),
      usageStopReason: t("chat.usage.stopReason"),
      usageRateLimitPrimary: t("chat.usage.rateLimitPrimary"),
      usageRateLimitSecondary: t("chat.usage.rateLimitSecondary"),
      usageRateLimitPlan: t("chat.usage.rateLimitPlan"),
      usageRateLimitReached: t("chat.usage.rateLimitReached"),
      usageRateLimitUsed: t("chat.usage.rateLimitUsed"),
      usageRateLimitWindow: t("chat.usage.rateLimitWindow"),
      usageRateLimitWindowHours: t("chat.usage.rateLimitWindowHours"),
      usageRateLimitWindowDays: t("chat.usage.rateLimitWindowDays"),
      usageRateLimitResetAt: t("chat.usage.rateLimitResetAt"),
      usageRateLimitResetIn: t("chat.usage.rateLimitResetIn"),
      usageCumulative: t("chat.usage.cumulative"),
      environment: t("chat.environment.title"),
      environmentCwd: t("chat.environment.cwd"),
      environmentBranch: t("chat.environment.branch"),
      environmentCommit: t("chat.environment.commit"),
      environmentDirty: t("chat.environment.dirty"),
      environmentClean: t("chat.environment.clean"),
      systemEventInterruptedBadge: t("chat.systemEvent.interrupted.badge"),
      systemEventInterruptedTitle: t("chat.systemEvent.interrupted.title"),
      systemEventInterruptedToolUseTitle: t("chat.systemEvent.interrupted.toolUseTitle"),
      systemEventInterruptedDescription: t("chat.systemEvent.interrupted.description"),
      systemEventInterruptedRolledBack: t("chat.systemEvent.interrupted.rolledBack"),
      systemEventLocalCommandBadge: t("chat.systemEvent.localCommandOutput.badge"),
      systemEventLocalCommandTitle: t("chat.systemEvent.localCommandOutput.title"),
      systemEventDetailReason: t("chat.systemEvent.detail.reason"),
      systemEventDetailDuration: t("chat.systemEvent.detail.duration"),
      systemEventDetailTurnId: t("chat.systemEvent.detail.turnId"),
      systemEventDetailRolledBackTurns: t("chat.systemEvent.detail.rolledBackTurns"),
      roleUser: t("chat.role.user"),
      roleAssistant: t("chat.role.assistant"),
      roleDeveloper: t("chat.role.developer"),
      roleMessage: t("chat.role.message"),
      imageUnavailable: t("chat.image.unavailable"),
      imageTooLarge: t("chat.image.tooLarge"),
      imageUnsupported: t("chat.image.unsupported"),
      imageMissing: t("chat.image.missing"),
      imageRemote: t("chat.image.remote"),
      imageInvalid: t("chat.image.invalid"),
      imageDisabled: t("chat.image.disabled"),
      imageOpenPreview: t("chat.image.openPreview"),
      imageClosePreview: t("chat.image.closePreview"),
      imageFitPreview: t("chat.image.fitPreview"),
      imageActualSize: t("chat.image.actualSize"),
      imageSave: t("chat.image.save"),
      imagePrevious: t("chat.image.previous"),
      imageNext: t("chat.image.next"),
      imageLoading: t("chat.image.loading"),
      imageAttachmentLabel: t("chat.image.attachmentLabel"),
      attachmentOpen: t("chat.attachment.open"),
      attachmentSave: t("chat.attachment.save"),
      attachmentFileReference: t("chat.attachment.fileReference"),
      attachmentOpenedFile: t("chat.attachment.openedFile"),
      attachmentSelection: t("chat.attachment.selection"),
      attachmentDocument: t("chat.attachment.document"),
      attachmentPdf: t("chat.attachment.pdf"),
      attachmentText: t("chat.attachment.text"),
      attachmentCode: t("chat.attachment.code"),
      attachmentImageReference: t("chat.attachment.imageReference"),
      attachmentWord: t("chat.attachment.word"),
      attachmentExcel: t("chat.attachment.excel"),
      attachmentPowerPoint: t("chat.attachment.powerPoint"),
      attachmentArchive: t("chat.attachment.archive"),
      attachmentGenericFile: t("chat.attachment.genericFile"),
      attachmentPreview: t("chat.attachment.preview"),
      attachmentTooLarge: t("chat.attachment.tooLarge"),
      attachmentUnsupported: t("chat.attachment.unsupported"),
      attachmentMissing: t("chat.attachment.missing"),
      attachmentUnavailable: t("chat.attachment.unavailable"),
      attachmentTotalCount: t("chat.attachment.totalCount"),
      taskNotificationTitle: t("chat.notification.task.title"),
      taskNotificationResult: t("chat.notification.task.result"),
      taskNotificationUsage: t("chat.notification.task.usage"),
      taskNotificationUsageTokens: t("chat.notification.task.usage.tokens"),
      taskNotificationUsageToolUses: t("chat.notification.task.usage.toolUses"),
      taskNotificationStatusCompleted: t("chat.notification.task.status.completed"),
      taskNotificationStatusFailed: t("chat.notification.task.status.failed"),
      taskNotificationStatusRunning: t("chat.notification.task.status.running"),
      taskNotificationStatusCancelled: t("chat.notification.task.status.cancelled"),
      taskNotificationStatusUnknown: t("chat.notification.task.status.unknown"),
      invokeTitle: t("chat.invoke.title"),
      invokeParameter: t("chat.invoke.parameter"),
      invokeDescription: t("chat.invoke.description"),
      invokeExpand: t("chat.invoke.expand"),
      invokeCollapse: t("chat.invoke.collapse"),
      copy: t("chat.button.copy"),
      showMore: t("chat.button.showMore"),
      showLess: t("chat.button.showLess"),
      stickyUserAriaLabel: t("chat.stickyUser.ariaLabel"),
      stickyUserAttachmentOnly: t("chat.stickyUser.attachmentOnly"),
      stickyUserOpenOriginal: t("chat.stickyUser.openOriginal"),
      copyMessageTooltip: t("chat.tooltip.copyMessage"),
      copyCodeTooltip: t("chat.tooltip.copyCode"),
      expandCardWidthTooltip: t("chat.tooltip.expandCardWidth"),
      restoreCardWidthTooltip: t("chat.tooltip.restoreCardWidth"),
      patchWrapOn: t("chat.patch.wrapOn"),
      patchWrapOff: t("chat.patch.wrapOff"),
      patchWrapOnTooltip: t("chat.patch.wrapOnTooltip"),
      patchWrapOffTooltip: t("chat.patch.wrapOffTooltip"),
      patchJumpTooltip: t("chat.patch.jumpTooltip"),
      patchGroupTitle: t("chat.patch.groupTitle"),
      patchGroupCount: t("chat.patch.groupCount"),
      patchExpand: t("chat.patch.expand"),
      patchCollapse: t("chat.patch.collapse"),
      patchBefore: t("chat.patch.before"),
      patchAfter: t("chat.patch.after"),
      patchNoDiff: t("chat.patch.noDiff"),
      patchMovedTo: t("chat.patch.movedTo"),
      patchDetailsLoadFailed: t("chat.patch.detailsLoadFailed"),
      patchDetailsRetry: t("chat.patch.detailsRetry"),
      performanceAutoNormal: t("chat.performance.autoNormal"),
      performanceAutoSimplified: t("chat.performance.autoSimplified"),
      performanceNormal: t("chat.performance.normal"),
      performanceSimplified: t("chat.performance.simplified"),
      performanceLargeHistoryToast: t("chat.performance.largeHistoryToast"),
      performanceSwitchedAuto: t("chat.performance.switchedAuto"),
      performanceSwitchedNormal: t("chat.performance.switchedNormal"),
      performanceSwitchedSimplified: t("chat.performance.switchedSimplified"),
      toolStatus: t("chat.toolCard.meta.status"),
      toolExitCode: t("chat.toolCard.meta.exitCode"),
      toolDuration: t("chat.toolCard.meta.duration"),
      toolStatusSuccess: t("chat.toolCard.status.success"),
      toolStatusCompleted: t("chat.toolCard.status.completed"),
      toolStatusError: t("chat.toolCard.status.error"),
      toolStatusTimeout: t("chat.toolCard.status.timeout"),
      toolStatusInterrupted: t("chat.toolCard.status.interrupted"),
      toolStatusCancelled: t("chat.toolCard.status.cancelled"),
      jumpPrevDiff: t("chat.nav.prevDiff"),
      jumpNextDiff: t("chat.nav.nextDiff"),
      jumpPrevUser: t("chat.nav.prevUser"),
      jumpNextUser: t("chat.nav.nextUser"),
      jumpPrevAssistant: t("chat.nav.prevAssistant"),
      jumpNextAssistant: t("chat.nav.nextAssistant"),
      annotationTags: t("chat.annotation.tags"),
      annotationNote: t("chat.annotation.note"),
      annotationNone: t("chat.annotation.none"),
      annotationEdit: t("chat.annotation.edit"),
      annotationFilterTag: t("chat.annotation.filterTag"),
      annotationRemoveTag: t("chat.annotation.removeTag"),
      annotationShowMore: t("chat.annotation.showMore"),
      annotationShowLess: t("chat.annotation.showLess"),
      detailsLoading: t("chat.details.loading"),
      codeCommentLabel: t("chat.codeComment.label"),
      codeCommentFile: t("chat.codeComment.file"),
      codeCommentLines: t("chat.codeComment.lines"),
      codeCommentUnparsedTitle: t("chat.codeComment.unparsedTitle"),
      codeCommentUnparsedEmptyBody: t("chat.codeComment.unparsedEmptyBody"),
      branchControlLabel: t("claudeBranches.controlLabel"),
      branchPrevious: t("claudeBranches.previous"),
      branchNext: t("claudeBranches.next"),
      branchPosition: t("claudeBranches.position"),
      branchOccurrencePosition: t("claudeBranches.occurrencePosition"),
      branchMap: t("claudeBranches.showMap"),
      branchMapTooltip: t("claudeBranches.showMapCount"),
      branchChooseSession: t("claudeBranches.chooseSession"),
      branchChooseHistory: t("claudeBranches.chooseHistory"),
      branchUnknownSession: t("claudeBranches.unknownSession"),
      branchBookmark: t("claudeBranches.bookmark"),
      branchTags: t("claudeBranches.tags"),
      branchNote: t("claudeBranches.note"),
      branchOverlaySummary: t("claudeBranches.overlaySummary"),
      branchCloseOverlay: t("claudeBranches.closeOverlay"),
      branchCurrent: t("claudeBranches.current"),
      branchExpandPreview: t("claudeBranches.expandPreview"),
      branchCollapsePreview: t("claudeBranches.collapsePreview"),
      branchOpenInChat: t("claudeBranches.openInChat"),
      branchOccurrencePartial: t("claudeBranches.occurrencePartial"),
      branchPartialWarning: t("claudeBranches.partialWarning"),
      branchShowCurrent: t("claudeBranches.showCurrent"),
      branchUntitled: t("claudeBranches.untitled"),
      branchHistoryStart: t("claudeBranches.historyStart"),
      branchHistoryStartAndBefore: t("claudeBranches.historyStartAndBefore"),
      branchFromStart: t("claudeBranches.fromStart"),
      branchDestination: t("claudeBranches.destination"),
      branchFit: t("claudeBranches.fit"),
      branchZoomOut: t("claudeBranches.zoomOut"),
      branchZoomIn: t("claudeBranches.zoomIn"),
      branchCollapsedPoints: t("claudeBranches.collapsedPoints"),
      branchCollapsedChoices: t("claudeBranches.collapsedChoices"),
      branchBefore: t("claudeBranches.before"),
      branchEnd: t("claudeBranches.end"),
      branchRoleUser: t("claudeBranches.roleUser"),
      branchRoleAssistant: t("claudeBranches.roleAssistant"),
      branchSwitchFailed: t("claudeBranches.switchFailed"),
      branchNone: t("claudeBranches.none"),
      branchLoadFailed: t("claudeBranches.loadFailed"),
      agentRunsTitle: t("codexAgentRuns.title"),
      agentRunsShow: t("codexAgentRuns.show"),
      agentRunsLoading: t("codexAgentRuns.loading"),
      agentRunsNone: t("codexAgentRuns.none"),
      agentRunsRelatedCount: t("codexAgentRuns.relatedCount"),
      agentRunsSubagent: t("codexAgentRuns.subagent"),
      agentRunsCurrent: t("codexAgentRuns.current"),
      agentRunsStarted: t("codexAgentRuns.started"),
      agentRunsLastActivity: t("codexAgentRuns.lastActivity"),
      agentRunsOpenSession: t("codexAgentRuns.openSession"),
      agentRunsPinSession: t("codexAgentRuns.pinSession"),
      agentRunsUnpinSession: t("codexAgentRuns.unpinSession"),
      agentRunsParentUnavailable: t("codexAgentRuns.parentUnavailable"),
      agentRunsDirectChildren: t("codexAgentRuns.directChildren"),
      agentRunsPartialWarning: t("codexAgentRuns.partialWarning"),
      agentRunsOmitted: t("codexAgentRuns.omitted"),
      agentRunsClose: t("codexAgentRuns.close"),
      agentRunsShowFirst: t("codexAgentRuns.showFirst"),
      agentRunsShowLast: t("codexAgentRuns.showLast"),
      agentRunsShowCurrent: t("codexAgentRuns.showCurrent"),
      agentRunsBookmark: t("codexAgentRuns.bookmark"),
      agentRunsTags: t("codexAgentRuns.tags"),
      agentRunsNote: t("codexAgentRuns.note"),
      agentRunsOtherRun: t("codexAgentRuns.otherRun"),
    };
  }

  private buildDateTime(): { timeZone: string } {
    // Resolve the display time zone from UI language settings (ja=JST, auto/en=system).
    const { timeZone } = resolveDateTimeSettings();
    return { timeZone };
  }

  private async withLiveRunningTurnStatus(
    model: ChatSessionModel,
    state: ChatPanelState,
    panel: vscode.WebviewPanel,
    summary: SessionSummary | undefined,
    config: ReturnType<typeof getConfig>,
  ): Promise<ChatSessionModel> {
    const turns = Array.isArray(model.turns) ? model.turns : [];
    if (turns.length === 0) return model;

    const activeTurnId = normalizeChatTurnId(model.activeTurnId);
    const activeTurn = activeTurnId ? turns.find((turn) => normalizeChatTurnId(turn.id) === activeTurnId) : undefined;
    let liveRunningTurnId: string | undefined;

    if (
      activeTurn &&
      activeTurn.status === "incomplete" &&
      isActiveCodexSessionPath(state.fsPath, summary, config) &&
      isPanelObservingLiveSession(panel, state, this.readyByPanel.get(panel) === true)
    ) {
      const mtimeMs = await readSessionMtimeMs(state.fsPath);
      const now = Date.now();
      const ageMs = typeof mtimeMs === "number" ? now - mtimeMs : undefined;
      const mtimeIsTrustworthy = typeof ageMs === "number" && Number.isFinite(ageMs) && ageMs >= 0;
      const mtimeIsRecent = mtimeIsTrustworthy && ageMs <= LIVE_RUNNING_STALE_MS;
      if (mtimeIsRecent) {
        liveRunningTurnId = activeTurn.id;
      }
    }

    const activeTurnItemCount = getTurnItemCount(activeTurn);
    const nextTurns =
      liveRunningTurnId || !activeTurn || activeTurnItemCount > 0
        ? turns
        : turns.filter((turn) => normalizeChatTurnId(turn.id) !== activeTurnId);
    const modelWithoutLiveTurnState: ChatSessionModel = { ...model };
    delete modelWithoutLiveTurnState.activeTurnId;
    delete modelWithoutLiveTurnState.liveRunningTurnId;
    const keepActiveTurnId = !!(liveRunningTurnId || activeTurnItemCount > 0);

    return {
      ...modelWithoutLiveTurnState,
      turns: nextTurns.map((turn) => ({
        ...turn,
        displayStatus: liveRunningTurnId && turn.id === liveRunningTurnId ? "running" : turn.status,
      })),
      ...(liveRunningTurnId ? { liveRunningTurnId } : {}),
      ...(keepActiveTurnId && model.activeTurnId ? { activeTurnId: model.activeTurnId } : {}),
    };
  }

  private async refreshPanelTitleFromFile(panel: vscode.WebviewPanel): Promise<void> {
    const titleRefreshSequence = this.nextTitleRefreshSequence(panel);
    const state = this.stateByPanel.get(panel);
    if (!state) return;
    if (!(await this.ensurePanelSessionFile(panel, state))) return;
    if (!this.isTitleRefreshCurrent(panel, state, titleRefreshSequence)) return;

    const config = getConfig();
    const existingSummary = this.historyService.isCurrentIndexForConfig(config)
      ? this.historyService.findByFsPath(state.fsPath)
      : undefined;
    const summary =
      existingSummary ??
      (await buildSessionSummary({
        sessionsRoot: config.sessionsRoot,
        fsPath: state.fsPath,
        previewMaxMessages: config.previewMaxMessages,
        timeZone: this.buildDateTime().timeZone,
      }));
    if (!summary) return;
    if (!this.isTitleRefreshCurrent(panel, state, titleRefreshSequence)) return;

    const displaySummary = await this.historyService.resolveDisplaySummary(
      applyPanelHistoryDateBasis(summary, config.historyDateBasis),
      config,
    );
    if (!this.isTitleRefreshCurrent(panel, state, titleRefreshSequence)) return;
    panel.title = buildPanelTitle(displaySummary);
    panel.iconPath = this.resolveSessionIconPath(displaySummary);
  }

  private nextTitleRefreshSequence(panel: vscode.WebviewPanel): number {
    const sequence = (this.titleRefreshSequenceByPanel.get(panel) ?? 0) + 1;
    this.titleRefreshSequenceByPanel.set(panel, sequence);
    return sequence;
  }

  private isTitleRefreshCurrent(
    panel: vscode.WebviewPanel,
    state: ChatPanelState,
    sequence: number,
  ): boolean {
    return (
      this.stateByPanel.get(panel) === state &&
      this.titleRefreshSequenceByPanel.get(panel) === sequence
    );
  }

  private async ensureSessionFileAvailable(fsPath: string): Promise<boolean> {
    const trimmed = typeof fsPath === "string" ? fsPath.trim() : "";
    if (!trimmed) return false;
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(trimmed));
      return (stat.type & vscode.FileType.File) !== 0;
    } catch {
      return false;
    }
  }

  private async ensurePanelSessionFile(panel: vscode.WebviewPanel, state: ChatPanelState): Promise<boolean> {
    const available = await this.ensureSessionFileAvailable(state.fsPath);
    if (this.stateByPanel.get(panel) !== state) return false;
    if (available) return true;
    await this.handleMissingSession(panel, state.fsPath);
    return false;
  }

  private async handleMissingSession(
    panel: vscode.WebviewPanel | null,
    fsPath: string,
    options: { showMessage?: boolean; notify?: boolean } = {},
  ): Promise<void> {
    if (panel) this.disposePanel(panel);

    if (options.showMessage ?? true) {
      void vscode.window.showErrorMessage(t("app.openSessionFailed"));
    }
    if (!(options.notify ?? true)) return;
    try {
      await this.onMissingSession?.(fsPath);
    } catch {
      // A failed refresh notification must not break panel disposal.
    }
  }

  private getOpenPanels(): vscode.WebviewPanel[] {
    const panels = new Set<vscode.WebviewPanel>();
    if (this.reusablePanel) panels.add(this.reusablePanel);
    for (const panel of this.panelsByKey.values()) panels.add(panel);
    for (const panel of this.branchPanels) panels.add(panel);
    return Array.from(panels);
  }

  private disposePanel(panel: vscode.WebviewPanel): void {
    try {
      panel.dispose();
    } catch {
      // Ignore dispose failures; the panel may already be closed.
    }
  }

  private resolveSessionIconPath(session: SessionSummary): { light: vscode.Uri; dark: vscode.Uri } {
    const agentPresentationEnabled =
      getConfig().agentRunsEnabled && this.codexAgentRuns.isPresentationEnabled();
    const agentRelation = agentPresentationEnabled && session.source === "codex"
      ? this.codexAgentRuns.getPresentation(session, t("codexAgentRuns.subagent")).relation
      : undefined;
    return this.sessionIconResolver.resolve(
      session,
      agentPresentationEnabled,
      agentRelation,
    );
  }

  private notifyAutoRefreshConsumerVisibilityChanged(): void {
    this.autoRefreshConsumerVisibilityEmitter.fire();
  }

  private requestAutoRefresh(panel: vscode.WebviewPanel, mode: ChatWebviewAutoRefreshMode): void {
    const state = this.stateByPanel.get(panel);
    if (!state || state.autoRefreshMode === "off" || !this.readyByPanel.get(panel)) return;
    this.stateByPanel.set(panel, { ...state, pendingAutoRefresh: false });
    void panel.webview.postMessage({ type: "requestReload", mode });
  }
}

function hasAgentRunsRelation(component: { nodes: readonly { unavailableParent: boolean }[] }): boolean {
  return component.nodes.length > 1 || component.nodes.some((node) => node.unavailableParent);
}

function buildCodexAgentRunsRelationKey(component: CodexAgentComponent, currentIdentityKey: string): string {
  return JSON.stringify({
    currentIdentityKey,
    sessionCount: component.sessionCount,
    agentCount: component.agentCount,
    relationPartial: component.relationPartial,
    omittedCount: component.omittedCount,
    nodes: component.nodes.map((node) => ({
      id: node.id,
      parentId: node.parentId ?? "",
      isCurrent: node.isCurrent,
      isSubagent: node.isSubagent,
      unavailableParent: node.unavailableParent,
    })),
  });
}

function isSameCodexAgentRunTarget(
  current: SessionSummary | undefined,
  requested: SessionSummary,
): boolean {
  return Boolean(
    current &&
    current.source === "codex" &&
    current.identityKey === requested.identityKey &&
    normalizeCacheKey(current.fsPath) === normalizeCacheKey(requested.fsPath),
  );
}

type PinnedSessionLookup = {
  cacheKeys: ReadonlySet<string>;
  identityKeys: ReadonlySet<string>;
};

function buildPinnedSessionLookup(pinStore: PinStore): PinnedSessionLookup {
  const pins = pinStore.getAll();
  return {
    cacheKeys: new Set(pins.map((pin) => pin.cacheKey)),
    identityKeys: new Set(
      pins.map((pin) => pin.identityKey).filter((identityKey): identityKey is string => Boolean(identityKey)),
    ),
  };
}

function isSessionPinnedInLookup(lookup: PinnedSessionLookup, session: SessionSummary): boolean {
  return lookup.cacheKeys.has(session.cacheKey) || lookup.identityKeys.has(session.identityKey);
}

function isSessionPinned(pinStore: PinStore, session: SessionSummary): boolean {
  return isSessionPinnedInLookup(buildPinnedSessionLookup(pinStore), session);
}

function formatAgentRunDateTime(localDate: string | undefined, timeLabel: string | undefined): string {
  const date = String(localDate ?? "").trim();
  const time = String(timeLabel ?? "").trim();
  return date && time ? `${date} ${time}` : date || time;
}

function sanitizeAgentRunWebviewText(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= 320 && !/[\u0000-\u001f\u007f]/u.test(text) ? text : fallback;
}

function randomNonce(): string {
  // Generates a nonce for CSP.
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i += 1) out += chars[Math.floor(Math.random() * chars.length)]!;
  return out;
}

function formatWebviewDebugMessage(msg: any): string {
  const scope = sanitizeDebugToken(msg?.scope, "chatOpenPosition");
  const eventName = sanitizeDebugToken(msg?.event, "event");
  const details = msg?.details && typeof msg.details === "object" ? msg.details : {};
  const fields: Record<string, string | number | boolean | null | undefined> = { event: eventName };
  for (const [key, value] of Object.entries(details)) {
    const safeKey = sanitizeDebugToken(key, "key");
    if (typeof value === "number" || typeof value === "boolean" || value == null) fields[safeKey] = value;
    else fields[safeKey] = sanitizeDebugValue(value);
  }
  return formatDebugFields(`${scope} webview`, fields);
}

function sanitizeDebugToken(value: unknown, fallback: string): string {
  const text = String(value ?? "").trim().replace(/[^a-zA-Z0-9_.-]/g, "_");
  return text ? text.slice(0, 48) : fallback;
}

function sanitizeDebugValue(value: unknown): string | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value == null) return "null";
  const text = String(value).replace(/[\r\n\t]/g, " ").trim();
  return text ? text.slice(0, 96) : undefined;
}

function debugSessionName(fsPath: string): string {
  const normalized = String(fsPath || "").replace(/\\/g, "/");
  const fileName = normalized.split("/").filter(Boolean).pop() ?? "unknown";
  return sanitizeDebugToken(fileName, "unknown");
}

function resolveSessionDetailMode(
  requestedMode: ChatSessionDetailMode | undefined,
  state: ChatPanelState,
): ChatSessionDetailMode {
  if (requestedMode === "full" || requestedMode === "summary") return requestedMode;
  if (state.revealTarget?.kind === "patchEntry") return DEFAULT_CHAT_SESSION_DETAIL_MODE;
  return DEFAULT_CHAT_SESSION_DETAIL_MODE;
}

function isSameChatPanelSession(
  left: ChatPanelState | undefined,
  right: ChatPanelState | undefined,
): boolean {
  return Boolean(
    left &&
    right &&
    left.kind === right.kind &&
    normalizeCacheKey(left.fsPath) === normalizeCacheKey(right.fsPath),
  );
}

function normalizeChatWebviewAutoRefreshMode(value: unknown): ChatWebviewAutoRefreshMode {
  return value === "preserve" || value === "follow" ? value : "off";
}

function normalizeChatSessionDetailMode(value: unknown): ChatSessionDetailMode | undefined {
  return value === "full" || value === "summary" ? value : undefined;
}

function normalizeChatWebviewPathMode(value: unknown): ChatWebviewPathMode {
  return value === "relocated" ? "relocated" : "recorded";
}

function normalizeChatWebviewPathModeOrUndefined(value: unknown): ChatWebviewPathMode | undefined {
  return value === "recorded" || value === "relocated" ? value : undefined;
}

async function readSessionMtimeMs(fsPath: string): Promise<number | undefined> {
  const trimmed = typeof fsPath === "string" ? fsPath.trim() : "";
  if (!trimmed) return undefined;
  try {
    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(trimmed));
    return typeof stat.mtime === "number" && Number.isFinite(stat.mtime) ? stat.mtime : undefined;
  } catch {
    return undefined;
  }
}

function isActiveCodexSessionPath(
  fsPath: string,
  summary: SessionSummary | undefined,
  config: ReturnType<typeof getConfig>,
): boolean {
  if (summary) {
    return (
      summary.source === "codex" &&
      summary.storage.archiveState === "active" &&
      summary.storage.rootKind === "codexSessions"
    );
  }
  return isPathInsideRoot(fsPath, config.sessionsRoot);
}

function isPanelObservingLiveSession(
  panel: vscode.WebviewPanel,
  state: ChatPanelState,
  isReady: boolean,
): boolean {
  return isReady && panel.visible && state.autoRefreshMode !== "off";
}

function isPathInsideRoot(fsPath: string, rootPath: string): boolean {
  const target = normalizeExistingPath(fsPath);
  const root = normalizeExistingPath(rootPath);
  if (!target || !root) return false;
  const relative = path.relative(root, target);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeExistingPath(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return path.resolve(trimmed);
  } catch {
    return "";
  }
}

function normalizeChatTurnId(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 256);
}

function getTurnItemCount(turn: ChatTurnSummary | undefined): number {
  const value = turn && typeof turn.itemCount === "number" && Number.isFinite(turn.itemCount) ? turn.itemCount : 0;
  return Math.max(0, Math.floor(value));
}

function sanitizePageSearchSeed(value: unknown): SessionPageSearchSeed | undefined {
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

function sanitizeBranchModelId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  return /^[a-f0-9]{24}$/u.test(id) ? id : "";
}

function sanitizeBranchOccurrenceId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  return /^[a-f0-9]{64}$/u.test(id) ? id : "";
}

function sanitizeBranchCursor(value: unknown): string {
  const cursor = typeof value === "string" ? value.trim() : "";
  return /^(g|c)\.[0-9a-z]+\.[a-f0-9]{24}$/u.test(cursor) && cursor.length <= 256 ? cursor : "";
}

function sanitizeBranchGeneration(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : -1;
}

function sanitizePositiveSequence(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : -1;
}

function sanitizeChatPanelRestoreState(value: unknown): ChatPanelRestoreState | null {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const restore = source.restore && typeof source.restore === "object" ? (source.restore as Record<string, unknown>) : source;
  if (restore.version !== 1) return null;

  const fsPath = typeof restore.fsPath === "string" ? restore.fsPath.trim() : "";
  if (!fsPath || fsPath.length > 4096) return null;
  if (restore.kind !== "session" && restore.kind !== "reusable" && restore.kind !== "branch") return null;
  const kind: ChatPanelKind = restore.kind;
  const revealMessageIndex =
    typeof restore.revealMessageIndex === "number" && Number.isFinite(restore.revealMessageIndex)
      ? Math.max(0, Math.floor(restore.revealMessageIndex))
      : undefined;
  const revealTarget = sanitizeFileChangeHistoryRevealTarget(restore.revealTarget);
  const scrollY =
    typeof restore.scrollY === "number" && Number.isFinite(restore.scrollY)
      ? Math.max(0, Math.floor(restore.scrollY))
      : undefined;
  const topMessageIndex =
    typeof restore.topMessageIndex === "number" && Number.isFinite(restore.topMessageIndex)
      ? Math.max(0, Math.floor(restore.topMessageIndex))
      : undefined;
  const autoRefreshMode = normalizeChatWebviewAutoRefreshMode(restore.autoRefreshMode);
  const detailMode = normalizeChatSessionDetailMode(restore.detailMode);
  const pathMode = normalizeChatWebviewPathModeOrUndefined(restore.pathMode);
  return {
    version: 1,
    kind,
    fsPath,
    ...(revealMessageIndex !== undefined ? { revealMessageIndex } : {}),
    ...(revealTarget ? { revealTarget } : {}),
    ...(scrollY !== undefined ? { scrollY } : {}),
    ...(topMessageIndex !== undefined ? { topMessageIndex } : {}),
    autoRefreshMode,
    ...(detailMode ? { detailMode } : {}),
    ...(pathMode ? { pathMode } : {}),
  };
}

function sanitizeFileChangeHistoryRevealTarget(value: unknown): FileChangeHistoryRevealTarget | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  if (source.kind !== "patchEntry") return undefined;
  const filePath = sanitizePatchDetailText(source.filePath, 4096);
  if (!filePath) return undefined;
  const movePath = sanitizePatchDetailText(source.movePath, 4096);
  const entryId = sanitizePatchDetailText(source.entryId, 512);
  const timestampIso = sanitizePatchDetailText(source.timestampIso, 128);
  const messageIndex =
    typeof source.messageIndex === "number" && Number.isFinite(source.messageIndex)
      ? Math.max(0, Math.floor(source.messageIndex))
      : undefined;
  return {
    kind: "patchEntry",
    filePath,
    ...(movePath ? { movePath } : {}),
    ...(entryId ? { entryId } : {}),
    ...(timestampIso ? { timestampIso } : {}),
    ...(messageIndex !== undefined ? { messageIndex } : {}),
  };
}

function sanitizePatchEntryDetailTarget(value: unknown): ChatPatchEntryDetailTarget | null {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const entryId = sanitizePatchDetailText(source.entryId, 512);
  if (!entryId) return null;

  const callId = sanitizePatchDetailText(source.callId, 512);
  const filePath = sanitizePatchDetailText(source.path, 4096);
  const displayPath = sanitizePatchDetailText(source.displayPath, 4096);
  const movePath = sanitizePatchDetailText(source.movePath, 4096);
  const moveDisplayPath = sanitizePatchDetailText(source.moveDisplayPath, 4096);
  const changeType = sanitizePatchDetailChangeType(source.changeType);
  return {
    entryId,
    ...(callId ? { callId } : {}),
    ...(filePath ? { path: filePath } : {}),
    ...(displayPath ? { displayPath } : {}),
    ...(movePath ? { movePath } : {}),
    ...(moveDisplayPath ? { moveDisplayPath } : {}),
    ...(changeType ? { changeType } : {}),
  };
}

function sanitizePatchDetailText(value: unknown, maxLength: number): string | undefined {
  const text = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "";
  if (!text) return undefined;
  return text.slice(0, Math.max(1, maxLength));
}

function sanitizePatchDetailChangeType(value: unknown): ChatPatchChangeType | undefined {
  return value === "create" ||
    value === "delete" ||
    value === "move" ||
    value === "rename" ||
    value === "update" ||
    value === "unknown"
    ? value
    : undefined;
}

function toWebviewChatSessionModel(model: ChatSessionModel, detailMode: ChatSessionDetailMode): ChatSessionModel {
  return detailMode === "full" ? toFullWebviewChatSessionModel(model) : toSummaryChatSessionModel(model);
}

function buildChatBookmarkTarget(
  sessionFsPath: string,
  sessionCacheKey: string,
  item: ChatTimelineItem,
  itemIndex: number,
): BookmarkTarget | null {
  if (!item || typeof item !== "object") return null;
  const kind = getBookmarkTargetKind(item);
  if (!kind) return null;
  const timestampIso = typeof item.timestampIso === "string" ? item.timestampIso.trim() : "";
  const rawMessageIndex = "messageIndex" in item ? item.messageIndex : undefined;
  const messageIndex =
    typeof rawMessageIndex === "number" && Number.isFinite(rawMessageIndex)
      ? Math.max(0, Math.floor(rawMessageIndex))
      : undefined;
  const fallbackId = getBookmarkFallbackId(item, itemIndex);
  const groupId = getBookmarkGroupId(item);
  const keyParams = { sessionCacheKey, kind, groupId, messageIndex, timestampIso, fallbackId };
  const key = buildBookmarkKey(keyParams);
  if (!key) return null;
  return {
    key,
    sessionFsPath,
    sessionCacheKey,
    kind,
    ...(groupId ? { groupId } : {}),
    title: getBookmarkTitle(item, itemIndex),
    ...(messageIndex !== undefined ? { messageIndex } : {}),
    ...(timestampIso ? { timestampIso } : {}),
  };
}

function getBookmarkTargetKind(item: ChatTimelineItem): BookmarkTargetKind | "" {
  if (item.type === "message") return "message";
  if (item.type === "patchGroup") return "patchGroup";
  if (item.type === "tool") return "tool";
  if (item.type === "usage") return "usage";
  if (item.type === "environment") return "environment";
  if (item.type === "note") return "note";
  return "";
}

function getBookmarkFallbackId(item: ChatTimelineItem, itemIndex: number): string {
  if (item.type === "patchGroup") {
    const turnId = typeof item.turnId === "string" ? item.turnId.trim() : "";
    if (turnId) return turnId;
  }
  if (item.type === "tool") {
    const callId = typeof item.callId === "string" ? item.callId.trim() : "";
    if (callId) return callId;
  }
  if (item.type === "note") {
    const title = typeof item.title === "string" ? item.title.trim() : "";
    if (title) return `${itemIndex}:${title}`;
  }
  return `item:${itemIndex}`;
}

function getBookmarkGroupId(item: ChatTimelineItem): string | undefined {
  if (item.type !== "patchGroup") return undefined;
  const explicitGroupId = typeof item.bookmarkGroupId === "string" ? item.bookmarkGroupId.trim() : "";
  if (explicitGroupId) return explicitGroupId;
  const turnId = typeof item.turnId === "string" ? item.turnId.trim() : "";
  return turnId ? `turn:${turnId}` : undefined;
}

function getBookmarkTitle(item: ChatTimelineItem, itemIndex: number): string {
  if (item.type === "message") {
    const role = item.role === "user" || item.role === "assistant" || item.role === "developer" ? item.role : "message";
    return typeof item.messageIndex === "number" ? `${role} #${item.messageIndex}` : role;
  }
  if (item.type === "patchGroup") return `diff #${itemIndex + 1}`;
  if (item.type === "tool") return item.name || `tool #${itemIndex + 1}`;
  if (item.type === "usage") return `usage #${itemIndex + 1}`;
  if (item.type === "environment") return `environment #${itemIndex + 1}`;
  if (item.type === "note") return item.title || `note #${itemIndex + 1}`;
  return `card #${itemIndex + 1}`;
}

function toFullWebviewChatSessionModel(model: ChatSessionModel): ChatSessionModel {
  return {
    ...model,
    items: model.items.map((item) => toFullWebviewTimelineItem(item)),
  };
}

function toFullWebviewTimelineItem(item: ChatTimelineItem): ChatTimelineItem {
  if (item.type === "message") return toWebviewMessageItem(item);
  if (item.type === "tool") return toFullToolItem(item);
  if (item.type === "patchGroup") return toFullPatchGroupItem(item);
  return { ...item };
}

function toSummaryChatSessionModel(model: ChatSessionModel): ChatSessionModel {
  return {
    ...model,
    items: model.items.map((item) => toSummaryTimelineItem(item)),
  };
}

function toSummaryTimelineItem(item: ChatTimelineItem): ChatTimelineItem {
  if (item.type === "tool") return toSummaryToolItem(item);
  if (item.type === "patchGroup") return toSummaryPatchGroupItem(item);
  if (item.type === "message") return toWebviewMessageItem(item);
  return { ...item };
}

function toWebviewMessageItem(item: ChatMessageItem): ChatMessageItem {
  return {
    ...item,
    attachments: item.attachments?.map((attachment) => toWebviewAttachment(attachment)),
  };
}

function toWebviewAttachment(attachment: ChatAttachment): ChatAttachment {
  if (attachment.type === "image") return sanitizeAttachmentForChannel(toWebviewImageAttachment(attachment), "webview");
  if (attachment.type === "document") return sanitizeAttachmentForChannel(toWebviewDocumentAttachment(attachment), "webview");
  return sanitizeAttachmentForChannel(attachment, "webview");
}

function toWebviewImageAttachment(image: ChatImageAttachment): ChatImageAttachment {
  const webviewImage: ChatImageAttachment = { ...image };
  if (webviewImage.status === "available" && hasNonEmptyString(webviewImage.src)) {
    delete webviewImage.src;
    webviewImage.dataOmitted = true;
  }
  return webviewImage;
}

function toWebviewDocumentAttachment(document: ChatDocumentAttachment): ChatDocumentAttachment {
  const webviewDocument: ChatDocumentAttachment = { ...document };
  if (webviewDocument.payload) {
    delete webviewDocument.payload;
    webviewDocument.dataOmitted = true;
  }
  return webviewDocument;
}

function toFullToolItem(item: ChatToolItem): ChatToolItem {
  return {
    ...item,
    presentation: item.presentation ? { ...item.presentation } : undefined,
  };
}

function toSummaryToolItem(item: ChatToolItem): ChatToolItem {
  const hasHeavyDetails =
    item.detailsOmitted === true || hasNonEmptyString(item.argumentsText) || hasNonEmptyString(item.outputText);
  return {
    type: "tool",
    messageIndex: item.messageIndex,
    turnId: item.turnId,
    timestampIso: item.timestampIso,
    name: item.name,
    callId: item.callId,
    execution: item.execution ? { ...item.execution } : undefined,
    presentation: item.presentation ? { ...item.presentation } : undefined,
    ...(hasHeavyDetails ? { detailsOmitted: true } : {}),
  };
}

function toFullPatchGroupItem(item: ChatPatchGroupItem): ChatPatchGroupItem {
  return {
    ...item,
    entries: item.entries.map((entry) => toFullPatchEntry(entry)),
  };
}

function toSummaryPatchGroupItem(item: ChatPatchGroupItem): ChatPatchGroupItem {
  return {
    ...item,
    entries: item.entries.map((entry) => toSummaryPatchEntry(entry)),
  };
}

function toFullPatchEntry(entry: ChatPatchEntry): ChatPatchEntry {
  return {
    ...entry,
    hunks: Array.isArray(entry.hunks)
      ? entry.hunks.map((hunk) => ({
          ...hunk,
          rows: Array.isArray(hunk.rows) ? hunk.rows.map((row) => ({ ...row })) : [],
        }))
      : [],
  };
}

function toSummaryPatchEntry(entry: ChatPatchEntry): ChatPatchEntry {
  const hunks = Array.isArray(entry.hunks) ? entry.hunks : [];
  const hasHunkRows = hunks.some((hunk) => Array.isArray(hunk.rows) && hunk.rows.length > 0);
  return {
    ...entry,
    detailsOmitted: hasHunkRows ? true : entry.detailsOmitted,
    hunks: hasHunkRows ? [] : hunks.map((hunk) => ({ ...hunk, rows: Array.isArray(hunk.rows) ? [...hunk.rows] : [] })),
  };
}

async function buildChatPerformanceStats(fsPath: string, model: ChatSessionModel): Promise<ChatPerformanceStats> {
  const stats: ChatPerformanceStats = {
    fileSizeBytes: 0,
    itemCount: Array.isArray(model.items) ? model.items.length : 0,
    messageChars: 0,
    diffGroupCount: 0,
    diffEntryCount: 0,
    diffLineEstimate: 0,
    imageCount: 0,
  };

  try {
    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
    stats.fileSizeBytes = Number.isFinite(stat.size) ? Math.max(0, Math.floor(stat.size)) : 0;
  } catch {
    // File size is only a performance hint; keep rendering if it cannot be read.
  }

  for (const item of Array.isArray(model.items) ? model.items : []) {
    if (item.type === "message") {
      stats.messageChars += typeof item.text === "string" ? item.text.length : 0;
      stats.imageCount += Array.isArray(item.attachments)
        ? item.attachments.filter((attachment) => attachment?.type === "image").length
        : 0;
      continue;
    }
    if (item.type !== "patchGroup") continue;
    stats.diffGroupCount += 1;
    const entries = Array.isArray(item.entries) ? item.entries : [];
    stats.diffEntryCount += entries.length;
    for (const entry of entries) {
      stats.diffLineEstimate += Math.max(0, entry.added || 0) + Math.max(0, entry.removed || 0);
    }
  }

  return stats;
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function collectSaveableImages(model: ChatSessionModel): Map<string, SaveableChatImage> {
  const images = new Map<string, SaveableChatImage>();
  for (const item of model.items) {
    if (item.type !== "message" || !Array.isArray(item.attachments)) continue;
    for (const image of item.attachments.filter((attachment): attachment is ChatImageAttachment => attachment?.type === "image")) {
      const saveable = toSaveableImage(image);
      if (!saveable) continue;
      images.set(image.id!, saveable);
    }
  }
  return images;
}

function collectSaveableDocuments(model: ChatSessionModel): Map<string, SaveableChatDocument> {
  const documents = new Map<string, SaveableChatDocument>();
  for (const item of model.items) {
    if (item.type !== "message" || !Array.isArray(item.attachments)) continue;
    for (const document of item.attachments.filter(
      (attachment): attachment is ChatDocumentAttachment => attachment?.type === "document",
    )) {
      const saveable = toSaveableDocument(document);
      if (!saveable || !document.id) continue;
      documents.set(document.id, saveable);
    }
  }
  return documents;
}

function toSaveableImage(image: ChatImageAttachment): SaveableChatImage | null {
  const id = typeof image.id === "string" ? image.id.trim() : "";
  const src = typeof image.src === "string" ? image.src.trim() : "";
  if (!id || image.status !== "available" || !src) return null;

  const mimeType = readImageDataUriMimeType(src);
  if (!imageExtensionForMimeType(mimeType)) return null;
  return {
    src,
    mimeType,
    label: image.label || "image-attachment",
  };
}

function toSaveableDocument(document: ChatDocumentAttachment): SaveableChatDocument | null {
  if (!document.id || document.status !== "available" || !document.payload) return null;
  return {
    payload: document.payload,
    mimeType: document.mimeType,
    label: document.label || "document-attachment",
    documentKind: document.documentKind,
  };
}

function readImageDataUriMimeType(src: string): string {
  const match = /^data:([^;,]+)(?:[;,]|,)/iu.exec(src.trim());
  return normalizeImageMimeType(match?.[1]);
}

function decodeImageDataUri(src: string): { mimeType: string; extension: string; bytes: Uint8Array } | null {
  const trimmed = src.trim();
  const match = /^data:([^;,]+)((?:;[^,]*)?),(.*)$/isu.exec(trimmed);
  if (!match) return null;

  const mimeType = normalizeImageMimeType(match[1]);
  const extension = imageExtensionForMimeType(mimeType);
  if (!extension) return null;

  const metadata = match[2] ?? "";
  const payload = match[3] ?? "";
  if (!payload) return null;

  try {
    if (/(?:^|;)base64(?:;|$)/iu.test(metadata)) {
      return { mimeType, extension, bytes: Buffer.from(payload.replace(/\s/g, ""), "base64") };
    }
    return { mimeType, extension, bytes: Buffer.from(decodeURIComponent(payload), "utf8") };
  } catch {
    return null;
  }
}

function decodeDocumentPayload(document: SaveableChatDocument): { extension: string; bytes: Uint8Array } | null {
  const extension = documentExtensionForSave(document);
  try {
    if (document.payload.kind === "text") {
      return { extension, bytes: Buffer.from(document.payload.text, "utf8") };
    }
    return { extension, bytes: Buffer.from(document.payload.data.replace(/\s/g, ""), "base64") };
  } catch {
    return null;
  }
}

function documentExtensionForSave(document: SaveableChatDocument): string {
  const existing = path.extname(document.label).toLowerCase();
  if (existing && existing.length <= 12) return existing;
  const mimeType = String(document.mimeType ?? "").toLowerCase();
  if (mimeType === "application/pdf" || document.documentKind === "pdf") return ".pdf";
  if (mimeType === "text/markdown") return ".md";
  if (mimeType === "application/json") return ".json";
  if (mimeType.startsWith("text/") || document.documentKind === "text") return ".txt";
  return ".bin";
}

function normalizeImageMimeType(value: string | undefined): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

function imageExtensionForMimeType(mimeType: string): string | null {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/gif") return ".gif";
  if (mimeType === "image/webp") return ".webp";
  return null;
}

function resolveSessionSaveCwd(state: ChatPanelState): string | undefined {
  return isChatRelocatedPathMode(state) ? state.sessionDisplayCwd || state.sessionCwd : state.sessionCwd;
}

function collectChatLocalLinkBaseDirs(state: ChatPanelState, ...workspaceDirs: string[]): string[] {
  if (isChatRelocatedPathMode(state)) {
    return collectLocalLinkBaseDirs(state.sessionDisplayCwd, state.sessionCwd, ...workspaceDirs);
  }
  return collectLocalLinkBaseDirs(state.sessionCwd, ...workspaceDirs);
}

function buildChatProjectPathMappings(state: ChatPanelState): Array<{ sourceCwd: string; targetCwd: string }> {
  if (!isChatRelocatedPathMode(state)) return [];
  if (!state.sessionCwd || !state.sessionDisplayCwd) return [];
  if (normalizeCacheKey(state.sessionCwd) === normalizeCacheKey(state.sessionDisplayCwd)) return [];
  return [{ sourceCwd: state.sessionCwd, targetCwd: state.sessionDisplayCwd }];
}

function isChatRelocatedPathMode(state: ChatPanelState): boolean {
  return state.pathModeEnabled === true && state.pathMode === "relocated";
}

function buildDefaultImageSaveUri(sessionCwd: string | undefined, label: string, extension: string): vscode.Uri {
  const fileName = buildImageFileName(label, extension);
  const baseDir = typeof sessionCwd === "string" && sessionCwd.trim() ? sessionCwd.trim() : undefined;
  if (!baseDir) return vscode.Uri.file(fileName);
  return vscode.Uri.joinPath(vscode.Uri.file(baseDir), fileName);
}

function buildDefaultAttachmentSaveUri(sessionCwd: string | undefined, label: string, extension: string): vscode.Uri {
  const fileName = buildSafeFileName(label, extension, "document-attachment");
  const baseDir = typeof sessionCwd === "string" && sessionCwd.trim() ? sessionCwd.trim() : undefined;
  if (!baseDir) return vscode.Uri.file(fileName);
  return vscode.Uri.joinPath(vscode.Uri.file(baseDir), fileName);
}

function buildImageFileName(label: string, extension: string): string {
  return buildSafeFileName(String(label || "image-attachment").replace(/\.(png|jpe?g|gif|webp)$/iu, ""), extension, "image-attachment");
}

function buildSafeFileName(label: string, extension: string, fallbackBase: string): string {
  const withoutKnownExtension = String(label || fallbackBase).replace(/\.[A-Za-z0-9]{1,12}$/u, "");
  let base = withoutKnownExtension
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  if (!base) base = fallbackBase;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(base)) base = `file-${base}`;
  return `${base}${extension}`;
}

async function openFileWithVsCodeOpenCommand(fsPath: string): Promise<boolean> {
  try {
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(fsPath));
    return true;
  } catch {
    return false;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error ?? "Unknown error");
}

function isCodexForkNavigationSnapshot(
  snapshot: BranchNavigationSnapshot,
): snapshot is CodexForkNavigationSnapshot {
  return "source" in snapshot && snapshot.source === "codex";
}

function buildPanelTitle(session: SessionSummary): string {
  // Keep panel titles compact by truncating only the title segment.
  const shortTitle = truncateByDisplayWidth(session.displayTitle, 28, "...");
  return `${session.localDate} ${session.timeLabel} ${shortTitle}`;
}

function applyPanelHistoryDateBasis(
  session: SessionSummary,
  historyDateBasis: ReturnType<typeof getConfig>["historyDateBasis"],
): SessionSummary {
  const localDate = historyDateBasis === "lastActivity" ? session.lastActivityLocalDate : session.startedLocalDate;
  const timeLabel = historyDateBasis === "lastActivity" ? session.lastActivityTimeLabel : session.startedTimeLabel;
  return { ...session, localDate, timeLabel };
}
