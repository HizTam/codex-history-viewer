import * as vscode from "vscode";
import type { SessionSummary } from "../sessions/sessionTypes";

export function appendSessionTooltipDateLines(md: vscode.MarkdownString, session: SessionSummary): void {
  const displayDateTime = formatSessionDateTime(session.localDate, session.timeLabel);
  const startedDateTime = formatSessionDateTime(session.startedLocalDate, session.startedTimeLabel);
  const lastActivityDateTime = formatSessionDateTime(session.lastActivityLocalDate, session.lastActivityTimeLabel);

  md.appendMarkdown(`**${escapeForMarkdown(displayDateTime)}**  \n`);

  if (startedDateTime === lastActivityDateTime) return;

  md.appendMarkdown(`Started: ${escapeForMarkdown(startedDateTime)}  \n`);
  md.appendMarkdown(`Last activity: ${escapeForMarkdown(lastActivityDateTime)}  \n`);
}

function formatSessionDateTime(localDate: string, timeLabel: string): string {
  return `${localDate} ${timeLabel}`;
}

function escapeForMarkdown(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\*/g, "\\*").replace(/_/g, "\\_");
}
