import { stat } from "node:fs/promises";
import {
  buildChatSessionModel,
} from "../chat/chatModelBuilder";
import type { ChatSessionModel } from "../chat/chatTypes";
import type { SessionSummary } from "../sessions/sessionTypes";
import { stableTextSha256 } from "../utils/stableTextHash";
import type {
  ClaudeBranchCommonRange,
  ClaudeBranchMessageAnchor,
  ClaudeBranchOccurrenceOption,
  ClaudeBranchOverlayGroup,
  ClaudeBranchOverlayPageModel,
  ClaudeChatBranchChoice,
  ClaudeChatBranchGroup,
  ClaudeChatBranchNavigationModel,
} from "./claudeBranchMapTypes";
import {
  CodexForkRelationService,
  buildCodexForkSessionEvidence,
} from "./codexForkRelationService";
import type {
  CodexForkRelationEdge,
  CodexForkSessionEvidence,
} from "./codexForkRelationTypes";
import type {
  CodexForkFileInventoryEntry,
  CodexForkHistoryInventory,
  CodexForkNavigationDependencies,
  CodexForkNavigationLoadProgress,
  CodexForkNavigationSnapshot,
  CodexForkNavigationTarget,
  CodexForkOverlayPageOptions,
  CodexForkPresentationChoice,
  CodexForkPresentationGroup,
  CodexForkPresentationOccurrence,
  CodexForkPresentationState,
  LoadCodexForkNavigationOptions,
  ResolvedCodexForkNavigationTarget,
} from "./codexForkNavigationTypes";

const LOAD_CONCURRENCY = 4;
const MAX_EVIDENCE_CACHE_ENTRIES = 512;
const MAX_EVIDENCE_CACHE_MESSAGES = 500_000;
const MAX_LOAD_EVIDENCE_MESSAGES = 500_000;
const MAX_SESSION_FILE_SIZE = 256 * 1024 * 1024;
const MAX_CHAT_BRANCH_GROUPS = 500;
const MAX_CONTROL_CHOICES = 20;
const INITIAL_GROUP_PAGE_SIZE = 2;
const GROUP_PAGE_SIZE = 2;
const INITIAL_CHOICE_PAGE_SIZE = 20;
const CHOICE_PAGE_SIZE = 20;
const CODEX_FORK_NAVIGATION_ALGORITHM_VERSION = 1;

interface EvidenceCacheEntry {
  cacheKey: string;
  signature: string;
  evidence: CodexForkSessionEvidence;
}

interface EvidenceLoadResult {
  session: SessionSummary;
  inventory?: CodexForkFileInventoryEntry;
  evidence?: CodexForkSessionEvidence;
  cacheHit: boolean;
  rebuilt: boolean;
  failed: boolean;
}

interface PresentationBuildResult {
  groups: CodexForkPresentationGroup[];
  targetById: Map<string, CodexForkNavigationTarget>;
  partial: boolean;
}

interface MutablePresentationGroup {
  id: string;
  parentSessionIdentityKey: string;
  parentAnchor: ClaudeBranchMessageAnchor;
  anchorMessageIndex: number;
  childEdges: CodexForkRelationEdge[];
  choices: CodexForkPresentationChoice[];
  parentGroupId?: string;
  parentChoiceId?: string;
}

interface GroupLookup {
  parentByChildIdentity: ReadonlyMap<string, string>;
  edgeByChildIdentity: ReadonlyMap<string, CodexForkRelationEdge>;
  sessionByIdentity: ReadonlyMap<string, SessionSummary>;
  sessionByCacheKey: ReadonlyMap<string, SessionSummary>;
}

interface NavigableComponent {
  groups: readonly CodexForkPresentationGroup[];
  sessionIdentityKeys: ReadonlySet<string>;
}

const groupLookupCache = new WeakMap<CodexForkNavigationSnapshot, GroupLookup>();

export class CodexForkNavigationSupersededError extends Error {
  constructor() {
    super("Codex fork navigation load was superseded by history or file changes.");
    this.name = "CodexForkNavigationSupersededError";
  }
}

export class CodexForkNavigationService {
  private readonly relationService = new CodexForkRelationService();
  private readonly evidenceCache = new Map<string, EvidenceCacheEntry>();
  private readonly statFile: (fsPath: string) => Promise<{ mtimeMs: number; size: number }>;
  private readonly buildChatModel: (fsPath: string) => Promise<ChatSessionModel>;
  private readonly getPresentationState: (
    session: SessionSummary,
    branchStart: ClaudeBranchMessageAnchor,
  ) => CodexForkPresentationState;

  constructor(
    private readonly historyService: CodexForkHistoryInventory,
    dependencies: CodexForkNavigationDependencies = {},
  ) {
    this.statFile = dependencies.statFile ?? defaultStatFile;
    this.buildChatModel = dependencies.buildChatModel ?? defaultBuildChatModel;
    this.getPresentationState =
      dependencies.getPresentationState ?? emptyPresentationState;
  }

  public clearCache(): void {
    this.evidenceCache.clear();
  }

