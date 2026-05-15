import * as vscode from "vscode";
import { normalizeCacheKey } from "../utils/fsUtils";

export type BookmarkTargetKind = "message" | "patchGroup" | "tool" | "usage" | "environment" | "note";

export interface BookmarkTarget {
  key: string;
  sessionFsPath: string;
  sessionCacheKey: string;
  kind: BookmarkTargetKind;
  groupId?: string;
  title?: string;
  messageIndex?: number;
  timestampIso?: string;
}

export interface BookmarkEntry extends BookmarkTarget {
  createdAt: number;
  updatedAt: number;
}

export interface BookmarkKeyParams {
  sessionCacheKey: string;
  kind: BookmarkTargetKind;
  groupId?: string;
  messageIndex?: number;
  timestampIso?: string;
  fallbackId?: string;
}

const BOOKMARKS_KEY = "codexHistoryViewer.bookmarks.v1";

// Stores timeline bookmark state in globalState without changing source history files.
export class BookmarkStore implements vscode.Disposable {
  private readonly memento: vscode.Memento;
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();

  public readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(memento: vscode.Memento) {
    this.memento = memento;
  }

  public dispose(): void {
    this.onDidChangeEmitter.dispose();
  }

  public getAll(): BookmarkEntry[] {
    const raw = this.memento.get<unknown>(BOOKMARKS_KEY);
    if (!Array.isArray(raw)) return [];
    return compactBookmarks(raw);
  }

  public get(key: string): BookmarkEntry | null {
    const normalized = normalizeBookmarkKey(key);
    if (!normalized) return null;
    return this.getAll().find((entry) => entry.key === normalized) ?? null;
  }

  public isBookmarked(key: string): boolean {
    return this.get(key) !== null;
  }

  public getKeysForTargets(targets: readonly BookmarkTarget[]): Set<string> {
    const candidateKeys = new Set(targets.map((target) => normalizeBookmarkKey(target.key)).filter(Boolean));
    if (candidateKeys.size === 0) return new Set();
    return new Set(this.getAll().filter((entry) => candidateKeys.has(entry.key)).map((entry) => entry.key));
  }

  public async toggle(target: BookmarkTarget): Promise<boolean> {
    const sanitized = sanitizeBookmarkTarget(target);
    if (!sanitized) return false;

    const list = this.getAll();
    const existingIndex = list.findIndex((entry) => entry.key === sanitized.key);
    if (existingIndex >= 0) {
      list.splice(existingIndex, 1);
      await this.memento.update(BOOKMARKS_KEY, list);
      this.onDidChangeEmitter.fire();
      return false;
    }

    const now = Date.now();
    list.push({
      ...sanitized,
      createdAt: now,
      updatedAt: now,
    });
    await this.memento.update(BOOKMARKS_KEY, compactBookmarks(list));
    this.onDidChangeEmitter.fire();
    return true;
  }

  public async removeMany(fsPaths: readonly string[]): Promise<BookmarkEntry[]> {
    const removeKeys = new Set(
      fsPaths
        .map((fsPath) => (typeof fsPath === "string" ? fsPath.trim() : ""))
        .filter((fsPath) => fsPath.length > 0)
        .map((fsPath) => normalizeCacheKey(fsPath)),
    );
    if (removeKeys.size === 0) return [];

    const current = this.getAll();
    const removed = current.filter((entry) => removeKeys.has(entry.sessionCacheKey));
    if (removed.length === 0) return [];

    const next = current.filter((entry) => !removeKeys.has(entry.sessionCacheKey));
    await this.memento.update(BOOKMARKS_KEY, next);
    this.onDidChangeEmitter.fire();
    return removed;
  }

  public async restore(entries: readonly BookmarkEntry[]): Promise<void> {
    const restored = compactBookmarks(entries);
    if (restored.length === 0) return;

    const byKey = new Map(this.getAll().map((entry) => [entry.key, entry]));
    for (const entry of restored) {
      byKey.set(entry.key, entry);
    }
    await this.memento.update(BOOKMARKS_KEY, compactBookmarks(Array.from(byKey.values())));
    this.onDidChangeEmitter.fire();
  }
}

