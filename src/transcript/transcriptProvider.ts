import * as vscode from "vscode";
import type { HistoryService } from "../services/historyService";
import type { SessionSummary } from "../sessions/sessionTypes";
import { renderTranscript } from "./transcriptRenderer";
import { t } from "../i18n";

// TextDocumentContentProvider that exposes a JSONL session as a Markdown transcript.
export class TranscriptContentProvider implements vscode.TextDocumentContentProvider {
  public readonly scheme = "codex-history-viewer";

  private readonly historyService: HistoryService;
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange = this.onDidChangeEmitter.event;

  private readonly cache = new Map<string, { content: string; messageLineMap: Map<number, number> }>();

  constructor(historyService: HistoryService) {
    this.historyService = historyService;
  }

  public provideTextDocumentContent(uri: vscode.Uri): string {
    const key = uri.toString();
    return this.cache.get(key)?.content ?? "";
  }

  public async openSessionTranscript(
    session: SessionSummary,
    options: { preview: boolean; revealMessageIndex?: number } = { preview: true },
  ): Promise<void> {
    try {
      const uri = this.buildUri(session.fsPath);
      const { content, messageLineMap } = await renderTranscript(session.fsPath);
      this.cache.set(uri.toString(), { content, messageLineMap });
      this.onDidChangeEmitter.fire(uri);

      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, {
        preview: options.preview,
        preserveFocus: options.preview,
      });
      await vscode.languages.setTextDocumentLanguage(doc, "markdown");

      if (options.revealMessageIndex) {
        const line = messageLineMap.get(options.revealMessageIndex);
        if (typeof line === "number") {
          const pos = new vscode.Position(Math.max(0, line - 1), 0);
          editor.selection = new vscode.Selection(pos, pos);
          await editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        }
      }
    } catch {
      void vscode.window.showErrorMessage(t("app.openSessionFailed"));
    }
  }

  private buildUri(fsPath: string): vscode.Uri {
    // Use a .md path so VS Code treats it as Markdown.
    const query = new URLSearchParams({ fsPath }).toString();
    return vscode.Uri.from({ scheme: this.scheme, path: "/session.md", query });
  }
}
