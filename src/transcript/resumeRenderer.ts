import * as fs from "node:fs";
import * as readline from "node:readline";
import { tryReadSessionMeta } from "../sessions/sessionSummary";
import { formatYmdHmInTimeZone, formatYmdHmsInTimeZone } from "../utils/dateUtils";
import { extractTaskSectionText, extractUserRequestText, normalizeWhitespace } from "../utils/textUtils";

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
  const stream = fs.createReadStream(fsPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let taskText: string | null = null;
  const recent: ResumeMessage[] = [];

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
      if (obj?.payload?.type !== "message") continue;

      const role = obj?.payload?.role;
      if (role !== "user" && role !== "assistant" && role !== "developer") continue;

      const textRaw = extractTextFromContent(obj?.payload?.content);
      const textNormalized = normalizeWhitespace(textRaw);
      if (!textNormalized) continue;

      const isContext = role !== "assistant" && isBoilerplateMessage(textNormalized);
      if (isContext && !includeContext) continue;

      if (role === "user") {
        const requestText = extractTaskSectionText(textNormalized) ?? extractUserRequestText(textNormalized) ?? textNormalized;
        if (!taskText) taskText = requestText;
        pushRecent(
          recent,
          {
            role: "user",
            timestampIso: typeof obj?.timestamp === "string" ? obj.timestamp : undefined,
            text: requestText,
          },
          maxMessages,
        );
        continue;
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
        continue;
      }

      // Exclude developer messages from the recent list; use them only to infer a missing task.
      if (!taskText) {
        const maybeTask = extractTaskSectionText(textNormalized) ?? extractUserRequestText(textNormalized);
        if (maybeTask) taskText = maybeTask;
      }
    }
  } finally {
    rl.close();
    stream.close();
  }

  const safeTask = taskText?.trim() ? taskText.trim() : "(task not found)";
  let recentTrimmed = recent.slice();
  let out = buildMarkdown({ fsPath, meta, timeZone, task: safeTask, recent: recentTrimmed });

  // If over the size limit, drop older messages first.
  while (out.length > maxChars && recentTrimmed.length > 4) {
    recentTrimmed.shift();
    out = buildMarkdown({ fsPath, meta, timeZone, task: safeTask, recent: recentTrimmed });
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
  timeZone: string;
  task: string;
  recent: ResumeMessage[];
}): string {
  const { fsPath, meta, timeZone, task, recent } = params;
  const lines: string[] = [];

  lines.push("# Resume context (Codex History Viewer)");
  lines.push("");
  lines.push(`- Source: \`${fsPath}\``);
  if (meta?.timestampIso) lines.push(`- Start: \`${formatIsoToLocal(meta.timestampIso, timeZone, { withSeconds: false })}\``);
  if (meta?.cwd) lines.push(`- CWD: \`${meta.cwd}\``);
  if (meta?.cliVersion) lines.push(`- CLI: \`${meta.cliVersion}\``);
  if (meta?.modelProvider) lines.push(`- Model Provider: \`${meta.modelProvider}\``);
  if (meta?.source) lines.push(`- Source type: \`${meta.source}\``);
  lines.push("");
  lines.push("> IMPORTANT: This excerpt is copied from a past Codex session. Read it and continue the work.");
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

function pushRecent(arr: ResumeMessage[], item: ResumeMessage, max: number): void {
  arr.push(item);
  while (arr.length > max) arr.shift();
}

function extractTextFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const maybeText = (item as any).text;
    if (typeof maybeText === "string") texts.push(maybeText);
  }
  return texts.join("");
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

function formatIsoToLocal(iso: string, timeZone: string, options: { withSeconds: boolean }): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  return options.withSeconds ? formatYmdHmsInTimeZone(d, timeZone) : formatYmdHmInTimeZone(d, timeZone);
}
