import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type {
  ChatEnvironmentItem,
  ChatImageAttachment,
  ChatPatchChangeType,
  ChatPatchEntry,
  ChatPatchGroupItem,
  ChatPatchHunk,
  ChatRateLimit,
  ChatRateLimits,
  ChatPatchRow,
  ChatRole,
  ChatSessionMeta,
  ChatSessionModel,
  ChatTimelineItem,
  ChatTokenUsage,
  ChatToolExecution,
  ChatToolItem,
  ChatUsageItem,
} from "./chatTypes";
import type { ImagesConfig } from "../settings";
import { tryReadSessionMeta } from "../sessions/sessionSummary";
import { extractCompactUserText, isBoilerplateUserMessageText } from "../utils/textUtils";
import { buildToolPresentation } from "../tools/toolSemantics";
import {
  addUnavailablePlaceholderIfNeeded,
  extractClaudeImageAttachments,
  extractCodexMessageContent,
  stripImagePlaceholders,
} from "./chatImageAttachments";

export interface ChatSessionModelBuildOptions {
  images?: ImagesConfig;
  includeDetails?: boolean;
}

// Parse a session JSONL and build a chat-view model.
export async function buildChatSessionModel(
  fsPath: string,
  options: ChatSessionModelBuildOptions = {},
): Promise<ChatSessionModel> {
  const meta = await readSessionMeta(fsPath);
  const items = await readTimelineItems(fsPath, meta.cwd, options);
  return { fsPath, meta, items };
}

async function readSessionMeta(fsPath: string): Promise<ChatSessionMeta> {
  const meta = await tryReadSessionMeta(fsPath);
  if (!meta) return {};
  return {
    id: meta.id,
    timestampIso: meta.timestampIso,
    cwd: meta.cwd,
    originator: meta.originator,
    cliVersion: meta.cliVersion,
    modelProvider: meta.modelProvider,
    source: meta.source,
    historySource: meta.historySource,
  };
}

async function readTimelineItems(
  fsPath: string,
  sessionCwd: string | undefined,
  options: ChatSessionModelBuildOptions,
): Promise<ChatTimelineItem[]> {
  const stream = fs.createReadStream(fsPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const items: ChatTimelineItem[] = [];
  const toolByCallId = new Map<string, ChatToolItem>();
  const pendingPatchGroups = new Map<string, PendingPatchGroup>();
  const codexTurnMeta: ChatMessageModelMeta = {};
  const usageState: UsageBuildState = {};
  const environmentState: EnvironmentBuildState = {};
  let messageIndex = 0;

  try {
    for await (const line of rl) {
      if (!line) continue;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      flushPendingClaudeUsageIfNeeded(obj, items, usageState);
      appendEnvironmentSnapshotIfChanged(obj, items, environmentState, () => messageIndex);
      if (updateCodexTurnMeta(obj, codexTurnMeta)) {
        continue;
      }
      if (
        await indexCodexTimelineRecord(
          obj,
          items,
          toolByCallId,
          () => (messageIndex += 1),
          () => messageIndex,
          codexTurnMeta,
          sessionCwd,
          options,
        )
      ) {
        continue;
      }
      if (
        indexCodexEventRecord(
          obj,
          items,
          toolByCallId,
          pendingPatchGroups,
          () => messageIndex,
          codexTurnMeta,
          usageState,
          sessionCwd,
          options,
        )
      ) {
        continue;
      }
      if (
        await indexClaudeTimelineRecord(
          obj,
          items,
          toolByCallId,
          () => (messageIndex += 1),
          () => messageIndex,
          usageState,
          sessionCwd,
          options,
        )
      ) {
        continue;
      }
    }
  } finally {
    rl.close();
    stream.close();
  }

  flushPendingPatchGroups(items, pendingPatchGroups);
  flushPendingClaudeUsage(items, usageState);
  finalizeTimelineItems(items);
  return items;
}

async function indexCodexTimelineRecord(
  obj: any,
  items: ChatTimelineItem[],
  toolByCallId: Map<string, ChatToolItem>,
  nextMessageIndex: () => number,
  currentMessageIndex: () => number,
  codexTurnMeta: ChatMessageModelMeta,
  sessionCwd?: string,
  options: ChatSessionModelBuildOptions = {},
): Promise<boolean> {
  if (obj?.type !== "response_item") return false;
  const payloadType = obj?.payload?.type;

  if (payloadType === "message") {
    const role = obj?.payload?.role as ChatRole | undefined;
    if (role !== "developer" && role !== "user" && role !== "assistant") return true;

    const parsed = await extractCodexMessageContent(
      obj?.payload?.content,
      sessionCwd,
      toImageExtractionOptions(options.images),
    );
    const text = normalizeText(parsed.text);
    const images = parsed.images;
    if (!text && images.length === 0) return true;

    const compactUserText = role === "user" ? extractCompactUserText(text) : null;
    const isBoilerplate = role === "assistant" ? false : isBoilerplateUserMessageText(text);
    const requestText = role === "user" ? compactUserText ?? text : undefined;
    // For user rows, treat only empty compact text as context.
    const isContext =
      role === "assistant" ? false : role === "user" ? !compactUserText && images.length === 0 : isBoilerplate;

    const ts = typeof obj?.timestamp === "string" ? obj.timestamp : undefined;
    const idx = role === "user" || role === "assistant" ? nextMessageIndex() : undefined;
    assignImageIds(images, typeof idx === "number" ? `m${idx}` : `item${items.length}`);

    items.push({
      type: "message",
      role,
      messageIndex: idx,
      timestampIso: ts,
      ...(role === "assistant" ? toMessageModelMeta(codexTurnMeta) : {}),
      text,
      requestText,
      ...(images.length > 0 ? { images } : {}),
      isContext,
    });
    return true;
  }

  if (payloadType === "function_call" || payloadType === "custom_tool_call") {
    const includeDetails = shouldIncludeDetails(options);
    const name = typeof obj?.payload?.name === "string" ? obj.payload.name : payloadType;
    const callId = typeof obj?.payload?.call_id === "string" ? obj.payload.call_id : undefined;
    const argumentsText = stringifyToolPayload(obj?.payload?.arguments ?? obj?.payload?.input);
    const ts = typeof obj?.timestamp === "string" ? obj.timestamp : undefined;
    const messageIndex = currentMessageIndex();

    const tool: ChatToolItem = {
      type: "tool",
      messageIndex,
      timestampIso: ts,
      name,
      callId,
      ...(includeDetails && argumentsText ? { argumentsText } : {}),
      ...(!includeDetails && hasText(argumentsText) ? { detailsOmitted: true } : {}),
    };
    if (!includeDetails) tool.presentation = buildToolPresentation({ ...tool, argumentsText });
    items.push(tool);
    if (callId) toolByCallId.set(callId, tool);
    return true;
  }

  if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
    const callId = typeof obj?.payload?.call_id === "string" ? obj.payload.call_id : undefined;
    const outputText = typeof obj?.payload?.output === "string" ? obj.payload.output : undefined;
    const ts = typeof obj?.timestamp === "string" ? obj.timestamp : undefined;
    const execution = extractToolExecutionFromText(outputText);

    attachOrPushToolOutput(items, toolByCallId, {
      callId,
      outputText,
      fallbackMessageIndex: currentMessageIndex(),
      timestampIso: ts,
      fallbackName: payloadType,
      includeDetails: shouldIncludeDetails(options),
      execution,
    });
    return true;
  }

  return true;
}

