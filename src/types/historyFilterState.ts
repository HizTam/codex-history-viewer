import type { ArchiveLocationFilter, SessionSourceFilter } from "../sessions/sessionTypes";
import { parseDateScopeStrict, type DateScope } from "./dateScope";
import { parseProjectSelection, type ProjectSelection } from "./projectSelection";

export const HISTORY_FILTER_STATE_V2_KEY = "codexHistoryViewer.historyFilterState.v2";
export const HISTORY_FILTER_STATE_V3_KEY = "codexHistoryViewer.historyFilterState.v3";

export type SessionDisplayTarget =
  | "activeVisible"
  | "visibleAllLocations"
  | "archivedVisible"
  | "hiddenAllLocations"
  | "all";

export type HistoryDisplayTarget = SessionDisplayTarget;

export interface HistoryFilterStateV2 {
  version: 2;
  date: DateScope;
  projects: ProjectSelection;
  source: SessionSourceFilter;
  tags: string[];
  archiveLocation: ArchiveLocationFilter;
}

export interface HistoryFilterStateV3 {
  version: 3;
  date: DateScope;
  projects: ProjectSelection;
  source: SessionSourceFilter;
  tags: string[];
  displayTarget: HistoryDisplayTarget;
}

export function parseHistoryFilterStateV2(value: unknown): HistoryFilterStateV2 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 2) return null;
  const date = parseDateScopeStrict(raw.date);
  const projects = parseProjectSelection(raw.projects);
  const tags = parseTagsStrict(raw.tags);
  if (!date || !projects || !tags) return null;
  if (raw.source !== "all" && raw.source !== "codex" && raw.source !== "claude") return null;
  if (raw.archiveLocation !== "activeOnly" && raw.archiveLocation !== "all" && raw.archiveLocation !== "archivedOnly") {
    return null;
  }
  if (raw.source === "claude" && raw.archiveLocation !== "all") return null;
  return {
    version: 2,
    date,
    projects,
    source: raw.source,
    tags,
    archiveLocation: raw.archiveLocation,
  };
}

export function createHistoryFilterStateV2(input: Omit<HistoryFilterStateV2, "version">): HistoryFilterStateV2 {
  return {
    version: 2,
    date: input.date,
    projects: input.projects,
    source: input.source,
    tags: input.tags.slice(0, 12),
    archiveLocation: input.archiveLocation,
  };
}

export function parseHistoryFilterStateV3(value: unknown): HistoryFilterStateV3 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 3) return null;
  const date = parseDateScopeStrict(raw.date);
  const projects = parseProjectSelection(raw.projects);
  const tags = parseTagsStrict(raw.tags);
  if (!date || !projects || !tags) return null;
  if (raw.source !== "all" && raw.source !== "codex" && raw.source !== "claude") return null;
  if (!isHistoryDisplayTarget(raw.displayTarget)) return null;
  return {
    version: 3,
    date,
    projects,
    source: raw.source,
    tags,
    displayTarget: raw.displayTarget,
  };
}

export function createHistoryFilterStateV3(input: Omit<HistoryFilterStateV3, "version">): HistoryFilterStateV3 {
  return {
    version: 3,
    date: input.date,
    projects: input.projects,
    source: input.source,
    tags: input.tags.slice(0, 12),
    displayTarget: input.displayTarget,
  };
}

export function historyDisplayTargetFromArchiveLocation(value: ArchiveLocationFilter): HistoryDisplayTarget {
  if (value === "archivedOnly") return "archivedVisible";
  if (value === "all") return "visibleAllLocations";
  return "activeVisible";
}

export function migrateHistoryDisplayTargetPreferenceFromV2(
  state: Pick<HistoryFilterStateV2, "source" | "archiveLocation">,
  legacyArchivePreference: ArchiveLocationFilter,
): HistoryDisplayTarget {
  // V2 stored Claude's effective location as all while preserving the Codex preference separately.
  return historyDisplayTargetFromArchiveLocation(
    state.source === "claude" ? legacyArchivePreference : state.archiveLocation,
  );
}

export function archiveLocationFromHistoryDisplayTarget(value: HistoryDisplayTarget): ArchiveLocationFilter {
  if (value === "activeVisible") return "activeOnly";
  if (value === "archivedVisible") return "archivedOnly";
  return "all";
}

export function historyDisplayTargetIncludesHidden(value: HistoryDisplayTarget): boolean {
  return value === "hiddenAllLocations" || value === "all";
}

export function historyDisplayTargetIncludesVisible(value: HistoryDisplayTarget): boolean {
  return value !== "hiddenAllLocations";
}

export function matchesSessionDisplayTarget(
  value: SessionDisplayTarget,
  archived: boolean,
  hidden: boolean,
): boolean {
  if (hidden ? !historyDisplayTargetIncludesHidden(value) : !historyDisplayTargetIncludesVisible(value)) {
    return false;
  }
  const location = archiveLocationFromHistoryDisplayTarget(value);
  if (location === "archivedOnly") return archived;
  if (location === "activeOnly") return !archived;
  return true;
}

export function isHistoryDisplayTarget(value: unknown): value is HistoryDisplayTarget {
  return value === "activeVisible" ||
    value === "visibleAllLocations" ||
    value === "archivedVisible" ||
    value === "hiddenAllLocations" ||
    value === "all";
}

export function resolveEffectiveHistoryDisplayTarget(
  preferred: HistoryDisplayTarget,
  source: SessionSourceFilter,
  archivedSessionsEnabled: boolean,
): HistoryDisplayTarget {
  if (source !== "claude" && archivedSessionsEnabled) return preferred;
  if (preferred === "hiddenAllLocations" || preferred === "all") return preferred;
  return "activeVisible";
}

function parseTagsStrict(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 12) return null;
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string") return null;
    const tag = candidate.trim();
    const key = tag.toLocaleLowerCase();
    if (!tag || tag.length > 256 || seen.has(key)) return null;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}
