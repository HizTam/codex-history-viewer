import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// Keep the native module optional so older Extension Hosts can activate normally.
export type SqliteValue = string | number | bigint | Uint8Array | null;
export type SqliteRow = Record<string, SqliteValue>;
export interface SqliteStatement {
  iterate(...values: SqliteValue[]): IterableIterator<SqliteRow>;
  all(...values: SqliteValue[]): SqliteRow[];
  get(...values: SqliteValue[]): SqliteRow | undefined;
  run(...values: SqliteValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  setReadBigInts(enabled: boolean): void;
}
export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  enableLoadExtension(enabled: boolean): void;
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (file: string, options?: { readOnly?: boolean; allowExtension?: boolean }) => SqliteDatabase;
}

export class SqliteCacheError extends Error {
  constructor(public readonly code: SqliteCacheErrorCode) {
    super(`SQLite cache: ${code}`);
    this.name = "SqliteCacheError";
  }
}
export type SqliteCacheErrorCode =
  | "runtime" | "unsafeVersion" | "fts" | "storage" | "foreignDatabase"
  | "schema" | "corrupt" | "io" | "full" | "busy" | "generation" | "expired"
  | "walPressure" | "worker" | "invalidData" | "resourceLimit" | "cancelled" | "disposed";
const ERROR_CODES: ReadonlySet<string> = new Set<SqliteCacheErrorCode>([
  "runtime", "unsafeVersion", "fts", "storage", "foreignDatabase", "schema", "corrupt", "io", "full",
  "busy", "generation", "expired", "walPressure", "worker", "invalidData", "resourceLimit", "cancelled", "disposed",
]);
export function isSqliteCacheErrorCode(value: unknown): value is SqliteCacheErrorCode {
  return typeof value === "string" && ERROR_CODES.has(value);
}

export function loadSqliteModule(): SqliteModule {
  try {
    const loaded: unknown = require("node:sqlite");
    if (!isRecord(loaded) || typeof loaded.DatabaseSync !== "function") throw new Error();
    return loaded as unknown as SqliteModule;
  } catch { throw new SqliteCacheError("runtime"); }
}

export function isSafeSqliteCacheVersion(version: string): boolean {
  const parts = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!parts) return false;
  const [major, minor, patch] = parts.slice(1).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return false;
  if (version === "3.44.6" || version === "3.50.7") return true;
  return major! > 3 || (major === 3 && (minor! > 51 || (minor === 51 && patch! >= 3)));
}

export function supportsSqliteCheckpointObservation(version: string): boolean {
  if (!isSafeSqliteCacheVersion(version)) return false;
  const [major, minor] = version.split(".").map(Number);
  return major! > 3 || (major === 3 && minor! >= 51);
}

export function configureSqliteConnection(db: SqliteDatabase): void {
  if (typeof db.enableLoadExtension !== "function") throw new SqliteCacheError("runtime");
  db.enableLoadExtension(false);
  db.exec("PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=100");
  if (db.prepare("PRAGMA trusted_schema").get()?.trusted_schema !== 0
    || db.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 1) throw new SqliteCacheError("runtime");
}

export interface SqliteRuntimeInfo {
  readonly version: string;
  readonly sourceId: string;
  readonly foldingRuntimeKey: string | null;
}
// Only necessary single trigrams are queried; positional postings are intentionally omitted.
export const SQLITE_CACHE_FTS_OPTIONS = "content='', contentless_delete=1, detail=column, tokenize='trigram case_sensitive 1'";
export function getFoldingRuntimeKey(version: string, sourceId: string): string | null {
  const { v8, unicode, icu } = process.versions;
  return v8 && unicode && icu ? JSON.stringify([v8, unicode, icu, version, sourceId]) : null;
}

