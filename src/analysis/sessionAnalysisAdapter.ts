import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import {
  buildChatSessionModel,
} from "../chat/chatModelBuilder";
import {
  detectClaudeMaterializedMessageRole,
  extractClaudeLocalCommandOutputContent,
  extractClaudeMessageContent,
  extractClaudeRequestInterruptionContent,
} from "../chat/chatAttachments";
import type {
  ChatMessageItem,
  ChatPatchGroupItem,
  ChatRateLimit,
  ChatRateLimits,
  ChatTimelineItem,
  ChatTokenUsage,
  ChatTokenUsageField,
  ChatTurnSummary,
  ChatUsageItem,
} from "../chat/chatTypes";
import type { SessionSummary } from "../sessions/sessionTypes";
import { normalizeCacheKey } from "../utils/fsUtils";
import { stableTextSha256 } from "../utils/stableTextHash";
import { extractCompactUserText, safeDisplayPath } from "../utils/textUtils";
import {
  normalizeSessionAnalysisGraphIdentifier,
  normalizeSessionAnalysisProjectCwd,
  normalizeSessionAnalysisTimestamp,
  SESSION_ANALYSIS_CLAUDE_PARSER_VERSION,
  SESSION_ANALYSIS_CODEX_PARSER_VERSION,
  SESSION_ANALYSIS_MAX_FILE_CHANGE_ENTRIES,
  SESSION_ANALYSIS_MAX_PATH_LENGTH,
  type AnalysisAvailability,
  type AnalysisNumber,
  type ClaudeGraphRecordOccurrence,
  type ClaudeSidechainState,
  type ClaudeVisibleMessageAnchor,
  type ModelEffortUsageStats,
  type ModelUsageStats,
  type RateLimitSnapshot,
  type RateLimitValue,
  type SessionAnalysisEntry,
  type SessionFileChangeEntry,
  type SessionFileChangeStats,
  type SessionMessageStats,
  type SessionUsageStats,
} from "./sessionAnalysisTypes";

const MAX_WARNINGS = 20;
const MAX_GRAPH_PREVIEW_LENGTH = 180;
const MAX_GRAPH_RECORDS = 100_000;
const MAX_VISIBLE_PARENT_HIDDEN_DEPTH = 10_000;
const MAX_MODEL_USAGE = 2_000;
const MAX_MODEL_EFFORT_USAGE = 2_000;
const MAX_TOOL_USAGE = 2_000;
const MAX_TOOL_NAME_LENGTH = 256;
const GRAPH_NORMALIZATION_VERSION = 2;

export interface SessionAnalysisAdapterInput {
  session: SessionSummary;
  mtimeMs: number;
  size: number;
  claudeSessionsRoot: string;
}

interface JsonlScanResult {
  malformedLineCount: number;
  invalidTimestamp: boolean;
  latestCodexCumulativeUsage?: ChatTokenUsage;
  claudeRecords: RawClaudeRecord[];
  claudeGraphRecordsTruncated: boolean;
  claudeGraphIdentifierInvalid: boolean;
  claudeSidechainState: ClaudeSidechainState;
}

interface RawClaudeRecord {
  recordOrdinal: number;
  recordUuid?: string;
  parentUuid?: string;
  logicalParentUuid?: string;
  sessionId?: string;
  timestampIso?: string;
  type: string;
  promptId?: string;
  requestId?: string;
  isMeta: boolean;
  isSidechain?: boolean;
  subtype?: string;
  compactBoundary: boolean;
  humanCandidate?: {
    fingerprint: string;
    preview: string;
  };
}

interface RawClaudeRecordBuildResult {
  record: RawClaudeRecord;
  invalidGraphIdentifier: boolean;
}

interface VisibleParentResolution {
  visibleUuid?: string;
  hiddenDistance?: number;
}

interface UsageStatsBuildResult {
  stats: SessionUsageStats;
  modelUsageTruncated: boolean;
  modelEffortUsageTruncated: boolean;
  tokenOverflow: boolean;
}

interface SafeTokenAccumulator {
  value: number;
  overflowed: boolean;
}

interface ModelUsageAccumulator {
  model: string;
  inputTokens: SafeTokenAccumulator;
  outputTokens: SafeTokenAccumulator;
  totalTokens: SafeTokenAccumulator;
}

interface SafeFileChangeAccumulator {
  value: number;
  overflowed: boolean;
}

interface FileChangeEntryAccumulator {
  normalizedPath: string;
  displayPath: string;
  changeEventCount: SafeFileChangeAccumulator;
  linesAdded: SafeFileChangeAccumulator;
  linesRemoved: SafeFileChangeAccumulator;
  firstTimestampIso?: string;
  lastTimestampIso?: string;
  chatMessageIndex?: number;
}

export interface FileChangeStatsBuildResult {
  stats: SessionFileChangeStats;
  entryPartial: boolean;
  warnings: string[];
}

interface RateLimitSnapshotBuildResult {
  snapshot?: RateLimitSnapshot;
  invalidValue: boolean;
  invalidTimestamp: boolean;
}

interface ClaudeVisibleMessageAnchorsBuildResult {
  anchors: ClaudeVisibleMessageAnchor[];
  invalidTimestamp: boolean;
}

export class CodexSessionAnalysisAdapter {
  public async analyze(input: SessionAnalysisAdapterInput): Promise<SessionAnalysisEntry> {
    if (input.session.source !== "codex") throw new Error("Codex adapter received a non-Codex session.");
    return analyzeSessionFile(input);
  }
}

export class ClaudeSessionAnalysisAdapter {
  public async analyze(input: SessionAnalysisAdapterInput): Promise<SessionAnalysisEntry> {
    if (input.session.source !== "claude") throw new Error("Claude adapter received a non-Claude session.");
    return analyzeSessionFile(input);
  }
}

