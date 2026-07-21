import * as path from "node:path";
import { sanitizeCachedCodexAgentMetadata } from "../agents/codexAgentMetadata";
import type { ChatAttachment, ChatMessageItem, ChatTimelineItem } from "../chat/chatTypes";
import type { SessionSummary } from "../sessions/sessionTypes";
import { stableTextSha256 } from "../utils/stableTextHash";
import { sanitizeCachedCodexForkMetadata, normalizeCodexForkThreadId } from "./codexForkMetadata";
import type {
  CodexForkBranchAnchor,
  CodexForkComponent,
  CodexForkEdgeStatus,
  CodexForkMessageAnchor,
  CodexForkMessageEvidence,
  CodexForkRelationBuildInput,
  CodexForkRelationEdge,
  CodexForkRelationNode,
  CodexForkSessionEvidence,
} from "./codexForkRelationTypes";

const MAX_COMPONENT_NODES = 500;
const MAX_TRAVERSAL_DEPTH = 64;
const MAX_MESSAGE_EVIDENCE = 100_000;
const MAX_PATH_LENGTH = 32_768;
const MAX_TIMESTAMP_LENGTH = 128;
const MAX_PREVIEW_LENGTH = 180;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

interface MutableForkEdge {
  child: SessionSummary;
  parentThreadId: string;
  status: CodexForkEdgeStatus;
  parent?: SessionSummary;
}

interface ForkGraph {
  sessionsByIdentity: Map<string, SessionSummary>;
  sessionByCacheKey: Map<string, SessionSummary>;
  edgeByChildIdentity: Map<string, MutableForkEdge>;
  parentByChildIdentity: Map<string, SessionSummary>;
  childrenByParentIdentity: Map<string, SessionSummary[]>;
  missingChildrenBySyntheticKey: Map<string, SessionSummary[]>;
  syntheticKeyByChildIdentity: Map<string, string>;
}

interface CollectedComponent {
  sessionIds: Set<string>;
  distanceByIdentity: Map<string, number>;
  syntheticKeys: Set<string>;
}

interface BranchAnchorResult {
  anchor?: CodexForkBranchAnchor;
  incomplete: boolean;
}

export class CodexForkRelationService {
  public build(input: CodexForkRelationBuildInput): CodexForkComponent {
    const graph = buildForkGraph(input.sessions);
    const current = graph.sessionByCacheKey.get(input.currentSessionCacheKey);
    if (!current || current.source !== "codex") return emptyComponent();

    const component = collectComponent(graph, current);
    const eligibleSessionIds = new Set(
      Array.from(component.sessionIds).filter(
        (identityKey) => (component.distanceByIdentity.get(identityKey) ?? Number.POSITIVE_INFINITY) <= MAX_TRAVERSAL_DEPTH,
      ),
    );
    eligibleSessionIds.add(current.identityKey);

    const ordered = orderComponentSessions(graph, eligibleSessionIds);
    const eligibleSyntheticKeys = new Set(
      Array.from(component.syntheticKeys).filter((syntheticKey) =>
        (graph.missingChildrenBySyntheticKey.get(syntheticKey) ?? []).some(
          (session) => eligibleSessionIds.has(session.identityKey),
        ),
      ),
    );
    const availableSessionSlots = Math.max(1, MAX_COMPONENT_NODES - eligibleSyntheticKeys.size);
    const retained = retainPrioritySessions(ordered, current, graph, availableSessionSlots);
    const retainedIds = new Set(retained.map((session) => session.identityKey));
    const retainedSyntheticKeys = new Set(
      Array.from(eligibleSyntheticKeys).filter((syntheticKey) =>
        (graph.missingChildrenBySyntheticKey.get(syntheticKey) ?? []).some(
          (session) => retainedIds.has(session.identityKey),
        ),
      ),
    );
    const nodes = buildNodes(graph, retained, retainedIds, retainedSyntheticKeys, current);
    const edges = buildComponentEdges(
      graph,
      retained,
      retainedIds,
      retainedSyntheticKeys,
      input.evidenceByIdentityKey,
    );

    const fullNodeCount = component.sessionIds.size + component.syntheticKeys.size;
    const omittedCount = Math.max(0, fullNodeCount - nodes.length);
    const resolvedForkCount = Array.from(component.sessionIds).reduce((count, identityKey) => {
      const parent = graph.parentByChildIdentity.get(identityKey);
      return count + (parent && component.sessionIds.has(parent.identityKey) ? 1 : 0);
    }, 0);
    const unavailableParentCount = countEdgeStatus(graph, component.sessionIds, "parentUnavailable");
    const ambiguousParentCount = countEdgeStatus(graph, component.sessionIds, "ambiguousParent");
    const scopeMismatchCount = countEdgeStatus(graph, component.sessionIds, "scopeMismatch");
    const cycleDroppedCount = countEdgeStatus(graph, component.sessionIds, "cycleDropped");
    const anchorIncompleteCount = edges.filter(
      (edge) => edge.status === "resolved" && edge.anchorIncomplete,
    ).length;
    const relationPartial =
      omittedCount > 0 ||
      unavailableParentCount > 0 ||
      ambiguousParentCount > 0 ||
      scopeMismatchCount > 0 ||
      cycleDroppedCount > 0 ||
      anchorIncompleteCount > 0;

    return {
      sessionCount: component.sessionIds.size,
      forkCount: resolvedForkCount,
      hasSupportedRelation: resolvedForkCount > 0,
      relationPartial,
      omittedCount,
      unavailableParentCount,
      ambiguousParentCount,
      scopeMismatchCount,
      cycleDroppedCount,
      anchorIncompleteCount,
      nodes,
      edges,
    };
  }
}

