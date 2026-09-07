import * as vscode from "vscode";
import type { CodexHistoryViewerConfig, HistoryDateBasis } from "../settings";
import { discoverSessionFiles, type DiscoveredSessionFile } from "../sessions/sessionDiscovery";
import type { HistoryIndex, HistoryRoots, SessionSummary } from "../sessions/sessionTypes";
import {
  buildSessionSummary,
  rebuildCodexHistoryBasePreview,
  tryReadSessionMeta,
} from "../sessions/sessionSummary";
import { sanitizeCachedCodexAgentMetadata } from "../agents/codexAgentMetadata";
import { sanitizeCachedCodexForkMetadata } from "../branchMap/codexForkMetadata";
import {
  resolveCodexLogicalHistoryPlan,
  sanitizeCachedCodexHistoryBaseMetadata,
  type CodexLogicalHistoryPlan,
} from "../sessions/codexHistoryBase";
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
import { isValidByteCount } from "../utils/formatBytes";
import type { PerformanceProbe } from "../performance/performanceCounters";
import { buildCanonicalFingerprint } from "../utils/canonicalFingerprint";

interface CacheEntryV1 {
  mtimeMs: number;
  size: number;
  summary: SessionSummary;
  codexAgentMetadataVersion?: 1;
}

interface HistoryInputStamp {
  readonly mtimeMs: number;
  readonly size: number;
}

const SUMMARY_CACHE_ALGO_VERSION = 20;
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
  unstableFileCount: number;
  incomplete: boolean;
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
  roots: HistoryRoots;
  sessions: SessionSummary[];
  historySources: SessionSummary[];
  logicalPlanSignatures: ReadonlyMap<string, string>;
  cache: CacheFileV9;
  verifiedCacheKeys: Set<string>;
  metadataComplete: boolean;
  unstableFileCount: number;
  inventoryComplete: boolean;
  discoveryFailureCount: number;
  metrics: HistoryBuildMetrics;
}

interface HistoryStateFingerprints {
  readonly presentation: string;
  readonly inventory: string;
  readonly cache: string;
}

export type HistoryCacheWriteDisposition =
  | "skippedUnchanged"
  | "skippedIncomplete"
  | "succeeded"
  | "failed";

export interface HistoryRefreshResult {
  readonly presentationChanged: boolean;
  readonly inventoryChanged: boolean;
  readonly cacheChanged: boolean;
  readonly cacheWrite: HistoryCacheWriteDisposition;
  readonly unstableFileCount: number;
  readonly inventoryComplete: boolean;
  readonly discoveryFailureCount: number;
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

class HistoryInventoryIncompleteError extends Error {
  constructor() {
    super("History inventory could not be observed completely.");
    this.name = "HistoryInventoryIncompleteError";
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
  if (summary.localDate === localDate && summary.timeLabel === timeLabel) return summary;
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
): Promise<boolean> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(globalStorageUri);
  } catch {
    return false;
  }

  const deletions = entries
    .filter(([name, type]) => (type & vscode.FileType.File) !== 0 && HISTORY_CACHE_FILE_PATTERN.test(name))
    .filter(([name]) => name.toLowerCase() !== currentCacheFileName.toLowerCase())
    .map(([name]) => vscode.Uri.joinPath(globalStorageUri, name));

  let complete = true;
  for (const fileUri of deletions) {
    try {
      await vscode.workspace.fs.delete(fileUri, { recursive: false, useTrash: false });
    } catch {
      complete = false;
    }
  }
  return complete;
}

function buildHistoryRoots(config: CodexHistoryViewerConfig): HistoryRoots {
  return {
    codexSessionsRoot: config.sessionsRoot,
    codexArchivedSessionsRoot: config.codexArchivedSessionsRoot,
    claudeSessionsRoot: config.claudeSessionsRoot,
  };
}

