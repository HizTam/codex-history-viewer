import * as path from "node:path";
import * as vscode from "vscode";
import { ChatPanelManager } from "../chat/chatPanelManager";
import { t } from "../i18n";
import { getConfig, type CodexHistoryViewerConfig } from "../settings";
import {
  elapsedMs,
  formatDebugFields,
  nowMs,
  sanitizeDebugError,
  sanitizeDebugToken,
} from "../services/debugLogUtils";
import type { HistoryService } from "../services/historyService";
import type { DebugLogger } from "../services/logger";
import { buildBookmarkKey, type BookmarkStore, type BookmarkTarget } from "../services/bookmarkStore";
import { SearchIndexService } from "../services/searchIndexService";
import { resolveDateTimeSettings } from "../utils/dateTimeSettings";
import { normalizeCacheKey, pathExists } from "../utils/fsUtils";
import {
  FILE_CHANGE_HISTORY_PAGE_SIZE,
  type FileChangeHistoryCandidate,
  type FileChangeHistoryCard,
  type FileChangeHistoryRevealTarget,
  type FileChangeHistoryTarget,
  type FileChangeHistoryWebviewModel,
} from "./fileChangeHistoryTypes";
import { FileChangeHistoryService } from "./fileChangeHistoryService";

type StaleReason = "indexToolContent" | "sources";

interface FileChangeHistoryPanelState {
  target: FileChangeHistoryTarget;
  generation: number;
  candidates: FileChangeHistoryCandidate[];
  cards: FileChangeHistoryCard[];
  pendingCards: FileChangeHistoryCard[];
  nextCandidateIndex: number;
  hasMore: boolean;
  loading: boolean;
  staleReason?: StaleReason;
  loadMoreCancellation?: vscode.CancellationTokenSource;
}

interface SourceIconUris {
  light: string;
  dark: string;
}

interface FileChangeBookmarkState {
  cards: FileChangeHistoryCard[];
  bookmarkKeys: string[];
}

export class FileChangeHistoryPanelManager implements vscode.Disposable {
  private readonly extensionUri: vscode.Uri;
  private readonly historyService: HistoryService;
  private readonly searchIndexService: SearchIndexService;
  private readonly fileChangeHistoryService: FileChangeHistoryService;
  private readonly chatPanels: ChatPanelManager;
  private readonly bookmarkStore: BookmarkStore;
  private readonly logger?: DebugLogger;
  private readonly bookmarkSubscription: vscode.Disposable;
  private readonly panelsByKey = new Map<string, vscode.WebviewPanel>();
  private readonly stateByPanel = new WeakMap<vscode.WebviewPanel, FileChangeHistoryPanelState>();
  private readonly bookmarkTargetsByPanel = new WeakMap<vscode.WebviewPanel, Map<string, BookmarkTarget>>();
  private readonly readyByPanel = new WeakMap<vscode.WebviewPanel, boolean>();
  private readonly panelIconPath: { light: vscode.Uri; dark: vscode.Uri };

  constructor(
    extensionUri: vscode.Uri,
    historyService: HistoryService,
    searchIndexService: SearchIndexService,
    fileChangeHistoryService: FileChangeHistoryService,
    chatPanels: ChatPanelManager,
    bookmarkStore: BookmarkStore,
    logger?: DebugLogger,
  ) {
    this.extensionUri = extensionUri;
    this.historyService = historyService;
    this.searchIndexService = searchIndexService;
    this.fileChangeHistoryService = fileChangeHistoryService;
    this.chatPanels = chatPanels;
    this.bookmarkStore = bookmarkStore;
    this.logger = logger;
    const extensionIcon = vscode.Uri.joinPath(extensionUri, "resources", "extension-icon.svg");
    this.panelIconPath = {
      light: extensionIcon,
      dark: extensionIcon,
    };
    this.bookmarkSubscription = this.bookmarkStore.onDidChange(() => {
      this.refreshBookmarkState();
    });
  }

  public dispose(): void {
    this.bookmarkSubscription.dispose();
    for (const panel of this.panelsByKey.values()) {
      this.cancelLoadMore(panel, true);
      panel.dispose();
    }
    this.panelsByKey.clear();
  }

