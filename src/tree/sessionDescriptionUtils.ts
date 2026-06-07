import type { SessionSummary } from "../sessions/sessionTypes";
import { t } from "../i18n";
import { safeDisplayPath } from "../utils/textUtils";

export function buildSessionDescription(
  session: SessionSummary,
  tags: readonly string[],
  projectAlias?: string,
  projectDisplayCwd?: string | null,
): string {
  const parts: string[] = [];
  if (session.storage.archiveState === "archived") parts.push(t("tree.description.archived"));
  const alias = String(projectAlias ?? "").trim();
  if (alias) parts.push(alias);
  else if (projectDisplayCwd) parts.push(safeDisplayPath(projectDisplayCwd, 80));
  else if (session.cwdShort) parts.push(session.cwdShort);
  if (tags.length > 0) parts.push(`#${tags.join(" #")}`);
  return parts.join("  ");
}
