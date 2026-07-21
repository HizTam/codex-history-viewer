import * as vscode from "vscode";
import { normalizeProjectKey } from "../utils/fsUtils";

export type ProjectAssociationMode = "relocate" | "groupOnly";
export type ProjectAssociationSetPreflight = "ok" | "invalid" | "sameProject" | "circular" | "sameTarget" | "sameGroup";
export type ProjectAssociationModeChangePreflight = "ok" | "invalid" | "noAssociation" | "sameMode";

export interface ProjectAssociation {
  sourceKey: string;
  targetKey: string;
  sourceCwd: string;
  targetCwd: string;
  mode: ProjectAssociationMode;
  createdAt: number;
  updatedAt: number;
}

const PROJECT_ASSOCIATIONS_KEY = "codexHistoryViewer.projectAssociations.v1";
export const NO_CWD_PROJECT_KEY = "__no_cwd__";
const MAX_CANONICAL_DEPTH = 256;

// Stores display-only project associations without changing source history files.
export class ProjectAssociationStore {
  private readonly memento: vscode.Memento;
  private entriesCache: Map<string, ProjectAssociation> | null = null;

  constructor(memento: vscode.Memento) {
    this.memento = memento;
  }

  public isEmpty(): boolean {
    return this.getCachedEntries().size === 0;
  }

  public getAll(): ProjectAssociation[] {
    return Array.from(this.getCachedEntries().values()).sort((a, b) => {
      if (a.targetKey !== b.targetKey) return a.targetKey.localeCompare(b.targetKey);
      return a.sourceKey.localeCompare(b.sourceKey);
    });
  }

  public invalidateCache(): void {
    this.entriesCache = null;
  }

  public getBySourceCwd(cwd: string | null | undefined): ProjectAssociation | null {
    const key = resolveProjectAssociationKey(cwd);
    if (!key) return null;
    return this.getCachedEntries().get(key) ?? null;
  }

  public getCanonicalProjectKey(cwd: string | null | undefined): string | null {
    return this.getGroupCanonicalProjectKey(cwd);
  }

  public createCanonicalProjectKeyResolver(): (cwd: string | null | undefined) => string | null {
    // Isolate callers from association changes published after this point.
    const entries = new Map(
      Array.from(this.getCachedEntries(), ([key, entry]) => [
        key,
        Object.freeze({ ...entry }),
      ] as const),
    );
    return (cwd: string | null | undefined): string | null => {
      const key = resolveProjectAssociationKey(cwd);
      if (!key) return null;
      return entries.size === 0 ? key : resolveGroupCanonicalProjectKey(key, entries);
    };
  }

  public getGroupCanonicalProjectKey(cwd: string | null | undefined): string | null {
    const key = resolveProjectAssociationKey(cwd);
    if (!key) return null;
    const entries = this.getCachedEntries();
    if (entries.size === 0) return key;
    return resolveGroupCanonicalProjectKey(key, entries);
  }

  public getRelocationProjectKey(cwd: string | null | undefined): string | null {
    const key = resolveProjectAssociationKey(cwd);
    if (!key) return null;
    const entries = this.getCachedEntries();
    if (entries.size === 0) return key;
    return resolveRelocationProjectKey(key, entries);
  }

  public getDisplayCwd(cwd: string | null | undefined): string | null {
    const raw = typeof cwd === "string" ? cwd.trim() : "";
    if (!raw) return null;
    const key = resolveProjectAssociationKey(raw);
    if (!key) return null;

    const entries = this.getCachedEntries();
    if (entries.size === 0) return raw;
    const relocationKey = resolveRelocationProjectKey(key, entries);
    if (relocationKey === key) return raw;
    const targetEntry = findRepresentativeTargetEntry(relocationKey, entries);
    return targetEntry?.targetCwd ?? raw;
  }

  public getSourcesForTargetCwd(cwd: string | null | undefined): ProjectAssociation[] {
    const targetKey = this.getGroupCanonicalProjectKey(cwd);
    if (!targetKey) return [];
    return this.getSourcesForTargetKey(targetKey);
  }

