import type { SessionSummary } from "../sessions/sessionTypes";
import { resolveCodexLogicalHistoryPlan } from "../sessions/codexHistoryBase";
import { buildChatSessionModel } from "../chat/chatModelBuilder";
import type { ChatTimelineItem } from "../chat/chatTypes";
import { statSafe } from "../utils/fsUtils";
import { buildBookmarkKey, type BookmarkTarget, type BookmarkTargetKind } from "./bookmarkStore";

export interface SessionBookmarkTargetScan {
  targets: BookmarkTarget[];
  stable: boolean;
}

export function buildTimelineBookmarkTarget(
  sessionFsPath: string,
  sessionCacheKey: string,
  item: ChatTimelineItem,
  itemIndex: number,
): BookmarkTarget | null {
  if (!item || typeof item !== "object") return null;
  const kind = getBookmarkTargetKind(item);
  if (!kind) return null;
  const timestampIso = typeof item.timestampIso === "string" ? item.timestampIso.trim() : "";
  const rawMessageIndex = "messageIndex" in item ? item.messageIndex : undefined;
  const messageIndex =
    typeof rawMessageIndex === "number" && Number.isFinite(rawMessageIndex)
      ? Math.max(0, Math.floor(rawMessageIndex))
      : undefined;
  const fallbackId = getBookmarkFallbackId(item, itemIndex);
  const groupId = getBookmarkGroupId(item);
  const key = buildBookmarkKey({ sessionCacheKey, kind, groupId, messageIndex, timestampIso, fallbackId });
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
        .map((item, index) => buildTimelineBookmarkTarget(session.fsPath, session.cacheKey, item, index))
        .filter((target): target is BookmarkTarget => target !== null),
      stable: true,
    };
  } catch {
    return { targets: [], stable: false };
  }
}

function getBookmarkTargetKind(item: ChatTimelineItem): BookmarkTargetKind | "" {
  if (item.type === "message") return "message";
  if (item.type === "patchGroup") return "patchGroup";
  if (item.type === "tool") return "tool";
  if (item.type === "usage") return "usage";
  if (item.type === "environment") return "environment";
  if (item.type === "note") return "note";
  return "";
}

function getBookmarkFallbackId(item: ChatTimelineItem, itemIndex: number): string {
  if (item.type === "patchGroup") {
    const turnId = typeof item.turnId === "string" ? item.turnId.trim() : "";
    if (turnId) return turnId;
  }
  if (item.type === "tool") {
    const callId = typeof item.callId === "string" ? item.callId.trim() : "";
    if (callId) return callId;
  }
  if (item.type === "note") {
    const title = typeof item.title === "string" ? item.title.trim() : "";
    if (title) return `${itemIndex}:${title}`;
  }
  return `item:${itemIndex}`;
}

function getBookmarkGroupId(item: ChatTimelineItem): string | undefined {
  if (item.type !== "patchGroup") return undefined;
  const explicitGroupId = typeof item.bookmarkGroupId === "string" ? item.bookmarkGroupId.trim() : "";
  if (explicitGroupId) return explicitGroupId;
  const turnId = typeof item.turnId === "string" ? item.turnId.trim() : "";
  return turnId ? `turn:${turnId}` : undefined;
}

function getBookmarkTitle(item: ChatTimelineItem, itemIndex: number): string {
  if (item.type === "message") {
    const role = item.role === "user" || item.role === "assistant" || item.role === "developer" ? item.role : "message";
    return typeof item.messageIndex === "number" ? `${role} #${item.messageIndex}` : role;
  }
  if (item.type === "patchGroup") return `diff #${itemIndex + 1}`;
  if (item.type === "tool") return item.name || `tool #${itemIndex + 1}`;
  if (item.type === "usage") return `usage #${itemIndex + 1}`;
  if (item.type === "environment") return `environment #${itemIndex + 1}`;
  if (item.type === "note") return item.title || `note #${itemIndex + 1}`;
  return `card #${itemIndex + 1}`;
}
