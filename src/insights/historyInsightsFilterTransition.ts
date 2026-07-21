import type { ArchiveLocationFilter } from "../sessions/sessionTypes";
import { historyInsightsDateRangeToDateScope } from "./historyInsightsDateRange";
import type { HistoryInsightsCondition, HistoryInsightsFilterApplication } from "./historyInsightsTypes";

export interface HistoryInsightsFilterTransition {
  condition: HistoryInsightsCondition;
  historyState: HistoryInsightsCondition | null;
}

export function buildHistoryInsightsFilterTransition(
  application: HistoryInsightsFilterApplication,
  effectiveArchiveLocation: ArchiveLocationFilter,
): HistoryInsightsFilterTransition {
  const condition: HistoryInsightsCondition = {
    date: historyInsightsDateRangeToDateScope(application.dateRange),
    projects: application.projects,
    source: application.source,
    tags: application.tags.slice(0, 12),
    archiveLocation: effectiveArchiveLocation,
  };
  return {
    condition,
    historyState: application.applyToHistory ? condition : null,
  };
}

export function validateHistoryInsightsArchiveLocation(
  application: Pick<HistoryInsightsFilterApplication, "source" | "archiveLocation">,
  archivedSessionsEnabled: boolean,
): ArchiveLocationFilter | null {
  if (application.source === "claude") {
    return application.archiveLocation === "all" ? "all" : null;
  }
  if (!archivedSessionsEnabled) {
    return application.archiveLocation === "activeOnly" ? "activeOnly" : null;
  }
  return application.archiveLocation;
}
