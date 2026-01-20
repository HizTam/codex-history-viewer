import * as fs from "node:fs";
import * as readline from "node:readline";
import { normalizeWhitespace } from "../utils/textUtils";
import { tryReadSessionMeta } from "../sessions/sessionSummary";

// Reads JSONL (rollout-*.jsonl) and renders the conversation as Markdown.
export async function renderTranscript(fsPath: string): Promise<{ content: string; messageLineMap: Map<number, number> }> {
  const stream = fs.createReadStream(fsPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const lines: string[] = [];
  const messageLineMap = new Map<number, number>();

  // Header. The file path may contain sensitive info; this is intended for local use.
  lines.push(`# Codex Session`);
  lines.push(``);
  lines.push(`- File: \`${fsPath}\``);
  const meta = await tryReadSessionMeta(fsPath);
  if (meta?.timestampIso) lines.push(`- Start (UTC): \`${meta.timestampIso}\``);
  if (meta?.cwd) lines.push(`- CWD: \`${meta.cwd}\``);
  if (meta?.originator) lines.push(`- Originator: \`${meta.originator}\``);
  if (meta?.cliVersion) lines.push(`- CLI: \`${meta.cliVersion}\``);
  if (meta?.modelProvider) lines.push(`- Model Provider: \`${meta.modelProvider}\``);
  if (meta?.source) lines.push(`- Source: \`${meta.source}\``);
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
      if (obj?.type !== "response_item") continue;

      // Message items (developer/user/assistant).
      if (obj?.payload?.type === "message") {
        const role = obj?.payload?.role;
        if (role !== "user" && role !== "assistant" && role !== "developer") continue;

        const textRaw = extractTextFromContent(obj?.payload?.content);
        const text = normalizeWhitespace(textRaw);
        if (!text) continue;

        const ts = typeof obj?.timestamp === "string" ? obj.timestamp : undefined;
        const ctx = role !== "assistant" && isBoilerplateUserMessage(text) ? " (context)" : "";

        if (role === "user" || role === "assistant") {
          msgIndex += 1;
          // Store 1-based line numbers for external navigation.
          messageLineMap.set(msgIndex, lines.length + 1);
          lines.push(`## [#${msgIndex}] ${capitalize(role)}${ctx}`);
        } else {
          lines.push(`## ${capitalize(role)}${ctx}`);
        }
        if (ts) lines.push(`- Timestamp: \`${ts}\``);
        lines.push(``);
        lines.push(text);
        lines.push(``);
        lastToolCallId = undefined;
        continue;
      }

      // Tool calls (function_call / output).
      if (obj?.payload?.type === "function_call") {
        const name = typeof obj?.payload?.name === "string" ? obj.payload.name : "function_call";
        const callId = typeof obj?.payload?.call_id === "string" ? obj.payload.call_id : undefined;
        const argsRaw = typeof obj?.payload?.arguments === "string" ? obj.payload.arguments : "";
        const args = formatJsonIfPossible(argsRaw);
        const ts = typeof obj?.timestamp === "string" ? obj.timestamp : undefined;

        lines.push(`## [tool] ${name}`);
        if (callId) lines.push(`- Call ID: \`${callId}\``);
        if (ts) lines.push(`- Timestamp: \`${ts}\``);
        lines.push(``);
        if (args) {
          lines.push(`### Arguments`);
          lines.push("```json");
          lines.push(args);
          lines.push("```");
          lines.push(``);
        }
        lastToolCallId = callId;
        continue;
      }

      if (obj?.payload?.type === "function_call_output") {
        const callId = typeof obj?.payload?.call_id === "string" ? obj.payload.call_id : undefined;
        const outRaw = typeof obj?.payload?.output === "string" ? obj.payload.output : "";
        const out = formatJsonIfPossible(outRaw) ?? outRaw;
        const ts = typeof obj?.timestamp === "string" ? obj.timestamp : undefined;

        // If the output belongs to the immediately preceding tool call, keep it in the same block.
        if (callId && lastToolCallId && callId === lastToolCallId) {
          lines.push(`### Output`);
        } else {
          lines.push(`## [tool output]`);
          if (callId) lines.push(`- Call ID: \`${callId}\``);
          if (ts) lines.push(`- Timestamp: \`${ts}\``);
          lines.push(``);
          lines.push(`### Output`);
        }
        lines.push("```");
        lines.push(out);
        lines.push("```");
        lines.push(``);
        continue;
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

function capitalize(s: string): string {
  return s.length > 0 ? `${s[0]!.toUpperCase()}${s.slice(1)}` : s;
}

function isBoilerplateUserMessage(text: string): boolean {
  // Detect large initial context blocks and mark them in the header.
  const t = text.trim();
  if (t.startsWith("<environment_context>")) return true;
  if (t.startsWith("# AGENTS.md instructions")) return true;
  if (t.startsWith("<INSTRUCTIONS>")) return true;
  return false;
}

function formatJsonIfPossible(text: string): string | null {
  // If the text is valid JSON, return a pretty-printed version.
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
