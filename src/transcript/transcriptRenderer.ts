import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { normalizeWhitespace } from "../utils/textUtils";
import { tryReadSessionMeta } from "../sessions/sessionSummary";
import type { SessionSource } from "../sessions/sessionTypes";
import { formatYmdHmInTimeZone, formatYmdHmsInTimeZone } from "../utils/dateUtils";

// Reads session JSONL and renders the conversation as Markdown.
export async function renderTranscript(
  fsPath: string,
  options: { timeZone: string; annotation?: { tags?: readonly string[]; note?: string } },
): Promise<{ content: string; messageLineMap: Map<number, number> }> {
  const timeZone = options.timeZone;

  const lines: string[] = [];
  const messageLineMap = new Map<number, number>();

  const meta = await tryReadSessionMeta(fsPath);
  const historySource = detectHistorySource(meta?.historySource, fsPath);
  // Read metadata first, then open the body stream.
  // In reverse order, readline can consume data first and leave the body empty.
  const stream = fs.createReadStream(fsPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  lines.push(`# ${historySource === "claude" ? "Claude" : "Codex"} Session`);
  lines.push(``);
  lines.push(`- File: \`${fsPath}\``);
  lines.push(`- History Source: \`${historySource}\``);
  if (meta?.timestampIso) lines.push(`- Start: \`${formatIsoToLocal(meta.timestampIso, timeZone, { withSeconds: false })}\``);
  if (meta?.cwd) lines.push(`- CWD: \`${meta.cwd}\``);
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

  try {
    for await (const line of rl) {
      if (!line) continue;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      const codexResult = renderCodexRecord(lines, messageLineMap, {
        obj,
        timeZone,
        msgIndex,
        lastToolCallId,
      });
      if (codexResult.handled) {
        msgIndex = codexResult.msgIndex;
        lastToolCallId = codexResult.lastToolCallId;
        continue;
      }

      const claudeResult = renderClaudeRecord(lines, messageLineMap, {
        obj,
        timeZone,
        msgIndex,
        lastToolCallId,
      });
      if (claudeResult.handled) {
        msgIndex = claudeResult.msgIndex;
        lastToolCallId = claudeResult.lastToolCallId;
      }
    }
  } finally {
    rl.close();
    stream.close();
  }

  if (msgIndex === 0) {
    lines.push(`(no user/assistant messages)`);
    lines.push(``);
  }

  return { content: lines.join("\n"), messageLineMap };
}

function renderCodexRecord(
  lines: string[],
  messageLineMap: Map<number, number>,
  params: { obj: any; timeZone: string; msgIndex: number; lastToolCallId?: string },
): { handled: boolean; msgIndex: number; lastToolCallId?: string } {
  const { obj, timeZone } = params;
  let { msgIndex, lastToolCallId } = params;

  if (obj?.type !== "response_item") return { handled: false, msgIndex, lastToolCallId };

  if (obj?.payload?.type === "message") {
    const role = obj?.payload?.role;
    if (role !== "user" && role !== "assistant" && role !== "developer") {
      return { handled: true, msgIndex, lastToolCallId };
    }

    const textRaw = extractTextFromCodexContent(obj?.payload?.content);
    const text = normalizeWhitespace(textRaw);
    if (!text) return { handled: true, msgIndex, lastToolCallId };

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
    lines.push(text);
    lines.push(``);
    lastToolCallId = undefined;
    return { handled: true, msgIndex, lastToolCallId };
  }

  if (obj?.payload?.type === "function_call") {
    const name = typeof obj?.payload?.name === "string" ? obj.payload.name : "function_call";
    const callId = typeof obj?.payload?.call_id === "string" ? obj.payload.call_id : undefined;
    const argsRaw = typeof obj?.payload?.arguments === "string" ? obj.payload.arguments : "";
    const args = formatJsonIfPossible(argsRaw);
    const ts = typeof obj?.timestamp === "string" ? obj.timestamp : undefined;

    lines.push(`## [tool] ${name}`);
    if (callId) lines.push(`- Call ID: \`${callId}\``);
    if (ts) lines.push(`- Timestamp: \`${formatIsoToLocal(ts, timeZone, { withSeconds: true })}\``);
    lines.push(``);
    if (args) {
      lines.push(`### Arguments`);
      lines.push("```json");
      lines.push(args);
      lines.push("```");
      lines.push(``);
    }
    lastToolCallId = callId;
    return { handled: true, msgIndex, lastToolCallId };
  }

  if (obj?.payload?.type === "function_call_output") {
    const callId = typeof obj?.payload?.call_id === "string" ? obj.payload.call_id : undefined;
    const outRaw = typeof obj?.payload?.output === "string" ? obj.payload.output : "";
    const out = formatJsonIfPossible(outRaw) ?? outRaw;
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
    lines.push("```");
    lines.push(out);
    lines.push("```");
    lines.push(``);
    return { handled: true, msgIndex, lastToolCallId };
  }

  return { handled: true, msgIndex, lastToolCallId };
}

function renderClaudeRecord(
  lines: string[],
  messageLineMap: Map<number, number>,
  params: { obj: any; timeZone: string; msgIndex: number; lastToolCallId?: string },
): { handled: boolean; msgIndex: number; lastToolCallId?: string } {
  const { obj, timeZone } = params;
  let { msgIndex, lastToolCallId } = params;

  const role = detectClaudeMessageRole(obj);
  if (!role) return { handled: false, msgIndex, lastToolCallId };

  const parsed = parseClaudeMessageContent(getClaudeMessageContent(obj));
  const text = normalizeWhitespace(parsed.messageText);
  const ts = typeof obj?.timestamp === "string" ? obj.timestamp : undefined;

  if (text) {
    const ctx = role !== "assistant" && isBoilerplateUserMessage(text) ? " (context)" : "";
    msgIndex += 1;
    messageLineMap.set(msgIndex, lines.length + 1);
    lines.push(`## [#${msgIndex}] ${capitalize(role)}${ctx}`);
    if (ts) lines.push(`- Timestamp: \`${formatIsoToLocal(ts, timeZone, { withSeconds: true })}\``);
    lines.push(``);
    lines.push(text);
    lines.push(``);
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
