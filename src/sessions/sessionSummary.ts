import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { formatTimeHmInTimeZone, toYmdInTimeZone, ymdToString } from "../utils/dateUtils";
import { normalizeCacheKey, statSafe } from "../utils/fsUtils";
import {
  extractCompactUserText,
  normalizeWhitespace,
  safeDisplayPath,
  singleLineSnippet,
} from "../utils/textUtils";
import {
  buildAttachmentSummaryLines,
  detectClaudeMaterializedMessageRole,
  extractClaudeLocalCommandOutputContent,
  extractClaudeMessageContent,
  extractCodexCompactUserText,
} from "../chat/chatAttachments";
import type { ChatAttachment } from "../chat/chatTypes";
import type {
  PreviewMessage,
  SessionMetaInfo,
  SessionSource,
  SessionStorageLocation,
  SessionSummary,
} from "./sessionTypes";
import { resolvePreviewSessionTitleCandidate } from "./sessionTitleResolver";
import { extractCodexAgentMetadata } from "../agents/codexAgentMetadata";
import { extractCodexForkMetadata } from "../branchMap/codexForkMetadata";
import { boundSessionIdentityKey } from "./sessionIdentity";

const META_SCAN_LINE_LIMIT = 400;

// Read session meta from the top of JSONL. Supports both Codex and Claude logs.
export async function tryReadSessionMeta(fsPath: string): Promise<SessionMetaInfo | null> {
  const stream = fs.createReadStream(fsPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const claudeMeta: SessionMetaInfo = { historySource: "claude" };
  let scanned = 0;

  try {
    for await (const line of rl) {
      if (!line) continue;
      scanned += 1;

      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        if (scanned >= META_SCAN_LINE_LIMIT) break;
        continue;
      }

      if (obj?.type === "session_meta" && obj?.payload && typeof obj.payload === "object") {
        const payload = obj.payload as Record<string, unknown>;
        const codexAgent = extractCodexAgentMetadata(payload.source);
        const codexFork = extractCodexForkMetadata(payload);
        return {
          id: typeof payload.id === "string" ? payload.id : undefined,
          timestampIso: typeof payload.timestamp === "string" ? payload.timestamp : undefined,
          cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
          originator: typeof payload.originator === "string" ? payload.originator : undefined,
          cliVersion: typeof payload.cli_version === "string" ? payload.cli_version : undefined,
          modelProvider: typeof payload.model_provider === "string" ? payload.model_provider : undefined,
          source: typeof payload.source === "string" ? payload.source : undefined,
          historySource: "codex",
          ...(codexAgent ? { codexAgent } : {}),
          ...(codexFork ? { codexFork } : {}),
        };
      }

      if (!claudeMeta.id && typeof obj?.sessionId === "string") claudeMeta.id = obj.sessionId;
      if (!claudeMeta.timestampIso && typeof obj?.timestamp === "string") claudeMeta.timestampIso = obj.timestamp;
      if (!claudeMeta.cwd && typeof obj?.cwd === "string") claudeMeta.cwd = obj.cwd;
      if (!claudeMeta.cliVersion && typeof obj?.version === "string") claudeMeta.cliVersion = obj.version;
      if (!claudeMeta.source) claudeMeta.source = "claude-vscode";

      if (scanned >= META_SCAN_LINE_LIMIT) break;
    }
  } finally {
    rl.close();
    stream.close();
  }

  if (!claudeMeta.id && !claudeMeta.timestampIso && !claudeMeta.cwd) return null;
  return claudeMeta;
}

function inferYmdFromPath(sessionsRoot: string, fsPath: string): { year: number; month: number; day: number } | null {
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

function buildCodexPreviewText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const maybeText = (item as { text?: unknown }).text;
    if (typeof maybeText === "string") texts.push(maybeText);
  }
  return texts.join("");
}

