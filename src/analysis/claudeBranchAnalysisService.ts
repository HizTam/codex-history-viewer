import { createHash } from "node:crypto";
import type { ClaudeGraphRecordOccurrence, SessionAnalysisEntry } from "./sessionAnalysisTypes";
import type {
  ClaudeBranchConfidence,
  ClaudeBranchChoice,
  ClaudeBranchEdge,
  ClaudeBranchGroup,
  ClaudeBranchLane,
  ClaudeBranchMapModel,
  ClaudeBranchNode,
  ClaudeBranchOccurrenceView,
} from "../branchMap/claudeBranchMapTypes";

const MAX_GRAPH_NODES = 20_000;

export interface ClaudeBranchAnnotationState {
  hasTags: boolean;
  hasNote: boolean;
}

export interface ClaudeBranchAnalysisInput {
  entries: readonly SessionAnalysisEntry[];
  baseSessionCacheKey: string;
  projectLabel: string;
  getSessionLabel: (cacheKey: string) => string;
  getAnnotationState?: (cacheKey: string) => ClaudeBranchAnnotationState;
  isOccurrenceBookmarked?: (occurrence: ClaudeGraphRecordOccurrence) => boolean;
  generatedAtIso?: string;
  refreshing?: boolean;
  stale?: boolean;
}

interface CanonicalGroup {
  id: string;
  confidence: ClaudeBranchConfidence;
  occurrences: ClaudeGraphRecordOccurrence[];
  parentId?: string;
  hasConflict: boolean;
  compactBoundary: boolean;
  depth: number;
}

export class ClaudeBranchAnalysisService {
  public build(input: ClaudeBranchAnalysisInput): ClaudeBranchMapModel {
    const primaryEntries = input.entries.filter(
      (entry) => entry.source === "claude" && entry.claudeIsSidechain !== true && entry.completeness !== "failed" && entry.completeness !== "unsupported",
    );
    const excludedSidechainCount = input.entries.filter(
      (entry) => entry.source === "claude" && entry.claudeIsSidechain === true,
    ).length;
    const unavailableSessionCount = input.entries.filter(
      (entry) => entry.source === "claude" && (entry.completeness === "failed" || entry.completeness === "unsupported"),
    ).length;
    const { lanes, laneByCacheKey, laneById } = buildLanes(primaryEntries, input);
    const candidateOccurrences = primaryEntries
      .flatMap((entry) => entry.claudeGraphRecords)
      .filter((occurrence) => occurrence.isMeta !== true && occurrence.isSidechain !== true)
      .sort(compareOccurrences);
    const allOccurrences = candidateOccurrences.slice(0, MAX_GRAPH_NODES * 10);
    const groups = canonicalizeOccurrences(allOccurrences);
    resolveParents(groups);
    markIdentityConflicts(groups);
    breakCycles(groups);
    propagateUnresolvedDescendants(groups);
    assignDepths(groups);
    const nodes = groups
      .map((group) => toViewNode(group, laneByCacheKey, laneById, input))
      .sort(compareNodes)
      .slice(0, MAX_GRAPH_NODES);
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = buildEdges(groups).filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));
    const branchGroups = buildBranchGroups(nodes);
    const baseLane = lanes.find((lane) => lane.isBaseSession);
    return {
      version: 1,
      projectLabel: input.projectLabel,
      baseSessionLabel: baseLane?.label ?? input.getSessionLabel(input.baseSessionCacheKey),
      generatedAtIso: input.generatedAtIso ?? new Date().toISOString(),
      refreshing: input.refreshing === true,
      stale: input.stale === true,
      lanes,
      nodes,
      edges,
      groups: branchGroups,
      unresolvedCount: nodes.filter((node) => node.confidence === "unresolved" || node.hasConflict).length,
      excludedSidechainCount,
      unavailableSessionCount,
      partial:
        candidateOccurrences.length > allOccurrences.length ||
        groups.length > nodes.length,
    };
  }
}

