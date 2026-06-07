import * as vscode from "vscode";
import type { PreviewTooltipMode } from "../settings";
import type { SessionSummary } from "../sessions/sessionTypes";
import { t } from "../i18n";

export interface SessionTooltipAnnotation {
  tags: readonly string[];
  note: string;
}

export function buildTreeRowTooltip(label: string, description?: string): string {
  const parts = [label.trim(), String(description ?? "").trim()].filter((x) => x.length > 0);
  return parts.join(" ");
}

export function buildSessionHoverTooltip(params: {
  session: SessionSummary;
  annotation: SessionTooltipAnnotation | null;
  label: string;
  description?: string;
  mode: PreviewTooltipMode;
  projectAlias?: string;
  projectDisplayCwd?: string | null;
}): string | vscode.MarkdownString {
  const { session, annotation, label, description, mode, projectAlias, projectDisplayCwd } = params;
  if (mode === "titleOnly") return buildTreeRowTooltip(label, description);

  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = false;
  appendSessionTooltipTitleLines(md, session);
  appendSessionTooltipDateLines(md, session);
  appendSessionMetadataLines(md, session, annotation, projectAlias, projectDisplayCwd);

  if (mode === "compact") return md;

  md.appendMarkdown(`\n---\n`);
  for (const msg of session.previewMessages) {
    md.appendMarkdown(`**${msg.role}**  \n`);
    md.appendMarkdown(`${escapeForMarkdown(msg.text)}\n\n`);
  }
  md.appendMarkdown(`---\n${escapeForMarkdown(t("tree.tooltip.sessionActions"))}\n`);
  return md;
}

export function appendSessionTooltipDateLines(md: vscode.MarkdownString, session: SessionSummary): void {
  const displayDateTime = formatSessionDateTime(session.localDate, session.timeLabel);
  const startedDateTime = formatSessionDateTime(session.startedLocalDate, session.startedTimeLabel);
  const lastActivityDateTime = formatSessionDateTime(session.lastActivityLocalDate, session.lastActivityTimeLabel);

  md.appendMarkdown(`**${escapeForMarkdown(displayDateTime)}**  \n`);

  if (startedDateTime === lastActivityDateTime) return;

  md.appendMarkdown(`Started: ${escapeForMarkdown(startedDateTime)}  \n`);
  md.appendMarkdown(`Last activity: ${escapeForMarkdown(lastActivityDateTime)}  \n`);
}

export function appendSessionTooltipTitleLines(md: vscode.MarkdownString, session: SessionSummary): void {
  if (!session.customTitle) {
    const title = String(session.displayTitle ?? "").trim();
    if (title) {
      md.appendMarkdown(`${escapeForMarkdown(t("tree.tooltip.title"))}: ${escapeForMarkdown(title)}  \n`);
    }
    return;
  }

  md.appendMarkdown(`${escapeForMarkdown(t("tree.tooltip.customTitle"))}: ${escapeForMarkdown(session.customTitle)}  \n`);
  const originalTitle = String(session.originalTitle ?? "").trim();
  if (originalTitle) {
    md.appendMarkdown(`${escapeForMarkdown(t("tree.tooltip.originalTitle"))}: ${escapeForMarkdown(originalTitle)}  \n`);
  }
}

function appendSessionMetadataLines(
  md: vscode.MarkdownString,
  session: SessionSummary,
  annotation: SessionTooltipAnnotation | null,
  projectAlias?: string,
  projectDisplayCwd?: string | null,
): void {
  md.appendMarkdown(`Source: ${sourceName(session.source)}  \n`);
  if (session.storage.archiveState === "archived") {
    md.appendMarkdown(
      `${escapeForMarkdown(t("tree.tooltip.location"))}: ${escapeForMarkdown(t("session.location.archived"))}  \n`,
    );
  }
  const alias = String(projectAlias ?? "").trim();
  const cwd = typeof session.meta?.cwd === "string" ? session.meta.cwd.trim() : "";
  const displayCwd = typeof projectDisplayCwd === "string" ? projectDisplayCwd.trim() : "";
  if (alias) {
    md.appendMarkdown(`${escapeForMarkdown(t("tree.tooltip.projectLabel"))}: ${escapeForMarkdown(alias)}  \n`);
  }
  if (displayCwd && cwd && displayCwd !== cwd) {
    md.appendMarkdown(`${escapeForMarkdown(t("tree.tooltip.displayCwdLabel"))}: ${escapeForMarkdown(displayCwd)}  \n`);
    md.appendMarkdown(`${escapeForMarkdown(t("tree.tooltip.originalCwdLabel"))}: ${escapeForMarkdown(cwd)}  \n`);
  } else if (alias && cwd) {
    md.appendMarkdown(`${escapeForMarkdown(t("tree.tooltip.cwdLabel"))}: ${escapeForMarkdown(cwd)}  \n`);
  } else if (session.cwdShort) {
    md.appendMarkdown(`${escapeForMarkdown(session.cwdShort)}  \n`);
  }
  if (annotation && annotation.tags.length > 0) {
    md.appendMarkdown(`Tags: ${escapeForMarkdown(annotation.tags.join(", "))}  \n`);
  }
  if (annotation && annotation.note.length > 0) {
    md.appendMarkdown(`Note: ${escapeForMarkdown(annotation.note)}  \n`);
  }
}

function formatSessionDateTime(localDate: string, timeLabel: string): string {
  return `${localDate} ${timeLabel}`;
}

function escapeForMarkdown(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\*/g, "\\*").replace(/_/g, "\\_");
}

function sourceName(source: SessionSummary["source"]): string {
  return source === "claude" ? "Claude Code" : "Codex";
}
