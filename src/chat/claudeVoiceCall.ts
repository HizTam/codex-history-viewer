import { createHash } from "node:crypto";
import { detectClaudeMaterializedMessageRole, extractClaudeLocalCommandOutputContent, extractClaudeMessageContent,
  extractClaudeRequestInterruptionContent } from "./chatAttachments";
import { extractClaudeTerminalOutput } from "./claudeTerminalOutput";
import { isClaudeInternalUserRecord } from "./claudeTaskNotification";
import { extractClaudeCompactUserText, isClaudeHumanTurnStart } from "./claudeCompactSummary";

const MAX_INPUT_CHARS = 1_048_576;
const MAX_BLOCKS = 128;
const MAX_LEGACY_NODES = 4_096;
const MAX_LEGACY_DEPTH = 32;
export const CLAUDE_VOICE_CALL_BODY_CHARS = 64_000;
const HEADER = "[TALK FROM A VOICE CALL - NOT USER INPUT]";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface ClaudeVoiceCall {
  voiceCallId: string;
  body: string;
  timestampIso?: string;
  truncated?: true;
  invalidContent?: true;
}

export interface ClaudeVoiceCallLegacyPresentation {
  messageIncrement: 0 | 1;
  itemCount: 0 | 1;
  controlEvent: boolean;
  changesTurn?: true;
  startsTurn?: true;
  mayResumeTurn?: true;
  legacyTimestampIso?: string;
  ambiguous: boolean;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Provenance is independent of body validation, so malformed voice cannot become an instruction.
export function isClaudeVoiceCallRecord(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.type === "system" && value.subtype === "voice_call_talk" ||
    value.type === "user" && isRecord(value.origin) && value.origin.kind === "voice-call" ||
    value.type === "attachment" && isRecord(value.attachment) && value.attachment.type === "queued_command" &&
      isRecord(value.attachment.origin) && value.attachment.origin.kind === "voice-call";
}

export function isClaudeVoiceCallId(value: unknown): value is string {
  return typeof value === "string" && /^cv-[a-f0-9]{32}$/u.test(value);
}

// Only validated text is projected; blocks, fold, correlation identifiers and audio never leave here.
export function projectClaudeVoiceCall(value: unknown, lineIndex: number): ClaudeVoiceCall | undefined {
  if (!isClaudeVoiceCallRecord(value)) return undefined;
  const record = value as Record<string, any>;
  const line = Number.isSafeInteger(lineIndex) && lineIndex >= 0 ? lineIndex : 0;
  const uuid = typeof record.uuid === "string" && UUID.test(record.uuid) ? record.uuid.toLowerCase() : "";
  const voiceCallId = `cv-${createHash("sha256").update(`${uuid}:line:${line}`, "utf8").digest("hex").slice(0, 32)}`;
  const timestampIso = readTimestamp(record.timestamp);
  const base: ClaudeVoiceCall = { voiceCallId, body: "", ...(timestampIso ? { timestampIso } : {}) };
  if (!validQueuedMetadata(record)) return { ...base, invalidContent: true };
  let text: string | undefined;
  if (record.type === "system") {
    if (record.msgV === 1 && record.isMeta === true && validOrigin(record.origin) &&
        typeof record.content === "string" && record.content.length <= MAX_INPUT_CHARS &&
        (record.fold === undefined || isRecord(record.fold) && isRecord(record.fold.command) && validQueuedMetadata(record.fold.command)) &&
        record.forwardedIntent == null) {
      text = record.content;
      if (record.blocks !== undefined && (!Array.isArray(record.blocks) || readText(record.blocks) !== text)) text = undefined;
    }
  } else if (record.type === "user") {
    if (record.isMeta === true && validOrigin(record.origin) && isRecord(record.message) &&
        (record.message.role === undefined || record.message.role === "user") && record.forwardedIntent == null &&
        record.toolUseResult === undefined) text = readText(record.message.content);
  } else {
    const attachment = record.attachment;
    if (isRecord(attachment) && validOrigin(attachment.origin) && validQueuedMetadata(attachment) &&
        (record.isMeta === undefined || record.isMeta === true) && record.forwardedIntent == null) text = readText(attachment.prompt);
  }
  if (text === undefined) return { ...base, invalidContent: true };
  text = text.replace(/\r\n?/gu, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").trim();
  if (text.startsWith(HEADER + "\n")) text = text.slice(HEADER.length + 1).trim();
  else if (text === HEADER) text = "";
  if (!text) return { ...base, invalidContent: true };
  let body = text.slice(0, CLAUDE_VOICE_CALL_BODY_CHARS);
  if (/[\uD800-\uDBFF]$/u.test(body)) body = body.slice(0, -1);
  return { ...base, body, ...(body.length < text.length ? { truncated: true } : {}) };
}

// Reuse the old control precedence solely for anchor compatibility, never for executing voice content.
export async function readClaudeVoiceCallLegacyPresentation(value: unknown): Promise<ClaudeVoiceCallLegacyPresentation> {
  const empty: ClaudeVoiceCallLegacyPresentation = { messageIncrement: 0, itemCount: 0, controlEvent: false, ambiguous: false };
  if (!isClaudeVoiceCallRecord(value)) return empty;
  const record = value as Record<string, any>;
  const role = detectClaudeMaterializedMessageRole(record);
  if (!role) return empty;
  const base = { ...empty, legacyTimestampIso: readLegacyTimestamp(record) };
  const content = isRecord(record.message) && "content" in record.message ? record.message.content : record.content;
  const textOnly = isPureTextContent(content);
  // Inspect every nested payload before legacy extractors can decode or measure an attachment.
  if (!hasLegacyContentBudget(content, textOnly)) return { ...base, ambiguous: true };
  const ambiguous = !textOnly || record.toolUseResult !== undefined || role !== "user";
  if (isClaudeInternalUserRecord(record)) return { ...base, messageIncrement: 1, itemCount: 1, ambiguous };
  if (role === "user" && extractClaudeRequestInterruptionContent(content, record))
    return { ...base, itemCount: 1, controlEvent: true, changesTurn: true, ambiguous };
  if (role === "user" && extractClaudeLocalCommandOutputContent(content))
    return { ...base, itemCount: 1, controlEvent: true, ambiguous };
  if (extractClaudeTerminalOutput(record, content)) return { ...base, messageIncrement: 1, itemCount: 1, controlEvent: true, ambiguous };
  const extracted = await extractClaudeMessageContent(content, undefined, { enabled: false }, { role, record });
  const visible = !!extracted.text.trim() || extracted.attachments.length > 0;
  const turnEligible = role === "user" && record.isSidechain !== true;
  const hasToolResults = (Array.isArray(content) ? content : [content]).some(block => isRecord(block) && block.type === "tool_result");
  const startsTurn = role === "user" && isClaudeHumanTurnStart(record,
    extractClaudeCompactUserText(record, extracted.text.replace(/\r\n?/gu, "\n").trim()), extracted.attachments, hasToolResults);
  const mayResumeTurn = turnEligible && extracted.attachments.some(attachment => attachment.type === "notification");
  return { ...base, messageIncrement: visible ? 1 : 0, itemCount: visible ? 1 : 0, ambiguous,
    ...(startsTurn ? { startsTurn: true } : {}), ...(mayResumeTurn ? { mayResumeTurn: true } : {}) };
}

function readLegacyTimestamp(record: Record<string, any>): string {
  // Match the pre-voice type precedence, including an explicitly empty top-level string.
  return (typeof record.timestamp === "string" ? record.timestamp :
    typeof record.payload?.timestamp === "string" ? record.payload.timestamp :
    typeof record.message?.timestamp === "string" ? record.message.timestamp : "").trim();
}

function isPureTextContent(content: unknown): boolean {
  if (typeof content === "string") return true;
  return Array.isArray(content) && content.length <= MAX_BLOCKS && content.every(block => {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return false;
    for (const key in block) if (Object.prototype.hasOwnProperty.call(block, key) && key !== "type" && key !== "text") return false;
    return true;
  });
}

function hasLegacyContentBudget(content: unknown, textOnly: boolean): boolean {
  if (Array.isArray(content) && content.length > MAX_BLOCKS) return false;
  if (textOnly) return readText(content) !== undefined;
  const pending = [{ value: content, depth: 0 }];
  const seen = new Set<object>();
  let count = 1, chars = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (depth > MAX_LEGACY_DEPTH) return false;
    if (typeof value === "string") {
      chars += value.length;
      if (chars > MAX_INPUT_CHARS) return false;
    } else if (value !== null && typeof value === "object") {
      if (seen.has(value)) return false;
      seen.add(value);
      for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        if (++count > MAX_LEGACY_NODES) return false;
        pending.push({ value: (value as Record<string, unknown>)[key], depth: depth + 1 });
      }
    }
  }
  return true;
}

