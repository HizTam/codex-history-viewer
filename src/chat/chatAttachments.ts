import * as path from "node:path";
import type {
  ChatAttachment,
  ChatDocumentAttachment,
  ChatDocumentKind,
  ChatFileKind,
  ChatFileReferenceAttachment,
  ChatImageAttachment,
  ChatImageAttachmentReason,
  ChatInvokeAttachment,
  ChatInvokeParameter,
  ChatNotificationAttachment,
  ChatNotificationStatus,
  ChatRole,
  ChatSelectionReferenceAttachment,
  ChatSystemEventScope,
} from "./chatTypes";
import type { ChatImageExtractionOptions } from "./chatImageAttachments";
import {
  addUnavailablePlaceholderIfNeeded,
  extractImageAttachmentFromItem,
  isPotentialImageAttachmentItem,
  stripImagePlaceholders,
} from "./chatImageAttachments";
import { getClaudeRequestInterruptedScope, isCodexTurnAbortedMessageText } from "../utils/textUtils";

export const CHAT_TEXT_DOCUMENT_PREVIEW_CHARS = 16_000;
export const CHAT_TEXT_DOCUMENT_SEARCH_CHARS = 64_000;
export const CHAT_TEXT_DOCUMENT_SAVE_BYTES = 5 * 1024 * 1024;
export const CHAT_EMBEDDED_BASE64_DOCUMENT_BYTES = 32 * 1024 * 1024;
export const CHAT_SELECTION_PREVIEW_CHARS = 4_000;
export const CHAT_ATTACHMENT_LABEL_SEARCH_CHARS = 512;
export const CHAT_ATTACHMENT_PATH_SEARCH_CHARS = 4_096;
export const CHAT_TASK_NOTIFICATION_RESULT_PREVIEW_CHARS = 12_000;
export const CHAT_TASK_NOTIFICATION_RESULT_MARKDOWN_CHARS = 120_000;
export const CHAT_TASK_NOTIFICATION_RESULT_SEARCH_CHARS = 64_000;
export const CHAT_INVOKE_PARAMETER_PREVIEW_CHARS = 4_000;
export const CHAT_INVOKE_PARAMETER_MARKDOWN_CHARS = 120_000;
export const CHAT_INVOKE_PARAMETER_SEARCH_CHARS = 32_000;

const DEFAULT_DOCUMENT_LABEL = "document-attachment";
const DEFAULT_FILE_REFERENCE_LABEL = "file-reference";
const TASK_NOTIFICATION_PREAMBLE =
  "[SYSTEM NOTIFICATION - NOT USER INPUT]\n" +
  "This is an automated background-task event, NOT a message from the user.\n" +
  "Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.";
const TASK_NOTIFICATION_OPEN_TAG = "<task-notification";
const TASK_NOTIFICATION_CLOSE_TAG = "</task-notification>";
const TASK_NOTIFICATION_OPEN_TAG_MAX_CHARS = 512;
const CODE_EXTENSIONS = new Set([
  ".bash",
  ".bat",
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".htm",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".kt",
  ".kts",
  ".php",
  ".ps1",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".swift",
  ".ts",
  ".tsx",
  ".xml",
  ".yaml",
  ".yml",
]);
const TEXT_EXTENSIONS = new Set([
  ".csv",
  ".diff",
  ".env",
  ".ini",
  ".log",
  ".md",
  ".markdown",
  ".patch",
  ".text",
  ".toml",
  ".tsv",
  ".txt",
]);
const ARCHIVE_EXTENSIONS = new Set([".7z", ".br", ".bz2", ".gz", ".rar", ".tar", ".tgz", ".xz", ".zip"]);
const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);

export interface ExtractedMessageContent {
  text: string;
  attachments: ChatAttachment[];
}

export interface ExtractedCodexTextContent {
  text: string;
  hasNonTextContent: boolean;
}

export interface ClaudeRequestInterruptionContent {
  scope: ChatSystemEventScope;
}

export interface ClaudeMessageExtractionOptions {
  role?: Extract<ChatRole, "user" | "assistant">;
}

export type AttachmentOutputChannel = "webview" | "markdown" | "search" | "resume" | "handoff";

export interface AttachmentSummaryOptions {
  mode?: "markdown" | "resume" | "handoff";
}

interface TextAttachmentSpan {
  start: number;
  end: number;
  attachment: ChatAttachment;
  replacementText?: string;
}

interface MarkdownSafeContextMap {
  ranges: Array<{ start: number; end: number }>;
  ambiguous: boolean;
}

interface ParsedXmlLikeFields {
  fields: Map<string, string>;
}

interface ParsedParameterField {
  name: string;
  value: string;
}

interface StructuredBlockSpec<T extends ChatAttachment, TOpen> {
  searchText: string;
  closeTag: string;
  matchOpen(text: string, index: number): { openEnd: number; data: TOpen } | null;
  parseBody(body: string, data: TOpen): T | null;
  findPreamble?: (text: string, cursor: number, openIndex: number) => { start: number; end: number; text: string } | null;
}

interface StructuredOpenCandidate<TOpen> {
  index: number;
  openEnd: number;
  data: TOpen;
}

interface StructuredCloseResolution {
  closeIndex: number;
  nextSearchIndex: number;
}

export function detectClaudeMaterializedMessageRole(obj: any): "user" | "assistant" | null {
  if (isClaudeQueuedPromptRecord(obj)) return null;

  const messageRole = typeof obj?.message?.role === "string" ? obj.message.role : "";
  if (messageRole === "user" || messageRole === "assistant") return messageRole;

  const envelopeType = typeof obj?.type === "string" ? obj.type : "";
  if (envelopeType === "user" || envelopeType === "assistant") return envelopeType;

  const topRole = typeof obj?.role === "string" ? obj.role : "";
  if (topRole === "user" || topRole === "assistant") return topRole;

  return null;
}

function isClaudeQueuedPromptRecord(obj: any): boolean {
  const type = typeof obj?.type === "string" ? obj.type : "";
  const attachmentType = typeof obj?.attachment?.type === "string" ? obj.attachment.type : "";
  if (type === "attachment" && attachmentType === "queued_command") return true;
  if (type !== "queue-operation") return false;
  const operation = typeof obj?.operation === "string" ? obj.operation : "";
  return (operation === "enqueue" || operation === "dequeue") && hasClaudeQueuedPromptContent(obj);
}

function hasClaudeQueuedPromptContent(obj: any): boolean {
  if (!obj || typeof obj !== "object") return false;
  if (!Object.prototype.hasOwnProperty.call(obj, "content")) return false;
  const content = obj.content;
  if (typeof content === "string") return content.length > 0;
  return Array.isArray(content) || (content !== null && typeof content === "object");
}

export function extractCodexTextContent(content: unknown): ExtractedCodexTextContent {
  if (typeof content === "string") {
    const stripped = stripImagePlaceholders(content);
    const files = extractCodexFilesMentionedFromText(stripped.text);
    return {
      text: files.text,
      hasNonTextContent: stripped.placeholderCount > 0 || files.attachments.length > 0,
    };
  }

  const items = normalizeContentItems(content);
  const texts: string[] = [];
  let hasNonTextContent = false;

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const maybeText = readStringField(obj, "text");
    if (maybeText) {
      const stripped = stripImagePlaceholders(maybeText);
      const files = extractCodexFilesMentionedFromText(stripped.text);
      if (files.text) texts.push(files.text);
      if (stripped.placeholderCount > 0 || files.attachments.length > 0 || isPotentialImageAttachmentItem(obj)) {
        hasNonTextContent = true;
      }
      continue;
    }
    if (Object.keys(obj).length > 0) hasNonTextContent = true;
  }

  return {
    text: texts.join(""),
    hasNonTextContent,
  };
}

export function isCodexTurnAbortedContent(content: unknown): boolean {
  if (!hasTextCandidate(content, "turn_aborted")) return false;
  const extracted = extractCodexTextContent(content);
  return !extracted.hasNonTextContent && isCodexTurnAbortedMessageText(extracted.text);
}

export function extractClaudeRequestInterruptionContent(content: unknown): ClaudeRequestInterruptionContent | null {
  if (!hasTextCandidate(content, "Request interrupted by user")) return null;

  if (typeof content === "string") {
    if (hasClaudeIdeTag(content) || stripImagePlaceholders(content).placeholderCount > 0) return null;
    return toClaudeRequestInterruptionContent(content);
  }

  const items = normalizeContentItems(content);
  if (items.length === 0) return null;
  const texts: string[] = [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const type = normalizeType(readStringField(obj, "type"));
    if (type === "text" || type === "inputtext" || type === "outputtext" || (!type && typeof obj.text === "string")) {
      if (isPotentialImageAttachmentItem(obj)) return null;
      const text = readStringField(obj, "text");
      if (text === undefined) continue;
      const stripped = stripImagePlaceholders(text);
      if (stripped.placeholderCount > 0 || hasClaudeIdeTag(stripped.text)) return null;
      if (stripped.text.trim()) texts.push(stripped.text);
      continue;
    }
    if (Object.keys(obj).length > 0) return null;
  }

  return toClaudeRequestInterruptionContent(texts.join(""));
}

