import * as fs from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";
import type {
  CodexHistoryBaseMetadata,
  SessionSource,
  SessionSummary,
} from "./sessionTypes";
import { normalizeCacheKey } from "../utils/fsUtils";
import { stableTextSha256 } from "../utils/stableTextHash";
import type { PerformanceProbe } from "../performance/performanceCounters";

const MAX_HISTORY_ID_LENGTH = 256;
const MAX_HISTORY_DEPTH = 32;
const MAX_BOUNDARY_RECORD_BYTES = 16 * 1024 * 1024;
const FIRST_RECORD_READ_CHUNK_BYTES = 64 * 1024;
const BOUNDARY_SCAN_CHUNK_BYTES = 64 * 1024;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const CODEX_ROLLOUT_ID_PATTERN =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\.jsonl$)/iu;

export type CodexHistoryPlanIssue =
  | "missingLeaf"
  | "missingParent"
  | "ambiguousParent"
  | "cycle"
  | "depthLimit"
  | "invalidBoundary"
  | "unreadableFile";

export interface CodexLogicalHistorySegment {
  readonly fsPath: string;
  readonly cacheKey: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly endByteOffset?: number;
  readonly isLeaf: boolean;
}

export interface CodexLogicalHistoryPlan {
  readonly leafFsPath: string;
  readonly segments: readonly CodexLogicalHistorySegment[];
  readonly complete: boolean;
  readonly signature: string;
  readonly issue?: CodexHistoryPlanIssue;
}

export interface SessionJsonlRecord {
  readonly value: any;
  readonly lineIndex: number;
  readonly physicalLineIndex: number;
  readonly sourceFsPath: string;
  readonly isLeaf: boolean;
}

export interface SessionJsonlLine {
  readonly line: string;
  readonly lineIndex: number;
  readonly physicalLineIndex: number;
  readonly sourceFsPath: string;
  readonly isLeaf: boolean;
}

export interface SessionJsonlReadOptions {
  readonly sessionInventory?: readonly SessionSummary[];
  readonly plan?: CodexLogicalHistoryPlan;
  readonly token?: { readonly isCancellationRequested: boolean };
  readonly cancellationErrorFactory?: () => Error;
  readonly performanceProbe?: PerformanceProbe;
}

interface HistoryBoundary {
  endOrdinalExclusive: number;
  endByteOffset: number;
}

interface Catalog {
  byPath: ReadonlyMap<string, SessionSummary>;
  byStorageRolloutId: ReadonlyMap<string, readonly SessionSummary[]>;
  byThreadId: ReadonlyMap<string, readonly SessionSummary[]>;
}

const catalogByInventory = new WeakMap<readonly SessionSummary[], Catalog>();

class CodexHistoryResolutionError extends Error {
  constructor(readonly issue: CodexHistoryPlanIssue) {
    super(issue);
    this.name = "CodexHistoryResolutionError";
  }
}

export class SessionJsonlReadCancelledError extends Error {
  constructor() {
    super("Session JSONL reading was cancelled.");
    this.name = "SessionJsonlReadCancelledError";
  }
}

export function extractCodexHistoryBaseMetadata(
  payload: unknown,
  firstOrdinalValue: unknown,
): CodexHistoryBaseMetadata | undefined {
  if (!isRecord(payload) || payload.history_mode !== "paginated" || !isRecord(payload.history_base)) {
    return undefined;
  }
  const sourceRolloutId = normalizeCodexHistoryId(payload.history_base.thread_id);
  const endOrdinalExclusive = normalizeNonNegativeSafeInteger(
    payload.history_base.end_ordinal_exclusive,
  );
  const endByteOffset = normalizeNonNegativeSafeInteger(payload.history_base.end_byte_offset);
  const firstOrdinal = normalizeNonNegativeSafeInteger(firstOrdinalValue);
  if (
    !sourceRolloutId ||
    endOrdinalExclusive === undefined ||
    endByteOffset === undefined ||
    firstOrdinal === undefined ||
    firstOrdinal !== endOrdinalExclusive
  ) {
    return undefined;
  }
  return { sourceRolloutId, endOrdinalExclusive, endByteOffset, firstOrdinal };
}