function buildBranchGroups(nodes: readonly ClaudeBranchNode[]): ClaudeBranchGroup[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const childrenByParentId = new Map<string, ClaudeBranchNode[]>();
  for (const node of nodes) {
    if (!node.parentId || node.confidence === "unresolved" || node.hasConflict) continue;
    const parent = nodeById.get(node.parentId);
    if (!parent || parent.confidence === "unresolved" || parent.hasConflict) continue;
    const children = childrenByParentId.get(node.parentId) ?? [];
    children.push(node);
    childrenByParentId.set(node.parentId, children);
  }

  const groups: ClaudeBranchGroup[] = [];
  for (const [parentNodeId, children] of childrenByParentId) {
    if (children.length < 2) continue;
    const orderedChildren = children.slice().sort(compareNodes);
    const distinctLaneIds = new Set(orderedChildren.flatMap((child) => child.laneIds));
    if (distinctLaneIds.size < 2) continue;
    const choices: ClaudeBranchChoice[] = orderedChildren.map((child) => ({
      id: hashId(`choice\u0000${parentNodeId}\u0000${child.id}`),
      nodeId: child.id,
      preview: child.preview,
      occurrenceIds: child.occurrences.map((occurrence) => occurrence.id),
      laneIds: [...child.laneIds],
    }));
    groups.push({
      id: hashId(`group\u0000${parentNodeId}\u0000${choices.map((choice) => choice.id).join("\u0000")}`),
      parentNodeId,
      choices,
    });
  }
  return groups.sort((left, right) => {
    const leftNode = nodeById.get(left.parentNodeId);
    const rightNode = nodeById.get(right.parentNodeId);
    if (leftNode && rightNode) return compareNodes(leftNode, rightNode) || left.id.localeCompare(right.id);
    return left.id.localeCompare(right.id);
  });
}

function buildLanes(
  entries: readonly SessionAnalysisEntry[],
  input: ClaudeBranchAnalysisInput,
): {
  lanes: ClaudeBranchLane[];
  laneByCacheKey: Map<string, ClaudeBranchLane>;
  laneById: Map<string, ClaudeBranchLane>;
} {
  const ordered = entries.slice().sort((left, right) => {
    if (left.cacheKey === input.baseSessionCacheKey) return -1;
    if (right.cacheKey === input.baseSessionCacheKey) return 1;
    return compareIso(left.startedAtIso, right.startedAtIso) || left.cacheKey.localeCompare(right.cacheKey);
  });
  const laneByCacheKey = new Map<string, ClaudeBranchLane>();
  const lanes = ordered.map((entry, order) => {
    const annotation = input.getAnnotationState?.(entry.cacheKey) ?? { hasTags: false, hasNote: false };
    const lane: ClaudeBranchLane = {
      id: hashId(`lane\u0000${entry.cacheKey}`),
      order,
      label: input.getSessionLabel(entry.cacheKey),
      isBaseSession: entry.cacheKey === input.baseSessionCacheKey,
      hasTags: annotation.hasTags,
      hasNote: annotation.hasNote,
    };
    laneByCacheKey.set(entry.cacheKey, lane);
    return lane;
  });
  return { lanes, laneByCacheKey, laneById: new Map(lanes.map((lane) => [lane.id, lane])) };
}

