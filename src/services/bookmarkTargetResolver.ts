import type { SessionSummary } from "../sessions/sessionTypes";
import { resolveCodexLogicalHistoryPlan } from "../sessions/codexHistoryBase";
import { buildChatSessionModel } from "../chat/chatModelBuilder";
import type { ChatTimelineItem } from "../chat/chatTypes";
import { statSafe } from "../utils/fsUtils";
import { buildBookmarkKey, buildBookmarkKeyFromTargetFingerprint, type BookmarkTarget, type BookmarkTargetKind } from "./bookmarkStore";
import { getTimelineBookmarkIndexOffset, getVoiceBookmarkCompatibility } from "./bookmarkIdentity";
import { t } from "../i18n";
import { getAntigravityTargetFingerprint } from "../antigravity/antigravityIdentity";
import { antigravityReader } from "../antigravity/antigravityReader";
import { projectAntigravityChat } from "../antigravity/antigravityChatModel";

// Presentation-only cards must not shift the fallback identities of existing bookmark targets.
export function createTimelineBookmarkTargetBuilder(
  sessionFsPath: string,
  sessionCacheKey: string,
  items: readonly ChatTimelineItem[],
): (item: ChatTimelineItem) => BookmarkTarget | null {
  const messagesByIndex = new Map<number, ChatTimelineItem>();
  if (items.some((item) => item.type === "claudeProgress" || (item.type === "tool" && item.advisor))) {
    for (const item of items) {
      if (item.type === "message" && item.role === "assistant" && item.messageIndex !== undefined) {
        messagesByIndex.set(item.messageIndex, item);
      }
    }
  }
  // Legacy Claude records placed merged text before their tools, even when blocks were interleaved.
  const legacyIndexes = new Map<ChatTimelineItem, number>();
  // Untrusted old results may have removed earlier cards, so protect the entire model before resolving any key.
  const fallbackScope = items.map(getVoiceBookmarkCompatibility).find(value => value?.ambiguousScope)?.ambiguousScope;
  let legacyIndex = 0;
  const remember = (item: ChatTimelineItem): void => {
    if (!legacyIndexes.has(item)) legacyIndexes.set(item, legacyIndex++);
  };
  for (const item of items) {
    if (item.type === "claudeVoiceCall") {
      legacyIndexes.set(item, legacyIndex);
      legacyIndex += getVoiceBookmarkCompatibility(item)?.legacyItemCount ?? 0;
      continue;
    }
    if (item.type === "claudeProgress" || item.type === "claudeQueuedInput" ||
      (item.type === "tool" && item.advisor) || (item.type === "taskNotification" && item.notificationId)) continue;
    const message = "messageIndex" in item && item.messageIndex !== undefined ? messagesByIndex.get(item.messageIndex) : undefined;
    if (message) remember(message);
    remember(item);
  }
  return (item) => {
    const itemIndex = legacyIndexes.get(item) ?? 0;
    const offset = getTimelineBookmarkIndexOffset(item);
    // Apply the offset only to the fallback identity, preserving titles and enumeration.
    const fallbackItemIndex = offset <= Number.MAX_SAFE_INTEGER - itemIndex ? itemIndex + offset : itemIndex;
    return buildTimelineBookmarkTarget(sessionFsPath, sessionCacheKey, item, itemIndex, fallbackItemIndex, fallbackScope);
  };
}

export interface SessionBookmarkTargetScan {
  targets: BookmarkTarget[];
  stable: boolean;
}

export function buildTimelineBookmarkTarget(
  sessionFsPath: string,
  sessionCacheKey: string,
  item: ChatTimelineItem,
  itemIndex: number,
  fallbackItemIndex: number = itemIndex,
  fallbackScope?: string,
): BookmarkTarget | null {
  if (!item || typeof item !== "object") return null;
  // Timing-only thinking must not create invisible bookmark targets.
  if ((item.type === "claudeProgress" || item.type === "antigravityProgress") && item.kind === "thinking" && !item.body.trim()) return null;
  const kind = getBookmarkTargetKind(item);
  if (!kind) return null;
  const legacyTimestamp = item.type === "claudeVoiceCall" && item.messageIndex !== undefined
    ? getVoiceBookmarkCompatibility(item)?.legacyTimestampIso : undefined;
  const timestampIso = legacyTimestamp ?? (typeof item.timestampIso === "string" ? item.timestampIso.trim() : "");
  const rawMessageIndex = "messageIndex" in item ? item.messageIndex : undefined;
  const messageIndex =
    typeof rawMessageIndex === "number" && Number.isFinite(rawMessageIndex)
      ? Math.max(0, Math.floor(rawMessageIndex))
      : undefined;
  const fallbackId = getBookmarkFallbackId(item, fallbackItemIndex, fallbackScope);
  const groupId = getBookmarkGroupId(item);
  const native = getAntigravityTargetFingerprint(item);
  const key = native ? buildBookmarkKeyFromTargetFingerprint(sessionCacheKey, native.kind, native.targetHash)
    : buildBookmarkKey({ sessionCacheKey, kind, groupId, messageIndex, timestampIso, fallbackId });
  if (!key) return null;
  return {
    key,
    sessionFsPath,
    sessionCacheKey,
    kind,
    ...(groupId ? { groupId } : {}),
    title: getBookmarkTitle(item, itemIndex),
    ...(messageIndex !== undefined ? { messageIndex } : {}),
    ...(timestampIso ? { timestampIso } : {}),
  };
}