function toClaudeRequestInterruptionContent(text: string): ClaudeRequestInterruptionContent | null {
  const scope = getClaudeRequestInterruptedScope(text);
  return scope ? { scope } : null;
}

export async function extractCodexMessageContent(
  content: unknown,
  sessionCwd?: string,
  options?: ChatImageExtractionOptions,
): Promise<ExtractedMessageContent> {
  const imageOptions = normalizeImageOptions(options);
  const items = normalizeContentItems(content);
  const texts: string[] = [];
  const attachments: ChatAttachment[] = [];
  let placeholderCount = 0;
  let placeholderInsertIndex: number | undefined;

  if (typeof content === "string") {
    const stripped = stripImagePlaceholders(content);
    if (stripped.placeholderCount > 0) {
      placeholderInsertIndex = attachments.length;
    }
    placeholderCount += stripped.placeholderCount;
    const files = extractCodexFilesMentionedFromText(stripped.text);
    if (files.text) texts.push(files.text);
    attachments.push(...files.attachments);
  }

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const maybeText = readStringField(obj, "text");
    if (maybeText) {
      const stripped = stripImagePlaceholders(maybeText);
      if (stripped.placeholderCount > 0 && placeholderInsertIndex === undefined) {
        placeholderInsertIndex = attachments.length;
      }
      placeholderCount += stripped.placeholderCount;
      const files = extractCodexFilesMentionedFromText(stripped.text);
      if (files.text) texts.push(files.text);
      attachments.push(...files.attachments);
    }

    const image = await extractImageAttachmentFromItem(obj, sessionCwd, imageOptions);
    if (image) attachments.push(image);
  }

  addPlaceholderImageIfNeeded(attachments, placeholderCount, placeholderInsertIndex, imageOptions.enabled ? "remote" : "disabled");
  return {
    text: texts.join(""),
    attachments,
  };
}

function extractClaudeTextAttachmentsFromText(
  text: string,
  role: ClaudeMessageExtractionOptions["role"] | undefined,
): ExtractedMessageContent {
  const normalized = normalizeNewlines(text);
  const spans: TextAttachmentSpan[] = [
    ...collectClaudeIdeReferenceSpans(normalized),
    ...collectClaudeStructuredAttachmentSpans(normalized, role),
  ].sort((a, b) => a.start - b.start || b.end - a.end);

  if (spans.length === 0) return { text: normalized, attachments: [] };

  const attachments: ChatAttachment[] = [];
  const parts: string[] = [];
  const seenNotifications = new Set<string>();
  let cursor = 0;

  for (const span of spans) {
    if (span.start < cursor || span.end <= span.start) continue;
    parts.push(normalized.slice(cursor, span.start));
    if (span.attachment.type === "notification") {
      const key = buildTaskNotificationDedupKey(span.attachment);
      if (!seenNotifications.has(key)) {
        seenNotifications.add(key);
        attachments.push(span.attachment);
      }
    } else {
      attachments.push(span.attachment);
    }
    parts.push(span.replacementText ?? buildRemovedAttachmentSeparator(normalized, span.start, span.end));
    cursor = span.end;
  }

  parts.push(normalized.slice(cursor));
  return { text: parts.join(""), attachments };
}

function buildRemovedAttachmentSeparator(text: string, start: number, end: number): string {
  const before = start > 0 ? text.charAt(start - 1) : "";
  const after = end < text.length ? text.charAt(end) : "";
  if (!before || !after) return "";
  return /\s/u.test(before) || /\s/u.test(after) ? "" : "\n";
}

function collectClaudeStructuredAttachmentSpans(
  text: string,
  role: ClaudeMessageExtractionOptions["role"] | undefined,
): TextAttachmentSpan[] {
  if (role === "user" && !text.includes(TASK_NOTIFICATION_OPEN_TAG)) return [];
  if (role === "assistant" && !text.includes("<invoke")) return [];
  if (role !== "user" && role !== "assistant") return [];
  const safeContext = buildMarkdownCodeAndQuoteSpanMap(text);
  if (safeContext.ambiguous) return [];
  if (role === "user") return collectClaudeTaskNotificationSpans(text, safeContext);
  return collectClaudeInvokeSpans(text, safeContext);
}

function collectClaudeTaskNotificationSpans(text: string, safeContext: MarkdownSafeContextMap): TextAttachmentSpan[] {
  if (!text.includes(TASK_NOTIFICATION_OPEN_TAG)) return [];
  return collectBoundedStructuredBlocks<ChatNotificationAttachment, undefined>(text, safeContext, {
    searchText: TASK_NOTIFICATION_OPEN_TAG,
    closeTag: TASK_NOTIFICATION_CLOSE_TAG,
    matchOpen: matchTaskNotificationOpenTag,
    parseBody: (body) => parseTaskNotificationBody(body),
    findPreamble: findAdjacentTaskNotificationPreamble,
  });
}

function matchTaskNotificationOpenTag(text: string, index: number): { openEnd: number; data: undefined } | null {
  if (!text.startsWith(TASK_NOTIFICATION_OPEN_TAG, index)) return null;
  const afterName = text.charAt(index + TASK_NOTIFICATION_OPEN_TAG.length);
  if (afterName === ">") return { openEnd: index + TASK_NOTIFICATION_OPEN_TAG.length + 1, data: undefined };
  if (!/[\t\n\f\r ]/u.test(afterName)) return null;

  let quote: "'" | '"' | "" = "";
  const maxEnd = Math.min(text.length, index + TASK_NOTIFICATION_OPEN_TAG_MAX_CHARS);
  for (let cursor = index + TASK_NOTIFICATION_OPEN_TAG.length + 1; cursor < maxEnd; cursor += 1) {
    const char = text.charAt(cursor);
    if (quote) {
      if (char === ">") return null;
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "<") return null;
    if (char === ">") return { openEnd: cursor + 1, data: undefined };
  }
  return null;
}

function parseTaskNotificationBody(body: string): ChatNotificationAttachment | null {
  const parsed = parseTopLevelXmlLikeFields(body, [
    "task-id",
    "tool-use-id",
    "output-file",
    "status",
    "summary",
    "note",
    "result",
    "usage",
  ]);
  if (!parsed) return null;
  const taskId = readParsedXmlField(parsed, "task-id");
  const toolUseId = readParsedXmlField(parsed, "tool-use-id");
  const outputFile = readParsedXmlField(parsed, "output-file");
  const rawStatus = readParsedXmlField(parsed, "status");
  const summary = readParsedXmlField(parsed, "summary");
  const note = readParsedXmlField(parsed, "note");
  const result = readParsedXmlField(parsed, "result");
  const usageBody = readParsedXmlField(parsed, "usage");
  if (!taskId && !toolUseId && !outputFile && !rawStatus && !summary && !note && !result && !usageBody) return null;

  const usage = usageBody ? parseTaskNotificationUsage(usageBody) : undefined;
  const cleanUsage =
    usage && Object.keys(usage).length > 0
      ? (usage as NonNullable<ChatNotificationAttachment["usage"]>)
      : undefined;

  const textParts = [
    summary,
    result ? clampText(result, CHAT_TASK_NOTIFICATION_RESULT_PREVIEW_CHARS) : "",
    formatTaskNotificationUsageText(cleanUsage),
  ].filter(Boolean);
  return {
    type: "notification",
    source: "claudeTaskNotification",
    notificationKind: "task",
    status: normalizeTaskNotificationStatus(rawStatus),
    ...(rawStatus ? { rawStatus } : {}),
    ...(taskId ? { taskId } : {}),
    ...(toolUseId ? { toolUseId } : {}),
    ...(summary ? { summary } : {}),
    ...(note ? { note } : {}),
    ...(result ? { result } : {}),
    ...(cleanUsage ? { usage: cleanUsage } : {}),
    ...(outputFile ? { outputFile } : {}),
    ...(textParts.length > 0 ? { text: textParts.join("\n") } : {}),
  };
}

function findAdjacentTaskNotificationPreamble(
  text: string,
  cursor: number,
  openIndex: number,
): { start: number; end: number; text: string } | null {
  const before = text.slice(cursor, openIndex);
  const preambleIndex = before.lastIndexOf(TASK_NOTIFICATION_PREAMBLE);
  if (preambleIndex < 0) return null;
  const afterPreamble = before.slice(preambleIndex + TASK_NOTIFICATION_PREAMBLE.length);
  if (afterPreamble.trim().length > 0) return null;
  return {
    start: cursor + preambleIndex,
    end: openIndex,
    text: TASK_NOTIFICATION_PREAMBLE,
  };
}

