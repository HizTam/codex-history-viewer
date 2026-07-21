import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import type { CodexHistoryViewerConfig } from "../settings";
import { isBoundedSessionIdentityKey } from "../sessions/sessionIdentity";
import type { SessionSummary } from "../sessions/sessionTypes";
import { SESSION_ANALYSIS_INDEX_FILE_NAME } from "../storage/cacheFiles";
import {
  formatJsonReadOrDropCorruptDebug,
  isFileNotFoundError,
  readJsonOrDropCorrupt,
  writeJson,
} from "../storage/jsonStorage";
import type { DebugLogger } from "../services/logger";
import { normalizeCacheKey } from "../utils/fsUtils";
import {
  buildUnsupportedSessionAnalysisEntry,
  ClaudeSessionAnalysisAdapter,
  CodexSessionAnalysisAdapter,
} from "./sessionAnalysisAdapter";
import {
  isSessionAnalysisGraphIdentifier,
  isSessionAnalysisProjectCwd,
  isSessionAnalysisTimestamp,
  SESSION_ANALYSIS_CACHE_SCHEMA_VERSION,
  SESSION_ANALYSIS_CLAUDE_PARSER_VERSION,
  SESSION_ANALYSIS_CODEX_PARSER_VERSION,
  SESSION_ANALYSIS_MAX_CACHE_ENTRIES,
  SESSION_ANALYSIS_MAX_FILE_CHANGE_ENTRIES,
  SESSION_ANALYSIS_MAX_PATH_LENGTH,
  SESSION_ANALYSIS_PATH_NORMALIZATION_VERSION,
  type SessionAnalysisCacheContext,
  type SessionAnalysisCacheFile,
  type SessionAnalysisEntry,
  type SessionAnalysisProgress,
  type SessionAnalysisResult,
} from "./sessionAnalysisTypes";

const YIELD_INTERVAL = 8;
export const SESSION_ANALYSIS_MAX_FILE_SIZE_BYTES = 256 * 1024 * 1024;

export interface SessionAnalysisCacheRetentionCandidate {
  cacheKey: string;
  mtimeMs: number;
  lastActivityAtIso?: string;
  startedAtIso?: string;
}

export interface AnalysisCancellationToken {
  readonly isCancellationRequested: boolean;
  readonly onCancellationRequested?: (
    listener: () => unknown,
  ) => { dispose(): unknown };
}

export interface EnsureSessionAnalysisOptions {
  sessions: readonly SessionSummary[];
  activeSessions: readonly SessionSummary[];
  config: CodexHistoryViewerConfig;
  token?: AnalysisCancellationToken;
  onProgress?: (progress: SessionAnalysisProgress) => void;
}

export interface StoredSessionAnalysisResult {
  entries: SessionAnalysisEntry[];
  generatedAtIso: string;
}

export class SessionAnalysisCancelledError extends Error {
  constructor() {
    super("Session analysis was cancelled.");
    this.name = "SessionAnalysisCancelledError";
  }
}

interface SharedBuildOutcome {
  entry: SessionAnalysisEntry;
  cacheHit: boolean;
}

interface SharedBuildConsumer {
  id: number;
  job: SharedBuildJob;
  sessions: readonly SessionSummary[];
  sessionKeys: ReadonlySet<string>;
  token?: AnalysisCancellationToken;
  onProgress?: (progress: SessionAnalysisProgress) => void;
  completedKeys: Set<string>;
  cacheHitCount: number;
  rebuiltCount: number;
  failedCount: number;
  settled: boolean;
  cancellationRegistration?: { dispose(): unknown };
  resolve(result: SessionAnalysisResult): void;
  reject(error: unknown): void;
}

interface SharedBuildJob {
  context: SessionAnalysisCacheContext;
  config: CodexHistoryViewerConfig;
  consumers: Map<number, SharedBuildConsumer>;
  sessionsByCacheKey: Map<string, SessionSummary>;
  activeKeys: Set<string>;
  pendingKeys: string[];
  pendingIndex: number;
  queuedKeys: Set<string>;
  outcomes: Map<string, SharedBuildOutcome>;
  accepting: boolean;
  committing: boolean;
  cacheLoaded: boolean;
  completion: Promise<void>;
}

interface SharedBuildAttachment {
  result?: Promise<SessionAnalysisResult>;
  waitFor?: Promise<void>;
}

export class SessionAnalysisIndexService {
  private readonly cacheUri: vscode.Uri;
  private readonly logger?: DebugLogger;
  private readonly codexAdapter = new CodexSessionAnalysisAdapter();
  private readonly claudeAdapter = new ClaudeSessionAnalysisAdapter();
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private cache: SessionAnalysisCacheFile | null = null;
  private readonly inFlightByCacheKey = new Map<string, Promise<SessionAnalysisEntry>>();
  private saveQueue: Promise<void> = Promise.resolve();
  private operationQueue: Promise<void> = Promise.resolve();
  private sharedBuildJob: SharedBuildJob | null = null;
  private nextConsumerId = 0;

  constructor(globalStorageUri: vscode.Uri, logger?: DebugLogger) {
    this.cacheUri = vscode.Uri.joinPath(globalStorageUri, SESSION_ANALYSIS_INDEX_FILE_NAME);
    this.logger = logger;
  }

  public async ensureEntries(options: EnsureSessionAnalysisOptions): Promise<SessionAnalysisResult> {
    this.throwIfCancelled(options.token);
    const context = buildSessionAnalysisCacheContext(options.config);
    while (true) {
      const attachment = await this.runExclusive(async (): Promise<SharedBuildAttachment> => {
        const current = this.sharedBuildJob;
        if (
          current &&
          (
            !current.accepting ||
            !sameCacheContext(current.context, context) ||
            hasConflictingRequestedSession(current, options.sessions)
          )
        ) {
          return { waitFor: current.completion };
        }
        const job = current ?? this.startSharedBuildJob(context, options.config);
        return { result: this.attachSharedBuildConsumer(job, options) };
      });
      if (attachment.result) return attachment.result;
      await attachment.waitFor?.catch(() => undefined);
      this.throwIfCancelled(options.token);
    }
  }