function emptyIndex(roots: HistoryRoots, performanceProbe?: PerformanceProbe): HistoryIndex {
  performanceProbe?.add("mapMaterializationCount", 5);
  return {
    sessionsRoot: roots.codexSessionsRoot,
    roots,
    sessions: [],
    historySources: [],
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
  private stateFingerprints: HistoryStateFingerprints | null = null;
  private persistedCacheFingerprint: string | null = null;
  private logicalPlanSignaturesByCacheKey: ReadonlyMap<string, string> = new Map();
  private readonly summaryFingerprintCache = new WeakMap<SessionSummary, string>();
  private obsoleteHistoryCacheCleanupPending = true;
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
    performanceProbe?: PerformanceProbe;
    fingerprints?: HistoryStateFingerprints | null;
    cachePersisted?: boolean;
    logicalPlanSignatures?: ReadonlyMap<string, string>;
    replaceIndex?: boolean;
    inventoryChanged?: boolean;
    advanceGeneration?: boolean;
  }): number {
    const replaceIndex = params.replaceIndex !== false;
    const inventoryChanged = params.inventoryChanged ?? !params.preserveInventoryGeneration;
    const advanceGeneration = params.advanceGeneration ?? (replaceIndex || inventoryChanged);
    if (replaceIndex) this.index = params.index;
    this.indexConfigKey = params.configKey;
    this.codexAgentMetadataVerifiedCacheKeys = params.verifiedCacheKeys;
    this.codexAgentMetadataComplete = params.metadataComplete;
    if (inventoryChanged) this.indexInventoryGeneration += 1;
    if (advanceGeneration) this.indexGeneration += 1;
    this.cacheForCurrentIndex = params.cache;
    this.cacheIndexGeneration = this.indexGeneration;
    this.stateFingerprints = params.fingerprints === undefined ? null : params.fingerprints;
    if (params.logicalPlanSignatures) {
      this.logicalPlanSignaturesByCacheKey = params.logicalPlanSignatures;
    }
    if (params.cachePersisted) {
      this.persistedCacheFingerprint = this.stateFingerprints?.cache ?? null;
    }
    if (replaceIndex) params.performanceProbe?.add("historyIndexReplacementCount");
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
    const historySources = Array.from(summaries);
    const logicalPlans = await this.resolveLogicalHistoryPlans(historySources);
    if (countInconsistentLogicalHistoryPlans(historySources, logicalPlans, normalized.entries) > 0) {
      this.logger?.debug(`history.cacheImmediate logicalPlanChanged totalMs=${elapsedMs(startedAt)}`);
      return false;
    }
    const selectedSummaries = selectPreferredSummariesByIdentity(summaries);
    const previewResults = await mapWithConcurrency(
      selectedSummaries,
      HISTORY_REFRESH_CONCURRENCY,
      async (summary) => {
        const plan = logicalPlans.get(summary.cacheKey);
        const result = await rebuildCodexHistoryBasePreview(
          summary,
          historySources,
          config.previewMaxMessages,
          undefined,
          undefined,
          plan,
        );
        return { ...result, plan };
      },
    );
    if (previewResults.some((result) => !result.complete)) {
      this.logger?.debug(`history.cacheImmediate logicalPreviewFailed totalMs=${elapsedMs(startedAt)}`);
      return false;
    }
    if (await this.countChangedLogicalHistorySegments(previewResults.map((result) => result.plan)) > 0) {
      this.logger?.debug(`history.cacheImmediate logicalPreviewChanged totalMs=${elapsedMs(startedAt)}`);
      return false;
    }
    const previewResolvedSummaries = previewResults.map((result) => result.summary);
    const resolvedSummaries = await this.resolveDisplayTitles(previewResolvedSummaries, config);
    sortSummariesByDisplayDate(resolvedSummaries);
    if (!this.isOperationContextCurrent(operation)) {
      this.logger?.debug(`history.cacheImmediate superseded totalMs=${elapsedMs(startedAt)}`);
      return false;
    }
    const hydratedEntries: Record<string, CacheEntryV1> = { ...normalized.entries };
    for (const summary of resolvedSummaries) {
      const entry = hydratedEntries[summary.cacheKey];
      if (entry && entry.summary !== summary) {
        hydratedEntries[summary.cacheKey] = { ...entry, summary };
      }
    }
    const hydratedCache = normalizeCacheFile(normalizedCache, hydratedEntries);
    const resolvedHistorySources = replaceSummariesByCacheKey(historySources, resolvedSummaries);
    const nextIndex = buildIndex(roots, resolvedSummaries, resolvedHistorySources);
    const logicalPlanSignatures = collectLogicalPlanSignatures(logicalPlans);
    const fingerprints = this.buildHistoryStateFingerprints({
      roots,
      sessions: resolvedSummaries,
      historySources: resolvedHistorySources,
      cache: hydratedCache,
      logicalPlanSignatures,
    });
    const verifiedCacheKeys = collectVerifiedCodexMetadataCacheKeys(hydratedEntries);
    const metadataComplete = isCompleteCodexAgentMetadataCache(
      hydratedCache,
      hydratedEntries,
      nextIndex,
    );
    this.commitIndexState({
      index: nextIndex,
      cache: hydratedCache,
      configKey: getHistoryServiceConfigKey(operation.config),
      verifiedCacheKeys,
      metadataComplete,
      fingerprints,
      logicalPlanSignatures,
    });
    this.persistedCacheFingerprint = this.buildDurableCacheFingerprint(normalizedCache) ?? null;
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

    const nextHistorySources = (this.index.historySources ?? this.index.sessions).map((summary) => {
      if (summary.source !== "codex" || !updatedByCacheKey.has(summary.cacheKey)) return summary;
      const nextMeta = { ...summary.meta };
      const codexAgent = updatedByCacheKey.get(summary.cacheKey);
      if (codexAgent) nextMeta.codexAgent = codexAgent;
      else delete nextMeta.codexAgent;
      return { ...summary, meta: nextMeta };
    });
    const nextIndex = buildIndex(this.index.roots, nextSummaries, nextHistorySources);
    const complete = areAllCodexEntriesVerifiedForIndex(entries, nextIndex);
    const nextCache: CacheFileV9 = {
      ...cache,
      codexAgentMetadataVersion: complete ? 1 : undefined,
      entries,
    };
    const nextFingerprints = this.buildHistoryStateFingerprints({
      roots: nextIndex.roots,
      sessions: nextIndex.sessions,
      historySources: nextIndex.historySources ?? nextIndex.sessions,
      cache: nextCache,
      logicalPlanSignatures: this.logicalPlanSignaturesByCacheKey,
    });
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
      fingerprints: nextFingerprints,
      logicalPlanSignatures: this.logicalPlanSignaturesByCacheKey,
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
      if (
        this.isOperationContextCurrent(operation) &&
        this.indexGeneration === committedGeneration &&
        this.cacheForCurrentIndex === nextCache
      ) {
        this.persistedCacheFingerprint = nextFingerprints?.cache ?? null;
      }
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

  public refresh(options: {
    forceRebuildCache: boolean;
    shouldStart?: () => boolean;
    performanceProbe?: PerformanceProbe;
  }): Promise<HistoryRefreshResult> {
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
    if (!built.inventoryComplete) throw new HistoryInventoryIncompleteError();
    const rebuiltIndex = buildIndex(built.roots, built.sessions, built.historySources);
    const rebuiltFingerprints = this.buildHistoryStateFingerprints({
      roots: built.roots,
      sessions: built.sessions,
      historySources: built.historySources,
      cache: built.cache,
      logicalPlanSignatures: built.logicalPlanSignatures,
    });

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
      const presentationChanged = fingerprintsDiffer(
        this.stateFingerprints?.presentation,
        rebuiltFingerprints?.presentation,
      );
      const inventoryChanged = fingerprintsDiffer(
        this.stateFingerprints?.inventory,
        rebuiltFingerprints?.inventory,
      );
      this.commitIndexState({
        index: rebuiltIndex,
        cache: built.cache,
        configKey: getHistoryServiceConfigKey(config),
        verifiedCacheKeys: built.verifiedCacheKeys,
        metadataComplete: built.metadataComplete,
        fingerprints: rebuiltFingerprints,
        cachePersisted: true,
        logicalPlanSignatures: built.logicalPlanSignatures,
        replaceIndex: presentationChanged,
        inventoryChanged,
        advanceGeneration: presentationChanged || inventoryChanged,
      });
    } else {
      this.persistedCacheFingerprint = null;
    }

    if (this.obsoleteHistoryCacheCleanupPending) {
      try {
        if (await cleanupObsoleteHistoryCacheFiles(this.globalStorageUri, HISTORY_CACHE_FILE_NAME)) {
          this.obsoleteHistoryCacheCleanupPending = false;
        }
      } catch (error) {
        this.logger?.debug(`history cache cleanup failed error=${sanitizeDebugError(error)}`);
      }
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
      index: rebuiltIndex,
      sessions: Object.freeze(Array.from(rebuiltIndex.sessions)),
      adopted,
    });
  }

  private async refreshCore(options: {
    forceRebuildCache: boolean;
    performanceProbe?: PerformanceProbe;
  }): Promise<HistoryRefreshResult> {
    const operation = this.captureOperationContext();
    const { config } = operation;
    const totalStartedAt = nowMs();
    let writeCacheMs = 0;

    const dateTime = resolveDateTimeSettings();
    const dateTimeSettingsKey = getDateTimeSettingsKey(dateTime);

    const cacheUri = this.getCacheUri();
    let cache: CacheFileV9 | null = null;
    let cacheSource: "process" | "disk" | null = null;
    if (!options.forceRebuildCache) {
      const processCache =
        this.cacheIndexGeneration === this.indexGeneration &&
        this.cacheForCurrentIndex &&
        this.isFreshCache(this.cacheForCurrentIndex, dateTimeSettingsKey, config)
          ? this.cacheForCurrentIndex
          : null;
      if (processCache) {
        cache = processCache;
        cacheSource = "process";
      } else {
        const diskCache = await this.readCacheFile(options.performanceProbe);
        if (this.isFreshCache(diskCache, dateTimeSettingsKey, config)) {
          cache = diskCache;
          cacheSource = "disk";
        }
      }
    }
    // The process cache is service-owned and already normalized; keep entry identities for no-op detection.
    const normalizedCache = cacheSource === "process" && cache
      ? { entries: cache.entries, dropped: 0 }
      : cache
        ? normalizeCacheEntries(cache.entries)
        : { entries: {}, dropped: 0 };
    if (normalizedCache.dropped > 0) {
      this.logger?.debug(`history.cache invalidEntries=${normalizedCache.dropped}`);
    }
    const normalizedSourceCache = cacheSource === "disk" && cache
      ? normalizeCacheFile(cache, normalizedCache.entries)
      : null;
    const persistedFingerprint = options.forceRebuildCache
      ? this.persistedCacheFingerprint
      : cacheSource === "process"
        ? this.persistedCacheFingerprint
        : cacheSource === "disk" && normalizedCache.dropped === 0 && normalizedSourceCache
          ? (this.buildDurableCacheFingerprint(normalizedSourceCache) ?? null)
          : null;
    const built = await this.buildHistoryState({
      config,
      dateTime,
      dateTimeSettingsKey,
      cachedEntries: normalizedCache.entries,
      performanceProbe: options.performanceProbe,
      reuseLogicalPreviews: cacheSource === "process",
    });
    if (!this.isOperationContextCurrent(operation)) throw new HistoryOperationSupersededError();
    if (!built.inventoryComplete) {
      options.performanceProbe?.setOutcome("partial");
      const { metrics } = built;
      this.logger?.debug(
        [
          "history.refresh incomplete",
          `totalMs=${elapsedMs(totalStartedAt)}`,
          `files=${metrics.files}`,
          `discoverMs=${metrics.discoverMs}`,
          `processMs=${metrics.processMs}`,
          `statMiss=${metrics.statMiss}`,
          `cacheHit=${metrics.cacheHit}`,
          `cacheMiss=${metrics.cacheMiss}`,
          `summaryOk=${metrics.summaryOk}`,
          `summaryFailed=${metrics.summaryFailed}`,
          `unstableFiles=${built.unstableFileCount}`,
          `discoveryFailures=${built.discoveryFailureCount}`,
        ].join(" "),
      );
      return Object.freeze({
        presentationChanged: false,
        inventoryChanged: false,
        cacheChanged: false,
        cacheWrite: "skippedIncomplete" as const,
        unstableFileCount: built.unstableFileCount,
        inventoryComplete: false,
        discoveryFailureCount: built.discoveryFailureCount,
      });
    }
    const fingerprints = (
      cacheSource === "process"
        ? this.reuseCurrentStateFingerprints(built)
        : null
    ) ?? this.buildHistoryStateFingerprints({
      roots: built.roots,
      sessions: built.sessions,
      historySources: built.historySources,
      cache: built.cache,
      logicalPlanSignatures: built.logicalPlanSignatures,
    });
    const presentationChanged = fingerprintsDiffer(
      this.stateFingerprints?.presentation,
      fingerprints?.presentation,
    );
    const inventoryChanged = fingerprintsDiffer(
      this.stateFingerprints?.inventory,
      fingerprints?.inventory,
    );
    const cacheChanged = fingerprintsDiffer(
      persistedFingerprint ?? undefined,
      fingerprints?.cache,
    );
    const shouldWriteCache = options.forceRebuildCache || cacheChanged;
    if (!cacheChanged) options.performanceProbe?.add("durableFingerprintHitCount");

    const candidateIndex = presentationChanged
      ? buildIndex(built.roots, built.sessions, built.historySources, options.performanceProbe)
      : this.index;
    const committedGeneration = this.commitIndexState({
      index: candidateIndex,
      cache: built.cache,
      configKey: getHistoryServiceConfigKey(operation.config),
      verifiedCacheKeys: built.verifiedCacheKeys,
      metadataComplete: built.metadataComplete,
      performanceProbe: options.performanceProbe,
      fingerprints,
      logicalPlanSignatures: built.logicalPlanSignatures,
      replaceIndex: presentationChanged,
      inventoryChanged,
      advanceGeneration: presentationChanged || inventoryChanged,
    });
    let supersededDuringWrite = false;
    let cacheWrite: HistoryCacheWriteDisposition = "skippedUnchanged";
    if (shouldWriteCache) {
      const writeCacheStartedAt = nowMs();
      try {
        await writeJson(cacheUri, built.cache, {
          performanceProbe: options.performanceProbe,
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
        cacheWrite = "succeeded";
        if (
          this.isOperationContextCurrent(operation) &&
          this.indexGeneration === committedGeneration &&
          this.cacheForCurrentIndex === built.cache
        ) {
          this.persistedCacheFingerprint = fingerprints?.cache ?? null;
        }
      } catch (error) {
        if (error instanceof HistoryOperationSupersededError) {
          supersededDuringWrite = true;
        } else {
          cacheWrite = "failed";
          options.performanceProbe?.setOutcome("partial");
          this.logger?.debug(`history cache write failed error=${sanitizeDebugError(error)}`);
        }
      }
    } else {
      this.persistedCacheFingerprint = persistedFingerprint;
    }
    const cacheIsDurable = cacheWrite === "succeeded" ||
      (cacheWrite === "skippedUnchanged" && !cacheChanged);
    if (
      cacheIsDurable &&
      this.obsoleteHistoryCacheCleanupPending &&
      !supersededDuringWrite &&
      this.isOperationContextCurrent(operation)
    ) {
      try {
        if (await cleanupObsoleteHistoryCacheFiles(this.globalStorageUri, HISTORY_CACHE_FILE_NAME)) {
          this.obsoleteHistoryCacheCleanupPending = false;
        }
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
        `presentationChanged=${presentationChanged}`,
        `inventoryChanged=${inventoryChanged}`,
        `cacheChanged=${cacheChanged}`,
        `cacheWrite=${cacheWrite}`,
      ].join(" "),
    );
    if (supersededDuringWrite || !this.isOperationContextCurrent(operation)) {
      throw new HistoryOperationSupersededError();
    }
    return Object.freeze({
      presentationChanged,
      inventoryChanged,
      cacheChanged,
      cacheWrite,
      unstableFileCount: built.unstableFileCount,
      inventoryComplete: built.inventoryComplete,
      discoveryFailureCount: built.discoveryFailureCount,
    });
  }

  private async buildHistoryState(params: {
    config: CodexHistoryViewerConfig;
    dateTime: DateTimeSettings;
    dateTimeSettingsKey: string;
    cachedEntries: Record<string, CacheEntryV1>;
    token?: vscode.CancellationToken;
    performanceProbe?: PerformanceProbe;
    reuseLogicalPreviews?: boolean;
  }): Promise<HistoryBuildResult> {
    const { config, dateTime, dateTimeSettingsKey, cachedEntries, token, performanceProbe } = params;
    const roots = buildHistoryRoots(config);
    let statMiss = 0;
    let cacheHit = 0;
    let cacheMiss = 0;
    let summaryOk = 0;
    let summaryFailed = 0;
    let summaryMs = 0;
    let unstableFileCount = 0;
    let incompleteFileCount = 0;

    throwIfHistoryRebuildCancelled(token);
    const discoverStartedAt = nowMs();
    const discovery = await discoverSessionFiles({
      codexRoot: config.sessionsRoot,
      codexArchivedRoot: config.codexArchivedSessionsRoot,
      claudeRoot: config.claudeSessionsRoot,
      includeCodex: config.enableCodexSource,
      includeCodexArchived: config.enableCodexArchivedSessions,
      includeClaude: config.enableClaudeSource,
      performanceProbe,
    });
    const files = discovery.files;
    performanceProbe?.add("sessionCount", files.length);
    const discoverMs = elapsedMs(discoverStartedAt);
    throwIfHistoryRebuildCancelled(token);

    const nextEntries: Record<string, CacheEntryV1> = {};
    const summaries: SessionSummary[] = [];
    const processStartedAt = nowMs();
    const fileResults = await mapWithConcurrency(files, HISTORY_REFRESH_CONCURRENCY, async (file) => {
      if (token?.isCancellationRequested) return emptyRefreshFileResult();
      try {
        const result = await this.refreshFile({
          file,
          cachedEntries,
          previewMaxMessages: config.previewMaxMessages,
          timeZone: dateTime.timeZone,
          historyDateBasis: config.historyDateBasis,
          performanceProbe,
          token,
        });
        return token?.isCancellationRequested ? emptyRefreshFileResult() : result;
      } catch (error) {
        if (token?.isCancellationRequested) return emptyRefreshFileResult();
        throw error;
      }
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
      unstableFileCount += result.unstableFileCount;
      if (result.incomplete) incompleteFileCount += 1;
      if (result.cacheKey && result.entry) nextEntries[result.cacheKey] = result.entry;
      if (result.summary) summaries.push(result.summary);
    }

    throwIfHistoryRebuildCancelled(token);
    const inventoryComplete = discovery.failureCount === 0 && incompleteFileCount === 0;
    const buildIncompleteResult = (): HistoryBuildResult => ({
      roots,
      sessions: [],
      historySources: [],
      logicalPlanSignatures: new Map(),
      cache: buildHistoryCacheCandidate(config, dateTimeSettingsKey, nextEntries, false),
      verifiedCacheKeys: new Set(),
      metadataComplete: false,
      unstableFileCount,
      inventoryComplete: false,
      discoveryFailureCount: discovery.failureCount,
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
        titleMs: 0,
      },
    });
    if (!inventoryComplete) {
      return buildIncompleteResult();
    }

    const titleStartedAt = nowMs();
    const historySources = Array.from(summaries);
    const logicalPlans = await this.resolveLogicalHistoryPlans(historySources, token);
    const inconsistentLogicalPlanCount = countInconsistentLogicalHistoryPlans(
      historySources,
      logicalPlans,
      nextEntries,
    );
    if (inconsistentLogicalPlanCount > 0) {
      unstableFileCount += inconsistentLogicalPlanCount;
      performanceProbe?.setOutcome("partial");
      return buildIncompleteResult();
    }
    const selectedSummaries = selectPreferredSummariesByIdentity(summaries);
    const previewResults = await mapWithConcurrency(
      selectedSummaries,
      HISTORY_REFRESH_CONCURRENCY,
      async (summary) => {
        const plan = logicalPlans.get(summary.cacheKey);
        if (
          params.reuseLogicalPreviews &&
          plan &&
          this.logicalPlanSignaturesByCacheKey.get(summary.cacheKey) === plan.signature
        ) {
          return { summary, complete: true, plan: undefined };
        }
        const result = await rebuildCodexHistoryBasePreview(
          summary,
          historySources,
          config.previewMaxMessages,
          token,
          performanceProbe,
          plan,
        );
        return { ...result, plan };
      },
    );
    if (previewResults.some((result) => !result.complete)) {
      performanceProbe?.setOutcome("partial");
      return buildIncompleteResult();
    }
    const changedLogicalSegmentCount = await this.countChangedLogicalHistorySegments(
      previewResults.map((result) => result.plan),
      token,
      performanceProbe,
    );
    if (changedLogicalSegmentCount > 0) {
      unstableFileCount += changedLogicalSegmentCount;
      performanceProbe?.setOutcome("partial");
      return buildIncompleteResult();
    }
    const previewResolvedSummaries = previewResults.map((result) => result.summary);
    const resolvedSummaries = await this.resolveDisplayTitles(
      previewResolvedSummaries,
      config,
      performanceProbe,
    );
    const titleMs = elapsedMs(titleStartedAt);
    throwIfHistoryRebuildCancelled(token);
    const summariesByKey = new Map(resolvedSummaries.map((summary) => [summary.cacheKey, summary] as const));
    for (const [cacheKey, entry] of Object.entries(nextEntries)) {
      const resolvedSummary = summariesByKey.get(cacheKey);
      if (!resolvedSummary || entry.summary === resolvedSummary) continue;
      nextEntries[cacheKey] = { ...entry, summary: resolvedSummary };
    }

    summaries.length = 0;
    summaries.push(...resolvedSummaries);
    sortSummariesByDisplayDate(summaries);
    const resolvedHistorySources = replaceSummariesByCacheKey(historySources, resolvedSummaries);

    const metadataComplete = areAllCodexEntriesVerifiedForSessions(nextEntries, summaries);
    return {
      roots,
      sessions: summaries,
      historySources: resolvedHistorySources,
      logicalPlanSignatures: collectLogicalPlanSignatures(logicalPlans),
      cache: buildHistoryCacheCandidate(config, dateTimeSettingsKey, nextEntries, metadataComplete),
      verifiedCacheKeys: collectVerifiedCodexMetadataCacheKeys(nextEntries),
      metadataComplete,
      unstableFileCount,
      inventoryComplete: true,
      discoveryFailureCount: discovery.failureCount,
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
    performanceProbe?: PerformanceProbe;
    token?: vscode.CancellationToken;
  }): Promise<RefreshFileResult> {
    const {
      file,
      cachedEntries,
      previewMaxMessages,
      timeZone,
      historyDateBasis,
      performanceProbe,
      token,
    } = params;
    const { fsPath } = file;
    const key = normalizeCacheKey(fsPath);
    throwIfHistoryRebuildCancelled(token);
    let inputStamp = await readHistoryInputStamp(fsPath, "initial", performanceProbe);
    throwIfHistoryRebuildCancelled(token);
    if (!inputStamp) {
      performanceProbe?.setOutcome("partial");
      return emptyRefreshFileResult({ statMiss: 1, incomplete: true });
    }

    const cached = cachedEntries[key];
    if (cached && cached.mtimeMs === inputStamp.mtimeMs && cached.size === inputStamp.size) {
      performanceProbe?.add("cacheHitCount");
      const sizedSummary = cached.summary.fileSizeBytes === inputStamp.size
        ? cached.summary
        : { ...cached.summary, fileSizeBytes: inputStamp.size };
      const summary = applyHistoryDateBasis(sizedSummary, historyDateBasis);
      return emptyRefreshFileResult({
        cacheKey: key,
        entry: summary === cached.summary ? cached : { ...cached, summary },
        summary,
        cacheHit: 1,
      });
    }

    const summaryStartedAt = nowMs();
    performanceProbe?.add("cacheMissCount");
    let observedUnstable = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let builtSummary: SessionSummary | null;
      try {
        builtSummary = await buildSessionSummary({
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
          fileStat: inputStamp,
          performanceProbe,
          token,
          cancellationErrorFactory: () => new vscode.CancellationError(),
        });
      } catch (error) {
        throwIfHistoryRebuildCancelled(token);
        performanceProbe?.setOutcome("partial");
        return emptyRefreshFileResult({
          cacheMiss: 1,
          summaryFailed: 1,
          summaryMs: elapsedMs(summaryStartedAt),
          unstableFileCount: 1,
          incomplete: true,
        });
      }

      throwIfHistoryRebuildCancelled(token);
      const verifiedStamp = await readHistoryInputStamp(fsPath, "postScan", performanceProbe);
      throwIfHistoryRebuildCancelled(token);
      if (!verifiedStamp) {
        performanceProbe?.setOutcome("partial");
        return emptyRefreshFileResult({
          statMiss: 1,
          cacheMiss: 1,
          summaryFailed: 1,
          summaryMs: elapsedMs(summaryStartedAt),
          unstableFileCount: 1,
          incomplete: true,
        });
      }
      if (!areSameHistoryInputStamp(inputStamp, verifiedStamp)) {
        observedUnstable = true;
        if (attempt === 0) {
          inputStamp = verifiedStamp;
          continue;
        }
        performanceProbe?.setOutcome("partial");
        return emptyRefreshFileResult({
          cacheMiss: 1,
          summaryFailed: 1,
          summaryMs: elapsedMs(summaryStartedAt),
          unstableFileCount: 1,
          incomplete: true,
        });
      }

      const fileSummaryMs = elapsedMs(summaryStartedAt);
      if (!builtSummary) {
        performanceProbe?.setOutcome("partial");
        return emptyRefreshFileResult({
          cacheMiss: 1,
          summaryFailed: 1,
          summaryMs: fileSummaryMs,
          unstableFileCount: observedUnstable ? 1 : 0,
        });
      }
      performanceProbe?.add("cacheEntryRebuildCount");
      performanceProbe?.observeMemory();

      const summary = applyHistoryDateBasis(
        { ...builtSummary, fileSizeBytes: inputStamp.size },
        historyDateBasis,
      );
      return emptyRefreshFileResult({
        cacheKey: key,
        entry: {
          mtimeMs: inputStamp.mtimeMs,
          size: inputStamp.size,
          summary,
          ...(summary.source === "codex" ? { codexAgentMetadataVersion: 1 as const } : {}),
        },
        summary,
        cacheMiss: 1,
        summaryOk: 1,
        summaryMs: fileSummaryMs,
        unstableFileCount: observedUnstable ? 1 : 0,
      });
    }

    performanceProbe?.setOutcome("partial");
    return emptyRefreshFileResult({ cacheMiss: 1, summaryFailed: 1, incomplete: true });
  }

  private async resolveLogicalHistoryPlans(
    summaries: readonly SessionSummary[],
    token?: vscode.CancellationToken,
  ): Promise<ReadonlyMap<string, CodexLogicalHistoryPlan>> {
    const candidates = summaries.filter(
      (summary) => summary.source === "codex" && summary.meta.codexHistoryBase,
    );
    const resolved = await mapWithConcurrency(
      candidates,
      HISTORY_REFRESH_CONCURRENCY,
      async (summary) => {
        throwIfHistoryRebuildCancelled(token);
        try {
          const plan = await resolveCodexLogicalHistoryPlan(summary.fsPath, summaries);
          return { cacheKey: summary.cacheKey, plan };
        } catch (error) {
          throwIfHistoryRebuildCancelled(token);
          return { cacheKey: summary.cacheKey, plan: undefined };
        }
      },
    );
    throwIfHistoryRebuildCancelled(token);

    const plans = new Map<string, CodexLogicalHistoryPlan>();
    for (const result of resolved) {
      if (result.plan) plans.set(result.cacheKey, result.plan);
    }
    return plans;
  }

  private async countChangedLogicalHistorySegments(
    plans: readonly (CodexLogicalHistoryPlan | undefined)[],
    token?: vscode.CancellationToken,
    performanceProbe?: PerformanceProbe,
  ): Promise<number> {
    const segmentsByCacheKey = new Map<string, CodexLogicalHistoryPlan["segments"][number]>();
    for (const plan of plans) {
      if (!plan) continue;
      for (const segment of plan.segments) {
        if (!segmentsByCacheKey.has(segment.cacheKey)) {
          segmentsByCacheKey.set(segment.cacheKey, segment);
        }
      }
    }
    const changed = await mapWithConcurrency(
      Array.from(segmentsByCacheKey.values()),
      HISTORY_REFRESH_CONCURRENCY,
      async (segment) => {
        throwIfHistoryRebuildCancelled(token);
        const observed = await readHistoryInputStamp(segment.fsPath, "postScan", performanceProbe);
        throwIfHistoryRebuildCancelled(token);
        return !observed ||
          observed.size !== segment.size ||
          !areCompatibleFileMtimes(observed.mtimeMs, segment.mtimeMs);
      },
    );
    return changed.filter(Boolean).length;
  }

  private buildHistoryStateFingerprints(params: {
    roots: HistoryRoots;
    sessions: readonly SessionSummary[];
    historySources: readonly SessionSummary[];
    cache: CacheFileV9;
    logicalPlanSignatures: ReadonlyMap<string, string>;
  }): HistoryStateFingerprints | null {
    const summaryFingerprint = (summary: SessionSummary): string | undefined =>
      buildSessionSummaryFingerprint(
        summary,
        this.summaryFingerprintCache,
      );
    const selectedRows = buildSummaryFingerprintRows(params.sessions, summaryFingerprint);
    const sourceRows = buildSummaryFingerprintRows(params.historySources, summaryFingerprint);
    if (!selectedRows || !sourceRows) return null;

    const inventoryRows: unknown[] = [];
    for (const summary of params.historySources) {
      const entry = params.cache.entries[summary.cacheKey];
      if (!entry) return null;
      const historyBase = summary.meta.codexHistoryBase;
      const logicalPlanSignature = historyBase
        ? params.logicalPlanSignatures.get(summary.cacheKey)
        : "physical";
      if (!logicalPlanSignature) return null;
      inventoryRows.push([
        summary.cacheKey,
        summary.identityKey,
        summary.source,
        summary.storage.rootKind,
        summary.storage.archiveState,
        summary.storage.rootPath,
        summary.fsPath,
        entry.mtimeMs,
        entry.size,
        projectCodexHistoryBase(historyBase),
        logicalPlanSignature,
      ]);
    }

    const presentation = buildCanonicalFingerprint("history-presentation:v1", [
      projectHistoryRoots(params.roots),
      selectedRows,
      sourceRows,
    ]);
    const inventory = buildCanonicalFingerprint("history-inventory:v1", [
      projectHistoryRoots(params.roots),
      inventoryRows,
    ]);
    const cache = this.buildDurableCacheFingerprint(params.cache);
    return presentation && inventory && cache
      ? Object.freeze({ presentation, inventory, cache })
      : null;
  }

  private reuseCurrentStateFingerprints(built: HistoryBuildResult): HistoryStateFingerprints | null {
    const fingerprints = this.stateFingerprints;
    const currentCache = this.cacheForCurrentIndex;
    const currentHistorySources = this.index.historySources ?? this.index.sessions;
    if (
      !fingerprints ||
      !currentCache ||
      !areHistoryRootsEqual(this.index.roots, built.roots) ||
      !areSameSummarySequence(this.index.sessions, built.sessions) ||
      !areSameSummarySequence(currentHistorySources, built.historySources) ||
      !areSameLogicalPlanSignatures(this.logicalPlanSignaturesByCacheKey, built.logicalPlanSignatures) ||
      !isCacheStructurallyReused(currentCache, built.cache)
    ) {
      return null;
    }
    return fingerprints;
  }

  private buildDurableCacheFingerprint(cache: CacheFileV9): string | undefined {
    const cacheRows: unknown[] = [];
    for (const cacheKey of Object.keys(cache.entries).sort()) {
      const entry = cache.entries[cacheKey];
      if (!entry) return undefined;
      const entrySummaryFingerprint = buildSessionSummaryFingerprint(
        entry.summary,
        this.summaryFingerprintCache,
      );
      if (!entrySummaryFingerprint) return undefined;
      cacheRows.push([
        cacheKey,
        entry.mtimeMs,
        entry.size,
        entry.codexAgentMetadataVersion,
        entrySummaryFingerprint,
      ]);
    }

    return buildCanonicalFingerprint("history-durable-cache:v1", [
      cache.version,
      cache.summaryAlgoVersion,
      cache.codexAgentMetadataVersion,
      cache.codexSessionsRoot,
      cache.codexArchivedSessionsRoot,
      cache.claudeSessionsRoot,
      cache.includeCodex,
      cache.includeCodexArchived,
      cache.includeClaude,
      cache.previewMaxMessages,
      cache.dateTimeSettingsKey,
      cacheRows,
    ]);
  }

  private async resolveDisplayTitles(
    summaries: readonly SessionSummary[],
    config: CodexHistoryViewerConfig,
    performanceProbe?: PerformanceProbe,
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
            performanceProbe,
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

  private async readCacheFile(performanceProbe?: PerformanceProbe): Promise<unknown | null> {
    const cacheUri = this.getCacheUri();
    const outcome = await readJsonOrDropCorrupt<unknown>(cacheUri, { performanceProbe });
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
    sessionRow: config.sessionRow ? Object.freeze({ ...config.sessionRow }) : config.sessionRow,
  };
  return Object.freeze(snapshot);
}

function replaceSummariesByCacheKey(
  source: readonly SessionSummary[],
  replacements: readonly SessionSummary[],
): SessionSummary[] {
  const replacementsByKey = new Map(
    replacements.map((summary) => [summary.cacheKey, summary] as const),
  );
  return source.map((summary) => replacementsByKey.get(summary.cacheKey) ?? summary);
}

function collectLogicalPlanSignatures(
  plans: ReadonlyMap<string, CodexLogicalHistoryPlan>,
): ReadonlyMap<string, string> {
  return new Map(Array.from(plans, ([cacheKey, plan]) => [cacheKey, plan.signature] as const));
}

function countInconsistentLogicalHistoryPlans(
  summaries: readonly SessionSummary[],
  plans: ReadonlyMap<string, CodexLogicalHistoryPlan>,
  entries: Readonly<Record<string, CacheEntryV1>>,
): number {
  let inconsistentCount = 0;
  for (const summary of summaries) {
    if (summary.source !== "codex" || !summary.meta.codexHistoryBase) continue;
    const plan = plans.get(summary.cacheKey);
    if (!plan || plan.segments.some((segment) => {
      const entry = entries[segment.cacheKey];
      return !entry ||
        entry.size !== segment.size ||
        !areCompatibleFileMtimes(entry.mtimeMs, segment.mtimeMs);
    })) {
      inconsistentCount += 1;
    }
  }
  return inconsistentCount;
}

function areCompatibleFileMtimes(left: number, right: number): boolean {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 1;
}

function buildSummaryFingerprintRows(
  summaries: readonly SessionSummary[],
  fingerprint: (summary: SessionSummary) => string | undefined,
): unknown[][] | null {
  const rows: unknown[][] = [];
  for (const summary of summaries) {
    const childFingerprint = fingerprint(summary);
    if (!childFingerprint) return null;
    rows.push([summary.cacheKey, childFingerprint]);
  }
  return rows;
}

function fingerprintsDiffer(previous: string | undefined, next: string | undefined): boolean {
  return !previous || !next || previous !== next;
}

function areHistoryRootsEqual(left: HistoryRoots, right: HistoryRoots): boolean {
  return left.codexSessionsRoot === right.codexSessionsRoot &&
    left.codexArchivedSessionsRoot === right.codexArchivedSessionsRoot &&
    left.claudeSessionsRoot === right.claudeSessionsRoot;
}

function areSameSummarySequence(
  left: readonly SessionSummary[],
  right: readonly SessionSummary[],
): boolean {
  return left.length === right.length && left.every((summary, index) => summary === right[index]);
}

function areSameLogicalPlanSignatures(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [cacheKey, signature] of left) {
    if (right.get(cacheKey) !== signature) return false;
  }
  return true;
}

