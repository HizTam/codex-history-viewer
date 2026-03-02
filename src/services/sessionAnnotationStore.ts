import * as vscode from "vscode";
import { normalizeCacheKey } from "../utils/fsUtils";

export interface SessionAnnotation {
  fsPath: string;
  cacheKey: string;
  tags: string[];
  note: string;
  updatedAt: number;
}

export interface AnnotationTagStat {
  tag: string;
  count: number;
}

const ANNOTATION_KEY = "codexHistoryViewer.sessionAnnotations.v1";

// Stores per-session tags/notes in Memento.
export class SessionAnnotationStore {
  private readonly memento: vscode.Memento;

  constructor(memento: vscode.Memento) {
    this.memento = memento;
  }

  public get(fsPath: string): SessionAnnotation | null {
    const key = normalizeCacheKey(fsPath);
    return this.getAll().find((x) => x.cacheKey === key) ?? null;
  }

  public getAll(): SessionAnnotation[] {
    const raw = this.memento.get<unknown>(ANNOTATION_KEY);
    if (!Array.isArray(raw)) return [];
    return raw
      .map((x) => sanitizeAnnotation(x))
      .filter((x): x is SessionAnnotation => x !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  public listTagStats(): AnnotationTagStat[] {
    const byKey = new Map<string, AnnotationTagStat>();
    for (const ann of this.getAll()) {
      const seenInSession = new Set<string>();
      for (const tag of ann.tags) {
        const key = normalizeTagKey(tag);
        if (!key || seenInSession.has(key)) continue;
        seenInSession.add(key);

        const current = byKey.get(key);
        if (!current) {
          byKey.set(key, { tag, count: 1 });
          continue;
        }
        current.count += 1;
      }
    }

    return Array.from(byKey.values()).sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count;
      return a.tag.localeCompare(b.tag, "en", { sensitivity: "base" });
    });
  }

  public async set(fsPath: string, params: { tags: readonly string[]; note: string }): Promise<void> {
    const key = normalizeCacheKey(fsPath);
    const list = this.getAll().filter((x) => x.cacheKey !== key);
    const tags = normalizeTags(params.tags);
    const note = normalizeNote(params.note);
    if (tags.length === 0 && note.length === 0) {
      await this.memento.update(ANNOTATION_KEY, list);
      return;
    }
    const next: SessionAnnotation = {
      fsPath,
      cacheKey: key,
      tags,
      note,
      updatedAt: Date.now(),
    };
    list.push(next);
    await this.memento.update(ANNOTATION_KEY, list);
  }

  public async remove(fsPath: string): Promise<void> {
    const key = normalizeCacheKey(fsPath);
    const list = this.getAll().filter((x) => x.cacheKey !== key);
    await this.memento.update(ANNOTATION_KEY, list);
  }

  public async removeMany(fsPaths: readonly string[]): Promise<void> {
    const removeKeys = new Set(fsPaths.map((p) => normalizeCacheKey(p)));
    const list = this.getAll().filter((x) => !removeKeys.has(x.cacheKey));
    await this.memento.update(ANNOTATION_KEY, list);
  }

  public async addTagsMany(fsPaths: readonly string[], tags: readonly string[]): Promise<number> {
    const addTags = normalizeTags(tags);
    if (addTags.length === 0) return 0;
    const keys = new Set(fsPaths.map((p) => normalizeCacheKey(p)));
    if (keys.size === 0) return 0;

    const list = this.getAll();
    const byKey = new Map(list.map((x) => [x.cacheKey, x]));
    let changed = 0;
    for (const key of keys) {
      const current = byKey.get(key);
      const fsPath = current?.fsPath ?? Array.from(fsPaths).find((p) => normalizeCacheKey(p) === key) ?? "";
      if (!fsPath) continue;
      const merged = normalizeTags([...(current?.tags ?? []), ...addTags]);
      const nextNote = current?.note ?? "";
      if (isSameAnnotation(current, merged, nextNote)) continue;
      byKey.set(key, {
        fsPath,
        cacheKey: key,
        tags: merged,
        note: nextNote,
        updatedAt: Date.now(),
      });
      changed += 1;
    }

    if (changed === 0) return 0;
    await this.memento.update(ANNOTATION_KEY, compactAnnotations(Array.from(byKey.values())));
    return changed;
  }

  public async removeTagsMany(fsPaths: readonly string[], tags: readonly string[]): Promise<number> {
    const removeKeys = new Set(normalizeTags(tags).map((x) => normalizeTagKey(x)));
    if (removeKeys.size === 0) return 0;
    const targetKeys = new Set(fsPaths.map((p) => normalizeCacheKey(p)));
    if (targetKeys.size === 0) return 0;

    const list = this.getAll();
    const byKey = new Map(list.map((x) => [x.cacheKey, x]));
    let changed = 0;
    for (const key of targetKeys) {
      const current = byKey.get(key);
      if (!current) continue;
      const nextTags = current.tags.filter((tag) => !removeKeys.has(normalizeTagKey(tag)));
      if (isSameAnnotation(current, nextTags, current.note)) continue;
      if (nextTags.length === 0 && current.note.length === 0) {
        byKey.delete(key);
      } else {
        byKey.set(key, {
          ...current,
          tags: nextTags,
          updatedAt: Date.now(),
        });
      }
      changed += 1;
    }

    if (changed === 0) return 0;
    await this.memento.update(ANNOTATION_KEY, compactAnnotations(Array.from(byKey.values())));
    return changed;
  }
}

function sanitizeAnnotation(value: unknown): SessionAnnotation | null {
  if (!value || typeof value !== "object") return null;
  const v = value as any;
  if (typeof v.fsPath !== "string" || v.fsPath.trim().length === 0) return null;
  if (typeof v.updatedAt !== "number" || !Number.isFinite(v.updatedAt)) return null;
  const tags = normalizeTags(Array.isArray(v.tags) ? v.tags : []);
  const note = normalizeNote(typeof v.note === "string" ? v.note : "");
  return {
    fsPath: v.fsPath.trim(),
    cacheKey: normalizeCacheKey(v.fsPath),
    tags,
    note,
    updatedAt: v.updatedAt,
  };
}

function normalizeTags(values: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const s = String(raw ?? "").trim();
    if (!s) continue;
    const key = normalizeTagKey(s);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= 12) break;
  }
  return out;
}

function normalizeTagKey(value: string): string {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeNote(value: unknown): string {
  const s = String(value ?? "").trim();
  if (!s) return "";
  return s.length > 500 ? s.slice(0, 500) : s;
}

function isSameAnnotation(
  current: SessionAnnotation | undefined,
  nextTags: readonly string[],
  nextNote: string,
): boolean {
  if (!current) return nextTags.length === 0 && nextNote.length === 0;
  if (current.note !== nextNote) return false;
  if (current.tags.length !== nextTags.length) return false;
  for (let i = 0; i < current.tags.length; i += 1) {
    if (normalizeTagKey(current.tags[i] ?? "") !== normalizeTagKey(nextTags[i] ?? "")) return false;
  }
  return true;
}

function compactAnnotations(values: readonly SessionAnnotation[]): SessionAnnotation[] {
  return values
    .map((x) => sanitizeAnnotation(x))
    .filter((x): x is SessionAnnotation => x !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
