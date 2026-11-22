import { createHash, randomUUID } from "node:crypto";
import { normalizeFsPathKey } from "../utils/fsUtils";
import * as vscode from "vscode";
import { STORAGE_CONTRACT_FINGERPRINT } from "../generated/storageContractFingerprint";
import { buildSqliteIndexTextPlan, canonicalSqliteJson, encodeSqliteText, hashSqliteText, stringifySqliteMetadata,
  SQLITE_CACHE_BATCH_BYTES, SQLITE_CACHE_BATCH_RECORDS } from "../storage/sqliteCacheCodec";
import { SqliteCacheReader, SqliteCacheStore, validateContext } from "../storage/sqliteCacheStore";
import { getFoldingRuntimeKey, isRecord, SqliteCacheError, sqliteInteger } from "../storage/sqliteRuntime";
import type { SqliteCacheContext, SqliteCacheEntry, SqliteReuseMessage, SqliteStageRecord } from "../storage/sqliteCacheTypes";
import { ALL_SEARCH_CANDIDATES, SearchIndexGenerationMismatchError, validateSearchReadOptions,
  type SearchIndexPreparedSnapshot, type SearchIndexReadSnapshot, type SearchIndexReadTicket, type SearchIndexScanReader, type SearchIndexReadOptions } from "./searchIndexReader";
import { areSameSearchFileObservation, releaseAntigravityObservationData, buildIndexedSession, isValidCacheEntry, isValidIndexedSearchMessage, isValidSearchIndexStamp,
  normalizeContext, observeSearchFile, mapSearchWithConcurrency, type IndexedFileChangeHint, type IndexedSearchMessage, type SearchIndexEnsureParams,
  type SearchIndexEntryStamp, type SearchFileObservationOk } from "./searchIndexService";

interface Receipt {
  readonly snapshot: SearchIndexReadSnapshot;
  readonly context: SqliteCacheContext;
  readonly entries: readonly SqliteCacheEntry[];
  readonly folded: boolean;
}
const tickets = new WeakMap<SearchIndexReadTicket, Receipt>();

// Keep only stamps, immutable version IDs and semantic digests between searches.
export class SqliteSearchIndexService {
  private generation?: { signature: string; snapshot: SearchIndexReadSnapshot };
  constructor(private readonly store: SqliteCacheStore) {}

