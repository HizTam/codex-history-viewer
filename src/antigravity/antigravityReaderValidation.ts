import * as path from "node:path";
import { ANTIGRAVITY_FILE_EDIT_BUDGET, inspectAntigravityFileEdit } from "./antigravityFileEdit";
import { isRecord } from "../storage/sqliteRuntime";
import { ANTIGRAVITY_MAX_COLLECTION_ITEMS, ANTIGRAVITY_MAX_SESSION_BYTES, ANTIGRAVITY_MAX_SESSIONS, ANTIGRAVITY_MAX_SUMMARY_BYTES, ANTIGRAVITY_PROFILE, ANTIGRAVITY_UUID, AntigravityReadError, antigravitySummarySize } from "./antigravityTypes";
import type { AntigravityErrorCode, AntigravitySummaryRecord } from "./antigravityTypes";
import type { AntigravityReaderRequest, AntigravityReaderResult } from "./antigravityReaderTypes";

const CODES = new Set<AntigravityErrorCode>(["runtime", "storage", "schema", "format", "corrupt", "busy", "sourceChanged", "sourceUnavailable", "cancelled", "deadline", "stalled", "limit"]);
const ISSUES = new Set(["unknownStep", "invalidStep", "unknownPayload", "unmatchedTool", "duplicateTool", "truncated", "unsupportedAttachment", "unknownUsage", "jsonlFallback"]);
export function isAntigravityErrorCode(value: unknown): value is AntigravityErrorCode { return typeof value === "string" && CODES.has(value as AntigravityErrorCode); }
const number = (value: unknown): boolean => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown, maximum = 32768): boolean => typeof value === "string" && value.length <= maximum;
const optionalText = (value: unknown): boolean => value === undefined || text(value, 16 * 1024 * 1024);
const array = (value: unknown, limit: number): value is unknown[] => Array.isArray(value) && value.length <= limit;
const issues = (value: unknown): boolean => array(value, ISSUES.size) && value.every(item => typeof item === "string" && ISSUES.has(item));
const date = (value: unknown): boolean => value === undefined || typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
function metadata(value: unknown): boolean {
  return isRecord(value) && typeof value.conversationId === "string" && ANTIGRAVITY_UUID.test(value.conversationId)
    && typeof value.trajectoryId === "string" && ANTIGRAVITY_UUID.test(value.trajectoryId) && date(value.createdAtIso)
    && array(value.workspaceUris, ANTIGRAVITY_MAX_COLLECTION_ITEMS) && value.workspaceUris.every(item => text(item));
}
function tool(value: unknown): boolean {
  return isRecord(value) && text(value.id) && Boolean(value.id) && text(value.name) && Boolean(value.name) && text(value.argumentsJson, 16 * 1024 * 1024);
}
function step(value: unknown): boolean {
  if (!isRecord(value) || !number(value.index) || !number(value.type) || !number(value.status) || !issues(value.issues)
    || !date(value.createdAtIso) || !date(value.startedAtIso) || !date(value.completedAtIso) || !optionalText(value.executionId)
    || value.tool !== undefined && !tool(value.tool)) return false;
  if (value.usage !== undefined) {
    const usage = value.usage;
    if (!isRecord(usage) || ![usage.model, usage.messageId, usage.responseId].every(optionalText)
      || !["modelNumber", "providerNumber", "inputTokens", "outputTokens", "thinkingOutputTokens", "responseOutputTokens", "cacheReadTokens", "cacheWriteTokens"].every(key => usage[key] === undefined || number(usage[key]))) return false;
  }
  if (value.input !== undefined) {
    const input = value.input;
    if (!isRecord(input) || !text(input.text, 16 * 1024 * 1024) || typeof input.queued !== "boolean" || !optionalText(input.clientMessageId)
      || !array(input.attachments, ANTIGRAVITY_MAX_COLLECTION_ITEMS) || !input.attachments.every(item => isRecord(item) && (item.kind === "image" || item.kind === "file") && [item.uri, item.path, item.label, item.mimeType, item.base64].every(optionalText))) return false;
  }
  if (value.planner !== undefined) {
    const planner = value.planner;
    if (!isRecord(planner) || !text(planner.text, 16 * 1024 * 1024) || !optionalText(planner.thinking) || !optionalText(planner.messageId)
      || typeof planner.redactedThinking !== "boolean" || planner.thinkingDurationMs !== undefined && !number(planner.thinkingDurationMs)
      || planner.stopReason !== undefined && !number(planner.stopReason) || !array(planner.tools, ANTIGRAVITY_MAX_COLLECTION_ITEMS) || !planner.tools.every(tool)) return false;
  }
  if (value.generic !== undefined) {
    const generic = value.generic;
    if (!isRecord(generic) || !isRecord(generic.arguments) || Object.keys(generic.arguments).length > ANTIGRAVITY_MAX_COLLECTION_ITEMS
      || !Object.entries(generic.arguments).every(([key, item]) => text(key) && text(item, 16 * 1024 * 1024))
      || !text(generic.output, 16 * 1024 * 1024) || typeof generic.hidden !== "boolean"
      || !array(generic.files, ANTIGRAVITY_MAX_COLLECTION_ITEMS) || !generic.files.every(item => isRecord(item) && text(item.uri)
        && (item.hasDiffStats === undefined || item.hasDiffStats === true)
        && (item.additions === undefined || number(item.additions)) && (item.deletions === undefined || number(item.deletions)))) return false;
  }
  if (!optionalText(value.fallbackInput) || !optionalText(value.fallbackOutput) || value.fallbackTools !== undefined && (!array(value.fallbackTools, ANTIGRAVITY_MAX_COLLECTION_ITEMS)
    || !value.fallbackTools.every(item => isRecord(item) && text(item.name) && Boolean(item.name) && text(item.argumentsJson, 16 * 1024 * 1024)))) return false;
  return true;
}
export function validateAntigravityRequest(value: unknown): AntigravityReaderRequest {
  if (!isRecord(value) || !["summaries", "session", "metadata"].includes(String(value.kind))) throw new AntigravityReadError("format");
  if (value.includeFileEdits !== undefined && (value.kind !== "session" || value.includeFileEdits !== true)) throw new AntigravityReadError("format");
  const locator = value.kind === "summaries" ? undefined : value.locator;
  const root = value.kind === "summaries" ? value.rootPath : isRecord(locator) ? locator.rootPath : undefined;
  if (!text(root) || typeof root !== "string" || !path.isAbsolute(root) || /[\u0000-\u001f]/.test(root)) throw new AntigravityReadError("storage");
  if (value.kind !== "summaries" && (!isRecord(locator) || locator.schemaProfile !== ANTIGRAVITY_PROFILE
    || typeof locator.conversationId !== "string" || !ANTIGRAVITY_UUID.test(locator.conversationId)
    || locator.conversationFsPath !== path.join(root, "conversations", locator.conversationId + ".db"))) throw new AntigravityReadError("storage");
  return value as unknown as AntigravityReaderRequest;
}
function validateFileEdits(value: Record<string, unknown>, steps: readonly unknown[]): boolean {
  if (value.fileEditScanIncomplete !== undefined && value.fileEditScanIncomplete !== true) return false;
  const edits = value.fileEdits;
  const unavailable = value.unavailableFileEditSteps === undefined ? [] : value.unavailableFileEditSteps;
  if (!array(edits, ANTIGRAVITY_FILE_EDIT_BUDGET.records) || Object.keys(edits).length !== edits.length
    || !array(unavailable, ANTIGRAVITY_FILE_EDIT_BUDGET.unavailableSteps) || Object.keys(unavailable).length !== unavailable.length) return false;
  let stepPosition = 0, last = -1, bytes = 0, lines = 0;
  const published = new Set<number>();
  function isFileEditStep(index: number): boolean {
    while (stepPosition < steps.length && (steps[stepPosition] as { index: number }).index < index) stepPosition++;
    const step = steps[stepPosition] as { index: number; type: number; generic?: unknown } | undefined;
    return step?.index === index && step.type === 132 && !!step.generic;
  }
  for (const row of edits) {
    if (!isRecord(row) || Object.keys(row).length !== 2 || typeof row.stepIndex !== "number" || !number(row.stepIndex) || row.stepIndex <= last) return false;
    last = row.stepIndex;
    if (!isFileEditStep(last)) return false;
    published.add(last);
    const decoded = inspectAntigravityFileEdit(row.edit);
    if (!decoded) return false;
    bytes += decoded.bytes; lines += decoded.edit.lines.length;
    if (bytes > ANTIGRAVITY_FILE_EDIT_BUDGET.bytes || lines > ANTIGRAVITY_FILE_EDIT_BUDGET.lines) return false;
  }
  stepPosition = 0; last = -1;
  for (const index of unavailable) {
    if (typeof index !== "number" || !number(index) || index <= last || published.has(index) || !isFileEditStep(index)) return false;
    last = index;
  }
  return true;
}