export async function analyzeSessionFile(input: SessionAnalysisAdapterInput): Promise<SessionAnalysisEntry> {
  const { session } = input;
  const warnings: string[] = [];
  try {
    const model = await buildChatSessionModel(session.fsPath, {
      includeDetails: false,
      turnTimelineMode: "basic",
      images: { enabled: false, maxSizeMB: 1, thumbnailSize: "small" },
    });
    const scan = await scanJsonl(session.fsPath, session.source === "claude", session.meta.cwd);
    if (scan.malformedLineCount > 0) warnings.push(`malformedLines:${scan.malformedLineCount}`);
    if (scan.claudeGraphRecordsTruncated) warnings.push("claudeGraphRecordLimitReached");
    if (scan.claudeGraphIdentifierInvalid) warnings.push("graphIdentifierInvalid");

    const availability: AnalysisAvailability = scan.malformedLineCount > 0 ? "partial" : "available";
    const usageResult = buildUsageStats(model.items, session.source, scan.latestCodexCumulativeUsage, availability);
    if (usageResult.modelUsageTruncated) warnings.push(`modelUsageLimit:${MAX_MODEL_USAGE}`);
    if (usageResult.modelEffortUsageTruncated) warnings.push(`modelEffortUsageLimit:${MAX_MODEL_EFFORT_USAGE}`);
    if (usageResult.tokenOverflow) warnings.push("tokenUsageOverflow");
    const projectCwd = normalizeSessionAnalysisProjectCwd(session.meta.cwd);
    const projectCwdInvalid = session.meta.cwd !== undefined && projectCwd === undefined;
    if (projectCwdInvalid) warnings.push("projectCwdInvalid");
    const fileChangeResult = buildFileChangeStats(model.items, availability, projectCwd);
    for (const warning of fileChangeResult.warnings) {
      if (!warnings.includes(warning)) warnings.push(warning);
    }
    const claudeVisibleMessages = session.source === "claude"
      ? buildClaudeVisibleMessageAnchors(model.items)
      : { anchors: [], invalidTimestamp: false };
    const claudeGraphRecords =
      session.source === "claude"
        ? buildClaudeGraphOccurrences(session, model.items, scan.claudeRecords, claudeVisibleMessages.anchors, warnings)
        : [];
    const rateLimitResult = buildLatestRateLimitSnapshot(session.cacheKey, model.items);
    if (rateLimitResult.invalidValue && !warnings.includes("rateLimitValueInvalid")) {
      warnings.push("rateLimitValueInvalid");
    }
    const startedAtIso = normalizeSessionAnalysisTimestamp(session.startedAtIso);
    const lastActivityAtIso = normalizeSessionAnalysisTimestamp(session.lastActivityAtIso);
    const timestampInvalid =
      scan.invalidTimestamp ||
      fileChangeResult.warnings.includes("timestampInvalid") ||
      claudeVisibleMessages.invalidTimestamp ||
      rateLimitResult.invalidTimestamp ||
      (session.startedAtIso !== undefined && startedAtIso === undefined) ||
      (session.lastActivityAtIso !== undefined && lastActivityAtIso === undefined);
    if (timestampInvalid && !warnings.includes("timestampInvalid")) warnings.push("timestampInvalid");

    const messageStats = buildMessageStats(model.items, model.turns, session.source, availability);
    if (model.items.some((item) => item.type === "tool" && item.name.trim().length > MAX_TOOL_NAME_LENGTH)) {
      warnings.push("toolNameTruncated");
    }
    if (
      messageStats.toolUsage.length >= MAX_TOOL_USAGE &&
      new Set(model.items.filter((item) => item.type === "tool").map((item) => normalizeToolName(item.name))).size > MAX_TOOL_USAGE
    ) {
      warnings.push(`toolUsageLimit:${MAX_TOOL_USAGE}`);
    }
    return {
      cacheKey: session.cacheKey,
      identityKey: session.identityKey,
      fsPath: session.fsPath,
      source: session.source,
      storage: session.storage,
      ...(projectCwd ? { projectCwd } : {}),
      ...(startedAtIso ? { startedAtIso } : {}),
      ...(lastActivityAtIso ? { lastActivityAtIso } : {}),
      mtimeMs: input.mtimeMs,
      size: input.size,
      parserVersion:
        session.source === "codex" ? SESSION_ANALYSIS_CODEX_PARSER_VERSION : SESSION_ANALYSIS_CLAUDE_PARSER_VERSION,
      completeness:
        scan.malformedLineCount > 0 ||
        scan.claudeGraphRecordsTruncated ||
        scan.claudeGraphIdentifierInvalid ||
        usageResult.modelUsageTruncated ||
        usageResult.modelEffortUsageTruncated ||
        usageResult.tokenOverflow ||
        fileChangeResult.entryPartial ||
        rateLimitResult.invalidValue ||
        timestampInvalid ||
        projectCwdInvalid ||
        warnings.includes("graphSessionIdInvalid") ||
        warnings.includes("toolNameTruncated") ||
        warnings.some((warning) => warning.startsWith("toolUsageLimit:"))
          ? "partial"
          : "complete",
      messageStats,
      usageStats: usageResult.stats,
      fileChangeStats: fileChangeResult.stats,
      ...(rateLimitResult.snapshot ? { latestRateLimitSnapshot: rateLimitResult.snapshot } : {}),
      claudeGraphRecords,
      ...(session.source === "claude"
        ? {
            claudeMessageBounds: {
              ...(claudeVisibleMessages.anchors[0] ? { first: claudeVisibleMessages.anchors[0] } : {}),
              ...(claudeVisibleMessages.anchors.at(-1) ? { last: claudeVisibleMessages.anchors.at(-1) } : {}),
            },
            claudePhysicalProjectFolderKey: buildClaudePhysicalProjectFolderKey(
              session.fsPath,
              input.claudeSessionsRoot,
            ),
            claudeIsSidechain: scan.claudeSidechainState,
          }
        : {}),
      warnings: warnings.slice(0, MAX_WARNINGS),
    };
  } catch (error) {
    return buildFailedEntry(input, error);
  }
}

function buildMessageStats(
  items: readonly ChatTimelineItem[],
  turns: readonly ChatTurnSummary[] | undefined,
  source: SessionSummary["source"],
  availability: AnalysisAvailability,
): SessionMessageStats {
  const messages = items.filter((item): item is ChatMessageItem => item.type === "message");
  const tools = items.filter((item) => item.type === "tool");
  const available = (value: number): AnalysisNumber => ({ value, availability });
  const unavailable = (): AnalysisNumber => ({ availability: "unavailable" });
  const codexTurns = source === "codex" ? turns ?? [] : [];
  const toolCounts = new Map<string, number>();
  for (const tool of tools) {
    const name = normalizeToolName(tool.name);
    toolCounts.set(name, Math.min(Number.MAX_SAFE_INTEGER, (toolCounts.get(name) ?? 0) + 1));
  }
  const toolUsage = Array.from(toolCounts, ([name, callCount]) => ({ name, callCount }))
    .sort((left, right) => right.callCount - left.callCount || left.name.localeCompare(right.name))
    .slice(0, MAX_TOOL_USAGE);
  return {
    userMessageCount: available(messages.filter((item) => item.role === "user" && item.isContext !== true).length),
    assistantMessageCount: available(messages.filter((item) => item.role === "assistant").length),
    developerMessageCount: available(messages.filter((item) => item.role === "developer").length),
    toolCallCount: available(tools.length),
    toolOutputCount: available(tools.filter((item) => Boolean(item.outputText) || item.detailsOmitted === true).length),
    turnCount: source === "codex" ? available(codexTurns.length) : unavailable(),
    completedTurnCount:
      source === "codex" ? available(codexTurns.filter((turn) => turn.status === "completed").length) : unavailable(),
    interruptedTurnCount:
      source === "codex" ? available(codexTurns.filter((turn) => turn.status === "interrupted").length) : unavailable(),
    rolledBackTurnCount:
      source === "codex" ? available(codexTurns.filter((turn) => turn.status === "rolledBack").length) : unavailable(),
    toolUsage,
  };
}

function normalizeToolName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  return (name || "unknown").slice(0, MAX_TOOL_NAME_LENGTH);
}

