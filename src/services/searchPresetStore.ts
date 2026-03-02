import * as vscode from "vscode";
import type { SearchRequest } from "./searchService";
import type { IndexedSearchRole } from "./searchIndexService";

export interface SearchPreset {
  id: string;
  name: string;
  request: SearchRequest;
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
    return raw
      .map((item) => sanitizePreset(item))
      .filter((p): p is SearchPreset => p !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  public async save(params: { name: string; request: SearchRequest; overwriteId?: string }): Promise<SearchPreset> {
    const name = String(params.name ?? "").trim();
    if (!name) throw new Error("preset name is empty");

    const now = Date.now();
    const list = this.getAll();
    const request = sanitizeRequest(params.request);
    const existing = params.overwriteId ? list.find((p) => p.id === params.overwriteId) : undefined;
    const next: SearchPreset = existing
      ? { ...existing, name, request, updatedAt: now }
      : { id: makePresetId(), name, request, createdAt: now, updatedAt: now };

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
  if (typeof v.name !== "string" || v.name.trim().length === 0) return null;
  if (typeof v.createdAt !== "number" || !Number.isFinite(v.createdAt)) return null;
  if (typeof v.updatedAt !== "number" || !Number.isFinite(v.updatedAt)) return null;
  const request = sanitizeRequest(v.request);
  if (!request.queryInput) return null;
  return {
    id: v.id.trim(),
    name: v.name.trim(),
    request,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}

function sanitizeRequest(request: SearchRequest): SearchRequest {
  const queryInput = typeof request?.queryInput === "string" ? request.queryInput.trim() : "";
  const validRoles = new Set<IndexedSearchRole>(["user", "assistant", "developer", "tool"]);
  const picked = Array.isArray(request?.roleFilter) ? request.roleFilter.filter((r) => validRoles.has(r)) : [];
  const roleFilter: IndexedSearchRole[] = picked.length > 0 ? Array.from(new Set(picked)) : ["user", "assistant"];
  return { queryInput, roleFilter };
}

function makePresetId(): string {
  const r = Math.random().toString(36).slice(2, 8);
  return `${Date.now().toString(36)}-${r}`;
}
