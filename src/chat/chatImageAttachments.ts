import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatImageAttachment, ChatImageAttachmentReason } from "./chatTypes";

const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_PLACEHOLDER_RE = /<image\b[^>]*>\s*<\/image>|<image\b[^>]*\/>|<image\b[^>]*>|<\/image>/giu;

const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const IMAGE_MIME_BY_EXTENSION = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

export interface ChatImageExtractionOptions {
  enabled?: boolean;
  maxBytes?: number;
}

export interface ExtractedMessageContent {
  text: string;
  images: ChatImageAttachment[];
}

export async function extractCodexMessageContent(
  content: unknown,
  sessionCwd?: string,
  options?: ChatImageExtractionOptions,
): Promise<ExtractedMessageContent> {
  if (!Array.isArray(content)) return { text: "", images: [] };

  const imageOptions = normalizeImageExtractionOptions(options);
  const texts: string[] = [];
  const images: ChatImageAttachment[] = [];
  let placeholderCount = 0;

  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const maybeText = readStringField(item, "text");
    if (maybeText) {
      const stripped = stripImagePlaceholders(maybeText);
      placeholderCount += stripped.placeholderCount;
      if (stripped.text) texts.push(stripped.text);
    }

    const image = await extractImageAttachment(item, sessionCwd, imageOptions);
    if (image) images.push(image);
  }

  addUnavailablePlaceholderIfNeeded(images, placeholderCount, imageOptions.enabled ? "remote" : "disabled");
  return { text: texts.join(""), images };
}

export async function extractClaudeImageAttachments(
  content: unknown,
  sessionCwd?: string,
  options?: ChatImageExtractionOptions,
): Promise<ChatImageAttachment[]> {
  const imageOptions = normalizeImageExtractionOptions(options);
  const items = Array.isArray(content) ? content : content && typeof content === "object" ? [content] : [];
  const images: ChatImageAttachment[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const image = await extractImageAttachment(item, sessionCwd, imageOptions);
    if (image) images.push(image);
  }
  return images;
}

export function stripImagePlaceholders(text: string): { text: string; placeholderCount: number } {
  let placeholderCount = 0;
  const stripped = String(text ?? "").replace(IMAGE_PLACEHOLDER_RE, () => {
    placeholderCount += 1;
    return "";
  });
  return { text: stripped, placeholderCount };
}

export function addUnavailablePlaceholderIfNeeded(
  images: ChatImageAttachment[],
  placeholderCount: number,
  reason: ChatImageAttachmentReason = "remote",
): void {
  if (placeholderCount <= 0 || images.length > 0) return;
  images.push(createUnavailableImageAttachment(reason));
}

async function extractImageAttachment(
  item: object,
  sessionCwd: string | undefined,
  options: Required<ChatImageExtractionOptions>,
): Promise<ChatImageAttachment | null> {
  const type = normalizeType(readStringField(item, "type"));
  const contentType = normalizeType(readStringField(item, "content_type"));
  const source = readObjectField(item, "source");
  const hasBase64Source = hasBase64ImageSource(source, type, contentType);
  const imageUrl = readImageUrlCandidate(item, type, contentType);
  const localPath = readLocalPathCandidate(item, type, contentType);
  const hasReferenceOnlyPointer =
    type === "imageassetpointer" || contentType === "imageassetpointer" || hasReferenceOnlyImagePointer(item);

  if (!options.enabled) {
    return hasBase64Source || imageUrl || localPath || hasReferenceOnlyPointer
      ? createUnavailableImageAttachment("disabled")
      : null;
  }

  const base64Image = imageFromBase64Source(source, type, contentType, options.maxBytes);
  if (base64Image) return base64Image;

  if (imageUrl) return await imageFromStringReference(imageUrl, sessionCwd, options.maxBytes);

  if (localPath) return await imageFromLocalPath(localPath, sessionCwd, options.maxBytes);

  if (hasReferenceOnlyPointer) {
    return createUnavailableImageAttachment("remote");
  }

  return null;
}

