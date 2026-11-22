import * as path from "node:path";
import { isRecord } from "../storage/sqliteRuntime";
import { AntigravityProto, AntigravityProtoError } from "./antigravityProto";
import type { AntigravityFileEdit } from "./antigravityTypes";

const FILE_EDIT_TYPE_URL = "type.googleapis.com/exa.cortex.core.tools.FileEdit";
const MAX_FILE_EDIT_BYTES = 1024 * 1024;
const MAX_FILE_EDIT_LINES = 8192;
export const ANTIGRAVITY_FILE_EDIT_BUDGET = Object.freeze({ bytes: 2 * 1024 * 1024, lines: 50000, records: 1000, unavailableSteps: 10000 });

export function normalizeAntigravityEditPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 32768 || !path.isAbsolute(value) || /^[\\/]{2}|[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  // Windows drive-relative, device, and alternate-stream paths are not local file identities.
  if (process.platform === "win32" && (!/^[a-z]:[\\/]/iu.test(value) || value.indexOf(":", 2) !== -1)) return undefined;
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized[0]!.toLowerCase() + normalized.slice(1) : normalized;
}

function rangeValue(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 0x7fffffff;
}

function isEditKind(value: unknown): value is 1 | 2 | 3 {
  return value === 1 || value === 2 || value === 3;
}

export function inspectAntigravityFileEdit(value: unknown): { edit: AntigravityFileEdit; bytes: number } | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 5 || typeof value.path !== "string" || normalizeAntigravityEditPath(value.path) !== value.path
    || !isEditKind(value.kind) || !rangeValue(value.start) || !rangeValue(value.end) || value.start > value.end
    || value.kind === 1 && value.end !== 0 || !Array.isArray(value.lines) || value.lines.length > MAX_FILE_EDIT_LINES
    || Object.keys(value.lines).length !== value.lines.length) return undefined;
  let bytes = Buffer.byteLength(value.path, "utf8"), before = 0;
  for (const line of value.lines) {
    if (!isRecord(line) || Object.keys(line).length !== 2 || !isEditKind(line.kind) || typeof line.text !== "string" || line.text.includes("\n")) return undefined;
    bytes += Buffer.byteLength(line.text, "utf8");
    if (bytes > MAX_FILE_EDIT_BYTES) return undefined;
    if (line.kind !== 1) before++;
  }
  if (before !== value.end - value.start) return undefined;
  return { edit: value as unknown as AntigravityFileEdit, bytes };
}

// A null result preserves the presence of a recognized FileEdit whose contents cannot be used.
export function decodeAntigravityFileEdit(result: AntigravityProto, includeEditContent: boolean): { edit: AntigravityFileEdit; bytes: number } | null | undefined {
  let recognized = false;
  try {
    const any = result.message(6);
    if (any?.string(1, 256) !== FILE_EDIT_TYPE_URL) return undefined;
    recognized = true;
    if (!includeEditContent) return null;
    const raw = any.bytes(2);
    if (!raw || raw.byteLength > MAX_FILE_EDIT_BYTES) return null;
    const value = any.message(2)!;
    if (value.boolean(6) === true) return null;
    const diff = value.message(3);
    const unified = diff?.message(3);
    if (!diff || !unified) return null;
    const lines = unified.messages(3).map(line => ({ kind: line.integer(2), text: line.string(1, MAX_FILE_EDIT_BYTES) ?? "" }));
    const decoded = inspectAntigravityFileEdit({ kind: value.integer(1), path: normalizeAntigravityEditPath(value.string(2, 32768)),
      start: diff.integer(1) ?? 0, end: diff.integer(2) ?? 0, lines });
    if (!decoded) return null;
    const stats = value.message(4);
    if (stats) {
      const added = decoded.edit.lines.filter(line => line.kind === 1).length;
      const removed = decoded.edit.lines.filter(line => line.kind === 2).length;
      if ((stats.integer(1, true) ?? 0) !== added || (stats.integer(2, true) ?? 0) !== removed) return null;
    }
    return decoded;
  } catch (error) {
    // An invalid optional edit does not displace the original tool result or conversation.
    if (!(error instanceof AntigravityProtoError)) throw error;
    return recognized ? null : undefined;
  }
}