  public refreshI18n(): void {
    const config = getConfig();
    for (const panel of this.panelsByKey.values()) {
      const state = this.stateByPanel.get(panel);
      if (state) panel.title = t("fileChangeHistory.panelTitle", state.target.fileName);
      if (!this.readyByPanel.get(panel)) continue;
      void panel.webview.postMessage({
        type: "i18n",
        i18n: this.buildI18n(),
        timeGuideEnabled: config.timeGuideEnabled,
      });
    }
  }

  private refreshBookmarkState(): void {
    for (const panel of this.panelsByKey.values()) {
      if (!this.readyByPanel.get(panel)) continue;
      void this.sendBookmarkState(panel);
    }
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

  public notifySettingsChanged(reason: StaleReason): void {
    const config = getConfig();
    for (const panel of this.panelsByKey.values()) {
      const state = this.stateByPanel.get(panel);
      if (!state) continue;
      panel.iconPath = this.resolvePanelIconPath(config);
      this.stateByPanel.set(panel, {
        ...state,
        staleReason: reason,
      });
      if (!this.readyByPanel.get(panel)) continue;
      void panel.webview.postMessage({
        type: "stale",
        reason,
        i18n: this.buildI18n(),
        timeGuideEnabled: config.timeGuideEnabled,
      });
    }
  }

  public async openForUri(uri: vscode.Uri | undefined): Promise<void> {
    const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!targetUri || targetUri.scheme !== "file") {
      void vscode.window.showInformationMessage(t("fileChangeHistory.noFileSelected"));
      return;
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(targetUri);
    if (!workspaceFolder) {
      void vscode.window.showInformationMessage(t("fileChangeHistory.noWorkspace"));
      return;
    }

    const config = getConfig();
    const target = this.fileChangeHistoryService.buildTarget(targetUri, workspaceFolder);
    const key = buildPanelKey(target);
    const panel = this.getOrCreatePanel(key, config);
    this.resetPanelState(panel, target);
    panel.title = t("fileChangeHistory.panelTitle", target.fileName);
    panel.iconPath = this.resolvePanelIconPath(config);
    panel.reveal(vscode.ViewColumn.Active, false);

    if (this.readyByPanel.get(panel)) {
      await panel.webview.postMessage({ type: "resetUi" });
      await this.sendLoading(panel, "syncIndex");
      void this.loadInitial(panel);
    }
  }

  private getOrCreatePanel(key: string, config: CodexHistoryViewerConfig): vscode.WebviewPanel {
    const existing = this.panelsByKey.get(key);
    if (existing) return existing;

    const panel = vscode.window.createWebviewPanel(
      "codexHistoryViewer.fileChangeHistory",
      t("fileChangeHistory.title"),
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, "media"),
          vscode.Uri.joinPath(this.extensionUri, "resources"),
        ],
        retainContextWhenHidden: true,
      },
    );
    panel.webview.html = this.buildHtml(panel.webview);
    panel.iconPath = this.resolvePanelIconPath(config);
    this.readyByPanel.set(panel, false);
    this.panelsByKey.set(key, panel);

    panel.webview.onDidReceiveMessage(async (msg) => {
      await this.handleMessage(panel, msg);
    });
    panel.onDidChangeViewState(() => {
      void panel.webview.postMessage({ type: "viewState", visible: panel.visible });
    });
    panel.onDidDispose(() => {
      this.cancelLoadMore(panel, true);
      this.panelsByKey.delete(key);
    });
    return panel;
  }

  private resetPanelState(panel: vscode.WebviewPanel, target: FileChangeHistoryTarget): void {
    const previous = this.stateByPanel.get(panel);
    this.cancelLoadMore(panel);
    this.stateByPanel.set(panel, {
      target,
      generation: (previous?.generation ?? 0) + 1,
      candidates: [],
      cards: [],
      pendingCards: [],
      nextCandidateIndex: 0,
      hasMore: false,
      loading: false,
    });
  }

  private async loadInitial(
    panel: vscode.WebviewPanel,
    targetCardCount = FILE_CHANGE_HISTORY_PAGE_SIZE,
    reason: "initial" | "reload" = "initial",
  ): Promise<void> {
    const state = this.stateByPanel.get(panel);
    if (!state || state.loading) return;
    const generation = state.generation;
    const config = getConfig();
    const limit = Math.max(FILE_CHANGE_HISTORY_PAGE_SIZE, Math.floor(targetCardCount));
    const totalStartedAt = nowMs();
    let indexMs = 0;
    let candidateMs = 0;
    let loadMs = 0;
    this.logger?.debug(
      formatDebugFields(`fileChangeHistory ${reason} start`, {
        limit,
        existingCards: state.cards.length,
      }),
    );

    this.stateByPanel.set(panel, { ...state, loading: true, staleReason: undefined });
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: t("fileChangeHistory.progress.syncIndex"),
          cancellable: true,
        },
        async (progress, token) => {
          await this.sendLoading(panel, "syncIndex");
          const indexStartedAt = nowMs();
          await this.searchIndexService.ensureUpToDate({
            index: this.historyService.getIndex(),
            codexSessionsRoot: config.sessionsRoot,
            claudeSessionsRoot: config.claudeSessionsRoot,
            includeCodex: config.enableCodexSource,
            includeClaude: config.enableClaudeSource,
            indexToolContent: config.searchIndexToolContent,
            token,
            progress,
          });
          indexMs = elapsedMs(indexStartedAt);

          const current = this.stateByPanel.get(panel);
          if (!current || current.generation !== generation) return;
          await this.sendLoading(panel, "collectCandidates");
          const candidateStartedAt = nowMs();
          const candidates = this.fileChangeHistoryService.buildCandidates({
            index: this.historyService.getIndex(),
            searchIndexService: this.searchIndexService,
            target: current.target,
            config,
          });
          candidateMs = elapsedMs(candidateStartedAt);

          await this.sendLoading(panel, "parseSessions");
          const loadStartedAt = nowMs();
          const loaded = await this.fileChangeHistoryService.loadCards({
            target: current.target,
            candidates,
            nextCandidateIndex: 0,
            pendingCards: [],
            limit,
            token,
          });
          loadMs = elapsedMs(loadStartedAt);

          await this.sendLoading(panel, "render");
          const latest = this.stateByPanel.get(panel);
          if (!latest || latest.generation !== generation) return;
          this.stateByPanel.set(panel, {
            ...latest,
            candidates,
            cards: loaded.cards,
            pendingCards: loaded.pendingCards,
            nextCandidateIndex: loaded.nextCandidateIndex,
            hasMore: !loaded.exhausted,
            loading: false,
          });
          await this.sendModel(panel, { reason });
          this.logger?.debug(
            formatDebugFields(`fileChangeHistory ${reason} done`, {
              totalMs: elapsedMs(totalStartedAt),
              indexMs,
              candidateMs,
              loadMs,
              candidates: candidates.length,
              scanned: loaded.stats.candidateScanned,
              parsedSessions: loaded.stats.parsedSessions,
              matchedSessions: loaded.stats.matchedSessions,
              cards: loaded.cards.length,
              pending: loaded.pendingCards.length,
              hasMore: !loaded.exhausted,
            }),
          );
          this.logger?.debug(
            formatDebugFields("fileChangeHistory diffStats", {
              codexPatchApplyEnd: loaded.stats.diffStats.codexPatchApplyEnd,
              codexApplyPatchParsed: loaded.stats.diffStats.codexApplyPatchParsed,
              codexApplyPatchFailedSkipped: loaded.stats.diffStats.codexApplyPatchFailedSkipped,
              codexDuplicatesSuppressed: loaded.stats.diffStats.codexDuplicatesSuppressed,
              claudeEditParsed: loaded.stats.diffStats.claudeEditParsed,
              claudeMultiEditParsed: loaded.stats.diffStats.claudeMultiEditParsed,
              claudeWriteParsed: loaded.stats.diffStats.claudeWriteParsed,
              noRenderableSkipped: loaded.stats.diffStats.noRenderableSkipped,
            }),
          );
        },
      );
    } catch (error) {
      const current = this.stateByPanel.get(panel);
      if (!current || current.generation !== generation) return;
      this.stateByPanel.set(panel, { ...current, loading: false });
      if (error instanceof vscode.CancellationError) {
        this.logger?.debug(
          formatDebugFields(`fileChangeHistory ${reason} cancel`, {
            totalMs: elapsedMs(totalStartedAt),
          }),
        );
        await panel.webview.postMessage({ type: "cancelled", message: t("fileChangeHistory.cancelled") });
      } else {
        this.logger?.debug(
          formatDebugFields(`fileChangeHistory ${reason} fail`, {
            totalMs: elapsedMs(totalStartedAt),
            error: sanitizeDebugError(error),
          }),
        );
        await panel.webview.postMessage({
          type: "error",
          message: t("fileChangeHistory.error.loadFailed", formatError(error)),
        });
      }
    }
  }

  private async loadMore(panel: vscode.WebviewPanel): Promise<void> {
    const state = this.stateByPanel.get(panel);
    if (!state || state.loading || !state.hasMore) return;
    const generation = state.generation;
    const cancellation = new vscode.CancellationTokenSource();
    const startedAt = nowMs();
    this.logger?.debug(
      formatDebugFields("fileChangeHistory loadMore start", {
        existingCards: state.cards.length,
        nextCandidateIndex: state.nextCandidateIndex,
        pending: state.pendingCards.length,
      }),
    );
    this.stateByPanel.set(panel, { ...state, loading: true, loadMoreCancellation: cancellation });
    try {
      await panel.webview.postMessage({ type: "loadMoreStarted" });
      const loaded = await this.fileChangeHistoryService.loadCards({
        target: state.target,
        candidates: state.candidates,
        nextCandidateIndex: state.nextCandidateIndex,
        pendingCards: state.pendingCards,
        limit: FILE_CHANGE_HISTORY_PAGE_SIZE,
        token: cancellation.token,
      });
      const nextCards = state.cards.concat(loaded.cards);
      const latest = this.stateByPanel.get(panel);
      if (!latest || latest.generation !== generation) return;
      this.stateByPanel.set(panel, {
        ...latest,
        cards: nextCards,
        pendingCards: loaded.pendingCards,
        nextCandidateIndex: loaded.nextCandidateIndex,
        hasMore: !loaded.exhausted,
        loading: false,
        loadMoreCancellation: undefined,
      });
      await this.sendModel(panel, { addedCount: loaded.cards.length, reason: "loadMore" });
      this.logger?.debug(
        formatDebugFields("fileChangeHistory loadMore done", {
          totalMs: elapsedMs(startedAt),
          added: loaded.cards.length,
          totalCards: nextCards.length,
          scanned: loaded.stats.candidateScanned,
          parsedSessions: loaded.stats.parsedSessions,
          matchedSessions: loaded.stats.matchedSessions,
          pendingConsumed: loaded.stats.pendingConsumed,
          pending: loaded.pendingCards.length,
          hasMore: !loaded.exhausted,
        }),
      );
      this.logger?.debug(
        formatDebugFields("fileChangeHistory diffStats", {
          codexPatchApplyEnd: loaded.stats.diffStats.codexPatchApplyEnd,
          codexApplyPatchParsed: loaded.stats.diffStats.codexApplyPatchParsed,
          codexApplyPatchFailedSkipped: loaded.stats.diffStats.codexApplyPatchFailedSkipped,
          codexDuplicatesSuppressed: loaded.stats.diffStats.codexDuplicatesSuppressed,
          claudeEditParsed: loaded.stats.diffStats.claudeEditParsed,
          claudeMultiEditParsed: loaded.stats.diffStats.claudeMultiEditParsed,
          claudeWriteParsed: loaded.stats.diffStats.claudeWriteParsed,
          noRenderableSkipped: loaded.stats.diffStats.noRenderableSkipped,
        }),
      );
    } catch (error) {
      const current = this.stateByPanel.get(panel);
      if (!current || current.generation !== generation) return;
      this.stateByPanel.set(panel, { ...current, loading: false, loadMoreCancellation: undefined });
      if (error instanceof vscode.CancellationError) {
        this.logger?.debug(
          formatDebugFields("fileChangeHistory loadMore cancel", {
            totalMs: elapsedMs(startedAt),
          }),
        );
        await panel.webview.postMessage({
          type: "loadMoreCancelled",
          message: t("fileChangeHistory.loadMoreCanceled"),
        });
        return;
      }
      this.logger?.debug(
        formatDebugFields("fileChangeHistory loadMore fail", {
          totalMs: elapsedMs(startedAt),
          error: sanitizeDebugError(error),
        }),
      );
      await panel.webview.postMessage({
        type: "loadMoreFailed",
        message: t("fileChangeHistory.error.loadFailed", formatError(error)),
      });
    } finally {
      cancellation.dispose();
    }
  }

  private async handleMessage(panel: vscode.WebviewPanel, msg: any): Promise<void> {
    const type = typeof msg?.type === "string" ? msg.type : "";
    switch (type) {
      case "ready":
        this.readyByPanel.set(panel, true);
        await this.sendLoading(panel, "syncIndex");
        // A fresh webview script instance should rebuild from extension-side state.
        void this.loadInitial(panel, FILE_CHANGE_HISTORY_PAGE_SIZE, "initial");
        return;
      case "loadMore":
        await this.loadMore(panel);
        return;
      case "reload":
        await this.reload(panel);
        return;
      case "openFile":
        await this.openTargetFile(panel);
        return;
      case "copyPath":
        await this.copyTargetPath(panel);
        return;
      case "openHistory":
        await this.openHistory(panel, typeof msg?.cardId === "string" ? msg.cardId : "");
        return;
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
              error: sanitizeDebugError(error),
            }),
          );
        } finally {
          await this.sendBookmarkState(panel);
        }
        return;
      }
      case "dismissStale":
        this.dismissStale(panel);
        return;
      case "debug":
        this.logger?.debug(formatFileChangeHistoryWebviewDebugMessage(msg));
        return;
    }
  }

  private async reload(panel: vscode.WebviewPanel): Promise<void> {
    const state = this.stateByPanel.get(panel);
    if (!state) return;
    this.cancelLoadMore(panel);
    const targetCardCount = Math.max(FILE_CHANGE_HISTORY_PAGE_SIZE, state.cards.length);
    this.stateByPanel.set(panel, {
      ...state,
      generation: state.generation + 1,
      loading: false,
      staleReason: undefined,
      loadMoreCancellation: undefined,
    });
    await this.sendLoading(panel, "syncIndex");
    void this.loadInitial(panel, targetCardCount, "reload");
  }

  private async openTargetFile(panel: vscode.WebviewPanel): Promise<void> {
    const state = this.stateByPanel.get(panel);
    if (!state) return;
    const uri = vscode.Uri.file(state.target.fsPath);
    if (!(await pathExists(state.target.fsPath))) {
      void vscode.window.showErrorMessage(t("fileChangeHistory.error.openFailed", state.target.fsPath));
      return;
    }
    try {
      await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    } catch {
      try {
        await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Active, preview: false });
      } catch (error) {
        void vscode.window.showErrorMessage(t("fileChangeHistory.error.openFailed", formatError(error)));
      }
    }
  }

  private async copyTargetPath(panel: vscode.WebviewPanel): Promise<void> {
    const state = this.stateByPanel.get(panel);
    if (!state) return;
    await vscode.env.clipboard.writeText(state.target.fsPath);
    await panel.webview.postMessage({ type: "copied", message: t("fileChangeHistory.copied") });
  }

  private async openHistory(panel: vscode.WebviewPanel, cardId: string): Promise<void> {
    const state = this.stateByPanel.get(panel);
    if (!state || !cardId) return;
    const card = state.cards.find((item) => item.id === cardId);
    if (!card) return;
    const session = this.historyService.findByFsPath(card.sessionFsPath);
    if (!session) {
      void vscode.window.showErrorMessage(t("fileChangeHistory.error.openHistoryFailed", t("app.openSessionFailed")));
      return;
    }

    const revealTarget: FileChangeHistoryRevealTarget = {
      kind: "patchEntry",
      messageIndex: card.messageIndex,
      timestampIso: card.timestampIso,
      filePath: card.path,
      movePath: card.movePath,
      entryId: card.entry.id,
    };
    try {
      await this.chatPanels.openSession(session, {
        kind: "session",
        revealMessageIndex: card.messageIndex,
        revealTarget,
        viewColumn: vscode.ViewColumn.Active,
      });
    } catch (error) {
      void vscode.window.showErrorMessage(t("fileChangeHistory.error.openHistoryFailed", formatError(error)));
      await panel.webview.postMessage({
        type: "inlineError",
        cardId,
        message: t("fileChangeHistory.error.openHistoryFailed", formatError(error)),
      });
    }
  }

  private dismissStale(panel: vscode.WebviewPanel): void {
    const state = this.stateByPanel.get(panel);
    if (!state) return;
    this.stateByPanel.set(panel, { ...state, staleReason: undefined });
  }

  private cancelLoadMore(panel: vscode.WebviewPanel, invalidate = false): void {
    const state = this.stateByPanel.get(panel);
    if (!state || !state.loadMoreCancellation) return;
    state.loadMoreCancellation.cancel();
    this.stateByPanel.set(panel, {
      ...state,
      generation: invalidate ? state.generation + 1 : state.generation,
      loadMoreCancellation: undefined,
    });
  }

  private async sendLoading(panel: vscode.WebviewPanel, phase: string): Promise<void> {
    await panel.webview.postMessage({
      type: "loading",
      phase,
      title: t("fileChangeHistory.title"),
      message: t(`fileChangeHistory.progress.${phase}`),
      i18n: this.buildI18n(),
      dateTime: this.buildDateTime(),
      extensionIcon: this.buildExtensionIcon(panel.webview),
      timeGuideEnabled: getConfig().timeGuideEnabled,
      debugLoggingEnabled: this.logger?.isDebugEnabled() ?? false,
    });
  }

  private async sendModel(
    panel: vscode.WebviewPanel,
    options: { addedCount?: number; reason?: "initial" | "reload" | "loadMore" } = {},
  ): Promise<void> {
    const state = this.stateByPanel.get(panel);
    if (!state) return;
    const config = getConfig();
    const bookmarkState = this.withBookmarkState(state.cards, panel);
    const cards = bookmarkState.cards;
    const model: FileChangeHistoryWebviewModel = {
      target: state.target,
      cards,
      sourceCounts: countSources(cards),
      enabledSources: { codex: config.enableCodexSource, claude: config.enableClaudeSource },
      totalCount: cards.length,
      hasMore: state.hasMore,
      noMore: cards.length > 0 && !state.hasMore,
    };
    await panel.webview.postMessage({
      type: "model",
      model,
      sourceIcons: this.buildSourceIcons(panel.webview),
      i18n: this.buildI18n(),
      dateTime: this.buildDateTime(),
      staleReason: state.staleReason,
      addedCount: options.addedCount,
      reason: options.reason,
      bookmarks: bookmarkState.bookmarkKeys,
      timeGuideEnabled: config.timeGuideEnabled,
      debugLoggingEnabled: this.logger?.isDebugEnabled() ?? false,
    });
  }

  private withBookmarkState(cards: readonly FileChangeHistoryCard[], panel: vscode.WebviewPanel): FileChangeBookmarkState {
    const targets = new Map<string, BookmarkTarget>();
    const cardTargets = new Map<string, BookmarkTarget>();
    const nextCards = cards.map((card) => {
      const target = buildFileChangeBookmarkTarget(card);
      if (!target) return card;
      targets.set(target.key, target);
      cardTargets.set(card.id, target);
      return { ...card, bookmarkKey: target.key };
    });

    const bookmarkedKeys = this.bookmarkStore.getKeysForTargets(Array.from(targets.values()));
    this.bookmarkTargetsByPanel.set(panel, targets);
    const cardsWithState = nextCards.map((card) => {
      const target = cardTargets.get(card.id);
      return target ? { ...card, isBookmarked: bookmarkedKeys.has(target.key) } : card;
    });
    return {
      cards: cardsWithState,
      bookmarkKeys: Array.from(bookmarkedKeys.values()),
    };
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = randomNonce();
    const sharedTimeGuideCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "sharedTimeGuide.css"),
    );
    const sharedTimeGuideJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "sharedTimeGuide.js"),
    );
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "fileChangeHistory.css"));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "fileChangeHistory.js"));
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${sharedTimeGuideCssUri}">
  <link rel="stylesheet" href="${cssUri}">
  <title>${t("fileChangeHistory.title")}</title>
