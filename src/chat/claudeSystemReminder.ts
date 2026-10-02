import { detectClaudeMaterializedMessageRole } from "./chatAttachments";

const MAX_INPUT_CHARS = 1_048_576;
const MAX_TEXT_BLOCKS = 128;
const MAX_BODY_CHARS = 64_000;
const OPEN_TAG = "<system-reminder>";
const CLOSE_TAG = "</system-reminder>";

export interface ClaudeSystemReminder {
  body: string;
  truncated?: true;
}

// Require native metadata as well as a complete wrapper; quoted user examples stay user input.
export function extractClaudeSystemReminder(value: unknown): ClaudeSystemReminder | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.isMeta !== true || record.origin !== undefined || detectClaudeMaterializedMessageRole(record) !== "user") return null;
  const message = record.message;
  const content = message && typeof message === "object" && !Array.isArray(message)
    ? (message as Record<string, unknown>).content ?? record.content
    : record.content;
  let text: string;
  if (typeof content === "string") {
    if (content.length > MAX_INPUT_CHARS) return null;
    text = content;
  } else if (Array.isArray(content) && content.length > 0 && content.length <= MAX_TEXT_BLOCKS) {
    const parts: string[] = [];
    let length = 0;
    for (const part of content) {
      if (!part || typeof part !== "object" || Array.isArray(part) || part.type !== "text" || typeof part.text !== "string") return null;
      length += part.text.length + (parts.length > 0 ? 1 : 0);
      if (length > MAX_INPUT_CHARS) return null;
      parts.push(part.text);
    }
    text = parts.join("\n");
  } else {
    return null;
  }
  text = text.replace(/\r\n?/gu, "\n").trim();
  if (!text.startsWith(OPEN_TAG) || !text.endsWith(CLOSE_TAG)) return null;
  const body = text.slice(OPEN_TAG.length, -CLOSE_TAG.length);
  // Reject nested or repeated wrappers rather than consuming unrelated content.
  if (/<\/?system-reminder\b/u.test(body)) return null;
  const normalized = body.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").trim();
  if (!normalized) return null;
  return {
    body: normalized.slice(0, MAX_BODY_CHARS),
    ...(normalized.length > MAX_BODY_CHARS ? { truncated: true } : {}),
  };
}
