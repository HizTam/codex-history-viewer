import { createHash } from "node:crypto";
import type { PerformanceProbe } from "../performance/performanceCounters";

type JsonRecord = Record<string, unknown>;

export const MAX_TRACKED_CODEX_FILE_CHANGE_SIGNATURES = 4_096;

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_TIMESTAMP_LENGTH = 128;
const MAX_STATUS_LENGTH = 64;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/gu;
const HAS_CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

export type CodexFileChangeEventSource = "patchApplyEnd" | "fileChangeItemCompleted";

export interface CodexFileChangeEvent {
  readonly source: CodexFileChangeEventSource;
  readonly changes: unknown;
  readonly turnId?: string;
  readonly operationId?: string;
  readonly timestampIso?: string;
  readonly status?: string;
  readonly success?: boolean;
}

interface UnmatchedSourceCounts {
  patchApplyEnd: number;
  fileChangeItemCompleted: number;
}

// Normalizes the two verified Codex rollout envelopes without interpreting diff contents.
export function readCodexFileChangeEvent(
  value: unknown,
  performanceProbe?: PerformanceProbe,
): CodexFileChangeEvent | undefined {
  performanceProbe?.add("fileChangeNormalizerCallCount");
  const root = asRecord(value);
  if (!root || root.type !== "event_msg") return undefined;

  const payload = asRecord(root.payload);
  if (!payload) return undefined;

  if (payload.type === "patch_apply_end") {
    performanceProbe?.add("fileChangeRecognizedCount");
    return compactEvent({
      source: "patchApplyEnd",
      changes: payload.changes,
      turnId: readIdentifier(payload.turn_id),
      operationId: readIdentifier(payload.call_id),
      timestampIso: readBoundedString(payload.timestamp, MAX_TIMESTAMP_LENGTH) ||
        readBoundedString(root.timestamp, MAX_TIMESTAMP_LENGTH),
      status: readBoundedString(payload.status, MAX_STATUS_LENGTH),
      success: readBoolean(payload.success),
    });
  }

  if (payload.type !== "item_completed") return undefined;
  const item = asRecord(payload.item);
  if (!item || item.type !== "FileChange") return undefined;

  performanceProbe?.add("fileChangeRecognizedCount");
  return compactEvent({
    source: "fileChangeItemCompleted",
    changes: item.changes,
    turnId: readIdentifier(payload.turn_id),
    operationId: readIdentifier(item.id),
    timestampIso: readBoundedString(payload.timestamp, MAX_TIMESTAMP_LENGTH) ||
      readBoundedString(root.timestamp, MAX_TIMESTAMP_LENGTH),
    status: readBoundedString(item.status, MAX_STATUS_LENGTH),
    success: combineSuccess(item.success, payload.success),
  });
}

// New completed-item records fail closed; legacy records retain their permissive compatibility behavior.
export function isSuccessfulCodexFileChangeEvent(
  event: CodexFileChangeEvent,
  performanceProbe?: PerformanceProbe,
): boolean {
  performanceProbe?.add("fileChangeSuccessCheckCount");
  const status = normalizeStatus(event.status);
  if (event.success === false || FAILURE_STATUSES.has(status)) return false;
  if (event.source === "fileChangeItemCompleted") {
    return status === "completed";
  }
  return true;
}

// Suppresses only one-to-one duplicates emitted once through each verified envelope.
export class CodexFileChangeEventDeduper {
  private readonly unmatchedBySignature = new Map<string, UnmatchedSourceCounts>();
  private readonly maxTrackedSignatures: number;

  public constructor(
    maxTrackedSignatures = MAX_TRACKED_CODEX_FILE_CHANGE_SIGNATURES,
    private readonly performanceProbe?: PerformanceProbe,
  ) {
    this.maxTrackedSignatures = normalizeTrackerLimit(maxTrackedSignatures);
  }

