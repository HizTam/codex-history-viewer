import * as vscode from "vscode";
import type { CodexHistoryViewerConfig, HistoryDateBasis } from "../settings";
import { findSessionFiles, type DiscoveredSessionFile } from "../sessions/sessionDiscovery";
import type { HistoryIndex, HistoryRoots, SessionSummary } from "../sessions/sessionTypes";
import { buildSessionSummary, tryReadSessionMeta } from "../sessions/sessionSummary";
import { sanitizeCachedCodexAgentMetadata } from "../agents/codexAgentMetadata";
import { sanitizeCachedCodexForkMetadata } from "../branchMap/codexForkMetadata";
import { resolveSessionDisplayTitle, resolveSessionDisplayTitles } from "../sessions/sessionTitleResolver";
import { normalizeCacheKey } from "../utils/fsUtils";
import { HISTORY_CACHE_FILE_NAME, HISTORY_CACHE_FILE_PATTERN } from "../storage/cacheFiles";
import { formatJsonReadOrDropCorruptDebug, readJsonOrDropCorrupt, writeJson } from "../storage/jsonStorage";
import {
  getDateTimeSettingsKey,
  resolveDateTimeSettings,
  type DateTimeSettings,
} from "../utils/dateTimeSettings";
import { CodexTitleStore } from "./codexTitleStore";
import type { SessionTitleOverrideStore } from "./sessionTitleOverrideStore";
import type { DebugLogger } from "./logger";
import { sanitizeDebugError } from "./debugLogUtils";
import { isBoundedSessionIdentityKey } from "../sessions/sessionIdentity";

interface CacheEntryV1 {
  mtimeMs: number;
  size: number;
  summary: SessionSummary;
  codexAgentMetadataVersion?: 1;
}

const SUMMARY_CACHE_ALGO_VERSION = 12;
const HISTORY_REFRESH_CONCURRENCY = 4;

interface CacheFileV9 {
  version: 9;
  summaryAlgoVersion: number;
  codexAgentMetadataVersion?: 1;
  codexSessionsRoot: string;
  codexArchivedSessionsRoot: string;
  claudeSessionsRoot: string;
  includeCodex: boolean;
  includeCodexArchived: boolean;
  includeClaude: boolean;
  previewMaxMessages: number;
  dateTimeSettingsKey: string;
  entries: Record<string, CacheEntryV1>;
}

interface HistoryOperationContext {
  config: CodexHistoryViewerConfig;
  configRevision: number;
}

interface NormalizedCacheEntries {
  entries: Record<string, CacheEntryV1>;
  dropped: number;
}

export interface CodexAgentMetadataBackfillResult {
  complete: boolean;
  updated: number;
  failed: number;
  cancelled: boolean;
}

interface RefreshFileResult {
  cacheKey?: string;
  entry?: CacheEntryV1;
  summary?: SessionSummary;
  statMiss: number;
  cacheHit: number;
  cacheMiss: number;
  summaryOk: number;
  summaryFailed: number;
  summaryMs: number;
}

interface HistoryBuildMetrics {
  files: number;
  discoverMs: number;
  processMs: number;
  statMiss: number;
  cacheHit: number;
  cacheMiss: number;
  summaryOk: number;
  summaryFailed: number;
  summaryMs: number;
  titleMs: number;
}

interface HistoryBuildResult {
  index: HistoryIndex;
  cache: CacheFileV9;
  verifiedCacheKeys: Set<string>;
  metadataComplete: boolean;
  metrics: HistoryBuildMetrics;
}

export interface HistoryRebuildSnapshot {
  readonly config: Readonly<CodexHistoryViewerConfig>;
  readonly dateTimeSettingsKey: string;
  readonly index: HistoryIndex;
  readonly sessions: readonly SessionSummary[];
  readonly adopted: boolean;
}

class HistoryOperationSupersededError extends Error {
  constructor() {
    super("History operation was superseded by a configuration change.");
    this.name = "HistoryOperationSupersededError";
  }
}

export function isHistoryOperationSupersededError(error: unknown): boolean {
  return error instanceof HistoryOperationSupersededError;
}

function applyHistoryDateBasis(summary: SessionSummary, historyDateBasis: HistoryDateBasis): SessionSummary {
  const localDate =
    historyDateBasis === "lastActivity" ? summary.lastActivityLocalDate : summary.startedLocalDate;
  const timeLabel =
    historyDateBasis === "lastActivity" ? summary.lastActivityTimeLabel : summary.startedTimeLabel;
  return { ...summary, localDate, timeLabel };
}

function sortSummariesByDisplayDate(summaries: SessionSummary[]): void {
  summaries.sort((a, b) => {
    if (a.localDate !== b.localDate) return a.localDate < b.localDate ? 1 : -1;
    return a.timeLabel < b.timeLabel ? 1 : a.timeLabel > b.timeLabel ? -1 : 0;
  });
}

function selectPreferredSummariesByIdentity(summaries: readonly SessionSummary[]): SessionSummary[] {
  const byIdentity = new Map<string, SessionSummary>();
  for (const summary of summaries) {
    const current = byIdentity.get(summary.identityKey);
    if (!current || compareIdentityCandidate(summary, current) < 0) {
      byIdentity.set(summary.identityKey, summary);
    }
  }
  return Array.from(byIdentity.values());
}

function compareIdentityCandidate(left: SessionSummary, right: SessionSummary): number {
  if (left.storage.archiveState !== right.storage.archiveState) {
    return left.storage.archiveState === "active" ? -1 : 1;
  }
  const leftTime = Date.parse(left.lastActivityAtIso ?? left.startedAtIso ?? "");
  const rightTime = Date.parse(right.lastActivityAtIso ?? right.startedAtIso ?? "");
  const leftMs = Number.isFinite(leftTime) ? leftTime : 0;
  const rightMs = Number.isFinite(rightTime) ? rightTime : 0;
  if (leftMs !== rightMs) return rightMs - leftMs;
  return left.cacheKey.localeCompare(right.cacheKey);
}

