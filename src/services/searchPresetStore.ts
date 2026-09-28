import * as vscode from "vscode";
import { parseHistoryFilterStateV3, type HistoryFilterStateV3 } from "../types/historyFilterState";

export interface SearchPreset {
  id: string;
  queryInput: string;
  scope?: HistoryFilterStateV3;
  invalidScope?: true;
  createdAt: number;
  updatedAt: number;
}

const PRESET_KEY = "codexHistoryViewer.searchPresets.v1";

// Stores search presets in Memento.
export class SearchPresetStore {
  private readonly memento: vscode.Memento;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(memento: vscode.Memento) {
    this.memento = memento;
  }

  public getAll(): SearchPreset[] {
    const raw = this.memento.get<unknown>(PRESET_KEY);
    if (!Array.isArray(raw)) return [];
    return dedupePresets(
      raw
        .map((item) => sanitizePreset(item))
        .filter((p): p is SearchPreset => p !== null)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    );
  }

  public async save(params: { queryInput: string; overwriteId?: string; scope?: HistoryFilterStateV3 }): Promise<SearchPreset> {
    const queryInput = normalizeQueryInput(params.queryInput);
    if (!queryInput) throw new Error("preset query is empty");
    const scope = params.scope === undefined ? undefined : parseHistoryFilterStateV3(params.scope);
    if (scope === null) throw new Error("preset scope is invalid");
    return this.enqueueWrite(async () => {
      const now = Date.now();
      const list = this.getAll();
      const existing = params.overwriteId
        ? list.find((p) => p.id === params.overwriteId)
        : list.find((p) => presetKey(p) === presetKey({ queryInput, scope }));
      const next: SearchPreset = existing
        ? { id: existing.id, queryInput, createdAt: existing.createdAt, updatedAt: now, ...(scope ? { scope } : {}) }
        : { id: makePresetId(), queryInput, createdAt: now, updatedAt: now, ...(scope ? { scope } : {}) };

      const kept = list.filter((p) => p.id !== next.id);
      kept.push(next);
      await this.memento.update(PRESET_KEY, kept);
      return next;
    });
  }

  public delete(id: string): Promise<boolean> {
    return this.enqueueWrite(async () => {
      const list = this.getAll();
      const next = list.filter((p) => p.id !== id);
      if (next.length === list.length) return false;
      await this.memento.update(PRESET_KEY, next);
      return true;
    });
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function sanitizePreset(value: unknown): SearchPreset | null {
  if (!value || typeof value !== "object") return null;
  const v = value as any;
  if (typeof v.id !== "string" || v.id.trim().length === 0) return null;
  const queryInput = normalizeQueryInput(v.queryInput) || normalizeQueryInput(v.request?.queryInput) || normalizeQueryInput(v.name);
  if (!queryInput) return null;
  const createdAt = typeof v.createdAt === "number" && Number.isFinite(v.createdAt) ? v.createdAt : 0;
  const updatedAt = typeof v.updatedAt === "number" && Number.isFinite(v.updatedAt) ? v.updatedAt : createdAt;
  const scope = v.scope === undefined ? undefined : parseHistoryFilterStateV3(v.scope);
  return {
    id: v.id.trim(),
    queryInput,
    createdAt,
    updatedAt,
    ...(scope ? { scope } : scope === null || v.invalidScope === true ? { invalidScope: true as const } : {}),
  };
}

function normalizeQueryInput(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function dedupePresets(presets: readonly SearchPreset[]): SearchPreset[] {
  const seen = new Set<string>();
  const out: SearchPreset[] = [];
  for (const preset of presets.slice().sort((a, b) => b.updatedAt - a.updatedAt)) {
    const key = presetKey(preset);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(preset);
  }
  return out;
}

// Preserve distinct scopes while treating set-valued filters as unordered.
function presetKey(preset: Pick<SearchPreset, "queryInput" | "scope" | "invalidScope">): string {
  const scope = preset.scope;
  return JSON.stringify([preset.queryInput, preset.invalidScope === true, scope ? {
    ...scope,
    tags: scope.tags.map(tag => tag.toLowerCase()).sort(),
    projects: scope.projects.kind === "groups"
      ? { kind: "groups", groups: [...scope.projects.groups].sort((a, b) => a.canonicalGroupKey.localeCompare(b.canonicalGroupKey)) }
      : scope.projects,
  } : null]);
}

function makePresetId(): string {
  const r = Math.random().toString(36).slice(2, 8);
  return `${Date.now().toString(36)}-${r}`;
}
