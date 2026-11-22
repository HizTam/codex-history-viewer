import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { isRecord } from "../storage/sqliteRuntime";
import { ANTIGRAVITY_MAX_BLOB_BYTES, ANTIGRAVITY_MAX_COLLECTION_ITEMS, AntigravityReadError } from "./antigravityTypes";
import type { AntigravityIssue, AntigravityStep } from "./antigravityTypes";

const TYPES: Readonly<Record<string, number>> = { USER_INPUT: 14, PLANNER_RESPONSE: 15, GENERIC: 132 };
const STATUSES: Readonly<Record<string, number>> = { UNSPECIFIED: 0, GENERATING: 8, QUEUED: 11, PENDING: 1, RUNNING: 2, WAITING: 9, DONE: 3, INVALID: 4, CLEARED: 5, CANCELED: 6, ERROR: 7, INTERRUPTED: 12 };
interface Candidate { readonly step: AntigravityStep; readonly row: Record<string, unknown> }
export interface AntigravityJsonlFallback {
  readonly steps: ReadonlyMap<number, AntigravityStep>;
  readonly digest?: string;
  readonly issues: readonly AntigravityIssue[];
}

function bounded(value: unknown): boolean {
  const pending = [{ value, depth: 0 }]; let count = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++count > 100000 || current.depth > 32) return false;
    if (!current.value || typeof current.value !== "object") continue;
    const values = Object.values(current.value);
    if (values.length > ANTIGRAVITY_MAX_COLLECTION_ITEMS) return false;
    for (const item of values) pending.push({ value: item, depth: current.depth + 1 });
  }
  return true;
}
function missing(error: unknown): boolean { return isRecord(error) && error.code === "ENOENT"; }
function iso(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value)) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}
function project({ step, row }: Candidate): AntigravityStep | undefined {
  const content = typeof row.content === "string" ? row.content : "";
  const createdAtIso = iso(row.created_at);
  if (!createdAtIso || step.createdAtIso && step.createdAtIso !== createdAtIso) return undefined;
  const base = { ...step, createdAtIso, issues: [...new Set<AntigravityIssue>([...step.issues, "jsonlFallback"])] };
  // JSONL has no verified call IDs, execution IDs, terminal evidence or token semantics.
  if (step.type === 14 && row.source === "USER_EXPLICIT" && content) return { ...base, fallbackInput: content };
  if (row.source !== "MODEL") return undefined;
  if (step.type === 15) {
    const thinking = typeof row.thinking === "string" ? row.thinking : undefined;
    const fallbackTools = Array.isArray(row.tool_calls) ? row.tool_calls.flatMap(item => {
      if (!isRecord(item) || typeof item.name !== "string" || !item.name || item.name.length > 32768 || /[\u0000-\u001f]/.test(item.name) || !isRecord(item.args)) return [];
      return [{ name: item.name, argumentsJson: JSON.stringify(item.args) }];
    }) : [];
    if (!content && !thinking && !fallbackTools.length) return undefined;
    return { ...base, planner: { text: content, thinking, redactedThinking: false, tools: [] }, fallbackTools };
  }
  return step.type === 132 && content ? { ...base, fallbackOutput: content } : undefined;
}

