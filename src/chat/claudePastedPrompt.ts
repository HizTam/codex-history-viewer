import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TextDecoder } from "node:util";

const MAX_HISTORY_BYTES = 8 * 1024 * 1024;
const MAX_HISTORY_ENTRIES = 500;
const MAX_HISTORY_LINE_CHARS = 2 * 1024 * 1024;
const MAX_HISTORY_DISPLAY_CHARS = 1_000_000;
const MAX_HISTORY_RECORDS = 128;
const MAX_SESSION_TEXT_CHARS = 20 * 1024 * 1024;
const MAX_PASTE_CONTENT_BYTES = 10_000_000;
const MAX_HYDRATED_PASTE_BYTES_PER_ENTRY = 10_000_000;
const MAX_RECOVERED_PASTE_CHARS = 10 * 1024 * 1024;
const MAX_MATCH_DELTA_MS = 5 * 60 * 1000;
const MAX_CONTROL_PRESERVE_DELTA_MS = 5 * 1000;
const MAX_MATCH_CANDIDATES = 8;
const MAX_MATCH_STEPS = 2_048;
const MAX_UNKNOWN_BOUNDARY_CANDIDATES = 64;
const MAX_HISTORY_CACHE_FILES = 8;
const MAX_SESSION_ID_CHARS = 256;
const MAX_PROJECT_CHARS = 4_096;
const MAX_IMAGE_PASTE_IDS = 128;
const MAX_PLACEHOLDER_ID = 0x7fff_ffff;

