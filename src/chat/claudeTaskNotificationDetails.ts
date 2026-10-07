import type { ChatNotificationAttachment, ChatNotificationDetails } from "./chatTypes";

export interface NotificationDetailBudget {
  remaining: number;
  scope: string;
  occurrences: Map<string, number>;
}

export interface NotificationRawSlice {
  source: string;
  start: number;
  end: number;
}

// This hash is an opaque UI identity, not an authentication or integrity primitive.
function opaqueIdentity(value: string): string {
  let first = 2166136261;
  let second = 3339675911;
  for (let index = 0; index < value.length; index += 1) {
    first = Math.imul(first ^ value.charCodeAt(index), 16777619);
    second = Math.imul(second ^ value.charCodeAt(index), 2246822519);
  }
  return (first >>> 0).toString(16).padStart(8, "0") + (second >>> 0).toString(16).padStart(8, "0");
}

export function createNotificationDetailBudget(record: unknown): NotificationDetailBudget {
  const object = record && typeof record === "object" ? record as Record<string, unknown> : {};
  const message = object.message && typeof object.message === "object" ? object.message as Record<string, unknown> : {};
  const id = typeof object.uuid === "string" && object.uuid ? object.uuid : typeof message.uuid === "string" && message.uuid ? message.uuid : undefined;
  return { remaining: 256000, scope: opaqueIdentity(id ? "record:" + id : "content:" + JSON.stringify(record ?? null)), occurrences: new Map() };
}

export function clampNotificationText(value: string, limit: number): string {
  let end = Math.max(0, Math.min(value.length, limit));
  if (end && /[\uD800-\uDBFF]/u.test(value[end - 1]!)) end -= 1;
  return value.slice(0, end);
}

export function takeNotificationText(value: string | undefined, limit: number, budget: NotificationDetailBudget): string | undefined {
  if (!value) return undefined;
  const text = clampNotificationText(normalizeNotificationText(value), Math.min(limit, budget.remaining));
  budget.remaining -= text.length;
  return text || undefined;
}

export function normalizeNotificationText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function decodeLeaf(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim();
}

// Parse only direct children, retaining raw values until the leaf is selected.
function rawChildren(body: string): Map<string, string | null> | undefined {
  const fields = new Map<string, string | null>();
  const open = /\s*<([A-Za-z][A-Za-z0-9_-]*)>/y;
  let cursor = 0;
  while (cursor < body.length) {
    while (cursor < body.length && /\s/u.test(body[cursor]!)) cursor += 1;
    if (cursor >= body.length) break;
    open.lastIndex = cursor;
    const match = open.exec(body);
    if (!match) return undefined;
    const tag = match[1]!;
    const close = "</" + tag + ">";
    const end = body.indexOf(close, open.lastIndex);
    if (end < 0) return undefined;
    fields.set(tag, fields.has(tag) ? null : body.slice(open.lastIndex, end));
    cursor = end + close.length;
  }
  return fields;
}

export function createNotificationDetails(rawBody: string, attachment: ChatNotificationAttachment, budget: NotificationDetailBudget): ChatNotificationDetails {
  const identity = opaqueIdentity(JSON.stringify([attachment.taskId, attachment.toolUseId]));
  const occurrence = budget.occurrences.get(identity) ?? 0;
  budget.occurrences.set(identity, occurrence + 1);
  const details: ChatNotificationDetails = { stateKey: "notification:" + budget.scope + ":" + identity + ":" + occurrence };
  if (budget.remaining === 0) return { ...details, omitted: true };
  const parsed = rawChildren(clampNotificationText(rawBody, 64000));
  const worktree = parsed?.get("worktree");
  const children = typeof worktree === "string" ? rawChildren(worktree) : undefined;
  const leaf = (map: Map<string, string | null> | undefined, key: string): string | undefined => {
    const raw = map?.get(key);
    // Literal nested tags in a worktree leaf are not a path or branch value.
    return typeof raw === "string" ? decodeLeaf(raw) : undefined;
  };
  const worktreeLeaf = (key: string): string | undefined => {
    const raw = children?.get(key);
    return typeof raw === "string" && !/[<>]/u.test(raw) ? decodeLeaf(raw) : undefined;
  };
  const fields: Array<[keyof ChatNotificationDetails, string | undefined, number]> = [
    ["taskId", attachment.taskId, 1024], ["toolUseId", attachment.toolUseId, 1024],
    ["taskType", leaf(parsed, "task-type"), 1024], ["outputFile", attachment.outputFile, 32768],
    ["rawStatus", attachment.rawStatus, 1024], ["note", attachment.note, 16000],
    ["event", leaf(parsed, "event"), 1024], ["worktreePath", worktreeLeaf("worktreePath"), 32768],
    ["worktreeBranch", worktreeLeaf("worktreeBranch"), 1024],
  ];
  let available = 64000;
  for (const [key, value, limit] of fields) {
    if (!value) continue;
    const text = takeNotificationText(value, Math.min(limit, available), budget);
    if (text) { Object.assign(details, { [key]: text }); available -= text.length; }
    if ((text?.length ?? 0) < normalizeNotificationText(value).length) (details.truncatedFields ??= []).push(key);
  }
  if (rawBody.length > 64000 || budget.remaining === 0) details.omitted = true;
  return details;
}

export function sameNotificationRaw(left: NotificationRawSlice, right: NotificationRawSlice): boolean {
  if (left.end - left.start !== right.end - right.start) return false;
  for (let offset = 0; offset < left.end - left.start; offset += 1) if (left.source.charCodeAt(left.start + offset) !== right.source.charCodeAt(right.start + offset)) return false;
  return true;
}

export function addNotificationRawVariant(details: ChatNotificationDetails, raw: NotificationRawSlice, retained: NotificationRawSlice[], budget: NotificationDetailBudget): void {
  if (retained.some(previous => sameNotificationRaw(previous, raw))) return;
  const used = details.rawVariants?.reduce((sum, variant) => sum + variant.text.length, 0) ?? 0;
  if (retained.length >= 16 || used >= 64000 || budget.remaining === 0) {
    details.omittedVariants = Math.min(Number.MAX_SAFE_INTEGER, (details.omittedVariants ?? 0) + 1);
    return;
  }
  const maximum = Math.min(64000 - used, budget.remaining);
  const candidate = raw.source.slice(raw.start, Math.min(raw.end, raw.start + maximum + 1));
  const text = takeNotificationText(candidate, maximum, budget);
  retained.push(raw);
  const truncated = raw.end - raw.start > candidate.length || normalizeNotificationText(candidate).length > (text?.length ?? 0);
  if (text) (details.rawVariants ??= []).push({ text, ...(truncated ? { truncated: true } : {}) });
}
