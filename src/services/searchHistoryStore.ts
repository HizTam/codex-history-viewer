import * as vscode from "vscode";

export interface SearchHistoryEntry {
  projectKey: string;
  queryInput: string;
  updatedAt: number;
}

export interface SearchHistorySaveRequest {
  projectKey: string;
  queryInput: string;
}

const SEARCH_HISTORY_KEY = "codexHistoryViewer.searchHistory.v2";
const LEGACY_SEARCH_HISTORY_KEY = "codexHistoryViewer.searchHistory.v1";
const MAX_SEARCH_HISTORY_ENTRIES_PER_PROJECT = 20;
export const GLOBAL_SEARCH_HISTORY_PROJECT_KEY = "global";

// Stores recent search queries in per-project buckets.
export class SearchHistoryStore {
  private readonly memento: vscode.Memento;

  constructor(memento: vscode.Memento) {
    this.memento = memento;
  }

  public async discardLegacyHistory(): Promise<void> {
    await this.memento.update(LEGACY_SEARCH_HISTORY_KEY, undefined);
  }

  public getAll(projectKey: string | null | undefined): SearchHistoryEntry[] {
    const normalizedProjectKey = normalizeSearchHistoryProjectKey(projectKey);
    return this.getAllEntries()
      .filter((entry) => entry.projectKey === normalizedProjectKey)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SEARCH_HISTORY_ENTRIES_PER_PROJECT);
  }

  public async save(request: SearchHistorySaveRequest): Promise<SearchHistoryEntry | null> {
    const next = sanitizeSaveRequest(request);
    if (!next) return null;

    const now = Date.now();
    const existingEntries = this.getAllEntries();
    const nextKey = buildSearchHistoryEntryKey(next.projectKey, next.queryInput);
    const entry: SearchHistoryEntry = {
      projectKey: next.projectKey,
      queryInput: next.queryInput,
      updatedAt: now,
    };
    const kept = existingEntries.filter(
      (item) => buildSearchHistoryEntryKey(item.projectKey, item.queryInput) !== nextKey,
    );
    await this.memento.update(SEARCH_HISTORY_KEY, limitEntriesPerProject([entry, ...kept]));
    return entry;
  }

  public async clear(projectKey: string | null | undefined): Promise<void> {
    const normalizedProjectKey = normalizeSearchHistoryProjectKey(projectKey);
    const kept = this.getAllEntries().filter((entry) => entry.projectKey !== normalizedProjectKey);
    await this.memento.update(SEARCH_HISTORY_KEY, kept);
  }

  public async remove(projectKey: string | null | undefined, queryInput: string): Promise<boolean> {
    const normalizedProjectKey = normalizeSearchHistoryProjectKey(projectKey);
    const query = typeof queryInput === "string" ? queryInput.trim() : "";
    if (!query) return false;
    const key = buildSearchHistoryEntryKey(normalizedProjectKey, query);
    const entries = this.getAllEntries();
    const kept = entries.filter((entry) => buildSearchHistoryEntryKey(entry.projectKey, entry.queryInput) !== key);
    if (kept.length === entries.length) return false;
    await this.memento.update(SEARCH_HISTORY_KEY, kept);
    return true;
  }

  private getAllEntries(): SearchHistoryEntry[] {
    const raw = this.memento.get<unknown>(SEARCH_HISTORY_KEY);
    if (!Array.isArray(raw)) return [];
    return limitEntriesPerProject(
      raw
      .map((item) => sanitizeEntry(item))
      .filter((entry): entry is SearchHistoryEntry => entry !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt),
    );
  }
}

function sanitizeEntry(value: unknown): SearchHistoryEntry | null {
  if (!value || typeof value !== "object") return null;
  const v = value as any;
  const projectKey = normalizeSearchHistoryProjectKey(v.projectKey);
  const queryInput = typeof v.queryInput === "string" ? v.queryInput.trim() : "";
  if (!queryInput) return null;
  const updatedAt = typeof v.updatedAt === "number" && Number.isFinite(v.updatedAt) ? v.updatedAt : 0;
  return {
    projectKey,
    queryInput,
    updatedAt,
  };
}

function sanitizeSaveRequest(request: SearchHistorySaveRequest): SearchHistoryEntry | null {
  const projectKey = normalizeSearchHistoryProjectKey(request?.projectKey);
  const queryInput = typeof request?.queryInput === "string" ? request.queryInput.trim() : "";
  if (!queryInput) return null;
  return {
    projectKey,
    queryInput,
    updatedAt: 0,
  };
}

function limitEntriesPerProject(entries: readonly SearchHistoryEntry[]): SearchHistoryEntry[] {
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  const out: SearchHistoryEntry[] = [];
  for (const entry of entries.slice().sort((a, b) => b.updatedAt - a.updatedAt)) {
    const projectKey = normalizeSearchHistoryProjectKey(entry.projectKey);
    const key = buildSearchHistoryEntryKey(projectKey, entry.queryInput);
    if (seen.has(key)) continue;
    const count = counts.get(projectKey) ?? 0;
    if (count >= MAX_SEARCH_HISTORY_ENTRIES_PER_PROJECT) continue;
    seen.add(key);
    counts.set(projectKey, count + 1);
    out.push({ ...entry, projectKey });
  }
  return out;
}

export function normalizeSearchHistoryProjectKey(projectKey: string | null | undefined): string {
  const key = typeof projectKey === "string" ? projectKey.trim() : "";
  return key || GLOBAL_SEARCH_HISTORY_PROJECT_KEY;
}

export function buildSearchHistoryEntryKey(projectKey: string | null | undefined, queryInput: string): string {
  const normalizedProjectKey = normalizeSearchHistoryProjectKey(projectKey);
  const normalized = queryInput.trim();
  return JSON.stringify([normalizedProjectKey, normalized]);
}