function canonicalizeOccurrences(occurrences: readonly ClaudeGraphRecordOccurrence[]): CanonicalGroup[] {
  const union = new OccurrenceUnion(occurrences);
  const occurrenceBySessionUuid = buildOccurrenceBySessionUuid(occurrences);
  const topology = buildOccurrenceTopology(occurrences, occurrenceBySessionUuid);
  markIntrinsicRecordUuidConflicts(occurrences, union, topology.depthByOccurrenceId);
  markContextualRecordUuidConflicts(topology.roots, union, () => "root");
  unionEvidenceMatches(topology.roots, union, () => "root");
  unionSharedRootPrefixes(topology, union);

  let level = topology.roots;
  while (level.length > 0) {
    const children = level.flatMap(
      (occurrence) => topology.childrenByParentOccurrenceId.get(occurrence.occurrenceId) ?? [],
    );
    const getParentContext = (occurrence: ClaudeGraphRecordOccurrence): string => {
      const parent = topology.parentByOccurrenceId.get(occurrence.occurrenceId);
      return parent && !union.isConflicted(parent.occurrenceId)
        ? union.find(parent.occurrenceId)
        : "";
    };
    markContextualRecordUuidConflicts(children, union, getParentContext);
    unionEvidenceMatches(children, union, getParentContext);
    unionStructuralPrefixMatches(children, union, topology.parentByOccurrenceId);
    level = children;
  }

  const occurrencesByRoot = new Map<string, ClaudeGraphRecordOccurrence[]>();
  for (const occurrence of occurrences) {
    const root = union.find(occurrence.occurrenceId);
    const grouped = occurrencesByRoot.get(root) ?? [];
    grouped.push(occurrence);
    occurrencesByRoot.set(root, grouped);
  }

  const groups: CanonicalGroup[] = Array.from(occurrencesByRoot.values()).map((groupOccurrences) => ({
    id: "",
    confidence: groupOccurrences.some((occurrence) => union.isConflicted(occurrence.occurrenceId))
      ? "unresolved"
      : groupOccurrences.length > 1
        ? "secondary"
        : "exact",
    occurrences: groupOccurrences,
    hasConflict: groupOccurrences.some((occurrence) => union.isConflicted(occurrence.occurrenceId)),
    compactBoundary: groupOccurrences.some((occurrence) => occurrence.compactBoundary),
    depth: 0,
  }));
  for (const group of groups) {
    group.occurrences.sort(compareOccurrences);
    group.id = hashId(group.occurrences.map((occurrence) => occurrence.occurrenceId).sort().join("\u0000"));
  }
  return groups;
}

class OccurrenceUnion {
  private readonly parent = new Map<string, string>();
  private readonly size = new Map<string, number>();
  private readonly sessionKeyById = new Map<string, string>();
  private readonly sessionKeysByRoot = new Map<string, Set<string>>();
  private readonly conflictRoots = new Set<string>();

  constructor(occurrences: readonly ClaudeGraphRecordOccurrence[]) {
    for (const occurrence of occurrences) {
      this.parent.set(occurrence.occurrenceId, occurrence.occurrenceId);
      this.size.set(occurrence.occurrenceId, 1);
      this.sessionKeyById.set(occurrence.occurrenceId, occurrence.sessionCacheKey);
    }
  }

  public find(id: string): string {
    let root = id;
    while ((this.parent.get(root) ?? root) !== root) {
      root = this.parent.get(root) ?? root;
    }
    let current = id;
    while ((this.parent.get(current) ?? current) !== current) {
      const next = this.parent.get(current) ?? current;
      this.parent.set(current, root);
      current = next;
    }
    return root;
  }

  public isConflicted(id: string): boolean {
    return this.conflictRoots.has(this.find(id));
  }

  public markConflicted(ids: Iterable<string>): void {
    for (const id of ids) this.conflictRoots.add(this.find(id));
  }

  public merge(left: string, right: string): boolean {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return !this.conflictRoots.has(leftRoot);
    if (
      this.conflictRoots.has(leftRoot) ||
      this.conflictRoots.has(rightRoot) ||
      this.haveOverlappingSessions(leftRoot, rightRoot)
    ) {
      this.conflictRoots.add(leftRoot);
      this.conflictRoots.add(rightRoot);
      return false;
    }
    const leftSize = this.size.get(leftRoot) ?? 1;
    const rightSize = this.size.get(rightRoot) ?? 1;
    const keepLeft = leftSize > rightSize || (leftSize === rightSize && leftRoot.localeCompare(rightRoot) <= 0);
    const first = keepLeft ? leftRoot : rightRoot;
    const second = keepLeft ? rightRoot : leftRoot;
    this.parent.set(second, first);
    this.size.set(first, leftSize + rightSize);
    this.size.delete(second);
    this.mergeSessionKeys(first, second);
    return true;
  }

