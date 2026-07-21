import { createHash } from "node:crypto";
import type { HistoryService } from "../services/historyService";
import type { DebugLogger } from "../services/logger";
import type { CodexAgentMetadata, HistoryIndex, SessionSummary } from "../sessions/sessionTypes";
import {
  normalizeCodexThreadId,
  resolveCodexAgentTaskLabel,
  resolveCodexAgentTaskSortKey,
  sanitizeCachedCodexAgentMetadata,
} from "./codexAgentMetadata";
import type {
  CodexAgentComponent,
  CodexAgentComponentNode,
  CodexAgentPresentation,
  CodexAgentRelationKind,
} from "./codexAgentRunsTypes";

const MAX_COMPONENT_NODES = 500;
const MAX_DIRECT_CHILDREN = 200;
const MAX_TRAVERSAL_DEPTH = 64;

interface AgentGraph {
  index: HistoryIndex;
  indexGeneration: number;
  sessionByIdentity: Map<string, SessionSummary>;
  sessionByThreadId: Map<string, SessionSummary>;
  agentMetadataByIdentity: Map<string, CodexAgentMetadata>;
  parentByChildIdentity: Map<string, SessionSummary>;
  childrenByParentIdentity: Map<string, SessionSummary[]>;
  unavailableChildrenByParentThreadId: Map<string, SessionSummary[]>;
  droppedEdgeChildren: Set<string>;
}

interface CollectedAgentComponent {
  sessionIds: Set<string>;
  syntheticParentIds: Set<string>;
}

export class CodexAgentRunsService {
  private readonly historyService: HistoryService;
  private readonly logger?: DebugLogger;
  private graph: AgentGraph | null = null;
  private presentationEnabled = false;

  constructor(historyService: HistoryService, logger?: DebugLogger) {
    this.historyService = historyService;
    this.logger = logger;
  }

  public invalidate(): void {
    this.graph = null;
  }

  public setPresentationEnabled(enabled: boolean): void {
    this.presentationEnabled = enabled;
    if (!enabled) {
      this.invalidate();
      return;
    }
    this.activateCurrentIndex();
  }

  public isPresentationEnabled(): boolean {
    return Boolean(
      this.presentationEnabled &&
      this.graph &&
      this.graph.index === this.historyService.getIndex() &&
      this.graph.indexGeneration === this.historyService.getIndexGeneration(),
    );
  }

  public activateCurrentIndex(): boolean {
    if (!this.presentationEnabled) {
      this.invalidate();
      return false;
    }
    const index = this.historyService.getIndex();
    const indexGeneration = this.historyService.getIndexGeneration();
    const graph = buildAgentGraph(
      index,
      indexGeneration,
      (session) => this.historyService.isCodexAgentMetadataVerified(session),
      this.logger,
    );
    if (
      index !== this.historyService.getIndex() ||
      indexGeneration !== this.historyService.getIndexGeneration() ||
      !this.presentationEnabled
    ) {
      return false;
    }
    this.graph = graph;
    return true;
  }

  public isHistorySessionVisible(session: SessionSummary): boolean {
    if (!this.isPresentationEnabled()) return true;
    const graph = this.graph!;
    const current = graph.sessionByIdentity.get(session.identityKey);
    return !current || !graph.parentByChildIdentity.has(current.identityKey);
  }

  public getPresentation(session: SessionSummary, fallbackLabel: string): CodexAgentPresentation {
    if (!this.isPresentationEnabled()) {
      return {
        relation: "none",
        taskLabel: fallbackLabel,
        directChildCount: 0,
        parentUnavailable: false,
        canShowComponent: false,
      };
    }
    const graph = this.graph!;
    const current = graph.sessionByIdentity.get(session.identityKey) ?? session;
    const metadata = graph.agentMetadataByIdentity.get(current.identityKey);
    const parentSession = graph.parentByChildIdentity.get(current.identityKey);
    const directChildCount = graph.childrenByParentIdentity.get(current.identityKey)?.length ?? 0;
    const relation = resolveRelationKind(Boolean(metadata), directChildCount > 0);
    const parentUnavailable = Boolean(
      metadata &&
      !parentSession &&
      !graph.sessionByThreadId.has(metadata.parentThreadId) &&
      !graph.droppedEdgeChildren.has(current.identityKey),
    );
    return {
      relation,
      taskLabel: resolveCodexAgentTaskLabel(metadata, fallbackLabel),
      directChildCount,
      ...(parentSession ? { parentSession } : {}),
      parentUnavailable,
      canShowComponent: Boolean(parentSession || parentUnavailable || directChildCount > 0),
    };
  }