  public async rebuildAll(options: EnsureSessionAnalysisOptions): Promise<SessionAnalysisResult> {
    return this.runExclusive(async () => {
      await this.waitForSharedBuildJob();
      this.throwIfCancelled(options.token);
      try {
        await vscode.workspace.fs.delete(this.cacheUri, { recursive: false, useTrash: false });
      } catch (error) {
        if (!isFileNotFoundError(error)) throw error;
      }
      this.loaded = true;
      this.cache = null;
      this.throwIfCancelled(options.token);
      return this.ensureEntriesCore(options, true);
    });
  }

  public async getStoredEntries(
    sessions: readonly SessionSummary[],
    config: CodexHistoryViewerConfig,
  ): Promise<StoredSessionAnalysisResult> {
    return this.runExclusive(async () => {
      const context = buildSessionAnalysisCacheContext(config);
      await this.ensureLoaded(context);
      if (!this.cache || !sameCacheContext(this.cache.context, context)) {
        return { entries: [], generatedAtIso: new Date(0).toISOString() };
      }
      const entries = sessions.flatMap((session) => {
        const entry = this.cache?.entries[session.cacheKey];
        return entry && isEntryForSession(entry, session) ? [entry] : [];
      });
      return { entries, generatedAtIso: this.cache.generatedAtIso };
    });
  }

  private startSharedBuildJob(
    context: SessionAnalysisCacheContext,
    config: CodexHistoryViewerConfig,
  ): SharedBuildJob {
    const job: SharedBuildJob = {
      context,
      config,
      consumers: new Map(),
      sessionsByCacheKey: new Map(),
      activeKeys: new Set(),
      pendingKeys: [],
      pendingIndex: 0,
      queuedKeys: new Set(),
      outcomes: new Map(),
      accepting: true,
      committing: false,
      cacheLoaded: false,
      completion: Promise.resolve(),
    };
    this.sharedBuildJob = job;
    job.completion = Promise.resolve()
      .then(() => this.runSharedBuildJob(job))
      .catch((error) => {
        this.rejectSharedBuildConsumers(job, error);
      })
      .finally(() => {
        job.accepting = false;
        if (this.sharedBuildJob === job) this.sharedBuildJob = null;
      });
    return job;
  }