function buildUsageStats(
  items: readonly ChatTimelineItem[],
  source: SessionSummary["source"],
  cumulativeFallback: ChatTokenUsage | undefined,
  completeAvailability: AnalysisAvailability,
): UsageStatsBuildResult {
  const usageItems = items.filter(
    (item): item is ChatUsageItem => item.type === "usage" && (source !== "codex" || Boolean(item.turnId)),
  );
  if (usageItems.length === 0 && source === "codex" && cumulativeFallback) {
    return buildCumulativeFallbackUsage(cumulativeFallback);
  }
  if (usageItems.length === 0) {
    return {
      stats: emptyUsageStats(),
      modelUsageTruncated: false,
      modelEffortUsageTruncated: false,
      tokenOverflow: false,
    };
  }

  const totals: Record<
    "inputTokens" | "outputTokens" | "cachedInputTokens" | "cacheReadInputTokens" |
    "cacheCreationInputTokens" | "reasoningOutputTokens",
    SafeTokenAccumulator
  > = {
    inputTokens: createSafeTokenAccumulator(),
    outputTokens: createSafeTokenAccumulator(),
    cachedInputTokens: createSafeTokenAccumulator(),
    cacheReadInputTokens: createSafeTokenAccumulator(),
    cacheCreationInputTokens: createSafeTokenAccumulator(),
    reasoningOutputTokens: createSafeTokenAccumulator(),
  };
  const derivedTotal = createSafeTokenAccumulator();
  let reportedTotal: number | undefined;
  let reportedTotalOverflowed = false;
  let tokenOverflow = false;
  const byModel = new Map<string, ModelUsageAccumulator>();
  const byModelEffort = new Map<string, Map<string, SafeTokenAccumulator>>();
  for (const item of usageItems) {
    const itemHasInvalidTokenField =
      (item.usage.invalidFields?.length ?? 0) > 0 ||
      (item.totalUsage?.invalidFields?.length ?? 0) > 0;
    if (itemHasInvalidTokenField) tokenOverflow = true;
    if (addTokenUsage(totals, item.usage)) tokenOverflow = true;
    const usageTotal = resolveUsageTotal(item.usage);
    if (usageTotal.overflowed) {
      derivedTotal.overflowed = true;
      tokenOverflow = true;
    } else if (addSafeToken(derivedTotal, usageTotal.value ?? 0)) {
      tokenOverflow = true;
    }
    const reported = resolveOptionalUsageTotal(item.totalUsage);
    if (reported.overflowed) {
      reportedTotal = undefined;
      reportedTotalOverflowed = true;
      tokenOverflow = true;
    } else if (reported.value !== undefined) {
      reportedTotal = reported.value;
      reportedTotalOverflowed = false;
    }
    const model = normalizeLabel(item.model) || "unknown";
    const current = byModel.get(model) ?? {
      model,
      inputTokens: createSafeTokenAccumulator(),
      outputTokens: createSafeTokenAccumulator(),
      totalTokens: createSafeTokenAccumulator(),
    };
    if (hasInvalidTokenField(item.usage, "inputTokens")) {
      current.inputTokens.overflowed = true;
      tokenOverflow = true;
    } else if (addSafeToken(current.inputTokens, normalizeToken(item.usage.inputTokens) ?? 0)) {
      tokenOverflow = true;
    }
    if (hasInvalidTokenField(item.usage, "outputTokens")) {
      current.outputTokens.overflowed = true;
      tokenOverflow = true;
    } else if (addSafeToken(current.outputTokens, normalizeToken(item.usage.outputTokens) ?? 0)) {
      tokenOverflow = true;
    }
    if (itemHasInvalidTokenField || usageTotal.overflowed) {
      current.totalTokens.overflowed = true;
    } else if (addSafeToken(current.totalTokens, usageTotal.value ?? 0)) {
      tokenOverflow = true;
    }
    byModel.set(model, current);
    if (source === "codex") {
      const effort = normalizeLabel(item.effort).slice(0, 80) || "unspecified";
      const effortTotals = byModelEffort.get(model) ?? new Map<string, SafeTokenAccumulator>();
      const effortTotal = effortTotals.get(effort) ?? createSafeTokenAccumulator();
      if (itemHasInvalidTokenField || usageTotal.overflowed) {
        effortTotal.overflowed = true;
      } else if (addSafeToken(effortTotal, usageTotal.value ?? 0)) {
        tokenOverflow = true;
      }
      effortTotals.set(effort, effortTotal);
      byModelEffort.set(model, effortTotals);
    }
  }
  if (Object.values(totals).some((value) => value.overflowed) || derivedTotal.overflowed) tokenOverflow = true;
  const allModelUsage = Array.from(byModel.values()).flatMap((value): ModelUsageStats[] => {
    if (value.inputTokens.overflowed || value.outputTokens.overflowed || value.totalTokens.overflowed) {
      tokenOverflow = true;
      return [];
    }
    return [{
      model: value.model,
      inputTokens: value.inputTokens.value,
      outputTokens: value.outputTokens.value,
      totalTokens: value.totalTokens.value,
    }];
  }).sort(compareModelUsage);
  const modelUsageTruncated = allModelUsage.length > MAX_MODEL_USAGE;
  const modelUsage = allModelUsage.slice(0, MAX_MODEL_USAGE);
  const retainedModels = new Set(modelUsage.map((value) => value.model));
  const allModelEffortUsage = Array.from(byModelEffort, ([model, efforts]) => {
    if (!retainedModels.has(model)) return [];
    return Array.from(efforts, ([effort, totalTokens]): ModelEffortUsageStats[] => {
      if (totalTokens.overflowed) {
        tokenOverflow = true;
        return [];
      }
      return [{ model, effort, totalTokens: totalTokens.value }];
    }).flat();
  }).flat().sort(compareModelEffortUsage);
  const modelEffortUsageTruncated = allModelEffortUsage.length > MAX_MODEL_EFFORT_USAGE;
  const metric = (value: SafeTokenAccumulator): AnalysisNumber =>
    value.overflowed ? { availability: "unavailable" } : { value: value.value, availability: completeAvailability };
  return {
    stats: {
      inputTokens: metric(totals.inputTokens),
      outputTokens: metric(totals.outputTokens),
      cachedInputTokens: metric(totals.cachedInputTokens),
      cacheReadInputTokens: metric(totals.cacheReadInputTokens),
      cacheCreationInputTokens: metric(totals.cacheCreationInputTokens),
      reasoningOutputTokens: metric(totals.reasoningOutputTokens),
      reportedTotalTokens:
        reportedTotal === undefined || reportedTotalOverflowed
          ? { availability: "unavailable" }
          : { value: reportedTotal, availability: completeAvailability },
      derivedTotalTokens: metric(derivedTotal),
      modelUsage,
      modelEffortUsage: allModelEffortUsage.slice(0, MAX_MODEL_EFFORT_USAGE),
      aggregationMethod: tokenOverflow
        ? "mixedPartial"
        : source === "codex"
          ? "codexLastUsageSum"
          : "claudeMessageSum",
    },
    modelUsageTruncated,
    modelEffortUsageTruncated,
    tokenOverflow,
  };
}

function buildCumulativeFallbackUsage(usage: ChatTokenUsage): UsageStatsBuildResult {
  const partial = (field: ChatTokenUsageField): AnalysisNumber => {
    if (hasInvalidTokenField(usage, field)) return { availability: "unavailable" };
    const value = normalizeToken(usage[field]);
    return value === undefined ? { availability: "unavailable" } : { value, availability: "partial" };
  };
  const total = resolveOptionalUsageTotal(usage);
  const tokenOverflow = (usage.invalidFields?.length ?? 0) > 0 || total.overflowed;
  return {
    stats: {
      inputTokens: partial("inputTokens"),
      outputTokens: partial("outputTokens"),
      cachedInputTokens: partial("cachedInputTokens"),
      cacheReadInputTokens: partial("cacheReadInputTokens"),
      cacheCreationInputTokens: partial("cacheCreationInputTokens"),
      reasoningOutputTokens: partial("reasoningOutputTokens"),
      reportedTotalTokens:
        total.overflowed || total.value === undefined
          ? { availability: "unavailable" }
          : { value: total.value, availability: "partial" },
      derivedTotalTokens:
        total.overflowed || total.value === undefined
          ? { availability: "unavailable" }
          : { value: total.value, availability: "partial" },
      modelUsage: [],
      modelEffortUsage: [],
      aggregationMethod: tokenOverflow ? "mixedPartial" : "codexCumulativeFallback",
    },
    modelUsageTruncated: false,
    modelEffortUsageTruncated: false,
    tokenOverflow,
  };
}

