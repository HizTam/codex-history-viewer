import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type {
  ChatImageAttachment,
  ChatPatchChangeType,
  ChatPatchEntry,
  ChatPatchGroupItem,
  ChatPatchHunk,
  ChatPatchRow,
  ChatRole,
  ChatSessionMeta,
  ChatSessionModel,
  ChatTimelineItem,
  ChatToolItem,
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

      if (
        await indexCodexTimelineRecord(
          obj,
          items,
          toolByCallId,
          () => (messageIndex += 1),
          () => messageIndex,
          sessionCwd,
          options,
        )
      ) {
        continue;
      }
      if (indexCodexEventRecord(obj, items, pendingPatchGroups, () => messageIndex, sessionCwd, options)) {
        continue;
      }
      if (
        await indexClaudeTimelineRecord(
          obj,
          items,
          toolByCallId,
          () => (messageIndex += 1),
          () => messageIndex,
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
  finalizeTimelineItems(items);
  return items;
}

async function indexCodexTimelineRecord(
  obj: any,
  items: ChatTimelineItem[],
  toolByCallId: Map<string, ChatToolItem>,
  nextMessageIndex: () => number,
  currentMessageIndex: () => number,
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
      text,
      requestText,
      ...(images.length > 0 ? { images } : {}),
      isContext,
    });
    return true;
  }

  if (payloadType === "function_call") {
    const includeDetails = shouldIncludeDetails(options);
    const name = typeof obj?.payload?.name === "string" ? obj.payload.name : "function_call";
    const callId = typeof obj?.payload?.call_id === "string" ? obj.payload.call_id : undefined;
    const argumentsText = typeof obj?.payload?.arguments === "string" ? obj.payload.arguments : undefined;
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

  if (payloadType === "function_call_output") {
    const callId = typeof obj?.payload?.call_id === "string" ? obj.payload.call_id : undefined;
    const outputText = typeof obj?.payload?.output === "string" ? obj.payload.output : undefined;
    const ts = typeof obj?.timestamp === "string" ? obj.timestamp : undefined;

    attachOrPushToolOutput(items, toolByCallId, {
      callId,
      outputText,
      fallbackMessageIndex: currentMessageIndex(),
      timestampIso: ts,
      fallbackName: "function_call_output",
      includeDetails: shouldIncludeDetails(options),
    });
    return true;
  }

  return true;
}

function indexCodexEventRecord(
  obj: any,
  items: ChatTimelineItem[],
  pendingPatchGroups: Map<string, PendingPatchGroup>,
  currentMessageIndex: () => number,
  sessionCwd?: string,
  options: ChatSessionModelBuildOptions = {},
): boolean {
  if (obj?.type !== "event_msg") return false;

  const payloadType = typeof obj?.payload?.type === "string" ? obj.payload.type : "";
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

    items.push({
      type: "message",
      role,
      messageIndex: idx,
      timestampIso: ts,
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
    attachOrPushToolOutput(items, toolByCallId, {
      callId: toolResult.callId,
      outputText,
      fallbackMessageIndex: currentMessageIndex(),
      timestampIso: ts,
      fallbackName: "tool_result",
      includeDetails,
    });
  }

  return true;
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
  },
): void {
  const { callId, outputText, fallbackMessageIndex, timestampIso, fallbackName, includeDetails } = params;
  if (callId && toolByCallId.has(callId)) {
    const tool = toolByCallId.get(callId)!;
    if (includeDetails) tool.outputText = outputText;
    else if (hasText(outputText)) tool.detailsOmitted = true;
    if (!tool.timestampIso) tool.timestampIso = timestampIso;
    if (typeof tool.messageIndex !== "number" && typeof fallbackMessageIndex === "number") {
      tool.messageIndex = fallbackMessageIndex;
    }
    return;
  }

  const tool: ChatToolItem = {
    type: "tool",
    messageIndex: fallbackMessageIndex,
    timestampIso,
    name: fallbackName,
    callId,
    ...(includeDetails && outputText ? { outputText } : {}),
    ...(!includeDetails && hasText(outputText) ? { detailsOmitted: true } : {}),
  };
  if (!includeDetails) tool.presentation = buildToolPresentation(tool);
  items.push(tool);
}

function finalizeTimelineItems(items: ChatTimelineItem[]): void {
  for (const item of items) {
    if (item.type !== "tool") continue;
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
  toolResults: Array<{ callId?: string; outputText?: string }>;
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
  const toolResults: Array<{ callId?: string; outputText?: string }> = [];

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
      toolResults.push({ callId, outputText });
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