function normalizeTaskNotificationStatus(status: string | undefined): ChatNotificationStatus {
  const normalized = (status ?? "").trim().toLowerCase().replace(/[_\s-]+/gu, "");
  if (normalized === "completed" || normalized === "failed" || normalized === "running") return normalized;
  if (normalized === "cancelled" || normalized === "canceled") return "cancelled";
  return "unknown";
}

function buildTaskNotificationDedupKey(attachment: ChatNotificationAttachment): string {
  return [
    attachment.taskId ?? "",
    attachment.toolUseId ?? "",
    attachment.rawStatus ?? attachment.status,
    hashText(attachment.result ?? ""),
  ].join("\u001f");
}

function formatTaskNotificationUsageText(usage: ChatNotificationAttachment["usage"] | undefined): string {
  if (!usage) return "";
  const parts: string[] = [];
  if (typeof usage.subagentTokens === "number") parts.push(`${formatTaskNotificationUsageNumber(usage.subagentTokens)} tokens`);
  if (typeof usage.toolUses === "number") parts.push(`${formatTaskNotificationUsageNumber(usage.toolUses)} tool uses`);
  if (typeof usage.durationMs === "number") {
    const durationText = formatTaskNotificationDurationMs(usage.durationMs);
    if (durationText) parts.push(durationText);
  }
  return parts.join(" / ");
}

function formatTaskNotificationUsageNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Math.max(0, Math.floor(value)).toLocaleString("en-US");
}

function formatTaskNotificationDurationMs(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "";
  const ms = Math.round(value);
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 1 : 2).replace(/\.?0+$/u, "")}s`;
  const totalSeconds = Math.round(seconds);
  if (totalSeconds >= 3600) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

function collectClaudeInvokeSpans(text: string, safeContext: MarkdownSafeContextMap): TextAttachmentSpan[] {
  if (!text.includes("<invoke")) return [];
  return collectBoundedStructuredBlocks<ChatInvokeAttachment, string>(text, safeContext, {
    searchText: "<invoke",
    closeTag: "</invoke>",
    matchOpen: (source, index) => {
      const openMatch = /^<invoke\s+name=(["'])([\s\S]{1,160}?)\1\s*>/iu.exec(source.slice(index));
      if (!openMatch) return null;
      return {
        openEnd: index + openMatch[0].length,
        data: decodeBasicXmlEntities(openMatch[2] ?? "").trim(),
      };
    },
    parseBody: (body, toolName) => {
      if (!toolName) return null;
      const parameters = parseInvokeParameters(body);
      return parameters ? buildInvokeAttachment(toolName, parameters, undefined) : null;
    },
    findPreamble: findAdjacentInvokeHarnessPreamble,
  });
}

function parseInvokeParameters(body: string): ChatInvokeAttachment["parameters"] | null {
  const parsed = parseTopLevelParameterFields(body);
  if (!parsed || parsed.length === 0) return null;
  return parsed;
}

function buildInvokeAttachment(
  toolName: string,
  parameters: ChatInvokeAttachment["parameters"],
  harnessPreamble: string | undefined,
): ChatInvokeAttachment {
  const description = findInvokeParameterValue(parameters, "description");
  const primaryParameterName = choosePrimaryInvokeParameterName(parameters);
  const primaryValue = primaryParameterName ? findInvokeParameterValue(parameters, primaryParameterName) : "";
  const textParts = [
    toolName,
    description,
    ...parameters.map((parameter) => `${parameter.name}: ${parameter.value}`),
  ].filter(Boolean);
  return {
    type: "invoke",
    source: "claudeInvokeMarkup",
    toolName,
    parameters,
    ...(description ? { description } : {}),
    ...(primaryParameterName ? { primaryParameterName } : {}),
    ...(primaryValue ? { primaryParameterPreview: clampText(primaryValue, CHAT_INVOKE_PARAMETER_PREVIEW_CHARS) } : {}),
    ...(harnessPreamble ? { harnessPreamble } : {}),
    ...(textParts.length > 0 ? { text: textParts.join("\n") } : {}),
  };
}

function findAdjacentInvokeHarnessPreamble(
  text: string,
  cursor: number,
  openIndex: number,
): { start: number; end: number; text: string } | null {
  const before = text.slice(cursor, openIndex);
  const match = /(?:^|\n)[ \t]*court[ \t]*(?:\n[ \t]*)*$/u.exec(before);
  if (!match) return null;
  const matched = match[0] ?? "";
  const start = cursor + before.length - matched.length + (matched.startsWith("\n") ? 1 : 0);
  return {
    start,
    end: openIndex,
    text: "court",
  };
}

function choosePrimaryInvokeParameterName(parameters: readonly { name: string; value: string }[]): string | undefined {
  const priority = ["command", "content", "pattern", "file_path", "path", "input"];
  for (const wanted of priority) {
    const found = parameters.find((parameter) => parameter.name.trim().toLowerCase() === wanted && parameter.value.trim());
    if (found) return found.name;
  }
  return parameters.find((parameter) => parameter.value.trim())?.name;
}

function findInvokeParameterValue(parameters: readonly { name: string; value: string }[], name: string): string {
  const wanted = name.trim().toLowerCase();
  return parameters.find((parameter) => parameter.name.trim().toLowerCase() === wanted)?.value.trim() ?? "";
}

function collectBoundedStructuredBlocks<T extends ChatAttachment, TOpen>(
  text: string,
  safeContext: MarkdownSafeContextMap,
  spec: StructuredBlockSpec<T, TOpen>,
): TextAttachmentSpan[] {
  const spans: TextAttachmentSpan[] = [];
  const openCandidates = collectStructuredOpenCandidates(text, safeContext, spec);
  if (openCandidates.length === 0) return spans;
  const closeCandidates = collectAllowedCloseTagCandidates(text, spec.closeTag, safeContext);
  let cursor = 0;
  let searchIndex = 0;
  let candidateIndex = 0;

  while (candidateIndex < openCandidates.length) {
    const open = openCandidates[candidateIndex]!;
    if (open.index < searchIndex) {
      candidateIndex += 1;
      continue;
    }

    const close = resolveStructuredBlockClose(openCandidates, closeCandidates, candidateIndex, spec.closeTag.length, text.length);
    if (close.closeIndex < 0) {
      searchIndex = Math.max(open.index + 1, close.nextSearchIndex);
      candidateIndex += 1;
      continue;
    }
    const closeEnd = close.closeIndex + spec.closeTag.length;
    const attachment = spec.parseBody(text.slice(open.openEnd, close.closeIndex), open.data);
    if (!attachment) {
      searchIndex = open.index + 1;
      candidateIndex += 1;
      continue;
    }

    const preamble = spec.findPreamble?.(text, cursor, open.index);
    const removeStart = preamble?.start ?? open.index;
    if (preamble?.text) attachStructuredPreamble(attachment, preamble.text);
    spans.push({ start: removeStart, end: closeEnd, attachment });
    cursor = closeEnd;
    searchIndex = closeEnd;
    candidateIndex += 1;
  }

  return spans;
}

function collectStructuredOpenCandidates<T extends ChatAttachment, TOpen>(
  text: string,
  safeContext: MarkdownSafeContextMap,
  spec: StructuredBlockSpec<T, TOpen>,
): StructuredOpenCandidate<TOpen>[] {
  const candidates: StructuredOpenCandidate<TOpen>[] = [];
  let searchIndex = 0;
  while (searchIndex < text.length) {
    const openIndex = text.indexOf(spec.searchText, searchIndex);
    if (openIndex < 0) break;
    if (!isOffsetInRanges(openIndex, safeContext.ranges)) {
      const open = spec.matchOpen(text, openIndex);
      if (open && !isOffsetInRanges(open.openEnd - 1, safeContext.ranges)) {
        candidates.push({ index: openIndex, openEnd: open.openEnd, data: open.data });
      }
    }
    searchIndex = openIndex + 1;
  }
  return candidates;
}

function collectAllowedCloseTagCandidates(
  text: string,
  closeTag: string,
  safeContext: MarkdownSafeContextMap,
): number[] {
  const candidates: number[] = [];
  let searchIndex = 0;
  while (searchIndex < text.length) {
    const closeIndex = text.indexOf(closeTag, searchIndex);
    if (closeIndex < 0) break;
    const closeEnd = closeIndex + closeTag.length;
    if (!isOffsetInRanges(closeIndex, safeContext.ranges) && !isOffsetInRanges(closeEnd - 1, safeContext.ranges)) {
      candidates.push(closeIndex);
    }
    searchIndex = closeEnd;
  }
  return candidates;
}

function resolveStructuredBlockClose<TOpen>(
  openCandidates: readonly StructuredOpenCandidate<TOpen>[],
  closeCandidates: readonly number[],
  openCandidateIndex: number,
  closeTagLength: number,
  textLength: number,
): StructuredCloseResolution {
  const open = openCandidates[openCandidateIndex];
  if (!open) return { closeIndex: -1, nextSearchIndex: textLength };
  const nextOpen = openCandidates[openCandidateIndex + 1]?.index ?? textLength;
  const firstCloseCandidate = lowerBoundNumber(closeCandidates, open.openEnd);
  const firstCloseAfterWindow = lowerBoundNumber(closeCandidates, nextOpen);
  const inWindowCount = firstCloseAfterWindow - firstCloseCandidate;
  if (inWindowCount === 1) {
    return { closeIndex: closeCandidates[firstCloseCandidate]!, nextSearchIndex: closeCandidates[firstCloseCandidate]! + closeTagLength };
  }
  const fallbackClose = inWindowCount > 1 ? closeCandidates[firstCloseCandidate] : undefined;
  const nextSearchIndex = fallbackClose !== undefined ? fallbackClose + closeTagLength : nextOpen;
  return { closeIndex: -1, nextSearchIndex: Math.max(open.index + 1, nextSearchIndex) };
}

function lowerBoundNumber(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if ((values[mid] ?? 0) < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

function attachStructuredPreamble(attachment: ChatAttachment, text: string): void {
  if (attachment.type === "notification") {
    attachment.systemPreamble = text;
    return;
  }
  if (attachment.type === "invoke") {
    attachment.harnessPreamble = text;
  }
}

function collectClaudeIdeReferenceSpans(text: string): TextAttachmentSpan[] {
  const spans: TextAttachmentSpan[] = [];
  const regex = /<ide_(opened_file|selection)>([\s\S]*?)<\/ide_\1>/giu;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) {
    const tag = match[1] ?? "";
    const body = match[2] ?? "";
    const attachment = tag === "opened_file" ? buildClaudeOpenedFileAttachment(body) : buildClaudeSelectionAttachment(body);
    spans.push({ start: match.index, end: match.index + match[0].length, attachment, replacementText: "\n" });
  }
  return spans;
}

function parseTopLevelXmlLikeFields(body: string, allowedTags: readonly string[]): ParsedXmlLikeFields | null {
  const allowed = new Set(allowedTags);
  const fields = new Map<string, string>();
  let cursor = 0;

  while (cursor < body.length) {
    const leading = body.slice(cursor).match(/^\s*/u)?.[0] ?? "";
    cursor += leading.length;
    if (cursor >= body.length) break;

    const openMatch = /^<([A-Za-z][A-Za-z0-9_-]*)>/u.exec(body.slice(cursor));
    const tag = openMatch?.[1];
    if (!openMatch || !tag) return null;

    const valueStart = cursor + openMatch[0].length;
    const closeTag = `</${tag}>`;
    const closeIndex = body.indexOf(closeTag, valueStart);
    if (closeIndex < 0) return null;

    if (allowed.has(tag)) {
      if (fields.has(tag)) return null;
      const rawValue = body.slice(valueStart, closeIndex);
      fields.set(tag, decodeBasicXmlEntities(rawValue).trim());
    }
    cursor = closeIndex + closeTag.length;
  }

  return { fields };
}

function readParsedXmlField(parsed: ParsedXmlLikeFields, tag: string): string | undefined {
  const value = parsed.fields.get(tag)?.trim() ?? "";
  return value || undefined;
}

function parseTopLevelParameterFields(body: string): ChatInvokeAttachment["parameters"] | null {
  const params: ParsedParameterField[] = [];
  let cursor = 0;
  while (cursor < body.length) {
    const leading = body.slice(cursor).match(/^\s*/u)?.[0] ?? "";
    cursor += leading.length;
    if (cursor >= body.length) break;

    const openMatch = /^<parameter\s+name=(["'])([\s\S]{1,160}?)\1\s*>/iu.exec(body.slice(cursor));
    if (!openMatch) return null;
    const name = decodeBasicXmlEntities(openMatch[2] ?? "").trim();
    if (!name) return null;

    const valueStart = cursor + openMatch[0].length;
    const nextParameterIndex = findNextParameterOpenIndex(body, valueStart);
    const closeCandidates = findLiteralCandidates(body, "</parameter>", valueStart, nextParameterIndex);
    if (closeCandidates.length !== 1) return null;
    const closeIndex = closeCandidates[0]!;
    if (closeIndex < 0) return null;
    const rawValue = body.slice(valueStart, closeIndex);
    params.push({ name, value: decodeBasicXmlEntities(rawValue) });
    cursor = closeIndex + "</parameter>".length;
  }
  return params;
}

function findNextParameterOpenIndex(body: string, fromIndex: number): number | undefined {
  const match = /<parameter\s+name=(["'])[\s\S]{1,160}?\1\s*>/iu.exec(body.slice(fromIndex));
  return match ? fromIndex + match.index : undefined;
}

function findLiteralCandidates(body: string, token: string, fromIndex: number, stopBefore?: number): number[] {
  const candidates: number[] = [];
  let searchIndex = fromIndex;
  while (searchIndex < body.length && (stopBefore === undefined || searchIndex < stopBefore)) {
    const index = body.indexOf(token, searchIndex);
    if (index < 0 || (stopBefore !== undefined && index >= stopBefore)) break;
    candidates.push(index);
    searchIndex = index + token.length;
  }
  return candidates;
}

function buildMarkdownCodeAndQuoteSpanMap(text: string): MarkdownSafeContextMap {
  const ranges: Array<{ start: number; end: number }> = [];
  const lines = splitLinesWithOffsets(text);
  let fencedStart: { offset: number; markerChar: string; markerLength: number } | null = null;
  let ambiguous = false;

  for (const line of lines) {
    const fence = /^ {0,3}(`{3,}|~{3,})/u.exec(line.text);
    if (fence?.[1]) {
      const marker = fence[1];
      const markerChar = marker[0] ?? "";
      if (!fencedStart) {
        fencedStart = { offset: line.start, markerChar, markerLength: marker.length };
      } else if (markerChar === fencedStart.markerChar && marker.length >= fencedStart.markerLength) {
        ranges.push({ start: fencedStart.offset, end: line.end });
        fencedStart = null;
      }
      continue;
    }
    if (!fencedStart && /^ {0,3}>/u.test(line.text)) {
      ranges.push({ start: line.start, end: line.end });
    }
  }

  if (fencedStart) ranges.push({ start: fencedStart.offset, end: text.length });

  for (const line of lines) {
    if (rangeOverlapsRanges(line.start, line.end, ranges)) continue;
    const inline = findInlineCodeRanges(line.text, line.start);
    ranges.push(...inline.ranges);
    ambiguous = ambiguous || inline.ambiguous;
  }

  return { ranges: mergeRanges(ranges), ambiguous };
}

