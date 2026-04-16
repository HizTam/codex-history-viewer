import * as fs from "node:fs";
import * as readline from "node:readline";
import type { ChatRole, ChatSessionMeta, ChatSessionModel, ChatTimelineItem, ChatToolItem } from "./chatTypes";
import { tryReadSessionMeta } from "../sessions/sessionSummary";
import { extractCompactUserText, isBoilerplateUserMessageText } from "../utils/textUtils";
import { buildToolPresentation } from "../tools/toolSemantics";

// Parse a session JSONL and build a chat-view model.
export async function buildChatSessionModel(fsPath: string): Promise<ChatSessionModel> {
  const meta = await readSessionMeta(fsPath);
  const items = await readTimelineItems(fsPath);
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

async function readTimelineItems(fsPath: string): Promise<ChatTimelineItem[]> {
  const stream = fs.createReadStream(fsPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const items: ChatTimelineItem[] = [];
  const toolByCallId = new Map<string, ChatToolItem>();
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

      if (indexCodexTimelineRecord(obj, items, toolByCallId, () => (messageIndex += 1), () => messageIndex)) {
        continue;
      }
      if (indexClaudeTimelineRecord(obj, items, toolByCallId, () => (messageIndex += 1), () => messageIndex)) {
        continue;
      }
    }
  } finally {
    rl.close();
    stream.close();
  }

  finalizeTimelineItems(items);
  return items;
}

function indexCodexTimelineRecord(
  obj: any,
  items: ChatTimelineItem[],
  toolByCallId: Map<string, ChatToolItem>,
  nextMessageIndex: () => number,
  currentMessageIndex: () => number,
): boolean {
  if (obj?.type !== "response_item") return false;
  const payloadType = obj?.payload?.type;

  if (payloadType === "message") {
    const role = obj?.payload?.role as ChatRole | undefined;
    if (role !== "developer" && role !== "user" && role !== "assistant") return true;

    const textRaw = extractTextFromCodexContent(obj?.payload?.content);
    const text = normalizeText(textRaw);
    if (!text) return true;

    const compactUserText = role === "user" ? extractCompactUserText(text) : null;
    const isBoilerplate = role === "assistant" ? false : isBoilerplateUserMessageText(text);
    const requestText = role === "user" ? compactUserText ?? text : undefined;
    // For user rows, treat only empty compact text as context.
    const isContext =
      role === "assistant" ? false : role === "user" ? !compactUserText : isBoilerplate;

    const ts = typeof obj?.timestamp === "string" ? obj.timestamp : undefined;
    const idx = role === "user" || role === "assistant" ? nextMessageIndex() : undefined;

    items.push({
      type: "message",
      role,
      messageIndex: idx,
      timestampIso: ts,
      text,
      requestText,
      isContext,
    });
    return true;
  }

  if (payloadType === "function_call") {
    const name = typeof obj?.payload?.name === "string" ? obj.payload.name : "function_call";
    const callId = typeof obj?.payload?.call_id === "string" ? obj.payload.call_id : undefined;
    const argumentsText = typeof obj?.payload?.arguments === "string" ? obj.payload.arguments : undefined;
    const ts = typeof obj?.timestamp === "string" ? obj.timestamp : undefined;
    const messageIndex = currentMessageIndex();

    const tool: ChatToolItem = { type: "tool", messageIndex, timestampIso: ts, name, callId, argumentsText };
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
    });
    return true;
  }

  return true;
}

function indexClaudeTimelineRecord(
  obj: any,
  items: ChatTimelineItem[],
  toolByCallId: Map<string, ChatToolItem>,
  nextMessageIndex: () => number,
  currentMessageIndex: () => number,
): boolean {
  const role = detectClaudeMessageRole(obj);
  if (!role) return false;

  const parsed = parseClaudeMessageContent(getClaudeMessageContent(obj));
  const text = normalizeText(parsed.messageText);
  const ts = typeof obj?.timestamp === "string" ? obj.timestamp : undefined;

  if (text) {
    const compactUserText = role === "user" ? extractCompactUserText(text) : null;
    const requestText = role === "user" ? compactUserText ?? text : undefined;
    const isContext = role === "user" ? !compactUserText : false;

    items.push({
      type: "message",
      role,
      messageIndex: nextMessageIndex(),
      timestampIso: ts,
      text,
      requestText,
      isContext,
    });
  }

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
      argumentsText,
    };
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
  },
): void {
  const { callId, outputText, fallbackMessageIndex, timestampIso, fallbackName } = params;
  if (callId && toolByCallId.has(callId)) {
    const tool = toolByCallId.get(callId)!;
    tool.outputText = outputText;
    if (!tool.timestampIso) tool.timestampIso = timestampIso;
    if (typeof tool.messageIndex !== "number" && typeof fallbackMessageIndex === "number") {
      tool.messageIndex = fallbackMessageIndex;
    }
    return;
  }

  items.push({
    type: "tool",
    messageIndex: fallbackMessageIndex,
    timestampIso,
    name: fallbackName,
    callId,
    outputText,
  });
}

function finalizeTimelineItems(items: ChatTimelineItem[]): void {
  for (const item of items) {
    if (item.type !== "tool") continue;
    item.presentation = buildToolPresentation(item);
  }
}

function extractTextFromCodexContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const maybeText = (item as { text?: unknown }).text;
    if (typeof maybeText === "string") texts.push(maybeText);
  }
  return texts.join("");
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