// Only fixed conversation-local logs can supplement unsupported, verified DB steps.
export async function readAntigravityJsonl(root: string, conversationId: string, inventory: readonly AntigravityStep[], maximumBytes: number, check: () => void): Promise<AntigravityJsonlFallback> {
  const wanted = new Map(inventory.filter(step => step.issues.includes("unknownPayload") && !step.input && !step.planner && !step.generic && Object.values(TYPES).includes(step.type)).map(step => [step.index, step]));
  if (!wanted.size) return { steps: new Map(), issues: [] };
  let directory = root;
  for (const segment of ["brain", conversationId, ".system_generated", "logs"]) {
    directory = path.join(directory, segment);
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory) return { steps: new Map(), issues: ["invalidStep"] };
    } catch (error) { if (missing(error)) return { steps: new Map(), issues: [] }; throw error; }
  }
  let rejected = false;
  for (const name of ["transcript_full.jsonl", "transcript.jsonl"]) {
    const file = path.join(directory, name);
    let handle: fs.FileHandle | undefined;
    try {
      check(); const named = await fs.lstat(file, { bigint: true });
      if (!named.isFile() || named.isSymbolicLink() || await fs.realpath(file) !== file) { rejected = true; continue; }
      if (named.size > BigInt(maximumBytes)) { rejected = true; continue; }
      handle = await fs.open(file, "r"); const before = await handle.stat({ bigint: true });
      if (named.dev !== before.dev || named.ino !== before.ino || named.birthtimeNs !== before.birthtimeNs) throw new AntigravityReadError("sourceChanged");
      const digest = createHash("sha256"), steps = new Map<number, AntigravityStep>(), issues = new Set<AntigravityIssue>();
      const buffer = Buffer.alloc(65536), fragments: Buffer[] = []; let lineBytes = 0, total = 0, previous = -1, invalid = false;
      const line = (): void => {
        if (!lineBytes) return;
        const bytes = Buffer.concat(fragments, lineBytes); fragments.length = 0; lineBytes = 0;
        try {
          const row: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
          if (!isRecord(row) || !bounded(row) || typeof row.step_index !== "number" || !Number.isSafeInteger(row.step_index) || row.step_index < 0 || row.step_index <= previous
            || typeof row.type !== "string" || !Object.hasOwn(TYPES, row.type) || typeof row.status !== "string" || !Object.hasOwn(STATUSES, row.status)) { invalid = true; return; }
          previous = row.step_index;
          const step = wanted.get(row.step_index);
          if (!step) return;
          if (step.type !== TYPES[row.type] || step.status !== STATUSES[row.status]) { issues.add("invalidStep"); return; }
          const projected = project({ step, row });
          if (!projected) { issues.add("invalidStep"); return; }
          if (row.truncated_fields !== undefined) {
            if (!Array.isArray(row.truncated_fields) || !row.truncated_fields.every(item => typeof item === "string")) { invalid = true; return; }
            if (row.truncated_fields.length) issues.add("truncated");
          }
          steps.set(step.index, projected);
        } catch { invalid = true; }
      };
      while (true) {
        check(); const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > maximumBytes) throw new AntigravityReadError("sourceChanged");
        const chunk = buffer.subarray(0, bytesRead); digest.update(chunk);
        let start = 0;
        for (let index = 0; index <= chunk.length; index++) if (index === chunk.length || chunk[index] === 10) {
          const fragment = chunk.subarray(start, index); lineBytes += fragment.length;
          if (lineBytes > ANTIGRAVITY_MAX_BLOB_BYTES) { invalid = true; break; }
          if (fragment.length) fragments.push(Buffer.from(fragment));
          if (index < chunk.length) line();
          start = index + 1;
        }
        if (invalid) break;
      }
      if (lineBytes) { invalid = true; issues.add("truncated"); }
      const after = await handle.stat({ bigint: true }), current = await fs.lstat(file, { bigint: true });
      if (before.dev !== current.dev || before.ino !== current.ino || before.birthtimeNs !== current.birthtimeNs || current.isSymbolicLink()
        || before.size !== after.size || before.size !== current.size || before.mtimeNs !== after.mtimeNs || before.mtimeNs !== current.mtimeNs
        || before.ctimeNs !== after.ctimeNs || before.ctimeNs !== current.ctimeNs || total !== Number(before.size) && !invalid) throw new AntigravityReadError("sourceChanged");
      if (invalid) { rejected = true; continue; }
      if (steps.size) issues.add("jsonlFallback");
      return { steps, digest: steps.size ? digest.digest("hex") : undefined, issues: [...issues] };
    } catch (error) {
      if (missing(error) && !handle) continue;
      throw error;
    } finally { await handle?.close(); }
  }
  return { steps: new Map(), issues: rejected ? ["invalidStep"] : [] };
}
