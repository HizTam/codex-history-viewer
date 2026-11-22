import { AntigravityProto, AntigravityProtoError } from "./antigravityProto";
import { decodeAntigravityFileEdit } from "./antigravityFileEdit";
import type { AntigravityAttachment, AntigravityFileEvidence, AntigravityIssue, AntigravityMetadata, AntigravityStep, AntigravityToolCall, AntigravityUsage } from "./antigravityTypes";
import { ANTIGRAVITY_MAX_COLLECTION_ITEMS, ANTIGRAVITY_UUID } from "./antigravityTypes";

const SMALL_TEXT = 32768;
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function timestamp(value: AntigravityProto | undefined): string | undefined {
  if (!value) return undefined;
  const seconds = value.integer(1, true) ?? 0, nanos = value.integer(2) ?? 0;
  if (nanos > 999999999) throw new AntigravityProtoError("value");
  const milliseconds = seconds * 1000 + Math.floor(nanos / 1000000);
  if (!Number.isSafeInteger(milliseconds)) throw new AntigravityProtoError("value");
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) throw new AntigravityProtoError("value");
  return date.toISOString();
}

function tool(value: AntigravityProto | undefined): AntigravityToolCall | undefined {
  if (!value) return undefined;
  const id = value.string(1, SMALL_TEXT) ?? "", name = value.string(2, SMALL_TEXT) ?? "";
  const argumentsJson = value.string(3) ?? "";
  if (!id || !name || /[\u0000-\u001f]/.test(id) || /[\u0000-\u001f]/.test(name)) throw new AntigravityProtoError("value");
  return { id, name, argumentsJson };
}

function usage(metadata: AntigravityProto | undefined): AntigravityUsage | undefined {
  const value = metadata?.message(9);
  if (!value) return undefined;
  const info = metadata?.message(24);
  // Header, signature, raw thinking and user identity fields are deliberately never decoded.
  return {
    model: info?.string(20, SMALL_TEXT) || info?.string(8, SMALL_TEXT) || info?.string(12, SMALL_TEXT) || undefined,
    modelNumber: value.integer(1), providerNumber: value.integer(6),
    inputTokens: value.integer(2), outputTokens: value.integer(3), cacheWriteTokens: value.integer(4), cacheReadTokens: value.integer(5),
    messageId: value.string(7, SMALL_TEXT), thinkingOutputTokens: value.integer(9), responseOutputTokens: value.integer(10),
    responseId: value.string(11, SMALL_TEXT),
  };
}

function image(value: AntigravityProto): AntigravityAttachment {
  const mimeType = value.string(2, 256), uri = value.string(4, SMALL_TEXT), label = value.string(3, SMALL_TEXT);
  const base64 = value.string(1);
  if (base64 !== undefined && (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64))) throw new AntigravityProtoError("value");
  return { kind: "image", mimeType, uri, label, base64 };
}

function media(value: AntigravityProto): AntigravityAttachment {
  const mimeType = value.string(1, 256), uri = value.string(5, SMALL_TEXT), label = value.string(9, SMALL_TEXT) || value.string(4, SMALL_TEXT);
  const inline = value.bytes(2), supported = mimeType && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mimeType.toLowerCase());
  // Arbitrary binary media and blob references are not fetched or turned into executable URIs.
  return { kind: mimeType?.startsWith("image/") ? "image" : "file", mimeType, uri, label,
    base64: supported && inline && inline.byteLength <= 12 * 1024 * 1024 ? Buffer.from(inline).toString("base64") : undefined };
}

function userInput(value: AntigravityProto, issues: Set<AntigravityIssue>): NonNullable<AntigravityStep["input"]> {
  const query = value.string(1), response = value.string(2);
  const textItems: string[] = [], attachments: AntigravityAttachment[] = [];
  for (const part of value.messages(3)) {
    if (part.has(1) && part.has(2)) { issues.add("invalidStep"); continue; }
    const text = part.string(1);
    if (text !== undefined) textItems.push(text);
    const scope = part.message(2);
    if (!scope) continue;
    // Scope items are contextual attachments, never additional human instructions.
    for (const field of [1, 2]) {
      const file = scope.message(field);
      if (!file) continue;
      const uri = file.string(5, SMALL_TEXT), absolutePath = file.string(1, SMALL_TEXT);
      if (uri || absolutePath) attachments.push({ kind: "file", uri, path: absolutePath });
    }
  }
  for (const [field, decode] of [[5, image], [9, media]] as const) for (const item of value.messages(field)) {
    try { attachments.push(decode(item)); }
    catch (error) { if (!(error instanceof AntigravityProtoError)) throw error; issues.add("unsupportedAttachment"); }
  }
  if (attachments.length > ANTIGRAVITY_MAX_COLLECTION_ITEMS) throw new AntigravityProtoError("bounds");
  // The native user_response and text item can contain the same input; choose one representation.
  const text = query || textItems.join("\n") || response || "";
  return { text, attachments, queued: value.boolean(6) ?? false, clientMessageId: value.string(19, SMALL_TEXT) };
}

function planner(value: AntigravityProto): NonNullable<AntigravityStep["planner"]> {
  const redacted = value.boolean(5) ?? false;
  const duration = value.message(11), seconds = duration?.integer(1), nanos = duration?.integer(2);
  const thinkingDurationMs = duration ? (seconds ?? 0) * 1000 + Math.floor((nanos ?? 0) / 1000000) : undefined;
  if ((nanos ?? 0) > 999999999 || thinkingDurationMs !== undefined && !Number.isSafeInteger(thinkingDurationMs)) throw new AntigravityProtoError("value");
  return {
    text: value.string(8) ?? value.string(1) ?? "",
    thinking: redacted ? undefined : value.string(3),
    redactedThinking: redacted, thinkingDurationMs,
    messageId: value.string(6, SMALL_TEXT), stopReason: value.integer(12),
    tools: value.messages(7).map(entry => tool(entry)!),
  };
}