export function buildCodexForkSessionEvidence(
  items: readonly ChatTimelineItem[],
): CodexForkSessionEvidence {
  const messages: CodexForkMessageEvidence[] = [];
  let eligibleCount = 0;
  for (const item of items) {
    if (!isVisibleMessage(item)) continue;
    eligibleCount += 1;
    if (messages.length >= MAX_MESSAGE_EVIDENCE) continue;
    const stableItemId =
      sanitizeStableItemId((item as ChatMessageItem & { sourceItemId?: unknown }).sourceItemId) ||
      sanitizeStableItemId(item.turnId);
    messages.push({
      role: item.role,
      chatMessageIndex: item.messageIndex,
      fingerprint: fingerprintMessage(item),
      ...(stableItemId ? { stableItemId } : {}),
      ...optionalTimestamp(item.timestampIso),
      ...optionalPreview(item.requestText ?? item.text, item.attachments),
    });
  }
  return {
    messages,
    truncated: eligibleCount > messages.length,
  };
}

export function buildCodexForkBranchAnchor(
  parentEvidence: CodexForkSessionEvidence | undefined,
  childEvidence: CodexForkSessionEvidence | undefined,
): BranchAnchorResult {
  if (!parentEvidence || !childEvidence) return { incomplete: true };
  const parentMessages = parentEvidence.messages;
  const childMessages = childEvidence.messages;
  const comparableLength = Math.min(parentMessages.length, childMessages.length);
  let commonMessageCount = 0;
  while (
    commonMessageCount < comparableLength &&
    messagesMatch(parentMessages[commonMessageCount]!, childMessages[commonMessageCount]!)
  ) {
    commonMessageCount += 1;
  }
  if (commonMessageCount === 0) return { incomplete: true };

  const divergedBeforeBoundary = commonMessageCount < comparableLength;
  if (!divergedBeforeBoundary && (parentEvidence.truncated || childEvidence.truncated)) {
    return { incomplete: true };
  }

  const parent = parentMessages[commonMessageCount - 1]!;
  const child = childMessages[commonMessageCount - 1]!;
  return {
    incomplete: false,
    anchor: {
      commonMessageCount,
      parent: toAnchor(parent),
      child: toAnchor(child),
      ...(parentMessages[commonMessageCount]
        ? { parentContinuation: toAnchor(parentMessages[commonMessageCount]!) }
        : {}),
      ...(childMessages[commonMessageCount]
        ? { childBranchStart: toAnchor(childMessages[commonMessageCount]!) }
        : {}),
    },
  };
}

