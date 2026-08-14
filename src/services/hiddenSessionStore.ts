import * as vscode from "vscode";
import * as path from "node:path";
import type { HistoryIndex, SessionSource, SessionSummary } from "../sessions/sessionTypes";
import { isBoundedSessionIdentityKey } from "../sessions/sessionIdentity";
import { normalizeCacheKey } from "../utils/fsUtils";
import type { SessionMetadataMutationCoordinator } from "./sessionMetadataMutationCoordinator";

export interface HiddenSessionEntry {
  identityKey: string;
  source: SessionSource;
  fsPath: string;
  cacheKey: string;
  hiddenAt: number;
  updatedAt: number;
}

export interface HiddenSessionMutationResult {
  changed: number;
  skipped: number;
  entries: HiddenSessionEntry[];
}

export interface HiddenSessionReconcileResult {
  updated: number;
}

export const HIDDEN_SESSIONS_KEY = "codexHistoryViewer.hiddenSessions.v1";
export const MAX_HIDDEN_SESSIONS = 200_000;

// Stores extension-local session visibility without modifying source history files.
export class HiddenSessionStore implements vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  private mutationQueue: Promise<void> = Promise.resolve();
  private cachedEntries: HiddenSessionEntry[] | null = null;
  private cachedIdentityKeys = new Set<string>();
  private cachedPathKeys = new Set<string>();

  public readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(
    private readonly memento: vscode.Memento,
    private readonly coordinator?: SessionMetadataMutationCoordinator,
  ) {}

  public dispose(): void {
    this.onDidChangeEmitter.dispose();
  }

  public getAll(): HiddenSessionEntry[] {
    this.ensureCache();
    return this.cachedEntries!.map((entry) => ({ ...entry }));
  }

  public isHidden(session: Pick<SessionSummary, "identityKey" | "cacheKey" | "fsPath">): boolean {
    const identityKey = String(session.identityKey ?? "").trim();
    const cacheKey = normalizeCacheKey(String(session.cacheKey || session.fsPath || ""));
    this.ensureCache();
    return (identityKey.length > 0 && this.cachedIdentityKeys.has(identityKey)) ||
      (cacheKey.length > 0 && this.cachedPathKeys.has(cacheKey));
  }

  public async hideSessions(sessions: readonly SessionSummary[]): Promise<HiddenSessionMutationResult> {
    const candidates = normalizeSessions(sessions);
    if (candidates.length === 0) return { changed: 0, skipped: 0, entries: [] };
    return this.enqueueMutation(async () => {
      const current = this.getAll();
      const byIdentity = new Map(current.map((entry) => [entry.identityKey, entry]));
      const byCacheKey = new Map(current.map((entry) => [entry.cacheKey, entry]));
      const added: HiddenSessionEntry[] = [];
      const base = Date.now();
      for (let index = 0; index < candidates.length; index += 1) {
        const session = candidates[index]!;
        if (byIdentity.has(session.identityKey) || byCacheKey.has(session.cacheKey)) continue;
        if (byIdentity.size >= MAX_HIDDEN_SESSIONS) continue;
        const entry: HiddenSessionEntry = {
          identityKey: session.identityKey,
          source: session.source,
          fsPath: session.fsPath,
          cacheKey: session.cacheKey,
          hiddenAt: base + index,
          updatedAt: base + index,
        };
        added.push(entry);
        byIdentity.set(entry.identityKey, entry);
        byCacheKey.set(entry.cacheKey, entry);
      }
      if (added.length > 0) await this.persist([...current, ...added]);
      return { changed: added.length, skipped: candidates.length - added.length, entries: added };
    });
  }

  public async unhideSessions(sessions: readonly SessionSummary[]): Promise<HiddenSessionMutationResult> {
    const candidates = normalizeSessions(sessions);
    if (candidates.length === 0) return { changed: 0, skipped: 0, entries: [] };
    return this.enqueueMutation(async () => {
      const identityKeys = new Set(candidates.map((session) => session.identityKey));
      const cacheKeys = new Set(candidates.map((session) => session.cacheKey));
      const current = this.getAll();
      const removed = current.filter((entry) => identityKeys.has(entry.identityKey) || cacheKeys.has(entry.cacheKey));
      if (removed.length > 0) {
        const removeIdentityKeys = new Set(removed.map((entry) => entry.identityKey));
        const removeCacheKeys = new Set(removed.map((entry) => entry.cacheKey));
        await this.persist(current.filter((entry) =>
          !removeIdentityKeys.has(entry.identityKey) && !removeCacheKeys.has(entry.cacheKey)));
      }
      return { changed: removed.length, skipped: candidates.length - removed.length, entries: removed };
    });
  }

  public async removeMany(fsPaths: readonly string[]): Promise<HiddenSessionEntry[]> {
    const cacheKeys = new Set(fsPaths.map((value) => normalizeCacheKey(String(value ?? ""))).filter(Boolean));
    if (cacheKeys.size === 0) return [];
    return this.enqueueMutation(async () => {
      const current = this.getAll();
      const removed = current.filter((entry) => cacheKeys.has(entry.cacheKey));
      if (removed.length > 0) {
        await this.persist(current.filter((entry) => !cacheKeys.has(entry.cacheKey)));
      }
      return removed;
    });
  }

  public async removeByIdentityKeys(identityKeys: readonly string[]): Promise<HiddenSessionEntry[]> {
    const keys = new Set(identityKeys.filter((value) => isBoundedSessionIdentityKey(value)));
    if (keys.size === 0) return [];
    return this.enqueueMutation(async () => {
      const current = this.getAll();
      const removed = current.filter((entry) => keys.has(entry.identityKey));
      if (removed.length > 0) {
        await this.persist(current.filter((entry) => !keys.has(entry.identityKey)));
      }
      return removed;
    });
  }

  public async restore(entries: readonly HiddenSessionEntry[]): Promise<number> {
    const restored = compactHiddenSessions(entries);
    if (restored.length === 0) return 0;
    return this.enqueueMutation(async () => {
      const current = this.getAll();
      const byIdentity = new Map(current.map((entry) => [entry.identityKey, entry]));
      const byCacheKey = new Set(current.map((entry) => entry.cacheKey));
      let changed = 0;
      for (const entry of restored) {
        if (byIdentity.has(entry.identityKey) || byCacheKey.has(entry.cacheKey)) continue;
        if (byIdentity.size >= MAX_HIDDEN_SESSIONS) continue;
        byIdentity.set(entry.identityKey, entry);
        byCacheKey.add(entry.cacheKey);
        changed += 1;
      }
      if (changed > 0) await this.persist(Array.from(byIdentity.values()));
      return changed;
    });
  }

  public async replaceAll(entries: readonly HiddenSessionEntry[], options?: { notify?: boolean; skipCoordinator?: boolean }): Promise<void> {
    if (this.coordinator && options?.skipCoordinator !== true) {
      await this.coordinator.runExclusive(() => this.replaceAll(entries, { ...options, skipCoordinator: true }));
      return;
    }
    const replace = async (): Promise<void> => {
      await this.persist(entries, options);
    };
    if (options?.skipCoordinator === true) await replace();
    else await this.enqueueMutation(replace);
  }

  public notifyChanged(): void {
    this.onDidChangeEmitter.fire();
  }

  public async relocate(oldFsPath: string, newFsPath: string): Promise<boolean> {
    const oldCacheKey = normalizeCacheKey(oldFsPath);
    const newCacheKey = normalizeCacheKey(newFsPath);
    if (!oldCacheKey || !newCacheKey || oldCacheKey === newCacheKey) return false;
    return this.enqueueMutation(async () => {
      const current = this.getAll();
      let changed = false;
      const next = current.map((entry) => {
        if (entry.cacheKey !== oldCacheKey) return entry;
        changed = true;
        return { ...entry, fsPath: newFsPath, cacheKey: newCacheKey, updatedAt: Date.now() };
      });
      if (changed) await this.persist(next);
      return changed;
    });
  }

  public async reconcile(index: HistoryIndex): Promise<HiddenSessionReconcileResult> {
    return this.enqueueMutation(async () => {
      const current = this.getAll();
      let updated = 0;
      const next = current.map((entry) => {
        const cacheMatch = index.byCacheKey.get(entry.cacheKey);
        const target = cacheMatch?.identityKey === entry.identityKey
          ? cacheMatch
          : index.byIdentityKey.get(entry.identityKey);
        if (!target || (target.fsPath === entry.fsPath && target.cacheKey === entry.cacheKey)) return entry;
        updated += 1;
        return {
          ...entry,
          source: target.source,
          fsPath: target.fsPath,
          cacheKey: target.cacheKey,
          updatedAt: Date.now(),
        };
      });
      if (updated > 0) await this.persist(next);
      return { updated };
    });
  }

  private async persist(entries: readonly HiddenSessionEntry[], options?: { notify?: boolean }): Promise<void> {
    const compacted = compactHiddenSessions(entries);
    await this.memento.update(HIDDEN_SESSIONS_KEY, compacted);
    this.setCache(compacted);
    if (options?.notify !== false) this.onDidChangeEmitter.fire();
  }

  private ensureCache(): void {
    if (this.cachedEntries) return;
    const raw = this.memento.get<unknown>(HIDDEN_SESSIONS_KEY);
    this.setCache(Array.isArray(raw) && raw.length <= MAX_HIDDEN_SESSIONS ? compactHiddenSessions(raw) : []);
  }

  private setCache(entries: readonly HiddenSessionEntry[]): void {
    this.cachedEntries = entries.map((entry) => ({ ...entry }));
    this.cachedIdentityKeys = new Set(this.cachedEntries.map((entry) => entry.identityKey));
    this.cachedPathKeys = new Set(this.cachedEntries.map((entry) => entry.cacheKey));
  }

  private enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    if (this.coordinator) return this.coordinator.runExclusive(mutation);
    const result = this.mutationQueue.then(mutation, mutation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function normalizeSessions(sessions: readonly SessionSummary[]): SessionSummary[] {
  const out: SessionSummary[] = [];
  const seen = new Set<string>();
  for (const session of sessions) {
    if (!session || !isBoundedSessionIdentityKey(session.identityKey)) continue;
    const fsPath = sanitizeSessionPath(session.fsPath);
    const cacheKey = normalizeCacheKey(session.cacheKey || fsPath);
    if (!fsPath || !cacheKey || seen.has(session.identityKey) || seen.has(cacheKey)) continue;
    seen.add(session.identityKey);
    seen.add(cacheKey);
    out.push(session);
  }
  return out;
}

function sanitizeHiddenSession(value: unknown): HiddenSessionEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!isBoundedSessionIdentityKey(raw.identityKey)) return null;
  if (/[\u0000-\u001f\u007f]/u.test(raw.identityKey)) return null;
  if (raw.source !== "codex" && raw.source !== "claude") return null;
  if (!raw.identityKey.startsWith(`${raw.source}:`)) return null;
  const fsPath = sanitizeSessionPath(raw.fsPath);
  const cacheKey = normalizeCacheKey(fsPath);
  if (!fsPath || !cacheKey) return null;
  if (typeof raw.hiddenAt !== "number" || !Number.isFinite(raw.hiddenAt)) return null;
  if (typeof raw.updatedAt !== "number" || !Number.isFinite(raw.updatedAt)) return null;
  if (raw.hiddenAt < 0 || raw.updatedAt < 0) return null;
  return {
    identityKey: raw.identityKey,
    source: raw.source,
    fsPath,
    cacheKey,
    hiddenAt: raw.hiddenAt,
    updatedAt: raw.updatedAt,
  };
}

function sanitizeSessionPath(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096) return "";
  const fsPath = value.trim();
  if (!fsPath || /[\u0000-\u001f\u007f]/u.test(fsPath) || !path.isAbsolute(fsPath)) return "";
  return fsPath;
}

function compactHiddenSessions(values: readonly unknown[]): HiddenSessionEntry[] {
  const byIdentity = new Map<string, HiddenSessionEntry>();
  const cacheKeys = new Set<string>();
  for (const value of values) {
    const entry = sanitizeHiddenSession(value);
    if (!entry || byIdentity.has(entry.identityKey) || cacheKeys.has(entry.cacheKey)) continue;
    byIdentity.set(entry.identityKey, entry);
    cacheKeys.add(entry.cacheKey);
    if (byIdentity.size >= MAX_HIDDEN_SESSIONS) break;
  }
  return Array.from(byIdentity.values()).sort((left, right) => right.updatedAt - left.updatedAt);
}
