import * as path from "node:path";
import * as vscode from "vscode";
import type { CodexHistoryViewerConfig } from "../settings";
import { findSessionFiles } from "../sessions/sessionDiscovery";
import type { HistoryIndex, SessionSummary } from "../sessions/sessionTypes";
import { buildSessionSummary } from "../sessions/sessionSummary";
import { normalizeCacheKey, pathExists } from "../utils/fsUtils";
import { readJson, writeJson } from "../storage/jsonStorage";
import { getDateTimeSettingsKey, resolveDateTimeSettings } from "../utils/dateTimeSettings";

// Builds the session index and manages its cache.

interface CacheEntryV1 {
  mtimeMs: number;
  size: number;
  summary: SessionSummary;
}

const SUMMARY_CACHE_ALGO_VERSION = 3;

interface CacheFileV4 {
  version: 4;
  summaryAlgoVersion: number;
  sessionsRoot: string;
  previewMaxMessages: number;
  dateTimeSettingsKey: string;
  entries: Record<string, CacheEntryV1>;
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
    this.updateConfig(this.config); // Hook for potential hot-reload (currently a no-op).
    const sessionsRoot = this.config.sessionsRoot;
    if (!(await pathExists(sessionsRoot))) {
      this.index = emptyIndex(sessionsRoot);
      return;
    }

    const dateTime = resolveDateTimeSettings();
    const dateTimeSettingsKey = getDateTimeSettingsKey(dateTime);

    const cacheUri = vscode.Uri.joinPath(this.globalStorageUri, "cache.v4.json");
    const cache = options.forceRebuildCache ? null : await readJson<CacheFileV4>(cacheUri);

    const cachedEntries: Record<string, CacheEntryV1> =
      cache &&
      cache.version === 4 &&
      cache.summaryAlgoVersion === SUMMARY_CACHE_ALGO_VERSION &&
      cache.sessionsRoot === sessionsRoot &&
      cache.previewMaxMessages === this.config.previewMaxMessages &&
      cache.dateTimeSettingsKey === dateTimeSettingsKey
        ? cache.entries
        : {};

    const files = await findSessionFiles(sessionsRoot);
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
        nextEntries[key] = cached;
        summaries.push(cached.summary);
        continue;
      }

      const summary = await buildSessionSummary({
        sessionsRoot,
        fsPath,
        previewMaxMessages: this.config.previewMaxMessages,
        timeZone: dateTime.timeZone,
      });
      if (!summary) continue;
      nextEntries[key] = { mtimeMs: st.mtimeMs, size: st.size, summary };
      summaries.push(summary);
    }

    // Sort by newest (localDate/timeLabel).
    summaries.sort((a, b) => {
      if (a.localDate !== b.localDate) return a.localDate < b.localDate ? 1 : -1;
      return a.timeLabel < b.timeLabel ? 1 : a.timeLabel > b.timeLabel ? -1 : 0;
    });

    this.index = buildIndex(sessionsRoot, summaries);
    const nextCache: CacheFileV4 = {
      version: 4,
      summaryAlgoVersion: SUMMARY_CACHE_ALGO_VERSION,
      sessionsRoot,
      previewMaxMessages: this.config.previewMaxMessages,
      dateTimeSettingsKey,
      entries: nextEntries,
    };
    await writeJson(cacheUri, nextCache);
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
