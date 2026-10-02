import { detectClaudeMaterializedMessageRole } from "./chatAttachments";
import { isClaudeCrossSessionInboundRecord } from "./claudeCrossSessionMessage";
import { extractClaudeSystemReminder } from "./claudeSystemReminder";

const MAX_CONTENT_CHARS = 64_000;

export function isClaudeTaskNotificationRecord(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (detectClaudeMaterializedMessageRole(value) !== "user" || isClaudeCrossSessionInboundRecord(value)) return false;
  const record = value as Record<string, unknown>;
  const origin = record.origin;
  if (record.isMeta !== true || !origin || typeof origin !== "object" || Array.isArray(origin)) return false;
  const metadata = origin as Record<string, unknown>;
  return metadata.kind === "task-notification" && metadata.producer === "session-task";
}

// Provenance is independent of extraction: malformed internal input never becomes a human request.
export function isClaudeInternalUserRecord(value: unknown): boolean {
  return isClaudeCrossSessionInboundRecord(value) || isClaudeTaskNotificationRecord(value) || extractClaudeSystemReminder(value) !== null;
}

export function projectClaudeTaskNotification(value: unknown): { body: string; truncated?: true; invalidContent?: true } {
  const record = value as { message?: { content?: unknown }; content?: unknown };
  const content = record?.message?.content ?? record?.content;
  let text: string | undefined;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content) && content.every(part => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")) {
    text = content.map(part => part.text as string).join("\n");
  }
  const invalidContent = text === undefined || !text.trim();
  if (invalidContent) {
    try {
      text = JSON.stringify(content ?? null, null, 2);
    } catch {
      // JSONL input cannot be cyclic, but callers may provide an invalid object.
      text = "null";
    }
  }
  const normalized = (text ?? "").replace(/\r\n?/gu, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
  return {
    body: normalized.slice(0, MAX_CONTENT_CHARS),
    ...(normalized.length > MAX_CONTENT_CHARS ? { truncated: true } : {}),
    ...(invalidContent ? { invalidContent: true } : {}),
  };
}
