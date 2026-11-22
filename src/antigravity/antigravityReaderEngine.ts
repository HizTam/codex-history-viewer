import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { configureSqliteConnection, isRecord, loadSqliteModule, safeSqliteError, type SqliteDatabase, type SqliteRow } from "../storage/sqliteRuntime";
import { decodeAntigravityMetadata, decodeAntigravityStep } from "./antigravityTranscript";
import { ANTIGRAVITY_FILE_EDIT_BUDGET, type decodeAntigravityFileEdit } from "./antigravityFileEdit";
import { AntigravityProtoError } from "./antigravityProto";
import { readAntigravityJsonl } from "./antigravityJsonl";
import { ANTIGRAVITY_MAX_BLOB_BYTES, ANTIGRAVITY_MAX_COLLECTION_ITEMS, ANTIGRAVITY_MAX_SESSION_BYTES, ANTIGRAVITY_MAX_SESSIONS, ANTIGRAVITY_MAX_SUMMARY_BYTES, ANTIGRAVITY_PROFILE, ANTIGRAVITY_UUID, AntigravityReadError, antigravitySummarySize } from "./antigravityTypes";
import type { AntigravityIssue, AntigravityMetadata, AntigravityStep, AntigravitySummaryRecord } from "./antigravityTypes";
import type { AntigravityReaderRequest, AntigravityReaderResult, AntigravitySessionData, AntigravitySummaryData } from "./antigravityReaderTypes";

const MAX_COLUMNS = 128, PAGE_BYTES = 8 * 1024 * 1024, MAX_STEPS = 200000;
const TABLES = {
  trajectory_meta: { trajectory_id: "TEXT", cascade_id: "TEXT" },
  trajectory_metadata_blob: { id: "TEXT", data: "BLOB" },
  steps: { idx: "INTEGER", step_type: "INTEGER", status: "INTEGER", metadata: "BLOB", render_info: "BLOB", step_payload: "BLOB", step_format: "INTEGER" },
  conversation_summaries: { conversation_id: "TEXT", title: "TEXT", preview: "TEXT", step_count: "INTEGER", last_modified_time: "NUMERIC", workspace_uris: "TEXT", status: "TEXT", not_fully_idle: "NUMERIC", killed: "NUMERIC" },
} as const;
type Table = keyof typeof TABLES;
type Identity = { readonly dev: bigint; readonly ino: bigint; readonly birthtimeNs: bigint };

function integer(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new AntigravityReadError("schema");
  return value;
}
function string(value: unknown, maximum = 32768): string {
  if (typeof value !== "string" || value.length > maximum || value.includes("\0")) throw new AntigravityReadError("schema");
  return value;
}
function blob(value: unknown): Uint8Array | undefined {
  if (value === null || value === undefined) return undefined;
  if (!(value instanceof Uint8Array) || value.byteLength > ANTIGRAVITY_MAX_BLOB_BYTES) throw new AntigravityReadError("limit");
  return value;
}
function text(value: unknown, maximum = 32768): string {
  if (!(value instanceof Uint8Array) || value.byteLength > maximum) throw new AntigravityReadError("schema");
  try { return string(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value), maximum); }
  catch { throw new AntigravityReadError("schema"); }
}
function affinity(type: string): string {
  const upper = type.toUpperCase();
  return upper.includes("INT") ? "INTEGER" : /CHAR|CLOB|TEXT/.test(upper) ? "TEXT" : !upper || upper.includes("BLOB") ? "BLOB" : /REAL|FLOA|DOUB/.test(upper) ? "REAL" : "NUMERIC";
}
function validateTable(db: SqliteDatabase, name: Table): void {
  const entry = db.prepare("SELECT type, CASE WHEN length(sql) <= 32768 THEN sql END AS sql FROM sqlite_schema WHERE name=? LIMIT 2").all(name);
  if (entry.length !== 1 || entry[0]?.type !== "table" || typeof entry[0].sql !== "string" || /CREATE\s+VIRTUAL\s+TABLE/i.test(entry[0].sql)) throw new AntigravityReadError("schema");
  const columns = new Map<string, SqliteRow>();
  for (const row of db.prepare(`PRAGMA table_info("${name}")`).iterate()) {
    if (columns.size >= MAX_COLUMNS) throw new AntigravityReadError("schema");
    columns.set(string(row.name), row);
  }
  for (const [column, expected] of Object.entries(TABLES[name])) {
    const row = columns.get(column);
    if (!row || affinity(string(row.type)) !== expected) throw new AntigravityReadError("schema");
  }
  const primary = name === "steps" ? "idx" : name === "trajectory_meta" ? "trajectory_id" : name === "trajectory_metadata_blob" ? "id" : "conversation_id";
  if (columns.get(primary)?.pk !== 1 || [...columns.values()].filter(row => row.pk !== 0).length !== 1) throw new AntigravityReadError("schema");
  if (name === "steps" && columns.get("idx")?.type !== "INTEGER") throw new AntigravityReadError("schema");
}