function emptyUsageStats(): SessionUsageStats {
  const unavailable = (): AnalysisNumber => ({ availability: "unavailable" });
  return {
    inputTokens: unavailable(),
    outputTokens: unavailable(),
    cachedInputTokens: unavailable(),
    cacheReadInputTokens: unavailable(),
    cacheCreationInputTokens: unavailable(),
    reasoningOutputTokens: unavailable(),
    reportedTotalTokens: unavailable(),
    derivedTotalTokens: unavailable(),
    modelUsage: [],
    modelEffortUsage: [],
    aggregationMethod: "unavailable",
  };
}

export function buildFileChangeStats(
  items: readonly ChatTimelineItem[],
  availability: AnalysisAvailability,
  sessionCwd: string | undefined,
): FileChangeStatsBuildResult {
  const groups = items.filter((item): item is ChatPatchGroupItem => item.type === "patchGroup");
  const byPath = new Map<string, FileChangeEntryAccumulator>();
  const changeEventCount = createSafeFileChangeAccumulator();
  const linesAdded = createSafeFileChangeAccumulator();
  const linesRemoved = createSafeFileChangeAccumulator();
  let unresolvedPathCount = 0;
  let invalidTimestamp = false;
  for (const group of groups) {
    const groupTimestampIso = normalizeSessionAnalysisTimestamp(group.timestampIso);
    if (group.timestampIso !== undefined && groupTimestampIso === undefined) invalidTimestamp = true;
    for (const entry of group.entries) {
      addSafeFileChangeValue(changeEventCount, 1);
      addSafeFileChangeValue(linesAdded, entry.added);
      addSafeFileChangeValue(linesRemoved, entry.removed);
      const rawPath = entry.movePath || entry.path;
      const normalizedPath = resolveAnalysisFilePath(rawPath, sessionCwd);
      if (!normalizedPath) {
        unresolvedPathCount += 1;
        continue;
      }
      const rawDisplayPath = normalizeLabel(entry.moveDisplayPath ?? entry.displayPath) || path.basename(normalizedPath);
      const current = byPath.get(normalizedPath) ?? {
        normalizedPath,
        displayPath: safeDisplayPath(rawDisplayPath, 160),
        changeEventCount: createSafeFileChangeAccumulator(),
        linesAdded: createSafeFileChangeAccumulator(),
        linesRemoved: createSafeFileChangeAccumulator(),
      };
      addSafeFileChangeValue(current.changeEventCount, 1);
      addSafeFileChangeValue(current.linesAdded, entry.added);
      addSafeFileChangeValue(current.linesRemoved, entry.removed);
      if (groupTimestampIso) {
        current.firstTimestampIso = minIso(current.firstTimestampIso, groupTimestampIso);
        current.lastTimestampIso = maxIso(current.lastTimestampIso, groupTimestampIso);
      }
      if (typeof group.messageIndex === "number" && group.messageIndex > 0) current.chatMessageIndex = group.messageIndex;
      byPath.set(normalizedPath, current);
    }
  }

  let fileChangeEventCountOverflow = false;
  let fileLinesAddedOverflow = false;
  let fileLinesRemovedOverflow = false;
  const files = Array.from(byPath.values()).flatMap((current): SessionFileChangeEntry[] => {
    fileChangeEventCountOverflow ||= current.changeEventCount.overflowed;
    fileLinesAddedOverflow ||= current.linesAdded.overflowed;
    fileLinesRemovedOverflow ||= current.linesRemoved.overflowed;
    if (
      current.changeEventCount.overflowed ||
      current.linesAdded.overflowed ||
      current.linesRemoved.overflowed
    ) {
      return [];
    }
    return [{
      normalizedPath: current.normalizedPath,
      displayPath: current.displayPath,
      changeEventCount: current.changeEventCount.value,
      linesAdded: current.linesAdded.value,
      linesRemoved: current.linesRemoved.value,
      ...(current.firstTimestampIso ? { firstTimestampIso: current.firstTimestampIso } : {}),
      ...(current.lastTimestampIso ? { lastTimestampIso: current.lastTimestampIso } : {}),
      ...(current.chatMessageIndex ? { chatMessageIndex: current.chatMessageIndex } : {}),
    }];
  }).sort(compareFileChangeEntries);

  const entriesTruncated = byPath.size > SESSION_ANALYSIS_MAX_FILE_CHANGE_ENTRIES;
  const numericOverflow =
    changeEventCount.overflowed ||
    linesAdded.overflowed ||
    linesRemoved.overflowed ||
    fileChangeEventCountOverflow ||
    fileLinesAddedOverflow ||
    fileLinesRemovedOverflow;
  const fileAvailability: AnalysisAvailability =
    availability === "partial" ||
    unresolvedPathCount > 0 ||
    entriesTruncated ||
    numericOverflow ||
    invalidTimestamp
      ? "partial"
      : "available";
  const metric = (value: SafeFileChangeAccumulator): AnalysisNumber =>
    value.overflowed
      ? { availability: "unavailable" }
      : { value: value.value, availability: fileAvailability };
  const warnings: string[] = [];
  if (entriesTruncated) warnings.push(`fileChangeEntryLimit:${SESSION_ANALYSIS_MAX_FILE_CHANGE_ENTRIES}`);
  if (changeEventCount.overflowed || fileChangeEventCountOverflow) {
    warnings.push("fileChangeEventCountOverflow");
  }
  if (linesAdded.overflowed || fileLinesAddedOverflow) warnings.push("fileChangeLinesAddedOverflow");
  if (linesRemoved.overflowed || fileLinesRemovedOverflow) warnings.push("fileChangeLinesRemovedOverflow");
  if (unresolvedPathCount > 0) warnings.push(`fileChangePathUnresolved:${unresolvedPathCount}`);
  if (invalidTimestamp) warnings.push("timestampInvalid");
  return {
    stats: {
      changeEventCount: metric(changeEventCount),
      distinctFileCount: { value: byPath.size, availability: fileAvailability },
      linesAdded: metric(linesAdded),
      linesRemoved: metric(linesRemoved),
      files: files.slice(0, SESSION_ANALYSIS_MAX_FILE_CHANGE_ENTRIES),
    },
    entryPartial: entriesTruncated || numericOverflow || unresolvedPathCount > 0 || invalidTimestamp,
    warnings,
  };
}