function indexCodexEventRecord(
  obj: any,
  items: ChatTimelineItem[],
  toolByCallId: Map<string, ChatToolItem>,
  pendingPatchGroups: Map<string, PendingPatchGroup>,
  currentMessageIndex: () => number,
  codexTurnMeta: ChatMessageModelMeta,
  usageState: UsageBuildState,
  sessionCwd?: string,
  options: ChatSessionModelBuildOptions = {},
): boolean {
  if (obj?.type !== "event_msg") return false;

  const payloadType = typeof obj?.payload?.type === "string" ? obj.payload.type : "";
  if (payloadType === "token_count") {
    const usageItem = buildCodexUsageItem(obj, currentMessageIndex(), codexTurnMeta);
    if (usageItem && shouldAppendCodexUsage(usageItem, usageState)) items.push(usageItem);
    return true;
  }

  if (payloadType === "exec_command_end") {
    const callId = typeof obj?.payload?.call_id === "string" ? obj.payload.call_id : undefined;
    const execution = extractToolExecutionFromCodexEvent(obj?.payload);
    if (callId && execution) attachToolExecution(toolByCallId, callId, execution);
    return true;
  }

  if (payloadType === "patch_apply_end") {
    const key = buildPatchGroupKey(obj);
    const turnId = typeof obj?.payload?.turn_id === "string" ? obj.payload.turn_id : undefined;
    const timestampIso = typeof obj?.timestamp === "string" ? obj.timestamp : undefined;
    const entries = buildPatchEntries(
      obj?.payload?.changes,
      sessionCwd,
      typeof obj?.payload?.call_id === "string" ? obj.payload.call_id : undefined,
      shouldIncludeDetails(options),
    );
    if (entries.length === 0) return true;

    const existing = pendingPatchGroups.get(key);
    if (existing) {
      existing.lastTimestampIso = timestampIso ?? existing.lastTimestampIso;
      existing.entries.push(...entries);
      existing.totalAdded += entries.reduce((sum, entry) => sum + entry.added, 0);
      existing.totalRemoved += entries.reduce((sum, entry) => sum + entry.removed, 0);
      return true;
    }

    pendingPatchGroups.set(key, {
      turnId,
      messageIndex: currentMessageIndex() > 0 ? currentMessageIndex() : undefined,
      firstTimestampIso: timestampIso,
      lastTimestampIso: timestampIso,
      entries: [...entries],
      totalAdded: entries.reduce((sum, entry) => sum + entry.added, 0),
      totalRemoved: entries.reduce((sum, entry) => sum + entry.removed, 0),
    });
    return true;
  }

  if (payloadType === "task_complete") {
    const turnId = typeof obj?.payload?.turn_id === "string" ? obj.payload.turn_id : undefined;
    if (!turnId) {
      flushPendingPatchGroups(items, pendingPatchGroups);
      return true;
    }
    flushPendingPatchGroup(items, pendingPatchGroups, turnId);
    return true;
  }

  if (payloadType === "task_started") {
    // Finalize any pending patch groups before the next turn begins.
    flushPendingPatchGroups(items, pendingPatchGroups);
    return true;
  }

  return true;
}