function buildForkGraph(sessions: readonly SessionSummary[]): ForkGraph {
  const codexSessions = sessions
    .filter((session) => {
      if (session.source !== "codex") return false;
      const agentMetadata = sanitizeCachedCodexAgentMetadata(session.meta.codexAgent);
      return agentMetadata.valid && !agentMetadata.value;
    })
    .slice()
    .sort(compareSessions);
  const sessionsByIdentity = new Map(codexSessions.map((session) => [session.identityKey, session]));
  const sessionByCacheKey = new Map(codexSessions.map((session) => [session.cacheKey, session]));
  const sessionsByThreadId = new Map<string, SessionSummary[]>();
  for (const session of codexSessions) {
    const threadId = normalizeCodexForkThreadId(session.meta.id);
    if (!threadId) continue;
    appendMapArray(sessionsByThreadId, threadId, session);
  }

  const edgeByChildIdentity = new Map<string, MutableForkEdge>();
  const candidateParentByChildIdentity = new Map<string, SessionSummary>();
  const candidateChildrenByParentIdentity = new Map<string, SessionSummary[]>();
  for (const child of codexSessions) {
    const metadata = sanitizeCachedCodexForkMetadata(child.meta.codexFork).value;
    if (!metadata) continue;
    const parentThreadId = metadata.parentThreadId;
    const parents = sessionsByThreadId.get(parentThreadId) ?? [];
    if (parents.length === 0) {
      edgeByChildIdentity.set(child.identityKey, {
        child,
        parentThreadId,
        status: "parentUnavailable",
      });
      continue;
    }
    if (parents.length !== 1) {
      edgeByChildIdentity.set(child.identityKey, {
        child,
        parentThreadId,
        status: "ambiguousParent",
      });
      continue;
    }
    const parent = parents[0]!;
    if (parent.identityKey === child.identityKey) {
      edgeByChildIdentity.set(child.identityKey, {
        child,
        parentThreadId,
        status: "cycleDropped",
      });
      continue;
    }
    if (!haveSameLocalForkScope(parent, child)) {
      edgeByChildIdentity.set(child.identityKey, {
        child,
        parentThreadId,
        parent,
        status: "scopeMismatch",
      });
      continue;
    }
    edgeByChildIdentity.set(child.identityKey, {
      child,
      parentThreadId,
      parent,
      status: "resolved",
    });
    candidateParentByChildIdentity.set(child.identityKey, parent);
    appendMapArray(candidateChildrenByParentIdentity, parent.identityKey, child);
  }
  sortSessionArrays(candidateChildrenByParentIdentity);
  breakCandidateCycles(
    codexSessions,
    edgeByChildIdentity,
    candidateParentByChildIdentity,
    candidateChildrenByParentIdentity,
  );

  const parentByChildIdentity = new Map<string, SessionSummary>();
  const childrenByParentIdentity = new Map<string, SessionSummary[]>();
  for (const [childIdentityKey, parent] of candidateParentByChildIdentity) {
    const edge = edgeByChildIdentity.get(childIdentityKey);
    const child = sessionsByIdentity.get(childIdentityKey);
    if (!edge || edge.status !== "resolved" || !child) continue;
    parentByChildIdentity.set(childIdentityKey, parent);
    appendMapArray(childrenByParentIdentity, parent.identityKey, child);
  }
  sortSessionArrays(childrenByParentIdentity);

  const missingChildrenBySyntheticKey = new Map<string, SessionSummary[]>();
  const syntheticKeyByChildIdentity = new Map<string, string>();
  for (const edge of edgeByChildIdentity.values()) {
    if (edge.status !== "parentUnavailable") continue;
    const key = buildMissingParentKey(edge.parentThreadId, edge.child);
    syntheticKeyByChildIdentity.set(edge.child.identityKey, key);
    appendMapArray(missingChildrenBySyntheticKey, key, edge.child);
  }
  sortSessionArrays(missingChildrenBySyntheticKey);

  return {
    sessionsByIdentity,
    sessionByCacheKey,
    edgeByChildIdentity,
    parentByChildIdentity,
    childrenByParentIdentity,
    missingChildrenBySyntheticKey,
    syntheticKeyByChildIdentity,
  };
}