  private mergeSessionKeys(first: string, second: string): void {
    const firstSessionKey = this.sessionKeyById.get(first);
    const firstSessions = this.sessionKeysByRoot.get(first) ?? new Set(
      firstSessionKey ? [firstSessionKey] : [],
    );
    const secondSessions = this.sessionKeysByRoot.get(second);
    if (secondSessions) {
      for (const sessionKey of secondSessions) firstSessions.add(sessionKey);
    } else {
      const sessionKey = this.sessionKeyById.get(second);
      if (sessionKey) firstSessions.add(sessionKey);
    }
    this.sessionKeysByRoot.set(first, firstSessions);
    this.sessionKeysByRoot.delete(second);
  }

  private haveOverlappingSessions(leftRoot: string, rightRoot: string): boolean {
    const leftSessions = this.sessionKeysByRoot.get(leftRoot);
    const rightSessions = this.sessionKeysByRoot.get(rightRoot);
    if (!leftSessions && !rightSessions) {
      return this.sessionKeyById.get(leftRoot) === this.sessionKeyById.get(rightRoot);
    }
    if (!leftSessions) {
      const leftSession = this.sessionKeyById.get(leftRoot);
      return leftSession ? rightSessions!.has(leftSession) : false;
    }
    if (!rightSessions) {
      const rightSession = this.sessionKeyById.get(rightRoot);
      return rightSession ? leftSessions.has(rightSession) : false;
    }
    const smaller = leftSessions.size <= rightSessions.size ? leftSessions : rightSessions;
    const larger = smaller === leftSessions ? rightSessions : leftSessions;
    for (const sessionKey of smaller) {
      if (larger.has(sessionKey)) return true;
    }
    return false;
  }
}

interface OccurrenceTopology {
  roots: ClaudeGraphRecordOccurrence[];
  parentByOccurrenceId: Map<string, ClaudeGraphRecordOccurrence>;
  childrenByParentOccurrenceId: Map<string, ClaudeGraphRecordOccurrence[]>;
  depthByOccurrenceId: Map<string, number>;
}

function buildOccurrenceTopology(
  occurrences: readonly ClaudeGraphRecordOccurrence[],
  occurrenceBySessionUuid: ReadonlyMap<string, ClaudeGraphRecordOccurrence | null>,
): OccurrenceTopology {
  const roots: ClaudeGraphRecordOccurrence[] = [];
  const parentByOccurrenceId = new Map<string, ClaudeGraphRecordOccurrence>();
  const childrenByParentOccurrenceId = new Map<string, ClaudeGraphRecordOccurrence[]>();
  const depthByOccurrenceId = new Map<string, number>();
  for (const occurrence of occurrences) {
    const parentUuid = occurrence.visibleParentUuid ?? occurrence.logicalParentUuid;
    if (!parentUuid) {
      roots.push(occurrence);
      continue;
    }
    const parent = occurrenceBySessionUuid.get(buildSessionUuidKey(occurrence.sessionCacheKey, parentUuid));
    if (!parent || parent.occurrenceId === occurrence.occurrenceId) continue;
    parentByOccurrenceId.set(occurrence.occurrenceId, parent);
    const children = childrenByParentOccurrenceId.get(parent.occurrenceId) ?? [];
    children.push(occurrence);
    childrenByParentOccurrenceId.set(parent.occurrenceId, children);
  }
  const queue = [...roots];
  for (const root of roots) depthByOccurrenceId.set(root.occurrenceId, 0);
  for (let index = 0; index < queue.length; index += 1) {
    const parent = queue[index]!;
    const childDepth = (depthByOccurrenceId.get(parent.occurrenceId) ?? -1) + 1;
    for (const child of childrenByParentOccurrenceId.get(parent.occurrenceId) ?? []) {
      if (depthByOccurrenceId.has(child.occurrenceId)) continue;
      depthByOccurrenceId.set(child.occurrenceId, childDepth);
      queue.push(child);
    }
  }
  return { roots, parentByOccurrenceId, childrenByParentOccurrenceId, depthByOccurrenceId };
}

