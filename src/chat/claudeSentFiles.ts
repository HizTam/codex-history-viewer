import { createHash } from "node:crypto";
import type { ChatFileReferenceAttachment, ChatSentFilesPresentation, ChatToolItem } from "./chatTypes";
import { inferFilePresentationKind } from "../utils/fileKind";

const MAX_FILES = 256;
const MAX_PATH_CHARS = 4_096;
const MAX_CAPTION_CHARS = 4_096;
const MAX_NOTICE_CHARS = 8_192;
const MAX_INPUT_CHARS = 2 * 1024 * 1024;
// The upstream result can report incomplete delivery without is_error being true.
const DELIVERY_WARNING = /\bNOT\b[^\n]*\bdelivered\b|reached only one of its viewers/u;

export function isSafeSentFilePath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > MAX_PATH_CHARS || value !== value.trim()) return false;
  if (/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value)) return false;
  return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(value) || /^[a-zA-Z]:[\\/]/u.test(value);
}

export function buildClaudeSentFiles(
  name: string, argumentsText: string | undefined, scope: string,
): Pick<ChatToolItem, "attachments" | "sentFiles"> | undefined {
  if (name !== "SendUserFile" || !argumentsText || argumentsText.length > MAX_INPUT_CHARS) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(argumentsText); } catch { return undefined; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const input = raw as Record<string, unknown>;
  const values = Array.isArray(input.files) ? input.files : typeof input.files === "string" ? [input.files] : [];
  const sentFiles: ChatSentFilesPresentation = { status: "pending" };
  if (values.length > MAX_FILES) sentFiles.truncated = true;
  if (typeof input.caption === "string" && input.caption.trim()) {
    sentFiles.caption = input.caption.trim().slice(0, MAX_CAPTION_CHARS);
    if (input.caption.trim().length > MAX_CAPTION_CHARS) sentFiles.truncated = true;
  }
  const attachments: ChatFileReferenceAttachment[] = [];
  for (let index = 0; index < Math.min(values.length, MAX_FILES); index += 1) {
    const value = values[index];
    if (typeof value !== "string" || !value.trim()) continue;
    const file = value.trim();
    const safe = isSafeSentFilePath(file);
    const label = (safe ? file.split(/[\\/]/u).pop() || file : file).slice(0, 512);
    if (file.length > MAX_PATH_CHARS) sentFiles.truncated = true;
    // Include the path in an opaque identity so stale clicks cannot open a replaced target.
    const id = `sent-file-${createHash("sha256").update(`${scope}\u0000${index}\u0000${file}`, "utf8").digest("hex").slice(0, 32)}`;
    attachments.push({ id, type: "fileReference", source: "claudeSendUserFile", label,
      ...(safe ? { path: file } : {}), fileKind: inferFilePresentationKind(safe ? file : "", label) });
  }
  return { attachments, sentFiles };
}

export function updateClaudeSentFilesResult(tool: ChatToolItem, outputText: string | undefined, isError: boolean): void {
  if (!tool.sentFiles) return;
  const text = outputText ?? "";
  const warning = DELIVERY_WARNING.test(text);
  tool.sentFiles.status = isError ? "error" : warning ? "warning" : "success";
  if ((isError || warning) && text) {
    tool.sentFiles.notice = text.slice(0, MAX_NOTICE_CHARS);
    if (text.length > MAX_NOTICE_CHARS) tool.sentFiles.truncated = true;
  } else {
    delete tool.sentFiles.notice;
  }
}
