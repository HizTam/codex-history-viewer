import type {
  ChatAttachment,
  ChatImageAttachment,
  ChatImageAttachmentReason,
  ChatToolExecution,
} from "./chatTypes";
import {
  extractImageAttachmentFromItem,
  type ChatImageExtractionOptions,
} from "./chatImageAttachments";

const MAX_TOOL_OUTPUT_ITEMS = 256;
const MAX_TOOL_OUTPUT_IMAGES = 32;
const MAX_TOOL_OUTPUT_TEXT_CHARS = 4 * 1024 * 1024;
const MAX_COMMAND_ITEMS = 128;
const MAX_COMMAND_ITEM_CHARS = 16 * 1024;
const MAX_COMMAND_TOTAL_CHARS = 64 * 1024;
const MAX_QUERY_ITEMS = 32;
const MAX_QUERY_CHARS = 8 * 1024;
const MAX_URL_CHARS = 16 * 1024;
const MAX_PROMPT_CHARS = 256 * 1024;
const DEFAULT_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const ABSOLUTE_IMAGE_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_IMAGE_LABEL = "image-attachment";

export interface ExtractedCodexToolOutput {
  text: string;
  attachments: ChatAttachment[];
}

export interface CodexStandaloneToolProjection {
  name: string;
  callId?: string;
  argumentsText?: string;
  execution?: ChatToolExecution;
  attachments: ChatAttachment[];
}

export function extractCodexToolOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return "";

  const parts: string[] = [];
  let remainingChars = MAX_TOOL_OUTPUT_TEXT_CHARS;
  for (const item of output.slice(0, MAX_TOOL_OUTPUT_ITEMS)) {
    if (remainingChars <= 0 || !isRecord(item) || item.type !== "input_text" || typeof item.text !== "string") {
      continue;
    }
    const text = item.text.slice(0, remainingChars);
    if (text) parts.push(text);
    remainingChars -= text.length;
  }
  return parts.join("");
}

export async function extractCodexToolOutput(
  output: unknown,
  sessionCwd?: string,
  imageOptions?: ChatImageExtractionOptions,
): Promise<ExtractedCodexToolOutput> {
  const text = extractCodexToolOutputText(output);
  if (!Array.isArray(output)) return { text, attachments: [] };

  const attachments: ChatAttachment[] = [];
  let imageCount = 0;
  for (const item of output.slice(0, MAX_TOOL_OUTPUT_ITEMS)) {
    if (!isRecord(item) || item.type !== "input_image" || imageCount >= MAX_TOOL_OUTPUT_IMAGES) continue;
    imageCount += 1;
    const image = await extractImageAttachmentFromItem(item, sessionCwd, imageOptions);
    if (image) attachments.push(image);
  }
  return { text, attachments };
}

export async function projectCodexStandaloneResponseItem(
  payload: unknown,
  imageOptions?: ChatImageExtractionOptions,
): Promise<CodexStandaloneToolProjection | null> {
  if (!isRecord(payload) || typeof payload.type !== "string") return null;

  if (payload.type === "local_shell_call") return projectLocalShellCall(payload);
  if (payload.type === "web_search_call") return projectWebSearchCall(payload);
  if (payload.type === "image_generation_call") return await projectImageGenerationCall(payload, imageOptions);
  return null;
}

function projectLocalShellCall(payload: Record<string, unknown>): CodexStandaloneToolProjection {
  const action = isRecord(payload.action) ? payload.action : null;
  const rawCommand = action?.command;
  const commandItems = Array.isArray(rawCommand) ? rawCommand : [];
  const command: string[] = [];
  let totalChars = 0;
  for (const value of commandItems.slice(0, MAX_COMMAND_ITEMS)) {
    if (typeof value !== "string" || totalChars >= MAX_COMMAND_TOTAL_CHARS) continue;
    const bounded = value.slice(0, Math.min(MAX_COMMAND_ITEM_CHARS, MAX_COMMAND_TOTAL_CHARS - totalChars));
    if (!bounded) continue;
    command.push(bounded);
    totalChars += bounded.length;
  }

  const args: Record<string, unknown> = { action: action?.type === "exec" ? "exec" : "unknown" };
  if (command.length > 0) args.command = command;
  const workingDirectory = readBoundedString(action?.working_directory, MAX_URL_CHARS);
  if (workingDirectory) args.working_directory = workingDirectory;
  const timeoutMs = readNonNegativeFiniteNumber(action?.timeout_ms);
  if (timeoutMs !== undefined) args.timeout_ms = timeoutMs;

  return {
    name: "shell_command",
    ...readCallId(payload.call_id),
    ...buildArgumentsText(args),
    ...readExecution(payload.status),
    attachments: [],
  };
}

function projectWebSearchCall(payload: Record<string, unknown>): CodexStandaloneToolProjection {
  const action = isRecord(payload.action) ? payload.action : null;
  const rawActionType = readBoundedString(action?.type, 64);
  const actionType =
    rawActionType === "search" ||
    rawActionType === "open_page" ||
    rawActionType === "find_in_page" ||
    rawActionType === "other"
      ? rawActionType
      : "other";
  const args: Record<string, unknown> = { action: actionType };

  if (actionType === "search") {
    const query = readBoundedString(action?.query, MAX_QUERY_CHARS);
    const queries = readBoundedStringArray(action?.queries, MAX_QUERY_ITEMS, MAX_QUERY_CHARS);
    if (query) args.query = query;
    if (queries.length > 0) args.queries = queries;
  } else if (actionType === "open_page") {
    const url = readBoundedString(action?.url, MAX_URL_CHARS);
    if (url) args.url = url;
  } else if (actionType === "find_in_page") {
    const url = readBoundedString(action?.url, MAX_URL_CHARS);
    const pattern = readBoundedString(action?.pattern, MAX_QUERY_CHARS);
    if (url) args.url = url;
    if (pattern) args.pattern = pattern;
  }

  return {
    name: "web_search",
    ...buildArgumentsText(args),
    ...readExecution(payload.status),
    attachments: [],
  };
}