async function indexClaudeTimelineRecord(
  obj: any,
  items: ChatTimelineItem[],
  toolByCallId: Map<string, ChatToolItem>,
  nextMessageIndex: () => number,
  currentMessageIndex: () => number,
  usageState: UsageBuildState,
  sessionCwd?: string,
  options: ChatSessionModelBuildOptions = {},
): Promise<boolean> {
  const role = detectClaudeMessageRole(obj);
  if (!role) return false;

  const rawContent = getClaudeMessageContent(obj);
  const parsed = parseClaudeMessageContent(rawContent);
  const stripped = stripImagePlaceholders(parsed.messageText);
  const imageOptions = toImageExtractionOptions(options.images);
  const images = await extractClaudeImageAttachments(rawContent, sessionCwd, imageOptions);
  addUnavailablePlaceholderIfNeeded(images, stripped.placeholderCount, imageOptions.enabled ? "remote" : "disabled");
  const text = normalizeText(stripped.text);
  const ts = typeof obj?.timestamp === "string" ? obj.timestamp : undefined;

  if (text || images.length > 0) {
    const compactUserText = role === "user" ? extractCompactUserText(text) : null;
    const requestText = role === "user" ? compactUserText ?? text : undefined;
    const isContext = role === "user" ? !compactUserText && images.length === 0 : false;
    const idx = nextMessageIndex();
    assignImageIds(images, `m${idx}`);
    const modelMeta = role === "assistant" ? extractClaudeMessageModelMeta(obj) : {};

    items.push({
      type: "message",
      role,
      messageIndex: idx,
      timestampIso: ts,
      ...modelMeta,
      text,
      requestText,
      ...(images.length > 0 ? { images } : {}),
      isContext,
    });
  }

  const includeDetails = shouldIncludeDetails(options);
  for (const toolCall of parsed.toolCalls) {
    const name = normalizeText(toolCall.name ?? "") || "tool_use";
    const callId = toolCall.callId;
    const argumentsText = toolCall.argumentsText ? normalizeText(toolCall.argumentsText) : undefined;
    const messageIndex = currentMessageIndex();
    const tool: ChatToolItem = {
      type: "tool",
      messageIndex,
      timestampIso: ts,
      name,
      callId,
      ...(includeDetails && argumentsText ? { argumentsText } : {}),
      ...(!includeDetails && hasText(argumentsText) ? { detailsOmitted: true } : {}),
    };
    if (!includeDetails) tool.presentation = buildToolPresentation({ ...tool, argumentsText });
    items.push(tool);
    if (callId) toolByCallId.set(callId, tool);
  }

  for (const toolResult of parsed.toolResults) {
    const outputText = normalizeText(toolResult.outputText ?? "");
    if (!outputText) continue;
    const execution = buildClaudeToolExecution(obj, toolResult.isError);
    attachOrPushToolOutput(items, toolByCallId, {
      callId: toolResult.callId,
      outputText,
      fallbackMessageIndex: currentMessageIndex(),
      timestampIso: ts,
      fallbackName: "tool_result",
      includeDetails,
      execution,
    });
  }

  if (role === "assistant") {
    const usageItem = buildClaudeUsageItem(obj, currentMessageIndex(), ts);
    if (usageItem) {
      usageState.pendingClaudeUsage = {
        sourceId: getClaudeMessageId(obj),
        item: usageItem,
      };
    }
  }

  return true;
}

interface ChatMessageModelMeta {
  model?: string;
  effort?: string;
}

interface UsageBuildState {
  lastCodexUsageSignature?: string;
  lastClaudeUsageSignature?: string;
  pendingClaudeUsage?: {
    sourceId?: string;
    item: ChatUsageItem;
  };
}

interface EnvironmentBuildState {
  lastSignature?: string;
}

function updateCodexTurnMeta(obj: any, meta: ChatMessageModelMeta): boolean {
  if (obj?.type !== "turn_context" || !obj?.payload || typeof obj.payload !== "object") return false;

  const model = normalizeModelMetaValue(obj.payload.model);
  const effort = normalizeModelMetaValue(obj.payload.effort);
  meta.model = model;
  meta.effort = effort;
  return true;
}

function toMessageModelMeta(meta: ChatMessageModelMeta): ChatMessageModelMeta {
  return {
    ...(meta.model ? { model: meta.model } : {}),
    ...(meta.effort ? { effort: meta.effort } : {}),
  };
}

function extractClaudeMessageModelMeta(obj: any): ChatMessageModelMeta {
  const model = normalizeModelMetaValue(obj?.message?.model ?? obj?.model);
  return model ? { model } : {};
}

function normalizeModelMetaValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 80) : undefined;
}

function appendEnvironmentSnapshotIfChanged(
  obj: any,
  items: ChatTimelineItem[],
  state: EnvironmentBuildState,
  currentMessageIndex: () => number,
): void {
  const snapshot = extractEnvironmentSnapshot(obj);
  if (!snapshot) return;

  const signature = buildEnvironmentSignature(snapshot);
  if (!signature || signature === state.lastSignature) return;
  state.lastSignature = signature;
  items.push({
    type: "environment",
    messageIndex: currentMessageIndex() > 0 ? currentMessageIndex() : undefined,
    ...snapshot,
  });
}

function extractEnvironmentSnapshot(obj: any): Omit<ChatEnvironmentItem, "type" | "messageIndex"> | null {
  if (!obj || typeof obj !== "object") return null;

  if (obj.type === "session_meta" && obj.payload && typeof obj.payload === "object") {
    const git = obj.payload.git && typeof obj.payload.git === "object" ? obj.payload.git : {};
    return buildEnvironmentSnapshot({
      timestampIso: obj.timestamp,
      cwd: obj.payload.cwd,
      gitBranch: (git as Record<string, unknown>).branch,
      gitCommit:
        (git as Record<string, unknown>).commit_hash ??
        (git as Record<string, unknown>).commitHash ??
        (git as Record<string, unknown>).commit,
      gitDirty:
        (git as Record<string, unknown>).dirty ??
        (git as Record<string, unknown>).is_dirty ??
        (git as Record<string, unknown>).has_uncommitted_changes,
    });
  }

  return buildEnvironmentSnapshot({
    timestampIso: obj.timestamp,
    cwd: obj.cwd,
    gitBranch: obj.gitBranch ?? obj.git_branch,
    gitCommit: obj.gitCommit ?? obj.git_commit ?? obj.commit,
    gitDirty: obj.gitDirty ?? obj.git_dirty,
  });
}

