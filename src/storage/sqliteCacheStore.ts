import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import * as vscode from "vscode";
import { ALL_SEARCH_CANDIDATES, validateSearchReadOptions, type SearchIndexReadOptions } from "../services/searchIndexReader";
import { canonicalSqliteJson, SQLITE_CACHE_BATCH_BYTES, SqliteTextDecoder } from "./sqliteCacheCodec";
import { isRecord, isSqliteCacheErrorCode, resolveSafeSqliteCachePath, SqliteCacheError, sqliteInteger, sqliteText,
  type SqliteCacheErrorCode, type SqliteRuntimeInfo } from "./sqliteRuntime";
import type { SqliteCacheContext, SqliteCacheEntry, SqliteCacheFamily, SqliteCacheRequest, SqliteCacheReadRequest, SqliteCacheWorkerRequest, SqliteReadScope } from "./sqliteCacheTypes";

export interface SqliteCacheStatus {
  readonly backend: "uninitialized" | "probing" | "sqlite" | "legacy";
  readonly reason?: SqliteCacheErrorCode;
}
export type SqliteCacheRuntimeAvailability =
  | { available: true }
  | { available: false; reason: SqliteCacheErrorCode };

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  cancellation?: vscode.Disposable;
}
interface WalCheckpointGate {
  force: boolean;
  checkpointed: boolean;
  promise: Promise<void>;
}
const CHECKPOINT_STAGE_BATCHES = Math.max(1, Math.floor(16 * 1048576 / SQLITE_CACHE_BATCH_BYTES));

class SqliteWorkerClient {
  private readonly pending = new Map<number, PendingCall>();
  private sequence = 0;
  private stopping?: Promise<void>;
  private stopped = false;
  private readonly exited: Promise<void>;
  constructor(private readonly worker: Worker) {
    this.exited = new Promise(resolve => worker.once("exit", () => { this.stopped = true; this.rejectAll(new SqliteCacheError("worker")); resolve(); }));
    worker.on("error", () => { void this.stop(new SqliteCacheError("worker")); });
    worker.on("message", (reply: unknown) => {
      if (!isRecord(reply) || !Number.isSafeInteger(reply.id) || typeof reply.ok !== "boolean") {
        void this.stop(new SqliteCacheError("invalidData")); return;
      }
      const item = this.pending.get(reply.id as number);
      if (!item) return;
      this.pending.delete(reply.id as number);
      clearTimeout(item.timer); item.cancellation?.dispose();
      if (reply.ok) item.resolve(reply.result);
      else item.reject(new SqliteCacheError(isSqliteCacheErrorCode(reply.code) ? reply.code : "worker"));
    });
  }
  public isTerminating(): boolean { return this.stopped || this.stopping !== undefined; }
  public call(request: SqliteCacheWorkerRequest, token?: vscode.CancellationToken, timeoutMs = 30000): Promise<unknown> {
    if (this.stopped || this.stopping) return Promise.reject(new SqliteCacheError("worker"));
    if (token?.isCancellationRequested) return Promise.reject(new vscode.CancellationError());
    const id = ++this.sequence;
    if (!Number.isSafeInteger(id)) return Promise.reject(new SqliteCacheError("worker"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void this.stop(new SqliteCacheError("worker")); }, timeoutMs);
      timer.unref();
      const item: PendingCall = { resolve, reject, timer };
      this.pending.set(id, item);
      item.cancellation = token?.onCancellationRequested(() => {
        if (request.kind === "publish" && request.final && request.cancelState) Atomics.store(new Int32Array(request.cancelState), 0, 1);
        else void this.stop(new vscode.CancellationError());
      });
      try { this.worker.postMessage({ id, request }); }
      catch { void this.stop(new SqliteCacheError("worker")); }
    });
  }
  private rejectAll(error: unknown): void {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer); item.cancellation?.dispose(); item.reject(error);
    }
    this.pending.clear();
  }
  public stop(error: Error = new SqliteCacheError("disposed")): Promise<void> {
    if (!this.stopping) {
      this.rejectAll(error);
      this.stopping = (async () => {
        if (!this.stopped) await this.worker.terminate();
        await this.exited;
      })();
    }
    return this.stopping;
  }
}

