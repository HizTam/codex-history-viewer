import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { SessionSummary } from "../sessions/sessionTypes";
import { normalizeFsPathKey } from "../utils/fsUtils";
import { antigravityReader } from "./antigravityReader";
import { ANTIGRAVITY_UUID } from "./antigravityTypes";

// The official CLI has no verified data-root switch; only its standard namespace is eligible.
export async function verifyAntigravityCliResume(session: SessionSummary, generation: number): Promise<boolean> {
  if (session.source !== "antigravity" || session.storage.rootKind !== "antigravitySessions" || session.storage.archiveState !== "active"
    || typeof session.meta.id !== "string" || !ANTIGRAVITY_UUID.test(session.meta.id) || antigravityReader.getConfigurationRevision() !== generation) return false;
  try {
    const standard = await fs.realpath(path.join(os.homedir(), ".gemini", "antigravity-cli"));
    const root = await fs.realpath(session.storage.rootPath);
    if (standard.startsWith("\\\\") || normalizeFsPathKey(root) !== normalizeFsPathKey(standard)) return false;
    const locator = antigravityReader.locator(session.fsPath);
    if (normalizeFsPathKey(locator.rootPath) !== normalizeFsPathKey(root)) return false;
    const metadata = await antigravityReader.readMetadata(session.fsPath);
    return metadata.conversationId === session.meta.id && antigravityReader.getConfigurationRevision() === generation;
  } catch { return false; }
}