  public getParentSession(session: SessionSummary): SessionSummary | undefined {
    if (!this.isPresentationEnabled()) return undefined;
    return this.graph!.parentByChildIdentity.get(session.identityKey);
  }

  public hasRelation(session: SessionSummary): boolean {
    return this.getPresentation(session, "").relation !== "none";
  }

  public buildComponent(session: SessionSummary, fallbackLabel: string): CodexAgentComponent {
    if (!this.isPresentationEnabled()) return emptyComponent();
    const graph = this.graph!;
    const current = graph.sessionByIdentity.get(session.identityKey);
    if (!current || current.source !== "codex") return emptyComponent();

    const fullComponent = collectAgentComponent(graph, current, null);
    const displayComponent = collectAgentComponent(graph, current, MAX_TRAVERSAL_DEPTH);
    const included = displayComponent.sessionIds;
    const syntheticParentIds = displayComponent.syntheticParentIds;
    let relationPartial =
      included.size < fullComponent.sessionIds.size ||
      syntheticParentIds.size < fullComponent.syntheticParentIds.size;
    for (const identityKey of fullComponent.sessionIds) {
      if (graph.droppedEdgeChildren.has(identityKey)) {
        relationPartial = true;
        break;
      }
    }

    const fullSessionCount = fullComponent.sessionIds.size;
    const fullAgentCount = Array.from(fullComponent.sessionIds).reduce((count, identityKey) => {
      const candidate = graph.sessionByIdentity.get(identityKey);
      return count + (candidate && graph.agentMetadataByIdentity.has(candidate.identityKey) ? 1 : 0);
    }, 0);

    const ordered = orderComponentSessions(graph, included);
    const displayEligibleIds = buildDisplayEligibleIds(graph, included, current, syntheticParentIds);
    const displayOrdered = ordered.filter((candidate) => displayEligibleIds.has(candidate.identityKey));
    if (displayOrdered.length < ordered.length) relationPartial = true;
    const retainedSyntheticParentIds = Array.from(syntheticParentIds)
      .sort(compareOrdinal)
      .slice(0, MAX_COMPONENT_NODES - 1);
    const retainedSyntheticParentIdSet = new Set(retainedSyntheticParentIds);
    if (retainedSyntheticParentIds.length < syntheticParentIds.size) relationPartial = true;
    const syntheticNodeCount = retainedSyntheticParentIds.length;
    const availableNodeLimit = Math.max(1, MAX_COMPONENT_NODES - syntheticNodeCount);
    const retained = retainCurrentPath(displayOrdered, current, graph, availableNodeLimit);
    if (displayOrdered.length > availableNodeLimit) relationPartial = true;
    const retainedIds = new Set(retained.map((candidate) => candidate.identityKey));
    const nodes: CodexAgentComponentNode[] = [];

    for (const parentThreadId of retainedSyntheticParentIds) {
      const children = graph.unavailableChildrenByParentThreadId.get(parentThreadId) ?? [];
      if (!children.some((child) => retainedIds.has(child.identityKey))) continue;
      nodes.push({
        id: syntheticNodeId(parentThreadId),
        unavailableParent: true,
        isCurrent: false,
        isSubagent: false,
        taskLabel: "",
        agentRole: "",
        directChildCount: children.length,
      });
    }

    for (const candidate of retained) {
      const metadata = graph.agentMetadataByIdentity.get(candidate.identityKey);
      const parent = graph.parentByChildIdentity.get(candidate.identityKey);
      const unavailableParentId =
        metadata && !parent && !graph.sessionByThreadId.has(metadata.parentThreadId)
          ? syntheticNodeId(metadata.parentThreadId)
          : undefined;
      nodes.push({
        id: sessionNodeId(candidate.identityKey),
        ...(parent && retainedIds.has(parent.identityKey)
          ? { parentId: sessionNodeId(parent.identityKey) }
          : unavailableParentId && retainedSyntheticParentIdSet.has(metadata!.parentThreadId)
            ? { parentId: unavailableParentId }
            : {}),
        session: candidate,
        unavailableParent: false,
        isCurrent: candidate.identityKey === current.identityKey,
        isSubagent: Boolean(metadata),
        taskLabel: resolveCodexAgentTaskLabel(metadata, fallbackLabel),
        agentRole: metadata?.agentRole ?? "",
        directChildCount: graph.childrenByParentIdentity.get(candidate.identityKey)?.length ?? 0,
      });
    }

    const fullNodeCount = fullSessionCount + fullComponent.syntheticParentIds.size;
    const omittedCount = Math.max(0, fullNodeCount - nodes.length);
    return {
      sessionCount: fullSessionCount,
      agentCount: fullAgentCount,
      relationPartial: relationPartial || omittedCount > 0,
      omittedCount,
      nodes,
    };
  }

}

