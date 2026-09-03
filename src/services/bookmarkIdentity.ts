import { readCodexFileChangeEvent } from "../sessions/codexFileChangeEvents";

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