</head>
<body>
  <div id="app"></div>
  <div id="restoreCover" aria-hidden="true" hidden></div>
  <script nonce="${nonce}" src="${sharedTimeGuideJsUri}"></script>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }

  private buildDateTime(): { timeZone: string } {
    const { timeZone } = resolveDateTimeSettings();
    return { timeZone };
  }

  private buildI18n(): Record<string, string> {
    return {
      title: t("fileChangeHistory.title"),
      openFile: t("fileChangeHistory.openFile"),
      copyPath: t("fileChangeHistory.copyPath"),
      reload: t("fileChangeHistory.reload"),
      loading: t("fileChangeHistory.loading"),
      search: t("fileChangeHistory.search"),
      searchPlaceholder: t("fileChangeHistory.searchPlaceholder"),
      searchCaseInsensitive: t("fileChangeHistory.searchCaseInsensitive"),
      searchNoMatches: t("fileChangeHistory.searchNoMatches"),
      pageSearchTitle: t("chat.pageSearch.title"),
      pageSearchTooltip: t("chat.pageSearch.tooltip"),
      pageSearchPlaceholder: t("chat.pageSearch.placeholder"),
      pageSearchPrevTooltip: t("chat.pageSearch.prevTooltip"),
      pageSearchNextTooltip: t("chat.pageSearch.nextTooltip"),
      pageSearchCloseTooltip: t("chat.pageSearch.closeTooltip"),
      pageSearchNoMatches: t("chat.pageSearch.noMatches"),
      pageSearchTypeToSearch: t("chat.pageSearch.typeToSearch"),
      patchBefore: t("chat.patch.before"),
      patchAfter: t("chat.patch.after"),
      patchNoDiff: t("chat.patch.noDiff"),
      openInHistory: t("fileChangeHistory.openInHistory"),
      bookmarkAdd: t("chat.tooltip.bookmarkAdd"),
      bookmarkRemove: t("chat.tooltip.bookmarkRemove"),
      loadFailed: t("fileChangeHistory.error.loadFallback"),
      loadMore: t("fileChangeHistory.loadMore"),
      loadMoreCanceled: t("fileChangeHistory.loadMoreCanceled"),
      noMore: t("fileChangeHistory.noMore"),
      emptyTitle: t("fileChangeHistory.empty.title"),
      emptyHint: t("fileChangeHistory.empty.hint"),
      emptyFilterTitle: t("fileChangeHistory.empty.filterTitle"),
      emptyFilterHint: t("fileChangeHistory.empty.filterHint"),
      sourceCounts: t("fileChangeHistory.sourceCounts"),
      sourceCountsCodexOnly: t("fileChangeHistory.sourceCounts.codexOnly"),
      sourceCountsClaudeOnly: t("fileChangeHistory.sourceCounts.claudeOnly"),
      resultCountOne: t("fileChangeHistory.resultCount.one"),
      resultCountMany: t("fileChangeHistory.resultCount.many"),
      added: t("fileChangeHistory.added"),
      removed: t("fileChangeHistory.removed"),
      movedTo: t("fileChangeHistory.movedTo"),
      changeTypeCreate: t("fileChangeHistory.changeType.create"),
      changeTypeDelete: t("fileChangeHistory.changeType.delete"),
      changeTypeMove: t("fileChangeHistory.changeType.move"),
      changeTypeRename: t("fileChangeHistory.changeType.rename"),
      changeTypeUpdate: t("fileChangeHistory.changeType.update"),
      changeTypeUnknown: t("fileChangeHistory.changeType.unknown"),
      top: t("fileChangeHistory.guide.top"),
      bottom: t("fileChangeHistory.guide.bottom"),
      prevMatch: t("fileChangeHistory.guide.prevMatch"),
      nextMatch: t("fileChangeHistory.guide.nextMatch"),
      dates: t("fileChangeHistory.guide.dates"),
      prevCard: t("fileChangeHistory.prevCard"),
      nextCard: t("fileChangeHistory.nextCard"),
      close: t("fileChangeHistory.close"),
      staleIndexToolContent: t("fileChangeHistory.stale.indexToolContent"),
      staleSources: t("fileChangeHistory.stale.sources"),
      loadMoreDone: t("fileChangeHistory.loadMoreDone"),
      loadMoreDoneMore: t("fileChangeHistory.loadMoreDoneMore"),
      loadMoreAvailable: t("fileChangeHistory.loadMoreAvailable"),
      copied: t("fileChangeHistory.copied"),
    };
  }

  private buildSourceIcons(webview: vscode.Webview): { codex: SourceIconUris; claude: SourceIconUris } {
    return {
      codex: this.buildSourceIconUris(webview, "source-codex.svg"),
      claude: this.buildSourceIconUris(webview, "source-claude.svg"),
    };
  }

  private buildSourceIconUris(webview: vscode.Webview, fileName: string): SourceIconUris {
    return {
      light: String(webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "resources", "icons", "light", fileName))),
      dark: String(webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "resources", "icons", "dark", fileName))),
    };
  }

  private buildExtensionIcon(webview: vscode.Webview): string {
    return String(webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "resources", "codex-history-viewer.svg")));
  }

  private resolvePanelIconPath(_config: CodexHistoryViewerConfig): { light: vscode.Uri; dark: vscode.Uri } {
    return this.panelIconPath;
  }
}

