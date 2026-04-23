import * as vscode from "vscode";
import type { HistoryService } from "../services/historyService";
import type { SessionAnnotationStore } from "../services/sessionAnnotationStore";
import type { PinStore } from "../services/pinStore";
import type { ChatOpenPositionStore } from "../services/chatOpenPositionStore";
import type { SessionSource, SessionSummary } from "../sessions/sessionTypes";
import { buildSessionSummary } from "../sessions/sessionSummary";
import { normalizeCacheKey } from "../utils/fsUtils";
import { collectLocalLinkBaseDirs, openLinkedFileInEditor, resolveLocalFileLinkTarget } from "../utils/localFileLinks";
import { buildChatSessionModel } from "./chatModelBuilder";
import { t } from "../i18n";
import { getConfig } from "../settings";
import { resolveDateTimeSettings } from "../utils/dateTimeSettings";
import { truncateByDisplayWidth } from "../utils/textUtils";
import type { DebugLogger } from "../services/logger";
import type { ChatImageAttachment, ChatSessionModel } from "./chatTypes";

type SaveableChatImage = {
  src: string;
  mimeType: string;
  label: string;
};

type MissingSessionHandler = (fsPath: string) => Promise<void> | void;
export type ChatPanelKind = "reusable" | "session";
type ChatPanelState = { fsPath: string; revealMessageIndex?: number; sessionCwd?: string; kind: ChatPanelKind };
type ExistingChatPanel = { panel: vscode.WebviewPanel; kind: ChatPanelKind };

// Manages chat-like WebviewPanels opened in the editor area.
export class ChatPanelManager {
  private readonly extensionUri: vscode.Uri;
  private readonly historyService: HistoryService;
  private readonly annotationStore: SessionAnnotationStore;
  private readonly pinStore: PinStore;
  private readonly openPositionStore: ChatOpenPositionStore;
  private readonly onMissingSession?: MissingSessionHandler;
  private readonly logger?: DebugLogger;
  private readonly codexPanelIconPath: { light: vscode.Uri; dark: vscode.Uri };
  private readonly claudePanelIconPath: { light: vscode.Uri; dark: vscode.Uri };

  private reusablePanel: vscode.WebviewPanel | null = null;
  private readonly panelsByKey = new Map<string, vscode.WebviewPanel>();
  private readonly stateByPanel = new WeakMap<vscode.WebviewPanel, ChatPanelState>();
  private readonly readyByPanel = new WeakMap<vscode.WebviewPanel, boolean>();
  private readonly imageDataByPanel = new WeakMap<vscode.WebviewPanel, Map<string, SaveableChatImage>>();

  constructor(
    extensionUri: vscode.Uri,
    historyService: HistoryService,
    annotationStore: SessionAnnotationStore,
    pinStore: PinStore,
    openPositionStore: ChatOpenPositionStore,
    onMissingSession?: MissingSessionHandler,
    logger?: DebugLogger,
  ) {
    this.extensionUri = extensionUri;
    this.historyService = historyService;
    this.annotationStore = annotationStore;
    this.pinStore = pinStore;
    this.openPositionStore = openPositionStore;
    this.onMissingSession = onMissingSession;
    this.logger = logger;
    this.codexPanelIconPath = {
      light: vscode.Uri.joinPath(extensionUri, "resources", "icons", "light", "source-codex.svg"),
      dark: vscode.Uri.joinPath(extensionUri, "resources", "icons", "dark", "source-codex.svg"),
    };
    this.claudePanelIconPath = {
      light: vscode.Uri.joinPath(extensionUri, "resources", "icons", "light", "source-claude.svg"),
      dark: vscode.Uri.joinPath(extensionUri, "resources", "icons", "dark", "source-claude.svg"),
    };
  }

  public refreshI18n(): void {
    const i18n = this.buildI18n();
    const dateTime = this.buildDateTime();
    const config = getConfig();
    const toolDisplayMode = config.toolDisplayMode;
    const userLongMessageFolding = config.userLongMessageFolding;
    const assistantLongMessageFolding = config.assistantLongMessageFolding;
    const imageSettings = this.buildImageSettings(config);
    const send = (panel: vscode.WebviewPanel): void => {
      if (!this.readyByPanel.get(panel)) return;
      void panel.webview.postMessage({
        type: "i18n",
        i18n,
        dateTime,
        toolDisplayMode,
        userLongMessageFolding,
        assistantLongMessageFolding,
        imageSettings,
        chatOpenPosition: config.chatOpenPosition,
        debugLoggingEnabled: this.logger?.isDebugEnabled() ?? false,
      });
    };

    if (this.reusablePanel) send(this.reusablePanel);
    for (const panel of this.panelsByKey.values()) send(panel);
  }

