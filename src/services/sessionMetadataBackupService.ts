import * as path from "node:path";
import { createHash } from "node:crypto";
import * as vscode from "vscode";
import type { HistoryIndex, SessionRootKind, SessionSource, SessionSummary } from "../sessions/sessionTypes";
import { isBoundedSessionIdentityKey } from "../sessions/sessionIdentity";
import type { SessionAnnotation, SessionAnnotationStore } from "./sessionAnnotationStore";
import {
  normalizeCustomTitle,
  resolveTitleOverrideKey,
  type SessionTitleOverride,
  type SessionTitleOverrideStore,
} from "./sessionTitleOverrideStore";
import type { PinEntry, PinStore } from "./pinStore";
import {
  buildBookmarkKeyFromTargetFingerprint,
  getBookmarkTargetFingerprint,
  type BookmarkEntry,
  type BookmarkStore,
  type BookmarkTargetKind,
} from "./bookmarkStore";
import {
  MAX_HIDDEN_SESSIONS,
  type HiddenSessionEntry,
  type HiddenSessionStore,
} from "./hiddenSessionStore";
import { normalizeCacheKey } from "../utils/fsUtils";
import { scanSessionBookmarkTargets } from "./bookmarkTargetResolver";
import type { SessionMetadataMutationCoordinator } from "./sessionMetadataMutationCoordinator";
import type { SessionMetadataImportMapping } from "./importExportService";

export const SESSION_METADATA_BACKUP_FORMAT = "codex-history-viewer.session-metadata";
export const SESSION_METADATA_BACKUP_VERSION = 1;
const MAX_BACKUP_SESSIONS = 200_000;
const MAX_BACKUP_BOOKMARKS_PER_SESSION = 10_000;
const MAX_BACKUP_BOOKMARKS_TOTAL = 500_000;

export interface SessionMetadataBackupBookmark {
  kind: BookmarkTargetKind;
  targetHash: string;
  groupId?: string;
  title?: string;
  messageIndex?: number;
  timestampIso?: string;
}

export interface SessionMetadataBackupLocator {
  identityKey?: string;
  source: SessionSource;
  sessionId?: string;
  rootKind: SessionRootKind;
  relativePath?: string;
}

export interface SessionMetadataBackupEntry {
  locator: SessionMetadataBackupLocator;
  annotation?: {
    tags?: string[];
    note?: string;
  };
  customTitle?: string;
  hidden?: true;
  pinned?: true;
  bookmarks?: SessionMetadataBackupBookmark[];
}

export interface SessionMetadataBackupFile {
  format: typeof SESSION_METADATA_BACKUP_FORMAT;
  version: typeof SESSION_METADATA_BACKUP_VERSION;
  generatedAtIso: string;
  extensionVersion: string;
  scope: "all" | "selection";
  sessions: SessionMetadataBackupEntry[];
}

export interface SessionMetadataRestorePreview {
  matched: number;
  matchedCodex: number;
  matchedClaude: number;
  unmatched: number;
  ambiguous: number;
  invalidBookmarks: number;
  total: number;
  addedTags: number;
  setTagSessions: number;
  clearedTagSessions: number;
  restoredNotes: number;
  overwrittenNotes: number;
  clearedNotes: number;
  restoredTitles: number;
  overwrittenTitles: number;
  clearedTitles: number;
  hiddenSessions: number;
  shownSessions: number;
  pinnedSessions: number;
  unpinnedSessions: number;
  restoredBookmarks: number;
  setBookmarkSessions: number;
  clearedBookmarkSessions: number;
  existingNotes: number;
  existingTitles: number;
  alreadyHiddenSessions: number;
  alreadyPinnedSessions: number;
  existingBookmarks: number;
  hiddenLimitSkipped: number;
  planFingerprint: string;
}

export interface SessionMetadataRestoreResult extends SessionMetadataRestorePreview {
  changedSessions: number;
  restoredBookmarks: number;
}

export interface SessionMetadataStores {
  annotations: SessionAnnotationStore;
  titles: SessionTitleOverrideStore;
  pins: PinStore;
  bookmarks: BookmarkStore;
  hidden: HiddenSessionStore;
}

export interface SessionMetadataRestoreOptions {
  token?: vscode.CancellationToken;
  progress?: vscode.Progress<{ message?: string; increment?: number }>;
  stores?: SessionMetadataStores;
  coordinator?: SessionMetadataMutationCoordinator;
  expectedPreview?: SessionMetadataRestorePreview;
  skipCoordinator?: boolean;
  importMappings?: readonly SessionMetadataImportMapping[];
  mode?: "merge" | "replace";
}

interface ResolvedRestoreEntry {
  entry: SessionMetadataBackupEntry;
  session: SessionSummary;
  bookmarkSourcePath?: string;
  bookmarks: BookmarkEntry[];
  bookmarksComplete: boolean;
}

interface ResolvedRestorePlan {
  entries: ResolvedRestoreEntry[];
  unmatched: number;
  ambiguous: number;
  invalidBookmarks: number;
  total: number;
}

interface SessionMetadataStoreSnapshots {
  annotations: SessionAnnotation[];
  titles: SessionTitleOverride[];
  pins: PinEntry[];
  bookmarks: BookmarkEntry[];
  hidden: HiddenSessionEntry[];
}

export function createSessionMetadataBackup(
  index: HistoryIndex,
  stores: SessionMetadataStores,
  sessions: readonly SessionSummary[] = index.sessions,
  extensionVersion = "2.13.1",
): SessionMetadataBackupFile {
  if (sessions.length > MAX_BACKUP_SESSIONS) {
    throw new Error("Too many sessions for a complete metadata sidecar.");
  }
  const annotationsByPath = new Map(stores.annotations.getAll().map((value) => [value.cacheKey, value]));
  const titlesByKey = new Map(stores.titles.getAll().map((value) => [value.key, value]));
  const pins = stores.pins.getAll();
  const pinnedIdentityKeys = new Set(pins.map((value) => value.identityKey).filter((value): value is string => !!value));
  const pinnedCacheKeys = new Set(pins.map((value) => value.cacheKey));
  const hiddenEntries = stores.hidden.getAll();
  const hiddenIdentityKeys = new Set(hiddenEntries.map((value) => value.identityKey));
  const hiddenCacheKeys = new Set(hiddenEntries.map((value) => value.cacheKey));
  const bookmarksByPath = new Map<string, BookmarkEntry[]>();
  for (const bookmark of stores.bookmarks.getAll()) {
    const values = bookmarksByPath.get(bookmark.sessionCacheKey) ?? [];
    values.push(bookmark);
    bookmarksByPath.set(bookmark.sessionCacheKey, values);
  }

  const output: SessionMetadataBackupEntry[] = [];
  const seen = new Set<string>();
  let bookmarkCount = 0;
  for (const session of sessions) {
    if (!session) throw new Error("Invalid session in metadata export selection.");
    if (seen.has(session.cacheKey)) throw new Error("Duplicate session in metadata export selection.");
    seen.add(session.cacheKey);
    const annotation = annotationsByPath.get(session.cacheKey);
    const titleKey = resolveTitleOverrideKey(session);
    const title = normalizeCustomTitle(titleKey ? titlesByKey.get(titleKey)?.title : "");
    const hidden = hiddenIdentityKeys.has(session.identityKey) || hiddenCacheKeys.has(session.cacheKey);
    const pinned = pinnedIdentityKeys.has(session.identityKey) || pinnedCacheKeys.has(session.cacheKey);
    const storedBookmarks = bookmarksByPath.get(session.cacheKey) ?? [];
    if (
      storedBookmarks.length > MAX_BACKUP_BOOKMARKS_PER_SESSION ||
      bookmarkCount + storedBookmarks.length > MAX_BACKUP_BOOKMARKS_TOTAL
    ) {
      throw new Error("Too many bookmarks for a complete metadata sidecar.");
    }
    const bookmarks = storedBookmarks
      .map(toBackupBookmark)
      .filter((value): value is SessionMetadataBackupBookmark => value !== null);
    if (bookmarks.length !== storedBookmarks.length) {
      throw new Error("A bookmark cannot be represented in the metadata sidecar.");
    }
    bookmarkCount += bookmarks.length;
    const tags = normalizeTags(annotation?.tags ?? []);
    if (tags.some((tag) => tag.length > 256)) {
      throw new Error("A tag is too long for the metadata sidecar.");
    }
    const note = normalizeLimitedText(annotation?.note, 500);
    const relativePath = toPortableRelativePath(session.storage.rootPath, session.fsPath);
    const sessionId = normalizePortableSessionId(session.meta.id);
    const identityKey = hasPortableStableIdentity(session) ? session.identityKey : "";
    if (!identityKey && !sessionId && !relativePath) {
      throw new Error("A session cannot be represented in the metadata sidecar.");
    }
    output.push({
      locator: {
        ...(identityKey ? { identityKey } : {}),
        source: session.source,
        ...(sessionId ? { sessionId } : {}),
        rootKind: session.storage.rootKind,
        ...(relativePath ? { relativePath } : {}),
      },
      ...(tags.length > 0 || note
        ? { annotation: { ...(tags.length > 0 ? { tags } : {}), ...(note ? { note } : {}) } }
        : {}),
      ...(title ? { customTitle: title } : {}),
      ...(hidden ? { hidden: true } : {}),
      ...(pinned ? { pinned: true } : {}),
      ...(bookmarks.length > 0 ? { bookmarks } : {}),
    });
  }

  return {
    format: SESSION_METADATA_BACKUP_FORMAT,
    version: SESSION_METADATA_BACKUP_VERSION,
    generatedAtIso: new Date().toISOString(),
    extensionVersion: isBoundedExtensionVersion(extensionVersion) ? extensionVersion : "2.13.1",
    scope: sessions === index.sessions ? "all" : "selection",
    sessions: output,
  };
}

