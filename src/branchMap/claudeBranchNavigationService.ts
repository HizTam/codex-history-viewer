import * as path from "node:path";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { ClaudeBranchAnalysisService } from "../analysis/claudeBranchAnalysisService";
import type { AnalysisCancellationToken } from "../analysis/sessionAnalysisIndexService";
import { SessionAnalysisIndexService } from "../analysis/sessionAnalysisIndexService";
import type {
  ClaudeGraphRecordOccurrence,
  ClaudeVisibleMessageAnchor,
  SessionAnalysisEntry,
  SessionAnalysisProgress,
} from "../analysis/sessionAnalysisTypes";
import { buildBookmarkKey, type BookmarkStore } from "../services/bookmarkStore";
import type { HistoryService } from "../services/historyService";
import type { SessionAnnotationStore } from "../services/sessionAnnotationStore";
import type { SessionSummary } from "../sessions/sessionTypes";
import { getConfig } from "../settings";
import { normalizeCacheKey } from "../utils/fsUtils";
import type {
  ClaudeBranchCommonRange,
  ClaudeBranchGroup,
  ClaudeBranchMapModel,
  ClaudeBranchMessageAnchor,
  ClaudeBranchNode,
  ClaudeBranchOccurrenceOption,
  ClaudeBranchOverlayGroup,
  ClaudeBranchOverlayPageModel,
  ClaudeChatBranchChoice,
  ClaudeChatBranchGroup,
  ClaudeChatBranchNavigationModel,
} from "./claudeBranchMapTypes";

const MAX_SNAPSHOTS = 12;
const MAX_CACHED_NODES = 50_000;
const MAX_CACHED_OCCURRENCES = 500_000;
const MAX_CHAT_BRANCH_GROUPS = 500;
const MAX_CONTROL_CHOICES = 20;
const MAX_CONTROL_OCCURRENCES = 20;
const INITIAL_GROUP_PAGE_SIZE = 2;
const GROUP_PAGE_SIZE = 2;
const INITIAL_CHOICE_PAGE_SIZE = 20;
const CHOICE_PAGE_SIZE = 20;
const BRANCH_RELATION_ALGORITHM_VERSION = 3;

export interface ClaudeBranchNavigationSnapshot {
  baseSessionCacheKey: string;
  folderKey: string;
  fingerprint: string;
  cursorSalt: string;
  sessions: readonly SessionSummary[];
  model: ClaudeBranchMapModel;
  entryByCacheKey: ReadonlyMap<string, SessionAnalysisEntry>;
  occurrenceById: ReadonlyMap<string, ClaudeGraphRecordOccurrence>;
  navigableOccurrenceIds: ReadonlySet<string>;
  laneIdBySessionCacheKey: ReadonlyMap<string, string>;
}

export interface LoadClaudeBranchNavigationOptions {
  token?: AnalysisCancellationToken;
  onProgress?: (progress: SessionAnalysisProgress) => void;
  onStoredSnapshot?: (snapshot: ClaudeBranchNavigationSnapshot) => void;
}

export interface ClaudeBranchOverlayPageOptions {
  cursor?: string;
  focusGroupId?: string;
  activeChatMessageIndex?: number;
}

interface CachedSnapshot {
  snapshot: ClaudeBranchNavigationSnapshot;
  lastUsed: number;
}

interface ClaudeLineageComponent {
  groups: ClaudeBranchGroup[];
  sessionCacheKeys: ReadonlySet<string>;
}

interface ClaudeBranchSnapshotLookup {
  nodeById: ReadonlyMap<string, ClaudeBranchMapModel["nodes"][number]>;
  laneById: ReadonlyMap<string, ClaudeBranchMapModel["lanes"][number]>;
  sessionTitleByCacheKey: ReadonlyMap<string, string>;
}

const snapshotLookupCache = new WeakMap<ClaudeBranchNavigationSnapshot, ClaudeBranchSnapshotLookup>();

export class ClaudeBranchNavigationService {
  private readonly branchAnalysis = new ClaudeBranchAnalysisService();
  private readonly snapshotByKey = new Map<string, CachedSnapshot>();

  constructor(
    private readonly historyService: HistoryService,
    private readonly analysisIndex: SessionAnalysisIndexService,
    private readonly bookmarkStore: BookmarkStore,
    private readonly annotationStore: SessionAnnotationStore,
  ) {}

  public clearSnapshots(): void {
    this.snapshotByKey.clear();
  }

