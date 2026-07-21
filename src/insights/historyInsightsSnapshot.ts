import type { SessionSummary } from "../sessions/sessionTypes";
import { sanitizeDateScope } from "../types/dateScope";
import { isValidYyyyMmDd } from "../utils/dateUtils";
import { normalizeProjectKey } from "../utils/fsUtils";
import { parseProjectSelection, projectSelectionFromCwds } from "../types/projectSelection";
import { sanitizeHistoryInsightsDateRange } from "./historyInsightsDateRange";
import type { HistoryInsightsSnapshot } from "./historyInsightsTypes";

export interface ResolvedHistoryInsightsSnapshot {
  snapshot: HistoryInsightsSnapshot;
  sessions: SessionSummary[];
}

export function resolveHistoryInsightsSnapshot(
  snapshot: HistoryInsightsSnapshot,
  currentSessions: readonly SessionSummary[],
): ResolvedHistoryInsightsSnapshot {
  const byCacheKey = new Map(currentSessions.map((session) => [session.cacheKey, session]));
  const byIdentityKey = new Map(currentSessions.map((session) => [session.identityKey, session]));
  const sessions: SessionSummary[] = [];
  const seenSessionCacheKeys = new Set<string>();
  const seenReferenceCacheKeys = new Set<string>();
  const seenReferenceIdentityKeys = new Set<string>();
  let changed = false;
  const references: HistoryInsightsSnapshot["references"] = [];
  for (const reference of snapshot.references) {
    if (
      seenReferenceCacheKeys.has(reference.cacheKey) ||
      seenReferenceIdentityKeys.has(reference.identityKey)
    ) {
      changed = true;
      continue;
    }
    seenReferenceCacheKeys.add(reference.cacheKey);
    seenReferenceIdentityKeys.add(reference.identityKey);
    const cacheMatch = byCacheKey.get(reference.cacheKey);
    const session = cacheMatch?.identityKey === reference.identityKey
      ? cacheMatch
      : byIdentityKey.get(reference.identityKey);
    if (!session) {
      references.push(reference);
      continue;
    }
    if (!seenSessionCacheKeys.has(session.cacheKey)) {
      seenSessionCacheKeys.add(session.cacheKey);
      sessions.push(session);
    }
    if (session.cacheKey === reference.cacheKey && session.localDate === reference.bucketLocalDate) {
      references.push(reference);
      continue;
    }
    changed = true;
    references.push({
      ...reference,
      cacheKey: session.cacheKey,
      bucketLocalDate: session.localDate,
    });
  }
  if (snapshot.references.length > 0 && sessions.length === 0) {
    return {
      snapshot: { ...snapshot, references: [] },
      sessions,
    };
  }
  return {
    snapshot: changed ? { ...snapshot, references } : snapshot,
    sessions,
  };
}