export function resolveAnalysisFilePath(rawPath: string, sessionCwd: string | undefined): string | undefined {
  let cleaned = String(rawPath ?? "").trim().replace(/^"|"$/gu, "");
  const tabIndex = cleaned.indexOf("\t");
  if (tabIndex >= 0) cleaned = cleaned.slice(0, tabIndex).trim();
  if (cleaned.startsWith("a/") || cleaned.startsWith("b/")) cleaned = cleaned.slice(2);
  if (!cleaned || cleaned === "/dev/null") return undefined;
  if (path.isAbsolute(cleaned)) {
    const normalizedPath = normalizeCacheKey(path.normalize(cleaned));
    return normalizedPath.length <= SESSION_ANALYSIS_MAX_PATH_LENGTH ? normalizedPath : undefined;
  }
  const cwd = String(sessionCwd ?? "").trim();
  if (!cwd || !path.isAbsolute(cwd)) return undefined;
  const normalizedPath = normalizeCacheKey(path.resolve(cwd, cleaned));
  return normalizedPath.length <= SESSION_ANALYSIS_MAX_PATH_LENGTH ? normalizedPath : undefined;
}

function buildLatestRateLimitSnapshot(
  cacheKey: string,
  items: readonly ChatTimelineItem[],
): RateLimitSnapshotBuildResult {
  let latest: ChatUsageItem | undefined;
  let invalidValue = false;
  let invalidTimestamp = false;
  for (const item of items) {
    if (item.type !== "usage" || !item.rateLimits) continue;
    if ((item.rateLimits.invalidFields?.length ?? 0) > 0) invalidValue = true;
    if (
      item.timestampIso !== undefined &&
      normalizeSessionAnalysisTimestamp(item.timestampIso) === undefined
    ) {
      invalidTimestamp = true;
    }
    if (!latest || compareIso(item.timestampIso, latest.timestampIso) >= 0) latest = item;
  }
  if (!latest?.rateLimits) return { invalidValue, invalidTimestamp };
  const normalized = toRateLimitSnapshot(cacheKey, latest.timestampIso, latest.rateLimits);
  return {
    ...(normalized.snapshot ? { snapshot: normalized.snapshot } : {}),
    invalidValue: invalidValue || normalized.invalidValue,
    invalidTimestamp: invalidTimestamp || normalized.invalidTimestamp,
  };
}

function toRateLimitSnapshot(
  cacheKey: string,
  observedAtIso: string | undefined,
  limits: ChatRateLimits,
): RateLimitSnapshotBuildResult {
  const primary = normalizeRateLimitValue(limits.primary);
  const secondary = normalizeRateLimitValue(limits.secondary);
  const normalizedObservedAtIso = normalizeSessionAnalysisTimestamp(observedAtIso);
  const invalidTimestamp = observedAtIso !== undefined && normalizedObservedAtIso === undefined;
  const hasSnapshotValue = Boolean(primary.value || secondary.value || limits.planType || limits.limitName);
  if (!hasSnapshotValue) {
    return {
      invalidValue:
        primary.invalidValue ||
        secondary.invalidValue ||
        (limits.invalidFields?.length ?? 0) > 0,
      invalidTimestamp,
    };
  }
  return {
    snapshot: {
      ...(normalizedObservedAtIso ? { observedAtIso: normalizedObservedAtIso } : {}),
      sourceSessionCacheKey: cacheKey,
      ...(primary.value ? { primary: primary.value } : {}),
      ...(secondary.value ? { secondary: secondary.value } : {}),
      ...(limits.planType ? { planType: limits.planType } : {}),
      ...(limits.limitName ? { limitName: limits.limitName } : {}),
      recordedBy: "localSession",
    },
    invalidValue:
      primary.invalidValue ||
      secondary.invalidValue ||
      (limits.invalidFields?.length ?? 0) > 0,
    invalidTimestamp,
  };
}

function normalizeRateLimitValue(
  value: ChatRateLimit | undefined,
): { value?: RateLimitValue; invalidValue: boolean } {
  if (!value) return { invalidValue: false };
  const normalized: RateLimitValue = {};
  let invalidValue = false;
  for (const key of ["usedPercent", "windowMinutes", "resetsAt", "resetsInSeconds"] as const) {
    const rawValue = value[key];
    if (rawValue === undefined) continue;
    const valid =
      key === "usedPercent"
        ? Number.isFinite(rawValue) && rawValue >= 0 && rawValue <= Number.MAX_SAFE_INTEGER
        : Number.isSafeInteger(rawValue) && rawValue >= 0;
    if (valid) {
      normalized[key] = rawValue;
    } else {
      invalidValue = true;
    }
  }
  return Object.keys(normalized).length > 0
    ? { value: normalized, invalidValue }
    : { invalidValue };
}

async function scanJsonl(fsPath: string, collectClaudeRecords: boolean, sessionCwd?: string): Promise<JsonlScanResult> {
  const stream = fs.createReadStream(fsPath, { encoding: "utf8" });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let malformedLineCount = 0;
  let invalidTimestamp = false;
  let latestCodexCumulativeUsage: ChatTokenUsage | undefined;
  let observedSidechainTrue = false;
  let observedSidechainFalse = false;
  let claudeGraphRecordsTruncated = false;
  let claudeGraphIdentifierInvalid = false;
  const claudeRecords: RawClaudeRecord[] = [];
  let recordOrdinal = 0;
  try {
    for await (const line of reader) {
      recordOrdinal += 1;
      if (!line.trim()) continue;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        malformedLineCount += 1;
        continue;
      }
      if (hasInvalidRawTimestamp(obj)) invalidTimestamp = true;
      const cumulative = extractTokenUsage(obj?.payload?.info?.total_token_usage);
      if (cumulative) latestCodexCumulativeUsage = cumulative;
      if (!collectClaudeRecords) continue;
      if (obj?.isSidechain === true) observedSidechainTrue = true;
      else if (obj?.isSidechain === false) observedSidechainFalse = true;
      if (claudeRecords.length >= MAX_GRAPH_RECORDS) {
        claudeGraphRecordsTruncated = true;
        continue;
      }
      const builtRecord = await buildRawClaudeRecord(obj, recordOrdinal, sessionCwd);
      if (builtRecord.invalidGraphIdentifier) claudeGraphIdentifierInvalid = true;
      claudeRecords.push(builtRecord.record);
    }
  } finally {
    reader.close();
    stream.close();
  }
  return {
    malformedLineCount,
    invalidTimestamp,
    ...(latestCodexCumulativeUsage ? { latestCodexCumulativeUsage } : {}),
    claudeRecords,
    claudeGraphRecordsTruncated,
    claudeGraphIdentifierInvalid,
    claudeSidechainState: observedSidechainTrue ? true : observedSidechainFalse ? false : "unknown",
  };
}

function hasInvalidRawTimestamp(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  for (const candidate of [raw, raw.payload, raw.message]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const container = candidate as Record<string, unknown>;
    if (
      Object.prototype.hasOwnProperty.call(container, "timestamp") &&
      normalizeSessionAnalysisTimestamp(container.timestamp) === undefined
    ) {
      return true;
    }
  }
  return false;
}

