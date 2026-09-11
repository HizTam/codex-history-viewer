import * as path from "node:path";
import type { HistoryIndex, SessionSummary } from "./sessionTypes";
import { extractCodexRolloutIdFromPath, findCodexHistoryParent, type CodexLogicalHistoryPlan } from "./codexHistoryBase";
import { normalizeCacheKey } from "../utils/fsUtils";
import { stableTextSha256 } from "../utils/stableTextHash";
import { normalizeCodexForkThreadId, sanitizeCachedCodexForkMetadata } from "../branchMap/codexForkMetadata";

const sourceLookupByInventory = new WeakMap<readonly SessionSummary[], ReadonlyMap<string, SessionSummary>>();
const revisionParentsByInventory = new WeakMap<readonly SessionSummary[], ReadonlyMap<string, SessionSummary>>();
const UUID_PART = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PHYSICAL_ROLLOUT_PATTERN = new RegExp(`^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-(${UUID_PART})(?:_(${UUID_PART}))?\\.jsonl$`, "iu");

function canonicalRolloutId(session: SessionSummary): string | undefined {
  const match = PHYSICAL_ROLLOUT_PATTERN.exec(path.basename(session.fsPath));
  const threadId = normalizeCodexForkThreadId(session.meta.id);
  if (!match || match[1]!.toLowerCase() !== threadId) return undefined;
  const suffix = match[2]?.toLowerCase();
  if (suffix === threadId) return undefined;
  return suffix ?? threadId;
}

