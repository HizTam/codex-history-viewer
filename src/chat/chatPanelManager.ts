import * as vscode from "vscode";
import type { HistoryService } from "../services/historyService";
import type { SessionAnnotationStore } from "../services/sessionAnnotationStore";
import type { PinStore } from "../services/pinStore";
import type { SessionSource, SessionSummary } from "../sessions/sessionTypes";
import { buildSessionSummary } from "../sessions/sessionSummary";
import { normalizeCacheKey } from "../utils/fsUtils";
import { collectLocalLinkBaseDirs, openLinkedFileInEditor, resolveLocalFileLinkTarget } from "../utils/localFileLinks";
import { buildChatSessionModel } from "./chatModelBuilder";
import { resolveUiLanguage, t } from "../i18n";
import { getConfig } from "../settings";
import { resolveDateTimeSettings } from "../utils/dateTimeSettings";
import { truncateByDisplayWidth } from "../utils/textUtils";

// Manages chat-like WebviewPanels opened in the editor area.
export class ChatPanelManager {
  private readonly extensionUri: vscode.Uri;
  private readonly historyService: HistoryService;
  private readonly annotationStore: SessionAnnotationStore;
  private readonly pinStore: PinStore;
  private readonly codexPanelIconPath: { light: vscode.Uri; dark: vscode.Uri };
  private readonly claudePanelIconPath: { light: vscode.Uri; dark: vscode.Uri };

  private previewPanel: vscode.WebviewPanel | null = null;
  private readonly panelsByKey = new Map<string, vscode.WebviewPanel>();
  private readonly stateByPanel = new WeakMap<
    vscode.WebviewPanel,
    { fsPath: string; revealMessageIndex?: number; sessionCwd?: string }
  >();
  private readonly readyByPanel = new WeakMap<vscode.WebviewPanel, boolean>();

  constructor(
    extensionUri: vscode.Uri,
    historyService: HistoryService,
    annotationStore: SessionAnnotationStore,
    pinStore: PinStore,
  ) {
    this.extensionUri = extensionUri;
    this.historyService = historyService;
    this.annotationStore = annotationStore;
    this.pinStore = pinStore;
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
    const send = (panel: vscode.WebviewPanel): void => {
      if (!this.readyByPanel.get(panel)) return;
      void panel.webview.postMessage({
        type: "i18n",
        i18n,
        dateTime,
        toolDisplayMode,
        userLongMessageFolding,
        assistantLongMessageFolding,
      });
    };

    if (this.previewPanel) send(this.previewPanel);
    for (const panel of this.panelsByKey.values()) send(panel);
  }

  public refreshPanels(): void {
    const refresh = (panel: vscode.WebviewPanel): void => {
      if (!this.readyByPanel.get(panel)) return;
      void this.sendSessionData(panel);
    };

    if (this.previewPanel) refresh(this.previewPanel);
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

    if (this.previewPanel) update(this.previewPanel);
    for (const panel of this.panelsByKey.values()) update(panel);
  }

  public async openSession(
    session: SessionSummary,
    options: { preview: boolean; revealMessageIndex?: number },
  ): Promise<void> {
    const key = normalizeCacheKey(session.fsPath);
    const panel = options.preview ? this.getOrCreatePreviewPanel() : this.getOrCreatePanelForKey(key);

    this.stateByPanel.set(panel, { fsPath: session.fsPath, revealMessageIndex: options.revealMessageIndex });
    panel.title = buildPanelTitle(session);
    panel.iconPath = this.resolveSourceIconPath(session.source);
    panel.reveal(panel.viewColumn, options.preview);

    // If the webview is already ready, update immediately on selection changes.
    if (this.readyByPanel.get(panel)) {
      await this.sendSessionData(panel);
    }
  }

  public async openSessionByFsPath(
    fsPath: string,
    options: { preview: boolean; revealMessageIndex?: number },
  ): Promise<void> {
    const session = this.historyService.findByFsPath(fsPath);
    if (!session) {
      void vscode.window.showErrorMessage(t("app.openSessionFailed"));
      return;
    }
    await this.openSession(session, options);
  }

  private getOrCreatePreviewPanel(): vscode.WebviewPanel {
    if (this.previewPanel) return this.previewPanel;
    const panel = this.createPanel({ isPreview: true });
    this.previewPanel = panel;
    panel.onDidDispose(() => {
      this.previewPanel = null;
    });
    return panel;
  }

  private getOrCreatePanelForKey(key: string): vscode.WebviewPanel {
    const existing = this.panelsByKey.get(key);
    if (existing) return existing;
    const panel = this.createPanel({ isPreview: false });
    this.panelsByKey.set(key, panel);
    panel.onDidDispose(() => {
      this.panelsByKey.delete(key);
    });
    return panel;
  }