function collectAgentComponent(
  graph: AgentGraph,
  current: SessionSummary,
  maxDepth: number | null,
): CollectedAgentComponent {
  const sessionIds = new Set<string>();
  const syntheticParentIds = new Set<string>();
  const expandedSyntheticParentIds = new Set<string>();
  const queue: Array<{ session: SessionSummary; depth: number }> = [{ session: current, depth: 0 }];
  let queueIndex = 0;
  while (queueIndex < queue.length) {
    const next = queue[queueIndex++]!;
    if (sessionIds.has(next.session.identityKey)) continue;
    sessionIds.add(next.session.identityKey);
    if (maxDepth !== null && next.depth >= maxDepth) continue;

    const parent = graph.parentByChildIdentity.get(next.session.identityKey);
    if (parent) queue.push({ session: parent, depth: next.depth + 1 });
    for (const child of graph.childrenByParentIdentity.get(next.session.identityKey) ?? []) {
      queue.push({ session: child, depth: next.depth + 1 });
    }

    const metadata = graph.agentMetadataByIdentity.get(next.session.identityKey);
    if (!metadata || parent || graph.sessionByThreadId.has(metadata.parentThreadId)) continue;
    syntheticParentIds.add(metadata.parentThreadId);
    if (expandedSyntheticParentIds.has(metadata.parentThreadId)) continue;
    expandedSyntheticParentIds.add(metadata.parentThreadId);
    for (const sibling of graph.unavailableChildrenByParentThreadId.get(metadata.parentThreadId) ?? []) {
      queue.push({ session: sibling, depth: next.depth + 1 });
    }
  }
  return { sessionIds, syntheticParentIds };
}

function buildDisplayEligibleIds(
  graph: AgentGraph,
  included: ReadonlySet<string>,
  current: SessionSummary,
  syntheticParentIds: ReadonlySet<string>,
): Set<string> {
  const eligible = new Set<string>();
  const currentPath = new Set<string>();
  let pathCursor: SessionSummary | undefined = current;
  while (pathCursor) {
    currentPath.add(pathCursor.identityKey);
    pathCursor = graph.parentByChildIdentity.get(pathCursor.identityKey);
  }

  const visit = (session: SessionSummary): void => {
    if (eligible.has(session.identityKey) || !included.has(session.identityKey)) return;
    eligible.add(session.identityKey);
    const children = graph.childrenByParentIdentity.get(session.identityKey) ?? [];
    for (const child of selectBoundedChildren(children, currentPath)) visit(child);
  };

  for (const parentThreadId of Array.from(syntheticParentIds).sort(compareOrdinal)) {
    const siblings = (graph.unavailableChildrenByParentThreadId.get(parentThreadId) ?? [])
      .filter((candidate) => included.has(candidate.identityKey));
    for (const sibling of selectBoundedChildren(siblings, currentPath)) visit(sibling);
  }

  for (const identityKey of Array.from(included).sort(compareOrdinal)) {
    const session = graph.sessionByIdentity.get(identityKey);
    if (!session) continue;
    const parent = graph.parentByChildIdentity.get(identityKey);
    if (parent && included.has(parent.identityKey)) continue;
    const metadata = graph.agentMetadataByIdentity.get(session.identityKey);
    if (metadata && syntheticParentIds.has(metadata.parentThreadId)) continue;
    visit(session);
  }
  return eligible;
}