export function sanitizeHistoryInsightsSnapshot(value: unknown): HistoryInsightsSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = boundedString(raw.id, 128);
  const createdAtIso = boundedString(raw.createdAtIso, 128);
  const dateTimeSettingsKey = boundedString(raw.dateTimeSettingsKey, 1024);
  if (!/^[a-z0-9-]{1,128}$/u.test(id) || !createdAtIso || !dateTimeSettingsKey) return null;
  if (!Number.isSafeInteger(raw.generation) || Number(raw.generation) < 0) return null;
  if (raw.dateBasis !== "started" && raw.dateBasis !== "lastActivity") return null;
  if (!Array.isArray(raw.references) || raw.references.length > 200_000) return null;
  const references: HistoryInsightsSnapshot["references"] = [];
  const seenCacheKeys = new Set<string>();
  const seenIdentityKeys = new Set<string>();
  for (const value of raw.references) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const reference = value as Record<string, unknown>;
    const cacheKey = boundedString(reference.cacheKey, 32_768);
    const identityKey = boundedString(reference.identityKey, 32_768);
    const bucketLocalDate = boundedString(reference.bucketLocalDate, 10);
    const projectKey = boundedString(reference.projectKey, 32_768);
    const projectLabel = boundedString(reference.projectLabel, 512);
    if (!cacheKey || !identityKey || !isValidYyyyMmDd(bucketLocalDate)) return null;
    if (reference.source !== "codex" && reference.source !== "claude") return null;
    if (seenCacheKeys.has(cacheKey) || seenIdentityKeys.has(identityKey)) return null;
    seenCacheKeys.add(cacheKey);
    seenIdentityKeys.add(identityKey);
    references.push({ cacheKey, identityKey, bucketLocalDate, source: reference.source, projectKey, projectLabel });
  }
  if (!raw.descriptor || typeof raw.descriptor !== "object" || Array.isArray(raw.descriptor)) return null;
  const descriptor = raw.descriptor as Record<string, unknown>;
  const date = sanitizeDateScope(descriptor.date);
  if (!matchesSanitizedDateScope(descriptor.date, date)) return null;
  const dateRange = sanitizeHistoryInsightsDateRange(descriptor.dateRange);
  if (!dateRange) return null;
  const source = descriptor.source;
  const archiveLocation = descriptor.archiveLocation;
  const viewMode = descriptor.viewMode;
  const sortOrder = descriptor.sortOrder;
  if (source !== "all" && source !== "codex" && source !== "claude") return null;
  if (archiveLocation !== "activeOnly" && archiveLocation !== "all" && archiveLocation !== "archivedOnly") return null;
  if (viewMode !== "date" && viewMode !== "latest") return null;
  if (!["createdDesc", "createdAsc", "lastActivityDesc", "lastActivityAsc", "titleAsc", "titleDesc"].includes(String(sortOrder))) return null;
  if (typeof descriptor.projectGrouped !== "boolean") return null;
  const projectCwd = nullableBoundedString(descriptor.projectCwd, 32_768);
  const projectScopeCwd = nullableBoundedString(descriptor.projectScopeCwd, 32_768);
  if ((descriptor.projectCwd !== undefined && projectCwd === undefined) ||
      (descriptor.projectScopeCwd !== undefined && projectScopeCwd === undefined)) return null;
  const projects = descriptor.projects === undefined
    ? projectSelectionFromCwds(projectCwd ?? null, projectScopeCwd ?? null, (cwd) => normalizeProjectKey(cwd))
    : parseProjectSelection(descriptor.projects);
  if (!projects) return null;
  if (!Array.isArray(descriptor.tags) || descriptor.tags.length > 12 || !descriptor.tags.every((tag) => typeof tag === "string" && tag.length <= 256)) return null;
  if (!Array.isArray(descriptor.chips) || descriptor.chips.length > 20 || !descriptor.chips.every((chip) => typeof chip === "string" && chip.length <= 512)) return null;
  return {
    id,
    createdAtIso,
    generation: Number(raw.generation),
    dateBasis: raw.dateBasis,
    dateTimeSettingsKey,
    references,
    descriptor: {
      date,
      dateRange,
      source,
      projects,
      tags: descriptor.tags.slice(),
      archiveLocation,
      viewMode,
      sortOrder: sortOrder as HistoryInsightsSnapshot["descriptor"]["sortOrder"],
      projectGrouped: descriptor.projectGrouped,
      chips: descriptor.chips.slice(),
    },
  };
}

function boundedString(value: unknown, maxLength: number): string {
  return typeof value === "string" && value.length <= maxLength ? value : "";
}

function nullableBoundedString(value: unknown, maxLength: number): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && value.length <= maxLength ? value : undefined;
}

function matchesSanitizedDateScope(value: unknown, sanitized: HistoryInsightsSnapshot["descriptor"]["date"]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (raw.kind !== sanitized.kind) return false;
  if (sanitized.kind === "year") return raw.yyyy === sanitized.yyyy;
  if (sanitized.kind === "month") return raw.ym === sanitized.ym;
  if (sanitized.kind === "day") return raw.ymd === sanitized.ymd;
  if (sanitized.kind === "range") return raw.from === sanitized.from && raw.to === sanitized.to;
  return true;
}