function splitLinesWithOffsets(text: string): Array<{ text: string; start: number; end: number }> {
  const lines: Array<{ text: string; start: number; end: number }> = [];
  let start = 0;
  while (start <= text.length) {
    const next = text.indexOf("\n", start);
    const end = next < 0 ? text.length : next + 1;
    lines.push({ text: text.slice(start, end), start, end });
    if (next < 0) break;
    start = end;
  }
  return lines;
}

function findInlineCodeRanges(text: string, baseOffset: number): { ranges: Array<{ start: number; end: number }>; ambiguous: boolean } {
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf("`", cursor);
    if (open < 0) break;
    const run = /^`+/u.exec(text.slice(open))?.[0] ?? "";
    if (!run) break;
    const close = text.indexOf(run, open + run.length);
    if (close < 0) {
      ranges.push({ start: baseOffset + open, end: baseOffset + text.length });
      break;
    }
    ranges.push({ start: baseOffset + open, end: baseOffset + close + run.length });
    cursor = close + run.length;
  }
  return { ranges, ambiguous: false };
}

function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const sorted = ranges
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

function isOffsetInRanges(offset: number, ranges: readonly { start: number; end: number }[]): boolean {
  return ranges.some((range) => offset >= range.start && offset < range.end);
}

function rangeOverlapsRanges(start: number, end: number, ranges: readonly { start: number; end: number }[]): boolean {
  return ranges.some((range) => start < range.end && end > range.start);
}

function parseTaskNotificationUsage(body: string): Partial<NonNullable<ChatNotificationAttachment["usage"]>> | undefined {
  const parsed = parseTopLevelXmlLikeFields(body, ["subagent_tokens", "tool_uses", "duration_ms"]);
  if (!parsed) return undefined;
  return {
    ...readOptionalNonNegativeIntegerField(parsed, "subagent_tokens", "subagentTokens"),
    ...readOptionalNonNegativeIntegerField(parsed, "tool_uses", "toolUses"),
    ...readOptionalNonNegativeIntegerField(parsed, "duration_ms", "durationMs"),
  };
}

function readOptionalNonNegativeIntegerField<T extends string>(
  parsed: ParsedXmlLikeFields,
  tag: string,
  key: T,
): { [K in T]?: number } {
  const raw = readParsedXmlField(parsed, tag);
  if (!raw) return {};
  const normalized = raw.replace(/,/gu, "").trim();
  if (!/^\d+$/u.test(normalized)) return {};
  const value = Number(normalized);
  if (!Number.isSafeInteger(value)) return {};
  return { [key]: value } as { [K in T]?: number };
}

function decodeBasicXmlEntities(value: string): string {
  return String(value ?? "")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&");
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export async function extractClaudeMessageContent(
  content: unknown,
  sessionCwd?: string,
  options?: ChatImageExtractionOptions,
  claudeOptions?: ClaudeMessageExtractionOptions,
): Promise<ExtractedMessageContent> {
  const imageOptions = normalizeImageOptions(options);
  const items = normalizeContentItems(content);
  const texts: string[] = [];
  const attachments: ChatAttachment[] = [];
  let placeholderCount = 0;
  let placeholderInsertIndex: number | undefined;

  if (typeof content === "string") {
    const stripped = stripImagePlaceholders(content);
    if (stripped.placeholderCount > 0) {
      placeholderInsertIndex = attachments.length;
    }
    placeholderCount += stripped.placeholderCount;
    const extracted = extractClaudeTextAttachmentsFromText(stripped.text, claudeOptions?.role);
    texts.push(extracted.text);
    attachments.push(...extracted.attachments);
  } else {
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const type = normalizeType(readStringField(obj, "type"));
      if (type === "document") {
        attachments.push(extractClaudeDocumentAttachment(obj));
        continue;
      }
      const itemText = readStringField(obj, "text");
      if (itemText) {
        const stripped = stripImagePlaceholders(itemText);
        if (stripped.placeholderCount > 0 && placeholderInsertIndex === undefined) {
          placeholderInsertIndex = attachments.length;
        }
        placeholderCount += stripped.placeholderCount;
        const extracted = extractClaudeTextAttachmentsFromText(stripped.text, claudeOptions?.role);
        texts.push(extracted.text);
        attachments.push(...extracted.attachments);
      }

      const image = await extractImageAttachmentFromItem(obj, sessionCwd, imageOptions);
      if (image) attachments.push(image);
    }
  }

  addPlaceholderImageIfNeeded(attachments, placeholderCount, placeholderInsertIndex, imageOptions.enabled ? "remote" : "disabled");

  return {
    text: texts.join(""),
    attachments,
  };
}

export function assignAttachmentIds(attachments: ChatAttachment[], scope: string): void {
  let imageIndex = 0;
  let documentIndex = 0;
  let fileIndex = 0;
  let selectionIndex = 0;
  let notificationIndex = 0;
  let invokeIndex = 0;
  for (const attachment of attachments) {
    if (!attachment || attachment.id) continue;
    if (attachment.type === "image") {
      imageIndex += 1;
      attachment.id = `${scope}-image-${imageIndex}`;
      continue;
    }
    if (attachment.type === "document") {
      documentIndex += 1;
      attachment.id = `${scope}-document-${documentIndex}`;
      continue;
    }
    if (attachment.type === "fileReference") {
      fileIndex += 1;
      attachment.id = `${scope}-file-${fileIndex}`;
      continue;
    }
    if (attachment.type === "selectionReference") {
      selectionIndex += 1;
      attachment.id = `${scope}-selection-${selectionIndex}`;
      continue;
    }
    if (attachment.type === "notification") {
      notificationIndex += 1;
      attachment.id = `${scope}-notification-${notificationIndex}`;
      continue;
    }
    if (attachment.type === "invoke") {
      invokeIndex += 1;
      attachment.id = `${scope}-invoke-${invokeIndex}`;
      continue;
    }
  }
}

export function sanitizeAttachmentForChannel(
  attachment: ChatAttachment,
  channel: AttachmentOutputChannel,
): ChatAttachment {
  if (attachment.type === "image") return sanitizeImageAttachmentForChannel(attachment, channel);
  if (attachment.type === "document") return sanitizeDocumentAttachmentForChannel(attachment, channel);
  if (attachment.type === "fileReference") return { ...attachment };
  if (attachment.type === "selectionReference") return { ...attachment };
  if (attachment.type === "notification") return sanitizeNotificationAttachmentForChannel(attachment, channel);
  if (attachment.type === "invoke") return sanitizeInvokeAttachmentForChannel(attachment, channel);
  return assertNeverChatAttachment(attachment);
}

function assertNeverChatAttachment(attachment: never): never {
  const unknownType = (attachment as { type?: unknown } | undefined)?.type;
  throw new Error(`Unsupported chat attachment type: ${String(unknownType ?? "unknown")}`);
}

function sanitizeImageAttachmentForChannel(
  attachment: ChatImageAttachment,
  channel: AttachmentOutputChannel,
): ChatImageAttachment {
  if (channel !== "webview") return { ...attachment };
  const dataOmitted = attachment.dataOmitted === true || typeof attachment.src === "string";
  return {
    ...(attachment.id ? { id: attachment.id } : {}),
    type: "image",
    status: attachment.status,
    source: attachment.source,
    ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    ...(attachment.label ? { label: attachment.label } : {}),
    ...(attachment.reason ? { reason: attachment.reason } : {}),
    ...(dataOmitted ? { dataOmitted: true } : {}),
  };
}

function sanitizeDocumentAttachmentForChannel(
  attachment: ChatDocumentAttachment,
  channel: AttachmentOutputChannel,
): ChatDocumentAttachment {
  if (channel !== "webview") return { ...attachment };
  const dataOmitted = attachment.dataOmitted === true || !!attachment.payload;
  return {
    ...(attachment.id ? { id: attachment.id } : {}),
    type: "document",
    status: attachment.status,
    documentKind: attachment.documentKind,
    source: attachment.source,
    ...(attachment.label ? { label: attachment.label } : {}),
    ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    ...(typeof attachment.byteLength === "number" ? { byteLength: attachment.byteLength } : {}),
    ...(attachment.previewText ? { previewText: attachment.previewText } : {}),
    ...(attachment.reason ? { reason: attachment.reason } : {}),
    ...(dataOmitted ? { dataOmitted: true } : {}),
  };
}

function sanitizeNotificationAttachmentForChannel(
  attachment: ChatNotificationAttachment,
  channel: AttachmentOutputChannel,
): ChatNotificationAttachment {
  const result = projectTaskNotificationResultForChannel(attachment.result, channel);
  const usage = attachment.usage ? { ...attachment.usage } : undefined;
  return {
    ...(attachment.id ? { id: attachment.id } : {}),
    type: "notification",
    source: "claudeTaskNotification",
    notificationKind: "task",
    status: attachment.status,
    ...(attachment.summary ? { summary: attachment.summary } : {}),
    ...(result ? { result } : {}),
    ...(usage ? { usage } : {}),
  };
}

function projectTaskNotificationResultForChannel(
  result: string | undefined,
  channel: AttachmentOutputChannel,
): string | undefined {
  if (!result) return undefined;
  if (channel === "webview") return clampText(result, CHAT_TASK_NOTIFICATION_RESULT_PREVIEW_CHARS);
  if (channel === "search") return clampText(result, CHAT_TASK_NOTIFICATION_RESULT_SEARCH_CHARS);
  if (channel === "resume" || channel === "handoff") return clampText(result, 1_000);
  return result;
}

function sanitizeInvokeAttachmentForChannel(
  attachment: ChatInvokeAttachment,
  channel: AttachmentOutputChannel,
): ChatInvokeAttachment {
  const parameterLimit =
    channel === "webview"
      ? CHAT_INVOKE_PARAMETER_PREVIEW_CHARS
      : channel === "search"
        ? CHAT_INVOKE_PARAMETER_SEARCH_CHARS
        : channel === "markdown"
          ? CHAT_INVOKE_PARAMETER_MARKDOWN_CHARS
          : 0;
  const parameters =
    parameterLimit > 0
      ? attachment.parameters.map((parameter) => clampInvokeParameterForChannel(parameter, parameterLimit))
      : [];
  return {
    ...(attachment.id ? { id: attachment.id } : {}),
    type: "invoke",
    source: "claudeInvokeMarkup",
    toolName: attachment.toolName,
    parameters,
    ...(attachment.description ? { description: attachment.description } : {}),
    ...(attachment.primaryParameterName && parameterLimit > 0 ? { primaryParameterName: attachment.primaryParameterName } : {}),
    ...(attachment.primaryParameterPreview && parameterLimit > 0 ? { primaryParameterPreview: attachment.primaryParameterPreview } : {}),
  };
}

function clampInvokeParameterForChannel(
  parameter: ChatInvokeParameter,
  maxChars: number,
): ChatInvokeParameter {
  const clamped = clampTextWithMetadata(parameter.value, maxChars);
  return {
    name: parameter.name,
    value: clamped.text,
    ...(clamped.truncated ? { truncated: true } : {}),
  };
}

function addPlaceholderImageIfNeeded(
  attachments: ChatAttachment[],
  placeholderCount: number,
  insertIndex: number | undefined,
  reason: ChatImageAttachmentReason,
): void {
  if (placeholderCount <= 0 || attachments.some((attachment) => attachment.type === "image")) return;
  const images: ChatImageAttachment[] = [];
  addUnavailablePlaceholderIfNeeded(images, 1, reason);
  const placeholder = images[0];
  if (!placeholder) return;
  const safeIndex =
    typeof insertIndex === "number" && Number.isFinite(insertIndex)
      ? Math.max(0, Math.min(attachments.length, Math.floor(insertIndex)))
      : attachments.length;
  attachments.splice(safeIndex, 0, placeholder);
}

export function hasClaudeAttachmentLikeContent(content: unknown): boolean {
  const items = normalizeContentItems(content);
  if (typeof content === "string") {
    return hasClaudeStructuredAttachmentTag(content) || hasClaudeIdeTag(content) || stripImagePlaceholders(content).placeholderCount > 0;
  }
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const type = normalizeType(readStringField(obj, "type"));
    if (type === "document" || isPotentialImageAttachmentItem(obj)) return true;
    const text = readStringField(obj, "text");
    if (text && (hasClaudeStructuredAttachmentTag(text) || hasClaudeIdeTag(text) || stripImagePlaceholders(text).placeholderCount > 0)) {
      return true;
    }
  }
  return false;
}

export function buildAttachmentSummaryLines(
  attachments: readonly ChatAttachment[],
  options: AttachmentSummaryOptions = {},
): string[] {
  const mode = options.mode ?? "markdown";
  const lines: string[] = [];
  for (const rawAttachment of attachments) {
    const attachment = sanitizeAttachmentForChannel(rawAttachment, mode);
    if (!attachment) continue;
    if (attachment.type === "image") {
      lines.push(formatImageSummary(attachment));
      continue;
    }
    if (attachment.type === "document") {
      lines.push(formatDocumentSummary(attachment));
      continue;
    }
    if (attachment.type === "fileReference") {
      lines.push(formatFileReferenceSummary(attachment));
      continue;
    }
    if (attachment.type === "selectionReference") {
      lines.push(formatSelectionSummary(attachment));
      continue;
    }
    if (attachment.type === "notification") {
      lines.push(...formatTaskNotificationSummary(attachment, mode));
      continue;
    }
    if (attachment.type === "invoke") {
      lines.push(...formatInvokeSummary(attachment, mode));
    }
  }
  return lines;
}

export function buildAttachmentSearchText(attachments: readonly ChatAttachment[]): string {
  const parts: string[] = [];
  for (const rawAttachment of attachments) {
    const attachment = sanitizeAttachmentForChannel(rawAttachment, "search");
    if (!attachment) continue;
    addSearchPart(parts, attachment.type);
    if (attachment.type === "image") {
      addSearchPart(parts, attachment.label);
      addSearchPart(parts, attachment.mimeType);
      continue;
    }
    if (attachment.type === "document") {
      addSearchPart(parts, attachment.label);
      addSearchPart(parts, attachment.mimeType);
      addSearchPart(parts, attachment.documentKind);
      if (attachment.documentKind === "text") {
        const textPayload = attachment.payload?.kind === "text" ? attachment.payload.text : attachment.previewText;
        addSearchPart(parts, textPayload, CHAT_TEXT_DOCUMENT_SEARCH_CHARS);
      }
      continue;
    }
    if (attachment.type === "fileReference") {
      addSearchPart(parts, attachment.label);
      addSearchPart(parts, attachment.path, CHAT_ATTACHMENT_PATH_SEARCH_CHARS);
      addSearchPart(parts, attachment.fileKind);
      continue;
    }
    if (attachment.type === "selectionReference") {
      addSearchPart(parts, attachment.label);
      addSearchPart(parts, attachment.path, CHAT_ATTACHMENT_PATH_SEARCH_CHARS);
      addSearchPart(parts, "selection");
      continue;
    }
    if (attachment.type === "notification") {
      addSearchPart(parts, "task notification");
      addSearchPart(parts, attachment.status);
      addSearchPart(parts, attachment.summary);
      addSearchPart(parts, attachment.result, CHAT_TASK_NOTIFICATION_RESULT_SEARCH_CHARS);
      continue;
    }
    if (attachment.type === "invoke") {
      addSearchPart(parts, "tool invocation");
      addSearchPart(parts, attachment.toolName);
      addSearchPart(parts, attachment.description);
      for (const parameter of attachment.parameters) {
        addSearchPart(parts, parameter.name);
        addSearchPart(parts, parameter.value, CHAT_INVOKE_PARAMETER_SEARCH_CHARS);
      }
    }
  }
  return parts.join("\n");
}

export function extractCodexFilesMentionedFromText(text: string): ExtractedMessageContent {
  const normalized = normalizeNewlines(text);
  const header = findCodexFilesMentionedHeader(normalized);
  if (!header) return { text, attachments: [] };

  const prefix = normalized.slice(0, header.start);
  const rest = normalized.slice(header.end);
  const requestMatch = /(?:^|\n)## My request for Codex:\s*(?:\n|$)/u.exec(rest);
  if (requestMatch) {
    const block = rest.slice(0, requestMatch.index);
    const parsed = parseCodexFileReferenceLines(block);
    if (parsed.attachments.length === 0 || parsed.failed) return { text, attachments: [] };
    if (prefix.trim().length > 0) {
      return {
        text: joinCodexTextAroundFilesBlock(prefix, rest.slice(requestMatch.index + requestMatch[0].length)),
        attachments: parsed.attachments,
      };
    }
    return {
      text: rest.slice(requestMatch.index + requestMatch[0].length),
      attachments: parsed.attachments,
    };
  }

  const parsed = parseCodexFileReferencePrefix(rest);
  if (parsed.attachments.length === 0 || parsed.failed) return { text, attachments: [] };
  return {
    text: joinCodexTextAroundFilesBlock(prefix, parsed.remainingText),
    attachments: parsed.attachments,
  };
}

function findCodexFilesMentionedHeader(text: string): { start: number; end: number } | null {
  const match = /(^|\n)[ \t]*# Files mentioned by the user:[ \t]*(?:\n|$)/u.exec(text);
  if (!match) return null;
  const leadingNewline = match[1] ?? "";
  return {
    start: match.index + leadingNewline.length,
    end: match.index + match[0].length,
  };
}

function joinCodexTextAroundFilesBlock(prefix: string, suffix: string): string {
  const cleanPrefix = prefix.replace(/\n+$/u, "");
  const cleanSuffix = suffix.replace(/^\n+/u, "");
  if (!cleanPrefix.trim()) return cleanSuffix;
  if (!cleanSuffix.trim()) return cleanPrefix;
  return `${cleanPrefix}\n\n${cleanSuffix}`;
}

function parseCodexFileReferencePrefix(text: string): {
  attachments: ChatFileReferenceAttachment[];
  remainingText: string;
  failed: boolean;
} {
  const lines = text.split("\n");
  const blockLines: string[] = [];
  let index = 0;
  let sawFile = false;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      blockLines.push(line);
      index += 1;
      continue;
    }
    if (!line.trimStart().startsWith("## ")) break;
    if (!parseCodexFileReferenceLine(line)) {
      return { attachments: [], remainingText: text, failed: true };
    }
    sawFile = true;
    blockLines.push(line);
    index += 1;
  }

  if (!sawFile) return { attachments: [], remainingText: text, failed: true };
  const parsed = parseCodexFileReferenceLines(blockLines.join("\n"));
  if (parsed.failed) return { attachments: [], remainingText: text, failed: true };
  return {
    attachments: parsed.attachments,
    remainingText: lines.slice(index).join("\n").replace(/^\n+/u, ""),
    failed: false,
  };
}

function parseCodexFileReferenceLines(text: string): { attachments: ChatFileReferenceAttachment[]; failed: boolean } {
  const attachments: ChatFileReferenceAttachment[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parsed = parseCodexFileReferenceLine(line);
    if (!parsed) return { attachments: [], failed: true };
    attachments.push(parsed);
  }
  return { attachments, failed: false };
}

function parseCodexFileReferenceLine(line: string): ChatFileReferenceAttachment | null {
  const text = line.trim();
  if (!text.startsWith("## ")) return null;
  const body = text.slice(3).trim();
  const separator = body.indexOf(": ");
  if (separator <= 0) return null;

  const label = body.slice(0, separator).trim();
  const rawPath = body.slice(separator + 2).trim();
  if (!label || !rawPath) return null;

  const lineInfo = parseLineSuffix(rawPath);
  const fsPath = lineInfo.text.trim();
  if (!fsPath) return null;

  return {
    type: "fileReference",
    source: "codexFilesMentioned",
    label,
    path: fsPath,
    ...(lineInfo.line ? { line: lineInfo.line } : {}),
    ...(lineInfo.endLine ? { endLine: lineInfo.endLine } : {}),
    fileKind: inferFileKind(fsPath, label),
  };
}

function buildClaudeOpenedFileAttachment(body: string): ChatFileReferenceAttachment {
  const pathText = extractClaudeOpenedFilePath(body) ?? extractPathLikeText(body);
  return {
    type: "fileReference",
    source: "claudeIdeOpenedFile",
    label: pathText ? path.basename(pathText) || pathText : DEFAULT_FILE_REFERENCE_LABEL,
    ...(pathText ? { path: pathText, fileKind: inferFileKind(pathText) } : { fileKind: "generic" as ChatFileKind }),
  };
}

function buildClaudeSelectionAttachment(body: string): ChatSelectionReferenceAttachment {
  const text = normalizeNewlines(body).trim();
  const lineMatch = /\blines?\s+(\d+)(?:\s*(?:to|-)\s*(\d+))?/iu.exec(text);
  const pathAndPreview = extractSelectionPathAndPreview(text);
  const pathText = pathAndPreview.path ?? extractPathLikeText(text);
  const previewText = clampText(pathAndPreview.previewText ?? "", CHAT_SELECTION_PREVIEW_CHARS);
  return {
    type: "selectionReference",
    source: "claudeIdeSelection",
    label: pathText ? path.basename(pathText) || pathText : "Selection",
    ...(pathText ? { path: pathText } : {}),
    ...(lineMatch?.[1] ? { line: Number(lineMatch[1]) } : {}),
    ...(lineMatch?.[2] ? { endLine: Number(lineMatch[2]) } : {}),
    ...(previewText ? { previewText } : {}),
  };
}

function extractSelectionPathAndPreview(text: string): { path?: string; previewText?: string } {
  const lower = text.toLowerCase();
  const fromIndex = lower.lastIndexOf(" from ");
  if (fromIndex < 0) return {};

  const afterFrom = text.slice(fromIndex + " from ".length);
  const separator = afterFrom.search(/:\s*(?:\n|$)/u);
  if (separator < 0) {
    const pathText = extractPathLikeText(afterFrom);
    return pathText ? { path: pathText } : {};
  }

  const rawPath = afterFrom.slice(0, separator).trim();
  const previewText = afterFrom.slice(separator + 1).trim();
  return {
    ...(rawPath ? { path: sanitizeClaudeIdePath(rawPath) } : {}),
    ...(previewText ? { previewText } : {}),
  };
}

function extractClaudeOpenedFilePath(body: string): string | undefined {
  const text = normalizeNewlines(body).trim();
  const match = /\bopened the file\s+([\s\S]+?)\s+in the IDE\b/iu.exec(text);
  return match?.[1] ? sanitizeClaudeIdePath(match[1]) : undefined;
}

function extractClaudeDocumentAttachment(item: Record<string, unknown>): ChatDocumentAttachment {
  const source = readObjectField(item, "source");
  const sourceType = normalizeType(readStringField(source, "type"));
  const label = readStringField(item, "title") || readStringField(item, "name") || readStringField(item, "file_name");
  const mimeType = normalizeMimeType(
    readStringField(item, "media_type") ||
      readStringField(item, "mime_type") ||
      readStringField(source, "media_type") ||
      readStringField(source, "mime_type"),
  );
  const documentKind = inferDocumentKind(mimeType, label);
  const safeLabel = label || defaultDocumentLabel(documentKind);

  if (sourceType === "text") {
    const text = readStringField(source, "data") || readStringField(source, "text") || "";
    if (!text) {
      return createUnavailableDocument({ documentKind, source: "embeddedText", label: safeLabel, mimeType, reason: "invalid" });
    }
    const byteLength = Buffer.byteLength(text, "utf8");
    const previewText = clampText(text, CHAT_TEXT_DOCUMENT_PREVIEW_CHARS);
    if (byteLength > CHAT_TEXT_DOCUMENT_SAVE_BYTES) {
      return {
        type: "document",
        status: "unavailable",
        documentKind: "text",
        source: "embeddedText",
        label: safeLabel,
        mimeType: mimeType ?? "text/plain",
        byteLength,
        previewText,
        reason: "tooLarge",
      };
    }
    return {
      type: "document",
      status: "available",
      documentKind: "text",
      source: "embeddedText",
      label: safeLabel,
      mimeType: mimeType ?? "text/plain",
      byteLength,
      previewText,
      dataOmitted: true,
      payload: { kind: "text", text },
    };
  }

  if (sourceType === "base64") {
    const data = readStringField(source, "data") || "";
    if (!data || !mimeType) {
      return createUnavailableDocument({ documentKind, source: "embeddedBase64", label: safeLabel, mimeType, reason: "invalid" });
    }
    const byteLength = estimateBase64Bytes(data);
    if (byteLength > CHAT_EMBEDDED_BASE64_DOCUMENT_BYTES) {
      return createUnavailableDocument({
        documentKind,
        source: "embeddedBase64",
        label: safeLabel,
        mimeType,
        byteLength,
        reason: "tooLarge",
      });
    }
    return {
      type: "document",
      status: "available",
      documentKind,
      source: "embeddedBase64",
      label: safeLabel,
      mimeType,
      byteLength,
      dataOmitted: true,
      payload: { kind: "base64", data },
    };
  }

  return createUnavailableDocument({
    documentKind,
    source: "reference",
    label: safeLabel,
    mimeType,
    reason: sourceType ? "unsupported" : "invalid",
  });
}

function createUnavailableDocument(params: {
  documentKind: ChatDocumentKind;
  source: ChatDocumentAttachment["source"];
  label: string;
  mimeType?: string;
  byteLength?: number;
  reason: NonNullable<ChatDocumentAttachment["reason"]>;
}): ChatDocumentAttachment {
  return {
    type: "document",
    status: "unavailable",
    documentKind: params.documentKind,
    source: params.source,
    label: params.label,
    ...(params.mimeType ? { mimeType: params.mimeType } : {}),
    ...(typeof params.byteLength === "number" ? { byteLength: params.byteLength } : {}),
    reason: params.reason,
  };
}

function formatImageSummary(image: ChatImageAttachment): string {
  const label = image.label || "Image attachment";
  const meta = [image.mimeType, image.status === "unavailable" ? image.reason : ""].filter(Boolean).join(", ");
  return `- Image attachment: ${formatMarkdownCodeSpan(label)}${meta ? ` (${meta})` : ""}`;
}

function formatDocumentSummary(document: ChatDocumentAttachment): string {
  const label = document.label || defaultDocumentLabel(document.documentKind);
  const meta = [document.mimeType, document.documentKind, document.status === "unavailable" ? document.reason : ""]
    .filter(Boolean)
    .join(", ");
  return `- Attached file: ${formatMarkdownCodeSpan(label)}${meta ? ` (${meta})` : ""}`;
}

function formatFileReferenceSummary(reference: ChatFileReferenceAttachment): string {
  const label = reference.source === "claudeIdeOpenedFile" ? "Opened file" : "File reference";
  const target = reference.path || reference.label || DEFAULT_FILE_REFERENCE_LABEL;
  const location = formatLineRange(reference.line, reference.endLine);
  return `- ${label}: ${formatMarkdownCodeSpan(target)}${location ? ` (${location})` : ""}`;
}

function formatSelectionSummary(selection: ChatSelectionReferenceAttachment): string {
  const target = selection.path || selection.label || "Selection";
  const location = formatLineRange(selection.line, selection.endLine);
  return `- Selection reference: ${formatMarkdownCodeSpan(target)}${location ? ` (${location})` : ""}`;
}

function formatTaskNotificationSummary(notification: ChatNotificationAttachment, mode: AttachmentSummaryOptions["mode"]): string[] {
  const lines: string[] = [];
  const headerParts = ["Task notification", notification.status];
  if (notification.summary) headerParts.push(notification.summary);
  lines.push(`- ${headerParts.filter(Boolean).join(": ")}`);
  const usageText = formatTaskNotificationUsageText(notification.usage);
  if (usageText && mode === "markdown") lines.push(`  - Usage: ${usageText}`);
  if (notification.result) {
    const limit = mode === "markdown" ? CHAT_TASK_NOTIFICATION_RESULT_MARKDOWN_CHARS : 1_000;
    lines.push(`  - Result: ${formatClampedTextForSummary(notification.result, limit)}`);
  }
  return lines;
}

function formatInvokeSummary(invoke: ChatInvokeAttachment, mode: AttachmentSummaryOptions["mode"]): string[] {
  const lines: string[] = [`- Tool invocation: ${formatMarkdownCodeSpan(invoke.toolName)}`];
  if (invoke.description) lines.push(`  - Description: ${invoke.description}`);
  if (mode === "resume" || mode === "handoff") return lines;
  for (const parameter of invoke.parameters) {
    const value = formatClampedTextForSummary(parameter.value, CHAT_INVOKE_PARAMETER_MARKDOWN_CHARS);
    lines.push(`  - ${parameter.name}: ${value}`);
  }
  return lines;
}

function formatMarkdownCodeSpan(value: string): string {
  const text = normalizeNewlines(value).replace(/\s+/g, " ").trim();
  if (!text) return "``";
  const tickRuns = text.match(/`+/gu) ?? [];
  const longestRun = tickRuns.reduce((max, run) => Math.max(max, run.length), 0);
  const delimiter = "`".repeat(longestRun + 1);
  const needsPadding = text.startsWith("`") || text.endsWith("`");
  const body = needsPadding ? ` ${text} ` : text;
  return `${delimiter}${body}${delimiter}`;
}