// Use a separate worker so the probe cannot open a cache or change the active backend.
export async function probeSqliteCacheAvailability(token: vscode.CancellationToken): Promise<SqliteCacheRuntimeAvailability> {
  let client: SqliteWorkerClient | undefined;
  try {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    client = new SqliteWorkerClient(new Worker(path.join(__dirname, "sqliteCacheWorker.js"), { workerData: "probeRuntime" }));
    const result = await client.call({ kind: "probeRuntime" }, token, 10_000);
    if (!isRecord(result)) throw new SqliteCacheError("invalidData");
    validateRuntime(result);
    return { available: true };
  } catch (error) {
    if (error instanceof vscode.CancellationError) throw error;
    return { available: false, reason: error instanceof SqliteCacheError ? error.code : "worker" };
  } finally {
    await client?.stop();
  }
}

export class SqliteCacheStore implements vscode.Disposable {
  private readonly owner = randomUUID();
  private status: SqliteCacheStatus;
  private readonly statusEmitter = new vscode.EventEmitter<SqliteCacheStatus>();
  public readonly onDidChangeStatus = this.statusEmitter.event;
  private initialization?: Promise<SqliteRuntimeInfo | null>;
  private client?: SqliteWorkerClient;
  private heartbeat?: ReturnType<typeof setInterval>;
  private maintenanceTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private closing = false;
  private shutdown?: Promise<void>;
  private readonly readers = new Set<SqliteCacheReader>();
  private activeSlots = 0;
  private readonly slotWaiters = new Set<() => void>();
  private walGate?: WalCheckpointGate;
  private stagedBatches = 0;
  private requestQueue: Promise<void> = Promise.resolve();

  constructor(private readonly storage: vscode.Uri, options?: { enabled: boolean }) {
    this.status = Object.freeze({ backend: options?.enabled === false ? "legacy" : "uninitialized" });
  }
  public getStatus(): SqliteCacheStatus { return this.status; }
  private setStatus(status: SqliteCacheStatus): void {
    this.status = Object.freeze(status);
    if (!this.closing) this.statusEmitter.fire(this.status);
  }

  public ready(): Promise<SqliteRuntimeInfo | null> {
    if (this.disposed || this.closing || this.status.backend === "legacy") return Promise.resolve(null);
    if (!this.initialization) this.initialization = this.initialize();
    return this.initialization;
  }
  private async initialize(): Promise<SqliteRuntimeInfo | null> {
    this.setStatus({ backend: "probing" });
    try {
      const file = await resolveSafeSqliteCachePath(this.storage);
      if (this.disposed || this.closing) return null;
      this.client = new SqliteWorkerClient(new Worker(path.join(__dirname, "sqliteCacheWorker.js")));
      const result = await this.callWorker(this.client, { kind: "init", file, owner: this.owner });
      if (!isRecord(result) || !isRecord(result.runtime)) throw new SqliteCacheError("invalidData");
      const runtime = validateRuntime(result.runtime);
      if (this.disposed || this.closing) { await this.client.stop(); return null; }
      this.setStatus({ backend: "sqlite" });
      this.heartbeat = setInterval(() => { void this.request({ kind: "heartbeat" }).then(() => this.scheduleMaintenance()).catch(() => undefined); }, 30000);
      this.heartbeat.unref();
      try { await this.request({ kind: "maintenance" }); }
      catch (error) {
        if (!(error instanceof SqliteCacheError) || error.code !== "busy") throw error;
        this.scheduleMaintenance();
      }
      return this.disposed || this.closing ? null : runtime;
    } catch (error) {
      await this.downgrade(error instanceof SqliteCacheError ? error.code : "storage");
      return null;
    }
  }

  public request(request: SqliteCacheRequest, token?: vscode.CancellationToken): Promise<unknown> {
    return this.withRequestLock(() => this.requestCore(request, token), token);
  }

