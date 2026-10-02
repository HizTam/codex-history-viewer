import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";
import { createSessionReadStream } from "../utils/sessionFileReader";
import { hasClaudeAgentPathShape, isSafeClaudeFile, parseClaudeAgentPath, type ClaudeAgentPath } from "../agents/claudeAgentMetadata";
import { normalizeCacheKey } from "../utils/fsUtils";
import type { SessionJsonlReadOptions } from "./codexHistoryBase";

const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_SCAN_RECORDS = 250_000;
const MAX_CONTEXT_CHARS = 64_000;
const MAX_CHAIN_DEPTH = 250_000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,256}$/u;

export interface ClaudeAgentHistoryProjection {
  ownLines: ReadonlySet<number>;
  context: string;
  partial: boolean;
  contextTruncated: boolean;
}

interface RecordEntry {
  line: number;
  value: Record<string, any>;
}

// Keep only a few bounded projections; transcript bodies never enter this cache.
const cache = new Map<string, { stamp: string; projection: ClaudeAgentHistoryProjection }>();

function resolveRoot(fsPath: string, options: SessionJsonlReadOptions): string | undefined {
  const indexed = options.claudeSessionsRoot === undefined
    ? options.sessionInventory?.find(session => session.source === "claude" && normalizeCacheKey(session.fsPath) === normalizeCacheKey(fsPath))
    : undefined;
  return options.claudeSessionsRoot ?? indexed?.storage.rootPath;
}