const CONTENT_HASH_RE = /^[0-9a-f]{16}$/u;
const SESSION_ID_RE = /^[A-Za-z0-9._:-]+$/u;
const CLAUDE_PLACEHOLDER_RE =
  /\[(Pasted text|Image|Audio|\.\.\.Truncated text) #([1-9]\d{0,9})(?: \+(\d+) lines)?(\.{0,3})\]/gu;

export type ClaudePastedPromptEntryType = "text" | "image";

export interface ClaudePastedPromptEntry {
  id: number;
  type: ClaudePastedPromptEntryType;
  placeholder: string;
  label: string;
  content?: string;
  unavailable?: true;
}

export interface ClaudePastedPromptResolution {
  display: string;
  entries: ClaudePastedPromptEntry[];
  imagePasteIds: number[];
  preserveSessionText?: true;
}

export interface ClaudePastedPromptResolver {
  resolve(obj: unknown, content: unknown): Promise<ClaudePastedPromptResolution | undefined>;
}

interface StoredPasteRecord {
  id: number;
  type: ClaudePastedPromptEntryType;
  content?: string;
  contentHash?: string;
}

interface StoredHistoryEntry {
  key: string;
  display: string;
  pastedContents: Map<number, StoredPasteRecord>;
  timestamp: number;
  project: string;
  sessionId: string;
}

interface ParsedPlaceholder {
  id: number;
  type: "text" | "image" | "audio";
  placeholder: string;
  label: string;
  start: number;
  end: number;
}

interface HistoryCacheEntry {
  fingerprint: string;
  entries: Promise<readonly StoredHistoryEntry[]>;
}

interface PreservationMatchInput {
  historyEntries: readonly StoredHistoryEntry[];
  usedEntries: ReadonlySet<string>;
  sessionText: string;
  imagePasteIds: number[];
  recordSessionId?: string;
  fallbackSessionId?: string;
  timestamp?: number;
  project?: string;
  hydrateEntry: (entry: StoredHistoryEntry) => Promise<StoredHistoryEntry>;
}

type MatchToken =
  | { kind: "known"; value: string }
  | { kind: "unknown"; id: number };

const historyCache = new Map<string, HistoryCacheEntry>();

export async function createClaudePastedPromptResolver(
  sessionFsPath: string,
): Promise<ClaudePastedPromptResolver | undefined> {
  const location = resolveClaudePromptStorageLocation(sessionFsPath);
  if (!location) return undefined;

  const historyEntries = await readHistoryEntries(location.historyPath);
  const fallbackSessionId = readSessionIdFromFilename(sessionFsPath);
  const usedEntries = new Set<string>();

  return {
    async resolve(obj: unknown, content: unknown): Promise<ClaudePastedPromptResolution | undefined> {
      if (!isHumanUserPromptRecord(obj)) return undefined;
      const sessionText = readClaudeMessageText(content);
      if (sessionText === undefined || sessionText.length > MAX_SESSION_TEXT_CHARS) return undefined;

      const record = asRecord(obj);
      const recordSessionId = readSessionId(record?.sessionId);
      const sessionId = recordSessionId ?? fallbackSessionId;
      const imagePasteIds = readClaudeImagePasteIds(obj);
      const timestamp = readTimestampMs(record?.timestamp);
      const project = readBoundedString(record?.cwd, MAX_PROJECT_CHARS);
      const hydratedEntries = new Map<string, Promise<StoredHistoryEntry>>();
      const hydrateEntry = (entry: StoredHistoryEntry): Promise<StoredHistoryEntry> => {
        const existing = hydratedEntries.get(entry.key);
        if (existing) return existing;
        const pending = hydratePasteRecords(entry, location.configRoot);
        hydratedEntries.set(entry.key, pending);
        return pending;
      };
      const hasPreservationMatch = (): Promise<boolean> =>
        hasUniqueVerifiedPreservationMatch({
          historyEntries,
          usedEntries,
          sessionText,
          imagePasteIds,
          recordSessionId,
          fallbackSessionId,
          timestamp,
          project,
          hydrateEntry,
        });
      if (recordSessionId && fallbackSessionId && recordSessionId !== fallbackSessionId) {
        return buildFallbackResolution(sessionText, imagePasteIds, await hasPreservationMatch());
      }
      if (sessionId) {
        if (timestamp !== undefined && project) {
          const candidates = historyEntries
            .filter(
              (entry) =>
                entry.sessionId === sessionId &&
                !usedEntries.has(entry.key) &&
                Math.abs(entry.timestamp - timestamp) <= MAX_MATCH_DELTA_MS &&
                projectsMatch(entry.project, project),
            )
            .sort(
              (a, b) =>
                Math.abs(a.timestamp - timestamp) - Math.abs(b.timestamp - timestamp) ||
                a.timestamp - b.timestamp,
            );
          if (candidates.length > MAX_MATCH_CANDIDATES) {
            return buildFallbackResolution(sessionText, imagePasteIds, true);
          }
          const hasStrongMetadataCandidate = candidates.some(
            (entry) => Math.abs(entry.timestamp - timestamp) <= MAX_CONTROL_PRESERVE_DELTA_MS,
          );

          let selected:
            | { entry: StoredHistoryEntry; resolution: ClaudePastedPromptResolution; delta: number }
            | undefined;
          for (const candidate of candidates) {
            const hydrated = await hydrateEntry(candidate);
            const resolution = matchHistoryEntry(hydrated, sessionText, imagePasteIds);
            if (!resolution) continue;
            const delta = Math.abs(candidate.timestamp - timestamp);
            if (selected && selected.delta === delta) {
              selected = undefined;
              break;
            }
            if (!selected) selected = { entry: candidate, resolution, delta };
          }
          if (selected) {
            usedEntries.add(selected.entry.key);
            return selected.resolution;
          }
          if (hasStrongMetadataCandidate) {
            return buildFallbackResolution(sessionText, imagePasteIds, true);
          }
        }
      }

      return buildFallbackResolution(sessionText, imagePasteIds, await hasPreservationMatch());
    },
  };
}

export function readClaudeImagePasteIds(obj: unknown): number[] {
  const record = asRecord(obj);
  const message = asRecord(record?.message);
  const recordImagePasteIds = record?.imagePasteIds;
  const messageImagePasteIds = message?.imagePasteIds;
  const raw = Array.isArray(recordImagePasteIds)
    ? recordImagePasteIds
    : Array.isArray(messageImagePasteIds)
      ? messageImagePasteIds
      : [];
  if (raw.length === 0 || raw.length > MAX_IMAGE_PASTE_IDS) return [];

  const result: number[] = [];
  const seen = new Set<number>();
  for (const value of raw) {
    if (!isPlaceholderId(value) || seen.has(value)) return [];
    seen.add(value);
    result.push(value);
  }
  return result;
}

function resolveClaudePromptStorageLocation(
  sessionFsPath: string,
): { configRoot: string; historyPath: string } | null {
  const resolved = path.resolve(sessionFsPath);
  const projectDirectory = path.dirname(resolved);
  const projectsRoot = path.dirname(projectDirectory);
  if (path.basename(projectsRoot).toLowerCase() !== "projects") return null;

  const relativeParts = path.relative(projectsRoot, resolved).split(path.sep).filter(Boolean);
  if (relativeParts.length !== 2 || path.extname(relativeParts[1] ?? "").toLowerCase() !== ".jsonl") return null;

  const configRoot = path.dirname(projectsRoot);
  return {
    configRoot,
    historyPath: path.join(configRoot, "history.jsonl"),
  };
}

async function readHistoryEntries(historyPath: string): Promise<readonly StoredHistoryEntry[]> {
  let stat: Stats;
  try {
    stat = await fs.lstat(historyPath);
  } catch {
    return [];
  }
  if (!isAllowedHistoryFile(stat)) return [];

  const fingerprint = `${stat.mtimeMs}:${stat.size}`;
  const cached = historyCache.get(historyPath);
  if (cached?.fingerprint === fingerprint) {
    historyCache.delete(historyPath);
    historyCache.set(historyPath, cached);
    return cached.entries;
  }

  const entries = loadHistoryTail(historyPath, stat);
  historyCache.set(historyPath, { fingerprint, entries });
  while (historyCache.size > MAX_HISTORY_CACHE_FILES) {
    const oldest = historyCache.keys().next().value;
    if (typeof oldest !== "string") break;
    historyCache.delete(oldest);
  }
  return entries;
}

async function loadHistoryTail(historyPath: string, before: Stats): Promise<readonly StoredHistoryEntry[]> {
  const byteLength = Math.min(before.size, MAX_HISTORY_BYTES);
  if (byteLength <= 0) return [];

  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(historyPath, "r");
    const opened = await handle.stat();
    if (!isAllowedHistoryFile(opened) || !sameFileIdentity(before, opened)) return [];
    const buffer = Buffer.alloc(byteLength);
    const start = Math.max(0, opened.size - byteLength);
    const { bytesRead } = await handle.read(buffer, 0, byteLength, start);
    const after = await fs.lstat(historyPath);
    if (!isAllowedHistoryFile(after) || !sameFileIdentity(opened, after)) return [];
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      if (firstNewline < 0) return [];
      text = text.slice(firstNewline + 1);
    }

    const lines = text.split(/\r?\n/u).filter(Boolean).slice(-MAX_HISTORY_ENTRIES);
    const entries: StoredHistoryEntry[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (!line || line.length > MAX_HISTORY_LINE_CHARS) continue;
      const parsed = parseHistoryLine(line, index);
      if (parsed) entries.push(parsed);
    }
    return entries.sort((a, b) => a.timestamp - b.timestamp);
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isAllowedHistoryFile(stat: Stats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && Number.isFinite(stat.size) && stat.size >= 0;
}

function parseHistoryLine(line: string, index: number): StoredHistoryEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.replace(/^\uFEFF/u, ""));
  } catch {
    return null;
  }

  const record = asRecord(parsed);
  if (!record) return null;
  const display = readBoundedString(record.display, MAX_HISTORY_DISPLAY_CHARS, true);
  const timestamp = readFiniteNonNegativeNumber(record.timestamp);
  const sessionId = readSessionId(record.sessionId);
  const project = readBoundedString(record.project, MAX_PROJECT_CHARS);
  const pastedContents = asRecord(record.pastedContents);
  if (display === undefined || timestamp === undefined || !sessionId || !project || !pastedContents) return null;

  const rawEntries = Object.entries(pastedContents);
  if (rawEntries.length > MAX_HISTORY_RECORDS) return null;
  const records = new Map<number, StoredPasteRecord>();
  for (const [key, value] of rawEntries) {
    const id = parsePasteRecordId(key);
    const paste = asRecord(value);
    if (id === undefined || !paste || paste.id !== id || (paste.type !== "text" && paste.type !== "image")) return null;

    const content = readPasteContent(paste.content);
    const contentHash = typeof paste.contentHash === "string" && CONTENT_HASH_RE.test(paste.contentHash)
      ? paste.contentHash
      : undefined;
    if (paste.content !== undefined && content === undefined) return null;
    if (paste.contentHash !== undefined && contentHash === undefined) return null;
    if (paste.type === "text" && content === undefined && contentHash === undefined) return null;
    if (paste.type === "text" && content !== undefined && contentHash && hashPasteContent(content) !== contentHash) {
      return null;
    }
    records.set(id, {
      id,
      type: paste.type,
      ...(content !== undefined ? { content } : {}),
      ...(contentHash ? { contentHash } : {}),
    });
  }

  const placeholders = parsePlaceholders(display);
  if (!placeholders || placeholders.length === 0) return null;
  const referencedIds = new Set(placeholders.map((placeholder) => placeholder.id));
  if ([...records.keys()].some((id) => !referencedIds.has(id))) return null;
  let hasTextRecord = false;
  for (const placeholder of placeholders) {
    const paste = records.get(placeholder.id);
    if (placeholder.type === "audio") return null;
    if (placeholder.type === "image") {
      if (paste && paste.type !== "image") return null;
      continue;
    }
    if (!paste || paste.type !== "text") return null;
    hasTextRecord = true;
  }
  // Claude Code currently persists only text paste records in prompt history.
  // Image-only prompts are resolved from imagePasteIds in the session JSONL.
  if (!hasTextRecord) return null;

  return {
    key: `${timestamp}:${index}`,
    display,
    pastedContents: records,
    timestamp,
    project,
    sessionId,
  };
}