function buildEnvironmentSnapshot(params: {
  timestampIso?: unknown;
  cwd?: unknown;
  gitBranch?: unknown;
  gitCommit?: unknown;
  gitDirty?: unknown;
}): Omit<ChatEnvironmentItem, "type" | "messageIndex"> | null {
  const cwd = normalizeEnvironmentText(params.cwd, 260);
  const gitBranch = normalizeEnvironmentText(params.gitBranch, 120);
  const gitCommit = normalizeGitCommit(params.gitCommit);
  const gitDirty = typeof params.gitDirty === "boolean" ? params.gitDirty : undefined;
  if (!gitBranch && !gitCommit && typeof gitDirty !== "boolean") return null;

  const timestampIso = normalizeTimestampIso(params.timestampIso);
  return {
    ...(timestampIso ? { timestampIso } : {}),
    ...(cwd ? { cwd } : {}),
    ...(gitBranch ? { gitBranch } : {}),
    ...(gitCommit ? { gitCommit } : {}),
    ...(typeof gitDirty === "boolean" ? { gitDirty } : {}),
  };
}

function buildEnvironmentSignature(item: Omit<ChatEnvironmentItem, "type" | "messageIndex">): string {
  return JSON.stringify({
    cwd: normalizeEnvironmentSignaturePath(item.cwd),
    gitBranch: item.gitBranch,
    gitCommit: item.gitCommit,
    gitDirty: item.gitDirty,
  });
}

function normalizeEnvironmentSignaturePath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.replace(/\\/g, "/").toLowerCase() : undefined;
}

function normalizeEnvironmentText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function normalizeGitCommit(value: unknown): string | undefined {
  const text = normalizeEnvironmentText(value, 80);
  if (!text) return undefined;
  return /^[0-9a-f]{7,64}$/iu.test(text) ? text : text.slice(0, 80);
}

function normalizeTimestampIso(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return Number.isFinite(Date.parse(trimmed)) ? trimmed : undefined;
}

function flushPendingClaudeUsageIfNeeded(obj: any, items: ChatTimelineItem[], state: UsageBuildState): void {
  const pending = state.pendingClaudeUsage;
  if (!pending) return;

  const role = detectClaudeMessageRole(obj);
  const sourceId = getClaudeMessageId(obj);
  if (role === "assistant" && sourceId && sourceId === pending.sourceId) return;

  flushPendingClaudeUsage(items, state);
}

function flushPendingClaudeUsage(items: ChatTimelineItem[], state: UsageBuildState): void {
  const pending = state.pendingClaudeUsage;
  if (!pending) return;
  const signature = buildUsageSignature(pending.item);
  if (signature !== state.lastClaudeUsageSignature) {
    items.push(pending.item);
    state.lastClaudeUsageSignature = signature;
  }
  state.pendingClaudeUsage = undefined;
}

function buildCodexUsageItem(obj: any, messageIndex: number, meta: ChatMessageModelMeta): ChatUsageItem | null {
  const info = obj?.payload?.info;
  if (!info || typeof info !== "object") return null;

  const usage = extractTokenUsage(info.last_token_usage);
  if (!usage) return null;

  const totalUsage = extractTokenUsage(info.total_token_usage);
  const modelContextWindow = normalizeOptionalInteger(info.model_context_window);
  const rateLimits = extractRateLimits(obj?.payload?.rate_limits);
  const timestampIso = typeof obj?.timestamp === "string" ? obj.timestamp : undefined;
  return {
    type: "usage",
    messageIndex: messageIndex > 0 ? messageIndex : undefined,
    timestampIso,
    ...toMessageModelMeta(meta),
    usage,
    ...(totalUsage ? { totalUsage } : {}),
    ...(typeof modelContextWindow === "number" ? { modelContextWindow } : {}),
    ...(rateLimits ? { rateLimits } : {}),
  };
}

function shouldAppendCodexUsage(item: ChatUsageItem, state: UsageBuildState): boolean {
  const signature = buildUsageSignature(item);
  if (signature === state.lastCodexUsageSignature) return false;
  state.lastCodexUsageSignature = signature;
  return true;
}

function buildUsageSignature(item: ChatUsageItem): string {
  return JSON.stringify({
    messageIndex: item.messageIndex,
    model: item.model,
    effort: item.effort,
    usage: item.usage,
    totalUsage: item.totalUsage,
    stopReason: item.stopReason,
    rateLimits: item.rateLimits,
  });
}

function buildClaudeUsageItem(obj: any, messageIndex: number, timestampIso?: string): ChatUsageItem | null {
  const rawUsage = obj?.message?.usage;
  if (!rawUsage || typeof rawUsage !== "object") return null;

  const usage = extractTokenUsage(rawUsage);
  if (!usage) return null;

  const modelMeta = extractClaudeMessageModelMeta(obj);
  const serviceTier = normalizeModelMetaValue(rawUsage.service_tier);
  const speed = normalizeModelMetaValue(rawUsage.speed);
  const stopReason = normalizeModelMetaValue(obj?.message?.stop_reason);
  return {
    type: "usage",
    messageIndex: messageIndex > 0 ? messageIndex : undefined,
    timestampIso,
    ...modelMeta,
    usage,
    ...(serviceTier ? { serviceTier } : {}),
    ...(speed ? { speed } : {}),
    ...(stopReason ? { stopReason } : {}),
  };
}

