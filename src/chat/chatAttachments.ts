import * as path from "node:path";
import type {
  ChatAttachment,
  ChatDocumentAttachment,
  ChatDocumentKind,
  ChatFileKind,
  ChatFileReferenceAttachment,
  ChatImageAttachment,
  ChatImageAttachmentReason,
  ChatSelectionReferenceAttachment,
  ChatSystemEventScope,
} from "./chatTypes";
import type { ChatImageExtractionOptions } from "./chatImageAttachments";
import {
  addUnavailablePlaceholderIfNeeded,
  extractImageAttachmentFromItem,
  isPotentialImageAttachmentItem,
  stripImagePlaceholders,
} from "./chatImageAttachments";
import { getClaudeRequestInterruptedScope, isCodexTurnAbortedMessageText } from "../utils/textUtils";

export const CHAT_TEXT_DOCUMENT_PREVIEW_CHARS = 16_000;
export const CHAT_TEXT_DOCUMENT_SEARCH_CHARS = 64_000;
export const CHAT_TEXT_DOCUMENT_SAVE_BYTES = 5 * 1024 * 1024;
export const CHAT_EMBEDDED_BASE64_DOCUMENT_BYTES = 32 * 1024 * 1024;
export const CHAT_SELECTION_PREVIEW_CHARS = 4_000;
export const CHAT_ATTACHMENT_LABEL_SEARCH_CHARS = 512;
export const CHAT_ATTACHMENT_PATH_SEARCH_CHARS = 4_096;

const DEFAULT_DOCUMENT_LABEL = "document-attachment";
const DEFAULT_FILE_REFERENCE_LABEL = "file-reference";
const CODE_EXTENSIONS = new Set([
  ".bash",
  ".bat",
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".htm",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".kt",
  ".kts",
  ".php",
  ".ps1",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".swift",
  ".ts",
  ".tsx",
  ".xml",
  ".yaml",
  ".yml",
]);
const TEXT_EXTENSIONS = new Set([
  ".csv",
  ".diff",
  ".env",
  ".ini",
  ".log",
  ".md",
  ".markdown",
  ".patch",
  ".text",
  ".toml",
  ".tsv",
  ".txt",
]);
const ARCHIVE_EXTENSIONS = new Set([".7z", ".br", ".bz2", ".gz", ".rar", ".tar", ".tgz", ".xz", ".zip"]);
const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);

export interface ExtractedMessageContent {
  text: string;
  attachments: ChatAttachment[];
}

export interface ExtractedCodexTextContent {
  text: string;
  hasNonTextContent: boolean;
}

export interface ClaudeRequestInterruptionContent {
  scope: ChatSystemEventScope;
}

export function extractCodexTextContent(content: unknown): ExtractedCodexTextContent {
  if (typeof content === "string") {
    const stripped = stripImagePlaceholders(content);
    const files = extractCodexFilesMentionedFromText(stripped.text);
    return {
      text: files.text,
      hasNonTextContent: stripped.placeholderCount > 0 || files.attachments.length > 0,
    };
  }

  const items = normalizeContentItems(content);
  const texts: string[] = [];
  let hasNonTextContent = false;

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const maybeText = readStringField(obj, "text");
    if (maybeText) {
      const stripped = stripImagePlaceholders(maybeText);
      const files = extractCodexFilesMentionedFromText(stripped.text);
      if (files.text) texts.push(files.text);
      if (stripped.placeholderCount > 0 || files.attachments.length > 0 || isPotentialImageAttachmentItem(obj)) {
        hasNonTextContent = true;
      }
      continue;
    }
    if (Object.keys(obj).length > 0) hasNonTextContent = true;
  }

  return {
    text: texts.join(""),
    hasNonTextContent,
  };
}

export function isCodexTurnAbortedContent(content: unknown): boolean {
  if (!hasTextCandidate(content, "turn_aborted")) return false;
  const extracted = extractCodexTextContent(content);
  return !extracted.hasNonTextContent && isCodexTurnAbortedMessageText(extracted.text);
}