function unionEvidenceMatches(
  occurrences: readonly ClaudeGraphRecordOccurrence[],
  union: OccurrenceUnion,
  getParentContext: (occurrence: ClaudeGraphRecordOccurrence) => string,
): void {
  const matchesByKey = new Map<string, ClaudeGraphRecordOccurrence[]>();
  for (const occurrence of occurrences) {
    const parentContext = getParentContext(occurrence);
    if (!parentContext) continue;
    for (const evidence of identityEvidenceKeys(occurrence)) {
      const key = `${parentContext}\u0000${evidence}`;
      const matches = matchesByKey.get(key) ?? [];
      matches.push(occurrence);
      matchesByKey.set(key, matches);
    }
  }
  for (const matches of matchesByKey.values()) {
    mergeCrossSessionMatches(matches, union);
  }
}

function markIntrinsicRecordUuidConflicts(
  occurrences: readonly ClaudeGraphRecordOccurrence[],
  union: OccurrenceUnion,
  depthByOccurrenceId: ReadonlyMap<string, number>,
): void {
  const matchesByRecordUuid = new Map<string, ClaudeGraphRecordOccurrence[]>();
  for (const occurrence of occurrences) {
    if (!occurrence.recordUuid) continue;
    const matches = matchesByRecordUuid.get(occurrence.recordUuid) ?? [];
    matches.push(occurrence);
    matchesByRecordUuid.set(occurrence.recordUuid, matches);
  }
  for (const matches of matchesByRecordUuid.values()) {
    if (matches.length < 2) continue;
    const fingerprints = new Set(matches.map((occurrence) => occurrence.textFingerprint));
    const sessionKeys = new Set(matches.map((occurrence) => occurrence.sessionCacheKey));
    const depths = new Set(matches.map(
      (occurrence) => depthByOccurrenceId.get(occurrence.occurrenceId) ?? "unresolved",
    ));
    if (fingerprints.size > 1 || sessionKeys.size !== matches.length || depths.size > 1) {
      union.markConflicted(matches.map((occurrence) => occurrence.occurrenceId));
    }
  }
}

function markContextualRecordUuidConflicts(
  occurrences: readonly ClaudeGraphRecordOccurrence[],
  union: OccurrenceUnion,
  getParentContext: (occurrence: ClaudeGraphRecordOccurrence) => string,
): void {
  const contextsByRecordUuid = new Map<string, {
    contexts: Set<string>;
    occurrenceIds: string[];
  }>();
  for (const occurrence of occurrences) {
    if (!occurrence.recordUuid) continue;
    const match = contextsByRecordUuid.get(occurrence.recordUuid) ?? {
      contexts: new Set<string>(),
      occurrenceIds: [],
    };
    match.contexts.add(getParentContext(occurrence));
    match.occurrenceIds.push(occurrence.occurrenceId);
    contextsByRecordUuid.set(occurrence.recordUuid, match);
  }
  for (const match of contextsByRecordUuid.values()) {
    if (
      match.occurrenceIds.length > 1 &&
      (match.contexts.size > 1 || match.contexts.has(""))
    ) {
      union.markConflicted(match.occurrenceIds);
    }
  }
}

function unionSharedRootPrefixes(
  topology: OccurrenceTopology,
  union: OccurrenceUnion,
): void {
  const pairsByPrefix = new Map<string, Array<{
    root: ClaudeGraphRecordOccurrence;
    child: ClaudeGraphRecordOccurrence;
  }>>();
  for (const root of topology.roots) {
    for (const child of topology.childrenByParentOccurrenceId.get(root.occurrenceId) ?? []) {
      const key = `${structuralIdentityKey(root)}\u0000${structuralIdentityKey(child)}`;
      const pairs = pairsByPrefix.get(key) ?? [];
      pairs.push({ root, child });
      pairsByPrefix.set(key, pairs);
    }
  }
  for (const pairs of pairsByPrefix.values()) {
    if (!haveUniqueSessions(pairs.map((pair) => pair.root))) continue;
    if (pairs.some(
      (pair) => union.isConflicted(pair.root.occurrenceId) || union.isConflicted(pair.child.occurrenceId),
    )) continue;
    mergeCrossSessionMatches(pairs.map((pair) => pair.root), union);
  }
}

