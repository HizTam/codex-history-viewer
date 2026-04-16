import { URLSearchParams } from "url";
import * as vscode from "vscode";
import { tryReadSessionMeta } from "../sessions/sessionSummary";
import { collectLocalLinkBaseDirs, resolveLocalFileLinkTarget, tryParseLocalFileLink } from "../utils/localFileLinks";

const MARKDOWN_LINK_PATTERN = /\[[^\]\r\n]+\]\(([^)\r\n]+)\)/g;

export class TranscriptDocumentLinkProvider implements vscode.DocumentLinkProvider {
  private readonly transcriptScheme: string;

  constructor(transcriptScheme: string) {
    this.transcriptScheme = transcriptScheme;
  }

  public async provideDocumentLinks(document: vscode.TextDocument): Promise<vscode.DocumentLink[]> {
    if (document.uri.scheme !== this.transcriptScheme) return [];

    const sessionFsPath = getSessionFsPathFromTranscriptUri(document.uri);
    if (!sessionFsPath) return [];

    const meta = await tryReadSessionMeta(sessionFsPath);
    const baseDirs = collectLocalLinkBaseDirs(
      meta?.cwd,
      ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    );

    const links: vscode.DocumentLink[] = [];
    let inFence = false;

    for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber += 1) {
      const line = document.lineAt(lineNumber).text;
      if (/^\s*```/.test(line)) {
        // Ignore Markdown links inside fenced code blocks.
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;

      MARKDOWN_LINK_PATTERN.lastIndex = 0;
      for (let match = MARKDOWN_LINK_PATTERN.exec(line); match; match = MARKDOWN_LINK_PATTERN.exec(line)) {
        const rawTarget = extractMarkdownLinkDestination(match[1]);
        if (!rawTarget || !tryParseLocalFileLink(rawTarget)) continue;

        const resolved = await resolveLocalFileLinkTarget(rawTarget, { baseDirs });
        if (!resolved) continue;

        const range = new vscode.Range(
          new vscode.Position(lineNumber, match.index),
          new vscode.Position(lineNumber, match.index + match[0].length),
        );
        const link = new vscode.DocumentLink(range, buildFileUriWithLocation(resolved));
        link.tooltip = resolved.line
          ? `Open ${resolved.fsPath}:${resolved.line}${resolved.column ? `:${resolved.column}` : ""}`
          : `Open ${resolved.fsPath}`;
        links.push(link);
      }
    }

    return links;
  }
}

function getSessionFsPathFromTranscriptUri(uri: vscode.Uri): string | null {
  const fsPath = new URLSearchParams(uri.query).get("fsPath");
  return fsPath && fsPath.trim() ? fsPath : null;
}

function extractMarkdownLinkDestination(rawTarget: string | undefined): string | null {
  const text = String(rawTarget || "").trim();
  if (!text) return null;

  if (text.startsWith("<")) {
    const end = text.indexOf(">");
    if (end > 1) return text.slice(1, end).trim();
  }

  const firstToken = text.match(/^\S+/u);
  return firstToken ? firstToken[0] : null;
}

function buildFileUriWithLocation(target: { fsPath: string; line?: number; column?: number }): vscode.Uri {
  const uri = vscode.Uri.file(target.fsPath);
  if (!target.line) return uri;

  // Keep the line fragment when VS Code can interpret it directly.
  const fragment = target.column ? `L${target.line},${target.column}` : `L${target.line}`;
  return uri.with({ fragment });
}
