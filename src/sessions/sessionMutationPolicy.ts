import * as path from "node:path";
import type { SessionSummary } from "./sessionTypes";

// The native SQLite source is never a target of this extension's history file mutations.
export function isReadOnlyNativeSession(session: Pick<SessionSummary, "source" | "fsPath">): boolean {
  return session.source === "antigravity" || path.extname(session.fsPath).toLowerCase() === ".db";
}