function breakCandidateCycles(
  sessions: readonly SessionSummary[],
  edgeByChildIdentity: Map<string, MutableForkEdge>,
  parentByChildIdentity: Map<string, SessionSummary>,
  childrenByParentIdentity: ReadonlyMap<string, readonly SessionSummary[]>,
): void {
  const state = new Map<string, 0 | 1 | 2>();
  for (const session of sessions) {
    if ((state.get(session.identityKey) ?? 0) !== 0) continue;
    state.set(session.identityKey, 1);
    const stack: Array<{ session: SessionSummary; nextChildIndex: number }> = [
      { session, nextChildIndex: 0 },
    ];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const children = childrenByParentIdentity.get(frame.session.identityKey) ?? [];
      if (frame.nextChildIndex >= children.length) {
        state.set(frame.session.identityKey, 2);
        stack.pop();
        continue;
      }
      const child = children[frame.nextChildIndex++]!;
      const childState = state.get(child.identityKey) ?? 0;
      if (childState === 1) {
        parentByChildIdentity.delete(child.identityKey);
        const edge = edgeByChildIdentity.get(child.identityKey);
        if (edge) {
          edge.status = "cycleDropped";
          edge.parent = undefined;
        }
        continue;
      }
      if (childState !== 0) continue;
      state.set(child.identityKey, 1);
      stack.push({ session: child, nextChildIndex: 0 });
    }
  }
}

function collectComponent(graph: ForkGraph, current: SessionSummary): CollectedComponent {
  const sessionIds = new Set<string>();
  const distanceByIdentity = new Map<string, number>();
  const syntheticKeys = new Set<string>();
  const expandedSyntheticKeys = new Set<string>();
  const queue: Array<{ session: SessionSummary; distance: number }> = [
    { session: current, distance: 0 },
  ];
  for (let index = 0; index < queue.length; index += 1) {
    const next = queue[index]!;
    const previousDistance = distanceByIdentity.get(next.session.identityKey);
    if (previousDistance !== undefined && previousDistance <= next.distance) continue;
    distanceByIdentity.set(next.session.identityKey, next.distance);
    sessionIds.add(next.session.identityKey);

    const parent = graph.parentByChildIdentity.get(next.session.identityKey);
    if (parent) queue.push({ session: parent, distance: next.distance + 1 });
    for (const child of graph.childrenByParentIdentity.get(next.session.identityKey) ?? []) {
      queue.push({ session: child, distance: next.distance + 1 });
    }

    const syntheticKey = graph.syntheticKeyByChildIdentity.get(next.session.identityKey);
    if (!syntheticKey) continue;
    syntheticKeys.add(syntheticKey);
    if (expandedSyntheticKeys.has(syntheticKey)) continue;
    expandedSyntheticKeys.add(syntheticKey);
    for (const sibling of graph.missingChildrenBySyntheticKey.get(syntheticKey) ?? []) {
      queue.push({ session: sibling, distance: next.distance + 1 });
    }
  }
  return { sessionIds, distanceByIdentity, syntheticKeys };
}

function orderComponentSessions(
  graph: ForkGraph,
  included: ReadonlySet<string>,
): SessionSummary[] {
  const ordered: SessionSummary[] = [];
  const seen = new Set<string>();
  const visit = (root: SessionSummary): void => {
    const stack: SessionSummary[] = [root];
    while (stack.length > 0) {
      const session = stack.pop()!;
      if (seen.has(session.identityKey) || !included.has(session.identityKey)) continue;
      seen.add(session.identityKey);
      ordered.push(session);
      const children = (graph.childrenByParentIdentity.get(session.identityKey) ?? [])
        .filter((child) => included.has(child.identityKey));
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push(children[index]!);
      }
    }
  };

  const syntheticRoots = Array.from(new Set(
    Array.from(included)
      .map((identityKey) => graph.syntheticKeyByChildIdentity.get(identityKey))
      .filter((key): key is string => Boolean(key)),
  )).sort(compareOrdinal);
  for (const syntheticKey of syntheticRoots) {
    for (const child of graph.missingChildrenBySyntheticKey.get(syntheticKey) ?? []) {
      if (included.has(child.identityKey)) visit(child);
    }
  }

  const roots = Array.from(included)
    .map((identityKey) => graph.sessionsByIdentity.get(identityKey))
    .filter((session): session is SessionSummary => Boolean(session))
    .filter((session) => {
      if (graph.syntheticKeyByChildIdentity.has(session.identityKey)) return false;
      const parent = graph.parentByChildIdentity.get(session.identityKey);
      return !parent || !included.has(parent.identityKey);
    })
    .sort(compareSessions);
  for (const root of roots) visit(root);
  for (const identityKey of Array.from(included).sort(compareOrdinal)) {
    const session = graph.sessionsByIdentity.get(identityKey);
    if (session) visit(session);
  }
  return ordered;
}

