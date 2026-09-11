import type * as vscode from "vscode";
import { stat } from "node:fs/promises";
import { buildChatSessionModel } from "../chat/chatModelBuilder";
import type { HistoryIndex, SessionSummary } from "../sessions/sessionTypes";
import {
  resolveCodexLogicalHistoryPlan,
  type CodexLogicalHistoryPlan,
  type CodexLogicalHistorySegment,
} from "../sessions/codexHistoryBase";
import { areCodexRolloutRevisionsRelated, compareCodexRolloutCreation, findCodexRolloutRevisionParent } from "../sessions/codexRolloutRevisions";
import { normalizeCacheKey } from "../utils/fsUtils";
import { stableTextSha256 } from "../utils/stableTextHash";
import { buildTimelineBookmarkTarget } from "./bookmarkTargetResolver";
import {
  buildBookmarkKeyFromTargetFingerprint,
  getBookmarkTargetFingerprint,
  type BookmarkEntry, type BookmarkStore, type BookmarkTarget,
} from "./bookmarkStore";
import type { ChatOpenPositionEntry, ChatOpenPositionStore } from "./chatOpenPositionStore";
import {
  isSameSessionAnnotationContent,
  normalizeSessionAnnotationTags,
  type SessionAnnotation, type SessionAnnotationStore,
} from "./sessionAnnotationStore";
import type { SessionMetadataMutationCoordinator } from "./sessionMetadataMutationCoordinator";
import { MementoSnapshotCache } from "./mementoSnapshotCache";
import type { DebugLogger } from "./logger";

const RECEIPTS_KEY = "codexHistoryViewer.codexRolloutInheritance.v1";
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

class InheritanceSupersededError extends Error {}

interface SourceMetadata {
  session: SessionSummary;
  annotation: SessionAnnotation | null;
  bookmarks: BookmarkEntry[];
  position: number | undefined;
}

interface TargetEvidence {
  target: BookmarkTarget;
  signature: string;
}

interface TimelineEvidence {
  targets: ReadonlyMap<string, TargetEvidence | null>;
  messages: ReadonlyMap<number, string | null>;
}

export interface CodexRolloutInheritanceResult {
  changed: boolean;
  pending: boolean;
  failed: boolean;
}

// Copy revision metadata once. Physical moves continue to use SessionReferenceRelocator.
export class CodexRolloutMetadataInheritance {
  private readonly receipts: MementoSnapshotCache<Map<string, string>>;
  private completedIndex?: HistoryIndex;

  constructor(
    memento: vscode.Memento,
    private readonly annotations: SessionAnnotationStore,
    private readonly bookmarks: BookmarkStore,
    private readonly positions: ChatOpenPositionStore,
    private readonly coordinator: SessionMetadataMutationCoordinator,
    private readonly logger?: DebugLogger,
  ) {
    this.receipts = new MementoSnapshotCache(memento, RECEIPTS_KEY, (raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return new Map();
      return new Map(Object.entries(raw).filter(([key, value]) =>
        HASH_PATTERN.test(key) && typeof value === "string" && HASH_PATTERN.test(value),
      ));
    });
  }

  public async reconcile(index: HistoryIndex, isCurrent: () => boolean): Promise<CodexRolloutInheritanceResult> {
    const result = { changed: false, pending: false, failed: false };
    if (!isCurrent()) return { ...result, pending: true };
    if (this.completedIndex === index) return result;
    const receiptSnapshot = this.receipts.read();
    const inventory = index.historySources ?? index.sessions;
    const pending = index.sessions.filter((session) => {
      if (session.source !== "codex") return false;
      const previous = receiptSnapshot.get(conversationKey(session));
      return (previous !== undefined || session.meta.codexHistoryBase ||
        (session.meta.codexStandaloneHistory && findCodexRolloutRevisionParent(session, inventory))) &&
        previous !== stableTextSha256(session.cacheKey);
    });
    for (const target of pending) {
      if (!isCurrent()) return { ...result, pending: true };
      try {
        const previous = receiptSnapshot.get(conversationKey(target));
        const related = inventory.filter((source) => source.cacheKey !== target.cacheKey &&
          areCodexRolloutRevisionsRelated(source, target, inventory))
          .sort((left, right) => compareCodexRolloutCreation(left, right) || right.cacheKey.localeCompare(left.cacheKey));
        // The last processed mainline is a tombstone boundary for intentionally removed metadata.
        const previousIndex = previous ? related.findIndex((source) => stableTextSha256(source.cacheKey) === previous) : -1;
        // If that boundary disappeared, preserve current metadata and establish a new boundary without copying older data.
        const sources = previous && previousIndex < 0 ? [] : previousIndex >= 0 ? related.slice(0, previousIndex + 1) : related;
        if (sources.length === 0 && !previous) continue;
        const completed = await this.inherit(target, sources, inventory, previous, isCurrent);
        result.changed ||= completed === "changed";
        result.pending ||= completed === "pending";
      } catch (error) {
        if (!(error instanceof InheritanceSupersededError)) {
          this.logger?.debug("codex rollout metadata inheritance failed");
          result.failed = true;
        }
        result.pending = true;
      }
    }
    if (!result.pending && isCurrent()) this.completedIndex = index;
    return result;
  }

