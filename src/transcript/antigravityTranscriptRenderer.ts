import { buildAntigravityChatModel } from "../antigravity/antigravityChatModel";
import type { ChatSessionModel } from "../chat/chatTypes";
import { buildAttachmentSummaryLines } from "../chat/chatAttachments";
import { formatYmdHmsInTimeZone } from "../utils/dateUtils";
import { t } from "../i18n";

interface NativeTranscriptOptions {
  readonly timeZone: string;
  readonly annotation?: { readonly tags?: readonly string[]; readonly note?: string };
  readonly locationLabel?: string;
  readonly displayCwd?: string | null;
}
function fence(text: string, language = ""): string {
  let length = 3;
  for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const marker = "`".repeat(length);
  return `${marker}${language}\n${text}\n${marker}`;
}
function markdownText(text: string): string {
  // Native text remains Markdown data; embedded HTML never becomes active markup.
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function inlineText(text: string): string { return markdownText(text).replace(/([\\`*_[\]{}()#+.!|>~])/g, "\\$1").replace(/[\r\n]+/g, " "); }

export function renderAntigravityModelTranscript(model: ChatSessionModel, options: NativeTranscriptOptions): { content: string; messageLineMap: Map<number, number> } {
  const chunks: string[] = [], messageLineMap = new Map<number, number>();
  let units = 0, lineNumber = 1, truncated = false;
  const append = (text = ""): void => {
    if (truncated) return;
    let value = text.replace(/\r\n?/g, "\n");
    const remaining = 64 * 1024 * 1024 - 1024 - units - (chunks.length ? 1 : 0);
    if (value.length > remaining) {
      value = value.slice(0, Math.max(0, remaining));
      if (/[\uD800-\uDBFF]/.test(value.at(-1) ?? "")) value = value.slice(0, -1);
      truncated = true;
    }
    if (chunks.length) { lineNumber++; units++; }
    units += value.length;
    for (let offset = value.indexOf("\n"); offset >= 0; offset = value.indexOf("\n", offset + 1)) lineNumber++;
    chunks.push(value);
  };
  const timestamp = (value?: string): string => value ? formatYmdHmsInTimeZone(new Date(value), options.timeZone) : "";
  append(`# ${t("antigravity.transcript.title")}`); append();
  append(`- ${t("chat.meta.sessionFile")}:`); append(fence(model.fsPath));
  if (model.meta.id) { append(`- ${t("chat.meta.sessionId")}:`); append(fence(model.meta.id)); }
  if (model.meta.cwd) { append(t("chat.meta.cwd", inlineText(model.meta.cwd))); append(); }
  if (options.locationLabel) { append(markdownText(options.locationLabel)); append(); }
  if (options.displayCwd && options.displayCwd !== model.meta.cwd) { append(t("chat.meta.relocatedCwd")); append(fence(options.displayCwd)); }
  if (options.annotation?.tags?.length) { append(options.annotation.tags.map(tag => markdownText(`#${tag}`)).join(" ")); append(); }
  if (options.annotation?.note) { append(markdownText(options.annotation.note)); append(); }
  append("---"); append();
  for (const item of model.items) {
    if (truncated) break;
    if (item.type === "message" && (item.role === "user" || item.role === "assistant")) {
      const role = item.role === "user" ? t("antigravity.transcript.user") : t("antigravity.transcript.assistant");
      if (item.messageIndex !== undefined) messageLineMap.set(item.messageIndex, lineNumber + (chunks.length ? 1 : 0));
      append(`## ${role} #${item.messageIndex ?? ""}${item.timestampIso ? ` (${timestamp(item.timestampIso)})` : ""}`); append();
      append(markdownText(item.text));
      for (const summary of buildAttachmentSummaryLines(item.attachments ?? [], { mode: "resume" })) append(markdownText(summary));
      append();
    } else if (item.type === "antigravityProgress") {
      const title = item.kind === "queuedInput" ? t("chat.antigravityProgress.queuedInput") : item.kind === "redactedThinking" ? t("chat.antigravityProgress.redactedThinking") : t("chat.antigravityProgress.thinking");
      if (!item.body && item.kind === "thinking") continue;
      append(`## ${title}`); append(); if (item.body) { append(markdownText(item.body)); append(); }
    } else if (item.type === "tool") {
      append(`### ${t("antigravity.transcript.tool", inlineText(item.name))}`); append();
      if (item.argumentsText) { append(fence(item.argumentsText, "json")); append(); }
      if (item.outputText !== undefined) { append(fence(item.outputText)); append(); }
    } else if (item.type === "patchGroup") {
      append(`### ${t("antigravity.transcript.unconfirmedChanges")}`); append();
      for (const entry of item.entries) {
        append(fence(entry.displayPath));
        const added = entry.statsAvailability?.added === false ? "—" : String(entry.added), removed = entry.statsAvailability?.removed === false ? "—" : String(entry.removed);
        append(`+${added} / -${removed}`); append();
        if (entry.detailsUnavailable) { append(entry.detailsUnavailable === "limit" ? t("chat.patchDiffLimit") : t("chat.patchDiffUnavailable")); append(); }
        else for (const hunk of entry.hunks) {
          const rows = hunk.rows.map(row => `${row.kind === "add" ? "+" : row.kind === "delete" ? "-" : " "}${row.kind === "add" ? row.rightText : row.leftText}`);
          append(fence([hunk.header, ...rows].join("\n"), "diff")); append();
        }
      }
    } else if (item.type === "usage") {
      append(`### ${t("chat.usage.title")}`); append();
      append(fence(JSON.stringify({ model: item.model, ...item.usage }, null, 2), "json")); append();
    } else if (item.type === "note") {
      append(`### ${inlineText(item.title)}`); append(); if (item.text) { append(markdownText(item.text)); append(); }
    }
  }
  if (truncated) chunks.push("\n---\n" + t("antigravity.transcript.truncated"));
  return { content: chunks.join("\n"), messageLineMap };
}

export async function renderAntigravityTranscript(fsPath: string, options: NativeTranscriptOptions): Promise<{ content: string; messageLineMap: Map<number, number> }> {
  const { model } = await buildAntigravityChatModel(fsPath, { includeDetails: true, images: { enabled: false, maxSizeMB: 1, thumbnailSize: "small" } });
  return renderAntigravityModelTranscript(model, options);
}