async function cleanupObsoleteHistoryCacheFiles(
  globalStorageUri: vscode.Uri,
  currentCacheFileName: string,
): Promise<void> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(globalStorageUri);
  } catch {
    return;
  }

  const deletions = entries
    .filter(([name, type]) => (type & vscode.FileType.File) !== 0 && HISTORY_CACHE_FILE_PATTERN.test(name))
    .filter(([name]) => name.toLowerCase() !== currentCacheFileName.toLowerCase())
    .map(([name]) => vscode.Uri.joinPath(globalStorageUri, name));

  for (const fileUri of deletions) {
    try {
      await vscode.workspace.fs.delete(fileUri, { recursive: false, useTrash: false });
    } catch {
      // Ignore cleanup failures and keep the current cache usable.
    }
  }
}

function buildHistoryRoots(config: CodexHistoryViewerConfig): HistoryRoots {
  return {
    codexSessionsRoot: config.sessionsRoot,
    codexArchivedSessionsRoot: config.codexArchivedSessionsRoot,
    claudeSessionsRoot: config.claudeSessionsRoot,
  };
}

function emptyIndex(roots: HistoryRoots): HistoryIndex {
  return {
    sessionsRoot: roots.codexSessionsRoot,
    roots,
    sessions: [],
    byCacheKey: new Map(),
    byIdentityKey: new Map(),
    byYmd: new Map(),
    byYm: new Map(),
    byY: new Map(),
  };
}