  public async load(
    baseSession: SessionSummary,
    options: LoadCodexForkNavigationOptions = {},
  ): Promise<CodexForkNavigationSnapshot> {
    if (!this.historyService.hasCompleteCodexAgentMetadata()) {
      const metadataResult = await this.historyService.ensureCodexAgentMetadata({
        shouldApply: options.shouldContinue,
      });
      if (metadataResult.cancelled) throw new CodexForkNavigationSupersededError();
    }
    if (options.shouldContinue?.() === false) throw new CodexForkNavigationSupersededError();

    const index = this.historyService.getIndex();
    const indexGeneration = this.historyService.getIndexGeneration();
    const indexedBase = index.byCacheKey.get(baseSession.cacheKey);
    if (
      !indexedBase ||
      indexedBase.source !== "codex" ||
      indexedBase.identityKey !== baseSession.identityKey
    ) {
      return buildEmptySnapshot(baseSession, indexGeneration);
    }
    this.assertCurrent(index, indexGeneration, options);

    const relationSessions = index.sessions.filter(
      (session) =>
        session.source !== "codex" ||
        this.historyService.isCodexAgentMetadataVerified(session),
    );
    const metadataPartial = relationSessions.length !== index.sessions.length;
    if (!this.historyService.isCodexAgentMetadataVerified(indexedBase)) {
      return buildMetadataIncompleteSnapshot(indexedBase, indexGeneration);
    }

    const metadataComponent = this.relationService.build({
      sessions: relationSessions,
      currentSessionCacheKey: indexedBase.cacheKey,
    });
    const componentSessions = orderComponentSessionsForEvidence(
      metadataComponent.nodes.flatMap((node) => node.session ? [node.session] : []),
      metadataComponent.edges,
      indexedBase.identityKey,
    );
    if (!metadataComponent.hasSupportedRelation || componentSessions.length < 2) {
      return buildSnapshot({
        baseSession: indexedBase,
        indexGeneration,
        sessions: componentSessions.length > 0 ? componentSessions : [indexedBase],
        component: metadataComponent,
        inventoryByCacheKey: new Map(),
        evidenceByIdentityKey: new Map(),
        loadPartial: metadataPartial || metadataComponent.relationPartial,
        getPresentationState: this.getPresentationState,
      });
    }

    let completed = 0;
    let cacheHitCount = 0;
    let rebuiltCount = 0;
    let retainedEvidenceMessageCount = 0;
    const results: EvidenceLoadResult[] = [];
    for (
      let batchOffset = 0;
      batchOffset < componentSessions.length;
      batchOffset += LOAD_CONCURRENCY
    ) {
      const batchSessions = componentSessions.slice(
        batchOffset,
        batchOffset + LOAD_CONCURRENCY,
      );
      const batchResults = await mapWithConcurrency(
        batchSessions,
        LOAD_CONCURRENCY,
        async (session) => {
          this.assertCurrent(index, indexGeneration, options);
          return this.loadSessionEvidence(session, options);
        },
      );
      for (const loaded of batchResults) {
        this.assertCurrent(index, indexGeneration, options);
        const result = retainEvidenceWithinBudget(
          loaded,
          Math.max(0, MAX_LOAD_EVIDENCE_MESSAGES - retainedEvidenceMessageCount),
        );
        retainedEvidenceMessageCount += result.evidence?.messages.length ?? 0;
        completed += 1;
        if (result.cacheHit) cacheHitCount += 1;
        if (result.rebuilt) rebuiltCount += 1;
        options.onProgress?.(progressOf(
          completed,
          componentSessions.length,
          cacheHitCount,
          rebuiltCount,
        ));
        results.push(result);
      }
    }
    this.assertCurrent(index, indexGeneration, options);

    const inventoryByCacheKey = new Map<string, CodexForkFileInventoryEntry>();
    const evidenceByIdentityKey = new Map<string, CodexForkSessionEvidence>();
    let loadPartial = false;
    for (const result of results) {
      if (result.inventory) inventoryByCacheKey.set(result.session.cacheKey, result.inventory);
      if (result.evidence) evidenceByIdentityKey.set(result.session.identityKey, result.evidence);
      if (result.failed || !result.inventory || !result.evidence) loadPartial = true;
    }
    await this.verifyInventory(componentSessions, inventoryByCacheKey, index, indexGeneration, options);

    const component = this.relationService.build({
      sessions: relationSessions,
      currentSessionCacheKey: indexedBase.cacheKey,
      evidenceByIdentityKey,
    });
    this.assertCurrent(index, indexGeneration, options);
    return buildSnapshot({
      baseSession: indexedBase,
      indexGeneration,
      sessions: component.nodes.flatMap((node) => node.session ? [node.session] : []),
      component,
      inventoryByCacheKey,
      evidenceByIdentityKey,
      loadPartial: metadataPartial || loadPartial,
      getPresentationState: this.getPresentationState,
    });
  }

  public resolveTarget(
    snapshot: CodexForkNavigationSnapshot,
    activeSessionCacheKey: string,
    groupId: string,
    choiceId: string,
    occurrenceId: string,
    activeChatMessageIndex?: number,
  ): ResolvedCodexForkNavigationTarget | undefined {
    if (
      snapshot.source !== "codex" ||
      snapshot.indexGeneration !== this.historyService.getIndexGeneration()
    ) {
      return undefined;
    }
    const index = this.historyService.getIndex();
    const activeSession = index.byCacheKey.get(activeSessionCacheKey);
    if (
      !activeSession ||
      activeSession.source !== "codex" ||
      !snapshot.sessions.some((session) => session.identityKey === activeSession.identityKey)
    ) {
      return undefined;
    }
    const target = resolveCodexForkNavigationTarget(
      snapshot,
      activeSessionCacheKey,
      groupId,
      choiceId,
      occurrenceId,
      activeChatMessageIndex,
    );
    if (!target) return undefined;
    const session = index.byCacheKey.get(target.sessionCacheKey);
    if (!session || session.identityKey !== target.sessionIdentityKey || session.source !== "codex") {
      return undefined;
    }
    return { target, session };
  }

  public async validateTarget(
    snapshot: CodexForkNavigationSnapshot,
    activeSessionCacheKey: string,
    groupId: string,
    choiceId: string,
    occurrenceId: string,
    activeChatMessageIndex?: number,
  ): Promise<ResolvedCodexForkNavigationTarget | undefined> {
    const generation = this.historyService.getIndexGeneration();
    const resolved = this.resolveTarget(
      snapshot,
      activeSessionCacheKey,
      groupId,
      choiceId,
      occurrenceId,
      activeChatMessageIndex,
    );
    if (!resolved) return undefined;
    const expected = snapshot.inventoryByCacheKey.get(resolved.target.sessionCacheKey);
    if (!expected || expected.signature !== resolved.target.inventorySignature) return undefined;
    if (!await this.validateSnapshotInventory(snapshot)) return undefined;
    if (
      generation !== this.historyService.getIndexGeneration() ||
      snapshot.indexGeneration !== generation
    ) {
      return undefined;
    }
    return resolved;
  }

  private async validateSnapshotInventory(
    snapshot: CodexForkNavigationSnapshot,
  ): Promise<boolean> {
    const index = this.historyService.getIndex();
    const sessionByCacheKey = new Map(
      snapshot.sessions.map((session) => [session.cacheKey, session]),
    );
    const entries = Array.from(snapshot.inventoryByCacheKey.values());
    const valid = await mapWithConcurrency(entries, LOAD_CONCURRENCY, async (expected) => {
      const captured = sessionByCacheKey.get(expected.cacheKey);
      const currentSession = index.byCacheKey.get(expected.cacheKey);
      if (
        !captured ||
        !currentSession ||
        currentSession.source !== "codex" ||
        currentSession.identityKey !== captured.identityKey ||
        currentSession.fsPath !== captured.fsPath
      ) {
        return false;
      }
      try {
        const current = await this.statFile(currentSession.fsPath);
        return (
          buildInventorySignature(expected.cacheKey, current.mtimeMs, current.size) ===
          expected.signature
        );
      } catch {
        return false;
      }
    });
    return valid.every(Boolean);
  }

  private async loadSessionEvidence(
    session: SessionSummary,
    options: LoadCodexForkNavigationOptions,
  ): Promise<EvidenceLoadResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (options.shouldContinue?.() === false) throw new CodexForkNavigationSupersededError();
      let before: { mtimeMs: number; size: number };
      try {
        before = await this.statFile(session.fsPath);
      } catch {
        return { session, cacheHit: false, rebuilt: false, failed: true };
      }
      if (
        !Number.isFinite(before.mtimeMs) ||
        before.mtimeMs < 0 ||
        !Number.isSafeInteger(before.size) ||
        before.size < 0
      ) {
        return { session, cacheHit: false, rebuilt: false, failed: true };
      }
      const signature = buildInventorySignature(session.cacheKey, before.mtimeMs, before.size);
      if (before.size > MAX_SESSION_FILE_SIZE) {
        return {
          session,
          inventory: {
            cacheKey: session.cacheKey,
            mtimeMs: before.mtimeMs,
            size: before.size,
            signature,
          },
          cacheHit: false,
          rebuilt: false,
          failed: true,
        };
      }
      const cached = this.takeCachedEvidence(signature);
      if (cached) {
        return {
          session,
          inventory: {
            cacheKey: session.cacheKey,
            mtimeMs: before.mtimeMs,
            size: before.size,
            signature,
          },
          evidence: cached,
          cacheHit: true,
          rebuilt: false,
          failed: false,
        };
      }