export function sanitizeCachedCodexHistoryBaseMetadata(value: unknown): {
  valid: boolean;
  value?: CodexHistoryBaseMetadata;
} {
  if (value === undefined) return { valid: true };
  if (!isRecord(value)) return { valid: false };
  const sourceRolloutId = normalizeCodexHistoryId(value.sourceRolloutId);
  const endOrdinalExclusive = normalizeNonNegativeSafeInteger(value.endOrdinalExclusive);
  const endByteOffset = normalizeNonNegativeSafeInteger(value.endByteOffset);
  const firstOrdinal = normalizeNonNegativeSafeInteger(value.firstOrdinal);
  if (
    !sourceRolloutId ||
    endOrdinalExclusive === undefined ||
    endByteOffset === undefined ||
    firstOrdinal === undefined ||
    firstOrdinal !== endOrdinalExclusive
  ) {
    return { valid: false };
  }
  return {
    valid: true,
    value: { sourceRolloutId, endOrdinalExclusive, endByteOffset, firstOrdinal },
  };
}

export function normalizeCodexHistoryId(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase();
  if (
    !normalized ||
    normalized.length > MAX_HISTORY_ID_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    return "";
  }
  return normalized;
}

export function extractCodexRolloutIdFromPath(fsPath: string): string {
  const match = CODEX_ROLLOUT_ID_PATTERN.exec(path.basename(fsPath));
  return normalizeCodexHistoryId(match?.[1]);
}

export async function resolveCodexLogicalHistoryPlan(
  leafFsPath: string,
  sessionInventory: readonly SessionSummary[] | undefined,
): Promise<CodexLogicalHistoryPlan> {
  const catalog = sessionInventory ? getOrBuildCatalog(sessionInventory) : buildCatalog([]);
  const leafKey = normalizeCacheKey(leafFsPath);
  const leaf = catalog.byPath.get(leafKey);
  if (!leaf || leaf.source !== "codex") {
    return fallbackPlan(leafFsPath, leaf ? undefined : "missingLeaf");
  }
  if (!leaf.meta.codexHistoryBase) return uncheckedPhysicalPlan(leafFsPath);

  const segments: CodexLogicalHistorySegment[] = [];
  const stack = new Set<string>();
  try {
    await appendSessionSegments(leaf, undefined, catalog, stack, segments, 0, leafKey);
    return freezePlan(leafFsPath, segments, true);
  } catch (error) {
    const issue = error instanceof CodexHistoryResolutionError ? error.issue : "unreadableFile";
    return fallbackPlan(leafFsPath, issue);
  }
}

export async function* readSessionJsonlRecords(
  fsPath: string,
  source: SessionSource,
  options: SessionJsonlReadOptions = {},
): AsyncGenerator<SessionJsonlRecord> {
  const performanceProbe = options.performanceProbe;
  for await (const record of readSessionJsonlLines(fsPath, source, options)) {
    if (!record.line) continue;
    let value: any;
    try {
      value = JSON.parse(record.line);
      performanceProbe?.add("parseSuccessCount");
    } catch {
      performanceProbe?.add("malformedLineCount");
      continue;
    }
    yield {
      value,
      lineIndex: record.lineIndex,
      physicalLineIndex: record.physicalLineIndex,
      sourceFsPath: record.sourceFsPath,
      isLeaf: record.isLeaf,
    };
  }
}

