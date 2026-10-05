import { createHash } from "node:crypto";
import { readClaudeMessageUuid } from "../services/claudeNativeBookmarkReader";

export interface ClaudeProgress {
  kind: "narration" | "thinking" | "redactedThinking";
  progressId: string;
  body: string;
  blockIndex: number;
  durationMs?: number;
}

const MAX_SIGNATURE_CHARS = 262_144;

export function isClaudeProgressId(value: unknown): value is string {
  return typeof value === "string" && /^cp-[a-f0-9]{32}$/u.test(value);
}

// Read only saved assistant progress; signatures and redacted payloads never leave this module.
export function extractClaudeProgress(value: unknown, lineIndex: number): ClaudeProgress[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  if (record.type !== "assistant") return [];
  const message = record.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return [];
  const { role, content } = message as Record<string, unknown>;
  if (role !== undefined && role !== "assistant") return [];
  if (!Array.isArray(content)) return [];
  const uuid = readClaudeMessageUuid(record.uuid);
  const line = Number.isSafeInteger(lineIndex) && lineIndex >= 0 ? lineIndex : 0;
  // The line disambiguates repeated UUIDs without exposing raw identifiers to the Webview.
  const identity = `${uuid ? `uuid:${uuid}:` : ""}line:${line}`;
  const duration = record.thinkingDurationMs;
  const durationMs = typeof duration === "number" && Number.isFinite(duration) && duration >= 0 && duration <= Number.MAX_SAFE_INTEGER
    ? duration : undefined;
  const result: ClaudeProgress[] = [];
  for (const [blockIndex, block] of content.entries()) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    if (block.type !== "thinking" && block.type !== "redacted_thinking") continue;
    if (block.type === "thinking" && typeof block.thinking !== "string") continue;
    const body = block.type === "thinking" ? block.thinking.replace(/\r\n?/gu, "\n").trim() : "";
    // Keep a timed empty block only as metadata for the next visible output.
    // A record-level duration belongs to its first progress block, never every block.
    if (block.type === "thinking" && !body && (durationMs === undefined || result.length > 0)) continue;
    result.push({
      kind: block.type === "redacted_thinking" ? "redactedThinking"
        : body && isNarrationSignature(block.signature) ? "narration" : "thinking",
      progressId: `cp-${createHash("sha256").update(`${identity}:block:${blockIndex}`, "utf8").digest("hex").slice(0, 32)}`,
      body,
      blockIndex,
      ...(durationMs !== undefined && result.length === 0 ? { durationMs } : {}),
    });
  }
  return result;
}

// The native renderer identifies narration with protobuf fields 2 -> 1 -> 8.
// This is a display hint, not authentication or a reason to trust the message body.
function isNarrationSignature(value: unknown): boolean {
  if (typeof value !== "string" || !value || value.length > MAX_SIGNATURE_CHARS ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(value) || value.length % 4 === 1 ||
    (value.includes("=") && value.length % 4 !== 0)) return false;
  let bytes: Uint8Array | undefined = Buffer.from(value, "base64");
  for (const field of [2, 1, 8]) {
    bytes = readBytesField(bytes, field);
    if (!bytes) return false;
  }
  return Buffer.from(bytes).equals(Buffer.from("narration", "utf8"));
}

function readBytesField(bytes: Uint8Array, wanted: number): Uint8Array | undefined {
  let offset = 0;
  let found: Uint8Array | undefined;
  const readVarint = (): number | undefined => {
    let value = 0;
    let scale = 1;
    for (let count = 0; count < 10 && offset < bytes.length; count += 1) {
      const byte = bytes[offset++]!;
      value += (byte & 127) * scale;
      if (!Number.isSafeInteger(value)) return undefined;
      if ((byte & 128) === 0) return value;
      scale *= 128;
    }
    return undefined;
  };
  while (offset < bytes.length) {
    const tag = readVarint();
    if (tag === undefined || tag < 8) return undefined;
    const wire = tag % 8;
    const field = Math.floor(tag / 8);
    if (wire === 0) {
      if (readVarint() === undefined) return undefined;
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      if (offset > bytes.length) return undefined;
    } else if (wire === 2) {
      const length = readVarint();
      if (length === undefined || length > bytes.length - offset) return undefined;
      if (field === wanted) found = bytes.subarray(offset, offset + length);
      offset += length;
    } else return undefined;
  }
  return found;
}
