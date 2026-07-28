import * as path from "node:path";
import * as vscode from "vscode";
import type { HistoryService } from "../services/historyService";
import type { SessionAnnotationStore } from "../services/sessionAnnotationStore";
import type { ProjectAssociationStore } from "../services/projectAssociationStore";
import type { SessionSummary } from "../sessions/sessionTypes";
import { renderTranscript } from "./transcriptRenderer";
import { t } from "../i18n";
import { resolveDateTimeSettings } from "../utils/dateTimeSettings";
import { normalizeCacheKey } from "../utils/fsUtils";
import { buildTranscriptDocumentFileName } from "./transcriptDocumentName";

// TextDocumentContentProvider that exposes a JSONL session as a Markdown transcript.
export class TranscriptContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  public readonly scheme = "codex-history-viewer";

  private readonly historyService: HistoryService;
  private readonly annotationStore: SessionAnnotationStore;
  private readonly projectAssociationStore: ProjectAssociationStore;
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange = this.onDidChangeEmitter.event;

  private readonly cache = new Map<string, { content: string; messageLineMap: Map<number, number> }>();

  constructor(
    historyService: HistoryService,
    annotationStore: SessionAnnotationStore,
    projectAssociationStore: ProjectAssociationStore,
  ) {
    this.historyService = historyService;
    this.annotationStore = annotationStore;
    this.projectAssociationStore = projectAssociationStore;
  }

  public async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const session = this.resolveSessionFromUri(uri);
    if (!session) return "";

    const key = normalizeCacheKey(session.fsPath);
    const cached = this.cache.get(key);
    if (cached) return cached.content;

    const rendered = await this.renderSession(session);
    this.cache.set(key, rendered);
    return rendered.content;
  }

  public async openSessionTranscript(
    session: SessionSummary,
    options: { preview: boolean; revealMessageIndex?: number } = { preview: true },
  ): Promise<void> {
    try {
      const uri = this.resolveOpenUri(session);
      const rendered = await this.renderSession(session);
      this.cache.set(normalizeCacheKey(session.fsPath), rendered);
      this.onDidChangeEmitter.fire(uri);

      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, {
        preview: options.preview,
        preserveFocus: options.preview,
      });
      if (doc.languageId !== "markdown") {
        await vscode.languages.setTextDocumentLanguage(doc, "markdown");
      }

      if (options.revealMessageIndex) {
        const line = rendered.messageLineMap.get(options.revealMessageIndex);
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

  public releaseDocument(uri: vscode.Uri): void {
    if (!isTranscriptDocumentUri(uri, this.scheme)) return;
    const fsPath = getSessionFsPathFromUri(uri);
    if (fsPath) this.cache.delete(normalizeCacheKey(fsPath));
  }

  public dispose(): void {
    this.cache.clear();
    this.onDidChangeEmitter.dispose();
  }

  private async renderSession(
    session: SessionSummary,
  ): Promise<{ content: string; messageLineMap: Map<number, number> }> {
    const { timeZone } = resolveDateTimeSettings();
    const ann = this.annotationStore.get(session.fsPath);
    const displayCwd =
      typeof session.meta?.cwd === "string" ? this.projectAssociationStore.getDisplayCwd(session.meta.cwd) : null;
    return renderTranscript(session.fsPath, {
      timeZone,
      locationLabel:
        session.storage.archiveState === "archived" ? t("session.location.archived") : t("session.location.active"),
      displayCwd,
      annotation: {
        tags: ann?.tags ?? [],
        note: ann?.note ?? "",
      },
    });
  }

  private resolveOpenUri(session: SessionSummary): vscode.Uri {
    const sessionKey = normalizeCacheKey(session.fsPath);
    const existingDocument = vscode.workspace.textDocuments.find((document) => {
      if (!isTranscriptDocumentUri(document.uri, this.scheme)) return false;
      const fsPath = getSessionFsPathFromUri(document.uri);
      return fsPath ? normalizeCacheKey(fsPath) === sessionKey : false;
    });
    if (existingDocument) return existingDocument.uri;

    const query = new URLSearchParams({ fsPath: session.fsPath }).toString();
    const fileName = buildTranscriptDocumentFileName(session.displayTitle);
    return vscode.Uri.from({ scheme: this.scheme, path: `/${fileName}`, query });
  }

  private resolveSessionFromUri(uri: vscode.Uri): SessionSummary | undefined {
    if (!isTranscriptDocumentUri(uri, this.scheme)) return undefined;
    const fsPath = getSessionFsPathFromUri(uri);
    return fsPath ? this.historyService.findByFsPath(fsPath) : undefined;
  }
}

function isTranscriptDocumentUri(uri: vscode.Uri, scheme: string): boolean {
  if (uri.scheme !== scheme || !uri.path.startsWith("/") || !uri.path.toLowerCase().endsWith(".md")) return false;
  return !uri.path.slice(1).includes("/");
}

function getSessionFsPathFromUri(uri: vscode.Uri): string | null {
  const fsPath = new URLSearchParams(uri.query).get("fsPath");
  if (
    !fsPath ||
    fsPath.length > 4_096 ||
    !path.isAbsolute(fsPath) ||
    /[\u0000-\u001f\u007f]/u.test(fsPath)
  ) {
    return null;
  }
  return fsPath;
}
