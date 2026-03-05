import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import type { SessionSource, SessionSummary } from "../sessions/sessionTypes";
import { tryReadSessionMeta } from "../sessions/sessionSummary";
import { toYmdInTimeZone } from "../utils/dateUtils";
import { resolveDateTimeSettings } from "../utils/dateTimeSettings";
import { renderTranscript } from "../transcript/transcriptRenderer";
import { resolveUiLanguage } from "../i18n";

export interface ExportSessionsResult {
  destinationDir: string;
  exported: number;
  skipped: number;
  failed: number;
}

export interface ImportSessionsResult {
  sourceDir: string;
  imported: number;
  overwritten: number;
  skipped: number;
  skippedExisting: number;
  skippedDuplicateId: number;
  failed: number;
}

export type DuplicateSessionIdMode = "skip" | "overwrite";

interface ExportManifestV1 {
  version: 1;
  generatedAtIso: string;
  roots: {
    codexSessionsRoot: string;
    claudeSessionsRoot: string;
  };
  files: ExportManifestFileEntryV1[];
}

interface ExportManifestFileEntryV1 {
  source: SessionSource;
  originalPath: string;
  relativePathFromSourceRoot: string;
  exportedRelativePath: string;
  sessionId?: string;
}

interface ImportFileCandidate {
  srcPath: string;
  sourceHint?: SessionSource;
  relativeHint?: string;
}

const EXPORT_MANIFEST_JSON = "manifest.json";
const EXPORT_MANIFEST_TEXT = "manifest.txt";

export async function exportSessions(params: {
  sessions: readonly SessionSummary[];
  codexSessionsRoot: string;
  claudeSessionsRoot: string;
}): Promise<ExportSessionsResult | null> {
  const { sessions, codexSessionsRoot, claudeSessionsRoot } = params;
  if (sessions.length === 0) return null;

  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    canSelectFolders: true,
    canSelectFiles: false,
    openLabel: localizeDialogLabel("Choose export destination", "エクスポート先を選択"),
  });
  if (!picked || picked.length === 0) return null;
  const baseDir = picked[0]!.fsPath;

  const stamp = buildDateStamp();
  const destinationDir = path.join(baseDir, `codex-history-export-${stamp}`);
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(destinationDir));

  let exported = 0;
  let skipped = 0;
  let failed = 0;

  const manifestLines: string[] = [];
  const manifestFiles: ExportManifestFileEntryV1[] = [];

  for (const session of sessions) {
    const relativeFromSource = buildRelativePathForSource(session.source, session.fsPath, {
      codexSessionsRoot,
      claudeSessionsRoot,
    });
    const preferredRelative = path.join(session.source, relativeFromSource);
    const targetPath = await ensureUniquePath(path.join(destinationDir, preferredRelative));

    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(targetPath)));
      await vscode.workspace.fs.copy(vscode.Uri.file(session.fsPath), vscode.Uri.file(targetPath), { overwrite: false });
      exported += 1;

      const exportedRelativePath = toForwardSlash(path.relative(destinationDir, targetPath));
      manifestFiles.push({
        source: session.source,
        originalPath: session.fsPath,
        relativePathFromSourceRoot: toForwardSlash(relativeFromSource),
        exportedRelativePath,
        sessionId: normalizeSessionId(session.meta?.id) || undefined,
      });
      manifestLines.push(`${session.fsPath} -> ${targetPath}`);
    } catch {
      failed += 1;
    }
  }

  const manifestJson: ExportManifestV1 = {
    version: 1,
    generatedAtIso: new Date().toISOString(),
    roots: {
      codexSessionsRoot,
      claudeSessionsRoot,
    },
    files: manifestFiles,
  };

  try {
    await fs.writeFile(path.join(destinationDir, EXPORT_MANIFEST_JSON), JSON.stringify(manifestJson, null, 2), {
      encoding: "utf8",
    });
    await fs.writeFile(path.join(destinationDir, EXPORT_MANIFEST_TEXT), manifestLines.join("\n"), { encoding: "utf8" });
  } catch {
    skipped += 1;
  }

  return { destinationDir, exported, skipped, failed };
}

