import { createHash } from "node:crypto";
import type { AnalysisNumber, SessionAnalysisEntry } from "../analysis/sessionAnalysisTypes";
import { inferFilePresentationKind } from "../utils/fileKind";
import { safeDisplayPath } from "../utils/textUtils";
import {
  resolveProjectRelativeFilePath,
  type HistoryInsightsAggregationProjectContext,
} from "./historyInsightsProjectContext";
import type {
  HistoryInsightsBreakdownGroup,
  HistoryInsightsBreakdownMetric,
  HistoryInsightsBreakdownMetricValues,
  HistoryInsightsBreakdownRow,
  HistoryInsightsActiveSessionMetric,
  HistoryInsightsActiveSessionRow,
  HistoryInsightsDayBucket,
  HistoryInsightsFileRow,
  HistoryInsightsMetric,
  HistoryInsightsModel,
  HistoryInsightsModelRow,
  HistoryInsightsProjectRow,
  HistoryInsightsSnapshot,
  HistoryInsightsToolGroup,
  HistoryInsightsDetailMetricKey,
  HistoryInsightsDetailMetricRow,
  HistoryInsightsFileKindRow,
} from "./historyInsightsTypes";

const MAX_FILE_ROWS = 500;
const MAX_BREAKDOWN_VISIBLE_ROWS = 32;
const MAX_BREAKDOWN_CANDIDATE_ROWS = 128;
const MAX_MODEL_EFFORT_ROWS = 32;
const MAX_TOOL_VISIBLE_ROWS = 32;
const MAX_TOOL_CANDIDATE_ROWS = 128;
const MAX_ACTIVE_SESSION_ROWS_PER_METRIC = 20;
const BREAKDOWN_METRICS: readonly HistoryInsightsBreakdownMetric[] = ["sessions", "inputTokens", "outputTokens", "totalTokens"];

export interface HistoryInsightsAggregationInput {
  snapshot: HistoryInsightsSnapshot;
  entries: readonly SessionAnalysisEntry[];
  cacheHitCount: number;
  rebuiltCount: number;
  generatedAtIso?: string;
  refreshing?: boolean;
  stale?: boolean;
  isFileHistoryPathSupported?: (normalizedPath: string) => boolean;
  isFileOpenSupported?: (normalizedPath: string) => boolean;
  projectContextBySessionKey?: ReadonlyMap<string, HistoryInsightsAggregationProjectContext>;
  drillDownProjectKeys?: ReadonlySet<string>;
  unknownProjectLabel?: string;
  sessionPresentationByIdentityKey?: ReadonlyMap<string, HistoryInsightsSessionPresentation>;
}

export interface HistoryInsightsSessionPresentation {
  title: string;
  lastActivityAtIso?: string;
}

interface NumericAggregationState {
  overflow: boolean;
}

interface FileProjectAccumulator {
  context: HistoryInsightsAggregationProjectContext;
  sessionKeys: Set<string>;
  relativePathCounts: Map<string, number>;
}

interface FileAccumulator {
  normalizedPath: string;
  displayPath: string;
  sessionKeys: Set<string>;
  changeEventCount: number;
  linesAdded: number;
  linesRemoved: number;
  lastTimestampIso?: string;
  projectContexts: Map<string, FileProjectAccumulator>;
}

interface MetricValueCollections {
  userRequests: AnalysisNumber[];
  inputTokens: AnalysisNumber[];
  outputTokens: AnalysisNumber[];
  totalTokens: AnalysisNumber[];
  distinctFiles: AnalysisNumber[];
  linesAdded: AnalysisNumber[];
  linesRemoved: AnalysisNumber[];
  changeEvents: AnalysisNumber[];
  reasoningOutputTokens: AnalysisNumber[];
}

type DetailMetricCollections = Record<HistoryInsightsDetailMetricKey, AnalysisNumber[]>;