export function parseSessionMetadataBackup(value: unknown): SessionMetadataBackupFile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.format !== SESSION_METADATA_BACKUP_FORMAT || raw.version !== SESSION_METADATA_BACKUP_VERSION) return null;
  if (typeof raw.generatedAtIso !== "string" || raw.generatedAtIso.length > 128 || !Number.isFinite(Date.parse(raw.generatedAtIso))) return null;
  if (!isBoundedExtensionVersion(raw.extensionVersion)) return null;
  if (raw.scope !== "all" && raw.scope !== "selection") return null;
  if (!Array.isArray(raw.sessions) || raw.sessions.length > MAX_BACKUP_SESSIONS) return null;
  const sessions: SessionMetadataBackupEntry[] = [];
  let bookmarkCount = 0;
  for (const candidate of raw.sessions) {
    const entry = sanitizeBackupEntry(candidate);
    if (!entry) return null;
    bookmarkCount += entry.bookmarks?.length ?? 0;
    if (bookmarkCount > MAX_BACKUP_BOOKMARKS_TOTAL) return null;
    sessions.push(entry);
  }
  return {
    format: SESSION_METADATA_BACKUP_FORMAT,
    version: SESSION_METADATA_BACKUP_VERSION,
    generatedAtIso: raw.generatedAtIso,
    extensionVersion: raw.extensionVersion,
    scope: raw.scope,
    sessions,
  };
}

export async function previewSessionMetadataRestore(
  backup: SessionMetadataBackupFile,
  index: HistoryIndex,
  options?: SessionMetadataRestoreOptions,
): Promise<SessionMetadataRestorePreview> {
  const resolved = await resolveRestoreEntries(backup, index, options);
  const snapshots = options?.stores ? snapshotSessionMetadataStores(options.stores) : null;
  const changes = snapshots
    ? calculateRestoreChangeCounts(resolved.entries, snapshots, options?.mode ?? "merge")
    : emptyRestoreChangeCounts();
  return {
    matched: resolved.entries.length,
    ...countMatchedSources(resolved.entries),
    unmatched: resolved.unmatched,
    ambiguous: resolved.ambiguous,
    invalidBookmarks: resolved.invalidBookmarks,
    total: resolved.total,
    ...changes,
    planFingerprint: snapshots ? buildRestorePlanFingerprint(resolved.entries, snapshots, options?.mode ?? "merge") : "",
  };
}