  private readSource(session: SessionSummary): SourceMetadata {
    return {
      session,
      annotation: this.annotations.get(session.fsPath),
      bookmarks: this.bookmarks.getAll().filter((entry) => entry.sessionCacheKey === session.cacheKey),
      position: this.positions.get(session.fsPath),
    };
  }

  private async inherit(
    target: SessionSummary,
    sources: readonly SessionSummary[],
    inventory: readonly SessionSummary[],
    previous: string | undefined,
    isCurrent: () => boolean,
  ): Promise<"changed" | "unchanged" | "pending"> {
    const sourceMetadata = sources.map((source) => this.readSource(source));
    const initialDestination = this.readSource(target);
    const plans = new Map<string, CodexLogicalHistoryPlan>();
    const targetPlan = await snapshotPlan(target, inventory);
    if (!targetPlan.complete) return "pending";
    plans.set(target.cacheKey, targetPlan);
    const copiedBookmarks = new Map<string, BookmarkEntry>();
    let copiedPosition: number | undefined;
    let targetEvidence: TimelineEvidence | undefined;

    for (const source of sourceMetadata) {
      if (!isCurrent()) return "pending";
      if (!source.annotation && source.bookmarks.length === 0 && source.position === undefined) continue;
      const sourcePlan = await snapshotPlan(source.session, inventory);
      if (!sourcePlan.complete) return "pending";
      plans.set(source.session.cacheKey, sourcePlan);
      if (source.bookmarks.length === 0 && source.position === undefined) continue;
      const commonPlan = commonPrefixPlan(targetPlan, sourcePlan);
      if (source.position === 0 && copiedPosition === undefined) copiedPosition = 0;
      if (commonPlan.segments.length === 0) continue;
      targetEvidence ??= await scanTimeline(target, targetPlan);
      const original = await scanTimeline(source.session, sourcePlan);
      const common = await scanTimeline(source.session, { ...commonPlan, leafFsPath: source.session.fsPath });
      const commonTarget = source.session.meta.cwd === target.meta.cwd
        ? remapTimelineEvidence(common, target) : await scanTimeline(target, commonPlan);
      for (const bookmark of source.bookmarks) {
        const prefix = common.targets.get(bookmark.key);
        if (!prefix || original.targets.get(bookmark.key)?.signature !== prefix.signature) continue;
        const fingerprint = getBookmarkTargetFingerprint(prefix.target.key);
        const targetKey = fingerprint && buildBookmarkKeyFromTargetFingerprint(target.cacheKey, fingerprint.kind, fingerprint.targetHash);
        const inherited = targetKey ? commonTarget.targets.get(targetKey) : undefined;
        if (!inherited || inherited.signature !== prefix.signature ||
          targetEvidence.targets.get(inherited.target.key)?.signature !== inherited.signature) continue;
        if (!copiedBookmarks.has(inherited.target.key)) {
          copiedBookmarks.set(inherited.target.key, { ...bookmark, ...inherited.target });
        }
      }
      const position = source.position;
      if (copiedPosition === undefined && position !== undefined) {
        const signature = common.messages.get(position);
        if (signature && signature === original.messages.get(position) &&
          signature === commonTarget.messages.get(position) && signature === targetEvidence.messages.get(position)) {
          copiedPosition = position;
        }
      }
    }

    if (!isCurrent()) return "pending";
    return this.coordinator.runExclusive(async () => {
      for (const [key, plan] of plans) {
        const session = key === target.cacheKey ? target : sources.find((source) => source.cacheKey === key)!;
        if ((await snapshotPlan(session, inventory)).signature !== plan.signature) return "pending";
      }
      if (!isCurrent() || this.receipts.read().get(conversationKey(target)) !== previous ||
        sourceMetadata.some((source) => JSON.stringify(source) !== JSON.stringify(this.readSource(source.session)))) return "pending";
      const beforeAnnotations = this.annotations.getAll();
      const beforeBookmarks = this.bookmarks.getAll();
      const beforePositions = this.positions.getAll();
      const beforeReceipts = new Map(this.receipts.read());
      const destination = this.annotations.get(target.fsPath);
      // A user edit made during preparation wins over automatic inheritance, including deletion.
      const inheritedAnnotations = JSON.stringify(initialDestination.annotation) === JSON.stringify(destination)
        ? sourceMetadata.flatMap((source) => source.annotation ? [source.annotation] : []) : [];
      const nextAnnotations = beforeAnnotations.slice();
      let annotationsChanged = false;
      if (inheritedAnnotations.length > 0) {
        const note = (destination ?? inheritedAnnotations[0]!).note;
        const tags = normalizeSessionAnnotationTags([...(destination?.tags ?? []), ...inheritedAnnotations.flatMap((item) => item.tags)]);
        if (!isSameSessionAnnotationContent(destination, tags, note)) {
          const annotation: SessionAnnotation = {
            fsPath: target.fsPath,
            cacheKey: target.cacheKey,
            note,
            tags,
            updatedAt: Date.now(),
          };
          const offset = nextAnnotations.findIndex((item) => item.cacheKey === target.cacheKey);
          if (offset < 0) nextAnnotations.push(annotation);
          else nextAnnotations[offset] = annotation;
          annotationsChanged = true;
        }
      }
      const existingBookmarkKeys = new Set(beforeBookmarks.map((bookmark) => bookmark.key));
      const destinationBookmarks = beforeBookmarks.filter((bookmark) => bookmark.sessionCacheKey === target.cacheKey);
      const nextBookmarks = JSON.stringify(initialDestination.bookmarks) === JSON.stringify(destinationBookmarks)
        ? beforeBookmarks.concat(Array.from(copiedBookmarks.values()).filter((bookmark) => !existingBookmarkKeys.has(bookmark.key))) : beforeBookmarks;
      const nextPositions: ChatOpenPositionEntry[] = beforePositions.slice();
      if (copiedPosition !== undefined && initialDestination.position === undefined && this.positions.get(target.fsPath) === undefined) {
        nextPositions.push({ fsPath: target.fsPath, cacheKey: target.cacheKey, messageIndex: copiedPosition, updatedAt: Date.now() });
      }
      const bookmarksChanged = nextBookmarks.length !== beforeBookmarks.length;
      const positionsChanged = nextPositions.length !== beforePositions.length;
      const rollback: Array<() => Promise<void>> = [];
      try {
        if (annotationsChanged) {
          rollback.push(() => this.annotations.replaceAll(beforeAnnotations, { notify: false }));
          await this.annotations.replaceAll(nextAnnotations, { notify: false });
        }
        if (bookmarksChanged) {
          rollback.push(() => this.bookmarks.replaceAll(beforeBookmarks, { notify: false }));
          await this.bookmarks.replaceAll(nextBookmarks, { notify: false });
        }
        if (positionsChanged) {
          rollback.push(() => this.positions.replaceAll(beforePositions));
          await this.positions.replaceAll(nextPositions);
        }
        if (!isCurrent()) throw new InheritanceSupersededError();
        const nextReceipts = new Map(beforeReceipts).set(conversationKey(target), stableTextSha256(target.cacheKey));
        rollback.push(() => this.receipts.write(Object.fromEntries(beforeReceipts)));
        await this.receipts.write(Object.fromEntries(nextReceipts));
        if (!isCurrent()) throw new InheritanceSupersededError();
      } catch (error) {
        let rollbackFailed = false;
        for (const restore of rollback.reverse()) {
          try { await restore(); } catch {
            rollbackFailed = true;
            this.logger?.debug("codex rollout metadata rollback failed");
          }
        }
        // A failed rollback must be reported even when the original cause was a stale index.
        if (rollbackFailed) throw new Error("Codex rollout metadata rollback failed.");
        throw error;
      }
      if (annotationsChanged) this.annotations.notifyChanged();
      if (bookmarksChanged) this.bookmarks.notifyChanged();
      return annotationsChanged || bookmarksChanged || positionsChanged ? "changed" : "unchanged";
    });
  }
}