function isSameIdentity(left: Identity, right: Identity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}
async function validateFile(rootPath: string, file: string, summaries: boolean): Promise<Identity> {
  if (!path.isAbsolute(rootPath) || !path.isAbsolute(file) || rootPath.startsWith("\\\\") || file.startsWith("\\\\") || /[\u0000-\u001f]/.test(rootPath + file)) throw new AntigravityReadError("storage");
  const root = await fs.realpath(rootPath);
  if (path.relative(root, rootPath) !== "") throw new AntigravityReadError("storage");
  const expectedDirectory = summaries ? root : path.join(root, "conversations");
  const directory = await fs.lstat(expectedDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink() || path.relative(root, await fs.realpath(expectedDirectory)) !== (summaries ? "" : "conversations")) throw new AntigravityReadError("storage");
  if (path.dirname(file) !== expectedDirectory || (summaries ? path.basename(file) !== "conversation_summaries.db" : !ANTIGRAVITY_UUID.test(path.basename(file, ".db")) || path.extname(file) !== ".db")) throw new AntigravityReadError("storage");
  let identity: Identity | undefined;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      const stat = await fs.lstat(file + suffix, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || path.dirname(await fs.realpath(file + suffix)) !== expectedDirectory) throw new AntigravityReadError("storage");
      if (!suffix) identity = stat;
    } catch (error) {
      if (!suffix || !isRecord(error) || error.code !== "ENOENT") throw error;
    }
  }
  if (!identity) throw new AntigravityReadError("sourceUnavailable");
  return identity;
}

function readMetadata(db: SqliteDatabase, conversationId: string): AntigravityMetadata {
  validateTable(db, "trajectory_meta"); validateTable(db, "trajectory_metadata_blob");
  const rows = db.prepare("SELECT CASE WHEN length(trajectory_id)<=128 THEN trajectory_id END AS trajectory_id, CASE WHEN length(cascade_id)<=128 THEN cascade_id END AS cascade_id FROM trajectory_meta LIMIT 2").all();
  if (rows.length !== 1 || rows[0]?.cascade_id !== conversationId) throw new AntigravityReadError("schema");
  const trajectoryId = string(rows[0].trajectory_id, 128);
  const row = db.prepare(`SELECT typeof(data) AS kind, length(data) AS bytes, CASE WHEN typeof(data)='blob' AND length(data)<=${ANTIGRAVITY_MAX_BLOB_BYTES} THEN data END AS data FROM trajectory_metadata_blob WHERE id='main'`).get();
  if (row && (row.kind !== "blob" || integer(row.bytes) > ANTIGRAVITY_MAX_BLOB_BYTES)) throw new AntigravityReadError("limit");
  return decodeAntigravityMetadata(conversationId, trajectoryId, blob(row?.data));
}