function selectBoundedChildren(
  children: readonly SessionSummary[],
  currentPath: ReadonlySet<string>,
): SessionSummary[] {
  if (children.length <= MAX_DIRECT_CHILDREN) return children.slice();
  const selected = children.slice(0, MAX_DIRECT_CHILDREN);
  const pathChild = children.find((child) => currentPath.has(child.identityKey));
  if (pathChild && !selected.some((child) => child.identityKey === pathChild.identityKey)) {
    selected[MAX_DIRECT_CHILDREN - 1] = pathChild;
    selected.sort(compareSessions);
  }
  return selected;
}

function buildAgentGraph(
  index: HistoryIndex,
  indexGeneration: number,
  isAgentMetadataVerified: (session: SessionSummary) => boolean,
  logger?: DebugLogger,
): AgentGraph {
  const codexSessions = index.sessions
    .filter((session) => session.source === "codex")
    .slice()
    .sort((left, right) => compareOrdinal(left.identityKey, right.identityKey));
  const sessionByIdentity = new Map(codexSessions.map((session) => [session.identityKey, session]));
  const sessionByThreadId = new Map<string, SessionSummary>();
  const agentMetadataByIdentity = new Map<string, CodexAgentMetadata>();
  for (const session of codexSessions) {
    const threadId = resolveSessionThreadId(session);
    if (threadId && !sessionByThreadId.has(threadId)) sessionByThreadId.set(threadId, session);
    if (!isAgentMetadataVerified(session)) continue;
    const metadata = sanitizeCachedCodexAgentMetadata(session.meta.codexAgent).value;
    if (metadata) agentMetadataByIdentity.set(session.identityKey, metadata);
  }

  const candidateParentByChild = new Map<string, SessionSummary>();
  const candidateChildrenByParent = new Map<string, SessionSummary[]>();
  const unavailableChildrenByParentThreadId = new Map<string, SessionSummary[]>();
  const droppedEdgeChildren = new Set<string>();

  for (const child of codexSessions) {
    const metadata = agentMetadataByIdentity.get(child.identityKey);
    if (!metadata) continue;
    const parent = sessionByThreadId.get(metadata.parentThreadId);
    if (!parent) {
      appendMapArray(unavailableChildrenByParentThreadId, metadata.parentThreadId, child);
      continue;
    }
    if (parent.identityKey === child.identityKey) {
      droppedEdgeChildren.add(child.identityKey);
      continue;
    }
    candidateParentByChild.set(child.identityKey, parent);
    appendMapArray(candidateChildrenByParent, parent.identityKey, child);
  }
  sortChildren(candidateChildrenByParent);
  sortChildren(unavailableChildrenByParentThreadId);

  const state = new Map<string, 0 | 1 | 2>();
  for (const session of codexSessions) {
    if ((state.get(session.identityKey) ?? 0) !== 0) continue;
    state.set(session.identityKey, 1);
    const stack: Array<{ session: SessionSummary; nextChildIndex: number }> = [
      { session, nextChildIndex: 0 },
    ];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const children = candidateChildrenByParent.get(frame.session.identityKey) ?? [];
      if (frame.nextChildIndex >= children.length) {
        state.set(frame.session.identityKey, 2);
        stack.pop();
        continue;
      }
      const child = children[frame.nextChildIndex++]!;
      const childState = state.get(child.identityKey) ?? 0;
      if (childState === 1) {
        candidateParentByChild.delete(child.identityKey);
        droppedEdgeChildren.add(child.identityKey);
        continue;
      }
      if (childState !== 0) continue;
      state.set(child.identityKey, 1);
      stack.push({ session: child, nextChildIndex: 0 });
    }
  }

  const parentByChildIdentity = new Map<string, SessionSummary>();
  const childrenByParentIdentity = new Map<string, SessionSummary[]>();
  for (const [childIdentity, parent] of candidateParentByChild) {
    const child = sessionByIdentity.get(childIdentity);
    if (!child || droppedEdgeChildren.has(childIdentity)) continue;
    parentByChildIdentity.set(childIdentity, parent);
    appendMapArray(childrenByParentIdentity, parent.identityKey, child);
  }
  sortChildren(childrenByParentIdentity);

  let depthMismatchCount = 0;
  for (const session of codexSessions) {
    const recordedDepth = agentMetadataByIdentity.get(session.identityKey)?.recordedDepth;
    if (recordedDepth === undefined) continue;
    const graphDepth = resolveGraphDepth(session, parentByChildIdentity, agentMetadataByIdentity);
    if (graphDepth !== null && graphDepth !== recordedDepth) depthMismatchCount += 1;
  }
  if (depthMismatchCount > 0) logger?.debug(`codexAgentRuns depthMismatch count=${depthMismatchCount}`);

  return {
    index,
    indexGeneration,
    sessionByIdentity,
    sessionByThreadId,
    agentMetadataByIdentity,
    parentByChildIdentity,
    childrenByParentIdentity,
    unavailableChildrenByParentThreadId,
    droppedEdgeChildren,
  };
}