function retainPrioritySessions(
  ordered: readonly SessionSummary[],
  current: SessionSummary,
  graph: ForkGraph,
  limit: number,
): SessionSummary[] {
  if (ordered.length <= limit) return ordered.slice();
  const eligibleIds = new Set(ordered.map((session) => session.identityKey));
  const priorityIds = new Set<string>();
  let cursor: SessionSummary | undefined = current;
  let depth = 0;
  while (cursor && eligibleIds.has(cursor.identityKey) && depth <= MAX_TRAVERSAL_DEPTH) {
    priorityIds.add(cursor.identityKey);
    cursor = graph.parentByChildIdentity.get(cursor.identityKey);
    depth += 1;
  }
  const parent = graph.parentByChildIdentity.get(current.identityKey);
  if (parent) {
    for (const sibling of graph.childrenByParentIdentity.get(parent.identityKey) ?? []) {
      if (eligibleIds.has(sibling.identityKey)) priorityIds.add(sibling.identityKey);
    }
  }
  for (const child of graph.childrenByParentIdentity.get(current.identityKey) ?? []) {
    if (eligibleIds.has(child.identityKey)) priorityIds.add(child.identityKey);
  }

  const retainedIds = new Set<string>([current.identityKey]);
  for (const session of ordered) {
    if (retainedIds.size >= limit) break;
    if (priorityIds.has(session.identityKey)) retainedIds.add(session.identityKey);
  }
  for (const session of ordered) {
    if (retainedIds.size >= limit) break;
    retainedIds.add(session.identityKey);
  }
  return ordered.filter((session) => retainedIds.has(session.identityKey)).slice(0, limit);
}

function buildNodes(
  graph: ForkGraph,
  retained: readonly SessionSummary[],
  retainedIds: ReadonlySet<string>,
  retainedSyntheticKeys: ReadonlySet<string>,
  current: SessionSummary,
): CodexForkRelationNode[] {
  const depthByIdentity = buildDepths(graph, retained, retainedIds, retainedSyntheticKeys);
  const nodes: CodexForkRelationNode[] = [];
  for (const syntheticKey of Array.from(retainedSyntheticKeys).sort(compareOrdinal)) {
    nodes.push({
      id: syntheticNodeId(syntheticKey),
      depth: 0,
      isCurrent: false,
      unavailableParent: true,
      directChildCount: graph.missingChildrenBySyntheticKey.get(syntheticKey)?.length ?? 0,
    });
  }
  for (const session of retained) {
    const parent = graph.parentByChildIdentity.get(session.identityKey);
    const syntheticKey = graph.syntheticKeyByChildIdentity.get(session.identityKey);
    nodes.push({
      id: sessionNodeId(session.identityKey),
      ...(parent && retainedIds.has(parent.identityKey)
        ? { parentId: sessionNodeId(parent.identityKey) }
        : syntheticKey && retainedSyntheticKeys.has(syntheticKey)
          ? { parentId: syntheticNodeId(syntheticKey) }
          : {}),
      session,
      depth: depthByIdentity.get(session.identityKey) ?? 0,
      isCurrent: session.identityKey === current.identityKey,
      unavailableParent: false,
      directChildCount: graph.childrenByParentIdentity.get(session.identityKey)?.length ?? 0,
    });
  }
  return nodes;
}