// A standalone revert has no inherited bytes. Its revision relation must never become a reader dependency.
export function findCodexRolloutRevisionParent(
  session: SessionSummary,
  inventory: readonly SessionSummary[],
): SessionSummary | undefined {
  let parents = revisionParentsByInventory.get(inventory);
  if (!parents) {
    const resolved = new Map<string, SessionSummary>();
    const families = new Map<string, SessionSummary[]>();
    for (const candidate of inventory) {
      if (candidate.source !== "codex") continue;
      const explicit = findCodexHistoryParent(candidate, inventory);
      if (explicit && isSameCodexRolloutConversation(candidate, explicit)) resolved.set(candidate.cacheKey, explicit);
      const physicalId = canonicalRolloutId(candidate);
      if (!physicalId || (physicalId !== normalizeCodexForkThreadId(candidate.meta.id) &&
        !candidate.meta.codexHistoryBase && candidate.meta.codexStandaloneHistory !== true)) continue;
      const key = JSON.stringify([candidate.identityKey, candidate.storage.rootKind,
        candidate.storage.archiveState, normalizeCacheKey(candidate.storage.rootPath)]);
      const family = families.get(key) ?? [];
      family.push(candidate);
      families.set(key, family);
    }
    for (const family of families.values()) {
      const counts = new Map<string, number>();
      for (const candidate of family) {
        const id = canonicalRolloutId(candidate)!;
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      family.sort(compareCodexRolloutCreation);
      for (let index = 0; index + 1 < family.length; index += 1) {
        const child = family[index]!;
        const parent = family[index + 1]!;
        const childId = canonicalRolloutId(child)!;
        if (child.meta.codexHistoryBase || child.meta.codexStandaloneHistory !== true ||
          childId === normalizeCodexForkThreadId(child.meta.id) || counts.get(childId) !== 1 ||
          counts.get(canonicalRolloutId(parent)!) !== 1 || !isSameCodexRolloutConversation(child, parent) ||
          compareCodexRolloutCreation(child, parent) >= 0 ||
          (family[index + 2] && compareCodexRolloutCreation(parent, family[index + 2]!) === 0)) continue;
        resolved.set(child.cacheKey, parent);
      }
    }
    parents = resolved;
    revisionParentsByInventory.set(inventory, parents);
  }
  return parents.get(session.cacheKey);
}

export function collectCodexRolloutDeletionTargets(
  selected: readonly SessionSummary[],
  inventory: readonly SessionSummary[],
): SessionSummary[] {
  const targets = new Map(selected.map((session) => [session.cacheKey, session]));
  const selectedByIdentity = new Map<string, SessionSummary[]>();
  for (const session of selected) {
    if (session.source !== "codex") continue;
    const family = selectedByIdentity.get(session.identityKey) ?? [];
    family.push(session);
    selectedByIdentity.set(session.identityKey, family);
  }
  for (const candidate of inventory) {
    if (targets.has(candidate.cacheKey)) continue;
    if (selectedByIdentity.get(candidate.identityKey)?.some((session) =>
      areCodexRolloutRevisionsRelated(session, candidate, inventory),
    )) {
      targets.set(candidate.cacheKey, candidate);
    }
  }
  return Array.from(targets.values());
}

export function findSessionHistorySource(index: HistoryIndex, cacheKey: string): SessionSummary | undefined {
  const current = index.byCacheKey.get(cacheKey);
  if (current) return current;
  const inventory = index.historySources ?? index.sessions;
  let lookup = sourceLookupByInventory.get(inventory);
  if (!lookup) {
    lookup = new Map(inventory.map((session) => [session.cacheKey, session]));
    sourceLookupByInventory.set(inventory, lookup);
  }
  return lookup.get(cacheKey);
}

export function isSameCodexRolloutConversation(left: SessionSummary, right: SessionSummary): boolean {
  const threadId = normalizeCodexForkThreadId(left.meta.id);
  return Boolean(
    left.source === "codex" && right.source === "codex" && threadId &&
    threadId === normalizeCodexForkThreadId(right.meta.id) &&
    left.identityKey === right.identityKey &&
    left.storage.rootKind === right.storage.rootKind &&
    left.storage.archiveState === right.storage.archiveState &&
    normalizeCacheKey(left.storage.rootPath) === normalizeCacheKey(right.storage.rootPath),
  );
}

// Creation order belongs to the physical rollout; late activity in an old revision is not a new edit.
export function compareCodexRolloutCreation(left: SessionSummary, right: SessionSummary): number {
  const creationKey = (session: SessionSummary): string => {
    const id = extractCodexRolloutIdFromPath(session.fsPath);
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab]/u.test(id)) {
      return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16).toString().padStart(16, "0");
    }
    const matches = Array.from(session.fsPath.matchAll(/(?:^|[/\\])rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-/gu));
    const stamp = matches.at(-1)?.[1];
    const timestamp = stamp ? Date.parse(`${stamp.slice(0, 13)}:${stamp.slice(14, 16)}:${stamp.slice(17, 19)}Z`) : NaN;
    const fallback = Date.parse(session.meta.timestampIso ?? session.startedAtIso ?? "");
    return String(Number.isFinite(timestamp) ? timestamp : Number.isFinite(fallback) ? fallback : 0).padStart(16, "0");
  };
  return creationKey(right).localeCompare(creationKey(left));
}

export function findSupersededCodexRolloutKeys(
  inventory: readonly SessionSummary[],
  plans: ReadonlyMap<string, CodexLogicalHistoryPlan>,
): ReadonlySet<string> {
  const superseded = new Set<string>();
  for (const child of inventory) {
    if (!child.meta.codexHistoryBase || !plans.get(child.cacheKey)?.complete) continue;
    let current = child;
    for (let depth = 0; depth < 32; depth += 1) {
      const parent = findCodexHistoryParent(current, inventory);
      if (!parent || !isSameCodexRolloutConversation(parent, child)) break;
      superseded.add(parent.cacheKey);
      current = parent;
    }
  }
  return superseded;
}

// Resolve only known physical revisions. Callers must also validate the active configuration.
export function resolveCodexRolloutMainline(index: HistoryIndex, cacheKey: string): SessionSummary | undefined {
  const current = index.byCacheKey.get(cacheKey);
  if (current) return current;
  const source = findSessionHistorySource(index, cacheKey);
  const mainline = source && index.byIdentityKey.get(source.identityKey);
  if (!source || !mainline) return undefined;
  return areCodexRolloutRevisionsRelated(source, mainline, index.historySources ?? index.sessions)
    ? mainline : undefined;
}