export async function* readSessionJsonlLines(
  fsPath: string,
  source: SessionSource,
  options: SessionJsonlReadOptions = {},
): AsyncGenerator<SessionJsonlLine> {
  const performanceProbe = options.performanceProbe;
  throwIfCancelled(options.token, options.cancellationErrorFactory);
  const providedPlan = options.plan &&
    normalizeCacheKey(options.plan.leafFsPath) === normalizeCacheKey(fsPath)
      ? options.plan
      : undefined;
  const plan = providedPlan ?? (
    source === "codex" && options.sessionInventory
      ? await resolveCodexLogicalHistoryPlan(fsPath, options.sessionInventory)
      : uncheckedPhysicalPlan(fsPath)
  );
  let lineIndex = 0;
  for (const segment of plan.segments) {
    throwIfCancelled(options.token, options.cancellationErrorFactory);
    performanceProbe?.add("segmentCount");
    // A resolved plan is a point-in-time snapshot; do not consume bytes appended after it was fixed.
    const readEndByteOffset = segment.endByteOffset ?? (
      providedPlan && Number.isSafeInteger(segment.size) && segment.size >= 0
        ? segment.size
        : undefined
    );
    if (readEndByteOffset === 0) continue;
    performanceProbe?.add("streamOpenCount");
    const stream = fs.createReadStream(segment.fsPath, {
      encoding: "utf8",
      ...(readEndByteOffset !== undefined
        ? { start: 0, end: readEndByteOffset - 1 }
        : {}),
    });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let physicalLineIndex = 0;
    try {
      for await (const line of rl) {
        throwIfCancelled(options.token, options.cancellationErrorFactory);
        lineIndex += 1;
        physicalLineIndex += 1;
        if (performanceProbe) {
          performanceProbe.add("physicalLineCount");
          performanceProbe.add("logicalLineCount");
          performanceProbe.add("readByteEstimatedCount", Buffer.byteLength(line, "utf8") + 1);
        }
        yield {
          line,
          lineIndex,
          physicalLineIndex,
          sourceFsPath: segment.fsPath,
          isLeaf: segment.isLeaf,
        };
      }
    } finally {
      rl.close();
      stream.close();
    }
  }
}

export async function collectCodexHistoryDependencies(
  sessions: readonly SessionSummary[],
  sessionInventory: readonly SessionSummary[],
): Promise<SessionSummary[]> {
  const catalog = getOrBuildCatalog(sessionInventory);
  const selectedKeys = new Set(sessions.map((session) => session.cacheKey));
  const dependencies: SessionSummary[] = [];
  const added = new Set<string>();
  for (const session of sessions) {
    if (session.source !== "codex" || !session.meta.codexHistoryBase) continue;
    const plan = await resolveCodexLogicalHistoryPlan(session.fsPath, sessionInventory);
    if (!plan.complete) continue;
    for (const segment of plan.segments) {
      if (segment.isLeaf || selectedKeys.has(segment.cacheKey) || added.has(segment.cacheKey)) continue;
      const dependency = catalog.byPath.get(segment.cacheKey);
      if (!dependency) continue;
      added.add(segment.cacheKey);
      dependencies.push(dependency);
    }
  }
  return dependencies;
}

export function findCodexHistoryDeletionBlockers(
  targets: readonly SessionSummary[],
  sessionInventory: readonly SessionSummary[],
): SessionSummary[] {
  const catalog = getOrBuildCatalog(sessionInventory);
  const targetKeys = new Set(targets.map((session) => session.cacheKey));
  const blockers = new Map<string, SessionSummary>();
  for (const child of sessionInventory) {
    const base = child.source === "codex" ? child.meta.codexHistoryBase : undefined;
    if (!base || targetKeys.has(child.cacheKey)) continue;
    const candidates = resolveCatalogCandidates(catalog, base.sourceRolloutId);
    if (candidates.some((parent) => targetKeys.has(parent.cacheKey))) {
      blockers.set(child.cacheKey, child);
    }
  }
  return Array.from(blockers.values());
}

export interface CodexHistoryDeletionPlan {
  readonly orderedTargets: readonly SessionSummary[];
  readonly dependencyKeysByTarget: ReadonlyMap<string, ReadonlySet<string>>;
  readonly restorePrerequisiteKeysByTarget: ReadonlyMap<string, ReadonlySet<string>>;
}