function resolveSessionThreadId(session: SessionSummary): string {
  const metadataThreadId = normalizeCodexThreadId(session.meta.id);
  if (metadataThreadId) return metadataThreadId;
  const match = /^codex:(?:id|rollout):(.+)$/u.exec(session.identityKey);
  return normalizeCodexThreadId(match?.[1]);
}

function resolveGraphDepth(
  session: SessionSummary,
  parentByChildIdentity: ReadonlyMap<string, SessionSummary>,
  agentMetadataByIdentity: ReadonlyMap<string, CodexAgentMetadata>,
): number | null {
  let depth = 0;
  let current = session;
  const seen = new Set<string>();
  while (true) {
    if (seen.has(current.identityKey) || depth > MAX_TRAVERSAL_DEPTH) return null;
    seen.add(current.identityKey);
    const parent = parentByChildIdentity.get(current.identityKey);
    if (!parent) return agentMetadataByIdentity.has(current.identityKey) ? null : depth;
    depth += 1;
    current = parent;
  }
}

function hasAdjacentSessions(graph: AgentGraph, session: SessionSummary): boolean {
  return Boolean(
    graph.parentByChildIdentity.has(session.identityKey) ||
    (graph.childrenByParentIdentity.get(session.identityKey)?.length ?? 0) > 0,
  );
}