function normalizeImageExtractionOptions(options?: ChatImageExtractionOptions): Required<ChatImageExtractionOptions> {
  const maxBytes = Number(options?.maxBytes);
  return {
    enabled: options?.enabled ?? true,
    maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : MAX_INLINE_IMAGE_BYTES,
  };
}

function hasBase64ImageSource(source: Record<string, unknown> | null, type: string, contentType: string): boolean {
  if (!source) return false;
  const sourceType = normalizeType(readStringField(source, "type"));
  if (sourceType !== "base64") return false;
  const mediaType = normalizeMimeType(readStringField(source, "media_type") || readStringField(source, "mime_type"));
  return !mediaType || mediaType.startsWith("image/") || isImageLikeType(type, contentType);
}

function imageFromBase64Source(
  source: Record<string, unknown> | null,
  type: string,
  contentType: string,
  maxBytes: number,
): ChatImageAttachment | null {
  if (!source) return null;
  const sourceType = normalizeType(readStringField(source, "type"));
  if (sourceType !== "base64") return null;

  const mediaType = normalizeMimeType(readStringField(source, "media_type") || readStringField(source, "mime_type"));
  const data = readStringField(source, "data");
  if (mediaType && !mediaType.startsWith("image/") && !isImageLikeType(type, contentType)) return null;
  if (!mediaType || !data) return createUnavailableImageAttachment("invalid");
  return imageFromDataUri(`data:${mediaType};base64,${data}`, maxBytes);
}

async function imageFromStringReference(
  value: string,
  sessionCwd: string | undefined,
  maxBytes: number,
): Promise<ChatImageAttachment> {
  const trimmed = value.trim();
  if (!trimmed) return createUnavailableImageAttachment("invalid");

  if (trimmed.toLowerCase().startsWith("data:")) return imageFromDataUri(trimmed, maxBytes);
  if (isRemoteOrApiReference(trimmed)) return createUnavailableImageAttachment("remote");
  return await imageFromLocalPath(trimmed, sessionCwd, maxBytes);
}

function imageFromDataUri(src: string, maxBytes: number): ChatImageAttachment {
  const parsed = parseDataImageUri(src);
  if (!parsed) return createUnavailableImageAttachment("invalid");
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(parsed.mimeType)) return createUnavailableImageAttachment("unsupported", parsed.mimeType);
  if (parsed.byteLength > maxBytes) return createUnavailableImageAttachment("tooLarge", parsed.mimeType);

  return {
    type: "image",
    status: "available",
    source: "data",
    src: parsed.src,
    mimeType: parsed.mimeType,
    label: "Image attachment",
  };
}

async function imageFromLocalPath(rawPath: string, sessionCwd: string | undefined, maxBytes: number): Promise<ChatImageAttachment> {
  const resolved = resolveLocalImagePath(rawPath, sessionCwd);
  if (!resolved) return createUnavailableImageAttachment("invalid");

  const mimeType = mimeTypeFromPath(resolved);
  if (!mimeType) return createUnavailableImageAttachment("unsupported", undefined, path.basename(resolved));

  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) return createUnavailableImageAttachment("missing", mimeType, path.basename(resolved));
    if (stat.size > maxBytes) return createUnavailableImageAttachment("tooLarge", mimeType, path.basename(resolved));
    const bytes = await fs.readFile(resolved);
    return {
      type: "image",
      status: "available",
      source: "local",
      src: `data:${mimeType};base64,${bytes.toString("base64")}`,
      mimeType,
      label: path.basename(resolved) || "Image attachment",
    };
  } catch {
    return createUnavailableImageAttachment("missing", mimeType, path.basename(resolved));
  }
}

function parseDataImageUri(value: string): { src: string; mimeType: string; byteLength: number } | null {
  const trimmed = value.trim();
  const commaIndex = trimmed.indexOf(",");
  if (!trimmed.toLowerCase().startsWith("data:") || commaIndex < 0) return null;

  const metadata = trimmed.slice(5, commaIndex);
  const payload = trimmed.slice(commaIndex + 1);
  if (!payload) return null;

  const rawMimeType = metadata.split(";")[0] || "image/png";
  const mimeType = normalizeMimeType(rawMimeType);
  if (!mimeType) return null;

  const isBase64 = /(?:^|;)base64(?:;|$)/iu.test(metadata);
  const byteLength = isBase64 ? estimateBase64Bytes(payload) : decodeURIComponentSafe(payload).length;
  return { src: trimmed, mimeType, byteLength };
}

