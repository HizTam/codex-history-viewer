import type { CodexHistoryViewerConfig } from "../settings";
import type { HistoryIndex, SessionSummary } from "../sessions/sessionTypes";
import { sourceInventoryConfigKey } from "../sessions/sourceInventory";
import { normalizeCacheKey, normalizeFsPathKey } from "../utils/fsUtils";
import { antigravityReader } from "./antigravityReader";
import { antigravitySessionIdentity } from "./antigravitySessionSummary";
import { ANTIGRAVITY_UUID } from "./antigravityTypes";

export interface AntigravitySourceScope {
  readonly configKey: string;
  readonly readerRevision: number;
  readonly readerRoots: readonly string[];
  readonly inventoryKey?: string;
  readonly inventoryRoots: readonly string[];
  readonly targets: readonly { readonly fsPath: string; readonly identityKey: string; readonly rootPath: string; readonly id: string | undefined }[];
}

type AntigravityScopeIndex = Pick<HistoryIndex, "byCacheKey" | "sourceInventoryStates">;

const rootsKey = (roots: readonly string[]): string => JSON.stringify(roots.map(normalizeFsPathKey).sort());

// Capture only identity and permission metadata; displayed bodies do not grant later Host capabilities.
export function captureAntigravitySourceScope(config: CodexHistoryViewerConfig, index: AntigravityScopeIndex, sessions: readonly SessionSummary[]): AntigravitySourceScope {
  const inventory = index.sourceInventoryStates?.antigravity;
  return Object.freeze({
    configKey: sourceInventoryConfigKey(config, "antigravity"), readerRevision: antigravityReader.getConfigurationRevision(),
    readerRoots: Object.freeze([...antigravityReader.getRoots()]), inventoryKey: inventory?.configKey,
    inventoryRoots: Object.freeze([...(inventory?.allowedRoots ?? [])]),
    targets: Object.freeze(sessions.filter(session => session.source === "antigravity").map(session => Object.freeze({
      fsPath: session.fsPath, identityKey: session.identityKey, rootPath: session.storage.rootPath, id: session.meta.id,
    }))),
  });
}

export function isAntigravitySourceScopeEnvironmentCurrent(scope: AntigravitySourceScope, config: CodexHistoryViewerConfig, index: AntigravityScopeIndex): boolean {
  const inventory = index.sourceInventoryStates?.antigravity;
  if (scope.configKey !== sourceInventoryConfigKey(config, "antigravity") || scope.readerRevision !== antigravityReader.getConfigurationRevision()
    || rootsKey(scope.readerRoots) !== rootsKey(antigravityReader.getRoots()) || scope.inventoryKey !== inventory?.configKey
     || rootsKey(scope.inventoryRoots) !== rootsKey(inventory?.allowedRoots ?? [])) return false;
  return true;
}

export function isAntigravitySourceScopeCurrent(scope: AntigravitySourceScope, config: CodexHistoryViewerConfig, index: AntigravityScopeIndex): boolean {
  if (!isAntigravitySourceScopeEnvironmentCurrent(scope, config, index)) return false;
  return scope.targets.every(target => {
    const current = index.byCacheKey.get(normalizeCacheKey(target.fsPath));
    return current?.source === "antigravity" && current.identityKey === target.identityKey && current.meta.id === target.id
      && normalizeFsPathKey(current.storage.rootPath) === normalizeFsPathKey(target.rootPath)
      && normalizeCacheKey(current.fsPath) === normalizeCacheKey(target.fsPath);
  });
}

export function hasAntigravitySessionPermission(config: CodexHistoryViewerConfig, index: AntigravityScopeIndex, session: SessionSummary | undefined): session is SessionSummary {
  const inventory = index.sourceInventoryStates?.antigravity;
  if (!config.enableAntigravitySource || !session || session.source !== "antigravity" || session.storage.rootKind !== "antigravitySessions"
    || session.storage.archiveState !== "active" || !ANTIGRAVITY_UUID.test(session.meta.id ?? "") || !inventory
    || inventory.configKey !== sourceInventoryConfigKey(config, "antigravity")
    || !inventory.allowedRoots.some(root => normalizeFsPathKey(root) === normalizeFsPathKey(session.storage.rootPath))) return false;
  try {
    const locator = antigravityReader.locator(session.fsPath);
    return locator.conversationId === session.meta.id && normalizeFsPathKey(locator.rootPath) === normalizeFsPathKey(session.storage.rootPath)
      && session.identityKey === antigravitySessionIdentity(locator.rootPath, locator.conversationId);
  } catch { return false; }
}