function orderComponentSessions(graph: AgentGraph, included: ReadonlySet<string>): SessionSummary[] {
  const roots = Array.from(included)
    .map((identityKey) => graph.sessionByIdentity.get(identityKey))
    .filter((session): session is SessionSummary => Boolean(session))
    .filter((session) => {
      const parent = graph.parentByChildIdentity.get(session.identityKey);
      return !parent || !included.has(parent.identityKey);
    })
    .sort(compareSessions);
  const ordered: SessionSummary[] = [];
  const seen = new Set<string>();
  const visit = (session: SessionSummary): void => {
    if (seen.has(session.identityKey) || !included.has(session.identityKey)) return;
    seen.add(session.identityKey);
    ordered.push(session);
    for (const child of graph.childrenByParentIdentity.get(session.identityKey) ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  for (const identityKey of Array.from(included).sort(compareOrdinal)) {
    const session = graph.sessionByIdentity.get(identityKey);
    if (session) visit(session);
  }
  return ordered;
}

function retainCurrentPath(
  ordered: readonly SessionSummary[],
  current: SessionSummary,
  graph: AgentGraph,
  limit: number,
): SessionSummary[] {
  if (ordered.length <= limit) return ordered.slice();
  const orderedIds = new Set(ordered.map((session) => session.identityKey));
  const priority = new Set<string>();
  const path: SessionSummary[] = [];
  let cursor: SessionSummary | undefined = current;
  while (cursor && orderedIds.has(cursor.identityKey)) {
    path.push(cursor);
    cursor = graph.parentByChildIdentity.get(cursor.identityKey);
  }
  path.reverse();
  for (const pathNode of path) priority.add(pathNode.identityKey);
  for (const pathNode of path) {
    const parent = graph.parentByChildIdentity.get(pathNode.identityKey);
    if (!parent) continue;
    for (const sibling of graph.childrenByParentIdentity.get(parent.identityKey) ?? []) {
      priority.add(sibling.identityKey);
    }
  }
  for (const child of graph.childrenByParentIdentity.get(current.identityKey) ?? []) {
    priority.add(child.identityKey);
  }

  const retainedIds = new Set<string>();
  for (const pathNode of path) {
    if (retainedIds.size >= limit) break;
    retainedIds.add(pathNode.identityKey);
  }
  retainedIds.add(current.identityKey);
  for (const session of ordered) {
    if (retainedIds.size >= limit) break;
    if (priority.has(session.identityKey)) retainedIds.add(session.identityKey);
  }
  for (const session of ordered) {
    if (retainedIds.size >= limit) break;
    retainedIds.add(session.identityKey);
  }
  return ordered.filter((session) => retainedIds.has(session.identityKey));
}

function sortChildren(map: Map<string, SessionSummary[]>): void {
  for (const children of map.values()) children.sort(compareSessions);
}

function compareSessions(left: SessionSummary, right: SessionSummary): number {
  const leftTimestamp = Date.parse(left.startedAtIso ?? "");
  const rightTimestamp = Date.parse(right.startedAtIso ?? "");
  const leftValid = Number.isFinite(leftTimestamp);
  const rightValid = Number.isFinite(rightTimestamp);
  if (leftValid && rightValid && leftTimestamp !== rightTimestamp) return leftTimestamp - rightTimestamp;
  if (leftValid !== rightValid) return leftValid ? -1 : 1;
  const dateCompare = compareOrdinal(
    `${left.startedLocalDate}\u0000${left.startedTimeLabel}`,
    `${right.startedLocalDate}\u0000${right.startedTimeLabel}`,
  );
  if (dateCompare !== 0) return dateCompare;
  const taskCompare = compareOptionalSortKey(
    resolveCodexAgentTaskSortKey(left.meta.codexAgent),
    resolveCodexAgentTaskSortKey(right.meta.codexAgent),
  );
  return taskCompare !== 0 ? taskCompare : compareOrdinal(left.identityKey, right.identityKey);
}

function compareOptionalSortKey(left: string, right: string): number {
  if (left && right) return compareOrdinal(left, right);
  if (left !== right) return left ? -1 : 1;
  return 0;
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function appendMapArray<TKey>(map: Map<TKey, SessionSummary[]>, key: TKey, value: SessionSummary): void {
  const current = map.get(key);
  if (current) current.push(value);
  else map.set(key, [value]);
}

function resolveRelationKind(isChild: boolean, isParent: boolean): CodexAgentRelationKind {
  if (isChild && isParent) return "both";
  if (isChild) return "child";
  if (isParent) return "parent";
  return "none";
}

function sessionNodeId(identityKey: string): string {
  return `session:${stableOpaqueId(identityKey)}`;
}

function syntheticNodeId(parentThreadId: string): string {
  return `missing:${stableOpaqueId(parentThreadId)}`;
}

function stableOpaqueId(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
}

function emptyComponent(): CodexAgentComponent {
  return { sessionCount: 0, agentCount: 0, relationPartial: false, omittedCount: 0, nodes: [] };
}
