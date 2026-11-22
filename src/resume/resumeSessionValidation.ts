import type { SessionSummary } from "../sessions/sessionTypes";
import { ANTIGRAVITY_UUID } from "../antigravity/antigravityTypes";

export type ResumeTargetSource = "codex" | "claude" | "antigravity";
export type ResumeActionReason =
  | "available"
  | "wrongSource"
  | "archived"
  | "invalidSessionId"
  | "workspaceUntrusted"
  | "rootUnverified"
  | "remoteHostMismatch"
  | "unknown";

const CODEX_EXTENSION_SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

export function resolveExtensionResumeSessionId(
  session: SessionSummary,
  target: ResumeTargetSource,
): string | null {
  if (session.source !== target || session.storage.archiveState !== "active" || session.meta.claudeAgent) return null;
  if (target === "antigravity") return typeof session.meta.id === "string" && ANTIGRAVITY_UUID.test(session.meta.id) ? session.meta.id : null;
  const id = typeof session.meta.id === "string" ? session.meta.id.trim() : "";
  if (!id) return null;
  if (target === "codex") return CODEX_EXTENSION_SESSION_ID_PATTERN.test(id) ? id : null;
  return CONTROL_CHARACTER_PATTERN.test(id) ? null : id;
}

export function evaluateExtensionResumeAction(
  session: SessionSummary | undefined,
  target: ResumeTargetSource,
): { available: boolean; reason: ResumeActionReason } {
  if (!session || session.source !== target) return { available: false, reason: "wrongSource" };
  if (session.storage.archiveState !== "active") return { available: false, reason: "archived" };
  if (!resolveExtensionResumeSessionId(session, target)) {
    return { available: false, reason: "invalidSessionId" };
  }
  return { available: true, reason: "available" };
}
