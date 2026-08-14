import * as vscode from "vscode";
import type { SessionSummary } from "../sessions/sessionTypes";
import { normalizeCacheKey } from "../utils/fsUtils";
import type { SessionMetadataMutationCoordinator } from "./sessionMetadataMutationCoordinator";

export interface SessionTitleOverride {
  key: string;
  title: string;
  updatedAt: number;
}

export const TITLE_OVERRIDE_KEY = "codexHistoryViewer.sessionTitleOverrides.v1";
const MAX_CUSTOM_TITLE_LENGTH = 120;

// Stores extension-local title overrides without changing source history files.
export class SessionTitleOverrideStore {
  private readonly memento: vscode.Memento;

  constructor(memento: vscode.Memento, private readonly coordinator?: SessionMetadataMutationCoordinator) {
    this.memento = memento;
  }

  public get(session: SessionSummary): SessionTitleOverride | null {
    const key = resolveTitleOverrideKey(session);
    if (!key) return null;
    return this.getAllByKey().get(key) ?? null;
  }

  public getTitle(session: SessionSummary): string | undefined {
    return this.get(session)?.title;
  }

  public has(session: SessionSummary): boolean {
    return this.get(session) !== null;
  }

  public getAll(): SessionTitleOverride[] {
    return Array.from(this.getAllByKey().values());
  }

  public async replaceAll(
    values: readonly SessionTitleOverride[],
    options?: { skipCoordinator?: boolean },
  ): Promise<void> {
    if (this.coordinator && options?.skipCoordinator !== true) {
      await this.coordinator.runExclusive(() => this.replaceAll(values, { skipCoordinator: true }));
      return;
    }
    const entries = new Map<string, SessionTitleOverride>();
    for (const value of values) {
      const entry = sanitizeEntry(value.key, value);
      if (entry) entries.set(entry.key, entry);
    }
    await this.save(entries);
  }

  public async set(session: SessionSummary, title: string): Promise<void> {
    await this.runMutation(() => this.setUncoordinated(session, title));
  }

  private async setUncoordinated(session: SessionSummary, title: string): Promise<void> {
    const key = resolveTitleOverrideKey(session);
    if (!key) return;
    const normalized = normalizeCustomTitle(title);
    if (!normalized) {
      await this.clear(session);
      return;
    }

    const entries = this.getAllByKey();
    entries.set(key, {
      key,
      title: normalized,
      updatedAt: Date.now(),
    });
    await this.save(entries);
  }

  public async clear(session: SessionSummary): Promise<boolean> {
    return this.runMutation(() => this.clearUncoordinated(session));
  }

  private async clearUncoordinated(session: SessionSummary): Promise<boolean> {
    const key = resolveTitleOverrideKey(session);
    if (!key) return false;
    const entries = this.getAllByKey();
    const changed = entries.delete(key);
    if (changed) await this.save(entries);
    return changed;
  }

  private getAllByKey(): Map<string, SessionTitleOverride> {
    const raw = this.memento.get<unknown>(TITLE_OVERRIDE_KEY);
    if (!raw || typeof raw !== "object") return new Map();

    const out = new Map<string, SessionTitleOverride>();
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const entry = sanitizeEntry(key, value);
      if (entry) out.set(entry.key, entry);
    }
    return out;
  }

  private async save(entries: ReadonlyMap<string, SessionTitleOverride>): Promise<void> {
    const payload: Record<string, SessionTitleOverride> = {};
    for (const [key, entry] of entries.entries()) {
      payload[key] = entry;
    }
    await this.memento.update(TITLE_OVERRIDE_KEY, payload);
  }

  private runMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.coordinator ? this.coordinator.runExclusive(operation) : operation();
  }
}

export function normalizeCustomTitle(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isCustomTitleTooLong(value: string): boolean {
  return Array.from(value).length > MAX_CUSTOM_TITLE_LENGTH;
}

export function getMaxCustomTitleLength(): number {
  return MAX_CUSTOM_TITLE_LENGTH;
}

export function resolveTitleOverrideKey(session: SessionSummary): string | null {
  const source = session.source === "claude" ? "claude" : "codex";
  const sessionId = normalizeSessionId(session.meta?.id);
  if (sessionId) return `${source}:id:${sessionId}`;

  const fsPath = typeof session.fsPath === "string" ? session.fsPath.trim() : "";
  if (!fsPath) return null;
  return `${source}:path:${normalizeCacheKey(fsPath)}`;
}

function normalizeSessionId(value: unknown): string {
  const id = String(value ?? "").trim();
  return /[\u0000-\u001F\u007F]/.test(id) ? "" : id;
}

function sanitizeEntry(key: string, value: unknown): SessionTitleOverride | null {
  const normalizedKey = typeof key === "string" ? key.trim() : "";
  if (!normalizedKey) return null;
  if (!value || typeof value !== "object") return null;

  const title = normalizeCustomTitle((value as any).title);
  const updatedAt = (value as any).updatedAt;
  if (!title || isCustomTitleTooLong(title)) return null;
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return null;

  return {
    key: normalizedKey,
    title,
    updatedAt,
  };
}
