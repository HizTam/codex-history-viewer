import type { ArchiveLocationFilter, SessionSource, SessionSourceFilter } from "../sessions/sessionTypes";
import type { HistorySortOrder, HistoryViewMode } from "../tree/historyTree";
import type { DateScope } from "../types/dateScope";
import type { ProjectSelection, ProjectSelectionGroup } from "../types/projectSelection";
import type { AnalysisAvailability } from "../analysis/sessionAnalysisTypes";
import type { FilePresentationKind } from "../utils/fileKind";
export interface HistoryInsightsCondition {
  date: DateScope;
  projects: ProjectSelection;
  source: SessionSourceFilter;
  tags: readonly string[];
  archiveLocation: ArchiveLocationFilter;
}

export interface HistoryInsightsSessionReference {
  cacheKey: string;
  identityKey: string;
  bucketLocalDate: string;
  source: SessionSource;
  projectKey: string;
  projectLabel: string;
}

export interface HistoryInsightsDateRange {
  from: string | null;
  to: string | null;
}

export interface HistoryInsightsFilterDescriptor {
  date: DateScope;
  dateRange: HistoryInsightsDateRange;
  source: SessionSourceFilter;
  projects: ProjectSelection;
  projectCwd?: string | null;
  projectScopeCwd?: string | null;
  tags: string[];
  archiveLocation: ArchiveLocationFilter;
  viewMode: HistoryViewMode;
  sortOrder: HistorySortOrder;
  projectGrouped: boolean;
  chips: string[];
}

export interface HistoryInsightsSnapshot {
  id: string;
  createdAtIso: string;
  generation: number;
  dateBasis: "started" | "lastActivity";
  dateTimeSettingsKey: string;
  references: HistoryInsightsSessionReference[];
  descriptor: HistoryInsightsFilterDescriptor;
}

export interface HistoryInsightsMetric {
  value?: number;
  availability: AnalysisAvailability;
  availableSessions: number;
  totalSessions: number;
}

export interface HistoryInsightsDayBucket {
  ymd: string;
  sessionCount: number;
  userRequestCount: HistoryInsightsMetric;
  inputTokenCount: HistoryInsightsMetric;
  outputTokenCount: HistoryInsightsMetric;
  reasoningOutputTokenCount: HistoryInsightsMetric;
  totalTokenCount: HistoryInsightsMetric;
  distinctFileCount: HistoryInsightsMetric;
  linesAdded: HistoryInsightsMetric;
  linesRemoved: HistoryInsightsMetric;
  changedLineCount: HistoryInsightsMetric;
}

export interface HistoryInsightsFileRow {
  id: string;
  displayPath: string;
  fileKind: FilePresentationKind;
  projectContexts: HistoryInsightsFileProjectContext[];
  projectContextCount: number;
  sessionCount: number;
  changeEventCount: number;
  linesAdded: number;
  linesRemoved: number;
  lastTimestampIso?: string;
  canOpenFileHistory: boolean;
  canOpenFile: boolean;
}

export interface HistoryInsightsFileProjectContext {
  displayName: string;
  pathHint: string;
  sessionCount: number;
  disambiguate: boolean;
}

export type HistoryInsightsEditableFilter =
  | "source"
  | "archiveLocation"
  | "projects"
  | "tags";

export interface HistoryInsightsFilterOption {
  id: string;
  label: string;
  selected: boolean;
  kind?: "all" | "group";
  description?: string;
  searchText?: string;
  memberCount?: number;
  current?: boolean;
  value?: string;
  section?: "current" | "related" | "projects";
}

export interface HistoryInsightsFilterOptions {
  source: HistoryInsightsFilterOption[];
  archiveLocation: HistoryInsightsFilterOption[];
  projects: HistoryInsightsFilterOption[];
  tags: HistoryInsightsFilterOption[];
}

export interface HistoryInsightsFilterPresentation {
  source: SessionSourceFilter;
  dateRange: HistoryInsightsDateRange;
  archiveLocation: ArchiveLocationFilter;
  projectsLabel: string;
  projectSelectionKind: ProjectSelection["kind"];
  tags: string[];
  canEditSource: boolean;
  canEditArchiveLocation: boolean;
  options: HistoryInsightsFilterOptions;
}

export type HistoryInsightsFilterSelection =
  | { filter: "source"; source: SessionSource }
  | { filter: "archiveLocation"; archiveLocation: Exclude<ArchiveLocationFilter, "all"> }
  | { filter: "projects"; projects: { kind: "all" } | { kind: "group"; group: ProjectSelectionGroup } }
  | { filter: "tags"; tags: string[] };

export interface HistoryInsightsFilterApplication {
  source: SessionSourceFilter;
  archiveLocation: ArchiveLocationFilter;
  projects: ProjectSelection;
  tags: string[];
  dateRange: HistoryInsightsDateRange;
  applyToHistory: boolean;
}

export interface HistoryInsightsFilterApplyPayload {
  snapshotId: string;
  sourceIds: string[];
  archiveLocationIds: string[];
  projectIds: string[];
  tagIds: string[];
  from: string | null;
  to: string | null;
  applyToHistory: boolean;
}