export class HistoryService {
  private readonly globalStorageUri: vscode.Uri;
  private readonly codexTitleStore: CodexTitleStore;
  private readonly titleOverrideStore: SessionTitleOverrideStore;
  private readonly logger?: DebugLogger;
  private config: CodexHistoryViewerConfig;
  private configKey: string;
  private configRevision = 0;
  private index: HistoryIndex;
  private indexGeneration = 0;
  private indexInventoryGeneration = 0;
  private indexConfigKey = "";
  private cacheForCurrentIndex: CacheFileV9 | null = null;
  private cacheIndexGeneration = -1;
  private codexAgentMetadataComplete = false;
  private codexAgentMetadataVerifiedCacheKeys = new Set<string>();
  private codexAgentMetadataBackfillPromise: Promise<CodexAgentMetadataBackfillResult> | null = null;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    globalStorageUri: vscode.Uri,
    config: CodexHistoryViewerConfig,
    titleOverrideStore: SessionTitleOverrideStore,
    logger?: DebugLogger,
  ) {
    this.globalStorageUri = globalStorageUri;
    this.codexTitleStore = new CodexTitleStore(globalStorageUri);
    this.titleOverrideStore = titleOverrideStore;
    this.logger = logger;
    this.config = config;
    this.configKey = getHistoryServiceConfigKey(config);
    this.index = emptyIndex(buildHistoryRoots(config));
  }

  public updateConfig(config: CodexHistoryViewerConfig): void {
    const nextKey = getHistoryServiceConfigKey(config);
    if (nextKey !== this.configKey) {
      this.configKey = nextKey;
      this.configRevision += 1;
    }
    this.config = config;
  }

  private captureOperationContext(): HistoryOperationContext {
    return {
      config: { ...this.config },
      configRevision: this.configRevision,
    };
  }

  private isOperationContextCurrent(context: HistoryOperationContext): boolean {
    return (
      context.configRevision === this.configRevision &&
      getHistoryServiceConfigKey(context.config) === this.configKey
    );
  }

  private commitIndexState(params: {
    index: HistoryIndex;
    cache: CacheFileV9;
    configKey: string;
    verifiedCacheKeys: Set<string>;
    metadataComplete: boolean;
    preserveInventoryGeneration?: boolean;
  }): number {
    this.index = params.index;
    this.indexConfigKey = params.configKey;
    this.codexAgentMetadataVerifiedCacheKeys = params.verifiedCacheKeys;
    this.codexAgentMetadataComplete = params.metadataComplete;
    if (!params.preserveInventoryGeneration) this.indexInventoryGeneration += 1;
    this.indexGeneration += 1;
    this.cacheForCurrentIndex = params.cache;
    this.cacheIndexGeneration = this.indexGeneration;
    return this.indexGeneration;
  }

  public getIndex(): HistoryIndex {
    return this.index;
  }

  public getIndexGeneration(): number {
    return this.indexGeneration;
  }

  public getIndexInventoryGeneration(): number {
    return this.indexInventoryGeneration;
  }

  public isCurrentIndexForConfig(config: CodexHistoryViewerConfig): boolean {
    const requestedConfigKey = getHistoryServiceConfigKey(config);
    const dateTimeSettingsKey = getDateTimeSettingsKey(resolveDateTimeSettings());
    return Boolean(
      requestedConfigKey === this.configKey &&
      this.indexConfigKey === requestedConfigKey &&
      this.cacheIndexGeneration === this.indexGeneration &&
      this.cacheForCurrentIndex &&
      this.isFreshCache(this.cacheForCurrentIndex, dateTimeSettingsKey, config)
    );
  }

  public hasCompleteCodexAgentMetadata(): boolean {
    return this.codexAgentMetadataComplete;
  }

  public isCodexAgentMetadataVerified(session: SessionSummary): boolean {
    return session.source !== "codex" || this.codexAgentMetadataVerifiedCacheKeys.has(session.cacheKey);
  }

  public findByFsPath(fsPath: string): SessionSummary | undefined {
    const key = normalizeCacheKey(fsPath);
    return this.index.byCacheKey.get(key);
  }

  public async resolveDisplaySummary(
    summary: SessionSummary,
    configSnapshot: CodexHistoryViewerConfig,
  ): Promise<SessionSummary> {
    const config = { ...configSnapshot };
    const codexTitlesById =
      summary.source === "codex" && summary.meta.id
        ? await this.codexTitleStore.getTitles({
            sessionsRoot: config.sessionsRoot,
            sessionIds: [summary.meta.id],
            pruneToSessionIds: false,
          })
        : new Map<string, string>();

    return resolveSessionDisplayTitle({
      session: summary,
      titleSource: config.historyTitleSource,
      codexTitlesById,
      customTitle: this.titleOverrideStore.getTitle(summary),
    });
  }

  public loadCachedIndexIfFresh(): Promise<boolean> {
    return this.enqueueOperation(() => this.loadCachedIndexIfFreshCore());
  }

  private async loadCachedIndexIfFreshCore(): Promise<boolean> {
    const operation = this.captureOperationContext();
    const { config } = operation;
    const startedAt = nowMs();
    const dateTime = resolveDateTimeSettings();
    const dateTimeSettingsKey = getDateTimeSettingsKey(dateTime);
    const cache = await this.readCacheFile();
    if (!this.isFreshCache(cache, dateTimeSettingsKey, config)) {
      this.logger?.debug(`history.cacheImmediate miss totalMs=${elapsedMs(startedAt)}`);
      return false;
    }

    const normalized = normalizeCacheEntries(cache.entries);
    if (normalized.dropped > 0) {
      this.logger?.debug(
        `history.cacheImmediate invalidEntries=${normalized.dropped} totalMs=${elapsedMs(startedAt)}`,
      );
      return false;
    }
    const normalizedCache = normalizeCacheFile(cache, normalized.entries);
    const roots = buildHistoryRoots(config);
    const summaries = Object.values(normalized.entries)
      .map((entry) => applyHistoryDateBasis(entry.summary, config.historyDateBasis));
    const selectedSummaries = selectPreferredSummariesByIdentity(summaries);
    const resolvedSummaries = await this.resolveDisplayTitles(selectedSummaries, config);
    sortSummariesByDisplayDate(resolvedSummaries);
    if (!this.isOperationContextCurrent(operation)) {
      this.logger?.debug(`history.cacheImmediate superseded totalMs=${elapsedMs(startedAt)}`);
      return false;
    }
    const nextIndex = buildIndex(roots, resolvedSummaries);
    const verifiedCacheKeys = collectVerifiedCodexMetadataCacheKeys(normalized.entries);
    const metadataComplete = isCompleteCodexAgentMetadataCache(
      normalizedCache,
      normalized.entries,
      nextIndex,
    );
    this.commitIndexState({
      index: nextIndex,
      cache: normalizedCache,
      configKey: getHistoryServiceConfigKey(operation.config),
      verifiedCacheKeys,
      metadataComplete,
    });
    this.logger?.debug(
      [
        "history.cacheImmediate loaded",
        `totalMs=${elapsedMs(startedAt)}`,
        `entries=${Object.keys(normalized.entries).length}`,
        `sessions=${resolvedSummaries.length}`,
      ].join(" "),
    );
    return true;
  }

  public ensureCodexAgentMetadata(options: {
    shouldApply?: () => boolean;
    onProgress?: (completed: number, total: number) => void;
  } = {}): Promise<CodexAgentMetadataBackfillResult> {
    if (this.codexAgentMetadataBackfillPromise) return this.codexAgentMetadataBackfillPromise;

    const task = this.enqueueOperation(async () => {
      if (options.shouldApply && !options.shouldApply()) {
        return { complete: false, updated: 0, failed: 0, cancelled: true };
      }
      if (this.codexAgentMetadataComplete) {
        return { complete: true, updated: 0, failed: 0, cancelled: false };
      }
      return this.ensureCodexAgentMetadataCore(options);
    }).finally(() => {
      if (this.codexAgentMetadataBackfillPromise === task) this.codexAgentMetadataBackfillPromise = null;
    });
    this.codexAgentMetadataBackfillPromise = task;
    return task;
  }

  private async ensureCodexAgentMetadataCore(options: {
    shouldApply?: () => boolean;
    onProgress?: (completed: number, total: number) => void;
  }): Promise<CodexAgentMetadataBackfillResult> {
    const operation = this.captureOperationContext();
    const generation = this.indexGeneration;
    const dateTimeSettingsKey = getDateTimeSettingsKey(resolveDateTimeSettings());
    const cache =
      this.cacheIndexGeneration === generation &&
      this.cacheForCurrentIndex &&
      this.isFreshCache(this.cacheForCurrentIndex, dateTimeSettingsKey, operation.config)
        ? this.cacheForCurrentIndex
        : null;
    if (!cache) {
      return { complete: false, updated: 0, failed: 0, cancelled: false };
    }

    const normalized = normalizeCacheEntries(cache.entries);
    if (normalized.dropped > 0) {
      this.logger?.debug(`codexAgentRuns metadata cache invalidEntries=${normalized.dropped}`);
      return { complete: false, updated: 0, failed: normalized.dropped, cancelled: false };
    }
    const entries = normalized.entries;

    const targets = Object.entries(entries).filter(([, entry]) =>
      entry.summary.source === "codex" && entry.codexAgentMetadataVersion !== 1
    );
    let completed = 0;
    const results = await mapWithConcurrency(targets, HISTORY_REFRESH_CONCURRENCY, async ([key, entry]) => {
      try {
        const meta = await tryReadSessionMeta(entry.summary.fsPath);
        if (!meta || meta.historySource !== "codex") {
          throw new Error("Codex session metadata was not found");
        }
        const sanitized = sanitizeCachedCodexAgentMetadata(meta.codexAgent);
        if (!sanitized.valid) throw new Error("Invalid Codex agent metadata");
        const nextMeta = { ...entry.summary.meta };
        if (sanitized.value) nextMeta.codexAgent = sanitized.value;
        else delete nextMeta.codexAgent;
        return {
          key,
          entry: {
            ...entry,
            summary: { ...entry.summary, meta: nextMeta },
            codexAgentMetadataVersion: 1 as const,
          },
          ok: true as const,
        };
      } catch (error) {
        this.logger?.debug(`codexAgentRuns metadata backfill failed error=${sanitizeDebugError(error)}`);
        return { key, entry, ok: false as const };
      } finally {
        completed += 1;
        options.onProgress?.(completed, targets.length);
      }
    });

    const cancelled =
      generation !== this.indexGeneration ||
      !this.isOperationContextCurrent(operation) ||
      (options.shouldApply ? !options.shouldApply() : false);
    if (cancelled) return { complete: false, updated: 0, failed: 0, cancelled: true };

    let updated = 0;
    let failed = 0;
    for (const result of results) {
      if (result.ok) {
        entries[result.key] = result.entry;
        updated += 1;
      } else {
        failed += 1;
      }
    }

    const updatedByCacheKey = new Map(
      Object.values(entries).map((entry) => [entry.summary.cacheKey, entry.summary.meta.codexAgent] as const),
    );
    const nextSummaries = this.index.sessions.map((summary) => {
      if (summary.source !== "codex" || !updatedByCacheKey.has(summary.cacheKey)) return summary;
      const nextMeta = { ...summary.meta };
      const codexAgent = updatedByCacheKey.get(summary.cacheKey);
      if (codexAgent) nextMeta.codexAgent = codexAgent;
      else delete nextMeta.codexAgent;
      return { ...summary, meta: nextMeta };
    });

    const nextIndex = buildIndex(this.index.roots, nextSummaries);
    const complete = areAllCodexEntriesVerifiedForIndex(entries, nextIndex);
    const nextCache: CacheFileV9 = {
      ...cache,
      codexAgentMetadataVersion: complete ? 1 : undefined,
      entries,
    };
    const verifiedCacheKeys = collectVerifiedCodexMetadataCacheKeys(entries);
    if (
      generation !== this.indexGeneration ||
      !this.isOperationContextCurrent(operation) ||
      (options.shouldApply ? !options.shouldApply() : false)
    ) {
      return { complete: false, updated: 0, failed: 0, cancelled: true };
    }
    const committedGeneration = this.commitIndexState({
      index: nextIndex,
      cache: nextCache,
      configKey: getHistoryServiceConfigKey(operation.config),
      verifiedCacheKeys,
      metadataComplete: complete,
      preserveInventoryGeneration: true,
    });
    let supersededDuringWrite = false;
    try {
      await writeJson(this.getCacheUri(), nextCache, {
        beforeCommit: () => {
          if (
            !this.isOperationContextCurrent(operation) ||
            this.indexGeneration !== committedGeneration ||
            this.cacheForCurrentIndex !== nextCache ||
            (options.shouldApply ? !options.shouldApply() : false)
          ) {
            throw new HistoryOperationSupersededError();
          }
        },
      });
    } catch (error) {
      if (error instanceof HistoryOperationSupersededError) {
        supersededDuringWrite = true;
      } else {
        this.logger?.debug(`codexAgentRuns metadata cache write failed error=${sanitizeDebugError(error)}`);
      }
    }
    if (
      supersededDuringWrite ||
      !this.isOperationContextCurrent(operation) ||
      (options.shouldApply ? !options.shouldApply() : false)
    ) {
      return { complete: false, updated: 0, failed: 0, cancelled: true };
    }
    return { complete, updated, failed, cancelled: false };
  }

  public refresh(options: { forceRebuildCache: boolean; shouldStart?: () => boolean }): Promise<void> {
    return this.enqueueOperation(() => {
      if (options.shouldStart && !options.shouldStart()) {
        throw new HistoryOperationSupersededError();
      }
      return this.refreshCore(options);
    });
  }

  public rebuildSnapshot(
    config: CodexHistoryViewerConfig,
    token?: vscode.CancellationToken,
    dateTime?: DateTimeSettings,
  ): Promise<HistoryRebuildSnapshot> {
    const configSnapshot = cloneHistoryConfig(config);
    const dateTimeSnapshot = Object.freeze({ ...(dateTime ?? resolveDateTimeSettings()) });
    const dateTimeSettingsKey = getDateTimeSettingsKey(dateTimeSnapshot);
    return this.enqueueOperation(() =>
      this.rebuildSnapshotCore(configSnapshot, dateTimeSnapshot, dateTimeSettingsKey, token),
    );
  }

  private async rebuildSnapshotCore(
    config: CodexHistoryViewerConfig,
    dateTime: DateTimeSettings,
    dateTimeSettingsKey: string,
    token?: vscode.CancellationToken,
  ): Promise<HistoryRebuildSnapshot> {
    const totalStartedAt = nowMs();
    throwIfHistoryRebuildCancelled(token);
    const built = await this.buildHistoryState({
      config,
      dateTime,
      dateTimeSettingsKey,
      cachedEntries: {},
      token,
    });
    throwIfHistoryRebuildCancelled(token);

    const writeCacheStartedAt = nowMs();
    await writeJson(this.getCacheUri(), built.cache, {
      beforeCommit: () => throwIfHistoryRebuildCancelled(token),
    });
    const writeCacheMs = elapsedMs(writeCacheStartedAt);

    const currentDateTimeSettingsKey = getDateTimeSettingsKey(resolveDateTimeSettings());
    const adopted =
      getHistoryServiceConfigKey(config) === this.configKey &&
      dateTimeSettingsKey === currentDateTimeSettingsKey;
    if (adopted) {
      this.commitIndexState({
        index: built.index,
        cache: built.cache,
        configKey: getHistoryServiceConfigKey(config),
        verifiedCacheKeys: built.verifiedCacheKeys,
        metadataComplete: built.metadataComplete,
      });
    }

    try {
      await cleanupObsoleteHistoryCacheFiles(this.globalStorageUri, HISTORY_CACHE_FILE_NAME);
    } catch (error) {
      this.logger?.debug(`history cache cleanup failed error=${sanitizeDebugError(error)}`);
    }

    const { metrics } = built;
    this.logger?.debug(
      [
        "history.rebuildSnapshot done",
        `totalMs=${elapsedMs(totalStartedAt)}`,
        `files=${metrics.files}`,
        `discoverMs=${metrics.discoverMs}`,
        `processMs=${metrics.processMs}`,
        `statMiss=${metrics.statMiss}`,
        `cacheHit=${metrics.cacheHit}`,
        `cacheMiss=${metrics.cacheMiss}`,
        `summaryOk=${metrics.summaryOk}`,
        `summaryFailed=${metrics.summaryFailed}`,
        `summaryMs=${metrics.summaryMs}`,
        `titleMs=${metrics.titleMs}`,
        `writeCacheMs=${writeCacheMs}`,
        `adopted=${adopted}`,
      ].join(" "),
    );

    return Object.freeze({
      config,
      dateTimeSettingsKey,
      index: built.index,
      sessions: Object.freeze(Array.from(built.index.sessions)),
      adopted,
    });
  }

  private async refreshCore(options: { forceRebuildCache: boolean }): Promise<void> {
    const operation = this.captureOperationContext();
    const { config } = operation;
    const totalStartedAt = nowMs();
    let writeCacheMs = 0;

    const dateTime = resolveDateTimeSettings();
    const dateTimeSettingsKey = getDateTimeSettingsKey(dateTime);

    const cacheUri = this.getCacheUri();
    let cache: CacheFileV9 | null = null;
    if (!options.forceRebuildCache) {
      const processCache =
        this.cacheIndexGeneration === this.indexGeneration &&
        this.cacheForCurrentIndex &&
        this.isFreshCache(this.cacheForCurrentIndex, dateTimeSettingsKey, config)
          ? this.cacheForCurrentIndex
          : null;
      if (processCache) {
        cache = processCache;
      } else {
        const diskCache = await this.readCacheFile();
        if (this.isFreshCache(diskCache, dateTimeSettingsKey, config)) cache = diskCache;
      }
    }
    const normalizedCache = cache ? normalizeCacheEntries(cache.entries) : { entries: {}, dropped: 0 };
    if (normalizedCache.dropped > 0) {
      this.logger?.debug(`history.cache invalidEntries=${normalizedCache.dropped}`);
    }
    const built = await this.buildHistoryState({
      config,
      dateTime,
      dateTimeSettingsKey,
      cachedEntries: normalizedCache.entries,
    });
    if (!this.isOperationContextCurrent(operation)) throw new HistoryOperationSupersededError();
    const committedGeneration = this.commitIndexState({
      index: built.index,
      cache: built.cache,
      configKey: getHistoryServiceConfigKey(operation.config),
      verifiedCacheKeys: built.verifiedCacheKeys,
      metadataComplete: built.metadataComplete,
    });
    const writeCacheStartedAt = nowMs();
    let supersededDuringWrite = false;
    try {
      await writeJson(cacheUri, built.cache, {
        beforeCommit: () => {
          if (
            !this.isOperationContextCurrent(operation) ||
            this.indexGeneration !== committedGeneration ||
            this.cacheForCurrentIndex !== built.cache
          ) {
            throw new HistoryOperationSupersededError();
          }
        },
      });
      writeCacheMs = elapsedMs(writeCacheStartedAt);
    } catch (error) {
      if (error instanceof HistoryOperationSupersededError) {
        supersededDuringWrite = true;
      } else {
        this.logger?.debug(`history cache write failed error=${sanitizeDebugError(error)}`);
      }
    }
    if (!supersededDuringWrite && this.isOperationContextCurrent(operation)) {
      try {
        await cleanupObsoleteHistoryCacheFiles(this.globalStorageUri, HISTORY_CACHE_FILE_NAME);
      } catch (error) {
        this.logger?.debug(`history cache cleanup failed error=${sanitizeDebugError(error)}`);
      }
    }

    const { metrics } = built;
    this.logger?.debug(
      [
        "history.refresh done",
        `totalMs=${elapsedMs(totalStartedAt)}`,
        `files=${metrics.files}`,
        `discoverMs=${metrics.discoverMs}`,
        `processMs=${metrics.processMs}`,
        `statMiss=${metrics.statMiss}`,
        `cacheHit=${metrics.cacheHit}`,
        `cacheMiss=${metrics.cacheMiss}`,
        `summaryOk=${metrics.summaryOk}`,
        `summaryFailed=${metrics.summaryFailed}`,
        `summaryMs=${metrics.summaryMs}`,
        `titleMs=${metrics.titleMs}`,
        `writeCacheMs=${writeCacheMs}`,
      ].join(" "),
    );
    if (supersededDuringWrite || !this.isOperationContextCurrent(operation)) {
      throw new HistoryOperationSupersededError();
    }
  }

  private async buildHistoryState(params: {
    config: CodexHistoryViewerConfig;
    dateTime: DateTimeSettings;
    dateTimeSettingsKey: string;
    cachedEntries: Record<string, CacheEntryV1>;
    token?: vscode.CancellationToken;
  }): Promise<HistoryBuildResult> {
    const { config, dateTime, dateTimeSettingsKey, cachedEntries, token } = params;
    const roots = buildHistoryRoots(config);
    let statMiss = 0;
    let cacheHit = 0;
    let cacheMiss = 0;
    let summaryOk = 0;
    let summaryFailed = 0;
    let summaryMs = 0;

    throwIfHistoryRebuildCancelled(token);
    const discoverStartedAt = nowMs();
    const files = await findSessionFiles({
      codexRoot: config.sessionsRoot,
      codexArchivedRoot: config.codexArchivedSessionsRoot,
      claudeRoot: config.claudeSessionsRoot,
      includeCodex: config.enableCodexSource,
      includeCodexArchived: config.enableCodexArchivedSessions,
      includeClaude: config.enableClaudeSource,
    });
    const discoverMs = elapsedMs(discoverStartedAt);
    throwIfHistoryRebuildCancelled(token);

    const nextEntries: Record<string, CacheEntryV1> = {};
    const summaries: SessionSummary[] = [];
    const processStartedAt = nowMs();
    const fileResults = await mapWithConcurrency(files, HISTORY_REFRESH_CONCURRENCY, async (file) => {
      if (token?.isCancellationRequested) return emptyRefreshFileResult();
      const result = await this.refreshFile({
        file,
        cachedEntries,
        previewMaxMessages: config.previewMaxMessages,
        timeZone: dateTime.timeZone,
        historyDateBasis: config.historyDateBasis,
      });
      return token?.isCancellationRequested ? emptyRefreshFileResult() : result;
    });
    const processMs = elapsedMs(processStartedAt);
    throwIfHistoryRebuildCancelled(token);

    for (const result of fileResults) {
      statMiss += result.statMiss;
      cacheHit += result.cacheHit;
      cacheMiss += result.cacheMiss;
      summaryOk += result.summaryOk;
      summaryFailed += result.summaryFailed;
      summaryMs += result.summaryMs;
      if (result.cacheKey && result.entry) nextEntries[result.cacheKey] = result.entry;
      if (result.summary) summaries.push(result.summary);
    }

    throwIfHistoryRebuildCancelled(token);
    const titleStartedAt = nowMs();
    const selectedSummaries = selectPreferredSummariesByIdentity(summaries);
    const resolvedSummaries = await this.resolveDisplayTitles(selectedSummaries, config);
    const titleMs = elapsedMs(titleStartedAt);
    throwIfHistoryRebuildCancelled(token);
    const summariesByKey = new Map(resolvedSummaries.map((summary) => [summary.cacheKey, summary] as const));
    for (const [cacheKey, entry] of Object.entries(nextEntries)) {
      const resolvedSummary = summariesByKey.get(cacheKey);
      if (!resolvedSummary) continue;
      entry.summary = resolvedSummary;
    }

    summaries.length = 0;
    summaries.push(...resolvedSummaries);
    sortSummariesByDisplayDate(summaries);

    const index = buildIndex(roots, summaries);
    const metadataComplete = areAllCodexEntriesVerifiedForIndex(nextEntries, index);
    return {
      index,
      cache: {
        version: 9,
        summaryAlgoVersion: SUMMARY_CACHE_ALGO_VERSION,
        ...(metadataComplete ? { codexAgentMetadataVersion: 1 } : {}),
        codexSessionsRoot: config.sessionsRoot,
        codexArchivedSessionsRoot: config.codexArchivedSessionsRoot,
        claudeSessionsRoot: config.claudeSessionsRoot,
        includeCodex: config.enableCodexSource,
        includeCodexArchived: config.enableCodexArchivedSessions,
        includeClaude: config.enableClaudeSource,
        previewMaxMessages: config.previewMaxMessages,
        dateTimeSettingsKey,
        entries: nextEntries,
      },
      verifiedCacheKeys: collectVerifiedCodexMetadataCacheKeys(nextEntries),
      metadataComplete,
      metrics: {
        files: files.length,
        discoverMs,
        processMs,
        statMiss,
        cacheHit,
        cacheMiss,
        summaryOk,
        summaryFailed,
        summaryMs,
        titleMs,
      },
    };
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationQueue.then(operation, operation);
    this.operationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async refreshFile(params: {
    file: DiscoveredSessionFile;
    cachedEntries: Record<string, CacheEntryV1>;
    previewMaxMessages: number;
    timeZone: string;
    historyDateBasis: HistoryDateBasis;
  }): Promise<RefreshFileResult> {
    const { file, cachedEntries, previewMaxMessages, timeZone, historyDateBasis } = params;
    const { fsPath } = file;
    const key = normalizeCacheKey(fsPath);
    let st: { mtimeMs: number; size: number } | null = null;
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
      st = { mtimeMs: stat.mtime, size: stat.size };
    } catch {
      // Skip unreadable files.
      return emptyRefreshFileResult({ statMiss: 1 });
    }

    const cached = cachedEntries[key];
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      const summary = applyHistoryDateBasis(cached.summary, historyDateBasis);
      return emptyRefreshFileResult({
        cacheKey: key,
        entry: { ...cached, summary },
        summary,
        cacheHit: 1,
      });
    }

    const summaryStartedAt = nowMs();
    const builtSummary = await buildSessionSummary({
      sessionsRoot: file.rootPath,
      sourceRoot: file.rootPath,
      storage: {
        rootKind: file.rootKind,
        archiveState: file.archiveState,
        rootPath: file.rootPath,
      },
      fsPath,
      previewMaxMessages,
      timeZone,
    });
    const fileSummaryMs = elapsedMs(summaryStartedAt);
    if (!builtSummary) {
      return emptyRefreshFileResult({
        cacheMiss: 1,
        summaryFailed: 1,
        summaryMs: fileSummaryMs,
      });
    }

    const summary = applyHistoryDateBasis(builtSummary, historyDateBasis);
    return emptyRefreshFileResult({
      cacheKey: key,
      entry: {
        mtimeMs: st.mtimeMs,
        size: st.size,
        summary,
        ...(summary.source === "codex" ? { codexAgentMetadataVersion: 1 as const } : {}),
      },
      summary,
      cacheMiss: 1,
      summaryOk: 1,
      summaryMs: fileSummaryMs,
    });
  }

  private async resolveDisplayTitles(
    summaries: readonly SessionSummary[],
    config: CodexHistoryViewerConfig,
  ): Promise<SessionSummary[]> {
    const codexSessionIds = summaries
      .filter((summary) => summary.source === "codex")
      .map((summary) => summary.meta.id)
      .filter((sessionId): sessionId is string => typeof sessionId === "string" && sessionId.trim().length > 0);
    const codexTitlesById =
      config.enableCodexSource || config.enableCodexArchivedSessions
        ? await this.codexTitleStore.getTitles({
            sessionsRoot: config.sessionsRoot,
            sessionIds: codexSessionIds,
            pruneToSessionIds: true,
          })
        : new Map<string, string>();

    return resolveSessionDisplayTitles({
      sessions: summaries,
      titleSource: config.historyTitleSource,
      codexTitlesById,
      getCustomTitle: (session) => this.titleOverrideStore.getTitle(session),
    });
  }

  private getCacheUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.globalStorageUri, HISTORY_CACHE_FILE_NAME);
  }

  private async readCacheFile(): Promise<unknown | null> {
    const cacheUri = this.getCacheUri();
    const outcome = await readJsonOrDropCorrupt<unknown>(cacheUri);
    const { result } = outcome;
    if (result.ok) return result.value;
    const debugMessage = formatJsonReadOrDropCorruptDebug("history.cacheRead", outcome);
    if (debugMessage) this.logger?.debug(debugMessage);
    return null;
  }

  private isFreshCache(
    cache: unknown,
    dateTimeSettingsKey: string,
    config: CodexHistoryViewerConfig,
  ): cache is CacheFileV9 {
    if (!isPlainRecord(cache)) return false;
    return (
      cache.version === 9 &&
      cache.summaryAlgoVersion === SUMMARY_CACHE_ALGO_VERSION &&
      cache.codexSessionsRoot === config.sessionsRoot &&
      cache.codexArchivedSessionsRoot === config.codexArchivedSessionsRoot &&
      cache.claudeSessionsRoot === config.claudeSessionsRoot &&
      cache.includeCodex === config.enableCodexSource &&
      cache.includeCodexArchived === config.enableCodexArchivedSessions &&
      cache.includeClaude === config.enableClaudeSource &&
      cache.previewMaxMessages === config.previewMaxMessages &&
      cache.dateTimeSettingsKey === dateTimeSettingsKey &&
      isPlainRecord(cache.entries)
    );
  }
}