  public async ensureUpToDate(params: SearchIndexEnsureParams): Promise<SearchIndexPreparedSnapshot> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await this.ensure(params); }
      catch (error) {
        if (params.token?.isCancellationRequested) throw new vscode.CancellationError();
        if (attempt > 0 || !(error instanceof SqliteCacheError) || error.code !== "generation") throw error;
      }
    }
    throw new SqliteCacheError("generation");
  }

  private async ensure(params: SearchIndexEnsureParams): Promise<SearchIndexPreparedSnapshot> {
    const runtime = await this.store.ready();
    if (!runtime) throw new SqliteCacheError("disposed");
    cancelled(params.token);
    const contextValue = { ...normalizeContext({ ...params, storageContractFingerprint: STORAGE_CONTRACT_FINGERPRINT,
      antigravitySessionsRootsKey: JSON.stringify((params.antigravitySessionsRoots ?? params.index.roots?.antigravitySessionsRoots ?? []).map(normalizeFsPathKey)) }),
      foldingRuntimeKey: runtime.foldingRuntimeKey, sqliteVersion: runtime.version, sqliteSourceId: runtime.sourceId };
    let context = await this.store.context("search", contextValue);
    const previous = await this.store.entries(context, params.token);
    const working = params.forceRebuild ? new Map<string, SqliteCacheEntry>() : new Map(previous);
    const sessions = params.sessionInventory ?? params.index.sessions;
    params.performanceProbe?.add("sessionCount", sessions.length);
    const inventory = params.index.historySources ?? sessions;
    const active = new Set(sessions.map(session => session.cacheKey));
    const readable = new Set(active);
    const removed = new Set([...previous.keys()].filter(key => !active.has(key)));
    for (const key of removed) working.delete(key);
    const stamps = new Map<string, SearchIndexEntryStamp>();
    for (const session of sessions) {
      const cached = working.get(session.cacheKey);
      const stamp = cached && cached.source === session.source && cached.identity === session.identityKey ? readStamp(cached) : undefined;
      if (stamp) stamps.set(session.cacheKey, stamp);
      else if (cached) { working.delete(session.cacheKey); removed.add(session.cacheKey); }
    }
    const observations = await mapSearchWithConcurrency(sessions, 8, async session => {
      cancelled(params.token);
      // Do not retain every native conversation while ordinary file stats are collected.
      if (session.source === "antigravity") return undefined;
      const observed = await observeSearchFile(session, inventory, "initial", params.performanceProbe, stamps.get(session.cacheKey), params.token);
      cancelled(params.token);
      return observed;
    });
    const pointers: { key: string; version: number }[] = [];
    let operation: string | undefined;
    let committed = false;
    const begin = async (): Promise<string> => {
      if (!operation) {
        const next = randomUUID();
        await this.store.request({ kind: "begin", context: context.id, head: context.head, operation: next }, params.token);
        operation = next;
      }
      return operation;
    };
    try {
      // The same source observer and projector serve both storage backends.
      for (let i = 0; i < sessions.length; i++) {
        cancelled(params.token);
        const session = sessions[i]!;
        params.progress?.report({ message: `index ${i + 1}/${sessions.length}` });
        const stamp = stamps.get(session.cacheKey);
        let observed = observations[i] ?? await observeSearchFile(
          session, inventory, "initial", params.performanceProbe, stamps.get(session.cacheKey), params.token,
        );
        cancelled(params.token);
        if (observed.kind === "unchanged") { params.performanceProbe?.add("cacheHitCount"); continue; }
        if (observed.kind === "transient") {
          if (session.source === "antigravity") { readable.delete(session.cacheKey); params.performanceProbe?.setOutcome("partial"); continue; }
          if (!stamp) throw new SqliteCacheError("invalidData");
          params.performanceProbe?.setOutcome("partial");
          continue;
        }
        if (observed.kind === "missing") {
          const verified = await observeSearchFile(session, inventory, "postScan", params.performanceProbe);
          cancelled(params.token);
          if (verified.kind === "transient" && session.source !== "antigravity" && !stamp) throw new SqliteCacheError("invalidData");
          if (session.source === "antigravity") readable.delete(session.cacheKey);
          if (verified.kind === "missing") { working.delete(session.cacheKey); removed.add(session.cacheKey); }
          else if (verified.kind === "ok") readable.delete(session.cacheKey);
          params.performanceProbe?.setOutcome("partial");
          continue;
        }
        let input: SearchFileObservationOk = observed;
        observed = releaseAntigravityObservationData(observed);
        let next: SqliteCacheEntry | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          const indexed = await buildIndexedSession(session.fsPath, { source: session.source,
            claudeSessionsRoot: session.source === "claude" ? session.storage.rootPath : undefined,
            indexToolContent: params.indexToolContent, sessionInventory: inventory, historyPlan: input.historyPlan,
            antigravityData: input.antigravityData,
            token: params.token, performanceProbe: params.performanceProbe });
          input = releaseAntigravityObservationData(input);
          cancelled(params.token);
          let verified = await observeSearchFile(session, inventory, "postScan", params.performanceProbe, undefined, params.token);
          cancelled(params.token);
          if (verified.kind === "transient") { if (session.source === "antigravity") break; throw new SqliteCacheError("invalidData"); }
          if (verified.kind === "ok" && areSameSearchFileObservation(input, verified)) {
            verified = releaseAntigravityObservationData(verified);
            const metadata: SearchIndexEntryStamp = { fsPath: session.fsPath, mtimeMs: input.mtimeMs, size: input.size,
              ...(input.historySignature ? { historySignature: input.historySignature } : {}) };
            if (!isValidCacheEntry({ ...metadata, ...indexed })) throw new SqliteCacheError("invalidData");
            const descriptor: Omit<SqliteCacheEntry, "version"> = { key: session.cacheKey, source: session.source,
              identity: session.identityKey, inputSignature: canonicalSqliteJson(metadata), semanticDigest: semanticDigest(indexed), metadata: JSON.stringify(metadata) };
            const job = await begin();
            const version = sqliteInteger(await this.store.request({ kind: "entry", operation: job, entry: descriptor }, params.token), 1);
            await this.stage(job, version, indexed, params.token, params.forceRebuild ? undefined : working.get(session.cacheKey)?.version);
            next = { ...descriptor, version };
            pointers.push({ key: session.cacheKey, version });
            removed.delete(session.cacheKey);
            params.performanceProbe?.add("cacheEntryRebuildCount");
            break;
          }
          if (attempt === 0 && verified.kind === "ok") { input = verified; verified = releaseAntigravityObservationData(verified); continue; }
          if (verified.kind === "ok") verified = releaseAntigravityObservationData(verified);
          break;
        }
        if (next) working.set(session.cacheKey, next);
        else { readable.delete(session.cacheKey); params.performanceProbe?.setOutcome("partial"); }
      }
      if (params.forceRebuild) for (const key of previous.keys()) if (!working.has(key)) removed.add(key);
      cancelled(params.token);
      if (operation || removed.size || params.forceRebuild) {
        const job = await begin();
        for (let start = 0; start < pointers.length; start += 256) await this.store.request({ kind: "publish", operation: job, pointers: pointers.slice(start, start + 256), removed: [], final: false }, params.token);
        const deleted = [...removed];
        for (let start = 0; start < deleted.length; start += 256) await this.store.request({ kind: "publish", operation: job, pointers: [], removed: deleted.slice(start, start + 256), final: false }, params.token);
        cancelled(params.token);
        // A successful COMMIT remains successful even if cancellation arrives immediately afterwards.
        context = validateContext(await this.store.publish(job, undefined, params.token));
        committed = true;
      }
      const digest = createHash("sha256").update(canonicalSqliteJson(contextValue));
      for (const key of [...readable].sort()) {
        digest.update(JSON.stringify(key)).update("\0").update(working.get(key)?.semanticDigest ?? "missing").update("\0");
      }
      const signature = digest.digest("hex");
      let snapshot = this.generation?.signature === signature ? this.generation.snapshot : undefined;
      if (!snapshot) { snapshot = this.snapshot(); this.generation = { signature, snapshot }; params.performanceProbe?.add("snapshotGenerationCount"); }
      else params.performanceProbe?.add("snapshotReuseCount");
      const ticket: SearchIndexReadTicket = Object.freeze({ kind: "searchIndexReadTicket" });
      tickets.set(ticket, { snapshot, context, entries: Object.freeze([...working.values()].filter(entry => readable.has(entry.key)).map(entry => Object.freeze(entry))),
        folded: runtime.foldingRuntimeKey !== null && runtime.foldingRuntimeKey === getFoldingRuntimeKey(runtime.version, runtime.sourceId) });
      return Object.freeze({ snapshot, ticket, unavailableSources: Object.freeze(
        sessions.some(session => session.source === "antigravity" && !readable.has(session.cacheKey)) ? ["antigravity" as const] : [],
      ) });
    } finally {
      if (operation && !committed && this.store.getStatus().backend === "sqlite") await this.store.request({ kind: "abandon", operation }).catch(() => undefined);
    }
  }

  private snapshot(): SearchIndexReadSnapshot {
    const snapshot: SearchIndexReadSnapshot = Object.freeze({ openReader: async (ticket: SearchIndexReadTicket, options: SearchIndexReadOptions = {}) => {
      validateSearchReadOptions(options);
      cancelled(options.token);
      const receipt = tickets.get(ticket);
      if (!receipt || receipt.snapshot !== snapshot) throw new SqliteCacheError("invalidData");
      try {
        const plan = options.candidatePlan?.kind === "grams" && options.candidatePlan.column === "folded" && !receipt.folded
          ? ALL_SEARCH_CANDIDATES : options.candidatePlan;
        const reader = await this.store.openReader(receipt.context, receipt.entries.map(entry => ({ key: entry.key, version: entry.version, inputSignature: entry.inputSignature })),
          { ...options, candidatePlan: plan });
        const requested = options.cacheKeys ? new Set(options.cacheKeys) : undefined;
        return new SqliteSearchReader(reader, new Set(receipt.entries.filter(entry => !requested || requested.has(entry.key)).map(entry => entry.key)), options.token);
      } catch (error) {
        if (error instanceof SqliteCacheError && error.code === "generation") throw new SearchIndexGenerationMismatchError();
        throw error;
      }
    } });
    return snapshot;
  }

  private async stage(operation: string, version: number, indexed: { messages: readonly IndexedSearchMessage[]; fileChangeHints: readonly IndexedFileChangeHint[] }, token?: vscode.CancellationToken, previous?: number): Promise<void> {
    const reused = new Set<number>();
    if (previous !== undefined) {
      let records: SqliteReuseMessage[] = [];
      let bytes = 2;
      const flushReuse = async (): Promise<void> => {
        if (!records.length) return;
        await this.store.beforeStage(token);
        const result = await this.store.request({ kind: "reuse", operation, version, previous, records }, token);
        const requested = new Set(records.map(record => record.ordinal));
        if (!Array.isArray(result) || result.length > records.length) throw new SqliteCacheError("invalidData");
        for (const value of result) {
          const ordinal = sqliteInteger(value);
          if (!requested.has(ordinal) || reused.has(ordinal)) throw new SqliteCacheError("invalidData");
          reused.add(ordinal);
        }
        records = []; bytes = 2;
      };
      for (let ordinal = 0; ordinal < indexed.messages.length; ordinal++) {
        cancelled(token);
        const { text, ...metadata } = indexed.messages[ordinal]!;
        const record: SqliteReuseMessage = { kind: "message", ordinal, metadata: stringifySqliteMetadata(metadata), role: metadata.role,
          source: metadata.source, units: text.length, digest: hashSqliteText(text) };
        const size = Buffer.byteLength(JSON.stringify(record), "utf8") + 1;
        if (records.length >= SQLITE_CACHE_BATCH_RECORDS || bytes + size > SQLITE_CACHE_BATCH_BYTES) await flushReuse();
        if (size + 2 > SQLITE_CACHE_BATCH_BYTES) throw new SqliteCacheError("invalidData");
        records.push(record); bytes += size;
      }
      await flushReuse();
    }
    let batch: SqliteStageRecord[] = [];
    let bytes = 2;
    const flush = async (): Promise<void> => {
      if (!batch.length) return;
      await this.store.beforeStage(token);
      await this.store.request({ kind: "stage", operation, version, records: batch }, token);
      batch = []; bytes = 2;
    };
    const add = async (record: SqliteStageRecord): Promise<void> => {
      cancelled(token);
      const size = Buffer.byteLength(JSON.stringify(record), "utf8") + 1;
      if (batch.length >= SQLITE_CACHE_BATCH_RECORDS || bytes + size > SQLITE_CACHE_BATCH_BYTES) await flush();
      if (size + 2 > SQLITE_CACHE_BATCH_BYTES) throw new SqliteCacheError("invalidData");
      batch.push(record); bytes += size;
    };
    for (let ordinal = 0; ordinal < indexed.messages.length; ordinal++) {
      if (reused.has(ordinal)) continue;
      const { text, ...metadata } = indexed.messages[ordinal]!;
      const plan = buildSqliteIndexTextPlan(text);
      await add({ kind: "message", ordinal, metadata: stringifySqliteMetadata(metadata), role: metadata.role, source: metadata.source, units: text.length, eligible: plan.eligible });
      let chunk = 0;
      for (const value of encodeSqliteText(text)) await add({ kind: "text", message: ordinal, ordinal: chunk++, text: value });
      if (plan.eligible) for (const column of ["raw", "folded"] as const) {
        if (plan[column].length) await add({ kind: "gram", message: ordinal, ordinal: 0, column, text: plan[column] });
      }
    }
    for (let ordinal = 0; ordinal < indexed.fileChangeHints.length; ordinal++) {
      const { paths, ...metadata } = indexed.fileChangeHints[ordinal]!;
      await add({ kind: "hint", ordinal, metadata: stringifySqliteMetadata(metadata) });
      for (let i = 0; i < paths.length; i++) await add({ kind: "path", hint: ordinal, ordinal: i, text: JSON.stringify(paths[i]) });
    }
    await flush();
    await this.store.request({ kind: "finishEntry", operation, version, messages: indexed.messages.length, hints: indexed.fileChangeHints.length, values: 0 }, token);
  }
}

