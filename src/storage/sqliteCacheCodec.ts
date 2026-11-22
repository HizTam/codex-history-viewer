import { createHash } from "node:crypto";
import { constants } from "node:buffer";
import { deflateSync, inflateSync } from "node:zlib";
import { isRecord, SqliteCacheError, sqliteInteger, sqliteUtf8 } from "./sqliteRuntime";

export const SQLITE_CACHE_CHUNK_UNITS = 65536;
export const SQLITE_FTS_MAX_MESSAGE_UNITS = 1048576;
export const SQLITE_CACHE_BATCH_BYTES = 4 * 1048576;
export const SQLITE_CACHE_BATCH_RECORDS = 256;
export const SQLITE_STORED_TEXT_MAX_BYTES = SQLITE_CACHE_CHUNK_UNITS * 6 + 2;
export const SQLITE_CACHE_METADATA_BYTES = 1048576;
export const SQLITE_FTS_MAX_INDEX_UNITS = 16384;
export const SQLITE_FTS_MAX_GRAMS = 4096;

// JSON escaping preserves UTF-16 code units, including NUL and lone surrogates.
export function* encodeSqliteText(text: string): Generator<string> {
  if (typeof text !== "string" || text.length > constants.MAX_STRING_LENGTH) throw new SqliteCacheError("invalidData");
  if (!text.length) { yield '""'; return; }
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + SQLITE_CACHE_CHUNK_UNITS);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff
      && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end--;
    yield JSON.stringify(text.slice(start, end));
    start = end;
  }
}

export function decodeSqliteTextChunk(value: unknown): string {
  if (typeof value !== "string" || value.length > SQLITE_CACHE_CHUNK_UNITS * 6 + 2) throw new SqliteCacheError("invalidData");
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new SqliteCacheError("invalidData"); }
  if (typeof parsed !== "string" || parsed.length > SQLITE_CACHE_CHUNK_UNITS) throw new SqliteCacheError("invalidData");
  return parsed;
}

export function encodeSqliteStoredText(json: string): { codec: 0 | 1; data: Uint8Array } {
  const text = decodeSqliteTextChunk(json);
  // Noncanonical JSON may contain a raw lone surrogate that UTF-8 cannot encode losslessly.
  const safeJson = /[\uD800-\uDFFF]/u.test(json) ? JSON.stringify(text) : json;
  const raw = Buffer.from(safeJson, "utf8");
  if (raw.length > SQLITE_STORED_TEXT_MAX_BYTES) throw new SqliteCacheError("invalidData");
  if (raw.length >= 1024) {
    const compressed = deflateSync(raw, { level: 1 });
    if (compressed.length <= raw.length * 0.9) return { codec: 1, data: compressed };
  }
  return { codec: 0, data: raw };
}

export function decodeSqliteStoredText(codec: unknown, value: unknown): { json: string; text: string } {
  // A NULL projection denotes a rejected oversized or otherwise corrupt physical value.
  if (value === null) throw new SqliteCacheError("corrupt");
  if ((codec !== 0 && codec !== 1) || !(value instanceof Uint8Array)
    || value.byteLength > SQLITE_STORED_TEXT_MAX_BYTES) throw new SqliteCacheError("invalidData");
  let bytes = value;
  if (codec === 1) {
    try {
      const decoded: unknown = inflateSync(value, { maxOutputLength: SQLITE_STORED_TEXT_MAX_BYTES, info: true });
      if (!isRecord(decoded) || !(decoded.buffer instanceof Uint8Array) || !isRecord(decoded.engine)
        || decoded.engine.bytesWritten !== value.byteLength) throw new SqliteCacheError("invalidData");
      bytes = decoded.buffer;
    } catch { throw new SqliteCacheError("invalidData"); }
  }
  const json = sqliteUtf8(bytes, SQLITE_STORED_TEXT_MAX_BYTES);
  return { json, text: decodeSqliteTextChunk(json) };
}

export function isSqliteFtsEligible(text: string): boolean {
  // Unicode mode treats a valid surrogate pair as one code point outside this range.
  return text.length <= SQLITE_FTS_MAX_MESSAGE_UNITS && !/[\u0000\uD800-\uDFFF]/u.test(text);
}

export function stringifySqliteMetadata(value: unknown): string {
  let json: unknown;
  try { json = JSON.stringify(value); } catch { throw new SqliteCacheError("invalidData"); }
  if (typeof json !== "string" || Buffer.byteLength(json, "utf8") > SQLITE_CACHE_METADATA_BYTES) throw new SqliteCacheError("invalidData");
  return json;
}