export async function restoreSessionMetadata(
  backup: SessionMetadataBackupFile,
  index: HistoryIndex,
  stores: SessionMetadataStores,
  options?: SessionMetadataRestoreOptions,
): Promise<SessionMetadataRestoreResult> {
  if (options?.coordinator && options.skipCoordinator !== true) {
    return options.coordinator.runExclusive(() => restoreSessionMetadata(
      backup,
      index,
      stores,
      { ...options, skipCoordinator: true },
    ));
  }
  const resolved = await resolveRestoreEntries(backup, index, options);
  if (options?.token?.isCancellationRequested) throw new vscode.CancellationError();
  const snapshots = snapshotSessionMetadataStores(stores);
  const mode = options?.mode ?? "merge";
  const planFingerprint = buildRestorePlanFingerprint(resolved.entries, snapshots, mode);
  if (options?.expectedPreview && options.expectedPreview.planFingerprint !== planFingerprint) {
    throw new SessionMetadataRestoreStaleError();
  }
  const stagedAnnotations = new Map(snapshots.annotations.map((value) => [value.cacheKey, value]));
  const stagedTitles = new Map(snapshots.titles.map((value) => [value.key, value]));
  const stagedPins = new Map(snapshots.pins.map((value) => [value.cacheKey, value]));
  const stagedPinIdentityKeys = new Set(
    snapshots.pins.map((value) => value.identityKey).filter((value): value is string => !!value),
  );
  const stagedBookmarks = new Map(snapshots.bookmarks.map((value) => [value.key, value]));
  const stagedHiddenByIdentity = new Map(snapshots.hidden.map((value) => [value.identityKey, value]));
  const stagedHiddenCacheKeys = new Set(snapshots.hidden.map((value) => value.cacheKey));
  const pinCacheKeysByIdentity = buildPinCacheKeysByIdentity(stagedPins.values());
  const hiddenIdentityByCacheKey = new Map(snapshots.hidden.map((value) => [value.cacheKey, value.identityKey]));
  const bookmarkKeysBySession = buildBookmarkKeysBySession(stagedBookmarks.values());
  const replaceHiddenAllowed = mode === "replace"
    ? buildReplaceHiddenAllowedIdentityKeys(resolved.entries, snapshots.hidden)
    : null;
  const changedSessionKeys = new Set<string>();
  let restoredBookmarks = 0;
  let annotationsChanged = false;
  let titlesChanged = false;
  let pinsChanged = false;
  let bookmarksChanged = false;
  let hiddenChanged = false;
  const attemptedStores = {
    annotations: false,
    pins: false,
    bookmarks: false,
    hidden: false,
  };

  for (const value of resolved.entries) {
    const { entry, session } = value;
    const now = Date.now();
    const annotationKey = normalizeCacheKey(session.fsPath);
    const existingAnnotation = stagedAnnotations.get(annotationKey);
    if (mode === "replace") {
      const tags = normalizeTags(entry.annotation?.tags ?? []);
      const note = normalizeLimitedText(entry.annotation?.note, 500);
      const shouldKeepAnnotation = tags.length > 0 || note.length > 0;
      const annotationMatches = !!existingAnnotation &&
        sameTagsExact(normalizeTags(existingAnnotation.tags), tags) &&
        normalizeLimitedText(existingAnnotation.note, 500) === note;
      if (shouldKeepAnnotation && !annotationMatches) {
        stagedAnnotations.set(annotationKey, {
          fsPath: session.fsPath,
          cacheKey: annotationKey,
          tags,
          note,
          updatedAt: now,
        } satisfies SessionAnnotation);
        annotationsChanged = true;
        changedSessionKeys.add(session.identityKey);
      } else if (!shouldKeepAnnotation && existingAnnotation) {
        stagedAnnotations.delete(annotationKey);
        annotationsChanged = true;
        changedSessionKeys.add(session.identityKey);
      }

      const titleKey = resolveTitleOverrideKey(session);
      const importedTitle = normalizeCustomTitle(entry.customTitle);
      if (titleKey) {
        const existingTitle = normalizeCustomTitle(stagedTitles.get(titleKey)?.title);
        if (importedTitle && importedTitle !== existingTitle) {
          stagedTitles.set(titleKey, { key: titleKey, title: importedTitle, updatedAt: now } satisfies SessionTitleOverride);
          titlesChanged = true;
          changedSessionKeys.add(session.identityKey);
        } else if (!importedTitle && stagedTitles.delete(titleKey)) {
          titlesChanged = true;
          changedSessionKeys.add(session.identityKey);
        }
      }

      const matchingPinKeys = getMatchingPinCacheKeys(session, stagedPins, pinCacheKeysByIdentity);
      if (entry.pinned) {
        if (matchingPinKeys.size === 0) {
          const pin: PinEntry = {
            fsPath: session.fsPath,
            cacheKey: session.cacheKey,
            identityKey: session.identityKey,
            source: session.source,
            archiveState: session.storage.archiveState,
            rootKind: session.storage.rootKind,
            pinnedAt: now,
          };
          stagedPins.set(pin.cacheKey, pin);
          appendSetMapValue(pinCacheKeysByIdentity, session.identityKey, pin.cacheKey);
          pinsChanged = true;
          changedSessionKeys.add(session.identityKey);
        }
      } else if (matchingPinKeys.size > 0) {
        for (const cacheKey of matchingPinKeys) stagedPins.delete(cacheKey);
        pinCacheKeysByIdentity.delete(session.identityKey);
        pinsChanged = true;
        changedSessionKeys.add(session.identityKey);
      }

      const hiddenIdentity = stagedHiddenByIdentity.has(session.identityKey)
        ? session.identityKey
        : hiddenIdentityByCacheKey.get(session.cacheKey);
      const shouldHide = entry.hidden === true && replaceHiddenAllowed?.has(session.identityKey) === true;
      if (shouldHide && !hiddenIdentity) {
        const hiddenEntry: HiddenSessionEntry = {
          identityKey: session.identityKey,
          source: session.source,
          fsPath: session.fsPath,
          cacheKey: session.cacheKey,
          hiddenAt: now,
          updatedAt: now,
        };
        stagedHiddenByIdentity.set(hiddenEntry.identityKey, hiddenEntry);
        stagedHiddenCacheKeys.add(hiddenEntry.cacheKey);
        hiddenIdentityByCacheKey.set(hiddenEntry.cacheKey, hiddenEntry.identityKey);
        hiddenChanged = true;
        changedSessionKeys.add(session.identityKey);
      } else if (!shouldHide && hiddenIdentity) {
        const removed = stagedHiddenByIdentity.get(hiddenIdentity);
        stagedHiddenByIdentity.delete(hiddenIdentity);
        if (removed) {
          stagedHiddenCacheKeys.delete(removed.cacheKey);
          hiddenIdentityByCacheKey.delete(removed.cacheKey);
        }
        hiddenChanged = true;
        changedSessionKeys.add(session.identityKey);
      }

      if (value.bookmarksComplete) {
        const existingBookmarkKeys = bookmarkKeysBySession.get(session.cacheKey) ?? new Set<string>();
        const desiredBookmarks = new Map(value.bookmarks.map((bookmark) => [bookmark.key, bookmark]));
        for (const bookmarkKey of existingBookmarkKeys) {
          if (desiredBookmarks.has(bookmarkKey)) continue;
          stagedBookmarks.delete(bookmarkKey);
          bookmarksChanged = true;
          changedSessionKeys.add(session.identityKey);
        }
        const nextBookmarkKeys = new Set<string>();
        for (const [bookmarkKey, bookmark] of desiredBookmarks) {
          const existingBookmark = stagedBookmarks.get(bookmarkKey);
          nextBookmarkKeys.add(bookmarkKey);
          if (existingBookmark && sameBookmarkMetadata(existingBookmark, bookmark)) continue;
          stagedBookmarks.set(bookmarkKey, {
            ...bookmark,
            createdAt: existingBookmark?.createdAt ?? bookmark.createdAt,
            updatedAt: now,
          });
          if (!existingBookmark) restoredBookmarks += 1;
          bookmarksChanged = true;
          changedSessionKeys.add(session.identityKey);
        }
        bookmarkKeysBySession.set(session.cacheKey, nextBookmarkKeys);
      }
      continue;
    }

    const tags = normalizeTags([...(existingAnnotation?.tags ?? []), ...(entry.annotation?.tags ?? [])]);
    const existingNote = normalizeLimitedText(existingAnnotation?.note, 500);
    const importedNote = normalizeLimitedText(entry.annotation?.note, 500);
    const note = existingNote || importedNote;
    if (!sameTags(existingAnnotation?.tags ?? [], tags) || (existingAnnotation?.note ?? "").trim() !== note) {
      stagedAnnotations.set(annotationKey, {
        fsPath: session.fsPath,
        cacheKey: annotationKey,
        tags,
        note,
        updatedAt: now,
      } satisfies SessionAnnotation);
      annotationsChanged = true;
      changedSessionKeys.add(session.identityKey);
    }

    const titleKey = resolveTitleOverrideKey(session);
    const existingTitle = titleKey ? normalizeCustomTitle(stagedTitles.get(titleKey)?.title) : "";
    const importedTitle = normalizeCustomTitle(entry.customTitle);
    if (titleKey && !existingTitle && importedTitle) {
      stagedTitles.set(titleKey, { key: titleKey, title: importedTitle, updatedAt: now } satisfies SessionTitleOverride);
      titlesChanged = true;
      changedSessionKeys.add(session.identityKey);
    }
    if (entry.pinned && !stagedPins.has(session.cacheKey) && !stagedPinIdentityKeys.has(session.identityKey)) {
      stagedPins.set(session.cacheKey, {
        fsPath: session.fsPath,
        cacheKey: session.cacheKey,
        identityKey: session.identityKey,
        source: session.source,
        archiveState: session.storage.archiveState,
        rootKind: session.storage.rootKind,
        pinnedAt: now,
      } satisfies PinEntry);
      stagedPinIdentityKeys.add(session.identityKey);
      pinsChanged = true;
      changedSessionKeys.add(session.identityKey);
    }
    if (
      entry.hidden &&
      !stagedHiddenByIdentity.has(session.identityKey) &&
      !stagedHiddenCacheKeys.has(session.cacheKey) &&
      stagedHiddenByIdentity.size < MAX_HIDDEN_SESSIONS
    ) {
      const hiddenEntry: HiddenSessionEntry = {
        identityKey: session.identityKey,
        source: session.source,
        fsPath: session.fsPath,
        cacheKey: session.cacheKey,
        hiddenAt: now,
        updatedAt: now,
      };
      stagedHiddenByIdentity.set(session.identityKey, hiddenEntry);
      stagedHiddenCacheKeys.add(session.cacheKey);
      hiddenChanged = true;
      changedSessionKeys.add(session.identityKey);
    }

    for (const bookmark of value.bookmarks) {
      if (stagedBookmarks.has(bookmark.key)) continue;
      stagedBookmarks.set(bookmark.key, bookmark);
      restoredBookmarks += 1;
      bookmarksChanged = true;
      changedSessionKeys.add(session.identityKey);
    }
  }

  const rollbackActions: Array<() => Promise<void>> = [];
  try {
    // Persist each metadata family once after the whole import has been validated and staged.
    if (annotationsChanged) {
      attemptedStores.annotations = true;
      rollbackActions.unshift(() => stores.annotations.replaceAll(snapshots.annotations, { notify: false, skipCoordinator: true }));
      await stores.annotations.replaceAll(Array.from(stagedAnnotations.values()), { notify: false, skipCoordinator: true });
    }
    if (titlesChanged) {
      rollbackActions.unshift(() => stores.titles.replaceAll(snapshots.titles, { skipCoordinator: true }));
      await stores.titles.replaceAll(Array.from(stagedTitles.values()), { skipCoordinator: true });
    }
    if (pinsChanged) {
      attemptedStores.pins = true;
      rollbackActions.unshift(() => stores.pins.replaceAll(snapshots.pins, { notify: false, skipCoordinator: true }));
      await stores.pins.replaceAll(Array.from(stagedPins.values()), { notify: false, skipCoordinator: true });
    }
    if (bookmarksChanged) {
      attemptedStores.bookmarks = true;
      rollbackActions.unshift(() => stores.bookmarks.replaceAll(snapshots.bookmarks, { notify: false, skipCoordinator: true }));
      await stores.bookmarks.replaceAll(Array.from(stagedBookmarks.values()), { notify: false, skipCoordinator: true });
    }
    if (hiddenChanged) {
      attemptedStores.hidden = true;
      rollbackActions.unshift(() => stores.hidden.replaceAll(snapshots.hidden, { notify: false, skipCoordinator: true }));
      await stores.hidden.replaceAll(Array.from(stagedHiddenByIdentity.values()), { notify: false, skipCoordinator: true });
    }
  } catch (error) {
    let rollbackFailed = false;
    for (const rollback of rollbackActions) {
      try {
        await rollback();
      } catch {
        rollbackFailed = true;
      }
    }
    notifyChangedStores(stores, attemptedStores);
    if (rollbackFailed) throw new SessionMetadataRestoreRollbackError({ cause: error });
    throw new Error("Metadata restore failed and was rolled back.", { cause: error });
  }

  notifyChangedStores(stores, {
    annotations: annotationsChanged,
    pins: pinsChanged,
    bookmarks: bookmarksChanged,
    hidden: hiddenChanged,
  });

  return {
    matched: resolved.entries.length,
    ...countMatchedSources(resolved.entries),
    unmatched: resolved.unmatched,
    ambiguous: resolved.ambiguous,
    invalidBookmarks: resolved.invalidBookmarks,
    total: resolved.total,
    ...calculateRestoreChangeCounts(resolved.entries, snapshots, mode),
    planFingerprint,
    changedSessions: changedSessionKeys.size,
    restoredBookmarks,
  };
}