  private attachSharedBuildConsumer(
    job: SharedBuildJob,
    options: EnsureSessionAnalysisOptions,
  ): Promise<SessionAnalysisResult> {
    let resolve!: (result: SessionAnalysisResult) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<SessionAnalysisResult>((resolveResult, rejectResult) => {
      resolve = resolveResult;
      reject = rejectResult;
    });
    const sessions = Array.from(options.sessions);
    const consumer: SharedBuildConsumer = {
      id: ++this.nextConsumerId,
      job,
      sessions,
      sessionKeys: new Set(sessions.map((session) => session.cacheKey)),
      ...(options.token ? { token: options.token } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      completedKeys: new Set(),
      cacheHitCount: 0,
      rebuiltCount: 0,
      failedCount: 0,
      settled: false,
      resolve,
      reject,
    };
    job.consumers.set(consumer.id, consumer);
    try {
      const registration = options.token?.onCancellationRequested?.(() => {
        this.cancelSharedBuildConsumer(consumer);
      });
      consumer.cancellationRegistration = registration;
      if (consumer.settled) disposeCancellationRegistration(consumer);
    } catch {
      consumer.cancellationRegistration = undefined;
    }
    if (options.token?.isCancellationRequested) this.cancelSharedBuildConsumer(consumer);
    if (consumer.settled) return result;
    for (const session of options.activeSessions) job.activeKeys.add(session.cacheKey);
    for (const session of sessions) {
      job.activeKeys.add(session.cacheKey);
      if (!job.sessionsByCacheKey.has(session.cacheKey)) job.sessionsByCacheKey.set(session.cacheKey, session);
      const outcome = job.outcomes.get(session.cacheKey);
      if (outcome) {
        this.applySharedBuildOutcome(consumer, session.cacheKey, outcome);
      } else if (!job.queuedKeys.has(session.cacheKey)) {
        job.queuedKeys.add(session.cacheKey);
        job.pendingKeys.push(session.cacheKey);
      }
    }
    this.notifySharedBuildConsumer(
      consumer,
      progressOf("loadCache", job.cacheLoaded ? 1 : 0, 1, consumer.cacheHitCount, consumer.rebuiltCount),
    );
    if (job.cacheLoaded) {
      this.notifySharedBuildConsumer(
        consumer,
        progressOf(
          "collectSessions",
          consumer.sessionKeys.size,
          consumer.sessionKeys.size,
          consumer.cacheHitCount,
          consumer.rebuiltCount,
        ),
      );
      if (consumer.completedKeys.size > 0) {
        this.notifySharedBuildConsumer(consumer, {
          phase: "analyzeSessions",
          completed: consumer.completedKeys.size,
          total: consumer.sessionKeys.size,
          cancellable: true,
          cacheHitCount: consumer.cacheHitCount,
          rebuiltCount: consumer.rebuiltCount,
        });
      }
    }
    return result;
  }

  private async runSharedBuildJob(job: SharedBuildJob): Promise<void> {
    await this.ensureLoaded(job.context);
    job.cacheLoaded = true;
    this.pruneCancelledSharedBuildConsumers(job);
    if (!hasActiveSharedBuildConsumer(job)) throw new SessionAnalysisCancelledError();
    for (const consumer of job.consumers.values()) {
      if (consumer.settled) continue;
      this.notifySharedBuildConsumer(
        consumer,
        progressOf("loadCache", 1, 1, consumer.cacheHitCount, consumer.rebuiltCount),
      );
      this.notifySharedBuildConsumer(
        consumer,
        progressOf(
          "collectSessions",
          consumer.sessionKeys.size,
          consumer.sessionKeys.size,
          consumer.cacheHitCount,
          consumer.rebuiltCount,
        ),
      );
    }

    const { cache, contextChanged } = this.createWorkingCache(job.context);
    let cacheChanged = contextChanged;
    let processed = 0;
    while (true) {
      this.pruneCancelledSharedBuildConsumers(job);
      if (!hasActiveSharedBuildConsumer(job)) throw new SessionAnalysisCancelledError();
      let cacheKey = nextSharedBuildCacheKey(job);
      if (!cacheKey) {
        await yieldToEventLoop();
        this.pruneCancelledSharedBuildConsumers(job);
        if (!hasActiveSharedBuildConsumer(job)) throw new SessionAnalysisCancelledError();
        cacheKey = nextSharedBuildCacheKey(job);
        if (!cacheKey) {
          job.accepting = false;
          break;
        }
      }
      if (!isSharedBuildCacheKeyRequested(job, cacheKey)) continue;
      const session = job.sessionsByCacheKey.get(cacheKey);
      if (!session) continue;
      const stat = await statSessionFile(session.fsPath);
      this.pruneCancelledSharedBuildConsumers(job);
      if (!hasActiveSharedBuildConsumer(job)) throw new SessionAnalysisCancelledError();
      if (!isSharedBuildCacheKeyRequested(job, cacheKey)) continue;
      const cached = cache.entries[cacheKey];
      let outcome: SharedBuildOutcome;
      if (cached && stat && isEntryFresh(cached, session, stat.mtimeMs, stat.size)) {
        outcome = { entry: cached, cacheHit: true };
      } else {
        const entry = await this.getOrBuildEntry(session, stat, job.config);
        cache.entries[cacheKey] = entry;
        cacheChanged = true;
        outcome = { entry, cacheHit: false };
      }
      job.outcomes.set(cacheKey, outcome);
      for (const consumer of job.consumers.values()) {
        if (consumer.settled || !consumer.sessionKeys.has(cacheKey)) continue;
        this.applySharedBuildOutcome(consumer, cacheKey, outcome);
        this.notifySharedBuildConsumer(consumer, {
          phase: "analyzeSessions",
          completed: consumer.completedKeys.size,
          total: consumer.sessionKeys.size,
          currentSource: session.source,
          cancellable: true,
          cacheHitCount: consumer.cacheHitCount,
          rebuiltCount: consumer.rebuiltCount,
        });
      }
      processed += 1;
      if (processed % YIELD_INTERVAL === 0) await yieldToEventLoop();
    }

    this.pruneCancelledSharedBuildConsumers(job);
    if (!hasActiveSharedBuildConsumer(job)) throw new SessionAnalysisCancelledError();
    cacheChanged = removeOrphanEntries(cache.entries, job.activeKeys) || cacheChanged;
    if (cacheChanged) {
      cache.generatedAtIso = new Date().toISOString();
      try {
        await this.saveCache(cache, () => this.beginSharedBuildCommit(job));
      } catch (error) {
        if (error instanceof SessionAnalysisCancelledError) throw error;
        if (!job.committing) this.beginSharedBuildCommit(job);
        this.logger?.debug(`analysis.cache write failed error=${sanitizeErrorName(error)}`);
      }
      this.cache = cache;
    }
    this.resolveSharedBuildConsumers(job, cache);
  }

  private applySharedBuildOutcome(
    consumer: SharedBuildConsumer,
    cacheKey: string,
    outcome: SharedBuildOutcome,
  ): void {
    if (consumer.settled || consumer.completedKeys.has(cacheKey)) return;
    consumer.completedKeys.add(cacheKey);
    if (outcome.cacheHit) {
      consumer.cacheHitCount += 1;
    } else {
      consumer.rebuiltCount += 1;
      if (outcome.entry.completeness === "failed") consumer.failedCount += 1;
    }
  }

  private resolveSharedBuildConsumers(
    job: SharedBuildJob,
    cache: SessionAnalysisCacheFile,
  ): void {
    for (const consumer of job.consumers.values()) {
      if (consumer.settled) continue;
      const entries: SessionAnalysisEntry[] = [];
      let complete = true;
      for (const session of consumer.sessions) {
        const outcome = job.outcomes.get(session.cacheKey);
        if (!outcome) {
          complete = false;
          break;
        }
        entries.push(outcome.entry);
      }
      if (!complete) {
        this.rejectSharedBuildConsumer(
          consumer,
          new Error("Session analysis shared build completed without all requested entries."),
        );
        continue;
      }
      consumer.settled = true;
      disposeCancellationRegistration(consumer);
      consumer.resolve({
        entries,
        cacheHitCount: consumer.cacheHitCount,
        rebuiltCount: consumer.rebuiltCount,
        failedCount: consumer.failedCount,
        generatedAtIso: cache.generatedAtIso,
      });
    }
  }

  private rejectSharedBuildConsumers(job: SharedBuildJob, error: unknown): void {
    for (const consumer of job.consumers.values()) {
      if (!consumer.settled) this.rejectSharedBuildConsumer(consumer, error);
    }
  }

  private rejectSharedBuildConsumer(consumer: SharedBuildConsumer, error: unknown): void {
    if (consumer.settled) return;
    consumer.settled = true;
    disposeCancellationRegistration(consumer);
    consumer.reject(error);
  }

  private cancelSharedBuildConsumer(consumer: SharedBuildConsumer): void {
    if (consumer.job.committing) return;
    this.rejectSharedBuildConsumer(consumer, new SessionAnalysisCancelledError());
  }

  private pruneCancelledSharedBuildConsumers(job: SharedBuildJob): void {
    if (job.committing) return;
    for (const consumer of job.consumers.values()) {
      if (!consumer.settled && consumer.token?.isCancellationRequested) {
        this.cancelSharedBuildConsumer(consumer);
      }
    }
  }

  private beginSharedBuildCommit(job: SharedBuildJob): void {
    if (job.committing) return;
    this.pruneCancelledSharedBuildConsumers(job);
    if (!hasActiveSharedBuildConsumer(job)) throw new SessionAnalysisCancelledError();
    job.committing = true;
  }

  private notifySharedBuildConsumer(
    consumer: SharedBuildConsumer,
    progress: SessionAnalysisProgress,
  ): void {
    if (!consumer.settled && consumer.token?.isCancellationRequested) {
      this.cancelSharedBuildConsumer(consumer);
    }
    if (consumer.settled || !consumer.onProgress) return;
    try {
      consumer.onProgress(progress);
    } catch (error) {
      this.logger?.debug(`analysis.progress callback failed error=${sanitizeErrorName(error)}`);
    }
  }

  private async waitForSharedBuildJob(): Promise<void> {
    await this.sharedBuildJob?.completion.catch(() => undefined);
  }

  private async ensureEntriesCore(
    options: EnsureSessionAnalysisOptions,
    requirePersistence = false,
  ): Promise<SessionAnalysisResult> {
    const context = buildSessionAnalysisCacheContext(options.config);
    options.onProgress?.(progressOf("loadCache", 0, 1, 0, 0));
    await this.ensureLoaded(context);
    this.throwIfCancelled(options.token);
    options.onProgress?.(progressOf("loadCache", 1, 1, 0, 0));

    const { cache, contextChanged } = this.createWorkingCache(context);
    const activeKeys = new Set(options.activeSessions.map((session) => session.cacheKey));
    let cacheChanged = contextChanged || removeOrphanEntries(cache.entries, activeKeys);
    options.onProgress?.(progressOf("collectSessions", options.sessions.length, options.sessions.length, 0, 0));

    const entries: SessionAnalysisEntry[] = [];
    let cacheHitCount = 0;
    let rebuiltCount = 0;
    let failedCount = 0;
    for (let index = 0; index < options.sessions.length; index += 1) {
      this.throwIfCancelled(options.token);
      const session = options.sessions[index]!;
      const stat = await statSessionFile(session.fsPath);
      const cached = cache.entries[session.cacheKey];
      if (cached && stat && isEntryFresh(cached, session, stat.mtimeMs, stat.size)) {
        entries.push(cached);
        cacheHitCount += 1;
      } else {
        const entry = await this.getOrBuildEntry(session, stat, options.config);
        cache.entries[session.cacheKey] = entry;
        entries.push(entry);
        cacheChanged = true;
        rebuiltCount += 1;
        if (entry.completeness === "failed") failedCount += 1;
      }
      options.onProgress?.({
        phase: "analyzeSessions",
        completed: index + 1,
        total: options.sessions.length,
        currentSource: session.source,
        cancellable: true,
        cacheHitCount,
        rebuiltCount,
      });
      if ((index + 1) % YIELD_INTERVAL === 0) await yieldToEventLoop();
    }

    this.throwIfCancelled(options.token);
    if (cacheChanged) {
      cache.generatedAtIso = new Date().toISOString();
      if (requirePersistence) {
        await this.saveCache(cache, () => this.throwIfCancelled(options.token));
        this.cache = cache;
      } else {
        try {
          await this.saveCache(cache);
        } catch (error) {
          this.logger?.debug(`analysis.cache write failed error=${sanitizeErrorName(error)}`);
        }
        this.cache = cache;
      }
    }
    return {
      entries,
      cacheHitCount,
      rebuiltCount,
      failedCount,
      generatedAtIso: cache.generatedAtIso,
    };
  }

  public getCachedEntry(cacheKey: string): SessionAnalysisEntry | undefined {
    return this.cache?.entries[cacheKey];
  }

  public async clear(): Promise<void> {
    await this.runExclusive(async () => {
      await this.waitForSharedBuildJob();
      this.loaded = true;
      this.cache = null;
      try {
        await vscode.workspace.fs.delete(this.cacheUri, { recursive: false, useTrash: false });
      } catch {
        // Missing or locked cache files are rebuilt on the next request.
      }
    });
  }

  private async ensureLoaded(context: SessionAnalysisCacheContext): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        const outcome = await readJsonOrDropCorrupt<unknown>(this.cacheUri);
        const debug = formatJsonReadOrDropCorruptDebug("analysis.cache", outcome);
        if (debug) this.logger?.debug(debug);
        if (outcome.result.ok) this.cache = sanitizeSessionAnalysisCache(outcome.result.value, context);
        this.loaded = true;
      })().finally(() => {
        this.loadPromise = null;
      });
    }
    await this.loadPromise;
  }

  private createWorkingCache(context: SessionAnalysisCacheContext): {
    cache: SessionAnalysisCacheFile;
    contextChanged: boolean;
  } {
    if (!this.cache || !sameCacheContext(this.cache.context, context)) {
      return {
        contextChanged: true,
        cache: {
          version: SESSION_ANALYSIS_CACHE_SCHEMA_VERSION,
          context,
          generatedAtIso: new Date(0).toISOString(),
          entries: {},
        },
      };
    }
    return {
      contextChanged: false,
      cache: {
        ...this.cache,
        entries: { ...this.cache.entries },
      },
    };
  }

  private async getOrBuildEntry(
    session: SessionSummary,
    stat: { mtimeMs: number; size: number } | null,
    config: CodexHistoryViewerConfig,
  ): Promise<SessionAnalysisEntry> {
    const existing = this.inFlightByCacheKey.get(session.cacheKey);
    if (existing) return existing;
    const input = {
      session,
      mtimeMs: stat?.mtimeMs ?? 0,
      size: stat?.size ?? 0,
      claudeSessionsRoot: config.claudeSessionsRoot,
    };
    const build = stat && !isSessionAnalysisFileSizeSupported(stat.size)
      ? Promise.resolve(buildUnsupportedSessionAnalysisEntry(input, "fileSizeLimit"))
      : (session.source === "codex" ? this.codexAdapter : this.claudeAdapter).analyze(input);
    this.inFlightByCacheKey.set(session.cacheKey, build);
    try {
      return await build;
    } finally {
      if (this.inFlightByCacheKey.get(session.cacheKey) === build) this.inFlightByCacheKey.delete(session.cacheKey);
    }
  }

  private async saveCache(
    cache: SessionAnalysisCacheFile,
    beforeCommit?: () => void,
  ): Promise<void> {
    const boundedEntries = buildBoundedPersistedCacheEntries(cache.entries);
    if (boundedEntries.omittedCount > 0) {
      this.logger?.debug(
        `analysis.cache persistence bounded retained=${Object.keys(boundedEntries.entries).length} omitted=${boundedEntries.omittedCount}`,
      );
    }
    const snapshot: SessionAnalysisCacheFile = {
      ...cache,
      entries: boundedEntries.entries,
    };
    this.saveQueue = this.saveQueue
      .catch(() => undefined)
      .then(async () => {
        await writeJson(this.cacheUri, snapshot, { pretty: false, ...(beforeCommit ? { beforeCommit } : {}) });
      });
    await this.saveQueue;
  }

  private throwIfCancelled(token: AnalysisCancellationToken | undefined): void {
    if (token?.isCancellationRequested) throw new SessionAnalysisCancelledError();
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release!: () => void;
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export function isSessionAnalysisFileSizeSupported(size: number): boolean {
  return Number.isSafeInteger(size) && size >= 0 && size <= SESSION_ANALYSIS_MAX_FILE_SIZE_BYTES;
}

export function selectSessionAnalysisCacheRetentionKeys(
  candidates: Iterable<SessionAnalysisCacheRetentionCandidate>,
  limit = SESSION_ANALYSIS_MAX_CACHE_ENTRIES,
): string[] {
  const boundedLimit = Number.isSafeInteger(limit) && limit >= 0 ? limit : 0;
  if (boundedLimit === 0) return [];
  const ordered = Array.from(candidates).sort(compareCacheRetentionCandidate);
  const retained: string[] = [];
  const seen = new Set<string>();
  for (const candidate of ordered) {
    if (seen.has(candidate.cacheKey)) continue;
    seen.add(candidate.cacheKey);
    retained.push(candidate.cacheKey);
    if (retained.length >= boundedLimit) break;
  }
  return retained;
}

export function buildBoundedPersistedCacheEntries(
  entries: Readonly<Record<string, SessionAnalysisEntry>>,
  limit = SESSION_ANALYSIS_MAX_CACHE_ENTRIES,
): { entries: Record<string, SessionAnalysisEntry>; omittedCount: number } {
  const boundedLimit = Number.isSafeInteger(limit) && limit >= 0 ? limit : 0;
  const cacheKeys = Object.keys(entries);
  if (cacheKeys.length <= boundedLimit) {
    return { entries: { ...entries }, omittedCount: 0 };
  }
  const retainedKeys = selectSessionAnalysisCacheRetentionKeys(
    cacheKeys.map((cacheKey) => entries[cacheKey]!),
    boundedLimit,
  );
  const retainedEntries: Record<string, SessionAnalysisEntry> = {};
  for (const cacheKey of retainedKeys) retainedEntries[cacheKey] = entries[cacheKey]!;
  return {
    entries: retainedEntries,
    omittedCount: cacheKeys.length - retainedKeys.length,
  };
}

function compareCacheRetentionCandidate(
  left: SessionAnalysisCacheRetentionCandidate,
  right: SessionAnalysisCacheRetentionCandidate,
): number {
  if (left.mtimeMs !== right.mtimeMs) return left.mtimeMs > right.mtimeMs ? -1 : 1;
  const leftActivity = left.lastActivityAtIso ?? "";
  const rightActivity = right.lastActivityAtIso ?? "";
  if (leftActivity !== rightActivity) return leftActivity > rightActivity ? -1 : 1;
  const leftStarted = left.startedAtIso ?? "";
  const rightStarted = right.startedAtIso ?? "";
  if (leftStarted !== rightStarted) return leftStarted > rightStarted ? -1 : 1;
  if (left.cacheKey === right.cacheKey) return 0;
  return left.cacheKey < right.cacheKey ? -1 : 1;
}

function hasConflictingRequestedSession(
  job: SharedBuildJob,
  sessions: readonly SessionSummary[],
): boolean {
  for (const session of sessions) {
    const existing = job.sessionsByCacheKey.get(session.cacheKey);
    if (!existing) continue;
    if (
      existing.source !== session.source ||
      existing.identityKey !== session.identityKey ||
      existing.fsPath !== session.fsPath ||
      existing.storage.rootKind !== session.storage.rootKind ||
      existing.storage.archiveState !== session.storage.archiveState
    ) {
      return true;
    }
  }
  return false;
}

function hasActiveSharedBuildConsumer(job: SharedBuildJob): boolean {
  for (const consumer of job.consumers.values()) {
    if (!consumer.settled) return true;
  }
  return false;
}

function isSharedBuildCacheKeyRequested(job: SharedBuildJob, cacheKey: string): boolean {
  for (const consumer of job.consumers.values()) {
    if (!consumer.settled && consumer.sessionKeys.has(cacheKey)) return true;
  }
  return false;
}

function nextSharedBuildCacheKey(job: SharedBuildJob): string | undefined {
  while (job.pendingIndex < job.pendingKeys.length) {
    const cacheKey = job.pendingKeys[job.pendingIndex++];
    if (!cacheKey) continue;
    job.queuedKeys.delete(cacheKey);
    if (job.outcomes.has(cacheKey)) continue;
    return cacheKey;
  }
  return undefined;
}

function disposeCancellationRegistration(consumer: SharedBuildConsumer): void {
  try {
    consumer.cancellationRegistration?.dispose();
  } catch {
    // Cancellation cleanup must not change the consumer result.
  }
  consumer.cancellationRegistration = undefined;
}

export function buildSessionAnalysisCacheContext(config: CodexHistoryViewerConfig): SessionAnalysisCacheContext {
  return {
    codexSessionsRoot: config.sessionsRoot,
    codexArchivedSessionsRoot: config.codexArchivedSessionsRoot,
    claudeSessionsRoot: config.claudeSessionsRoot,
    includeCodex: config.enableCodexSource,
    includeCodexArchived: config.enableCodexArchivedSessions,
    includeClaude: config.enableClaudeSource,
    codexParserVersion: SESSION_ANALYSIS_CODEX_PARSER_VERSION,
    claudeParserVersion: SESSION_ANALYSIS_CLAUDE_PARSER_VERSION,
    pathNormalizationVersion: SESSION_ANALYSIS_PATH_NORMALIZATION_VERSION,
  };
}

export function sanitizeSessionAnalysisCache(
  value: unknown,
  expectedContext: SessionAnalysisCacheContext,
): SessionAnalysisCacheFile | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== SESSION_ANALYSIS_CACHE_SCHEMA_VERSION) return null;
  if (!sameCacheContextExceptParserVersions(raw.context, expectedContext)) return null;
  if (!raw.entries || typeof raw.entries !== "object" || Array.isArray(raw.entries)) return null;
  const entries = raw.entries as Record<string, unknown>;
  if (Object.keys(entries).length > SESSION_ANALYSIS_MAX_CACHE_ENTRIES) return null;
  const sanitizedEntries: Record<string, SessionAnalysisEntry> = {};
  for (const [key, entry] of Object.entries(entries)) {
    if (!isSessionAnalysisEntry(entry, key)) continue;
    const expectedParserVersion = entry.source === "codex"
      ? expectedContext.codexParserVersion
      : expectedContext.claudeParserVersion;
    if (entry.parserVersion !== expectedParserVersion) continue;
    sanitizedEntries[key] = entry;
  }
  return {
    version: SESSION_ANALYSIS_CACHE_SCHEMA_VERSION,
    context: expectedContext,
    generatedAtIso: isSessionAnalysisTimestamp(raw.generatedAtIso)
      ? raw.generatedAtIso
      : new Date(0).toISOString(),
    entries: sanitizedEntries,
  };
}

