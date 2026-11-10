import { StringDecoder } from "node:string_decoder";
import type { IndexedSearchMessage, IndexedSearchRole } from "./searchIndexService";

const TEXT_CHUNK_UNITS = 65_536;
const TOOL_TEXT_CHUNK_BYTES = 65_536;
const REPAIR_CHECKPOINT_INTERVAL = 1024;
const TEXT_BLOCK_BYTES = 8 * 1024 * 1024;
const ROLES: readonly IndexedSearchRole[] = ["user", "assistant", "developer", "tool"];
const SOURCES: readonly IndexedSearchMessage["source"][] = ["message", "toolArguments", "toolOutput"];

interface MessageExtra {
  readonly ordinal: number;
  readonly inputId?: string;
  readonly progressId?: string;
}

interface PackedData {
  readonly text: readonly Buffer[];
  readonly textEnds: Float64Array;
  readonly messageIndexes: Float64Array;
  readonly kinds: Uint8Array;
  readonly repairEnds: Float64Array;
  readonly repairPositions: Float64Array;
  readonly repairValues: Uint16Array;
  readonly extras: readonly MessageExtra[];
}

export interface PackedSearchMessageReader {
  (): readonly IndexedSearchMessage[];
  readonly iterateToolTexts: (checkpoint: () => Promise<void>) => AsyncIterable<string>;
}

// Keep the returned reader in a separate scope so it cannot retain the raw input strings.
export async function packSearchMessages(
  messages: readonly IndexedSearchMessage[],
  checkpoint: () => Promise<void>,
): Promise<PackedSearchMessageReader> {
  if (!Array.isArray(messages)) throw new TypeError("Invalid indexed message collection");
  const count = messages.length;
  const textEnds = new Float64Array(count);
  const messageIndexes = new Float64Array(count);
  const kinds = new Uint8Array(count);
  const repairEnds = new Float64Array(count);
  const extras: MessageExtra[] = [];
  // Snapshot scalar values before yielding; callers cannot change the second pass's inputs.
  const texts = new Array<string>(count);
  let byteCount = 0;
  let repairCount = 0;
  await checkpoint();
  for (let ordinal = 0; ordinal < count; ordinal++) {
    const message = messages[ordinal];
    if (!message || typeof message !== "object" || typeof message.text !== "string" ||
        !Number.isFinite(message.messageIndex)) throw new TypeError("Invalid indexed message");
    const role = ROLES.indexOf(message.role);
    const source = SOURCES.indexOf(message.source);
    if (role < 0 || source < 0 ||
        (message.inputId !== undefined && typeof message.inputId !== "string") ||
        (message.progressId !== undefined && typeof message.progressId !== "string") ||
        (message.progressKind !== undefined && message.progressKind !== "narration" && message.progressKind !== "thinking")) {
      throw new TypeError("Invalid indexed message metadata");
    }
    messageIndexes[ordinal] = message.messageIndex;
    const progress = message.progressKind === "narration" ? 1 : message.progressKind === "thinking" ? 2 : 0;
    kinds[ordinal] = (role << 4) | (progress << 2) | source;
    if (message.inputId !== undefined || message.progressId !== undefined) {
      extras.push(Object.freeze({
        ordinal,
        ...(message.inputId !== undefined ? { inputId: message.inputId } : {}),
        ...(message.progressId !== undefined ? { progressId: message.progressId } : {}),
      }));
    }
    const text = message.text;
    texts[ordinal] = text;
    for (let start = 0; start < text.length;) {
      const end = nextTextChunkEnd(text, start);
      const chunk = text.slice(start, end);
      byteCount += Buffer.byteLength(chunk, "utf8");
      // Unicode mode matches unpaired code units while excluding valid surrogate pairs.
      for (const _match of chunk.matchAll(/[\uD800-\uDFFF]/gu)) repairCount++;
      if (!Number.isSafeInteger(byteCount) || !Number.isSafeInteger(repairCount)) {
        throw new RangeError("Indexed message storage exceeds the supported count");
      }
      start = end;
      await checkpoint();
    }
    textEnds[ordinal] = byteCount;
    repairEnds[ordinal] = repairCount;
    await checkpoint();
  }

  const text = new Array<Buffer>(Math.ceil(byteCount / TEXT_BLOCK_BYTES));
  for (let ordinal = 0; ordinal < text.length; ordinal++) {
    await checkpoint();
    text[ordinal] = Buffer.allocUnsafeSlow(Math.min(TEXT_BLOCK_BYTES, byteCount - ordinal * TEXT_BLOCK_BYTES));
  }
  const repairPositions = new Float64Array(repairCount);
  const repairValues = new Uint16Array(repairCount);
  let byteOffset = 0;
  let repairOrdinal = 0;
  for (let ordinal = 0; ordinal < count; ordinal++) {
    const value = texts[ordinal];
    for (let start = 0; start < value.length;) {
      const end = nextTextChunkEnd(value, start);
      const chunk = value.slice(start, end);
      const bytes = Buffer.from(chunk, "utf8");
      for (let offset = 0; offset < bytes.byteLength;) {
        const blockOrdinal = Math.floor(byteOffset / TEXT_BLOCK_BYTES);
        const blockOffset = byteOffset % TEXT_BLOCK_BYTES;
        const length = Math.min(bytes.byteLength - offset, text[blockOrdinal].byteLength - blockOffset);
        bytes.copy(text[blockOrdinal], blockOffset, offset, offset + length);
        byteOffset += length;
        offset += length;
      }
      for (const match of chunk.matchAll(/[\uD800-\uDFFF]/gu)) {
        repairPositions[repairOrdinal] = start + match.index;
        repairValues[repairOrdinal++] = chunk.charCodeAt(match.index);
      }
      start = end;
      await checkpoint();
    }
    await checkpoint();
  }
  if (byteOffset !== byteCount || repairOrdinal !== repairCount) {
    throw new Error("Indexed message packing did not preserve its declared shape");
  }
  return createPackedReader({ text, textEnds, messageIndexes, kinds, repairEnds, repairPositions, repairValues, extras });
}