function buildClaudePreviewText(content: unknown): string {
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

function buildClaudePreviewAttachmentText(attachments: readonly ChatAttachment[]): string {
  return buildAttachmentSummaryLines(attachments, { mode: "resume" }).join("\n");
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

function parseTimestampDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}

function parseTimestampIso(value: unknown): string | undefined {
  return parseTimestampDate(value) ? String(value) : undefined;
}

function extractCodexActivityTimestampIso(obj: any): string | undefined {
  if (obj?.type !== "response_item") return undefined;
  const payloadType = typeof obj?.payload?.type === "string" ? obj.payload.type : "";
  if (payloadType !== "message" && payloadType !== "function_call" && payloadType !== "function_call_output") {
    return undefined;
  }
  return parseTimestampIso(obj?.timestamp);
}

function extractClaudeActivityTimestampIso(obj: any): string | undefined {
  if (!detectClaudeMessageRole(obj)) return undefined;
  return parseTimestampIso(obj?.timestamp);
}

function extractClaudeSummaryTitle(obj: any): string | undefined {
  const summary = typeof obj?.summary === "string" ? obj.summary.trim() : "";
  if (obj?.type !== "summary" || !summary) return undefined;
  return summary;
}

function extractClaudeAiTitle(obj: any): string | undefined {
  const title = typeof obj?.aiTitle === "string" ? obj.aiTitle.trim() : "";
  if (obj?.type !== "ai-title" || !title) return undefined;
  return title;
}

function extractClaudeCustomTitle(obj: any): string | undefined {
  const title = typeof obj?.customTitle === "string" ? obj.customTitle.trim() : "";
  if (obj?.type !== "custom-title" || !title) return undefined;
  return title;
}

function extractClaudeRenameTitle(obj: any): string | undefined {
  if (obj?.type !== "system" || obj?.subtype !== "local_command") return undefined;

  const candidates = [obj?.content, obj?.message?.content];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const match = candidate.match(/<local-command-stdout>Session renamed to:\s*(.+?)<\/local-command-stdout>/i);
    const renamed = match?.[1]?.trim();
    if (renamed) return renamed;
  }

  return undefined;
}

