import * as vscode from "vscode";
import { normalizeCacheKey } from "../utils/fsUtils";
import type { SessionMetadataMutationCoordinator } from "./sessionMetadataMutationCoordinator";
import { MementoSnapshotCache } from "./mementoSnapshotCache";
import type { HistoryIndex } from "../sessions/sessionTypes";
import { resolveCodexRolloutMainline } from "../sessions/codexRolloutRevisions";

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

export const ANNOTATION_KEY = "codexHistoryViewer.sessionAnnotations.v1";

// Stores per-session tags/notes in Memento.
export class SessionAnnotationStore implements vscode.Disposable {
  private readonly coordinator?: SessionMetadataMutationCoordinator;
  private readonly cache: MementoSnapshotCache<{ entries: SessionAnnotation[]; byPathKey: Map<string, SessionAnnotation> }>;
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  private mutationQueue: Promise<void> = Promise.resolve();

  public readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(memento: vscode.Memento, coordinator?: SessionMetadataMutationCoordinator) {
    this.coordinator = coordinator;
    this.cache = new MementoSnapshotCache(memento, ANNOTATION_KEY, (raw) => {
      const entries = sanitizeAnnotations(raw);
      const byPathKey = new Map<string, SessionAnnotation>();
      for (const entry of entries) {
        if (!byPathKey.has(entry.cacheKey)) byPathKey.set(entry.cacheKey, entry);
      }
      return { entries, byPathKey };
    });
  }

  public dispose(): void {
    this.cache.invalidate();
    this.onDidChangeEmitter.dispose();
  }

  public get(fsPath: string): SessionAnnotation | null {
    const key = normalizeCacheKey(fsPath);
    const annotation = this.cache.read().byPathKey.get(key);
    return annotation ? cloneAnnotation(annotation) : null;
  }

  public getAll(): SessionAnnotation[] {
    return this.cache.read().entries.map((entry) => cloneAnnotation(entry));
  }