  private withRequestLock<T>(operation: () => Promise<T>, token?: vscode.CancellationToken): Promise<T> {
    if (token?.isCancellationRequested) return Promise.reject(new vscode.CancellationError());
    return new Promise<T>((resolve, reject) => {
      let started = false, cancelled = false;
      let subscription: vscode.Disposable | undefined;
      subscription = token?.onCancellationRequested(() => {
        if (!started) { cancelled = true; subscription?.dispose(); reject(new vscode.CancellationError()); }
      });
      if (cancelled) subscription?.dispose();
      const run = async (): Promise<T> => {
        started = true; subscription?.dispose();
        if (cancelled || token?.isCancellationRequested) throw new vscode.CancellationError();
        return operation();
      };
      const queued = this.requestQueue.then(run, run);
      this.requestQueue = queued.then(() => undefined, () => undefined);
      void queued.then(resolve, reject);
    });
  }

  public publish(operation: string, beforeCommit?: () => void, token?: vscode.CancellationToken): Promise<unknown> {
    return this.withRequestLock(async () => {
      try {
        await this.requestCore({ kind: "preparePublish", operation }, token);
        if (this.closing || this.disposed) throw new SqliteCacheError("disposed");
        if (token?.isCancellationRequested) throw new vscode.CancellationError();
        beforeCommit?.();
        if (token?.isCancellationRequested) throw new vscode.CancellationError();
        // Only the final call ignores a cancellation that arrives after the successful COMMIT.
        return await this.requestCore({ kind: "publish", operation, pointers: [], removed: [], final: true, cancelState: new SharedArrayBuffer(4) }, token);
      } finally {
        if (this.status.backend === "sqlite") {
          try { await this.requestCore({ kind: "rollbackPublish", operation }); }
          catch {
            // Never reuse a connection whose transaction release could not be confirmed.
            await this.downgrade("worker");
          }
        }
      }
    }, token);
  }

  private async requestCore(request: SqliteCacheRequest, token?: vscode.CancellationToken): Promise<unknown> {
    if (!this.client || this.disposed || (this.closing && request.kind !== "close" && request.kind !== "dispose" && request.kind !== "rollbackPublish")
      || this.status.backend !== "sqlite") throw new SqliteCacheError("disposed");
    const committing = request.kind === "publish" && request.final;
    try {
      const result = await this.callWorker(this.client, request, token, committing);
      if (request.kind === "publish" && request.final) this.scheduleMaintenance();
      return result;
    } catch (error) {
      if (error instanceof vscode.CancellationError) {
        // Termination must finish before a subsequent request can enter the legacy fallback.
        if (this.client.isTerminating()) await this.downgrade("worker");
      } else if (error instanceof SqliteCacheError && ["schema", "corrupt", "invalidData", "resourceLimit", "io", "full", "worker"].includes(error.code)) {
        await this.downgrade(error.code === "invalidData" ? "corrupt" : error.code);
      }
      throw error;
    }
  }

  private async callWorker(client: SqliteWorkerClient, request: SqliteCacheRequest, token?: vscode.CancellationToken, committing = false): Promise<unknown> {
    const started = Date.now();
    while (true) {
      if (request.kind === "init" && this.closing) throw new SqliteCacheError("disposed");
      try {
        const result = await client.call(request, token);
        if (!committing && token?.isCancellationRequested) throw new vscode.CancellationError();
        return result;
      } catch (error) {
        if ((!committing && token?.isCancellationRequested) ||
          (error instanceof SqliteCacheError && error.code === "cancelled")) throw new vscode.CancellationError();
        if (!committing && error instanceof SqliteCacheError && error.code === "busy" && Date.now() - started < 2000
          && !this.closing && !token?.isCancellationRequested) {
          await new Promise(resolve => setTimeout(resolve, 20));
          continue;
        }
        throw error;
      }
    }
  }

