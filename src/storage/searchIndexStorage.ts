import { constants } from "node:buffer";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, unlink } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { TextDecoder } from "node:util";
import * as vscode from "vscode";
import type { PerformanceProbe } from "../performance/performanceCounters";
import type { SearchIndexCacheContext, SearchIndexEntryV1 } from "../services/searchIndexService";
import {
  deleteJsonFileAfterParseError,
  isFileNotFoundError,
  type JsonReadOrDropCorruptResult,
  type JsonReadResult,
} from "./jsonStorage";

// Bound serialization by a physical row, never by the complete index or entry.
const FORMAT_VERSION = 1;
const TEXT_CHUNK_UNITS = 65_536;
const MAX_ROW_BYTES = 1024 * 1024;
const MAX_META_FIELDS = 16;
const READ_CHUNK_BYTES = 64 * 1024;
const YIELD_INTERVAL_MS = 8;

type Scalar = string | number | boolean;
type Meta = Record<string, Scalar>;
type Row = unknown[];
type MetaSchema = Readonly<Record<string, { readonly type: "string" | "number" | "boolean"; readonly optional?: true }>>;

const CONTEXT_SCHEMA: MetaSchema = {
  codexSessionsRoot: { type: "string" },
  claudeSessionsRoot: { type: "string" },
  codexArchivedSessionsRoot: { type: "string", optional: true },
  includeCodex: { type: "boolean" },
  includeClaude: { type: "boolean" },
  includeCodexArchived: { type: "boolean", optional: true },
  indexToolContent: { type: "string", optional: true },
};
const ENTRY_SCHEMA: MetaSchema = {
  key: { type: "string" },
  fsPath: { type: "string" },
  mtimeMs: { type: "number" },
  size: { type: "number" },
  historySignature: { type: "string", optional: true },
};
const MESSAGE_SCHEMA: MetaSchema = {
  messageIndex: { type: "number" },
  role: { type: "string" },
  source: { type: "string" },
  inputId: { type: "string", optional: true },
  progressId: { type: "string", optional: true },
  progressKind: { type: "string", optional: true },
};
const HINT_SCHEMA: MetaSchema = {
  messageIndex: { type: "number" },
  timestampIso: { type: "string", optional: true },
  origin: { type: "string" },
  hasDiffLikeContent: { type: "boolean" },
};

export interface SearchIndexStorageOptions {
  readonly token?: vscode.CancellationToken;
  readonly performanceProbe?: PerformanceProbe;
}

export interface SearchIndexWriteData {
  readonly version: number;
  readonly context: SearchIndexCacheContext;
  readonly entries: ReadonlyMap<string, SearchIndexEntryV1>;
}

class SchemaError extends Error {}

class CooperativeWork {
  private lastYield = performance.now();

  constructor(private readonly options: SearchIndexStorageOptions) {}

  public check(): void {
    if (this.options.token?.isCancellationRequested) throw new vscode.CancellationError();
  }

  public async checkpoint(): Promise<void> {
    this.check();
    if (performance.now() - this.lastYield < YIELD_INTERVAL_MS) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.options.performanceProbe?.add("cooperativeYieldCount");
    this.lastYield = performance.now();
    this.check();
  }
}

export async function writeSearchIndex(
  uri: vscode.Uri,
  data: SearchIndexWriteData,
  options: SearchIndexStorageOptions & { readonly beforeCommit?: () => void } = {},
): Promise<void> {
  const work = new CooperativeWork(options);
  work.check();
  const tempUri = buildTempUri(uri);
  let providerBytes: Uint8Array | undefined;
  let ownsTemp = uri.scheme !== "file";
  try {
    options.performanceProbe?.add("cacheWriteCount");
    if (uri.scheme === "file") {
      const output = createWriteStream(tempUri.fsPath, { flags: "wx" });
      output.once("open", () => { ownsTemp = true; });
      const cancellation = options.token?.onCancellationRequested(() => output.destroy(new vscode.CancellationError()));
      try {
        await pipeline(Readable.from(encodedRows(data, work, options.performanceProbe)), output);
      } finally {
        cancellation?.dispose();
        output.destroy();
        // Pipeline owns stream errors; this wait also covers failed-open/close paths.
        await finished(output, { cleanup: true }).catch(() => undefined);
      }
    } else {
      providerBytes = await encodeProviderBytes(data, work);
      options.performanceProbe?.add("cacheWriteByteCount", providerBytes.byteLength);
      work.check();
      await vscode.workspace.fs.writeFile(tempUri, providerBytes);
    }

    // Cancellation is checked before commit, never after a successful disk commit.
    work.check();
    options.beforeCommit?.();
    try {
      await vscode.workspace.fs.rename(tempUri, uri, { overwrite: true });
    } catch {
      work.check();
      options.beforeCommit?.();
      if (uri.scheme === "file") await copyFile(tempUri.fsPath, uri.fsPath);
      else await vscode.workspace.fs.writeFile(uri, providerBytes!);
    }
  } finally {
    if (ownsTemp) await cleanupTemp(tempUri);
  }
}

