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
  extractCodexMessageContent,
  isCodexProtocolContextContent,
  selectClaudeControlContent,
} from "../chat/chatAttachments";
import {
  createClaudePastedPromptResolver,
  type ClaudePastedPromptResolver,
} from "../chat/claudePastedPrompt";
import { isClaudeCrossSessionInboundRecord } from "../chat/claudeCrossSessionMessage";
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
import {
  extractCodexHistoryBaseMetadata,
  readSessionJsonlRecords,
  type CodexLogicalHistoryPlan,
  type SessionJsonlReadOptions,
} from "./codexHistoryBase";
import type { PerformanceProbe } from "../performance/performanceCounters";

const META_SCAN_LINE_LIMIT = 400;

// Read session meta from the top of JSONL. Supports both Codex and Claude logs.
export async function tryReadSessionMeta(
  fsPath: string,
  performanceProbe?: PerformanceProbe,
): Promise<SessionMetaInfo | null> {
  performanceProbe?.add("segmentCount");
  performanceProbe?.add("streamOpenCount");
  const stream = fs.createReadStream(fsPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const claudeMeta: SessionMetaInfo = { historySource: "claude" };
  let scanned = 0;
  let hasParsedRecord = false;

  try {
    for await (const line of rl) {
      if (performanceProbe) observeEstimatedJsonlLine(performanceProbe, line);
      if (!line) continue;
      scanned += 1;

      let obj: any;
      try {
        obj = JSON.parse(line);
        performanceProbe?.add("parseSuccessCount");
      } catch {
        performanceProbe?.add("malformedLineCount");
        if (scanned >= META_SCAN_LINE_LIMIT) break;
        continue;
      }
      const isFirstParsedRecord = !hasParsedRecord;
      hasParsedRecord = true;

      const codexMeta = extractCodexSessionMeta(obj, isFirstParsedRecord);
      if (codexMeta) return codexMeta;

      observeClaudeSessionMeta(claudeMeta, obj);

      if (scanned >= META_SCAN_LINE_LIMIT) break;
    }
  } finally {
    rl.close();
    stream.close();
  }

  return hasClaudeSessionMeta(claudeMeta) ? claudeMeta : null;
}

function extractCodexSessionMeta(obj: any, isFirstParsedRecord: boolean): SessionMetaInfo | undefined {
  if (obj?.type !== "session_meta" || !obj?.payload || typeof obj.payload !== "object") return undefined;
  const payload = obj.payload as Record<string, unknown>;
  const codexAgent = extractCodexAgentMetadata(payload.source);
  const codexFork = extractCodexForkMetadata(payload);
  const codexHistoryBase = isFirstParsedRecord
    ? extractCodexHistoryBaseMetadata(payload, obj?.ordinal)
    : undefined;
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
    ...(codexHistoryBase ? { codexHistoryBase } : {}),
  };
}

function observeClaudeSessionMeta(meta: SessionMetaInfo, obj: any): void {
  if (!meta.id && typeof obj?.sessionId === "string") meta.id = obj.sessionId;
  if (!meta.timestampIso && typeof obj?.timestamp === "string") meta.timestampIso = obj.timestamp;
  if (!meta.cwd && typeof obj?.cwd === "string") meta.cwd = obj.cwd;
  if (!meta.cliVersion && typeof obj?.version === "string") meta.cliVersion = obj.version;
  if (!meta.source) meta.source = "claude-vscode";
}

