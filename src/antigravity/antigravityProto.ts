import { ANTIGRAVITY_MAX_BLOB_BYTES, ANTIGRAVITY_MAX_COLLECTION_ITEMS } from "./antigravityTypes";

export class AntigravityProtoError extends Error {
  constructor(public readonly code: "wire" | "duplicate" | "bounds" | "utf8" | "value") {
    super(`Invalid Antigravity protocol: ${code}`);
    this.name = "AntigravityProtoError";
  }
}
type WireValue = { readonly wire: 0; readonly value: bigint } | { readonly wire: 1 | 2 | 5; readonly value: Uint8Array };

// Decode only descriptor-verified fields; unknown bytes are never interpreted as text or code.
export class AntigravityProto {
  private readonly values = new Map<number, WireValue[]>();
  constructor(bytes: Uint8Array, private readonly depth = 0) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > ANTIGRAVITY_MAX_BLOB_BYTES || depth > 32) throw new AntigravityProtoError("bounds");
    let offset = 0, count = 0;
    const varint = (): bigint => {
      let value = 0n;
      for (let index = 0; index < 10; index++) {
        if (offset >= bytes.byteLength) throw new AntigravityProtoError("wire");
        const byte = bytes[offset++]!;
        if (index === 9 && byte > 1) throw new AntigravityProtoError("wire");
        value |= BigInt(byte & 127) << BigInt(index * 7);
        if (byte < 128) return value;
      }
      throw new AntigravityProtoError("wire");
    };
    while (offset < bytes.byteLength) {
      if (++count > ANTIGRAVITY_MAX_COLLECTION_ITEMS) throw new AntigravityProtoError("bounds");
      const tag = varint(), field = Number(tag >> 3n), wire = Number(tag & 7n);
      if (field < 1 || field > 0x1fffffff) throw new AntigravityProtoError("wire");
      let value: WireValue;
      if (wire === 0) value = { wire, value: varint() };
      else if (wire === 1 || wire === 2 || wire === 5) {
        const length = wire === 2 ? varint() : BigInt(wire === 1 ? 8 : 4);
        if (length > BigInt(bytes.byteLength - offset)) throw new AntigravityProtoError("wire");
        const end = offset + Number(length);
        value = { wire, value: bytes.subarray(offset, end) }; offset = end;
      } else throw new AntigravityProtoError("wire");
      const existing = this.values.get(field);
      if (existing) existing.push(value); else this.values.set(field, [value]);
    }
  }

  public has(field: number): boolean { return this.values.has(field); }
  private single(field: number): WireValue | undefined {
    const values = this.values.get(field);
    if (values && values.length !== 1) throw new AntigravityProtoError("duplicate");
    return values?.[0];
  }
  public integer(field: number, signed = false): number | undefined {
    const value = this.single(field);
    if (!value) return undefined;
    if (value.wire !== 0) throw new AntigravityProtoError("wire");
    const integer = signed ? BigInt.asIntN(64, value.value) : value.value;
    if (integer > BigInt(Number.MAX_SAFE_INTEGER) || integer < BigInt(Number.MIN_SAFE_INTEGER)) throw new AntigravityProtoError("value");
    return Number(integer);
  }
  public boolean(field: number): boolean | undefined {
    const value = this.integer(field);
    if (value !== undefined && value !== 0 && value !== 1) throw new AntigravityProtoError("value");
    return value === undefined ? undefined : value === 1;
  }
  public bytes(field: number): Uint8Array | undefined {
    const value = this.single(field);
    if (!value) return undefined;
    if (value.wire !== 2) throw new AntigravityProtoError("wire");
    return value.value;
  }
  public string(field: number, maximum = ANTIGRAVITY_MAX_BLOB_BYTES): string | undefined {
    const value = this.bytes(field);
    if (!value) return undefined;
    if (value.byteLength > maximum) throw new AntigravityProtoError("bounds");
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value); }
    catch { throw new AntigravityProtoError("utf8"); }
  }
  public message(field: number): AntigravityProto | undefined {
    const value = this.bytes(field);
    return value ? new AntigravityProto(value, this.depth + 1) : undefined;
  }
  public messages(field: number): readonly AntigravityProto[] {
    return (this.values.get(field) ?? []).map(value => {
      if (value.wire !== 2) throw new AntigravityProtoError("wire");
      return new AntigravityProto(value.value, this.depth + 1);
    });
  }
  public strings(field: number, maximum = ANTIGRAVITY_MAX_BLOB_BYTES): readonly string[] {
    return (this.values.get(field) ?? []).map(value => {
      if (value.wire !== 2) throw new AntigravityProtoError("wire");
      if (value.value.byteLength > maximum) throw new AntigravityProtoError("bounds");
      try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value.value); }
      catch { throw new AntigravityProtoError("utf8"); }
    });
  }
}