export async function exportMaskedTranscripts(params: {
  sessions: readonly SessionSummary[];
}): Promise<ExportSessionsResult | null> {
  const { sessions } = params;
  if (sessions.length === 0) return null;

  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    canSelectFolders: true,
    canSelectFiles: false,
    openLabel: localizeDialogLabel("Choose sanitized export destination", "サニタイズ済みエクスポート先を選択"),
  });
  if (!picked || picked.length === 0) return null;
  const baseDir = picked[0]!.fsPath;

  const stamp = buildDateStamp();
  const destinationDir = path.join(baseDir, `codex-history-sanitized-${stamp}`);
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(destinationDir));

  let exported = 0;
  let skipped = 0;
  let failed = 0;

  const { timeZone } = resolveDateTimeSettings();
  for (const s of sessions) {
    const fileBase = path.parse(s.fsPath).name;
    const outPath = await ensureUniquePath(path.join(destinationDir, `${fileBase}.md`));
    try {
      const rendered = await renderTranscript(s.fsPath, { timeZone });
      const masked = sanitizeText(rendered.content);
      await fs.writeFile(outPath, masked, { encoding: "utf8" });
      exported += 1;
    } catch {
      failed += 1;
    }
  }

  return { destinationDir, exported, skipped, failed };
}

export async function importSessions(params: {
  codexSessionsRoot: string;
  claudeSessionsRoot: string;
  existingSessions?: readonly SessionSummary[];
  duplicateIdMode?: DuplicateSessionIdMode;
}): Promise<ImportSessionsResult | null> {
  const { codexSessionsRoot, claudeSessionsRoot, existingSessions } = params;
  const duplicateIdMode: DuplicateSessionIdMode = params.duplicateIdMode ?? "skip";

  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    canSelectFolders: true,
    canSelectFiles: false,
    openLabel: localizeDialogLabel("Choose import source", "インポート元を選択"),
  });
  if (!picked || picked.length === 0) return null;
  const sourceDir = picked[0]!.fsPath;

  const manifest = await readExportManifest(sourceDir);
  const files = manifest
    ? manifest.files.map((entry) => toImportCandidateFromManifest(sourceDir, entry))
    : await listImportCandidatesFromDirectory(sourceDir);
  if (files.length === 0) {
    return {
      sourceDir,
      imported: 0,
      overwritten: 0,
      skipped: 0,
      skippedExisting: 0,
      skippedDuplicateId: 0,
      failed: 0,
    };
  }

  let imported = 0;
  let overwritten = 0;
  let skipped = 0;
  let skippedExisting = 0;
  let skippedDuplicateId = 0;
  let failed = 0;
  const existingPathBySessionId = buildExistingPathBySessionId(existingSessions ?? []);

  for (const file of files) {
    const src = file.srcPath;
    const srcExists = await exists(src);
    if (!srcExists) {
      failed += 1;
      continue;
    }

    const srcMeta = await tryReadSessionMeta(src);
    const sessionId = normalizeSessionId(srcMeta?.id);
    const existingPathById = sessionId ? existingPathBySessionId.get(sessionId) : undefined;
    const shouldOverwriteById = !!existingPathById && duplicateIdMode === "overwrite";

    if (existingPathById && !shouldOverwriteById) {
      skipped += 1;
      skippedDuplicateId += 1;
      continue;
    }

    const destinationPath = shouldOverwriteById
      ? existingPathById!
      : await resolveImportDestinationPath({
          codexSessionsRoot,
          claudeSessionsRoot,
          sourceHint: file.sourceHint,
          relativeHint: file.relativeHint,
          srcPath: src,
          srcMetaTimestampIso: srcMeta?.timestampIso,
        });
    const srcKey = normalizePathKey(src);
    const dstKey = normalizePathKey(destinationPath);
    if (srcKey === dstKey) {
      skipped += 1;
      skippedExisting += 1;
      if (sessionId && !existingPathBySessionId.has(sessionId)) existingPathBySessionId.set(sessionId, destinationPath);
      continue;
    }

    const destinationExists = await exists(destinationPath);
    if (destinationExists && !shouldOverwriteById) {
      const identical = await areFilesIdentical(src, destinationPath);
      skipped += 1;
      skippedExisting += 1;
      if (sessionId && !existingPathBySessionId.has(sessionId)) existingPathBySessionId.set(sessionId, destinationPath);
      void identical;
      continue;
    }

    if (destinationExists && shouldOverwriteById) {
      const identical = await areFilesIdentical(src, destinationPath);
      if (identical) {
        skipped += 1;
        skippedExisting += 1;
        if (sessionId && !existingPathBySessionId.has(sessionId)) {
          existingPathBySessionId.set(sessionId, destinationPath);
        }
        continue;
      }
    }

    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(destinationPath)));
      await vscode.workspace.fs.copy(vscode.Uri.file(src), vscode.Uri.file(destinationPath), { overwrite: shouldOverwriteById });
      await touchImportedPaths(destinationPath, [codexSessionsRoot, claudeSessionsRoot]);
      if (shouldOverwriteById) overwritten += 1;
      else imported += 1;
      if (sessionId && !existingPathBySessionId.has(sessionId)) {
        existingPathBySessionId.set(sessionId, destinationPath);
      }
    } catch {
      failed += 1;
    }
  }

  if (imported > 0 || overwritten > 0) {
    await touchPathQuiet(codexSessionsRoot);
    await touchPathQuiet(claudeSessionsRoot);
  }
  return { sourceDir, imported, overwritten, skipped, skippedExisting, skippedDuplicateId, failed };
}