  public async load(
    baseSession: SessionSummary,
    options: LoadClaudeBranchNavigationOptions = {},
  ): Promise<ClaudeBranchNavigationSnapshot> {
    const config = getConfig();
    if (!config.branchNavigationEnabled) {
      return this.buildSnapshot(baseSession, [baseSession], [], new Date(0).toISOString(), false, false);
    }
    const sessions = collectPhysicalProjectSessions(
      baseSession,
      this.historyService.getIndex().sessions,
      config.claudeSessionsRoot,
    );
    options.onProgress?.(progressOf("collectSessions", sessions.length, sessions.length, 0, 0));
    if (sessions.length < 2) {
      return this.buildSnapshot(baseSession, sessions, [], new Date(0).toISOString(), false, false);
    }

    const cacheKey = buildSnapshotCacheKey(baseSession);
    const inventoryFingerprint = await buildSessionInventoryFingerprint(sessions);
    const inventoryCached = this.snapshotByKey.get(cacheKey);
    let publishedFingerprint = "";
    if (inventoryCached?.snapshot.fingerprint.startsWith(`r${BRANCH_RELATION_ALGORITHM_VERSION}:${inventoryFingerprint}:`)) {
      inventoryCached.lastUsed = Date.now();
      this.snapshotByKey.delete(cacheKey);
      this.snapshotByKey.set(cacheKey, inventoryCached);
      options.onStoredSnapshot?.(inventoryCached.snapshot);
      publishedFingerprint = inventoryCached.snapshot.fingerprint;
    }
    const stored = await this.analysisIndex.getStoredEntries(sessions, config);
    if (stored.entries.length === sessions.length) {
      const storedSnapshot = this.buildSnapshot(
        baseSession,
        sessions,
        stored.entries,
        stored.generatedAtIso,
        true,
        false,
        inventoryFingerprint,
      );
      if (storedSnapshot.fingerprint !== publishedFingerprint) options.onStoredSnapshot?.(storedSnapshot);
    }

    const result = await this.analysisIndex.ensureEntries({
      sessions,
      activeSessions: this.historyService.getIndex().sessions,
      config,
      token: options.token,
      onProgress: options.onProgress,
    });
    options.onProgress?.(progressOf("buildRelations", 0, result.entries.length, result.cacheHitCount, result.rebuiltCount));
    const fingerprint = buildSnapshotFingerprint(sessions, result.entries, inventoryFingerprint);
    const cached = this.snapshotByKey.get(cacheKey);
    if (cached?.snapshot.fingerprint === fingerprint) {
      cached.lastUsed = Date.now();
      this.snapshotByKey.delete(cacheKey);
      this.snapshotByKey.set(cacheKey, cached);
      return cached.snapshot;
    }

    const snapshot = this.buildSnapshot(
      baseSession,
      sessions,
      result.entries,
      result.generatedAtIso,
      false,
      false,
      inventoryFingerprint,
    );
    this.snapshotByKey.set(cacheKey, { snapshot, lastUsed: Date.now() });
    this.pruneSnapshots();
    return snapshot;
  }

  private buildSnapshot(
    baseSession: SessionSummary,
    sessions: readonly SessionSummary[],
    entries: readonly SessionAnalysisEntry[],
    generatedAtIso: string,
    refreshing: boolean,
    stale: boolean,
    inventoryFingerprint?: string,
  ): ClaudeBranchNavigationSnapshot {
    const sessionByCacheKey = new Map(sessions.map((session) => [session.cacheKey, session]));
    const model = this.branchAnalysis.build({
      entries,
      baseSessionCacheKey: baseSession.cacheKey,
      projectLabel: resolveProjectLabel(baseSession),
      getSessionLabel: (cacheKey) => sessionByCacheKey.get(cacheKey)?.displayTitle ?? "",
      getAnnotationState: (cacheKey) => {
        const session = sessionByCacheKey.get(cacheKey);
        const annotation = session ? this.annotationStore.get(session.fsPath) : null;
        return { hasTags: Boolean(annotation?.tags.length), hasNote: Boolean(annotation?.note) };
      },
      isOccurrenceBookmarked: (occurrence) => this.isOccurrenceBookmarked(occurrence, sessionByCacheKey),
      generatedAtIso,
      refreshing,
      stale,
    });
    const fingerprint = buildSnapshotFingerprint(sessions, entries, inventoryFingerprint);
    const rawOccurrenceById = new Map<string, ClaudeGraphRecordOccurrence>();
    for (const entry of entries) {
      for (const occurrence of entry.claudeGraphRecords) rawOccurrenceById.set(occurrence.occurrenceId, occurrence);
    }
    const occurrenceById = new Map<string, ClaudeGraphRecordOccurrence>();
    const laneIdBySessionCacheKey = new Map<string, string>();
    const navigableOccurrenceIds = new Set<string>();
    for (const node of model.nodes) {
      for (const occurrence of node.occurrences) {
        navigableOccurrenceIds.add(occurrence.id);
        const rawOccurrence = rawOccurrenceById.get(occurrence.id);
        if (rawOccurrence) {
          occurrenceById.set(occurrence.id, rawOccurrence);
          laneIdBySessionCacheKey.set(rawOccurrence.sessionCacheKey, occurrence.laneId);
        }
      }
    }
    return {
      baseSessionCacheKey: baseSession.cacheKey,
      folderKey: normalizeCacheKey(path.dirname(baseSession.fsPath)),
      fingerprint,
      cursorSalt: hashId(`cursor\u0000${fingerprint}\u0000${generatedAtIso}`),
      sessions: [...sessions],
      model,
      entryByCacheKey: new Map(entries.map((entry) => [entry.cacheKey, entry])),
      occurrenceById,
      navigableOccurrenceIds,
      laneIdBySessionCacheKey,
    };
  }

  private isOccurrenceBookmarked(
    occurrence: ClaudeGraphRecordOccurrence,
    sessionByCacheKey: ReadonlyMap<string, SessionSummary>,
  ): boolean {
    const session = sessionByCacheKey.get(occurrence.sessionCacheKey);
    if (!session) return false;
    const key = buildBookmarkKey({
      sessionCacheKey: occurrence.sessionCacheKey,
      kind: "message",
      messageIndex: occurrence.chatMessageIndex,
      timestampIso: occurrence.timestampIso,
      fallbackId: occurrence.recordUuid ?? String(occurrence.recordOrdinal),
    });
    return Boolean(key && this.bookmarkStore.isBookmarked(key));
  }