export function extractClaudeRequestInterruptionContent(content: unknown): ClaudeRequestInterruptionContent | null {
  if (!hasTextCandidate(content, "Request interrupted by user")) return null;

  if (typeof content === "string") {
    if (hasClaudeIdeTag(content) || stripImagePlaceholders(content).placeholderCount > 0) return null;
    return toClaudeRequestInterruptionContent(content);
  }

  const items = normalizeContentItems(content);
  if (items.length === 0) return null;
  const texts: string[] = [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const type = normalizeType(readStringField(obj, "type"));
    if (type === "text" || type === "inputtext" || type === "outputtext" || (!type && typeof obj.text === "string")) {
      if (isPotentialImageAttachmentItem(obj)) return null;
      const text = readStringField(obj, "text");
      if (text === undefined) continue;
      const stripped = stripImagePlaceholders(text);
      if (stripped.placeholderCount > 0 || hasClaudeIdeTag(stripped.text)) return null;
      if (stripped.text.trim()) texts.push(stripped.text);
      continue;
    }
    if (Object.keys(obj).length > 0) return null;
  }

  return toClaudeRequestInterruptionContent(texts.join(""));
}

function toClaudeRequestInterruptionContent(text: string): ClaudeRequestInterruptionContent | null {
  const scope = getClaudeRequestInterruptedScope(text);
  return scope ? { scope } : null;
}

export async function extractCodexMessageContent(
  content: unknown,
  sessionCwd?: string,
  options?: ChatImageExtractionOptions,
): Promise<ExtractedMessageContent> {
  const imageOptions = normalizeImageOptions(options);
  const items = normalizeContentItems(content);
  const texts: string[] = [];
  const attachments: ChatAttachment[] = [];
  let placeholderCount = 0;
  let placeholderInsertIndex: number | undefined;

  if (typeof content === "string") {
    const stripped = stripImagePlaceholders(content);
    if (stripped.placeholderCount > 0) {
      placeholderInsertIndex = attachments.length;
    }
    placeholderCount += stripped.placeholderCount;
    const files = extractCodexFilesMentionedFromText(stripped.text);
    if (files.text) texts.push(files.text);
    attachments.push(...files.attachments);
  }

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const maybeText = readStringField(obj, "text");
    if (maybeText) {
      const stripped = stripImagePlaceholders(maybeText);
      if (stripped.placeholderCount > 0 && placeholderInsertIndex === undefined) {
        placeholderInsertIndex = attachments.length;
      }
      placeholderCount += stripped.placeholderCount;
      const files = extractCodexFilesMentionedFromText(stripped.text);
      if (files.text) texts.push(files.text);
      attachments.push(...files.attachments);
    }

    const image = await extractImageAttachmentFromItem(obj, sessionCwd, imageOptions);
    if (image) attachments.push(image);
  }

  addPlaceholderImageIfNeeded(attachments, placeholderCount, placeholderInsertIndex, imageOptions.enabled ? "remote" : "disabled");
  return {
    text: texts.join(""),
    attachments,
  };
}

export async function extractClaudeMessageContent(
  content: unknown,
  sessionCwd?: string,
  options?: ChatImageExtractionOptions,
): Promise<ExtractedMessageContent> {
  const imageOptions = normalizeImageOptions(options);
  const items = normalizeContentItems(content);
  const texts: string[] = [];
  const attachments: ChatAttachment[] = [];
  let placeholderCount = 0;
  let placeholderInsertIndex: number | undefined;

  if (typeof content === "string") {
    const stripped = stripImagePlaceholders(content);
    if (stripped.placeholderCount > 0) {
      placeholderInsertIndex = attachments.length;
    }
    placeholderCount += stripped.placeholderCount;
    const ide = extractClaudeIdeReferencesFromText(stripped.text);
    texts.push(ide.text);
    attachments.push(...ide.attachments);
  } else {
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const type = normalizeType(readStringField(obj, "type"));
      if (type === "document") {
        attachments.push(extractClaudeDocumentAttachment(obj));
        continue;
      }
      const itemText = readStringField(obj, "text");
      if (itemText) {
        const stripped = stripImagePlaceholders(itemText);
        if (stripped.placeholderCount > 0 && placeholderInsertIndex === undefined) {
          placeholderInsertIndex = attachments.length;
        }
        placeholderCount += stripped.placeholderCount;
        const ide = extractClaudeIdeReferencesFromText(stripped.text);
        texts.push(ide.text);
        attachments.push(...ide.attachments);
      }

      const image = await extractImageAttachmentFromItem(obj, sessionCwd, imageOptions);
      if (image) attachments.push(image);
    }
  }

  addPlaceholderImageIfNeeded(attachments, placeholderCount, placeholderInsertIndex, imageOptions.enabled ? "remote" : "disabled");

  return {
    text: texts.join(""),
    attachments,
  };
}

