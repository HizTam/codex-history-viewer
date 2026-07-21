import type { ArchiveLocationFilter, SessionSourceFilter } from "../sessions/sessionTypes";
import { parseDateScopeStrict, type DateScope } from "./dateScope";
import { parseProjectSelection, type ProjectSelection } from "./projectSelection";

export const HISTORY_FILTER_STATE_V2_KEY = "codexHistoryViewer.historyFilterState.v2";

export interface HistoryFilterStateV2 {
  version: 2;
  date: DateScope;
  projects: ProjectSelection;
  source: SessionSourceFilter;
  tags: string[];
  archiveLocation: ArchiveLocationFilter;
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
