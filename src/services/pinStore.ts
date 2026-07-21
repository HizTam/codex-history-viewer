import * as vscode from "vscode";
import * as path from "node:path";
import type {
  HistoryIndex,
  SessionArchiveState,
  SessionRootKind,
  SessionSource,
  SessionSummary,
} from "../sessions/sessionTypes";
import { normalizeCacheKey } from "../utils/fsUtils";

// Stores pin state in Memento (globalState).
export interface PinEntry {
  fsPath: string;
  cacheKey: string;
  identityKey?: string;
  source?: SessionSource;
  archiveState?: SessionArchiveState;
  rootKind?: SessionRootKind;
  pinnedAt: number;
}

export interface PinReconcileResult {
  updated: number;
  moves: Array<{ oldFsPath: string; newFsPath: string }>;
}

const PINS_KEY = "codexHistoryViewer.pins.v1";

export class PinStore implements vscode.Disposable {
  private readonly memento: vscode.Memento;
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  private mutationQueue: Promise<void> = Promise.resolve();

  public readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(memento: vscode.Memento) {
    this.memento = memento;
  }

  public dispose(): void {
    this.onDidChangeEmitter.dispose();
  }

  private normalizeFsPaths(fsPaths: readonly string[]): Array<{ fsPath: string; cacheKey: string }> {
    // Validate input, normalize and deduplicate while preserving order.
    const out: Array<{ fsPath: string; cacheKey: string }> = [];
    const seen = new Set<string>();

    for (const raw of fsPaths) {
      const fsPath = typeof raw === "string" ? raw.trim() : "";
      if (!fsPath) continue;
      const cacheKey = normalizeCacheKey(fsPath);
      if (seen.has(cacheKey)) continue;
      seen.add(cacheKey);
      out.push({ fsPath, cacheKey });
    }

    return out;
  }

  private normalizeSessions(sessions: readonly SessionSummary[]): PinEntry[] {
    const out: PinEntry[] = [];
    const seen = new Set<string>();
    for (const session of sessions) {
      if (!session || typeof session.fsPath !== "string") continue;
      const cacheKey = normalizeCacheKey(session.fsPath);
      if (!cacheKey || seen.has(cacheKey)) continue;
      seen.add(cacheKey);
      out.push({
        fsPath: session.fsPath,
        cacheKey,
        identityKey: session.identityKey,
        source: session.source,
        archiveState: session.storage.archiveState,
        rootKind: session.storage.rootKind,
        pinnedAt: 0,
      });
    }
    return out;
  }

  public getAll(): PinEntry[] {
    const raw = this.memento.get<unknown>(PINS_KEY);
    if (!Array.isArray(raw)) return [];
    return raw
      .map((x) => {
        if (!x || typeof x !== "object") return null;
        const fsPath = (x as any).fsPath;
        const pinnedAt = (x as any).pinnedAt;
        if (typeof fsPath !== "string" || typeof pinnedAt !== "number") return null;
        const identityKey = typeof (x as any).identityKey === "string" ? (x as any).identityKey.trim() : "";
        const source = (x as any).source === "codex" || (x as any).source === "claude" ? (x as any).source : undefined;
        const archiveState = sanitizeArchiveState((x as any).archiveState);
        const rootKind = sanitizeRootKind((x as any).rootKind);
        return {
          fsPath,
          cacheKey: normalizeCacheKey(fsPath),
          ...(identityKey ? { identityKey } : {}),
          ...(source ? { source } : {}),
          ...(archiveState ? { archiveState } : {}),
          ...(rootKind ? { rootKind } : {}),
          pinnedAt,
        } satisfies PinEntry;
      })
      .filter((x): x is PinEntry => x !== null);
  }

  public isPinned(fsPath: string): boolean {
    const key = normalizeCacheKey(fsPath);
    return this.getAll().some((p) => p.cacheKey === key);
  }

  public async pin(fsPath: string): Promise<void> {
    await this.pinMany([fsPath]);
  }