export function planCodexHistoryDeletionTargets(
  targets: readonly SessionSummary[],
  sessionInventory: readonly SessionSummary[],
): CodexHistoryDeletionPlan | undefined {
  const catalog = getOrBuildCatalog(sessionInventory);
  const targetByKey = new Map<string, SessionSummary>();
  for (const target of targets) {
    if (!targetByKey.has(target.cacheKey)) targetByKey.set(target.cacheKey, target);
  }
  const uniqueTargets = Array.from(targetByKey.values());
  const originalOrder = new Map(
    uniqueTargets.map((session, index) => [session.cacheKey, index] as const),
  );
  const parentKeysByChild = new Map<string, Set<string>>();
  const childKeysByParent = new Map<string, Set<string>>();
  const dependencyCountByParent = new Map<string, number>(
    uniqueTargets.map((session) => [session.cacheKey, 0] as const),
  );

  for (const child of uniqueTargets) {
    const base = child.source === "codex" ? child.meta.codexHistoryBase : undefined;
    if (!base) continue;
    for (const parent of resolveCatalogCandidates(catalog, base.sourceRolloutId)) {
      if (!targetByKey.has(parent.cacheKey)) continue;
      const parentKeys = parentKeysByChild.get(child.cacheKey) ?? new Set<string>();
      if (parentKeys.has(parent.cacheKey)) continue;
      parentKeys.add(parent.cacheKey);
      parentKeysByChild.set(child.cacheKey, parentKeys);
      const childKeys = childKeysByParent.get(parent.cacheKey) ?? new Set<string>();
      childKeys.add(child.cacheKey);
      childKeysByParent.set(parent.cacheKey, childKeys);
      dependencyCountByParent.set(parent.cacheKey, childKeys.size);
    }
  }

  const ready = uniqueTargets
    .filter((session) => dependencyCountByParent.get(session.cacheKey) === 0)
    .sort((left, right) =>
      (originalOrder.get(left.cacheKey) ?? 0) - (originalOrder.get(right.cacheKey) ?? 0),
    );
  const ordered: SessionSummary[] = [];
  for (let index = 0; index < ready.length; index += 1) {
    const child = ready[index]!;
    ordered.push(child);
    for (const parentKey of parentKeysByChild.get(child.cacheKey) ?? []) {
      const nextCount = (dependencyCountByParent.get(parentKey) ?? 0) - 1;
      dependencyCountByParent.set(parentKey, nextCount);
      if (nextCount !== 0) continue;
      const parent = targetByKey.get(parentKey);
      if (parent) ready.push(parent);
    }
  }
  if (ordered.length !== targetByKey.size) return undefined;
  return {
    orderedTargets: Object.freeze(ordered),
    dependencyKeysByTarget: childKeysByParent,
    restorePrerequisiteKeysByTarget: parentKeysByChild,
  };
}

async function appendSessionSegments(
  session: SessionSummary,
  boundary: HistoryBoundary | undefined,
  catalog: Catalog,
  stack: Set<string>,
  output: CodexLogicalHistorySegment[],
  depth: number,
  leafKey: string,
): Promise<void> {
  if (depth > MAX_HISTORY_DEPTH) throw new CodexHistoryResolutionError("depthLimit");
  if (stack.has(session.cacheKey)) throw new CodexHistoryResolutionError("cycle");
  stack.add(session.cacheKey);
  try {
    const fileStat = await statSessionFile(session.fsPath);
    const base = session.meta.codexHistoryBase;
    if (base) {
      await validateDeclaredHistoryBase(session.fsPath, fileStat.size, base);
      const candidates = resolveCatalogCandidates(catalog, base.sourceRolloutId);
      if (candidates.length === 0) throw new CodexHistoryResolutionError("missingParent");
      if (candidates.length !== 1) throw new CodexHistoryResolutionError("ambiguousParent");
      const parent = candidates[0]!;
      if (parent.cacheKey === session.cacheKey) throw new CodexHistoryResolutionError("cycle");
      await appendSessionSegments(
        parent,
        {
          endOrdinalExclusive: base.endOrdinalExclusive,
          endByteOffset: base.endByteOffset,
        },
        catalog,
        stack,
        output,
        depth + 1,
        leafKey,
      );
    }

    if (boundary) await validateBoundary(session, boundary, fileStat.size);
    output.push(Object.freeze({
      fsPath: session.fsPath,
      cacheKey: session.cacheKey,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      ...(boundary ? { endByteOffset: boundary.endByteOffset } : {}),
      isLeaf: session.cacheKey === leafKey,
    }));
  } finally {
    stack.delete(session.cacheKey);
  }
}