export function assignAttachmentIds(attachments: ChatAttachment[], scope: string): void {
  let imageIndex = 0;
  let documentIndex = 0;
  let fileIndex = 0;
  let selectionIndex = 0;
  for (const attachment of attachments) {
    if (!attachment || attachment.id) continue;
    if (attachment.type === "image") {
      imageIndex += 1;
      attachment.id = `${scope}-image-${imageIndex}`;
      continue;
    }
    if (attachment.type === "document") {
      documentIndex += 1;
      attachment.id = `${scope}-document-${documentIndex}`;
      continue;
    }
    if (attachment.type === "fileReference") {
      fileIndex += 1;
      attachment.id = `${scope}-file-${fileIndex}`;
      continue;
    }
    selectionIndex += 1;
    attachment.id = `${scope}-selection-${selectionIndex}`;
  }
}

function addPlaceholderImageIfNeeded(
  attachments: ChatAttachment[],
  placeholderCount: number,
  insertIndex: number | undefined,
  reason: ChatImageAttachmentReason,
): void {
  if (placeholderCount <= 0 || attachments.some((attachment) => attachment.type === "image")) return;
  const images: ChatImageAttachment[] = [];
  addUnavailablePlaceholderIfNeeded(images, 1, reason);
  const placeholder = images[0];
  if (!placeholder) return;
  const safeIndex =
    typeof insertIndex === "number" && Number.isFinite(insertIndex)
      ? Math.max(0, Math.min(attachments.length, Math.floor(insertIndex)))
      : attachments.length;
  attachments.splice(safeIndex, 0, placeholder);
}

export function hasClaudeAttachmentLikeContent(content: unknown): boolean {
  const items = normalizeContentItems(content);
  if (typeof content === "string") return hasClaudeIdeTag(content) || stripImagePlaceholders(content).placeholderCount > 0;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const type = normalizeType(readStringField(obj, "type"));
    if (type === "document" || isPotentialImageAttachmentItem(obj)) return true;
    const text = readStringField(obj, "text");
    if (text && (hasClaudeIdeTag(text) || stripImagePlaceholders(text).placeholderCount > 0)) return true;
  }
  return false;
}

export function buildAttachmentSummaryLines(attachments: readonly ChatAttachment[]): string[] {
  const lines: string[] = [];
  for (const attachment of attachments) {
    if (!attachment) continue;
    if (attachment.type === "image") {
      lines.push(formatImageSummary(attachment));
      continue;
    }
    if (attachment.type === "document") {
      lines.push(formatDocumentSummary(attachment));
      continue;
    }
    if (attachment.type === "fileReference") {
      lines.push(formatFileReferenceSummary(attachment));
      continue;
    }
    lines.push(formatSelectionSummary(attachment));
  }
  return lines;
}