  public async pinMany(fsPaths: readonly string[]): Promise<{ pinned: number; skipped: number }> {
    // Pin in bulk (batch the Memento update into a single write).
    const normalized = this.normalizeFsPaths(fsPaths);
    if (normalized.length === 0) return { pinned: 0, skipped: 0 };

    return this.enqueueMutation(async () => {
      const pins = this.getAll();
      const existing = new Set(pins.map((p) => p.cacheKey));

      const base = Date.now();
      const toAdd: PinEntry[] = [];
      for (let i = 0; i < normalized.length; i += 1) {
        const n = normalized[i]!;
        if (existing.has(n.cacheKey)) continue;
        toAdd.push({ fsPath: n.fsPath, cacheKey: n.cacheKey, pinnedAt: base + i });
      }

      if (toAdd.length > 0) {
        await this.memento.update(PINS_KEY, [...pins, ...toAdd]);
        this.onDidChangeEmitter.fire();
      }

      return { pinned: toAdd.length, skipped: normalized.length - toAdd.length };
    });
  }

  public async pinSessions(
    sessions: readonly SessionSummary[],
  ): Promise<{ pinned: number; skipped: number; added: PinEntry[] }> {
    const normalized = this.normalizeSessions(sessions);
    if (normalized.length === 0) return { pinned: 0, skipped: 0, added: [] };

    return this.enqueueMutation(async () => {
      const pins = this.getAll();
      const existing = new Set(pins.map((p) => p.cacheKey));
      const base = Date.now();
      const toAdd: PinEntry[] = [];
      for (let i = 0; i < normalized.length; i += 1) {
        const n = normalized[i]!;
        if (existing.has(n.cacheKey)) continue;
        toAdd.push({ ...n, pinnedAt: base + i });
      }

      if (toAdd.length > 0) {
        await this.memento.update(PINS_KEY, compactPins([...pins, ...toAdd]));
        this.onDidChangeEmitter.fire();
      }

      return {
        pinned: toAdd.length,
        skipped: normalized.length - toAdd.length,
        added: toAdd.map((entry) => ({ ...entry })),
      };
    });
  }

  public async reconcile(index: HistoryIndex): Promise<PinReconcileResult> {
    return this.enqueueMutation(async () => {
      const pins = this.getAll();
      if (pins.length === 0) return { updated: 0, moves: [] };

      let updated = 0;
      const moves: Array<{ oldFsPath: string; newFsPath: string }> = [];
      const next: PinEntry[] = [];

      for (const pin of pins) {
        const current = index.byCacheKey.get(pin.cacheKey);
        const identityKeys = pin.identityKey ? [pin.identityKey] : resolveFallbackIdentityKeys(pin);
        const target = current ?? findByIdentityKeys(index, identityKeys);
        if (!target) {
          next.push(pin);
          continue;
        }

        const patched: PinEntry = {
          fsPath: target.fsPath,
          cacheKey: target.cacheKey,
          identityKey: target.identityKey,
          source: target.source,
          archiveState: target.storage.archiveState,
          rootKind: target.storage.rootKind,
          pinnedAt: pin.pinnedAt,
        };
        if (
          patched.fsPath !== pin.fsPath ||
          patched.cacheKey !== pin.cacheKey ||
          patched.identityKey !== pin.identityKey ||
          patched.source !== pin.source ||
          patched.archiveState !== pin.archiveState ||
          patched.rootKind !== pin.rootKind
        ) {
          updated += 1;
          if (patched.fsPath !== pin.fsPath) moves.push({ oldFsPath: pin.fsPath, newFsPath: patched.fsPath });
        }
        next.push(patched);
      }

      const compacted = compactPins(next);
      if (updated > 0 || compacted.length !== pins.length) {
        await this.memento.update(PINS_KEY, compacted);
        this.onDidChangeEmitter.fire();
      }

      return { updated, moves };
    });
  }

  public async unpin(fsPath: string): Promise<void> {
    await this.unpinMany([fsPath]);
  }