function isCacheStructurallyReused(left: CacheFileV9, right: CacheFileV9): boolean {
  if (
    left.version !== right.version ||
    left.summaryAlgoVersion !== right.summaryAlgoVersion ||
    left.codexAgentMetadataVersion !== right.codexAgentMetadataVersion ||
    left.codexSessionsRoot !== right.codexSessionsRoot ||
    left.codexArchivedSessionsRoot !== right.codexArchivedSessionsRoot ||
    left.claudeSessionsRoot !== right.claudeSessionsRoot ||
    left.includeCodex !== right.includeCodex ||
    left.includeCodexArchived !== right.includeCodexArchived ||
    left.includeClaude !== right.includeClaude ||
    left.previewMaxMessages !== right.previewMaxMessages ||
    left.dateTimeSettingsKey !== right.dateTimeSettingsKey
  ) {
    return false;
  }

  const leftKeys = Object.keys(left.entries);
  if (leftKeys.length !== Object.keys(right.entries).length) return false;
  return leftKeys.every((cacheKey) => left.entries[cacheKey] === right.entries[cacheKey]);
}

function buildSessionSummaryFingerprint(
  summary: SessionSummary,
  summaryFingerprintCache: WeakMap<SessionSummary, string>,
): string | undefined {
  const cachedSummaryFingerprint = summaryFingerprintCache.get(summary);
  if (cachedSummaryFingerprint) return cachedSummaryFingerprint;

  const summaryFingerprint = buildCanonicalFingerprint("history-session-summary:v2", [
    summary.fsPath,
    summary.fileSizeBytes,
    summary.cacheKey,
    summary.identityKey,
    summary.source,
    [summary.storage.rootKind, summary.storage.archiveState, summary.storage.rootPath],
    [
      summary.meta.id,
      summary.meta.timestampIso,
      summary.meta.cwd,
      summary.meta.originator,
      summary.meta.cliVersion,
      summary.meta.modelProvider,
      summary.meta.source,
      summary.meta.historySource,
      projectCodexAgent(summary.meta.codexAgent),
      projectCodexFork(summary.meta.codexFork),
      projectCodexHistoryBase(summary.meta.codexHistoryBase),
    ],
    summary.inferredYmd
      ? [summary.inferredYmd.year, summary.inferredYmd.month, summary.inferredYmd.day]
      : undefined,
    summary.startedAtIso,
    summary.lastActivityAtIso,
    summary.startedLocalDate,
    summary.startedTimeLabel,
    summary.lastActivityLocalDate,
    summary.lastActivityTimeLabel,
    summary.localDate,
    summary.timeLabel,
    summary.snippet,
    summary.nativeTitle,
    summary.originalTitle,
    summary.customTitle,
    summary.displayTitle,
    summary.cwdShort,
    summary.previewMessages.map((message) => [message.role, message.text]),
  ]);
  if (summaryFingerprint) summaryFingerprintCache.set(summary, summaryFingerprint);
  return summaryFingerprint;
}

