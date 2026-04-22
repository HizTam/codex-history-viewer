import * as vscode from "vscode";
import type { CodexHistoryViewerConfig, HistoryDateBasis } from "../settings";
import { findSessionFiles } from "../sessions/sessionDiscovery";
import type { HistoryIndex, SessionSummary } from "../sessions/sessionTypes";
import { buildSessionSummary } from "../sessions/sessionSummary";
import { resolveSessionDisplayTitle, resolveSessionDisplayTitles } from "../sessions/sessionTitleResolver";
import { normalizeCacheKey } from "../utils/fsUtils";
import { readJson, writeJson } from "../storage/jsonStorage";
import { getDateTimeSettingsKey, resolveDateTimeSettings } from "../utils/dateTimeSettings";
import { CodexTitleStore } from "./codexTitleStore";
import type { DebugLogger } from "./logger";

interface CacheEntryV1 {
  mtimeMs: number;
  size: number;
  summary: SessionSummary;
}

const SUMMARY_CACHE_ALGO_VERSION = 8;
const HISTORY_CACHE_FILE_NAME = "cache.v8.json";
const HISTORY_CACHE_FILE_PATTERN = /^cache\.v\d+\.json$/i;
const HISTORY_REFRESH_CONCURRENCY = 4;

interface CacheFileV8 {
  version: 8;
  summaryAlgoVersion: number;
  codexSessionsRoot: string;
  claudeSessionsRoot: string;
  includeCodex: boolean;
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

function emptyIndex(sessionsRoot: string): HistoryIndex {
  return {
    sessionsRoot,
    sessions: [],
    byCacheKey: new Map(),
    byYmd: new Map(),
    byYm: new Map(),
    byY: new Map(),
  };
}

export class HistoryService {
  private readonly globalStorageUri: vscode.Uri;
  private readonly codexTitleStore: CodexTitleStore;
  private readonly logger?: DebugLogger;
  private config: CodexHistoryViewerConfig;
  private index: HistoryIndex;

  constructor(globalStorageUri: vscode.Uri, config: CodexHistoryViewerConfig, logger?: DebugLogger) {
    this.globalStorageUri = globalStorageUri;
    this.codexTitleStore = new CodexTitleStore(globalStorageUri);
    this.logger = logger;
    this.config = config;
    this.index = emptyIndex(config.sessionsRoot);
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
    });
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
    const claudeSessionsRoot = this.config.claudeSessionsRoot;

    const dateTime = resolveDateTimeSettings();
    const dateTimeSettingsKey = getDateTimeSettingsKey(dateTime);

    const cacheUri = vscode.Uri.joinPath(this.globalStorageUri, HISTORY_CACHE_FILE_NAME);
    const cache = options.forceRebuildCache ? null : await readJson<CacheFileV8>(cacheUri);

    const cachedEntries: Record<string, CacheEntryV1> =
      cache &&
      cache.version === 8 &&
      cache.summaryAlgoVersion === SUMMARY_CACHE_ALGO_VERSION &&
      cache.codexSessionsRoot === sessionsRoot &&
      cache.claudeSessionsRoot === claudeSessionsRoot &&
      cache.includeCodex === this.config.enableCodexSource &&
      cache.includeClaude === this.config.enableClaudeSource &&
      cache.previewMaxMessages === this.config.previewMaxMessages &&
      cache.dateTimeSettingsKey === dateTimeSettingsKey
        ? cache.entries
        : {};

    const discoverStartedAt = nowMs();
    const files = await findSessionFiles({
      codexRoot: sessionsRoot,
      claudeRoot: claudeSessionsRoot,
      includeCodex: this.config.enableCodexSource,
      includeClaude: this.config.enableClaudeSource,
    });
    discoverMs = elapsedMs(discoverStartedAt);
    const nextEntries: Record<string, CacheEntryV1> = {};
    const summaries: SessionSummary[] = [];

    const processStartedAt = nowMs();
    const fileResults = await mapWithConcurrency(files, HISTORY_REFRESH_CONCURRENCY, async (fsPath) =>
      this.refreshFile({
        fsPath,
        sessionsRoot,
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
    const resolvedSummaries = await this.resolveDisplayTitles(summaries);
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

    this.index = buildIndex(sessionsRoot, summaries);
    const nextCache: CacheFileV8 = {
      version: 8,
      summaryAlgoVersion: SUMMARY_CACHE_ALGO_VERSION,
      codexSessionsRoot: sessionsRoot,
      claudeSessionsRoot,
      includeCodex: this.config.enableCodexSource,
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
    fsPath: string;
    sessionsRoot: string;
    cachedEntries: Record<string, CacheEntryV1>;
    previewMaxMessages: number;
    timeZone: string;
    historyDateBasis: HistoryDateBasis;
  }): Promise<RefreshFileResult> {
    const { fsPath, sessionsRoot, cachedEntries, previewMaxMessages, timeZone, historyDateBasis } = params;
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
      sessionsRoot,
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
      this.config.enableCodexSource
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
    });
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

function buildIndex(sessionsRoot: string, summaries: SessionSummary[]): HistoryIndex {
  const idx: HistoryIndex = emptyIndex(sessionsRoot);
  idx.sessions = summaries;

  for (const s of summaries) {
    idx.byCacheKey.set(s.cacheKey, s);

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