function conversationKey(session: SessionSummary): string {
  return stableTextSha256(JSON.stringify([
    session.identityKey, session.storage.rootKind, session.storage.archiveState, normalizeCacheKey(session.storage.rootPath),
  ]));
}

async function snapshotPlan(session: SessionSummary, inventory: readonly SessionSummary[]): Promise<CodexLogicalHistoryPlan> {
  const plan = await resolveCodexLogicalHistoryPlan(session.fsPath, inventory);
  if (!plan.complete) return plan;
  const segments: CodexLogicalHistorySegment[] = [];
  for (const segment of plan.segments) {
    const fileStat = await stat(segment.fsPath);
    if (!fileStat.isFile() || !Number.isSafeInteger(fileStat.size) || fileStat.size < 0 ||
      (segment.endByteOffset !== undefined && segment.endByteOffset > fileStat.size)) throw new Error("Unstable rollout metadata source.");
    if (session.meta.codexHistoryBase && (fileStat.size !== segment.size || fileStat.mtimeMs !== segment.mtimeMs)) {
      throw new Error("Unstable rollout metadata plan.");
    }
    segments.push({ ...segment, size: fileStat.size, mtimeMs: fileStat.mtimeMs });
  }
  return { ...plan, segments, signature: stableTextSha256(JSON.stringify(segments)) };
}

