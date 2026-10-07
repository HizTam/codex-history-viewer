import { buildClaudeTaskNotificationPresentation, detectClaudeMaterializedMessageRole } from "./chatAttachments";
import { isClaudeCrossSessionInboundRecord } from "./claudeCrossSessionMessage";
import { extractClaudeSystemReminder } from "./claudeSystemReminder";
import type { ChatTaskNotificationPresentation } from "./chatTypes";

const MAX_CONTENT_CHARS = 64_000;

function readQueuedTaskNotificationAttachment(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.type !== "attachment" || (record.isMeta !== undefined && record.isMeta !== true) || record.forwardedIntent != null) return undefined;
  const valueAttachment = record.attachment;
  if (!valueAttachment || typeof valueAttachment !== "object" || Array.isArray(valueAttachment)) return undefined;
  const attachment = valueAttachment as Record<string, unknown>;
  if (attachment.type !== "queued_command" || attachment.commandMode !== "task-notification" ||
      (attachment.isMeta !== undefined && attachment.isMeta !== true) ||
      (attachment.humanTurn !== undefined && attachment.humanTurn !== false) || attachment.forwardedIntent != null) return undefined;
  const origin = attachment.origin;
  if (!origin || typeof origin !== "object" || Array.isArray(origin)) return undefined;
  const metadata = origin as Record<string, unknown>;
  return metadata.kind === "task-notification" && metadata.producer === "session-task" && metadata.subkind !== "peer-send-message"
    ? attachment : undefined;
}

// Only delivered commands with explicit internal provenance are eligible for display.
export function isClaudeQueuedTaskNotificationRecord(value: unknown): boolean {
  return readQueuedTaskNotificationAttachment(value) !== undefined;
}

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

export function projectClaudeTaskNotification(value: unknown, includeDetails = false): { body: string; truncated?: true; invalidContent?: true; presentation?: ChatTaskNotificationPresentation } {
  const record = value as { message?: { content?: unknown }; content?: unknown };
  const queued = readQueuedTaskNotificationAttachment(value);
  const content = queued ? queued.prompt : record?.message?.content ?? record?.content;
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
  const body = normalized.slice(0, MAX_CONTENT_CHARS);
  const presentation = includeDetails && !invalidContent ? buildClaudeTaskNotificationPresentation(body, value) : undefined;
  return {
    body,
    ...(presentation ? { presentation } : {}),
    ...(normalized.length > MAX_CONTENT_CHARS ? { truncated: true } : {}),
    ...(invalidContent ? { invalidContent: true } : {}),
  };
}