      let model: ChatSessionModel | undefined;
      let buildFailed = false;
      try {
        model = await this.buildChatModel(session.fsPath);
      } catch {
        buildFailed = true;
      }
      if (options.shouldContinue?.() === false) throw new CodexForkNavigationSupersededError();
      let after: { mtimeMs: number; size: number };
      try {
        after = await this.statFile(session.fsPath);
      } catch {
        throw new CodexForkNavigationSupersededError();
      }
      const afterSignature = buildInventorySignature(session.cacheKey, after.mtimeMs, after.size);
      if (afterSignature !== signature) {
        if (attempt === 0) continue;
        throw new CodexForkNavigationSupersededError();
      }
      const inventory: CodexForkFileInventoryEntry = {
        cacheKey: session.cacheKey,
        mtimeMs: after.mtimeMs,
        size: after.size,
        signature,
      };
      if (buildFailed || !model) {
        return {
          session,
          inventory,
          cacheHit: false,
          rebuilt: true,
          failed: true,
        };
      }
      const evidence = buildCodexForkSessionEvidence(model.items);
      this.storeCachedEvidence(session.cacheKey, signature, evidence);
      return {
        session,
        inventory,
        evidence,
        cacheHit: false,
        rebuilt: true,
        failed: false,
      };
    }
    return { session, cacheHit: false, rebuilt: false, failed: true };
  }

  private async verifyInventory(
    sessions: readonly SessionSummary[],
    inventoryByCacheKey: ReadonlyMap<string, CodexForkFileInventoryEntry>,
    capturedIndex: ReturnType<CodexForkHistoryInventory["getIndex"]>,
    capturedGeneration: number,
    options: LoadCodexForkNavigationOptions,
  ): Promise<void> {
    await mapWithConcurrency(sessions, LOAD_CONCURRENCY, async (session) => {
      const expected = inventoryByCacheKey.get(session.cacheKey);
      if (!expected) return;
      let current: { mtimeMs: number; size: number };
      try {
        current = await this.statFile(session.fsPath);
      } catch {
        throw new CodexForkNavigationSupersededError();
      }
      if (
        buildInventorySignature(session.cacheKey, current.mtimeMs, current.size) !==
        expected.signature
      ) {
        throw new CodexForkNavigationSupersededError();
      }
    });
    this.assertCurrent(capturedIndex, capturedGeneration, options);
  }

  private takeCachedEvidence(signature: string): CodexForkSessionEvidence | undefined {
    const cached = this.evidenceCache.get(signature);
    if (!cached) return undefined;
    this.evidenceCache.delete(signature);
    this.evidenceCache.set(signature, cached);
    return cached.evidence;
  }

  private storeCachedEvidence(
    cacheKey: string,
    signature: string,
    evidence: CodexForkSessionEvidence,
  ): void {
    for (const [key, cached] of this.evidenceCache) {
      if (cached.cacheKey === cacheKey && key !== signature) this.evidenceCache.delete(key);
    }
    this.evidenceCache.delete(signature);
    this.evidenceCache.set(signature, { cacheKey, signature, evidence });
    this.pruneEvidenceCache();
  }

  private pruneEvidenceCache(): void {
    let messageCount = Array.from(this.evidenceCache.values()).reduce(
      (total, cached) => total + cached.evidence.messages.length,
      0,
    );
    while (
      this.evidenceCache.size > MAX_EVIDENCE_CACHE_ENTRIES ||
      messageCount > MAX_EVIDENCE_CACHE_MESSAGES
    ) {
      const oldest = this.evidenceCache.entries().next().value as
        | [string, EvidenceCacheEntry]
        | undefined;
      if (!oldest) break;
      this.evidenceCache.delete(oldest[0]);
      messageCount -= oldest[1].evidence.messages.length;
    }
  }

  private assertCurrent(
    capturedIndex: ReturnType<CodexForkHistoryInventory["getIndex"]>,
    capturedGeneration: number,
    options: LoadCodexForkNavigationOptions,
  ): void {
    if (
      options.shouldContinue?.() === false ||
      capturedIndex !== this.historyService.getIndex() ||
      capturedGeneration !== this.historyService.getIndexGeneration()
    ) {
      throw new CodexForkNavigationSupersededError();
    }
  }
}

export function buildCodexForkChatBranchNavigationModel(
  snapshot: CodexForkNavigationSnapshot,
  activeSessionCacheKey: string,
  generation: number,
  validUserMessageIndexes?: ReadonlySet<number>,
  activeChatMessageIndex?: number,
): ClaudeChatBranchNavigationModel {
  const title = resolveSessionTitle(snapshot, activeSessionCacheKey);
  const activeSession = getGroupLookup(snapshot).sessionByCacheKey.get(activeSessionCacheKey);
  if (!activeSession) return emptyChatNavigation(snapshot, generation, title);
  const component = collectNavigableComponent(snapshot, activeSession.identityKey);
  const groups: ClaudeChatBranchGroup[] = [];
  for (const group of component.groups) {
    if (groups.length >= MAX_CHAT_BRANCH_GROUPS) break;
    const currentChoiceIndex = resolveCurrentChoiceIndex(
      snapshot,
      group,
      activeSession.identityKey,
      activeChatMessageIndex,
    );
    if (currentChoiceIndex < 0) continue;
    const activeOccurrence = group.choices[currentChoiceIndex]?.occurrence;
    if (!activeOccurrence || activeOccurrence.branchStart.chatMessageIndex < 1) continue;
    if (
      validUserMessageIndexes &&
      (
        activeOccurrence.branchStart.role !== "user" ||
        !validUserMessageIndexes.has(activeOccurrence.branchStart.chatMessageIndex)
      )
    ) {
      continue;
    }
    const indexes = controlChoiceIndexes(group.choices.length, currentChoiceIndex, MAX_CONTROL_CHOICES);
    groups.push({
      id: group.id,
      anchorChatMessageIndex: activeOccurrence.branchStart.chatMessageIndex,
      currentChoiceIndex,
      choiceCount: group.choices.length,
      choices: indexes.map((choiceIndex) =>
        buildChoiceView(snapshot, group.choices[choiceIndex]!, choiceIndex, currentChoiceIndex)
      ),
    });
  }
  return {
    version: 3,
    generation,
    groupCount: component.groups.length,
    groups,
    overlay: buildCodexForkBranchOverlayPage(snapshot, activeSessionCacheKey, generation, {
      activeChatMessageIndex,
    }),
  };
}

