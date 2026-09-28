import type { ChatPatchChangeType, ChatPatchEntry, ChatPatchHunk, ChatPatchRow } from "../chat/chatTypes";

const MAX_TEXT = 2 * 1024 * 1024;
const MAX_LINES = 20_000;
const MAX_FILES = 200;
const MAX_HUNKS = 2_048;
const MAX_DIFF_CELLS = 1_000_000;
const MAX_PENDING_RESULTS = 16;

export type ClaudeEditState = "unconfirmed" | "success" | "staged" | "error" | "interrupted";
type ToolKind = "edit" | "multiedit" | "write" | "bash";
type RecordValue = Record<string, unknown>;

export interface ClaudeEditResult {
  callId: string;
  state: ClaudeEditState;
  data?: RecordValue;
}

export interface ClaudeFileChangeProjection {
  entries: ChatPatchEntry[];
  incomplete: boolean;
}

export interface ClaudeFileChangeOperation<T> {
  readonly callId: string;
  readonly kind: ToolKind;
  readonly context: T;
  projection: ClaudeFileChangeProjection;
}

interface TrackedOperation<T> extends ClaudeFileChangeOperation<T> {
  input?: RecordValue;
}

// Keep only relevant tool data; all consumers share the same result precedence.
export class ClaudeFileChangeTracker<T> {
  readonly operations: ClaudeFileChangeOperation<T>[] = [];
  private readonly byId = new Map<string, TrackedOperation<T>>();
  private readonly pending = new Map<string, ClaudeEditResult>();

  register(call: { name?: string; input?: unknown }, callId: string, context: T): ClaudeFileChangeOperation<T> | undefined {
    const kind = readToolKind(call.name);
    if (!kind || !validId(callId) || this.byId.has(callId)) return undefined;
    const input = readInput(call.input);
    const pendingResult = this.pending.get(callId);
    let projection: ClaudeFileChangeProjection | undefined;
    const operation: TrackedOperation<T> = {
      callId, kind, context, input,
      // Most requests have a later result; do not materialize their provisional hunks twice.
      get projection() { return projection ??= projectClaudeFileChange(kind, input, callId, pendingResult); },
      set projection(value: ClaudeFileChangeProjection) { projection = value; },
    };
    this.pending.delete(callId);
    this.byId.set(callId, operation);
    this.operations.push(operation);
    return operation;
  }

  acceptResults(record: unknown): readonly ClaudeEditResult[] {
    const results = readClaudeEditResults(record);
    for (const result of results) {
      const operation = this.byId.get(result.callId);
      if (operation) {
        operation.projection = projectClaudeFileChange(operation.kind, operation.input, operation.callId, result);
      } else {
        // Out-of-order results are exceptional; bound their retained structured data.
        if (this.pending.size >= MAX_PENDING_RESULTS) this.pending.delete(this.pending.keys().next().value!);
        this.pending.set(result.callId, result);
      }
    }
    return results;
  }
}

export function readClaudeEditResults(record: unknown): ClaudeEditResult[] {
  if (!isRecord(record)) return [];
  const message = isRecord(record.message) ? record.message : record;
  const raw = Array.isArray(message.content) ? message.content : [message.content];
  const results = raw.filter((item): item is RecordValue => isRecord(item) && item.type === "tool_result");
  // A top-level sidecar cannot safely describe more than one tool result.
  const ambiguous = results.length > 1 && record.toolUseResult !== undefined;
  const data = results.length === 1 && isRecord(record.toolUseResult) ? sanitizeResult(record.toolUseResult) : undefined;
  return results.slice(0, MAX_FILES).flatMap((result) => {
    const callId = validId(result.tool_use_id) ? result.tool_use_id : undefined;
    if (!callId) return [];
    const state: ClaudeEditState = result.is_error === true ? "error"
      : data?.staged === true ? "staged"
        : data?.interrupted === true ? "interrupted"
          : ambiguous || data?.invalidState === true || (result.is_error !== undefined && result.is_error !== false) ? "unconfirmed" : "success";
    return [{ callId, state, ...(data ? { data } : {}) }];
  });
}

// Search uses the same validated structured hunks, independently of request text.
export function readClaudeResultChanges(result: ClaudeEditResult): ClaudeFileChangeProjection {
  if (result.state !== "success" || !result.data) return empty();
  const data = result.data;
  if (Object.hasOwn(data, "bashEditDiff")) return projectBash(data.bashEditDiff, result.callId);
  const filePath = readPath(data);
  if (!filePath) return empty();
  if (data.type === "create" || data.type === "update") return projectClaudeFileChange("write", undefined, result.callId, result);
  if (Object.hasOwn(data, "structuredPatch")) return projectStructured(data.structuredPatch, result.callId, filePath, "update");
  return empty();
}

