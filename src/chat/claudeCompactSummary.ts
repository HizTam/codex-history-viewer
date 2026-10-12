import { detectClaudeMaterializedMessageRole } from "./chatAttachments";
import { extractCompactUserText } from "../utils/textUtils";

// Upstream marks generated compaction summaries explicitly; never classify by prose or language.
export function isClaudeCompactSummaryRecord(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as Record<string, unknown>).isCompactSummary === true &&
    detectClaudeMaterializedMessageRole(value) === "user";
}

export function extractClaudeCompactUserText(record: unknown, text: string): string | null {
  return isClaudeCompactSummaryRecord(record) ? null : extractCompactUserText(text);
}