  private async downgrade(reason: SqliteCacheErrorCode): Promise<void> {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = undefined; }
    if (this.maintenanceTimer) { clearTimeout(this.maintenanceTimer); this.maintenanceTimer = undefined; }
    const client = this.client;
    if (client) await client.stop();
    this.setStatus({ backend: "legacy", reason });
    for (const wake of this.slotWaiters) wake();
  }
  public async rejectCorruptData(): Promise<never> {
    await this.downgrade("corrupt");
    throw new SqliteCacheError("corrupt");
  }

  public async context(family: SqliteCacheFamily, context: unknown): Promise<SqliteCacheContext> {
    const value = await this.request({ kind: "context", family, json: canonicalSqliteJson(context) });
    return validateContext(value);
  }
  public async entries(context: SqliteCacheContext, token?: vscode.CancellationToken): Promise<Map<string, SqliteCacheEntry>> {
    try {
      const entries = new Map<string, SqliteCacheEntry>();
      let metadataBytes = 0;
      let after: string | null = null;
      while (true) {
        const value = await this.request({ kind: "list", context: context.id, after }, token);
        if (!Array.isArray(value) || value.length > 256) throw new SqliteCacheError("invalidData");
        if (!value.length) break;
        for (const raw of value) {
          const entry = validateEntry(raw);
          metadataBytes += Buffer.byteLength(JSON.stringify(entry), "utf8");
          if (metadataBytes > 256 * 1048576) {
            await this.downgrade("resourceLimit");
            throw new SqliteCacheError("resourceLimit");
          }
          if (entries.has(entry.key)) throw new SqliteCacheError("invalidData");
          entries.set(entry.key, entry);
          after = entry.key;
        }
        if (entries.size > 1000000) throw new SqliteCacheError("invalidData");
      }
      if (await this.request({ kind: "head", context: context.id }, token) !== context.head) throw new SqliteCacheError("generation");
      return entries;
    } catch (error) {
      if (error instanceof SqliteCacheError && error.code === "invalidData") return this.rejectCorruptData();
      throw error;
    }
  }

  public async openReader(context: SqliteCacheContext, entries: readonly SqliteReadScope[], options: SearchIndexReadOptions = {}): Promise<SqliteCacheReader> {
    if (this.disposed || this.closing) throw new SqliteCacheError("disposed");
    validateSearchReadOptions(options);
    options = { ...options, cacheKeys: options.cacheKeys ? [...options.cacheKeys] : undefined,
      roles: options.roles ? [...new Set(options.roles)] : undefined,
      candidatePlan: options.candidatePlan?.kind === "grams"
        ? { kind: "grams", column: options.candidatePlan.column, anyOf: [...options.candidatePlan.anyOf] }
        : ALL_SEARCH_CANDIDATES };
    await this.takeSlot(options.token);
    const id = randomUUID();
    let opened = false;
    try {
      if (this.walGate) await this.waitForWalGate(this.walGate.promise, options.token);
      if (options.token?.isCancellationRequested) throw new vscode.CancellationError();
      await this.request({ kind: "open", reader: id, context: context.id, head: context.head }, options.token);
      opened = true;
      const scope = options.cacheKeys ? new Set(options.cacheKeys) : undefined;
      let batch: SqliteReadScope[] = [];
      for (const entry of entries) {
        if (scope && !scope.has(entry.key)) continue;
        batch.push(entry);
        if (batch.length === 256) { await this.request({ kind: "scope", reader: id, entries: batch }, options.token); batch = []; }
      }
      if (batch.length) await this.request({ kind: "scope", reader: id, entries: batch }, options.token);
      let after = 0;
      while (true) {
        const result = await this.request({ kind: "candidates", reader: id, plan: options.candidatePlan ?? ALL_SEARCH_CANDIDATES, after }, options.token);
        if (!isRecord(result) || typeof result.done !== "boolean") throw new SqliteCacheError("invalidData");
        const next = sqliteInteger(result.after);
        if (result.done) break;
        if (next <= after) throw new SqliteCacheError("invalidData");
        after = next;
      }
      await this.request({ kind: "seal", reader: id }, options.token);
      const reader = new SqliteCacheReader(this, id, options, () => {
        this.readers.delete(reader);
        this.releaseSlot();
      });
      this.readers.add(reader);
      return reader;
    } catch (error) {
      if (opened && this.status.backend === "sqlite") await this.request({ kind: "close", reader: id }).catch(() => undefined);
      this.releaseSlot();
      throw error;
    }
  }

  private async takeSlot(token?: vscode.CancellationToken): Promise<void> {
    while (this.activeSlots >= 3) {
      if (token?.isCancellationRequested) throw new vscode.CancellationError();
      await new Promise<void>(resolve => {
        let cancellation: vscode.Disposable | undefined;
        const wake = (): void => { this.slotWaiters.delete(wake); cancellation?.dispose(); resolve(); };
        cancellation = token?.onCancellationRequested(() => wake());
        this.slotWaiters.add(wake);
        if (token?.isCancellationRequested) wake();
      });
      if (this.disposed || this.closing || this.status.backend !== "sqlite") throw new SqliteCacheError("disposed");
    }
    if (token?.isCancellationRequested) throw new vscode.CancellationError();
    this.activeSlots++;
  }
  private releaseSlot(): void {
    this.activeSlots--;
    this.slotWaiters.values().next().value?.();
  }

  public async beforeStage(token?: vscode.CancellationToken, force = false): Promise<void> {
    if (token?.isCancellationRequested) throw new vscode.CancellationError();
    const active = this.walGate;
    if (active) {
      active.force ||= force;
      await this.waitForWalGate(active.promise, token);
      // A force request can join after the last observation but before the gate is released.
      if (force && !active.checkpointed) await this.beforeStage(token, true);
      return;
    }
    if (!force && ++this.stagedBatches % CHECKPOINT_STAGE_BATCHES !== 0) return;

    const check = async (observe: boolean): Promise<number> => {
      const result = await this.request({ kind: "checkpoint", observe });
      if (!isRecord(result)) throw new SqliteCacheError("invalidData");
      gate.checkpointed ||= !observe;
      return sqliteInteger(result.pendingBytes);
    };
    // Share the observation and the drain. A caller's cancellation must not release another caller's gate.
    const gate: WalCheckpointGate = { force, checkpointed: false, promise: Promise.resolve().then(async () => {
      const observe = !gate.force;
      let pending = await check(observe);
      if (observe && gate.force && pending <= 128 * 1048576) pending = await check(false);
      if (pending <= 128 * 1048576) return;
      const started = Date.now();
      while (await check(false) > 64 * 1048576) {
        if (Date.now() - started >= 2000) throw new SqliteCacheError("walPressure");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }).finally(() => {
      if (this.walGate === gate) this.walGate = undefined;
    }) };
    this.walGate = gate;
    await this.waitForWalGate(gate.promise, token);
  }

  private async waitForWalGate(pending: Promise<void>, token?: vscode.CancellationToken): Promise<void> {
    if (!token) return pending;
    let subscription: vscode.Disposable | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      const cancel = (): void => reject(new vscode.CancellationError());
      subscription = token.onCancellationRequested(cancel);
      if (token.isCancellationRequested) cancel();
    });
    try { await Promise.race([pending, cancelled]); }
    finally { subscription?.dispose(); }
  }

  private scheduleMaintenance(): void {
    if (this.maintenanceTimer || this.closing || this.disposed || this.status.backend !== "sqlite") return;
    this.maintenanceTimer = setTimeout(() => {
      this.maintenanceTimer = undefined;
      void (async () => {
        await this.beforeStage(undefined, true);
        const result = await this.request({ kind: "maintenance" });
        if (isRecord(result) && result.more === true) this.scheduleMaintenance();
      })().catch(() => {
        // The public result is already committed; heartbeat schedules a later maintenance retry.
      });
    }, 50);
    this.maintenanceTimer.unref();
  }

  public dispose(): void { void this.disposeAsync(); }
  public disposeAsync(): Promise<void> {
    if (!this.shutdown) this.shutdown = this.close();
    return this.shutdown;
  }
  private async close(): Promise<void> {
    this.closing = true;
    if (this.maintenanceTimer) { clearTimeout(this.maintenanceTimer); this.maintenanceTimer = undefined; }
    for (const wake of this.slotWaiters) wake();
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = undefined; }
    for (const reader of [...this.readers]) await reader.dispose();
    if (this.status.backend === "sqlite") {
      try { await this.request({ kind: "dispose" }); }
      catch { /* Worker termination below also closes all native handles. */ }
    }
    this.disposed = true;
    await this.client?.stop();
    this.statusEmitter.dispose();
    for (const wake of this.slotWaiters) wake();
  }
}

