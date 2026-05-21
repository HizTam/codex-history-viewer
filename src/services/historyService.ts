import * as vscode from "vscode";
import type { CodexHistoryViewerConfig, HistoryDateBasis } from "../settings";
import { findSessionFiles, type DiscoveredSessionFile } from "../sessions/sessionDiscovery";
import type { HistoryIndex, HistoryRoots, SessionSummary } from "../sessions/sessionTypes";
import { buildSessionSummary } from "../sessions/sessionSummary";
import { resolveSessionDisplayTitle, resolveSessionDisplayTitles } from "../sessions/sessionTitleResolver";
import { normalizeCacheKey } from "../utils/fsUtils";
import { readJson, writeJson } from "../storage/jsonStorage";
import { getDateTimeSettingsKey, resolveDateTimeSettings } from "../utils/dateTimeSettings";
import { CodexTitleStore } from "./codexTitleStore";
import type { SessionTitleOverrideStore } from "./sessionTitleOverrideStore";
import type { DebugLogger } from "./logger";

interface CacheEntryV1 {
  mtimeMs: number;
  size: number;
  summary: SessionSummary;
}

const SUMMARY_CACHE_ALGO_VERSION = 9;
const HISTORY_CACHE_FILE_NAME = "cache.v9.json";
const HISTORY_CACHE_FILE_PATTERN = /^cache\.v\d+\.json$/i;
const HISTORY_REFRESH_CONCURRENCY = 4;