export function buildAttachmentSearchText(attachments: readonly ChatAttachment[]): string {
  const parts: string[] = [];
  for (const attachment of attachments) {
    if (!attachment) continue;
    addSearchPart(parts, attachment.type);
    if (attachment.type === "image") {
      addSearchPart(parts, attachment.label);
      addSearchPart(parts, attachment.mimeType);
      continue;
    }
    if (attachment.type === "document") {
      addSearchPart(parts, attachment.label);
      addSearchPart(parts, attachment.mimeType);
      addSearchPart(parts, attachment.documentKind);
      if (attachment.documentKind === "text") {
        const textPayload = attachment.payload?.kind === "text" ? attachment.payload.text : attachment.previewText;
        addSearchPart(parts, textPayload, CHAT_TEXT_DOCUMENT_SEARCH_CHARS);
      }
      continue;
    }
    if (attachment.type === "fileReference") {
      addSearchPart(parts, attachment.label);
      addSearchPart(parts, attachment.path, CHAT_ATTACHMENT_PATH_SEARCH_CHARS);
      addSearchPart(parts, attachment.fileKind);
      continue;
    }
    addSearchPart(parts, attachment.label);
    addSearchPart(parts, attachment.path, CHAT_ATTACHMENT_PATH_SEARCH_CHARS);
    addSearchPart(parts, "selection");
  }
  return parts.join("\n");
}

export function extractCodexFilesMentionedFromText(text: string): ExtractedMessageContent {
  const normalized = normalizeNewlines(text);
  const header = findCodexFilesMentionedHeader(normalized);
  if (!header) return { text, attachments: [] };

  const prefix = normalized.slice(0, header.start);
  const rest = normalized.slice(header.end);
  const requestMatch = /(?:^|\n)## My request for Codex:\s*(?:\n|$)/u.exec(rest);
  if (requestMatch) {
    const block = rest.slice(0, requestMatch.index);
    const parsed = parseCodexFileReferenceLines(block);
    if (parsed.attachments.length === 0 || parsed.failed) return { text, attachments: [] };
    if (prefix.trim().length > 0) {
      return {
        text: joinCodexTextAroundFilesBlock(prefix, rest.slice(requestMatch.index + requestMatch[0].length)),
        attachments: parsed.attachments,
      };
    }
    return {
      text: rest.slice(requestMatch.index + requestMatch[0].length),
      attachments: parsed.attachments,
    };
  }

  const parsed = parseCodexFileReferencePrefix(rest);
  if (parsed.attachments.length === 0 || parsed.failed) return { text, attachments: [] };
  return {
    text: joinCodexTextAroundFilesBlock(prefix, parsed.remainingText),
    attachments: parsed.attachments,
  };
}

function findCodexFilesMentionedHeader(text: string): { start: number; end: number } | null {
  const match = /(^|\n)[ \t]*# Files mentioned by the user:[ \t]*(?:\n|$)/u.exec(text);
  if (!match) return null;
  const leadingNewline = match[1] ?? "";
  return {
    start: match.index + leadingNewline.length,
    end: match.index + match[0].length,
  };
}

function joinCodexTextAroundFilesBlock(prefix: string, suffix: string): string {
  const cleanPrefix = prefix.replace(/\n+$/u, "");
  const cleanSuffix = suffix.replace(/^\n+/u, "");
  if (!cleanPrefix.trim()) return cleanSuffix;
  if (!cleanSuffix.trim()) return cleanPrefix;
  return `${cleanPrefix}\n\n${cleanSuffix}`;
}

function parseCodexFileReferencePrefix(text: string): {
  attachments: ChatFileReferenceAttachment[];
  remainingText: string;
  failed: boolean;
} {
  const lines = text.split("\n");
  const blockLines: string[] = [];
  let index = 0;
  let sawFile = false;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      blockLines.push(line);
      index += 1;
      continue;
    }
    if (!line.trimStart().startsWith("## ")) break;
    if (!parseCodexFileReferenceLine(line)) {
      return { attachments: [], remainingText: text, failed: true };
    }
    sawFile = true;
    blockLines.push(line);
    index += 1;
  }

  if (!sawFile) return { attachments: [], remainingText: text, failed: true };
  const parsed = parseCodexFileReferenceLines(blockLines.join("\n"));
  if (parsed.failed) return { attachments: [], remainingText: text, failed: true };
  return {
    attachments: parsed.attachments,
    remainingText: lines.slice(index).join("\n").replace(/^\n+/u, ""),
    failed: false,
  };
}

