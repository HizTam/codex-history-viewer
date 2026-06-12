import * as vscode from "vscode";
import type { PreviewTooltipMode } from "../settings";
import type { SessionSummary } from "../sessions/sessionTypes";
import { t } from "../i18n";

export interface SessionTooltipAnnotation {
  tags: readonly string[];
  note: string;
}

export type SessionDateAxis = "display" | "started" | "lastActivity";
export type SessionDateLabelKey = "tree.tooltip.sessionDate.started" | "tree.tooltip.sessionDate.lastActivity";

export function buildTreeRowTooltip(label: string, description?: string): string {
  const parts = [label.trim(), String(description ?? "").trim()].filter((x) => x.length > 0);
  return parts.join(" ");
}

export function sessionDateLabelKeyForAxis(axis: SessionDateAxis): SessionDateLabelKey | undefined {
  switch (axis) {
    case "started":
      return "tree.tooltip.sessionDate.started";
    case "lastActivity":
      return "tree.tooltip.sessionDate.lastActivity";
    default:
      return undefined;
  }
}

export function getSessionDatePartsForAxis(
  session: SessionSummary,
  axis: SessionDateAxis,
): { localDate: string; timeLabel: string } {
  if (axis === "started") {
    const localDate = String(session.startedLocalDate ?? "").trim();
    if (localDate) return { localDate, timeLabel: String(session.startedTimeLabel ?? "").trim() };
  }
  if (axis === "lastActivity") {
    const localDate = String(session.lastActivityLocalDate ?? "").trim();
    if (localDate) return { localDate, timeLabel: String(session.lastActivityTimeLabel ?? "").trim() };
    return getSessionDatePartsForAxis(session, "started");
  }
  return {
    localDate: String(session.localDate ?? "").trim(),
    timeLabel: String(session.timeLabel ?? "").trim(),
  };
}

export function formatSessionDateTimeForAxis(session: SessionSummary, axis: SessionDateAxis): string {
  const { localDate, timeLabel } = getSessionDatePartsForAxis(session, axis);
  return formatSessionDateTime(localDate, timeLabel);
}

export function buildSessionHoverTooltip(params: {
  session: SessionSummary;
  annotation: SessionTooltipAnnotation | null;
  label: string;
  description?: string;
  mode: PreviewTooltipMode;
  projectAlias?: string;
  projectDisplayCwd?: string | null;
  primaryDateTime?: string;
  primaryDateLabelKey?: SessionDateLabelKey;
}): string | vscode.MarkdownString {
  const { session, annotation, label, description, mode, projectAlias, projectDisplayCwd, primaryDateLabelKey } = params;
  if (mode === "titleOnly") {
    const tooltipLabel =
      primaryDateLabelKey && params.primaryDateTime
        ? `${t(primaryDateLabelKey, params.primaryDateTime)} ${String(session.displayTitle ?? "").trim() || label}`
        : label;
    return buildTreeRowTooltip(tooltipLabel, description);
  }

  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = false;
  appendSessionTooltipTitleLines(md, session);
  appendSessionTooltipDateLines(md, session, params.primaryDateTime, primaryDateLabelKey);
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

export function appendSessionTooltipDateLines(
  md: vscode.MarkdownString,
  session: SessionSummary,
  primaryDateTime?: string,
  primaryDateLabelKey?: SessionDateLabelKey,
): void {
  const displayDateTime = primaryDateTime ?? formatSessionDateTime(session.localDate, session.timeLabel);
  const startedDateTime = formatSessionDateTime(session.startedLocalDate, session.startedTimeLabel);
  const lastActivityDateTime = formatSessionDateTime(session.lastActivityLocalDate, session.lastActivityTimeLabel);

  if (startedDateTime === lastActivityDateTime) {
    const primaryLine = primaryDateLabelKey ? t(primaryDateLabelKey, displayDateTime) : displayDateTime;
    md.appendMarkdown(`**${escapeForMarkdown(primaryLine)}**  \n`);
    return;
  }

  const highlightedKey = primaryDateLabelKey ?? inferDateLabelKey(displayDateTime, startedDateTime, lastActivityDateTime);
  appendSessionDateDetailLine(md, "tree.tooltip.sessionDate.started", startedDateTime, highlightedKey);
  appendSessionDateDetailLine(md, "tree.tooltip.sessionDate.lastActivity", lastActivityDateTime, highlightedKey);
}

function appendSessionDateDetailLine(
  md: vscode.MarkdownString,
  key: SessionDateLabelKey,
  value: string,
  highlightedKey: SessionDateLabelKey | undefined,
): void {
  const line = escapeForMarkdown(t(key, value));
  md.appendMarkdown(key === highlightedKey ? `**${line}**  \n` : `${line}  \n`);
}

function inferDateLabelKey(
  displayDateTime: string,
  startedDateTime: string,
  lastActivityDateTime: string,
): SessionDateLabelKey | undefined {
  if (displayDateTime === startedDateTime) return "tree.tooltip.sessionDate.started";
  if (displayDateTime === lastActivityDateTime) return "tree.tooltip.sessionDate.lastActivity";
  return undefined;
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
  const datePart = String(localDate ?? "").trim();
  const timePart = String(timeLabel ?? "").trim();
  if (!datePart) return timePart;
  return timePart ? `${datePart} ${timePart}` : datePart;
}

function escapeForMarkdown(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\*/g, "\\*").replace(/_/g, "\\_");
}

function sourceName(source: SessionSummary["source"]): string {
  return source === "claude" ? "Claude Code" : "Codex";
}
