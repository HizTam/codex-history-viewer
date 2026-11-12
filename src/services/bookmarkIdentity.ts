import { readCodexFileChangeEvent } from "../sessions/codexFileChangeEvents";

const timelineBookmarkIndexOffset = Symbol("timelineBookmarkIndexOffset");
type TimelineBookmarkIndexOffsetMetadata = { [timelineBookmarkIndexOffset]?: unknown };

// Keep removed-card offsets in memory and preserve them through ordinary object spreads.
export function setTimelineBookmarkIndexOffset(item: object, offset: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError("Timeline bookmark index offset must be a non-negative safe integer.");
  }
  Object.defineProperty(item, timelineBookmarkIndexOffset, {
    value: offset,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

export function getTimelineBookmarkIndexOffset(item: object): number {
  if (!item || typeof item !== "object") return 0;
  const offset = (item as TimelineBookmarkIndexOffsetMetadata)[timelineBookmarkIndexOffset];
  return typeof offset === "number" && Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
}

export function copyTimelineBookmarkIndexOffset<T extends object>(source: object, target: T): T {
  const offset = getTimelineBookmarkIndexOffset(source);
  if (offset > 0) setTimelineBookmarkIndexOffset(target, offset);
  return target;
}

// Builds stable cross-view IDs for bookmark targets that originate from JSONL records.
export function buildCodexPatchBookmarkGroupId(obj: unknown, fallbackIndex?: number): string {
  const event = readCodexFileChangeEvent(obj);
  const turnId = event?.turnId;
  if (turnId) return `turn:${turnId}`;

  const callId = event?.operationId;
  if (callId) return `call:${callId}`;

  const timestampIso = event?.timestampIso;
  if (timestampIso) return `ts:${timestampIso}`;

  const index = normalizePositiveIndex(fallbackIndex);
  return index > 0 ? `line:${index}` : "patch";
}

export function resolveClaudeToolCallId(callId: unknown, lineIndex: number, toolCallIndex: number): string {
  const normalized = readTrimmedString(callId);
  if (normalized) return normalized;
  return `fallback:line:${normalizeNonNegativeIndex(lineIndex)}:tool:${normalizeNonNegativeIndex(toolCallIndex)}`;
}

export function buildClaudePatchBookmarkGroupId(
  callId: unknown,
  lineIndex: number,
  toolCallIndex: number,
  messageIndex: number,
): string {
  return `claude:${resolveClaudeToolCallId(callId, lineIndex, toolCallIndex)}:${normalizeNonNegativeIndex(messageIndex)}`;
}

function readTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePositiveIndex(value: unknown): number {
  const index = normalizeNonNegativeIndex(value);
  return index > 0 ? index : 0;
}

function normalizeNonNegativeIndex(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
