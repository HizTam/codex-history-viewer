// Native records stay source-specific until the shared projector validates their meaning.
export const ANTIGRAVITY_PROFILE = "sqliteStepsV1" as const;
export const ANTIGRAVITY_MAX_BLOB_BYTES = 16 * 1024 * 1024;
export const ANTIGRAVITY_MAX_SESSION_BYTES = 256 * 1024 * 1024;
export const ANTIGRAVITY_MAX_COLLECTION_ITEMS = 10000;
export const ANTIGRAVITY_MAX_SESSIONS = 200000;
export const ANTIGRAVITY_MAX_SUMMARY_BYTES = 128 * 1024 * 1024;
export const ANTIGRAVITY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type AntigravityErrorCode = "runtime" | "storage" | "schema" | "format" | "corrupt" | "busy"
  | "sourceChanged" | "sourceUnavailable" | "cancelled" | "deadline" | "stalled" | "limit";
export class AntigravityReadError extends Error {
  constructor(public readonly code: AntigravityErrorCode) {
    super(`Antigravity history: ${code}`);
    this.name = "AntigravityReadError";
  }
}
export type AntigravityIssue = "unknownStep" | "invalidStep" | "unknownPayload" | "unmatchedTool"
  | "duplicateTool" | "truncated" | "unsupportedAttachment" | "unknownUsage" | "jsonlFallback";

export interface AntigravitySessionLocator {
  readonly rootPath: string;
  readonly conversationFsPath: string;
  readonly conversationId: string;
  readonly schemaProfile: typeof ANTIGRAVITY_PROFILE;
}
export interface AntigravityToolCall {
  readonly id: string;
  readonly name: string;
  readonly argumentsJson: string;
}
export interface AntigravityUsage {
  readonly model?: string;
  readonly modelNumber?: number;
  readonly providerNumber?: number;
  readonly messageId?: string;
  readonly responseId?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly thinkingOutputTokens?: number;
  readonly responseOutputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}
export interface AntigravityFileEvidence {
  readonly uri: string;
  readonly hasDiffStats?: true;
  readonly additions?: number;
  readonly deletions?: number;
}
export interface AntigravityAttachment {
  readonly kind: "image" | "file";
  readonly uri?: string;
  readonly path?: string;
  readonly label?: string;
  readonly mimeType?: string;
  readonly base64?: string;
}
export interface AntigravityFileEdit {
  readonly path: string;
  readonly kind: 1 | 2 | 3;
  readonly start: number;
  readonly end: number;
  readonly lines: readonly { readonly kind: 1 | 2 | 3; readonly text: string }[];
}

export interface AntigravityStep {
  readonly index: number;
  readonly type: number;
  readonly status: number;
  readonly createdAtIso?: string;
  readonly startedAtIso?: string;
  readonly completedAtIso?: string;
  readonly executionId?: string;
  readonly tool?: AntigravityToolCall;
  readonly usage?: AntigravityUsage;
  readonly input?: { readonly text: string; readonly queued: boolean; readonly clientMessageId?: string; readonly attachments: readonly AntigravityAttachment[] };
  readonly planner?: { readonly text: string; readonly thinking?: string; readonly redactedThinking: boolean; readonly thinkingDurationMs?: number; readonly messageId?: string; readonly stopReason?: number; readonly tools: readonly AntigravityToolCall[] };
  readonly generic?: { readonly arguments: Readonly<Record<string, string>>; readonly output: string; readonly files: readonly AntigravityFileEvidence[]; readonly hidden: boolean };
  readonly fallbackTools?: readonly { readonly name: string; readonly argumentsJson: string }[];
  readonly fallbackInput?: string;
  readonly fallbackOutput?: string;
  readonly issues: readonly AntigravityIssue[];
}
export interface AntigravityMetadata {
  readonly conversationId: string;
  readonly trajectoryId: string;
  readonly createdAtIso?: string;
  readonly workspaceUris: readonly string[];
}
export interface AntigravitySummaryRecord {
  readonly conversationId: string;
  readonly title: string;
  readonly preview: string;
  readonly stepCount: number;
  readonly lastModifiedIso?: string;
  readonly workspaceUris: readonly string[];
  readonly status: string;
  readonly notFullyIdle: boolean;
  readonly killed: boolean;
}

// Budget for the whole reply includes record and URI slots as well as UTF-16 strings.
export function antigravitySummarySize(summary: AntigravitySummaryRecord): number {
  let characters = summary.conversationId.length + summary.title.length + summary.preview.length +
    (summary.lastModifiedIso?.length ?? 0) + summary.status.length;
  for (const uri of summary.workspaceUris) {
    if (typeof uri !== "string") return Infinity;
    characters += uri.length;
  }
  return 64 + 16 * summary.workspaceUris.length + 2 * characters;
}
