const MAX_ACTIVITY_TIMESTAMP_LENGTH = 128;
const MAX_LIVE_SESSION_ID_LENGTH = 256;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

export const LIVE_RUNNING_STALE_MS = 30 * 60 * 1000;

export interface SessionFileFingerprint {
  mtimeMs: number;
  size: number;
}

export interface ChatSourceRecordSignature {
  lineIndex: number;
  ordinal?: number;
  timestampIso?: string;
}

export interface ChatSourceActivityEvidence {
  lastValidRecordLineIndex?: number;
  lastValidRecordOrdinal?: number;
  lastValidRecordTimestampIso?: string;
  latestValidTopLevelTimestampIso?: string;
}

export type LiveActivitySource = "observed" | "recordTimestamp" | "mtime";
export type LiveObservationTransition = "bootstrap" | "append" | "unchanged" | "reset";

export interface LiveSessionObservation {
  sessionId: string;
  fingerprint: SessionFileFingerprint;
  recordSignature?: ChatSourceRecordSignature;
  effectiveActivityAtMs?: number;
  activitySource?: LiveActivitySource;
  requestSequence: number;
  transition: LiveObservationTransition;
}

export interface LiveActivityBootstrap {
  effectiveActivityAtMs: number;
  activitySource: "recordTimestamp" | "mtime";
}

export interface BuildLiveSessionObservationInput {
  sessionId: string;
  fingerprint: SessionFileFingerprint;
  activityEvidence: ChatSourceActivityEvidence;
  requestSequence: number;
  observedAtMs: number;
  staleMs?: number;
}

export function createChatSourceActivityEvidence(): ChatSourceActivityEvidence {
  return {};
}

// Records only bounded metadata from a successfully parsed JSON object.
export function observeChatSourceActivityRecord(
  evidence: ChatSourceActivityEvidence,
  value: unknown,
  lineIndex: number,
): boolean {
  if (!isRecord(value) || !isSafePositiveInteger(lineIndex)) return false;

  evidence.lastValidRecordLineIndex = lineIndex;
  const ordinal = sanitizeOrdinal(value.ordinal);
  if (ordinal === undefined) {
    delete evidence.lastValidRecordOrdinal;
  } else {
    evidence.lastValidRecordOrdinal = ordinal;
  }

  const timestampIso = sanitizeActivityTimestamp(value.timestamp);
  if (timestampIso === undefined) {
    delete evidence.lastValidRecordTimestampIso;
  } else {
    evidence.lastValidRecordTimestampIso = timestampIso;
    evidence.latestValidTopLevelTimestampIso = timestampIso;
  }
  return true;
}

export function sanitizeActivityTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_ACTIVITY_TIMESTAMP_LENGTH ||
    CONTROL_CHARACTERS.test(trimmed)
  ) {
    return undefined;
  }

  const timestampMs = Date.parse(trimmed);
  if (!Number.isFinite(timestampMs)) return undefined;
  try {
    return new Date(timestampMs).toISOString();
  } catch {
    return undefined;
  }
}

export function createSessionFileFingerprint(
  mtimeMs: unknown,
  size: unknown,
): SessionFileFingerprint | undefined {
  if (typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs) || mtimeMs < 0) return undefined;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return undefined;
  return { mtimeMs, size };
}

export function hasSessionFileFingerprintChanged(
  previous: SessionFileFingerprint,
  current: SessionFileFingerprint,
): boolean {
  return previous.size !== current.size || Math.abs(previous.mtimeMs - current.mtimeMs) > 1;
}

