import { readClaudeAgentMetadata, parseClaudeAgentPath } from "../agents/claudeAgentMetadata";
import * as vscode from "vscode";
import * as path from "node:path";
import { STORAGE_CONTRACT_FINGERPRINT } from "../generated/storageContractFingerprint";
import { SqliteCacheStore } from "../storage/sqliteCacheStore";
import { SqliteValueCache } from "../storage/sqliteValueCache";
import type { CodexHistoryViewerConfig, HistoryDateBasis } from "../settings";
import { discoverSessionFiles, type DiscoveredSessionFile } from "../sessions/sessionDiscovery";
import type { HistoryIndex, HistoryRoots, SessionSummary } from "../sessions/sessionTypes";
import {
  buildSessionSummary,
  rebuildCodexHistoryBasePreview,
  tryReadSessionMeta,
} from "../sessions/sessionSummary";
import { CODEX_AGENT_METADATA_VERSION, sanitizeCachedCodexAgentMetadata } from "../agents/codexAgentMetadata";
import { sanitizeCachedCodexForkMetadata } from "../branchMap/codexForkMetadata";
import {
  resolveCodexLogicalHistoryPlan,
  sanitizeCachedCodexHistoryBaseMetadata,
  type CodexLogicalHistoryPlan,
} from "../sessions/codexHistoryBase";
import { resolveSessionDisplayTitle, resolveSessionDisplayTitles } from "../sessions/sessionTitleResolver";
import { normalizeCacheKey, normalizeFsPathKey } from "../utils/fsUtils";
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
import {
  areCodexRolloutRevisionsRelated,
  compareCodexRolloutCreation,
  findSupersededCodexRolloutKeys,
} from "../sessions/codexRolloutRevisions";
import { buildAntigravitySessionSummary, buildAntigravityStartupSummary, antigravitySessionIdentity } from "../antigravity/antigravitySessionSummary";
import { createSourceInventoryStates, sourceInventoryConfigKey, type SourceInventoryStates } from "../sessions/sourceInventory";
import { ANTIGRAVITY_UUID } from "../antigravity/antigravityTypes";
import { antigravityReader } from "../antigravity/antigravityReader";

interface CacheEntryV1 {
  mtimeMs: number;
  size: number;
  summary: SessionSummary;
  codexAgentMetadataVersion?: typeof CODEX_AGENT_METADATA_VERSION;
}

interface HistoryInputStamp {
  readonly mtimeMs: number;
  readonly size: number;
}

const SUMMARY_CACHE_ALGO_VERSION = 32;
const HISTORY_REFRESH_CONCURRENCY = 4;