function estimateBase64Bytes(payload: string): number {
  const compact = payload.replace(/\s/g, "");
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function readImageUrlCandidate(item: object, type: string, contentType: string): string | undefined {
  const imageUrl = readUnknownField(item, "image_url");
  const fromImageUrl = readStringOrUrlObject(imageUrl);
  if (fromImageUrl) return fromImageUrl;

  if (!isImageLikeType(type, contentType)) return undefined;

  const candidateKeys = ["url", "src", "dataUrl", "data_url"];
  for (const key of candidateKeys) {
    const value = readStringField(item, key);
    if (value) return value;
  }

  return undefined;
}

function readLocalPathCandidate(item: object, type: string, contentType: string): string | undefined {
  if (!isImageLikeType(type, contentType)) return undefined;

  const candidateKeys = ["path", "localPath", "local_path", "file_path", "image_path"];
  for (const key of candidateKeys) {
    const value = readStringField(item, key);
    if (value) return value;
  }

  if (type !== "localimage") return undefined;
  return readStringOrUrlObject(readUnknownField(item, "image_url"));
}

function isImageLikeType(type: string, contentType: string): boolean {
  return (
    type === "image" ||
    type === "inputimage" ||
    type === "imageurl" ||
    type === "localimage" ||
    type === "imageassetpointer" ||
    contentType === "image" ||
    contentType === "inputimage" ||
    contentType === "imageassetpointer"
  );
}

function readStringOrUrlObject(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (!value || typeof value !== "object") return undefined;
  return (
    readStringField(value, "url") ||
    readStringField(value, "uri") ||
    readStringField(value, "path") ||
    readStringField(value, "localPath")
  );
}

function resolveLocalImagePath(rawPath: string, sessionCwd?: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed || isRemoteOrApiReference(trimmed)) return null;

  let candidate = trimmed;
  if (/^file:\/\//iu.test(candidate)) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      return null;
    }
  }

  if (candidate === "~" || candidate.startsWith(`~${path.sep}`) || candidate.startsWith("~/")) {
    candidate = path.join(os.homedir(), candidate.slice(2));
  }

  if (path.isAbsolute(candidate)) return path.normalize(candidate);
  if (!sessionCwd) return null;
  return path.normalize(path.resolve(sessionCwd, candidate));
}

function mimeTypeFromPath(fsPath: string): string | undefined {
  return IMAGE_MIME_BY_EXTENSION.get(path.extname(fsPath).toLowerCase());
}

function normalizeMimeType(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "image/jpg") return "image/jpeg";
  return normalized;
}

function normalizeType(value: string | undefined): string {
  return value?.trim().toLowerCase().replace(/[_-]/g, "") ?? "";
}

function isRemoteOrApiReference(value: string): boolean {
  return /^(https?:|sediment:\/\/|file-service:\/\/|blob:)/iu.test(value.trim());
}

function hasReferenceOnlyImagePointer(item: object): boolean {
  return !!(
    readStringField(item, "asset_pointer") ||
    readStringField(item, "file_id") ||
    readStringField(item, "fileId")
  );
}

function createUnavailableImageAttachment(
  reason: ChatImageAttachmentReason,
  mimeType?: string,
  label = "Image attachment",
): ChatImageAttachment {
  return {
    type: "image",
    status: "unavailable",
    source: "reference",
    mimeType,
    label,
    reason,
  };
}

function readObjectField(item: object, key: string): Record<string, unknown> | null {
  const value = readUnknownField(item, key);
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readStringField(item: object, key: string): string | undefined {
  const value = readUnknownField(item, key);
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readUnknownField(item: object, key: string): unknown {
  return (item as Record<string, unknown>)[key];
}