function unionStructuralPrefixMatches(
  occurrences: readonly ClaudeGraphRecordOccurrence[],
  union: OccurrenceUnion,
  parentByOccurrenceId: ReadonlyMap<string, ClaudeGraphRecordOccurrence>,
): void {
  const matchesByKey = new Map<string, ClaudeGraphRecordOccurrence[]>();
  for (const occurrence of occurrences) {
    const parent = parentByOccurrenceId.get(occurrence.occurrenceId);
    if (!parent || union.isConflicted(parent.occurrenceId)) continue;
    const key = `${union.find(parent.occurrenceId)}\u0000${structuralIdentityKey(occurrence)}`;
    const matches = matchesByKey.get(key) ?? [];
    matches.push(occurrence);
    matchesByKey.set(key, matches);
  }
  for (const matches of matchesByKey.values()) {
    mergeCrossSessionMatches(matches, union);
  }
}

function identityEvidenceKeys(occurrence: ClaudeGraphRecordOccurrence): string[] {
  return [
    occurrence.recordUuid ? `record\u0000${occurrence.recordUuid}\u0000${occurrence.textFingerprint}` : "",
    occurrence.promptId ? `prompt\u0000${occurrence.promptId}\u0000${occurrence.textFingerprint}` : "",
    occurrence.requestId ? `request\u0000${occurrence.requestId}\u0000${occurrence.textFingerprint}` : "",
    occurrence.timestampIso && Number.isFinite(Date.parse(occurrence.timestampIso))
      ? `time\u0000${occurrence.timestampIso}\u0000${occurrence.textFingerprint}`
      : "",
  ].filter(Boolean);
}

function structuralIdentityKey(occurrence: ClaudeGraphRecordOccurrence): string {
  return `${occurrence.type}\u0000${occurrence.textFingerprint}`;
}

function mergeCrossSessionMatches(
  matches: readonly ClaudeGraphRecordOccurrence[],
  union: OccurrenceUnion,
): boolean {
  if (!haveUniqueSessions(matches)) return false;
  let merged = true;
  for (let index = 1; index < matches.length; index += 1) {
    if (!union.merge(matches[0]!.occurrenceId, matches[index]!.occurrenceId)) merged = false;
  }
  return merged && !union.isConflicted(matches[0]!.occurrenceId);
}

function haveUniqueSessions(matches: readonly ClaudeGraphRecordOccurrence[]): boolean {
  if (matches.length < 2) return false;
  return new Set(matches.map((occurrence) => occurrence.sessionCacheKey)).size === matches.length;
}

function buildOccurrenceBySessionUuid(
  occurrences: readonly ClaudeGraphRecordOccurrence[],
): Map<string, ClaudeGraphRecordOccurrence | null> {
  const result = new Map<string, ClaudeGraphRecordOccurrence | null>();
  for (const occurrence of occurrences) {
    if (!occurrence.recordUuid) continue;
    const key = buildSessionUuidKey(occurrence.sessionCacheKey, occurrence.recordUuid);
    if (result.has(key)) {
      result.set(key, null);
    } else {
      result.set(key, occurrence);
    }
  }
  return result;
}

