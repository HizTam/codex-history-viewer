import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { isLocalSqliteDisk, isRecord } from "../storage/sqliteRuntime";
import { ANTIGRAVITY_PROFILE, ANTIGRAVITY_UUID, AntigravityReadError } from "./antigravityTypes";
import type { AntigravityErrorCode, AntigravityMetadata, AntigravitySessionLocator } from "./antigravityTypes";
import type { AntigravityCancellationToken, AntigravityReaderRequest, AntigravityReaderResult, AntigravitySessionData, AntigravitySummaryData } from "./antigravityReaderTypes";
import { isAntigravityErrorCode, validateAntigravityRequest, validateAntigravityResult } from "./antigravityReaderValidation";

interface Consumer {
  resolve(value: AntigravityReaderResult): void;
  reject(error: AntigravityReadError): void;
  cancellation?: { dispose(): void };
  isCancelled(): boolean;
}
interface Job {
  readonly id: number;
  readonly generation: number;
  readonly key: string;
  readonly request: AntigravityReaderRequest;
  readonly cancel: Int32Array;
  readonly consumers: Set<Consumer>;
  foreground: boolean;
  deadline?: ReturnType<typeof setTimeout>;
  watchdog?: ReturnType<typeof setTimeout>;
}
interface ResolvedRoots {
  readonly roots: readonly string[];
  readonly failures: number;
}
interface RootRefresh {
  readonly generation: number;
  readonly promise: Promise<{ readonly generation: number; readonly roots: readonly string[] }>;
}
export interface AntigravityReaderStatus {
  readonly state: "disabled" | "idle" | "running" | "stopping" | "unavailable";
  readonly reason?: AntigravityErrorCode;
}

// One controller owns the sole native reader Worker across all history consumers.
export class AntigravityReader {
  private configKey = "";
  private configuration: Promise<readonly string[]> = Promise.resolve([]);
  private rootRefresh?: RootRefresh;
  private generation = 0;
  private roots: readonly string[] = [];
  private resolvedRoots?: readonly string[];
  private disposed = false;
  private enabled = false;
  private configurationFailureCount = 0;
  private worker?: Worker;
  private workerExit?: Promise<void>;
  private stopping = false;
  private stopReason?: AntigravityErrorCode;
  private sequence = 0;
  private active?: Job;
  private readonly queue: Job[] = [];
  private readonly jobs = new Map<string, Job>();
  private status: AntigravityReaderStatus = { state: "disabled" };
  private readonly listeners = new Set<(status: AntigravityReaderStatus) => void>();