function buildDepths(
  graph: ForkGraph,
  retained: readonly SessionSummary[],
  retainedIds: ReadonlySet<string>,
  retainedSyntheticKeys: ReadonlySet<string>,
): Map<string, number> {
  const result = new Map<string, number>();
  const queue: Array<{ session: SessionSummary; depth: number }> = [];
  for (const syntheticKey of retainedSyntheticKeys) {
    for (const child of graph.missingChildrenBySyntheticKey.get(syntheticKey) ?? []) {
      if (retainedIds.has(child.identityKey)) queue.push({ session: child, depth: 1 });
    }
  }
  for (const session of retained) {
    const parent = graph.parentByChildIdentity.get(session.identityKey);
    const syntheticKey = graph.syntheticKeyByChildIdentity.get(session.identityKey);
    if (
      (!parent || !retainedIds.has(parent.identityKey)) &&
      (!syntheticKey || !retainedSyntheticKeys.has(syntheticKey))
    ) {
      queue.push({ session, depth: 0 });
    }
  }
  for (let index = 0; index < queue.length; index += 1) {
    const next = queue[index]!;
    if (result.has(next.session.identityKey)) continue;
    result.set(next.session.identityKey, next.depth);
    for (const child of graph.childrenByParentIdentity.get(next.session.identityKey) ?? []) {
      if (retainedIds.has(child.identityKey)) {
        queue.push({ session: child, depth: Math.min(MAX_TRAVERSAL_DEPTH, next.depth + 1) });
      }
    }
  }
  return result;
}

function buildComponentEdges(
  graph: ForkGraph,
  retained: readonly SessionSummary[],
  retainedIds: ReadonlySet<string>,
  retainedSyntheticKeys: ReadonlySet<string>,
  evidenceByIdentityKey: ReadonlyMap<string, CodexForkSessionEvidence> | undefined,
): CodexForkRelationEdge[] {
  const result: CodexForkRelationEdge[] = [];
  for (const child of retained) {
    const edge = graph.edgeByChildIdentity.get(child.identityKey);
    if (!edge) continue;
    if (edge.status === "resolved") {
      const parent = edge.parent;
      if (!parent || !retainedIds.has(parent.identityKey)) continue;
      const anchor = buildCodexForkBranchAnchor(
        evidenceByIdentityKey?.get(parent.identityKey),
        evidenceByIdentityKey?.get(child.identityKey),
      );
      result.push({
        childIdentityKey: child.identityKey,
        parentThreadId: edge.parentThreadId,
        status: "resolved",
        parentIdentityKey: parent.identityKey,
        ...(anchor.anchor ? { anchor: anchor.anchor } : {}),
        anchorIncomplete: anchor.incomplete,
      });
      continue;
    }
    if (edge.status === "parentUnavailable") {
      const syntheticKey = graph.syntheticKeyByChildIdentity.get(child.identityKey);
      if (!syntheticKey || !retainedSyntheticKeys.has(syntheticKey)) continue;
    }
    result.push({
      childIdentityKey: child.identityKey,
      parentThreadId: edge.parentThreadId,
      status: edge.status,
      anchorIncomplete: true,
    });
  }
  return result;
}

function countEdgeStatus(
  graph: ForkGraph,
  sessionIds: ReadonlySet<string>,
  status: CodexForkEdgeStatus,
): number {
  let count = 0;
  for (const identityKey of sessionIds) {
    if (graph.edgeByChildIdentity.get(identityKey)?.status === status) count += 1;
  }
  return count;
}

function haveSameLocalForkScope(parent: SessionSummary, child: SessionSummary): boolean {
  const parentCwd = normalizeCwd(parent.meta.cwd);
  const childCwd = normalizeCwd(child.meta.cwd);
  return Boolean(parentCwd && childCwd && parentCwd === childCwd);
}

function normalizeCwd(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > MAX_PATH_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(trimmed) ||
    !path.isAbsolute(trimmed)
  ) {
    return "";
  }
  try {
    const normalized = path.resolve(trimmed).normalize("NFC");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  } catch {
    return "";
  }
}

function buildMissingParentKey(parentThreadId: string, child: SessionSummary): string {
  const cwd = normalizeCwd(child.meta.cwd);
  return `${parentThreadId}\u0000${cwd || child.identityKey}`;
}