function formatLineRange(line: number | undefined, endLine: number | undefined): string {
  if (typeof line !== "number" || !Number.isFinite(line)) return "";
  if (typeof endLine === "number" && Number.isFinite(endLine) && endLine > line) return `lines ${line}-${endLine}`;
  return `line ${line}`;
}

function addSearchPart(parts: string[], value: unknown, maxChars = CHAT_ATTACHMENT_LABEL_SEARCH_CHARS): void {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return;
  parts.push(clampText(text, maxChars));
}

function parseLineSuffix(value: string): { text: string; line?: number; endLine?: number } {
  const match = /^(.*)\s+\((?:lines?|line)\s+(\d+)(?:\s*(?:-|to)\s*(\d+))?\)\s*$/iu.exec(value.trim());
  if (!match) return { text: value };
  const line = Number(match[2]);
  const endLine = match[3] ? Number(match[3]) : undefined;
  return {
    text: match[1] ?? value,
    ...(Number.isFinite(line) && line >= 1 ? { line: Math.floor(line) } : {}),
    ...(Number.isFinite(endLine) && endLine !== undefined && endLine >= 1 ? { endLine: Math.floor(endLine) } : {}),
  };
}

function inferDocumentKind(mimeType: string | undefined, label: string | undefined): ChatDocumentKind {
  const mime = String(mimeType ?? "").toLowerCase();
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("text/") || isTextLikeMimeType(mime)) return "text";
  const kind = inferFileKind(label ?? "");
  if (kind === "pdf") return "pdf";
  if (kind === "text" || kind === "code") return "text";
  return "generic";
}

