import type { SessionSummary } from "../sessions/sessionTypes";

export type CliResumeTarget = "codex" | "claude";

declare const validatedCliSessionIdBrand: unique symbol;
export type ValidatedCliSessionId = string & {
  readonly [validatedCliSessionIdBrand]: CliResumeTarget;
};

const CLI_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function validateCodexResumeSessionId(value: unknown): ValidatedCliSessionId | null {
  return validateCliResumeSessionId(value, "codex");
}

export function validateClaudeResumeSessionId(value: unknown): ValidatedCliSessionId | null {
  return validateCliResumeSessionId(value, "claude");
}

export function validateCliResumeSessionId(
  value: unknown,
  target: CliResumeTarget,
): ValidatedCliSessionId | null {
  // Validate the original value without trimming or Unicode normalization.
  if (typeof value !== "string" || !CLI_SESSION_ID_PATTERN.test(value)) return null;
  return value as ValidatedCliSessionId & { readonly [validatedCliSessionIdBrand]: typeof target };
}

export function hasValidCliResumeSessionId(session: SessionSummary): boolean {
  return validateCliResumeSessionId(session.meta.id, session.source) !== null;
}

export function isCliResumeSessionEligible(session: SessionSummary, target: CliResumeTarget): boolean {
  return (
    session.source === target &&
    session.storage.archiveState === "active" &&
    validateCliResumeSessionId(session.meta.id, target) !== null
  );
}

export function buildCliResumeCommand(target: CliResumeTarget, sessionId: ValidatedCliSessionId): string {
  return target === "codex"
    ? `codex resume ${sessionId}`
    : `claude --resume ${sessionId}`;
}