export function resolveLiveActivityBootstrap(
  activityEvidence: ChatSourceActivityEvidence,
  fingerprint: SessionFileFingerprint | undefined,
  observedAtMs: number,
  staleMs = LIVE_RUNNING_STALE_MS,
): LiveActivityBootstrap | undefined {
  if (!isFiniteNonNegativeNumber(observedAtMs) || !isFiniteNonNegativeNumber(staleMs)) return undefined;

  const timestampIso = sanitizeActivityTimestamp(activityEvidence.latestValidTopLevelTimestampIso);
  if (timestampIso !== undefined) {
    const timestampMs = Date.parse(timestampIso);
    return isLiveActivityFresh(timestampMs, observedAtMs, staleMs)
      ? { effectiveActivityAtMs: timestampMs, activitySource: "recordTimestamp" }
      : undefined;
  }

  const mtimeMs = fingerprint?.mtimeMs;
  return typeof mtimeMs === "number" && isLiveActivityFresh(mtimeMs, observedAtMs, staleMs)
    ? { effectiveActivityAtMs: mtimeMs, activitySource: "mtime" }
    : undefined;
}

export function buildLiveSessionObservation(
  previous: LiveSessionObservation | undefined,
  input: BuildLiveSessionObservationInput,
): LiveSessionObservation | undefined {
  const sessionId = sanitizeLiveSessionId(input.sessionId);
  const fingerprint = createSessionFileFingerprint(input.fingerprint?.mtimeMs, input.fingerprint?.size);
  const requestSequence = sanitizePositiveSequence(input.requestSequence);
  const observedAtMs = input.observedAtMs;
  const staleMs = input.staleMs ?? LIVE_RUNNING_STALE_MS;
  if (
    !sessionId ||
    !fingerprint ||
    requestSequence === undefined ||
    !isFiniteNonNegativeNumber(observedAtMs) ||
    !isFiniteNonNegativeNumber(staleMs)
  ) {
    return undefined;
  }

  const recordSignature = readRecordSignature(input.activityEvidence);
  const sameSession = previous?.sessionId === sessionId;
  const transition = resolveObservationTransition(previous, sameSession, fingerprint, recordSignature);

  let effectiveActivityAtMs: number | undefined;
  let activitySource: LiveActivitySource | undefined;
  if (transition === "append") {
    const recordTimestampMs =
      recordSignature?.timestampIso === undefined ? undefined : Date.parse(recordSignature.timestampIso);
    if (recordTimestampMs !== undefined && Number.isFinite(recordTimestampMs)) {
      const clampedTimestampMs = Math.min(recordTimestampMs, observedAtMs);
      if (isFiniteNonNegativeNumber(clampedTimestampMs)) {
        effectiveActivityAtMs = clampedTimestampMs;
        activitySource = "recordTimestamp";
      }
    } else {
      effectiveActivityAtMs = observedAtMs;
      activitySource = "observed";
    }
  } else if (transition === "unchanged" && previous) {
    effectiveActivityAtMs = sanitizeActivityTime(previous.effectiveActivityAtMs);
    activitySource = effectiveActivityAtMs === undefined ? undefined : previous.activitySource;
  } else {
    const bootstrap = resolveLiveActivityBootstrap(
      input.activityEvidence,
      fingerprint,
      observedAtMs,
      staleMs,
    );
    effectiveActivityAtMs = bootstrap?.effectiveActivityAtMs;
    activitySource = bootstrap?.activitySource;
  }

  return {
    sessionId,
    fingerprint,
    ...(recordSignature ? { recordSignature } : {}),
    ...(effectiveActivityAtMs !== undefined ? { effectiveActivityAtMs } : {}),
    ...(activitySource ? { activitySource } : {}),
    requestSequence,
    transition,
  };
}

// Keeps a newer reset authoritative while preventing stale parallel reads from rewinding append progress.
export function mergeLiveSessionObservation(
  current: LiveSessionObservation | undefined,
  candidate: LiveSessionObservation | undefined,
): LiveSessionObservation | undefined {
  if (!candidate) return current;
  if (!current) return candidate;
  if (candidate.requestSequence < current.requestSequence) return current;
  if (candidate.sessionId !== current.sessionId || candidate.transition === "reset") return candidate;

  if (isObservationBehind(candidate, current)) return current;

  const currentActivityAtMs = sanitizeActivityTime(current.effectiveActivityAtMs);
  const candidateActivityAtMs = sanitizeActivityTime(candidate.effectiveActivityAtMs);
  if (
    currentActivityAtMs !== undefined &&
    (candidateActivityAtMs === undefined || currentActivityAtMs > candidateActivityAtMs)
  ) {
    const merged: LiveSessionObservation = {
      ...candidate,
      effectiveActivityAtMs: currentActivityAtMs,
    };
    if (current.activitySource) merged.activitySource = current.activitySource;
    else delete merged.activitySource;
    return merged;
  }
  return candidate;
}

