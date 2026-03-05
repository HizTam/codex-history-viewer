import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { tryReadSessionMeta } from "../sessions/sessionSummary";
import type { SessionSource } from "../sessions/sessionTypes";
import { formatYmdHmInTimeZone, formatYmdHmsInTimeZone } from "../utils/dateUtils";
import { extractCompactUserText, extractTaskSectionText, extractUserRequestText, normalizeWhitespace } from "../utils/textUtils";

type ResumeRole = "user" | "assistant";

interface ResumeMessage {
  role: ResumeRole;
  timestampIso?: string;
  text: string;
}

export interface ResumeRenderOptions {
  timeZone: string;
  maxMessages?: number;
  maxChars?: number;
  includeContext?: boolean;
}

// Build a resume excerpt text from a history session.
export async function renderResumeContext(fsPath: string, options: ResumeRenderOptions): Promise<string> {
  const timeZone = typeof options.timeZone === "string" ? options.timeZone : "";
  const maxMessages = clampInt(options.maxMessages, 4, 200, 20);
  const maxChars = clampInt(options.maxChars, 2000, 200_000, 25_000);
  const includeContext = !!options.includeContext;

  const meta = await tryReadSessionMeta(fsPath);
  const historySource = detectHistorySource(meta?.historySource, fsPath);
  const stream = fs.createReadStream(fsPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let taskText: string | null = null;
  const recent: ResumeMessage[] = [];
  const setTaskIfEmpty = (nextTask: string): void => {
    if (!taskText) taskText = nextTask;
  };

  try {
    for await (const line of rl) {
      if (!line) continue;

      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      if (collectCodexResumeMessage(obj, includeContext, recent, maxMessages, setTaskIfEmpty)) {
        continue;
      }
      collectClaudeResumeMessage(obj, includeContext, recent, maxMessages, setTaskIfEmpty);
    }
  } finally {
    rl.close();
    stream.close();
  }

  const taskCandidate = (taskText ?? "").trim();
  const safeTask = taskCandidate.length > 0 ? taskCandidate : "(task not found)";
  let recentTrimmed = recent.slice();
  let out = buildMarkdown({ fsPath, meta, historySource, timeZone, task: safeTask, recent: recentTrimmed });

  while (out.length > maxChars && recentTrimmed.length > 4) {
    recentTrimmed.shift();
    out = buildMarkdown({ fsPath, meta, historySource, timeZone, task: safeTask, recent: recentTrimmed });
  }
  if (out.length > maxChars) {
    const keep = Math.max(0, maxChars - 3);
    out = `${out.slice(0, keep)}...`;
  }

  return out;
}

function buildMarkdown(params: {
  fsPath: string;
  meta: Awaited<ReturnType<typeof tryReadSessionMeta>>;
  historySource: SessionSource;
  timeZone: string;
  task: string;
  recent: ResumeMessage[];
}): string {
  const { fsPath, meta, historySource, timeZone, task, recent } = params;
  const lines: string[] = [];

  lines.push("# Resume context (Codex History Viewer)");
  lines.push("");
  lines.push(`- Source: \`${fsPath}\``);
  lines.push(`- History Source: \`${historySource}\``);
  if (meta?.timestampIso) lines.push(`- Start: \`${formatIsoToLocal(meta.timestampIso, timeZone, { withSeconds: false })}\``);
  if (meta?.cwd) lines.push(`- CWD: \`${meta.cwd}\``);
  if (meta?.cliVersion) lines.push(`- CLI: \`${meta.cliVersion}\``);
  if (meta?.modelProvider) lines.push(`- Model Provider: \`${meta.modelProvider}\``);
  if (meta?.source) lines.push(`- Source type: \`${meta.source}\``);
  lines.push("");
  lines.push("> IMPORTANT: This excerpt is copied from a past session. Read it and continue the work.");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Task");
  lines.push("");
  lines.push(task);
  lines.push("");
  lines.push("## Recent messages");
  lines.push("");

  if (recent.length === 0) {
    lines.push("(no recent messages)");
    lines.push("");
    return lines.join("\n");
  }

  for (const m of recent) {
    lines.push(`### ${m.role === "user" ? "User" : "Assistant"}`);
    if (m.timestampIso) lines.push(`- Timestamp: \`${formatIsoToLocal(m.timestampIso, timeZone, { withSeconds: true })}\``);
    lines.push("");
    lines.push(m.text);
    lines.push("");
  }

  return lines.join("\n");
}

function collectCodexResumeMessage(
  obj: any,
  includeContext: boolean,
  recent: ResumeMessage[],
  maxMessages: number,
  setTask: (task: string) => void,
): boolean {
  if (obj?.type !== "response_item") return false;
  if (obj?.payload?.type !== "message") return true;

  const role = obj?.payload?.role;
  if (role !== "user" && role !== "assistant" && role !== "developer") return true;

  const textRaw = extractTextFromCodexContent(obj?.payload?.content);
  const textNormalized = normalizeWhitespace(textRaw);
  if (!textNormalized) return true;

  if (role === "user") {
    const compactUserText = extractCompactUserText(textNormalized);
    const requestText =
      compactUserText ?? extractTaskSectionText(textNormalized) ?? extractUserRequestText(textNormalized) ?? textNormalized;
    const isContext = !compactUserText;
    if (isContext && !includeContext) return true;
    setTask(requestText);
    pushRecent(
      recent,
      {
        role: "user",
        timestampIso: typeof obj?.timestamp === "string" ? obj.timestamp : undefined,
        text: requestText,
      },
      maxMessages,
    );
    return true;
  }

  if (role === "assistant") {
    pushRecent(
      recent,
      {
        role: "assistant",
        timestampIso: typeof obj?.timestamp === "string" ? obj.timestamp : undefined,
        text: textNormalized,
      },
      maxMessages,
    );
    return true;
  }

  const isContext = isBoilerplateMessage(textNormalized);
  if (isContext && !includeContext) return true;
  const maybeTask = extractTaskSectionText(textNormalized) ?? extractUserRequestText(textNormalized);
  if (maybeTask) setTask(maybeTask);
  return true;
}

function collectClaudeResumeMessage(
  obj: any,
  includeContext: boolean,
  recent: ResumeMessage[],
  maxMessages: number,
  setTask: (task: string) => void,
): boolean {
  const role = detectClaudeMessageRole(obj);
  if (!role) return false;

  const textRaw = extractTextFromClaudeContent(getClaudeMessageContent(obj));
  const textNormalized = normalizeWhitespace(textRaw);
  if (!textNormalized) return true;

  if (role === "user") {
    const compactUserText = extractCompactUserText(textNormalized);
    const requestText =
      compactUserText ?? extractTaskSectionText(textNormalized) ?? extractUserRequestText(textNormalized) ?? textNormalized;
    const isContext = !compactUserText;
    if (isContext && !includeContext) return true;
    setTask(requestText);
    pushRecent(
      recent,
      {
        role: "user",
        timestampIso: typeof obj?.timestamp === "string" ? obj.timestamp : undefined,
        text: requestText,
      },
      maxMessages,
    );
    return true;
  }

  pushRecent(
    recent,
    {
      role: "assistant",
      timestampIso: typeof obj?.timestamp === "string" ? obj.timestamp : undefined,
      text: textNormalized,
    },
    maxMessages,
  );
  return true;
}

function pushRecent(arr: ResumeMessage[], item: ResumeMessage, max: number): void {
  arr.push(item);
  while (arr.length > max) arr.shift();
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

function extractTextFromClaudeContent(content: unknown): string {
  if (typeof content === "string") return content;
  const items = Array.isArray(content) ? content : content && typeof content === "object" ? [content] : [];
  if (items.length === 0) return "";

  const texts: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const type = typeof (item as { type?: unknown }).type === "string" ? (item as { type: string }).type : "";
    if (type !== "text" && type !== "input_text" && type !== "output_text") continue;
    const maybeText = (item as { text?: unknown }).text;
    if (typeof maybeText === "string") texts.push(maybeText);
  }
  return texts.join("");
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

function isBoilerplateMessage(text: string): boolean {
  const t = text.trim();
  if (t.startsWith("<environment_context>")) return true;
  if (t.startsWith("# AGENTS.md instructions")) return true;
  if (t.startsWith("<INSTRUCTIONS>")) return true;
  return false;
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? Math.floor(v) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function detectHistorySource(source: SessionSource | undefined, fsPath: string): SessionSource {
  if (source === "codex" || source === "claude") return source;
  return path.basename(fsPath).toLowerCase().startsWith("rollout-") ? "codex" : "claude";
}

function formatIsoToLocal(iso: string, timeZone: string, options: { withSeconds: boolean }): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  return options.withSeconds ? formatYmdHmsInTimeZone(d, timeZone) : formatYmdHmInTimeZone(d, timeZone);
}