async function validateBoundary(
  session: SessionSummary,
  boundary: HistoryBoundary,
  fileSize: number,
): Promise<void> {
  const { endByteOffset, endOrdinalExclusive } = boundary;
  if (endByteOffset > fileSize) throw new CodexHistoryResolutionError("invalidBoundary");
  const physicalStartOrdinal = session.meta.codexHistoryBase?.endOrdinalExclusive ?? 0;
  if (endOrdinalExclusive < physicalStartOrdinal) {
    throw new CodexHistoryResolutionError("invalidBoundary");
  }

  const handle = await open(session.fsPath, "r");
  try {
    const firstRecord = await readFirstJsonRecord(handle, fileSize);
    const declaredStartOrdinal = session.meta.codexHistoryBase?.firstOrdinal ?? 0;
    if (
      !isRecord(firstRecord) ||
      firstRecord.type !== "session_meta" ||
      firstRecord.ordinal !== declaredStartOrdinal
    ) {
      throw new CodexHistoryResolutionError("invalidBoundary");
    }
    if (endByteOffset === 0) {
      if (endOrdinalExclusive !== physicalStartOrdinal) {
        throw new CodexHistoryResolutionError("invalidBoundary");
      }
      return;
    }
    if (endOrdinalExclusive <= physicalStartOrdinal) {
      throw new CodexHistoryResolutionError("invalidBoundary");
    }
    const newline = await readBytesExactly(handle, 1, endByteOffset - 1);
    if (newline[0] !== 0x0a) {
      throw new CodexHistoryResolutionError("invalidBoundary");
    }
    let recordBytes = await readBoundaryRecordBytes(handle, endByteOffset);
    if (recordBytes.at(-1) === 0x0d) recordBytes = recordBytes.subarray(0, recordBytes.length - 1);
    if (recordBytes.length === 0) throw new CodexHistoryResolutionError("invalidBoundary");
    let record: unknown;
    try {
      record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(recordBytes));
    } catch {
      throw new CodexHistoryResolutionError("invalidBoundary");
    }
    if (!isRecord(record) || record.ordinal !== endOrdinalExclusive - 1) {
      throw new CodexHistoryResolutionError("invalidBoundary");
    }
  } finally {
    await handle.close();
  }
}

async function readBoundaryRecordBytes(
  handle: FileHandle,
  endByteOffset: number,
): Promise<Buffer> {
  const recordEnd = endByteOffset - 1;
  const scanStart = Math.max(0, endByteOffset - MAX_BOUNDARY_RECORD_BYTES);
  let scanEnd = recordEnd;
  let recordStart: number | undefined;

  while (scanEnd > scanStart) {
    const chunkStart = Math.max(scanStart, scanEnd - BOUNDARY_SCAN_CHUNK_BYTES);
    const bytes = await readBytesExactly(handle, scanEnd - chunkStart, chunkStart);
    const previousNewline = bytes.lastIndexOf(0x0a);
    if (previousNewline >= 0) {
      recordStart = chunkStart + previousNewline + 1;
      break;
    }
    scanEnd = chunkStart;
  }

  if (recordStart === undefined) {
    if (scanStart !== 0) throw new CodexHistoryResolutionError("invalidBoundary");
    recordStart = 0;
  }
  const recordByteLength = recordEnd - recordStart;
  if (recordByteLength <= 0) throw new CodexHistoryResolutionError("invalidBoundary");
  return readBytesExactly(handle, recordByteLength, recordStart);
}