  public getSourcesForTargetKey(targetKey: string | null | undefined): ProjectAssociation[] {
    const key = resolveProjectAssociationKey(targetKey);
    if (!key) return [];
    const entries = this.getCachedEntries();
    return Array.from(entries.values())
      .filter((entry) => resolveGroupCanonicalProjectKey(entry.sourceKey, entries) === key)
      .sort((a, b) => a.sourceCwd.localeCompare(b.sourceCwd));
  }

  public getDirectSourcesForTargetCwd(cwd: string | null | undefined): ProjectAssociation[] {
    const targetKey = resolveProjectAssociationKey(cwd);
    if (!targetKey) return [];
    return this.getDirectSourcesForTargetKey(targetKey);
  }

  public getDirectSourcesForTargetKey(targetKey: string | null | undefined): ProjectAssociation[] {
    const key = resolveProjectAssociationKey(targetKey);
    if (!key) return [];
    return Array.from(this.getCachedEntries().values())
      .filter((entry) => entry.targetKey === key)
      .sort((a, b) => a.sourceCwd.localeCompare(b.sourceCwd));
  }

  public getRelocationSourcesForTargetCwd(cwd: string | null | undefined): ProjectAssociation[] {
    const targetKey = resolveProjectAssociationKey(cwd);
    if (!targetKey) return [];
    const entries = this.getCachedEntries();
    return Array.from(entries.values())
      .filter((entry) => entry.mode === "relocate")
      .filter((entry) => resolveRelocationProjectKey(entry.sourceKey, entries) === targetKey)
      .sort((a, b) => a.sourceCwd.localeCompare(b.sourceCwd));
  }

  public getDescendantSourcesForSourceCwd(cwd: string | null | undefined): ProjectAssociation[] {
    const sourceKey = resolveProjectAssociationKey(cwd);
    if (!sourceKey) return [];
    const entries = this.getCachedEntries();
    return Array.from(entries.values())
      .filter((entry) => canReachProjectKey(entry.sourceKey, sourceKey, entries, "group"))
      .sort((a, b) => a.sourceCwd.localeCompare(b.sourceCwd));
  }

  public getRepresentativeTargetCwd(targetKey: string | null | undefined): string | null {
    const key = resolveProjectAssociationKey(targetKey);
    if (!key) return null;
    return findRepresentativeTargetEntry(key, this.getCachedEntries())?.targetCwd ?? null;
  }

  public evaluateSet(sourceCwd: string | null | undefined, targetCwd: string | null | undefined): ProjectAssociationSetPreflight {
    const sourceKey = resolveProjectAssociationKey(sourceCwd);
    const targetKey = resolveProjectAssociationKey(targetCwd);
    if (!sourceKey || !targetKey) return "invalid";
    if (sourceKey === targetKey) return "sameProject";

    const entries = this.getCachedEntries();
    const entriesWithoutSource = new Map(entries);
    entriesWithoutSource.delete(sourceKey);
    if (canReachProjectKey(targetKey, sourceKey, entriesWithoutSource, "group")) return "circular";

    const previous = entries.get(sourceKey);
    if (previous?.targetKey === targetKey) return "sameTarget";

    const sourceCanonical = resolveGroupCanonicalProjectKey(sourceKey, entries);
    const targetCanonical = resolveGroupCanonicalProjectKey(targetKey, entries);
    if (sourceCanonical && targetCanonical && sourceCanonical === targetCanonical) return "sameGroup";

    return "ok";
  }

  public evaluateModeChange(
    sourceCwd: string | null | undefined,
    mode: ProjectAssociationMode,
  ): ProjectAssociationModeChangePreflight {
    const sourceKey = resolveProjectAssociationKey(sourceCwd);
    if (!sourceKey) return "invalid";
    const previous = this.getCachedEntries().get(sourceKey);
    if (!previous) return "noAssociation";
    if (previous.mode === normalizeAssociationMode(mode)) return "sameMode";
    return "ok";
  }

