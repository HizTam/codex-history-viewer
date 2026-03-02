import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import type { SessionSummary } from "../sessions/sessionTypes";
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

export async function exportSessions(params: {
  sessions: readonly SessionSummary[];
  sessionsRoot: string;
}): Promise<ExportSessionsResult | null> {
  const { sessions, sessionsRoot } = params;
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
  for (const s of sessions) {
    const relative = safeRelativeExportPath(sessionsRoot, s.fsPath);
    const targetPath = await ensureUniquePath(path.join(destinationDir, relative));
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(targetPath)));
      await vscode.workspace.fs.copy(vscode.Uri.file(s.fsPath), vscode.Uri.file(targetPath), { overwrite: false });
      exported += 1;
      manifestLines.push(`${s.fsPath} -> ${targetPath}`);
    } catch {
      failed += 1;
    }
  }

  const manifestPath = path.join(destinationDir, "manifest.txt");
  try {
    await fs.writeFile(manifestPath, manifestLines.join("\n"), { encoding: "utf8" });
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
  sessionsRoot: string;
  existingSessions?: readonly SessionSummary[];
  duplicateIdMode?: DuplicateSessionIdMode;
}): Promise<ImportSessionsResult | null> {
  const { sessionsRoot, existingSessions } = params;
  const duplicateIdMode: DuplicateSessionIdMode = params.duplicateIdMode ?? "skip";
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    canSelectFolders: true,
    canSelectFiles: false,
    openLabel: localizeDialogLabel("Choose import source", "インポート元を選択"),
  });
  if (!picked || picked.length === 0) return null;
  const sourceDir = picked[0]!.fsPath;

  const files = await listJsonlFiles(sourceDir);
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

  for (const src of files) {
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
      : await resolveImportDestinationPath(sessionsRoot, sourceDir, src);
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
      // Do not overwrite when a file with the same name already exists. Keep `identical` for future detailed logging.
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
      await touchImportedPaths(destinationPath, sessionsRoot);
      if (shouldOverwriteById) overwritten += 1;
      else imported += 1;
      if (sessionId && !existingPathBySessionId.has(sessionId)) {
        existingPathBySessionId.set(sessionId, destinationPath);
      }
    } catch {
      failed += 1;
    }
  }

  if (imported > 0 || overwritten > 0) await touchPathQuiet(sessionsRoot);
  return { sourceDir, imported, overwritten, skipped, skippedExisting, skippedDuplicateId, failed };
}

function sanitizeText(input: string): string {
  let out = String(input ?? "");

  // Mask explicit credential patterns.
  out = out.replace(/\b(sk-[a-zA-Z0-9]{16,})\b/g, "<TOKEN>");
  out = out.replace(/\b(ghp_[a-zA-Z0-9]{20,})\b/g, "<TOKEN>");
  out = out.replace(/\b(AIza[0-9A-Za-z\-_]{20,})\b/g, "<TOKEN>");
  out = out.replace(/\b(xox[baprs]-[0-9A-Za-z-]{10,})\b/g, "<TOKEN>");
  out = out.replace(/\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, "<EMAIL>");

  // Mask common key/value secrets.
  out = out.replace(/(\b(?:password|passwd|token|secret|api[_-]?key)\b\s*[:=]\s*)([^\s`"']+)/gi, "$1<REDACTED>");

  // Mask Windows absolute paths.
  out = out.replace(/\b([A-Za-z]:\\(?:[^\\\r\n\t:*?"<>|]+\\)*[^\\\r\n\t:*?"<>|]*)/g, "<PATH>");

  // Mask Unix-like absolute paths while preserving URLs.
  out = out.replace(/(^|[\s(])\/(?:[^\s)]+\/)*[^\s)]+/gm, (m) => {
    const prefix = m.startsWith("/") ? "" : m[0]!;
    const body = prefix ? m.slice(1) : m;
    if (/^\/\//.test(body) || /^\/https?:/i.test(body)) return m;
    return `${prefix}<PATH>`;
  });

  return out;
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

function safeRelativeExportPath(sessionsRoot: string, fsPath: string): string {
  const rel = path.relative(sessionsRoot, fsPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return path.basename(fsPath);
  return rel;
}

async function resolveImportDestinationPath(sessionsRoot: string, importRoot: string, srcPath: string): Promise<string> {
  const rel = path.relative(importRoot, srcPath);
  const byTree = tryBuildDestPathFromTree(sessionsRoot, rel);
  if (byTree) return byTree;

  const byTimestamp = await tryBuildDestPathFromMetaTimestamp(sessionsRoot, srcPath);
  if (byTimestamp) return byTimestamp;

  const now = new Date();
  const yyyy = `${now.getFullYear()}`;
  const mm = `${now.getMonth() + 1}`.padStart(2, "0");
  const dd = `${now.getDate()}`.padStart(2, "0");
  return path.join(sessionsRoot, yyyy, mm, dd, path.basename(srcPath));
}

function tryBuildDestPathFromTree(sessionsRoot: string, relativePath: string): string | null {
  const parts = relativePath.split(/[\\/]+/).filter((p) => p.length > 0);
  if (parts.length < 4) return null;
  const fileName = parts[parts.length - 1]!;
  if (!fileName.toLowerCase().endsWith(".jsonl")) return null;
  // Even when the export parent folder is selected, restore by detecting YYYY/MM/DD in the path.
  for (let i = 0; i <= parts.length - 4; i += 1) {
    const y = parts[i]!;
    const m = parts[i + 1]!;
    const d = parts[i + 2]!;
    if (!/^\d{4}$/.test(y) || !/^\d{2}$/.test(m) || !/^\d{2}$/.test(d)) continue;
    return path.join(sessionsRoot, y, m, d, fileName);
  }
  return null;
}

async function tryBuildDestPathFromMetaTimestamp(sessionsRoot: string, srcPath: string): Promise<string | null> {
  try {
    const meta = await tryReadSessionMeta(srcPath);
    if (!meta?.timestampIso) return null;
    const ms = Date.parse(meta.timestampIso);
    if (!Number.isFinite(ms)) return null;

    const { timeZone } = resolveDateTimeSettings();
    const ymd = toYmdInTimeZone(new Date(ms), timeZone);
    const yyyy = `${ymd.year}`;
    const mm = `${ymd.month}`.padStart(2, "0");
    const dd = `${ymd.day}`.padStart(2, "0");
    return path.join(sessionsRoot, yyyy, mm, dd, path.basename(srcPath));
  } catch {
    return null;
  }
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
  const s = String(value ?? "").trim();
  return s;
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

async function touchImportedPaths(filePath: string, sessionsRoot: string): Promise<void> {
  const parentDir = path.dirname(filePath);
  await touchPathQuiet(filePath);
  await touchPathQuiet(parentDir);
  await touchPathQuiet(sessionsRoot);
}

async function touchPathQuiet(targetPath: string): Promise<void> {
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

function localizeDialogLabel(en: string, ja: string): string {
  // Switch dialog button labels based on the extension UI language setting.
  return resolveUiLanguage() === "ja" ? ja : en;
}
