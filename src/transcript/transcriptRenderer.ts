import * as path from "node:path";
import { normalizeWhitespace } from "../utils/textUtils";
import { tryReadSessionMeta } from "../sessions/sessionSummary";
import type { SessionSource, SessionSummary } from "../sessions/sessionTypes";
import { readSessionJsonlRecords } from "../sessions/codexHistoryBase";
import { formatYmdHmInTimeZone, formatYmdHmsInTimeZone } from "../utils/dateUtils";
import {
  buildAttachmentSummaryLines,
  detectClaudeMaterializedMessageRole,
  extractClaudeMessageContent,
  extractCodexMessageContent,
} from "../chat/chatAttachments";
import { createClaudePastedPromptResolver, type ClaudePastedPromptResolver } from "../chat/claudePastedPrompt";
import {
  extractClaudeCrossSessionMessage,
  isClaudeCrossSessionInboundRecord,
} from "../chat/claudeCrossSessionMessage";
import {
  extractCodexToolOutput,
  projectCodexStandaloneResponseItem,
} from "../chat/codexResponseItems";
import {
  normalizeCodexCorrelationId,
  readCodexAsyncQuestionMessage,
  readCodexControlToolKind,
  readCodexRolloutRecordKind,
} from "../sessions/codexRolloutCompatibility";

interface CodexTranscriptState {
  readonly seenAsyncQuestionIds: Set<string>;
  readonly suppressedControlCallIds: Set<string>;
}

