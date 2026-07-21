import type { CodexAgentMetadata } from "../sessions/sessionTypes";
import { truncateByDisplayWidth } from "../utils/textUtils";

const MAX_PARENT_THREAD_ID_LENGTH = 256;
const MAX_AGENT_PATH_LENGTH = 512;
const MAX_AGENT_LABEL_LENGTH = 120;
const MAX_RECORDED_DEPTH = 64;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface SanitizedCodexAgentMetadata {
  valid: boolean;
  value?: CodexAgentMetadata;
}

export function extractCodexAgentMetadata(source: unknown): CodexAgentMetadata | undefined {
  if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
  const subagent = (source as { subagent?: unknown }).subagent;
  if (!subagent || typeof subagent !== "object" || Array.isArray(subagent)) return undefined;
  const threadSpawn = (subagent as { thread_spawn?: unknown }).thread_spawn;
  if (!threadSpawn || typeof threadSpawn !== "object" || Array.isArray(threadSpawn)) return undefined;
  return sanitizeCodexAgentMetadata(threadSpawn, true).value;
}

export function sanitizeCachedCodexAgentMetadata(value: unknown): SanitizedCodexAgentMetadata {
  if (value === undefined) return { valid: true };
  if (value === null) return { valid: false };
  return sanitizeCodexAgentMetadata(value, false);
}

export function resolveCodexAgentTaskLabel(
  metadata: CodexAgentMetadata | undefined,
  fallback: string,
): string {
  const pathLabel = getAgentPathLabel(metadata?.agentPath);
  if (pathLabel) return pathLabel;
  const nickname = sanitizeDisplayCandidate(metadata?.agentNickname);
  return nickname || fallback;
}

export function resolveCodexAgentTaskSortKey(metadata: CodexAgentMetadata | undefined): string {
  return getAgentPathLabel(metadata?.agentPath) || sanitizeDisplayCandidate(metadata?.agentNickname);
}

export function normalizeCodexThreadId(value: unknown): string {
  return sanitizeString(value, MAX_PARENT_THREAD_ID_LENGTH).toLowerCase();
}

function sanitizeCodexAgentMetadata(value: unknown, rawThreadSpawn: boolean): SanitizedCodexAgentMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false };
  const candidate = value as Record<string, unknown>;
  const parentThreadId = normalizeCodexThreadId(
    rawThreadSpawn ? candidate.parent_thread_id : candidate.parentThreadId,
  );
  if (!parentThreadId) return { valid: false };

  const recordedDepthRaw = rawThreadSpawn ? candidate.depth : candidate.recordedDepth;
  const recordedDepth =
    typeof recordedDepthRaw === "number" &&
    Number.isSafeInteger(recordedDepthRaw) &&
    recordedDepthRaw >= 1 &&
    recordedDepthRaw <= MAX_RECORDED_DEPTH
      ? recordedDepthRaw
      : undefined;
  const agentPath = sanitizeString(rawThreadSpawn ? candidate.agent_path : candidate.agentPath, MAX_AGENT_PATH_LENGTH);
  const agentNickname = sanitizeString(
    rawThreadSpawn ? candidate.agent_nickname : candidate.agentNickname,
    MAX_AGENT_LABEL_LENGTH,
  );
  const agentRole = sanitizeString(rawThreadSpawn ? candidate.agent_role : candidate.agentRole, MAX_AGENT_LABEL_LENGTH);

  return {
    valid: true,
    value: {
      parentThreadId,
      ...(recordedDepth !== undefined ? { recordedDepth } : {}),
      ...(agentPath ? { agentPath } : {}),
      ...(agentNickname ? { agentNickname } : {}),
      ...(agentRole ? { agentRole } : {}),
    },
  };
}

function sanitizeString(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || CONTROL_CHARACTER_PATTERN.test(normalized)) return "";
  return normalized;
}

function getAgentPathLabel(value: unknown): string {
  const agentPath = sanitizeString(value, MAX_AGENT_PATH_LENGTH);
  if (!agentPath) return "";
  const segments = agentPath.split(/[\\/]+/u).map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 1 && segments[0]?.toLowerCase() === "root") return "";
  return sanitizeDisplayCandidate(segments.at(-1));
}

function sanitizeDisplayCandidate(value: unknown): string {
  const candidate = sanitizeString(value, MAX_AGENT_LABEL_LENGTH);
  if (!candidate || UUID_PATTERN.test(candidate)) return "";
  return truncateByDisplayWidth(candidate, 79, "…");
}