  public async set(sourceCwd: string, targetCwd: string, mode: ProjectAssociationMode = "relocate"): Promise<boolean> {
    const sourceKey = resolveProjectAssociationKey(sourceCwd);
    const targetKey = resolveProjectAssociationKey(targetCwd);
    if (!sourceKey || !targetKey || sourceKey === targetKey) return false;

    const entries = this.getAllBySourceKey();
    const normalizedMode = normalizeAssociationMode(mode);
    const entriesWithoutSource = new Map(entries);
    entriesWithoutSource.delete(sourceKey);
    if (canReachProjectKey(targetKey, sourceKey, entriesWithoutSource, "group")) return false;

    const resolvedTargetKey =
      normalizedMode === "relocate"
        ? resolveRelocationProjectKey(targetKey, entriesWithoutSource)
        : targetKey;
    if (!resolvedTargetKey || sourceKey === resolvedTargetKey) return false;

    const now = Date.now();
    const targetRepresentativeCwd =
      normalizedMode === "relocate"
        ? (findRepresentativeTargetEntry(resolvedTargetKey, entries)?.targetCwd ?? targetCwd.trim())
        : targetCwd.trim();
    let changed = false;

    if (normalizedMode === "relocate") {
      for (const [key, entry] of Array.from(entries.entries())) {
        if (entry.targetKey !== sourceKey) continue;
        entries.set(key, {
          ...entry,
          targetKey: resolvedTargetKey,
          targetCwd: targetRepresentativeCwd,
          updatedAt: now,
        });
        changed = true;
      }
    }

    const previous = entries.get(sourceKey);
    const next: ProjectAssociation = {
      sourceKey,
      targetKey: resolvedTargetKey,
      sourceCwd: sourceCwd.trim(),
      targetCwd: targetRepresentativeCwd,
      mode: normalizedMode,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };

    if (!areAssociationsEqual(previous, next)) {
      entries.set(sourceKey, next);
      changed = true;
    }

    if (!changed) return false;
    await this.save(entries);
    return true;
  }

  public async changeMode(sourceCwd: string | null | undefined, mode: ProjectAssociationMode): Promise<boolean> {
    const sourceKey = resolveProjectAssociationKey(sourceCwd);
    if (!sourceKey) return false;
    const previous = this.getCachedEntries().get(sourceKey);
    if (!previous) return false;
    return this.set(previous.sourceCwd, previous.targetCwd, normalizeAssociationMode(mode));
  }

  public async removeBySourceCwd(sourceCwd: string | null | undefined): Promise<boolean> {
    const sourceKey = resolveProjectAssociationKey(sourceCwd);
    if (!sourceKey) return false;
    const entries = this.getAllBySourceKey();
    const changed = entries.delete(sourceKey);
    if (changed) await this.save(entries);
    return changed;
  }

  public async removeDirectSourcesForTargetCwd(targetCwd: string | null | undefined): Promise<ProjectAssociation[]> {
    const targetKey = resolveProjectAssociationKey(targetCwd);
    if (!targetKey) return [];

    const entries = this.getAllBySourceKey();
    const removed: ProjectAssociation[] = [];
    for (const [sourceKey, entry] of Array.from(entries.entries())) {
      if (entry.targetKey !== targetKey) continue;
      entries.delete(sourceKey);
      removed.push(entry);
    }
    if (removed.length > 0) await this.save(entries);
    return removed.sort((a, b) => a.sourceCwd.localeCompare(b.sourceCwd));
  }

  public async restoreSnapshot(snapshot: readonly ProjectAssociation[]): Promise<void> {
    const entries = new Map<string, ProjectAssociation>();
    for (const entry of snapshot) {
      const sanitized = sanitizeAssociationEntry(entry.sourceKey, entry);
      if (sanitized) entries.set(sanitized.sourceKey, sanitized);
    }
    await this.save(entries);
  }

  private getAllBySourceKey(): Map<string, ProjectAssociation> {
    return new Map(this.getCachedEntries());
  }