function resolveParents(groups: CanonicalGroup[]): void {
  const occurrences = groups.flatMap((group) => group.occurrences);
  const occurrenceBySessionUuid = buildOccurrenceBySessionUuid(occurrences);
  const groupByOccurrenceId = new Map<string, CanonicalGroup>();
  for (const group of groups) {
    for (const occurrence of group.occurrences) groupByOccurrenceId.set(occurrence.occurrenceId, group);
  }
  for (const group of groups) {
    const parents = new Set<string>();
    let rootCount = 0;
    let resolvedCount = 0;
    let invalidParent = false;
    let compact = group.compactBoundary;
    for (const occurrence of group.occurrences) {
      const parentUuid = occurrence.visibleParentUuid ?? occurrence.logicalParentUuid;
      if (!parentUuid) {
        rootCount += 1;
        continue;
      }
      if (!occurrence.visibleParentUuid && occurrence.logicalParentUuid) compact = true;
      const parentOccurrence = occurrenceBySessionUuid.get(
        buildSessionUuidKey(occurrence.sessionCacheKey, parentUuid),
      );
      const parent = parentOccurrence
        ? groupByOccurrenceId.get(parentOccurrence.occurrenceId)
        : undefined;
      if (!parent || parent === group) {
        invalidParent = true;
        continue;
      }
      resolvedCount += 1;
      parents.add(parent.id);
    }
    if (
      invalidParent ||
      (rootCount > 0 && rootCount !== group.occurrences.length) ||
      (resolvedCount > 0 && resolvedCount !== group.occurrences.length) ||
      parents.size > 1
    ) {
      group.parentId = undefined;
      group.hasConflict = true;
      group.confidence = "unresolved";
    } else if (parents.size === 1) {
      group.parentId = parents.values().next().value;
    }
    group.compactBoundary = compact;
  }
}

function markIdentityConflicts(groups: readonly CanonicalGroup[]): void {
  const groupsByRecordUuid = new Map<string, Set<CanonicalGroup>>();
  for (const group of groups) {
    for (const occurrence of group.occurrences) {
      if (!occurrence.recordUuid) continue;
      const matches = groupsByRecordUuid.get(occurrence.recordUuid) ?? new Set<CanonicalGroup>();
      matches.add(group);
      groupsByRecordUuid.set(occurrence.recordUuid, matches);
    }
  }
  for (const matches of groupsByRecordUuid.values()) {
    if (matches.size < 2) continue;
    for (const group of matches) {
      group.hasConflict = true;
      group.confidence = "unresolved";
    }
  }
}