function isVisibleMessage(item: ChatTimelineItem): item is ChatMessageItem & {
  role: "user" | "assistant";
  messageIndex: number;
} {
  return item.type === "message" &&
    (item.role === "user" || item.role === "assistant") &&
    item.isContext !== true &&
    typeof item.messageIndex === "number" &&
    Number.isSafeInteger(item.messageIndex) &&
    item.messageIndex >= 1;
}

function fingerprintMessage(item: ChatMessageItem): string {
  return stableTextSha256(JSON.stringify([
    item.role,
    normalizeMessageText(item.requestText ?? item.text),
    serializeAttachments(item.attachments),
  ]));
}

function normalizeMessageText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .trim();
}

function serializeAttachments(attachments: readonly ChatAttachment[] | undefined): string {
  if (!attachments || attachments.length === 0) return "";
  return JSON.stringify(attachments.map((attachment) => {
    const { id: _id, ...stable } = attachment;
    return stableTextSha256(JSON.stringify(stable));
  }));
}

function optionalTimestamp(value: unknown): { timestampIso?: string } {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_TIMESTAMP_LENGTH ||
    value.trim().length === 0 ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return {};
  }
  return { timestampIso: value };
}

function optionalPreview(
  text: unknown,
  attachments: readonly ChatAttachment[] | undefined,
): { preview?: string } {
  const preview = normalizeMessageText(text)
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .slice(0, MAX_PREVIEW_LENGTH);
  if (preview) return { preview };
  const attachmentTypes = attachments?.map((attachment) => attachment.type).join(", ") ?? "";
  return attachmentTypes ? { preview: attachmentTypes.slice(0, MAX_PREVIEW_LENGTH) } : {};
}

function sanitizeStableItemId(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  if (!normalized || normalized.length > 1_024 || CONTROL_CHARACTER_PATTERN.test(normalized)) return "";
  return normalized;
}

function messagesMatch(
  parent: CodexForkMessageEvidence,
  child: CodexForkMessageEvidence,
): boolean {
  if (parent.role !== child.role || parent.fingerprint !== child.fingerprint) return false;
  if (parent.stableItemId && child.stableItemId) return parent.stableItemId === child.stableItemId;
  return true;
}

function toAnchor(evidence: CodexForkMessageEvidence): CodexForkMessageAnchor {
  return {
    role: evidence.role,
    chatMessageIndex: evidence.chatMessageIndex,
    ...(evidence.timestampIso ? { timestampIso: evidence.timestampIso } : {}),
    ...(evidence.preview ? { preview: evidence.preview } : {}),
  };
}

function sortSessionArrays<TKey>(map: Map<TKey, SessionSummary[]>): void {
  for (const sessions of map.values()) sessions.sort(compareSessions);
}

function appendMapArray<TKey>(map: Map<TKey, SessionSummary[]>, key: TKey, value: SessionSummary): void {
  const current = map.get(key);
  if (current) current.push(value);
  else map.set(key, [value]);
}

function compareSessions(left: SessionSummary, right: SessionSummary): number {
  const leftTime = Date.parse(left.startedAtIso ?? "");
  const rightTime = Date.parse(right.startedAtIso ?? "");
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) {
    return Number.isFinite(leftTime) ? -1 : 1;
  }
  return compareOrdinal(left.identityKey, right.identityKey);
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sessionNodeId(identityKey: string): string {
  return `session:${opaqueId(identityKey)}`;
}

function syntheticNodeId(syntheticKey: string): string {
  return `missing:${opaqueId(syntheticKey)}`;
}

function opaqueId(value: string): string {
  return stableTextSha256(value).slice(0, 24);
}

function emptyComponent(): CodexForkComponent {
  return {
    sessionCount: 0,
    forkCount: 0,
    hasSupportedRelation: false,
    relationPartial: false,
    omittedCount: 0,
    unavailableParentCount: 0,
    ambiguousParentCount: 0,
    scopeMismatchCount: 0,
    cycleDroppedCount: 0,
    anchorIncompleteCount: 0,
    nodes: [],
    edges: [],
  };
}