function countMatchedSources(
  entries: readonly ResolvedRestoreEntry[],
): Pick<SessionMetadataRestorePreview, "matchedCodex" | "matchedClaude"> {
  let matchedCodex = 0;
  let matchedClaude = 0;
  for (const { session } of entries) {
    if (session.source === "codex") matchedCodex += 1;
    else if (session.source === "claude") matchedClaude += 1;
  }
  return { matchedCodex, matchedClaude };
}

function calculateRestoreChangeCounts(
  entries: readonly ResolvedRestoreEntry[],
  snapshots: SessionMetadataStoreSnapshots,
  mode: "merge" | "replace",
): Pick<
  SessionMetadataRestorePreview,
  "addedTags" | "setTagSessions" | "clearedTagSessions"
  | "restoredNotes" | "overwrittenNotes" | "clearedNotes"
  | "restoredTitles" | "overwrittenTitles" | "clearedTitles"
  | "hiddenSessions" | "shownSessions" | "pinnedSessions" | "unpinnedSessions" | "restoredBookmarks"
  | "setBookmarkSessions" | "clearedBookmarkSessions"
  | "existingNotes" | "existingTitles" | "alreadyHiddenSessions" | "alreadyPinnedSessions" | "existingBookmarks"
  | "hiddenLimitSkipped"
> {
  if (mode === "replace") return calculateReplaceChangeCounts(entries, snapshots);
  const annotations = new Map(snapshots.annotations.map((value) => [value.cacheKey, value]));
  const titles = new Map(snapshots.titles.map((value) => [value.key, value]));
  const pins = snapshots.pins;
  const pinnedIdentityKeys = new Set(pins.map((value) => value.identityKey).filter((value): value is string => !!value));
  const pinnedCacheKeys = new Set(pins.map((value) => value.cacheKey));
  const bookmarks = new Set(snapshots.bookmarks.map((value) => value.key));
  const hidden = snapshots.hidden;
  const hiddenIdentityKeys = new Set(hidden.map((value) => value.identityKey));
  const hiddenCacheKeys = new Set(hidden.map((value) => value.cacheKey));
  const counts = emptyRestoreChangeCounts();
  for (const { entry, session, bookmarks: resolvedBookmarks } of entries) {
    const existingAnnotation = annotations.get(session.cacheKey);
    const existingTags = normalizeTags(existingAnnotation?.tags ?? []);
    const mergedTags = normalizeTags([...existingTags, ...(entry.annotation?.tags ?? [])]);
    counts.addedTags += Math.max(0, mergedTags.length - existingTags.length);
    const importedNote = normalizeLimitedText(entry.annotation?.note, 500);
    let nextNote = normalizeLimitedText(existingAnnotation?.note, 500);
    if (importedNote) {
      if (nextNote) {
        counts.existingNotes += 1;
      }
      else {
        counts.restoredNotes += 1;
        nextNote = importedNote;
      }
    }
    if (mergedTags.length > 0 || nextNote) {
      annotations.set(session.cacheKey, {
        fsPath: session.fsPath,
        cacheKey: session.cacheKey,
        tags: mergedTags,
        note: nextNote,
        updatedAt: existingAnnotation?.updatedAt ?? 0,
      });
    }
    const titleKey = resolveTitleOverrideKey(session);
    const importedTitle = normalizeCustomTitle(entry.customTitle);
    if (importedTitle && titleKey) {
      if (normalizeCustomTitle(titles.get(titleKey)?.title)) {
        counts.existingTitles += 1;
      }
      else {
        counts.restoredTitles += 1;
        titles.set(titleKey, { key: titleKey, title: importedTitle, updatedAt: 0 });
      }
    }
    if (entry.pinned) {
      if (pinnedIdentityKeys.has(session.identityKey) || pinnedCacheKeys.has(session.cacheKey)) {
        counts.alreadyPinnedSessions += 1;
      }
      else {
        counts.pinnedSessions += 1;
        pinnedIdentityKeys.add(session.identityKey);
        pinnedCacheKeys.add(session.cacheKey);
      }
    }
    if (entry.hidden) {
      if (hiddenIdentityKeys.has(session.identityKey) || hiddenCacheKeys.has(session.cacheKey)) {
        counts.alreadyHiddenSessions += 1;
      }
      else if (hiddenIdentityKeys.size < MAX_HIDDEN_SESSIONS) {
        counts.hiddenSessions += 1;
        hiddenIdentityKeys.add(session.identityKey);
        hiddenCacheKeys.add(session.cacheKey);
      } else {
        counts.hiddenLimitSkipped += 1;
      }
    }
    for (const bookmark of resolvedBookmarks) {
      if (bookmarks.has(bookmark.key)) {
        counts.existingBookmarks += 1;
      }
      else {
        counts.restoredBookmarks += 1;
        bookmarks.add(bookmark.key);
      }
    }
  }
  return counts;
}

