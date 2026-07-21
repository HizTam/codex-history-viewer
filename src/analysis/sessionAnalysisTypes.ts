import type { SessionSource, SessionStorageLocation } from "../sessions/sessionTypes";

export type AnalysisAvailability = "available" | "partial" | "unavailable";
export type AnalysisCompleteness = "complete" | "partial" | "unsupported" | "failed";

export interface AnalysisNumber {
  value?: number;
  availability: AnalysisAvailability;
}

export interface SessionMessageStats {
  userMessageCount: AnalysisNumber;
  assistantMessageCount: AnalysisNumber;
  developerMessageCount: AnalysisNumber;
  toolCallCount: AnalysisNumber;
  toolOutputCount: AnalysisNumber;
  turnCount: AnalysisNumber;
  completedTurnCount: AnalysisNumber;
  interruptedTurnCount: AnalysisNumber;
  rolledBackTurnCount: AnalysisNumber;
  toolUsage: ToolUsageStats[];
}

export interface ToolUsageStats {
  name: string;
  callCount: number;
}

export type UsageAggregationMethod =
  | "codexLastUsageSum"
  | "codexCumulativeFallback"
  | "claudeMessageSum"
  | "mixedPartial"
  | "unavailable";

export interface ModelUsageStats {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ModelEffortUsageStats {
  model: string;
  effort: string;
  totalTokens: number;
}

export interface SessionUsageStats {
  inputTokens: AnalysisNumber;
  outputTokens: AnalysisNumber;
  cachedInputTokens: AnalysisNumber;
  cacheReadInputTokens: AnalysisNumber;
  cacheCreationInputTokens: AnalysisNumber;
  reasoningOutputTokens: AnalysisNumber;
  reportedTotalTokens: AnalysisNumber;
  derivedTotalTokens: AnalysisNumber;
  modelUsage: ModelUsageStats[];
  modelEffortUsage: ModelEffortUsageStats[];
  aggregationMethod: UsageAggregationMethod;
}

export interface SessionFileChangeEntry {
  normalizedPath: string;
  displayPath: string;
  changeEventCount: number;
  linesAdded: number;
  linesRemoved: number;
  firstTimestampIso?: string;
  lastTimestampIso?: string;
  chatMessageIndex?: number;
}

export interface SessionFileChangeStats {
  changeEventCount: AnalysisNumber;
  distinctFileCount: AnalysisNumber;
  linesAdded: AnalysisNumber;
  linesRemoved: AnalysisNumber;
  files: SessionFileChangeEntry[];
}

export interface RateLimitValue {
  usedPercent?: number;
  windowMinutes?: number;
  resetsAt?: number;
  resetsInSeconds?: number;
}

export interface RateLimitSnapshot {
  observedAtIso?: string;
  sourceSessionCacheKey: string;
  primary?: RateLimitValue;
  secondary?: RateLimitValue;
  planType?: string;
  limitName?: string;
  recordedBy: "localSession";
}

export type ClaudeSidechainState = true | false | "unknown";

export interface ClaudeVisibleMessageAnchor {
  role: "user" | "assistant";
  chatMessageIndex: number;
  timestampIso?: string;
  preview?: string;
}

export interface ClaudeMessageBounds {
  first?: ClaudeVisibleMessageAnchor;
  last?: ClaudeVisibleMessageAnchor;
}

export interface ClaudeGraphRecordOccurrence {
  occurrenceId: string;
  sessionCacheKey: string;
  sessionIdentityKey: string;
  sessionId?: string;
  recordUuid?: string;
  parentUuid?: string;
  visibleParentUuid?: string;
  logicalParentUuid?: string;
  timestampIso?: string;
  type: string;
  promptId?: string;
  requestId?: string;
  isMeta: boolean;
  isSidechain?: boolean;
  subtype?: string;
  textFingerprint: string;
  preview: string;
  chatMessageIndex: number;
  recordOrdinal: number;
  compactBoundary: boolean;
  previousVisibleMessage?: ClaudeVisibleMessageAnchor;
}

export interface SessionAnalysisEntry {
  cacheKey: string;
  identityKey: string;
  fsPath: string;
  source: SessionSource;
  storage: SessionStorageLocation;
  projectCwd?: string;
  startedAtIso?: string;
  lastActivityAtIso?: string;
  mtimeMs: number;
  size: number;
  parserVersion: number;
  completeness: AnalysisCompleteness;
  messageStats: SessionMessageStats;
  usageStats: SessionUsageStats;
  fileChangeStats: SessionFileChangeStats;
  latestRateLimitSnapshot?: RateLimitSnapshot;
  claudeGraphRecords: ClaudeGraphRecordOccurrence[];
  claudeMessageBounds?: ClaudeMessageBounds;
  claudePhysicalProjectFolderKey?: string;
  claudeIsSidechain?: ClaudeSidechainState;
  warnings: string[];
}

export interface SessionAnalysisCacheContext {
  codexSessionsRoot: string;
  codexArchivedSessionsRoot: string;
  claudeSessionsRoot: string;
  includeCodex: boolean;
  includeCodexArchived: boolean;
  includeClaude: boolean;
  codexParserVersion: number;
  claudeParserVersion: number;
  pathNormalizationVersion: number;
}

export interface SessionAnalysisCacheFile {
  version: 1;
  context: SessionAnalysisCacheContext;
  generatedAtIso: string;
  entries: Record<string, SessionAnalysisEntry>;
}

export type SessionAnalysisProgressPhase =
  | "loadCache"
  | "collectSessions"
  | "analyzeSessions"
  | "buildRelations"
  | "aggregate"
  | "render";

export interface SessionAnalysisProgress {
  phase: SessionAnalysisProgressPhase;
  completed: number;
  total: number;
  currentSource?: SessionSource;
  cancellable: boolean;
  cacheHitCount: number;
  rebuiltCount: number;
}

export interface SessionAnalysisResult {
  entries: SessionAnalysisEntry[];
  cacheHitCount: number;
  rebuiltCount: number;
  failedCount: number;
  generatedAtIso: string;
}

export const SESSION_ANALYSIS_CACHE_SCHEMA_VERSION = 1 as const;
export const SESSION_ANALYSIS_CODEX_PARSER_VERSION = 8;
export const SESSION_ANALYSIS_CLAUDE_PARSER_VERSION = 8;
export const SESSION_ANALYSIS_PATH_NORMALIZATION_VERSION = 1;
export const SESSION_ANALYSIS_MAX_FILE_CHANGE_ENTRIES = 100_000;
export const SESSION_ANALYSIS_MAX_CACHE_ENTRIES = 200_000;
export const SESSION_ANALYSIS_MAX_PATH_LENGTH = 32_768;
export const SESSION_ANALYSIS_MAX_GRAPH_IDENTIFIER_LENGTH = 1_024;
export const SESSION_ANALYSIS_MAX_TIMESTAMP_LENGTH = 128;

export function isSessionAnalysisTimestamp(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= SESSION_ANALYSIS_MAX_TIMESTAMP_LENGTH &&
    value.trim().length > 0;
}

export function normalizeSessionAnalysisTimestamp(value: unknown): string | undefined {
  return isSessionAnalysisTimestamp(value) ? value : undefined;
}

export function isSessionAnalysisProjectCwd(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= SESSION_ANALYSIS_MAX_PATH_LENGTH &&
    value.trim().length > 0;
}

export function normalizeSessionAnalysisProjectCwd(value: unknown): string | undefined {
  return isSessionAnalysisProjectCwd(value) ? value : undefined;
}

export function isSessionAnalysisGraphIdentifier(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= SESSION_ANALYSIS_MAX_GRAPH_IDENTIFIER_LENGTH &&
    value.trim().length > 0;
}

export function normalizeSessionAnalysisGraphIdentifier(value: unknown): string | undefined {
  return isSessionAnalysisGraphIdentifier(value) ? value : undefined;
}
