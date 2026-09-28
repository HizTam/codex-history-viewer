import * as fs from "node:fs";
import { stat, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAX_DECODED_BYTES = 1024 * 1024 * 1024;
// Small compressed inputs bound each synchronous WASM call, including highly repetitive data.
const WASM_INPUT_BYTES = 512;
let wasmQueue: Promise<void> = Promise.resolve();

interface WasmDecoder {
  compress(bytes: Uint8Array): Uint8Array;
  resetDecompression(): void;
  decompressChunk(bytes: Uint8Array): Uint8Array;
  decompressEnd(): void;
}

// An explicit import may overwrite a history in another storage format. Keep the destination
// format and replace it only after the complete conversion succeeds; this is not a read cache.
export async function importSessionWithDestinationFormat(source: string, destination: string): Promise<void> {
  const originalSource = await stat(source);
  const originalDestination = await stat(destination);
  const temporary = `${destination}.import-${randomUUID()}.tmp`;
  try {
    const input = isCompressedSessionFile(destination) ? encodePlainSession(source) : readCompressedBytes(source);
    await pipeline(Readable.from(input), fs.createWriteStream(temporary, { flags: "wx" }));
    const currentSource = await stat(source);
    const currentDestination = await stat(destination);
    if (currentSource.size !== originalSource.size || currentSource.mtimeMs !== originalSource.mtimeMs ||
        currentDestination.size !== originalDestination.size || currentDestination.mtimeMs !== originalDestination.mtimeMs) {
      throw new Error("Import files changed during conversion.");
    }
    await rename(temporary, destination);
  } finally {
    try { await unlink(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function* encodePlainSession(fsPath: string): AsyncGenerator<Uint8Array> {
  const previous = wasmQueue;
  let release!: () => void;
  wasmQueue = new Promise<void>(resolve => { release = resolve; });
  await previous;
  let input: fs.ReadStream | undefined;
  try {
    const runtime = require("../vendor/zstd.cjs") as { Zstd: { load(): Promise<WasmDecoder> } };
    const decoder = await runtime.Zstd.load();
    input = fs.createReadStream(fsPath, { highWaterMark: 64 * 1024 });
    let wrote = false;
    for await (const chunk of input) {
      // Independent bounded frames avoid retaining the entire imported file in memory.
      yield decoder.compress(chunk as Buffer);
      wrote = true;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (!wrote) yield decoder.compress(new Uint8Array());
  } finally { input?.destroy(); release(); }
}

export interface SessionFileReadOptions {
  readonly endByteOffset?: number;
  readonly maxDecodedBytes?: number;
  readonly token?: { readonly isCancellationRequested: boolean };
  readonly cancellationErrorFactory?: () => Error;
}

export function isCompressedSessionFile(fsPath: string): boolean {
  return /\.jsonl\.zst$/iu.test(fsPath);
}

export function isSessionFile(fsPath: string): boolean {
  return /\.jsonl(?:\.zst)?$/iu.test(fsPath);
}

export function uncompressedSessionPath(fsPath: string): string {
  return isCompressedSessionFile(fsPath) ? fsPath.slice(0, -4) : fsPath;
}

// Resolve only the two representations of this exact history; never substitute by conversation ID.
export async function resolveSessionFilePath(fsPath: string): Promise<string | undefined> {
  const plain = uncompressedSessionPath(fsPath);
  const candidates = isSessionFile(fsPath) && path.basename(plain).startsWith("rollout-")
    ? [plain, `${plain}.zst`]
    : [fsPath];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return undefined;
}

// Byte limits refer to decoded JSONL, whereas callers keep physical size/mtime for cache stamps.
export function createSessionReadStream(fsPath: string, options: SessionFileReadOptions = {}): Readable {
  if (options.endByteOffset !== undefined && (!Number.isSafeInteger(options.endByteOffset) || options.endByteOffset < 0)) {
    throw new Error("Invalid session read boundary.");
  }
  if (!isCompressedSessionFile(fsPath)) {
    if (options.endByteOffset === 0) return Readable.from([]);
    return fs.createReadStream(fsPath, {
      encoding: "utf8",
      ...(options.endByteOffset === undefined ? {} : { end: options.endByteOffset - 1 }),
    });
  }
  return Readable.from(readCompressedBytes(fsPath, options), { objectMode: false }).setEncoding("utf8");
}

export async function* readCompressedBytes(fsPath: string, options: SessionFileReadOptions = {}): AsyncGenerator<Buffer> {
  if (options.endByteOffset !== undefined && (!Number.isSafeInteger(options.endByteOffset) || options.endByteOffset < 0)) {
    throw new Error("Invalid session read boundary.");
  }
  if (options.endByteOffset === 0) return;
  const limit = options.maxDecodedBytes ?? MAX_DECODED_BYTES;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("Invalid decompression limit.");
  let size = 0;
  const bytes = readWasm(fsPath, options);
  for await (const chunk of bytes) {
    throwIfReadCancelled(options);
    size += chunk.byteLength;
    if (size > limit) throw new Error("Compressed history exceeds the decoded size limit (1 GiB).");
    const excess = options.endByteOffset === undefined ? 0 : Math.max(0, size - options.endByteOffset);
    const output = excess ? chunk.subarray(0, Math.max(0, chunk.byteLength - excess)) : chunk;
    if (output.byteLength) yield output;
    if (options.endByteOffset !== undefined && size >= options.endByteOffset) return;
  }
}

async function* readWasm(fsPath: string, options: SessionFileReadOptions): AsyncGenerator<Buffer> {
  // The library owns one streaming context, so hold its lock until completion or iterator cancellation.
  const previous = wasmQueue;
  let release!: () => void;
  wasmQueue = new Promise<void>(resolve => { release = resolve; });
  await previous;
  let input: fs.ReadStream | undefined;
  let decoder: WasmDecoder | undefined;
  try {
    throwIfReadCancelled(options);
    const runtime = require("../vendor/zstd.cjs") as { Zstd: { load(): Promise<WasmDecoder> } };
    decoder = await runtime.Zstd.load();
    decoder.resetDecompression();
    input = fs.createReadStream(fsPath, { highWaterMark: 64 * 1024 });
    let yieldedAt = Date.now();
    for await (const value of input) {
      const chunk = value as Buffer;
      for (let offset = 0; offset < chunk.length; offset += WASM_INPUT_BYTES) {
        throwIfReadCancelled(options);
        const output = decoder.decompressChunk(chunk.subarray(offset, offset + WASM_INPUT_BYTES));
        if (output.byteLength) yield Buffer.from(output.buffer, output.byteOffset, output.byteLength);
        if (Date.now() - yieldedAt >= 8) {
          await new Promise<void>(resolve => setImmediate(resolve));
          yieldedAt = Date.now();
        }
      }
      // Yield between source chunks so cancellation and other extension work can make progress.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    decoder.decompressEnd();
  } finally {
    input?.destroy();
    try { decoder?.resetDecompression(); } finally { release(); }
  }
}

function throwIfReadCancelled(options: SessionFileReadOptions): void {
  if (options.token?.isCancellationRequested) {
    throw options.cancellationErrorFactory?.() ?? new Error("Session reading was cancelled.");
  }
}
