import * as vscode from "vscode";
import { normalizeCacheKey } from "../utils/fsUtils";

export interface ChatOpenPositionEntry {
  fsPath: string;
  cacheKey: string;
  messageIndex: number;
  updatedAt: number;
}

const CHAT_OPEN_POSITION_KEY = "codexHistoryViewer.chatOpenPositions.v1";
const MAX_CHAT_OPEN_POSITIONS = 100;

// Stores the last viewed chat message position in globalState.
export class ChatOpenPositionStore {
  private readonly memento: vscode.Memento;
  private readonly entriesByKey = new Map<string, ChatOpenPositionEntry>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(memento: vscode.Memento) {
    this.memento = memento;
    for (const entry of compactEntries(readEntries(memento))) {
      this.entriesByKey.set(entry.cacheKey, entry);
    }
  }

  public get(fsPath: string): number | undefined {
    const key = normalizeFsPathKey(fsPath);
    if (!key) return undefined;
    return this.entriesByKey.get(key)?.messageIndex;
  }

  public async set(fsPath: string, messageIndex: number): Promise<void> {
    const entry = buildEntry(fsPath, messageIndex);
    if (!entry) return;

    this.entriesByKey.set(entry.cacheKey, entry);
    this.prune();
    await this.persist();
  }

  public async deleteMany(fsPaths: readonly string[]): Promise<void> {
    const keys = new Set(fsPaths.map((fsPath) => normalizeFsPathKey(fsPath)).filter((key): key is string => !!key));
    if (keys.size === 0) return;

    let changed = false;
    for (const key of keys) {
      if (this.entriesByKey.delete(key)) changed = true;
    }
    if (!changed) return;

    await this.persist();
  }

  private prune(): void {
    const entries = this.getAll();
    if (entries.length <= MAX_CHAT_OPEN_POSITIONS) return;

    this.entriesByKey.clear();
    for (const entry of entries.slice(0, MAX_CHAT_OPEN_POSITIONS)) {
      this.entriesByKey.set(entry.cacheKey, entry);
    }
  }

  private getAll(): ChatOpenPositionEntry[] {
    return Array.from(this.entriesByKey.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async persist(): Promise<void> {
    const run = this.writeQueue.then(() => this.memento.update(CHAT_OPEN_POSITION_KEY, this.getAll()));
    this.writeQueue = run.catch(() => undefined);
    await run;
  }
}

function readEntries(memento: vscode.Memento): ChatOpenPositionEntry[] {
  const raw = memento.get<unknown>(CHAT_OPEN_POSITION_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.map((value) => sanitizeEntry(value)).filter((entry): entry is ChatOpenPositionEntry => entry !== null);
}

function compactEntries(entries: readonly ChatOpenPositionEntry[]): ChatOpenPositionEntry[] {
  const byKey = new Map<string, ChatOpenPositionEntry>();
  for (const entry of entries) {
    const current = byKey.get(entry.cacheKey);
    if (!current || entry.updatedAt > current.updatedAt) {
      byKey.set(entry.cacheKey, entry);
    }
  }
  return Array.from(byKey.values())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CHAT_OPEN_POSITIONS);
}

function buildEntry(fsPath: string, messageIndex: number): ChatOpenPositionEntry | null {
  const cleanPath = normalizeFsPath(fsPath);
  if (!cleanPath) return null;
  const cleanIndex = normalizeMessageIndex(messageIndex);
  if (cleanIndex === null) return null;
  return {
    fsPath: cleanPath,
    cacheKey: normalizeCacheKey(cleanPath),
    messageIndex: cleanIndex,
    updatedAt: Date.now(),
  };
}

function sanitizeEntry(value: unknown): ChatOpenPositionEntry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as any;
  const fsPath = normalizeFsPath(raw.fsPath);
  if (!fsPath) return null;
  const messageIndex = normalizeMessageIndex(raw.messageIndex);
  if (messageIndex === null) return null;
  const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? Math.max(0, raw.updatedAt) : 0;
  return {
    fsPath,
    cacheKey: normalizeCacheKey(fsPath),
    messageIndex,
    updatedAt,
  };
}

function normalizeFsPath(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeFsPathKey(value: unknown): string {
  const fsPath = normalizeFsPath(value);
  return fsPath ? normalizeCacheKey(fsPath) : "";
}

function normalizeMessageIndex(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}