function projectHistoryRoots(roots: HistoryRoots): unknown[] {
  return [roots.codexSessionsRoot, roots.codexArchivedSessionsRoot, roots.claudeSessionsRoot];
}

function projectCodexAgent(value: SessionSummary["meta"]["codexAgent"]): unknown[] | undefined {
  return value
    ? [value.parentThreadId, value.recordedDepth, value.agentPath, value.agentNickname, value.agentRole]
    : undefined;
}

function projectCodexFork(value: SessionSummary["meta"]["codexFork"]): unknown[] | undefined {
  return value ? [value.parentThreadId] : undefined;
}

function projectCodexHistoryBase(
  value: SessionSummary["meta"]["codexHistoryBase"],
): unknown[] | undefined {
  return value
    ? [value.sourceRolloutId, value.endOrdinalExclusive, value.endByteOffset, value.firstOrdinal]
    : undefined;
}

function throwIfHistoryRebuildCancelled(token?: vscode.CancellationToken): void {
  if (token?.isCancellationRequested) throw new vscode.CancellationError();
}

async function readHistoryInputStamp(
  fsPath: string,
  phase: "initial" | "postScan",
  performanceProbe?: PerformanceProbe,
): Promise<HistoryInputStamp | null> {
  try {
    performanceProbe?.add(phase === "initial" ? "statCount" : "postScanCheckCount");
    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
    if (!Number.isFinite(stat.mtime) || !isValidByteCount(stat.size)) return null;
    return { mtimeMs: stat.mtime, size: stat.size };
  } catch {
    return null;
  }
}