  public refreshPanels(): void {
    const refresh = (panel: vscode.WebviewPanel): void => {
      if (!this.readyByPanel.get(panel)) return;
      void this.sendSessionData(panel);
    };

    if (this.reusablePanel) refresh(this.reusablePanel);
    for (const panel of this.panelsByKey.values()) refresh(panel);
  }

  public refreshTitles(): void {
    const update = (panel: vscode.WebviewPanel): void => {
      const state = this.stateByPanel.get(panel);
      if (!state) return;
      const session = this.historyService.findByFsPath(state.fsPath);
      if (!session) return;
      panel.title = buildPanelTitle(session);
      panel.iconPath = this.resolveSourceIconPath(session.source);
    };

    if (this.reusablePanel) update(this.reusablePanel);
    for (const panel of this.panelsByKey.values()) update(panel);
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
      await this.handleMissingSession(panel, state.fsPath, { showMessage: false, notify: false });
    }
  }

  public async openSession(
    session: SessionSummary,
    options: { kind: ChatPanelKind; revealMessageIndex?: number },
  ): Promise<void> {
    if (!(await this.ensureSessionFileAvailable(session.fsPath))) {
      await this.handleMissingSession(null, session.fsPath);
      return;
    }

    const key = normalizeCacheKey(session.fsPath);
    const panel = options.kind === "reusable" ? this.getOrCreateReusablePanel() : this.getOrCreatePanelForKey(key);

    this.stateByPanel.set(panel, {
      fsPath: session.fsPath,
      revealMessageIndex: options.revealMessageIndex,
      kind: options.kind,
    });
    panel.title = buildPanelTitle(session);
    panel.iconPath = this.resolveSourceIconPath(session.source);
    panel.reveal(panel.viewColumn, options.kind === "reusable");

    // If the webview is already ready, update immediately on selection changes.
    if (this.readyByPanel.get(panel)) {
      await this.sendSessionData(panel);
    }
  }

  public async revealExistingSessionPanel(
    fsPath: string,
    revealMessageIndex?: number,
    options: { preserveFocus?: boolean; promoteReusable?: boolean } = {},
  ): Promise<boolean> {
    const existing = this.findExistingSessionPanel(fsPath);
    if (!existing) return false;
    const { panel } = existing;
    const state = this.stateByPanel.get(panel);
    if (!state) return false;
    if (!(await this.ensurePanelSessionFile(panel, state.fsPath))) return false;

    const nextKind = existing.kind === "reusable" && options.promoteReusable === true ? "session" : state.kind;
    if (state.kind === "reusable" && nextKind === "session") {
      this.promoteReusablePanelToSession(panel, state.fsPath);
    }

    this.stateByPanel.set(panel, { ...state, revealMessageIndex, kind: nextKind });
    panel.reveal(panel.viewColumn, options.preserveFocus === true);
    if (this.readyByPanel.get(panel)) {
      await this.sendSessionData(panel);
    }
    return true;
  }

  public async openSessionByFsPath(
    fsPath: string,
    options: { kind: ChatPanelKind; revealMessageIndex?: number },
  ): Promise<void> {
    const session = this.historyService.findByFsPath(fsPath);
    if (!session) {
      void vscode.window.showErrorMessage(t("app.openSessionFailed"));
      return;
    }
    await this.openSession(session, options);
  }

  private getOrCreateReusablePanel(): vscode.WebviewPanel {
    if (this.reusablePanel) return this.reusablePanel;
    const panel = this.createPanel({ kind: "reusable" });
    this.reusablePanel = panel;
    panel.onDidDispose(() => {
      if (this.reusablePanel === panel) {
        this.reusablePanel = null;
      }
    });
    return panel;
  }

  private getOrCreatePanelForKey(key: string): vscode.WebviewPanel {
    const existing = this.panelsByKey.get(key);
    if (existing) return existing;
    const panel = this.createPanel({ kind: "session" });
    this.panelsByKey.set(key, panel);
    panel.onDidDispose(() => {
      this.panelsByKey.delete(key);
    });
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

  private promoteReusablePanelToSession(panel: vscode.WebviewPanel, fsPath: string): void {
    if (this.reusablePanel === panel) {
      this.reusablePanel = null;
    }
    const key = normalizeCacheKey(fsPath);
    this.panelsByKey.set(key, panel);
    panel.onDidDispose(() => {
      if (this.panelsByKey.get(key) === panel) {
        this.panelsByKey.delete(key);
      }
    });
  }

  private createPanel(params: { kind: ChatPanelKind }): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
      "codexHistoryViewer.chat",
      "Codex Session",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: params.kind === "reusable" },
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, "media"),
          vscode.Uri.joinPath(this.extensionUri, "node_modules", "markdown-it", "dist"),
        ],
        retainContextWhenHidden: true,
      },
    );

    panel.webview.html = this.buildHtml(panel.webview);
    this.readyByPanel.set(panel, false);

    panel.webview.onDidReceiveMessage(async (msg) => {
      await this.handleMessage(panel, msg);
    });

    return panel;
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = randomNonce();
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "chatView.css"));
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
  <link rel="stylesheet" href="${cssUri}">
  <title>Codex History Viewer</title>