export function claudeChangeSearchText(entries: readonly ChatPatchEntry[]): string {
  const chunks: string[] = [];
  let size = 0;
  for (const entry of entries) {
    chunks.push(entry.path);
    size += entry.path.length;
    for (const hunk of entry.hunks) {
      for (const row of hunk.rows) {
        const line = row.kind === "context" ? row.leftText
          : [row.leftText, row.rightText].filter(Boolean).join("\n");
        if (size + line.length > MAX_TEXT) return chunks.join("\n");
        chunks.push(line);
        size += line.length;
      }
    }
  }
  return chunks.join("\n");
}

function projectClaudeFileChange(kind: ToolKind, input: RecordValue | undefined, callId: string, result?: ClaudeEditResult): ClaudeFileChangeProjection {
  if (result && ["staged", "error", "interrupted"].includes(result.state)) return empty();
  if (kind === "bash") {
    const projection = result?.data && Object.hasOwn(result.data, "bashEditDiff") ? projectBash(result.data.bashEditDiff, callId) : empty();
    if (result?.state === "unconfirmed") {
      projection.incomplete = true;
      for (const entry of projection.entries) entry.evidence = "unconfirmed";
    }
    return projection;
  }
  const data = result?.data;
  if (data && ["filePath", "file_path", "path", "target_file", "targetPath"].some(key => Object.hasOwn(data, key)) && !readPath(data)) return empty(true);
  const filePath = readPath(data) ?? readPath(input);
  if (!filePath) return empty(true);
  const confirmed = result?.state === "success";
  if (data?.userModified === true && !Object.hasOwn(data, "structuredPatch")) {
    const hasActualText = kind === "write" ? readText(data, ["content"]) !== undefined
      : kind === "edit" && readText(data, ["oldString"]) !== undefined && readText(data, ["newString"]) !== undefined;
    if (!hasActualText) return empty(true);
  }
  let projection: ClaudeFileChangeProjection;
  if (data && Object.hasOwn(data, "structuredPatch")) {
    projection = projectStructured(data.structuredPatch, callId, filePath,
      kind === "write" ? data.type === "create" ? "create" : data.type === "update" ? "update" : "unknown" : "update");
    if (kind === "write" && Array.isArray(data.structuredPatch) && data.structuredPatch.length === 0) {
      const content = readText(data, ["content"]);
      const original = data.type === "create" ? "" : readText(data, ["originalFile"]);
      projection = content !== undefined && original !== undefined
        ? fromTexts(original, content, callId, filePath, data.type === "create" ? "create" : "update") : empty(true);
    } else if (kind !== "write" && Array.isArray(data.structuredPatch) && data.structuredPatch.length === 0) {
      const oldText = readText(data, ["oldString"]) ?? readText(input, ["old_string", "oldString"]);
      const newText = readText(data, ["newString"]) ?? readText(input, ["new_string", "newString"]);
      if (oldText !== newText || kind === "multiedit") projection.incomplete = true;
    }
  } else if (kind === "write") {
    const content = readText(data, ["content"]) ?? readText(input, ["content"]);
    const original = readText(data, ["originalFile"]);
    if (content === undefined) return empty(true);
    if (data?.type === "create") projection = fromTexts("", content, callId, filePath, "create");
    else if (original !== undefined) projection = fromTexts(original, content, callId, filePath, "update");
    else {
      projection = fromTexts("", content, callId, filePath, data?.type === "update" ? "update" : "unknown");
      projection.incomplete = true;
      for (const entry of projection.entries) { entry.incomplete = true; entry.evidence = "unconfirmed"; }
    }
  } else if (kind === "multiedit") {
    const edits = Array.isArray(input?.edits) ? input.edits : [];
    projection = empty(edits.length > MAX_HUNKS || !Array.isArray(input?.edits));
    const hunks: ChatPatchHunk[] = [];
    let added = 0, removed = 0, retainedRows = 0, retainedChars = 0;
    const workBudget = { cells: MAX_DIFF_CELLS };
    for (const edit of edits.slice(0, MAX_HUNKS)) {
      const oldText = readText(edit, ["old_string", "oldString"]);
      const newText = readText(edit, ["new_string", "newString"]);
      if (oldText === undefined || newText === undefined) { projection.incomplete = true; continue; }
      retainedChars += oldText.length + newText.length;
      if (retainedChars > MAX_TEXT) { projection.incomplete = true; break; }
      const next = fromTexts(oldText, newText, callId, filePath, "update", workBudget);
      projection.incomplete ||= next.incomplete;
      for (const entry of next.entries) {
        retainedRows += entry.hunks.reduce((sum, hunk) => sum + hunk.rows.length, 0);
        if (retainedRows > MAX_LINES) { projection.incomplete = true; break; }
        hunks.push(...entry.hunks); added += entry.added; removed += entry.removed;
      }
      if (retainedRows > MAX_LINES) break;
    }
    if (hunks.length) projection.entries.push(makeEntry(callId, 0, filePath, "update", hunks, added, removed));
  } else {
    const oldText = readText(data, ["oldString"]) ?? readText(input, ["old_string", "oldString"]);
    const newText = readText(data, ["newString"]) ?? readText(input, ["new_string", "newString"]);
    projection = oldText !== undefined && newText !== undefined
      ? fromTexts(oldText, newText, callId, filePath, "update") : empty(true);
    if (data?.replaceAll === true || input?.replace_all === true) projection.incomplete = true;
  }
  if (!confirmed) {
    projection.incomplete = true;
    for (const entry of projection.entries) entry.evidence = "unconfirmed";
  }
  if (projection.incomplete) for (const entry of projection.entries) entry.incomplete = true;
  return projection;
}