  private pruneSnapshots(): void {
    let nodeCount = Array.from(this.snapshotByKey.values()).reduce(
      (total, cached) => total + cached.snapshot.model.nodes.length,
      0,
    );
    let occurrenceCount = Array.from(this.snapshotByKey.values()).reduce(
      (total, cached) => total + cached.snapshot.occurrenceById.size,
      0,
    );
    while (
      this.snapshotByKey.size > MAX_SNAPSHOTS ||
      nodeCount > MAX_CACHED_NODES ||
      occurrenceCount > MAX_CACHED_OCCURRENCES
    ) {
      const oldest = this.snapshotByKey.entries().next().value as [string, CachedSnapshot] | undefined;
      if (!oldest) break;
      this.snapshotByKey.delete(oldest[0]);
      nodeCount -= oldest[1].snapshot.model.nodes.length;
      occurrenceCount -= oldest[1].snapshot.occurrenceById.size;
    }
  }
}

export function buildClaudeChatBranchNavigationModel(
  snapshot: ClaudeBranchNavigationSnapshot,
  activeSessionCacheKey: string,
  generation: number,
  validUserMessageIndexes?: ReadonlySet<number>,
  activeChatMessageIndex?: number,
): ClaudeChatBranchNavigationModel {
  const title = resolveSessionTitle(snapshot, activeSessionCacheKey);
  const currentLaneId = snapshot.laneIdBySessionCacheKey.get(activeSessionCacheKey);
  if (!currentLaneId) {
    return emptyChatNavigation(generation, title, isSessionRelationPartial(snapshot, activeSessionCacheKey));
  }

  const component = collectLineageComponent(snapshot, currentLaneId, activeChatMessageIndex);
  const componentGroups = component.groups;
  const groups: ClaudeChatBranchGroup[] = [];
  for (const group of componentGroups) {
    if (groups.length >= MAX_CHAT_BRANCH_GROUPS) break;
    const currentChoiceIndexes = group.choices.flatMap((choice, index) => choice.laneIds.includes(currentLaneId) ? [index] : []);
    if (currentChoiceIndexes.length !== 1) continue;
    const currentChoiceIndex = currentChoiceIndexes[0]!;
    const anchorOccurrence = findLaneOccurrence(
      snapshot,
      group.choices[currentChoiceIndex]!,
      currentLaneId,
      activeChatMessageIndex,
    );
    if (!anchorOccurrence || anchorOccurrence.chatMessageIndex < 1) continue;
    if (validUserMessageIndexes && !validUserMessageIndexes.has(anchorOccurrence.chatMessageIndex)) continue;
    const indexes = controlChoiceIndexes(group.choices.length, currentChoiceIndex, MAX_CONTROL_CHOICES);
    groups.push({
      id: group.id,
      anchorChatMessageIndex: anchorOccurrence.chatMessageIndex,
      currentChoiceIndex,
      choiceCount: group.choices.length,
      choices: indexes.map((choiceIndex) => buildChoiceView(
        snapshot,
        group.choices[choiceIndex]!,
        choiceIndex,
        currentLaneId,
        0,
        MAX_CONTROL_OCCURRENCES,
        activeChatMessageIndex,
      )),
    });
  }

  return {
    version: 3,
    generation,
    groupCount: componentGroups.length,
    groups,
    overlay: buildClaudeBranchOverlayPage(snapshot, activeSessionCacheKey, generation, {
      activeChatMessageIndex,
    }),
  };
}

export function buildClaudeBranchOverlayPage(
  snapshot: ClaudeBranchNavigationSnapshot,
  activeSessionCacheKey: string,
  generation: number,
  options: ClaudeBranchOverlayPageOptions = {},
): ClaudeBranchOverlayPageModel {
  void generation;
  const currentLaneId = snapshot.laneIdBySessionCacheKey.get(activeSessionCacheKey);
  const title = resolveSessionTitle(snapshot, activeSessionCacheKey);
  if (!currentLaneId) return emptyOverlay(title, isSessionRelationPartial(snapshot, activeSessionCacheKey));
  const component = collectLineageComponent(snapshot, currentLaneId, options.activeChatMessageIndex);
  const allGroups = component.groups;
  const currentGroupId = options.focusGroupId && allGroups.some((group) => group.id === options.focusGroupId)
    ? options.focusGroupId
    : resolveCurrentGroupId(snapshot, allGroups, currentLaneId, options.activeChatMessageIndex);
  const pageSize = options.cursor ? GROUP_PAGE_SIZE : INITIAL_GROUP_PAGE_SIZE;
  const currentIndex = Math.max(0, allGroups.findIndex((group) => group.id === currentGroupId));
  const requestedOffset = options.cursor
    ? decodeCursor(snapshot, options.cursor, "group", "tree")
    : Math.max(0, currentIndex - Math.floor(pageSize / 2));
  const offset = options.cursor
    ? clampCursorPageOffset(requestedOffset ?? 0, allGroups.length)
    : clampWindowPageOffset(requestedOffset ?? 0, allGroups.length, pageSize);
  const pageGroups = allGroups.slice(offset, offset + pageSize);
  return {
    title,
    groups: pageGroups.map((group) => buildOverlayGroup(
      snapshot,
      allGroups,
      group,
      currentLaneId,
      undefined,
      undefined,
      options.activeChatMessageIndex,
    )),
    totalGroupCount: allGroups.length,
    routeCount: countComponentRoutes(allGroups),
    currentGroupId,
    ...(offset > 0 ? { previousCursor: encodeCursor(snapshot, "group", Math.max(0, offset - GROUP_PAGE_SIZE), "tree") } : {}),
    ...(offset + pageGroups.length < allGroups.length
      ? { nextCursor: encodeCursor(snapshot, "group", offset + pageGroups.length, "tree") }
      : {}),
    previousGroupCount: offset,
    nextGroupCount: Math.max(0, allGroups.length - offset - pageGroups.length),
    relationPartial: isComponentRelationPartial(snapshot, component),
    navigationIncomplete: isNavigationIncomplete(snapshot, allGroups),
  };
}