  public getStatus(): AntigravityReaderStatus { return this.status; }
  public onDidChangeStatus(listener: (status: AntigravityReaderStatus) => void): { dispose(): void } {
    this.listeners.add(listener); return { dispose: () => { this.listeners.delete(listener); } };
  }
  private setStatus(status: AntigravityReaderStatus): void {
    this.status = Object.freeze(status);
    for (const listener of this.listeners) listener(this.status);
  }
  public configure(roots: readonly string[], enabled: boolean): Promise<readonly string[]> {
    roots = Object.freeze([...roots]);
    const key = JSON.stringify([enabled, roots]);
    if (key === this.configKey) return this.configuration;
    this.configKey = key; const generation = ++this.generation;
    this.enabled = enabled;
    this.roots = []; this.resolvedRoots = undefined; this.configurationFailureCount = 0; this.rejectAll("cancelled");
    if (this.worker) this.stop("cancelled");
    const previousExit = this.workerExit;
    this.configuration = (async () => {
      if (!await this.waitForPreviousWorker(previousExit, generation, roots.length)) return [];
      if (!enabled || this.disposed) { this.resolvedRoots = this.roots; this.setStatus({ state: "disabled" }); return this.roots; }
      const resolved = await this.resolveRoots(roots);
      if (this.disposed || generation !== this.generation) return [];
      return this.publishResolvedRoots(resolved);
    })();
    return this.configuration;
  }
  private async waitForPreviousWorker(exit: Promise<void> | undefined, generation: number, rootCount: number): Promise<boolean> {
    if (exit) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const exited = await Promise.race([exit.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 15000); })]);
      clearTimeout(timer);
      if (this.disposed || generation !== this.generation) return false;
      if (!exited) {
        this.configurationFailureCount = Math.max(1, rootCount); this.worker?.unref();
        this.setStatus({ state: "unavailable", reason: "stalled" }); return false;
      }
    }
    return !this.disposed && generation === this.generation;
  }
  private async resolveRoots(roots: readonly string[], knownRoots: readonly string[] = []): Promise<ResolvedRoots> {
    const canonical = new Set<string>(); let failures = 0;
    for (const root of roots) {
      if (typeof root !== "string" || !path.isAbsolute(root) || root.startsWith("\\\\") || /[\u0000-\u001f]/.test(root)) { failures++; continue; }
      try {
        const resolved = await fs.realpath(root);
        const known = knownRoots.find(value => this.rootKey(value) === this.rootKey(resolved));
        // A current local-disk proof may be reused only for the same canonical directory.
        if (!resolved.startsWith("\\\\") && (await fs.stat(resolved)).isDirectory() && (known || await isLocalSqliteDisk(resolved))) canonical.add(known ?? resolved);
        else failures++;
      } catch (error) { if (!isRecord(error) || error.code !== "ENOENT") failures++; }
    }
    return { roots: Object.freeze([...canonical]), failures };
  }
  private rootKey(root: string): string { return process.platform === "win32" ? root.toLowerCase() : root; }
  private publishResolvedRoots(resolved: ResolvedRoots): readonly string[] {
    this.roots = resolved.roots; this.resolvedRoots = resolved.roots; this.configurationFailureCount = resolved.failures;
    this.setStatus(resolved.failures && !this.roots.length ? { state: "unavailable", reason: "storage" } : { state: "idle" });
    return this.roots;
  }
  private async refreshRoots(roots: readonly string[], key: string, generation: number): Promise<{ generation: number; roots: readonly string[] }> {
    const resolved = await this.resolveRoots(roots, this.roots);
    if (this.disposed || this.configKey !== key || this.generation !== generation) throw new AntigravityReadError("cancelled");
    const sameRoots = resolved.roots.length === this.roots.length && resolved.roots.every((root, index) => this.rootKey(root) === this.rootKey(this.roots[index]!));
    if (sameRoots) {
      if (this.configurationFailureCount !== resolved.failures) {
        this.configurationFailureCount = resolved.failures;
        this.setStatus(this.active || this.stopping ? this.status : resolved.failures && !this.roots.length ? { state: "unavailable", reason: "storage" } : { state: "idle" });
      }
      return { generation, roots: this.roots };
    }
    // Environmental root changes revoke old permissions just like a source configuration change.
    const nextGeneration = ++this.generation;
    // Canonical permissions are known even while the previous Worker is stopping.
    this.resolvedRoots = resolved.roots;
    this.roots = []; this.rejectAll("cancelled");
    if (this.worker && !this.stopping) this.stop("cancelled");
    else this.setStatus(this.status);
    const previousExit = this.workerExit;
    const publication = (async () => {
      if (!await this.waitForPreviousWorker(previousExit, nextGeneration, roots.length)) return [];
      if (this.configKey !== key || this.disposed || this.generation !== nextGeneration) throw new AntigravityReadError("cancelled");
      return this.publishResolvedRoots(resolved);
    })();
    this.configuration = publication;
    const published = await publication;
    return { generation: nextGeneration, roots: published };
  }
  public getRoots(): readonly string[] { return this.roots; }
  public getResolvedRoots(roots: readonly string[], enabled: boolean): readonly string[] | undefined {
    return !this.disposed && this.configKey === JSON.stringify([enabled, roots]) ? this.resolvedRoots : undefined;
  }
  public getConfigurationRevision(): number { return this.generation; }
  public async ready(): Promise<void> {
    const generation = this.generation;
    await this.configuration;
    if (this.disposed || generation !== this.generation) throw new AntigravityReadError("cancelled");
  }
  public async readyFor(roots: readonly string[], enabled: boolean): Promise<readonly string[]> {
    roots = Object.freeze([...roots]);
    const key = JSON.stringify([enabled, roots]);
    if (key !== this.configKey) throw new AntigravityReadError("cancelled");
    const generation = this.generation;
    await this.configuration;
    if (key !== this.configKey || this.disposed || generation !== this.generation) throw new AntigravityReadError("cancelled");
    if (!enabled) return this.roots;
    let refresh = this.rootRefresh;
    if (!refresh || refresh.generation !== generation) {
      refresh = { generation, promise: this.refreshRoots(roots, key, generation) }; this.rootRefresh = refresh;
      const current = refresh;
      const clear = (): void => { if (this.rootRefresh === current) this.rootRefresh = undefined; };
      void refresh.promise.then(clear, clear);
    }
    const result = await refresh.promise;
    if (this.disposed || key !== this.configKey || result.generation !== this.generation || result.roots !== this.roots) throw new AntigravityReadError("cancelled");
    return result.roots;
  }
  public getConfigurationFailureCount(): number { return this.configurationFailureCount; }
  public locator(file: string): AntigravitySessionLocator {
    const id = path.basename(file, ".db");
    const rootPath = this.roots.find(root => file === path.join(root, "conversations", id + ".db"));
    if (!rootPath || !ANTIGRAVITY_UUID.test(id)) throw new AntigravityReadError("storage");
    return Object.freeze({ rootPath, conversationFsPath: file, conversationId: id, schemaProfile: ANTIGRAVITY_PROFILE });
  }
  public async readSession(file: string, token?: AntigravityCancellationToken, includeFileEdits = false, foreground = false): Promise<AntigravitySessionData> {
    await this.ready();
    return this.request({ kind: "session", locator: this.locator(file), ...(includeFileEdits ? { includeFileEdits: true } : {}) }, token, foreground) as Promise<AntigravitySessionData>;
  }
  public async readMetadata(file: string, token?: AntigravityCancellationToken): Promise<AntigravityMetadata> {
    await this.ready();
    return this.request({ kind: "metadata", locator: this.locator(file) }, token) as Promise<AntigravityMetadata>;
  }
  public readSummaries(rootPath: string, token?: AntigravityCancellationToken): Promise<AntigravitySummaryData> {
    return this.request({ kind: "summaries", rootPath }, token) as Promise<AntigravitySummaryData>;
  }
  private request(request: AntigravityReaderRequest, token?: AntigravityCancellationToken, foreground = false): Promise<AntigravityReaderResult> {
    validateAntigravityRequest(request);
    const root = request.kind === "summaries" ? request.rootPath : request.locator.rootPath;
    if (this.disposed || !this.roots.includes(root)) return Promise.reject(new AntigravityReadError("storage"));
    if (this.stopping) return Promise.reject(new AntigravityReadError("stalled"));
    if (token?.isCancellationRequested) return Promise.reject(new AntigravityReadError("cancelled"));
    const key = JSON.stringify([this.generation, request]);
    let job = this.jobs.get(key);
    if (!job) {
      if (this.jobs.size >= 64) return Promise.reject(new AntigravityReadError("busy"));
      const id = ++this.sequence;
      if (!Number.isSafeInteger(id) || typeof SharedArrayBuffer !== "function") return Promise.reject(new AntigravityReadError("runtime"));
      job = { id, key, generation: this.generation, request, cancel: new Int32Array(new SharedArrayBuffer(4)), consumers: new Set(), foreground: false };
      this.jobs.set(key, job); this.queue.push(job);
      const queued = job;
      job.deadline = setTimeout(() => {
        this.rejectJob(queued, "deadline");
        if (this.active === queued) this.stop("deadline"); else this.removeQueued(queued);
      }, 30000); job.deadline.unref();
    }
    if (foreground && !job.foreground && this.active !== job) {
      const index = this.queue.indexOf(job);
      if (index >= 0) {
        this.queue.splice(index, 1);
        const firstBackground = this.queue.findIndex(queued => !queued.foreground);
        this.queue.splice(firstBackground < 0 ? this.queue.length : firstBackground, 0, job);
        job.foreground = true;
      }
    }
    const target = job;
    return new Promise((resolve, reject) => {
      const consumer: Consumer = { resolve, reject, isCancelled: () => token?.isCancellationRequested === true }; target.consumers.add(consumer);
      const onCancel = (): void => {
        if (!target.consumers.delete(consumer)) return;
        consumer.cancellation?.dispose(); consumer.reject(new AntigravityReadError("cancelled"));
        if (!target.consumers.size) {
          Atomics.store(target.cancel, 0, 1);
          this.removeQueued(target);
        }
      };
      consumer.cancellation = token?.onCancellationRequested?.(onCancel);
      if (token && !token.onCancellationRequested) {
        const poll = setInterval(() => { if (token.isCancellationRequested) onCancel(); }, 50); poll.unref();
        consumer.cancellation = { dispose: () => clearInterval(poll) };
      }
      if (token?.isCancellationRequested) {
        target.consumers.delete(consumer); consumer.cancellation?.dispose(); consumer.reject(new AntigravityReadError("cancelled"));
        if (!target.consumers.size) { Atomics.store(target.cancel, 0, 1); this.removeQueued(target); }
      }
      this.pump();
    });
  }
  private removeQueued(job: Job): void {
    const index = this.queue.indexOf(job); if (index >= 0) { this.queue.splice(index, 1); clearTimeout(job.deadline); }
    if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
  }
  private ensureWorker(): Worker {
    if (!this.worker) {
      const worker = new Worker(path.join(__dirname, "antigravityReaderWorker.js")); this.worker = worker;
      let resolveExit!: () => void;
      this.workerExit = new Promise<void>(resolve => { resolveExit = resolve; });
      this.stopReason = undefined;
      worker.on("message", reply => this.receive(reply));
      worker.on("error", () => this.stop("sourceUnavailable"));
      worker.once("exit", () => {
        resolveExit();
        if (this.worker !== worker) return;
        const reason = this.stopReason ?? "sourceUnavailable";
        this.rejectAll(reason);
        this.worker = undefined; this.workerExit = undefined; this.stopping = false;
        if (this.active) this.finish(undefined, new AntigravityReadError(reason));
        if (!this.disposed && this.roots.length) this.setStatus({ state: "unavailable", reason });
      });
    }
    return this.worker;
  }
  private pump(): void {
    if (this.active || this.stopping || this.disposed) return;
    const job = this.queue.shift(); if (!job) return;
    if (job.generation !== this.generation || !job.consumers.size) { this.removeQueued(job); this.pump(); return; }
    this.active = job; this.setStatus({ state: "running" });
    this.watch(job);
    try { const worker = this.ensureWorker(); worker.ref(); worker.postMessage({ id: job.id, request: job.request, cancel: job.cancel.buffer }); }
    catch { this.stop("runtime"); }
  }
  private watch(job: Job): void {
    clearTimeout(job.watchdog);
    job.watchdog = setTimeout(() => this.stop("stalled"), 15000); job.watchdog.unref();
  }
  private receive(reply: unknown): void {
    const job = this.active;
    if (!job || this.stopping) return;
    if (!isRecord(reply) || reply.id !== job.id) { this.stop("format"); return; }
    if (reply.progress === true) { this.watch(job); return; }
    if (typeof reply.ok !== "boolean") { this.stop("format"); return; }
    if (!reply.ok) { this.finish(undefined, new AntigravityReadError(isAntigravityErrorCode(reply.code) ? reply.code : "format")); return; }
    if (!job.consumers.size || job.generation !== this.generation || Atomics.load(job.cancel, 0)) { this.finish(undefined, new AntigravityReadError("cancelled")); return; }
    try {
      const result = validateAntigravityResult(job.request, reply.result);
      this.finish(result, job.generation !== this.generation || Atomics.load(job.cancel, 0) ? new AntigravityReadError("cancelled") : undefined);
    } catch { this.stop("format"); }
  }
  private finish(result?: AntigravityReaderResult, error?: AntigravityReadError): void {
    const job = this.active; if (!job) return;
    this.active = undefined; clearTimeout(job.deadline); clearTimeout(job.watchdog);
    if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
    for (const consumer of job.consumers) {
      consumer.cancellation?.dispose();
      if (error || !result || consumer.isCancelled()) consumer.reject(error ?? new AntigravityReadError(consumer.isCancelled() ? "cancelled" : "format"));
      else consumer.resolve(result);
    }
    job.consumers.clear();
    if (!this.stopping) this.worker?.unref();
    if (!this.stopping && !this.disposed) this.setStatus(!this.enabled ? { state: "disabled" } : error ? { state: "unavailable", reason: error.code } : { state: "idle" });
    queueMicrotask(() => this.pump());
  }
  private rejectJob(job: Job, code: AntigravityErrorCode): void {
    Atomics.store(job.cancel, 0, 1);
    for (const consumer of job.consumers) { consumer.cancellation?.dispose(); consumer.reject(new AntigravityReadError(code)); }
    job.consumers.clear();
  }
  private rejectAll(code: AntigravityErrorCode): void {
    for (const job of this.jobs.values()) this.rejectJob(job, code);
    for (const job of this.queue.splice(0)) { clearTimeout(job.deadline); this.jobs.delete(job.key); }
  }
  private stop(code: AntigravityErrorCode): void {
    if (this.stopping) return;
    this.stopping = true; this.stopReason = code; this.rejectAll(code); this.setStatus({ state: "stopping", reason: code });
    const worker = this.worker;
    if (!worker) { this.stopping = false; this.finish(undefined, new AntigravityReadError(code)); return; }
    worker.ref();
    // Termination requests never grant permission to start another Worker before its exit event.
    void worker.terminate().catch(() => { this.setStatus({ state: "unavailable", reason: "stalled" }); });
  }
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.generation++; this.roots = []; this.stop("cancelled"); this.listeners.clear();
  }
}

export const antigravityReader = new AntigravityReader();
