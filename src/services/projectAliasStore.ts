import * as vscode from "vscode";
import { normalizeProjectKey } from "../utils/fsUtils";

export interface ProjectAlias {
  key: string;
  alias: string;
  cwd: string;
  updatedAt: number;
}

const PROJECT_ALIASES_KEY = "codexHistoryViewer.projectAliases.v1";
const MAX_PROJECT_ALIAS_LENGTH = 120;
const NO_CWD_PROJECT_KEY = "__no_cwd__";

// Stores extension-local project aliases without changing source history files.
export class ProjectAliasStore {
  private readonly memento: vscode.Memento;

  constructor(memento: vscode.Memento) {
    this.memento = memento;
  }

  public getByCwd(cwd: string | null | undefined): ProjectAlias | null {
    const key = resolveProjectAliasKey(cwd);
    if (!key) return null;
    return this.getAllByKey().get(key) ?? null;
  }

  public getAliasByCwd(cwd: string | null | undefined): string | undefined {
    return this.getByCwd(cwd)?.alias;
  }

  public async set(cwd: string, alias: string): Promise<void> {
    const key = resolveProjectAliasKey(cwd);
    if (!key) return;
    const normalized = normalizeProjectAlias(alias);
    if (!normalized) {
      await this.clearByCwd(cwd);
      return;
    }

    const entries = this.getAllByKey();
    entries.set(key, {
      key,
      alias: normalized,
      cwd: cwd.trim(),
      updatedAt: Date.now(),
    });
    await this.save(entries);
  }

  public async clearByCwd(cwd: string | null | undefined): Promise<boolean> {
    const key = resolveProjectAliasKey(cwd);
    if (!key) return false;
    const entries = this.getAllByKey();
    const changed = entries.delete(key);
    if (changed) await this.save(entries);
    return changed;
  }

  private getAllByKey(): Map<string, ProjectAlias> {
    const raw = this.memento.get<unknown>(PROJECT_ALIASES_KEY);
    if (!raw || typeof raw !== "object") return new Map();

    const out = new Map<string, ProjectAlias>();
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const entry = sanitizeEntry(key, value);
      if (entry) out.set(entry.key, entry);
    }
    return out;
  }

  private async save(entries: ReadonlyMap<string, ProjectAlias>): Promise<void> {
    const payload: Record<string, ProjectAlias> = {};
    for (const [key, entry] of entries.entries()) {
      payload[key] = entry;
    }
    await this.memento.update(PROJECT_ALIASES_KEY, payload);
  }
}

export function normalizeProjectAlias(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isProjectAliasTooLong(value: string): boolean {
  return Array.from(value).length > MAX_PROJECT_ALIAS_LENGTH;
}

export function getMaxProjectAliasLength(): number {
  return MAX_PROJECT_ALIAS_LENGTH;
}

export function resolveProjectAliasKey(cwd: unknown): string | null {
  const raw = typeof cwd === "string" ? cwd.trim() : "";
  if (!raw) return null;
  if (raw === NO_CWD_PROJECT_KEY) return null;
  const key = normalizeProjectKey(raw);
  if (!key || key === NO_CWD_PROJECT_KEY) return null;
  return key;
}

function sanitizeEntry(key: string, value: unknown): ProjectAlias | null {
  const normalizedKey = resolveProjectAliasKey(key);
  if (!normalizedKey) return null;
  if (!value || typeof value !== "object") return null;

  const alias = normalizeProjectAlias((value as any).alias);
  const cwd = typeof (value as any).cwd === "string" ? (value as any).cwd.trim() : "";
  const updatedAt = (value as any).updatedAt;
  if (!alias || isProjectAliasTooLong(alias)) return null;
  if (!cwd || resolveProjectAliasKey(cwd) !== normalizedKey) return null;
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return null;

  return {
    key: normalizedKey,
    alias,
    cwd,
    updatedAt,
  };
}