function parseSummary(row: SqliteRow): AntigravitySummaryRecord {
  const conversationId = text(row.conversation_id, 128);
  if (!ANTIGRAVITY_UUID.test(conversationId)) throw new AntigravityReadError("format");
  const workspaceJson: unknown = JSON.parse(text(row.workspace_uris, 1048576));
  if (!Array.isArray(workspaceJson) || workspaceJson.length > ANTIGRAVITY_MAX_COLLECTION_ITEMS || !workspaceJson.every(value => typeof value === "string" && value.length <= 32768 && !value.includes("\0"))) throw new AntigravityReadError("format");
  const lastModified = row.last_modified_time === null ? "" : text(row.last_modified_time, 128);
  const milliseconds = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?$/.test(lastModified) ? Date.parse(lastModified.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(lastModified) ? lastModified : lastModified + "Z") : NaN;
  const notFullyIdle = integer(row.not_fully_idle), killed = integer(row.killed);
  if (notFullyIdle > 1 || killed > 1) throw new AntigravityReadError("format");
  return { conversationId, title: text(row.title), preview: text(row.preview), stepCount: integer(row.step_count),
    lastModifiedIso: Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined,
    workspaceUris: workspaceJson as string[], status: text(row.status, 256), notFullyIdle: notFullyIdle === 1, killed: killed === 1 };
}

export function safeAntigravityError(error: unknown): AntigravityReadError {
  if (error instanceof AntigravityReadError) return error;
  if (error instanceof AntigravityProtoError || error instanceof SyntaxError) return new AntigravityReadError("format");
  if (isRecord(error) && ["ENOENT", "EACCES", "EPERM"].includes(String(error.code))) return new AntigravityReadError("sourceUnavailable");
  const code = safeSqliteError(error);
  return new AntigravityReadError(code === "busy" || code === "runtime" || code === "schema" || code === "corrupt" ? code : "sourceUnavailable");
}