export function areCodexRolloutRevisionsRelated(
  left: SessionSummary,
  right: SessionSummary,
  inventory: readonly SessionSummary[],
): boolean {
  if (!isSameCodexRolloutConversation(left, right)) return false;
  const ancestors = (start: SessionSummary): Set<string> => {
    const keys = new Set<string>();
    let current: SessionSummary | undefined = start;
    let referenceDepth = 0;
    // Standalone edits add no reader dependency, even after many successive prompt edits.
    for (let depth = 0; current && depth <= inventory.length; depth += 1) {
      if (keys.has(current.cacheKey)) return new Set();
      keys.add(current.cacheKey);
      referenceDepth = current.meta.codexHistoryBase ? referenceDepth + 1 : 0;
      if (referenceDepth > 32) return new Set();
      const parent = findCodexRolloutRevisionParent(current, inventory);
      current = parent && isSameCodexRolloutConversation(parent, start) ? parent : undefined;
    }
    return current ? new Set() : keys;
  };
  const leftAncestors = ancestors(left);
  return Array.from(ancestors(right)).some((key) => leftAncestors.has(key));
}

export interface CodexRolloutNavigationInventory {
  sessions: SessionSummary[];
  revisionParentByCacheKey: ReadonlyMap<string, string>;
  forkHistoryParentByCacheKey: ReadonlyMap<string, string>;
  sourceIdentityByCacheKey: ReadonlyMap<string, string>;
  representativeCacheKeys: ReadonlySet<string>;
}

// Route keys live only in navigation snapshots; persisted conversation identities remain intact.
export function buildCodexRolloutNavigationInventory(index: HistoryIndex): CodexRolloutNavigationInventory {
  const inventory = index.historySources ?? index.sessions;
  const retained = new Map(index.sessions.map((session) => [session.cacheKey, session]));
  const revisionParentByCacheKey = new Map<string, string>();
  for (const child of inventory) {
    const representative = index.byIdentityKey.get(child.identityKey);
    if (!representative || !isSameCodexRolloutConversation(child, representative)) continue;
    const parent = findCodexRolloutRevisionParent(child, inventory);
    if (!parent || !isSameCodexRolloutConversation(parent, child)) continue;
    retained.set(parent.cacheKey, parent);
    retained.set(child.cacheKey, child);
    revisionParentByCacheKey.set(child.cacheKey, parent.cacheKey);
  }
  const forkHistoryParentByCacheKey = new Map<string, string>();
  for (const child of retained.values()) {
    const fork = sanitizeCachedCodexForkMetadata(child.meta.codexFork).value;
    if (!fork) continue;
    const parent = findCodexHistoryParent(child, inventory);
    // A paginated fork can still reference a physical revision preceding its parent's edit.
    // Ancestor references of nested forks must not replace the declared direct parent.
    if (parent && retained.has(parent.cacheKey) && normalizeCodexForkThreadId(parent.meta.id) === fork.parentThreadId) {
      forkHistoryParentByCacheKey.set(child.cacheKey, parent.cacheKey);
    }
  }
  const representativeCacheKeys = new Set(index.sessions.map((session) => session.cacheKey));
  const sourceIdentityByCacheKey = new Map<string, string>();
  const sessions = Array.from(retained.values(), (session) => {
    sourceIdentityByCacheKey.set(session.cacheKey, session.identityKey);
    return representativeCacheKeys.has(session.cacheKey) ? session : {
      ...session,
      identityKey: `codex-rollout:${stableTextSha256(session.cacheKey)}`,
    };
  });
  return { sessions, revisionParentByCacheKey, forkHistoryParentByCacheKey, sourceIdentityByCacheKey, representativeCacheKeys };
}