function nextTextChunkEnd(text: string, start: number): number {
  const end = Math.min(text.length, start + TEXT_CHUNK_UNITS);
  if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) return end - 1;
  return end;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

function createPackedReader(data: PackedData): PackedSearchMessageReader {
  const read = () => {
    const messages = new Array<IndexedSearchMessage>(data.messageIndexes.length);
    let byteStart = 0;
    let repairStart = 0;
    let extraOrdinal = 0;
    for (let ordinal = 0; ordinal < messages.length; ordinal++) {
      const byteEnd = data.textEnds[ordinal];
      const repairEnd = data.repairEnds[ordinal];
      const text = restoreSurrogates(readText(data.text, byteStart, byteEnd), data, repairStart, repairEnd);
      const kind = data.kinds[ordinal];
      const progress = (kind >> 2) & 0x03;
      const extra = data.extras[extraOrdinal]?.ordinal === ordinal ? data.extras[extraOrdinal++] : undefined;
      messages[ordinal] = Object.freeze({
        messageIndex: data.messageIndexes[ordinal],
        role: ROLES[kind >> 4],
        source: SOURCES[kind & 0x03],
        text,
        ...(extra?.inputId !== undefined ? { inputId: extra.inputId } : {}),
        ...(extra?.progressId !== undefined ? { progressId: extra.progressId } : {}),
        ...(progress ? { progressKind: progress === 1 ? "narration" as const : "thinking" as const } : {}),
      });
      byteStart = byteEnd;
      repairStart = repairEnd;
    }
    return Object.freeze(messages);
  };
  return Object.defineProperty(read, "iterateToolTexts", {
    value: (checkpoint: () => Promise<void>): AsyncIterable<string> => iteratePackedToolTexts(data, checkpoint),
  }) as PackedSearchMessageReader;
}

async function* iteratePackedToolTexts(
  data: PackedData,
  checkpoint: () => Promise<void>,
): AsyncIterable<string> {
  await checkpoint();
  for (let ordinal = 0; ordinal < data.messageIndexes.length; ordinal++) {
    const source = data.kinds[ordinal] & 0x03;
    // Metadata-only scans must remain cancellable without decoding ordinary messages.
    await checkpoint();
    if (source !== 1 && source !== 2) continue;
    const byteStart = ordinal === 0 ? 0 : data.textEnds[ordinal - 1];
    const repairStart = ordinal === 0 ? 0 : data.repairEnds[ordinal - 1];
    yield await readToolText(data, byteStart, data.textEnds[ordinal], repairStart, data.repairEnds[ordinal], checkpoint);
  }
}