function sameCacheContextExceptParserVersions(
  left: unknown,
  right: SessionAnalysisCacheContext,
): left is SessionAnalysisCacheContext {
  if (!left || typeof left !== "object") return false;
  const raw = left as Record<string, unknown>;
  return (
    raw.codexSessionsRoot === right.codexSessionsRoot &&
    raw.codexArchivedSessionsRoot === right.codexArchivedSessionsRoot &&
    raw.claudeSessionsRoot === right.claudeSessionsRoot &&
    raw.includeCodex === right.includeCodex &&
    raw.includeCodexArchived === right.includeCodexArchived &&
    raw.includeClaude === right.includeClaude &&
    isSafeNonNegativeInteger(raw.codexParserVersion) &&
    isSafeNonNegativeInteger(raw.claudeParserVersion) &&
    raw.pathNormalizationVersion === right.pathNormalizationVersion
  );
}

function sameCacheContext(left: unknown, right: SessionAnalysisCacheContext): left is SessionAnalysisCacheContext {
  if (!sameCacheContextExceptParserVersions(left, right)) return false;
  return (
    left.codexParserVersion === right.codexParserVersion &&
    left.claudeParserVersion === right.claudeParserVersion
  );
}

function isSessionAnalysisEntry(value: unknown, key: string): value is SessionAnalysisEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<SessionAnalysisEntry>;
  if (key.length === 0 || key.length > SESSION_ANALYSIS_MAX_PATH_LENGTH) return false;
  if (entry.cacheKey !== key || (entry.source !== "codex" && entry.source !== "claude")) return false;
  if (entry.completeness !== "complete" && entry.completeness !== "partial" && entry.completeness !== "unsupported" && entry.completeness !== "failed") return false;
  if (typeof entry.fsPath !== "string" || entry.fsPath.length > SESSION_ANALYSIS_MAX_PATH_LENGTH || !pathIsAbsolute(entry.fsPath)) return false;
  if (!isBoundedSessionIdentityKey(entry.identityKey)) return false;
  if (!isSafeNonNegativeNumber(entry.mtimeMs) || !isSafeNonNegativeInteger(entry.size) || !isSafeNonNegativeInteger(entry.parserVersion)) return false;
  if (!isStorageLocation(entry.storage) || !isMessageStats(entry.messageStats)) return false;
  const usageStats = entry.usageStats;
  if (!isUsageStats(usageStats) || !isFileChangeStats(entry.fileChangeStats)) return false;
  if (entry.source === "claude" && usageStats.modelEffortUsage.length !== 0) return false;
  if (!isOptionalSessionAnalysisProjectCwd(entry.projectCwd)) return false;
  if (!isOptionalSessionAnalysisTimestamp(entry.startedAtIso) ||
    !isOptionalSessionAnalysisTimestamp(entry.lastActivityAtIso)) return false;
  if (!isRateLimitSnapshot(entry.latestRateLimitSnapshot, key)) return false;
  if (!Array.isArray(entry.claudeGraphRecords) || entry.claudeGraphRecords.length > 100_000) return false;
  const occurrenceIds = new Set<string>();
  for (const record of entry.claudeGraphRecords) {
    if (!isClaudeGraphRecord(record, entry) || occurrenceIds.has(record.occurrenceId)) return false;
    occurrenceIds.add(record.occurrenceId);
  }
  if (entry.source === "claude") {
    if (!isClaudeMessageBounds(entry.claudeMessageBounds)) return false;
  } else if (entry.claudeMessageBounds !== undefined) {
    return false;
  }
  if (!isOptionalBoundedString(entry.claudePhysicalProjectFolderKey, 1024)) return false;
  if (entry.claudeIsSidechain !== undefined && entry.claudeIsSidechain !== true && entry.claudeIsSidechain !== false && entry.claudeIsSidechain !== "unknown") return false;
  if (!Array.isArray(entry.warnings) || entry.warnings.length > 100) return false;
  if (!entry.warnings.every((warning) => typeof warning === "string" && warning.length <= 1024)) return false;
  return true;
}