function extractTokenUsage(value: unknown): ChatTokenUsage | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const usage: ChatTokenUsage = {
    ...toOptionalTokenField("inputTokens", raw.input_tokens),
    ...toOptionalTokenField("cachedInputTokens", raw.cached_input_tokens),
    ...toOptionalTokenField("cacheReadInputTokens", raw.cache_read_input_tokens),
    ...toOptionalTokenField("cacheCreationInputTokens", raw.cache_creation_input_tokens),
    ...toOptionalTokenField("outputTokens", raw.output_tokens),
    ...toOptionalTokenField("reasoningOutputTokens", raw.reasoning_output_tokens),
    ...toOptionalTokenField("totalTokens", raw.total_tokens),
  };
  return Object.keys(usage).length > 0 ? usage : null;
}

function toOptionalTokenField<K extends keyof ChatTokenUsage>(key: K, value: unknown): Pick<ChatTokenUsage, K> | {} {
  const n = normalizeOptionalInteger(value);
  return typeof n === "number" ? { [key]: n } as Pick<ChatTokenUsage, K> : {};
}

function normalizeOptionalInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const n = Math.max(0, Math.floor(value));
  return Number.isSafeInteger(n) ? n : undefined;
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value >= 0 ? value : undefined;
}

function extractRateLimits(value: unknown): ChatRateLimits | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const primary = extractRateLimit(raw.primary);
  const secondary = extractRateLimit(raw.secondary);
  const limitId = normalizeModelMetaValue(raw.limit_id);
  const limitName = normalizeModelMetaValue(raw.limit_name);
  const planType = normalizeModelMetaValue(raw.plan_type);
  const reachedType = normalizeModelMetaValue(raw.rate_limit_reached_type);
  const limits: ChatRateLimits = {
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(limitId ? { limitId } : {}),
    ...(limitName ? { limitName } : {}),
    ...(planType ? { planType } : {}),
    ...(reachedType ? { reachedType } : {}),
  };
  return Object.keys(limits).length > 0 ? limits : undefined;
}

function extractRateLimit(value: unknown): ChatRateLimit | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const limit: ChatRateLimit = {
    ...toOptionalNumberField("usedPercent", raw.used_percent),
    ...toOptionalNumberField("windowMinutes", raw.window_minutes),
    ...toOptionalNumberField("resetsAt", raw.resets_at),
    ...toOptionalNumberField("resetsInSeconds", raw.resets_in_seconds),
  };
  return Object.keys(limit).length > 0 ? limit : undefined;
}

function toOptionalNumberField<K extends keyof ChatRateLimit>(key: K, value: unknown): Pick<ChatRateLimit, K> | {} {
  const n = normalizeOptionalNumber(value);
  return typeof n === "number" ? { [key]: n } as Pick<ChatRateLimit, K> : {};
}

function getClaudeMessageId(obj: any): string | undefined {
  return normalizeModelMetaValue(obj?.message?.id ?? obj?.requestId ?? obj?.uuid);
}

function stringifyToolPayload(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return undefined;
  return safeJsonStringify(value);
}

function attachToolExecution(
  toolByCallId: Map<string, ChatToolItem>,
  callId: string,
  execution: ChatToolExecution,
): void {
  const tool = toolByCallId.get(callId);
  if (!tool) return;
  mergeToolExecutionIntoItem(tool, execution);
}

function mergeToolExecutionIntoItem(tool: ChatToolItem, execution: ChatToolExecution | null | undefined): void {
  if (!execution || Object.keys(execution).length === 0) return;
  tool.execution = mergeToolExecution(tool.execution, execution);
}

function mergeToolExecution(
  current: ChatToolExecution | undefined,
  next: ChatToolExecution,
): ChatToolExecution {
  return {
    ...(current ?? {}),
    ...next,
    ...(typeof next.exitCode === "number" ? { exitCode: next.exitCode } : {}),
    ...(typeof next.durationMs === "number" ? { durationMs: next.durationMs } : {}),
  };
}

function buildClaudeToolExecution(obj: any, isError?: boolean): ChatToolExecution | undefined {
  const result = obj?.toolUseResult;
  const interrupted = result && typeof result === "object" && (result as Record<string, unknown>).interrupted === true;
  const errorText = isError ? normalizeToolMetaText(result) : undefined;
  const execution: ChatToolExecution = {
    ...(interrupted ? { status: "interrupted" } : isError === true ? { status: "error" } : { status: "success" }),
    ...(errorText ? { error: errorText } : {}),
  };
  return execution;
}

function extractToolExecutionFromCodexEvent(payload: unknown): ChatToolExecution | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const raw = payload as Record<string, unknown>;
  const duration = raw.duration;
  const durationMs =
    duration && typeof duration === "object"
      ? durationPartsToMs((duration as Record<string, unknown>).secs, (duration as Record<string, unknown>).nanos)
      : undefined;
  const execution: ChatToolExecution = {
    ...toOptionalExecutionStatus(raw.status),
    ...toOptionalExitCode(raw.exit_code ?? raw.exitCode ?? raw.code),
    ...(typeof durationMs === "number" ? { durationMs } : {}),
  };
  return Object.keys(execution).length > 0 ? execution : undefined;
}