async function hydratePasteRecords(entry: StoredHistoryEntry, configRoot: string): Promise<StoredHistoryEntry> {
  const hydrated = new Map<number, StoredPasteRecord>();
  let remainingBytes = MAX_HYDRATED_PASTE_BYTES_PER_ENTRY;
  for (const [id, record] of entry.pastedContents) {
    if (record.type !== "text" || record.content !== undefined || !record.contentHash) {
      hydrated.set(id, record);
      continue;
    }
    const content = remainingBytes > 0
      ? await readPasteCacheContent(configRoot, record.contentHash, remainingBytes)
      : undefined;
    if (content !== undefined) remainingBytes -= Buffer.byteLength(content, "utf8");
    hydrated.set(id, content === undefined ? record : { ...record, content });
  }
  return { ...entry, pastedContents: hydrated };
}

async function hasUniqueVerifiedPreservationMatch(input: PreservationMatchInput): Promise<boolean> {
  const candidates = input.historyEntries.filter(
    (entry) => !input.usedEntries.has(entry.key) && hasPreservationMetadataAnchor(entry, input),
  );
  if (candidates.length === 0 || candidates.length > MAX_MATCH_CANDIDATES) return false;

  let matchingCandidates = 0;
  for (const candidate of candidates) {
    const hydrated = await input.hydrateEntry(candidate);
    if (!hasCompleteKnownTextPasteContent(hydrated)) return false;
    if (!matchHistoryEntry(hydrated, input.sessionText, input.imagePasteIds)) continue;
    matchingCandidates += 1;
    if (matchingCandidates > 1) return false;
  }
  return matchingCandidates === 1;
}