export async function getClaudeAgentDependencyStamp(fsPath: string, claudeSessionsRoot?: string): Promise<string | undefined> {
  const location = parseClaudeAgentPath(fsPath, claudeSessionsRoot);
  if (!location) return hasClaudeAgentPathShape(fsPath, claudeSessionsRoot) ? "claude-parent:unavailable" : undefined;
  const parent = path.join(location.rootPath, location.project, `${location.ownerSessionId}.jsonl`);
  if (!await isSafeClaudeFile(parent, location.rootPath)) return "claude-parent:unavailable";
  try {
    const stat = await fs.stat(parent);
    return `claude-parent:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "claude-parent:unavailable";
  }
}

export async function resolveClaudeAgentHistory(
  fsPath: string,
  options: SessionJsonlReadOptions = {},
): Promise<ClaudeAgentHistoryProjection | undefined> {
  const incomplete = (): ClaudeAgentHistoryProjection => ({ ownLines: new Set(), context: "", partial: true, contextTruncated: false });
  checkCancelled(options);
  const root = resolveRoot(fsPath, options);
  const location = parseClaudeAgentPath(fsPath, root);
  // Never treat an ambiguous child path as an unfiltered primary transcript.
  if (!location) return hasClaudeAgentPathShape(fsPath, root) ? incomplete() : undefined;
  if (!await isSafeClaudeFile(fsPath, location.rootPath)) return incomplete();
  checkCancelled(options);
  const stat = await fs.stat(fsPath);
  const stamp = `${stat.size}:${stat.mtimeMs}`;
  const cacheKey = JSON.stringify([fsPath, location.rootPath]);
  const cached = cache.get(cacheKey);
  if (cached?.stamp === stamp) return cached.projection;
  const scan = await scanRecords(fsPath, options);
  let partial = scan.partial;
  let context = "";
  let contextTruncated = false;
  const appendContext = (value: Record<string, any>): void => {
    if (context.length >= MAX_CONTEXT_CHARS) { contextTruncated = true; return; }
    const body = JSON.stringify(value.message ?? value);
    const text = `${value.type ?? "context"}: ${body}\n`;
    const remaining = MAX_CONTEXT_CHARS - context.length;
    context += text.slice(0, remaining);
    if (text.length > remaining) contextTruncated = true;
  };
  const byUuid = new Map<string, RecordEntry>();
  const duplicateUuids = new Set<string>();
  const own: RecordEntry[] = [];
  const references: RecordEntry[] = [];
  for (const entry of scan.records) {
    const value = entry.value;
    if (typeof value.uuid === "string" && SAFE_ID.test(value.uuid)) {
      const previous = byUuid.get(value.uuid)?.value;
      // Claude may persist successive content updates under the same UUID.
      if (previous && (previous.parentUuid !== value.parentUuid || previous.agentId !== value.agentId || previous.sessionId !== value.sessionId || previous.isSidechain !== value.isSidechain)) {
        duplicateUuids.add(value.uuid); partial = true;
      }
      byUuid.set(value.uuid, entry);
    }
    if (value.type === "fork-context-ref") { references.push(entry); continue; }
    if (isOwnedRecord(value, location)) own.push(entry);
    else if (value.type === "user" || value.type === "assistant") {
      appendContext(value);
      if (value.isSidechain !== false && !(typeof value.agentId === "string" && value.agentId !== location.agentId)) partial = true;
    }
  }
  const parentIds = new Set(own.map(entry => entry.value.parentUuid));
  const leafCandidate = own.slice().reverse().find(entry => !parentIds.has(entry.value.uuid) && !(entry.value.type === "system" && entry.value.subtype === "compact_boundary"));
  const leaf = leafCandidate ? byUuid.get(leafCandidate.value.uuid) : undefined;
  const ownLines = new Set<number>();
  const visited = new Set<string>();
  let current = leaf;
  while (current) {
    checkCancelled(options);
    const value = current.value;
    if (visited.has(value.uuid) || duplicateUuids.has(value.uuid) || visited.size >= MAX_CHAIN_DEPTH) { partial = true; break; }
    visited.add(value.uuid);
    if (isOwnedRecord(value, location)) ownLines.add(current.line);
    else if (value.agentId === location.agentId && value.isSidechain !== false) partial = true;
    const parent = value.parentUuid;
    if (parent == null) break;
    if (typeof parent !== "string" || !SAFE_ID.test(parent)) { partial = true; break; }
    current = byUuid.get(parent);
    // A persisted fork reference may provide the missing prefix boundary.
    if (!current && !references.some(entry => entry.value.parentLastUuid === parent)) partial = true;
  }
  if (!leaf) partial = true;
  partial = recoverParallelRecords(byUuid, duplicateUuids, ownLines, location, options) || partial;
  if (references.length) {
    if (references.length !== 1) partial = true;
    const ref = references.at(-1)!.value;
    if (ref.agentId !== location.agentId || ref.parentSessionId !== location.ownerSessionId || typeof ref.parentLastUuid !== "string" || !SAFE_ID.test(ref.parentLastUuid)) {
      partial = true;
    } else {
      const parentPath = path.join(location.rootPath, location.project, `${location.ownerSessionId}.jsonl`);
      if (!await isSafeClaudeFile(parentPath, location.rootPath)) partial = true;
      else {
        const prefix = await scanRecords(parentPath, options).catch(() => {
          checkCancelled(options);
          return { records: [] as RecordEntry[], partial: true };
        });
        partial ||= prefix.partial;
        const parents = new Map<string, RecordEntry>();
        for (const entry of prefix.records) {
          if (typeof entry.value.uuid !== "string") continue;
          if (parents.has(entry.value.uuid)) partial = true;
          parents.set(entry.value.uuid, entry);
        }
        const chain: RecordEntry[] = [];
        const seen = new Set<string>();
        let entry = parents.get(ref.parentLastUuid);
        if (!entry) partial = true;
        while (entry) {
          const value = entry.value;
          if (seen.has(value.uuid) || seen.size >= MAX_CHAIN_DEPTH || (value.sessionId && value.sessionId !== location.ownerSessionId)) { partial = true; break; }
          seen.add(value.uuid);
          if (!value.isSidechain && (value.type === "user" || value.type === "assistant")) chain.push(entry);
          if (value.parentUuid == null) break;
          entry = parents.get(value.parentUuid);
          if (!entry) partial = true;
        }
        for (const entry of chain.reverse()) appendContext(entry.value);
      }
    }
  }
  const projection = { ownLines, context, partial, contextTruncated };
  // Reference resolution depends on another file; always revalidate it on the next read.
  if (!references.length) {
    cache.delete(cacheKey);
    cache.set(cacheKey, { stamp, projection });
    while (cache.size > 4) cache.delete(cache.keys().next().value!);
  }
  if (partial) options.performanceProbe?.setOutcome("partial");
  return projection;
}

function isOwnedRecord(value: Record<string, any>, location: ClaudeAgentPath): boolean {
  return value.agentId === location.agentId && value.isSidechain === true &&
    (value.sessionId === undefined || value.sessionId === location.ownerSessionId) &&
    typeof value.uuid === "string" && SAFE_ID.test(value.uuid);
}

// A turn can contain parallel assistant blocks and results outside the leaf's parent chain.
// Recover only explicit relations in the same ownership scope, retaining physical line order.
function recoverParallelRecords(
  byUuid: ReadonlyMap<string, RecordEntry>,
  duplicateUuids: ReadonlySet<string>,
  ownLines: Set<number>,
  location: ClaudeAgentPath,
  options: SessionJsonlReadOptions,
): boolean {
  const assistants = new Map<string, RecordEntry>();
  const groups = new Map<string, RecordEntry[]>();
  const toolOwners = new Map<string, RecordEntry | null>();
  const results: RecordEntry[] = [];
  const toolIds = new Map<string, ReadonlySet<string>>();
  let partial = false;
  for (const entry of byUuid.values()) {
    checkCancelled(options);
    const value = entry.value;
    if (duplicateUuids.has(value.uuid) || !isOwnedRecord(value, location)) continue;
    if (value.type === "assistant") {
      assistants.set(value.uuid, entry);
      const messageId = value.message?.id;
      if (typeof messageId === "string" && SAFE_ID.test(messageId)) {
        const group = groups.get(messageId) ?? [];
        group.push(entry);
        groups.set(messageId, group);
      }
      const ids = readToolIds(value, "tool_use", "id");
      toolIds.set(value.uuid, ids);
      for (const id of ids) {
        const previous = toolOwners.get(id);
        // Split blocks of one message share authority; different messages do not.
        const sameMessage = previous && typeof messageId === "string" && SAFE_ID.test(messageId) &&
          previous.value.message?.id === messageId;
        toolOwners.set(id, previous === undefined || sameMessage ? entry : null);
      }
    } else if (value.type === "user" && readToolIds(value, "tool_result", "tool_use_id").size) results.push(entry);
  }
  const selectedGroups = new Set<string>();
  for (const entry of assistants.values()) {
    if (ownLines.has(entry.line) && typeof entry.value.message?.id === "string") selectedGroups.add(entry.value.message.id);
  }
  for (const groupId of selectedGroups) {
    checkCancelled(options);
    for (const entry of groups.get(groupId) ?? []) ownLines.add(entry.line);
  }
  const selectedToolIds = new Set<string>();
  for (const entry of assistants.values()) {
    if (ownLines.has(entry.line)) for (const id of toolIds.get(entry.value.uuid) ?? []) selectedToolIds.add(id);
  }
  for (const entry of results) {
    checkCancelled(options);
    if (ownLines.has(entry.line)) continue;
    const ids = readToolIds(entry.value, "tool_result", "tool_use_id");
    const explicit = [entry.value.parentUuid, entry.value.sourceToolAssistantUUID]
      .filter((uuid): uuid is string => typeof uuid === "string")
      .map(uuid => assistants.get(uuid)).filter((value): value is RecordEntry => value !== undefined);
    const related = [...ids].map(id => {
      const linked = explicit.find(assistant => toolIds.get(assistant.value.uuid)?.has(id));
      return linked ?? toolOwners.get(id);
    });
    // A mixed result must not import an unselected or ambiguous branch along with a selected one.
    if (related.every(assistant => assistant && ownLines.has(assistant.line))) ownLines.add(entry.line);
    else if (related.some(assistant => assistant && ownLines.has(assistant.line)) ||
        (related.some(assistant => !assistant) && [...ids].some(id => selectedToolIds.has(id)))) partial = true;
  }
  return partial;
}

function readToolIds(value: Record<string, any>, type: string, key: string): ReadonlySet<string> {
  const content = value.message?.content;
  if (!Array.isArray(content)) return new Set();
  return new Set(content.filter(block => block && typeof block === "object" && block.type === type &&
    typeof block[key] === "string" && SAFE_ID.test(block[key])).map(block => block[key] as string));
}

async function scanRecords(fsPath: string, options: SessionJsonlReadOptions): Promise<{ records: RecordEntry[]; partial: boolean }> {
  const records: RecordEntry[] = [];
  let partial = (await fs.stat(fsPath)).size > MAX_SCAN_BYTES;
  const stream = createSessionReadStream(fsPath, { token: options.token, cancellationErrorFactory: options.cancellationErrorFactory, endByteOffset: MAX_SCAN_BYTES });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineIndex = 0;
  try {
    for await (const line of rl) {
      checkCancelled(options);
      lineIndex += 1;
      if (lineIndex > MAX_SCAN_RECORDS) { partial = true; break; }
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== "object" || Array.isArray(value)) { partial = true; continue; }
        records.push({ line: lineIndex, value: value as Record<string, any> });
      } catch {
        partial = true;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { records, partial };
}

function checkCancelled(options: SessionJsonlReadOptions): void {
  if (options.token?.isCancellationRequested) throw options.cancellationErrorFactory?.() ?? new Error("Cancelled");
}