export function probeSqliteCacheRuntime(): SqliteRuntimeInfo {
  if (typeof SharedArrayBuffer !== "function" || typeof Atomics !== "object" || typeof Atomics.store !== "function") throw new SqliteCacheError("runtime");
  const flag = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(flag, 0, 1);
  if (Atomics.load(flag, 0) !== 1) throw new SqliteCacheError("runtime");
  const { DatabaseSync } = loadSqliteModule();
  const db = new DatabaseSync(":memory:", { allowExtension: false });
  try {
    configureSqliteConnection(db);
    const version = db.prepare("SELECT sqlite_version() AS value").get()?.value;
    const sourceId = db.prepare("SELECT sqlite_source_id() AS value").get()?.value;
    if (typeof version !== "string" || typeof sourceId !== "string") throw new SqliteCacheError("runtime");
    if (!isSafeSqliteCacheVersion(version)) throw new SqliteCacheError("unsafeVersion");
    db.exec("BEGIN; CREATE TABLE probe(value INTEGER); INSERT INTO probe VALUES(1); ROLLBACK");
    const bigint = db.prepare("SELECT ? AS value");
    bigint.setReadBigInts(true);
    if (bigint.get(9007199254740993n)?.value !== 9007199254740993n) throw new SqliteCacheError("runtime");
    if (typeof bigint.iterate !== "function" || [...bigint.iterate(1n)][0]?.value !== 1n) throw new SqliteCacheError("runtime");
    if (db.prepare("SELECT octet_length(?) AS value").get("😀")?.value !== 4) throw new SqliteCacheError("runtime");
    try {
      db.exec(`CREATE VIRTUAL TABLE grams USING fts5(raw, folded, ${SQLITE_CACHE_FTS_OPTIONS})`);
      db.prepare("INSERT INTO grams(rowid, raw, folded) VALUES(1, ?, ?)").run("AbC日本語", "abc日本語");
      if (db.prepare("SELECT rowid FROM grams WHERE grams MATCH ?").all('raw : "日本語"').length !== 1) throw new Error();
      db.exec("DELETE FROM grams WHERE rowid=1");
      if (db.prepare("SELECT rowid FROM grams WHERE grams MATCH ?").all('folded : "abc"').length !== 0) throw new Error();
    } catch { throw new SqliteCacheError("fts"); }
    return { version, sourceId, foldingRuntimeKey: getFoldingRuntimeKey(version, sourceId) };
  } finally { db.close(); }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function sqliteText(value: unknown, max = 32768): string {
  if (typeof value !== "string" || value.length > max || value.includes("\0")) throw new SqliteCacheError("invalidData");
  return value;
}
export function sqliteInteger(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new SqliteCacheError("invalidData");
  return value;
}
export function sqliteUtf8(value: unknown, maxBytes = 4194304): string {
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > maxBytes) throw new SqliteCacheError("corrupt");
    return value;
  }
  if (!(value instanceof Uint8Array) || value.byteLength > maxBytes) throw new SqliteCacheError("corrupt");
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value); }
  catch { throw new SqliteCacheError("corrupt"); }
}
export function safeSqliteError(error: unknown): SqliteCacheErrorCode {
  if (error instanceof SqliteCacheError) return error.code;
  if (isRecord(error) && typeof error.errcode === "number") {
    const primary = error.errcode & 255;
    if (primary === 5 || primary === 6) return "busy";
    if (primary === 11 || primary === 26) return "corrupt";
    if (primary === 13) return "full";
    if (primary === 10 || primary === 14) return "io";
    if (primary === 17) return "schema";
  }
  return "io";
}

function nativeRealpath(file: string): Promise<string> {
  return new Promise((resolve, reject) => fs.realpath.native(file, (error, result) => error ? reject(error) : resolve(result)));
}

export async function isLocalSqliteDisk(directory: string): Promise<boolean> {
  if (process.platform === "win32") {
    const drive = /^([A-Za-z]):[\\/]/.exec(directory)?.[1];
    if (!drive) return false;
    const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    // Only a validated drive letter enters this fixed, bounded OS capability probe.
    const script = `[int]([System.IO.DriveInfo]::new('${drive}:\\').DriveType)`;
    return new Promise(resolve => execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 3000, maxBuffer: 256, encoding: "utf8" },
      (error, stdout) => resolve(!error && /^(2|3)\s*$/.test(stdout))));
  }
  if (process.platform === "darwin") {
    // A mounted local disk is positive evidence; unknown and remote mounts fall back.
    return new Promise(resolve => execFile("/bin/df", ["-P", directory],
      { timeout: 3000, maxBuffer: 32768, encoding: "utf8" },
      (error, stdout) => resolve(!error && /^\/dev\/disk\d+(?:s\d+)*\s+\d+\s+\d+\s+\d+\s+\d+%/m.test(stdout))));
  }
  // Unknown and network filesystem kinds deliberately use the legacy backend.
  if (process.platform !== "linux") return false;
  const kind = (await fs.promises.statfs(directory)).type;
  const localKinds = new Set([0xef53, 0x9123683e, 0x58465342, 0x01021994, 0x2fc12fc1, 0x2011bab0]);
  return localKinds.has(kind >>> 0);
}

export async function resolveSafeSqliteCachePath(storage: { scheme: string; authority: string; fsPath: string }): Promise<string> {
  try {
    if (!["file", "vscode-userdata"].includes(storage.scheme) || storage.authority || !path.isAbsolute(storage.fsPath)
      || storage.fsPath.startsWith("\\\\") || storage.fsPath.includes("\0")) throw new Error();
    await fs.promises.mkdir(storage.fsPath, { recursive: true });
    const root = await nativeRealpath(storage.fsPath);
    if (root.startsWith("\\\\") || !await isLocalSqliteDisk(root)) throw new Error();
    const directory = path.join(root, "sqlite-cache");
    await fs.promises.mkdir(directory, { recursive: true });
    if ((await fs.promises.lstat(directory)).isSymbolicLink()) throw new Error();
    if (path.relative(root, await nativeRealpath(directory)) !== "sqlite-cache") throw new Error();
    return path.join(directory, "history-index.sqlite");
  } catch { throw new SqliteCacheError("storage"); }
}