  private createPanel(params: { isPreview: boolean }): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
      "codexHistoryViewer.chat",
      "Codex Session",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: params.isPreview },
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
    const shikiBundleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "chatViewShiki.bundle.js"),
    );
    const markdownItUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "node_modules", "markdown-it", "dist", "markdown-it.min.js"),
    );

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
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
    <button id="btnReload" type="button" class="toolbarIconBtn"></button>
  </div>
  <div id="annotation"></div>
  <div id="meta"></div>
  <div id="timeline"></div>
  <script nonce="${nonce}" src="${markdownItUri}"></script>
  <script nonce="${nonce}" src="${shikiBundleUri}"></script>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }

  private async handleMessage(panel: vscode.WebviewPanel, msg: any): Promise<void> {
    const state = this.stateByPanel.get(panel);
    if (!state) return;

    const type = typeof msg?.type === "string" ? msg.type : "";
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
        await this.sendSessionData(panel, { restoreScrollY, restoreSelectedMessageIndex });
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
  ): Promise<void> {
    const state = this.stateByPanel.get(panel);
    if (!state) return;
    const model = await buildChatSessionModel(state.fsPath);
    this.stateByPanel.set(panel, {
      ...state,
      sessionCwd: typeof model.meta?.cwd === "string" ? model.meta.cwd : undefined,
    });
    const annotation = this.annotationStore.get(state.fsPath);
    const dateTime = this.buildDateTime();
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
      isPinned: this.pinStore.isPinned(state.fsPath),
      i18n: this.buildI18n(),
      dateTime,
      toolDisplayMode: getConfig().toolDisplayMode,
      userLongMessageFolding: getConfig().userLongMessageFolding,
      assistantLongMessageFolding: getConfig().assistantLongMessageFolding,
    });
  }

  private buildI18n(): Record<string, string> {
    const uiText = (ja: string, en: string): string => (resolveUiLanguage() === "ja" ? ja : en);
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
      copied: t("chat.toast.copied"),
      tool: t("chat.label.tool"),
      arguments: t("chat.label.arguments"),
      output: t("chat.label.output"),
      copy: t("chat.button.copy"),
      showMore: t("chat.button.showMore"),
      showLess: t("chat.button.showLess"),
      copyMessageTooltip: t("chat.tooltip.copyMessage"),
      copyCodeTooltip: t("chat.tooltip.copyCode"),
      jumpPrevUser: t("chat.nav.prevUser"),
      jumpNextUser: t("chat.nav.nextUser"),
      jumpPrevAssistant: t("chat.nav.prevAssistant"),
      jumpNextAssistant: t("chat.nav.nextAssistant"),
      annotationTags: uiText("タグ", "Tags"),
      annotationNote: uiText("メモ", "Note"),
      annotationNone: uiText("なし", "None"),
      annotationEdit: uiText("編集", "Edit"),
      annotationFilterTag: uiText("このタグで履歴を絞り込む", "Filter history by this tag"),
      annotationRemoveTag: uiText("このタグを削除", "Remove this tag"),
      annotationShowMore: uiText("もっと見る", "Show more"),
      annotationShowLess: uiText("閉じる", "Show less"),
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

    const config = getConfig();
    const summary = await buildSessionSummary({
      sessionsRoot: config.sessionsRoot,
      fsPath: state.fsPath,
      previewMaxMessages: config.previewMaxMessages,
      timeZone: this.buildDateTime().timeZone,
    });
    if (!summary) return;

    const displaySummary = applyPanelHistoryDateBasis(summary, config.historyDateBasis);
    panel.title = buildPanelTitle(displaySummary);
    panel.iconPath = this.resolveSourceIconPath(displaySummary.source);
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

function buildPanelTitle(session: SessionSummary): string {
  // Keep panel titles compact by truncating only the snippet segment.
  const shortSnippet = truncateByDisplayWidth(session.snippet, 28, "...");
  return `${session.localDate} ${session.timeLabel} ${shortSnippet}`;
}

function applyPanelHistoryDateBasis(
  session: SessionSummary,
  historyDateBasis: ReturnType<typeof getConfig>["historyDateBasis"],
): SessionSummary {
  const localDate = historyDateBasis === "lastActivity" ? session.lastActivityLocalDate : session.startedLocalDate;
  const timeLabel = historyDateBasis === "lastActivity" ? session.lastActivityTimeLabel : session.startedTimeLabel;
  return { ...session, localDate, timeLabel };
}
