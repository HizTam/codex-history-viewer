import { detectClaudeMaterializedMessageRole } from "./chatAttachments";
import { extractCompactUserText } from "../utils/textUtils";
import type { ClaudePastedPromptResolution } from "./claudePastedPrompt";

// Upstream marks generated compaction summaries explicitly; never classify by prose or language.
export function isClaudeCompactSummaryRecord(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as Record<string, unknown>).isCompactSummary === true &&
    detectClaudeMaterializedMessageRole(value) === "user";
}

export function extractClaudeCompactUserText(
  record: unknown,
  text: string,
  pastedPrompt?: ClaudePastedPromptResolution,
): string | null {
  if (isClaudeCompactSummaryRecord(record)) return null;
  // A rejected shutdown record or protected paste must not be reclassified from prose alone.
  const shutdownFlag = !!record && typeof record === "object" && !Array.isArray(record) &&
    (record as Record<string, unknown>).interruptedByShutdown === true;
  return extractCompactUserText(text, {
    preserveClaudeInterruptionText: shutdownFlag || pastedPrompt?.preserveSessionText === true,
  });
}