async function buildRawClaudeRecord(
  obj: any,
  recordOrdinal: number,
  sessionCwd?: string,
): Promise<RawClaudeRecordBuildResult> {
  const role = detectClaudeMaterializedMessageRole(obj);
  const rawContent = getClaudeMessageContent(obj);
  let humanCandidate: RawClaudeRecord["humanCandidate"];
  if (
    role === "user" &&
    obj?.isMeta !== true &&
    !extractClaudeRequestInterruptionContent(rawContent) &&
    !extractClaudeLocalCommandOutputContent(rawContent)
  ) {
    const extracted = await extractClaudeMessageContent(
      rawContent,
      sessionCwd,
      { enabled: false, maxBytes: 1024 * 1024 },
      { role: "user" },
    );
    const compact = extractCompactUserText(extracted.text);
    if (compact || extracted.attachments.length > 0) {
      const normalized = normalizeGraphText(compact ?? extracted.text);
      humanCandidate = {
        fingerprint: fingerprintGraphText(normalized),
        preview: singleLine(normalized).slice(0, MAX_GRAPH_PREVIEW_LENGTH),
      };
    }
  }
  const recordUuid = normalizeOptionalGraphIdentifier(obj?.uuid);
  const parentUuid = normalizeOptionalGraphIdentifier(obj?.parentUuid);
  const logicalParentUuid = normalizeOptionalGraphIdentifier(obj?.logicalParentUuid);
  const sessionId = normalizeOptionalGraphIdentifier(obj?.sessionId);
  const promptId = normalizeOptionalGraphIdentifier(obj?.promptId);
  const requestId = normalizeOptionalGraphIdentifier(obj?.requestId);
  const subtype = normalizeOptionalGraphIdentifier(obj?.subtype ?? obj?.message?.subtype);
  const invalidGraphIdentifier = [
    recordUuid,
    parentUuid,
    logicalParentUuid,
    sessionId,
    promptId,
    requestId,
    subtype,
  ].some((candidate) => candidate.invalid);
  const type = normalizeLabel(obj?.type ?? role ?? "unknown") || "unknown";
  return {
    record: {
      recordOrdinal,
      ...(recordUuid.value ? { recordUuid: recordUuid.value } : {}),
      ...(parentUuid.value ? { parentUuid: parentUuid.value } : {}),
      ...(logicalParentUuid.value ? { logicalParentUuid: logicalParentUuid.value } : {}),
      ...(sessionId.value ? { sessionId: sessionId.value } : {}),
      ...optionalTimestamp("timestampIso", obj?.timestamp),
      type,
      ...(promptId.value ? { promptId: promptId.value } : {}),
      ...(requestId.value ? { requestId: requestId.value } : {}),
      isMeta: obj?.isMeta === true,
      ...(typeof obj?.isSidechain === "boolean" ? { isSidechain: obj.isSidechain } : {}),
      ...(subtype.value ? { subtype: subtype.value } : {}),
      compactBoundary: subtype.value === "compact_boundary" || type === "compact_boundary",
      ...(humanCandidate ? { humanCandidate } : {}),
    },
    invalidGraphIdentifier,
  };
}

export function buildClaudeGraphOccurrences(
  session: SessionSummary,
  items: readonly ChatTimelineItem[],
  records: readonly RawClaudeRecord[],
  visibleMessageAnchors: readonly ClaudeVisibleMessageAnchor[],
  warnings: string[],
): ClaudeGraphRecordOccurrence[] {
  const humanItems = items.filter(
    (item): item is ChatMessageItem =>
      item.type === "message" && item.role === "user" && item.isContext !== true && typeof item.messageIndex === "number",
  );
  const itemQueues = new Map<string, { items: ChatMessageItem[]; nextIndex: number }>();
  for (const item of humanItems) {
    const fingerprint = fingerprintGraphText(normalizeGraphText(item.requestText ?? item.text));
    const key = buildMessageMatchKey(item.timestampIso, fingerprint);
    const queue = itemQueues.get(key);
    if (queue) {
      queue.items.push(item);
    } else {
      itemQueues.set(key, { items: [item], nextIndex: 0 });
    }
  }
  const previousVisibleMessageByIndex = buildPreviousVisibleMessageByIndex(visibleMessageAnchors);

  const recordByUuid = new Map<string, RawClaudeRecord>();
  const visibleByUuid = new Set<string>();
  const visibleParentResolutionByUuid = new Map<string, VisibleParentResolution>();
  for (const record of records) {
    if (record.recordUuid) recordByUuid.set(record.recordUuid, record);
    if (record.recordUuid && record.humanCandidate) visibleByUuid.add(record.recordUuid);
  }

  const occurrences: ClaudeGraphRecordOccurrence[] = [];
  let unmatchedRecords = 0;
  let invalidFallbackSessionId = false;
  const fallbackSessionId = normalizeSessionAnalysisGraphIdentifier(session.meta.id);
  for (const record of records) {
    if (!record.humanCandidate) continue;
    const queue = itemQueues.get(buildMessageMatchKey(record.timestampIso, record.humanCandidate.fingerprint));
    const item = queue && queue.nextIndex < queue.items.length
      ? queue.items[queue.nextIndex++]
      : undefined;
    if (!item?.messageIndex) {
      unmatchedRecords += 1;
      continue;
    }
    const visibleParentUuid = resolveVisibleParentUuid(
      record,
      recordByUuid,
      visibleByUuid,
      visibleParentResolutionByUuid,
    );
    const occurrenceId = stableHash([
      session.cacheKey,
      String(record.recordOrdinal),
      record.recordUuid ?? "",
      String(item.messageIndex),
    ].join("\u0000"));
    const previousVisibleMessage = previousVisibleMessageByIndex.get(item.messageIndex);
    const sessionId = record.sessionId ?? fallbackSessionId;
    if (!record.sessionId && session.meta.id !== undefined && !fallbackSessionId) {
      invalidFallbackSessionId = true;
    }
    occurrences.push({
      occurrenceId,
      sessionCacheKey: session.cacheKey,
      sessionIdentityKey: session.identityKey,
      ...(sessionId ? { sessionId } : {}),
      ...(record.recordUuid ? { recordUuid: record.recordUuid } : {}),
      ...(record.parentUuid ? { parentUuid: record.parentUuid } : {}),
      ...(visibleParentUuid ? { visibleParentUuid } : {}),
      ...(record.logicalParentUuid ? { logicalParentUuid: record.logicalParentUuid } : {}),
      ...(record.timestampIso ? { timestampIso: record.timestampIso } : {}),
      type: record.type,
      ...(record.promptId ? { promptId: record.promptId } : {}),
      ...(record.requestId ? { requestId: record.requestId } : {}),
      isMeta: record.isMeta,
      ...(typeof record.isSidechain === "boolean" ? { isSidechain: record.isSidechain } : {}),
      ...(record.subtype ? { subtype: record.subtype } : {}),
      textFingerprint: record.humanCandidate.fingerprint,
      preview: record.humanCandidate.preview,
      chatMessageIndex: item.messageIndex,
      recordOrdinal: record.recordOrdinal,
      compactBoundary: record.compactBoundary,
      ...(previousVisibleMessage ? { previousVisibleMessage } : {}),
    });
  }
  const unmatchedItems = Array.from(itemQueues.values())
    .reduce((sum, queue) => sum + queue.items.length - queue.nextIndex, 0);
  if (unmatchedRecords > 0) warnings.push(`unmatchedClaudeRecords:${unmatchedRecords}`);
  if (unmatchedItems > 0) warnings.push(`unmatchedChatMessages:${unmatchedItems}`);
  if (invalidFallbackSessionId && !warnings.includes("graphSessionIdInvalid")) {
    warnings.push("graphSessionIdInvalid");
  }
  return occurrences;
}