export function buildClaudeBranchChoicePage(
  snapshot: ClaudeBranchNavigationSnapshot,
  activeSessionCacheKey: string,
  groupId: string,
  cursor: string,
  activeChatMessageIndex?: number,
): ClaudeBranchOverlayGroup | null {
  const currentLaneId = snapshot.laneIdBySessionCacheKey.get(activeSessionCacheKey);
  if (!currentLaneId) return null;
  const groups = collectLineageComponent(snapshot, currentLaneId, activeChatMessageIndex).groups;
  const group = groups.find((candidate) => candidate.id === groupId);
  if (!group) return null;
  const offset = decodeCursor(snapshot, cursor, "choice", group.id);
  if (offset === null) return null;
  return buildOverlayGroup(snapshot, groups, group, currentLaneId, offset, CHOICE_PAGE_SIZE, activeChatMessageIndex);
}

export function isClaudeBranchTargetInActiveLineage(
  snapshot: ClaudeBranchNavigationSnapshot,
  activeSessionCacheKey: string,
  groupId: string,
  choiceId: string,
  occurrenceId: string,
  activeChatMessageIndex?: number,
): boolean {
  const currentLaneId = snapshot.laneIdBySessionCacheKey.get(activeSessionCacheKey);
  if (!currentLaneId) return false;
  const group = collectLineageComponent(snapshot, currentLaneId, activeChatMessageIndex).groups.find(
    (candidate) => candidate.id === groupId,
  );
  const choice = group?.choices.find((candidate) => candidate.id === choiceId);
  return Boolean(choice?.occurrenceIds.includes(occurrenceId));
}

export function collectPhysicalProjectSessions(
  baseSession: SessionSummary,
  sessions: readonly SessionSummary[],
  claudeSessionsRoot: string,
): SessionSummary[] {
  const baseFolder = normalizeCacheKey(path.dirname(baseSession.fsPath));
  return sessions.filter(
    (session) =>
      session.source === "claude" &&
      isValidClaudePrimarySession(session, claudeSessionsRoot) &&
      normalizeCacheKey(path.dirname(session.fsPath)) === baseFolder,
  );
}

export function isValidClaudePrimarySession(session: SessionSummary, claudeSessionsRoot: string): boolean {
  if (session.source !== "claude" || session.storage.rootKind !== "claudeSessions") return false;
  const relative = path.relative(path.resolve(claudeSessionsRoot), path.resolve(session.fsPath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  const parts = relative.split(/[\\/]+/u).filter(Boolean);
  return parts.length === 2 && parts[1]!.toLowerCase().endsWith(".jsonl");
}

function collectLineageComponent(
  snapshot: ClaudeBranchNavigationSnapshot,
  currentLaneId: string,
  activeChatMessageIndex?: number,
): ClaudeLineageComponent {
  const activeNodeId = resolveActiveNodeId(snapshot, currentLaneId, activeChatMessageIndex);
  if (!activeNodeId) return { groups: [], sessionCacheKeys: new Set() };
  const adjacent = new Map<string, Set<string>>();
  for (const edge of snapshot.model.edges) {
    if (edge.kind === "unresolved") continue;
    const from = adjacent.get(edge.from) ?? new Set<string>();
    from.add(edge.to);
    adjacent.set(edge.from, from);
    const to = adjacent.get(edge.to) ?? new Set<string>();
    to.add(edge.from);
    adjacent.set(edge.to, to);
  }
  const component = new Set([activeNodeId]);
  const queue = [activeNodeId];
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const current = queue[queueIndex]!;
    for (const next of adjacent.get(current) ?? []) {
      if (component.has(next)) continue;
      component.add(next);
      queue.push(next);
    }
  }
  const groups = snapshot.model.groups.filter(
    (group) => component.has(group.parentNodeId) || group.choices.some((choice) => component.has(choice.nodeId)),
  );
  const laneIds = new Set(snapshot.model.nodes.flatMap((node) => component.has(node.id) ? node.laneIds : []));
  const sessionCacheKeys = new Set<string>();
  for (const [cacheKey, laneId] of snapshot.laneIdBySessionCacheKey) {
    if (laneIds.has(laneId)) sessionCacheKeys.add(cacheKey);
  }
  return { groups, sessionCacheKeys };
}

function resolveActiveNodeId(
  snapshot: ClaudeBranchNavigationSnapshot,
  currentLaneId: string,
  activeChatMessageIndex?: number,
): string {
  const candidates = snapshot.model.nodes.flatMap((node) => node.occurrences.flatMap((occurrence) =>
    occurrence.laneId === currentLaneId ? [{ nodeId: node.id, occurrence }] : []));
  candidates.sort((left, right) =>
    left.occurrence.chatMessageIndex - right.occurrence.chatMessageIndex ||
    left.occurrence.recordOrdinal - right.occurrence.recordOrdinal ||
    left.occurrence.id.localeCompare(right.occurrence.id) ||
    left.nodeId.localeCompare(right.nodeId));
  if (candidates.length === 0) return "";
  const targetIndex = Number.isSafeInteger(activeChatMessageIndex) && Number(activeChatMessageIndex) >= 1
    ? Number(activeChatMessageIndex)
    : undefined;
  if (targetIndex !== undefined) {
    const exact = candidates.find((candidate) => candidate.occurrence.chatMessageIndex === targetIndex);
    if (exact) return exact.nodeId;
    const previous = candidates.filter(
      (candidate) => candidate.occurrence.chatMessageIndex < targetIndex,
    ).at(-1);
    if (previous) return previous.nodeId;
    return candidates[0]!.nodeId;
  }
  return candidates.at(-1)!.nodeId;
}

function isComponentRelationPartial(
  snapshot: ClaudeBranchNavigationSnapshot,
  component: ClaudeLineageComponent,
): boolean {
  if (snapshot.model.partial) return true;
  return Array.from(component.sessionCacheKeys).some((cacheKey) => isSessionRelationPartial(snapshot, cacheKey));
}

function isSessionRelationPartial(snapshot: ClaudeBranchNavigationSnapshot, cacheKey: string): boolean {
  const entry = snapshot.entryByCacheKey.get(cacheKey);
  if (!entry) return false;
  if (entry.completeness === "failed" || entry.completeness === "unsupported") return true;
  return entry.warnings.some((warning) =>
    warning === "claudeGraphRecordLimitReached" ||
    warning.startsWith("malformedLines:") ||
    warning.startsWith("unmatchedClaudeRecords:") ||
    warning.startsWith("unmatchedChatMessages:"));
}

function resolveCurrentGroupId(
  snapshot: ClaudeBranchNavigationSnapshot,
  groups: readonly ClaudeBranchGroup[],
  currentLaneId: string,
  activeChatMessageIndex?: number,
): string {
  if (typeof activeChatMessageIndex === "number") {
    const exact = groups.find((group) => group.choices.some((choice) => {
      if (!choice.laneIds.includes(currentLaneId)) return false;
      return findLaneOccurrence(snapshot, choice, currentLaneId, activeChatMessageIndex)?.chatMessageIndex === activeChatMessageIndex;
    }));
    if (exact) return exact.id;
  }
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index]!;
    if (group.choices.some((choice) => choice.laneIds.includes(currentLaneId))) return group.id;
  }
  return "";
}

