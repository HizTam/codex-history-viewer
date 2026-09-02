import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import type { SessionRootKind, SessionSource, SessionStorageLocation, SessionSummary } from "../sessions/sessionTypes";
import { parseSessionMetadataBackup } from "./sessionMetadataBackupService";
import { buildSessionSummary, resolveSessionIdentityKey, tryReadSessionMeta } from "../sessions/sessionSummary";
import { toYmdInTimeZone } from "../utils/dateUtils";
import { resolveDateTimeSettings } from "../utils/dateTimeSettings";
import { normalizeCacheKey } from "../utils/fsUtils";
import { renderTranscript } from "../transcript/transcriptRenderer";
import { t } from "../i18n";
import { collectCodexHistoryDependencies } from "../sessions/codexHistoryBase";

export interface ExportSessionsResult {
  destinationDir: string;
  exported: number;
  skipped: number;
  failed: number;
  metadataStatus: "none" | "included" | "failed";
}

export interface ImportSessionsResult {
  sourceDir: string;
  imported: number;
  overwritten: number;
  unchanged: number;
  skipped: number;
  skippedExisting: number;
  skippedDuplicateId: number;
  failed: number;
  metadata: unknown | null;
  metadataStatus: "none" | "available" | "invalid";
  metadataMappings: SessionMetadataImportMapping[];
  selection: ImportSessionsSelection;
}

export interface SessionMetadataImportMapping {
  source: SessionSource;
  sessionId?: string;
  relativePathFromSourceRoot: string;
  destinationPath: string;
  operation: "imported" | "overwritten";
  sourcePath?: string;
}

export type DuplicateSessionIdMode = "skip" | "overwrite";
export type ImportSessionsSelection = "all" | "jsonl" | "metadata";

export interface ImportSessionsPreflight {
  sourceDir: string;
  imported: number;
  overwritten: number;
  unchanged: number;
  skipped: number;
  skippedExisting: number;
  skippedDuplicateId: number;
  failed: number;
  metadata: unknown;
  metadataMappings: SessionMetadataImportMapping[];
  metadataOnlyMappings: SessionMetadataImportMapping[];
  projectedSessions: SessionSummary[];
}

interface ExportManifestBase {
  generatedAtIso: string;
  roots: {
    codexSessionsRoot: string;
    claudeSessionsRoot: string;
  };
  files: ExportManifestFileEntryV1[];
}

interface ExportManifestV1 extends ExportManifestBase {
  version: 1;
}

interface ExportManifestV2 extends ExportManifestBase {
  version: 2;
  metadata: {
    relativePath: string;
    format: "codex-history-viewer.session-metadata";
    version: 1;
  };
}

type ExportManifest = ExportManifestV1 | ExportManifestV2;

interface ExportManifestFileEntryV1 {
  source: SessionSource;
  rootKind?: SessionRootKind;
  originalPath: string;
  relativePathFromSourceRoot: string;
  exportedRelativePath: string;
  sessionId?: string;
}

interface ImportFileCandidate {
  srcPath: string;
  sourceHint?: SessionSource;
  rootKindHint?: SessionRootKind;
  relativeHint?: string;
  manifestLocator?: Omit<SessionMetadataImportMapping, "destinationPath" | "operation" | "sourcePath">;
}

interface PreparedImportOperation {
  file: ImportFileCandidate;
  sourcePath: string;
  sourceSize: number;
  sourceMtimeMs: number;
  destinationPath: string;
  destinationRoot: string;
  operation: SessionMetadataImportMapping["operation"];
}

interface MetadataRootKindHints {
  bySourceAndId: Map<string, SessionRootKind | null>;
  bySourceAndRelativePath: Map<string, SessionRootKind | null>;
}

const EXPORT_MANIFEST_JSON = "manifest.json";
const EXPORT_MANIFEST_TEXT = "manifest.txt";
const EXPORT_METADATA_JSON = "session-metadata.json";
const MAX_EXPORT_METADATA_BYTES = 32 * 1024 * 1024;
const MAX_EXPORT_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_EXPORT_MANIFEST_FILES = 200_000;