function isStorageLocation(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  return (
    (raw.rootKind === "codexSessions" || raw.rootKind === "codexArchivedSessions" || raw.rootKind === "claudeSessions") &&
    (raw.archiveState === "active" || raw.archiveState === "archived") &&
    typeof raw.rootPath === "string" && raw.rootPath.length <= SESSION_ANALYSIS_MAX_PATH_LENGTH
  );
}

function isMessageStats(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  if (![
    "userMessageCount", "assistantMessageCount", "developerMessageCount", "toolCallCount", "toolOutputCount",
    "turnCount", "completedTurnCount", "interruptedTurnCount", "rolledBackTurnCount",
  ].every((key) => isAnalysisNumber(raw[key]))) return false;
  if (!Array.isArray(raw.toolUsage) || raw.toolUsage.length > 2_000) return false;
  const names = new Set<string>();
  return raw.toolUsage.every((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const usage = value as Record<string, unknown>;
    if (typeof usage.name !== "string" || usage.name.length === 0 || usage.name.length > 256 || names.has(usage.name)) return false;
    names.add(usage.name);
    return isSafeNonNegativeInteger(usage.callCount);
  });
}

function isUsageStats(value: unknown): value is SessionAnalysisEntry["usageStats"] {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  if (!["inputTokens", "outputTokens", "cachedInputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "reasoningOutputTokens", "reportedTotalTokens", "derivedTotalTokens"].every((key) => isAnalysisNumber(raw[key]))) return false;
  if (!["codexLastUsageSum", "codexCumulativeFallback", "claudeMessageSum", "mixedPartial", "unavailable"].includes(String(raw.aggregationMethod))) return false;
  if (!Array.isArray(raw.modelUsage) || raw.modelUsage.length > 2_000) return false;
  const modelTotals = new Map<string, number>();
  for (const value of raw.modelUsage) {
    if (!value || typeof value !== "object") return false;
    const model = value as Record<string, unknown>;
    if (typeof model.model !== "string" || model.model.length === 0 || model.model.length > 512 ||
      !isSafeNonNegativeInteger(model.inputTokens) || !isSafeNonNegativeInteger(model.outputTokens) ||
      !isSafeNonNegativeInteger(model.totalTokens) || modelTotals.has(model.model)) return false;
    modelTotals.set(model.model, model.totalTokens as number);
  }
  if (!Array.isArray(raw.modelEffortUsage) || raw.modelEffortUsage.length > 2_000) return false;
  const pairs = new Set<string>();
  const effortTotals = new Map<string, number>();
  for (const value of raw.modelEffortUsage) {
    if (!value || typeof value !== "object") return false;
    const usage = value as Record<string, unknown>;
    if (typeof usage.model !== "string" || usage.model.length === 0 || usage.model.length > 512 ||
      typeof usage.effort !== "string" || usage.effort.length === 0 || usage.effort.length > 80 ||
      !isSafeNonNegativeInteger(usage.totalTokens)) return false;
    const pair = JSON.stringify([usage.model, usage.effort]);
    if (pairs.has(pair)) return false;
    pairs.add(pair);
    const total = (effortTotals.get(usage.model) ?? 0) + (usage.totalTokens as number);
    if (!Number.isSafeInteger(total) || total > (modelTotals.get(usage.model) ?? -1)) return false;
    effortTotals.set(usage.model, total);
  }
  return true;
}

function isFileChangeStats(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  if (!["changeEventCount", "distinctFileCount", "linesAdded", "linesRemoved"].every((key) => isAnalysisNumber(raw[key]))) return false;
  if (!Array.isArray(raw.files) || raw.files.length > SESSION_ANALYSIS_MAX_FILE_CHANGE_ENTRIES) return false;
  const normalizedPaths = new Set<string>();
  for (const value of raw.files) {
    if (!value || typeof value !== "object") return false;
    const file = value as Record<string, unknown>;
    if (
      typeof file.normalizedPath !== "string" ||
      file.normalizedPath.length > SESSION_ANALYSIS_MAX_PATH_LENGTH ||
      !pathIsAbsolute(file.normalizedPath) ||
      typeof file.displayPath !== "string" ||
      file.displayPath.length > 512 ||
      !isSafeNonNegativeInteger(file.changeEventCount) ||
      !isSafeNonNegativeInteger(file.linesAdded) ||
      !isSafeNonNegativeInteger(file.linesRemoved) ||
      !isOptionalSessionAnalysisTimestamp(file.firstTimestampIso) ||
      !isOptionalSessionAnalysisTimestamp(file.lastTimestampIso) ||
      (file.chatMessageIndex !== undefined && !isSafePositiveInteger(file.chatMessageIndex))
    ) {
      return false;
    }
    const normalizedPath = normalizeCacheKey(file.normalizedPath);
    if (normalizedPaths.has(normalizedPath)) return false;
    normalizedPaths.add(normalizedPath);
  }
  return true;
}

function isRateLimitSnapshot(value: unknown, cacheKey: string): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  const planTypeValid = isOptionalNonBlankBoundedString(raw.planType, 512);
  const limitNameValid = isOptionalNonBlankBoundedString(raw.limitName, 512);
  const hasSnapshotValue =
    raw.primary !== undefined ||
    raw.secondary !== undefined ||
    raw.planType !== undefined ||
    raw.limitName !== undefined;
  return hasSnapshotValue &&
    raw.sourceSessionCacheKey === cacheKey &&
    raw.recordedBy === "localSession" &&
    isOptionalSessionAnalysisTimestamp(raw.observedAtIso) &&
    planTypeValid &&
    limitNameValid &&
    isRateLimitValue(raw.primary) &&
    isRateLimitValue(raw.secondary);
}

function isRateLimitValue(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  const keys = ["usedPercent", "windowMinutes", "resetsAt", "resetsInSeconds"] as const;
  return keys.some((key) => raw[key] !== undefined) &&
    keys.every((key) =>
      raw[key] === undefined ||
      (key === "usedPercent" ? isSafeNonNegativeNumber(raw[key]) : isSafeNonNegativeInteger(raw[key]))
    );
}

function isClaudeGraphRecord(value: unknown, entry: Partial<SessionAnalysisEntry>): boolean {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.occurrenceId === "string" && /^[a-f0-9]{64}$/u.test(raw.occurrenceId) &&
    raw.sessionCacheKey === entry.cacheKey && raw.sessionIdentityKey === entry.identityKey &&
    typeof raw.type === "string" && raw.type.length <= 512 && typeof raw.textFingerprint === "string" &&
    raw.textFingerprint.length <= 128 && typeof raw.preview === "string" && raw.preview.length <= 512 &&
    isSafePositiveInteger(raw.chatMessageIndex) && isSafePositiveInteger(raw.recordOrdinal) &&
    typeof raw.isMeta === "boolean" && typeof raw.compactBoundary === "boolean" &&
    isClaudeVisibleMessageAnchor(raw.previousVisibleMessage, true) &&
    (raw.isSidechain === undefined || typeof raw.isSidechain === "boolean") &&
    isOptionalSessionAnalysisTimestamp(raw.timestampIso) &&
    ["sessionId", "recordUuid", "parentUuid", "visibleParentUuid", "logicalParentUuid", "promptId", "requestId", "subtype"].every(
      (key) => isOptionalSessionAnalysisGraphIdentifier(raw[key]),
    );
}

function isClaudeMessageBounds(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return isClaudeVisibleMessageAnchor(raw.first, true) && isClaudeVisibleMessageAnchor(raw.last, true);
}

function isClaudeVisibleMessageAnchor(value: unknown, optional: boolean): boolean {
  if (value === undefined) return optional;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return (raw.role === "user" || raw.role === "assistant") &&
    isSafePositiveInteger(raw.chatMessageIndex) &&
    isOptionalSessionAnalysisTimestamp(raw.timestampIso) &&
    isOptionalBoundedString(raw.preview, 512);
}

function isAnalysisNumber(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  if (raw.availability !== "available" && raw.availability !== "partial" && raw.availability !== "unavailable") return false;
  if (raw.availability === "unavailable") return raw.value === undefined;
  return isSafeNonNegativeInteger(raw.value);
}

function isOptionalBoundedString(value: unknown, maxLength: number): boolean {
  return value === undefined || (typeof value === "string" && value.length <= maxLength);
}

function isOptionalNonBlankBoundedString(value: unknown, maxLength: number): boolean {
  return value === undefined ||
    (typeof value === "string" && value.length <= maxLength && value.trim().length > 0);
}

function isOptionalSessionAnalysisTimestamp(value: unknown): boolean {
  return value === undefined || isSessionAnalysisTimestamp(value);
}

function isOptionalSessionAnalysisProjectCwd(value: unknown): boolean {
  return value === undefined || isSessionAnalysisProjectCwd(value);
}

function isOptionalSessionAnalysisGraphIdentifier(value: unknown): boolean {
  return value === undefined || isSessionAnalysisGraphIdentifier(value);
}

function isSafeNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return isSafeNonNegativeNumber(value) && Number.isInteger(value);
}