export function buildCodexForkBranchOverlayPage(
  snapshot: CodexForkNavigationSnapshot,
  activeSessionCacheKey: string,
  generation: number,
  options: CodexForkOverlayPageOptions = {},
): ClaudeBranchOverlayPageModel {
  void generation;
  const title = resolveSessionTitle(snapshot, activeSessionCacheKey);
  const activeSession = getGroupLookup(snapshot).sessionByCacheKey.get(activeSessionCacheKey);
  if (!activeSession) return emptyOverlay(snapshot, title);
  const component = collectNavigableComponent(snapshot, activeSession.identityKey);
  const allGroups = component.groups;
  const currentGroupId =
    options.focusGroupId && allGroups.some((group) => group.id === options.focusGroupId)
      ? options.focusGroupId
      : resolveCurrentGroupId(
          snapshot,
          allGroups,
          activeSession.identityKey,
          options.activeChatMessageIndex,
        );
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
    groups: pageGroups.map((group) =>
      buildOverlayGroup(
        snapshot,
        group,
        activeSession.identityKey,
        undefined,
        undefined,
        options.activeChatMessageIndex,
      )
    ),
    totalGroupCount: allGroups.length,
    routeCount: component.sessionIdentityKeys.size,
    currentGroupId,
    ...(offset > 0
      ? {
          previousCursor: encodeCursor(
            snapshot,
            "group",
            Math.max(0, offset - GROUP_PAGE_SIZE),
            "tree",
          ),
        }
      : {}),
    ...(offset + pageGroups.length < allGroups.length
      ? {
          nextCursor: encodeCursor(
            snapshot,
            "group",
            offset + pageGroups.length,
            "tree",
          ),
        }
      : {}),
    previousGroupCount: offset,
    nextGroupCount: Math.max(0, allGroups.length - offset - pageGroups.length),
    relationPartial: snapshot.relationPartial,
    navigationIncomplete:
      snapshot.component.hasSupportedRelation &&
      allGroups.length === 0,
  };
}

export function buildCodexForkBranchChoicePage(
  snapshot: CodexForkNavigationSnapshot,
  activeSessionCacheKey: string,
  groupId: string,
  cursor: string,
  activeChatMessageIndex?: number,
): ClaudeBranchOverlayGroup | null {
  const activeSession = getGroupLookup(snapshot).sessionByCacheKey.get(activeSessionCacheKey);
  if (!activeSession) return null;
  const group = collectNavigableComponent(
    snapshot,
    activeSession.identityKey,
  ).groups.find((candidate) => candidate.id === groupId);
  if (!group) return null;
  const offset = decodeCursor(snapshot, cursor, "choice", group.id);
  if (offset === null) return null;
  return buildOverlayGroup(
    snapshot,
    group,
    activeSession.identityKey,
    offset,
    CHOICE_PAGE_SIZE,
    activeChatMessageIndex,
  );
}

export function isCodexForkTargetInActiveLineage(
  snapshot: CodexForkNavigationSnapshot,
  activeSessionCacheKey: string,
  groupId: string,
  choiceId: string,
  occurrenceId: string,
  activeChatMessageIndex?: number,
): boolean {
  return Boolean(
    resolveCodexForkNavigationTarget(
      snapshot,
      activeSessionCacheKey,
      groupId,
      choiceId,
      occurrenceId,
      activeChatMessageIndex,
    ),
  );
}

export function resolveCodexForkNavigationTarget(
  snapshot: CodexForkNavigationSnapshot,
  activeSessionCacheKey: string,
  groupId: string,
  choiceId: string,
  occurrenceId: string,
  activeChatMessageIndex?: number,
): CodexForkNavigationTarget | undefined {
  void activeChatMessageIndex;
  if (snapshot.source !== "codex") return undefined;
  const lookup = getGroupLookup(snapshot);
  const activeSession = lookup.sessionByCacheKey.get(activeSessionCacheKey);
  if (!activeSession) return undefined;
  const group = collectNavigableComponent(
    snapshot,
    activeSession.identityKey,
  ).groups.find((candidate) => candidate.id === groupId);
  if (!group) return undefined;
  const choice = group.choices.find((candidate) => candidate.id === choiceId);
  if (!choice || choice.occurrence.id !== occurrenceId) return undefined;
  const target = snapshot.targetById.get(occurrenceId);
  if (
    !target ||
    target.id !== occurrenceId ||
    target.sessionIdentityKey !== choice.occurrence.sessionIdentityKey ||
    target.sessionCacheKey !== choice.occurrence.sessionCacheKey ||
    target.chatMessageIndex !== choice.occurrence.branchStart.chatMessageIndex ||
    target.role !== choice.occurrence.branchStart.role
  ) {
    return undefined;
  }
  return target;
}

function buildSnapshot(input: {
  baseSession: SessionSummary;
  indexGeneration: number;
  sessions: readonly SessionSummary[];
  component: CodexForkNavigationSnapshot["component"];
  inventoryByCacheKey: ReadonlyMap<string, CodexForkFileInventoryEntry>;
  evidenceByIdentityKey: ReadonlyMap<string, CodexForkSessionEvidence>;
  loadPartial: boolean;
  getPresentationState?: (
    session: SessionSummary,
    branchStart: ClaudeBranchMessageAnchor,
  ) => CodexForkPresentationState;
}): CodexForkNavigationSnapshot {
  const inventoryFingerprint = buildInventoryFingerprint(
    input.sessions,
    input.inventoryByCacheKey,
  );
  const presentation = buildPresentation(
    input.component,
    input.sessions,
    input.inventoryByCacheKey,
    input.evidenceByIdentityKey,
    input.getPresentationState ?? emptyPresentationState,
  );
  const fingerprint = `cf${CODEX_FORK_NAVIGATION_ALGORITHM_VERSION}:${input.indexGeneration}:${inventoryFingerprint}:${stableTextSha256(
    presentation.groups.map((group) =>
      `${group.id}\u0000${group.choices.map((choice) => [
        choice.id,
        choice.occurrence.isBookmarked ? "1" : "0",
        choice.occurrence.hasTags ? "1" : "0",
        choice.occurrence.hasNote ? "1" : "0",
      ].join("\u0000")).join("\u0001")}`
    ).join("\u0002"),
  ).slice(0, 32)}`;
  return {
    source: "codex",
    baseSessionCacheKey: input.baseSession.cacheKey,
    baseSessionIdentityKey: input.baseSession.identityKey,
    indexGeneration: input.indexGeneration,
    inventoryFingerprint,
    fingerprint,
    cursorSalt: opaqueId(`cursor\u0000${fingerprint}`),
    sessions: [...input.sessions],
    component: input.component,
    relationPartial:
      input.loadPartial ||
      input.component.relationPartial ||
      presentation.partial,
    groups: presentation.groups,
    inventoryByCacheKey: new Map(input.inventoryByCacheKey),
    targetById: presentation.targetById,
  };
}

function buildEmptySnapshot(
  baseSession: SessionSummary,
  indexGeneration: number,
): CodexForkNavigationSnapshot {
  const component = new CodexForkRelationService().build({
    sessions: [baseSession],
    currentSessionCacheKey: baseSession.cacheKey,
  });
  return buildSnapshot({
    baseSession,
    indexGeneration,
    sessions: [baseSession],
    component,
    inventoryByCacheKey: new Map(),
    evidenceByIdentityKey: new Map(),
    loadPartial: false,
    getPresentationState: emptyPresentationState,
  });
}

