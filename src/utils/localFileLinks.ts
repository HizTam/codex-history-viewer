import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { mapAssociatedProjectPath, type ProjectPathMapping } from "../services/projectPathMapper";
import { normalizeCacheKey, pathExists } from "./fsUtils";

export type LinkedFileTarget = {
  fsPath: string;
  line?: number;
  column?: number;
  relocatedFrom?: string;
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
  options?: {
    requestedLine?: number;
    requestedColumn?: number;
    baseDirs?: readonly string[];
    projectPathMappings?: readonly ProjectPathMapping[];
    claudeSessionFsPath?: string;
  },
): Promise<LinkedFileTarget | null> {
  const parsed = splitPathAndLocation(rawFsPath);
  if (!parsed) return null;

  const requestedLine = sanitizePositiveInteger(options?.requestedLine);
  const requestedColumn = sanitizePositiveInteger(options?.requestedColumn);

  if (parsed.kind === "absolute") {
    const rawPathLiteral = String(rawFsPath ?? "").trim();
    // Try the raw literal only when suffix parsing changed the path, so filenames that
    // literally contain fragments such as `#L39` are not misinterpreted as line suffixes.
    if (rawPathLiteral !== parsed.fsPath && (await pathExists(rawPathLiteral))) {
      return { fsPath: rawPathLiteral, line: requestedLine, column: requestedColumn };
    }
    const relocated = mapAssociatedProjectPath(parsed.fsPath, options?.projectPathMappings ?? []);
    if (relocated && (await pathExists(relocated.fsPath))) {
      return {
        fsPath: relocated.fsPath,
        line: requestedLine ?? parsed.line,
        column: requestedColumn ?? parsed.column,
        relocatedFrom: parsed.fsPath,
      };
    }
    // Fall back to the original path after relocation so relocate uses the current target first.
    if (await pathExists(parsed.fsPath)) {
      return {
        fsPath: parsed.fsPath,
        line: requestedLine ?? parsed.line,
        column: requestedColumn ?? parsed.column,
      };
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

  const claudeTempCandidate = isStandardClaudeProjectSessionPath(options?.claudeSessionFsPath)
    ? await resolveClaudeTempRelativeLink(parsed.fsPath)
    : null;
  if (claudeTempCandidate) {
    return {
      fsPath: claudeTempCandidate,
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

async function resolveClaudeTempRelativeLink(relativePath: string): Promise<string | null> {
  if (process.platform !== "win32") return null;

  const segments = String(relativePath ?? "").split(/[\\/]+/u);
  let firstSuffixIndex = 0;
  while (segments[firstSuffixIndex] === "..") firstSuffixIndex += 1;
  if (firstSuffixIndex === 0 || firstSuffixIndex >= segments.length) return null;

  const suffix = segments.slice(firstSuffixIndex);
  if (suffix.some((segment) => !isSafeWindowsPathSegment(segment))) return null;

  const claudeTempRoot = path.resolve(os.tmpdir(), "claude");
  const driveRoot = path.parse(claudeTempRoot).root;
  if (!driveRoot) return null;

  const candidate = path.resolve(driveRoot, ...suffix);
  if (!isStrictPathDescendant(claudeTempRoot, candidate)) return null;

  try {
    const stat = await fs.lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const [realClaudeTempRoot, realCandidate] = await Promise.all([
      fs.realpath(claudeTempRoot),
      fs.realpath(candidate),
    ]);
    return isStrictPathDescendant(realClaudeTempRoot, realCandidate) ? realCandidate : null;
  } catch {
    return null;
  }
}

function isStrictPathDescendant(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return !!relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isSafeWindowsPathSegment(segment: string): boolean {
  if (!segment || segment === "." || segment === "..") return false;
  if (/[<>:"|?*\u0000-\u001f]/u.test(segment)) return false;
  return !segment.endsWith(" ") && !segment.endsWith(".");
}

function isStandardClaudeProjectSessionPath(sessionFsPath: string | undefined): boolean {
  const rawPath = String(sessionFsPath ?? "").trim();
  if (!rawPath) return false;
  const resolved = path.resolve(rawPath);
  const projectDirectory = path.dirname(resolved);
  const projectsRoot = path.dirname(projectDirectory);
  if (path.basename(projectsRoot).toLowerCase() !== "projects") return false;
  const relativeParts = path.relative(projectsRoot, resolved).split(path.sep).filter(Boolean);
  return relativeParts.length === 2 && path.extname(relativeParts[1] ?? "").toLowerCase() === ".jsonl";
}
