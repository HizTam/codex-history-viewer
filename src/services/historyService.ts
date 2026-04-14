import * as vscode from "vscode";
import type { CodexHistoryViewerConfig, HistoryDateBasis } from "../settings";
import { findSessionFiles } from "../sessions/sessionDiscovery";
import type { HistoryIndex, SessionSummary } from "../sessions/sessionTypes";
import { buildSessionSummary } from "../sessions/sessionSummary";
import { normalizeCacheKey } from "../utils/fsUtils";
import { readJson, writeJson } from "../storage/jsonStorage";
import { getDateTimeSettingsKey, resolveDateTimeSettings } from "../utils/dateTimeSettings";

interface CacheEntryV1 {
  mtimeMs: number;
  size: number;
  summary: SessionSummary;
}

const SUMMARY_CACHE_ALGO_VERSION = 6;
const HISTORY_CACHE_FILE_NAME = "cache.v6.json";
const HISTORY_CACHE_FILE_PATTERN = /^cache\.v\d+\.json$/i;

interface CacheFileV6 {
  version: 6;
  summaryAlgoVersion: number;
  codexSessionsRoot: string;
  claudeSessionsRoot: string;
  includeCodex: boolean;
  includeClaude: boolean;
  previewMaxMessages: number;
  dateTimeSettingsKey: string;
  entries: Record<string, CacheEntryV1>;
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
    byYmd: new Map(),
    byYm: new Map(),
    byY: new Map(),
  };
}

export class HistoryService {
  private readonly globalStorageUri: vscode.Uri;
  private config: CodexHistoryViewerConfig;
  private index: HistoryIndex;

  constructor(globalStorageUri: vscode.Uri, config: CodexHistoryViewerConfig) {
    this.globalStorageUri = globalStorageUri;
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
    return this.index.sessions.find((s) => s.cacheKey === key);
  }

  public async refresh(options: { forceRebuildCache: boolean }): Promise<void> {
    this.updateConfig(this.config);
    const sessionsRoot = this.config.sessionsRoot;
    const claudeSessionsRoot = this.config.claudeSessionsRoot;

    const dateTime = resolveDateTimeSettings();
    const dateTimeSettingsKey = getDateTimeSettingsKey(dateTime);

    const cacheUri = vscode.Uri.joinPath(this.globalStorageUri, HISTORY_CACHE_FILE_NAME);
    const cache = options.forceRebuildCache ? null : await readJson<CacheFileV6>(cacheUri);

    const cachedEntries: Record<string, CacheEntryV1> =
      cache &&
      cache.version === 6 &&
      cache.summaryAlgoVersion === SUMMARY_CACHE_ALGO_VERSION &&
      cache.codexSessionsRoot === sessionsRoot &&
      cache.claudeSessionsRoot === claudeSessionsRoot &&
      cache.includeCodex === this.config.enableCodexSource &&
      cache.includeClaude === this.config.enableClaudeSource &&
      cache.previewMaxMessages === this.config.previewMaxMessages &&
      cache.dateTimeSettingsKey === dateTimeSettingsKey
        ? cache.entries
        : {};

    const files = await findSessionFiles({
      codexRoot: sessionsRoot,
      claudeRoot: claudeSessionsRoot,
      includeCodex: this.config.enableCodexSource,
      includeClaude: this.config.enableClaudeSource,
    });
    const nextEntries: Record<string, CacheEntryV1> = {};
    const summaries: SessionSummary[] = [];

    for (const fsPath of files) {
      const key = normalizeCacheKey(fsPath);
      let st: { mtimeMs: number; size: number } | null = null;
      try {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
        st = { mtimeMs: stat.mtime, size: stat.size };
      } catch {
        // Skip unreadable files.
        continue;
      }

      const cached = cachedEntries[key];
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        const summary = applyHistoryDateBasis(cached.summary, this.config.historyDateBasis);
        nextEntries[key] = { ...cached, summary };
        summaries.push(summary);
        continue;
      }

      const builtSummary = await buildSessionSummary({
        sessionsRoot,
        fsPath,
        previewMaxMessages: this.config.previewMaxMessages,
        timeZone: dateTime.timeZone,
      });
      if (!builtSummary) continue;
      const summary = applyHistoryDateBasis(builtSummary, this.config.historyDateBasis);
      nextEntries[key] = { mtimeMs: st.mtimeMs, size: st.size, summary };
      summaries.push(summary);
    }

    sortSummariesByDisplayDate(summaries);

    this.index = buildIndex(sessionsRoot, summaries);
    const nextCache: CacheFileV6 = {
      version: 6,
      summaryAlgoVersion: SUMMARY_CACHE_ALGO_VERSION,
      codexSessionsRoot: sessionsRoot,
      claudeSessionsRoot,
      includeCodex: this.config.enableCodexSource,
      includeClaude: this.config.enableClaudeSource,
      previewMaxMessages: this.config.previewMaxMessages,
      dateTimeSettingsKey,
      entries: nextEntries,
    };
    await writeJson(cacheUri, nextCache);
    await cleanupObsoleteHistoryCacheFiles(this.globalStorageUri, HISTORY_CACHE_FILE_NAME);
  }
}

function buildIndex(sessionsRoot: string, summaries: SessionSummary[]): HistoryIndex {
  const idx: HistoryIndex = emptyIndex(sessionsRoot);
  idx.sessions = summaries;

  for (const s of summaries) {
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