const SUMMARY_FIELDS = new Set(["conversationId", "title", "preview", "stepCount", "lastModifiedIso", "workspaceUris", "status", "notFullyIdle", "killed"]);

function validateSummaries(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length !== 2 || typeof value.partial !== "boolean" ||
      !array(value.summaries, ANTIGRAVITY_MAX_SESSIONS) || Object.keys(value.summaries).length !== value.summaries.length) return false;
  let bytes = 0;
  for (const item of value.summaries) {
    if (!isRecord(item) || !Object.keys(item).every(key => SUMMARY_FIELDS.has(key)) ||
        typeof item.conversationId !== "string" || !ANTIGRAVITY_UUID.test(item.conversationId) ||
        !text(item.title) || !text(item.preview) || !number(item.stepCount) || !date(item.lastModifiedIso) ||
        !array(item.workspaceUris, ANTIGRAVITY_MAX_COLLECTION_ITEMS) || Object.keys(item.workspaceUris).length !== item.workspaceUris.length ||
        !item.workspaceUris.every(uri => text(uri)) || !text(item.status, 256) ||
        typeof item.notFullyIdle !== "boolean" || typeof item.killed !== "boolean") return false;
    bytes += antigravitySummarySize(item as unknown as AntigravitySummaryRecord);
    if (!Number.isFinite(bytes) || bytes > ANTIGRAVITY_MAX_SUMMARY_BYTES) return false;
  }
  return true;
}