  private getCachedEntries(): ReadonlyMap<string, ProjectAssociation> {
    if (this.entriesCache) return this.entriesCache;

    const raw = this.memento.get<unknown>(PROJECT_ASSOCIATIONS_KEY);
    if (!raw || typeof raw !== "object") {
      this.entriesCache = new Map();
      return this.entriesCache;
    }

    const out = new Map<string, ProjectAssociation>();
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const entry = sanitizeAssociationEntry(key, value);
      if (entry) out.set(entry.sourceKey, entry);
    }
    this.entriesCache = sanitizeEntries(out);
    return this.entriesCache;
  }

  private async save(entries: ReadonlyMap<string, ProjectAssociation>): Promise<void> {
    const sanitized = sanitizeEntries(entries);
    const payload: Record<string, ProjectAssociation> = {};
    for (const [key, entry] of sanitized.entries()) {
      payload[key] = entry;
    }
    this.entriesCache = new Map(sanitized);
    await this.memento.update(PROJECT_ASSOCIATIONS_KEY, payload);
  }
}

export function resolveProjectAssociationKey(cwd: unknown): string | null {
  const raw = typeof cwd === "string" ? cwd.trim() : "";
  if (!raw || raw === NO_CWD_PROJECT_KEY) return null;
  const key = normalizeProjectKey(raw);
  if (!key || key === NO_CWD_PROJECT_KEY) return null;
  return key;
}

function resolveGroupCanonicalProjectKey(
  startKey: string,
  entries: ReadonlyMap<string, ProjectAssociation>,
): string {
  const normalizedStart = resolveProjectAssociationKey(startKey);
  if (!normalizedStart) return "";

  let current = normalizedStart;
  const visited = new Set<string>();
  const limit = Math.min(MAX_CANONICAL_DEPTH, entries.size + 1);
  for (let depth = 0; depth <= limit; depth += 1) {
    if (visited.has(current)) return normalizedStart;
    visited.add(current);

    const entry = entries.get(current);
    if (!entry) return current;
    const next = resolveProjectAssociationKey(entry.targetKey);
    if (!next) return normalizedStart;
    current = next;
  }

  return normalizedStart;
}

function resolveRelocationProjectKey(
  startKey: string,
  entries: ReadonlyMap<string, ProjectAssociation>,
): string {
  const normalizedStart = resolveProjectAssociationKey(startKey);
  if (!normalizedStart) return "";

  let current = normalizedStart;
  const visited = new Set<string>();
  const limit = Math.min(MAX_CANONICAL_DEPTH, entries.size + 1);
  for (let depth = 0; depth <= limit; depth += 1) {
    if (visited.has(current)) return normalizedStart;
    visited.add(current);

    const entry = entries.get(current);
    if (!entry || entry.mode !== "relocate") return current;
    const next = resolveProjectAssociationKey(entry.targetKey);
    if (!next) return normalizedStart;
    current = next;
  }

  return normalizedStart;
}

function canReachProjectKey(
  startKey: string,
  targetKey: string,
  entries: ReadonlyMap<string, ProjectAssociation>,
  mode: "group" | "relocate",
): boolean {
  const normalizedStart = resolveProjectAssociationKey(startKey);
  const normalizedTarget = resolveProjectAssociationKey(targetKey);
  if (!normalizedStart || !normalizedTarget) return false;

  let current = normalizedStart;
  const visited = new Set<string>();
  const limit = Math.min(MAX_CANONICAL_DEPTH, entries.size + 1);
  for (let depth = 0; depth <= limit; depth += 1) {
    if (current === normalizedTarget) return true;
    if (visited.has(current)) return false;
    visited.add(current);

    const entry = entries.get(current);
    if (!entry || (mode === "relocate" && entry.mode !== "relocate")) return false;
    const next = resolveProjectAssociationKey(entry.targetKey);
    if (!next) return false;
    current = next;
  }

  return false;
}