export async function scanSessionBookmarkTargets(
  session: SessionSummary,
  sessionInventory?: readonly SessionSummary[],
): Promise<SessionBookmarkTargetScan> {
  if (session.source === "antigravity") {
    try {
      const data = await antigravityReader.readSession(session.fsPath);
      const { model } = projectAntigravityChat(data, session.fsPath, session.storage.rootPath, { includeDetails: false });
      const verified = await antigravityReader.readSession(session.fsPath);
      if (data.digest !== verified.digest) return { targets: [], stable: false };
      return { targets: model.items.map(createTimelineBookmarkTargetBuilder(session.fsPath, session.cacheKey, model.items)).filter((value): value is BookmarkTarget => value !== null), stable: true };
    } catch { return { targets: [], stable: false }; }
  }
  const before = await statSafe(session.fsPath);
  if (!before) return { targets: [], stable: false };
  try {
    const historyPlan = session.source === "codex" && session.meta.codexHistoryBase && sessionInventory
      ? await resolveCodexLogicalHistoryPlan(session.fsPath, sessionInventory)
      : undefined;
    const model = await buildChatSessionModel(session.fsPath, {
      includeDetails: false,
      sessionInventory,
      historyPlan,
      claudeSessionsRoot: session.source === "claude" ? session.storage.rootPath : undefined,
    });
    const after = await statSafe(session.fsPath);
    if (!after || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      return { targets: [], stable: false };
    }
    if (historyPlan && sessionInventory) {
      const currentPlan = await resolveCodexLogicalHistoryPlan(session.fsPath, sessionInventory);
      if (currentPlan.signature !== historyPlan.signature) {
        return { targets: [], stable: false };
      }
    }
    return {
      targets: model.items
        .map(createTimelineBookmarkTargetBuilder(session.fsPath, session.cacheKey, model.items))
        .filter((target): target is BookmarkTarget => target !== null),
      stable: true,
    };
  } catch {
    return { targets: [], stable: false };
  }
}

function getBookmarkTargetKind(item: ChatTimelineItem): BookmarkTargetKind | "" {
  if (item.type === "claudeVoiceCall") return item.messageIndex !== undefined ? "message" : "note";
  if (item.type === "antigravityProgress") return "note";
  if (item.type === "claudeQueuedInput") return "note";
  if (item.type === "claudeProgress") return "note";
  if (item.type === "message") return "message";
  if (item.type === "patchGroup") return "patchGroup";
  if (item.type === "tool") return "tool";
  if (item.type === "usage") return "usage";
  if (item.type === "environment") return "environment";
  if (item.type === "note") return "note";
  return "";
}

function getBookmarkFallbackId(item: ChatTimelineItem, itemIndex: number, fallbackScope?: string): string {
  const prefix = fallbackScope ? `${fallbackScope}:` : "";
  if (item.type === "claudeVoiceCall" && item.messageIndex === undefined) return item.voiceCallId;
  if (item.type === "claudeQueuedInput") return item.inputId;
  if (item.type === "claudeProgress") return item.progressId;
  if (item.type === "patchGroup") {
    const turnId = typeof item.turnId === "string" ? item.turnId.trim() : "";
    if (turnId) return turnId;
  }
  if (item.type === "tool") {
    if (item.advisor) return item.advisor.id;
    const callId = typeof item.callId === "string" ? item.callId.trim() : "";
    if (callId) return callId;
  }
  if (item.type === "note") {
    const title = typeof item.title === "string" ? item.title.trim() : "";
    if (title) return `${prefix}${itemIndex}:${title}`;
  }
  return `${prefix}item:${itemIndex}`;
}

function getBookmarkGroupId(item: ChatTimelineItem): string | undefined {
  if (item.type !== "patchGroup") return undefined;
  const explicitGroupId = typeof item.bookmarkGroupId === "string" ? item.bookmarkGroupId.trim() : "";
  if (explicitGroupId) return explicitGroupId;
  const turnId = typeof item.turnId === "string" ? item.turnId.trim() : "";
  return turnId ? `turn:${turnId}` : undefined;
}

function getBookmarkTitle(item: ChatTimelineItem, itemIndex: number): string {
  if (item.type === "claudeVoiceCall") return t("chat.claudeVoiceCall.title");
  if (item.type === "antigravityProgress") return t(`chat.antigravityProgress.${item.kind}`);
  if (item.type === "claudeQueuedInput") return t("chat.claudeQueuedInput");
  if (item.type === "claudeProgress") return t(`chat.claudeProgress.${item.kind}`);
  if (item.type === "message") {
    const role = item.role === "user" || item.role === "assistant" || item.role === "developer" ? item.role : "message";
    return typeof item.messageIndex === "number" ? `${role} #${item.messageIndex}` : role;
  }
  if (item.type === "patchGroup") return `diff #${itemIndex + 1}`;
  if (item.type === "tool") return item.advisor ? t("chat.claudeAdvisor.title") : item.name || `tool #${itemIndex + 1}`;
  if (item.type === "usage") return `usage #${itemIndex + 1}`;
  if (item.type === "environment") return `environment #${itemIndex + 1}`;
  if (item.type === "note") return item.title || `note #${itemIndex + 1}`;
  return `card #${itemIndex + 1}`;
}