function extractToolExecutionFromText(outputText: unknown): ChatToolExecution | undefined {
  if (typeof outputText !== "string" || outputText.trim().length === 0) return undefined;
  const trimmed = outputText.trim();
  const parsed = parseJsonObject(trimmed);
  const metadata = parsed?.metadata && typeof parsed.metadata === "object" ? parsed.metadata as Record<string, unknown> : null;
  const source = metadata ?? parsed;

  const execution: ChatToolExecution = {};
  if (source) {
    Object.assign(
      execution,
      toOptionalExecutionStatus(source.status),
      toOptionalExitCode(source.exit_code ?? source.exitCode ?? source.code),
      toOptionalDurationMs(source.duration_ms ?? source.durationMs),
      toOptionalDurationSeconds(source.duration_seconds ?? source.durationSeconds),
    );
  }

  const plainExit = outputText.match(/\bExit code:\s*(-?\d+)\b/u);
  if (plainExit && typeof execution.exitCode !== "number") execution.exitCode = Number(plainExit[1]);

  const plainWallTime = outputText.match(/\bWall time:\s*([0-9]+(?:\.[0-9]+)?)\s*seconds\b/iu);
  if (plainWallTime && typeof execution.durationMs !== "number") {
    execution.durationMs = Math.round(Number(plainWallTime[1]) * 1000);
  }

  const timedOut = outputText.match(/\bcommand timed out after\s+(\d+)\s+milliseconds\b/iu);
  if (timedOut) {
    execution.status = "timeout";
    if (typeof execution.durationMs !== "number") execution.durationMs = Number(timedOut[1]);
  }

  return Object.keys(execution).length > 0 ? execution : undefined;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  if (!text.startsWith("{") || !text.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toOptionalExecutionStatus(value: unknown): Pick<ChatToolExecution, "status"> | {} {
  const status = normalizeToolMetaText(value);
  return status ? { status } : {};
}

function toOptionalExitCode(value: unknown): Pick<ChatToolExecution, "exitCode"> | {} {
  const n = normalizeIntegerLike(value);
  return typeof n === "number" ? { exitCode: n } : {};
}

function toOptionalDurationMs(value: unknown): Pick<ChatToolExecution, "durationMs"> | {} {
  const n = normalizeNonNegativeNumberLike(value);
  return typeof n === "number" ? { durationMs: Math.round(n) } : {};
}

function toOptionalDurationSeconds(value: unknown): Pick<ChatToolExecution, "durationMs"> | {} {
  const n = normalizeNonNegativeNumberLike(value);
  return typeof n === "number" ? { durationMs: Math.round(n * 1000) } : {};
}

function durationPartsToMs(secs: unknown, nanos: unknown): number | undefined {
  const secValue = normalizeNonNegativeNumberLike(secs) ?? 0;
  const nanoValue = normalizeNonNegativeNumberLike(nanos) ?? 0;
  const ms = Math.round(secValue * 1000 + nanoValue / 1_000_000);
  return Number.isSafeInteger(ms) ? ms : undefined;
}

function normalizeIntegerLike(value: unknown): number | undefined {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^-?\d+$/u.test(value.trim())
        ? Number(value.trim())
        : NaN;
  if (!Number.isFinite(n)) return undefined;
  const int = Math.trunc(n);
  return Number.isSafeInteger(int) ? int : undefined;
}

function normalizeNonNegativeNumberLike(value: unknown): number | undefined {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[0-9]+(?:\.[0-9]+)?$/u.test(value.trim())
        ? Number(value.trim())
        : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function normalizeToolMetaText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const text = value.trim().replace(/\s+/gu, " ");
    return text ? text.slice(0, 160) : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function attachOrPushToolOutput(
  items: ChatTimelineItem[],
  toolByCallId: Map<string, ChatToolItem>,
  params: {
    callId?: string;
    outputText?: string;
    fallbackMessageIndex?: number;
    timestampIso?: string;
    fallbackName: string;
    includeDetails: boolean;
    execution?: ChatToolExecution;
  },
): void {
  const { callId, outputText, fallbackMessageIndex, timestampIso, fallbackName, includeDetails, execution } = params;
  if (callId && toolByCallId.has(callId)) {
    const tool = toolByCallId.get(callId)!;
    if (includeDetails) tool.outputText = outputText;
    else if (hasText(outputText)) tool.detailsOmitted = true;
    mergeToolExecutionIntoItem(tool, execution ?? extractToolExecutionFromText(outputText));
    if (!tool.timestampIso) tool.timestampIso = timestampIso;
    if (typeof tool.messageIndex !== "number" && typeof fallbackMessageIndex === "number") {
      tool.messageIndex = fallbackMessageIndex;
    }
    return;
  }

  const resolvedExecution = execution ?? extractToolExecutionFromText(outputText);
  const tool: ChatToolItem = {
    type: "tool",
    messageIndex: fallbackMessageIndex,
    timestampIso,
    name: fallbackName,
    callId,
    ...(includeDetails && outputText ? { outputText } : {}),
    ...(!includeDetails && hasText(outputText) ? { detailsOmitted: true } : {}),
    ...(resolvedExecution ? { execution: resolvedExecution } : {}),
  };
  if (!includeDetails) tool.presentation = buildToolPresentation(tool);
  items.push(tool);
}

function finalizeTimelineItems(items: ChatTimelineItem[]): void {
  for (const item of items) {
    if (item.type !== "tool") continue;
    mergeToolExecutionIntoItem(item, extractToolExecutionFromText(item.outputText));
    if (item.presentation) continue;
    item.presentation = buildToolPresentation(item);
  }
}

function shouldIncludeDetails(options: ChatSessionModelBuildOptions): boolean {
  return options.includeDetails !== false;
}

function toImageExtractionOptions(images?: ImagesConfig): { enabled: boolean; maxBytes: number } {
  const maxSizeMB = Number(images?.maxSizeMB);
  const safeMaxSizeMB = Number.isFinite(maxSizeMB) && maxSizeMB > 0 ? Math.min(100, Math.floor(maxSizeMB)) : 20;
  return {
    enabled: images?.enabled ?? true,
    maxBytes: safeMaxSizeMB * 1024 * 1024,
  };
}

function assignImageIds(images: ChatImageAttachment[], scope: string): void {
  for (let i = 0; i < images.length; i += 1) {
    const image = images[i];
    if (!image || image.id) continue;
    image.id = `${scope}-image-${i + 1}`;
  }
}

interface PendingPatchGroup {
  turnId?: string;
  messageIndex?: number;
  firstTimestampIso?: string;
  lastTimestampIso?: string;
  entries: ChatPatchEntry[];
  totalAdded: number;
  totalRemoved: number;
}

function flushPendingPatchGroup(
  items: ChatTimelineItem[],
  pendingPatchGroups: Map<string, PendingPatchGroup>,
  turnId: string,
): void {
  const group = pendingPatchGroups.get(turnId);
  if (!group) return;
  items.push(toPatchGroupItem(group));
  pendingPatchGroups.delete(turnId);
}

function flushPendingPatchGroups(
  items: ChatTimelineItem[],
  pendingPatchGroups: Map<string, PendingPatchGroup>,
): void {
  for (const [key, group] of pendingPatchGroups.entries()) {
    items.push(toPatchGroupItem(group));
    pendingPatchGroups.delete(key);
  }
}

function toPatchGroupItem(group: PendingPatchGroup): ChatPatchGroupItem {
  return {
    type: "patchGroup",
    messageIndex: group.messageIndex,
    timestampIso: group.lastTimestampIso ?? group.firstTimestampIso,
    turnId: group.turnId,
    entryCount: group.entries.length,
    totalAdded: group.totalAdded,
    totalRemoved: group.totalRemoved,
    entries: group.entries,
  };
}

function buildPatchGroupKey(obj: any): string {
  const turnId = typeof obj?.payload?.turn_id === "string" ? obj.payload.turn_id.trim() : "";
  if (turnId) return turnId;
  const callId = typeof obj?.payload?.call_id === "string" ? obj.payload.call_id.trim() : "";
  if (callId) return `call:${callId}`;
  const timestampIso = typeof obj?.timestamp === "string" ? obj.timestamp.trim() : "";
  return timestampIso ? `ts:${timestampIso}` : "patch";
}

function buildPatchEntries(
  changes: unknown,
  sessionCwd?: string,
  callId?: string,
  includeDetails = true,
): ChatPatchEntry[] {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return [];

  const entries: ChatPatchEntry[] = [];
  let index = 0;
  for (const [rawPath, rawChange] of Object.entries(changes as Record<string, unknown>)) {
    const change = rawChange && typeof rawChange === "object" ? (rawChange as Record<string, unknown>) : {};
    const changeType = normalizePatchChangeType(change.type);
    const movePath = typeof change.move_path === "string" ? change.move_path : undefined;
    const unifiedDiff = typeof change.unified_diff === "string" ? change.unified_diff : "";
    const parsed = parseUnifiedDiff(unifiedDiff, includeDetails);
    const displayPath = formatPatchDisplayPath(rawPath, sessionCwd);
    const moveDisplayPath = movePath ? formatPatchDisplayPath(movePath, sessionCwd) : undefined;

    entries.push({
      id: `${callId ?? "patch"}:${index}`,
      callId,
      path: rawPath,
      displayPath,
      movePath,
      moveDisplayPath,
      changeType,
      added: parsed.added,
      removed: parsed.removed,
      ...(!includeDetails && hasText(unifiedDiff) ? { detailsOmitted: true } : {}),
      hunks: parsed.hunks,
    });
    index += 1;
  }
  return entries;
}

function parseUnifiedDiff(
  diffText: string,
  includeDetails = true,
): { added: number; removed: number; hunks: ChatPatchHunk[] } {
  const lines = String(diffText ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const hunks: ChatPatchHunk[] = [];
  let added = 0;
  let removed = 0;

  let currentHunk: ChatPatchHunk | null = null;
  let currentLeftLine = 0;
  let currentRightLine = 0;
  let pendingDeletes: Array<{ line: number; text: string }> = [];
  let pendingAdds: Array<{ line: number; text: string }> = [];

  const flushPendingRows = (): void => {
    if (!currentHunk || (pendingDeletes.length === 0 && pendingAdds.length === 0)) return;
    if (!includeDetails) {
      pendingDeletes = [];
      pendingAdds = [];
      return;
    }
    const count = Math.max(pendingDeletes.length, pendingAdds.length);
    for (let i = 0; i < count; i += 1) {
      const left = pendingDeletes[i];
      const right = pendingAdds[i];
      const kind = left && right ? "modify" : left ? "delete" : "add";
      currentHunk.rows.push({
        kind,
        leftLine: left?.line,
        leftText: left?.text ?? "",
        rightLine: right?.line,
        rightText: right?.text ?? "",
      });
    }
    pendingDeletes = [];
    pendingAdds = [];
  };

  for (const rawLine of lines) {
    if (rawLine.startsWith("@@")) {
      flushPendingRows();
      const parsedHeader = parsePatchHeader(rawLine);
      currentLeftLine = parsedHeader?.leftStart ?? 0;
      currentRightLine = parsedHeader?.rightStart ?? 0;
      currentHunk = { header: rawLine, rows: [] };
      if (includeDetails) hunks.push(currentHunk);
      continue;
    }
    if (!currentHunk) continue;
    if (!rawLine) continue;
    if (rawLine.startsWith("\\")) continue;

    const marker = rawLine[0];
    const text = rawLine.slice(1);
    if (marker === " ") {
      flushPendingRows();
      if (includeDetails) {
        currentHunk.rows.push({
          kind: "context",
          leftLine: currentLeftLine,
          leftText: text,
          rightLine: currentRightLine,
          rightText: text,
        });
      }
      currentLeftLine += 1;
      currentRightLine += 1;
      continue;
    }
    if (marker === "-") {
      removed += 1;
      pendingDeletes.push({ line: currentLeftLine, text });
      currentLeftLine += 1;
      continue;
    }
    if (marker === "+") {
      added += 1;
      pendingAdds.push({ line: currentRightLine, text });
      currentRightLine += 1;
      continue;
    }
  }

  flushPendingRows();
  return { added, removed, hunks };
}

function parsePatchHeader(header: string): { leftStart: number; rightStart: number } | null {
  const match = header.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/u);
  if (!match) return null;
  return {
    leftStart: Number(match[1]),
    rightStart: Number(match[2]),
  };
}

function normalizePatchChangeType(value: unknown): ChatPatchChangeType {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (
    normalized === "create" ||
    normalized === "delete" ||
    normalized === "move" ||
    normalized === "rename" ||
    normalized === "update"
  ) {
    return normalized;
  }
  return "unknown";
}

function formatPatchDisplayPath(fsPath: string, sessionCwd?: string): string {
  const normalizedPath = path.normalize(String(fsPath ?? "").trim());
  if (!normalizedPath) return "";
  if (!sessionCwd) return normalizedPath;

  try {
    const relativePath = path.relative(sessionCwd, normalizedPath);
    if (relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
      return relativePath;
    }
  } catch {
    // Fall back to the original path when relative formatting fails.
  }
  return normalizedPath;
}

function parseClaudeMessageContent(content: unknown): {
  messageText: string;
  toolCalls: Array<{ callId?: string; name?: string; argumentsText?: string }>;
  toolResults: Array<{ callId?: string; outputText?: string; isError?: boolean }>;
} {
  if (typeof content === "string") {
    return { messageText: content, toolCalls: [], toolResults: [] };
  }
  const items = Array.isArray(content) ? content : content && typeof content === "object" ? [content] : null;
  if (!items) {
    return { messageText: "", toolCalls: [], toolResults: [] };
  }

  const messageTexts: string[] = [];
  const toolCalls: Array<{ callId?: string; name?: string; argumentsText?: string }> = [];
  const toolResults: Array<{ callId?: string; outputText?: string; isError?: boolean }> = [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const type = typeof (item as { type?: unknown }).type === "string" ? (item as { type: string }).type : "";

    if (type === "text" || type === "input_text" || type === "output_text") {
      const text = typeof (item as { text?: unknown }).text === "string" ? (item as { text: string }).text : "";
      if (text) messageTexts.push(text);
      continue;
    }

    if (type === "tool_use") {
      const callId =
        typeof (item as { id?: unknown }).id === "string"
          ? (item as { id: string }).id
          : typeof (item as { tool_use_id?: unknown }).tool_use_id === "string"
            ? (item as { tool_use_id: string }).tool_use_id
            : undefined;
      const name = typeof (item as { name?: unknown }).name === "string" ? (item as { name: string }).name : undefined;
      const input = (item as { input?: unknown }).input;
      const argumentsText =
        typeof input === "string" ? input : input !== undefined ? safeJsonStringify(input) : undefined;
      toolCalls.push({ callId, name, argumentsText });
      continue;
    }

    if (type === "tool_result") {
      const callId =
        typeof (item as { tool_use_id?: unknown }).tool_use_id === "string"
          ? (item as { tool_use_id: string }).tool_use_id
          : typeof (item as { id?: unknown }).id === "string"
            ? (item as { id: string }).id
            : undefined;
      const outputText = extractClaudeToolResultText((item as { content?: unknown }).content);
      const isError = (item as { is_error?: unknown }).is_error === true;
      toolResults.push({ callId, outputText, ...(isError ? { isError } : {}) });
      continue;
    }

    if (typeof (item as { text?: unknown }).text === "string") {
      messageTexts.push((item as { text: string }).text);
    }
  }

  return {
    messageText: messageTexts.join(""),
    toolCalls,
    toolResults,
  };
}

function detectClaudeMessageRole(obj: any): "user" | "assistant" | null {
  const messageRole = typeof obj?.message?.role === "string" ? obj.message.role : "";
  if (messageRole === "user" || messageRole === "assistant") return messageRole;

  const envelopeType = typeof obj?.type === "string" ? obj.type : "";
  if (envelopeType === "user" || envelopeType === "assistant") return envelopeType;

  const topRole = typeof obj?.role === "string" ? obj.role : "";
  if (topRole === "user" || topRole === "assistant") return topRole;

  return null;
}

function getClaudeMessageContent(obj: any): unknown {
  if (obj?.message && typeof obj.message === "object" && "content" in obj.message) {
    return (obj.message as { content?: unknown }).content;
  }
  if (obj && typeof obj === "object" && "content" in obj) return (obj as { content?: unknown }).content;
  return undefined;
}

function extractClaudeToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const item of content) {
      if (typeof item === "string") {
        texts.push(item);
        continue;
      }
      if (item && typeof item === "object") {
        const type = typeof (item as { type?: unknown }).type === "string" ? (item as { type: string }).type : "";
        if (type === "text" || type === "input_text" || type === "output_text") {
          const text = typeof (item as { text?: unknown }).text === "string" ? (item as { text: string }).text : "";
          if (text) texts.push(text);
          continue;
        }
        if (typeof (item as { text?: unknown }).text === "string") {
          texts.push((item as { text: string }).text);
          continue;
        }
      }
      texts.push(safeJsonStringify(item));
    }
    return texts.join("\n");
  }
  if (content === undefined) return "";
  return safeJsonStringify(content);
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeText(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}