async function validateDeclaredHistoryBase(
  fsPath: string,
  fileSize: number,
  expected: CodexHistoryBaseMetadata,
): Promise<void> {
  const handle = await open(fsPath, "r");
  try {
    const record = await readFirstJsonRecord(handle, fileSize);
    if (!isRecord(record) || record.type !== "session_meta" || !isRecord(record.payload)) {
      throw new CodexHistoryResolutionError("invalidBoundary");
    }
    const actual = extractCodexHistoryBaseMetadata(record.payload, record.ordinal);
    if (
      !actual ||
      actual.sourceRolloutId !== expected.sourceRolloutId ||
      actual.endOrdinalExclusive !== expected.endOrdinalExclusive ||
      actual.endByteOffset !== expected.endByteOffset ||
      actual.firstOrdinal !== expected.firstOrdinal
    ) {
      throw new CodexHistoryResolutionError("invalidBoundary");
    }
  } finally {
    await handle.close();
  }
}

async function readFirstJsonRecord(handle: FileHandle, fileSize: number): Promise<unknown> {
  if (fileSize <= 0) throw new CodexHistoryResolutionError("invalidBoundary");
  const readLimit = Math.min(fileSize, MAX_BOUNDARY_RECORD_BYTES + 1);
  const chunks: Buffer[] = [];
  let readOffset = 0;
  let recordBytes: Buffer | undefined;
  while (readOffset < readLimit) {
    const byteLength = Math.min(FIRST_RECORD_READ_CHUNK_BYTES, readLimit - readOffset);
    const bytes = await readBytesExactly(handle, byteLength, readOffset);
    const newlineIndex = bytes.indexOf(0x0a);
    if (newlineIndex >= 0) {
      chunks.push(bytes.subarray(0, newlineIndex));
      recordBytes = Buffer.concat(chunks);
      break;
    }
    chunks.push(bytes);
    readOffset += byteLength;
  }
  if (!recordBytes) {
    if (fileSize > MAX_BOUNDARY_RECORD_BYTES) {
      throw new CodexHistoryResolutionError("invalidBoundary");
    }
    recordBytes = Buffer.concat(chunks);
  }
  if (recordBytes.at(-1) === 0x0d) recordBytes = recordBytes.subarray(0, recordBytes.length - 1);
  if (recordBytes.length === 0) throw new CodexHistoryResolutionError("invalidBoundary");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(recordBytes));
  } catch {
    throw new CodexHistoryResolutionError("invalidBoundary");
  }
}

async function readBytesExactly(
  handle: FileHandle,
  byteLength: number,
  position: number,
): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(byteLength);
  let readOffset = 0;
  while (readOffset < byteLength) {
    const result = await handle.read(
      bytes,
      readOffset,
      byteLength - readOffset,
      position + readOffset,
    );
    if (result.bytesRead <= 0) throw new CodexHistoryResolutionError("invalidBoundary");
    readOffset += result.bytesRead;
  }
  return bytes;
}

function buildCatalog(sessionInventory: readonly SessionSummary[]): Catalog {
  const byPath = new Map<string, SessionSummary>();
  const byStorageRolloutId = new Map<string, SessionSummary[]>();
  const byThreadId = new Map<string, SessionSummary[]>();
  for (const session of sessionInventory) {
    if (session.source !== "codex") continue;
    byPath.set(session.cacheKey, session);
    appendCatalogCandidate(
      byStorageRolloutId,
      extractCodexRolloutIdFromPath(session.fsPath),
      session,
    );
    appendCatalogCandidate(byThreadId, normalizeCodexHistoryId(session.meta.id), session);
  }
  return { byPath, byStorageRolloutId, byThreadId };
}