function calculateReplaceChangeCounts(
  entries: readonly ResolvedRestoreEntry[],
  snapshots: SessionMetadataStoreSnapshots,
): ReturnType<typeof emptyRestoreChangeCounts> {
  const counts = emptyRestoreChangeCounts();
  const annotations = new Map(snapshots.annotations.map((value) => [value.cacheKey, value]));
  const titles = new Map(snapshots.titles.map((value) => [value.key, value]));
  const pinnedIdentityKeys = new Set(
    snapshots.pins.map((value) => value.identityKey).filter((value): value is string => !!value),
  );
  const pinnedCacheKeys = new Set(snapshots.pins.map((value) => value.cacheKey));
  const hiddenIdentityKeys = new Set(snapshots.hidden.map((value) => value.identityKey));
  const hiddenCacheKeys = new Set(snapshots.hidden.map((value) => value.cacheKey));
  const bookmarksBySession = new Map<string, Map<string, BookmarkEntry>>();
  for (const bookmark of snapshots.bookmarks) {
    const values = bookmarksBySession.get(bookmark.sessionCacheKey) ?? new Map<string, BookmarkEntry>();
    values.set(bookmark.key, bookmark);
    bookmarksBySession.set(bookmark.sessionCacheKey, values);
  }
  const allowedHidden = buildReplaceHiddenAllowedIdentityKeys(entries, snapshots.hidden);

  for (const { entry, session, bookmarks, bookmarksComplete } of entries) {
    const existingAnnotation = annotations.get(session.cacheKey);
    const existingTags = normalizeTags(existingAnnotation?.tags ?? []);
    const importedTags = normalizeTags(entry.annotation?.tags ?? []);
    if (!sameTagsExact(existingTags, importedTags)) {
      if (importedTags.length > 0) counts.setTagSessions += 1;
      else counts.clearedTagSessions += 1;
      const existingTagKeys = new Set(existingTags.map((tag) => tag.toLowerCase()));
      counts.addedTags += importedTags.filter((tag) => !existingTagKeys.has(tag.toLowerCase())).length;
    }

    const existingNote = normalizeLimitedText(existingAnnotation?.note, 500);
    const importedNote = normalizeLimitedText(entry.annotation?.note, 500);
    if (existingNote === importedNote) {
      if (importedNote) counts.existingNotes += 1;
    } else if (!existingNote && importedNote) counts.restoredNotes += 1;
    else if (existingNote && importedNote) counts.overwrittenNotes += 1;
    else counts.clearedNotes += 1;

    const titleKey = resolveTitleOverrideKey(session);
    const existingTitle = titleKey ? normalizeCustomTitle(titles.get(titleKey)?.title) : "";
    const importedTitle = normalizeCustomTitle(entry.customTitle);
    if (existingTitle === importedTitle) {
      if (importedTitle) counts.existingTitles += 1;
    } else if (!existingTitle && importedTitle) counts.restoredTitles += 1;
    else if (existingTitle && importedTitle) counts.overwrittenTitles += 1;
    else counts.clearedTitles += 1;

    const wasPinned = pinnedIdentityKeys.has(session.identityKey) || pinnedCacheKeys.has(session.cacheKey);
    if (entry.pinned) {
      if (wasPinned) counts.alreadyPinnedSessions += 1;
      else counts.pinnedSessions += 1;
    } else if (wasPinned) counts.unpinnedSessions += 1;

    const wasHidden = hiddenIdentityKeys.has(session.identityKey) || hiddenCacheKeys.has(session.cacheKey);
    const willBeHidden = entry.hidden === true && allowedHidden.has(session.identityKey);
    if (entry.hidden === true && !willBeHidden) counts.hiddenLimitSkipped += 1;
    else if (willBeHidden) {
      if (wasHidden) counts.alreadyHiddenSessions += 1;
      else counts.hiddenSessions += 1;
    } else if (wasHidden) counts.shownSessions += 1;

    if (!bookmarksComplete) continue;
    const existingBookmarks = bookmarksBySession.get(session.cacheKey) ?? new Map<string, BookmarkEntry>();
    const importedBookmarks = new Map(bookmarks.map((bookmark) => [bookmark.key, bookmark]));
    let bookmarksMatch = existingBookmarks.size === importedBookmarks.size;
    if (bookmarksMatch) {
      for (const [key, importedBookmark] of importedBookmarks) {
        const existingBookmark = existingBookmarks.get(key);
        if (!existingBookmark || !sameBookmarkMetadata(existingBookmark, importedBookmark)) {
          bookmarksMatch = false;
          break;
        }
      }
    }
    if (bookmarksMatch) {
      counts.existingBookmarks += importedBookmarks.size;
    } else if (importedBookmarks.size === 0) {
      counts.clearedBookmarkSessions += 1;
    } else {
      counts.setBookmarkSessions += 1;
      counts.restoredBookmarks += Array.from(importedBookmarks.keys())
        .filter((key) => !existingBookmarks.has(key)).length;
    }
  }
  return counts;
}

function buildReplaceHiddenAllowedIdentityKeys(
  entries: readonly ResolvedRestoreEntry[],
  existingHidden: readonly HiddenSessionEntry[],
): Set<string> {
  const targetIdentityKeys = new Set(entries.map(({ session }) => session.identityKey));
  const targetCacheKeys = new Set(entries.map(({ session }) => session.cacheKey));
  const existingIdentityKeys = new Set(existingHidden.map((entry) => entry.identityKey));
  const existingCacheKeys = new Set(existingHidden.map((entry) => entry.cacheKey));
  const nonTargetCount = existingHidden.filter((entry) =>
    !targetIdentityKeys.has(entry.identityKey) && !targetCacheKeys.has(entry.cacheKey)).length;
  let remaining = Math.max(0, MAX_HIDDEN_SESSIONS - nonTargetCount);
  const desired = entries.filter(({ entry }) => entry.hidden === true);
  const prioritized = [
    ...desired.filter(({ session }) =>
      existingIdentityKeys.has(session.identityKey) || existingCacheKeys.has(session.cacheKey)),
    ...desired.filter(({ session }) =>
      !existingIdentityKeys.has(session.identityKey) && !existingCacheKeys.has(session.cacheKey)),
  ];
  const allowed = new Set<string>();
  for (const { session } of prioritized) {
    if (remaining <= 0) break;
    allowed.add(session.identityKey);
    remaining -= 1;
  }
  return allowed;
}

function buildPinCacheKeysByIdentity(entries: Iterable<PinEntry>): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (entry.identityKey) appendSetMapValue(result, entry.identityKey, entry.cacheKey);
  }
  return result;
}

function getMatchingPinCacheKeys(
  session: SessionSummary,
  pins: ReadonlyMap<string, PinEntry>,
  cacheKeysByIdentity: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
  const result = new Set(cacheKeysByIdentity.get(session.identityKey) ?? []);
  if (pins.has(session.cacheKey)) result.add(session.cacheKey);
  return result;
}

function buildBookmarkKeysBySession(entries: Iterable<BookmarkEntry>): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const entry of entries) appendSetMapValue(result, entry.sessionCacheKey, entry.key);
  return result;
}

function appendSetMapValue(
  map: Map<string, Set<string>>,
  key: string,
  value: string,
): void {
  const values = map.get(key) ?? new Set<string>();
  values.add(value);
  map.set(key, values);
}

function sameBookmarkMetadata(left: BookmarkEntry, right: BookmarkEntry): boolean {
  return left.key === right.key &&
    left.sessionFsPath === right.sessionFsPath &&
    left.sessionCacheKey === right.sessionCacheKey &&
    left.kind === right.kind &&
    left.groupId === right.groupId &&
    left.title === right.title &&
    left.messageIndex === right.messageIndex &&
    left.timestampIso === right.timestampIso;
}

function snapshotSessionMetadataStores(stores: SessionMetadataStores): SessionMetadataStoreSnapshots {
  return {
    annotations: stores.annotations.getAll(),
    titles: stores.titles.getAll(),
    pins: stores.pins.getAll(),
    bookmarks: stores.bookmarks.getAll(),
    hidden: stores.hidden.getAll(),
  };
}

function emptyRestoreChangeCounts(): Pick<
  SessionMetadataRestorePreview,
  "addedTags" | "setTagSessions" | "clearedTagSessions"
  | "restoredNotes" | "overwrittenNotes" | "clearedNotes"
  | "restoredTitles" | "overwrittenTitles" | "clearedTitles"
  | "hiddenSessions" | "shownSessions" | "pinnedSessions" | "unpinnedSessions" | "restoredBookmarks"
  | "setBookmarkSessions" | "clearedBookmarkSessions"
  | "existingNotes" | "existingTitles" | "alreadyHiddenSessions" | "alreadyPinnedSessions" | "existingBookmarks"
  | "hiddenLimitSkipped"
> {
  return {
    addedTags: 0,
    setTagSessions: 0,
    clearedTagSessions: 0,
    restoredNotes: 0,
    overwrittenNotes: 0,
    clearedNotes: 0,
    restoredTitles: 0,
    overwrittenTitles: 0,
    clearedTitles: 0,
    hiddenSessions: 0,
    shownSessions: 0,
    pinnedSessions: 0,
    unpinnedSessions: 0,
    restoredBookmarks: 0,
    setBookmarkSessions: 0,
    clearedBookmarkSessions: 0,
    existingNotes: 0,
    existingTitles: 0,
    alreadyHiddenSessions: 0,
    alreadyPinnedSessions: 0,
    existingBookmarks: 0,
    hiddenLimitSkipped: 0,
  };
}