function parseCodexFileReferenceLines(text: string): { attachments: ChatFileReferenceAttachment[]; failed: boolean } {
  const attachments: ChatFileReferenceAttachment[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parsed = parseCodexFileReferenceLine(line);
    if (!parsed) return { attachments: [], failed: true };
    attachments.push(parsed);
  }
  return { attachments, failed: false };
}

function parseCodexFileReferenceLine(line: string): ChatFileReferenceAttachment | null {
  const text = line.trim();
  if (!text.startsWith("## ")) return null;
  const body = text.slice(3).trim();
  const separator = body.indexOf(": ");
  if (separator <= 0) return null;

  const label = body.slice(0, separator).trim();
  const rawPath = body.slice(separator + 2).trim();
  if (!label || !rawPath) return null;

  const lineInfo = parseLineSuffix(rawPath);
  const fsPath = lineInfo.text.trim();
  if (!fsPath) return null;

  return {
    type: "fileReference",
    source: "codexFilesMentioned",
    label,
    path: fsPath,
    ...(lineInfo.line ? { line: lineInfo.line } : {}),
    ...(lineInfo.endLine ? { endLine: lineInfo.endLine } : {}),
    fileKind: inferFileKind(fsPath, label),
  };
}

function extractClaudeIdeReferencesFromText(text: string): ExtractedMessageContent {
  const attachments: ChatAttachment[] = [];
  const clean = normalizeNewlines(text).replace(
    /<ide_(opened_file|selection)>([\s\S]*?)<\/ide_\1>/giu,
    (_full, tag: string, body: string) => {
      if (tag === "opened_file") attachments.push(buildClaudeOpenedFileAttachment(body));
      else attachments.push(buildClaudeSelectionAttachment(body));
      return "\n";
    },
  );
  return {
    text: clean,
    attachments,
  };
}

function buildClaudeOpenedFileAttachment(body: string): ChatFileReferenceAttachment {
  const pathText = extractClaudeOpenedFilePath(body) ?? extractPathLikeText(body);
  return {
    type: "fileReference",
    source: "claudeIdeOpenedFile",
    label: pathText ? path.basename(pathText) || pathText : DEFAULT_FILE_REFERENCE_LABEL,
    ...(pathText ? { path: pathText, fileKind: inferFileKind(pathText) } : { fileKind: "generic" as ChatFileKind }),
  };
}

function buildClaudeSelectionAttachment(body: string): ChatSelectionReferenceAttachment {
  const text = normalizeNewlines(body).trim();
  const lineMatch = /\blines?\s+(\d+)(?:\s*(?:to|-)\s*(\d+))?/iu.exec(text);
  const pathAndPreview = extractSelectionPathAndPreview(text);
  const pathText = pathAndPreview.path ?? extractPathLikeText(text);
  const previewText = clampText(pathAndPreview.previewText ?? "", CHAT_SELECTION_PREVIEW_CHARS);
  return {
    type: "selectionReference",
    source: "claudeIdeSelection",
    label: pathText ? path.basename(pathText) || pathText : "Selection",
    ...(pathText ? { path: pathText } : {}),
    ...(lineMatch?.[1] ? { line: Number(lineMatch[1]) } : {}),
    ...(lineMatch?.[2] ? { endLine: Number(lineMatch[2]) } : {}),
    ...(previewText ? { previewText } : {}),
  };
}

function extractSelectionPathAndPreview(text: string): { path?: string; previewText?: string } {
  const lower = text.toLowerCase();
  const fromIndex = lower.lastIndexOf(" from ");
  if (fromIndex < 0) return {};

  const afterFrom = text.slice(fromIndex + " from ".length);
  const separator = afterFrom.search(/:\s*(?:\n|$)/u);
  if (separator < 0) {
    const pathText = extractPathLikeText(afterFrom);
    return pathText ? { path: pathText } : {};
  }

  const rawPath = afterFrom.slice(0, separator).trim();
  const previewText = afterFrom.slice(separator + 1).trim();
  return {
    ...(rawPath ? { path: sanitizeClaudeIdePath(rawPath) } : {}),
    ...(previewText ? { previewText } : {}),
  };
}