function commonPrefixPlan(target: CodexLogicalHistoryPlan, source: CodexLogicalHistoryPlan): CodexLogicalHistoryPlan {
  const segments: CodexLogicalHistorySegment[] = [];
  for (let index = 0; index < Math.min(target.segments.length, source.segments.length); index += 1) {
    const left = target.segments[index]!;
    const right = source.segments[index]!;
    if (left.cacheKey !== right.cacheKey) break;
    const leftEnd = left.endByteOffset ?? left.size;
    const rightEnd = right.endByteOffset ?? right.size;
    const endByteOffset = Math.min(leftEnd, rightEnd);
    if (endByteOffset > 0) segments.push({ ...left, endByteOffset, isLeaf: false });
    if (leftEnd !== rightEnd) break;
  }
  return { ...target, segments, signature: stableTextSha256(JSON.stringify(segments)) };
}

async function scanTimeline(session: SessionSummary, plan: CodexLogicalHistoryPlan): Promise<TimelineEvidence> {
  const model = await buildChatSessionModel(session.fsPath, { includeDetails: true, historyPlan: plan });
  const targets = new Map<string, TargetEvidence | null>();
  const messages = new Map<number, string | null>();
  model.items.forEach((item, index) => {
    const signature = stableTextSha256(JSON.stringify(item));
    const target = buildTimelineBookmarkTarget(session.fsPath, session.cacheKey, item, index);
    if (target) targets.set(target.key, targets.has(target.key) ? null : { target, signature });
    if (item.type === "message" && item.messageIndex !== undefined) {
      messages.set(item.messageIndex, messages.has(item.messageIndex) ? null : signature);
    }
  });
  return { targets, messages };
}

function remapTimelineEvidence(evidence: TimelineEvidence, session: SessionSummary): TimelineEvidence {
  const targets = new Map<string, TargetEvidence | null>();
  for (const [key, item] of evidence.targets) {
    const fingerprint = getBookmarkTargetFingerprint(key);
    if (!fingerprint) continue;
    const targetKey = buildBookmarkKeyFromTargetFingerprint(session.cacheKey, fingerprint.kind, fingerprint.targetHash);
    targets.set(targetKey, item ? {
      signature: item.signature,
      target: { ...item.target, key: targetKey, sessionFsPath: session.fsPath, sessionCacheKey: session.cacheKey },
    } : null);
  }
  // Codex timeline items depend on the records and cwd, not the containing JSONL path.
  return { targets, messages: evidence.messages };
}