function buildMetadataIncompleteSnapshot(
  baseSession: SessionSummary,
  indexGeneration: number,
): CodexForkNavigationSnapshot {
  const component = new CodexForkRelationService().build({
    sessions: [],
    currentSessionCacheKey: baseSession.cacheKey,
  });
  return buildSnapshot({
    baseSession,
    indexGeneration,
    sessions: [baseSession],
    component,
    inventoryByCacheKey: new Map(),
    evidenceByIdentityKey: new Map(),
    loadPartial: true,
    getPresentationState: emptyPresentationState,
  });
}

function buildPresentation(
  component: CodexForkNavigationSnapshot["component"],
  sessions: readonly SessionSummary[],
  inventoryByCacheKey: ReadonlyMap<string, CodexForkFileInventoryEntry>,
  evidenceByIdentityKey: ReadonlyMap<string, CodexForkSessionEvidence>,
  getPresentationState: (
    session: SessionSummary,
    branchStart: ClaudeBranchMessageAnchor,
  ) => CodexForkPresentationState,
): PresentationBuildResult {
  const sessionByIdentity = new Map(sessions.map((session) => [session.identityKey, session]));
  const anchoredEdges = component.edges.filter(
    (edge): edge is CodexForkRelationEdge & {
      parentIdentityKey: string;
      anchor: NonNullable<CodexForkRelationEdge["anchor"]>;
    } =>
      edge.status === "resolved" &&
      Boolean(edge.parentIdentityKey) &&
      Boolean(edge.anchor) &&
      !edge.anchorIncomplete,
  );
  const groupByKey = new Map<string, MutablePresentationGroup>();
  for (const edge of anchoredEdges) {
    const parent = sessionByIdentity.get(edge.parentIdentityKey);
    const child = sessionByIdentity.get(edge.childIdentityKey);
    if (!parent || !child) continue;
    const key = [
      parent.identityKey,
      edge.anchor.parent.role,
      String(edge.anchor.parent.chatMessageIndex),
    ].join("\u0000");
    let group = groupByKey.get(key);
    if (!group) {
      const id = opaqueId(`group\u0000${key}`);
      group = {
        id,
        parentSessionIdentityKey: parent.identityKey,
        parentAnchor: toDisplayAnchor(edge.anchor.parent),
        anchorMessageIndex: edge.anchor.parent.chatMessageIndex,
        childEdges: [],
        choices: [],
      };
      groupByKey.set(key, group);
    }
    group.childEdges.push(edge);
  }

  const targetById = new Map<string, CodexForkNavigationTarget>();
  const mutableGroups = Array.from(groupByKey.values());
  for (const group of mutableGroups) {
    const parent = sessionByIdentity.get(group.parentSessionIdentityKey);
    const firstEdge = group.childEdges[0];
    if (!parent || !firstEdge?.anchor) continue;
    const parentStart = firstEdge.anchor.parentContinuation ?? firstEdge.anchor.parent;
    const parentChoice = buildPresentationChoice({
      groupId: group.id,
      kind: "parentContinuation",
      session: parent,
      preBranch: firstEdge.anchor.parent,
      branchStart: parentStart,
      inventory: inventoryByCacheKey.get(parent.cacheKey),
      evidence: evidenceByIdentityKey.get(parent.identityKey),
      targetById,
      getPresentationState,
    });
    if (parentChoice) group.choices.push(parentChoice);

    const childEdges = group.childEdges.slice().sort((left, right) => {
      const leftSession = sessionByIdentity.get(left.childIdentityKey);
      const rightSession = sessionByIdentity.get(right.childIdentityKey);
      return compareSessions(leftSession, rightSession);
    });
    for (const edge of childEdges) {
      const child = sessionByIdentity.get(edge.childIdentityKey);
      if (!child || !edge.anchor) continue;
      const childStart = edge.anchor.childBranchStart ?? edge.anchor.child;
      const choice = buildPresentationChoice({
        groupId: group.id,
        kind: "child",
        session: child,
        preBranch: edge.anchor.child,
        branchStart: childStart,
        inventory: inventoryByCacheKey.get(child.cacheKey),
        evidence: evidenceByIdentityKey.get(child.identityKey),
        targetById,
        getPresentationState,
      });
      if (choice) group.choices.push(choice);
    }
  }

  const hasIncompleteChoices = mutableGroups.some((group) => {
    const parentChoiceCount = group.choices.filter(
      (choice) => choice.kind === "parentContinuation",
    ).length;
    const childChoiceCount = group.choices.length - parentChoiceCount;
    return parentChoiceCount !== 1 || childChoiceCount !== group.childEdges.length;
  });
  const usableGroups = mutableGroups.filter(
    (group) =>
      group.choices.some((choice) => choice.kind === "parentContinuation") &&
      group.choices.some((choice) => choice.kind === "child"),
  );
  const groupsByParentIdentity = new Map<string, MutablePresentationGroup[]>();
  for (const group of usableGroups) {
    const current = groupsByParentIdentity.get(group.parentSessionIdentityKey);
    if (current) current.push(group);
    else groupsByParentIdentity.set(group.parentSessionIdentityKey, [group]);
  }
  for (const groups of groupsByParentIdentity.values()) {
    groups.sort(compareMutableGroups);
  }
  const childChoiceOwner = new Map<string, { groupId: string; choiceId: string }>();
  for (const group of usableGroups) {
    for (const choice of group.choices) {
      if (choice.kind === "child") {
        childChoiceOwner.set(choice.sessionIdentityKey, {
          groupId: group.id,
          choiceId: choice.id,
        });
      }
    }
  }
  for (const groups of groupsByParentIdentity.values()) {
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index]!;
      const previous = groups[index - 1];
      if (previous) {
        group.parentGroupId = previous.id;
        group.parentChoiceId = previous.choices.find(
          (choice) => choice.kind === "parentContinuation",
        )?.id;
        continue;
      }
      const owner = childChoiceOwner.get(group.parentSessionIdentityKey);
      if (owner) {
        group.parentGroupId = owner.groupId;
        group.parentChoiceId = owner.choiceId;
      }
    }
  }

  const orderedGroups = orderPresentationGroups(usableGroups)
    .slice(0, MAX_CHAT_BRANCH_GROUPS)
    .map((group): CodexForkPresentationGroup => ({
      id: group.id,
      parentSessionIdentityKey: group.parentSessionIdentityKey,
      parentAnchor: group.parentAnchor,
      anchorMessageIndex: group.anchorMessageIndex,
      ...(group.parentGroupId ? { parentGroupId: group.parentGroupId } : {}),
      ...(group.parentChoiceId ? { parentChoiceId: group.parentChoiceId } : {}),
      choices: group.choices,
    }));
  const retainedGroupIds = new Set(orderedGroups.map((group) => group.id));
  const retainedTargetIds = new Set(
    orderedGroups.flatMap((group) =>
      group.choices.map((choice) => choice.occurrence.id)
    ),
  );
  for (const [targetId] of targetById) {
    if (!retainedTargetIds.has(targetId)) targetById.delete(targetId);
  }
  return {
    groups: orderedGroups.map((group) => ({
      ...group,
      ...(group.parentGroupId && retainedGroupIds.has(group.parentGroupId)
        ? {}
        : { parentGroupId: undefined, parentChoiceId: undefined }),
    })),
    targetById,
    partial:
      anchoredEdges.length !== component.forkCount ||
      hasIncompleteChoices ||
      usableGroups.length !== mutableGroups.length ||
      usableGroups.length > orderedGroups.length,
  };
}