// Reads session JSONL and renders the session transcript as Markdown.
export async function renderTranscript(
  fsPath: string,
  options: {
    timeZone: string;
    annotation?: { tags?: readonly string[]; note?: string };
    locationLabel?: string;
    displayCwd?: string | null;
    sessionInventory?: readonly SessionSummary[];
  },
): Promise<{ content: string; messageLineMap: Map<number, number> }> {
  const timeZone = options.timeZone;

  const lines: string[] = [];
  const messageLineMap = new Map<number, number>();

  const meta = await tryReadSessionMeta(fsPath);
  const historySource = detectHistorySource(meta?.historySource, fsPath);
  const pastedPromptResolver = historySource === "claude" ? await createClaudePastedPromptResolver(fsPath) : undefined;

  lines.push(`# ${historySource === "claude" ? "Claude Code" : "Codex"} Session`);
  lines.push(``);
  lines.push(`- File: \`${fsPath}\``);
  lines.push(`- History Source: \`${historySource}\``);
  if (options.locationLabel) lines.push(`- Location: \`${options.locationLabel}\``);
  if (meta?.timestampIso) lines.push(`- Start: \`${formatIsoToLocal(meta.timestampIso, timeZone, { withSeconds: false })}\``);
  if (meta?.cwd) lines.push(`- CWD: \`${meta.cwd}\``);
  const displayCwd = typeof options.displayCwd === "string" ? options.displayCwd.trim() : "";
  if (displayCwd && meta?.cwd && displayCwd !== meta.cwd) lines.push(`- Display CWD: \`${displayCwd}\``);
  if (meta?.originator) lines.push(`- Originator: \`${meta.originator}\``);
  if (meta?.cliVersion) lines.push(`- CLI: \`${meta.cliVersion}\``);
  if (meta?.modelProvider) lines.push(`- Model Provider: \`${meta.modelProvider}\``);
  if (meta?.source) lines.push(`- Source: \`${meta.source}\``);
  const tags = Array.isArray(options.annotation?.tags)
    ? options.annotation!.tags.map((tag) => String(tag ?? "").trim()).filter((tag) => tag.length > 0)
    : [];
  const note = typeof options.annotation?.note === "string" ? options.annotation.note.trim() : "";
  if (tags.length > 0) lines.push(`- Tags: ${tags.map((tag) => `\`#${tag}\``).join(", ")}`);
  if (note) lines.push(`- Note: ${note}`);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);

  let msgIndex = 0;
  let lastToolCallId: string | undefined;
  const codexState: CodexTranscriptState = {
    seenAsyncQuestionIds: new Set(),
    suppressedControlCallIds: new Set(),
  };

  for await (const record of readSessionJsonlRecords(fsPath, historySource, {
    sessionInventory: options.sessionInventory,
  })) {
    const obj = record.value;

    const codexResult = await renderCodexRecord(lines, messageLineMap, {
      obj,
      timeZone,
      msgIndex,
      lastToolCallId,
      state: codexState,
    });
    if (codexResult.handled) {
      msgIndex = codexResult.msgIndex;
      lastToolCallId = codexResult.lastToolCallId;
      continue;
    }

    const claudeResult = await renderClaudeRecord(lines, messageLineMap, {
      obj,
      timeZone,
      msgIndex,
      lastToolCallId,
      pastedPromptResolver,
    });
    if (claudeResult.handled) {
      msgIndex = claudeResult.msgIndex;
      lastToolCallId = claudeResult.lastToolCallId;
    }
  }

  if (msgIndex === 0) {
    lines.push(`(no user/assistant messages)`);
    lines.push(``);
  }

  return { content: lines.join("\n"), messageLineMap };
}

async function renderCodexRecord(
  lines: string[],
  messageLineMap: Map<number, number>,
  params: {
    obj: any;
    timeZone: string;
    msgIndex: number;
    lastToolCallId?: string;
    state: CodexTranscriptState;
  },
): Promise<{ handled: boolean; msgIndex: number; lastToolCallId?: string }> {
  const { obj, timeZone, state } = params;
  let { msgIndex, lastToolCallId } = params;

  const asyncQuestion = readCodexAsyncQuestionMessage(obj);
  if (asyncQuestion) {
    if (state.seenAsyncQuestionIds.has(asyncQuestion.itemId)) {
      return { handled: true, msgIndex, lastToolCallId };
    }
    state.seenAsyncQuestionIds.add(asyncQuestion.itemId);
    const text = normalizeWhitespace(asyncQuestion.text);
    if (!text) return { handled: true, msgIndex, lastToolCallId };
    msgIndex += 1;
    messageLineMap.set(msgIndex, lines.length + 1);
    lines.push(`## [#${msgIndex}] Assistant`);
    const ts = typeof obj?.timestamp === "string" ? obj.timestamp : undefined;
    if (ts) lines.push(`- Timestamp: \`${formatIsoToLocal(ts, timeZone, { withSeconds: true })}\``);
    lines.push("");
    appendMessageBodyLines(lines, [], text);
    return { handled: true, msgIndex, lastToolCallId: undefined };
  }

  const recordKind = readCodexRolloutRecordKind(obj);
  if (recordKind && recordKind !== "response_item") {
    return { handled: true, msgIndex, lastToolCallId };
  }
  if (obj?.type !== "response_item") return { handled: false, msgIndex, lastToolCallId };

  if (obj?.payload?.type === "message") {
    const role = obj?.payload?.role;
    if (role !== "user" && role !== "assistant" && role !== "developer") {
      return { handled: true, msgIndex, lastToolCallId };
    }

    const extracted = await extractCodexMessageContent(obj?.payload?.content, undefined, { enabled: false });
    const text = normalizeWhitespace(extracted.text);
    const attachmentLines = buildAttachmentSummaryLines(extracted.attachments);
    if (!text && attachmentLines.length === 0) return { handled: true, msgIndex, lastToolCallId };

    const ts = typeof obj?.timestamp === "string" ? obj.timestamp : undefined;
    const ctx = role !== "assistant" && isBoilerplateUserMessage(text) ? " (context)" : "";

    if (role === "user" || role === "assistant") {
      msgIndex += 1;
      messageLineMap.set(msgIndex, lines.length + 1);
      lines.push(`## [#${msgIndex}] ${capitalize(role)}${ctx}`);
    } else {
      lines.push(`## ${capitalize(role)}${ctx}`);
    }
    if (ts) lines.push(`- Timestamp: \`${formatIsoToLocal(ts, timeZone, { withSeconds: true })}\``);
    lines.push(``);
    appendMessageBodyLines(lines, attachmentLines, text);
    lastToolCallId = undefined;
    return { handled: true, msgIndex, lastToolCallId };
  }

  if (obj?.payload?.type === "function_call" || obj?.payload?.type === "custom_tool_call") {
    if (readCodexControlToolKind(obj)) {
      const callId = normalizeCodexCorrelationId(obj?.payload?.call_id);
      if (callId) state.suppressedControlCallIds.add(callId);
      return { handled: true, msgIndex, lastToolCallId: undefined };
    }
    const payloadType = obj.payload.type;
    const name =
      typeof obj?.payload?.name === "string"
        ? obj.payload.name
        : payloadType === "custom_tool_call"
          ? "custom_tool_call"
          : "function_call";
    const callId = typeof obj?.payload?.call_id === "string" ? obj.payload.call_id : undefined;
    const argsRaw =
      payloadType === "custom_tool_call"
        ? typeof obj?.payload?.input === "string"
          ? obj.payload.input
          : ""
        : typeof obj?.payload?.arguments === "string"
          ? obj.payload.arguments
          : "";
    const args = formatJsonIfPossible(argsRaw) ?? argsRaw;
    const ts = typeof obj?.timestamp === "string" ? obj.timestamp : undefined;

    lines.push(`## [tool] ${name}`);
    if (callId) lines.push(`- Call ID: \`${callId}\``);
    if (ts) lines.push(`- Timestamp: \`${formatIsoToLocal(ts, timeZone, { withSeconds: true })}\``);
    lines.push(``);
    if (args) {
      lines.push(`### Arguments`);
      lines.push(looksLikeJson(args) ? "```json" : "```");
      lines.push(args);
      lines.push("```");
      lines.push(``);
    }
    lastToolCallId = callId;
    return { handled: true, msgIndex, lastToolCallId };
  }

  if (obj?.payload?.type === "function_call_output" || obj?.payload?.type === "custom_tool_call_output") {
    const normalizedCallId = normalizeCodexCorrelationId(obj?.payload?.call_id);
    if (normalizedCallId && state.suppressedControlCallIds.has(normalizedCallId)) {
      return { handled: true, msgIndex, lastToolCallId };
    }
    const callId = typeof obj?.payload?.call_id === "string" ? obj.payload.call_id : undefined;
    const extracted = await extractCodexToolOutput(obj?.payload?.output, undefined, { enabled: false });
    const outRaw = extracted.text;
    const out = formatJsonIfPossible(outRaw) ?? outRaw;
    const attachmentLines = buildAttachmentSummaryLines(extracted.attachments);
    const ts = typeof obj?.timestamp === "string" ? obj.timestamp : undefined;

    if (callId && lastToolCallId && callId === lastToolCallId) {
      lines.push(`### Output`);
    } else {
      lines.push(`## [tool output]`);
      if (callId) lines.push(`- Call ID: \`${callId}\``);
      if (ts) lines.push(`- Timestamp: \`${formatIsoToLocal(ts, timeZone, { withSeconds: true })}\``);
      lines.push(``);
      lines.push(`### Output`);
    }
    for (const attachmentLine of attachmentLines) lines.push(attachmentLine);
    if (attachmentLines.length > 0 && out) lines.push("");
    if (out) {
      lines.push(looksLikeJson(out) ? "```json" : "```");
      lines.push(out);
      lines.push("```");
    }
    lines.push(``);
    return { handled: true, msgIndex, lastToolCallId };
  }

  const standalone = await projectCodexStandaloneResponseItem(obj?.payload, { enabled: false });
  if (standalone) {
    const ts = typeof obj?.timestamp === "string" ? obj.timestamp : undefined;
    lines.push(`## [tool] ${standalone.name}`);
    if (standalone.callId) lines.push(`- Call ID: \`${standalone.callId}\``);
    if (ts) lines.push(`- Timestamp: \`${formatIsoToLocal(ts, timeZone, { withSeconds: true })}\``);
    if (standalone.execution?.status) lines.push(`- Status: \`${standalone.execution.status}\``);
    lines.push(``);

    const args = standalone.argumentsText
      ? formatJsonIfPossible(standalone.argumentsText) ?? standalone.argumentsText
      : "";
    if (args) {
      lines.push(`### Arguments`);
      lines.push(looksLikeJson(args) ? "```json" : "```");
      lines.push(args);
      lines.push("```");
      lines.push(``);
    }

    const attachmentLines = buildAttachmentSummaryLines(standalone.attachments);
    if (attachmentLines.length > 0) {
      lines.push(`### Output`);
      for (const attachmentLine of attachmentLines) lines.push(attachmentLine);
      lines.push(``);
    }
    lastToolCallId = standalone.callId;
    return { handled: true, msgIndex, lastToolCallId };
  }

  return { handled: true, msgIndex, lastToolCallId };
}

