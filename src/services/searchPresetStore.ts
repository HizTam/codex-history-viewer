import * as vscode from "vscode";

export interface SearchPreset {
  id: string;
  queryInput: string;
  createdAt: number;
  updatedAt: number;
}

const PRESET_KEY = "codexHistoryViewer.searchPresets.v1";

// Stores search presets in Memento.
export class SearchPresetStore {
  private readonly memento: vscode.Memento;

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

  public async save(params: { queryInput: string; overwriteId?: string }): Promise<SearchPreset> {
    const queryInput = normalizeQueryInput(params.queryInput);
    if (!queryInput) throw new Error("preset query is empty");

    const now = Date.now();
    const list = this.getAll();
    const existing = params.overwriteId
      ? list.find((p) => p.id === params.overwriteId)
      : list.find((p) => p.queryInput === queryInput);
    const next: SearchPreset = existing
      ? { ...existing, queryInput, updatedAt: now }
      : { id: makePresetId(), queryInput, createdAt: now, updatedAt: now };

    const kept = list.filter((p) => p.id !== next.id);
    kept.push(next);
    await this.memento.update(PRESET_KEY, kept);
    return next;
  }

  public async delete(id: string): Promise<boolean> {
    const list = this.getAll();
    const next = list.filter((p) => p.id !== id);
    if (next.length === list.length) return false;
    await this.memento.update(PRESET_KEY, next);
    return true;
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
  return {
    id: v.id.trim(),
    queryInput,
    createdAt,
    updatedAt,
  };
}

function normalizeQueryInput(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function dedupePresets(presets: readonly SearchPreset[]): SearchPreset[] {
  const seen = new Set<string>();
  const out: SearchPreset[] = [];
  for (const preset of presets.slice().sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (seen.has(preset.queryInput)) continue;
    seen.add(preset.queryInput);
    out.push(preset);
  }
  return out;
}

function makePresetId(): string {
  const r = Math.random().toString(36).slice(2, 8);
  return `${Date.now().toString(36)}-${r}`;
}