function buildPresentationChoice(input: {
  groupId: string;
  kind: CodexForkPresentationChoice["kind"];
  session: SessionSummary;
  preBranch: ClaudeBranchMessageAnchor;
  branchStart: ClaudeBranchMessageAnchor;
  inventory?: CodexForkFileInventoryEntry;
  evidence?: CodexForkSessionEvidence;
  targetById: Map<string, CodexForkNavigationTarget>;
  getPresentationState: (
    session: SessionSummary,
    branchStart: ClaudeBranchMessageAnchor,
  ) => CodexForkPresentationState;
}): CodexForkPresentationChoice | undefined {
  if (!input.inventory || input.branchStart.chatMessageIndex < 1) return undefined;
  const choiceId = opaqueId(
    [
      input.groupId,
      input.kind,
      input.session.identityKey,
      String(input.branchStart.chatMessageIndex),
    ].join("\u0000"),
  );
  const occurrenceId = stableTextSha256(`occurrence\u0000${choiceId}`);
  const first = input.evidence?.messages[0];
  const last = input.evidence?.truncated
    ? undefined
    : input.evidence?.messages.at(-1);
  const presentationState = safePresentationState(
    input.getPresentationState,
    input.session,
    input.branchStart,
  );
  const occurrence: CodexForkPresentationOccurrence = {
    id: occurrenceId,
    sessionIdentityKey: input.session.identityKey,
    sessionCacheKey: input.session.cacheKey,
    ...(first ? { historyFirst: toDisplayAnchor(first) } : {}),
    preBranch: toDisplayAnchor(input.preBranch),
    branchStart: toDisplayAnchor(input.branchStart),
    ...(last ? { historyEnd: toDisplayAnchor(last) } : {}),
    ...presentationState,
  };
  input.targetById.set(occurrenceId, {
    id: occurrenceId,
    sessionCacheKey: input.session.cacheKey,
    sessionIdentityKey: input.session.identityKey,
    chatMessageIndex: occurrence.branchStart.chatMessageIndex,
    role: occurrence.branchStart.role,
    inventorySignature: input.inventory.signature,
  });
  return {
    id: choiceId,
    kind: input.kind,
    sessionIdentityKey: input.session.identityKey,
    preview:
      occurrence.branchStart.preview?.trim() ||
      input.session.displayTitle.trim(),
    occurrence,
  };
}

function orderPresentationGroups(
  groups: readonly MutablePresentationGroup[],
): MutablePresentationGroup[] {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const childrenByParentId = new Map<string, MutablePresentationGroup[]>();
  const roots: MutablePresentationGroup[] = [];
  for (const group of groups) {
    if (group.parentGroupId && byId.has(group.parentGroupId)) {
      const children = childrenByParentId.get(group.parentGroupId);
      if (children) children.push(group);
      else childrenByParentId.set(group.parentGroupId, [group]);
    } else {
      roots.push(group);
    }
  }
  roots.sort(compareMutableGroups);
  for (const children of childrenByParentId.values()) children.sort(compareMutableGroups);
  const result: MutablePresentationGroup[] = [];
  const seen = new Set<string>();
  const visit = (root: MutablePresentationGroup): void => {
    const stack = [root];
    while (stack.length > 0) {
      const group = stack.pop()!;
      if (seen.has(group.id)) continue;
      seen.add(group.id);
      result.push(group);
      const children = childrenByParentId.get(group.id) ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push(children[index]!);
      }
    }
  };
  for (const root of roots) visit(root);
  for (const group of groups.slice().sort(compareMutableGroups)) visit(group);
  return result;
}

function buildOverlayGroup(
  snapshot: CodexForkNavigationSnapshot,
  group: CodexForkPresentationGroup,
  activeSessionIdentityKey: string,
  requestedChoiceOffset?: number,
  requestedChoicePageSize?: number,
  activeChatMessageIndex?: number,
): ClaudeBranchOverlayGroup {
  const currentChoiceIndex = resolveCurrentChoiceIndex(
    snapshot,
    group,
    activeSessionIdentityKey,
    activeChatMessageIndex,
  );
  const pageSize = requestedChoicePageSize ?? INITIAL_CHOICE_PAGE_SIZE;
  const initialOffset = currentChoiceIndex >= 0
    ? Math.max(0, currentChoiceIndex - Math.floor(pageSize / 2))
    : 0;
  const offset = requestedChoiceOffset === undefined
    ? clampWindowPageOffset(initialOffset, group.choices.length, pageSize)
    : clampCursorPageOffset(requestedChoiceOffset, group.choices.length);
  const choices = group.choices.slice(offset, offset + pageSize).map((choice, index) =>
    buildChoiceView(snapshot, choice, offset + index, currentChoiceIndex)
  );
  return {
    id: group.id,
    groupIndex: Math.max(0, snapshot.groups.indexOf(group)),
    ...(group.parentGroupId ? { parentGroupId: group.parentGroupId } : {}),
    ...(group.parentChoiceId ? { parentChoiceId: group.parentChoiceId } : {}),
    choiceCount: group.choices.length,
    currentChoiceIndex,
    activeLineage: currentChoiceIndex >= 0,
    ...buildCommonRange(snapshot, group, currentChoiceIndex),
    choices,
    ...(offset > 0
      ? {
          previousChoiceCursor: encodeCursor(
            snapshot,
            "choice",
            Math.max(0, offset - CHOICE_PAGE_SIZE),
            group.id,
          ),
        }
      : {}),
    ...(offset + choices.length < group.choices.length
      ? {
          nextChoiceCursor: encodeCursor(
            snapshot,
            "choice",
            offset + choices.length,
            group.id,
          ),
        }
      : {}),
    previousChoiceCount: offset,
    nextChoiceCount: Math.max(0, group.choices.length - offset - choices.length),
  };
}

function buildChoiceView(
  snapshot: CodexForkNavigationSnapshot,
  choice: CodexForkPresentationChoice,
  choiceIndex: number,
  currentChoiceIndex: number,
): ClaudeChatBranchChoice {
  const session = getGroupLookup(snapshot).sessionByIdentity.get(choice.sessionIdentityKey);
  const source = choice.occurrence;
  const occurrence: ClaudeBranchOccurrenceOption = {
    id: source.id,
    sessionLabel: session?.displayTitle.trim() ?? "",
    isCurrent: choiceIndex === currentChoiceIndex,
    ...(source.historyFirst ? { historyFirst: source.historyFirst } : {}),
    ...(source.preBranch ? { preBranch: source.preBranch } : {}),
    branchStart: source.branchStart,
    ...(source.historyEnd ? { historyEnd: source.historyEnd } : {}),
    isBookmarked: source.isBookmarked,
    hasTags: source.hasTags,
    hasNote: source.hasNote,
  };
  return {
    id: choice.id,
    choiceIndex,
    preview: choice.preview,
    occurrenceCount: 1,
    occurrences: [occurrence],
  };
}