interface CacheFileV9 {
  version: 9;
  summaryAlgoVersion: number;
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
  private index: HistoryIndex;

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
    this.index = emptyIndex(buildHistoryRoots(config));
  }

  public updateConfig(config: CodexHistoryViewerConfig): void {
    this.config = config;
  }

  public getIndex(): HistoryIndex {
    return this.index;
  }

  public findByFsPath(fsPath: string): SessionSummary | undefined {
    const key = normalizeCacheKey(fsPath);
    return this.index.byCacheKey.get(key);
  }

  public async resolveDisplaySummary(summary: SessionSummary): Promise<SessionSummary> {
    const codexTitlesById =
      summary.source === "codex" && summary.meta.id
        ? await this.codexTitleStore.getTitles({
            sessionsRoot: this.config.sessionsRoot,
            sessionIds: [summary.meta.id],
            pruneToSessionIds: false,
          })
        : new Map<string, string>();

    return resolveSessionDisplayTitle({
      session: summary,
      titleSource: this.config.historyTitleSource,
      codexTitlesById,
      customTitle: this.titleOverrideStore.getTitle(summary),
    });
  }

  public async loadCachedIndexIfFresh(): Promise<boolean> {
    const startedAt = nowMs();
    const dateTime = resolveDateTimeSettings();
    const dateTimeSettingsKey = getDateTimeSettingsKey(dateTime);
    const cache = await readJson<CacheFileV9>(this.getCacheUri());
    if (!this.isFreshCache(cache, dateTimeSettingsKey)) {
      this.logger?.debug(`history.cacheImmediate miss totalMs=${elapsedMs(startedAt)}`);
      return false;
    }

    const roots = buildHistoryRoots(this.config);
    const summaries = Object.values(cache.entries)
      .map((entry) => applyHistoryDateBasis(entry.summary, this.config.historyDateBasis));
    const selectedSummaries = selectPreferredSummariesByIdentity(summaries);
    const resolvedSummaries = await this.resolveDisplayTitles(selectedSummaries);
    sortSummariesByDisplayDate(resolvedSummaries);
    this.index = buildIndex(roots, resolvedSummaries);
    this.logger?.debug(
      [
        "history.cacheImmediate loaded",
        `totalMs=${elapsedMs(startedAt)}`,
        `entries=${Object.keys(cache.entries).length}`,
        `sessions=${resolvedSummaries.length}`,
      ].join(" "),
    );
    return true;
  }

  public async refresh(options: { forceRebuildCache: boolean }): Promise<void> {
    const totalStartedAt = nowMs();
    let discoverMs = 0;
    let statMiss = 0;
    let cacheHit = 0;
    let cacheMiss = 0;
    let summaryOk = 0;
    let summaryFailed = 0;
    let summaryMs = 0;
    let processMs = 0;
    let titleMs = 0;
    let writeCacheMs = 0;

    this.updateConfig(this.config);
    const sessionsRoot = this.config.sessionsRoot;
    const codexArchivedSessionsRoot = this.config.codexArchivedSessionsRoot;
    const claudeSessionsRoot = this.config.claudeSessionsRoot;
    const roots = buildHistoryRoots(this.config);

    const dateTime = resolveDateTimeSettings();
    const dateTimeSettingsKey = getDateTimeSettingsKey(dateTime);

    const cacheUri = this.getCacheUri();
    const cache = options.forceRebuildCache ? null : await readJson<CacheFileV9>(cacheUri);

    const cachedEntries: Record<string, CacheEntryV1> = this.isFreshCache(cache, dateTimeSettingsKey)
      ? cache.entries
      : {};

    const discoverStartedAt = nowMs();
    const files = await findSessionFiles({
      codexRoot: sessionsRoot,
      codexArchivedRoot: codexArchivedSessionsRoot,
      claudeRoot: claudeSessionsRoot,
      includeCodex: this.config.enableCodexSource,
      includeCodexArchived: this.config.enableCodexArchivedSessions,
      includeClaude: this.config.enableClaudeSource,
    });
    discoverMs = elapsedMs(discoverStartedAt);
    const nextEntries: Record<string, CacheEntryV1> = {};
    const summaries: SessionSummary[] = [];

    const processStartedAt = nowMs();
    const fileResults = await mapWithConcurrency(files, HISTORY_REFRESH_CONCURRENCY, async (file) =>
      this.refreshFile({
        file,
        cachedEntries,
        previewMaxMessages: this.config.previewMaxMessages,
        timeZone: dateTime.timeZone,
        historyDateBasis: this.config.historyDateBasis,
      }),
    );
    processMs = elapsedMs(processStartedAt);

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

    const titleStartedAt = nowMs();
    const selectedSummaries = selectPreferredSummariesByIdentity(summaries);
    const resolvedSummaries = await this.resolveDisplayTitles(selectedSummaries);
    titleMs = elapsedMs(titleStartedAt);
    const summariesByKey = new Map(resolvedSummaries.map((summary) => [summary.cacheKey, summary] as const));
    for (const [cacheKey, entry] of Object.entries(nextEntries)) {
      const resolvedSummary = summariesByKey.get(cacheKey);
      if (!resolvedSummary) continue;
      entry.summary = resolvedSummary;
    }

    summaries.length = 0;
    summaries.push(...resolvedSummaries);
    sortSummariesByDisplayDate(summaries);

    this.index = buildIndex(roots, summaries);
    const nextCache: CacheFileV9 = {
      version: 9,
      summaryAlgoVersion: SUMMARY_CACHE_ALGO_VERSION,
      codexSessionsRoot: sessionsRoot,
      codexArchivedSessionsRoot,
      claudeSessionsRoot,
      includeCodex: this.config.enableCodexSource,
      includeCodexArchived: this.config.enableCodexArchivedSessions,
      includeClaude: this.config.enableClaudeSource,
      previewMaxMessages: this.config.previewMaxMessages,
      dateTimeSettingsKey,
      entries: nextEntries,
    };
    const writeCacheStartedAt = nowMs();
    await writeJson(cacheUri, nextCache);
    writeCacheMs = elapsedMs(writeCacheStartedAt);
    await cleanupObsoleteHistoryCacheFiles(this.globalStorageUri, HISTORY_CACHE_FILE_NAME);

    this.logger?.debug(
      [
        "history.refresh done",
        `totalMs=${elapsedMs(totalStartedAt)}`,
        `files=${files.length}`,
        `discoverMs=${discoverMs}`,
        `processMs=${processMs}`,
        `statMiss=${statMiss}`,
        `cacheHit=${cacheHit}`,
        `cacheMiss=${cacheMiss}`,
        `summaryOk=${summaryOk}`,
        `summaryFailed=${summaryFailed}`,
        `summaryMs=${summaryMs}`,
        `titleMs=${titleMs}`,
        `writeCacheMs=${writeCacheMs}`,
      ].join(" "),
    );
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
      entry: { mtimeMs: st.mtimeMs, size: st.size, summary },
      summary,
      cacheMiss: 1,
      summaryOk: 1,
      summaryMs: fileSummaryMs,
    });
  }

  private async resolveDisplayTitles(summaries: readonly SessionSummary[]): Promise<SessionSummary[]> {
    const codexSessionIds = summaries
      .filter((summary) => summary.source === "codex")
      .map((summary) => summary.meta.id)
      .filter((sessionId): sessionId is string => typeof sessionId === "string" && sessionId.trim().length > 0);
    const codexTitlesById =
      this.config.enableCodexSource || this.config.enableCodexArchivedSessions
        ? await this.codexTitleStore.getTitles({
            sessionsRoot: this.config.sessionsRoot,
            sessionIds: codexSessionIds,
            pruneToSessionIds: true,
          })
        : new Map<string, string>();

    return resolveSessionDisplayTitles({
      sessions: summaries,
      titleSource: this.config.historyTitleSource,
      codexTitlesById,
      getCustomTitle: (session) => this.titleOverrideStore.getTitle(session),
    });
  }

  private getCacheUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.globalStorageUri, HISTORY_CACHE_FILE_NAME);
  }

  private isFreshCache(cache: CacheFileV9 | null, dateTimeSettingsKey: string): cache is CacheFileV9 {
    return (
      !!cache &&
      cache.version === 9 &&
      cache.summaryAlgoVersion === SUMMARY_CACHE_ALGO_VERSION &&
      cache.codexSessionsRoot === this.config.sessionsRoot &&
      cache.codexArchivedSessionsRoot === this.config.codexArchivedSessionsRoot &&
      cache.claudeSessionsRoot === this.config.claudeSessionsRoot &&
      cache.includeCodex === this.config.enableCodexSource &&
      cache.includeCodexArchived === this.config.enableCodexArchivedSessions &&
      cache.includeClaude === this.config.enableClaudeSource &&
      cache.previewMaxMessages === this.config.previewMaxMessages &&
      cache.dateTimeSettingsKey === dateTimeSettingsKey &&
      !!cache.entries &&
      typeof cache.entries === "object"
    );
  }
}

function nowMs(): number {
  return Date.now();
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, nowMs() - startedAt);
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