export function isLiveActivityFresh(
  effectiveActivityAtMs: unknown,
  observedAtMs: number,
  staleMs = LIVE_RUNNING_STALE_MS,
): effectiveActivityAtMs is number {
  if (
    !isFiniteNonNegativeNumber(effectiveActivityAtMs) ||
    !isFiniteNonNegativeNumber(observedAtMs) ||
    !isFiniteNonNegativeNumber(staleMs)
  ) {
    return false;
  }
  const ageMs = observedAtMs - effectiveActivityAtMs;
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= staleMs;
}

export function getLiveActivityExpiryAtMs(
  effectiveActivityAtMs: unknown,
  staleMs = LIVE_RUNNING_STALE_MS,
): number | undefined {
  if (!isFiniteNonNegativeNumber(effectiveActivityAtMs)) return undefined;
  if (!isFiniteNonNegativeNumber(staleMs)) return undefined;
  const expiryAtMs = effectiveActivityAtMs + staleMs;
  return Number.isFinite(expiryAtMs) ? expiryAtMs : undefined;
}

function resolveObservationTransition(
  previous: LiveSessionObservation | undefined,
  sameSession: boolean,
  fingerprint: SessionFileFingerprint,
  recordSignature: ChatSourceRecordSignature | undefined,
): LiveObservationTransition {
  if (!previous) return "bootstrap";
  if (!sameSession || fingerprint.size < previous.fingerprint.size) return "reset";

  const previousSignature = previous.recordSignature;
  if (!previousSignature) return recordSignature ? "append" : "unchanged";
  if (!recordSignature || recordSignature.lineIndex < previousSignature.lineIndex) return "reset";
  if (recordSignature.lineIndex > previousSignature.lineIndex) return "append";
  return areRecordSignaturesEqual(previousSignature, recordSignature) ? "unchanged" : "reset";
}

function readRecordSignature(
  evidence: ChatSourceActivityEvidence,
): ChatSourceRecordSignature | undefined {
  const lineIndex = evidence.lastValidRecordLineIndex;
  if (!isSafePositiveInteger(lineIndex)) return undefined;
  const ordinal = sanitizeOrdinal(evidence.lastValidRecordOrdinal);
  const timestampIso = sanitizeActivityTimestamp(evidence.lastValidRecordTimestampIso);
  return {
    lineIndex,
    ...(ordinal !== undefined ? { ordinal } : {}),
    ...(timestampIso !== undefined ? { timestampIso } : {}),
  };
}

function areRecordSignaturesEqual(
  left: ChatSourceRecordSignature,
  right: ChatSourceRecordSignature,
): boolean {
  return (
    left.lineIndex === right.lineIndex &&
    left.ordinal === right.ordinal &&
    left.timestampIso === right.timestampIso
  );
}

function isObservationBehind(
  candidate: LiveSessionObservation,
  current: LiveSessionObservation,
): boolean {
  if (candidate.fingerprint.size < current.fingerprint.size) return true;
  const candidateLineIndex = candidate.recordSignature?.lineIndex;
  const currentLineIndex = current.recordSignature?.lineIndex;
  if (currentLineIndex === undefined) return false;
  return candidateLineIndex === undefined || candidateLineIndex < currentLineIndex;
}

function sanitizeLiveSessionId(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_LIVE_SESSION_ID_LENGTH || CONTROL_CHARACTERS.test(trimmed)) return "";
  return trimmed;
}

function sanitizeOrdinal(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function sanitizePositiveSequence(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function sanitizeActivityTime(value: unknown): number | undefined {
  return isFiniteNonNegativeNumber(value) ? value : undefined;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