function projectBash(raw: unknown, callId: string): ClaudeFileChangeProjection {
  if (!isRecord(raw) || !Array.isArray(raw.files)) return empty(true);
  const projection = empty(raw.moreFiles !== 0 || raw.unavailable === true || raw.skipped === true || raw.shared === true || raw.files.length > MAX_FILES);
  let remaining = MAX_LINES, remainingChars = MAX_TEXT;
  for (const [index, file] of raw.files.slice(0, MAX_FILES).entries()) {
    if (!isRecord(file) || !readPath(file) || (file.created === true && file.deleted === true)) { projection.incomplete = true; continue; }
    const parsed = parseHunks(file.hunks, remaining);
    if (!parsed) { projection.incomplete = true; continue; }
    remainingChars -= parsed.chars;
    if (remainingChars < 0) { projection.incomplete = true; break; }
    remaining -= parsed.lines;
    if (!parsed.added && !parsed.removed && file.created !== true && file.deleted !== true) { projection.incomplete = true; continue; }
    const entry = makeEntry(callId, index, readPath(file)!, file.created === true ? "create" : file.deleted === true ? "delete" : "update", parsed.hunks, parsed.added, parsed.removed);
    if (raw.shared === true) entry.evidence = "shared";
    projection.entries.push(entry);
  }
  if (projection.incomplete) for (const entry of projection.entries) entry.incomplete = true;
  return projection;
}

function projectStructured(raw: unknown, callId: string, filePath: string, changeType: ChatPatchChangeType): ClaudeFileChangeProjection {
  const parsed = parseHunks(raw, MAX_LINES);
  if (!parsed) return empty(true);
  if (!parsed.added && !parsed.removed && changeType !== "create") return empty();
  return { entries: [makeEntry(callId, 0, filePath, changeType, parsed.hunks, parsed.added, parsed.removed)], incomplete: false };
}