export async function readSearchIndex(
  uri: vscode.Uri,
  options: SearchIndexStorageOptions = {},
): Promise<JsonReadOrDropCorruptResult<unknown>> {
  const work = new CooperativeWork(options);
  work.check();
  const rows = new RowReader(readRows(readBytes(uri, options, work), work));
  let result: JsonReadResult<unknown>;
  try {
    result = { ok: true, value: await decodeIndex(rows, work) };
  } catch (error) {
    if (error instanceof vscode.CancellationError) throw error;
    if (error instanceof SchemaError || (!rows.recognized && error instanceof SyntaxError)) {
      result = { ok: true, value: null };
    } else {
      result = {
        ok: false,
        reason: isFileNotFoundError(error) ? "missing" : error instanceof SyntaxError ? "parseError" : "readError",
        ...(error instanceof Error ? { errorName: error.name } : {}),
      };
    }
  } finally {
    await rows.close();
  }
  if (result.ok || result.reason !== "parseError") return { result };
  return { result, deletion: await deleteJsonFileAfterParseError(uri, result) };
}

async function* encodedRows(
  data: SearchIndexWriteData,
  work: CooperativeWork,
  probe?: PerformanceProbe,
): AsyncGenerator<Buffer> {
  for (const row of indexRows(data)) {
    await work.checkpoint();
    const bytes = Buffer.from(`${JSON.stringify(row)}\n`, "utf8");
    if (bytes.byteLength - 1 > MAX_ROW_BYTES) throw new RangeError("Search index row exceeds the byte limit");
    probe?.add("cacheWriteByteCount", bytes.byteLength);
    yield bytes;
  }
}

async function encodeProviderBytes(data: SearchIndexWriteData, work: CooperativeWork): Promise<Uint8Array> {
  let byteLength = 0;
  for await (const bytes of encodedRows(data, work)) {
    byteLength += bytes.byteLength;
    if (!Number.isSafeInteger(byteLength) || byteLength > constants.MAX_LENGTH) {
      throw new RangeError("Search index exceeds the provider byte buffer limit");
    }
  }
  const output = Buffer.allocUnsafe(byteLength);
  let offset = 0;
  for await (const bytes of encodedRows(data, work)) {
    if (offset + bytes.byteLength > output.byteLength) throw new Error("Search index changed during encoding");
    output.set(bytes, offset);
    offset += bytes.byteLength;
  }
  if (offset !== output.byteLength) throw new Error("Search index changed during encoding");
  return output;
}

function* indexRows(data: SearchIndexWriteData): Generator<Row> {
  requireCount(data.version);
  yield ["header", FORMAT_VERSION, data.version];
  yield* metaRows(data.context, CONTEXT_SCHEMA);
  let entryOrdinal = 0;
  for (const [key, entry] of data.entries) {
    requireCount(entryOrdinal);
    requireCount(entry.messages.length);
    if (entry.fileChangeHints !== undefined) requireCount(entry.fileChangeHints.length);
    yield ["entry", entryOrdinal++, entry.messages.length, entry.fileChangeHints?.length ?? null];
    yield* metaRows({ ...entry, key }, ENTRY_SCHEMA);
    for (let ordinal = 0; ordinal < entry.messages.length; ordinal++) {
      const message = entry.messages[ordinal];
      requireText(message.text);
      yield ["message", ordinal, message.text.length, chunkCount(message.text.length)];
      yield* metaRows(message, MESSAGE_SCHEMA);
      yield* textRows(message.text);
    }
    for (let ordinal = 0; ordinal < (entry.fileChangeHints?.length ?? 0); ordinal++) {
      const hint = entry.fileChangeHints![ordinal];
      requireCount(hint.paths.length);
      yield ["hint", ordinal, hint.paths.length];
      yield* metaRows(hint, HINT_SCHEMA);
      for (let pathOrdinal = 0; pathOrdinal < hint.paths.length; pathOrdinal++) {
        const text = hint.paths[pathOrdinal];
        requireText(text);
        yield ["path", pathOrdinal, text.length, chunkCount(text.length)];
        yield* textRows(text);
      }
    }
  }
  yield ["end", entryOrdinal];
}