function files(render: AntigravityProto | undefined): AntigravityFileEvidence[] {
  const output: AntigravityFileEvidence[] = [];
  for (const part of render?.messages(9) ?? []) {
    const diff = part.message(4);
    if (!diff) continue;
    const uri = diff.string(1, SMALL_TEXT), stats = diff.message(2);
    if (!uri) continue;
    // Keep the wire values for existing bookmark identities and track message presence separately.
    const additions = stats?.integer(1, true), deletions = stats?.integer(2, true);
    if ((additions !== undefined && additions < 0) || (deletions !== undefined && deletions < 0)) throw new AntigravityProtoError("value");
    output.push({ uri, additions, deletions, ...(stats ? { hasDiffStats: true } : {}) });
  }
  return output;
}

type FileEditCollector = {
  includeContent: boolean;
  collect(value: Exclude<ReturnType<typeof decodeAntigravityFileEdit>, undefined>): void;
};

function generic(value: AntigravityProto, issues: Set<AntigravityIssue>, renderBytes?: Uint8Array, collectFileEdit?: FileEditCollector): NonNullable<AntigravityStep["generic"]> {
  const args: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const entry of value.messages(1)) {
    const key = entry.string(1, SMALL_TEXT), content = entry.string(2);
    if (key === undefined || content === undefined || own(args, key)) throw new AntigravityProtoError("duplicate");
    args[key] = content;
  }
  const result = value.message(2);
  if (result?.has(5) || result?.has(6) || result?.has(8) || result?.has(9) || result?.has(10) || result?.has(11)) issues.add("unknownPayload");
  if (result?.messages(4).length) issues.add("unsupportedAttachment");
  const render = result?.message(3) ?? (renderBytes ? new AntigravityProto(renderBytes) : undefined);
  const decoded = { arguments: args, output: result?.string(1) ?? "", files: files(render), hidden: render?.boolean(4) ?? false };
  if (collectFileEdit && result?.has(6)) {
    const fileEdit = decodeAntigravityFileEdit(result, collectFileEdit.includeContent);
    if (fileEdit !== undefined) collectFileEdit.collect(fileEdit);
  }
  return decoded;
}

export interface AntigravityStepRow {
  readonly index: number;
  readonly type: number;
  readonly status: number;
  readonly format: number;
  readonly metadata?: Uint8Array;
  readonly renderInfo?: Uint8Array;
  readonly payload?: Uint8Array;
}

export function decodeAntigravityStep(row: AntigravityStepRow, collectFileEdit?: FileEditCollector): AntigravityStep {
  if (![row.index, row.type, row.status, row.format].every(value => Number.isSafeInteger(value) && value >= 0)) throw new AntigravityProtoError("value");
  const issues = new Set<AntigravityIssue>();
  const base = { index: row.index, type: row.type, status: row.status };
  if (row.format !== 0) return { ...base, issues: ["unknownPayload"] };
  try {
    const payload = row.payload ? new AntigravityProto(row.payload) : undefined;
    if (payload && ((payload.integer(1) ?? 0) !== row.type || (payload.integer(4) ?? 0) !== row.status)) throw new AntigravityProtoError("value");
    const nativeMetadata = payload?.bytes(5);
    if (row.metadata && nativeMetadata && !Buffer.from(row.metadata).equals(nativeMetadata)) throw new AntigravityProtoError("value");
    const metadata = row.metadata ? new AntigravityProto(row.metadata) : payload?.message(5);
    let decodedUsage: AntigravityUsage | undefined;
    try { decodedUsage = usage(metadata); }
    catch (error) { if (!(error instanceof AntigravityProtoError)) throw error; issues.add("unknownUsage"); }
    const result: AntigravityStep = {
      ...base, createdAtIso: timestamp(metadata?.message(1)), startedAtIso: timestamp(metadata?.message(32)),
      completedAtIso: timestamp(metadata?.message(8)) ?? timestamp(metadata?.message(7)),
      executionId: metadata?.string(12, SMALL_TEXT), tool: tool(metadata?.message(29) ?? metadata?.message(4)),
      usage: decodedUsage,
      input: row.type === 14 && payload?.has(19) ? userInput(payload.message(19)!, issues) : undefined,
      planner: row.type === 15 && payload?.has(20) ? planner(payload.message(20)!) : undefined,
      generic: row.type === 132 && payload?.has(140) ? generic(payload.message(140)!, issues, row.renderInfo, collectFileEdit) : undefined,
      issues: [],
    };
    if (![14, 15, 132].includes(row.type)) issues.add("unknownStep");
    else if (!result.input && !result.planner && !result.generic) issues.add("unknownPayload");
    return { ...result, issues: [...issues] };
  } catch (error) {
    if (!(error instanceof AntigravityProtoError)) throw error;
    return { ...base, issues: ["invalidStep"] };
  }
}

export function decodeAntigravityMetadata(conversationId: string, trajectoryId: string, bytes?: Uint8Array): AntigravityMetadata {
  if (!ANTIGRAVITY_UUID.test(conversationId) || !ANTIGRAVITY_UUID.test(trajectoryId)) throw new AntigravityProtoError("value");
  const value = bytes ? new AntigravityProto(bytes) : undefined;
  const workspaceUris = [...(value?.messages(1).map(entry => entry.string(1, SMALL_TEXT)).filter((entry): entry is string => Boolean(entry)) ?? []), ...(value?.strings(7, SMALL_TEXT) ?? [])];
  return { conversationId, trajectoryId, createdAtIso: timestamp(value?.message(2)), workspaceUris: [...new Set(workspaceUris)] };
}