function sanitizeEntries(entries: ReadonlyMap<string, ProjectAssociation>): Map<string, ProjectAssociation> {
  const valid = new Map<string, ProjectAssociation>();
  for (const [key, value] of entries.entries()) {
    const entry = sanitizeAssociationEntry(key, value);
    if (entry) valid.set(entry.sourceKey, entry);
  }

  const out = new Map<string, ProjectAssociation>();
  for (const entry of valid.values()) {
    const entriesWithoutSource = new Map(valid);
    entriesWithoutSource.delete(entry.sourceKey);
    if (canReachProjectKey(entry.targetKey, entry.sourceKey, entriesWithoutSource, "group")) continue;
    const target =
      entry.mode === "relocate"
        ? resolveRelocationProjectKey(entry.targetKey, entriesWithoutSource)
        : entry.targetKey;
    if (!target || target === entry.sourceKey) continue;

    const targetEntry = entry.targetKey === target ? entry : findRepresentativeTargetEntry(target, valid);
    if (!targetEntry) {
      out.set(entry.sourceKey, entry);
      continue;
    }

    const targetCwd = targetEntry.targetCwd;
    if (resolveProjectAssociationKey(targetCwd) !== target) {
      out.set(entry.sourceKey, entry);
      continue;
    }
    out.set(entry.sourceKey, { ...entry, targetKey: target, targetCwd });
  }
  return out;
}

function sanitizeAssociationEntry(key: string, value: unknown): ProjectAssociation | null {
  const sourceKey = resolveProjectAssociationKey(key);
  if (!sourceKey) return null;
  if (!value || typeof value !== "object") return null;

  const raw = value as any;
  const rawSourceKey = resolveProjectAssociationKey(raw.sourceKey);
  const targetKey = resolveProjectAssociationKey(raw.targetKey);
  const sourceCwd = typeof raw.sourceCwd === "string" ? raw.sourceCwd.trim() : "";
  const targetCwd = typeof raw.targetCwd === "string" ? raw.targetCwd.trim() : "";
  const mode = normalizeAssociationMode(raw.mode);
  const createdAt = typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : 0;
  const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0;

  if (!rawSourceKey || rawSourceKey !== sourceKey) return null;
  if (!targetKey || sourceKey === targetKey) return null;
  if (!sourceCwd || resolveProjectAssociationKey(sourceCwd) !== sourceKey) return null;
  if (!targetCwd || resolveProjectAssociationKey(targetCwd) !== targetKey) return null;
  if (createdAt <= 0 || updatedAt <= 0) return null;

  return {
    sourceKey,
    targetKey,
    sourceCwd,
    targetCwd,
    mode,
    createdAt,
    updatedAt,
  };
}

function findRepresentativeTargetEntry(
  targetKey: string | null | undefined,
  entries: ReadonlyMap<string, ProjectAssociation>,
): ProjectAssociation | null {
  const key = resolveProjectAssociationKey(targetKey);
  if (!key) return null;

  let best: ProjectAssociation | null = null;
  for (const entry of entries.values()) {
    if (entry.targetKey !== key) continue;
    if (!best || compareRepresentativeTargetEntry(entry, best) < 0) best = entry;
  }
  return best;
}

function compareRepresentativeTargetEntry(left: ProjectAssociation, right: ProjectAssociation): number {
  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt;
  if (left.sourceKey !== right.sourceKey) return left.sourceKey.localeCompare(right.sourceKey);
  return left.targetCwd.localeCompare(right.targetCwd);
}

function areAssociationsEqual(left: ProjectAssociation | undefined, right: ProjectAssociation): boolean {
  return (
    !!left &&
    left.sourceKey === right.sourceKey &&
    left.targetKey === right.targetKey &&
    left.sourceCwd === right.sourceCwd &&
    left.targetCwd === right.targetCwd &&
    left.mode === right.mode
  );
}

function normalizeAssociationMode(value: unknown): ProjectAssociationMode {
  return value === "groupOnly" ? "groupOnly" : "relocate";
}