function* metaRows(value: object, schema: MetaSchema): Generator<Row> {
  const record = value as Record<string, unknown>;
  const pairs: [string, Scalar][] = [];
  let units = 0;
  for (const key of Object.keys(schema)) {
    const item = record[key];
    if (item === undefined && schema[key].optional) continue;
    validateScalar(key, item, schema);
    pairs.push([key, item as Scalar]);
    units += key.length + (typeof item === "string" ? item.length : 0);
  }
  if (units <= TEXT_CHUNK_UNITS) {
    yield ["meta", pairs];
    return;
  }
  yield ["meta", null, pairs.length];
  for (const [key, item] of pairs) {
    if (typeof item === "string" && item.length > TEXT_CHUNK_UNITS) {
      yield ["string", key, item.length, chunkCount(item.length)];
      yield* textRows(item);
    } else {
      yield ["field", key, item];
    }
  }
}

function* textRows(text: string): Generator<Row> {
  for (let start = 0, ordinal = 0; start < text.length; start += TEXT_CHUNK_UNITS, ordinal++) {
    yield ["text", ordinal, text.slice(start, start + TEXT_CHUNK_UNITS)];
  }
}

async function* readBytes(
  uri: vscode.Uri,
  options: SearchIndexStorageOptions,
  work: CooperativeWork,
): AsyncGenerator<Uint8Array> {
  work.check();
  if (uri.scheme !== "file") {
    const bytes = await vscode.workspace.fs.readFile(uri);
    options.performanceProbe?.add("cacheReadByteCount", bytes.byteLength);
    for (let offset = 0; offset < bytes.byteLength; offset += READ_CHUNK_BYTES) {
      await work.checkpoint();
      yield bytes.subarray(offset, offset + READ_CHUNK_BYTES);
    }
    work.check();
    return;
  }
  const input = createReadStream(uri.fsPath, { highWaterMark: READ_CHUNK_BYTES });
  const cancellation = options.token?.onCancellationRequested(() => input.destroy(new vscode.CancellationError()));
  try {
    for await (const raw of input) {
      await work.checkpoint();
      const bytes = raw as Buffer;
      options.performanceProbe?.add("cacheReadByteCount", bytes.byteLength);
      yield bytes;
    }
    work.check();
  } finally {
    cancellation?.dispose();
    input.destroy();
    // The iterator propagates I/O errors; closing must not replace that error.
    await finished(input, { cleanup: true }).catch(() => undefined);
  }
}

async function* readRows(bytes: AsyncIterable<Uint8Array>, work: CooperativeWork): AsyncGenerator<unknown> {
  const line = new Uint8Array(MAX_ROW_BYTES);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let used = 0;
  for await (const part of bytes) {
    let start = 0;
    for (let cursor = 0; cursor < part.byteLength; cursor++) {
      if (part[cursor] !== 10) continue;
      const count = cursor - start;
      if (used + count > MAX_ROW_BYTES) throw new RangeError("Search index row exceeds the byte limit");
      line.set(part.subarray(start, cursor), used);
      used += count;
      await work.checkpoint();
      yield parseRow(line.subarray(0, used), decoder);
      used = 0;
      start = cursor + 1;
    }
    if (used + part.byteLength - start > MAX_ROW_BYTES) throw new RangeError("Search index row exceeds the byte limit");
    line.set(part.subarray(start), used);
    used += part.byteLength - start;
    await work.checkpoint();
  }
  if (used > 0) yield parseRow(line.subarray(0, used), decoder);
}