function nowMs(): number {
  return Date.now();
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, nowMs() - startedAt);
}

function cloneHistoryConfig(config: CodexHistoryViewerConfig): CodexHistoryViewerConfig {
  const snapshot: CodexHistoryViewerConfig = {
    ...config,
    autoRefresh: config.autoRefresh
      ? Object.freeze({ ...config.autoRefresh })
      : config.autoRefresh,
    images: config.images ? Object.freeze({ ...config.images }) : config.images,
  };
  return Object.freeze(snapshot);
}

function throwIfHistoryRebuildCancelled(token?: vscode.CancellationToken): void {
  if (token?.isCancellationRequested) throw new vscode.CancellationError();
}

function emptyRefreshFileResult(overrides: Partial<RefreshFileResult> = {}): RefreshFileResult {
  return {
    statMiss: 0,
    cacheHit: 0,
    cacheMiss: 0,
    summaryOk: 0,
    summaryFailed: 0,
    summaryMs: 0,
    ...overrides,
  };
}

function getHistoryServiceConfigKey(config: CodexHistoryViewerConfig): string {
  return JSON.stringify([
    config.sessionsRoot,
    config.codexArchivedSessionsRoot,
    config.claudeSessionsRoot,
    config.enableCodexSource,
    config.enableCodexArchivedSessions,
    config.enableClaudeSource,
    config.previewMaxMessages,
    config.historyDateBasis,
    config.historyTitleSource,
  ]);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeCacheEntries(rawEntries: Record<string, CacheEntryV1>): NormalizedCacheEntries {
  const entries: Record<string, CacheEntryV1> = {};
  let dropped = 0;
  for (const [storageKey, rawEntry] of Object.entries(rawEntries as Record<string, unknown>)) {
    const entry = normalizeCachedEntry(rawEntry, storageKey);
    if (!entry) {
      dropped += 1;
      continue;
    }
    entries[storageKey] = entry;
  }
  return { entries, dropped };
}

function normalizeCacheFile(cache: CacheFileV9, entries: Record<string, CacheEntryV1>): CacheFileV9 {
  return {
    version: 9,
    summaryAlgoVersion: SUMMARY_CACHE_ALGO_VERSION,
    codexAgentMetadataVersion: cache.codexAgentMetadataVersion === 1 ? 1 : undefined,
    codexSessionsRoot: cache.codexSessionsRoot,
    codexArchivedSessionsRoot: cache.codexArchivedSessionsRoot,
    claudeSessionsRoot: cache.claudeSessionsRoot,
    includeCodex: cache.includeCodex,
    includeCodexArchived: cache.includeCodexArchived,
    includeClaude: cache.includeClaude,
    previewMaxMessages: cache.previewMaxMessages,
    dateTimeSettingsKey: cache.dateTimeSettingsKey,
    entries,
  };
}

function normalizeCachedEntry(value: unknown, storageKey: string): CacheEntryV1 | null {
  if (!isPlainRecord(value)) return null;
  const { mtimeMs, size } = value;
  if (
    typeof mtimeMs !== "number" ||
    !Number.isFinite(mtimeMs) ||
    mtimeMs < 0 ||
    typeof size !== "number" ||
    !Number.isFinite(size) ||
    size < 0
  ) {
    return null;
  }
  const summary = normalizeCachedSummary(value.summary, storageKey);
  if (!summary) return null;
  if (summary.source !== "codex") {
    const meta = { ...summary.meta };
    delete meta.codexAgent;
    delete meta.codexFork;
    return {
      mtimeMs,
      size,
      summary: { ...summary, meta },
      codexAgentMetadataVersion: undefined,
    };
  }

  const sanitized = sanitizeCachedCodexAgentMetadata(summary.meta.codexAgent);
  const sanitizedFork = sanitizeCachedCodexForkMetadata(summary.meta.codexFork);
  if (!sanitizedFork.valid) return null;
  const meta = { ...summary.meta };
  if (sanitized.value) meta.codexAgent = sanitized.value;
  else delete meta.codexAgent;
  if (sanitizedFork.value) meta.codexFork = sanitizedFork.value;
  else delete meta.codexFork;
  return {
    mtimeMs,
    size,
    summary: { ...summary, meta },
    codexAgentMetadataVersion:
      value.codexAgentMetadataVersion === 1 && sanitized.valid ? 1 : undefined,
  };
}

function normalizeCachedSummary(value: unknown, storageKey: string): SessionSummary | null {
  if (!isPlainRecord(value)) return null;
  if (
    typeof value.fsPath !== "string" ||
    value.fsPath.length === 0 ||
    typeof value.cacheKey !== "string" ||
    value.cacheKey !== storageKey ||
    normalizeCacheKey(value.fsPath) !== storageKey ||
    !isBoundedSessionIdentityKey(value.identityKey) ||
    (value.source !== "codex" && value.source !== "claude") ||
    !isPlainRecord(value.storage) ||
    !isPlainRecord(value.meta) ||
    !Array.isArray(value.previewMessages)
  ) {
    return null;
  }
  const storage = value.storage;
  if (
    (storage.rootKind !== "codexSessions" &&
      storage.rootKind !== "codexArchivedSessions" &&
      storage.rootKind !== "claudeSessions") ||
    (storage.archiveState !== "active" && storage.archiveState !== "archived") ||
    typeof storage.rootPath !== "string"
  ) {
    return null;
  }
  if (
    !hasRequiredCachedSummaryStrings(value) ||
    !hasValidOptionalCachedSummaryStrings(value) ||
    !hasValidCachedPreviewMessages(value.previewMessages) ||
    !hasValidCachedInferredYmd(value.inferredYmd)
  ) {
    return null;
  }
  return {
    ...(value as unknown as SessionSummary),
    storage: {
      rootKind: storage.rootKind,
      archiveState: storage.archiveState,
      rootPath: storage.rootPath,
    },
    meta: { ...value.meta },
    previewMessages: value.previewMessages.map((message) => ({
      role: message.role,
      text: message.text,
    })),
  };
}

function hasRequiredCachedSummaryStrings(value: Record<string, unknown>): boolean {
  return [
    "startedLocalDate",
    "startedTimeLabel",
    "lastActivityLocalDate",
    "lastActivityTimeLabel",
    "localDate",
    "timeLabel",
    "snippet",
    "displayTitle",
    "cwdShort",
  ].every((key) => typeof value[key] === "string");
}

function hasValidOptionalCachedSummaryStrings(value: Record<string, unknown>): boolean {
  return [
    "startedAtIso",
    "lastActivityAtIso",
    "nativeTitle",
    "originalTitle",
    "customTitle",
  ].every((key) => value[key] === undefined || typeof value[key] === "string");
}

function hasValidCachedPreviewMessages(value: readonly unknown[]): value is SessionSummary["previewMessages"] {
  return value.every((message) =>
    isPlainRecord(message) &&
    (message.role === "user" || message.role === "assistant") &&
    typeof message.text === "string"
  );
}

function hasValidCachedInferredYmd(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.year === "number" &&
    Number.isSafeInteger(value.year) &&
    typeof value.month === "number" &&
    Number.isSafeInteger(value.month) &&
    typeof value.day === "number" &&
    Number.isSafeInteger(value.day)
  );
}