export class SessionMetadataRestoreStaleError extends Error {
  constructor() {
    super("Session metadata changed after the restore preview.");
    this.name = "SessionMetadataRestoreStaleError";
  }
}

export class SessionMetadataRestoreRollbackError extends Error {
  constructor(options?: ErrorOptions) {
    super("Session metadata restore and rollback failed.", options);
    this.name = "SessionMetadataRestoreRollbackError";
  }
}

function buildRestorePlanFingerprint(
  entries: readonly ResolvedRestoreEntry[],
  snapshots: SessionMetadataStoreSnapshots,
  mode: "merge" | "replace",
): string {
  const payload = {
    mode,
    sessions: entries.map(({ entry, session, bookmarks, bookmarksComplete }) => ({
      identityKey: session.identityKey,
      cacheKey: session.cacheKey,
      annotation: {
        tags: normalizeTags(entry.annotation?.tags ?? []),
        note: normalizeLimitedText(entry.annotation?.note, 500),
      },
      customTitle: normalizeCustomTitle(entry.customTitle),
      hidden: entry.hidden === true,
      pinned: entry.pinned === true,
      bookmarksComplete,
      bookmarks: bookmarks.map((bookmark) => ({
        key: bookmark.key,
        groupId: bookmark.groupId,
        title: bookmark.title,
        messageIndex: bookmark.messageIndex,
        timestampIso: bookmark.timestampIso,
      })).sort((left, right) => left.key.localeCompare(right.key)),
    })).sort((left, right) => left.identityKey.localeCompare(right.identityKey)),
    annotations: snapshots.annotations.slice().sort((left, right) => left.cacheKey.localeCompare(right.cacheKey)),
    titles: snapshots.titles.slice().sort((left, right) => left.key.localeCompare(right.key)),
    pins: snapshots.pins.slice().sort((left, right) => left.cacheKey.localeCompare(right.cacheKey)),
    bookmarks: snapshots.bookmarks.slice().sort((left, right) => left.key.localeCompare(right.key)),
    hidden: snapshots.hidden.slice().sort((left, right) => left.identityKey.localeCompare(right.identityKey)),
  };
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

function notifyChangedStores(
  stores: SessionMetadataStores,
  changed: { annotations: boolean; pins: boolean; bookmarks: boolean; hidden: boolean },
): void {
  if (changed.annotations) stores.annotations.notifyChanged();
  if (changed.pins) stores.pins.notifyChanged();
  if (changed.bookmarks) stores.bookmarks.notifyChanged();
  if (changed.hidden) stores.hidden.notifyChanged();
}

async function resolveRestoreEntries(
  backup: SessionMetadataBackupFile,
  index: HistoryIndex,
  options?: SessionMetadataRestoreOptions,
): Promise<ResolvedRestorePlan> {
  if (options?.mode === "replace") {
    if (!options.importMappings) throw new Error("Replace restore requires validated import mappings.");
    return resolveImportReplaceEntries(backup, index, options.importMappings, options);
  }
  const byIdentityKey = new Map<string, SessionSummary[]>();
  const bySourceAndId = new Map<string, SessionSummary[]>();
  const byRootAndRelativePath = new Map<string, SessionSummary[]>();
  for (const session of index.sessions) {
    appendMapValue(byIdentityKey, session.identityKey, session);
    const sessionId = normalizePortableSessionId(session.meta.id);
    if (sessionId) appendMapValue(bySourceAndId, `${session.source}\0${sessionId}`, session);
    const relativePath = toPortableRelativePath(session.storage.rootPath, session.fsPath);
    if (relativePath) appendMapValue(byRootAndRelativePath, `${session.storage.rootKind}\0${relativePath}`, session);
  }

  const entries: ResolvedRestoreEntry[] = [];
  let unmatched = 0;
  let ambiguous = 0;
  const seenSessions = new Set<string>();
  for (const entry of backup.sessions) {
    if (options?.token?.isCancellationRequested) throw new vscode.CancellationError();
    const locator = entry.locator;
    let candidates = locator.identityKey ? byIdentityKey.get(locator.identityKey) ?? [] : [];
    if (candidates.length === 0 && locator.sessionId) {
      candidates = bySourceAndId.get(`${locator.source}\0${locator.sessionId}`) ?? [];
    }
    if (candidates.length === 0 && locator.relativePath) {
      candidates = byRootAndRelativePath.get(`${locator.rootKind}\0${locator.relativePath}`) ?? [];
    }
    if (candidates.length === 0 && options?.importMappings) {
      const mappedPaths = options.importMappings
        .filter((mapping) =>
          mapping.source === locator.source &&
          ((locator.sessionId && mapping.sessionId === locator.sessionId) ||
            (locator.relativePath && mapping.relativePathFromSourceRoot === locator.relativePath))
        )
        .map((mapping) => normalizeCacheKey(mapping.destinationPath));
      candidates = Array.from(new Set(mappedPaths))
        .map((cacheKey) => index.byCacheKey.get(cacheKey))
        .filter((candidate): candidate is SessionSummary => candidate !== undefined);
    }
    const matching = candidates.filter((candidate) => candidate.source === locator.source);
    if (matching.length === 0) {
      unmatched += 1;
      continue;
    }
    if (matching.length !== 1 || seenSessions.has(matching[0]!.identityKey)) {
      ambiguous += 1;
      continue;
    }
    const session = matching[0]!;
    seenSessions.add(session.identityKey);
    entries.push({ entry, session, bookmarks: [], bookmarksComplete: true });
  }

  const invalidBookmarks = await resolveRestoreBookmarks(entries, options);
  return { entries, unmatched, ambiguous, invalidBookmarks, total: backup.sessions.length };
}

async function resolveImportReplaceEntries(
  backup: SessionMetadataBackupFile,
  index: HistoryIndex,
  rawMappings: readonly SessionMetadataImportMapping[],
  options?: SessionMetadataRestoreOptions,
): Promise<ResolvedRestorePlan> {
  const mappings = rawMappings
    .map(sanitizeSessionMetadataImportMapping)
    .filter((value): value is SessionMetadataImportMapping => value !== null);
  let unmatched = rawMappings.length - mappings.length;
  let ambiguous = 0;
  const mappingsByDestination = new Map<string, SessionMetadataImportMapping[]>();
  for (const mapping of mappings) {
    appendMapValue(mappingsByDestination, normalizeCacheKey(mapping.destinationPath), mapping);
  }

  const entriesBySourceAndId = new Map<string, SessionMetadataBackupEntry[]>();
  const entriesBySourceAndRelativePath = new Map<string, SessionMetadataBackupEntry[]>();
  for (const entry of backup.sessions) {
    if (entry.locator.sessionId) {
      appendMapValue(entriesBySourceAndId, `${entry.locator.source}\0${entry.locator.sessionId}`, entry);
    }
    if (entry.locator.relativePath) {
      appendMapValue(
        entriesBySourceAndRelativePath,
        `${entry.locator.source}\0${entry.locator.relativePath}`,
        entry,
      );
    }
  }

  const provisional: Array<{
    mapping: SessionMetadataImportMapping;
    session: SessionSummary;
    entry?: SessionMetadataBackupEntry;
  }> = [];
  for (const destinationMappings of mappingsByDestination.values()) {
    if (options?.token?.isCancellationRequested) throw new vscode.CancellationError();
    if (destinationMappings.length !== 1) {
      ambiguous += destinationMappings.length;
      continue;
    }
    const mapping = destinationMappings[0]!;
    const destination = index.byCacheKey.get(normalizeCacheKey(mapping.destinationPath));
    if (!destination || destination.source !== mapping.source) {
      unmatched += 1;
      continue;
    }
    const candidates = new Set<SessionMetadataBackupEntry>();
    if (mapping.sessionId) {
      for (const entry of entriesBySourceAndId.get(`${mapping.source}\0${mapping.sessionId}`) ?? []) {
        candidates.add(entry);
      }
    }
    for (const entry of entriesBySourceAndRelativePath.get(
      `${mapping.source}\0${mapping.relativePathFromSourceRoot}`,
    ) ?? []) {
      candidates.add(entry);
    }
    const matchingEntries = Array.from(candidates).filter((entry) => metadataEntryMatchesImportMapping(entry, mapping));
    if (matchingEntries.length > 1) {
      ambiguous += 1;
      continue;
    }
    provisional.push({ mapping, session: destination, entry: matchingEntries[0] });
  }

  const plansByEntry = new Map<SessionMetadataBackupEntry, typeof provisional>();
  for (const plan of provisional) {
    if (plan.entry) appendMapValue(plansByEntry, plan.entry, plan);
  }
  const reusedEntries = new Set(
    Array.from(plansByEntry.entries())
      .filter(([, plans]) => plans.length > 1)
      .map(([entry]) => entry),
  );
  const entries: ResolvedRestoreEntry[] = [];
  for (const plan of provisional) {
    if (plan.entry && reusedEntries.has(plan.entry)) {
      ambiguous += 1;
      continue;
    }
    const entry = plan.entry ?? createEmptyImportMetadataEntry(plan.mapping, plan.session);
    entries.push({
      entry,
      session: plan.session,
      ...(plan.mapping.sourcePath ? { bookmarkSourcePath: plan.mapping.sourcePath } : {}),
      bookmarks: [],
      bookmarksComplete: true,
    });
  }
  const invalidBookmarks = await resolveRestoreBookmarks(entries, options);
  return { entries, unmatched, ambiguous, invalidBookmarks, total: rawMappings.length };
}

function sanitizeSessionMetadataImportMapping(value: unknown): SessionMetadataImportMapping | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.source !== "codex" && raw.source !== "claude") return null;
  if (raw.operation !== "imported" && raw.operation !== "overwritten") return null;
  const sessionId = sanitizeOptionalSessionId(raw.sessionId);
  if (sessionId === null) return null;
  const relativePathFromSourceRoot = sanitizeRelativePath(raw.relativePathFromSourceRoot);
  const destinationPath = typeof raw.destinationPath === "string" ? raw.destinationPath.trim() : "";
  const sourcePath = typeof raw.sourcePath === "string" ? raw.sourcePath.trim() : "";
  if (!relativePathFromSourceRoot || !destinationPath || !path.isAbsolute(destinationPath)) return null;
  if (sourcePath && !path.isAbsolute(sourcePath)) return null;
  return {
    source: raw.source,
    ...(sessionId ? { sessionId } : {}),
    relativePathFromSourceRoot,
    destinationPath: path.resolve(destinationPath),
    operation: raw.operation,
    ...(sourcePath ? { sourcePath: path.resolve(sourcePath) } : {}),
  };
}