export function buildBookmarkKey(params: BookmarkKeyParams): string {
  const sessionCacheKey = normalizeBookmarkText(params.sessionCacheKey);
  const kind = sanitizeBookmarkKind(params.kind);
  if (!sessionCacheKey || !kind) return "";

  const messageIndex =
    typeof params.messageIndex === "number" && Number.isFinite(params.messageIndex)
      ? Math.max(0, Math.floor(params.messageIndex))
      : 0;
  const timestampIso = normalizeBookmarkText(params.timestampIso);
  const fallbackId = normalizeBookmarkText(params.fallbackId);
  const groupId = normalizeBookmarkText(params.groupId);
  const fingerprint =
    kind === "patchGroup" && groupId
      ? [kind, "group", groupId].join("\u0000")
      : [
          kind,
          messageIndex > 0 ? String(messageIndex) : "",
          timestampIso,
          kind === "patchGroup" && (messageIndex > 0 || timestampIso) ? "" : fallbackId,
        ].join("\u0000");
  return `bm-${hashString(sessionCacheKey)}-${kind}-${hashString(fingerprint)}`;
}

export function normalizeBookmarkKey(value: unknown): string {
  const key = typeof value === "string" ? value.trim() : "";
  return /^bm-[a-z0-9]+-[a-zA-Z]+-[a-z0-9]+$/u.test(key) ? key : "";
}

export function sanitizeBookmarkTarget(value: unknown): BookmarkTarget | null {
  if (!value || typeof value !== "object") return null;
  const v = value as BookmarkTarget;
  const key = normalizeBookmarkKey(v.key);
  const sessionFsPath = normalizeBookmarkText(v.sessionFsPath);
  const sessionCacheKey = normalizeBookmarkText(v.sessionCacheKey) || normalizeCacheKey(sessionFsPath);
  const kind = sanitizeBookmarkKind(v.kind);
  if (!key || !sessionFsPath || !sessionCacheKey || !kind) return null;

  const groupId = normalizeBookmarkText(v.groupId) || undefined;
  const messageIndex =
    typeof v.messageIndex === "number" && Number.isFinite(v.messageIndex)
      ? Math.max(0, Math.floor(v.messageIndex))
      : undefined;
  const timestampIso = normalizeBookmarkText(v.timestampIso) || undefined;
  const title = normalizeBookmarkTitle(v.title);
  return {
    key,
    sessionFsPath,
    sessionCacheKey,
    kind,
    ...(groupId ? { groupId } : {}),
    ...(title ? { title } : {}),
    ...(messageIndex !== undefined ? { messageIndex } : {}),
    ...(timestampIso ? { timestampIso } : {}),
  };
}

function sanitizeBookmarkEntry(value: unknown): BookmarkEntry | null {
  const target = sanitizeBookmarkTarget(value);
  if (!target || !value || typeof value !== "object") return null;
  const v = value as { createdAt?: unknown; updatedAt?: unknown };
  const createdAt = typeof v.createdAt === "number" && Number.isFinite(v.createdAt) ? v.createdAt : Date.now();
  const updatedAt = typeof v.updatedAt === "number" && Number.isFinite(v.updatedAt) ? v.updatedAt : createdAt;
  return {
    ...target,
    createdAt,
    updatedAt,
  };
}

function compactBookmarks(values: readonly unknown[]): BookmarkEntry[] {
  const byKey = new Map<string, BookmarkEntry>();
  for (const value of values) {
    const entry = sanitizeBookmarkEntry(value);
    if (!entry) continue;
    byKey.set(entry.key, entry);
  }
  return Array.from(byKey.values()).sort((a, b) => b.updatedAt - a.updatedAt);
}

function sanitizeBookmarkKind(value: unknown): BookmarkTargetKind | "" {
  if (
    value === "message" ||
    value === "patchGroup" ||
    value === "tool" ||
    value === "usage" ||
    value === "environment" ||
    value === "note"
  ) {
    return value;
  }
  return "";
}

function normalizeBookmarkText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeBookmarkTitle(value: unknown): string {
  const title = normalizeBookmarkText(value);
  return title.length > 160 ? title.slice(0, 160) : title;
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