async function readToolText(
  data: PackedData,
  byteStart: number,
  byteEnd: number,
  repairStart: number,
  repairEnd: number,
  checkpoint: () => Promise<void>,
): Promise<string> {
  // Each invocation owns its decoder and cursors, including concurrent or abandoned iterators.
  const decoder = new StringDecoder("utf8");
  const parts: string[] = [];
  let byteOffset = byteStart;
  let textOffset = 0;
  let repairCursor = repairStart;
  const appendFragment = async (fragment: string): Promise<void> => {
    const restored = await restoreTextFragment(fragment, textOffset, data, repairCursor, repairEnd, checkpoint);
    if (restored.text.length > 0) parts.push(restored.text);
    textOffset += fragment.length;
    repairCursor = restored.repairCursor;
    await checkpoint();
  };

  while (byteOffset < byteEnd) {
    const blockOrdinal = Math.floor(byteOffset / TEXT_BLOCK_BYTES);
    const blockOffset = byteOffset % TEXT_BLOCK_BYTES;
    const length = Math.min(TOOL_TEXT_CHUNK_BYTES, byteEnd - byteOffset, data.text[blockOrdinal].byteLength - blockOffset);
    await appendFragment(decoder.write(data.text[blockOrdinal].subarray(blockOffset, blockOffset + length)));
    byteOffset += length;
  }
  await appendFragment(decoder.end());
  const text = parts.join("");
  await checkpoint();
  return text;
}

async function restoreTextFragment(
  text: string,
  textOffset: number,
  data: PackedData,
  repairCursor: number,
  repairEnd: number,
  checkpoint: () => Promise<void>,
): Promise<{ readonly text: string; readonly repairCursor: number }> {
  const textEnd = textOffset + text.length;
  if (repairCursor === repairEnd || data.repairPositions[repairCursor] >= textEnd) {
    return { text, repairCursor };
  }
  const parts: string[] = [];
  let cursor = 0;
  let repairsSinceCheckpoint = 0;
  while (repairCursor < repairEnd && data.repairPositions[repairCursor] < textEnd) {
    const position = data.repairPositions[repairCursor] - textOffset;
    if (cursor < position) parts.push(text.slice(cursor, position));
    parts.push(String.fromCharCode(data.repairValues[repairCursor++]));
    cursor = position + 1;
    if (++repairsSinceCheckpoint === REPAIR_CHECKPOINT_INTERVAL) {
      repairsSinceCheckpoint = 0;
      await checkpoint();
    }
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return { text: parts.join(""), repairCursor };
}

function readText(blocks: readonly Buffer[], start: number, end: number): string {
  if (start === end) return "";
  const first = Math.floor(start / TEXT_BLOCK_BYTES);
  const last = Math.floor((end - 1) / TEXT_BLOCK_BYTES);
  if (first === last) return blocks[first].toString("utf8", start % TEXT_BLOCK_BYTES, (end - first * TEXT_BLOCK_BYTES));
  const decoder = new StringDecoder("utf8");
  const parts: string[] = [];
  for (let ordinal = first; ordinal <= last; ordinal++) {
    const low = ordinal === first ? start % TEXT_BLOCK_BYTES : 0;
    const high = Math.min(blocks[ordinal].byteLength, end - ordinal * TEXT_BLOCK_BYTES);
    parts.push(decoder.write(blocks[ordinal].subarray(low, high)));
  }
  parts.push(decoder.end());
  return parts.join("");
}

function restoreSurrogates(text: string, data: PackedData, start: number, end: number): string {
  if (start === end) return text;
  const parts: string[] = [];
  let cursor = 0;
  while (start < end) {
    const windowStart = Math.floor(data.repairPositions[start] / TEXT_CHUNK_UNITS) * TEXT_CHUNK_UNITS;
    const windowEnd = Math.min(text.length, windowStart + TEXT_CHUNK_UNITS);
    if (cursor < windowStart) parts.push(text.slice(cursor, windowStart));
    const repaired: string[] = [];
    cursor = windowStart;
    // Bound temporary piece counts even if an entire input consists of isolated surrogates.
    while (start < end && data.repairPositions[start] < windowEnd) {
      const position = data.repairPositions[start];
      if (cursor < position) repaired.push(text.slice(cursor, position));
      repaired.push(String.fromCharCode(data.repairValues[start++]));
      cursor = position + 1;
    }
    if (cursor < windowEnd) repaired.push(text.slice(cursor, windowEnd));
    parts.push(repaired.join(""));
    cursor = windowEnd;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.join("");
}