function readText(value: unknown): string | undefined {
  if (typeof value === "string") return value.length <= MAX_INPUT_CHARS ? value : undefined;
  if (!Array.isArray(value) || value.length > MAX_BLOCKS) return undefined;
  const parts: string[] = [];
  let size = 0;
  for (const block of value) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return undefined;
    size += block.text.length + (parts.length ? 1 : 0);
    if (size > MAX_INPUT_CHARS) return undefined;
    parts.push(block.text);
  }
  return parts.join("\n");
}

function validOrigin(value: unknown): boolean {
  if (!isRecord(value) || value.kind !== "voice-call") return false;
  for (const key of ["requestUuid", "inReplyToUuid"]) if (value[key] !== undefined && (typeof value[key] !== "string" || !UUID.test(value[key]))) return false;
  return value.saidAt === undefined || readTimestamp(value.saidAt) !== undefined;
}

function validQueuedMetadata(value: Record<string, any>): boolean {
  return (value.isMeta === undefined || value.isMeta === true) && (value.humanTurn === undefined || value.humanTurn === false) &&
    (value.commandMode === undefined || value.commandMode === "prompt") && value.forwardedIntent == null;
}

function readTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value)) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  const normalized = new Date(ms).toISOString();
  return normalized.slice(0, 19) === value.slice(0, 19) ? normalized : undefined;
}