  public shouldSuppress(event: CodexFileChangeEvent): boolean {
    if (!isSuccessfulCodexFileChangeEvent(event, this.performanceProbe)) return false;
    const signature = buildEventSignature(event, this.performanceProbe);
    if (!signature) return false;

    let counts = this.unmatchedBySignature.get(signature);
    if (!counts) {
      this.evictOldestIfFull();
      counts = { patchApplyEnd: 0, fileChangeItemCompleted: 0 };
      this.unmatchedBySignature.set(signature, counts);
      this.performanceProbe?.observeMax("fileChangeTrackingPeak", this.unmatchedBySignature.size);
    }

    const opposite: CodexFileChangeEventSource =
      event.source === "patchApplyEnd" ? "fileChangeItemCompleted" : "patchApplyEnd";
    if (counts[opposite] > 0) {
      counts[opposite] -= 1;
      if (counts.patchApplyEnd === 0 && counts.fileChangeItemCompleted === 0) {
        this.unmatchedBySignature.delete(signature);
      }
      this.performanceProbe?.add("fileChangeDuplicateHitCount");
      return true;
    }

    counts[event.source] += 1;
    return false;
  }

  private evictOldestIfFull(): void {
    while (this.unmatchedBySignature.size >= this.maxTrackedSignatures) {
      const oldest = this.unmatchedBySignature.keys().next().value as string | undefined;
      if (!oldest) break;
      this.unmatchedBySignature.delete(oldest);
      this.performanceProbe?.add("fileChangeEvictionCount");
    }
  }
}

const FAILURE_STATUSES = new Set(["failed", "failure", "error", "cancelled", "canceled", "declined"]);

function compactEvent(event: CodexFileChangeEvent): CodexFileChangeEvent {
  return {
    source: event.source,
    changes: event.changes,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.operationId ? { operationId: event.operationId } : {}),
    ...(event.timestampIso ? { timestampIso: event.timestampIso } : {}),
    ...(event.status ? { status: event.status } : {}),
    ...(typeof event.success === "boolean" ? { success: event.success } : {}),
  };
}

function buildEventSignature(
  event: CodexFileChangeEvent,
  performanceProbe?: PerformanceProbe,
): string | undefined {
  // Without a turn boundary, pairing could hide two independent edits with identical contents.
  if (!event.turnId) return undefined;
  const changes = asRecord(event.changes);
  if (!changes) return undefined;
  const paths = Object.keys(changes).sort();
  if (paths.length === 0) return undefined;

  performanceProbe?.add("fileChangeSignatureCalculationCount");
  const hash = createHash("sha256");
  updateHashPart(hash, "codex-file-change-v1", performanceProbe);
  updateHashPart(hash, event.turnId ?? "", performanceProbe);
  for (const rawPath of paths) {
    updateHashPart(hash, rawPath, performanceProbe);
    const change = asRecord(changes[rawPath]);
    if (!change) {
      updateHashPart(hash, "invalid", performanceProbe);
      continue;
    }
    updateHashPart(hash, readRawString(change.type), performanceProbe);
    updateHashPart(hash, readRawString(change.move_path), performanceProbe);
    updateHashPart(hash, readRawString(change.unified_diff), performanceProbe);
    updateHashPart(hash, readRawString(change.content), performanceProbe);
  }
  return hash.digest("hex");
}

function updateHashPart(
  hash: ReturnType<typeof createHash>,
  value: string,
  performanceProbe?: PerformanceProbe,
): void {
  const length = String(value.length);
  hash.update(length, "utf8");
  hash.update(":", "utf8");
  hash.update(value, "utf8");
  hash.update(";", "utf8");
  if (performanceProbe) {
    performanceProbe.add(
      "fileChangeSignatureInputByteCount",
      Buffer.byteLength(length, "utf8") + Buffer.byteLength(value, "utf8") + 2,
    );
  }
}

function normalizeTrackerLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return MAX_TRACKED_CODEX_FILE_CHANGE_SIGNATURES;
  }
  return Math.min(value, MAX_TRACKED_CODEX_FILE_CHANGE_SIGNATURES);
}

function normalizeStatus(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function readIdentifier(value: unknown): string {
  if (typeof value !== "string") return "";
  const cleaned = value.trim().replace(CONTROL_CHARACTERS, "");
  return cleaned.slice(0, MAX_IDENTIFIER_LENGTH);
}

function readBoundedString(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || HAS_CONTROL_CHARACTER.test(trimmed)) return "";
  return trimmed;
}

function readRawString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function combineSuccess(...values: unknown[]): boolean | undefined {
  let sawTrue = false;
  for (const value of values) {
    const normalized = readBoolean(value);
    if (normalized === false) return false;
    if (normalized === true) sawTrue = true;
  }
  return sawTrue ? true : undefined;
}
