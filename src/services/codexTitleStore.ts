import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { readJson, writeJson } from "../storage/jsonStorage";
import { normalizeWhitespace } from "../utils/textUtils";
import { normalizeCacheKey } from "../utils/fsUtils";

interface CodexTitleCacheEntry {
  threadName: string;
  updatedAt?: string;
  lastSeenAt: number;
}

interface CodexTitleCacheBucket {
  sessionsRoot: string;
  entries: Record<string, CodexTitleCacheEntry>;
}

interface CodexTitleCacheFileV1 {
  version: 1;
  roots: Record<string, CodexTitleCacheBucket>;
}

interface SessionIndexEntry {
  threadName: string;
  updatedAt?: string;
}

const CODEX_TITLE_CACHE_FILE_NAME = "codex-title-cache.v1.json";

function normalizeSessionId(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : undefined;
}

function sanitizeThreadName(value: unknown): string | undefined {
  const normalized = normalizeWhitespace(typeof value === "string" ? value : "").trim();
  if (!normalized) return undefined;
  return normalized.length > 300 ? `${normalized.slice(0, 299)}...` : normalized;
}

function sanitizeTimestampIso(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : undefined;
}

function sanitizeCacheEntry(value: unknown): CodexTitleCacheEntry | null {
  if (!value || typeof value !== "object") return null;
  const threadName = sanitizeThreadName((value as any).threadName);
  const lastSeenAt = (value as any).lastSeenAt;
  if (!threadName || typeof lastSeenAt !== "number" || !Number.isFinite(lastSeenAt)) return null;

  return {
    threadName,
    updatedAt: sanitizeTimestampIso((value as any).updatedAt),
    lastSeenAt,
  };
}

function sanitizeCacheFile(value: unknown): CodexTitleCacheFileV1 {
  const result: CodexTitleCacheFileV1 = { version: 1, roots: {} };
  if (!value || typeof value !== "object" || (value as any).version !== 1) return result;

  const roots = (value as any).roots;
  if (!roots || typeof roots !== "object") return result;

  for (const [bucketKey, bucketValue] of Object.entries(roots as Record<string, unknown>)) {
    if (!bucketValue || typeof bucketValue !== "object") continue;

    const sessionsRoot = typeof (bucketValue as any).sessionsRoot === "string" ? (bucketValue as any).sessionsRoot.trim() : "";
    if (!sessionsRoot) continue;

    const entriesRaw = (bucketValue as any).entries;
    const entries: Record<string, CodexTitleCacheEntry> = {};
    if (entriesRaw && typeof entriesRaw === "object") {
      for (const [sessionId, entryValue] of Object.entries(entriesRaw as Record<string, unknown>)) {
        const normalizedId = normalizeSessionId(sessionId);
        const sanitizedEntry = sanitizeCacheEntry(entryValue);
        if (!normalizedId || !sanitizedEntry) continue;
        entries[normalizedId] = sanitizedEntry;
      }
    }

    result.roots[bucketKey] = { sessionsRoot, entries };
  }

  return result;
}

function resolveSessionIndexPath(sessionsRoot: string): string {
  return path.join(path.dirname(path.resolve(sessionsRoot)), "session_index.jsonl");
}

async function readSessionIndexEntries(indexPath: string): Promise<Map<string, SessionIndexEntry> | null> {
  let text: string;
  try {
    text = await fs.readFile(indexPath, "utf8");
  } catch {
    return null;
  }

  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const result = new Map<string, SessionIndexEntry>();
  for (const line of lines) {
    if (!line) continue;

    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const sessionId = normalizeSessionId(obj?.id);
    const threadName = sanitizeThreadName(obj?.thread_name);
    if (!sessionId || !threadName) continue;

    result.set(sessionId, {
      threadName,
      updatedAt: sanitizeTimestampIso(obj?.updated_at),
    });
  }

  return result;
}

function ensureBucket(cache: CodexTitleCacheFileV1, sessionsRoot: string): {
  bucketKey: string;
  bucket: CodexTitleCacheBucket;
  created: boolean;
  updated: boolean;
} {
  const bucketKey = normalizeCacheKey(sessionsRoot);
  const existing = cache.roots[bucketKey];
  if (existing) {
    return {
      bucketKey,
      bucket: existing,
      created: false,
      updated: existing.sessionsRoot !== sessionsRoot,
    };
  }

  const bucket: CodexTitleCacheBucket = {
    sessionsRoot,
    entries: {},
  };
  cache.roots[bucketKey] = bucket;
  return { bucketKey, bucket, created: true, updated: false };
}

function dropEmptyBuckets(cache: CodexTitleCacheFileV1): void {
  for (const [bucketKey, bucket] of Object.entries(cache.roots)) {
    if (Object.keys(bucket.entries).length > 0) continue;
    delete cache.roots[bucketKey];
  }
}

export class CodexTitleStore {
  private readonly cacheUri: vscode.Uri;

  constructor(globalStorageUri: vscode.Uri) {
    this.cacheUri = vscode.Uri.joinPath(globalStorageUri, CODEX_TITLE_CACHE_FILE_NAME);
  }

  public async getTitles(params: {
    sessionsRoot: string;
    sessionIds: readonly string[];
    pruneToSessionIds: boolean;
  }): Promise<Map<string, string>> {
    const sessionIds = Array.from(
      new Set(params.sessionIds.map((sessionId) => normalizeSessionId(sessionId)).filter((sessionId): sessionId is string => !!sessionId)),
    );
    const requestedIds = new Set(sessionIds);

    const cache = sanitizeCacheFile(await readJson<unknown>(this.cacheUri));
    const { bucket, bucketKey, created, updated } = ensureBucket(cache, params.sessionsRoot);
    let dirty = created || updated;
    if (updated) bucket.sessionsRoot = params.sessionsRoot;

    const liveEntries = await readSessionIndexEntries(resolveSessionIndexPath(params.sessionsRoot));
    const now = Date.now();

    if (liveEntries) {
      for (const sessionId of sessionIds) {
        const liveEntry = liveEntries.get(sessionId);
        if (!liveEntry) continue;

        const current = bucket.entries[sessionId];
        if (
          !current ||
          current.threadName !== liveEntry.threadName ||
          current.updatedAt !== liveEntry.updatedAt
        ) {
          bucket.entries[sessionId] = {
            threadName: liveEntry.threadName,
            updatedAt: liveEntry.updatedAt,
            lastSeenAt: now,
          };
          dirty = true;
        }
      }
    }

    if (params.pruneToSessionIds) {
      const nextEntries: Record<string, CodexTitleCacheEntry> = {};
      for (const sessionId of requestedIds) {
        const entry = bucket.entries[sessionId];
        if (!entry) continue;
        nextEntries[sessionId] = entry;
      }

      const currentKeys = Object.keys(bucket.entries);
      const nextKeys = Object.keys(nextEntries);
      if (
        currentKeys.length !== nextKeys.length ||
        currentKeys.some((key) => !Object.prototype.hasOwnProperty.call(nextEntries, key))
      ) {
        bucket.entries = nextEntries;
        dirty = true;
      }
    }

    const resolved = new Map<string, string>();
    for (const sessionId of sessionIds) {
      const threadName = bucket.entries[sessionId]?.threadName;
      if (threadName) resolved.set(sessionId, threadName);
    }

    if (!dirty) return resolved;

    if (Object.keys(bucket.entries).length === 0) {
      delete cache.roots[bucketKey];
    }
    dropEmptyBuckets(cache);
    await writeJson(this.cacheUri, cache);
    return resolved;
  }
}