export class SqliteCacheReader {
  private disposed = false;
  private disposal?: Promise<void>;
  constructor(private readonly store: SqliteCacheStore, private readonly id: string,
    private readonly options: SearchIndexReadOptions, private readonly released: () => void) {}
  public assertActive(): void {
    if (this.disposed || this.options.token?.isCancellationRequested) throw new vscode.CancellationError();
  }
  public async rows(request: SqliteCacheReadRequest, token = this.options.token): Promise<Record<string, unknown>[]> {
    this.assertActive();
    const value = await this.store.request({ ...request, reader: this.id } as SqliteCacheRequest, token);
    if (!Array.isArray(value) || value.length > 256 || value.some(row => !isRecord(row))) return this.store.rejectCorruptData();
    try { if (Buffer.byteLength(JSON.stringify(value), "utf8") > 8 * 1048576 + 2) return this.store.rejectCorruptData(); }
    catch { return this.store.rejectCorruptData(); }
    return value;
  }
  public async *messages(key: string, tools = false): AsyncGenerator<Record<string, unknown>> {
    let after = -1;
    while (true) {
      const rows = await this.rows({ kind: "messages", reader: this.id, key, after, roles: this.options.roles ?? [], tools });
      if (!rows.length) return;
      for (const row of rows) {
        const ordinal = sqliteInteger(row.ordinal);
        if (ordinal <= after) throw new SqliteCacheError("invalidData");
        yield row;
        after = ordinal;
      }
    }
  }
  public async text(message: number, units: number): Promise<string> {
    try {
      const decoder = new SqliteTextDecoder();
      let after = -1;
      while (true) {
        this.assertActive();
        const rows = await this.store.request({ kind: "texts", reader: this.id, message, after }, this.options.token);
        // Sixteen bounded decoded chunks cannot exceed the existing reply memory budget.
        if (!Array.isArray(rows) || rows.length > 16 || rows.some(row => !isRecord(row) || Object.keys(row).length !== 2)) {
          throw new SqliteCacheError("invalidData");
        }
        if (!rows.length) return decoder.finish(units);
        for (const row of rows) { decoder.appendDecoded(row.ordinal, row.text); after = sqliteInteger(row.ordinal); }
        if (rows.length < 16) return decoder.finish(units);
      }
    } catch (error) {
      if (error instanceof SqliteCacheError && error.code === "invalidData") return this.store.rejectCorruptData();
      throw error;
    }
  }
  public async value(key: string): Promise<unknown> {
    try {
      const decoder = new SqliteTextDecoder();
      let after = -1;
      while (true) {
        const rows = await this.rows({ kind: "values", reader: this.id, key, after });
        if (!rows.length) {
          try { return JSON.parse(decoder.finish()); }
          catch { return this.store.rejectCorruptData(); }
        }
        for (const row of rows) { decoder.append(row.ordinal, row.text_json); after = sqliteInteger(row.ordinal); }
      }
    } catch (error) {
      if (error instanceof SqliteCacheError && error.code === "invalidData") return this.store.rejectCorruptData();
      throw error;
    }
  }
  public rejectCorruptData(): Promise<never> { return this.store.rejectCorruptData(); }
  public dispose(): Promise<void> {
    if (!this.disposal) this.disposal = (async () => {
      this.disposed = true;
      try { if (this.store.getStatus().backend === "sqlite") await this.store.request({ kind: "close", reader: this.id }); }
      finally { this.released(); }
    })();
    return this.disposal;
  }
}

export function validateContext(value: unknown): SqliteCacheContext {
  if (!isRecord(value) || typeof value.id !== "string" || !/^[a-f0-9]{64}$/.test(value.id)) throw new SqliteCacheError("invalidData");
  return { id: value.id, head: sqliteInteger(value.head) };
}
function validateRuntime(value: Record<string, unknown>): SqliteRuntimeInfo {
  return { version: sqliteText(value.version, 100), sourceId: sqliteText(value.sourceId, 256),
    foldingRuntimeKey: value.foldingRuntimeKey === null ? null : sqliteText(value.foldingRuntimeKey, 1024) };
}
function validateEntry(value: unknown): SqliteCacheEntry {
  if (!isRecord(value) || !["codex", "claude", "antigravity", "none"].includes(String(value.source))
    || typeof value.semanticDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.semanticDigest)) throw new SqliteCacheError("invalidData");
  return { key: sqliteText(value.key), version: sqliteInteger(value.version, 1), source: value.source as SqliteCacheEntry["source"],
    identity: sqliteText(value.identity), inputSignature: sqliteText(value.inputSignature, 1048576), semanticDigest: value.semanticDigest,
    metadata: sqliteText(value.metadata, 1048576) };
}