function countSources(cards: readonly FileChangeHistoryCard[]): { codex: number; claude: number } {
  let codex = 0;
  let claude = 0;
  for (const card of cards) {
    if (card.source === "codex") codex += 1;
    else claude += 1;
  }
  return { codex, claude };
}

function buildFileChangeBookmarkTarget(card: FileChangeHistoryCard): BookmarkTarget | null {
  const sessionFsPath = typeof card.sessionFsPath === "string" ? card.sessionFsPath.trim() : "";
  const sessionCacheKey = typeof card.sessionCacheKey === "string" ? card.sessionCacheKey.trim() : "";
  if (!sessionFsPath || !sessionCacheKey) return null;
  const groupId = typeof card.bookmarkGroupId === "string" ? card.bookmarkGroupId.trim() : "";
  const keyParams = {
    sessionCacheKey,
    kind: "patchGroup",
    groupId,
    messageIndex: card.messageIndex,
    timestampIso: card.timestampIso,
    fallbackId: card.entry?.callId || card.entry?.id || card.id,
  } as const;
  const key = buildBookmarkKey(keyParams);
  if (!key) return null;
  return {
    key,
    sessionFsPath,
    sessionCacheKey,
    kind: "patchGroup",
    ...(groupId ? { groupId } : {}),
    title: card.sessionTitle,
    ...(typeof card.messageIndex === "number" ? { messageIndex: card.messageIndex } : {}),
    ...(typeof card.timestampIso === "string" && card.timestampIso.trim() ? { timestampIso: card.timestampIso.trim() } : {}),
  };
}

function buildPanelKey(target: FileChangeHistoryTarget): string {
  return `${normalizeCacheKey(target.workspaceRoot)}\u0000${normalizeCacheKey(target.fsPath)}`;
}

function randomNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i += 1) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown");
}

function formatFileChangeHistoryWebviewDebugMessage(msg: any): string {
  const scope = sanitizeDebugToken(msg?.scope, "webview");
  const eventName = sanitizeDebugToken(msg?.event, "event");
  const details = msg?.details && typeof msg.details === "object" ? msg.details : {};
  const fields: Record<string, string | number | boolean | null | undefined> = { event: eventName };
  for (const [key, value] of Object.entries(details)) {
    const safeKey = sanitizeDebugToken(key, "key");
    if (typeof value === "number" || typeof value === "boolean" || value == null) {
      fields[safeKey] = value;
    } else {
      fields[safeKey] = sanitizeDebugToken(value, "value");
    }
  }
  return formatDebugFields(`fileChangeHistory ${scope}`, fields);
}