class SqliteSearchReader implements SearchIndexScanReader {
  constructor(private readonly reader: SqliteCacheReader, private readonly keys: ReadonlySet<string>, private readonly token?: vscode.CancellationToken) {}
  public async *iterateMessages(key: string, checkpoint: () => Promise<void>): AsyncIterable<IndexedSearchMessage> {
    for await (const item of this.messages(key, false, checkpoint)) yield item;
  }
  public async *iterateToolTexts(key: string, checkpoint: () => Promise<void>): AsyncIterable<string> {
    for await (const item of this.messages(key, true, checkpoint)) yield item.text;
  }
  private async *messages(key: string, tools: boolean, checkpoint: () => Promise<void>): AsyncGenerator<IndexedSearchMessage> {
    try {
      for await (const row of this.reader.messages(key, tools)) {
        await checkpoint(); cancelled(this.token);
        let metadata: unknown;
        try { metadata = JSON.parse(String(row.metadata)); } catch { throw new SqliteCacheError("invalidData"); }
        if (!isRecord(metadata)) throw new SqliteCacheError("invalidData");
        const text = await this.reader.text(sqliteInteger(row.id, 1), sqliteInteger(row.units));
        const message = { messageIndex: metadata.messageIndex, role: metadata.role, source: metadata.source, text,
          ...(metadata.inputId !== undefined ? { inputId: metadata.inputId } : {}),
          ...(metadata.progressId !== undefined ? { progressId: metadata.progressId } : {}),
          ...(metadata.progressKind !== undefined ? { progressKind: metadata.progressKind } : {}) };
        if (!isValidIndexedSearchMessage(message)) throw new SqliteCacheError("invalidData");
        await checkpoint(); cancelled(this.token);
        yield Object.freeze(message);
      }
    } catch (error) {
      if (error instanceof SqliteCacheError && error.code === "invalidData") return await this.reader.rejectCorruptData();
      throw error;
    }
  }
  public async getFileChangeHints(key: string): Promise<readonly IndexedFileChangeHint[] | null> {
    this.reader.assertActive();
    if (!this.keys.has(key)) return null;
    try {
      const hints: IndexedFileChangeHint[] = [];
      let after = -1;
      while (true) {
        const rows = await this.reader.rows({ kind: "hints", reader: "", key, after });
        if (!rows.length) break;
        for (const row of rows) {
          if (sqliteInteger(row.ordinal) !== after + 1) throw new SqliteCacheError("invalidData");
          let metadata: unknown;
          try { metadata = JSON.parse(String(row.metadata)); } catch { throw new SqliteCacheError("invalidData"); }
          if (!isRecord(metadata)) throw new SqliteCacheError("invalidData");
          const paths: string[] = [];
          let pathAfter = -1;
          while (true) {
            const values = await this.reader.rows({ kind: "paths", reader: "", key, hint: row.ordinal as number, after: pathAfter });
            if (!values.length) break;
            for (const value of values) {
              if (sqliteInteger(value.ordinal) !== pathAfter + 1) throw new SqliteCacheError("invalidData");
              let parsed: unknown;
              try { parsed = JSON.parse(String(value.path_json)); } catch { throw new SqliteCacheError("invalidData"); }
              if (typeof parsed !== "string" || parsed.length > 32768) throw new SqliteCacheError("invalidData");
              paths.push(parsed); pathAfter++;
            }
          }
          const hint = { messageIndex: metadata.messageIndex, origin: metadata.origin, hasDiffLikeContent: metadata.hasDiffLikeContent,
            ...(metadata.timestampIso !== undefined ? { timestampIso: metadata.timestampIso } : {}), paths: Object.freeze(paths) };
          if (!isValidCacheEntry({ fsPath: "", mtimeMs: 0, size: 0, messages: [], fileChangeHints: [hint] })) throw new SqliteCacheError("invalidData");
          hints.push(Object.freeze(hint) as unknown as IndexedFileChangeHint);
          after++;
        }
      }
      return Object.freeze(hints);
    } catch (error) {
      if (error instanceof SqliteCacheError && error.code === "invalidData") return this.reader.rejectCorruptData();
      throw error;
    }
  }
  public dispose(): Promise<void> { return this.reader.dispose(); }
}

function readStamp(entry: SqliteCacheEntry): SearchIndexEntryStamp | undefined {
  try { const stamp: unknown = JSON.parse(entry.metadata); return isValidSearchIndexStamp(stamp) ? stamp : undefined; }
  catch { return undefined; }
}
function cancelled(token?: vscode.CancellationToken): void { if (token?.isCancellationRequested) throw new vscode.CancellationError(); }
function semanticDigest(indexed: { messages: readonly IndexedSearchMessage[]; fileChangeHints: readonly IndexedFileChangeHint[] }): string {
  const hash = createHash("sha256");
  const add = (text: string): void => { hash.update(String(text.length)).update(":").update(text, "utf16le").update(";"); };
  for (const { text, ...metadata } of indexed.messages) { add("message"); add(canonicalSqliteJson(metadata)); add(text); }
  for (const { paths, ...metadata } of indexed.fileChangeHints) { add("hint"); add(canonicalSqliteJson(metadata)); for (const path of paths) add(path); add("endHint"); }
  return hash.digest("hex");
}