interface CacheFileV9 {
  storageContractFingerprint: string;
  version: 9;
  summaryAlgoVersion: number;
  codexAgentMetadataVersion?: typeof CODEX_AGENT_METADATA_VERSION;
  codexSessionsRoot: string;
  codexArchivedSessionsRoot: string;
  claudeSessionsRoot: string;
  antigravitySessionsRoots: readonly string[];
  includeCodex: boolean;
  includeCodexArchived: boolean;
  includeCodexCompressed?: boolean;
  includeClaude: boolean;
  includeAntigravity: boolean;
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
  coreInventoryComplete: boolean;
  sourceInventoryStates: SourceInventoryStates;
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
  readonly coreInventoryComplete: boolean;
  readonly sourceInventoryStates: SourceInventoryStates;
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

export class HistoryInventoryIncompleteError extends Error {
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

function selectPreferredSummariesByIdentity(
  summaries: readonly SessionSummary[],
  plans: ReadonlyMap<string, CodexLogicalHistoryPlan>,
): SessionSummary[] {
  const superseded = findSupersededCodexRolloutKeys(summaries, plans);
  const byIdentity = new Map<string, SessionSummary>();
  for (const summary of summaries) {
    if (superseded.has(summary.cacheKey)) continue;
    const current = byIdentity.get(summary.identityKey);
    const creationOrder = current && areCodexRolloutRevisionsRelated(summary, current, summaries)
      ? compareCodexRolloutCreation(summary, current) : 0;
    if (!current || (creationOrder || compareIdentityCandidate(summary, current)) < 0) {
      byIdentity.set(summary.identityKey, summary);
    }
  }
  return Array.from(byIdentity.values());
}

function haveSameNativeRoots(left: readonly string[], right: readonly string[]): boolean {
  const leftKeys = new Set(left.map(normalizeFsPathKey));
  const rightKeys = new Set(right.map(normalizeFsPathKey));
  return leftKeys.size === rightKeys.size && [...leftKeys].every(root => rightKeys.has(root));
}

function isStartupSummaryInScope(summary: SessionSummary, config: CodexHistoryViewerConfig, nativeRoots: readonly string[]): boolean {
  const { rootKind, rootPath } = summary.storage;
  const roots: readonly string[] =
    summary.source === "antigravity" && rootKind === "antigravitySessions" && config.enableAntigravitySource ? nativeRoots
    : summary.source === "claude" && rootKind === "claudeSessions" && config.enableClaudeSource ? [config.claudeSessionsRoot]
    : summary.source === "codex" && rootKind === "codexSessions" && config.enableCodexSource ? [config.sessionsRoot]
    : summary.source === "codex" && rootKind === "codexArchivedSessions" && config.enableCodexArchivedSessions ? [config.codexArchivedSessionsRoot]
    : [];
  return roots.some(root => {
    if (!root || normalizeFsPathKey(root) !== normalizeFsPathKey(rootPath)) return false;
    const relative = path.relative(root, summary.fsPath);
    return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
  });
}

function selectStartupSummaries(summaries: readonly SessionSummary[]): SessionSummary[] {
  // Entries describe physical files, including older Codex rollouts. Defer ambiguous families to the normal logical projection.
  const codexIdentities = new Map<string, number>();
  for (const summary of summaries) {
    if (summary.source === "codex") codexIdentities.set(summary.identityKey, (codexIdentities.get(summary.identityKey) ?? 0) + 1);
  }
  return selectPreferredSummariesByIdentity(summaries.filter(summary =>
    summary.source !== "codex" || (!summary.meta.codexHistoryBase && codexIdentities.get(summary.identityKey) === 1)), new Map());
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
    antigravitySessionsRoots: config.antigravitySessionsRoots ?? [],
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
    sourceInventoryStates: createSourceInventoryStates(roots),
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
  private readonly sqliteValues?: SqliteValueCache;
  private operationUsesSqlite = false;
  private cachePreparationError: unknown;
  private lastResolvedAntigravityRoots?: readonly string[];
  private startupPreview?: {
    readonly onChange: () => void;
    readonly statusSubscription?: vscode.Disposable;
    index?: HistoryIndex;
  };

  constructor(
    globalStorageUri: vscode.Uri,
    config: CodexHistoryViewerConfig,
    titleOverrideStore: SessionTitleOverrideStore,
    logger?: DebugLogger,
    private readonly sqliteCache?: SqliteCacheStore,
  ) {
    this.globalStorageUri = globalStorageUri;
    this.codexTitleStore = new CodexTitleStore(globalStorageUri);
    this.titleOverrideStore = titleOverrideStore;
    this.logger = logger;
    this.sqliteValues = sqliteCache ? new SqliteValueCache(sqliteCache, "history") : undefined;
    this.config = config;
    this.configKey = getHistoryServiceConfigKey(config);
    this.index = emptyIndex(buildHistoryRoots(config));
    void antigravityReader.configure(config.antigravitySessionsRoots ?? [], config.enableAntigravitySource === true);
  }

  public updateConfig(config: CodexHistoryViewerConfig): void {
    const antigravityChanged = sourceInventoryConfigKey(this.config, "antigravity") !== sourceInventoryConfigKey(config, "antigravity");
    const nextKey = getHistoryServiceConfigKey(config);
    if (nextKey !== this.configKey) {
      this.configKey = nextKey;
      this.configRevision += 1;
      this.endStartupPreview();
    }
    this.config = config;
    void antigravityReader.configure(config.antigravitySessionsRoots ?? [], config.enableAntigravitySource === true);
    if (antigravityChanged) {
      this.lastResolvedAntigravityRoots = undefined;
      const old = this.index.sourceInventoryStates.antigravity;
      const states: SourceInventoryStates = Object.freeze({ ...this.index.sourceInventoryStates, antigravity: Object.freeze({
        status: config.enableAntigravitySource ? "cached" : "disabled", configKey: sourceInventoryConfigKey(config, "antigravity"), configRevision: this.configRevision,
        generation: old.generation + 1, allowedRoots: Object.freeze([] as string[]),
      }) });
      this.index = buildIndex({ ...this.index.roots, antigravitySessionsRoots: [...(config.antigravitySessionsRoots ?? [])] },
        this.index.sessions.filter(session => session.source !== "antigravity"), (this.index.historySources ?? this.index.sessions).filter(session => session.source !== "antigravity"), undefined, states);
      this.indexGeneration++; this.indexInventoryGeneration++; this.cacheIndexGeneration = -1; this.cacheForCurrentIndex = null; this.stateFingerprints = null;
    }
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
    if (replaceIndex) this.index = this.withSourceGenerations(params.index);
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

  public startStartupPreview(onChange: () => void): void {
    if (!this.sqliteCache || this.sqliteCache.getStatus().backend === "legacy") return;
    this.startupPreview = {
      onChange,
      statusSubscription: this.sqliteCache.onDidChangeStatus(status => {
        if (status.backend === "legacy") this.endStartupPreview();
      }),
    };
  }

  public endStartupPreview(): void {
    const previous = this.startupPreview;
    this.startupPreview = undefined;
    previous?.statusSubscription?.dispose();
    if (previous?.index) previous.onChange();
  }

  public getStartupPreview(): HistoryIndex | undefined {
    return this.startupPreview?.index;
  }

  public resolveStartupSelection(selected: SessionSummary, allowPreview = false): SessionSummary | undefined {
    const preview = allowPreview ? this.startupPreview?.index?.byCacheKey.get(selected.cacheKey) : undefined;
    const sourceState = this.index.sourceInventoryStates[selected.source];
    const confirmed = this.indexConfigKey === this.configKey &&
      (selected.source === "antigravity" || sourceState.status === "complete") &&
      sourceState.configKey === sourceInventoryConfigKey(this.config, selected.source)
      ? this.index.byCacheKey.get(selected.cacheKey) : undefined;
    const current = preview ?? confirmed;
    return current && current.source === selected.source && current.identityKey === selected.identityKey &&
      current.fsPath === selected.fsPath && current.storage.rootKind === selected.storage.rootKind &&
      current.storage.archiveState === selected.storage.archiveState && current.storage.rootPath === selected.storage.rootPath &&
      current.meta.id === selected.meta.id ? current : undefined;
  }

  public getStartupNativeReadIndex(selected: SessionSummary): Pick<HistoryIndex, "byCacheKey" | "sourceInventoryStates"> | undefined {
    const index = this.startupPreview?.index;
    if (selected.source !== "antigravity" || !index || !this.resolveStartupSelection(selected, true) ||
        !index.byCacheKey.has(selected.cacheKey)) return undefined;
    return {
      byCacheKey: index.byCacheKey,
      sourceInventoryStates: {
        ...index.sourceInventoryStates,
        antigravity: {
          ...index.sourceInventoryStates.antigravity,
          configKey: sourceInventoryConfigKey(this.config, "antigravity"),
          allowedRoots: antigravityReader.getRoots(),
        },
      },
    };
  }

  private publishStartupPreview(
    config: CodexHistoryViewerConfig,
    summaries: SessionSummary[],
    replace = false,
    nativeRoots = antigravityReader.getRoots(),
  ): void {
    const preview = this.startupPreview;
    if (!preview || !this.operationUsesSqlite || this.cachePreparationError) return;
    const previous = preview.index?.sessions ?? [];
    const retained = replace ? [] : previous.filter(session => isStartupSummaryInScope(session, config, nativeRoots));
    const byIdentity = new Map(retained.map(session => [session.identityKey, session]));
    if (preview.index && !summaries.length && retained.length === previous.length) return;
    for (const summary of summaries) {
      if (isStartupSummaryInScope(summary, config, nativeRoots)) byIdentity.set(summary.identityKey, summary);
    }
    const sessions = [...byIdentity.values()];
    sortSummariesByDisplayDate(sessions);
    preview.index = buildIndex(buildHistoryRoots(config), sessions);
    preview.onChange();
  }

  public getIndexGeneration(): number {
    return this.indexGeneration;
  }

  public getSourceIndexGeneration(source: SessionSummary["source"]): number { return this.index.sourceInventoryStates[source].generation; }

  private withSourceGenerations(index: HistoryIndex): HistoryIndex {
    const fingerprint = (value: HistoryIndex, source: SessionSummary["source"]): string | undefined => {
      const state = value.sourceInventoryStates[source];
      return buildCanonicalFingerprint("source-index", [state.status, state.configKey, state.allowedRoots,
        buildSummaryFingerprintRows((value.historySources ?? value.sessions).filter(session => session.source === source), summary => buildSessionSummaryFingerprint(summary, this.summaryFingerprintCache))]);
    };
    const states = { ...index.sourceInventoryStates }; let changedGeneration = false;
    for (const source of ["codex", "claude", "antigravity"] as const) {
      const changed = fingerprint(index, source) !== fingerprint(this.index, source), state = states[source];
      const generation = Math.max(state.generation, this.index.sourceInventoryStates[source].generation + (changed ? 1 : 0));
      if (generation !== state.generation) { changedGeneration = true; states[source] = Object.freeze({ ...state, generation }); }
    }
    return changedGeneration ? { ...index, sourceInventoryStates: Object.freeze(states) } : index;
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
    await this.prepareSqliteCache(config, dateTimeSettingsKey);
    const cache = await this.readCacheFile(undefined, config, dateTimeSettingsKey);
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
    const scopedEntries = { ...normalized.entries };
    let authorizedNativeRoots: readonly string[] | undefined;
    if (config.enableAntigravitySource && Object.values(scopedEntries).some(entry => entry.summary.source === "antigravity")) {
      if (this.startupPreview && this.operationUsesSqlite && this.isOperationContextCurrent(operation)) {
        const core = Object.values(scopedEntries).flatMap(entry => entry.summary.source === "antigravity" ? [] :
          [applyHistoryDateBasis(entry.summary, config.historyDateBasis)]);
        this.publishStartupPreview(config, selectStartupSummaries(core));
      }
      authorizedNativeRoots = await antigravityReader.readyFor(config.antigravitySessionsRoots ?? [], true);
    }
    const nativeRoots = new Set((authorizedNativeRoots ?? []).map(normalizeFsPathKey));
    for (const [key, entry] of Object.entries(scopedEntries)) {
      if (entry.summary.source === "antigravity" &&
          (!config.enableAntigravitySource || !nativeRoots.has(normalizeFsPathKey(entry.summary.storage.rootPath)))) delete scopedEntries[key];
    }
    const summaries = Object.values(scopedEntries).map(entry => applyHistoryDateBasis(entry.summary, config.historyDateBasis));
    if (this.startupPreview && this.operationUsesSqlite && this.isOperationContextCurrent(operation)) {
      this.publishStartupPreview(config, selectStartupSummaries(summaries));
    }
    const historySources = Array.from(summaries);
    const logicalPlans = await this.resolveLogicalHistoryPlans(historySources);
    if (countInconsistentLogicalHistoryPlans(historySources, logicalPlans, normalized.entries) > 0) {
      this.logger?.debug(`history.cacheImmediate logicalPlanChanged totalMs=${elapsedMs(startedAt)}`);
      return false;
    }
    const selectedSummaries = selectPreferredSummariesByIdentity(summaries, logicalPlans);
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
    if (!this.isOperationContextCurrent(operation) ||
        (authorizedNativeRoots && this.nativeRootPermissionsChanged(config, authorizedNativeRoots))) {
      this.logger?.debug(`history.cacheImmediate superseded totalMs=${elapsedMs(startedAt)}`);
      return false;
    }
    const hydratedEntries = scopedEntries;
    for (const summary of resolvedSummaries) {
      const entry = hydratedEntries[summary.cacheKey];
      if (entry && entry.summary !== summary) {
        hydratedEntries[summary.cacheKey] = { ...entry, summary };
      }
    }
    const hydratedCache = normalizeCacheFile(normalizedCache, hydratedEntries);
    const resolvedHistorySources = replaceSummariesByCacheKey(historySources, resolvedSummaries);
    this.publishStartupPreview(config, resolvedSummaries, true);
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
    await this.prepareSqliteCache(operation.config, dateTimeSettingsKey);
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
      entry.summary.source === "codex" && entry.codexAgentMetadataVersion !== CODEX_AGENT_METADATA_VERSION
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
            codexAgentMetadataVersion: CODEX_AGENT_METADATA_VERSION,
          } satisfies CacheEntryV1,
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
    const nextIndex = buildIndex(this.index.roots, nextSummaries, nextHistorySources, undefined, this.index.sourceInventoryStates);
    const complete = areAllCodexEntriesVerifiedForIndex(entries, nextIndex);
    const nextCache: CacheFileV9 = {
      ...cache,
      codexAgentMetadataVersion: complete ? CODEX_AGENT_METADATA_VERSION : undefined,
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
      await this.writeCacheFile(nextCache, {
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
    const operation = { config, configRevision: this.configRevision };
    if (this.isOperationContextCurrent(operation)) this.reconcileAntigravityRootPermissions();
    throwIfHistoryRebuildCancelled(token);
    await this.prepareSqliteCache(config, dateTimeSettingsKey, true);
    const built = await this.buildHistoryState({
      config,
      dateTime,
      dateTimeSettingsKey,
      cachedEntries: {},
      token,
    }).finally(() => {
      // Permissions may have changed before the rebuild or while discovery was running.
      if (this.isOperationContextCurrent(operation)) this.reconcileAntigravityRootPermissions();
    });
    throwIfHistoryRebuildCancelled(token);
    const nativeRoots = built.sourceInventoryStates.antigravity.allowedRoots;
    if (this.nativeRootPermissionsChanged(config, nativeRoots)) throw new HistoryOperationSupersededError();
    if (!built.inventoryComplete) {
      if (this.isOperationContextCurrent(operation)) {
        this.applyNativeRootPermissions(Object.freeze({
          ...this.index.sourceInventoryStates,
          antigravity: built.sourceInventoryStates.antigravity,
        }));
      }
      throw new HistoryInventoryIncompleteError();
    }
    const rebuiltIndex = buildIndex(built.roots, built.sessions, built.historySources, undefined, built.sourceInventoryStates);
    const rebuiltFingerprints = this.buildHistoryStateFingerprints({
      roots: built.roots,
      sessions: built.sessions,
      historySources: built.historySources,
      cache: built.cache,
      logicalPlanSignatures: built.logicalPlanSignatures,
    });

    const writeCacheStartedAt = nowMs();
    await this.writeCacheFile(built.cache, {
      token,
      beforeCommit: () => {
        throwIfHistoryRebuildCancelled(token);
        if (this.nativeRootPermissionsChanged(config, nativeRoots)) throw new HistoryOperationSupersededError();
      },
    });
    const writeCacheMs = elapsedMs(writeCacheStartedAt);

    const currentDateTimeSettingsKey = getDateTimeSettingsKey(resolveDateTimeSettings());
    const adopted = this.isOperationContextCurrent(operation) && dateTimeSettingsKey === currentDateTimeSettingsKey &&
      !this.nativeRootPermissionsChanged(config, nativeRoots);
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
    await this.prepareSqliteCache(config, dateTimeSettingsKey);
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
        const diskCache = await this.readCacheFile(options.performanceProbe, config, dateTimeSettingsKey);
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
      publishStartupPreview: this.operationUsesSqlite && this.startupPreview && !this.cachePreparationError
        ? summaries => {
            if (this.isOperationContextCurrent(operation)) this.publishStartupPreview(config, summaries);
          }
        : undefined,
    });
    if (!this.isOperationContextCurrent(operation) ||
        this.nativeRootPermissionsChanged(config, built.sourceInventoryStates.antigravity.allowedRoots)) throw new HistoryOperationSupersededError();
    if (!built.coreInventoryComplete) {
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
      const statesChanged = !sameInventoryStates(this.index.sourceInventoryStates, built.sourceInventoryStates);
      const inventoryChanged = this.applyNativeRootPermissions(built.sourceInventoryStates, options.performanceProbe);
      if (!inventoryChanged && statesChanged) this.index = { ...this.index, sourceInventoryStates: built.sourceInventoryStates };
      return Object.freeze({
        presentationChanged: statesChanged || inventoryChanged,
        inventoryChanged,
        cacheChanged: false,
        cacheWrite: "skippedIncomplete" as const,
        unstableFileCount: built.unstableFileCount,
        inventoryComplete: false,
        coreInventoryComplete: false,
        sourceInventoryStates: this.index.sourceInventoryStates,
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
    const presentationChanged = !sameInventoryStates(this.index.sourceInventoryStates, built.sourceInventoryStates) || fingerprintsDiffer(
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
    const shouldWriteCache = built.inventoryComplete && (options.forceRebuildCache || cacheChanged);
    if (!cacheChanged) options.performanceProbe?.add("durableFingerprintHitCount");

    const candidateIndex = presentationChanged
      ? buildIndex(built.roots, built.sessions, built.historySources, options.performanceProbe, built.sourceInventoryStates)
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
    let cacheWrite: HistoryCacheWriteDisposition = built.inventoryComplete ? "skippedUnchanged" : "skippedIncomplete";
    if (shouldWriteCache) {
      const writeCacheStartedAt = nowMs();
      try {
        await this.writeCacheFile(built.cache, {
          performanceProbe: options.performanceProbe,
          beforeCommit: () => {
            if (
              !this.isOperationContextCurrent(operation) ||
              this.indexGeneration !== committedGeneration ||
              this.cacheForCurrentIndex !== built.cache ||
              this.nativeRootPermissionsChanged(config, built.sourceInventoryStates.antigravity.allowedRoots)
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
      coreInventoryComplete: built.coreInventoryComplete,
      sourceInventoryStates: built.sourceInventoryStates,
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
    publishStartupPreview?: (summaries: SessionSummary[]) => void;
  }): Promise<HistoryBuildResult> {
    const { config, dateTime, dateTimeSettingsKey, cachedEntries, token, performanceProbe } = params;
    const publish = params.publishStartupPreview;
    const resolvePreviewTitle = (summary: SessionSummary): SessionSummary => resolveSessionDisplayTitle({
      session: summary,
      titleSource: config.historyTitleSource,
      customTitle: this.titleOverrideStore.getTitle(summary),
    });
    const roots = buildHistoryRoots(config);
    let statMiss = 0;
    let cacheHit = 0;
    let cacheMiss = 0;
    let summaryOk = 0;
    let summaryFailed = 0;
    let summaryMs = 0;
    let unstableFileCount = 0;
    let incompleteFileCount = 0;
    let antigravityIncompleteFileCount = 0;

    throwIfHistoryRebuildCancelled(token);
    const discoverStartedAt = nowMs();
    const discovery = await discoverSessionFiles({
      codexRoot: config.sessionsRoot,
      codexArchivedRoot: config.codexArchivedSessionsRoot,
      claudeRoot: config.claudeSessionsRoot,
      includeCodex: config.enableCodexSource,
      includeCodexArchived: config.enableCodexArchivedSessions,
      includeCodexCompressed: config.enableCodexCompressedSessions === true,
      includeClaude: config.enableClaudeSource,
      antigravityRoots: config.antigravitySessionsRoots ?? [],
      includeAntigravity: config.enableAntigravitySource === true,
      onAntigravityDiscovered: publish ? async files => {
        publish([]);
        const previews = await mapWithConcurrency(files, HISTORY_REFRESH_CONCURRENCY, file =>
          buildAntigravityStartupSummary(file, dateTime.timeZone, cachedEntries[normalizeCacheKey(file.fsPath)]?.summary));
        const titled = previews.flatMap(summary =>
          summary ? [resolvePreviewTitle(applyHistoryDateBasis(summary, config.historyDateBasis))] : []);
        if (titled.length) publish(titled);
      } : undefined,
      performanceProbe,
    });
    const files = discovery.files;
    performanceProbe?.add("sessionCount", files.length);
    const discoverMs = elapsedMs(discoverStartedAt);
    throwIfHistoryRebuildCancelled(token);

    const nextEntries: Record<string, CacheEntryV1> = {};
    const summaries: SessionSummary[] = [];
    const processStartedAt = nowMs();
    const pendingCore = { codex: 0, claude: 0 };
    const corePreviews: Record<"codex" | "claude", SessionSummary[]> = { codex: [], claude: [] };
    let completeCodexPreview = discovery.coreFailureCount === 0;
    if (publish) for (const file of files) {
      if (file.source !== "antigravity") pendingCore[file.source]++;
    }
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
        if (token?.isCancellationRequested) return emptyRefreshFileResult();
        if (publish && file.source !== "antigravity") {
          const sourcePreviews = corePreviews[file.source];
          if (result.summary) sourcePreviews.push(result.summary);
          if (file.source === "codex" && (result.incomplete || !result.summary)) completeCodexPreview = false;
          if (--pendingCore[file.source] === 0 && sourcePreviews.length && (file.source !== "codex" || completeCodexPreview)) {
            publish(selectStartupSummaries(sourcePreviews).map(resolvePreviewTitle));
          }
        }
        return result;
      } catch (error) {
        if (token?.isCancellationRequested) return emptyRefreshFileResult();
        throw error;
      }
    });
    const processMs = elapsedMs(processStartedAt);
    throwIfHistoryRebuildCancelled(token);

    for (const [index, result] of fileResults.entries()) {
      statMiss += result.statMiss;
      cacheHit += result.cacheHit;
      cacheMiss += result.cacheMiss;
      summaryOk += result.summaryOk;
      summaryFailed += result.summaryFailed;
      summaryMs += result.summaryMs;
      unstableFileCount += result.unstableFileCount;
      if (result.incomplete) {
        if (files[index]?.source === "antigravity") antigravityIncompleteFileCount++;
        else incompleteFileCount++;
      }
      if (result.cacheKey && result.entry) nextEntries[result.cacheKey] = result.entry;
      if (result.summary) summaries.push(result.summary);
    }

    throwIfHistoryRebuildCancelled(token);
    const coreInventoryComplete = discovery.coreFailureCount === 0 && incompleteFileCount === 0;
    const antigravityComplete = discovery.antigravityFailureCount === 0 && antigravityIncompleteFileCount === 0;
    const inventoryComplete = coreInventoryComplete && antigravityComplete;
    if (!antigravityComplete && config.enableAntigravitySource) {
      // A configured alias may point to a different directory even when the settings are unchanged.
      const allowedRoots = new Set(discovery.antigravityRoots.map(normalizeFsPathKey));
      const sameConfig = this.index.sourceInventoryStates.antigravity.configKey === sourceInventoryConfigKey(config, "antigravity");
      const previous = sameConfig ? (this.index.historySources ?? this.index.sessions)
        : Object.values(cachedEntries).map(entry => entry.summary);
      for (let index = summaries.length - 1; index >= 0; index--) if (summaries[index]?.source === "antigravity") summaries.splice(index, 1);
      for (const [key, entry] of Object.entries(nextEntries)) if (entry.summary.source === "antigravity") delete nextEntries[key];
      for (const summary of previous) {
        if (summary.source !== "antigravity" || !allowedRoots.has(normalizeFsPathKey(summary.storage.rootPath))) continue;
        summaries.push(summary);
        const entry = cachedEntries[summary.cacheKey]; if (entry) nextEntries[summary.cacheKey] = entry;
      }
    }
    const states = (coreComplete: boolean, sourceSummaries = summaries): SourceInventoryStates =>
      this.buildSourceStates(config, discovery.antigravityRoots, coreComplete, antigravityComplete && coreComplete, sourceSummaries);
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
      coreInventoryComplete: false,
      sourceInventoryStates: states(false),
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
    if (!coreInventoryComplete) {
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
    const selectedSummaries = selectPreferredSummariesByIdentity(summaries, logicalPlans);
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

    sortSummariesByDisplayDate(resolvedSummaries);
    const resolvedHistorySources = replaceSummariesByCacheKey(historySources, resolvedSummaries);

    const metadataComplete = areAllCodexEntriesVerifiedForSessions(nextEntries, resolvedSummaries);
    return {
      roots,
      sessions: resolvedSummaries,
      historySources: resolvedHistorySources,
      logicalPlanSignatures: collectLogicalPlanSignatures(logicalPlans),
      cache: buildHistoryCacheCandidate(config, dateTimeSettingsKey, nextEntries, metadataComplete),
      verifiedCacheKeys: collectVerifiedCodexMetadataCacheKeys(nextEntries),
      metadataComplete,
      unstableFileCount,
      inventoryComplete,
      coreInventoryComplete: true,
      sourceInventoryStates: states(true, resolvedSummaries),
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

  public reconcileAntigravityRootPermissions(): boolean {
    const config = this.config;
    const roots = antigravityReader.getResolvedRoots(config.antigravitySessionsRoots ?? [], config.enableAntigravitySource === true);
    if (!roots || roots === this.lastResolvedAntigravityRoots) return false;
    this.lastResolvedAntigravityRoots = roots;
    const previous = this.index.sourceInventoryStates.antigravity;
    const changed = this.applyNativeRootPermissions(Object.freeze({
      ...this.index.sourceInventoryStates,
      antigravity: Object.freeze({
        ...previous, status: roots.length ? "partial" : "unavailable", configKey: sourceInventoryConfigKey(config, "antigravity"),
        configRevision: this.configRevision, allowedRoots: roots, generation: previous.generation + 1,
      }),
    }));
    if (this.startupPreview?.index) this.publishStartupPreview(config, [], false, roots);
    return changed;
  }

  private nativeRootPermissionsChanged(config: CodexHistoryViewerConfig, roots: readonly string[]): boolean {
    const authorized = antigravityReader.getResolvedRoots(config.antigravitySessionsRoots ?? [], config.enableAntigravitySource === true);
    return authorized !== undefined && !haveSameNativeRoots(roots, authorized);
  }

  private applyNativeRootPermissions(states: SourceInventoryStates, performanceProbe?: PerformanceProbe): boolean {
    const allowedRoots = new Set(states.antigravity.allowedRoots.map(normalizeFsPathKey));
    const retained = (summary: SessionSummary): boolean =>
      summary.source !== "antigravity" || allowedRoots.has(normalizeFsPathKey(summary.storage.rootPath));
    const previous = this.index.sourceInventoryStates.antigravity;
    const scopeChanged = previous.configKey !== "" && !haveSameNativeRoots(previous.allowedRoots, states.antigravity.allowedRoots);
    const sources = this.index.historySources ?? this.index.sessions;
    const historySources = sources.filter(retained);
    if (historySources.length === sources.length && !scopeChanged) return false;
    this.index = this.withSourceGenerations(historySources.length === sources.length ? { ...this.index, sourceInventoryStates: states }
      : buildIndex(this.index.roots, this.index.sessions.filter(retained), historySources, performanceProbe, states));
    this.indexGeneration++;
    this.indexInventoryGeneration++;
    this.cacheIndexGeneration = -1;
    this.cacheForCurrentIndex = null;
    this.stateFingerprints = null;
    return true;
  }

  private buildSourceStates(config: CodexHistoryViewerConfig, antigravityRoots: readonly string[], coreComplete: boolean, antigravityComplete: boolean, sessions: readonly SessionSummary[]): SourceInventoryStates {
    const build = (source: "codex" | "claude" | "antigravity") => {
      const enabled = source === "antigravity" ? config.enableAntigravitySource === true : source === "claude" ? config.enableClaudeSource : config.enableCodexSource || config.enableCodexArchivedSessions;
      const complete = source === "antigravity" ? antigravityComplete : coreComplete;
      const allowedRoots = source === "antigravity" ? antigravityRoots : source === "claude" ? [config.claudeSessionsRoot]
        : [config.enableCodexSource ? config.sessionsRoot : undefined, config.enableCodexArchivedSessions ? config.codexArchivedSessionsRoot : undefined].filter((root): root is string => root !== undefined);
      const configKey = sourceInventoryConfigKey(config, source), previous = this.index.sourceInventoryStates[source];
      const sourceSessions = sessions.filter(summary => summary.source === source);
      const status = !enabled ? "disabled" : complete ? "complete" : sourceSessions.length ? "partial" : "unavailable";
      // Compare summaries only after logical projection and presentation have been finalized in commitIndexState.
      const unchanged = previous.status === status && previous.configKey === configKey && JSON.stringify(previous.allowedRoots) === JSON.stringify(allowedRoots);
      return Object.freeze({ status, configKey, configRevision: this.configRevision, generation: previous.generation + (unchanged ? 0 : 1), allowedRoots: Object.freeze([...allowedRoots]) });
    };
    return Object.freeze({ codex: build("codex"), claude: build("claude"), antigravity: build("antigravity") });
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

    if (file.source === "antigravity") {
      const started = nowMs();
      try {
        // Native WAL commits can leave the DB mtime unchanged; always revalidate native metadata.
        const summary = applyHistoryDateBasis(await buildAntigravitySessionSummary(file, inputStamp, timeZone, token), historyDateBasis);
        const entry = { mtimeMs: inputStamp.mtimeMs, size: inputStamp.size, summary };
        return emptyRefreshFileResult({ cacheKey: key, entry, summary, cacheMiss: 1, summaryOk: 1, summaryMs: elapsedMs(started) });
      } catch {
        throwIfHistoryRebuildCancelled(token);
        return emptyRefreshFileResult({ cacheMiss: 1, summaryFailed: 1, summaryMs: elapsedMs(started), incomplete: true });
      }
    }

    const cached = cachedEntries[key];
    const claudeAgent = file.source === "claude" ? await readClaudeAgentMetadata(fsPath, file.rootPath) : undefined;
    const sameClaudeAgent = JSON.stringify(cached?.summary.meta.claudeAgent) === JSON.stringify(claudeAgent);
    if (cached && sameClaudeAgent && cached.summary.fsPath === fsPath && cached.summary.source === file.source &&
        cached.summary.storage.rootKind === file.rootKind && cached.summary.storage.archiveState === file.archiveState &&
        normalizeFsPathKey(cached.summary.storage.rootPath) === normalizeFsPathKey(file.rootPath) &&
        cached.mtimeMs === inputStamp.mtimeMs && cached.size === inputStamp.size) {
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
      const verifiedClaudeAgent = file.source === "claude" ? await readClaudeAgentMetadata(fsPath, file.rootPath) : undefined;
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
      if (!areSameHistoryInputStamp(inputStamp, verifiedStamp) ||
        JSON.stringify(builtSummary?.meta.claudeAgent) !== JSON.stringify(verifiedClaudeAgent)) {
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
          ...(summary.source === "codex" ? { codexAgentMetadataVersion: CODEX_AGENT_METADATA_VERSION } : {}),
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
      cache.antigravitySessionsRoots ?? [],
      cache.includeCodex,
      cache.includeCodexArchived,
      cache.includeCodexCompressed === true,
      cache.includeClaude,
      cache.includeAntigravity === true,
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

  private async prepareSqliteCache(config: CodexHistoryViewerConfig, dateTimeSettingsKey: string, strict = false): Promise<void> {
    const usesSqlite = Boolean(this.sqliteValues && await this.sqliteCache?.ready());
    if (this.operationUsesSqlite !== usesSqlite) this.persistedCacheFingerprint = null;
    this.operationUsesSqlite = usesSqlite;
    this.cachePreparationError = undefined;
    if (!usesSqlite) this.endStartupPreview();
    if (this.operationUsesSqlite) {
      try { await this.sqliteValues!.prepare(historySqliteContext(config, dateTimeSettingsKey)); }
      catch (error) {
        this.cachePreparationError = error;
        this.endStartupPreview();
        if (strict) throw error;
        this.logger?.debug("history.sqlite cache preparation failed");
      }
    }
  }

  private async writeCacheFile(cache: CacheFileV9, options: { beforeCommit?: () => void; performanceProbe?: PerformanceProbe; token?: vscode.CancellationToken }): Promise<void> {
    if (this.operationUsesSqlite && this.sqliteValues) {
      if (this.cachePreparationError) throw this.cachePreparationError;
      const { entries, ...header } = cache;
      await this.sqliteValues.save(historySqliteContextFromCache(cache), { header, entries }, options);
      return;
    }
    await writeJson(this.getCacheUri(), cache, options);
  }

  private async readCacheFile(performanceProbe?: PerformanceProbe, config = this.config,
    dateTimeSettingsKey = getDateTimeSettingsKey(resolveDateTimeSettings())): Promise<unknown | null> {
    if (this.operationUsesSqlite && this.sqliteValues) {
      if (this.cachePreparationError) return null;
      try {
        const document = await this.sqliteValues.load(historySqliteContext(config, dateTimeSettingsKey));
        return document ? { ...document.header, entries: document.entries } : null;
      } catch {
        this.logger?.debug("history.sqlite cache read failed");
        return null;
      }
    }
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
      cache.storageContractFingerprint === STORAGE_CONTRACT_FINGERPRINT &&
      cache.summaryAlgoVersion === SUMMARY_CACHE_ALGO_VERSION &&
      cache.codexSessionsRoot === config.sessionsRoot &&
      cache.codexArchivedSessionsRoot === config.codexArchivedSessionsRoot &&
      cache.claudeSessionsRoot === config.claudeSessionsRoot &&
      JSON.stringify(cache.antigravitySessionsRoots ?? []) === JSON.stringify(config.antigravitySessionsRoots ?? []) &&
      cache.includeCodex === config.enableCodexSource &&
      cache.includeCodexArchived === config.enableCodexArchivedSessions &&
      (cache.includeCodexCompressed === true) === (config.enableCodexCompressedSessions === true) &&
      cache.includeClaude === config.enableClaudeSource &&
      (cache.includeAntigravity === true) === (config.enableAntigravitySource === true) &&
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
    antigravitySessionsRoots: Object.freeze([...(config.antigravitySessionsRoots ?? [])]),
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
    left.claudeSessionsRoot === right.claudeSessionsRoot &&
    JSON.stringify(left.antigravitySessionsRoots ?? []) === JSON.stringify(right.antigravitySessionsRoots ?? []);
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
    JSON.stringify(left.antigravitySessionsRoots ?? []) !== JSON.stringify(right.antigravitySessionsRoots ?? []) ||
    left.includeCodex !== right.includeCodex ||
    left.includeCodexArchived !== right.includeCodexArchived ||
    (left.includeCodexCompressed === true) !== (right.includeCodexCompressed === true) ||
    left.includeClaude !== right.includeClaude ||
    (left.includeAntigravity === true) !== (right.includeAntigravity === true) ||
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
    summary.codexRollbackRevision,
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
      summary.meta.claudeAgent,
      projectCodexFork(summary.meta.codexFork),
      projectCodexHistoryBase(summary.meta.codexHistoryBase),
      summary.meta.codexStandaloneHistory,
      summary.meta.antigravity,
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
  return [roots.codexSessionsRoot, roots.codexArchivedSessionsRoot, roots.claudeSessionsRoot, roots.antigravitySessionsRoots ?? []];
}

function projectCodexAgent(value: SessionSummary["meta"]["codexAgent"]): unknown[] | undefined {
  return value
    ? [value.parentThreadId, value.kind, value.recordedDepth, value.agentPath, value.agentNickname, value.agentRole]
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
    storageContractFingerprint: STORAGE_CONTRACT_FINGERPRINT,
    summaryAlgoVersion: SUMMARY_CACHE_ALGO_VERSION,
    ...(metadataComplete ? { codexAgentMetadataVersion: CODEX_AGENT_METADATA_VERSION } : {}),
    codexSessionsRoot: config.sessionsRoot,
    codexArchivedSessionsRoot: config.codexArchivedSessionsRoot,
    claudeSessionsRoot: config.claudeSessionsRoot,
    antigravitySessionsRoots: config.antigravitySessionsRoots ?? [],
    includeCodex: config.enableCodexSource,
    includeCodexArchived: config.enableCodexArchivedSessions,
    includeCodexCompressed: config.enableCodexCompressedSessions === true,
    includeClaude: config.enableClaudeSource,
    includeAntigravity: config.enableAntigravitySource === true,
    previewMaxMessages: config.previewMaxMessages,
    dateTimeSettingsKey,
    entries,
  };
}

function historySqliteContext(config: CodexHistoryViewerConfig, dateTimeSettingsKey: string): Record<string, unknown> {
  return historySqliteContextFromCache(buildHistoryCacheCandidate(config, dateTimeSettingsKey, {}, false));
}

function historySqliteContextFromCache(cache: CacheFileV9): Record<string, unknown> {
  const { entries: _entries, codexAgentMetadataVersion: _metadataComplete, ...context } = cache;
  return context;
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
    config.antigravitySessionsRoots ?? [],
    config.enableCodexSource,
    config.enableCodexArchivedSessions,
    config.enableCodexCompressedSessions === true,
    config.enableClaudeSource,
    config.enableAntigravitySource === true,
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
    storageContractFingerprint: STORAGE_CONTRACT_FINGERPRINT,
    summaryAlgoVersion: SUMMARY_CACHE_ALGO_VERSION,
    codexAgentMetadataVersion: cache.codexAgentMetadataVersion === CODEX_AGENT_METADATA_VERSION ? CODEX_AGENT_METADATA_VERSION : undefined,
    codexSessionsRoot: cache.codexSessionsRoot,
    codexArchivedSessionsRoot: cache.codexArchivedSessionsRoot,
    claudeSessionsRoot: cache.claudeSessionsRoot,
    antigravitySessionsRoots: Array.isArray(cache.antigravitySessionsRoots) ? cache.antigravitySessionsRoots : [],
    includeCodex: cache.includeCodex,
    includeCodexArchived: cache.includeCodexArchived,
    includeCodexCompressed: cache.includeCodexCompressed === true,
    includeClaude: cache.includeClaude,
    includeAntigravity: cache.includeAntigravity === true,
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
  if (summary.source === "antigravity") {
    return { mtimeMs, size, summary: { ...summary, fileSizeBytes: size, meta: {
      id: summary.meta.id, timestampIso: typeof summary.meta.timestampIso === "string" ? summary.meta.timestampIso : undefined,
      cwd: typeof summary.meta.cwd === "string" ? summary.meta.cwd : undefined, historySource: "antigravity", antigravity: summary.meta.antigravity,
    } } };
  }
  if (summary.source !== "codex") {
    // Child relationships must be revalidated from the adjacent sidecar, never trusted from disk cache.
    if (parseClaudeAgentPath(summary.fsPath, summary.storage.rootPath) || summary.meta.claudeAgent !== undefined) return null;
    const meta = { ...summary.meta };
    delete meta.codexAgent;
    delete meta.codexFork;
    delete meta.codexHistoryBase;
    delete meta.codexStandaloneHistory;
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
  if (summary.meta.codexStandaloneHistory !== undefined &&
    (summary.meta.codexStandaloneHistory !== true || sanitizedHistoryBase.value)) return null;
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
      value.codexAgentMetadataVersion === CODEX_AGENT_METADATA_VERSION && sanitized.valid ? CODEX_AGENT_METADATA_VERSION : undefined,
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
    (value.source !== "codex" && value.source !== "claude" && value.source !== "antigravity") ||
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
      storage.rootKind !== "claudeSessions" && storage.rootKind !== "antigravitySessions") ||
    (storage.archiveState !== "active" && storage.archiveState !== "archived") ||
    typeof storage.rootPath !== "string"
  ) {
    return null;
  }
  if (value.source === "antigravity") {
    if (storage.rootKind !== "antigravitySessions" || storage.archiveState !== "active" || typeof value.meta.id !== "string"
      || !ANTIGRAVITY_UUID.test(value.meta.id) || value.identityKey !== antigravitySessionIdentity(storage.rootPath as string, value.meta.id)
      || value.fsPath !== path.join(storage.rootPath as string, "conversations", value.meta.id + ".db")
      || !isPlainRecord(value.meta.antigravity) || value.meta.antigravity.profile !== "sqliteStepsV1"
      || !["available", "metadataOnly", "unavailable"].includes(String(value.meta.antigravity.availability)) || !Array.isArray(value.meta.antigravity.issues)
      || value.meta.antigravity.issues.length > 10 || !value.meta.antigravity.issues.every(issue => typeof issue === "string" && ["unknownStep", "invalidStep", "unknownPayload", "unmatchedTool", "duplicateTool", "truncated", "unsupportedAttachment", "unknownUsage", "jsonlFallback"].includes(issue))) return null;
  }
  if (
    !hasRequiredCachedSummaryStrings(value) ||
    !hasValidOptionalCachedSummaryStrings(value) ||
    !hasValidCachedPreviewMessages(value.previewMessages) ||
    !hasValidCachedInferredYmd(value.inferredYmd) ||
    (value.codexRollbackRevision !== undefined &&
      (value.source !== "codex" || !Number.isSafeInteger(value.codexRollbackRevision) || Number(value.codexRollbackRevision) <= 0))
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
    entry.summary.source !== "codex" || entry.codexAgentMetadataVersion === CODEX_AGENT_METADATA_VERSION
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
    if (entry.summary.source !== "codex" || entry.codexAgentMetadataVersion !== CODEX_AGENT_METADATA_VERSION) continue;
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
    cache.codexAgentMetadataVersion === CODEX_AGENT_METADATA_VERSION &&
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
  sourceInventoryStates?: SourceInventoryStates,
): HistoryIndex {
  const idx: HistoryIndex = emptyIndex(roots, performanceProbe);
  idx.sessions = summaries;
  idx.historySources = historySources;
  if (sourceInventoryStates) idx.sourceInventoryStates = sourceInventoryStates;

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

function sameInventoryStates(left: SourceInventoryStates, right: SourceInventoryStates): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