function parseRow(bytes: Uint8Array, decoder: TextDecoder): unknown {
  const end = bytes.byteLength > 0 && bytes[bytes.byteLength - 1] === 13 ? bytes.byteLength - 1 : bytes.byteLength;
  // Fatal UTF-8 TypeError is a non-destructive readError, never JSON corruption.
  const text = decoder.decode(bytes.subarray(0, end));
  if (text.length === 0) throw new SchemaError("Empty search index row");
  return JSON.parse(text) as unknown;
}

class RowReader {
  public recognized = false;

  constructor(private readonly iterator: AsyncGenerator<unknown>) {}

  public async next(): Promise<Row | null> {
    const next = await this.iterator.next();
    if (next.done) return null;
    if (!Array.isArray(next.value)) throw new SchemaError("Expected a search index row");
    return next.value;
  }

  public async require(): Promise<Row> {
    const row = await this.next();
    if (row === null) throw new SyntaxError("Unexpected end of search index");
    return row;
  }

  public async close(): Promise<void> {
    await this.iterator.return(undefined);
  }
}

async function decodeIndex(rows: RowReader, work: CooperativeWork): Promise<unknown> {
  const header = await rows.next();
  if (!header || header.length !== 3 || header[0] !== "header" || header[1] !== FORMAT_VERSION) {
    throw new SchemaError("Unrecognized search index format");
  }
  rows.recognized = true;
  requireCount(header[2]);
  const context = await readMeta(rows, CONTEXT_SCHEMA);
  const entries: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let entryOrdinal = 0;
  while (true) {
    await work.checkpoint();
    const row = await rows.require();
    if (row[0] === "end") {
      requireRow(row, "end", 2);
      if (row[1] !== entryOrdinal) throw new SchemaError("Invalid search index entry count");
      if (await rows.next() !== null) throw new SchemaError("Data after search index trailer");
      return { version: header[2], context, entries };
    }
    requireRow(row, "entry", 4);
    if (row[1] !== entryOrdinal++) throw new SchemaError("Invalid search index entry ordinal");
    requireCount(row[2]);
    if (row[3] !== null) requireCount(row[3]);
    const meta = await readMeta(rows, ENTRY_SCHEMA);
    const key = meta.key as string;
    if (key.length === 0 || Object.hasOwn(entries, key)) throw new SchemaError("Invalid or duplicate search index entry key");
    delete meta.key;
    const messages: unknown[] = [];
    for (let ordinal = 0; ordinal < (row[2] as number); ordinal++) {
      const message = await rows.require();
      requireRow(message, "message", 4);
      if (message[1] !== ordinal) throw new SchemaError("Invalid search index message ordinal");
      const length = requireTextShape(message[2], message[3]);
      const messageMeta = await readMeta(rows, MESSAGE_SCHEMA);
      messages.push({ ...messageMeta, text: await readText(rows, length) });
    }
    const entry: Record<string, unknown> = { ...meta, messages };
    if (row[3] !== null) {
      const hints: unknown[] = [];
      for (let ordinal = 0; ordinal < (row[3] as number); ordinal++) {
        const hint = await rows.require();
        requireRow(hint, "hint", 3);
        if (hint[1] !== ordinal) throw new SchemaError("Invalid search index hint ordinal");
        requireCount(hint[2]);
        const hintMeta = await readMeta(rows, HINT_SCHEMA);
        const paths: string[] = [];
        for (let pathOrdinal = 0; pathOrdinal < (hint[2] as number); pathOrdinal++) {
          const path = await rows.require();
          requireRow(path, "path", 4);
          if (path[1] !== pathOrdinal) throw new SchemaError("Invalid search index path ordinal");
          paths.push(await readText(rows, requireTextShape(path[2], path[3])));
        }
        hints.push({ ...hintMeta, paths });
      }
      entry.fileChangeHints = hints;
    }
    entries[key] = entry;
  }
}

