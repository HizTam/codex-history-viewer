import * as fs from "node:fs";
import * as readline from "node:readline";
import type { ChatRole, ChatSessionMeta, ChatSessionModel, ChatTimelineItem, ChatToolItem } from "./chatTypes";
import { extractTaskSectionText, extractUserRequestText } from "../utils/textUtils";

// Parses JSONL (rollout-*.jsonl) and builds a model for the chat-like webview.
export async function buildChatSessionModel(fsPath: string): Promise<ChatSessionModel> {
  const meta = await readSessionMeta(fsPath);
  const items = await readTimelineItems(fsPath);
  return { fsPath, meta, items };
}

async function readSessionMeta(fsPath: string): Promise<ChatSessionMeta> {
  const stream = fs.createReadStream(fsPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj?.type !== "session_meta") continue;
      const p = obj?.payload ?? {};
      return {
        id: typeof p.id === "string" ? p.id : undefined,
        timestampIso: typeof p.timestamp === "string" ? p.timestamp : undefined,
        cwd: typeof p.cwd === "string" ? p.cwd : undefined,
        originator: typeof p.originator === "string" ? p.originator : undefined,
        cliVersion: typeof p.cli_version === "string" ? p.cli_version : undefined,
        modelProvider: typeof p.model_provider === "string" ? p.model_provider : undefined,
        source: typeof p.source === "string" ? p.source : undefined,
      };
    }
  } finally {
    rl.close();
    stream.close();
  }
  return {};
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

      if (obj?.type === "response_item" && obj?.payload?.type === "message") {
        const role = obj?.payload?.role as ChatRole | undefined;
        if (role !== "developer" && role !== "user" && role !== "assistant") continue;

        const textRaw = extractTextFromContent(obj?.payload?.content);
        const text = normalizeText(textRaw);
        if (!text) continue;

        const isContext = role !== "assistant" && isBoilerplate(text);
        const requestText =
          role === "user" ? extractTaskSectionText(text) ?? extractUserRequestText(text) ?? text : undefined;

        const ts = typeof obj?.timestamp === "string" ? obj.timestamp : undefined;
        const idx = role === "user" || role === "assistant" ? (messageIndex += 1) : undefined;

        items.push({
          type: "message",
          role,
          messageIndex: idx,
          timestampIso: ts,
          text,
          requestText,
          isContext,
        });
        continue;
      }

      if (obj?.type === "response_item" && obj?.payload?.type === "function_call") {
        const name = typeof obj?.payload?.name === "string" ? obj.payload.name : "function_call";
        const callId = typeof obj?.payload?.call_id === "string" ? obj.payload.call_id : undefined;
        const argumentsText = typeof obj?.payload?.arguments === "string" ? obj.payload.arguments : undefined;
        const ts = typeof obj?.timestamp === "string" ? obj.timestamp : undefined;

        const tool: ChatToolItem = { type: "tool", timestampIso: ts, name, callId, argumentsText };
        items.push(tool);
        if (callId) toolByCallId.set(callId, tool);
        continue;
      }

      if (obj?.type === "response_item" && obj?.payload?.type === "function_call_output") {
        const callId = typeof obj?.payload?.call_id === "string" ? obj.payload.call_id : undefined;
        const outputText = typeof obj?.payload?.output === "string" ? obj.payload.output : undefined;
        const ts = typeof obj?.timestamp === "string" ? obj.timestamp : undefined;

        if (callId && toolByCallId.has(callId)) {
          const tool = toolByCallId.get(callId)!;
          tool.outputText = outputText;
          // Output timestamps can be newer; fill in if missing.
          if (!tool.timestampIso) tool.timestampIso = ts;
        } else {
          // Display output even if the matching function_call is missing.
          items.push({
            type: "tool",
            timestampIso: ts,
            name: "function_call_output",
            callId,
            outputText,
          });
        }
        continue;
      }
    }
  } finally {
    rl.close();
    stream.close();
  }

  return items;
}

function extractTextFromContent(content: unknown): string {
  // Concatenate payload.content[].text (ignore unknown shapes).
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const maybeText = (item as any).text;
    if (typeof maybeText === "string") texts.push(maybeText);
  }
  return texts.join("");
}

function normalizeText(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function isBoilerplate(text: string): boolean {
  // Identify common non-conversation blocks (environment info, rules, etc.).
  const t = text.trim();
  if (t.startsWith("<environment_context>")) return true;
  if (t.startsWith("# AGENTS.md instructions")) return true;
  if (t.startsWith("<INSTRUCTIONS>")) return true;
  return false;
}