export function inferFileKind(fsPath: string, fallbackLabel?: string): ChatFileKind {
  const ext = path.extname(String(fsPath || fallbackLabel || "").trim()).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".doc" || ext === ".docx" || ext === ".docm" || ext === ".rtf") return "word";
  if (ext === ".xls" || ext === ".xlsx" || ext === ".xlsm") return "excel";
  if (ext === ".ppt" || ext === ".pptx" || ext === ".pptm") return "powerpoint";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (ARCHIVE_EXTENSIONS.has(ext)) return "archive";
  if (CODE_EXTENSIONS.has(ext)) return "code";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  if (isWellKnownTextFileName(fsPath) || isWellKnownTextFileName(fallbackLabel)) return "text";
  return "generic";
}

function isWellKnownTextFileName(value: string | undefined): boolean {
  const base = path.basename(String(value ?? "").trim()).toLowerCase();
  return (
    base === "license" ||
    base === "readme" ||
    base === "changelog" ||
    base === "authors" ||
    base === "contributors" ||
    base === "copying"
  );
}

function defaultDocumentLabel(documentKind: ChatDocumentKind): string {
  if (documentKind === "pdf") return "PDF document";
  if (documentKind === "text") return "Text document";
  return DEFAULT_DOCUMENT_LABEL;
}