  public listTagStats(index?: HistoryIndex): AnnotationTagStat[] {
    const byKey = new Map<string, AnnotationTagStat>();
    for (const ann of this.getAll()) {
      const mainline = index ? resolveCodexRolloutMainline(index, ann.cacheKey) : undefined;
      if (mainline && mainline.cacheKey !== ann.cacheKey) continue;
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
    await this.runMutation(() => this.setUncoordinated(fsPath, params));
  }

  private async setUncoordinated(fsPath: string, params: { tags: readonly string[]; note: string }): Promise<void> {
    const key = normalizeCacheKey(fsPath);
    const current = this.getAll();
    const tags = normalizeSessionAnnotationTags(params.tags);
    const note = normalizeNote(params.note);
    const existing = current.find((x) => x.cacheKey === key);
    if (isSameSessionAnnotationContent(existing, tags, note)) return;
    const list = current.filter((x) => x.cacheKey !== key);
    if (tags.length === 0 && note.length === 0) {
      await this.persist(list);
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
    await this.persist(list);
  }

  public async remove(fsPath: string): Promise<void> {
    await this.runMutation(() => this.removeUncoordinated(fsPath));
  }

  private async removeUncoordinated(fsPath: string): Promise<void> {
    const key = normalizeCacheKey(fsPath);
    const current = this.getAll();
    const list = current.filter((x) => x.cacheKey !== key);
    if (list.length === current.length) return;
    await this.persist(list);
  }

  public async removeMany(fsPaths: readonly string[]): Promise<void> {
    await this.runMutation(() => this.removeManyUncoordinated(fsPaths));
  }

  private async removeManyUncoordinated(fsPaths: readonly string[]): Promise<void> {
    const removeKeys = new Set(fsPaths.map((p) => normalizeCacheKey(p)));
    const current = this.getAll();
    const list = current.filter((x) => !removeKeys.has(x.cacheKey));
    if (list.length === current.length) return;
    await this.persist(list);
  }

  public async replaceAll(
    values: readonly SessionAnnotation[],
    options?: { notify?: boolean; skipCoordinator?: boolean },
  ): Promise<void> {
    if (options?.skipCoordinator === true) {
      await this.persist(values, options);
      return;
    }
    await this.runMutation(() => this.persist(values, options));
  }

  public notifyChanged(): void {
    this.cache.invalidate();
    this.onDidChangeEmitter.fire();
  }

  public async relocate(oldFsPath: string, newFsPath: string): Promise<boolean> {
    return this.runMutation(() => this.relocateUncoordinated(oldFsPath, newFsPath));
  }

  private async relocateUncoordinated(oldFsPath: string, newFsPath: string): Promise<boolean> {
    const oldKey = normalizeCacheKey(oldFsPath);
    const newKey = normalizeCacheKey(newFsPath);
    if (!oldKey || !newKey || oldKey === newKey) return false;

    const list = this.getAll();
    const oldAnnotation = list.find((x) => x.cacheKey === oldKey);
    if (!oldAnnotation) return false;

    const newAnnotation = list.find((x) => x.cacheKey === newKey);
    const mergedTags = normalizeSessionAnnotationTags([...(newAnnotation?.tags ?? []), ...oldAnnotation.tags]);
    const mergedNote = normalizeNote(newAnnotation ? newAnnotation.note : oldAnnotation.note);
    const next = list.filter((x) => x.cacheKey !== oldKey && x.cacheKey !== newKey);
    if (mergedTags.length > 0 || mergedNote.length > 0) {
      next.push({
        fsPath: newFsPath,
        cacheKey: newKey,
        tags: mergedTags,
        note: mergedNote,
        updatedAt: Date.now(),
      });
    }

    await this.persist(next);
    return true;
  }

  public async addTagsMany(fsPaths: readonly string[], tags: readonly string[]): Promise<number> {
    return this.runMutation(() => this.addTagsManyUncoordinated(fsPaths, tags));
  }

  private async addTagsManyUncoordinated(fsPaths: readonly string[], tags: readonly string[]): Promise<number> {
    const addTags = normalizeSessionAnnotationTags(tags);
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
      const merged = normalizeSessionAnnotationTags([...(current?.tags ?? []), ...addTags]);
      const nextNote = current?.note ?? "";
      if (isSameSessionAnnotationContent(current, merged, nextNote)) continue;
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
    await this.persist(Array.from(byKey.values()));
    return changed;
  }

  public async removeTagsMany(fsPaths: readonly string[], tags: readonly string[]): Promise<number> {
    return this.runMutation(() => this.removeTagsManyUncoordinated(fsPaths, tags));
  }

  private async removeTagsManyUncoordinated(fsPaths: readonly string[], tags: readonly string[]): Promise<number> {
    const removeKeys = new Set(normalizeSessionAnnotationTags(tags).map((x) => normalizeTagKey(x)));
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
      if (isSameSessionAnnotationContent(current, nextTags, current.note)) continue;
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
    await this.persist(Array.from(byKey.values()));
    return changed;
  }

  private async persist(values: readonly SessionAnnotation[], options?: { notify?: boolean }): Promise<void> {
    const compacted = compactAnnotations(values);
    await this.cache.write(compacted);
    if (options?.notify !== false) this.onDidChangeEmitter.fire();
  }

  private runMutation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.coordinator) return this.coordinator.runExclusive(operation);
    const next = this.mutationQueue.then(operation, operation);
    this.mutationQueue = next.then(() => undefined, () => undefined);
    return next;
  }
}

function cloneAnnotation(value: SessionAnnotation): SessionAnnotation {
  return { ...value, tags: [...value.tags] };
}

function sanitizeAnnotation(value: unknown): SessionAnnotation | null {
  if (!value || typeof value !== "object") return null;
  const v = value as any;
  if (typeof v.fsPath !== "string" || v.fsPath.trim().length === 0) return null;
  if (typeof v.updatedAt !== "number" || !Number.isFinite(v.updatedAt)) return null;
  const tags = normalizeSessionAnnotationTags(Array.isArray(v.tags) ? v.tags : []);
  const note = normalizeNote(typeof v.note === "string" ? v.note : "");
  return {
    fsPath: v.fsPath.trim(),
    cacheKey: normalizeCacheKey(v.fsPath),
    tags,
    note,
    updatedAt: v.updatedAt,
  };
}

// Keep automatic inheritance and user edits subject to the same tag rules.
export function normalizeSessionAnnotationTags(values: readonly unknown[]): string[] {
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

// Compare normalized content without treating timestamps or paths as edits.
export function isSameSessionAnnotationContent(
  current: SessionAnnotation | null | undefined,
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
  return sanitizeAnnotations(values);
}

function sanitizeAnnotations(value: unknown): SessionAnnotation[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => sanitizeAnnotation(entry))
    .filter((entry): entry is SessionAnnotation => entry !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