function getOrBuildCatalog(sessionInventory: readonly SessionSummary[]): Catalog {
  const cached = catalogByInventory.get(sessionInventory);
  if (cached) return cached;
  // Inventories are immutable snapshots; WeakMap ownership prevents stale catalogs from outliving them.
  const catalog = buildCatalog(sessionInventory);
  catalogByInventory.set(sessionInventory, catalog);
  return catalog;
}

function resolveCatalogCandidates(
  catalog: Catalog,
  sourceRolloutId: string,
): readonly SessionSummary[] {
  const storageMatches = catalog.byStorageRolloutId.get(sourceRolloutId) ?? [];
  return storageMatches.length > 0
    ? storageMatches
    : catalog.byThreadId.get(sourceRolloutId) ?? [];
}

function appendCatalogCandidate(
  target: Map<string, SessionSummary[]>,
  id: string,
  session: SessionSummary,
): void {
  if (!id) return;
  const bucket = target.get(id);
  if (!bucket) {
    target.set(id, [session]);
  } else if (!bucket.some((candidate) => candidate.cacheKey === session.cacheKey)) {
    bucket.push(session);
  }
}

async function fallbackPlan(
  leafFsPath: string,
  issue: CodexHistoryPlanIssue | undefined,
): Promise<CodexLogicalHistoryPlan> {
  const physical = await physicalPlan(leafFsPath);
  return freezePlan(leafFsPath, physical.segments, false, issue);
}

async function physicalPlan(fsPath: string): Promise<CodexLogicalHistoryPlan> {
  let segment: CodexLogicalHistorySegment;
  try {
    const fileStat = await statSessionFile(fsPath);
    segment = Object.freeze({
      fsPath,
      cacheKey: normalizeCacheKey(fsPath),
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      isLeaf: true,
    });
  } catch {
    throw new CodexHistoryResolutionError("unreadableFile");
  }
  return freezePlan(fsPath, [segment], true);
}

function uncheckedPhysicalPlan(fsPath: string): CodexLogicalHistoryPlan {
  const segment = Object.freeze({
    fsPath,
    cacheKey: normalizeCacheKey(fsPath),
    size: 0,
    mtimeMs: 0,
    isLeaf: true,
  });
  return freezePlan(fsPath, [segment], true);
}

function freezePlan(
  leafFsPath: string,
  segments: readonly CodexLogicalHistorySegment[],
  complete: boolean,
  issue?: CodexHistoryPlanIssue,
): CodexLogicalHistoryPlan {
  const frozenSegments = Object.freeze(Array.from(segments));
  const signature = stableTextSha256(JSON.stringify({
    complete,
    issue: issue ?? null,
    segments: frozenSegments.map((segment) => [
      segment.cacheKey,
      segment.size,
      segment.mtimeMs,
      segment.endByteOffset ?? null,
    ]),
  }));
  return Object.freeze({
    leafFsPath,
    segments: frozenSegments,
    complete,
    signature,
    ...(issue ? { issue } : {}),
  });
}

async function statSessionFile(fsPath: string): Promise<{ size: number; mtimeMs: number }> {
  try {
    const value = await stat(fsPath);
    if (!value.isFile() || !Number.isSafeInteger(value.size) || value.size < 0) {
      throw new Error("Invalid session file stat.");
    }
    return { size: value.size, mtimeMs: value.mtimeMs };
  } catch {
    throw new CodexHistoryResolutionError("unreadableFile");
  }
}

function normalizeNonNegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function throwIfCancelled(
  token: { readonly isCancellationRequested: boolean } | undefined,
  errorFactory: (() => Error) | undefined,
): void {
  if (token?.isCancellationRequested) {
    throw errorFactory?.() ?? new SessionJsonlReadCancelledError();
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