function metadataEntryMatchesImportMapping(
  entry: SessionMetadataBackupEntry,
  mapping: SessionMetadataImportMapping,
): boolean {
  if (entry.locator.source !== mapping.source) return false;
  const comparisons: boolean[] = [];
  if (entry.locator.sessionId && mapping.sessionId) {
    comparisons.push(entry.locator.sessionId === mapping.sessionId);
  }
  if (entry.locator.relativePath) {
    comparisons.push(entry.locator.relativePath === mapping.relativePathFromSourceRoot);
  }
  return comparisons.length > 0 && comparisons.every(Boolean);
}

function createEmptyImportMetadataEntry(
  mapping: SessionMetadataImportMapping,
  session: SessionSummary,
): SessionMetadataBackupEntry {
  return {
    locator: {
      ...(hasPortableStableIdentity(session) ? { identityKey: session.identityKey } : {}),
      source: mapping.source,
      ...(mapping.sessionId ? { sessionId: mapping.sessionId } : {}),
      rootKind: session.storage.rootKind,
      relativePath: mapping.relativePathFromSourceRoot,
    },
  };
}

async function resolveRestoreBookmarks(
  entries: ResolvedRestoreEntry[],
  options?: SessionMetadataRestoreOptions,
): Promise<number> {
  let invalidBookmarks = 0;
  let scannedSessions = 0;
  const bookmarkInventory = entries.map(toBookmarkScanSession);
  await mapWithConcurrency(entries, 4, async (resolved) => {
    if (options?.token?.isCancellationRequested) throw new vscode.CancellationError();
    const requested = resolved.entry.bookmarks ?? [];
    if (requested.length > 0) {
      const scanSession = toBookmarkScanSession(resolved);
      const scanned = await scanSessionBookmarkTargets(
        scanSession,
        bookmarkInventory,
      );
      if (!scanned.stable) {
        invalidBookmarks += requested.length;
        resolved.bookmarksComplete = false;
      } else {
        const targetsByFingerprint = new Map<string, BookmarkEntry[]>();
        const now = Date.now();
        for (const target of scanned.targets) {
          const fingerprint = getBookmarkTargetFingerprint(target.key);
          if (!fingerprint) continue;
          const key = `${fingerprint.kind}\0${fingerprint.targetHash}`;
          const values = targetsByFingerprint.get(key) ?? [];
          values.push({ ...target, createdAt: now, updatedAt: now });
          targetsByFingerprint.set(key, values);
        }
        for (const bookmark of requested) {
          const matches = targetsByFingerprint.get(`${bookmark.kind}\0${bookmark.targetHash}`) ?? [];
          if (matches.length !== 1) {
            invalidBookmarks += 1;
            resolved.bookmarksComplete = false;
            continue;
          }
          if (resolved.bookmarks.some((existing) => existing.key === matches[0]!.key)) {
            invalidBookmarks += 1;
            resolved.bookmarksComplete = false;
            continue;
          }
          const matched = matches[0]!;
          const fingerprint = getBookmarkTargetFingerprint(matched.key);
          if (!fingerprint) {
            invalidBookmarks += 1;
            resolved.bookmarksComplete = false;
            continue;
          }
          resolved.bookmarks.push({
            ...matched,
            key: buildBookmarkKeyFromTargetFingerprint(
              resolved.session.cacheKey,
              fingerprint.kind,
              fingerprint.targetHash,
            ),
            sessionFsPath: resolved.session.fsPath,
            sessionCacheKey: resolved.session.cacheKey,
            ...(bookmark.title ? { title: bookmark.title } : { title: undefined }),
          });
        }
      }
    }
    scannedSessions += 1;
    options?.progress?.report({ increment: entries.length > 0 ? 100 / entries.length : 100 });
    if (scannedSessions % 100 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  return invalidBookmarks;
}

function toBookmarkScanSession(resolved: ResolvedRestoreEntry): SessionSummary {
  if (!resolved.bookmarkSourcePath) return resolved.session;
  return {
    ...resolved.session,
    fsPath: resolved.bookmarkSourcePath,
    cacheKey: normalizeCacheKey(resolved.bookmarkSourcePath),
  };
}

function toBackupBookmark(value: BookmarkEntry): SessionMetadataBackupBookmark | null {
  const fingerprint = getBookmarkTargetFingerprint(value.key);
  if (!fingerprint || fingerprint.kind !== value.kind) return null;
  if (value.groupId !== undefined && (typeof value.groupId !== "string" || value.groupId.length > 512)) return null;
  if (value.title !== undefined && (typeof value.title !== "string" || value.title.length > 160)) return null;
  if (
    value.messageIndex !== undefined &&
    (!Number.isSafeInteger(value.messageIndex) || value.messageIndex < 0)
  ) return null;
  if (
    value.timestampIso !== undefined &&
    (typeof value.timestampIso !== "string" || value.timestampIso.length > 128 || !Number.isFinite(Date.parse(value.timestampIso)))
  ) return null;
  return {
    kind: value.kind,
    targetHash: fingerprint.targetHash,
    ...(value.groupId ? { groupId: normalizeLimitedText(value.groupId, 512) } : {}),
    ...(value.title ? { title: normalizeLimitedText(value.title, 160) } : {}),
    ...(value.messageIndex !== undefined ? { messageIndex: value.messageIndex } : {}),
    ...(value.timestampIso ? { timestampIso: normalizeLimitedText(value.timestampIso, 128) } : {}),
  };
}

function sanitizeBackupEntry(value: unknown): SessionMetadataBackupEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!raw.locator || typeof raw.locator !== "object" || Array.isArray(raw.locator)) return null;
  const locatorRaw = raw.locator as Record<string, unknown>;
  const identityKey = locatorRaw.identityKey === undefined
    ? ""
    : isBoundedSessionIdentityKey(locatorRaw.identityKey)
      ? locatorRaw.identityKey
      : "";
  if (locatorRaw.identityKey !== undefined && !identityKey) return null;
  if (locatorRaw.source !== "codex" && locatorRaw.source !== "claude") return null;
  if (identityKey && !isPortableStableIdentityKey(locatorRaw.source, identityKey)) return null;
  if (!isSessionRootKind(locatorRaw.rootKind)) return null;
  const sessionId = sanitizeOptionalSessionId(locatorRaw.sessionId);
  if (sessionId === null) return null;
  const relativePath = sanitizeRelativePath(locatorRaw.relativePath);
  if (locatorRaw.relativePath !== undefined && !relativePath) return null;
  if (!identityKey && !sessionId && !relativePath) return null;
  if (raw.annotation !== undefined && (!raw.annotation || typeof raw.annotation !== "object" || Array.isArray(raw.annotation))) {
    return null;
  }
  const annotationRaw = (raw.annotation ?? {}) as Record<string, unknown>;
  if (annotationRaw.tags !== undefined && (!Array.isArray(annotationRaw.tags) || annotationRaw.tags.length > 12)) return null;
  if (Array.isArray(annotationRaw.tags) && annotationRaw.tags.some((tag) =>
    typeof tag !== "string" || tag.length > 256
  )) return null;
  const tags = normalizeTags(Array.isArray(annotationRaw.tags) ? annotationRaw.tags : []);
  const note = sanitizeOptionalBoundedText(annotationRaw.note, 500);
  if (note === null) return null;
  if (raw.customTitle !== undefined && typeof raw.customTitle !== "string") return null;
  if (typeof raw.customTitle === "string" && raw.customTitle.length > 1_024) return null;
  const customTitle = normalizeCustomTitle(raw.customTitle);
  if (Array.from(customTitle).length > 120) return null;
  if (raw.bookmarks !== undefined && (!Array.isArray(raw.bookmarks) || raw.bookmarks.length > MAX_BACKUP_BOOKMARKS_PER_SESSION)) return null;
  if (raw.hidden !== undefined && raw.hidden !== true) return null;
  if (raw.pinned !== undefined && raw.pinned !== true) return null;
  const bookmarks = (Array.isArray(raw.bookmarks) ? raw.bookmarks : [])
    .map(sanitizeBackupBookmark)
    .filter((bookmark): bookmark is SessionMetadataBackupBookmark => bookmark !== null);
  if (Array.isArray(raw.bookmarks) && bookmarks.length !== raw.bookmarks.length) return null;
  return {
    locator: {
      ...(identityKey ? { identityKey } : {}),
      source: locatorRaw.source,
      ...(sessionId ? { sessionId } : {}),
      rootKind: locatorRaw.rootKind,
      ...(relativePath ? { relativePath } : {}),
    },
    ...(tags.length > 0 || note
      ? { annotation: { ...(tags.length > 0 ? { tags } : {}), ...(note ? { note } : {}) } }
      : {}),
    ...(customTitle ? { customTitle } : {}),
    ...(raw.hidden === true ? { hidden: true } : {}),
    ...(raw.pinned === true ? { pinned: true } : {}),
    ...(bookmarks.length > 0 ? { bookmarks } : {}),
  };
}

function sanitizeBackupBookmark(value: unknown): SessionMetadataBackupBookmark | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!isBookmarkKind(raw.kind)) return null;
  const targetHash = sanitizeOptionalBoundedText(raw.targetHash, 64);
  if (targetHash === null) return null;
  if (!/^[a-z0-9]{1,64}$/u.test(targetHash)) return null;
  const groupId = sanitizeOptionalBoundedText(raw.groupId, 512);
  const title = sanitizeOptionalBoundedText(raw.title, 160);
  const timestampIso = sanitizeOptionalBoundedText(raw.timestampIso, 128);
  if (groupId === null || title === null || timestampIso === null) return null;
  if (raw.timestampIso !== undefined && (!timestampIso || !Number.isFinite(Date.parse(timestampIso)))) return null;
  if (raw.messageIndex !== undefined && (
    typeof raw.messageIndex !== "number" ||
    !Number.isSafeInteger(raw.messageIndex) ||
    raw.messageIndex < 0
  )) return null;
  const messageIndex = typeof raw.messageIndex === "number" && Number.isInteger(raw.messageIndex) && raw.messageIndex >= 0
    ? raw.messageIndex
    : undefined;
  return {
    kind: raw.kind,
    targetHash,
    ...(groupId ? { groupId } : {}),
    ...(title ? { title } : {}),
    ...(messageIndex !== undefined ? { messageIndex } : {}),
    ...(timestampIso ? { timestampIso } : {}),
  };
}