function buildClaudeVisibleMessageAnchors(
  items: readonly ChatTimelineItem[],
): ClaudeVisibleMessageAnchorsBuildResult {
  let invalidTimestamp = false;
  const anchors = items.flatMap((item): ClaudeVisibleMessageAnchor[] => {
    if (
      item.type !== "message" ||
      (item.role !== "user" && item.role !== "assistant") ||
      item.isContext === true ||
      typeof item.messageIndex !== "number" ||
      !Number.isSafeInteger(item.messageIndex) ||
      item.messageIndex < 1
    ) {
      return [];
    }
    const timestampIso = normalizeSessionAnalysisTimestamp(item.timestampIso);
    if (item.timestampIso !== undefined && timestampIso === undefined) invalidTimestamp = true;
    return [{
      role: item.role,
      chatMessageIndex: item.messageIndex,
      ...(timestampIso ? { timestampIso } : {}),
      ...buildVisibleMessagePreview(item),
    }];
  });
  return { anchors, invalidTimestamp };
}

function buildVisibleMessagePreview(item: ChatMessageItem): { preview?: string } {
  const preview = singleLine(normalizeGraphText(item.requestText ?? item.text)).slice(0, MAX_GRAPH_PREVIEW_LENGTH);
  return preview ? { preview } : {};
}

function buildPreviousVisibleMessageByIndex(
  anchors: readonly ClaudeVisibleMessageAnchor[],
): ReadonlyMap<number, ClaudeVisibleMessageAnchor> {
  const previousByMessageIndex = new Map<number, ClaudeVisibleMessageAnchor>();
  let previous: ClaudeVisibleMessageAnchor | undefined;
  for (const anchor of anchors) {
    if (previous && previous.chatMessageIndex < anchor.chatMessageIndex) {
      previousByMessageIndex.set(anchor.chatMessageIndex, previous);
    }
    if (!previous || previous.chatMessageIndex < anchor.chatMessageIndex) {
      previous = anchor;
    }
  }
  return previousByMessageIndex;
}

function resolveVisibleParentUuid(
  record: RawClaudeRecord,
  recordByUuid: ReadonlyMap<string, RawClaudeRecord>,
  visibleByUuid: ReadonlySet<string>,
  resolutionByUuid: Map<string, VisibleParentResolution>,
): string | undefined {
  const startUuid = record.parentUuid ?? record.logicalParentUuid;
  if (!startUuid) return undefined;

  let next: string | undefined = startUuid;
  const path: string[] = [];
  const visited = new Set<string>();
  let resolution: VisibleParentResolution | undefined;
  while (next) {
    if (visibleByUuid.has(next)) {
      resolution = { visibleUuid: next, hiddenDistance: 0 };
      break;
    }
    if (resolutionByUuid.has(next)) {
      resolution = resolutionByUuid.get(next);
      break;
    }
    if (visited.has(next)) {
      resolution = {};
      break;
    }
    visited.add(next);
    path.push(next);
    const parent = recordByUuid.get(next);
    next = parent?.parentUuid ?? parent?.logicalParentUuid;
  }
  resolution ??= {};

  for (let index = path.length - 1; index >= 0; index -= 1) {
    resolution = resolution.visibleUuid !== undefined && resolution.hiddenDistance !== undefined
      ? {
          visibleUuid: resolution.visibleUuid,
          hiddenDistance: resolution.hiddenDistance + 1,
        }
      : {};
    resolutionByUuid.set(path[index]!, resolution);
  }

  const startResolution = visibleByUuid.has(startUuid)
    ? { visibleUuid: startUuid, hiddenDistance: 0 }
    : resolutionByUuid.get(startUuid);
  return (
    startResolution?.visibleUuid !== undefined &&
    startResolution.hiddenDistance !== undefined &&
    startResolution.hiddenDistance < MAX_VISIBLE_PARENT_HIDDEN_DEPTH
  )
    ? startResolution.visibleUuid
    : undefined;
}

function buildClaudePhysicalProjectFolderKey(fsPath: string, rootPath: string): string | undefined {
  const relative = path.relative(path.resolve(rootPath), path.resolve(path.dirname(fsPath)));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  const parts = relative.split(/[\\/]+/u).filter(Boolean);
  if (parts.length !== 1) return undefined;
  const normalized = parts[0]!.normalize("NFC");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function buildFailedEntry(input: SessionAnalysisAdapterInput, error: unknown): SessionAnalysisEntry {
  return buildUnavailableEntry(input, "failed", `analysisFailed:${sanitizeErrorName(error)}`);
}

export function buildUnsupportedSessionAnalysisEntry(
  input: SessionAnalysisAdapterInput,
  reason: "fileSizeLimit",
): SessionAnalysisEntry {
  return buildUnavailableEntry(input, "unsupported", `unsupported:${reason}`);
}

function buildUnavailableEntry(
  input: SessionAnalysisAdapterInput,
  completeness: "failed" | "unsupported",
  warning: string,
): SessionAnalysisEntry {
  const unavailable = (): AnalysisNumber => ({ availability: "unavailable" });
  const startedAtIso = normalizeSessionAnalysisTimestamp(input.session.startedAtIso);
  const lastActivityAtIso = normalizeSessionAnalysisTimestamp(input.session.lastActivityAtIso);
  const projectCwd = normalizeSessionAnalysisProjectCwd(input.session.meta.cwd);
  const projectCwdInvalid = input.session.meta.cwd !== undefined && projectCwd === undefined;
  const timestampInvalid =
    (input.session.startedAtIso !== undefined && startedAtIso === undefined) ||
    (input.session.lastActivityAtIso !== undefined && lastActivityAtIso === undefined);
  const messageStats: SessionMessageStats = {
    userMessageCount: unavailable(),
    assistantMessageCount: unavailable(),
    developerMessageCount: unavailable(),
    toolCallCount: unavailable(),
    toolOutputCount: unavailable(),
    turnCount: unavailable(),
    completedTurnCount: unavailable(),
    interruptedTurnCount: unavailable(),
    rolledBackTurnCount: unavailable(),
    toolUsage: [],
  };
  const fileChangeStats: SessionFileChangeStats = {
    changeEventCount: unavailable(),
    distinctFileCount: unavailable(),
    linesAdded: unavailable(),
    linesRemoved: unavailable(),
    files: [],
  };
  return {
    cacheKey: input.session.cacheKey,
    identityKey: input.session.identityKey,
    fsPath: input.session.fsPath,
    source: input.session.source,
    storage: input.session.storage,
    ...(projectCwd ? { projectCwd } : {}),
    ...(startedAtIso ? { startedAtIso } : {}),
    ...(lastActivityAtIso ? { lastActivityAtIso } : {}),
    mtimeMs: input.mtimeMs,
    size: input.size,
    parserVersion:
      input.session.source === "codex" ? SESSION_ANALYSIS_CODEX_PARSER_VERSION : SESSION_ANALYSIS_CLAUDE_PARSER_VERSION,
    completeness,
    messageStats,
    usageStats: emptyUsageStats(),
    fileChangeStats,
    claudeGraphRecords: [],
    ...(input.session.source === "claude"
      ? {
          claudeMessageBounds: {},
          claudePhysicalProjectFolderKey: buildClaudePhysicalProjectFolderKey(
            input.session.fsPath,
            input.claudeSessionsRoot,
          ),
          claudeIsSidechain: "unknown" as const,
        }
      : {}),
    warnings: [
      warning,
      ...(timestampInvalid ? ["timestampInvalid"] : []),
      ...(projectCwdInvalid ? ["projectCwdInvalid"] : []),
    ],
  };
}

function createSafeTokenAccumulator(): SafeTokenAccumulator {
  return { value: 0, overflowed: false };
}

function createSafeFileChangeAccumulator(): SafeFileChangeAccumulator {
  return { value: 0, overflowed: false };
}

function addSafeFileChangeValue(target: SafeFileChangeAccumulator, value: number): boolean {
  if (target.overflowed) return true;
  if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - target.value) {
    target.overflowed = true;
    return true;
  }
  target.value += value;
  return false;
}

