import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { canonicalSqliteJson, encodeSqliteText, hashSqliteText, SQLITE_CACHE_BATCH_BYTES, SQLITE_CACHE_BATCH_RECORDS } from "./sqliteCacheCodec";
import { SqliteCacheStore, validateContext } from "./sqliteCacheStore";
import { isRecord, SqliteCacheError, sqliteInteger } from "./sqliteRuntime";
import type { SqliteCacheContext, SqliteCacheEntry, SqliteCacheFamily, SqliteStageRecord } from "./sqliteCacheTypes";

export interface SqliteValueCacheSnapshot {
  readonly json: string;
  readonly context: SqliteCacheContext;
  readonly entries: ReadonlyMap<string, SqliteCacheEntry>;
}
export interface SqliteValueDocument {
  readonly header: Record<string, unknown>;
  readonly entries: Record<string, unknown>;
}

// History and Analysis retain their validators and publication policies above this storage adapter.
export class SqliteValueCache {
  private state?: SqliteValueCacheSnapshot;
  private forceRewrite = false;
  constructor(private readonly store: SqliteCacheStore, private readonly family: Exclude<SqliteCacheFamily, "search">) {}

  public async prepare(context: unknown, token?: vscode.CancellationToken): Promise<SqliteValueCacheSnapshot> {
    const json = canonicalSqliteJson(context);
    let state: SqliteValueCacheSnapshot | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const head = await this.store.context(this.family, context);
      try { state = { json, context: head, entries: await this.store.entries(head, token) }; break; }
      catch (error) {
        if (attempt > 0 || !(error instanceof SqliteCacheError) || error.code !== "generation") throw error;
      }
    }
    if (!state) throw new SqliteCacheError("generation");
    this.state = state;
    return state;
  }

  public async load(context: unknown, keys?: ReadonlySet<string>, token?: vscode.CancellationToken): Promise<SqliteValueDocument | null> {
    return this.loadPrepared(await this.prepare(context, token), keys, token);
  }

  public async loadPrepared(state: SqliteValueCacheSnapshot, keys?: ReadonlySet<string>, token?: vscode.CancellationToken): Promise<SqliteValueDocument | null> {
    const header = state.entries.get("header");
    if (!header) return null;
    const selected = [...state.entries.values()].filter(entry => entry.key === "header"
      || (entry.key.startsWith("entry:") && (!keys || keys.has(entry.key.slice(6)))));
    const reader = await this.store.openReader(state.context, selected.map(entry => ({ key: entry.key, version: entry.version, inputSignature: entry.inputSignature })), { token });
    try {
      const rawHeader = await reader.value("header");
      if (!isRecord(rawHeader)) throw new SqliteCacheError("invalidData");
      if (hashSqliteText(JSON.stringify(rawHeader)) !== header.semanticDigest) throw new SqliteCacheError("invalidData");
      const entries: Record<string, unknown> = Object.create(null);
      for (const entry of selected) {
        if (entry.key === "header") continue;
        const value = await reader.value(entry.key);
        if (!isRecord(value)) throw new SqliteCacheError("invalidData");
        if (hashSqliteText(JSON.stringify(value)) !== entry.semanticDigest) throw new SqliteCacheError("invalidData");
        entries[entry.key.slice(6)] = value;
      }
      return { header: rawHeader, entries };
    } catch (error) {
      if (error instanceof SqliteCacheError && error.code === "invalidData") this.forceRewrite = true;
      throw error;
    } finally { await reader.dispose(); }
  }

  public async save(context: unknown, document: SqliteValueDocument, options: {
    beforeCommit?: () => void;
    token?: vscode.CancellationToken;
    retainKeys?: ReadonlySet<string>;
    preserveUnloaded?: boolean;
    snapshot?: SqliteValueCacheSnapshot;
  } = {}): Promise<void> {
    const retainKeys = options.retainKeys ? new Set(options.retainKeys) : undefined;
    const json = canonicalSqliteJson(context);
    if (!options.snapshot && (!this.state || this.state.json !== json)) await this.prepare(context, options.token);
    const state = options.snapshot ?? this.state!;
    if (state.json !== json) throw new SqliteCacheError("invalidData");
    const operation = randomUUID();
    await this.store.request({ kind: "begin", context: state.context.id, head: state.context.head, operation }, options.token);
    let committed = false;
    const next = new Map(state.entries);
    const present = new Set(["header", ...Object.keys(document.entries).map(key => "entry:" + key)]);
    const removed = [...state.entries.keys()].filter(key => key !== "header"
      && ((!options.preserveUnloaded && !present.has(key)) || (retainKeys && !retainKeys.has(key.slice(6)))));
    const pointers: { key: string; version: number }[] = [];
    try {
      for (const [key, value] of [["header", document.header] as const, ...Object.entries(document.entries).map(([key, value]) => ["entry:" + key, value] as const)]) {
        if (key !== "header" && retainKeys && !retainKeys.has(key.slice(6))) continue;
        if (!isRecord(value)) throw new SqliteCacheError("invalidData");
        const previous = this.forceRewrite ? undefined : state.entries.get(key);
        // Callers may update an existing summary object; compare its content rather than its identity.
        const text = JSON.stringify(value);
        const digest = hashSqliteText(text);
        if (digest === previous?.semanticDigest) continue;
        const summary = isRecord(value.summary) ? value.summary : value;
        const source = ["codex", "claude", "antigravity"].includes(String(summary.source)) ? summary.source as SqliteCacheEntry["source"] : "none";
        const metadata = { mtimeMs: typeof value.mtimeMs === "number" && Number.isFinite(value.mtimeMs) ? value.mtimeMs : 0,
          ...(typeof summary.startedAtIso === "string" ? { startedAtIso: summary.startedAtIso } : {}),
          ...(typeof summary.lastActivityAtIso === "string" ? { lastActivityAtIso: summary.lastActivityAtIso } : {}) };
        const descriptor: Omit<SqliteCacheEntry, "version"> = { key, source,
          identity: typeof summary.identityKey === "string" ? summary.identityKey : "", inputSignature: digest, semanticDigest: digest, metadata: JSON.stringify(metadata) };
        const version = sqliteInteger(await this.store.request({ kind: "entry", operation, entry: descriptor }, options.token), 1);
        let ordinal = 0;
        let batch: SqliteStageRecord[] = [];
        let bytes = 2;
        const flush = async (): Promise<void> => {
          if (!batch.length) return;
          await this.store.beforeStage(options.token);
          await this.store.request({ kind: "stage", operation, version, records: batch }, options.token);
          batch = []; bytes = 2;
        };
        for (const chunk of encodeSqliteText(text)) {
          const record: SqliteStageRecord = { kind: "value", ordinal: ordinal++, text: chunk };
          const size = Buffer.byteLength(JSON.stringify(record), "utf8") + 1;
          if (batch.length >= SQLITE_CACHE_BATCH_RECORDS || bytes + size > SQLITE_CACHE_BATCH_BYTES) await flush();
          batch.push(record); bytes += size;
        }
        await flush();
        await this.store.request({ kind: "finishEntry", operation, version, messages: 0, hints: 0, values: ordinal }, options.token);
        next.set(key, { ...descriptor, version });
        pointers.push({ key, version });
      }
      for (let start = 0; start < pointers.length; start += 256) await this.store.request({ kind: "publish", operation, pointers: pointers.slice(start, start + 256), removed: [], final: false }, options.token);
      for (let start = 0; start < removed.length; start += 256) await this.store.request({ kind: "publish", operation, pointers: [], removed: removed.slice(start, start + 256), final: false }, options.token);
      const result = await this.store.publish(operation, options.beforeCommit, options.token);
      const head = validateContext(result);
      committed = true;
      for (const key of removed) next.delete(key);
      this.state = { json, context: head, entries: next };
      this.forceRewrite = false;
    } finally {
      if (!committed && this.store.getStatus().backend === "sqlite") await this.store.request({ kind: "abandon", operation }).catch(() => undefined);
    }
  }
}
