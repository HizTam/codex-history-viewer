import type { SessionSummary } from "../sessions/sessionTypes";
import { t } from "../i18n";
import { safeDisplayPath } from "../utils/textUtils";
import type { CodexAgentPresentation } from "../agents/codexAgentRunsTypes";

export function buildSessionDescription(
  session: SessionSummary,
  tags: readonly string[],
  projectAlias?: string,
  projectDisplayCwd?: string | null,
  agentPresentation?: CodexAgentPresentation,
): string {
  const parts: string[] = [];
  if (agentPresentation?.relation === "child" || agentPresentation?.relation === "both") {
    parts.push(`${t("codexAgentRuns.subagent")} · ${agentPresentation.taskLabel}`);
  }
  if (
    (agentPresentation?.relation === "parent" || agentPresentation?.relation === "both") &&
    agentPresentation.directChildCount > 0
  ) {
    parts.push(t("codexAgentRuns.directChildrenDescription", agentPresentation.directChildCount));
  }
  if (session.storage.archiveState === "archived") parts.push(t("tree.description.archived"));
  const alias = String(projectAlias ?? "").trim();
  if (alias) parts.push(alias);
  else if (projectDisplayCwd) parts.push(safeDisplayPath(projectDisplayCwd, 80));
  else if (session.cwdShort) parts.push(session.cwdShort);
  if (tags.length > 0) parts.push(`#${tags.join(" #")}`);
  return parts.join("  ");
}