function addSafeToken(target: SafeTokenAccumulator, value: number): boolean {
  if (target.overflowed) return true;
  if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - target.value) {
    target.overflowed = true;
    return true;
  }
  target.value += value;
  return false;
}

function addTokenUsage(
  target: Record<
    "inputTokens" | "outputTokens" | "cachedInputTokens" | "cacheReadInputTokens" |
    "cacheCreationInputTokens" | "reasoningOutputTokens",
    SafeTokenAccumulator
  >,
  usage: ChatTokenUsage,
): boolean {
  let overflowed = false;
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
    "reasoningOutputTokens",
  ] as const) {
    if (hasInvalidTokenField(usage, key)) {
      target[key].overflowed = true;
      overflowed = true;
    } else if (addSafeToken(target[key], normalizeToken(usage[key]) ?? 0)) {
      overflowed = true;
    }
  }
  return overflowed;
}

function extractTokenUsage(value: unknown): ChatTokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const usage: ChatTokenUsage = {};
  const invalidFields: ChatTokenUsageField[] = [];
  for (const [key, rawKey] of [
    ["inputTokens", "input_tokens"],
    ["outputTokens", "output_tokens"],
    ["cachedInputTokens", "cached_input_tokens"],
    ["cacheReadInputTokens", "cache_read_input_tokens"],
    ["cacheCreationInputTokens", "cache_creation_input_tokens"],
    ["reasoningOutputTokens", "reasoning_output_tokens"],
    ["totalTokens", "total_tokens"],
  ] as const) {
    if (!(rawKey in raw)) continue;
    const normalized = normalizeToken(raw[rawKey]);
    if (normalized === undefined) {
      invalidFields.push(key);
    } else {
      usage[key] = normalized;
    }
  }
  if (invalidFields.length > 0) usage.invalidFields = invalidFields;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function resolveUsageTotal(usage: ChatTokenUsage): { value?: number; overflowed: boolean } {
  if (hasInvalidTokenField(usage, "totalTokens")) return { overflowed: true };
  const total = normalizeToken(usage.totalTokens);
  if (total !== undefined) return { value: total, overflowed: false };
  if (hasInvalidTokenField(usage, "inputTokens") || hasInvalidTokenField(usage, "outputTokens")) {
    return { overflowed: true };
  }
  const accumulator = createSafeTokenAccumulator();
  addSafeToken(accumulator, normalizeToken(usage.inputTokens) ?? 0);
  addSafeToken(accumulator, normalizeToken(usage.outputTokens) ?? 0);
  return accumulator.overflowed
    ? { overflowed: true }
    : { value: accumulator.value, overflowed: false };
}

function resolveOptionalUsageTotal(
  usage: ChatTokenUsage | undefined,
): { value?: number; overflowed: boolean } {
  if (!usage) return { overflowed: false };
  if (hasInvalidTokenField(usage, "totalTokens")) return { overflowed: true };
  const total = normalizeToken(usage.totalTokens);
  if (total !== undefined) return { value: total, overflowed: false };
  if (hasInvalidTokenField(usage, "inputTokens") || hasInvalidTokenField(usage, "outputTokens")) {
    return { overflowed: true };
  }
  const input = normalizeToken(usage.inputTokens);
  const output = normalizeToken(usage.outputTokens);
  if (input === undefined && output === undefined) return { overflowed: false };
  const accumulator = createSafeTokenAccumulator();
  addSafeToken(accumulator, input ?? 0);
  addSafeToken(accumulator, output ?? 0);
  return accumulator.overflowed
    ? { overflowed: true }
    : { value: accumulator.value, overflowed: false };
}

function compareModelUsage(left: ModelUsageStats, right: ModelUsageStats): number {
  return right.totalTokens - left.totalTokens || compareStableText(left.model, right.model);
}

function compareModelEffortUsage(left: ModelEffortUsageStats, right: ModelEffortUsageStats): number {
  return right.totalTokens - left.totalTokens ||
    compareStableText(left.model, right.model) ||
    compareStableText(left.effort, right.effort);
}

function compareFileChangeEntries(left: SessionFileChangeEntry, right: SessionFileChangeEntry): number {
  return right.changeEventCount - left.changeEventCount ||
    compareStableText(left.displayPath, right.displayPath) ||
    compareStableText(left.normalizedPath, right.normalizedPath);
}

function compareStableText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function normalizeToken(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function hasInvalidTokenField(usage: ChatTokenUsage, field: ChatTokenUsageField): boolean {
  return usage.invalidFields?.includes(field) === true;
}

function normalizeLabel(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, 512) : "";
}

function optionalTimestamp<K extends string>(key: K, value: unknown): Partial<Record<K, string>> {
  const normalized = normalizeSessionAnalysisTimestamp(value);
  return normalized ? ({ [key]: normalized } as Partial<Record<K, string>>) : {};
}

function normalizeOptionalGraphIdentifier(value: unknown): { value?: string; invalid: boolean } {
  if (value === undefined || value === null) return { invalid: false };
  const normalized = normalizeSessionAnalysisGraphIdentifier(value);
  return normalized ? { value: normalized, invalid: false } : { invalid: true };
}

function getClaudeMessageContent(obj: any): unknown {
  if (obj?.message && typeof obj.message === "object" && "content" in obj.message) return obj.message.content;
  return obj && typeof obj === "object" && "content" in obj ? obj.content : undefined;
}

function normalizeGraphText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t ]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .trim();
}

function fingerprintGraphText(value: string): string {
  return `v${GRAPH_NORMALIZATION_VERSION}:${stableHash(value)}`;
}

function stableHash(value: string): string {
  return stableTextSha256(value);
}

function buildMessageMatchKey(timestampIso: string | undefined, fingerprint: string): string {
  return `${normalizeSessionAnalysisTimestamp(timestampIso) ?? ""}\u0000${fingerprint}`;
}

function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function compareIso(left: string | undefined, right: string | undefined): number {
  // Intentionally sort missing or invalid timestamps first so max/latest selection favors valid evidence.
  const leftMs = Date.parse(left ?? "");
  const rightMs = Date.parse(right ?? "");
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) return leftMs - rightMs;
  if (Number.isFinite(leftMs)) return 1;
  if (Number.isFinite(rightMs)) return -1;
  return String(left ?? "").localeCompare(String(right ?? ""));
}

function minIso(current: string | undefined, next: string): string {
  return !current || compareIso(next, current) < 0 ? next : current;
}

function maxIso(current: string | undefined, next: string): string {
  return !current || compareIso(next, current) > 0 ? next : current;
}

function sanitizeErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  return normalizeLabel(name) || "UnknownError";
}