function buildOverlayGroup(
  snapshot: ClaudeBranchNavigationSnapshot,
  allGroups: readonly ClaudeBranchGroup[],
  group: ClaudeBranchGroup,
  currentLaneId: string,
  requestedChoiceOffset?: number,
  requestedChoicePageSize?: number,
  activeChatMessageIndex?: number,
): ClaudeBranchOverlayGroup {
  const parentRelation = findParentGroupRelation(snapshot.model, allGroups, group);
  const currentChoiceIndex = group.choices.findIndex((choice) => choice.laneIds.includes(currentLaneId));
  const pageSize = requestedChoicePageSize ?? INITIAL_CHOICE_PAGE_SIZE;
  const initialOffset = currentChoiceIndex >= 0
    ? Math.max(0, currentChoiceIndex - Math.floor(pageSize / 2))
    : 0;
  const offset = requestedChoiceOffset === undefined
    ? clampWindowPageOffset(initialOffset, group.choices.length, pageSize)
    : clampCursorPageOffset(requestedChoiceOffset, group.choices.length);
  const choices = group.choices.slice(offset, offset + pageSize).map((choice, index) =>
    buildChoiceView(
      snapshot,
      choice,
      offset + index,
      currentLaneId,
      0,
      MAX_CONTROL_OCCURRENCES,
      activeChatMessageIndex,
    ));
  return {
    id: group.id,
    groupIndex: Math.max(0, allGroups.indexOf(group)),
    ...parentRelation,
    choiceCount: group.choices.length,
    currentChoiceIndex,
    activeLineage: currentChoiceIndex >= 0,
    ...buildCommonRange(snapshot, group, currentLaneId, activeChatMessageIndex),
    choices,
    ...(offset > 0 ? { previousChoiceCursor: encodeCursor(snapshot, "choice", Math.max(0, offset - CHOICE_PAGE_SIZE), group.id) } : {}),
    ...(offset + choices.length < group.choices.length
      ? { nextChoiceCursor: encodeCursor(snapshot, "choice", offset + choices.length, group.id) }
      : {}),
    previousChoiceCount: offset,
    nextChoiceCount: Math.max(0, group.choices.length - offset - choices.length),
  };
}

