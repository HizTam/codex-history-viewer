import type { SessionSummary } from "../sessions/sessionTypes";
import { t } from "../i18n";

export function buildSessionDescription(session: SessionSummary, tags: readonly string[], projectAlias?: string): string {
  const parts: string[] = [];
  if (session.storage.archiveState === "archived") parts.push(t("tree.description.archived"));
  const alias = String(projectAlias ?? "").trim();
  if (alias) parts.push(alias);
  else if (session.cwdShort) parts.push(session.cwdShort);
  if (tags.length > 0) parts.push(`#${tags.join(" #")}`);
  return parts.join("  ");
}