function isSafePositiveInteger(value: unknown): value is number {
  return isSafeNonNegativeInteger(value) && value > 0;
}

function pathIsAbsolute(value: string): boolean {
  return /^([A-Za-z]:[\\/]|\\\\|\/)/u.test(value);
}

function removeOrphanEntries(entries: Record<string, SessionAnalysisEntry>, activeKeys: ReadonlySet<string>): boolean {
  let changed = false;
  for (const key of Object.keys(entries)) {
    if (activeKeys.has(key)) continue;
    delete entries[key];
    changed = true;
  }
  return changed;
}

function isEntryFresh(
  entry: SessionAnalysisEntry,
  session: SessionSummary,
  mtimeMs: number,
  size: number,
): boolean {
  const parserVersion =
    session.source === "codex" ? SESSION_ANALYSIS_CODEX_PARSER_VERSION : SESSION_ANALYSIS_CLAUDE_PARSER_VERSION;
  return (
    isEntryForSession(entry, session) &&
    entry.mtimeMs === mtimeMs &&
    entry.size === size &&
    entry.parserVersion === parserVersion
  );
}

function isEntryForSession(entry: SessionAnalysisEntry, session: SessionSummary): boolean {
  return entry.source === session.source && entry.identityKey === session.identityKey &&
    entry.fsPath === session.fsPath && entry.storage.rootKind === session.storage.rootKind &&
    entry.storage.archiveState === session.storage.archiveState;
}

async function statSessionFile(fsPath: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const stat = await fs.stat(fsPath);
    return stat.isFile() ? { mtimeMs: stat.mtimeMs, size: stat.size } : null;
  } catch {
    return null;
  }
}

function progressOf(
  phase: SessionAnalysisProgress["phase"],
  completed: number,
  total: number,
  cacheHitCount: number,
  rebuiltCount: number,
): SessionAnalysisProgress {
  return { phase, completed, total, cancellable: true, cacheHitCount, rebuiltCount };
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function sanitizeErrorName(error: unknown): string {
  const raw = error instanceof Error ? error.name : "UnknownError";
  return raw.replace(/[^A-Za-z0-9_.-]/gu, "").slice(0, 80) || "UnknownError";
}