function extractClaudeOpenedFilePath(body: string): string | undefined {
  const text = normalizeNewlines(body).trim();
  const match = /\bopened the file\s+([\s\S]+?)\s+in the IDE\b/iu.exec(text);
  return match?.[1] ? sanitizeClaudeIdePath(match[1]) : undefined;
}

function extractClaudeDocumentAttachment(item: Record<string, unknown>): ChatDocumentAttachment {
  const source = readObjectField(item, "source");
  const sourceType = normalizeType(readStringField(source, "type"));
  const label = readStringField(item, "title") || readStringField(item, "name") || readStringField(item, "file_name");
  const mimeType = normalizeMimeType(
    readStringField(item, "media_type") ||
      readStringField(item, "mime_type") ||
      readStringField(source, "media_type") ||
      readStringField(source, "mime_type"),
  );
  const documentKind = inferDocumentKind(mimeType, label);
  const safeLabel = label || defaultDocumentLabel(documentKind);

  if (sourceType === "text") {
    const text = readStringField(source, "data") || readStringField(source, "text") || "";
    if (!text) {
      return createUnavailableDocument({ documentKind, source: "embeddedText", label: safeLabel, mimeType, reason: "invalid" });
    }
    const byteLength = Buffer.byteLength(text, "utf8");
    const previewText = clampText(text, CHAT_TEXT_DOCUMENT_PREVIEW_CHARS);
    if (byteLength > CHAT_TEXT_DOCUMENT_SAVE_BYTES) {
      return {
        type: "document",
        status: "unavailable",
        documentKind: "text",
        source: "embeddedText",
        label: safeLabel,
        mimeType: mimeType ?? "text/plain",
        byteLength,
        previewText,
        reason: "tooLarge",
      };
    }
    return {
      type: "document",
      status: "available",
      documentKind: "text",
      source: "embeddedText",
      label: safeLabel,
      mimeType: mimeType ?? "text/plain",
      byteLength,
      previewText,
      dataOmitted: true,
      payload: { kind: "text", text },
    };
  }

  if (sourceType === "base64") {
    const data = readStringField(source, "data") || "";
    if (!data || !mimeType) {
      return createUnavailableDocument({ documentKind, source: "embeddedBase64", label: safeLabel, mimeType, reason: "invalid" });
    }
    const byteLength = estimateBase64Bytes(data);
    if (byteLength > CHAT_EMBEDDED_BASE64_DOCUMENT_BYTES) {
      return createUnavailableDocument({
        documentKind,
        source: "embeddedBase64",
        label: safeLabel,
        mimeType,
        byteLength,
        reason: "tooLarge",
      });
    }
    return {
      type: "document",
      status: "available",
      documentKind,
      source: "embeddedBase64",
      label: safeLabel,
      mimeType,
      byteLength,
      dataOmitted: true,
      payload: { kind: "base64", data },
    };
  }

  return createUnavailableDocument({
    documentKind,
    source: "reference",
    label: safeLabel,
    mimeType,
    reason: sourceType ? "unsupported" : "invalid",
  });
}

function createUnavailableDocument(params: {
  documentKind: ChatDocumentKind;
  source: ChatDocumentAttachment["source"];
  label: string;
  mimeType?: string;
  byteLength?: number;
  reason: NonNullable<ChatDocumentAttachment["reason"]>;
}): ChatDocumentAttachment {
  return {
    type: "document",
    status: "unavailable",
    documentKind: params.documentKind,
    source: params.source,
    label: params.label,
    ...(params.mimeType ? { mimeType: params.mimeType } : {}),
    ...(typeof params.byteLength === "number" ? { byteLength: params.byteLength } : {}),
    reason: params.reason,
  };
}

function formatImageSummary(image: ChatImageAttachment): string {
  const label = image.label || "Image attachment";
  const meta = [image.mimeType, image.status === "unavailable" ? image.reason : ""].filter(Boolean).join(", ");
  return `- Image attachment: ${formatMarkdownCodeSpan(label)}${meta ? ` (${meta})` : ""}`;
}