export async function exportSessions(params: {
  sessions: readonly SessionSummary[];
  sessionInventory?: readonly SessionSummary[];
  codexSessionsRoot: string;
  claudeSessionsRoot: string;
  createMetadata?: (exportedSessions: readonly SessionSummary[]) => unknown;
}): Promise<ExportSessionsResult | null> {
  const { sessions, codexSessionsRoot, claudeSessionsRoot } = params;
  if (sessions.length === 0) return null;
  const dependencies = params.sessionInventory
    ? await collectCodexHistoryDependencies(sessions, params.sessionInventory)
    : [];
  const sessionsToExport = dedupeSessionsByCacheKey([...sessions, ...dependencies]);

  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    canSelectFolders: true,
    canSelectFiles: false,
    openLabel: t("import.dialog.exportDestination"),
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
  const exportedSessions: SessionSummary[] = [];

  for (const session of sessionsToExport) {
    const relativeFromSource = buildRelativePathForSession(session, {
      codexSessionsRoot,
      claudeSessionsRoot,
    });
    const preferredRelative = path.join(session.source, relativeFromSource);
    const targetPath = await ensureUniquePath(path.join(destinationDir, preferredRelative));

    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(targetPath)));
      await vscode.workspace.fs.copy(vscode.Uri.file(session.fsPath), vscode.Uri.file(targetPath), { overwrite: false });
      exported += 1;
      exportedSessions.push(session);

      const exportedRelativePath = toForwardSlash(path.relative(destinationDir, targetPath));
      manifestFiles.push({
        source: session.source,
        rootKind: session.storage.rootKind,
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

  let metadataWritten = false;
  if (params.createMetadata && exportedSessions.length > 0) {
    try {
      const metadataText = `${JSON.stringify(params.createMetadata(exportedSessions), null, 2)}\n`;
      if (Buffer.byteLength(metadataText, "utf8") > MAX_EXPORT_METADATA_BYTES) throw new Error("Metadata sidecar is too large.");
      await fs.writeFile(path.join(destinationDir, EXPORT_METADATA_JSON), metadataText, { encoding: "utf8" });
      metadataWritten = true;
    } catch {
      metadataWritten = false;
    }
  }

  const manifestBase: ExportManifestBase = {
    generatedAtIso: new Date().toISOString(),
    roots: { codexSessionsRoot, claudeSessionsRoot },
    files: manifestFiles,
  };
  const manifestJson: ExportManifest = metadataWritten
    ? {
        ...manifestBase,
        version: 2,
        metadata: {
          relativePath: EXPORT_METADATA_JSON,
          format: "codex-history-viewer.session-metadata",
          version: 1,
        },
      }
    : { ...manifestBase, version: 1 };

  let manifestJsonWritten = false;
  try {
    const manifestText = JSON.stringify(manifestJson, null, 2);
    if (Buffer.byteLength(manifestText, "utf8") > MAX_EXPORT_MANIFEST_BYTES) {
      throw new Error("Export manifest is too large.");
    }
    await fs.writeFile(path.join(destinationDir, EXPORT_MANIFEST_JSON), manifestText, {
      encoding: "utf8",
    });
    manifestJsonWritten = true;
    await fs.writeFile(path.join(destinationDir, EXPORT_MANIFEST_TEXT), manifestLines.join("\n"), { encoding: "utf8" });
  } catch {
    skipped += 1;
  }

  return {
    destinationDir,
    exported,
    skipped,
    failed,
    metadataStatus: params.createMetadata && exportedSessions.length > 0
      ? metadataWritten && manifestJsonWritten ? "included" : "failed"
      : "none",
  };
}

export async function exportMaskedTranscripts(params: {
  sessions: readonly SessionSummary[];
  sessionInventory?: readonly SessionSummary[];
}): Promise<ExportSessionsResult | null> {
  const { sessions } = params;
  if (sessions.length === 0) return null;

  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    canSelectFolders: true,
    canSelectFiles: false,
    openLabel: t("import.dialog.sanitizedExportDestination"),
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
      const rendered = await renderTranscript(s.fsPath, {
        timeZone,
        locationLabel: s.storage.archiveState === "archived" ? t("session.location.archived") : t("session.location.active"),
        sessionInventory: params.sessionInventory,
      });
      const masked = sanitizeText(rendered.content);
      await fs.writeFile(outPath, masked, { encoding: "utf8" });
      exported += 1;
    } catch {
      failed += 1;
    }
  }

  return { destinationDir, exported, skipped, failed, metadataStatus: "none" };
}

function dedupeSessionsByCacheKey(sessions: readonly SessionSummary[]): SessionSummary[] {
  const result: SessionSummary[] = [];
  const seen = new Set<string>();
  for (const session of sessions) {
    if (seen.has(session.cacheKey)) continue;
    seen.add(session.cacheKey);
    result.push(session);
  }
  return result;
}