function breakCycles(groups: CanonicalGroup[]): void {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const processed = new Set<string>();
  for (const start of groups) {
    if (processed.has(start.id)) continue;
    const path: CanonicalGroup[] = [];
    const pathIndex = new Map<string, number>();
    let current: CanonicalGroup | undefined = start;
    while (current && !processed.has(current.id)) {
      const cycleIndex = pathIndex.get(current.id);
      if (cycleIndex !== undefined) {
        let breakNode = path[cycleIndex]!;
        for (let index = cycleIndex; index < path.length; index += 1) {
          const cycleNode = path[index]!;
          cycleNode.hasConflict = true;
          cycleNode.confidence = "unresolved";
          if (cycleNode.id.localeCompare(breakNode.id) < 0) breakNode = cycleNode;
        }
        breakNode.parentId = undefined;
        break;
      }
      pathIndex.set(current.id, path.length);
      path.push(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    for (const group of path) processed.add(group.id);
  }
}

function propagateUnresolvedDescendants(groups: readonly CanonicalGroup[]): void {
  const childrenByParentId = new Map<string, CanonicalGroup[]>();
  const queue: CanonicalGroup[] = [];
  const visited = new Set<string>();
  for (const group of groups) {
    if (group.parentId) {
      const children = childrenByParentId.get(group.parentId) ?? [];
      children.push(group);
      childrenByParentId.set(group.parentId, children);
    }
    if (group.hasConflict || group.confidence === "unresolved") {
      queue.push(group);
      visited.add(group.id);
    }
  }
  for (let index = 0; index < queue.length; index += 1) {
    const parent = queue[index]!;
    for (const child of childrenByParentId.get(parent.id) ?? []) {
      if (visited.has(child.id)) continue;
      child.confidence = "unresolved";
      visited.add(child.id);
      queue.push(child);
    }
  }
}

function assignDepths(groups: CanonicalGroup[]): void {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const memo = new Map<string, number>();
  for (const start of groups) {
    if (memo.has(start.id)) continue;
    const path: CanonicalGroup[] = [];
    let current: CanonicalGroup | undefined = start;
    while (current && !memo.has(current.id)) {
      path.push(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    let depth = current ? (memo.get(current.id) ?? -1) : -1;
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const group = path[index]!;
      depth = Math.min(10_000, depth + 1);
      group.depth = depth;
      memo.set(group.id, depth);
    }
  }
}

function toViewNode(
  group: CanonicalGroup,
  laneByCacheKey: ReadonlyMap<string, ClaudeBranchLane>,
  laneById: ReadonlyMap<string, ClaudeBranchLane>,
  input: ClaudeBranchAnalysisInput,
): ClaudeBranchNode {
  const occurrenceViews: ClaudeBranchOccurrenceView[] = group.occurrences
    .map((occurrence) => {
      const lane = laneByCacheKey.get(occurrence.sessionCacheKey);
      if (!lane) return null;
      return {
        id: occurrence.occurrenceId,
        laneId: lane.id,
        chatMessageIndex: occurrence.chatMessageIndex,
        recordOrdinal: occurrence.recordOrdinal,
        ...(occurrence.timestampIso ? { timestampIso: occurrence.timestampIso } : {}),
        isBookmarked: input.isOccurrenceBookmarked?.(occurrence) ?? false,
      };
    })
    .filter((occurrence): occurrence is ClaudeBranchOccurrenceView => occurrence !== null);
  const laneIds = Array.from(new Set(occurrenceViews.map((occurrence) => occurrence.laneId))).sort(
    (left, right) => (laneById.get(left)?.order ?? 0) - (laneById.get(right)?.order ?? 0),
  );
  const first = group.occurrences[0];
  return {
    id: group.id,
    ...(group.parentId ? { parentId: group.parentId } : {}),
    depth: group.depth,
    preview: first?.preview ?? "",
    ...(first?.timestampIso ? { timestampIso: first.timestampIso } : {}),
    confidence: group.confidence,
    occurrenceCount: occurrenceViews.length,
    occurrences: occurrenceViews,
    laneIds,
    hasConflict: group.hasConflict,
    compactBoundary: group.compactBoundary,
  };
}

function buildEdges(groups: readonly CanonicalGroup[]): ClaudeBranchEdge[] {
  const groupById = new Map(groups.map((group) => [group.id, group]));
  return groups.flatMap((group) => {
    if (!group.parentId) return [];
    const parent = groupById.get(group.parentId);
    const kind =
      group.hasConflict ||
      group.confidence === "unresolved" ||
      !parent ||
      parent.hasConflict ||
      parent.confidence === "unresolved"
        ? "unresolved"
        : group.compactBoundary
          ? "compactBoundary"
          : "parent";
    return [{ id: hashId(`${group.parentId}\u0000${group.id}\u0000${kind}`), from: group.parentId, to: group.id, kind }];
  });
}

function buildSessionUuidKey(cacheKey: string, uuid: string): string {
  return `${cacheKey}\u0000${uuid}`;
}

function compareOccurrences(left: ClaudeGraphRecordOccurrence, right: ClaudeGraphRecordOccurrence): number {
  return (
    compareIso(left.timestampIso, right.timestampIso) ||
    left.sessionCacheKey.localeCompare(right.sessionCacheKey) ||
    left.recordOrdinal - right.recordOrdinal ||
    left.occurrenceId.localeCompare(right.occurrenceId)
  );
}

function compareNodes(left: ClaudeBranchNode, right: ClaudeBranchNode): number {
  return left.depth - right.depth || compareIso(left.timestampIso, right.timestampIso) || left.id.localeCompare(right.id);
}

function compareIso(left: string | undefined, right: string | undefined): number {
  // Intentionally sort missing or invalid timestamps after valid ones for chronological branch display.
  const leftMs = Date.parse(left ?? "");
  const rightMs = Date.parse(right ?? "");
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) return leftMs - rightMs;
  if (Number.isFinite(leftMs)) return -1;
  if (Number.isFinite(rightMs)) return 1;
  return String(left ?? "").localeCompare(String(right ?? ""));
}

function hashId(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
}