function formatDocumentSummary(document: ChatDocumentAttachment): string {
  const label = document.label || defaultDocumentLabel(document.documentKind);
  const meta = [document.mimeType, document.documentKind, document.status === "unavailable" ? document.reason : ""]
    .filter(Boolean)
    .join(", ");
  return `- Attached file: ${formatMarkdownCodeSpan(label)}${meta ? ` (${meta})` : ""}`;
}

function formatFileReferenceSummary(reference: ChatFileReferenceAttachment): string {
  const label = reference.source === "claudeIdeOpenedFile" ? "Opened file" : "File reference";
  const target = reference.path || reference.label || DEFAULT_FILE_REFERENCE_LABEL;
  const location = formatLineRange(reference.line, reference.endLine);
  return `- ${label}: ${formatMarkdownCodeSpan(target)}${location ? ` (${location})` : ""}`;
}

function formatSelectionSummary(selection: ChatSelectionReferenceAttachment): string {
  const target = selection.path || selection.label || "Selection";
  const location = formatLineRange(selection.line, selection.endLine);
  return `- Selection reference: ${formatMarkdownCodeSpan(target)}${location ? ` (${location})` : ""}`;
}

function formatMarkdownCodeSpan(value: string): string {
  const text = normalizeNewlines(value).replace(/\s+/g, " ").trim();
  if (!text) return "``";
  const tickRuns = text.match(/`+/gu) ?? [];
  const longestRun = tickRuns.reduce((max, run) => Math.max(max, run.length), 0);
  const delimiter = "`".repeat(longestRun + 1);
  const needsPadding = text.startsWith("`") || text.endsWith("`");
  const body = needsPadding ? ` ${text} ` : text;
  return `${delimiter}${body}${delimiter}`;
}

function formatLineRange(line: number | undefined, endLine: number | undefined): string {
  if (typeof line !== "number" || !Number.isFinite(line)) return "";
  if (typeof endLine === "number" && Number.isFinite(endLine) && endLine > line) return `lines ${line}-${endLine}`;
  return `line ${line}`;
}

function addSearchPart(parts: string[], value: unknown, maxChars = CHAT_ATTACHMENT_LABEL_SEARCH_CHARS): void {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return;
  parts.push(clampText(text, maxChars));
}

function parseLineSuffix(value: string): { text: string; line?: number; endLine?: number } {
  const match = /^(.*)\s+\((?:lines?|line)\s+(\d+)(?:\s*(?:-|to)\s*(\d+))?\)\s*$/iu.exec(value.trim());
  if (!match) return { text: value };
  const line = Number(match[2]);
  const endLine = match[3] ? Number(match[3]) : undefined;
  return {
    text: match[1] ?? value,
    ...(Number.isFinite(line) && line >= 1 ? { line: Math.floor(line) } : {}),
    ...(Number.isFinite(endLine) && endLine !== undefined && endLine >= 1 ? { endLine: Math.floor(endLine) } : {}),
  };
}

function inferDocumentKind(mimeType: string | undefined, label: string | undefined): ChatDocumentKind {
  const mime = String(mimeType ?? "").toLowerCase();
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("text/") || isTextLikeMimeType(mime)) return "text";
  const kind = inferFileKind(label ?? "");
  if (kind === "pdf") return "pdf";
  if (kind === "text" || kind === "code") return "text";
  return "generic";
}

export function inferFileKind(fsPath: string, fallbackLabel?: string): ChatFileKind {
  const ext = path.extname(String(fsPath || fallbackLabel || "").trim()).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".doc" || ext === ".docx" || ext === ".docm" || ext === ".rtf") return "word";
  if (ext === ".xls" || ext === ".xlsx" || ext === ".xlsm") return "excel";
  if (ext === ".ppt" || ext === ".pptx" || ext === ".pptm") return "powerpoint";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (ARCHIVE_EXTENSIONS.has(ext)) return "archive";
  if (CODE_EXTENSIONS.has(ext)) return "code";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  if (isWellKnownTextFileName(fsPath) || isWellKnownTextFileName(fallbackLabel)) return "text";
  return "generic";
}

