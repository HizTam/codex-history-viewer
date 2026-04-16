import * as path from "node:path";
import * as vscode from "vscode";
import { normalizeCacheKey, pathExists } from "./fsUtils";

export type LinkedFileTarget = {
  fsPath: string;
  line?: number;
  column?: number;
};

type ParsedLocalFileLink = LinkedFileTarget & {
  kind: "absolute" | "relative";
};

export function tryParseLocalFileLink(rawHref: string): ParsedLocalFileLink | null {
  const href = String(rawHref || "").trim();
  if (!href || href.startsWith("command:")) return null;

  const fromVscodeCdn = parseFromVscodeResourceCdn(href);
  if (fromVscodeCdn) return fromVscodeCdn;

  const fromFileUri = parseFromFileUri(href);
  if (fromFileUri) return fromFileUri;

  return splitPathAndLocation(safeDecodeURIComponent(href));
}

export async function resolveLocalFileLinkTarget(
  rawFsPath: string,
  options?: { requestedLine?: number; requestedColumn?: number; baseDirs?: readonly string[] },
): Promise<LinkedFileTarget | null> {
  const parsed = splitPathAndLocation(rawFsPath);
  if (!parsed) return null;

  const requestedLine = sanitizePositiveInteger(options?.requestedLine);
  const requestedColumn = sanitizePositiveInteger(options?.requestedColumn);

  if (parsed.kind === "absolute") {
    // Prefer the original absolute path when it exists so filenames that literally contain
    // fragments such as `#L39` are not misinterpreted as line suffixes.
    if (await pathExists(rawFsPath)) {
      return { fsPath: rawFsPath, line: requestedLine, column: requestedColumn };
    }
    return {
      fsPath: parsed.fsPath,
      line: requestedLine ?? parsed.line,
      column: requestedColumn ?? parsed.column,
    };
  }

  const baseDirs = collectLocalLinkBaseDirs(...(options?.baseDirs ?? []));
  for (const baseDir of baseDirs) {
    const candidate = path.resolve(baseDir, parsed.fsPath);
    if (!(await pathExists(candidate))) continue;
    return {
      fsPath: candidate,
      line: requestedLine ?? parsed.line,
      column: requestedColumn ?? parsed.column,
    };
  }

  return null;
}

export async function openLinkedFileInEditor(target: LinkedFileTarget): Promise<boolean> {
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target.fsPath));
    const opts: vscode.TextDocumentShowOptions = {
      preview: false,
      preserveFocus: false,
    };
    if (target.line !== undefined) {
      const pos = new vscode.Position(Math.max(0, target.line - 1), Math.max(0, (target.column ?? 1) - 1));
      opts.selection = new vscode.Range(pos, pos);
    }
    await vscode.window.showTextDocument(doc, opts);
    return true;
  } catch {
    return false;
  }
}

export function collectLocalLinkBaseDirs(...baseDirs: Array<string | null | undefined>): string[] {
  const byKey = new Map<string, string>();
  for (const rawBaseDir of baseDirs) {
    const baseDir = String(rawBaseDir ?? "").trim();
    if (!baseDir) continue;
    const key = normalizeCacheKey(baseDir);
    if (!byKey.has(key)) byKey.set(key, baseDir);
  }
  return Array.from(byKey.values());
}

function parseFromVscodeResourceCdn(href: string): ParsedLocalFileLink | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.hostname !== "file+.vscode-resource.vscode-cdn.net") return null;

  let decodedPath = safeDecodeURIComponent(`${url.pathname || ""}${url.hash || ""}`);
  decodedPath = decodedPath.replace(/^\/+/, "");
  if (!decodedPath) return null;
  return splitPathAndLocation(decodedPath, { allowHashSuffix: !!url.hash });
}

function parseFromFileUri(href: string): ParsedLocalFileLink | null {
  if (!href.toLowerCase().startsWith("file://")) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  let decodedPath = safeDecodeURIComponent(`${url.pathname || ""}${url.hash || ""}`);
  if (/^\/[a-zA-Z]:\//.test(decodedPath)) decodedPath = decodedPath.slice(1);
  if (!decodedPath) return null;
  return splitPathAndLocation(decodedPath, { allowHashSuffix: !!url.hash });
}

function splitPathAndLocation(
  pathLike: string,
  options?: { allowHashSuffix?: boolean; allowColonSuffix?: boolean },
): ParsedLocalFileLink | null {
  const text = String(pathLike || "").trim();
  const kind = detectPathKind(text);
  if (!kind) return null;

  const hashTarget = options?.allowHashSuffix === false ? null : parseHashPathLocation(text);
  if (hashTarget) return hashTarget;

  const colonTarget = options?.allowColonSuffix === false ? null : parseColonPathLocation(text);
  if (colonTarget) return colonTarget;

  return { fsPath: text, kind };
}

function parseHashPathLocation(text: string): ParsedLocalFileLink | null {
  // Accept GitHub- and VS Code-style fragments such as `#L39`, `#L39C2`, and `#L39-L45`.
  const match = text.match(/^(.*?)(?:#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?)$/i);
  if (!match) return null;
  return buildLinkedFileTarget(match[1], match[2], match[3], text);
}

function parseColonPathLocation(text: string): ParsedLocalFileLink | null {
  const match = text.match(/^(.*?)(?::(\d+)(?::(\d+))?)$/);
  if (!match) return null;
  return buildLinkedFileTarget(match[1], match[2], match[3], text);
}

function buildLinkedFileTarget(
  fsPathLike: string,
  lineText: string | undefined,
  columnText: string | undefined,
  fallbackFsPath: string,
): ParsedLocalFileLink | null {
  const fsPath = String(fsPathLike || "").trim();
  const kind = detectPathKind(fsPath);
  if (!kind) return null;

  const line = sanitizePositiveInteger(lineText ? Number(lineText) : undefined);
  const column = sanitizePositiveInteger(columnText ? Number(columnText) : undefined);
  if (line === undefined) return { fsPath: fallbackFsPath, kind };

  return { fsPath, line, column, kind };
}

function detectPathKind(input: string): "absolute" | "relative" | null {
  const text = String(input || "").trim();
  if (!text) return null;
  if (isAbsolutePathLike(text)) return "absolute";
  return looksLikeRelativePath(text) ? "relative" : null;
}

function isAbsolutePathLike(input: string): boolean {
  const text = String(input || "").trim();
  if (!text) return false;
  if (/^[a-zA-Z]:[\\/]/.test(text)) return true;
  if (text.startsWith("\\\\")) return true;
  return text.startsWith("/");
}

function looksLikeRelativePath(input: string): boolean {
  const text = String(input || "").trim();
  if (!text) return false;
  if (isAbsolutePathLike(text)) return false;
  if (text.startsWith("#") || text.startsWith("?")) return false;
  if (text.startsWith("//")) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) return false;
  if (text.startsWith("./") || text.startsWith("../") || text.startsWith(".\\") || text.startsWith("..\\")) return true;
  if (text.includes("/") || text.includes("\\")) return true;

  const body = text.replace(/[?#].*$/u, "");
  return /^[^\s\\/]+(?:\.[^\s\\/]+)+$/u.test(body);
}

function sanitizePositiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined;
}

function safeDecodeURIComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