function areSameHistoryInputStamp(left: HistoryInputStamp, right: HistoryInputStamp): boolean {
  return left.mtimeMs === right.mtimeMs && left.size === right.size;
}

function buildHistoryCacheCandidate(
  config: CodexHistoryViewerConfig,
  dateTimeSettingsKey: string,
  entries: Record<string, CacheEntryV1>,
  metadataComplete: boolean,
): CacheFileV9 {
  return {
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
    entries,
  };
}

function emptyRefreshFileResult(overrides: Partial<RefreshFileResult> = {}): RefreshFileResult {
  return {
    statMiss: 0,
    cacheHit: 0,
    cacheMiss: 0,
    summaryOk: 0,
    summaryFailed: 0,
    summaryMs: 0,
    unstableFileCount: 0,
    incomplete: false,
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
    !isValidByteCount(size)
  ) {
    return null;
  }
  const summary = normalizeCachedSummary(value.summary, storageKey);
  if (!summary) return null;
  if (summary.source !== "codex") {
    const meta = { ...summary.meta };
    delete meta.codexAgent;
    delete meta.codexFork;
    delete meta.codexHistoryBase;
    return {
      mtimeMs,
      size,
      summary: { ...summary, fileSizeBytes: size, meta },
      codexAgentMetadataVersion: undefined,
    };
  }

  const sanitized = sanitizeCachedCodexAgentMetadata(summary.meta.codexAgent);
  const sanitizedFork = sanitizeCachedCodexForkMetadata(summary.meta.codexFork);
  if (!sanitizedFork.valid) return null;
  const sanitizedHistoryBase = sanitizeCachedCodexHistoryBaseMetadata(summary.meta.codexHistoryBase);
  if (!sanitizedHistoryBase.valid) return null;
  const meta = { ...summary.meta };
  if (sanitized.value) meta.codexAgent = sanitized.value;
  else delete meta.codexAgent;
  if (sanitizedFork.value) meta.codexFork = sanitizedFork.value;
  else delete meta.codexFork;
  if (sanitizedHistoryBase.value) meta.codexHistoryBase = sanitizedHistoryBase.value;
  else delete meta.codexHistoryBase;
  return {
    mtimeMs,
    size,
    summary: { ...summary, fileSizeBytes: size, meta },
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
  return areAllCodexEntriesVerifiedForSessions(entries, index.sessions);
}

function areAllCodexEntriesVerifiedForSessions(
  entries: Record<string, CacheEntryV1>,
  sessions: readonly SessionSummary[],
): boolean {
  if (!areAllCodexEntriesVerified(entries)) return false;
  const verifiedCacheKeys = collectVerifiedCodexMetadataCacheKeys(entries);
  return sessions.every(
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

function buildIndex(
  roots: HistoryRoots,
  summaries: SessionSummary[],
  historySources: SessionSummary[] = summaries,
  performanceProbe?: PerformanceProbe,
): HistoryIndex {
  const idx: HistoryIndex = emptyIndex(roots, performanceProbe);
  idx.sessions = summaries;
  idx.historySources = historySources;

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