function parseHunks(raw: unknown, limit: number): { hunks: ChatPatchHunk[]; added: number; removed: number; lines: number; chars: number } | undefined {
  if (!Array.isArray(raw) || raw.length > MAX_HUNKS) return undefined;
  const hunks: ChatPatchHunk[] = [];
  let added = 0, removed = 0, lines = 0, chars = 0;
  let previousOldEnd = 0, previousNewEnd = 0;
  for (const hunk of raw) {
    if (!isRecord(hunk) || !Array.isArray(hunk.lines)) return undefined;
    const { oldStart, oldLines, newStart, newLines } = hunk;
    if (![oldStart, oldLines, newStart, newLines].every(safeCount)) return undefined;
    const oldAt = oldStart as number, newAt = newStart as number, oldCount = oldLines as number, newCount = newLines as number;
    if ((oldCount > 0 && oldAt === 0) || (newCount > 0 && newAt === 0)
      || oldAt < previousOldEnd || newAt < previousNewEnd
      || !Number.isSafeInteger(oldAt + oldCount) || !Number.isSafeInteger(newAt + newCount)) return undefined;
    lines += hunk.lines.length;
    if (lines > limit) return undefined;
    const rows: ChatPatchRow[] = [];
    let left = oldAt, right = newAt;
    for (const rawLine of hunk.lines) {
      if (typeof rawLine !== "string") return undefined;
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.includes("\n") || line.includes("\r")) return undefined;
      chars += line.length;
      if (chars > MAX_TEXT) return undefined;
      if (line === "\\ No newline at end of file") continue;
      const text = line.slice(1);
      if (line.startsWith(" ")) rows.push({ kind: "context", leftLine: left++, rightLine: right++, leftText: text, rightText: text });
      else if (line.startsWith("-")) { removed++; rows.push({ kind: "delete", leftLine: left++, leftText: text, rightText: "" }); }
      else if (line.startsWith("+")) { added++; rows.push({ kind: "add", rightLine: right++, leftText: "", rightText: text }); }
      else return undefined;
    }
    if (left - oldAt !== oldCount || right - newAt !== newCount) return undefined;
    previousOldEnd = oldAt + oldCount;
    previousNewEnd = newAt + newCount;
    hunks.push({ header: `@@ -${oldAt},${oldCount} +${newAt},${newCount} @@`, rows: pairRows(rows) });
  }
  return { hunks, added, removed, lines, chars };
}

// Pair adjacent deletions/additions for the existing side-by-side renderer.
function pairRows(rows: ChatPatchRow[]): ChatPatchRow[] {
  const out: ChatPatchRow[] = [];
  for (let i = 0; i < rows.length;) {
    if (rows[i]!.kind === "context") { out.push(rows[i++]!); continue; }
    const deleted: ChatPatchRow[] = [], added: ChatPatchRow[] = [];
    while (i < rows.length && rows[i]!.kind !== "context") {
      const row = rows[i++]!;
      (row.kind === "delete" ? deleted : added).push(row);
    }
    for (let j = 0; j < Math.max(deleted.length, added.length); j++) {
      const left = deleted[j], right = added[j];
      out.push({ kind: left && right ? "modify" : left ? "delete" : "add",
        ...(left ? { leftLine: left.leftLine } : {}), ...(right ? { rightLine: right.rightLine } : {}),
        leftText: left?.leftText ?? "", rightText: right?.rightText ?? "" });
    }
  }
  return out;
}

function fromTexts(before: string, after: string, callId: string, filePath: string, changeType: ChatPatchChangeType, budget = { cells: MAX_DIFF_CELLS }): ClaudeFileChangeProjection {
  if (before === after && changeType !== "create") return empty();
  const oldLines = splitLines(before), newLines = splitLines(after);
  if (oldLines.length + newLines.length > MAX_LINES) return empty(true);
  let prefix = 0, suffix = 0;
  while (prefix < Math.min(oldLines.length, newLines.length) && oldLines[prefix] === newLines[prefix]) prefix++;
  while (suffix < Math.min(oldLines.length, newLines.length) - prefix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++;
  const left = oldLines.slice(prefix, oldLines.length - suffix), right = newLines.slice(prefix, newLines.length - suffix);
  if (!left.length && !right.length && before !== after) return empty(true);
  const cells = (left.length + 1) * (right.length + 1);
  if (cells > budget.cells) return empty(true);
  budget.cells -= cells;
  const width = right.length + 1;
  const lcs = new Uint32Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) {
    lcs[i * width + j] = left[i] === right[j] ? 1 + lcs[(i + 1) * width + j + 1]!
      : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
  }
  const rows: ChatPatchRow[] = [];
  let i = 0, j = 0, added = 0, removed = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      rows.push({ kind: "context", leftLine: prefix + i + 1, rightLine: prefix + j + 1, leftText: left[i++]!, rightText: right[j++]! });
    } else if (i < left.length && (j === right.length || lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!)) {
      removed++; rows.push({ kind: "delete", leftLine: prefix + i + 1, leftText: left[i++]!, rightText: "" });
    } else { added++; rows.push({ kind: "add", rightLine: prefix + j + 1, leftText: "", rightText: right[j++]! }); }
  }
  const header = `@@ -${left.length ? prefix + 1 : prefix},${left.length} +${right.length ? prefix + 1 : prefix},${right.length} @@`;
  return { entries: [makeEntry(callId, 0, filePath, changeType, [{ header, rows: pairRows(rows) }], added, removed)], incomplete: false };
}

