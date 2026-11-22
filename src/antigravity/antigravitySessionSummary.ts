import * as path from "node:path";
import { lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { antigravityReader } from "./antigravityReader";
import type { AntigravityMetadata } from "./antigravityTypes";
import type { AntigravityCancellationToken } from "./antigravityReaderTypes";
import type { DiscoveredSessionFile } from "../sessions/sessionDiscovery";
import type { SessionSummary } from "../sessions/sessionTypes";
import { boundSessionIdentityKey } from "../sessions/sessionIdentity";
import { formatTimeHmInTimeZone, toYmdInTimeZone, ymdToString } from "../utils/dateUtils";
import { normalizeCacheKey } from "../utils/fsUtils";
import { safeDisplayPath, singleLineSnippet } from "../utils/textUtils";

export function antigravityWorkspacePath(uris: readonly string[]): string | undefined {
  for (const uri of uris) {
    try {
      const parsed = new URL(uri);
      if (parsed.protocol !== "file:" || parsed.host || parsed.search || parsed.hash) continue;
      const file = fileURLToPath(parsed);
      if (path.isAbsolute(file) && !file.startsWith("\\\\") && !/[\u0000-\u001f]/.test(file)) return file;
    } catch { /* Invalid native URI is classification data, never filesystem authority. */ }
  }
  return undefined;
}
export function antigravitySessionIdentity(root: string, id: string): string {
  const rootDigest = createHash("sha256").update(process.platform === "win32" ? root.toLowerCase() : root, "utf8").digest("hex");
  return boundSessionIdentityKey("antigravity", `antigravity:root:${rootDigest}:id:${id}`);
}

export async function buildAntigravitySessionSummary(file: DiscoveredSessionFile, stat: { readonly size: number; readonly mtimeMs: number }, timeZone: string, token?: AntigravityCancellationToken): Promise<SessionSummary> {
  const metadata = await antigravityReader.readMetadata(file.fsPath, token);
  return projectAntigravitySummary(file, timeZone, metadata, stat);
}

export async function buildAntigravityStartupSummary(file: DiscoveredSessionFile, timeZone: string, previous?: SessionSummary): Promise<SessionSummary | undefined> {
  const native = file.antigravitySummary;
  if (!native?.title) return undefined;
  if (previous?.source === "antigravity" && previous.fsPath === file.fsPath && previous.meta.id === native.conversationId) {
    return { ...previous, nativeTitle: native.title };
  }
  const metadata = { conversationId: native.conversationId, workspaceUris: [] };
  const activityMs = Date.parse(native.lastModifiedIso ?? "");
  if (Number.isFinite(activityMs)) return projectAntigravitySummary(file, timeZone, metadata, { mtimeMs: activityMs });
  try {
    const stat = await lstat(file.fsPath);
    return stat.isFile() ? projectAntigravitySummary(file, timeZone, metadata, stat) : undefined;
  } catch {
    // The full inventory handles unreadable and vanished files.
    return undefined;
  }
}

function projectAntigravitySummary(
  file: DiscoveredSessionFile,
  timeZone: string,
  metadata: Pick<AntigravityMetadata, "conversationId" | "createdAtIso" | "workspaceUris">,
  stat: { readonly size?: number; readonly mtimeMs: number },
): SessionSummary {
  const native = file.antigravitySummary;
  const cwd = antigravityWorkspacePath(metadata.workspaceUris) ?? antigravityWorkspacePath(native?.workspaceUris ?? []);
  const start = metadata.createdAtIso ? new Date(metadata.createdAtIso) : undefined;
  const activity = native?.lastModifiedIso ? new Date(native.lastModifiedIso) : start;
  const date = (value: Date): string => ymdToString(toYmdInTimeZone(value, timeZone));
  const startedLocalDate = date(start ?? activity ?? new Date(stat.mtimeMs)), lastActivityLocalDate = date(activity ?? start ?? new Date(stat.mtimeMs));
  const startedTimeLabel = start ? formatTimeHmInTimeZone(start, timeZone) : "--:--";
  const lastActivityTimeLabel = activity ? formatTimeHmInTimeZone(activity, timeZone) : "--:--";
  const snippet = native?.preview ? singleLineSnippet(native.preview, 70) : path.basename(file.fsPath);
  return {
    fsPath: file.fsPath, fileSizeBytes: stat.size, cacheKey: normalizeCacheKey(file.fsPath), identityKey: antigravitySessionIdentity(file.rootPath, metadata.conversationId),
    source: "antigravity", storage: { rootKind: "antigravitySessions", archiveState: "active", rootPath: file.rootPath },
    meta: { id: metadata.conversationId, historySource: "antigravity", timestampIso: metadata.createdAtIso, cwd,
      antigravity: { profile: "sqliteStepsV1", availability: "metadataOnly", issues: [] } },
    startedAtIso: metadata.createdAtIso, lastActivityAtIso: native?.lastModifiedIso,
    startedLocalDate, startedTimeLabel, lastActivityLocalDate, lastActivityTimeLabel,
    localDate: startedLocalDate, timeLabel: startedTimeLabel,
    snippet, nativeTitle: native?.title || undefined, displayTitle: snippet, cwdShort: cwd ? safeDisplayPath(cwd, 80) : "", previewMessages: [],
  };
}