async function readMeta(rows: RowReader, schema: MetaSchema): Promise<Meta> {
  const row = await rows.require();
  const meta: Meta = Object.create(null) as Meta;
  if (row.length === 2 && row[0] === "meta" && Array.isArray(row[1])) {
    if (row[1].length > MAX_META_FIELDS) throw new SchemaError("Too many metadata fields");
    let units = 0;
    for (const pair of row[1] as unknown[]) {
      if (!Array.isArray(pair) || pair.length !== 2) throw new SchemaError("Invalid metadata pair");
      addField(meta, pair[0], pair[1], schema);
      units += (pair[0] as string).length + (typeof pair[1] === "string" ? pair[1].length : 0);
    }
    if (units > TEXT_CHUNK_UNITS) throw new SchemaError("Inline metadata exceeds its limit");
  } else {
    requireRow(row, "meta", 3);
    if (row[1] !== null) throw new SchemaError("Invalid expanded metadata");
    requireCount(row[2]);
    if ((row[2] as number) > MAX_META_FIELDS) throw new SchemaError("Too many metadata fields");
    for (let ordinal = 0; ordinal < (row[2] as number); ordinal++) {
      const field = await rows.require();
      if (field[0] === "field") {
        requireRow(field, "field", 3);
        if (typeof field[2] === "string" && field[2].length > TEXT_CHUNK_UNITS) throw new SchemaError("Metadata string requires chunks");
        addField(meta, field[1], field[2], schema);
      } else {
        requireRow(field, "string", 4);
        if (typeof field[1] !== "string" || !Object.hasOwn(schema, field[1]) || schema[field[1]].type !== "string") {
          throw new SchemaError("Unknown metadata string field");
        }
        const length = requireTextShape(field[2], field[3]);
        if (length <= TEXT_CHUNK_UNITS) throw new SchemaError("Unnecessary metadata chunks");
        addField(meta, field[1], await readText(rows, length), schema);
      }
    }
  }
  for (const key of Object.keys(schema)) {
    if (!schema[key].optional && !Object.hasOwn(meta, key)) throw new SchemaError("Missing metadata field");
  }
  return meta;
}

async function readText(rows: RowReader, length: number): Promise<string> {
  const chunks: string[] = [];
  for (let ordinal = 0, count = chunkCount(length); ordinal < count; ordinal++) {
    const row = await rows.require();
    requireRow(row, "text", 3);
    if (row[1] !== ordinal || typeof row[2] !== "string") throw new SchemaError("Invalid search index text chunk");
    const expected = Math.min(TEXT_CHUNK_UNITS, length - ordinal * TEXT_CHUNK_UNITS);
    if (row[2].length !== expected) throw new SchemaError("Invalid search index text length");
    chunks.push(row[2]);
  }
  return chunks.join("");
}

function requireRow(row: Row, kind: string, length: number): void {
  if (row[0] !== kind || row.length !== length) throw new SchemaError("Unexpected search index row");
}

function requireCount(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new SchemaError("Invalid search index count");
}

function requireText(value: unknown): asserts value is string {
  if (typeof value !== "string") throw new SchemaError("Invalid search index string");
}

function requireTextShape(length: unknown, count: unknown): number {
  requireCount(length);
  requireCount(count);
  if (length > constants.MAX_STRING_LENGTH) throw new RangeError("Search index string exceeds the runtime limit");
  if (count !== chunkCount(length)) throw new SchemaError("Invalid search index chunk count");
  return length;
}

function chunkCount(length: number): number {
  return Math.ceil(length / TEXT_CHUNK_UNITS);
}

function validateScalar(key: string, value: unknown, schema: MetaSchema): void {
  if (!Object.hasOwn(schema, key) || typeof value !== schema[key].type || (typeof value === "number" && !Number.isFinite(value))) {
    throw new SchemaError("Invalid search index metadata scalar");
  }
}

function addField(meta: Meta, key: unknown, value: unknown, schema: MetaSchema): void {
  if (typeof key !== "string" || Object.hasOwn(meta, key)) throw new SchemaError("Invalid or duplicate metadata field");
  validateScalar(key, value, schema);
  meta[key] = value as Scalar;
}

function buildTempUri(uri: vscode.Uri): vscode.Uri {
  const stem = uri.path.endsWith(".jsonl") ? uri.path.slice(0, -6) : uri.path;
  return uri.with({ path: `${stem}.tmp-${Date.now().toString(36)}-${randomUUID().replace(/-/gu, "")}.jsonl` });
}

async function cleanupTemp(uri: vscode.Uri): Promise<void> {
  try {
    if (uri.scheme === "file") await unlink(uri.fsPath);
    else await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
  } catch {
    // Cleanup is best effort and must never hide the primary result or error.
  }
}
