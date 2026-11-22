import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { readSqliteCacheSchemaState, SQLITE_CACHE_APPLICATION_ID } from "./sqliteCacheSchema";
import { configureSqliteConnection, isRecord, loadSqliteModule, SqliteCacheError } from "./sqliteRuntime";

const CACHE_FILE_NAME = "history-index.sqlite";
const CACHE_DIRECTORY = "sqlite-cache";
const RECOVERY_DIRECTORY = "recovered";
const SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;
const SQLITE_SIGNATURE = Buffer.from("SQLite format 3\0", "ascii");
const HEADER_SIZE = 100;
const APPLICATION_ID_OFFSET = 68;
const retrySignal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

// A validated, fixed child directory records the fallback choice across starts.
export function selectSqliteCacheFile(primary: string): string {
  if (!path.isAbsolute(primary) || path.basename(primary) !== CACHE_FILE_NAME) throw new SqliteCacheError("storage");
  const directory = path.dirname(primary);
  requireCacheDirectory(directory);
  const allowRecovery = path.basename(directory) === CACHE_DIRECTORY;
  const recovered = path.join(directory, RECOVERY_DIRECTORY);
  if (allowRecovery && fs.lstatSync(recovered, { throwIfNoEntry: false })) return inspectRecoveryFile(recovered);

  try {
    inspectCacheFile(primary);
    return primary;
  } catch (error) {
    if (!allowRecovery || !(error instanceof SqliteCacheError) || error.code !== "foreignDatabase") throw error;
    try { fs.mkdirSync(recovered); }
    catch (cause) { if (!isRecord(cause) || cause.code !== "EEXIST") throw cause; }
    return inspectRecoveryFile(recovered);
  }
}

function inspectRecoveryFile(directory: string): string {
  requireCacheDirectory(directory);
  const file = path.join(directory, CACHE_FILE_NAME);
  inspectCacheFile(file);
  return file;
}

function requireCacheDirectory(directory: string): void {
  const entry = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!entry?.isDirectory() || entry.isSymbolicLink() || path.relative(directory, fs.realpathSync.native(directory)) !== "") {
    throw new SqliteCacheError("storage");
  }
}

function inspectCacheFile(file: string): void {
  const directory = path.dirname(file);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = inspectFileEntry(file, directory);
    const sidecars = inspectSidecars(file, directory);
    if (!before || before.size === 0n) {
      // Another Worker may be in the middle of committing the initial empty database.
      const after = inspectFileEntry(file, directory);
      if (!sidecars && sameEntry(before, after) && !inspectSidecars(file, directory)) return;
    } else {
      const header = readHeader(file, before);
      const after = inspectFileEntry(file, directory);
      const hasSidecars = inspectSidecars(file, directory);
      if (header && header.length > 0 && sameEntry(before, after)) {
        const signatureLength = Math.min(header.length, SQLITE_SIGNATURE.length);
        if (!header.subarray(0, signatureLength).equals(SQLITE_SIGNATURE.subarray(0, signatureLength))) {
          throw new SqliteCacheError("foreignDatabase");
        }
        const applicationId = header.length >= APPLICATION_ID_OFFSET + 4 ? header.readUInt32BE(APPLICATION_ID_OFFSET) : undefined;
        if (applicationId !== undefined && applicationId !== 0 && applicationId !== SQLITE_CACHE_APPLICATION_ID) {
          throw new SqliteCacheError("foreignDatabase");
        }
        if (header.length === HEADER_SIZE) {
          if (applicationId !== SQLITE_CACHE_APPLICATION_ID) throw new SqliteCacheError("foreignDatabase");
          inspectOwnedSchema(file);
          return;
        }
        if (!sidecars && !hasSidecars) throw new SqliteCacheError("foreignDatabase");
      }
    }
    if (attempt < 2) Atomics.wait(retrySignal, 0, 0, 25);
  }
  throw new SqliteCacheError("busy");
}

function inspectSidecars(file: string, directory: string): boolean {
  let found = false;
  for (const suffix of SIDECAR_SUFFIXES) {
    if (inspectFileEntry(file + suffix, directory)) found = true;
  }
  return found;
}

function inspectFileEntry(file: string, directory: string): fs.BigIntStats | undefined {
  const entry = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  if (!entry) return undefined;
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n) throw new SqliteCacheError("storage");
  try {
    if (path.relative(directory, path.dirname(fs.realpathSync.native(file))) !== "") throw new SqliteCacheError("storage");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  return entry;
}

function sameEntry(left: fs.BigIntStats | undefined, right: fs.BigIntStats | undefined): boolean {
  if (!left || !right) return left === right;
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function readHeader(file: string, expected: fs.BigIntStats): Buffer | undefined {
  try {
    if (process.platform !== "win32") {
      // A separate PID prevents POSIX close() from releasing this process's SQLite file locks.
      return execFileSync("/usr/bin/head", ["-c", String(HEADER_SIZE), file], { timeout: 2500, maxBuffer: 256, stdio: ["ignore", "pipe", "pipe"] });
    }
    const descriptor = fs.openSync(file, "r");
    try {
      if (!sameEntry(fs.fstatSync(descriptor, { bigint: true }), expected)) return undefined;
      const buffer = Buffer.alloc(HEADER_SIZE);
      const length = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
      return sameEntry(fs.fstatSync(descriptor, { bigint: true }), expected) ? buffer.subarray(0, length) : undefined;
    } finally { fs.closeSync(descriptor); }
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT" && !fs.lstatSync(file, { throwIfNoEntry: false })) return undefined;
    throw new SqliteCacheError("storage");
  }
}

function inspectOwnedSchema(file: string): void {
  const db = new (loadSqliteModule().DatabaseSync)(file, { readOnly: true, allowExtension: false });
  try {
    configureSqliteConnection(db);
    readSqliteCacheSchemaState(db);
  } finally { db.close(); }
}