export async function importSessions(params: {
  codexSessionsRoot: string;
  codexArchivedSessionsRoot?: string;
  claudeSessionsRoot: string;
  existingSessions?: readonly SessionSummary[];
  duplicateIdMode?: DuplicateSessionIdMode;
  confirm?: (preflight: ImportSessionsPreflight) => Promise<ImportSessionsSelection | null>;
}): Promise<ImportSessionsResult | null> {
  const { codexSessionsRoot, claudeSessionsRoot, existingSessions } = params;
  const codexArchivedSessionsRoot = String(params.codexArchivedSessionsRoot ?? "").trim();
  const duplicateIdMode: DuplicateSessionIdMode = params.duplicateIdMode ?? "skip";

  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    canSelectFolders: true,
    canSelectFiles: false,
    openLabel: t("import.dialog.importSource"),
  });
  if (!picked || picked.length === 0) return null;
  const sourceDir = picked[0]!.fsPath;

  const manifestRead = await readExportManifest(sourceDir);
  const manifest = manifestRead.manifest;
  const metadata = await readExportMetadata(sourceDir, manifest);
  const metadataStatus = resolveImportedMetadataStatus(manifest, manifestRead.version2Declared, metadata);
  const metadataRootKindHints = buildMetadataRootKindHints(metadata);
  const files = manifest
    ? manifest.files
        .map((entry) => toImportCandidateFromManifest(sourceDir, entry, metadataRootKindHints))
        .filter((entry): entry is ImportFileCandidate => entry !== null)
    : await listImportCandidatesFromDirectory(sourceDir);
  if (files.length === 0) {
    return {
      sourceDir,
      imported: 0,
      overwritten: 0,
      unchanged: 0,
      skipped: 0,
      skippedExisting: 0,
      skippedDuplicateId: 0,
      failed: 0,
      metadata,
      metadataStatus,
      metadataMappings: [],
      selection: "jsonl",
    };
  }

  let plannedImported = 0;
  let plannedOverwritten = 0;
  let plannedUnchanged = 0;
  let skipped = 0;
  let skippedExisting = 0;
  let skippedDuplicateId = 0;
  let failed = 0;
  const prepared: PreparedImportOperation[] = [];
  const plannedMetadataMappings: SessionMetadataImportMapping[] = [];
  const existingPathBySessionId = buildExistingPathBySourceAndSessionId(existingSessions ?? []);

  for (const file of files) {
    const src = file.srcPath;
    let sourceStat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      sourceStat = await fs.stat(src);
    } catch {
      failed += 1;
      continue;
    }
    if (!sourceStat.isFile() || !(await isRealPathContained(sourceDir, src))) {
      failed += 1;
      continue;
    }

    const srcMeta = await tryReadSessionMeta(src);
    const sessionId = normalizeSessionId(srcMeta?.id);
    const source = file.sourceHint ?? srcMeta?.historySource ?? inferSourceFromFileName(path.basename(src)) ?? "codex";
    const sourceAndSessionId = sessionId ? `${source}\0${sessionId}` : "";
    const existingPathById = sourceAndSessionId ? existingPathBySessionId.get(sourceAndSessionId) : undefined;
    if (existingPathById === null) {
      skipped += 1;
      skippedDuplicateId += 1;
      continue;
    }
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
          codexArchivedSessionsRoot,
          claudeSessionsRoot,
          sourceHint: file.sourceHint,
          rootKindHint: file.rootKindHint,
          relativeHint: file.relativeHint,
          srcPath: src,
          srcMetaTimestampIso: srcMeta?.timestampIso,
        });
    const srcKey = normalizePathKey(src);
    const dstKey = normalizePathKey(destinationPath);
    const destinationRoot = resolveImportDestinationRoot(destinationPath, {
      codexSessionsRoot,
      codexArchivedSessionsRoot,
      claudeSessionsRoot,
    });
    if (!destinationRoot) {
      failed += 1;
      continue;
    }
    if (srcKey === dstKey) {
      if (shouldOverwriteById) {
        plannedUnchanged += 1;
      } else {
        skipped += 1;
        skippedExisting += 1;
      }
      if (sourceAndSessionId && !existingPathBySessionId.has(sourceAndSessionId)) {
        existingPathBySessionId.set(sourceAndSessionId, destinationPath);
      }
      if (shouldOverwriteById) {
        prepared.push({
          file,
          sourcePath: src,
          sourceSize: sourceStat.size,
          sourceMtimeMs: sourceStat.mtimeMs,
          destinationPath,
          destinationRoot,
          operation: "overwritten",
        });
        appendMetadataImportMapping(plannedMetadataMappings, file, destinationPath, "overwritten", src);
      }
      continue;
    }

    const destinationExists = await exists(destinationPath);
    if (destinationExists && !shouldOverwriteById) {
      skipped += 1;
      skippedExisting += 1;
      if (sourceAndSessionId && !existingPathBySessionId.has(sourceAndSessionId)) {
        existingPathBySessionId.set(sourceAndSessionId, destinationPath);
      }
      continue;
    }

    if (destinationExists && shouldOverwriteById) {
      const identical = await areFilesIdentical(src, destinationPath);
      if (identical) {
        plannedUnchanged += 1;
        if (sourceAndSessionId && !existingPathBySessionId.has(sourceAndSessionId)) {
          existingPathBySessionId.set(sourceAndSessionId, destinationPath);
        }
        prepared.push({
          file,
          sourcePath: src,
          sourceSize: sourceStat.size,
          sourceMtimeMs: sourceStat.mtimeMs,
          destinationPath,
          destinationRoot,
          operation: "overwritten",
        });
        appendMetadataImportMapping(plannedMetadataMappings, file, destinationPath, "overwritten", src);
        continue;
      }
    }

    const operation = shouldOverwriteById ? "overwritten" : "imported";
    prepared.push({
      file,
      sourcePath: src,
      sourceSize: sourceStat.size,
      sourceMtimeMs: sourceStat.mtimeMs,
      destinationPath,
      destinationRoot,
      operation,
    });
    if (operation === "overwritten") plannedOverwritten += 1;
    else plannedImported += 1;
    if (sourceAndSessionId && !existingPathBySessionId.has(sourceAndSessionId)) {
      existingPathBySessionId.set(sourceAndSessionId, destinationPath);
    }
    appendMetadataImportMapping(plannedMetadataMappings, file, destinationPath, operation, src);
  }

  const projectedSessions = await buildProjectedImportSessions(
    prepared,
    existingSessions ?? [],
    { codexSessionsRoot, codexArchivedSessionsRoot, claudeSessionsRoot },
  );
  const existingDestinationKeys = new Set((existingSessions ?? []).map((session) => session.cacheKey));
  const metadataOnlyMappings = stripMappingSourcePaths(
    plannedMetadataMappings.filter((mapping) =>
      mapping.operation === "overwritten" &&
      existingDestinationKeys.has(normalizeCacheKey(mapping.destinationPath))
    ),
  );
  let selection: ImportSessionsSelection = metadataStatus === "available" ? "all" : "jsonl";
  if (metadataStatus === "available" && parseSessionMetadataBackup(metadata) && params.confirm) {
    const confirmed = await params.confirm({
      sourceDir,
      imported: plannedImported,
      overwritten: plannedOverwritten,
      unchanged: plannedUnchanged,
      skipped,
      skippedExisting,
      skippedDuplicateId,
      failed,
      metadata,
      metadataMappings: plannedMetadataMappings,
      metadataOnlyMappings,
      projectedSessions,
    });
    if (!confirmed) return null;
    selection = confirmed;
  }

  if (selection === "metadata") {
    return {
      sourceDir,
      imported: 0,
      overwritten: 0,
      unchanged: 0,
      skipped,
      skippedExisting,
      skippedDuplicateId,
      failed,
      metadata,
      metadataStatus,
      metadataMappings: stripMappingSourcePaths(metadataOnlyMappings),
      selection,
    };
  }

  let imported = 0;
  let overwritten = 0;
  let unchanged = 0;
  const metadataMappings: SessionMetadataImportMapping[] = [];
  for (const operation of prepared) {
    try {
      if (!(await isRealPathContained(sourceDir, operation.sourcePath))) {
        throw new Error("Import source changed after confirmation.");
      }
      const currentSourceStat = await fs.stat(operation.sourcePath);
      if (
        !currentSourceStat.isFile() ||
        currentSourceStat.size !== operation.sourceSize ||
        currentSourceStat.mtimeMs !== operation.sourceMtimeMs
      ) {
        throw new Error("Import source content changed after confirmation.");
      }
      const sourceAndDestinationMatch = normalizePathKey(operation.sourcePath) === normalizePathKey(operation.destinationPath);
      const copyRequired = operation.operation === "imported" || (
        !sourceAndDestinationMatch && !(await areFilesIdentical(operation.sourcePath, operation.destinationPath))
      );
      if (copyRequired) {
        if (!(await isImportDestinationParentSafe(operation.destinationRoot, path.dirname(operation.destinationPath)))) {
          throw new Error("Import destination parent escaped its configured root.");
        }
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(operation.destinationPath)));
        if (!(await isRealPathContainedOrEqual(operation.destinationRoot, path.dirname(operation.destinationPath)))) {
          throw new Error("Import destination escaped its configured root.");
        }
        await vscode.workspace.fs.copy(
          vscode.Uri.file(operation.sourcePath),
          vscode.Uri.file(operation.destinationPath),
          { overwrite: operation.operation === "overwritten" },
        );
        await touchImportedPaths(
          operation.destinationPath,
          [codexSessionsRoot, codexArchivedSessionsRoot, claudeSessionsRoot],
        );
        if (operation.operation === "overwritten") overwritten += 1;
        else imported += 1;
      } else {
        if (!(await isRealPathContainedOrEqual(operation.destinationRoot, operation.destinationPath))) {
          throw new Error("Existing import destination escaped its configured root.");
        }
        unchanged += 1;
      }
      if (selection === "all") {
        appendMetadataImportMapping(
          metadataMappings,
          operation.file,
          operation.destinationPath,
          operation.operation,
        );
      }
    } catch {
      failed += 1;
    }
  }

  if (imported > 0 || overwritten > 0) {
    await touchPathQuiet(codexSessionsRoot);
    await touchPathQuiet(codexArchivedSessionsRoot);
    await touchPathQuiet(claudeSessionsRoot);
  }
  return {
    sourceDir,
    imported,
    overwritten,
    unchanged,
    skipped,
    skippedExisting,
    skippedDuplicateId,
    failed,
    metadata,
    metadataStatus,
    metadataMappings,
    selection,
  };
}