function buildChoiceView(
  snapshot: ClaudeBranchNavigationSnapshot,
  choice: ClaudeBranchGroup["choices"][number],
  choiceIndex: number,
  currentLaneId: string,
  occurrenceOffset: number,
  occurrenceLimit: number,
  activeChatMessageIndex?: number,
): ClaudeChatBranchChoice {
  const lookup = getSnapshotLookup(snapshot);
  const node = lookup.nodeById.get(choice.nodeId);
  const viewOccurrenceById = new Map((node?.occurrences ?? []).map((occurrence) => [occurrence.id, occurrence]));
  const currentOccurrenceId = findLaneOccurrence(
    snapshot,
    choice,
    currentLaneId,
    activeChatMessageIndex,
  )?.occurrenceId;
  const orderedIds = choice.occurrenceIds.slice().sort((leftId, rightId) => {
    if (leftId === currentOccurrenceId && rightId !== currentOccurrenceId) return -1;
    if (rightId === currentOccurrenceId && leftId !== currentOccurrenceId) return 1;
    const left = viewOccurrenceById.get(leftId);
    const right = viewOccurrenceById.get(rightId);
    return (left?.chatMessageIndex ?? 0) - (right?.chatMessageIndex ?? 0) || leftId.localeCompare(rightId);
  });
  const occurrences = orderedIds.slice(occurrenceOffset, occurrenceOffset + occurrenceLimit).flatMap((occurrenceId) => {
    const raw = snapshot.occurrenceById.get(occurrenceId);
    const view = viewOccurrenceById.get(occurrenceId);
    if (!raw || !view) return [];
    const lane = lookup.laneById.get(view.laneId);
    const entry = snapshot.entryByCacheKey.get(raw.sessionCacheKey);
    const option: ClaudeBranchOccurrenceOption = {
      id: occurrenceId,
      sessionLabel: lane?.label ?? "",
      isCurrent: occurrenceId === currentOccurrenceId,
      ...(entry?.claudeMessageBounds?.first
        ? { historyFirst: toDisplayAnchor(entry, entry.claudeMessageBounds.first) }
        : {}),
      ...(raw.previousVisibleMessage ? { preBranch: toDisplayAnchor(entry, raw.previousVisibleMessage) } : {}),
      branchStart: toBranchStartAnchor(raw),
      ...(entry?.claudeMessageBounds?.last
        ? { historyEnd: toDisplayAnchor(entry, entry.claudeMessageBounds.last) }
        : {}),
      isBookmarked: view.isBookmarked,
      hasTags: lane?.hasTags === true,
      hasNote: lane?.hasNote === true,
    };
    return [option];
  });
  return {
    id: choice.id,
    choiceIndex,
    preview: choice.preview,
    occurrenceCount: orderedIds.length,
    occurrences,
  };
}

function buildCommonRange(
  snapshot: ClaudeBranchNavigationSnapshot,
  group: ClaudeBranchGroup,
  currentLaneId: string,
  activeChatMessageIndex?: number,
): { commonRange?: ClaudeBranchCommonRange } {
  const occurrences = group.choices.map((choice) => findFirstRawOccurrence(snapshot, choice)).filter(
    (occurrence): occurrence is ClaudeGraphRecordOccurrence => Boolean(occurrence),
  );
  if (occurrences.length !== group.choices.length) return {};
  const entries = occurrences.map((occurrence) => snapshot.entryByCacheKey.get(occurrence.sessionCacheKey));
  const first = entries.map((entry) => entry?.claudeMessageBounds?.first);
  const last = occurrences.map((occurrence) => occurrence.previousVisibleMessage);
  if (!anchorsShareRoleAndIndex(first) || !anchorsShareRoleAndIndex(last)) return {};
  const activeChoice = group.choices.find((choice) => choice.laneIds.includes(currentLaneId));
  const activeOccurrence = activeChoice
    ? findLaneOccurrence(snapshot, activeChoice, currentLaneId, activeChatMessageIndex)
    : undefined;
  const activeEntry = activeOccurrence ? snapshot.entryByCacheKey.get(activeOccurrence.sessionCacheKey) : undefined;
  const displayOccurrence = activeOccurrence ?? occurrences[0]!;
  return {
    commonRange: {
      first: withAnchorPreview(
        snapshot,
        displayOccurrence.sessionCacheKey,
        mergeSharedAnchor(first as ClaudeVisibleMessageAnchor[], activeEntry?.claudeMessageBounds?.first),
      ),
      last: withAnchorPreview(
        snapshot,
        displayOccurrence.sessionCacheKey,
        mergeSharedAnchor(last as ClaudeVisibleMessageAnchor[], activeOccurrence?.previousVisibleMessage),
      ),
    },
  };
}

function anchorsShareRoleAndIndex(
  anchors: readonly (ClaudeVisibleMessageAnchor | undefined)[],
): boolean {
  if (anchors.length === 0 || anchors.some((anchor) => !anchor)) return false;
  const first = anchors[0]!;
  return anchors.every((anchor) => anchor?.role === first.role && anchor.chatMessageIndex === first.chatMessageIndex);
}

function mergeSharedAnchor(
  anchors: readonly ClaudeVisibleMessageAnchor[],
  preferred?: ClaudeVisibleMessageAnchor,
): ClaudeBranchMessageAnchor {
  const first = anchors[0]!;
  const timestamps = new Set(anchors.map((anchor) => anchor.timestampIso ?? ""));
  const usePreferred = preferred?.role === first.role && preferred.chatMessageIndex === first.chatMessageIndex;
  const display = usePreferred ? preferred : first;
  return {
    role: first.role,
    chatMessageIndex: first.chatMessageIndex,
    ...(display.timestampIso && (usePreferred || timestamps.size === 1) ? { timestampIso: display.timestampIso } : {}),
    ...(display.preview ? { preview: display.preview } : {}),
  };
}

