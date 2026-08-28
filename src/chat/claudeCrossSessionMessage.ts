import { detectClaudeMaterializedMessageRole } from "./chatAttachments";

export const CLAUDE_CROSS_SESSION_BODY_MAX_CHARS = 120_000;
export const CLAUDE_CROSS_SESSION_DISPLAY_CHARS = 64_000;
export const CLAUDE_CROSS_SESSION_SEARCH_CHARS = 64_000;

const CLAUDE_CROSS_SESSION_CONTENT_SCAN_CHARS = 256_000;
const CLAUDE_CROSS_SESSION_OPEN_TAG_CHARS = 1_024;
const CLAUDE_CROSS_SESSION_SENDER_NAME_CHARS = 128;
const CROSS_SESSION_CLOSE_TAG = "</cross-session-message>";
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
const UNSAFE_LABEL_CONTROLS = /[\u0000-\u001f\u007f]/gu;

export type ClaudeCrossSessionProvenance = "peer" | "coordinator";

export interface ClaudeCrossSessionMessage {
  provenance: ClaudeCrossSessionProvenance;
  body: string;
  senderName?: string;
}

export interface ProjectedClaudeCrossSessionBody {
  body: string;
  truncated: boolean;
}

export function isClaudeCrossSessionInboundRecord(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;
  if ((obj as { isMeta?: unknown }).isMeta !== true) return false;
  if (detectClaudeMaterializedMessageRole(obj) !== "user") return false;

  const origin = readOrigin(obj);
  if (!origin) return false;
  if (origin.kind === "peer") return true;
  return origin.kind === "task-notification" && origin.subkind === "peer-send-message";
}

export function extractClaudeCrossSessionMessage(obj: unknown): ClaudeCrossSessionMessage | null {
  if (!isClaudeCrossSessionInboundRecord(obj)) return null;

  const origin = readOrigin(obj);
  if (!origin) return null;
  const provenance: ClaudeCrossSessionProvenance = origin.kind === "peer" ? "peer" : "coordinator";
  const content = readBoundedTextContent(readClaudeMessageContent(obj));
  if (content === null) return null;

  const normalizedContent = normalizeCrossSessionText(content);
  const wrapperBody = extractWrappedBody(normalizedContent);
  const hasOriginBody = Object.prototype.hasOwnProperty.call(origin, "body");
  let body: string | null = null;

  if (hasOriginBody) {
    if (typeof origin.body !== "string") return null;
    const normalizedOriginBody = normalizeCrossSessionText(origin.body);
    if (!isValidBody(normalizedOriginBody)) return null;
    if (wrapperBody !== null && wrapperBody !== normalizedOriginBody) return null;
    if (wrapperBody === null && !normalizedContent.includes(normalizedOriginBody)) return null;
    body = normalizedOriginBody;
  } else {
    body = wrapperBody;
  }

  if (body === null || !isValidBody(body)) return null;
  const senderName = normalizeSenderName(origin.name);
  return {
    provenance,
    body,
    ...(senderName ? { senderName } : {}),
  };
}

export function projectClaudeCrossSessionBody(
  body: string,
  maxChars = CLAUDE_CROSS_SESSION_DISPLAY_CHARS,
): ProjectedClaudeCrossSessionBody {
  const safeLimit =
    Number.isSafeInteger(maxChars) && maxChars > 0
      ? Math.min(maxChars, CLAUDE_CROSS_SESSION_BODY_MAX_CHARS)
      : CLAUDE_CROSS_SESSION_DISPLAY_CHARS;
  if (body.length <= safeLimit) return { body, truncated: false };
  return {
    body: body.slice(0, safeLimit),
    truncated: true,
  };
}

function readOrigin(obj: unknown): Record<string, unknown> | null {
  if (!obj || typeof obj !== "object") return null;
  const origin = (obj as { origin?: unknown }).origin;
  if (!origin || typeof origin !== "object" || Array.isArray(origin)) return null;
  return origin as Record<string, unknown>;
}

function readClaudeMessageContent(obj: unknown): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  const message = (obj as { message?: unknown }).message;
  if (message && typeof message === "object" && "content" in message) {
    return (message as { content?: unknown }).content;
  }
  return "content" in obj ? (obj as { content?: unknown }).content : undefined;
}

function readBoundedTextContent(content: unknown): string | null {
  if (typeof content === "string") {
    return content.length <= CLAUDE_CROSS_SESSION_CONTENT_SCAN_CHARS ? content : null;
  }
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  let totalChars = 0;
  for (const item of content) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const type = (item as { type?: unknown }).type;
    const text = (item as { text?: unknown }).text;
    if (type !== "text" || typeof text !== "string") return null;
    totalChars += text.length;
    if (totalChars > CLAUDE_CROSS_SESSION_CONTENT_SCAN_CHARS) return null;
    parts.push(text);
  }
  return parts.join("\n");
}

function extractWrappedBody(content: string): string | null {
  const openPattern = new RegExp(
    `<cross-session-message\\b[^>\\r\\n]{0,${CLAUDE_CROSS_SESSION_OPEN_TAG_CHARS}}>`,
    "iu",
  );
  const openMatch = openPattern.exec(content);
  if (!openMatch) return null;

  const bodyStart = openMatch.index + openMatch[0].length;
  const closeIndex = content.lastIndexOf(CROSS_SESSION_CLOSE_TAG);
  if (closeIndex < bodyStart) return null;
  let body = content.slice(bodyStart, closeIndex);
  if (body.startsWith("\n")) body = body.slice(1);
  if (body.endsWith("\n")) body = body.slice(0, -1);
  return normalizeCrossSessionText(body);
}

function normalizeCrossSessionText(value: string): string {
  return value.replace(/\r\n?/gu, "\n").replace(UNSAFE_TEXT_CONTROLS, "");
}

function isValidBody(body: string): boolean {
  return body.trim().length > 0 && body.length <= CLAUDE_CROSS_SESSION_BODY_MAX_CHARS;
}

function normalizeSenderName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(UNSAFE_LABEL_CONTROLS, " ").replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > CLAUDE_CROSS_SESSION_SENDER_NAME_CHARS) return undefined;
  return normalized;
}
