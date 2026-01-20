import * as fs from "node:fs";
import * as readline from "node:readline";
import * as path from "node:path";
import { normalizeCacheKey, readFirstLineUtf8, statSafe } from "../utils/fsUtils";
import { formatTimeHmLocal, toYmdLocal, ymdToString } from "../utils/dateUtils";
import { extractUserRequestText, normalizeWhitespace, safeDisplayPath, singleLineSnippet } from "../utils/textUtils";
import type { PreviewMessage, SessionMetaInfo, SessionSummary } from "./sessionTypes";

// Parses the first session_meta line (returns null on corruption instead of throwing).
export async function tryReadSessionMeta(fsPath: string): Promise<SessionMetaInfo | null> {
  const firstLine = await readFirstLineUtf8(fsPath);
  if (!firstLine) return null;
  try {
    const obj = JSON.parse(firstLine) as { type?: string; payload?: Record<string, unknown> };
    if (obj.type !== "session_meta") return null;
    const payload = obj.payload ?? {};

    const meta: SessionMetaInfo = {
      id: typeof payload.id === "string" ? payload.id : undefined,
      timestampIso: typeof payload.timestamp === "string" ? payload.timestamp : undefined,
      cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
      originator: typeof payload.originator === "string" ? payload.originator : undefined,
      cliVersion: typeof payload.cli_version === "string" ? payload.cli_version : undefined,
      modelProvider: typeof payload.model_provider === "string" ? payload.model_provider : undefined,
      source: typeof payload.source === "string" ? payload.source : undefined,
    };
    return meta;
  } catch {
    return null;
  }
}

function inferYmdFromPath(sessionsRoot: string, fsPath: string): { year: number; month: number; day: number } | null {
  // Infer the date from the default directory structure (YYYY/MM/DD).
  const rel = path.relative(sessionsRoot, fsPath);
  const parts = rel.split(path.sep);
  if (parts.length < 4) return null;
  const [y, m, d] = parts;
  if (!/^\d{4}$/.test(y) || !/^\d{2}$/.test(m) || !/^\d{2}$/.test(d)) return null;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (!(year >= 1970 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null;
  return { year, month, day };
}

function buildPreviewTextParts(content: unknown): string {
  // Safely extract and concatenate text from payload.content[] items.
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const maybeText = (item as { text?: unknown }).text;
    if (typeof maybeText === "string") texts.push(maybeText);
  }
  return texts.join("");
}

function isBoilerplateUserMessage(text: string): boolean {
  // Light heuristic to avoid using environment/large rule blocks as the session summary.
  const t = text.trim();
  if (t.startsWith("<environment_context>")) return true;
  if (t.startsWith("# AGENTS.md instructions")) return true;
  if (t.startsWith("<INSTRUCTIONS>")) return true;
  return false;
}

export async function readPreviewMessages(fsPath: string, maxMessages: number): Promise<PreviewMessage[]> {
  // Stop early once enough messages are collected to stay safe on large files.
  const stream = fs.createReadStream(fsPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const result: PreviewMessage[] = [];
  try {
    for await (const line of rl) {
      if (result.length >= maxMessages) break;
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
      if (role !== "user" && role !== "assistant") continue;

      const textRaw = buildPreviewTextParts(obj?.payload?.content);
      const textNormalized = normalizeWhitespace(textRaw);
      const text =
        role === "user"
          ? extractUserRequestText(textNormalized) ?? textNormalized
          : textNormalized;
      if (!text) continue;
      if (role === "user" && isBoilerplateUserMessage(text)) continue;

      // Tooltips should stay readable; truncate extremely long text.
      const trimmed = text.length > 1200 ? `${text.slice(0, 1199)}…` : text;
      result.push({ role, text: trimmed });
    }
  } finally {
    rl.close();
    stream.close();
  }
  return result;
}

export async function buildSessionSummary(params: {
  sessionsRoot: string;
  fsPath: string;
  previewMaxMessages: number;
}): Promise<SessionSummary | null> {
  const { sessionsRoot, fsPath, previewMaxMessages } = params;
  const stat = await statSafe(fsPath);
  if (!stat) return null;

  const cacheKey = normalizeCacheKey(fsPath);
  const meta = (await tryReadSessionMeta(fsPath)) ?? {};

  const inferred = inferYmdFromPath(sessionsRoot, fsPath) ?? undefined;
  const start = meta.timestampIso ? new Date(meta.timestampIso) : null;
  const startLocal = start && !Number.isNaN(start.getTime()) ? start : null;

  const ymd =
    inferred ??
    (startLocal
      ? toYmdLocal(startLocal)
      : // If the start date is unknown, fall back to mtime for rough grouping.
        toYmdLocal(new Date(stat.mtimeMs)));
  const localDate = ymdToString(ymd);

  const timeLabel = startLocal ? formatTimeHmLocal(startLocal) : "--:--";

  const previewMessages = await readPreviewMessages(fsPath, previewMaxMessages);
  const snippetSource = pickSessionSnippetSource(previewMessages);
  const snippet = snippetSource ? singleLineSnippet(snippetSource, 70) : path.basename(fsPath);
  const cwdShort = meta.cwd ? safeDisplayPath(meta.cwd, 80) : "";

  return {
    fsPath,
    cacheKey,
    meta,
    inferredYmd: inferred,
    localDate,
    timeLabel,
    snippet,
    cwdShort,
    previewMessages,
  };
}

function pickSessionSnippetSource(messages: PreviewMessage[]): string | null {
  const firstUserIndex = messages.findIndex((m) => m.role === "user" && m.text.trim().length > 0);
  if (firstUserIndex < 0) return null;

  const firstUser = messages[firstUserIndex]!.text.trim();
  if (isUiTitleGenerationPrompt(firstUser)) {
    const nextAssistant = messages.slice(firstUserIndex + 1).find((m) => m.role === "assistant" && m.text.trim().length > 0);
    if (nextAssistant) return nextAssistant.text.trim();
  }

  return firstUser;
}

function isUiTitleGenerationPrompt(text: string): boolean {
  const s = text.trim();
  return /^Generate a concise UI title \(20-40 characters\) for this task\b/i.test(s);
}