export function aggregateHistoryInsights(input: HistoryInsightsAggregationInput): HistoryInsightsModel {
  const numericState: NumericAggregationState = { overflow: false };
  const entryByCacheKey = new Map(input.entries.map((entry) => [entry.cacheKey, entry]));
  const entryByIdentityKey = new Map(input.entries.map((entry) => [entry.identityKey, entry]));
  const targetSessions = input.snapshot.references.length;
  const metricValues: MetricValueCollections = {
    userRequests: [] as AnalysisNumber[],
    inputTokens: [] as AnalysisNumber[],
    outputTokens: [] as AnalysisNumber[],
    totalTokens: [] as AnalysisNumber[],
    distinctFiles: [] as AnalysisNumber[],
    linesAdded: [] as AnalysisNumber[],
    linesRemoved: [] as AnalysisNumber[],
    changeEvents: [] as AnalysisNumber[],
    reasoningOutputTokens: [] as AnalysisNumber[],
  };
  const detailMetricValues: DetailMetricCollections = {
    cachedInputTokens: [],
    cacheReadInputTokens: [],
    cacheCreationInputTokens: [],
    reasoningOutputTokens: [],
    userMessages: [],
    assistantMessages: [],
    developerMessages: [],
    toolCalls: [],
    toolOutputs: [],
    turns: [],
    completedTurns: [],
    interruptedTurns: [],
    rolledBackTurns: [],
  };
  const fileKindPaths = new Map<HistoryInsightsFileKindRow["kind"], Set<string>>();
  const fileKindEvents = new Map<HistoryInsightsFileKindRow["kind"], number>();
  const dayByYmd = new Map<string, HistoryInsightsDayBucket>();
  const dayFilePaths = new Map<string, Set<string>>();
  const files = new Map<string, FileAccumulator>();
  const sourceMetrics = new Map<string, HistoryInsightsBreakdownMetricValues>();
  const modelMetrics = new Map<string, HistoryInsightsBreakdownMetricValues>();
  const modelEffortTotals = new Map<string, Map<string, number>>();
  const projectMetrics = new Map<string, { label: string; metrics: HistoryInsightsBreakdownMetricValues }>();
  const projectContextKeysByLabel = new Map<string, Set<string>>();
  const toolMetrics = new Map<string, { calls: number; sessions: number }>();
  const activeSessions: HistoryInsightsActiveSessionRow[] = [];
  let analyzedSessions = 0;
  let failedSessions = 0;
  let unsupportedSessions = 0;
  let partialSessions = 0;
  let modelAvailableSessions = 0;
  let toolAvailableSessions = 0;

  for (const reference of input.snapshot.references) {
    const cacheMatch = entryByCacheKey.get(reference.cacheKey);
    const entry = cacheMatch?.identityKey === reference.identityKey
      ? cacheMatch
      : entryByIdentityKey.get(reference.identityKey);
    const projectContext = resolveProjectContext(
      input,
      entry,
      reference.identityKey,
      reference.projectKey,
      reference.projectLabel,
    );
    const projectLabel = projectContext.displayName;
    const projectLabelKey = projectLabel.toLocaleLowerCase();
    const contextKeys = projectContextKeysByLabel.get(projectLabelKey) ?? new Set<string>();
    contextKeys.add(projectContext.contextKey);
    projectContextKeysByLabel.set(projectLabelKey, contextKeys);
    const source = sourceMetrics.get(reference.source) ?? emptyBreakdownMetrics();
    source.sessions = addAndTrack(source.sessions, 1, numericState);
    sourceMetrics.set(reference.source, source);
    const project = projectMetrics.get(reference.projectKey) ?? { label: projectLabel, metrics: emptyBreakdownMetrics() };
    project.label = projectLabel;
    project.metrics.sessions = addAndTrack(project.metrics.sessions, 1, numericState);
    projectMetrics.set(reference.projectKey, project);
    const day = dayByYmd.get(reference.bucketLocalDate) ?? createDayBucket(reference.bucketLocalDate);
    day.sessionCount = addAndTrack(day.sessionCount, 1, numericState);
    dayByYmd.set(reference.bucketLocalDate, day);

    if (!entry) {
      appendUnavailableMetrics(metricValues);
      for (const metrics of Object.values(detailMetricValues)) metrics.push({ availability: "unavailable" });
      appendUnavailableDayMetrics(day, numericState);
      continue;
    }
    if (entry.completeness === "failed") failedSessions = addAndTrack(failedSessions, 1, numericState);
    else if (entry.completeness === "unsupported") unsupportedSessions = addAndTrack(unsupportedSessions, 1, numericState);
    else analyzedSessions = addAndTrack(analyzedSessions, 1, numericState);
    if (entry.completeness === "partial") partialSessions = addAndTrack(partialSessions, 1, numericState);
    metricValues.userRequests.push(entry.messageStats.userMessageCount);
    metricValues.inputTokens.push(entry.usageStats.inputTokens);
    metricValues.outputTokens.push(entry.usageStats.outputTokens);
    metricValues.totalTokens.push(entry.usageStats.derivedTotalTokens);
    metricValues.distinctFiles.push(entry.fileChangeStats.distinctFileCount);
    metricValues.linesAdded.push(entry.fileChangeStats.linesAdded);
    metricValues.linesRemoved.push(entry.fileChangeStats.linesRemoved);
    metricValues.changeEvents.push(entry.fileChangeStats.changeEventCount);
    metricValues.reasoningOutputTokens.push(entry.usageStats.reasoningOutputTokens);
    detailMetricValues.cachedInputTokens.push(entry.usageStats.cachedInputTokens);
    detailMetricValues.cacheReadInputTokens.push(entry.usageStats.cacheReadInputTokens);
    detailMetricValues.cacheCreationInputTokens.push(entry.usageStats.cacheCreationInputTokens);
    detailMetricValues.reasoningOutputTokens.push(entry.usageStats.reasoningOutputTokens);
    detailMetricValues.userMessages.push(entry.messageStats.userMessageCount);
    detailMetricValues.assistantMessages.push(entry.messageStats.assistantMessageCount);
    detailMetricValues.developerMessages.push(entry.messageStats.developerMessageCount);
    detailMetricValues.toolCalls.push(entry.messageStats.toolCallCount);
    detailMetricValues.toolOutputs.push(entry.messageStats.toolOutputCount);
    detailMetricValues.turns.push(entry.messageStats.turnCount);
    detailMetricValues.completedTurns.push(entry.messageStats.completedTurnCount);
    detailMetricValues.interruptedTurns.push(entry.messageStats.interruptedTurnCount);
    detailMetricValues.rolledBackTurns.push(entry.messageStats.rolledBackTurnCount);
    addAnalysisMetric(source, "inputTokens", entry.usageStats.inputTokens, numericState);
    addAnalysisMetric(source, "outputTokens", entry.usageStats.outputTokens, numericState);
    addAnalysisMetric(source, "totalTokens", entry.usageStats.derivedTotalTokens, numericState);
    addAnalysisMetric(project.metrics, "inputTokens", entry.usageStats.inputTokens, numericState);
    addAnalysisMetric(project.metrics, "outputTokens", entry.usageStats.outputTokens, numericState);
    addAnalysisMetric(project.metrics, "totalTokens", entry.usageStats.derivedTotalTokens, numericState);
    appendDayMetric(day.userRequestCount, entry.messageStats.userMessageCount, numericState);
    appendDayMetric(day.inputTokenCount, entry.usageStats.inputTokens, numericState);
    appendDayMetric(day.outputTokenCount, entry.usageStats.outputTokens, numericState);
    appendDayMetric(day.reasoningOutputTokenCount, entry.usageStats.reasoningOutputTokens, numericState);
    appendDayMetric(day.totalTokenCount, entry.usageStats.derivedTotalTokens, numericState);
    appendDayMetric(day.distinctFileCount, zeroValueForAvailability(entry.fileChangeStats.distinctFileCount), numericState);
    appendDayMetric(day.linesAdded, entry.fileChangeStats.linesAdded, numericState);
    appendDayMetric(day.linesRemoved, entry.fileChangeStats.linesRemoved, numericState);
    appendDayMetric(
      day.changedLineCount,
      sumAnalysisNumbers(entry.fileChangeStats.linesAdded, entry.fileChangeStats.linesRemoved, numericState),
      numericState,
    );

    if (entry.usageStats.modelUsage.length > 0) {
      modelAvailableSessions = addAndTrack(modelAvailableSessions, 1, numericState);
    }
    if (entry.messageStats.toolCallCount.availability !== "unavailable") {
      toolAvailableSessions = addAndTrack(toolAvailableSessions, 1, numericState);
    }
    const sessionModels = new Set<string>();
    for (const model of entry.usageStats.modelUsage) {
      const metrics = modelMetrics.get(model.model) ?? emptyBreakdownMetrics();
      if (!sessionModels.has(model.model)) {
        metrics.sessions = addAndTrack(metrics.sessions, 1, numericState);
        sessionModels.add(model.model);
      }
      metrics.inputTokens = addAndTrack(metrics.inputTokens, model.inputTokens, numericState);
      metrics.outputTokens = addAndTrack(metrics.outputTokens, model.outputTokens, numericState);
      metrics.totalTokens = addAndTrack(metrics.totalTokens, model.totalTokens, numericState);
      modelMetrics.set(model.model, metrics);
    }
    for (const usage of entry.usageStats.modelEffortUsage) {
      if (entry.source !== "codex") continue;
      const efforts = modelEffortTotals.get(usage.model) ?? new Map<string, number>();
      efforts.set(usage.effort, addAndTrack(efforts.get(usage.effort) ?? 0, usage.totalTokens, numericState));
      modelEffortTotals.set(usage.model, efforts);
    }
    for (const tool of entry.messageStats.toolUsage) {
      const current = toolMetrics.get(tool.name) ?? { calls: 0, sessions: 0 };
      current.calls = addAndTrack(current.calls, tool.callCount, numericState);
      current.sessions = addAndTrack(current.sessions, 1, numericState);
      toolMetrics.set(tool.name, current);
    }
    const presentation = input.sessionPresentationByIdentityKey?.get(reference.identityKey);
    activeSessions.push({
      id: buildHistoryInsightsEntityId(`session\0${reference.identityKey}`),
      title: String(presentation?.title || reference.identityKey).slice(0, 512),
      source: reference.source,
      projectLabel: String(projectLabel).slice(0, 512),
      ...(presentation?.lastActivityAtIso ? { lastActivityAtIso: presentation.lastActivityAtIso } : {}),
      metrics: {
        userRequests: copyAnalysisMetric(entry.messageStats.userMessageCount),
        toolCalls: copyAnalysisMetric(entry.messageStats.toolCallCount),
        reasoningTokens: copyAnalysisMetric(entry.usageStats.reasoningOutputTokens),
        totalTokens: copyAnalysisMetric(entry.usageStats.derivedTotalTokens),
        changedLines: sumAnalysisNumbers(entry.fileChangeStats.linesAdded, entry.fileChangeStats.linesRemoved, numericState),
      },
    });
    for (const file of entry.fileChangeStats.files) {
      const kind = inferFilePresentationKind(file.normalizedPath, file.displayPath);
      const kindPaths = fileKindPaths.get(kind) ?? new Set<string>();
      kindPaths.add(file.normalizedPath);
      fileKindPaths.set(kind, kindPaths);
      fileKindEvents.set(kind, addAndTrack(fileKindEvents.get(kind) ?? 0, file.changeEventCount, numericState));
      const paths = dayFilePaths.get(reference.bucketLocalDate) ?? new Set<string>();
      paths.add(file.normalizedPath);
      dayFilePaths.set(reference.bucketLocalDate, paths);
      const current = files.get(file.normalizedPath) ?? {
        normalizedPath: file.normalizedPath,
        displayPath: file.displayPath,
        sessionKeys: new Set<string>(),
        changeEventCount: 0,
        linesAdded: 0,
        linesRemoved: 0,
        projectContexts: new Map<string, FileProjectAccumulator>(),
      };
      current.sessionKeys.add(entry.cacheKey);
      current.changeEventCount = addAndTrack(current.changeEventCount, file.changeEventCount, numericState);
      current.linesAdded = addAndTrack(current.linesAdded, file.linesAdded, numericState);
      current.linesRemoved = addAndTrack(current.linesRemoved, file.linesRemoved, numericState);
      current.lastTimestampIso = maxIso(current.lastTimestampIso, file.lastTimestampIso);
      const fileProject = current.projectContexts.get(projectContext.contextKey) ?? {
        context: projectContext,
        sessionKeys: new Set<string>(),
        relativePathCounts: new Map<string, number>(),
      };
      fileProject.sessionKeys.add(reference.identityKey);
      const relativePath = resolveProjectRelativeFilePath(file.normalizedPath, projectContext.physicalCwd);
      if (relativePath) {
        fileProject.relativePathCounts.set(
          relativePath,
          addAndTrack(fileProject.relativePathCounts.get(relativePath) ?? 0, 1, numericState),
        );
      }
      current.projectContexts.set(projectContext.contextKey, fileProject);
      files.set(file.normalizedPath, current);
    }
  }

  const distinctFileMetric = aggregateDistinctFiles(files.size, metricValues.distinctFiles, targetSessions, numericState);
  for (const [ymd, day] of dayByYmd) {
    if (day.distinctFileCount.availability !== "unavailable") {
      day.distinctFileCount.value = dayFilePaths.get(ymd)?.size ?? 0;
    }
  }
  const fileRows = Array.from(files.values())
    .sort((left, right) =>
      right.sessionKeys.size - left.sessionKeys.size ||
      right.changeEventCount - left.changeEventCount ||
      left.displayPath.localeCompare(right.displayPath),
    )
    .slice(0, MAX_FILE_ROWS)
    .map((file): HistoryInsightsFileRow => {
      addAndTrack(file.linesAdded, file.linesRemoved, numericState);
      const projectContexts = Array.from(file.projectContexts.values())
        .map((value) => ({
          value,
          displayPath: selectMostFrequentPath(value.relativePathCounts) ?? file.displayPath,
        }))
        .sort((left, right) =>
          right.value.sessionKeys.size - left.value.sessionKeys.size ||
          left.value.context.displayName.localeCompare(right.value.context.displayName) ||
          left.value.context.pathHint.localeCompare(right.value.context.pathHint) ||
          left.value.context.contextKey.localeCompare(right.value.context.contextKey),
        );
      const primary = projectContexts[0];
      return {
        id: buildHistoryInsightsEntityId(file.normalizedPath),
        displayPath: safeDisplayPath(primary?.displayPath ?? file.displayPath, 160),
        fileKind: inferFilePresentationKind(file.normalizedPath, file.displayPath),
        projectContexts: projectContexts.slice(0, 3).map(({ value }) => ({
          displayName: safeDisplayPath(value.context.displayName, 120),
          pathHint: safeDisplayPath(value.context.pathHint, 80),
          sessionCount: value.sessionKeys.size,
          disambiguate: (projectContextKeysByLabel.get(value.context.displayName.toLocaleLowerCase())?.size ?? 0) > 1,
        })),
        projectContextCount: projectContexts.length,
        sessionCount: file.sessionKeys.size,
        changeEventCount: file.changeEventCount,
        linesAdded: file.linesAdded,
        linesRemoved: file.linesRemoved,
        ...(file.lastTimestampIso ? { lastTimestampIso: file.lastTimestampIso } : {}),
        canOpenFileHistory: input.isFileHistoryPathSupported?.(file.normalizedPath) ?? false,
        canOpenFile: input.isFileOpenSupported?.(file.normalizedPath) ?? false,
      };
    });

  const sources = buildBreakdown(Array.from(sourceMetrics, ([label, metrics]) => ({
    id: buildHistoryInsightsEntityId(label),
    label,
    metrics,
  })), numericState);
  const models = buildModelBreakdown(modelMetrics, modelEffortTotals, numericState);
  const projects = buildProjectBreakdown(projectMetrics, input.drillDownProjectKeys, numericState);
  const tools = buildToolGroup(toolMetrics, numericState);
  const rankedActiveSessions = buildActiveSessionCandidates(activeSessions);
  const metrics = {
    sessions: { value: targetSessions, availability: "available" as const, availableSessions: targetSessions, totalSessions: targetSessions },
    userRequests: aggregateNumbers(metricValues.userRequests, targetSessions, numericState),
    inputTokens: aggregateNumbers(metricValues.inputTokens, targetSessions, numericState),
    outputTokens: aggregateNumbers(metricValues.outputTokens, targetSessions, numericState),
    totalTokens: aggregateNumbers(metricValues.totalTokens, targetSessions, numericState),
    distinctFiles: distinctFileMetric,
    linesAdded: aggregateNumbers(metricValues.linesAdded, targetSessions, numericState),
    linesRemoved: aggregateNumbers(metricValues.linesRemoved, targetSessions, numericState),
    changeEvents: aggregateNumbers(metricValues.changeEvents, targetSessions, numericState),
    reasoningOutputTokens: aggregateNumbers(metricValues.reasoningOutputTokens, targetSessions, numericState),
  };
  const usageDetails = {
    inputCache: buildDetailRows(
      ["cachedInputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "reasoningOutputTokens"],
      detailMetricValues,
      targetSessions,
      numericState,
    ),
    messages: buildDetailRows(
      ["userMessages", "assistantMessages", "developerMessages", "toolCalls", "toolOutputs"],
      detailMetricValues,
      targetSessions,
      numericState,
    ),
    turns: buildDetailRows(
      ["turns", "completedTurns", "interruptedTurns", "rolledBackTurns"],
      detailMetricValues,
      targetSessions,
      numericState,
    ),
    fileKinds: buildFileKindRows(fileKindPaths, fileKindEvents),
  };
  return {
    version: 1,
    snapshotId: input.snapshot.id,
    generatedAtIso: input.generatedAtIso ?? new Date().toISOString(),
    refreshing: input.refreshing === true,
    stale: input.stale === true,
    dateBasis: input.snapshot.dateBasis,
    dateTimeSettingsKey: input.snapshot.dateTimeSettingsKey,
    chips: input.snapshot.descriptor.chips.slice(0, 20),
    metrics,
    days: Array.from(dayByYmd.values()).sort((left, right) => left.ymd.localeCompare(right.ymd)),
    files: fileRows,
    sources,
    models,
    projects,
    tools,
    activeSessions: rankedActiveSessions,
    usageDetails,
    quality: {
      targetSessions,
      analyzedSessions,
      cacheHitCount: addAndTrack(0, input.cacheHitCount, numericState),
      rebuiltCount: addAndTrack(0, input.rebuiltCount, numericState),
      failedSessions,
      unsupportedSessions,
      partialSessions,
      tokenAvailableSessions: metricValues.totalTokens.filter((metric) => metric.availability !== "unavailable").length,
      fileChangeAvailableSessions: metricValues.distinctFiles.filter((metric) => metric.availability !== "unavailable").length,
      modelAvailableSessions,
      toolAvailableSessions,
      numericOverflow: numericState.overflow,
    },
  };
}

function buildDetailRows(
  keys: readonly HistoryInsightsDetailMetricKey[],
  values: DetailMetricCollections,
  totalSessions: number,
  numericState: NumericAggregationState,
): HistoryInsightsDetailMetricRow[] {
  return keys.map((key) => ({
    key,
    metric: aggregateNumbers(values[key], totalSessions, numericState),
  }));
}

function buildFileKindRows(
  paths: ReadonlyMap<HistoryInsightsFileKindRow["kind"], ReadonlySet<string>>,
  events: ReadonlyMap<HistoryInsightsFileKindRow["kind"], number>,
): HistoryInsightsFileKindRow[] {
  return Array.from(paths, ([kind, values]) => ({
    kind,
    distinctFileCount: values.size,
    changeEventCount: events.get(kind) ?? 0,
  })).sort((left, right) =>
    right.distinctFileCount - left.distinctFileCount ||
    right.changeEventCount - left.changeEventCount ||
    left.kind.localeCompare(right.kind));
}

function copyAnalysisMetric(metric: AnalysisNumber): AnalysisNumber {
  return metric.value === undefined ? { availability: metric.availability } : { value: metric.value, availability: metric.availability };
}

function buildToolGroup(
  values: ReadonlyMap<string, { calls: number; sessions: number }>,
  numericState: NumericAggregationState,
): HistoryInsightsToolGroup {
  const allRows = Array.from(values, ([label, metrics]) => ({
    id: buildHistoryInsightsEntityId(`tool\0${label}`),
    label,
    calls: metrics.calls,
    sessions: metrics.sessions,
  }));
  const totals = { calls: 0, sessions: 0 };
  const positiveRowCounts = { calls: 0, sessions: 0 };
  const candidateIds = new Set<string>();
  for (const metric of ["calls", "sessions"] as const) {
    for (const row of allRows) {
      totals[metric] = addAndTrack(totals[metric], row[metric], numericState);
      if (row[metric] > 0) positiveRowCounts[metric] = addAndTrack(positiveRowCounts[metric], 1, numericState);
    }
    allRows
      .filter((row) => row[metric] > 0)
      .sort((left, right) => right[metric] - left[metric] || left.label.localeCompare(right.label))
      .slice(0, MAX_TOOL_VISIBLE_ROWS)
      .forEach((row) => candidateIds.add(row.id));
  }
  const rows = allRows
    .filter((row) => candidateIds.has(row.id))
    .sort((left, right) => right.calls - left.calls || left.label.localeCompare(right.label))
    .slice(0, MAX_TOOL_CANDIDATE_ROWS);
  return { rows, totals, positiveRowCounts };
}

function buildActiveSessionCandidates(rows: readonly HistoryInsightsActiveSessionRow[]): HistoryInsightsActiveSessionRow[] {
  const metrics: readonly HistoryInsightsActiveSessionMetric[] = [
    "userRequests",
    "toolCalls",
    "reasoningTokens",
    "totalTokens",
    "changedLines",
  ];
  const candidateIds = new Set<string>();
  for (const metric of metrics) {
    rows
      .filter((row) => row.metrics[metric].availability !== "unavailable" && row.metrics[metric].value !== undefined)
      .sort((left, right) => compareActiveSessionRows(left, right, metric))
      .slice(0, MAX_ACTIVE_SESSION_ROWS_PER_METRIC)
      .forEach((row) => candidateIds.add(row.id));
  }
  return rows.filter((row) => candidateIds.has(row.id));
}

function compareActiveSessionRows(
  left: HistoryInsightsActiveSessionRow,
  right: HistoryInsightsActiveSessionRow,
  metric: HistoryInsightsActiveSessionMetric,
): number {
  return (right.metrics[metric].value ?? -1) - (left.metrics[metric].value ?? -1) ||
    String(right.lastActivityAtIso ?? "").localeCompare(String(left.lastActivityAtIso ?? "")) ||
    left.title.localeCompare(right.title) ||
    left.id.localeCompare(right.id);
}

export function aggregateNumbers(
  values: readonly AnalysisNumber[],
  totalSessions: number,
  numericState: NumericAggregationState = { overflow: false },
): HistoryInsightsMetric {
  let value = 0;
  let availableSessions = 0;
  let hasPartial = false;
  let overflowed = false;
  for (const metric of values) {
    if (metric.availability === "unavailable" || typeof metric.value !== "number") continue;
    const result = addSafeNonNegativeIntegers(value, metric.value);
    value = result.value;
    if (result.overflowed) {
      overflowed = true;
      numericState.overflow = true;
    }
    availableSessions = addAndTrack(availableSessions, 1, numericState);
    if (metric.availability === "partial") hasPartial = true;
  }
  if (availableSessions === 0) return { availability: "unavailable", availableSessions: 0, totalSessions };
  const availability = hasPartial || overflowed || availableSessions < totalSessions ? "partial" : "available";
  return { value, availability, availableSessions, totalSessions };
}

function aggregateDistinctFiles(
  distinctFileCount: number,
  values: readonly AnalysisNumber[],
  totalSessions: number,
  numericState: NumericAggregationState,
): HistoryInsightsMetric {
  const base = aggregateNumbers(
    values.map((metric) => ({ ...metric, value: metric.value === undefined ? undefined : 0 })),
    totalSessions,
    numericState,
  );
  return base.availability === "unavailable" ? base : { ...base, value: distinctFileCount };
}

function appendUnavailableMetrics(values: MetricValueCollections): void {
  for (const metrics of Object.values(values)) metrics.push({ availability: "unavailable" });
}

function createDayBucket(ymd: string): HistoryInsightsDayBucket {
  const unavailable = (): HistoryInsightsMetric => ({ availability: "unavailable", availableSessions: 0, totalSessions: 0 });
  return {
    ymd,
    sessionCount: 0,
    userRequestCount: unavailable(),
    inputTokenCount: unavailable(),
    outputTokenCount: unavailable(),
    reasoningOutputTokenCount: unavailable(),
    totalTokenCount: unavailable(),
    distinctFileCount: unavailable(),
    linesAdded: unavailable(),
    linesRemoved: unavailable(),
    changedLineCount: unavailable(),
  };
}

function appendUnavailableDayMetrics(day: HistoryInsightsDayBucket, numericState: NumericAggregationState): void {
  appendDayMetric(day.userRequestCount, undefined, numericState);
  appendDayMetric(day.inputTokenCount, undefined, numericState);
  appendDayMetric(day.outputTokenCount, undefined, numericState);
  appendDayMetric(day.reasoningOutputTokenCount, undefined, numericState);
  appendDayMetric(day.totalTokenCount, undefined, numericState);
  appendDayMetric(day.distinctFileCount, undefined, numericState);
  appendDayMetric(day.linesAdded, undefined, numericState);
  appendDayMetric(day.linesRemoved, undefined, numericState);
  appendDayMetric(day.changedLineCount, undefined, numericState);
}

function appendDayMetric(
  target: HistoryInsightsMetric,
  metric: AnalysisNumber | undefined,
  numericState: NumericAggregationState,
): void {
  target.totalSessions = addAndTrack(target.totalSessions, 1, numericState);
  if (!metric || metric.availability === "unavailable" || typeof metric.value !== "number") {
    if (target.availableSessions > 0) target.availability = "partial";
    return;
  }
  const result = addSafeNonNegativeIntegers(target.value ?? 0, metric.value);
  target.value = result.value;
  if (result.overflowed) numericState.overflow = true;
  target.availableSessions = addAndTrack(target.availableSessions, 1, numericState);
  target.availability =
    target.availability === "partial" ||
    metric.availability === "partial" ||
    result.overflowed ||
    target.availableSessions < target.totalSessions
      ? "partial"
      : "available";
}

function sumAnalysisNumbers(
  left: AnalysisNumber,
  right: AnalysisNumber,
  numericState: NumericAggregationState,
): AnalysisNumber {
  if (left.availability === "unavailable" && right.availability === "unavailable") return { availability: "unavailable" };
  const result = addSafeNonNegativeIntegers(left.value ?? 0, right.value ?? 0);
  if (result.overflowed) numericState.overflow = true;
  const availability =
    result.overflowed ||
    left.availability === "partial" || right.availability === "partial" ||
    left.availability === "unavailable" || right.availability === "unavailable"
      ? "partial"
      : "available";
  return { value: result.value, availability };
}

function zeroValueForAvailability(metric: AnalysisNumber): AnalysisNumber {
  return metric.availability === "unavailable"
    ? { availability: "unavailable" }
    : { value: 0, availability: metric.availability };
}

function emptyBreakdownMetrics(): HistoryInsightsBreakdownMetricValues {
  return { sessions: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function addAnalysisMetric(
  target: HistoryInsightsBreakdownMetricValues,
  key: Exclude<HistoryInsightsBreakdownMetric, "sessions">,
  metric: AnalysisNumber,
  numericState: NumericAggregationState,
): void {
  if (metric.availability === "unavailable" || typeof metric.value !== "number") return;
  target[key] = addAndTrack(target[key], metric.value, numericState);
}

function buildBreakdown<TRow extends HistoryInsightsBreakdownRow>(
  rows: readonly TRow[],
  numericState: NumericAggregationState,
): HistoryInsightsBreakdownGroup<TRow> {
  const totals = emptyBreakdownMetrics();
  const positiveRowCounts = emptyBreakdownMetrics();
  for (const row of rows) {
    for (const metric of BREAKDOWN_METRICS) {
      totals[metric] = addAndTrack(totals[metric], row.metrics[metric], numericState);
      if (row.metrics[metric] > 0) {
        positiveRowCounts[metric] = addAndTrack(positiveRowCounts[metric], 1, numericState);
      }
    }
  }
  const candidateIds = new Set<string>();
  for (const metric of BREAKDOWN_METRICS) {
    rows
      .filter((row) => row.metrics[metric] > 0)
      .sort((left, right) => right.metrics[metric] - left.metrics[metric] || left.label.localeCompare(right.label) || left.id.localeCompare(right.id))
      .slice(0, MAX_BREAKDOWN_VISIBLE_ROWS)
      .forEach((row) => candidateIds.add(row.id));
  }
  const candidates = rows
    .filter((row) => candidateIds.has(row.id))
    .sort((left, right) => right.metrics.totalTokens - left.metrics.totalTokens || left.label.localeCompare(right.label) || left.id.localeCompare(right.id))
    .slice(0, MAX_BREAKDOWN_CANDIDATE_ROWS);
  return { rows: candidates, totals, positiveRowCounts };
}

function buildModelBreakdown(
  values: ReadonlyMap<string, HistoryInsightsBreakdownMetricValues>,
  effortValues: ReadonlyMap<string, ReadonlyMap<string, number>>,
  numericState: NumericAggregationState,
): HistoryInsightsBreakdownGroup<HistoryInsightsModelRow> {
  const rows = Array.from(values.entries())
    .map(([label, metrics]): HistoryInsightsModelRow => {
      const allEfforts = Array.from(effortValues.get(label) ?? [])
        .filter(([, totalTokens]) => totalTokens > 0)
        .map(([effort, totalTokens]) => ({
          id: buildHistoryInsightsEntityId(`${label}\0${effort}`),
          label: effort,
          value: totalTokens,
        }))
        .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label));
      return {
        id: buildHistoryInsightsEntityId(label),
        label,
        metrics,
        effortRows: allEfforts.slice(0, MAX_MODEL_EFFORT_ROWS),
        effortTotalTokens: allEfforts.reduce(
          (sum, effort) => addAndTrack(sum, effort.value, numericState),
          0,
        ),
        omittedEffortCount: Math.max(0, allEfforts.length - MAX_MODEL_EFFORT_ROWS),
      };
    });
  return buildBreakdown(rows, numericState);
}

function buildProjectBreakdown(
  values: ReadonlyMap<string, { label: string; metrics: HistoryInsightsBreakdownMetricValues }>,
  drillDownProjectKeys: ReadonlySet<string> | undefined,
  numericState: NumericAggregationState,
): HistoryInsightsBreakdownGroup<HistoryInsightsProjectRow> {
  return buildBreakdown(Array.from(values.entries())
    .map(([key, value]) => ({
      id: buildHistoryInsightsEntityId(key),
      label: value.label,
      metrics: value.metrics,
      canDrillDown: key.length > 0 && (drillDownProjectKeys?.has(key) ?? true),
    })), numericState);
}

function addAndTrack(left: number, right: number, state: NumericAggregationState): number {
  const result = addSafeNonNegativeIntegers(left, right);
  if (result.overflowed) state.overflow = true;
  return result.value;
}

function addSafeNonNegativeIntegers(
  left: number,
  right: number,
): { value: number; overflowed: boolean } {
  const normalizedLeft = normalizeNonNegativeSafeInteger(left);
  const normalizedRight = normalizeNonNegativeSafeInteger(right);
  const normalized = normalizedLeft.normalized || normalizedRight.normalized;
  if (normalizedLeft.value > Number.MAX_SAFE_INTEGER - normalizedRight.value) {
    return { value: Number.MAX_SAFE_INTEGER, overflowed: true };
  }
  return {
    value: normalizedLeft.value + normalizedRight.value,
    overflowed: normalized,
  };
}

function normalizeNonNegativeSafeInteger(value: number): { value: number; normalized: boolean } {
  if (Number.isSafeInteger(value) && value >= 0) return { value, normalized: false };
  if (!Number.isFinite(value)) {
    return { value: value === Number.POSITIVE_INFINITY ? Number.MAX_SAFE_INTEGER : 0, normalized: true };
  }
  if (value <= 0) return { value: 0, normalized: true };
  return {
    value: Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)),
    normalized: true,
  };
}

export function buildHistoryInsightsEntityId(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
}

function maxIso(current: string | undefined, next: string | undefined): string | undefined {
  if (!next || !Number.isFinite(Date.parse(next))) return current;
  if (!current || !Number.isFinite(Date.parse(current))) return next;
  const currentMs = Date.parse(current);
  const nextMs = Date.parse(next);
  return nextMs > currentMs ? next : current;
}

function resolveProjectContext(
  input: HistoryInsightsAggregationInput,
  entry: SessionAnalysisEntry | undefined,
  identityKey: string,
  projectKey: string,
  projectLabel: string,
): HistoryInsightsAggregationProjectContext {
  const resolved =
    input.projectContextBySessionKey?.get(identityKey) ??
    (entry ? input.projectContextBySessionKey?.get(entry.cacheKey) : undefined);
  if (resolved) return resolved;
  const displayName = String(projectLabel || input.unknownProjectLabel || "").trim();
  return {
    contextKey: projectKey || `unknown:${identityKey}`,
    displayName,
    pathHint: "",
    physicalCwd: "",
  };
}

function selectMostFrequentPath(values: ReadonlyMap<string, number>): string | undefined {
  return Array.from(values.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
}