function toPortableRelativePath(rootPath: string, fsPath: string): string {
  const relative = path.relative(rootPath, fsPath);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return "";
  return sanitizeRelativePath(relative.split(path.sep).join("/"));
}

function sanitizeRelativePath(value: unknown): string {
  if (typeof value !== "string") return "";
  if (value.length > 4096) return "";
  const trimmed = value.trim();
  const raw = trimmed.replace(/\\/g, "/");
  if (!raw || /[\u0000-\u001f\u007f]/u.test(raw) || raw.startsWith("/") || /^[a-z]:/iu.test(raw)) return "";
  const segments = raw.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return "";
  const normalized = path.posix.normalize(raw);
  if (normalized !== raw || normalized === "." || normalized === ".." || normalized.startsWith("../")) return "";
  return normalized;
}

function hasPortableStableIdentity(session: SessionSummary): boolean {
  return isPortableStableIdentityKey(session.source, session.identityKey);
}

function isPortableStableIdentityKey(source: SessionSource, identityKey: string): boolean {
  const idPrefix = `${source}:id:`;
  if (identityKey.startsWith(idPrefix)) {
    const sessionId = identityKey.slice(idPrefix.length);
    return sessionId.length > 0 && normalizePortableSessionId(sessionId) === sessionId;
  }
  return source === "codex" &&
    /^codex:rollout:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(identityKey);
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      await worker(values[index]!);
    }
  });
  await Promise.all(runners);
}

function normalizeTags(values: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const tag = typeof value === "string" ? value.trim() : "";
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= 12) break;
  }
  return out;
}

function sameTags(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value.trim().toLowerCase() === (right[index] ?? "").trim().toLowerCase());
}

function sameTagsExact(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function normalizeLimitedText(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function normalizePortableSessionId(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (
    normalized.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(normalized) ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(normalized)
  ) {
    return "";
  }
  return normalized;
}

function sanitizeOptionalSessionId(value: unknown): string | null {
  const normalized = sanitizeOptionalBoundedText(value, 512);
  if (normalized === null) return null;
  if (normalized && normalizePortableSessionId(normalized) !== normalized) return null;
  return normalized;
}

function sanitizeOptionalBoundedText(value: unknown, maximum: number): string | null {
  if (value === undefined) return "";
  if (typeof value !== "string") return null;
  if (value.length > maximum) return null;
  const normalized = value.trim();
  return normalized;
}

function appendMapValue<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

function isSessionRootKind(value: unknown): value is SessionRootKind {
  return value === "codexSessions" || value === "codexArchivedSessions" || value === "claudeSessions";
}

function isBookmarkKind(value: unknown): value is BookmarkTargetKind {
  return value === "message" || value === "patchGroup" || value === "tool" || value === "usage" || value === "environment" || value === "note";
}

function isBoundedExtensionVersion(value: unknown): value is string {
  return typeof value === "string" &&
    value.length <= 64 &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value);
}