</head>
<body>
  <div id="toolbar">
    <button id="btnResumeInCodex" type="button"></button>
    <button id="btnPinToggle" type="button"></button>
    <div id="toolbarSpacer"></div>
    <button id="btnMarkdown" type="button"></button>
    <button id="btnCopyResume" type="button"></button>
    <button id="btnToggleDetails" type="button"></button>
    <button id="btnScrollTop" type="button" class="toolbarIconBtn"></button>
    <button id="btnScrollBottom" type="button" class="toolbarIconBtn"></button>
    <button id="btnPageSearch" type="button" class="toolbarIconBtn"></button>
    <button id="btnReload" type="button" class="toolbarIconBtn"></button>
  </div>
  <div id="pageSearchBar" hidden>
    <div id="pageSearchResizeHandle" aria-hidden="true"></div>
    <div id="pageSearchInner">
      <div id="pageSearchHeader">
        <div id="pageSearchTitle"></div>
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
    </div>
    <div id="pageSearchResults" role="listbox" aria-live="polite"></div>
  </div>
  <div id="scrollRoot">
    <div id="annotation"></div>
    <div id="meta"></div>
    <div id="timeline"></div>
  </div>
  <script nonce="${nonce}" src="${markdownItUri}"></script>
  <script nonce="${nonce}" src="${katexJsUri}"></script>
  <script nonce="${nonce}" src="${shikiBundleUri}"></script>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }

  private async handleMessage(panel: vscode.WebviewPanel, msg: any): Promise<void> {
    const state = this.stateByPanel.get(panel);
    if (!state) return;

    const type = typeof msg?.type === "string" ? msg.type : "";
    if (
      type !== "ready" &&
      type !== "copy" &&
      type !== "debug" &&
      type !== "rememberOpenPosition" &&
      !(await this.ensurePanelSessionFile(panel, state.fsPath))
    ) {
      return;
    }

    switch (type) {
      case "ready": {
        this.readyByPanel.set(panel, true);
        await this.sendSessionData(panel);
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
      case "saveImage": {
        await this.saveImageFromPanel(panel, msg);
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
      case "togglePin": {
        const commandId = this.pinStore.isPinned(state.fsPath)
          ? "codexHistoryViewer.unpinSession"
          : "codexHistoryViewer.pinSession";
        await vscode.commands.executeCommand(commandId, { fsPath: state.fsPath });
        await this.sendSessionData(panel);
        return;
      }
      case "openLocalFile": {
        const rawFsPath = typeof msg?.fsPath === "string" ? msg.fsPath.trim() : "";
        if (!rawFsPath) return;

        const requestedLine =
          typeof msg?.line === "number" && Number.isFinite(msg.line) && msg.line >= 1
            ? Math.floor(msg.line)
            : undefined;
        const requestedColumn =
          typeof msg?.column === "number" && Number.isFinite(msg.column) && msg.column >= 1
            ? Math.floor(msg.column)
            : undefined;
        const target = await resolveLocalFileLinkTarget(rawFsPath, {
          requestedLine,
          requestedColumn,
          baseDirs: collectLocalLinkBaseDirs(
            state.sessionCwd,
            ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
          ),
        });

        if (!target || !(await openLinkedFileInEditor(target))) {
          void vscode.window.showErrorMessage(t("app.openLinkedFileFailed", rawFsPath));
        }
        return;
      }
      case "reload": {
        // Reload rereads the session file and preserves view position (scroll).
        const restoreScrollY = typeof msg?.scrollY === "number" && Number.isFinite(msg.scrollY) ? Math.max(0, msg.scrollY) : undefined;
        const restoreSelectedMessageIndex =
          typeof msg?.selectedMessageIndex === "number" && Number.isFinite(msg.selectedMessageIndex)
            ? msg.selectedMessageIndex
            : undefined;
        const sent = await this.sendSessionData(panel, { restoreScrollY, restoreSelectedMessageIndex });
        if (!sent) return;
        await this.refreshPanelTitleFromFile(panel);
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
      default:
        return;
    }
  }

  private async sendSessionData(
    panel: vscode.WebviewPanel,
    options?: { restoreScrollY?: number; restoreSelectedMessageIndex?: number },
  ): Promise<boolean> {
    const state = this.stateByPanel.get(panel);
    if (!state) return false;
    if (!(await this.ensurePanelSessionFile(panel, state.fsPath))) return false;

    const config = getConfig();
    let model: Awaited<ReturnType<typeof buildChatSessionModel>>;
    try {
      model = await buildChatSessionModel(state.fsPath, { images: config.images });
    } catch {
      if (!(await this.ensurePanelSessionFile(panel, state.fsPath))) return false;
      void vscode.window.showErrorMessage(t("app.openSessionFailed"));
      return false;
    }

    this.stateByPanel.set(panel, {
      ...state,
      sessionCwd: typeof model.meta?.cwd === "string" ? model.meta.cwd : undefined,
    });
    this.imageDataByPanel.set(panel, collectSaveableImages(model));
    const annotation = this.annotationStore.get(state.fsPath);
    const dateTime = this.buildDateTime();
    const savedOpenMessageIndex =
      config.chatOpenPosition === "lastMessage" ? this.openPositionStore.get(state.fsPath) : undefined;
    this.logger?.debug(
      `chatOpenPosition send session=${debugSessionName(state.fsPath)} mode=${config.chatOpenPosition} panelKind=${state.kind} saved=${savedOpenMessageIndex ?? "none"}`,
    );
    void panel.webview.postMessage({
      type: "sessionData",
      model: {
        ...model,
        annotation: {
          tags: annotation?.tags ? [...annotation.tags] : [],
          note: annotation?.note ?? "",
        },
      },
      revealMessageIndex: state.revealMessageIndex,
      restoreScrollY: options?.restoreScrollY,
      restoreSelectedMessageIndex: options?.restoreSelectedMessageIndex,
      panelKind: state.kind,
      isPreview: state.kind === "reusable",
      isPinned: this.pinStore.isPinned(state.fsPath),
      i18n: this.buildI18n(),
      dateTime,
      chatOpenPosition: config.chatOpenPosition,
      savedOpenMessageIndex,
      debugLoggingEnabled: this.logger?.isDebugEnabled() ?? false,
      toolDisplayMode: config.toolDisplayMode,
      userLongMessageFolding: config.userLongMessageFolding,
      assistantLongMessageFolding: config.assistantLongMessageFolding,
      imageSettings: this.buildImageSettings(config),
    });
    return true;
  }

  private buildImageSettings(config: ReturnType<typeof getConfig>): { thumbnailSize: "small" | "medium" | "large" } {
    return {
      thumbnailSize: config.images.thumbnailSize,
    };
  }

  private async saveImageFromPanel(panel: vscode.WebviewPanel, msg: any): Promise<void> {
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

    const state = this.stateByPanel.get(panel);
    const defaultUri = buildDefaultImageSaveUri(state?.sessionCwd, image.label, decoded.extension);
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

  private buildI18n(): Record<string, string> {
    return {
      resumeInCodex: t("chat.button.resumeInCodex"),
      resumeInCodexTooltip: t("chat.tooltip.resumeInCodex"),
      resumeInClaude: t("chat.button.resumeInClaude"),
      resumeInClaudeTooltip: t("chat.tooltip.resumeInClaude"),
      pin: t("chat.button.pin"),
      unpin: t("chat.button.unpin"),
      pinTooltip: t("chat.tooltip.pin"),
      unpinTooltip: t("chat.tooltip.unpin"),
      markdown: t("chat.button.markdown"),
      markdownTooltip: t("chat.tooltip.markdown"),
      copyResume: t("chat.button.copyResume"),
      // Tooltip explains the purpose of the "Copy Prompt Excerpt" action.
      copyResumeTooltip: t("chat.tooltip.copyResume"),
      reload: t("chat.button.reload"),
      reloadTooltip: t("chat.tooltip.reload"),
      scrollTop: t("chat.button.scrollTop"),
      scrollTopTooltip: t("chat.tooltip.scrollTop"),
      scrollBottom: t("chat.button.scrollBottom"),
      scrollBottomTooltip: t("chat.tooltip.scrollBottom"),
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
      copied: t("chat.toast.copied"),
      restoredLastPosition: t("chat.toast.restoredLastPosition"),
      tool: t("chat.label.tool"),
      arguments: t("chat.label.arguments"),
      output: t("chat.label.output"),
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
      copy: t("chat.button.copy"),
      showMore: t("chat.button.showMore"),
      showLess: t("chat.button.showLess"),
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
    };
  }

  private buildDateTime(): { timeZone: string } {
    // Resolve the display time zone from UI language settings (ja=JST, auto/en=system).
    const { timeZone } = resolveDateTimeSettings();
    return { timeZone };
  }

  private async refreshPanelTitleFromFile(panel: vscode.WebviewPanel): Promise<void> {
    const state = this.stateByPanel.get(panel);
    if (!state) return;
    if (!(await this.ensurePanelSessionFile(panel, state.fsPath))) return;

    const config = getConfig();
    this.historyService.updateConfig(config);
    const summary = await buildSessionSummary({
      sessionsRoot: config.sessionsRoot,
      fsPath: state.fsPath,
      previewMaxMessages: config.previewMaxMessages,
      timeZone: this.buildDateTime().timeZone,
    });
    if (!summary) return;

    const displaySummary = await this.historyService.resolveDisplaySummary(
      applyPanelHistoryDateBasis(summary, config.historyDateBasis),
    );
    panel.title = buildPanelTitle(displaySummary);
    panel.iconPath = this.resolveSourceIconPath(displaySummary.source);
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

  private async ensurePanelSessionFile(panel: vscode.WebviewPanel, fsPath: string): Promise<boolean> {
    if (await this.ensureSessionFileAvailable(fsPath)) return true;
    await this.handleMissingSession(panel, fsPath);
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
    const panels: vscode.WebviewPanel[] = [];
    if (this.reusablePanel) panels.push(this.reusablePanel);
    for (const panel of this.panelsByKey.values()) panels.push(panel);
    return panels;
  }

  private disposePanel(panel: vscode.WebviewPanel): void {
    try {
      panel.dispose();
    } catch {
      // Ignore dispose failures; the panel may already be closed.
    }
  }

  private resolveSourceIconPath(source: SessionSource): { light: vscode.Uri; dark: vscode.Uri } {
    return source === "claude" ? this.claudePanelIconPath : this.codexPanelIconPath;
  }
}

function randomNonce(): string {
  // Generates a nonce for CSP.
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i += 1) out += chars[Math.floor(Math.random() * chars.length)]!;
  return out;
}

function formatWebviewDebugMessage(msg: any): string {
  const eventName = sanitizeDebugToken(msg?.event, "event");
  const details = msg?.details && typeof msg.details === "object" ? msg.details : {};
  const parts: string[] = [];
  for (const [key, value] of Object.entries(details)) {
    const safeKey = sanitizeDebugToken(key, "key");
    const safeValue = sanitizeDebugValue(value);
    if (safeValue === undefined) continue;
    parts.push(`${safeKey}=${safeValue}`);
  }
  return `chatOpenPosition webview event=${eventName}${parts.length > 0 ? ` ${parts.join(" ")}` : ""}`;
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

function collectSaveableImages(model: ChatSessionModel): Map<string, SaveableChatImage> {
  const images = new Map<string, SaveableChatImage>();
  for (const item of model.items) {
    if (item.type !== "message" || !Array.isArray(item.images)) continue;
    for (const image of item.images) {
      const saveable = toSaveableImage(image);
      if (!saveable) continue;
      images.set(image.id!, saveable);
    }
  }
  return images;
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

function buildDefaultImageSaveUri(sessionCwd: string | undefined, label: string, extension: string): vscode.Uri {
  const fileName = buildImageFileName(label, extension);
  const baseDir = typeof sessionCwd === "string" && sessionCwd.trim() ? sessionCwd.trim() : undefined;
  if (!baseDir) return vscode.Uri.file(fileName);
  return vscode.Uri.joinPath(vscode.Uri.file(baseDir), fileName);
}

function buildImageFileName(label: string, extension: string): string {
  const withoutKnownExtension = String(label || "image-attachment").replace(/\.(png|jpe?g|gif|webp)$/iu, "");
  let base = withoutKnownExtension
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  if (!base) base = "image-attachment";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(base)) base = `image-${base}`;
  return `${base}${extension}`;
}

function formatError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error ?? "Unknown error");
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