function hasPreservationMetadataAnchor(entry: StoredHistoryEntry, input: PreservationMatchInput): boolean {
  const sessionMatches =
    entry.sessionId === input.recordSessionId ||
    entry.sessionId === input.fallbackSessionId;
  if (!sessionMatches) return false;

  const projectMatches = input.project !== undefined && projectsMatch(entry.project, input.project);
  const timestampMatches =
    input.timestamp !== undefined &&
    Math.abs(entry.timestamp - input.timestamp) <= MAX_MATCH_DELTA_MS;
  return projectMatches || timestampMatches;
}

function hasCompleteKnownTextPasteContent(entry: StoredHistoryEntry): boolean {
  let hasTextRecord = false;
  for (const record of entry.pastedContents.values()) {
    if (record.type !== "text") continue;
    hasTextRecord = true;
    if (record.content === undefined) return false;
  }
  return hasTextRecord;
}

async function readPasteCacheContent(
  configRoot: string,
  contentHash: string,
  remainingBytes: number,
): Promise<string | undefined> {
  if (!CONTENT_HASH_RE.test(contentHash)) return undefined;
  const cacheRoot = path.join(configRoot, "paste-cache");
  const candidate = path.join(cacheRoot, `${contentHash}.txt`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const cacheRootStat = await fs.lstat(cacheRoot);
    if (!cacheRootStat.isDirectory() || cacheRootStat.isSymbolicLink()) return undefined;
    const before = await fs.lstat(candidate);
    if (!isAllowedPasteCacheFile(before) || before.size > remainingBytes) return undefined;
    const [realCacheRoot, realCandidate] = await Promise.all([fs.realpath(cacheRoot), fs.realpath(candidate)]);
    if (!isStrictPathDescendant(realCacheRoot, realCandidate)) return undefined;
    handle = await fs.open(candidate, "r");
    const opened = await handle.stat();
    if (
      !isAllowedPasteCacheFile(opened) ||
      opened.size !== before.size ||
      opened.size > remainingBytes ||
      !sameFileIdentity(before, opened)
    ) {
      return undefined;
    }
    const bytes = await handle.readFile();
    if (bytes.length !== opened.size || bytes.length > MAX_PASTE_CONTENT_BYTES) return undefined;
    const after = await fs.lstat(candidate);
    if (!isAllowedPasteCacheFile(after) || after.size !== opened.size || !sameFileIdentity(opened, after)) return undefined;
    const actualHash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    if (actualHash !== contentHash) return undefined;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isAllowedPasteCacheFile(stat: Stats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= MAX_PASTE_CONTENT_BYTES;
}

function sameFileIdentity(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function hashPasteContent(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex").slice(0, 16);
}

function matchHistoryEntry(
  entry: StoredHistoryEntry,
  sessionText: string,
  imagePasteIds: number[],
): ClaudePastedPromptResolution | null {
  const placeholders = parsePlaceholders(entry.display);
  if (!placeholders || placeholders.length === 0) return null;

  const tokens: MatchToken[] = [];
  let cursor = 0;
  for (const placeholder of placeholders) {
    appendKnownToken(tokens, entry.display.slice(cursor, placeholder.start));
    const record = entry.pastedContents.get(placeholder.id);
    if (placeholder.type === "audio") return null;
    if (placeholder.type === "image") appendKnownToken(tokens, placeholder.placeholder);
    else if (!record || record.type !== "text") return null;
    else if (record.content !== undefined) appendKnownToken(tokens, record.content);
    else tokens.push({ kind: "unknown", id: placeholder.id });
    cursor = placeholder.end;
  }
  appendKnownToken(tokens, entry.display.slice(cursor));

  const captures = matchTokens(tokens, sessionText);
  if (!captures) return null;

  const entries: ClaudePastedPromptEntry[] = [];
  for (const placeholder of placeholders) {
    if (placeholder.type !== "text" && placeholder.type !== "image") return null;
    const record = entry.pastedContents.get(placeholder.id);
    const content = placeholder.type === "text" ? record?.content ?? captures.get(placeholder.id) : undefined;
    entries.push({
      id: placeholder.id,
      type: placeholder.type,
      placeholder: placeholder.placeholder,
      label: placeholder.label,
      ...(placeholder.type === "text" && content !== undefined ? { content } : {}),
      ...(placeholder.type === "text" && content === undefined ? { unavailable: true as const } : {}),
    });
  }

  const placeholderImageIds = placeholders
    .filter((placeholder) => placeholder.type === "image")
    .map((placeholder) => placeholder.id);
  if (imagePasteIds.length > 0 && !numberArraysEqual(imagePasteIds, placeholderImageIds)) return null;
  const resolvedImageIds = imagePasteIds.length > 0 ? imagePasteIds : placeholderImageIds;
  return {
    display: entry.display,
    entries,
    imagePasteIds: resolvedImageIds,
  };
}

function matchTokens(tokens: readonly MatchToken[], text: string): Map<number, string> | null {
  if (tokens.every((token) => token.kind === "known")) {
    return tokens.map((token) => token.kind === "known" ? token.value : "").join("") === text ? new Map() : null;
  }

  let steps = 0;
  const solutions: Array<Map<number, string>> = [];
  const visit = (tokenIndex: number, textIndex: number, captures: Map<number, string>): void => {
    if (solutions.length > 1 || steps >= MAX_MATCH_STEPS) return;
    steps += 1;
    if (tokenIndex >= tokens.length) {
      if (textIndex === text.length && !solutions.some((solution) => capturesEqual(solution, captures))) {
        solutions.push(new Map(captures));
      }
      return;
    }

    const token = tokens[tokenIndex]!;
    if (token.kind === "known") {
      if (text.startsWith(token.value, textIndex)) visit(tokenIndex + 1, textIndex + token.value.length, captures);
      return;
    }

    const existing = captures.get(token.id);
    if (existing !== undefined) {
      if (text.startsWith(existing, textIndex)) visit(tokenIndex + 1, textIndex + existing.length, captures);
      return;
    }

    const next = tokens[tokenIndex + 1];
    if (!next) {
      const value = text.slice(textIndex);
      if (value.length <= MAX_RECOVERED_PASTE_CHARS) {
        captures.set(token.id, value);
        visit(tokenIndex + 1, text.length, captures);
        captures.delete(token.id);
      }
      return;
    }
    if (next.kind === "unknown" || next.value.length === 0) return;

    let searchIndex = textIndex;
    let candidateCount = 0;
    while (candidateCount < MAX_UNKNOWN_BOUNDARY_CANDIDATES) {
      const boundary = text.indexOf(next.value, searchIndex);
      if (boundary < 0) break;
      const value = text.slice(textIndex, boundary);
      if (value.length <= MAX_RECOVERED_PASTE_CHARS) {
        captures.set(token.id, value);
        visit(tokenIndex + 1, boundary, captures);
        captures.delete(token.id);
      }
      candidateCount += 1;
      searchIndex = boundary + 1;
    }
  };

  visit(0, 0, new Map());
  return solutions.length === 1 ? solutions[0]! : null;
}

function appendKnownToken(tokens: MatchToken[], value: string): void {
  if (!value) return;
  const previous = tokens[tokens.length - 1];
  if (previous?.kind === "known") previous.value += value;
  else tokens.push({ kind: "known", value });
}

function capturesEqual(a: ReadonlyMap<number, string>, b: ReadonlyMap<number, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, value] of a) {
    if (b.get(id) !== value) return false;
  }
  return true;
}

function buildImageOnlyResolution(
  sessionText: string,
  imagePasteIds: number[],
): ClaudePastedPromptResolution | undefined {
  if (imagePasteIds.length === 0) return undefined;
  const allowedIds = new Set(imagePasteIds);
  const placeholders = parsePlaceholders(sessionText)?.filter(
    (placeholder) => placeholder.type === "image" && allowedIds.has(placeholder.id),
  ) ?? [];
  if (!numberArraysEqual(imagePasteIds, placeholders.map((placeholder) => placeholder.id))) return undefined;
  return {
    display: sessionText,
    entries: placeholders.map((placeholder) => ({
      id: placeholder.id,
      type: "image" as const,
      placeholder: placeholder.placeholder,
      label: placeholder.label,
    })),
    imagePasteIds,
  };
}

function buildFallbackResolution(
  sessionText: string,
  imagePasteIds: number[],
  preserveSessionText: boolean,
): ClaudePastedPromptResolution | undefined {
  if (preserveSessionText) {
    return {
      display: sessionText,
      entries: [],
      imagePasteIds: [],
      preserveSessionText: true,
    };
  }
  return buildImageOnlyResolution(sessionText, imagePasteIds);
}

function numberArraysEqual(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function parsePlaceholders(text: string): ParsedPlaceholder[] | null {
  const placeholders: ParsedPlaceholder[] = [];
  CLAUDE_PLACEHOLDER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CLAUDE_PLACEHOLDER_RE.exec(text))) {
    const rawKind = match[1] ?? "";
    const id = Number(match[2]);
    const rawLineCount = match[3];
    const suffix = match[4] ?? "";
    const truncated = rawKind === "...Truncated text";
    if (!isPlaceholderId(id) || (truncated ? suffix !== "..." : suffix !== "")) return null;
    if (rawLineCount !== undefined) {
      const lineCount = Number(rawLineCount);
      if (!Number.isSafeInteger(lineCount) || lineCount < 0) return null;
    }
    if (rawKind === "Pasted text" && rawLineCount !== undefined && Number(rawLineCount) === 0) return null;
    if ((rawKind === "Image" || rawKind === "Audio") && rawLineCount !== undefined) return null;
    if (truncated && rawLineCount === undefined) return null;

    const type = rawKind === "Image" ? "image" : rawKind === "Audio" ? "audio" : "text";
    const baseLabel = truncated ? "Truncated text" : rawKind;
    const lineLabel = rawLineCount === undefined ? "" : ` +${rawLineCount} lines`;
    placeholders.push({
      id,
      type,
      placeholder: match[0],
      label: `${baseLabel} #${id}${lineLabel}`,
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return placeholders;
}

function isHumanUserPromptRecord(value: unknown): boolean {
  const record = asRecord(value);
  if (!record || record.isMeta === true || record.stackedExpansion === true) return false;
  if (record.type !== "user" && asRecord(record.message)?.role !== "user") return false;
  const origin = asRecord(record.origin);
  if (typeof origin?.kind === "string" && origin.kind !== "human") return false;

  const content = asRecord(record.message)?.content ?? record.content;
  if (Array.isArray(content) && content.some((item) => asRecord(item)?.type === "tool_result")) return false;
  return true;
}

function readClaudeMessageText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  const items = Array.isArray(content) ? content : content && typeof content === "object" ? [content] : [];
  const texts: string[] = [];
  for (const item of items) {
    const record = asRecord(item);
    if (!record || (record.type !== "text" && record.type !== "input_text" && record.type !== "output_text")) continue;
    if (typeof record.text === "string") texts.push(record.text);
  }
  return texts.join("");
}

function readSessionIdFromFilename(sessionFsPath: string): string | undefined {
  return readSessionId(path.basename(sessionFsPath, path.extname(sessionFsPath)));
}

function readSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_SESSION_ID_CHARS || !SESSION_ID_RE.test(normalized)) return undefined;
  return normalized;
}

function readTimestampMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function projectsMatch(a: string, b: string): boolean {
  const normalizedA = normalizeProjectPath(a);
  const normalizedB = normalizeProjectPath(b);
  return normalizedA !== undefined && normalizedB !== undefined && normalizedA === normalizedB;
}

function isStrictPathDescendant(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return !!relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function normalizeProjectPath(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_PROJECT_CHARS) return undefined;
  const normalized = path.resolve(trimmed);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function parsePasteRecordId(value: string): number | undefined {
  if (!/^[1-9]\d{0,9}$/u.test(value)) return undefined;
  const parsed = Number(value);
  return isPlaceholderId(parsed) ? parsed : undefined;
}

function isPlaceholderId(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= MAX_PLACEHOLDER_ID;
}

function readPasteContent(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return Buffer.byteLength(value, "utf8") <= MAX_PASTE_CONTENT_BYTES ? value : undefined;
}

function readBoundedString(value: unknown, maxChars: number, allowEmpty = false): string | undefined {
  if (typeof value !== "string" || value.length > maxChars || (!allowEmpty && value.trim().length === 0)) return undefined;
  return value;
}

function readFiniteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
