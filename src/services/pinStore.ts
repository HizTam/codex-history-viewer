import * as vscode from "vscode";
import { normalizeCacheKey } from "../utils/fsUtils";

// Stores pin state in Memento (globalState).
export interface PinEntry {
  fsPath: string;
  cacheKey: string;
  pinnedAt: number;
}

const PINS_KEY = "codexHistoryViewer.pins.v1";

export class PinStore {
  private readonly memento: vscode.Memento;

  constructor(memento: vscode.Memento) {
    this.memento = memento;
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

  public getAll(): PinEntry[] {
    const raw = this.memento.get<unknown>(PINS_KEY);
    if (!Array.isArray(raw)) return [];
    return raw
      .map((x) => {
        if (!x || typeof x !== "object") return null;
        const fsPath = (x as any).fsPath;
        const pinnedAt = (x as any).pinnedAt;
        if (typeof fsPath !== "string" || typeof pinnedAt !== "number") return null;
        return { fsPath, cacheKey: normalizeCacheKey(fsPath), pinnedAt } satisfies PinEntry;
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
    }

    return { pinned: toAdd.length, skipped: normalized.length - toAdd.length };
  }

  public async unpin(fsPath: string): Promise<void> {
    await this.unpinMany([fsPath]);
  }

  public async unpinMany(fsPaths: readonly string[]): Promise<{ unpinned: number; skipped: number }> {
    // Unpin in bulk (batch the Memento update into a single write).
    const normalized = this.normalizeFsPaths(fsPaths);
    if (normalized.length === 0) return { unpinned: 0, skipped: 0 };

    const removeKeys = new Set(normalized.map((n) => n.cacheKey));
    const pins = this.getAll();
    const beforeKeys = new Set(pins.map((p) => p.cacheKey));

    const nextPins = pins.filter((p) => !removeKeys.has(p.cacheKey));
    const removedKeysCount = Array.from(removeKeys.values()).filter((k) => beforeKeys.has(k)).length;

    if (removedKeysCount > 0) {
      await this.memento.update(PINS_KEY, nextPins);
    }

    return { unpinned: removedKeysCount, skipped: normalized.length - removedKeysCount };
  }
}
