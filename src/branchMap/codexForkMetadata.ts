import type { CodexForkMetadata } from "../sessions/sessionTypes";

const MAX_THREAD_ID_LENGTH = 256;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

export interface SanitizedCodexForkMetadata {
  valid: boolean;
  value?: CodexForkMetadata;
}

export function extractCodexForkMetadata(payload: unknown): CodexForkMetadata | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const parentThreadId = normalizeCodexForkThreadId(
    (payload as { forked_from_id?: unknown }).forked_from_id,
  );
  return parentThreadId ? { parentThreadId } : undefined;
}

export function sanitizeCachedCodexForkMetadata(value: unknown): SanitizedCodexForkMetadata {
  if (value === undefined) return { valid: true };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false };
  const candidate = value as { parentThreadId?: unknown };
  const parentThreadId = normalizeCodexForkThreadId(candidate.parentThreadId);
  return parentThreadId
    ? { valid: true, value: { parentThreadId } }
    : { valid: false };
}

export function normalizeCodexForkThreadId(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > MAX_THREAD_ID_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    return "";
  }
  return normalized.toLowerCase();
}