function areAllCodexEntriesVerified(entries: Record<string, CacheEntryV1>): boolean {
  return Object.values(entries).every((entry) =>
    entry.summary.source !== "codex" || entry.codexAgentMetadataVersion === 1
  );
}

function areAllCodexEntriesVerifiedForIndex(
  entries: Record<string, CacheEntryV1>,
  index: HistoryIndex,
): boolean {
  if (!areAllCodexEntriesVerified(entries)) return false;
  const verifiedCacheKeys = collectVerifiedCodexMetadataCacheKeys(entries);
  return index.sessions.every(
    (session) => session.source !== "codex" || verifiedCacheKeys.has(session.cacheKey),
  );
}

function collectVerifiedCodexMetadataCacheKeys(entries: Record<string, CacheEntryV1>): Set<string> {
  const verified = new Set<string>();
  for (const entry of Object.values(entries)) {
    if (entry.summary.source !== "codex" || entry.codexAgentMetadataVersion !== 1) continue;
    verified.add(entry.summary.cacheKey);
  }
  return verified;
}

function isCompleteCodexAgentMetadataCache(
  cache: CacheFileV9,
  entries: Record<string, CacheEntryV1>,
  index: HistoryIndex,
): boolean {
  return (
    cache.codexAgentMetadataVersion === 1 &&
    areAllCodexEntriesVerifiedForIndex(entries, index)
  );
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  const limit = Math.max(1, Math.floor(concurrency));
  const workerCount = Math.min(limit, items.length);
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await mapper(items[currentIndex]!, currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

function buildIndex(roots: HistoryRoots, summaries: SessionSummary[]): HistoryIndex {
  const idx: HistoryIndex = emptyIndex(roots);
  idx.sessions = summaries;

  for (const s of summaries) {
    idx.byCacheKey.set(s.cacheKey, s);
    idx.byIdentityKey.set(s.identityKey, s);

    const ymd = s.localDate;
    const [yyyy, mm, dd] = ymd.split("-");
    if (!yyyy || !mm || !dd) continue;

    if (!idx.byY.has(yyyy)) idx.byY.set(yyyy, new Map());
    const byMonth = idx.byY.get(yyyy)!;
    if (!byMonth.has(mm)) byMonth.set(mm, new Map());
    const byDay = byMonth.get(mm)!;
    if (!byDay.has(dd)) byDay.set(dd, []);
    byDay.get(dd)!.push(s);

    if (!idx.byYmd.has(ymd)) idx.byYmd.set(ymd, []);
    idx.byYmd.get(ymd)!.push(s);

    if (!idx.byYm.has(yyyy)) idx.byYm.set(yyyy, new Map());
    const ymMap = idx.byYm.get(yyyy)!;
    if (!ymMap.has(mm)) ymMap.set(mm, []);
    ymMap.get(mm)!.push(s);
  }

  // Ensure sessions within a day are sorted by time (descending).
  for (const [, months] of idx.byY) {
    for (const [, days] of months) {
      for (const [, list] of days) {
        list.sort((a, b) => (a.timeLabel < b.timeLabel ? 1 : a.timeLabel > b.timeLabel ? -1 : 0));
      }
    }
  }

  return idx;
}