// One engine call owns one connection; page boundaries release read transactions.
export async function readAntigravityDatabase(request: AntigravityReaderRequest, cancelled: () => boolean = () => false, progress: () => void = () => undefined): Promise<AntigravityReaderResult> {
  const deadline = Date.now() + 30000;
  const check = (): void => {
    if (cancelled()) throw new AntigravityReadError("cancelled");
    if (Date.now() >= deadline) throw new AntigravityReadError("deadline");
  };
  const root = request.kind === "summaries" ? request.rootPath : request.locator.rootPath;
  const file = request.kind === "summaries" ? path.join(root, "conversation_summaries.db") : request.locator.conversationFsPath;
  if (request.kind !== "summaries" && (request.locator.schemaProfile !== ANTIGRAVITY_PROFILE || !ANTIGRAVITY_UUID.test(request.locator.conversationId) || path.basename(file) !== request.locator.conversationId + ".db")) throw new AntigravityReadError("storage");
  let changedRetries = 0, busyRetries = 0;
  while (true) {
    let db: SqliteDatabase | undefined, inTransaction = false;
    let retryDelay: number | undefined;
    try {
      check(); progress();
      const identity = await validateFile(root, file, request.kind === "summaries");
      check();
      const { DatabaseSync } = loadSqliteModule();
      db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
      configureSqliteConnection(db); db.exec("PRAGMA query_only=ON");
      if (db.prepare("PRAGMA query_only").get()?.query_only !== 1) throw new AntigravityReadError("runtime");
      const probe = db.prepare("SELECT 1 AS value");
      if (typeof probe.setReadBigInts !== "function" || typeof probe.iterate !== "function") throw new AntigravityReadError("runtime");
      probe.setReadBigInts(true);
      if (probe.get()?.value !== 1n || typeof probe.iterate !== "function") throw new AntigravityReadError("runtime");
      const version = (): number => integer(db!.prepare("PRAGMA data_version").get()?.data_version);
      const initial = version();
      const stable = async (): Promise<void> => {
        check();
        if (version() !== initial || !isSameIdentity(identity, await validateFile(root, file, request.kind === "summaries"))) throw new AntigravityReadError("sourceChanged");
      };
      const begin = async (): Promise<void> => { await stable(); db!.exec("BEGIN"); inTransaction = true; };
      const end = async (): Promise<void> => { db!.exec("COMMIT"); inTransaction = false; await stable(); progress(); await new Promise<void>(resolve => setImmediate(resolve)); };
      let result: AntigravityReaderResult;
      if (request.kind === "summaries") {
        validateTable(db, "conversation_summaries");
        const summaries: AntigravitySummaryRecord[] = []; let after = "", done = false, partial = false;
        const columns = ["conversation_id", "title", "preview", "last_modified_time", "workspace_uris", "status"].map(column => `CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB))<=${column === "workspace_uris" ? 1048576 : column === "title" || column === "preview" ? 32768 : 256} THEN CAST(${column} AS BLOB) END AS ${column}`).join(",");
        const statement = db.prepare(`SELECT ${columns},step_count,not_fully_idle,killed FROM conversation_summaries WHERE conversation_id>? ORDER BY conversation_id LIMIT 500`);
        let scanned = 0, summaryBytes = 0;
        while (!done) {
          await begin(); let count = 0;
          for (const row of statement.iterate(after)) {
            check(); count++;
            if (scanned >= ANTIGRAVITY_MAX_SESSIONS) { partial = true; done = true; break; }
            scanned++;
            // Invalid keys cannot become the next seek cursor or escape the source namespace.
            const key = text(row.conversation_id, 128); after = key;
            try {
              const summary = parseSummary(row);
              summaryBytes += antigravitySummarySize(summary);
              if (summaryBytes > ANTIGRAVITY_MAX_SUMMARY_BYTES) { partial = true; done = true; break; }
              summaries.push(summary);
            } catch { partial = true; }
          }
          await end(); done ||= count < 500;
        }
        result = { summaries, partial } satisfies AntigravitySummaryData;
      } else {
        await begin(); const metadata = readMetadata(db, request.locator.conversationId); await end();
        if (request.kind === "metadata") result = metadata;
        else {
          validateTable(db, "steps");
          const steps: AntigravityStep[] = [], issues = new Set<AntigravityIssue>();
          const fileEdits: Array<NonNullable<AntigravitySessionData["fileEdits"]>[number]> = [];
          const editBudget = { ...ANTIGRAVITY_FILE_EDIT_BUDGET };
          const unavailableFileEditSteps: number[] = [];
          let fileEditScanIncomplete = false;
          const digest = createHash("sha256"); digest.update(JSON.stringify(metadata)); digest.update("\n");
          const headers = db.prepare("SELECT idx,step_type,status,step_format,typeof(metadata) AS metadata_type,length(metadata) AS metadata_bytes,typeof(render_info) AS render_type,length(render_info) AS render_bytes,typeof(step_payload) AS payload_type,length(step_payload) AS payload_bytes FROM steps WHERE idx>? ORDER BY idx LIMIT 128");
          const bytes = db.prepare("SELECT metadata,render_info,step_payload FROM steps WHERE idx=?");
          let after = -1, total = 0, semanticBytes = 0, done = false;
          while (!done) {
            await begin(); let count = 0, pageBytes = 0; const pageStarted = Date.now();
            for (const header of headers.iterate(after)) {
              check();
              const index = integer(header.idx), type = integer(header.step_type), status = integer(header.status), format = integer(header.step_format);
              const lengths = [header.metadata_bytes, header.render_bytes, header.payload_bytes].map(value => value === null ? 0 : integer(value));
              const rowBytes = lengths.reduce((sum, value) => sum + value, 0);
              if (count && (pageBytes + rowBytes > PAGE_BYTES || Date.now() - pageStarted >= 2000)) break;
              count++; after = index;
              if (total + rowBytes > ANTIGRAVITY_MAX_SESSION_BYTES || steps.length >= MAX_STEPS) {
                issues.add("truncated"); fileEditScanIncomplete = true; done = true; break;
              }
              let step: AntigravityStep;
              let nativeEdit: ReturnType<typeof decodeAntigravityFileEdit>;
              if (lengths.some(value => value > ANTIGRAVITY_MAX_BLOB_BYTES)) step = { index, type, status, issues: ["truncated"] };
              else if ([header.metadata_type, header.render_type, header.payload_type].some(value => value !== "blob" && value !== "null")) step = { index, type, status, issues: ["invalidStep"] };
              else {
                const data = bytes.get(index);
                if (!data) throw new AntigravityReadError("sourceChanged");
                for (const [field, value] of [data.metadata, data.render_info, data.step_payload].entries()) {
                  digest.update(JSON.stringify([index, field, value instanceof Uint8Array ? value.byteLength : null]));
                  if (value instanceof Uint8Array) digest.update(value);
                }
                const includeContent = editBudget.bytes > 0 && editBudget.lines > 0 && editBudget.records > 0;
                step = decodeAntigravityStep({ index, type, status, format, metadata: blob(data.metadata), renderInfo: blob(data.render_info), payload: blob(data.step_payload) },
                  request.includeFileEdits === true ? { includeContent, collect: edit => { nativeEdit = edit; } } : undefined);
              }
              const encoded = JSON.stringify(step), encodedBytes = Buffer.byteLength(encoded, "utf8");
              if (semanticBytes + encodedBytes > ANTIGRAVITY_MAX_SESSION_BYTES) {
                issues.add("truncated"); fileEditScanIncomplete = true; done = true; break;
              }
              // The optional Viewer projection uses its own budget and never truncates ordinary history.
              if (nativeEdit && nativeEdit.bytes <= editBudget.bytes && nativeEdit.edit.lines.length <= editBudget.lines) {
                fileEdits.push({ stepIndex: index, edit: nativeEdit.edit });
                editBudget.records--; editBudget.bytes -= nativeEdit.bytes; editBudget.lines -= nativeEdit.edit.lines.length;
              } else if (nativeEdit !== undefined) {
                if (unavailableFileEditSteps.length < ANTIGRAVITY_FILE_EDIT_BUDGET.unavailableSteps) unavailableFileEditSteps.push(index);
                else fileEditScanIncomplete = true;
              }
              semanticBytes += encodedBytes;
              total += rowBytes; pageBytes += rowBytes; steps.push(step);
              for (const issue of step.issues) issues.add(issue);
              digest.update(encoded); digest.update("\n");
            }
            await end(); done ||= count === 0;
          }
          const fallback = await readAntigravityJsonl(root, request.locator.conversationId, steps, Math.max(0, ANTIGRAVITY_MAX_SESSION_BYTES - total), check);
          for (const issue of fallback.issues) issues.add(issue);
          for (let index = 0; index < steps.length; index++) {
            const replacement = fallback.steps.get(steps[index]!.index);
            if (!replacement) continue;
            const previousBytes = Buffer.byteLength(JSON.stringify(steps[index]), "utf8"), encoded = JSON.stringify(replacement);
            const replacementBytes = Buffer.byteLength(encoded, "utf8");
            if (semanticBytes - previousBytes + replacementBytes > ANTIGRAVITY_MAX_SESSION_BYTES) { issues.add("truncated"); continue; }
            semanticBytes += replacementBytes - previousBytes; steps[index] = replacement; digest.update(encoded); digest.update("\n");
          }
          if (fallback.digest) digest.update(fallback.digest);
          digest.update(JSON.stringify([...issues])); await stable();
          result = { metadata, steps, digest: digest.digest("hex"), issues: [...issues],
            ...(request.includeFileEdits ? { fileEdits, ...(unavailableFileEditSteps.length ? { unavailableFileEditSteps } : {}),
              ...(fileEditScanIncomplete ? { fileEditScanIncomplete: true } : {}) } : {})
          } satisfies AntigravitySessionData;
        }
      }
      await stable(); check(); return result;
    } catch (error) {
      const safe = safeAntigravityError(error);
      if (safe.code === "sourceChanged" && changedRetries++ < 1) continue;
      if (safe.code === "busy" && busyRetries < 2) retryDelay = [100, 300][busyRetries++]!;
      else throw safe;
    } finally {
      if (db) {
        try { if (inTransaction) db.exec("ROLLBACK"); }
        finally { db.close(); }
      }
    }
    // Release the transaction and connection before waiting for a busy producer.
    if (retryDelay !== undefined) { check(); await new Promise(resolve => setTimeout(resolve, retryDelay)); }
  }
}