function findParentGroupRelation(
  model: ClaudeBranchMapModel,
  groups: readonly ClaudeBranchGroup[],
  group: ClaudeBranchGroup,
): { parentGroupId?: string; parentChoiceId?: string } {
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const ownerByChoiceNodeId = new Map<string, { groupId: string; choiceId: string }>();
  for (const candidate of groups) {
    for (const choice of candidate.choices) {
      ownerByChoiceNodeId.set(choice.nodeId, { groupId: candidate.id, choiceId: choice.id });
    }
  }
  let nodeId: string | undefined = group.parentNodeId;
  const visited = new Set<string>();
  while (nodeId && !visited.has(nodeId)) {
    visited.add(nodeId);
    const owner = ownerByChoiceNodeId.get(nodeId);
    if (owner && owner.groupId !== group.id) {
      return { parentGroupId: owner.groupId, parentChoiceId: owner.choiceId };
    }
    nodeId = nodeById.get(nodeId)?.parentId;
  }
  return {};
}

function countComponentRoutes(groups: readonly ClaudeBranchGroup[]): number {
  return new Set(groups.flatMap((group) => group.choices.flatMap((choice) => choice.laneIds))).size;
}

function isNavigationIncomplete(
  snapshot: ClaudeBranchNavigationSnapshot,
  groups: readonly ClaudeBranchGroup[],
): boolean {
  return groups.some((group) => group.choices.some((choice) => {
    const occurrences = choice.occurrenceIds.flatMap((occurrenceId) => {
      const occurrence = snapshot.occurrenceById.get(occurrenceId);
      return occurrence ? [occurrence] : [];
    });
    return occurrences.length === 0 || occurrences.every(
      (occurrence) =>
        !snapshot.navigableOccurrenceIds.has(occurrence.occurrenceId) ||
        occurrence.chatMessageIndex < 1 ||
        !snapshot.entryByCacheKey.has(occurrence.sessionCacheKey),
    );
  }));
}

function resolveSessionTitle(snapshot: ClaudeBranchNavigationSnapshot, cacheKey: string): string {
  return getSnapshotLookup(snapshot).sessionTitleByCacheKey.get(cacheKey) ?? "";
}

function getSnapshotLookup(snapshot: ClaudeBranchNavigationSnapshot): ClaudeBranchSnapshotLookup {
  const cached = snapshotLookupCache.get(snapshot);
  if (cached) return cached;
  const lookup: ClaudeBranchSnapshotLookup = {
    nodeById: new Map(snapshot.model.nodes.map((node) => [node.id, node])),
    laneById: new Map(snapshot.model.lanes.map((lane) => [lane.id, lane])),
    sessionTitleByCacheKey: new Map(
      snapshot.sessions.map((session) => [session.cacheKey, session.displayTitle.trim()]),
    ),
  };
  snapshotLookupCache.set(snapshot, lookup);
  return lookup;
}

function findLaneOccurrence(
  snapshot: ClaudeBranchNavigationSnapshot,
  choice: ClaudeBranchGroup["choices"][number],
  laneId: string,
  preferredChatMessageIndex?: number,
): ClaudeGraphRecordOccurrence | undefined {
  const candidates = choice.occurrenceIds.flatMap((occurrenceId) => {
    const raw = snapshot.occurrenceById.get(occurrenceId);
    return raw && snapshot.laneIdBySessionCacheKey.get(raw.sessionCacheKey) === laneId ? [raw] : [];
  }).sort((left, right) =>
    left.chatMessageIndex - right.chatMessageIndex ||
    left.recordOrdinal - right.recordOrdinal ||
    left.occurrenceId.localeCompare(right.occurrenceId));
  if (candidates.length === 0) return undefined;
  const targetIndex = Number.isSafeInteger(preferredChatMessageIndex) && Number(preferredChatMessageIndex) >= 1
    ? Number(preferredChatMessageIndex)
    : undefined;
  if (targetIndex !== undefined) {
    const exact = candidates.find((candidate) => candidate.chatMessageIndex === targetIndex);
    if (exact) return exact;
    const previous = candidates.filter((candidate) => candidate.chatMessageIndex < targetIndex).at(-1);
    return previous ?? candidates[0];
  }
  return candidates.at(-1);
}

function findFirstRawOccurrence(
  snapshot: ClaudeBranchNavigationSnapshot,
  choice: ClaudeBranchGroup["choices"][number],
): ClaudeGraphRecordOccurrence | undefined {
  return choice.occurrenceIds.flatMap((id) => {
    const occurrence = snapshot.occurrenceById.get(id);
    return occurrence ? [occurrence] : [];
  }).sort((left, right) => left.recordOrdinal - right.recordOrdinal || left.occurrenceId.localeCompare(right.occurrenceId))[0];
}

function controlChoiceIndexes(choiceCount: number, currentChoiceIndex: number, limit: number): number[] {
  if (choiceCount <= 0) return [];
  const boundedLimit = Math.max(1, Math.min(choiceCount, Math.floor(limit)));
  if (choiceCount <= boundedLimit) return Array.from({ length: choiceCount }, (_value, index) => index);
  const beforeCurrent = Math.floor((boundedLimit - 1) / 2);
  return Array.from({ length: boundedLimit }, (_value, offset) => (
    currentChoiceIndex - beforeCurrent + offset + choiceCount
  ) % choiceCount).sort((left, right) => left - right);
}

function toBranchStartAnchor(occurrence: ClaudeGraphRecordOccurrence): ClaudeBranchMessageAnchor {
  return {
    role: "user",
    chatMessageIndex: occurrence.chatMessageIndex,
    ...(occurrence.timestampIso ? { timestampIso: occurrence.timestampIso } : {}),
    ...(occurrence.preview ? { preview: occurrence.preview } : {}),
  };
}

