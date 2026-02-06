import * as vscode from "vscode";
import type { HistoryService } from "../services/historyService";
import type { SessionSummary } from "../sessions/sessionTypes";
import { normalizeCacheKey } from "../utils/fsUtils";
import { buildChatSessionModel } from "./chatModelBuilder";
import { t } from "../i18n";
import { resolveDateTimeSettings } from "../utils/dateTimeSettings";

// Manages chat-like WebviewPanels opened in the editor area.
export class ChatPanelManager {
  private readonly extensionUri: vscode.Uri;
  private readonly historyService: HistoryService;

  private previewPanel: vscode.WebviewPanel | null = null;
  private readonly panelsByKey = new Map<string, vscode.WebviewPanel>();
  private readonly stateByPanel = new WeakMap<vscode.WebviewPanel, { fsPath: string; revealMessageIndex?: number }>();
  private readonly readyByPanel = new WeakMap<vscode.WebviewPanel, boolean>();

  constructor(extensionUri: vscode.Uri, historyService: HistoryService) {
    this.extensionUri = extensionUri;
    this.historyService = historyService;
  }

  public refreshI18n(): void {
    const i18n = this.buildI18n();
    const dateTime = this.buildDateTime();
    const send = (panel: vscode.WebviewPanel): void => {
      if (!this.readyByPanel.get(panel)) return;
      void panel.webview.postMessage({ type: "i18n", i18n, dateTime });
    };

    if (this.previewPanel) send(this.previewPanel);
    for (const panel of this.panelsByKey.values()) send(panel);
  }

  public refreshTitles(): void {
    const update = (panel: vscode.WebviewPanel): void => {
      const state = this.stateByPanel.get(panel);
      if (!state) return;
      const session = this.historyService.findByFsPath(state.fsPath);
      if (!session) return;
      panel.title = `${session.localDate} ${session.timeLabel} ${session.snippet}`;
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
    panel.title = `${session.localDate} ${session.timeLabel} ${session.snippet}`;
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
    const markdownItUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "node_modules", "markdown-it", "dist", "markdown-it.min.js"),
    );

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource}`,
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
    <button id="btnMarkdown" type="button"></button>
    <div id="toolbarSpacer"></div>
    <button id="btnToggleDetails" type="button"></button>
    <button id="btnReload" type="button" class="toolbarIconBtn"></button>
  </div>
  <div id="meta"></div>
  <div id="timeline"></div>
  <script nonce="${nonce}" src="${markdownItUri}"></script>
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
      case "reload": {
        // Reload rereads the session file and preserves view position (scroll).
        const restoreScrollY = typeof msg?.scrollY === "number" && Number.isFinite(msg.scrollY) ? Math.max(0, msg.scrollY) : undefined;
        const restoreSelectedMessageIndex =
          typeof msg?.selectedMessageIndex === "number" && Number.isFinite(msg.selectedMessageIndex)
            ? msg.selectedMessageIndex
            : undefined;
        await this.sendSessionData(panel, { restoreScrollY, restoreSelectedMessageIndex });
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
    const dateTime = this.buildDateTime();
    void panel.webview.postMessage({
      type: "sessionData",
      model,
      revealMessageIndex: state.revealMessageIndex,
      restoreScrollY: options?.restoreScrollY,
      restoreSelectedMessageIndex: options?.restoreSelectedMessageIndex,
      i18n: this.buildI18n(),
      dateTime,
    });
  }

  private buildI18n(): Record<string, string> {
    return {
      markdown: t("chat.button.markdown"),
      reload: t("chat.button.reload"),
      detailsOn: t("chat.button.detailsOn"),
      detailsOff: t("chat.button.detailsOff"),
      copied: t("chat.toast.copied"),
      tool: t("chat.label.tool"),
      arguments: t("chat.label.arguments"),
      output: t("chat.label.output"),
      copy: t("chat.button.copy"),
    };
  }

  private buildDateTime(): { timeZone: string } {
    // 日時表示のタイムゾーンは、UI言語設定に合わせて決定する（ja=JST、auto/en=システム）。
    const { timeZone } = resolveDateTimeSettings();
    return { timeZone };
  }
}

function randomNonce(): string {
  // Generates a nonce for CSP.
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i += 1) out += chars[Math.floor(Math.random() * chars.length)]!;
  return out;
}