function makeEntry(callId: string, index: number, filePath: string, changeType: ChatPatchChangeType, hunks: ChatPatchHunk[], added: number, removed: number): ChatPatchEntry {
  return { id: `${callId}:${index}`, callId, path: filePath, displayPath: filePath, changeType, added, removed, hunks };
}

function sanitizeResult(data: RecordValue): RecordValue {
  const out: RecordValue = {};
  if (["staged", "interrupted"].some(key => data[key] !== undefined && typeof data[key] !== "boolean")) out.invalidState = true;
  for (const key of ["staged", "interrupted", "type", "filePath", "oldString", "newString", "originalFile", "content", "replaceAll", "userModified"]) {
    const value = data[key];
    if (typeof value === "boolean" || value === null || (typeof value === "string" && value.length <= MAX_TEXT)) out[key] = value;
  }
  if (Object.hasOwn(data, "filePath") && !Object.hasOwn(out, "filePath")) out.filePath = null;
  // Retain normalized, bounded data instead of arbitrary tool-result objects.
  if (Object.hasOwn(data, "structuredPatch")) out.structuredPatch = boundedHunks(data.structuredPatch);
  if (Object.hasOwn(data, "bashEditDiff")) {
    const bash = data.bashEditDiff;
    const budget = { lines: MAX_LINES, chars: MAX_TEXT };
    out.bashEditDiff = isRecord(bash) ? {
      moreFiles: safeCount(bash.moreFiles) ? bash.moreFiles : undefined,
      unavailable: bash.unavailable !== undefined && bash.unavailable !== false,
      skipped: bash.skipped !== undefined && bash.skipped !== false,
      shared: bash.shared !== undefined && bash.shared !== false,
      files: Array.isArray(bash.files) ? bash.files.slice(0, MAX_FILES + 1).map(file => isRecord(file)
        ? { filePath: readPath(file), created: file.created === true, deleted: file.deleted === true, hunks: boundedHunks(file.hunks, budget) } : null) : null,
    } : null;
  }
  return out;
}

function boundedHunks(value: unknown, budget = { lines: MAX_LINES, chars: MAX_TEXT }): unknown {
  // Validate first so malformed or oversized values cannot survive in pending results.
  if (budget.lines <= 0 || budget.chars <= 0) return null;
  const parsed = parseHunks(value, budget.lines);
  if (!parsed || parsed.chars > budget.chars) return null;
  budget.lines -= parsed.lines;
  budget.chars -= parsed.chars;
  return (value as RecordValue[]).map(hunk => ({ oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines,
    lines: [...hunk.lines as string[]] }));
}

function readInput(value: unknown, includeEdits = true): RecordValue | undefined {
  if (typeof value === "string" && value.length <= MAX_TEXT) {
    try { value = JSON.parse(value); } catch { return undefined; }
  }
  if (!isRecord(value)) return undefined;
  const out: RecordValue = {};
  for (const key of ["file_path", "filePath", "path", "target_file", "targetPath", "old_string", "oldString", "new_string", "newString", "content", "replace_all"]) {
    const field = value[key];
    if (typeof field === "boolean" || (typeof field === "string" && field.length <= MAX_TEXT)) out[key] = field;
  }
  if (includeEdits && Array.isArray(value.edits)) out.edits = value.edits.slice(0, MAX_HUNKS + 1).map(edit => readInput(edit, false));
  return out;
}

function readToolKind(value: unknown): ToolKind | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  return normalized === "edit" || normalized === "multiedit" || normalized === "write" || normalized === "bash" ? normalized : undefined;
}

function readPath(value: unknown): string | undefined {
  const text = readText(value, ["filePath", "file_path", "path", "target_file", "targetPath"]);
  return text && text.trim() && text.length <= 32_768 && !/[\u0000-\u001f\u007f-\u009f]/u.test(text)
    && (!/^[a-z][a-z0-9+.-]*:/iu.test(text) || /^[a-z]:[\\/]/iu.test(text)) ? text : undefined;
}

function readText(value: unknown, keys: readonly string[]): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) if (typeof value[key] === "string" && value[key].length <= MAX_TEXT) return value[key];
  return undefined;
}

function validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value); }
function safeCount(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function isRecord(value: unknown): value is RecordValue { return !!value && typeof value === "object" && !Array.isArray(value); }
function splitLines(value: string): string[] { const lines = value.replace(/\r\n?/gu, "\n").split("\n"); if (lines.at(-1) === "") lines.pop(); return lines; }
function empty(incomplete = false): ClaudeFileChangeProjection { return { entries: [], incomplete }; }