function toDisplayAnchor(
  entry: SessionAnalysisEntry | undefined,
  anchor: ClaudeVisibleMessageAnchor,
): ClaudeBranchMessageAnchor {
  const preview = anchor.preview ?? entry?.claudeGraphRecords.find(
    (occurrence) => occurrence.chatMessageIndex === anchor.chatMessageIndex && occurrence.preview,
  )?.preview;
  return {
    role: anchor.role,
    chatMessageIndex: anchor.chatMessageIndex,
    ...(anchor.timestampIso ? { timestampIso: anchor.timestampIso } : {}),
    ...(preview ? { preview } : {}),
  };
}

function withAnchorPreview(
  snapshot: ClaudeBranchNavigationSnapshot,
  sessionCacheKey: string,
  anchor: ClaudeBranchMessageAnchor,
): ClaudeBranchMessageAnchor {
  if (anchor.preview) return anchor;
  const entry = snapshot.entryByCacheKey.get(sessionCacheKey);
  const preview = entry?.claudeGraphRecords.find(
    (occurrence) => occurrence.chatMessageIndex === anchor.chatMessageIndex && occurrence.preview,
  )?.preview;
  return preview ? { ...anchor, preview } : anchor;
}

function emptyChatNavigation(
  generation: number,
  title: string,
  relationPartial: boolean,
): ClaudeChatBranchNavigationModel {
  return {
    version: 3,
    generation,
    groupCount: 0,
    groups: [],
    overlay: emptyOverlay(title, relationPartial),
  };
}

function emptyOverlay(title: string, relationPartial: boolean): ClaudeBranchOverlayPageModel {
  return {
    title,
    groups: [],
    totalGroupCount: 0,
    routeCount: 0,
    currentGroupId: "",
    previousGroupCount: 0,
    nextGroupCount: 0,
    relationPartial,
    navigationIncomplete: false,
  };
}

function encodeCursor(
  snapshot: ClaudeBranchNavigationSnapshot,
  kind: "group" | "choice",
  offset: number,
  scope: string,
): string {
  const boundedOffset = Math.max(0, Math.floor(offset));
  const payload = `${kind}\u0000${boundedOffset}\u0000${scope}`;
  return `${kind === "group" ? "g" : "c"}.${boundedOffset.toString(36)}.${hashId(`${snapshot.cursorSalt}\u0000${payload}`)}`;
}

function decodeCursor(
  snapshot: ClaudeBranchNavigationSnapshot,
  cursor: string,
  kind: "group" | "choice",
  scope: string,
): number | null {
  const match = String(cursor ?? "").match(/^(g|c)\.([0-9a-z]+)\.([a-f0-9]{24})$/u);
  if (!match || match[1] !== (kind === "group" ? "g" : "c")) return null;
  const offset = Number.parseInt(match[2]!, 36);
  if (!Number.isSafeInteger(offset) || offset < 0) return null;
  return encodeCursor(snapshot, kind, offset, scope) === cursor ? offset : null;
}

function clampWindowPageOffset(offset: number, total: number, pageSize: number): number {
  if (total <= pageSize) return 0;
  return Math.max(0, Math.min(Math.floor(offset), total - pageSize));
}

function clampCursorPageOffset(offset: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(Math.floor(offset), total - 1));
}

function buildSnapshotCacheKey(baseSession: SessionSummary): string {
  return `${normalizeCacheKey(path.dirname(baseSession.fsPath))}\u0000${baseSession.cacheKey}`;
}

function buildEntriesFingerprint(entries: readonly SessionAnalysisEntry[]): string {
  const value = entries
    .map((entry) => `${entry.cacheKey}\u0000${entry.mtimeMs}\u0000${entry.size}\u0000${entry.parserVersion}`)
    .sort()
    .join("\u0001");
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
}

async function buildSessionInventoryFingerprint(sessions: readonly SessionSummary[]): Promise<string> {
  const inventory = await Promise.all(sessions.map(async (session) => {
    try {
      const file = await stat(session.fsPath);
      return `${normalizeCacheKey(session.fsPath)}\u0000${file.mtimeMs}\u0000${file.size}`;
    } catch {
      return `${normalizeCacheKey(session.fsPath)}\u0000missing`;
    }
  }));
  const value = inventory.sort().join("\u0001");
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
}

function buildFallbackInventoryFingerprint(sessions: readonly SessionSummary[]): string {
  const value = sessions.map((session) => normalizeCacheKey(session.fsPath)).sort().join("\u0001");
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
}

function buildSnapshotFingerprint(
  sessions: readonly SessionSummary[],
  entries: readonly SessionAnalysisEntry[],
  inventoryFingerprint?: string,
): string {
  return `r${BRANCH_RELATION_ALGORITHM_VERSION}:${inventoryFingerprint ?? buildFallbackInventoryFingerprint(sessions)}:${buildEntriesFingerprint(entries)}`;
}

function resolveProjectLabel(session: SessionSummary): string {
  const cwd = typeof session.meta.cwd === "string" ? session.meta.cwd.trim() : "";
  return cwd ? path.basename(path.normalize(cwd)) || session.cwdShort : session.cwdShort;
}

function progressOf(
  phase: SessionAnalysisProgress["phase"],
  completed: number,
  total: number,
  cacheHitCount: number,
  rebuiltCount: number,
): SessionAnalysisProgress {
  return { phase, completed, total, cancellable: true, cacheHitCount, rebuiltCount };
}

function hashId(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
}
