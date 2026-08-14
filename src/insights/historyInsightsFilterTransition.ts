import { historyInsightsDateRangeToDateScope } from "./historyInsightsDateRange";
import type { HistoryInsightsCondition, HistoryInsightsFilterApplication } from "./historyInsightsTypes";
import {
  archiveLocationFromHistoryDisplayTarget,
  resolveEffectiveHistoryDisplayTarget,
  type HistoryDisplayTarget,
} from "../types/historyFilterState";

export interface HistoryInsightsFilterTransition {
  condition: HistoryInsightsCondition;
  historyState: HistoryInsightsCondition | null;
}

export function buildHistoryInsightsFilterTransition(
  application: HistoryInsightsFilterApplication,
  effectiveDisplayTarget: HistoryDisplayTarget,
): HistoryInsightsFilterTransition {
  const condition: HistoryInsightsCondition = {
    date: historyInsightsDateRangeToDateScope(application.dateRange),
    projects: application.projects,
    source: application.source,
    tags: application.tags.slice(0, 12),
    archiveLocation: archiveLocationFromHistoryDisplayTarget(effectiveDisplayTarget),
    displayTarget: effectiveDisplayTarget,
  };
  return {
    condition,
    historyState: application.applyToHistory ? condition : null,
  };
}

export function resolveHistoryInsightsDisplayTarget(
  application: Pick<HistoryInsightsFilterApplication, "source" | "displayTarget">,
  archivedSessionsEnabled: boolean,
): HistoryDisplayTarget | null {
  const requiresArchive = application.displayTarget === "visibleAllLocations" || application.displayTarget === "archivedVisible";
  if (requiresArchive && (application.source === "claude" || !archivedSessionsEnabled)) return null;
  return resolveEffectiveHistoryDisplayTarget(application.displayTarget, application.source, archivedSessionsEnabled);
}