function isWellKnownTextFileName(value: string | undefined): boolean {
  const base = path.basename(String(value ?? "").trim()).toLowerCase();
  return (
    base === "license" ||
    base === "readme" ||
    base === "changelog" ||
    base === "authors" ||
    base === "contributors" ||
    base === "copying"
  );
}

function defaultDocumentLabel(documentKind: ChatDocumentKind): string {
  if (documentKind === "pdf") return "PDF document";
  if (documentKind === "text") return "Text document";
  return DEFAULT_DOCUMENT_LABEL;
}

function isTextLikeMimeType(mimeType: string): boolean {
  return (
    mimeType === "application/json" ||
    mimeType === "application/xml" ||
    mimeType === "application/yaml" ||
    mimeType === "application/x-yaml" ||
    mimeType.endsWith("+json") ||
    mimeType.endsWith("+xml")
  );
}

function extractPathLikeText(value: string): string | undefined {
  const text = sanitizeClaudeIdePath(value);
  if (!text) return undefined;
  const windows = /[A-Za-z]:[\\/][^\r\n<>"]+/u.exec(text);
  if (windows) return trimPathPunctuation(windows[0]);
  const unc = /\\\\[^\r\n<>"]+/u.exec(text);
  if (unc) return trimPathPunctuation(unc[0]);
  const unix = /(?:^|\s)(\/[^\r\n<>"]+)/u.exec(text);
  if (unix?.[1]) return trimPathPunctuation(unix[1]);

  const firstLine = text.split("\n")[0]?.trim() ?? "";
  if (firstLine && !/\s/u.test(firstLine)) return trimPathPunctuation(firstLine);
  return undefined;
}

function sanitizeClaudeIdePath(value: string): string {
  const text = normalizeNewlines(value)
    .trim()
    .replace(/-\s*\n\s*/gu, "-")
    .replace(/\s*\n\s*/gu, "")
    .replace(/\s+in the IDE\.?(?:\s+This may or may not be related to the current task\.?)?$/iu, "")
    .replace(/\s+This may or may not be related to the current task\.?$/iu, "")
    .trim();
  return trimPathPunctuation(text);
}

function trimPathPunctuation(value: string): string {
  return value.trim().replace(/[)\].,;:]+$/u, "").trim();
}

function hasClaudeIdeTag(value: string): boolean {
  return /<ide_(?:opened_file|selection)>/iu.test(value);
}

function hasTextCandidate(content: unknown, needle: string): boolean {
  if (typeof content === "string") return content.includes(needle);
  for (const item of normalizeContentItems(content)) {
    if (!item || typeof item !== "object") continue;
    const text = readStringField(item as Record<string, unknown>, "text");
    if (text?.includes(needle)) return true;
  }
  return false;
}

function normalizeImageOptions(options?: ChatImageExtractionOptions): Required<ChatImageExtractionOptions> {
  return {
    enabled: options?.enabled ?? true,
    maxBytes: typeof options?.maxBytes === "number" && Number.isFinite(options.maxBytes) ? options.maxBytes : 20 * 1024 * 1024,
  };
}

function normalizeContentItems(content: unknown): unknown[] {
  return Array.isArray(content) ? content : content && typeof content === "object" ? [content] : [];
}

function normalizeNewlines(value: string): string {
  return String(value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function clampText(value: string, maxChars: number): string {
  const text = String(value ?? "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function estimateBase64Bytes(payload: string): number {
  const compact = payload.replace(/\s/g, "");
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

function normalizeType(value: string | undefined): string {
  return value?.trim().toLowerCase().replace(/[_-]/g, "") ?? "";
}

function normalizeMimeType(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  return normalized;
}

function readObjectField(item: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  const value = item?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readStringField(item: Record<string, unknown> | null, key: string): string | undefined {
  const value = item?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}