function isTextLikeMimeType(mimeType: string): boolean {
  return (
    mimeType === "application/json" ||
    mimeType === "application/xml" ||
    mimeType === "application/yaml" ||
    mimeType === "application/x-yaml" ||
    mimeType.endsWith("+json") ||
    mimeType.endsWith("+xml")
  );
}

function extractPathLikeText(value: string): string | undefined {
  const text = sanitizeClaudeIdePath(value);
  if (!text) return undefined;
  const windows = /[A-Za-z]:[\\/][^\r\n<>"]+/u.exec(text);
  if (windows) return trimPathPunctuation(windows[0]);
  const unc = /\\\\[^\r\n<>"]+/u.exec(text);
  if (unc) return trimPathPunctuation(unc[0]);
  const unix = /(?:^|\s)(\/[^\r\n<>"]+)/u.exec(text);
  if (unix?.[1]) return trimPathPunctuation(unix[1]);

  const firstLine = text.split("\n")[0]?.trim() ?? "";
  if (firstLine && !/\s/u.test(firstLine)) return trimPathPunctuation(firstLine);
  return undefined;
}

function sanitizeClaudeIdePath(value: string): string {
  const text = normalizeNewlines(value)
    .trim()
    .replace(/-\s*\n\s*/gu, "-")
    .replace(/\s*\n\s*/gu, "")
    .replace(/\s+in the IDE\.?(?:\s+This may or may not be related to the current task\.?)?$/iu, "")
    .replace(/\s+This may or may not be related to the current task\.?$/iu, "")
    .trim();
  return trimPathPunctuation(text);
}

function trimPathPunctuation(value: string): string {
  return value.trim().replace(/[)\].,;:]+$/u, "").trim();
}

function hasClaudeIdeTag(value: string): boolean {
  return /<ide_(?:opened_file|selection)>/iu.test(value);
}

function hasClaudeStructuredAttachmentTag(value: string): boolean {
  if (hasTaskNotificationStructuredAttachmentTag(value)) return true;
  return /<invoke\s+name=(["']).+?\1\s*>[\s\S]*?<\/invoke>/iu.test(value);
}

function hasTaskNotificationStructuredAttachmentTag(value: string): boolean {
  let searchIndex = 0;
  while (searchIndex < value.length) {
    const openIndex = value.indexOf(TASK_NOTIFICATION_OPEN_TAG, searchIndex);
    if (openIndex < 0) return false;
    const open = matchTaskNotificationOpenTag(value, openIndex);
    if (open && value.indexOf(TASK_NOTIFICATION_CLOSE_TAG, open.openEnd) >= 0) return true;
    searchIndex = openIndex + 1;
  }
  return false;
}

function hasTextCandidate(content: unknown, needle: string): boolean {
  if (typeof content === "string") return content.includes(needle);
  for (const item of normalizeContentItems(content)) {
    if (!item || typeof item !== "object") continue;
    const text = readStringField(item as Record<string, unknown>, "text");
    if (text?.includes(needle)) return true;
  }
  return false;
}

function normalizeImageOptions(options?: ChatImageExtractionOptions): Required<ChatImageExtractionOptions> {
  return {
    enabled: options?.enabled ?? true,
    maxBytes: typeof options?.maxBytes === "number" && Number.isFinite(options.maxBytes) ? options.maxBytes : 20 * 1024 * 1024,
  };
}

function normalizeContentItems(content: unknown): unknown[] {
  return Array.isArray(content) ? content : content && typeof content === "object" ? [content] : [];
}

function normalizeNewlines(value: string): string {
  return String(value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function clampText(value: string, maxChars: number): string {
  const text = String(value ?? "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function clampTextWithMetadata(value: string, maxChars: number): { text: string; truncated: boolean; originalLength: number } {
  const text = String(value ?? "");
  if (text.length <= maxChars) return { text, truncated: false, originalLength: text.length };
  return {
    text: `${text.slice(0, Math.max(0, maxChars - 3))}...`,
    truncated: true,
    originalLength: text.length,
  };
}

function formatClampedTextForSummary(value: string, maxChars: number): string {
  const clamped = clampTextWithMetadata(value, maxChars);
  if (!clamped.truncated) return clamped.text;
  return `${clamped.text} [truncated from ${clamped.originalLength} chars]`;
}

function estimateBase64Bytes(payload: string): number {
  const compact = payload.replace(/\s/g, "");
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

function normalizeType(value: string | undefined): string {
  return value?.trim().toLowerCase().replace(/[_-]/g, "") ?? "";
}

function normalizeMimeType(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  return normalized;
}

function readObjectField(item: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  const value = item?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readStringField(item: Record<string, unknown> | null, key: string): string | undefined {
  const value = item?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}
