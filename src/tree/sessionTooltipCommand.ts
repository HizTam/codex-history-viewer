import { isBoundedSessionIdentityKey } from "../sessions/sessionIdentity";
import { stableTextSha256 } from "../utils/stableTextHash";

export const OPEN_SESSION_FROM_TOOLTIP_COMMAND_ID = "codexHistoryViewer.openSessionFromTooltip";

const SESSION_TOOLTIP_REFERENCE_PATTERN = /^[0-9a-f]{64}$/u;

export function buildSessionViewCommandUri(identityKey: unknown): string | undefined {
  const sessionRef = createSessionTooltipReference(identityKey);
  if (!sessionRef) return undefined;

  const query = encodeURIComponent(JSON.stringify([{ sessionRef }]));
  return `command:${OPEN_SESSION_FROM_TOOLTIP_COMMAND_ID}?${query}`;
}

export function resolveSessionTooltipReferenceArgument(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const sessionRef = (value as { sessionRef?: unknown }).sessionRef;
  return typeof sessionRef === "string" && SESSION_TOOLTIP_REFERENCE_PATTERN.test(sessionRef)
    ? sessionRef
    : undefined;
}

export function resolveUniqueSessionByTooltipReference<T extends { readonly identityKey: string }>(
  sessions: readonly T[],
  sessionRef: string,
): T | undefined {
  if (!SESSION_TOOLTIP_REFERENCE_PATTERN.test(sessionRef)) return undefined;

  let match: T | undefined;
  for (const session of sessions) {
    if (createSessionTooltipReference(session.identityKey) !== sessionRef) continue;
    if (match) return undefined;
    match = session;
  }
  return match;
}

function createSessionTooltipReference(identityKey: unknown): string | undefined {
  if (
    !isBoundedSessionIdentityKey(identityKey) ||
    /[\u0000-\u001f\u007f]/u.test(identityKey)
  ) {
    return undefined;
  }
  return stableTextSha256(identityKey);
}