export function validateAntigravityResult(request: AntigravityReaderRequest, value: unknown): AntigravityReaderResult {
  if (request.kind === "summaries") {
    if (!validateSummaries(value)) throw new AntigravityReadError("format");
    return value as AntigravityReaderResult;
  }
  let valid = false;
  if (request.kind === "metadata") valid = metadata(value) && isRecord(value) && value.conversationId === request.locator.conversationId;
  else if (request.kind === "session") {
    if (isRecord(value) && metadata(value.metadata) && isRecord(value.metadata) && value.metadata.conversationId === request.locator.conversationId
      && typeof value.digest === "string" && /^[0-9a-f]{64}$/.test(value.digest) && issues(value.issues) && array(value.steps, 200000)) {
      let previous = -1;
      valid = value.steps.every(item => {
        if (!step(item) || !isRecord(item) || typeof item.index !== "number" || item.index <= previous) return false;
        previous = item.index; return true;
      });
      valid &&= request.includeFileEdits === true ? validateFileEdits(value, value.steps)
        : value.fileEdits === undefined && value.unavailableFileEditSteps === undefined && value.fileEditScanIncomplete === undefined;
    }
  }
  // Avoid assembling a giant JSON string just to validate a structured-clone reply.
  let bytes = 0, nodes = 0;
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }], seen = new Set<object>();
  while (valid && pending.length) {
    const current = pending.pop()!;
    if (++nodes > 2000000 || current.depth > 32) { valid = false; break; }
    if (typeof current.value === "string") bytes += Buffer.byteLength(current.value, "utf8");
    else if (current.value && typeof current.value === "object") {
      if (seen.has(current.value)) { valid = false; break; }
      seen.add(current.value);
      for (const [key, item] of Object.entries(current.value)) {
        // The typed and bounded optional channel is validated independently of the original reply.
        if (current.value === value && request.kind === "session" && (key === "fileEdits" || key === "unavailableFileEditSteps")) continue;
        pending.push({ value: item, depth: current.depth + 1 });
      }
    }
    if (bytes > ANTIGRAVITY_MAX_SESSION_BYTES * 2) valid = false;
  }
  if (!valid) throw new AntigravityReadError("format");
  return value as AntigravityReaderResult;
}
