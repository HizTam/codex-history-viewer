import type { CodexHistoryViewerConfig } from "../settings";
import type { HistoryRoots, HistorySourceInventoryState, SessionSource } from "./sessionTypes";

export type SourceInventoryStates = Readonly<Record<SessionSource, HistorySourceInventoryState>>;
export function sourceInventoryConfigKey(config: CodexHistoryViewerConfig, source: SessionSource): string {
  return JSON.stringify(source === "antigravity" ? [config.enableAntigravitySource === true, config.antigravitySessionsRoots ?? []]
    : source === "claude" ? [config.enableClaudeSource, config.claudeSessionsRoot]
    : [config.enableCodexSource, config.enableCodexArchivedSessions, config.enableCodexCompressedSessions === true, config.sessionsRoot, config.codexArchivedSessionsRoot]);
}
export function createSourceInventoryStates(roots: HistoryRoots, status: HistorySourceInventoryState["status"] = "cached"): SourceInventoryStates {
  const state = (allowedRoots: readonly string[]): HistorySourceInventoryState => Object.freeze({ status, configKey: "", configRevision: 0, generation: 0, allowedRoots: Object.freeze([...allowedRoots]) });
  // Cached inventories are never evidence that an absent session can be removed.
  return Object.freeze({ codex: state([roots.codexSessionsRoot, roots.codexArchivedSessionsRoot]), claude: state([roots.claudeSessionsRoot]), antigravity: state(roots.antigravitySessionsRoots ?? []) });
}
export function isSourceInventoryComplete(states: SourceInventoryStates | undefined, source: SessionSource, config: CodexHistoryViewerConfig): boolean {
  const state = states?.[source];
  return state?.status === "complete" && state.configKey === sourceInventoryConfigKey(config, source);
}