export function isWithinSqliteGramBudget(text: string): boolean {
  if (typeof text !== "string" || text.length > SQLITE_FTS_MAX_INDEX_UNITS || !isSqliteFtsEligible(text)) return false;
  if (text.length <= SQLITE_FTS_MAX_GRAMS + 2) return true;
  if (/^[\u0001-\u007f]*$/.test(text)) {
    const grams = new Set<number>();
    let gram = 0;
    for (let index = 0; index < text.length; index++) {
      gram = ((gram << 8) | text.charCodeAt(index)) & 0xffffff;
      if (index >= 2) { grams.add(gram); if (grams.size > SQLITE_FTS_MAX_GRAMS) return false; }
    }
  } else {
    const grams = new Set<string>();
    let first = "", second = "";
    for (const point of text) {
      if (first && second) { grams.add(first + second + point); if (grams.size > SQLITE_FTS_MAX_GRAMS) return false; }
      first = second; second = point;
    }
  }
  return true;
}

export type SqliteIndexTextPlan = { eligible: false } | { eligible: true; raw: string; folded: string };
export function buildSqliteIndexTextPlan(text: string): SqliteIndexTextPlan {
  if (!isSqliteFtsEligible(text)) return { eligible: false };
  const compact = (value: string): string | undefined => {
    let result = "";
    for (const piece of sqliteGramChunks(value)) {
      if (result.length + piece.length > SQLITE_FTS_MAX_INDEX_UNITS) return undefined;
      result += piece;
    }
    return isWithinSqliteGramBudget(result) ? result : undefined;
  };
  const raw = compact(text);
  if (raw === undefined) return { eligible: false };
  const folded = compact(text.toLowerCase());
  return folded === undefined ? { eligible: false } : { eligible: true, raw, folded };
}

export function* sqliteGramChunks(text: string): Generator<string> {
  // Repeated overlapping pieces carry the same necessary grams, so keep each piece once.
  const seen = new Set<string>();
  let pieces: string[] = [];
  let units = 0;
  for (const piece of overlappingGramPieces(text)) {
    if (seen.has(piece)) continue;
    seen.add(piece);
    if (units + piece.length > SQLITE_CACHE_CHUNK_UNITS) {
      yield pieces.join(""); pieces = []; units = 0;
    }
    pieces.push(piece); units += piece.length;
  }
  if (pieces.length) yield pieces.join("");
}

function* overlappingGramPieces(text: string): Generator<string> {
  // Two overlapping code points retain every possible trigram across chunk boundaries.
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + 256);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    yield text.slice(start, end);
    if (end === text.length) break;
    let next = end;
    for (let overlap = 0; overlap < 2 && next > start; overlap++) {
      next--;
      if (next > start && text.charCodeAt(next) >= 0xdc00 && text.charCodeAt(next) <= 0xdfff) next--;
    }
    start = next;
  }
}

export function hashSqliteText(text: string): string {
  // Hash code units rather than lossy UTF-8 encoding of an unpaired surrogate.
  return createHash("sha256").update(text, "utf16le").digest("hex");
}

export function canonicalSqliteJson(value: unknown): string {
  const visit = (input: unknown, depth: number): unknown => {
    if (depth > 64) throw new SqliteCacheError("invalidData");
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (Array.isArray(input)) return input.map(item => visit(item, depth + 1));
    if (input && typeof input === "object" && Object.getPrototypeOf(input) === Object.prototype) {
      const result: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(input).sort()) {
        const item = (input as Record<string, unknown>)[key];
        if (item !== undefined) result[key] = visit(item, depth + 1);
      }
      return result;
    }
    throw new SqliteCacheError("invalidData");
  };
  return JSON.stringify(visit(value, 0));
}

export class SqliteTextDecoder {
  private readonly chunks: string[] = [];
  private units = 0;
  public append(ordinal: unknown, value: unknown): void {
    this.appendDecoded(ordinal, decodeSqliteTextChunk(value));
  }
  public appendDecoded(ordinal: unknown, chunk: unknown): void {
    if (sqliteInteger(ordinal) !== this.chunks.length) throw new SqliteCacheError("invalidData");
    if (typeof chunk !== "string" || chunk.length > SQLITE_CACHE_CHUNK_UNITS) throw new SqliteCacheError("invalidData");
    if (this.units + chunk.length > constants.MAX_STRING_LENGTH) throw new SqliteCacheError("invalidData");
    this.chunks.push(chunk);
    this.units += chunk.length;
  }
  public finish(expectedUnits?: number): string {
    if (!this.chunks.length || (expectedUnits !== undefined && expectedUnits !== this.units)) throw new SqliteCacheError("invalidData");
    return this.chunks.join("");
  }
}