function sanitizeText(input: string): string {
  let out = String(input ?? "");

  out = out.replace(/\b(sk-[a-zA-Z0-9]{16,})\b/g, "<TOKEN>");
  out = out.replace(/\b(ghp_[a-zA-Z0-9]{20,})\b/g, "<TOKEN>");
  out = out.replace(/\b(AIza[0-9A-Za-z\-_]{20,})\b/g, "<TOKEN>");
  out = out.replace(/\b(xox[baprs]-[0-9A-Za-z-]{10,})\b/g, "<TOKEN>");
  out = out.replace(/\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, "<EMAIL>");
  out = out.replace(/(\b(?:password|passwd|token|secret|api[_-]?key)\b\s*[:=]\s*)([^\s`"']+)/gi, "$1<REDACTED>");
  out = out.replace(/\b([A-Za-z]:\\(?:[^\\\r\n\t:*?"<>|]+\\)*[^\\\r\n\t:*?"<>|]*)/g, "<PATH>");
  out = out.replace(/(^|[\s(])\/(?:[^\s)]+\/)*[^\s)]+/gm, (m) => {
    const prefix = m.startsWith("/") ? "" : m[0]!;
    const body = prefix ? m.slice(1) : m;
    if (/^\/\//.test(body) || /^\/https?:/i.test(body)) return m;
    return `${prefix}<PATH>`;
  });

  return out;
}

function buildRelativePathForSource(
  source: SessionSource,
  fsPath: string,
  roots: { codexSessionsRoot: string; claudeSessionsRoot: string },
): string {
  const root = source === "claude" ? roots.claudeSessionsRoot : roots.codexSessionsRoot;
  const rel = safeRelativePath(root, fsPath);
  return rel ?? path.basename(fsPath);
}

function safeRelativePath(rootPath: string, fsPath: string): string | null {
  const rel = path.relative(rootPath, fsPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel;
}

async function readExportManifest(sourceDir: string): Promise<ExportManifestV1 | null> {
  const manifestPath = path.join(sourceDir, EXPORT_MANIFEST_JSON);
  try {
    const raw = await fs.readFile(manifestPath, { encoding: "utf8" });
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidExportManifest(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function toImportCandidateFromManifest(sourceDir: string, entry: ExportManifestFileEntryV1): ImportFileCandidate {
  return {
    srcPath: path.join(sourceDir, entry.exportedRelativePath),
    sourceHint: entry.source,
    relativeHint: entry.relativePathFromSourceRoot,
  };
}

async function listImportCandidatesFromDirectory(sourceDir: string): Promise<ImportFileCandidate[]> {
  const files = await listJsonlFiles(sourceDir);
  return files.map((srcPath) => {
    const rel = toForwardSlash(path.relative(sourceDir, srcPath));
    const parsed = parseSourcePrefixFromRelativePath(rel);
    if (parsed) {
      return {
        srcPath,
        sourceHint: parsed.source,
        relativeHint: parsed.relativeWithoutSource,
      };
    }
    return {
      srcPath,
      sourceHint: inferSourceFromFileName(path.basename(srcPath)) ?? undefined,
      relativeHint: rel,
    };
  });
}

async function listJsonlFiles(rootDir: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let ents: Array<import("node:fs").Dirent> = [];
    try {
      ents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of ents) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (ent.isFile() && ent.name.toLowerCase().endsWith(".jsonl")) out.push(full);
    }
  }
  return out;
}

async function resolveImportDestinationPath(params: {
  codexSessionsRoot: string;
  claudeSessionsRoot: string;
  sourceHint?: SessionSource;
  relativeHint?: string;
  srcPath: string;
  srcMetaTimestampIso?: string;
}): Promise<string> {
  const source = params.sourceHint ?? inferSourceFromFileName(path.basename(params.srcPath)) ?? "codex";
  const targetRoot = source === "claude" ? params.claudeSessionsRoot : params.codexSessionsRoot;
  const root = targetRoot && targetRoot.trim().length > 0 ? targetRoot : params.codexSessionsRoot;

  const byHint = tryBuildDestinationBySourceLayout({
    source,
    root,
    relativeHint: params.relativeHint,
    fileName: path.basename(params.srcPath),
  });
  if (byHint) return byHint;

  const byTimestamp = await tryBuildDestPathFromMetaTimestamp(root, params.srcMetaTimestampIso, path.basename(params.srcPath), source);
  if (byTimestamp) return byTimestamp;

  return source === "claude"
    ? path.join(root, "imported", path.basename(params.srcPath))
    : buildTodayCodexFallback(root, path.basename(params.srcPath));
}

function tryBuildDestinationBySourceLayout(params: {
  source: SessionSource;
  root: string;
  relativeHint?: string;
  fileName: string;
}): string | null {
  const relativeHint = params.relativeHint ? toForwardSlash(params.relativeHint) : "";
  if (!relativeHint) return null;

  const parts = relativeHint.split("/").filter((p) => p.length > 0 && p !== "." && p !== "..");
  if (parts.length === 0) return null;
  const fileName = parts[parts.length - 1]!;
  if (!fileName.toLowerCase().endsWith(".jsonl")) return null;

  if (params.source === "codex") {
    const ymdPath = tryBuildCodexPathFromParts(parts);
    if (ymdPath) return path.join(params.root, ...ymdPath);
    return null;
  }

  if (parts.length >= 2) {
    const projectDir = parts[parts.length - 2]!;
    const fileName = parts[parts.length - 1]!;
    return path.join(params.root, projectDir, fileName);
  }
  return path.join(params.root, "imported", params.fileName);
}

function tryBuildCodexPathFromParts(parts: string[]): string[] | null {
  if (parts.length < 4) return null;
  const fileName = parts[parts.length - 1]!;
  for (let i = 0; i <= parts.length - 4; i += 1) {
    const y = parts[i]!;
    const m = parts[i + 1]!;
    const d = parts[i + 2]!;
    if (!/^\d{4}$/.test(y) || !/^\d{2}$/.test(m) || !/^\d{2}$/.test(d)) continue;
    return [y, m, d, fileName];
  }
  return null;
}

async function tryBuildDestPathFromMetaTimestamp(
  rootPath: string,
  timestampIso: string | undefined,
  fileName: string,
  source: SessionSource,
): Promise<string | null> {
  try {
    if (!timestampIso) return null;
    const ms = Date.parse(timestampIso);
    if (!Number.isFinite(ms)) return null;

    if (source === "claude") {
      return path.join(rootPath, "imported", fileName);
    }

    const { timeZone } = resolveDateTimeSettings();
    const ymd = toYmdInTimeZone(new Date(ms), timeZone);
    const yyyy = `${ymd.year}`;
    const mm = `${ymd.month}`.padStart(2, "0");
    const dd = `${ymd.day}`.padStart(2, "0");
    return path.join(rootPath, yyyy, mm, dd, fileName);
  } catch {
    return null;
  }
}

function buildTodayCodexFallback(rootPath: string, fileName: string): string {
  const now = new Date();
  const yyyy = `${now.getFullYear()}`;
  const mm = `${now.getMonth() + 1}`.padStart(2, "0");
  const dd = `${now.getDate()}`.padStart(2, "0");
  return path.join(rootPath, yyyy, mm, dd, fileName);
}

async function ensureUniquePath(candidatePath: string): Promise<string> {
  const parsed = path.parse(candidatePath);
  let out = candidatePath;
  let i = 1;
  while (await exists(out)) {
    out = path.join(parsed.dir, `${parsed.name}-${i}${parsed.ext}`);
    i += 1;
  }
  return out;
}

async function exists(fsPath: string): Promise<boolean> {
  try {
    await fs.stat(fsPath);
    return true;
  } catch {
    return false;
  }
}

function normalizePathKey(fsPath: string): string {
  return path.normalize(fsPath).toLowerCase();
}

function normalizeSessionId(value: unknown): string {
  return String(value ?? "").trim();
}

function buildExistingPathBySessionId(sessions: readonly SessionSummary[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const session of sessions) {
    const id = normalizeSessionId(session.meta?.id);
    if (id && !out.has(id)) out.set(id, session.fsPath);
  }
  return out;
}

async function areFilesIdentical(a: string, b: string): Promise<boolean> {
  try {
    const [sa, sb] = await Promise.all([fs.stat(a), fs.stat(b)]);
    if (sa.size !== sb.size) return false;
    const [ba, bb] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
    return ba.equals(bb);
  } catch {
    return false;
  }
}

async function touchImportedPaths(filePath: string, rootPaths: readonly string[]): Promise<void> {
  const parentDir = path.dirname(filePath);
  await touchPathQuiet(filePath);
  await touchPathQuiet(parentDir);
  for (const rootPath of rootPaths) {
    await touchPathQuiet(rootPath);
  }
}

async function touchPathQuiet(targetPath: string): Promise<void> {
  if (!targetPath || targetPath.trim().length === 0) return;
  try {
    const now = new Date();
    await fs.utimes(targetPath, now, now);
  } catch {
    // Continue import even on environments where touching timestamps is not allowed.
  }
}

function buildDateStamp(): string {
  const d = new Date();
  const yyyy = `${d.getFullYear()}`;
  const mm = `${d.getMonth() + 1}`.padStart(2, "0");
  const dd = `${d.getDate()}`.padStart(2, "0");
  const hh = `${d.getHours()}`.padStart(2, "0");
  const mi = `${d.getMinutes()}`.padStart(2, "0");
  const ss = `${d.getSeconds()}`.padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

function parseSourcePrefixFromRelativePath(relativePath: string): { source: SessionSource; relativeWithoutSource: string } | null {
  const normalized = toForwardSlash(relativePath);
  const parts = normalized.split("/").filter((p) => p.length > 0);
  if (parts.length < 2) return null;
  const first = parts[0]!.toLowerCase();
  if (first !== "codex" && first !== "claude") return null;
  return {
    source: first,
    relativeWithoutSource: parts.slice(1).join("/"),
  };
}

function inferSourceFromFileName(fileName: string): SessionSource | null {
  const lower = fileName.toLowerCase();
  return lower.startsWith("rollout-") ? "codex" : "claude";
}

function toForwardSlash(p: string): string {
  return String(p ?? "").replace(/\\/g, "/");
}

function isValidExportManifest(value: unknown): value is ExportManifestV1 {
  if (!value || typeof value !== "object") return false;
  const obj = value as Partial<ExportManifestV1>;
  if (obj.version !== 1) return false;
  if (!obj.roots || typeof obj.roots !== "object") return false;
  if (typeof obj.roots.codexSessionsRoot !== "string") return false;
  if (typeof obj.roots.claudeSessionsRoot !== "string") return false;
  if (!Array.isArray(obj.files)) return false;
  for (const file of obj.files) {
    if (!file || typeof file !== "object") return false;
    if ((file as any).source !== "codex" && (file as any).source !== "claude") return false;
    if (typeof (file as any).originalPath !== "string") return false;
    if (typeof (file as any).relativePathFromSourceRoot !== "string") return false;
    if (typeof (file as any).exportedRelativePath !== "string") return false;
    const sessionId = (file as any).sessionId;
    if (sessionId !== undefined && typeof sessionId !== "string") return false;
  }
  return true;
}

function localizeDialogLabel(en: string, ja: string): string {
  return resolveUiLanguage() === "ja" ? ja : en;
}