export type HistoryInsightsBreakdownMetric = "sessions" | "inputTokens" | "outputTokens" | "totalTokens";

export interface HistoryInsightsBreakdownMetricValues {
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface HistoryInsightsBreakdownRow {
  id: string;
  label: string;
  metrics: HistoryInsightsBreakdownMetricValues;
}

export interface HistoryInsightsBreakdownGroup<TRow extends HistoryInsightsBreakdownRow = HistoryInsightsBreakdownRow> {
  rows: TRow[];
  totals: HistoryInsightsBreakdownMetricValues;
  positiveRowCounts: HistoryInsightsBreakdownMetricValues;
}

export interface HistoryInsightsModelEffortRow {
  id: string;
  label: string;
  value: number;
}

export interface HistoryInsightsModelRow extends HistoryInsightsBreakdownRow {
  effortRows: HistoryInsightsModelEffortRow[];
  effortTotalTokens: number;
  omittedEffortCount: number;
}

export interface HistoryInsightsProjectRow extends HistoryInsightsBreakdownRow {
  canDrillDown: boolean;
}

export type HistoryInsightsToolMetric = "calls" | "sessions";

export interface HistoryInsightsToolRow {
  id: string;
  label: string;
  calls: number;
  sessions: number;
}

export interface HistoryInsightsToolGroup {
  rows: HistoryInsightsToolRow[];
  totals: Record<HistoryInsightsToolMetric, number>;
  positiveRowCounts: Record<HistoryInsightsToolMetric, number>;
}

export type HistoryInsightsActiveSessionMetric =
  | "userRequests"
  | "toolCalls"
  | "reasoningTokens"
  | "totalTokens"
  | "changedLines";

export interface HistoryInsightsActiveSessionMetricValue {
  value?: number;
  availability: AnalysisAvailability;
}

export interface HistoryInsightsActiveSessionRow {
  id: string;
  title: string;
  source: SessionSource;
  projectLabel: string;
  lastActivityAtIso?: string;
  metrics: Record<HistoryInsightsActiveSessionMetric, HistoryInsightsActiveSessionMetricValue>;
}

export type HistoryInsightsDetailMetricKey =
  | "cachedInputTokens"
  | "cacheReadInputTokens"
  | "cacheCreationInputTokens"
  | "reasoningOutputTokens"
  | "userMessages"
  | "assistantMessages"
  | "developerMessages"
  | "toolCalls"
  | "toolOutputs"
  | "turns"
  | "completedTurns"
  | "interruptedTurns"
  | "rolledBackTurns";

export interface HistoryInsightsDetailMetricRow {
  key: HistoryInsightsDetailMetricKey;
  metric: HistoryInsightsMetric;
}

export interface HistoryInsightsFileKindRow {
  kind: FilePresentationKind;
  distinctFileCount: number;
  changeEventCount: number;
}

export interface HistoryInsightsUsageDetails {
  inputCache: HistoryInsightsDetailMetricRow[];
  messages: HistoryInsightsDetailMetricRow[];
  turns: HistoryInsightsDetailMetricRow[];
  fileKinds: HistoryInsightsFileKindRow[];
}

export interface HistoryInsightsDataQuality {
  targetSessions: number;
  analyzedSessions: number;
  cacheHitCount: number;
  rebuiltCount: number;
  failedSessions: number;
  unsupportedSessions: number;
  partialSessions: number;
  tokenAvailableSessions: number;
  fileChangeAvailableSessions: number;
  modelAvailableSessions: number;
  toolAvailableSessions: number;
  numericOverflow: boolean;
}

export interface HistoryInsightsModel {
  version: 1;
  snapshotId: string;
  generatedAtIso: string;
  refreshing: boolean;
  stale: boolean;
  dateBasis: HistoryInsightsSnapshot["dateBasis"];
  dateTimeSettingsKey: string;
  chips: string[];
  metrics: {
    sessions: HistoryInsightsMetric;
    userRequests: HistoryInsightsMetric;
    inputTokens: HistoryInsightsMetric;
    outputTokens: HistoryInsightsMetric;
    totalTokens: HistoryInsightsMetric;
    distinctFiles: HistoryInsightsMetric;
    linesAdded: HistoryInsightsMetric;
    linesRemoved: HistoryInsightsMetric;
    changeEvents: HistoryInsightsMetric;
    reasoningOutputTokens: HistoryInsightsMetric;
  };
  days: HistoryInsightsDayBucket[];
  files: HistoryInsightsFileRow[];
  sources: HistoryInsightsBreakdownGroup;
  models: HistoryInsightsBreakdownGroup<HistoryInsightsModelRow>;
  projects: HistoryInsightsBreakdownGroup<HistoryInsightsProjectRow>;
  tools: HistoryInsightsToolGroup;
  activeSessions: HistoryInsightsActiveSessionRow[];
  usageDetails: HistoryInsightsUsageDetails;
  quality: HistoryInsightsDataQuality;
}