function buildCommonRange(
  snapshot: CodexForkNavigationSnapshot,
  group: CodexForkPresentationGroup,
  currentChoiceIndex: number,
): { commonRange?: ClaudeBranchCommonRange } {
  void snapshot;
  const occurrences = group.choices.map((choice) => choice.occurrence);
  const first = occurrences.map((occurrence) => occurrence.historyFirst);
  const last = occurrences.map((occurrence) => occurrence.preBranch);
  if (!anchorsShareRoleAndIndex(first) || !anchorsShareRoleAndIndex(last)) return {};
  const preferred = occurrences[currentChoiceIndex >= 0 ? currentChoiceIndex : 0]!;
  return {
    commonRange: {
      first: preferred.historyFirst ?? first[0]!,
      last: preferred.preBranch ?? last[0]!,
    },
  };
}

function anchorsShareRoleAndIndex(
  anchors: readonly (ClaudeBranchMessageAnchor | undefined)[],
): boolean {
  if (anchors.length === 0 || anchors.some((anchor) => !anchor)) return false;
  const first = anchors[0]!;
  return anchors.every(
    (anchor) =>
      anchor?.role === first.role &&
      anchor.chatMessageIndex === first.chatMessageIndex,
  );
}

function resolveCurrentChoiceIndex(
  snapshot: CodexForkNavigationSnapshot,
  group: CodexForkPresentationGroup,
  activeSessionIdentityKey: string,
  _activeChatMessageIndex?: number,
): number {
  if (activeSessionIdentityKey === group.parentSessionIdentityKey) {
    return group.choices.findIndex((choice) => choice.kind === "parentContinuation");
  }
  const lookup = getGroupLookup(snapshot);
  let cursor = activeSessionIdentityKey;
  let directChild = "";
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const parent = lookup.parentByChildIdentity.get(cursor);
    if (!parent) return -1;
    if (parent === group.parentSessionIdentityKey) {
      directChild = cursor;
      break;
    }
    cursor = parent;
  }
  if (!directChild) return -1;
  const directChoiceIndex = group.choices.findIndex(
    (choice) =>
      choice.kind === "child" &&
      choice.sessionIdentityKey === directChild,
  );
  if (directChoiceIndex >= 0) return directChoiceIndex;
  const directEdge = lookup.edgeByChildIdentity.get(directChild);
  if (
    directEdge?.anchor &&
    directEdge.anchor.parent.chatMessageIndex > group.anchorMessageIndex
  ) {
    return group.choices.findIndex((choice) => choice.kind === "parentContinuation");
  }
  return -1;
}

function resolveCurrentGroupId(
  snapshot: CodexForkNavigationSnapshot,
  groups: readonly CodexForkPresentationGroup[],
  activeSessionIdentityKey: string,
  activeChatMessageIndex?: number,
): string {
  if (Number.isSafeInteger(activeChatMessageIndex)) {
    const exact = groups.find((group) => {
      const choiceIndex = resolveCurrentChoiceIndex(
        snapshot,
        group,
        activeSessionIdentityKey,
        activeChatMessageIndex,
      );
      return (
        choiceIndex >= 0 &&
        group.choices[choiceIndex]?.occurrence.branchStart.chatMessageIndex ===
          activeChatMessageIndex
      );
    });
    if (exact) return exact.id;
  }
  let current = "";
  for (const group of groups) {
    const choiceIndex = resolveCurrentChoiceIndex(
      snapshot,
      group,
      activeSessionIdentityKey,
      activeChatMessageIndex,
    );
    if (choiceIndex < 0) continue;
    current = group.id;
  }
  return current;
}

function collectNavigableComponent(
  snapshot: CodexForkNavigationSnapshot,
  activeSessionIdentityKey: string,
): NavigableComponent {
  const adjacent = new Map<string, Set<string>>();
  for (const group of snapshot.groups) {
    for (const choice of group.choices) {
      if (choice.kind !== "child") continue;
      appendAdjacent(
        adjacent,
        group.parentSessionIdentityKey,
        choice.sessionIdentityKey,
      );
      appendAdjacent(
        adjacent,
        choice.sessionIdentityKey,
        group.parentSessionIdentityKey,
      );
    }
  }
  const sessionIdentityKeys = new Set<string>([activeSessionIdentityKey]);
  const queue = [activeSessionIdentityKey];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    for (const next of adjacent.get(current) ?? []) {
      if (sessionIdentityKeys.has(next)) continue;
      sessionIdentityKeys.add(next);
      queue.push(next);
    }
  }
  return {
    groups: snapshot.groups.filter(
      (group) => sessionIdentityKeys.has(group.parentSessionIdentityKey),
    ),
    sessionIdentityKeys,
  };
}

function appendAdjacent(
  adjacent: Map<string, Set<string>>,
  from: string,
  to: string,
): void {
  const values = adjacent.get(from);
  if (values) values.add(to);
  else adjacent.set(from, new Set([to]));
}

function getGroupLookup(snapshot: CodexForkNavigationSnapshot): GroupLookup {
  const cached = groupLookupCache.get(snapshot);
  if (cached) return cached;
  const parentByChildIdentity = new Map<string, string>();
  const edgeByChildIdentity = new Map<string, CodexForkRelationEdge>();
  for (const edge of snapshot.component.edges) {
    edgeByChildIdentity.set(edge.childIdentityKey, edge);
    if (edge.status === "resolved" && edge.parentIdentityKey) {
      parentByChildIdentity.set(edge.childIdentityKey, edge.parentIdentityKey);
    }
  }
  const lookup: GroupLookup = {
    parentByChildIdentity,
    edgeByChildIdentity,
    sessionByIdentity: new Map(snapshot.sessions.map((session) => [session.identityKey, session])),
    sessionByCacheKey: new Map(snapshot.sessions.map((session) => [session.cacheKey, session])),
  };
  groupLookupCache.set(snapshot, lookup);
  return lookup;
}

function resolveSessionTitle(
  snapshot: CodexForkNavigationSnapshot,
  cacheKey: string,
): string {
  return getGroupLookup(snapshot).sessionByCacheKey.get(cacheKey)?.displayTitle.trim() ?? "";
}

function emptyChatNavigation(
  snapshot: CodexForkNavigationSnapshot,
  generation: number,
  title: string,
): ClaudeChatBranchNavigationModel {
  return {
    version: 3,
    generation,
    groupCount: 0,
    groups: [],
    overlay: emptyOverlay(snapshot, title),
  };
}

function emptyOverlay(
  snapshot: CodexForkNavigationSnapshot,
  title: string,
): ClaudeBranchOverlayPageModel {
  return {
    title,
    groups: [],
    totalGroupCount: 0,
    routeCount: snapshot.component.sessionCount,
    currentGroupId: "",
    previousGroupCount: 0,
    nextGroupCount: 0,
    relationPartial: snapshot.relationPartial,
    navigationIncomplete:
      snapshot.component.hasSupportedRelation &&
      snapshot.groups.length === 0,
  };
}