async function renderClaudeRecord(
  lines: string[],
  messageLineMap: Map<number, number>,
  params: {
    obj: any;
    timeZone: string;
    msgIndex: number;
    lastToolCallId?: string;
    pastedPromptResolver?: ClaudePastedPromptResolver;
  },
): Promise<{ handled: boolean; msgIndex: number; lastToolCallId?: string }> {
  const { obj, timeZone } = params;
  let { msgIndex, lastToolCallId } = params;

  const role = detectClaudeMessageRole(obj);
  if (!role) return { handled: false, msgIndex, lastToolCallId };

  if (isClaudeCrossSessionInboundRecord(obj)) {
    msgIndex += 1;
    const crossSessionMessage = extractClaudeCrossSessionMessage(obj);
    if (!crossSessionMessage) return { handled: true, msgIndex, lastToolCallId };

    messageLineMap.set(msgIndex, lines.length + 1);
    lines.push(`## [#${msgIndex}] Cross-session message`);
    const ts = typeof obj?.timestamp === "string" ? obj.timestamp : undefined;
    if (ts) lines.push(`- Timestamp: \`${formatIsoToLocal(ts, timeZone, { withSeconds: true })}\``);
    if (crossSessionMessage.senderName) {
      lines.push(`- From: ${escapeMarkdownInline(crossSessionMessage.senderName)}`);
    }
    lines.push("");
    appendPlainTextCodeBlock(lines, crossSessionMessage.body);
    lastToolCallId = undefined;
    return { handled: true, msgIndex, lastToolCallId };
  }

  const rawContent = getClaudeMessageContent(obj);
  const parsed = parseClaudeMessageContent(rawContent);
  const pastedPrompt = role === "user" ? await params.pastedPromptResolver?.resolve(obj, rawContent) : undefined;
  const extracted = await extractClaudeMessageContent(rawContent, undefined, { enabled: false }, { role, pastedPrompt });
  const text = normalizeWhitespace(extracted.text);
  const attachmentLines = buildAttachmentSummaryLines(extracted.attachments);
  const ts = typeof obj?.timestamp === "string" ? obj.timestamp : undefined;

  if (text || attachmentLines.length > 0) {
    const ctx = role !== "assistant" && isBoilerplateUserMessage(text) ? " (context)" : "";
    msgIndex += 1;
    messageLineMap.set(msgIndex, lines.length + 1);
    lines.push(`## [#${msgIndex}] ${capitalize(role)}${ctx}`);
    if (ts) lines.push(`- Timestamp: \`${formatIsoToLocal(ts, timeZone, { withSeconds: true })}\``);
    lines.push(``);
    appendMessageBodyLines(lines, attachmentLines, text);
    lastToolCallId = undefined;
  }

  for (const toolCall of parsed.toolCalls) {
    const name = normalizeWhitespace(toolCall.name ?? "") || "tool_use";
    const callId = toolCall.callId;
    const args = formatJsonIfPossible(toolCall.argumentsText ?? "") ?? (toolCall.argumentsText ?? "");

    lines.push(`## [tool] ${name}`);
    if (callId) lines.push(`- Call ID: \`${callId}\``);
    if (ts) lines.push(`- Timestamp: \`${formatIsoToLocal(ts, timeZone, { withSeconds: true })}\``);
    lines.push(``);
    if (args) {
      const blockKind = looksLikeJson(args) ? "json" : "";
      lines.push(`### Arguments`);
      lines.push(blockKind ? `\`\`\`${blockKind}` : "```");
      lines.push(args);
      lines.push("```");
      lines.push(``);
    }
    lastToolCallId = callId;
  }

  for (const toolResult of parsed.toolResults) {
    const callId = toolResult.callId;
    const outRaw = toolResult.outputText ?? "";
    const out = formatJsonIfPossible(outRaw) ?? outRaw;
    if (!normalizeWhitespace(out)) continue;

    if (callId && lastToolCallId && callId === lastToolCallId) {
      lines.push(`### Output`);
    } else {
      lines.push(`## [tool output]`);
      if (callId) lines.push(`- Call ID: \`${callId}\``);
      if (ts) lines.push(`- Timestamp: \`${formatIsoToLocal(ts, timeZone, { withSeconds: true })}\``);
      lines.push(``);
      lines.push(`### Output`);
    }
    const blockKind = looksLikeJson(out) ? "json" : "";
    lines.push(blockKind ? `\`\`\`${blockKind}` : "```");
    lines.push(out);
    lines.push("```");
    lines.push(``);
  }

  return { handled: true, msgIndex, lastToolCallId };
}