async function readExportMetadata(sourceDir: string, manifest: ExportManifest | null): Promise<unknown | null> {
  if (!manifest || manifest.version !== 2) return null;
  const metadataPath = resolveContainedManifestPath(sourceDir, manifest.metadata.relativePath);
  if (!metadataPath) return null;
  try {
    if (!(await isRealPathContained(sourceDir, metadataPath))) return null;
    const stat = await fs.stat(metadataPath);
    if (!stat.isFile() || stat.size > MAX_EXPORT_METADATA_BYTES) return null;
    const bytes = await fs.readFile(metadataPath);
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return null;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function resolveImportedMetadataStatus(
  manifest: ExportManifest | null,
  version2Declared: boolean,
  metadata: unknown | null,
): ImportSessionsResult["metadataStatus"] {
  if (manifest?.version === 2) return metadata === null ? "invalid" : "available";
  return version2Declared ? "invalid" : "none";
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

function buildRelativePathForSession(
  session: SessionSummary,
  roots: { codexSessionsRoot: string; claudeSessionsRoot: string },
): string {
  const storageRelative = safeRelativePath(session.storage.rootPath, session.fsPath);
  if (storageRelative) return storageRelative;
  const configuredRoot = session.source === "claude" ? roots.claudeSessionsRoot : roots.codexSessionsRoot;
  return safeRelativePath(configuredRoot, session.fsPath) ?? path.basename(session.fsPath);
}

function safeRelativePath(rootPath: string, fsPath: string): string | null {
  const rel = path.relative(rootPath, fsPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel;
}

async function readExportManifest(
  sourceDir: string,
): Promise<{ manifest: ExportManifest | null; version2Declared: boolean }> {
  const manifestPath = path.join(sourceDir, EXPORT_MANIFEST_JSON);
  try {
    if (!(await isRealPathContained(sourceDir, manifestPath))) return { manifest: null, version2Declared: false };
    const stat = await fs.stat(manifestPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_EXPORT_MANIFEST_BYTES) {
      return { manifest: null, version2Declared: false };
    }
    const bytes = await fs.readFile(manifestPath);
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return { manifest: null, version2Declared: false };
    }
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = JSON.parse(raw) as unknown;
    const version2Declared = isRecord(parsed) && parsed.version === 2;
    if (!isValidExportManifest(parsed)) return { manifest: null, version2Declared };
    return { manifest: parsed, version2Declared };
  } catch {
    return { manifest: null, version2Declared: false };
  }
}

function toImportCandidateFromManifest(
  sourceDir: string,
  entry: ExportManifestFileEntryV1,
  metadataRootKindHints: MetadataRootKindHints | null,
): ImportFileCandidate | null {
  const srcPath = resolveContainedManifestPath(sourceDir, entry.exportedRelativePath);
  if (!srcPath) return null;
  const rootKindHint = entry.rootKind ?? resolveMetadataRootKindHint(entry, metadataRootKindHints);
  return {
    srcPath,
    sourceHint: entry.source,
    ...(rootKindHint ? { rootKindHint } : {}),
    relativeHint: entry.relativePathFromSourceRoot,
    manifestLocator: {
      source: entry.source,
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
      relativePathFromSourceRoot: entry.relativePathFromSourceRoot,
    },
  };
}

function appendMetadataImportMapping(
  mappings: SessionMetadataImportMapping[],
  file: ImportFileCandidate,
  destinationPath: string,
  operation: SessionMetadataImportMapping["operation"],
  sourcePath?: string,
): void {
  if (!file.manifestLocator || !path.isAbsolute(destinationPath)) return;
  mappings.push({
    ...file.manifestLocator,
    destinationPath: path.resolve(destinationPath),
    operation,
    ...(sourcePath && path.isAbsolute(sourcePath) ? { sourcePath: path.resolve(sourcePath) } : {}),
  });
}

function stripMappingSourcePaths(
  mappings: readonly SessionMetadataImportMapping[],
): SessionMetadataImportMapping[] {
  return mappings.map(({ sourcePath: _sourcePath, ...mapping }) => mapping);
}

async function buildProjectedImportSessions(
  operations: readonly PreparedImportOperation[],
  existingSessions: readonly SessionSummary[],
  roots: {
    codexSessionsRoot: string;
    codexArchivedSessionsRoot: string;
    claudeSessionsRoot: string;
  },
): Promise<SessionSummary[]> {
  const existingByPath = new Map(existingSessions.map((session) => [session.cacheKey, session]));
  const projectedByPath = new Map<string, SessionSummary>();
  const { timeZone } = resolveDateTimeSettings();
  for (const operation of operations) {
    if (!operation.file.manifestLocator) continue;
    const destinationKey = normalizeCacheKey(operation.destinationPath);
    const existing = existingByPath.get(destinationKey);
    if (existing) {
      projectedByPath.set(destinationKey, existing);
      continue;
    }
    const storage = resolveProjectedStorage(operation, roots);
    let summary: SessionSummary | null = null;
    try {
      summary = await buildSessionSummary({
        sessionsRoot: storage.rootPath,
        sourceRoot: storage.rootPath,
        storage,
        fsPath: operation.sourcePath,
        previewMaxMessages: 3,
        timeZone,
      });
    } catch {
      summary = null;
    }
    if (!summary) continue;
    projectedByPath.set(destinationKey, {
      ...summary,
      fsPath: operation.destinationPath,
      cacheKey: destinationKey,
      identityKey: resolveSessionIdentityKey(summary.source, summary.meta, operation.destinationPath, destinationKey),
      storage,
    });
  }
  return Array.from(projectedByPath.values());
}

function resolveProjectedStorage(
  operation: PreparedImportOperation,
  roots: {
    codexSessionsRoot: string;
    codexArchivedSessionsRoot: string;
    claudeSessionsRoot: string;
  },
): SessionStorageLocation {
  const source = operation.file.sourceHint ?? inferSourceFromFileName(path.basename(operation.sourcePath)) ?? "codex";
  if (source === "claude") {
    return { rootKind: "claudeSessions", archiveState: "active", rootPath: roots.claudeSessionsRoot };
  }
  const archived = operation.file.rootKindHint === "codexArchivedSessions" && roots.codexArchivedSessionsRoot.length > 0;
  return archived
    ? { rootKind: "codexArchivedSessions", archiveState: "archived", rootPath: roots.codexArchivedSessionsRoot }
    : { rootKind: "codexSessions", archiveState: "active", rootPath: roots.codexSessionsRoot };
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
  codexArchivedSessionsRoot: string;
  claudeSessionsRoot: string;
  sourceHint?: SessionSource;
  rootKindHint?: SessionRootKind;
  relativeHint?: string;
  srcPath: string;
  srcMetaTimestampIso?: string;
}): Promise<string> {
  const source = params.sourceHint ?? inferSourceFromFileName(path.basename(params.srcPath)) ?? "codex";
  const useArchivedRoot =
    source === "codex" &&
    params.rootKindHint === "codexArchivedSessions" &&
    params.codexArchivedSessionsRoot.length > 0;
  const targetRoot = source === "claude"
    ? params.claudeSessionsRoot
    : useArchivedRoot
      ? params.codexArchivedSessionsRoot
      : params.codexSessionsRoot;
  const root = targetRoot && targetRoot.trim().length > 0 ? targetRoot : params.codexSessionsRoot;

  const byHint = tryBuildDestinationBySourceLayout({
    source,
    rootKind: useArchivedRoot ? "codexArchivedSessions" : source === "claude" ? "claudeSessions" : "codexSessions",
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
  rootKind: SessionRootKind;
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
    if (params.rootKind === "codexArchivedSessions") return path.join(params.root, ...parts);
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

function resolveImportDestinationRoot(
  destinationPath: string,
  roots: {
    codexSessionsRoot: string;
    codexArchivedSessionsRoot: string;
    claudeSessionsRoot: string;
  },
): string | null {
  const destination = path.resolve(destinationPath);
  const candidates = [roots.codexSessionsRoot, roots.codexArchivedSessionsRoot, roots.claudeSessionsRoot]
    .map((rootPath) => String(rootPath ?? "").trim())
    .filter((rootPath) => rootPath.length > 0 && path.isAbsolute(rootPath))
    .map((rootPath) => path.resolve(rootPath))
    .filter((rootPath) => isPathContainedOrEqual(rootPath, destination))
    .sort((left, right) => right.length - left.length);
  return candidates[0] ?? null;
}

function isPathContainedOrEqual(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function isRealPathContainedOrEqual(rootPath: string, candidatePath: string): Promise<boolean> {
  try {
    const [realRoot, realCandidate] = await Promise.all([fs.realpath(rootPath), fs.realpath(candidatePath)]);
    return isPathContainedOrEqual(realRoot, realCandidate);
  } catch {
    return false;
  }
}

async function isImportDestinationParentSafe(rootPath: string, parentPath: string): Promise<boolean> {
  if (!isPathContainedOrEqual(rootPath, parentPath)) return false;
  const [existingRoot, existingParent] = await Promise.all([
    findNearestExistingDirectory(rootPath),
    findNearestExistingDirectory(parentPath),
  ]);
  if (!existingRoot || !existingParent) return false;
  if (normalizePathKey(existingRoot) === normalizePathKey(existingParent)) return true;
  try {
    const [realRoot, realParent] = await Promise.all([fs.realpath(existingRoot), fs.realpath(existingParent)]);
    return isPathContainedOrEqual(realRoot, realParent);
  } catch {
    return false;
  }
}

async function findNearestExistingDirectory(candidatePath: string): Promise<string | null> {
  let current = path.resolve(candidatePath);
  while (true) {
    try {
      const stat = await fs.stat(current);
      if (stat.isDirectory()) return current;
      return null;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

function normalizeSessionId(value: unknown): string {
  return String(value ?? "").trim();
}

function buildExistingPathBySourceAndSessionId(sessions: readonly SessionSummary[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const session of sessions) {
    const id = normalizeSessionId(session.meta?.id);
    const key = id ? `${session.source}\0${id}` : "";
    if (!key) continue;
    const existing = out.get(key);
    if (existing === undefined) out.set(key, session.fsPath);
    else if (existing !== null && normalizePathKey(existing) !== normalizePathKey(session.fsPath)) out.set(key, null);
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

function isValidExportManifest(value: unknown): value is ExportManifest {
  if (!isRecord(value)) return false;
  const obj = value as Partial<ExportManifest>;
  if (obj.version !== 1 && obj.version !== 2) return false;
  if (!isBoundedText(obj.generatedAtIso, 128) || !Number.isFinite(Date.parse(obj.generatedAtIso))) return false;
  if (!isRecord(obj.roots)) return false;
  if (!isBoundedText(obj.roots.codexSessionsRoot, 4096, true)) return false;
  if (!isBoundedText(obj.roots.claudeSessionsRoot, 4096, true)) return false;
  if (!Array.isArray(obj.files) || obj.files.length > MAX_EXPORT_MANIFEST_FILES) return false;
  for (const file of obj.files) {
    if (!isRecord(file)) return false;
    if (file.source !== "codex" && file.source !== "claude") return false;
    if (file.rootKind !== undefined && !isCompatibleRootKind(file.source, file.rootKind)) return false;
    if (!isBoundedText(file.originalPath, 4096)) return false;
    if (!isPortableManifestRelativePath(file.relativePathFromSourceRoot)) return false;
    if (!isPortableManifestRelativePath(file.exportedRelativePath) || !file.exportedRelativePath.toLowerCase().endsWith(".jsonl")) {
      return false;
    }
    if (file.sessionId !== undefined && !isBoundedText(file.sessionId, 512)) return false;
  }
  if (obj.version === 2) {
    const metadata = (obj as Partial<ExportManifestV2>).metadata;
    if (!metadata || typeof metadata !== "object") return false;
    if (metadata.relativePath !== EXPORT_METADATA_JSON) return false;
    if (metadata.format !== "codex-history-viewer.session-metadata" || metadata.version !== 1) return false;
  }
  return true;
}

function buildMetadataRootKindHints(value: unknown): MetadataRootKindHints | null {
  const backup = parseSessionMetadataBackup(value);
  if (!backup) return null;
  const hints: MetadataRootKindHints = {
    bySourceAndId: new Map(),
    bySourceAndRelativePath: new Map(),
  };
  for (const entry of backup.sessions) {
    const { locator } = entry;
    if (!isCompatibleRootKind(locator.source, locator.rootKind)) continue;
    if (locator.sessionId) {
      appendRootKindHint(hints.bySourceAndId, `${locator.source}\0${locator.sessionId}`, locator.rootKind);
    }
    if (locator.relativePath) {
      appendRootKindHint(
        hints.bySourceAndRelativePath,
        `${locator.source}\0${locator.relativePath}`,
        locator.rootKind,
      );
    }
  }
  return hints;
}

function resolveMetadataRootKindHint(
  entry: ExportManifestFileEntryV1,
  hints: MetadataRootKindHints | null,
): SessionRootKind | undefined {
  if (!hints) return undefined;
  const byId = entry.sessionId
    ? hints.bySourceAndId.get(`${entry.source}\0${entry.sessionId}`)
    : undefined;
  const byRelative = hints.bySourceAndRelativePath.get(
    `${entry.source}\0${entry.relativePathFromSourceRoot}`,
  );
  if (byId === null || byRelative === null) return undefined;
  if (byId && byRelative && byId !== byRelative) return undefined;
  return byId ?? byRelative ?? undefined;
}

function appendRootKindHint(
  hints: Map<string, SessionRootKind | null>,
  key: string,
  rootKind: SessionRootKind,
): void {
  if (!hints.has(key)) {
    hints.set(key, rootKind);
    return;
  }
  if (hints.get(key) !== rootKind) hints.set(key, null);
}

function isCompatibleRootKind(source: SessionSource, rootKind: unknown): rootKind is SessionRootKind {
  if (source === "claude") return rootKind === "claudeSessions";
  return rootKind === "codexSessions" || rootKind === "codexArchivedSessions";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isBoundedText(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === "string" &&
    value.length <= maximum &&
    (allowEmpty || value.length > 0) &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function isPortableManifestRelativePath(value: unknown): value is string {
  if (!isBoundedText(value, 4096)) return false;
  const raw = value.replace(/\\/gu, "/");
  if (raw.startsWith("/") || /^[a-z]:/iu.test(raw)) return false;
  const segments = raw.split("/");
  return segments.every((segment) =>
    !!segment &&
    segment !== "." &&
    segment !== ".." &&
    !/[<>:"|?*]/u.test(segment) &&
    !/[. ]$/u.test(segment)
  );
}

function resolveContainedManifestPath(rootPath: string, relativePath: string): string | null {
  const raw = typeof relativePath === "string" ? relativePath.trim().replace(/\\/g, "/") : "";
  if (!raw || raw.includes("\0") || raw.startsWith("/") || /^[a-z]:/iu.test(raw)) return null;
  const segments = raw.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  const resolvedRoot = path.resolve(rootPath);
  const resolved = path.resolve(resolvedRoot, ...segments);
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return null;
  return resolved;
}

async function isRealPathContained(rootPath: string, candidatePath: string): Promise<boolean> {
  try {
    const [realRoot, realCandidate] = await Promise.all([fs.realpath(rootPath), fs.realpath(candidatePath)]);
    const relative = path.relative(realRoot, realCandidate);
    return relative.length > 0 && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
  } catch {
    return false;
  }
}