async function readSessionActivityInfo(
  fsPath: string,
  source: SessionSource,
): Promise<{ lastActivityTimestampIso?: string; nativeTitle?: string }> {
  const stream = fs.createReadStream(fsPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lastTimestampIso: string | undefined;
  let claudeCustomTitle: string | undefined;
  let claudeAiTitle: string | undefined;
  let claudeSummaryTitle: string | undefined;
  let claudeRenameTitle: string | undefined;
  try {
    for await (const line of rl) {
      if (!line) continue;

      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      const timestampIso =
        source === "claude"
          ? extractClaudeActivityTimestampIso(obj)
          : extractCodexActivityTimestampIso(obj);
      if (timestampIso) lastTimestampIso = timestampIso;

      if (source === "claude") {
        const customTitle = extractClaudeCustomTitle(obj);
        if (customTitle) claudeCustomTitle = customTitle;

        const aiTitle = extractClaudeAiTitle(obj);
        if (aiTitle) claudeAiTitle = aiTitle;

        const summaryTitle = extractClaudeSummaryTitle(obj);
        if (summaryTitle) claudeSummaryTitle = summaryTitle;

        const renameTitle = extractClaudeRenameTitle(obj);
        if (renameTitle) claudeRenameTitle = renameTitle;
      }
    }
  } finally {
    rl.close();
    stream.close();
  }

  return {
    lastActivityTimestampIso: lastTimestampIso,
    nativeTitle:
      source === "claude"
        ? claudeCustomTitle ?? claudeAiTitle ?? claudeRenameTitle ?? claudeSummaryTitle
        : undefined,
  };
}

function toLocalDateString(date: Date, timeZone: string): string {
  return ymdToString(toYmdInTimeZone(date, timeZone));
}

function toTimeLabel(date: Date, timeZone: string): string {
  return formatTimeHmInTimeZone(date, timeZone);
}

export async function readPreviewMessages(fsPath: string, maxMessages: number): Promise<PreviewMessage[]> {
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

      if (obj?.type === "response_item" && obj?.payload?.type === "message") {
        const role = obj?.payload?.role;
        if (role !== "user" && role !== "assistant") continue;

        const textRaw = buildCodexPreviewText(obj?.payload?.content);
        const textNormalized = normalizeWhitespace(textRaw);
        if (!textNormalized) continue;
        const userText =
          role === "user" ? extractCodexCompactUserText(obj?.payload?.content, textNormalized) : null;
        if (role === "user" && !userText) continue;
        const text = role === "user" ? userText! : textNormalized;

        const trimmed = text.length > 1200 ? `${text.slice(0, 1199)}...` : text;
        result.push({ role, text: trimmed });
        continue;
      }

      const role = detectClaudeMessageRole(obj);
      if (!role) continue;

      const rawContent = getClaudeMessageContent(obj);
      if (role === "user" && extractClaudeLocalCommandOutputContent(rawContent)) continue;
      const extracted = await extractClaudeMessageContent(rawContent, undefined, { enabled: false }, { role });
      const attachmentSummary = buildClaudePreviewAttachmentText(extracted.attachments);
      const textRaw = [buildClaudePreviewText(extracted.text), attachmentSummary].filter(Boolean).join("\n");
      const textNormalized = normalizeWhitespace(textRaw);
      if (!textNormalized) continue;
      const userText = role === "user" ? extractCompactUserText(textNormalized) : null;
      if (role === "user" && !userText) continue;
      const text = role === "user" ? userText! : textNormalized;

      const trimmed = text.length > 1200 ? `${text.slice(0, 1199)}...` : text;
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
  sourceRoot?: string;
  storage?: SessionStorageLocation;
  fsPath: string;
  previewMaxMessages: number;
  timeZone: string;
}): Promise<SessionSummary | null> {
  const { sessionsRoot, fsPath, previewMaxMessages, timeZone } = params;
  const sourceRoot = params.sourceRoot ?? sessionsRoot;
  const stat = await statSafe(fsPath);
  if (!stat) return null;

  const cacheKey = normalizeCacheKey(fsPath);
  const readMeta = (await tryReadSessionMeta(fsPath)) ?? {};
  const source = detectSessionSource(readMeta, fsPath);
  const storage: SessionStorageLocation =
    params.storage ??
    (source === "claude"
      ? { rootKind: "claudeSessions", archiveState: "active", rootPath: sourceRoot }
      : { rootKind: "codexSessions", archiveState: "active", rootPath: sourceRoot });
  const meta: SessionMetaInfo = { ...readMeta, historySource: source };
  const identityKey = resolveSessionIdentityKey(source, meta, fsPath, cacheKey);
  const activityInfo = await readSessionActivityInfo(fsPath, source);
  const lastActivityIso = activityInfo.lastActivityTimestampIso;

  const inferred = source === "codex" ? inferYmdFromPath(sourceRoot, fsPath) ?? undefined : undefined;
  const startValid = parseTimestampDate(meta.timestampIso);
  const lastActivityValid = parseTimestampDate(lastActivityIso);

  if (source === "claude" && !startValid && !lastActivityValid) return null;

  const statDate = new Date(stat.mtimeMs);
  const startedLocalDate = startValid
    ? toLocalDateString(startValid, timeZone)
    : inferred
      ? ymdToString(inferred)
      : lastActivityValid && source === "claude"
        ? toLocalDateString(lastActivityValid, timeZone)
        : toLocalDateString(statDate, timeZone);
  const startedTimeLabel = startValid
    ? toTimeLabel(startValid, timeZone)
    : lastActivityValid && source === "claude"
      ? toTimeLabel(lastActivityValid, timeZone)
      : "--:--";
  const lastActivityLocalDate = lastActivityValid
    ? toLocalDateString(lastActivityValid, timeZone)
    : startValid
      ? toLocalDateString(startValid, timeZone)
      : inferred
        ? ymdToString(inferred)
        : toLocalDateString(statDate, timeZone);
  const lastActivityTimeLabel = lastActivityValid
    ? toTimeLabel(lastActivityValid, timeZone)
    : startValid
      ? toTimeLabel(startValid, timeZone)
      : "--:--";

  const previewMessages = await readPreviewMessages(fsPath, previewMaxMessages);
  const snippetSource = resolvePreviewSessionTitleCandidate(previewMessages);
  const snippet = snippetSource ? singleLineSnippet(snippetSource, 70) : path.basename(fsPath);
  const cwdShort = meta.cwd ? safeDisplayPath(meta.cwd, 80) : "";

  return {
    fsPath,
    cacheKey,
    identityKey,
    source,
    storage,
    meta,
    inferredYmd: inferred,
    startedAtIso: parseTimestampIso(meta.timestampIso),
    lastActivityAtIso: lastActivityIso,
    startedLocalDate,
    startedTimeLabel,
    lastActivityLocalDate,
    lastActivityTimeLabel,
    localDate: startedLocalDate,
    timeLabel: startedTimeLabel,
    snippet,
    nativeTitle: activityInfo.nativeTitle,
    displayTitle: snippet,
    cwdShort,
    previewMessages,
  };
}

function detectSessionSource(meta: SessionMetaInfo, fsPath: string): SessionSource {
  if (meta.historySource === "codex" || meta.historySource === "claude") return meta.historySource;
  const base = path.basename(fsPath).toLowerCase();
  return base.startsWith("rollout-") ? "codex" : "claude";
}

function resolveSessionIdentityKey(
  source: SessionSource,
  meta: SessionMetaInfo,
  fsPath: string,
  cacheKey: string,
): string {
  const sessionId = normalizeIdentityPart(meta.id);
  if (sessionId) return boundSessionIdentityKey(source, `${source}:id:${sessionId}`);

  if (source === "codex") {
    const rolloutId = extractCodexRolloutId(fsPath);
    if (rolloutId) return boundSessionIdentityKey(source, `${source}:rollout:${rolloutId}`);
  }

  return boundSessionIdentityKey(source, `${source}:path:${cacheKey}`);
}

function extractCodexRolloutId(fsPath: string): string {
  const base = path.basename(fsPath);
  const match =
    /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu.exec(base);
  return match?.[1]?.toLowerCase() ?? "";
}

function normalizeIdentityPart(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/[\u0000-\u001f\u007f]/gu, "").toLowerCase();
}