function appendMessageBodyLines(lines: string[], attachmentLines: readonly string[], text: string): void {
  for (const line of attachmentLines) lines.push(line);
  if (attachmentLines.length > 0 && text) lines.push("");
  if (text) lines.push(text);
  lines.push("");
}

function appendPlainTextCodeBlock(lines: string[], text: string): void {
  for (const line of text.split("\n")) lines.push(`    ${line}`);
  lines.push("");
}

function escapeMarkdownInline(value: string): string {
  const specialCharacters = "\\`*_{}[]<>()#+-.!|>";
  return Array.from(value, (character) => specialCharacters.includes(character) ? `\\${character}` : character).join("");
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
  return detectClaudeMaterializedMessageRole(obj);
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
          if (text) {
            texts.push(text);
            continue;
          }
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

function detectHistorySource(source: SessionSource | undefined, fsPath: string): SessionSource {
  if (source === "codex" || source === "claude") return source;
  return path.basename(fsPath).toLowerCase().startsWith("rollout-") ? "codex" : "claude";
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function capitalize(s: string): string {
  return s.length > 0 ? `${s[0]!.toUpperCase()}${s.slice(1)}` : s;
}

function isBoilerplateUserMessage(text: string): boolean {
  const t = text.trim();
  if (t.startsWith("<environment_context>")) return true;
  if (t.startsWith("# AGENTS.md instructions")) return true;
  if (t.startsWith("<INSTRUCTIONS>")) return true;
  return false;
}

function formatJsonIfPossible(text: string): string | null {
  const s = (text ?? "").trim();
  if (!s) return null;
  if (!(s.startsWith("{") || s.startsWith("["))) return null;
  try {
    const obj = JSON.parse(s);
    return JSON.stringify(obj, null, 2);
  } catch {
    return null;
  }
}

function looksLikeJson(text: string): boolean {
  const s = text.trim();
  return s.startsWith("{") || s.startsWith("[");
}

function formatIsoToLocal(iso: string, timeZone: string, options: { withSeconds: boolean }): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  return options.withSeconds ? formatYmdHmsInTimeZone(d, timeZone) : formatYmdHmInTimeZone(d, timeZone);
}
