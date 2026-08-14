import type {
  HistoryInsightsEditableFilter,
  HistoryInsightsFilterApplication,
  HistoryInsightsFilterApplyPayload,
  HistoryInsightsFilterSelection,
} from "./historyInsightsTypes";
import { sanitizeHistoryInsightsDateRange } from "./historyInsightsDateRange";
import { MAX_PROJECT_SELECTION_GROUPS, type ProjectSelection } from "../types/projectSelection";
import type { SessionSourceFilter } from "../sessions/sessionTypes";
import type { HistoryDisplayTarget } from "../types/historyFilterState";

export type HistoryInsightsFilterApplicationResult =
  | { ok: true; value: HistoryInsightsFilterApplication }
  | { ok: false; reason: "invalid" | "stale" };

export function resolveHistoryInsightsFilterApplication(
  value: unknown,
  expectedSnapshotId: string,
  selections: ReadonlyMap<string, HistoryInsightsFilterSelection>,
): HistoryInsightsFilterApplicationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "invalid" };
  const raw = value as Partial<HistoryInsightsFilterApplyPayload>;
  if (typeof raw.snapshotId !== "string" || raw.snapshotId !== expectedSnapshotId) return { ok: false, reason: "stale" };
  const source = resolveSourceSelections(raw.sourceIds, selections);
  const displayTarget = resolveDisplayTargetSelection(raw.archiveLocationIds, selections);
  const projects = resolveProjectSelections(raw.projectIds, selections);
  const tags = resolveHistoryInsightsFilterSelection("tags", raw.tagIds, selections);
  const dateRange = sanitizeHistoryInsightsDateRange({ from: raw.from ?? null, to: raw.to ?? null });
  if (
    typeof raw.applyToHistory !== "boolean" ||
    !source ||
    !displayTarget ||
    !projects ||
    !tags || tags.filter !== "tags" ||
    !dateRange
  ) {
    return { ok: false, reason: "invalid" };
  }
  return {
    ok: true,
    value: {
      source,
      displayTarget,
      projects,
      tags: tags.tags,
      dateRange,
      applyToHistory: raw.applyToHistory,
    },
  };
}

export function resolveHistoryInsightsFilterSelection(
  filter: HistoryInsightsEditableFilter,
  value: unknown,
  selections: ReadonlyMap<string, HistoryInsightsFilterSelection>,
): HistoryInsightsFilterSelection | null {
  if (!Array.isArray(value)) return null;
  const maximum = filter === "tags" ? 12 : 1;
  if (value.length > maximum || (filter !== "tags" && value.length !== 1)) return null;
  const ids = value.map((candidate) => typeof candidate === "string" ? candidate.trim() : "");
  if (ids.some((id) => !/^[a-f0-9]{24}$/u.test(id)) || new Set(ids).size !== ids.length) return null;
  const resolved = ids.map((id) => selections.get(buildHistoryInsightsFilterOptionMapKey(filter, id)));
  if (resolved.some((selection) => !selection || selection.filter !== filter)) return null;
  if (filter === "tags") {
    const tags = resolved.flatMap((selection) => selection?.filter === "tags" ? selection.tags : []);
    return { filter: "tags", tags };
  }
  return resolved[0] ?? null;
}

export function buildHistoryInsightsFilterOptionMapKey(filter: HistoryInsightsEditableFilter, id: string): string {
  return `${filter}:${id}`;
}

function resolveSourceSelections(
  value: unknown,
  selections: ReadonlyMap<string, HistoryInsightsFilterSelection>,
): SessionSourceFilter | null {
  const resolved = resolveFiniteSelections("source", value, selections);
  if (!resolved) return null;
  const sources = resolved.flatMap((selection) => selection.filter === "source" ? [selection.source] : []);
  if (sources.length !== resolved.length) return null;
  const sourceSet = new Set(sources);
  if (sourceSet.size !== sources.length) return null;
  if (sourceSet.size === 2 && sourceSet.has("codex") && sourceSet.has("claude")) return "all";
  return sources.length === 1 ? sources[0]! : null;
}

function resolveDisplayTargetSelection(
  value: unknown,
  selections: ReadonlyMap<string, HistoryInsightsFilterSelection>,
): HistoryDisplayTarget | null {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const resolved = resolveFiniteSelections("archiveLocation", value, selections);
  if (!resolved || resolved.length !== 1) return null;
  const selection = resolved[0];
  return selection?.filter === "archiveLocation" ? selection.displayTarget : null;
}

function resolveFiniteSelections(
  filter: "source" | "archiveLocation",
  value: unknown,
  selections: ReadonlyMap<string, HistoryInsightsFilterSelection>,
): HistoryInsightsFilterSelection[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) return null;
  const ids = value.map((candidate) => typeof candidate === "string" ? candidate.trim() : "");
  if (ids.some((id) => !/^[a-f0-9]{24}$/u.test(id)) || new Set(ids).size !== ids.length) return null;
  const resolved = ids.map((id) => selections.get(buildHistoryInsightsFilterOptionMapKey(filter, id)));
  if (resolved.some((selection) => !selection || selection.filter !== filter)) return null;
  return resolved as HistoryInsightsFilterSelection[];
}

function resolveProjectSelections(
  value: unknown,
  selections: ReadonlyMap<string, HistoryInsightsFilterSelection>,
): ProjectSelection | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PROJECT_SELECTION_GROUPS) return null;
  const ids = value.map((candidate) => typeof candidate === "string" ? candidate.trim() : "");
  if (ids.some((id) => !/^[a-f0-9]{24}$/u.test(id)) || new Set(ids).size !== ids.length) return null;
  const resolved = ids.map((id) => selections.get(buildHistoryInsightsFilterOptionMapKey("projects", id)));
  if (resolved.some((selection) => !selection || selection.filter !== "projects")) return null;
  const projectSelections = resolved as Array<Extract<HistoryInsightsFilterSelection, { filter: "projects" }>>;
  const all = projectSelections.filter((selection) => selection.projects.kind === "all");
  if (all.length > 0) return projectSelections.length === 1 ? { kind: "all" } : null;
  const groups = projectSelections.flatMap((selection) => selection.projects.kind === "group" ? [selection.projects.group] : []);
  if (groups.length !== projectSelections.length) return null;
  const keys = new Set(groups.map((group) => group.canonicalGroupKey));
  return keys.size === groups.length ? { kind: "groups", groups } : null;
}