function toDisplayAnchor(
  anchor: {
    role: "user" | "assistant";
    chatMessageIndex: number;
    timestampIso?: string;
    preview?: string;
  },
): ClaudeBranchMessageAnchor {
  return {
    role: anchor.role,
    chatMessageIndex: anchor.chatMessageIndex,
    ...(anchor.timestampIso ? { timestampIso: anchor.timestampIso } : {}),
    ...(anchor.preview ? { preview: anchor.preview } : {}),
  };
}

function controlChoiceIndexes(
  choiceCount: number,
  currentChoiceIndex: number,
  limit: number,
): number[] {
  if (choiceCount <= 0) return [];
  const boundedLimit = Math.max(1, Math.min(choiceCount, Math.floor(limit)));
  if (choiceCount <= boundedLimit) {
    return Array.from({ length: choiceCount }, (_value, index) => index);
  }
  const beforeCurrent = Math.floor((boundedLimit - 1) / 2);
  return Array.from({ length: boundedLimit }, (_value, offset) =>
    (
      currentChoiceIndex -
      beforeCurrent +
      offset +
      choiceCount
    ) % choiceCount
  ).sort((left, right) => left - right);
}

function encodeCursor(
  snapshot: CodexForkNavigationSnapshot,
  kind: "group" | "choice",
  offset: number,
  scope: string,
): string {
  const boundedOffset = Math.max(0, Math.floor(offset));
  const payload = `${kind}\u0000${boundedOffset}\u0000${scope}`;
  return `${kind === "group" ? "g" : "c"}.${boundedOffset.toString(36)}.${opaqueId(
    `${snapshot.cursorSalt}\u0000${payload}`,
  )}`;
}

function decodeCursor(
  snapshot: CodexForkNavigationSnapshot,
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

function clampWindowPageOffset(
  offset: number,
  total: number,
  pageSize: number,
): number {
  if (total <= pageSize) return 0;
  return Math.max(0, Math.min(Math.floor(offset), total - pageSize));
}

function clampCursorPageOffset(offset: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(Math.floor(offset), total - 1));
}

function buildInventorySignature(
  cacheKey: string,
  mtimeMs: number,
  size: number,
): string {
  return stableTextSha256(`${cacheKey}\u0000${mtimeMs}\u0000${size}`).slice(0, 32);
}

function buildInventoryFingerprint(
  sessions: readonly SessionSummary[],
  inventoryByCacheKey: ReadonlyMap<string, CodexForkFileInventoryEntry>,
): string {
  const value = sessions
    .map((session) => {
      const inventory = inventoryByCacheKey.get(session.cacheKey);
      return inventory
        ? `${session.cacheKey}\u0000${inventory.signature}`
        : `${session.cacheKey}\u0000missing`;
    })
    .sort()
    .join("\u0001");
  return stableTextSha256(value).slice(0, 24);
}

function progressOf(
  completed: number,
  total: number,
  cacheHitCount: number,
  rebuiltCount: number,
): CodexForkNavigationLoadProgress {
  return { completed, total, cacheHitCount, rebuiltCount };
}

async function defaultStatFile(
  fsPath: string,
): Promise<{ mtimeMs: number; size: number }> {
  const result = await stat(fsPath);
  return { mtimeMs: result.mtimeMs, size: result.size };
}

async function defaultBuildChatModel(fsPath: string): Promise<ChatSessionModel> {
  return buildChatSessionModel(fsPath, {
    includeDetails: false,
    turnTimelineMode: "basic",
    images: { enabled: false, maxSizeMB: 1, thumbnailSize: "small" },
  });
}

function emptyPresentationState(): CodexForkPresentationState {
  return {
    isBookmarked: false,
    hasTags: false,
    hasNote: false,
  };
}

function safePresentationState(
  getPresentationState: (
    session: SessionSummary,
    branchStart: ClaudeBranchMessageAnchor,
  ) => CodexForkPresentationState,
  session: SessionSummary,
  branchStart: ClaudeBranchMessageAnchor,
): CodexForkPresentationState {
  try {
    const value = getPresentationState(session, toDisplayAnchor(branchStart));
    return {
      isBookmarked: value?.isBookmarked === true,
      hasTags: value?.hasTags === true,
      hasNote: value?.hasNote === true,
    };
  } catch {
    return emptyPresentationState();
  }
}

function retainEvidenceWithinBudget(
  result: EvidenceLoadResult,
  remainingMessages: number,
): EvidenceLoadResult {
  const evidence = result.evidence;
  if (!evidence || evidence.messages.length <= remainingMessages) return result;
  if (remainingMessages > 0) {
    return {
      ...result,
      evidence: {
        messages: evidence.messages.slice(0, remainingMessages),
        truncated: true,
      },
      failed: true,
    };
  }
  const { evidence: _evidence, ...withoutEvidence } = result;
  return {
    ...withoutEvidence,
    failed: true,
  };
}

function orderComponentSessionsForEvidence(
  sessions: readonly SessionSummary[],
  edges: readonly CodexForkRelationEdge[],
  currentSessionIdentityKey: string,
): SessionSummary[] {
  const adjacent = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.status !== "resolved" || !edge.parentIdentityKey) continue;
    appendAdjacent(adjacent, edge.parentIdentityKey, edge.childIdentityKey);
    appendAdjacent(adjacent, edge.childIdentityKey, edge.parentIdentityKey);
  }
  const distanceByIdentity = new Map<string, number>([
    [currentSessionIdentityKey, 0],
  ]);
  const queue = [currentSessionIdentityKey];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    const nextDistance = (distanceByIdentity.get(current) ?? 0) + 1;
    for (const next of adjacent.get(current) ?? []) {
      if (distanceByIdentity.has(next)) continue;
      distanceByIdentity.set(next, nextDistance);
      queue.push(next);
    }
  }
  return sessions.slice().sort((left, right) => {
    const distance =
      (distanceByIdentity.get(left.identityKey) ?? Number.POSITIVE_INFINITY) -
      (distanceByIdentity.get(right.identityKey) ?? Number.POSITIVE_INFINITY);
    return distance || compareSessions(left, right);
  });
}

async function mapWithConcurrency<T, TResult>(
  values: readonly T[],
  concurrency: number,
  map: (value: T, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  const result = new Array<TResult>(values.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(values.length, Math.floor(concurrency)));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      result[index] = await map(values[index]!, index);
    }
  }));
  return result;
}

function compareMutableGroups(
  left: MutablePresentationGroup,
  right: MutablePresentationGroup,
): number {
  return (
    left.parentSessionIdentityKey.localeCompare(right.parentSessionIdentityKey) ||
    left.anchorMessageIndex - right.anchorMessageIndex ||
    left.id.localeCompare(right.id)
  );
}

function compareSessions(
  left: SessionSummary | undefined,
  right: SessionSummary | undefined,
): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  const leftTime = Date.parse(left.startedAtIso ?? "");
  const rightTime = Date.parse(right.startedAtIso ?? "");
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) {
    return Number.isFinite(leftTime) ? -1 : 1;
  }
  return left.identityKey.localeCompare(right.identityKey);
}

function opaqueId(value: string): string {
  return stableTextSha256(value).slice(0, 24);
}