  public async restore(entries: readonly PinEntry[]): Promise<void> {
    const toRestore = compactPins(entries);
    if (toRestore.length === 0) return;
    await this.enqueueMutation(async () => {
      const current = this.getAll();
      const next = compactPins([...current, ...toRestore]);
      if (arePinsEqual(current, next)) return;
      await this.memento.update(PINS_KEY, next);
      this.onDidChangeEmitter.fire();
    });
  }

  public async unpinMany(fsPaths: readonly string[]): Promise<{ unpinned: number; skipped: number }> {
    // Unpin in bulk (batch the Memento update into a single write).
    const normalized = this.normalizeFsPaths(fsPaths);
    if (normalized.length === 0) return { unpinned: 0, skipped: 0 };

    return this.enqueueMutation(async () => {
      const removeKeys = new Set(normalized.map((n) => n.cacheKey));
      const pins = this.getAll();
      const beforeKeys = new Set(pins.map((p) => p.cacheKey));

      const nextPins = pins.filter((p) => !removeKeys.has(p.cacheKey));
      const removedKeysCount = Array.from(removeKeys.values()).filter((k) => beforeKeys.has(k)).length;

      if (removedKeysCount > 0) {
        await this.memento.update(PINS_KEY, nextPins);
        this.onDidChangeEmitter.fire();
      }

      return { unpinned: removedKeysCount, skipped: normalized.length - removedKeysCount };
    });
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(operation, operation);
    this.mutationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function findByIdentityKeys(index: HistoryIndex, identityKeys: readonly string[]): SessionSummary | undefined {
  for (const identityKey of identityKeys) {
    const session = index.byIdentityKey.get(identityKey);
    if (session) return session;
  }
  return undefined;
}

function resolveFallbackIdentityKeys(pin: PinEntry): string[] {
  const source = pin.source ?? inferSourceFromFileName(pin.fsPath);
  if (source === "codex") {
    const rolloutId = extractCodexRolloutId(pin.fsPath);
    if (rolloutId) return [`codex:id:${rolloutId}`, `codex:rollout:${rolloutId}`];
  }
  return [];
}

function inferSourceFromFileName(fsPath: string): SessionSource | undefined {
  const base = path.basename(fsPath).toLowerCase();
  if (base.startsWith("rollout-")) return "codex";
  if (base.endsWith(".jsonl")) return "claude";
  return undefined;
}

function sanitizeArchiveState(value: unknown): SessionArchiveState | undefined {
  return value === "active" || value === "archived" ? value : undefined;
}

function sanitizeRootKind(value: unknown): SessionRootKind | undefined {
  if (value === "codexSessions" || value === "codexArchivedSessions" || value === "claudeSessions") return value;
  return undefined;
}

function extractCodexRolloutId(fsPath: string): string {
  const base = path.basename(fsPath);
  const match =
    /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu.exec(base);
  return match?.[1]?.toLowerCase() ?? "";
}

function compactPins(pins: readonly PinEntry[]): PinEntry[] {
  const byKey = new Map<string, PinEntry>();
  for (const pin of pins) {
    const fsPath = typeof pin.fsPath === "string" ? pin.fsPath.trim() : "";
    if (!fsPath) continue;
    const cacheKey = normalizeCacheKey(fsPath);
    if (!cacheKey) continue;
    byKey.set(cacheKey, { ...pin, fsPath, cacheKey });
  }
  return Array.from(byKey.values()).sort((a, b) => a.pinnedAt - b.pinnedAt);
}

function arePinsEqual(left: readonly PinEntry[], right: readonly PinEntry[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      entry.fsPath === other.fsPath &&
      entry.cacheKey === other.cacheKey &&
      entry.identityKey === other.identityKey &&
      entry.source === other.source &&
      entry.archiveState === other.archiveState &&
      entry.rootKind === other.rootKind &&
      entry.pinnedAt === other.pinnedAt
    );
  });
}