async function projectImageGenerationCall(
  payload: Record<string, unknown>,
  imageOptions?: ChatImageExtractionOptions,
): Promise<CodexStandaloneToolProjection> {
  const prompt = readBoundedString(payload.revised_prompt, MAX_PROMPT_CHARS, false);
  const executionProjection = readExecution(payload.status);
  const normalizedStatus = executionProjection.execution?.status?.toLowerCase();
  const hasResult = typeof payload.result === "string" && payload.result.trim().length > 0;
  const attachments =
    !hasResult && (normalizedStatus === "in_progress" || normalizedStatus === "queued")
      ? []
      : [await extractImageGenerationAttachment(payload.result, imageOptions)];
  return {
    name: "image_generation",
    ...readCallId(payload.id),
    ...(prompt ? buildArgumentsText({ prompt }) : {}),
    ...executionProjection,
    attachments,
  };
}

async function extractImageGenerationAttachment(
  rawResult: unknown,
  imageOptions?: ChatImageExtractionOptions,
): Promise<ChatImageAttachment> {
  if (typeof rawResult !== "string") return createUnavailableImage("invalid");
  const result = rawResult.trim();
  if (!result) return createUnavailableImage("missing");

  const maxBytes = normalizeImageMaxBytes(imageOptions);
  const maxEncodedChars = Math.ceil(maxBytes / 3) * 4 + 512;
  if (result.length > maxEncodedChars) return createUnavailableImage("tooLarge", "image/png");

  if (/^data:/iu.test(result)) {
    if (!hasStrictBase64DataUriPayload(result)) return createUnavailableImage("invalid");
    return (
      (await extractImageAttachmentFromItem({ type: "input_image", image_url: result }, undefined, imageOptions)) ??
      createUnavailableImage("invalid")
    );
  }
  if (/^(?:https?:|sediment:\/\/|file-service:\/\/|blob:)/iu.test(result)) {
    return (
      (await extractImageAttachmentFromItem({ type: "input_image", image_url: result }, undefined, imageOptions)) ??
      createUnavailableImage("remote")
    );
  }
  if (!isStrictBase64(result)) return createUnavailableImage("invalid", "image/png");

  return (
    (await extractImageAttachmentFromItem(
      { type: "input_image", image_url: `data:image/png;base64,${result}` },
      undefined,
      imageOptions,
    )) ?? createUnavailableImage("invalid", "image/png")
  );
}

function isStrictBase64(value: string): boolean {
  if (!value || value.length % 4 !== 0) return false;
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value);
}

function hasStrictBase64DataUriPayload(value: string): boolean {
  const commaIndex = value.indexOf(",");
  if (commaIndex <= 5) return false;
  const metadata = value.slice(5, commaIndex);
  if (!/(?:^|;)base64(?:;|$)/iu.test(metadata)) return false;
  return isStrictBase64(value.slice(commaIndex + 1));
}

function normalizeImageMaxBytes(options?: ChatImageExtractionOptions): number {
  if (options?.enabled === false) return ABSOLUTE_IMAGE_MAX_BYTES;
  const maxBytes = Number(options?.maxBytes);
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return DEFAULT_IMAGE_MAX_BYTES;
  return Math.min(ABSOLUTE_IMAGE_MAX_BYTES, Math.floor(maxBytes));
}

function createUnavailableImage(
  reason: ChatImageAttachmentReason,
  mimeType?: string,
): ChatImageAttachment {
  return {
    type: "image",
    status: "unavailable",
    source: "reference",
    ...(mimeType ? { mimeType } : {}),
    label: DEFAULT_IMAGE_LABEL,
    reason,
  };
}

function readCallId(value: unknown): { callId?: string } {
  const callId = readBoundedString(value, 256);
  return callId && /^[A-Za-z0-9._:-]+$/u.test(callId) ? { callId } : {};
}

function readExecution(value: unknown): { execution?: ChatToolExecution } {
  const status = readBoundedString(value, 64);
  return status && /^[A-Za-z0-9_-]+$/u.test(status) ? { execution: { status } } : {};
}

function buildArgumentsText(value: Record<string, unknown>): { argumentsText?: string } {
  if (Object.keys(value).length === 0) return {};
  try {
    return { argumentsText: JSON.stringify(value) };
  } catch {
    return {};
  }
}

function readBoundedString(value: unknown, maxChars: number, trim = true): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = trim ? value.trim() : value;
  if (!text) return undefined;
  return text.slice(0, maxChars);
}

function readBoundedStringArray(
  value: unknown,
  maxItems: number,
  maxChars: number,
): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value.slice(0, maxItems)) {
    const text = readBoundedString(item, maxChars);
    if (text) result.push(text);
  }
  return result;
}

function readNonNegativeFiniteNumber(value: unknown): number | undefined {
  const numericText = typeof value === "string" ? value.trim() : "";
  const numberValue =
    typeof value === "number"
      ? value
      : numericText.length > 0 && numericText.length <= 32 && /^\d+(?:\.\d+)?$/u.test(numericText)
        ? Number(numericText)
        : NaN;
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
