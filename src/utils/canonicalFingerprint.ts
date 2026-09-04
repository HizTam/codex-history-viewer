import { createHash, type Hash } from "node:crypto";

const MAX_FINGERPRINT_DOMAIN_LENGTH = 256;
const MAX_PENDING_UTF8_FRAMES = 128;

interface CanonicalHashWriter {
  readonly hash: Hash;
  readonly pendingUtf8: string[];
}

// Builds a domain-separated digest without relying on object property insertion order.
export function buildCanonicalFingerprint(domain: string, value: unknown): string | undefined {
  if (
    typeof domain !== "string" ||
    domain.length === 0 ||
    domain.length > MAX_FINGERPRINT_DOMAIN_LENGTH ||
    hasUnpairedSurrogate(domain)
  ) {
    return undefined;
  }

  try {
    const writer: CanonicalHashWriter = {
      hash: createHash("sha256"),
      pendingUtf8: [],
    };
    updateStringFrame(writer, "domain", domain);
    const activeObjects = new Set<object>();
    updateCanonicalValue(writer, value, activeObjects);
    flushPendingUtf8(writer);
    return writer.hash.digest("hex");
  } catch {
    return undefined;
  }
}

function updateCanonicalValue(writer: CanonicalHashWriter, value: unknown, activeObjects: Set<object>): void {
  if (value === null) {
    updateAsciiFrame(writer, "null", "");
    return;
  }

  if (typeof value === "string") {
    updateStringFrame(writer, "string", value);
    return;
  }
  if (typeof value === "boolean") {
    updateAsciiFrame(writer, "boolean", value ? "1" : "0");
    return;
  }
  if (typeof value === "number") {
    updateNumberFrame(writer, value);
    return;
  }
  if (typeof value === "undefined") {
    updateAsciiFrame(writer, "undefined", "");
    return;
  }
  if (typeof value !== "object") {
    throw new TypeError("Unsupported canonical fingerprint value.");
  }
  if (activeObjects.has(value)) throw new TypeError("Circular canonical fingerprint value.");

  activeObjects.add(value);
  try {
    if (Array.isArray(value)) {
      updateAsciiFrame(writer, "array-start", String(value.length));
      for (const item of value) updateCanonicalValue(writer, item, activeObjects);
      updateAsciiFrame(writer, "array-end", "");
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Only plain objects can be fingerprinted canonically.");
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    updateAsciiFrame(writer, "object-start", String(keys.length));
    for (const key of keys) {
      updateStringFrame(writer, "key", key);
      updateCanonicalValue(writer, record[key], activeObjects);
    }
    updateAsciiFrame(writer, "object-end", "");
  } finally {
    activeObjects.delete(value);
  }
}

function updateNumberFrame(writer: CanonicalHashWriter, value: number): void {
  const normalized = Object.is(value, -0) ? 0 : value;
  if (
    !Number.isFinite(normalized) ||
    normalized < 0 ||
    (Number.isInteger(normalized) && !Number.isSafeInteger(normalized))
  ) {
    throw new TypeError("Invalid canonical fingerprint number.");
  }
  updateAsciiFrame(writer, "number", String(normalized));
}

function updateStringFrame(writer: CanonicalHashWriter, tag: string, value: string): void {
  if (!hasUnpairedSurrogate(value)) {
    appendPendingUtf8(writer, `${tag}:utf8:${Buffer.byteLength(value, "utf8")}:${value};`);
    return;
  }

  appendPendingUtf8(writer, `${tag}:utf16le:${Buffer.byteLength(value, "utf16le")}:`);
  flushPendingUtf8(writer);
  writer.hash.update(value, "utf16le");
  appendPendingUtf8(writer, ";");
}

function updateAsciiFrame(writer: CanonicalHashWriter, tag: string, value: string): void {
  appendPendingUtf8(writer, `${tag}:${value.length}:${value};`);
}

function appendPendingUtf8(writer: CanonicalHashWriter, value: string): void {
  writer.pendingUtf8.push(value);
  if (writer.pendingUtf8.length >= MAX_PENDING_UTF8_FRAMES) flushPendingUtf8(writer);
}

function flushPendingUtf8(writer: CanonicalHashWriter): void {
  if (writer.pendingUtf8.length === 0) return;
  writer.hash.update(writer.pendingUtf8.join(""), "utf8");
  writer.pendingUtf8.length = 0;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return true;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return true;
  }
  return false;
}
