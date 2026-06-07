import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type {
  ChatEnvironmentItem,
  ChatMessageItem,
  ChatMemoryCitation,
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
  assignAttachmentIds,
  extractClaudeMessageContent,
  extractCodexMessageContent,
  hasClaudeAttachmentLikeContent,
} from "./chatAttachments";
import { stripImagePlaceholders } from "./chatImageAttachments";
import { normalizeMemoryCitationPayload, splitTrailingMemoryCitationBlock } from "./memoryCitation";
import {
  buildClaudePatchBookmarkGroupId,
  buildCodexPatchBookmarkGroupId,
  resolveClaudeToolCallId,
} from "../services/bookmarkIdentity";

export interface ChatSessionModelBuildOptions {
  images?: ImagesConfig;
  includeDetails?: boolean;
}

export interface ChatPatchEntryDetailTarget {
  entryId: string;
  callId?: string;
  path?: string;
  displayPath?: string;
  movePath?: string;
  moveDisplayPath?: string;
  changeType?: ChatPatchChangeType;
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

export async function buildChatPatchEntryDetails(
  fsPath: string,
  target: ChatPatchEntryDetailTarget,
): Promise<ChatPatchEntry | null> {
  const entryId = typeof target.entryId === "string" ? target.entryId.trim() : "";
  if (!entryId) return null;

  const meta = await readSessionMeta(fsPath);
  return readPatchEntryDetails(fsPath, meta.cwd, { ...target, entryId });
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
  const memoryCitationState: MemoryCitationBuildState = {};
  let messageIndex = 0;
  let lineIndex = 0;

  try {
    for await (const line of rl) {
      lineIndex += 1;
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
          pendingPatchGroups,
          () => (messageIndex += 1),
          () => messageIndex,
          codexTurnMeta,
          memoryCitationState,
          sessionCwd,
          options,
          lineIndex,
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
          memoryCitationState,
          usageState,
          sessionCwd,
          options,
          lineIndex,
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
          lineIndex,
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

async function readPatchEntryDetails(
  fsPath: string,
  sessionCwd: string | undefined,
  target: ChatPatchEntryDetailTarget,
): Promise<ChatPatchEntry | null> {
  const stream = fs.createReadStream(fsPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const pendingApplyPatchEntries = new Map<string, ChatPatchEntry[]>();
  const entriesByGroup = new Map<string, ChatPatchEntry[]>();
  let messageIndex = 0;
  let lineIndex = 0;

  const appendGroupEntries = (groupKey: string, entries: ChatPatchEntry[]): void => {
    if (entries.length === 0) return;
    const bucket = entriesByGroup.get(groupKey);
    if (bucket) bucket.push(...entries);
    else entriesByGroup.set(groupKey, [...entries]);
  };

  try {
    for await (const line of rl) {
      lineIndex += 1;
      if (!line) continue;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      if (obj?.type === "response_item" && obj?.payload?.type === "message") {
        const role = obj?.payload?.role;
        if (role === "user" || role === "assistant") messageIndex += 1;
        continue;
      }

      const customApplyPatchInput = readCodexCustomApplyPatchInput(obj);
      if (customApplyPatchInput !== undefined) {
        const callId = typeof obj?.payload?.call_id === "string" ? obj.payload.call_id : `apply_patch:${lineIndex}`;
        const entries = buildCodexApplyPatchEntriesForDetailTarget(customApplyPatchInput, sessionCwd, callId, target);
        if (entries.length > 0) pendingApplyPatchEntries.set(callId, entries);
        continue;
      }

      if (obj?.type === "response_item" && isCodexToolCallOutput(obj?.payload?.type)) {
        const callId = typeof obj?.payload?.call_id === "string" ? obj.payload.call_id : undefined;
        const outputText = typeof obj?.payload?.output === "string" ? obj.payload.output : undefined;
        if (callId && isApplyPatchFailureOutput(outputText)) pendingApplyPatchEntries.delete(callId);
        continue;
      }

      if (obj?.type === "event_msg") {
        const payloadType = typeof obj?.payload?.type === "string" ? obj.payload.type : "";
        if (payloadType === "patch_apply_end") {
          const rawCallId = typeof obj?.payload?.call_id === "string" ? obj.payload.call_id : undefined;
          const callId = rawCallId ?? `patch:${lineIndex}`;
          const groupKey = buildPatchGroupKey(obj, lineIndex);
          if (rawCallId) pendingApplyPatchEntries.delete(rawCallId);
          if (isPatchApplyEndFailure(obj)) continue;
          appendGroupEntries(
            groupKey,
            buildCodexPatchEntriesForDetailTarget(obj?.payload?.changes, sessionCwd, callId, target),
          );
          continue;
        }
        continue;
      }

      const role = detectClaudeMessageRole(obj);
      if (!role) continue;
      const parsed = parseClaudeMessageContent(getClaudeMessageContent(obj));
      const stripped = stripImagePlaceholders(parsed.messageText);
      if (normalizeText(stripped.text) || hasClaudeAttachmentLikeContent(getClaudeMessageContent(obj))) messageIndex += 1;
      for (let toolCallIndex = 0; toolCallIndex < parsed.toolCalls.length; toolCallIndex += 1) {
        const toolCall = parsed.toolCalls[toolCallIndex]!;
        const callId = resolveClaudeToolCallId(toolCall.callId, lineIndex, toolCallIndex);
        const entries = buildClaudeToolUsePatchEntries(toolCall, sessionCwd, callId, true).filter((entry) =>
          isPatchEntryDetailCandidate(entry, target),
        );
        appendGroupEntries(buildClaudePatchBookmarkGroupId(toolCall.callId, lineIndex, toolCallIndex, messageIndex), entries);
      }
    }
  } finally {
    rl.close();
    stream.close();
  }

  for (const [key, entries] of pendingApplyPatchEntries.entries()) {
    appendGroupEntries(`apply:${key}`, entries);
  }
  return selectPatchEntryDetail(entriesByGroup, target);
}

async function indexCodexTimelineRecord(
  obj: any,
  items: ChatTimelineItem[],
  toolByCallId: Map<string, ChatToolItem>,
  pendingPatchGroups: Map<string, PendingPatchGroup>,
  nextMessageIndex: () => number,
  currentMessageIndex: () => number,
  codexTurnMeta: ChatMessageModelMeta,
  memoryCitationState: MemoryCitationBuildState,
  sessionCwd?: string,
  options: ChatSessionModelBuildOptions = {},
  lineIndex = 0,
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
    let text = normalizeText(parsed.text);
    const attachments = parsed.attachments;
    let memoryCitation: ChatMemoryCitation | undefined;
    if (role === "assistant") {
      const split = splitTrailingMemoryCitationBlock(text);
      text = normalizeText(split.text);
      memoryCitation = takePendingMemoryCitation(memoryCitationState) ?? split.memoryCitation;
    }
    if (!text && attachments.length === 0 && !memoryCitation) return true;

    const compactUserText = role === "user" ? extractCompactUserText(text) : null;
    const isBoilerplate = role === "assistant" ? false : isBoilerplateUserMessageText(text);
    const requestText = role === "user" ? compactUserText ?? text : undefined;
    // For user rows, treat only empty compact text as context.
    const isContext =
      role === "assistant" ? false : role === "user" ? !compactUserText && attachments.length === 0 : isBoilerplate;

    const ts = typeof obj?.timestamp === "string" ? obj.timestamp : undefined;
    const idx = role === "user" || role === "assistant" ? nextMessageIndex() : undefined;
    assignAttachmentIds(attachments, typeof idx === "number" ? `m${idx}` : `item${items.length}`);

    const item: ChatMessageItem = {
      type: "message",
      role,
      messageIndex: idx,
      timestampIso: ts,
      ...(role === "assistant" ? toMessageModelMeta(codexTurnMeta) : {}),
      text,
      requestText,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(memoryCitation ? { memoryCitation } : {}),
      isContext,
    };
    items.push(item);
    if (role === "assistant") memoryCitationState.lastAssistantItemIndex = items.length - 1;
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

    const customApplyPatchInput = readCodexCustomApplyPatchInput(obj);
    if (customApplyPatchInput !== undefined) {
      const patchCallId = callId ?? `apply_patch:${lineIndex}`;
      const matchEntries = buildCodexApplyPatchEntries(customApplyPatchInput, sessionCwd, patchCallId, includeDetails);
      const entries = mergePatchEntriesLikeCodex(matchEntries);
      if (entries.length > 0) {
        const applyGroupKey = buildApplyPatchPendingGroupKey(patchCallId, lineIndex);
        const group: PendingPatchGroup = {
          bookmarkGroupId: applyGroupKey,
          messageIndex: messageIndex > 0 ? messageIndex : undefined,
          firstTimestampIso: ts,
          lastTimestampIso: ts,
          entries,
          matchEntries,
          totalAdded: entries.reduce((sum, entry) => sum + entry.added, 0),
          totalRemoved: entries.reduce((sum, entry) => sum + entry.removed, 0),
        };
        items.push(toPatchGroupItem(group));
        pendingPatchGroups.set(applyGroupKey, {
          ...group,
          flushed: true,
          itemIndex: items.length - 1,
        });
      }
    }
    return true;
  }

  if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
    const callId = typeof obj?.payload?.call_id === "string" ? obj.payload.call_id : undefined;
    const outputText = typeof obj?.payload?.output === "string" ? obj.payload.output : undefined;
    const ts = typeof obj?.timestamp === "string" ? obj.timestamp : undefined;
    const execution = extractToolExecutionFromText(outputText);
    if (callId && isApplyPatchFailureOutput(outputText)) {
      removePendingApplyPatchGroup(items, pendingPatchGroups, callId);
    }

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
  memoryCitationState: MemoryCitationBuildState,
  usageState: UsageBuildState,
  sessionCwd?: string,
  options: ChatSessionModelBuildOptions = {},
  lineIndex = 0,
): boolean {
  if (obj?.type !== "event_msg") return false;

  const payloadType = typeof obj?.payload?.type === "string" ? obj.payload.type : "";
  const payloadPhase = typeof obj?.payload?.phase === "string" ? obj.payload.phase : "";
  if (payloadPhase === "final_answer") {
    const memoryCitation = normalizeMemoryCitationPayload(obj?.payload?.memory_citation);
    if (
      memoryCitation &&
      !attachMemoryCitationToLastAssistant(items, memoryCitationState, memoryCitation, currentMessageIndex())
    ) {
      memoryCitationState.pendingFinalAnswer = memoryCitation;
    }
  }

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
    const key = buildPatchGroupKey(obj, lineIndex);
    const bookmarkGroupId = buildCodexPatchBookmarkGroupId(obj, lineIndex);
    const turnId = typeof obj?.payload?.turn_id === "string" ? obj.payload.turn_id : undefined;
    const callId = typeof obj?.payload?.call_id === "string" ? obj.payload.call_id : undefined;
    const patchCallId = callId ?? `patch:${lineIndex}`;
    const timestampIso =
      typeof obj?.payload?.timestamp === "string"
        ? obj.payload.timestamp
        : typeof obj?.timestamp === "string"
          ? obj.timestamp
          : undefined;
    const matchEntries = buildPatchEntries(
      obj?.payload?.changes,
      sessionCwd,
      patchCallId,
      shouldIncludeDetails(options),
    );
    const entries = mergePatchEntriesLikeCodex(matchEntries);
    const removedByCallId = callId ? removePendingApplyPatchGroup(items, pendingPatchGroups, callId) : false;
    if (!removedByCallId && matchEntries.length > 0) {
      removeMatchingPendingApplyPatchGroup(items, pendingPatchGroups, matchEntries, currentMessageIndex());
    }
    if (isPatchApplyEndFailure(obj)) return true;
    if (entries.length === 0) return true;

    const existing = pendingPatchGroups.get(key);
    if (existing) {
      existing.lastTimestampIso = timestampIso ?? existing.lastTimestampIso;
      existing.entries = mergePatchEntriesLikeCodex([...existing.entries, ...entries]);
      existing.totalAdded = existing.entries.reduce((sum, entry) => sum + entry.added, 0);
      existing.totalRemoved = existing.entries.reduce((sum, entry) => sum + entry.removed, 0);
      return true;
    }

    pendingPatchGroups.set(key, {
      turnId,
      bookmarkGroupId,
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
    memoryCitationState.pendingFinalAnswer = undefined;
    memoryCitationState.lastAssistantItemIndex = undefined;
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
  lineIndex = 0,
): Promise<boolean> {
  const role = detectClaudeMessageRole(obj);
  if (!role) return false;

  const rawContent = getClaudeMessageContent(obj);
  const parsed = parseClaudeMessageContent(rawContent);
  const extracted = await extractClaudeMessageContent(rawContent, sessionCwd, toImageExtractionOptions(options.images));
  const attachments = extracted.attachments;
  const text = normalizeText(extracted.text);
  const ts = typeof obj?.timestamp === "string" ? obj.timestamp : undefined;

  if (text || attachments.length > 0) {
    const compactUserText = role === "user" ? extractCompactUserText(text) : null;
    const requestText = role === "user" ? compactUserText ?? text : undefined;
    const isContext = role === "user" ? !compactUserText && attachments.length === 0 : false;
    const idx = nextMessageIndex();
    assignAttachmentIds(attachments, `m${idx}`);
    const modelMeta = role === "assistant" ? extractClaudeMessageModelMeta(obj) : {};

    items.push({
      type: "message",
      role,
      messageIndex: idx,
      timestampIso: ts,
      ...modelMeta,
      text,
      requestText,
      ...(attachments.length > 0 ? { attachments } : {}),
      isContext,
    });
  }

  const includeDetails = shouldIncludeDetails(options);
  for (let toolCallIndex = 0; toolCallIndex < parsed.toolCalls.length; toolCallIndex += 1) {
    const toolCall = parsed.toolCalls[toolCallIndex]!;
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

    const patchEntries = buildClaudeToolUsePatchEntries(
      toolCall,
      sessionCwd,
      resolveClaudeToolCallId(callId, lineIndex, toolCallIndex),
      includeDetails,
    );
    if (patchEntries.length > 0) {
      const bookmarkGroupId = buildClaudePatchBookmarkGroupId(callId, lineIndex, toolCallIndex, messageIndex);
      items.push({
        type: "patchGroup",
        bookmarkGroupId,
        messageIndex: messageIndex > 0 ? messageIndex : undefined,
        timestampIso: ts,
        entryCount: patchEntries.length,
        totalAdded: patchEntries.reduce((sum, entry) => sum + entry.added, 0),
        totalRemoved: patchEntries.reduce((sum, entry) => sum + entry.removed, 0),
        entries: patchEntries,
      });
    }
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

interface MemoryCitationBuildState {
  pendingFinalAnswer?: ChatMemoryCitation;
  lastAssistantItemIndex?: number;
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

function takePendingMemoryCitation(state: MemoryCitationBuildState): ChatMemoryCitation | undefined {
  const citation = state.pendingFinalAnswer;
  state.pendingFinalAnswer = undefined;
  return citation;
}

function attachMemoryCitationToLastAssistant(
  items: ChatTimelineItem[],
  state: MemoryCitationBuildState,
  citation: ChatMemoryCitation,
  currentMessageIndex: number,
): boolean {
  const index = state.lastAssistantItemIndex;
  if (typeof index !== "number" || index < 0 || index >= items.length) return false;
  const item = items[index];
  if (!item || item.type !== "message" || item.role !== "assistant") return false;
  if (item.messageIndex !== currentMessageIndex) return false;
  item.memoryCitation = citation;
  return true;
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

interface PendingPatchGroup {
  turnId?: string;
  bookmarkGroupId?: string;
  messageIndex?: number;
  firstTimestampIso?: string;
  lastTimestampIso?: string;
  entries: ChatPatchEntry[];
  matchEntries?: ChatPatchEntry[];
  totalAdded: number;
  totalRemoved: number;
  flushed?: boolean;
  itemIndex?: number;
}

interface ApplyPatchFileAccumulator {
  path: string;
  movePath?: string;
  changeType: ChatPatchChangeType;
  added: number;
  removed: number;
  hunks: ChatPatchHunk[];
  currentHunk: ChatPatchHunk | null;
  rightLine: number;
  pendingDeletes: string[];
  pendingAdds: string[];
}

function flushPendingPatchGroup(
  items: ChatTimelineItem[],
  pendingPatchGroups: Map<string, PendingPatchGroup>,
  turnId: string,
): void {
  const group = pendingPatchGroups.get(turnId);
  if (!group) return;
  if (!group.flushed) items.push(toPatchGroupItem(group));
  pendingPatchGroups.delete(turnId);
}

function flushPendingPatchGroups(
  items: ChatTimelineItem[],
  pendingPatchGroups: Map<string, PendingPatchGroup>,
): void {
  for (const [key, group] of pendingPatchGroups.entries()) {
    if (!group.flushed) items.push(toPatchGroupItem(group));
    pendingPatchGroups.delete(key);
  }
}

function toPatchGroupItem(group: PendingPatchGroup): ChatPatchGroupItem {
  return {
    type: "patchGroup",
    messageIndex: group.messageIndex,
    timestampIso: group.lastTimestampIso ?? group.firstTimestampIso,
    turnId: group.turnId,
    bookmarkGroupId: group.bookmarkGroupId,
    entryCount: group.entries.length,
    totalAdded: group.totalAdded,
    totalRemoved: group.totalRemoved,
    entries: group.entries,
  };
}

function buildPatchGroupKey(obj: any, fallbackIndex?: number): string {
  const turnId = typeof obj?.payload?.turn_id === "string" ? obj.payload.turn_id.trim() : "";
  if (turnId) return turnId;
  const callId = typeof obj?.payload?.call_id === "string" ? obj.payload.call_id.trim() : "";
  if (callId) return `call:${callId}`;
  const timestampIso =
    typeof obj?.payload?.timestamp === "string"
      ? obj.payload.timestamp.trim()
      : typeof obj?.timestamp === "string"
        ? obj.timestamp.trim()
        : "";
  if (timestampIso) return `ts:${timestampIso}`;
  return typeof fallbackIndex === "number" && Number.isFinite(fallbackIndex) && fallbackIndex > 0
    ? `line:${Math.floor(fallbackIndex)}`
    : "patch";
}

function buildApplyPatchPendingGroupKey(callId: string | undefined, fallbackIndex: number): string {
  const normalizedCallId = typeof callId === "string" ? callId.trim() : "";
  return normalizedCallId ? `apply:${normalizedCallId}` : `apply:${fallbackIndex}`;
}

function removePendingApplyPatchGroup(
  items: ChatTimelineItem[],
  pendingPatchGroups: Map<string, PendingPatchGroup>,
  callId: string,
): boolean {
  const key = buildApplyPatchPendingGroupKey(callId, 0);
  const group = pendingPatchGroups.get(key);
  if (!group) return false;
  removePendingPatchGroupByKey(items, pendingPatchGroups, key, group);
  return true;
}

function removeMatchingPendingApplyPatchGroup(
  items: ChatTimelineItem[],
  pendingPatchGroups: Map<string, PendingPatchGroup>,
  entries: ChatPatchEntry[],
  messageIndex: number,
): boolean {
  const targetSignature = buildPatchEntriesSignature(entries);
  if (!targetSignature) return false;

  let fallback: { key: string; group: PendingPatchGroup } | undefined;
  for (const [key, group] of pendingPatchGroups.entries()) {
    if (!key.startsWith("apply:")) continue;
    if (buildPatchEntriesSignature(group.matchEntries ?? group.entries) !== targetSignature) continue;
    if (messageIndex > 0 && group.messageIndex === messageIndex) {
      removePendingPatchGroupByKey(items, pendingPatchGroups, key, group);
      return true;
    }
    fallback = { key, group };
  }

  if (!fallback) return false;
  removePendingPatchGroupByKey(items, pendingPatchGroups, fallback.key, fallback.group);
  return true;
}

function removePendingPatchGroupByKey(
  items: ChatTimelineItem[],
  pendingPatchGroups: Map<string, PendingPatchGroup>,
  key: string,
  group: PendingPatchGroup,
): void {
  if (group.flushed && typeof group.itemIndex === "number") {
    removeFlushedPatchGroupItem(items, pendingPatchGroups, group);
  }
  pendingPatchGroups.delete(key);
}

function removeFlushedPatchGroupItem(
  items: ChatTimelineItem[],
  pendingPatchGroups: Map<string, PendingPatchGroup>,
  group: PendingPatchGroup,
): void {
  const preferredIndex = group.itemIndex;
  const removeAt = (index: number): void => {
    items.splice(index, 1);
    for (const pending of pendingPatchGroups.values()) {
      if (!pending.flushed || typeof pending.itemIndex !== "number" || pending.itemIndex <= index) continue;
      pending.itemIndex -= 1;
    }
  };

  if (
    typeof preferredIndex === "number" &&
    items[preferredIndex]?.type === "patchGroup" &&
    (items[preferredIndex] as ChatPatchGroupItem).entries === group.entries
  ) {
    removeAt(preferredIndex);
    return;
  }

  const fallbackIndex = items.findIndex(
    (item) => item.type === "patchGroup" && (item as ChatPatchGroupItem).entries === group.entries,
  );
  if (fallbackIndex >= 0) removeAt(fallbackIndex);
}

function mergePatchEntriesLikeCodex(entries: readonly ChatPatchEntry[]): ChatPatchEntry[] {
  const out: ChatPatchEntry[] = [];
  const updateIndexByPath = new Map<string, number>();

  for (const entry of entries) {
    const resetKey = getCodexPatchMergePath(entry);
    const canMerge = entry.changeType === "update" && !entry.movePath && !entry.moveDisplayPath;

    if (canMerge && resetKey) {
      const existingIndex = updateIndexByPath.get(resetKey);
      if (existingIndex !== undefined) {
        out[existingIndex] = mergePatchEntry(out[existingIndex]!, entry);
        continue;
      }
    }

    out.push(clonePatchEntry(entry));
    if (!resetKey) continue;
    if (canMerge) updateIndexByPath.set(resetKey, out.length - 1);
    else updateIndexByPath.delete(resetKey);
  }

  return out;
}

function mergePatchEntry(base: ChatPatchEntry, next: ChatPatchEntry): ChatPatchEntry {
  return {
    ...base,
    added: (base.added || 0) + (next.added || 0),
    removed: (base.removed || 0) + (next.removed || 0),
    detailsOmitted: base.detailsOmitted === true || next.detailsOmitted === true ? true : undefined,
    hunks: [...(base.hunks ?? []), ...(next.hunks ?? [])],
  };
}

function clonePatchEntry(entry: ChatPatchEntry): ChatPatchEntry {
  return {
    ...entry,
    hunks: [...(entry.hunks ?? [])],
  };
}

function getCodexPatchMergePath(entry: ChatPatchEntry): string {
  const raw = entry.movePath || entry.moveDisplayPath || entry.path || entry.displayPath;
  return normalizePatchSignaturePath(raw).toLowerCase();
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
    const content = typeof change.content === "string" ? change.content : undefined;
    const parsed = parseCodexPatchApplyEndChange(changeType, unifiedDiff, content, includeDetails);
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
      ...(!includeDetails && parsed.hasDetails ? { detailsOmitted: true } : {}),
      hunks: parsed.hunks,
    });
    index += 1;
  }
  return entries;
}

function readCodexCustomApplyPatchInput(obj: any): string | undefined {
  if (obj?.type !== "response_item" || obj?.payload?.type !== "custom_tool_call") return undefined;
  if (normalizePatchToolName(obj?.payload?.name) !== "applypatch") return undefined;
  return typeof obj?.payload?.input === "string" ? obj.payload.input : undefined;
}

function buildCodexApplyPatchEntries(
  patchText: string,
  sessionCwd: string | undefined,
  callId: string,
  includeDetails: boolean,
): ChatPatchEntry[] {
  const lines = String(patchText ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const entries: ChatPatchEntry[] = [];
  let current: ApplyPatchFileAccumulator | null = null;
  let index = 0;

  const flush = (): void => {
    if (!current) return;
    flushApplyPatchPendingRows(current);
    if (hasRenderableApplyPatch(current)) {
      entries.push({
        id: `${callId}:apply:${index}`,
        callId,
        path: current.path,
        displayPath: formatPatchDisplayPath(current.path, sessionCwd),
        movePath: current.movePath,
        moveDisplayPath: current.movePath ? formatPatchDisplayPath(current.movePath, sessionCwd) : undefined,
        changeType: current.changeType,
        added: current.added,
        removed: current.removed,
        ...(!includeDetails ? { detailsOmitted: true } : {}),
        hunks: includeDetails ? current.hunks : [],
      });
      index += 1;
    }
    current = null;
  };

  for (const line of lines) {
    if (line === "*** Begin Patch" || line === "*** End Patch") continue;
    if (line.startsWith("*** Add File: ")) {
      flush();
      current = createApplyPatchFileAccumulator(line.slice("*** Add File: ".length), "create");
      if (includeDetails) {
        current.currentHunk = { header: "@@ -0,0 +1 @@", rows: [] };
        current.hunks.push(current.currentHunk);
      }
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      flush();
      current = createApplyPatchFileAccumulator(line.slice("*** Update File: ".length), "update");
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      flush();
      current = createApplyPatchFileAccumulator(line.slice("*** Delete File: ".length), "delete");
      continue;
    }
    if (!current) continue;

    if (line.startsWith("*** Move to: ")) {
      current.movePath = line.slice("*** Move to: ".length).trim();
      current.changeType = "move";
      continue;
    }
    if (line === "*** End of File") continue;
    if (line.startsWith("*** ")) continue;

    if (line.startsWith("@@")) {
      flushApplyPatchPendingRows(current);
      if (includeDetails) {
        current.currentHunk = { header: line, rows: [] };
        current.hunks.push(current.currentHunk);
      }
      continue;
    }

    appendApplyPatchChangeLine(current, line, includeDetails);
  }
  flush();
  return entries;
}

function buildCodexPatchEntriesForDetailTarget(
  changes: unknown,
  sessionCwd: string | undefined,
  callId: string,
  target: ChatPatchEntryDetailTarget,
): ChatPatchEntry[] {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return [];

  const entries: ChatPatchEntry[] = [];
  let index = 0;
  for (const [rawPath, rawChange] of Object.entries(changes as Record<string, unknown>)) {
    const change = rawChange && typeof rawChange === "object" ? (rawChange as Record<string, unknown>) : {};
    const changeType = normalizePatchChangeType(change.type);
    const movePath = typeof change.move_path === "string" ? change.move_path : undefined;
    const displayPath = formatPatchDisplayPath(rawPath, sessionCwd);
    const moveDisplayPath = movePath ? formatPatchDisplayPath(movePath, sessionCwd) : undefined;
    const id = `${callId ?? "patch"}:${index}`;
    const candidate = {
      id,
      callId,
      path: rawPath,
      displayPath,
      movePath,
      moveDisplayPath,
      changeType,
    };
    if (isPatchEntryDetailCandidate(candidate, target)) {
      const unifiedDiff = typeof change.unified_diff === "string" ? change.unified_diff : "";
      const content = typeof change.content === "string" ? change.content : undefined;
      const parsed = parseCodexPatchApplyEndChange(changeType, unifiedDiff, content, true);
      entries.push({
        ...candidate,
        added: parsed.added,
        removed: parsed.removed,
        hunks: parsed.hunks,
      });
    }
    index += 1;
  }
  return entries;
}

function buildCodexApplyPatchEntriesForDetailTarget(
  patchText: string,
  sessionCwd: string | undefined,
  callId: string,
  target: ChatPatchEntryDetailTarget,
): ChatPatchEntry[] {
  const lines = String(patchText ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const entries: ChatPatchEntry[] = [];
  let current: ApplyPatchFileAccumulator | null = null;
  let includeCurrentDetails = false;
  let index = 0;

  const refreshCurrentDetailsFlag = (): void => {
    if (!current) return;
    includeCurrentDetails = isPatchEntryDetailCandidate(
      {
        id: `${callId}:apply:${index}`,
        callId,
        path: current.path,
        displayPath: formatPatchDisplayPath(current.path, sessionCwd),
        movePath: current.movePath,
        moveDisplayPath: current.movePath ? formatPatchDisplayPath(current.movePath, sessionCwd) : undefined,
        changeType: current.changeType,
      },
      target,
    );
    if (includeCurrentDetails && !current.currentHunk && current.hunks.length === 0) {
      current.currentHunk = {
        header: current.changeType === "create" ? "@@ -0,0 +1 @@" : "@@",
        rows: [],
      };
      current.hunks.push(current.currentHunk);
    }
  };

  const flush = (): void => {
    if (!current) return;
    flushApplyPatchPendingRows(current);
    if (hasRenderableApplyPatch(current)) {
      if (includeCurrentDetails) {
        entries.push({
          id: `${callId}:apply:${index}`,
          callId,
          path: current.path,
          displayPath: formatPatchDisplayPath(current.path, sessionCwd),
          movePath: current.movePath,
          moveDisplayPath: current.movePath ? formatPatchDisplayPath(current.movePath, sessionCwd) : undefined,
          changeType: current.changeType,
          added: current.added,
          removed: current.removed,
          hunks: current.hunks,
        });
      }
      index += 1;
    }
    current = null;
    includeCurrentDetails = false;
  };

  for (const line of lines) {
    if (line === "*** Begin Patch" || line === "*** End Patch") continue;
    if (line.startsWith("*** Add File: ")) {
      flush();
      current = createApplyPatchFileAccumulator(line.slice("*** Add File: ".length), "create");
      refreshCurrentDetailsFlag();
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      flush();
      current = createApplyPatchFileAccumulator(line.slice("*** Update File: ".length), "update");
      refreshCurrentDetailsFlag();
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      flush();
      current = createApplyPatchFileAccumulator(line.slice("*** Delete File: ".length), "delete");
      refreshCurrentDetailsFlag();
      continue;
    }
    if (!current) continue;

    if (line.startsWith("*** Move to: ")) {
      current.movePath = line.slice("*** Move to: ".length).trim();
      current.changeType = "move";
      refreshCurrentDetailsFlag();
      continue;
    }
    if (line === "*** End of File") continue;
    if (line.startsWith("*** ")) continue;

    if (line.startsWith("@@")) {
      flushApplyPatchPendingRows(current);
      if (includeCurrentDetails) {
        current.currentHunk = { header: line, rows: [] };
        current.hunks.push(current.currentHunk);
      }
      continue;
    }

    appendApplyPatchChangeLine(current, line, includeCurrentDetails);
  }
  flush();
  return entries;
}

function isPatchApplyEndFailure(obj: any): boolean {
  const payload = obj?.payload && typeof obj.payload === "object" ? obj.payload : {};
  if (typeof payload.success === "boolean") return !payload.success;
  const status = typeof payload.status === "string" ? payload.status.trim().toLowerCase() : "";
  return (
    status === "failed" ||
    status === "failure" ||
    status === "error" ||
    status === "cancelled" ||
    status === "canceled"
  );
}

function isCodexToolCallOutput(payloadType: unknown): boolean {
  return payloadType === "function_call_output" || payloadType === "custom_tool_call_output";
}

function isApplyPatchFailureOutput(outputText: string | undefined): boolean {
  const text = String(outputText ?? "").trim().toLowerCase();
  if (!text) return false;
  return (
    text.includes("apply_patch verification failed") ||
    text.includes("apply_patch failed") ||
    text.includes("failed to apply patch") ||
    text.includes("failed to find expected lines") ||
    text.includes("invalid context")
  );
}

function buildPatchEntriesSignature(entries: ChatPatchEntry[]): string {
  if (entries.length === 0) return "";
  return entries.map(buildPatchEntrySignature).sort().join("\n");
}

function selectPatchEntryDetail(
  entriesByGroup: Map<string, ChatPatchEntry[]>,
  target: ChatPatchEntryDetailTarget,
): ChatPatchEntry | null {
  let fallback: ChatPatchEntry | null = null;
  for (const entries of entriesByGroup.values()) {
    const merged = mergePatchEntriesLikeCodex(entries);
    const exact = merged.find((entry) => entry.id === target.entryId);
    if (exact) return toLoadedPatchEntryDetail(exact);
    if (!fallback) {
      const candidate = merged.find((entry) => isPatchEntryDetailCandidate(entry, target));
      if (candidate) fallback = candidate;
    }
  }
  return fallback ? toLoadedPatchEntryDetail(fallback) : null;
}

function toLoadedPatchEntryDetail(entry: ChatPatchEntry): ChatPatchEntry {
  const loaded = clonePatchEntry(entry);
  delete loaded.detailsOmitted;
  return loaded;
}

function isPatchEntryDetailCandidate(
  entry: Pick<
    ChatPatchEntry,
    "id" | "callId" | "path" | "displayPath" | "movePath" | "moveDisplayPath" | "changeType"
  >,
  target: ChatPatchEntryDetailTarget,
): boolean {
  if (entry.id && entry.id === target.entryId) return true;
  if (target.changeType && entry.changeType !== target.changeType) return false;

  const targetPaths = getPatchDetailTargetPaths(target);
  if (targetPaths.size === 0) return false;
  const entryPaths = [
    entry.path,
    entry.displayPath,
    entry.movePath,
    entry.moveDisplayPath,
  ]
    .map((value) => normalizePatchSignaturePath(value))
    .filter((value) => value.length > 0);
  return entryPaths.some((value) => targetPaths.has(value));
}

function getPatchDetailTargetPaths(target: ChatPatchEntryDetailTarget): Set<string> {
  const values = [target.path, target.displayPath, target.movePath, target.moveDisplayPath]
    .map((value) => normalizePatchSignaturePath(value))
    .filter((value) => value.length > 0);
  return new Set(values);
}

function buildPatchEntrySignature(entry: ChatPatchEntry): string {
  return [
    normalizePatchSignaturePath(entry.path || entry.displayPath),
    normalizePatchSignaturePath(entry.movePath || entry.moveDisplayPath || ""),
    entry.changeType || "unknown",
    String(entry.added || 0),
    String(entry.removed || 0),
  ].join("\u0001");
}

function normalizePatchSignaturePath(value: string | undefined): string {
  let text = String(value ?? "").trim().replace(/^"|"$/g, "");
  const tabIndex = text.indexOf("\t");
  if (tabIndex >= 0) text = text.slice(0, tabIndex).trim();
  if (text.startsWith("a/") || text.startsWith("b/")) text = text.slice(2);
  if (text === "/dev/null") return "";
  return path.normalize(text).replace(/\\/g, "/");
}

function createApplyPatchFileAccumulator(filePath: string, changeType: ChatPatchChangeType): ApplyPatchFileAccumulator {
  return {
    path: filePath.trim(),
    changeType,
    added: 0,
    removed: 0,
    hunks: [],
    currentHunk: null,
    rightLine: 1,
    pendingDeletes: [],
    pendingAdds: [],
  };
}

function hasRenderableApplyPatch(acc: ApplyPatchFileAccumulator): boolean {
  if ((acc.added || 0) > 0 || (acc.removed || 0) > 0) return true;
  if (acc.changeType === "delete" || !!acc.movePath) return true;
  return acc.hunks.some((hunk) => hunk.rows.length > 0);
}

function appendApplyPatchChangeLine(
  acc: ApplyPatchFileAccumulator,
  line: string,
  includeDetails: boolean,
): void {
  if (includeDetails && !acc.currentHunk) {
    acc.currentHunk = { header: "@@", rows: [] };
    acc.hunks.push(acc.currentHunk);
  }

  if (acc.changeType === "create") {
    if (!line.startsWith("+")) return;
    if (includeDetails && acc.currentHunk) {
      acc.currentHunk.rows.push({
        kind: "add",
        leftText: "",
        rightLine: acc.rightLine,
        rightText: line.slice(1),
      });
    }
    acc.rightLine += 1;
    acc.added += 1;
    return;
  }

  const marker = line[0];
  const text = line.slice(1);
  if (marker === " ") {
    flushApplyPatchPendingRows(acc);
    if (includeDetails && acc.currentHunk) {
      acc.currentHunk.rows.push({
        kind: "context",
        leftText: text,
        rightText: text,
      });
    }
    return;
  }
  if (marker === "-") {
    if (includeDetails) acc.pendingDeletes.push(text);
    acc.removed += 1;
    return;
  }
  if (marker === "+") {
    if (includeDetails) acc.pendingAdds.push(text);
    acc.added += 1;
  }
}

function flushApplyPatchPendingRows(acc: ApplyPatchFileAccumulator): void {
  const hunk = acc.currentHunk;
  if (!hunk || (acc.pendingDeletes.length === 0 && acc.pendingAdds.length === 0)) return;
  const count = Math.max(acc.pendingDeletes.length, acc.pendingAdds.length);
  for (let i = 0; i < count; i += 1) {
    const leftText = acc.pendingDeletes[i];
    const rightText = acc.pendingAdds[i];
    hunk.rows.push({
      kind: leftText !== undefined && rightText !== undefined ? "modify" : leftText !== undefined ? "delete" : "add",
      leftText: leftText ?? "",
      rightText: rightText ?? "",
    });
  }
  acc.pendingDeletes = [];
  acc.pendingAdds = [];
}

function buildClaudeToolUsePatchEntries(
  toolCall: { name?: string; input?: unknown },
  sessionCwd: string | undefined,
  callId: string,
  includeDetails: boolean,
): ChatPatchEntry[] {
  const input =
    typeof toolCall.input === "string" ? tryParseJsonObject(toolCall.input) ?? toolCall.input : toolCall.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];

  const toolName = normalizeClaudeToolName(toolCall.name);
  const filePath = readClaudeToolPath(input as Record<string, unknown>);
  if (!filePath) return [];

  if (toolName.includes("multiedit")) {
    const edits = Array.isArray((input as { edits?: unknown }).edits) ? (input as { edits: unknown[] }).edits : [];
    const hunks: ChatPatchHunk[] = [];
    let added = 0;
    let removed = 0;
    for (let i = 0; i < edits.length; i += 1) {
      const edit = edits[i];
      const oldText = readClaudeToolString(edit, ["old_string", "oldString"]);
      const newText = readClaudeToolString(edit, ["new_string", "newString"]);
      if (oldText === undefined || newText === undefined || oldText === newText) continue;
      const hunk = buildSyntheticPatchHunk(oldText, newText, `@@ edit ${i + 1} @@`, includeDetails);
      added += splitPatchContentLines(newText).length;
      removed += splitPatchContentLines(oldText).length;
      hunks.push(hunk);
    }
    if (hunks.length === 0) return [];
    return [
      buildSyntheticPatchEntry({
        id: `${callId}:0`,
        callId,
        filePath,
        sessionCwd,
        changeType: "update",
        added,
        removed,
        hunks,
        includeDetails,
      }),
    ];
  }

  if (toolName.includes("edit")) {
    const oldText = readClaudeToolString(input, ["old_string", "oldString"]);
    const newText = readClaudeToolString(input, ["new_string", "newString"]);
    if (oldText === undefined || newText === undefined || oldText === newText) return [];
    const hunk = buildSyntheticPatchHunk(oldText, newText, "@@ -1 +1 @@", includeDetails);
    const added = splitPatchContentLines(newText).length;
    const removed = splitPatchContentLines(oldText).length;
    return [
      buildSyntheticPatchEntry({
        id: `${callId}:0`,
        callId,
        filePath,
        sessionCwd,
        changeType: "update",
        added,
        removed,
        hunks: [hunk],
        includeDetails,
      }),
    ];
  }

  if (toolName.includes("write")) {
    const content = readClaudeToolString(input, ["content"]);
    if (content === undefined) return [];
    const lines = splitPatchContentLines(content);
    if (lines.length === 0) return [];
    const hunk: ChatPatchHunk = {
      header: `@@ -0,0 +1,${lines.length} @@`,
      rows: includeDetails
        ? lines.map((line, index) => ({
            kind: "add",
            leftText: "",
            rightLine: index + 1,
            rightText: line,
          }))
        : [],
    };
    return [
      buildSyntheticPatchEntry({
        id: `${callId}:0`,
        callId,
        filePath,
        sessionCwd,
        changeType: "create",
        added: lines.length,
        removed: 0,
        hunks: [hunk],
        includeDetails,
      }),
    ];
  }

  return [];
}

function buildSyntheticPatchEntry(params: {
  id: string;
  callId: string;
  filePath: string;
  sessionCwd?: string;
  changeType: ChatPatchChangeType;
  added: number;
  removed: number;
  hunks: ChatPatchHunk[];
  includeDetails: boolean;
}): ChatPatchEntry {
  return {
    id: params.id,
    callId: params.callId,
    path: params.filePath,
    displayPath: formatPatchDisplayPath(params.filePath, params.sessionCwd),
    changeType: params.changeType,
    added: params.added,
    removed: params.removed,
    ...(!params.includeDetails ? { detailsOmitted: true } : {}),
    hunks: params.includeDetails ? params.hunks : [],
  };
}

function buildSyntheticPatchHunk(
  oldText: string,
  newText: string,
  header: string,
  includeDetails: boolean,
): ChatPatchHunk {
  const oldLines = splitPatchContentLines(oldText);
  const newLines = splitPatchContentLines(newText);
  if (!includeDetails) return { header, rows: [] };
  const rows: ChatPatchRow[] = [];
  const count = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < count; i += 1) {
    const hasOld = i < oldLines.length;
    const hasNew = i < newLines.length;
    rows.push({
      kind: hasOld && hasNew ? "modify" : hasOld ? "delete" : "add",
      leftLine: hasOld ? i + 1 : undefined,
      leftText: hasOld ? oldLines[i]! : "",
      rightLine: hasNew ? i + 1 : undefined,
      rightText: hasNew ? newLines[i]! : "",
    });
  }
  return { header, rows };
}

function splitPatchContentLines(value: string): string[] {
  const normalized = String(value ?? "").replace(/^\uFEFF/u, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized) return [];
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function readClaudeToolPath(value: Record<string, unknown>): string | undefined {
  return readClaudeToolString(value, ["file_path", "filePath", "path", "target_file", "targetPath"]);
}

function readClaudeToolString(value: unknown, keys: readonly string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}

function normalizeClaudeToolName(value: unknown): string {
  return String(value ?? "").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function normalizePatchToolName(value: unknown): string {
  return String(value ?? "").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function tryParseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseCodexPatchApplyEndChange(
  changeType: ChatPatchChangeType,
  unifiedDiff: string,
  content: string | undefined,
  includeDetails: boolean,
): { added: number; removed: number; hunks: ChatPatchHunk[]; hasDetails: boolean } {
  if (hasText(unifiedDiff)) {
    return {
      ...parseUnifiedDiff(unifiedDiff, includeDetails),
      hasDetails: true,
    };
  }

  if (content === undefined || (changeType !== "create" && changeType !== "delete")) {
    return { added: 0, removed: 0, hunks: [], hasDetails: false };
  }

  const lines = splitPatchContentLines(content);
  const isCreate = changeType === "create";
  const hunk: ChatPatchHunk = {
    header: isCreate ? `@@ -0,0 +1,${lines.length} @@` : `@@ -1,${lines.length} +0,0 @@`,
    rows: includeDetails
      ? lines.map((line, index) =>
          isCreate
            ? {
                kind: "add",
                leftText: "",
                rightLine: index + 1,
                rightText: line,
              }
            : {
                kind: "delete",
                leftLine: index + 1,
                leftText: line,
                rightText: "",
              },
        )
      : [],
  };

  return {
    added: isCreate ? lines.length : 0,
    removed: isCreate ? 0 : lines.length,
    hunks: includeDetails && lines.length > 0 ? [hunk] : [],
    hasDetails: lines.length > 0,
  };
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
  if (normalized === "add") return "create";
  if (normalized === "remove") return "delete";
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
  toolCalls: Array<{ callId?: string; name?: string; argumentsText?: string; input?: unknown }>;
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
  const toolCalls: Array<{ callId?: string; name?: string; argumentsText?: string; input?: unknown }> = [];
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
      toolCalls.push({ callId, name, argumentsText, input });
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