function hasClaudeSessionMeta(meta: SessionMetaInfo): boolean {
  return Boolean(meta.id || meta.timestampIso || meta.cwd);
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

function buildPreviewAttachmentText(attachments: readonly ChatAttachment[]): string {
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
  if (
    payloadType !== "message" &&
    payloadType !== "function_call" &&
    payloadType !== "custom_tool_call" &&
    payloadType !== "function_call_output" &&
    payloadType !== "custom_tool_call_output" &&
    payloadType !== "local_shell_call" &&
    payloadType !== "web_search_call" &&
    payloadType !== "image_generation_call"
  ) {
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

function toLocalDateString(date: Date, timeZone: string): string {
  return ymdToString(toYmdInTimeZone(date, timeZone));
}

function toTimeLabel(date: Date, timeZone: string): string {
  return formatTimeHmInTimeZone(date, timeZone);
}

export async function readPreviewMessages(
  fsPath: string,
  maxMessages: number,
  options: {
    sessionInventory?: readonly SessionSummary[];
    plan?: CodexLogicalHistoryPlan;
    source?: SessionSource;
    token?: { readonly isCancellationRequested: boolean };
    performanceProbe?: PerformanceProbe;
  } = {},
): Promise<PreviewMessage[]> {
  const pastedPromptResolver = await createClaudePastedPromptResolver(fsPath);
  const source = options.source ?? detectSessionSource({}, fsPath);

  const result: PreviewMessage[] = [];
  for await (const record of readSessionJsonlRecords(fsPath, source, {
    sessionInventory: options.sessionInventory,
    plan: options.plan,
    token: options.token,
    performanceProbe: options.performanceProbe,
  })) {
    if (result.length >= maxMessages) break;
    await appendPreviewMessage(record.value, pastedPromptResolver, result);
  }

  return result;
}

async function appendPreviewMessage(
  obj: any,
  pastedPromptResolver: ClaudePastedPromptResolver | undefined,
  result: PreviewMessage[],
): Promise<void> {
  if (obj?.type === "response_item" && obj?.payload?.type === "message") {
    const role = obj?.payload?.role;
    if (role !== "user" && role !== "assistant") return;

    const content = obj?.payload?.content;
    if (role === "user" && isCodexProtocolContextContent(content)) return;
    const extracted = await extractCodexMessageContent(content, undefined, { enabled: false }, { role });
    const cleanText = normalizeWhitespace(extracted.text);
    const attachmentSummary = buildPreviewAttachmentText(extracted.attachments);
    const textNormalized = normalizeWhitespace([cleanText, attachmentSummary].filter(Boolean).join("\n"));
    if (!textNormalized) return;
    const userText =
      role === "user"
        ? extractCodexCompactUserText(content, cleanText) ?? (attachmentSummary || null)
        : null;
    if (role === "user" && !userText) return;
    const text = role === "user" ? userText! : textNormalized;

    const trimmed = text.length > 1200 ? `${text.slice(0, 1199)}...` : text;
    result.push({ role, text: trimmed });
    return;
  }

  const role = detectClaudeMessageRole(obj);
  if (!role || isClaudeCrossSessionInboundRecord(obj)) return;

  const rawContent = getClaudeMessageContent(obj);
  const pastedPrompt = role === "user" ? await pastedPromptResolver?.resolve(obj, rawContent) : undefined;
  const controlContent = selectClaudeControlContent(rawContent, pastedPrompt);
  if (role === "user" && extractClaudeLocalCommandOutputContent(controlContent)) return;
  const extracted = await extractClaudeMessageContent(rawContent, undefined, { enabled: false }, { role, pastedPrompt });
  const attachmentSummary = buildPreviewAttachmentText(extracted.attachments);
  const textRaw = [buildClaudePreviewText(extracted.text), attachmentSummary].filter(Boolean).join("\n");
  const textNormalized = normalizeWhitespace(textRaw);
  if (!textNormalized) return;
  const userText = role === "user" ? extractCompactUserText(textNormalized) : null;
  if (role === "user" && !userText) return;
  const text = role === "user" ? userText! : textNormalized;

  const trimmed = text.length > 1200 ? `${text.slice(0, 1199)}...` : text;
  result.push({ role, text: trimmed });
}

interface PhysicalSessionSummaryScan {
  readonly meta: SessionMetaInfo | null;
  readonly codexLastActivityTimestampIso?: string;
  readonly claudeLastActivityTimestampIso?: string;
  readonly claudeNativeTitle?: string;
  readonly previewMessages: PreviewMessage[];
}

async function scanPhysicalSessionSummary(
  fsPath: string,
  maxMessages: number,
  performanceProbe?: PerformanceProbe,
  token?: SessionJsonlReadOptions["token"],
  cancellationErrorFactory?: SessionJsonlReadOptions["cancellationErrorFactory"],
): Promise<PhysicalSessionSummaryScan> {
  throwIfSummaryScanCancelled(token, cancellationErrorFactory);
  const pastedPromptResolver = await createClaudePastedPromptResolver(fsPath);
  const claudeMeta: SessionMetaInfo = { historySource: "claude" };
  const previewMessages: PreviewMessage[] = [];
  let codexMeta: SessionMetaInfo | undefined;
  let metaScanComplete = false;
  let metaScannedLineCount = 0;
  let hasParsedMetaRecord = false;
  let codexLastActivityTimestampIso: string | undefined;
  let claudeLastActivityTimestampIso: string | undefined;
  let claudeCustomTitle: string | undefined;
  let claudeAiTitle: string | undefined;
  let claudeSummaryTitle: string | undefined;
  let claudeRenameTitle: string | undefined;

  performanceProbe?.add("segmentCount");
  performanceProbe?.add("streamOpenCount");
  const stream = fs.createReadStream(fsPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      throwIfSummaryScanCancelled(token, cancellationErrorFactory);
      if (performanceProbe) {
        observeEstimatedJsonlLine(performanceProbe, line);
        performanceProbe.add("logicalLineCount");
      }
      if (!line) continue;

      let obj: any;
      try {
        obj = JSON.parse(line);
        performanceProbe?.add("parseSuccessCount");
      } catch {
        performanceProbe?.add("malformedLineCount");
        if (!metaScanComplete) {
          metaScannedLineCount += 1;
          if (metaScannedLineCount >= META_SCAN_LINE_LIMIT) metaScanComplete = true;
        }
        continue;
      }

      if (!metaScanComplete) {
        metaScannedLineCount += 1;
        const isFirstParsedRecord = !hasParsedMetaRecord;
        hasParsedMetaRecord = true;
        codexMeta = extractCodexSessionMeta(obj, isFirstParsedRecord);
        if (codexMeta) {
          metaScanComplete = true;
        } else {
          observeClaudeSessionMeta(claudeMeta, obj);
          if (metaScannedLineCount >= META_SCAN_LINE_LIMIT) metaScanComplete = true;
        }
      }

      const codexTimestampIso = extractCodexActivityTimestampIso(obj);
      if (codexTimestampIso) codexLastActivityTimestampIso = codexTimestampIso;
      const claudeTimestampIso = extractClaudeActivityTimestampIso(obj);
      if (claudeTimestampIso) claudeLastActivityTimestampIso = claudeTimestampIso;

      const customTitle = extractClaudeCustomTitle(obj);
      if (customTitle) claudeCustomTitle = customTitle;
      const aiTitle = extractClaudeAiTitle(obj);
      if (aiTitle) claudeAiTitle = aiTitle;
      const summaryTitle = extractClaudeSummaryTitle(obj);
      if (summaryTitle) claudeSummaryTitle = summaryTitle;
      const renameTitle = extractClaudeRenameTitle(obj);
      if (renameTitle) claudeRenameTitle = renameTitle;

      if (!(previewMessages.length >= maxMessages)) {
        await appendPreviewMessage(obj, pastedPromptResolver, previewMessages);
      }
    }
  } finally {
    rl.close();
    stream.close();
  }

  const claudeNativeTitle = claudeCustomTitle ?? claudeAiTitle ?? claudeRenameTitle ?? claudeSummaryTitle;
  return {
    meta: codexMeta ?? (hasClaudeSessionMeta(claudeMeta) ? claudeMeta : null),
    ...(codexLastActivityTimestampIso ? { codexLastActivityTimestampIso } : {}),
    ...(claudeLastActivityTimestampIso ? { claudeLastActivityTimestampIso } : {}),
    ...(claudeNativeTitle ? { claudeNativeTitle } : {}),
    previewMessages,
  };
}

export interface CodexHistoryBasePreviewRebuildResult {
  readonly summary: SessionSummary;
  readonly complete: boolean;
}

export async function rebuildCodexHistoryBasePreview(
  summary: SessionSummary,
  sessionInventory: readonly SessionSummary[],
  maxMessages: number,
  token?: { readonly isCancellationRequested: boolean },
  performanceProbe?: PerformanceProbe,
  plan?: CodexLogicalHistoryPlan,
): Promise<CodexHistoryBasePreviewRebuildResult> {
  if (summary.source !== "codex" || !summary.meta.codexHistoryBase) {
    return { summary, complete: true };
  }
  try {
    const previewMessages = await readPreviewMessages(summary.fsPath, maxMessages, {
      source: "codex",
      sessionInventory,
      plan,
      token,
      performanceProbe,
    });
    const snippetSource = resolvePreviewSessionTitleCandidate(previewMessages);
    const snippet = snippetSource ? singleLineSnippet(snippetSource, 70) : path.basename(summary.fsPath);
    const displayTitle = summary.customTitle ?? summary.originalTitle ?? summary.nativeTitle ?? snippet;
    if (
      summary.snippet === snippet &&
      summary.displayTitle === displayTitle &&
      arePreviewMessagesEqual(summary.previewMessages, previewMessages)
    ) {
      return { summary, complete: true };
    }
    return {
      summary: {
        ...summary,
        previewMessages,
        snippet,
        displayTitle,
      },
      complete: true,
    };
  } catch (error) {
    if (token?.isCancellationRequested) throw error;
    return { summary, complete: false };
  }
}

function arePreviewMessagesEqual(
  left: readonly PreviewMessage[],
  right: readonly PreviewMessage[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((message, index) => {
    const candidate = right[index];
    return candidate?.role === message.role && candidate.text === message.text;
  });
}

export async function buildSessionSummary(params: {
  sessionsRoot: string;
  sourceRoot?: string;
  storage?: SessionStorageLocation;
  fsPath: string;
  previewMaxMessages: number;
  timeZone: string;
  fileStat?: Readonly<{ mtimeMs: number; size: number }>;
  performanceProbe?: PerformanceProbe;
  token?: SessionJsonlReadOptions["token"];
  cancellationErrorFactory?: SessionJsonlReadOptions["cancellationErrorFactory"];
}): Promise<SessionSummary | null> {
  const { sessionsRoot, fsPath, previewMaxMessages, timeZone } = params;
  const sourceRoot = params.sourceRoot ?? sessionsRoot;
  throwIfSummaryScanCancelled(params.token, params.cancellationErrorFactory);
  let stat = params.fileStat;
  if (
    stat &&
    (!Number.isFinite(stat.mtimeMs) || !Number.isSafeInteger(stat.size) || stat.size < 0)
  ) {
    return null;
  }
  if (!stat) {
    params.performanceProbe?.add("statCount");
    stat = await statSafe(fsPath) ?? undefined;
  }
  throwIfSummaryScanCancelled(params.token, params.cancellationErrorFactory);
  if (!stat) return null;

  const cacheKey = normalizeCacheKey(fsPath);
  const scan = await scanPhysicalSessionSummary(
    fsPath,
    previewMaxMessages,
    params.performanceProbe,
    params.token,
    params.cancellationErrorFactory,
  );
  const readMeta = scan.meta ?? {};
  const source = detectSessionSource(readMeta, fsPath);
  const storage: SessionStorageLocation =
    params.storage ??
    (source === "claude"
      ? { rootKind: "claudeSessions", archiveState: "active", rootPath: sourceRoot }
      : { rootKind: "codexSessions", archiveState: "active", rootPath: sourceRoot });
  const meta: SessionMetaInfo = { ...readMeta, historySource: source };
  const identityKey = resolveSessionIdentityKey(source, meta, fsPath, cacheKey);
  const lastActivityIso = source === "claude"
    ? scan.claudeLastActivityTimestampIso
    : scan.codexLastActivityTimestampIso;

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

  const previewMessages = scan.previewMessages;
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
    nativeTitle: source === "claude" ? scan.claudeNativeTitle : undefined,
    displayTitle: snippet,
    cwdShort,
    previewMessages,
  };
}

function throwIfSummaryScanCancelled(
  token?: SessionJsonlReadOptions["token"],
  cancellationErrorFactory?: SessionJsonlReadOptions["cancellationErrorFactory"],
): void {
  if (!token?.isCancellationRequested) return;
  throw cancellationErrorFactory?.() ?? new Error("Session summary scan was cancelled.");
}

function observeEstimatedJsonlLine(performanceProbe: PerformanceProbe, line: string): void {
  performanceProbe.add("physicalLineCount");
  performanceProbe.add("readByteEstimatedCount", Buffer.byteLength(line, "utf8") + 1);
}

function detectSessionSource(meta: SessionMetaInfo, fsPath: string): SessionSource {
  if (meta.historySource === "codex" || meta.historySource === "claude") return meta.historySource;
  const base = path.basename(fsPath).toLowerCase();
  return base.startsWith("rollout-") ? "codex" : "claude";
}

export function resolveSessionIdentityKey(
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
