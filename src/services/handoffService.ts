import * as crypto from "node:crypto";
import { isClaudeVoiceCallRecord } from "../chat/claudeVoiceCall";
import * as fs from "node:fs/promises";
import { ClaudeQueuedInputTracker } from "../chat/claudeQueuedInput";
import * as path from "node:path";
import { extractClaudeTerminalOutput } from "../chat/claudeTerminalOutput";
import * as vscode from "vscode";
import { t } from "../i18n";
import type { SessionSource, SessionSummary } from "../sessions/sessionTypes";
import {
  buildAttachmentSummaryLines,
  detectClaudeMaterializedMessageRole,
  extractClaudeLocalCommandOutputContent,
  extractClaudeMessageContent,
  extractClaudeRequestInterruptionContent,
  extractCodexMessageContent,
  isCodexProtocolContextContent,
  selectClaudeControlContent,
} from "../chat/chatAttachments";
import type { ChatAttachment } from "../chat/chatTypes";
import { createClaudePastedPromptResolver, type ClaudePastedPromptResolver } from "../chat/claudePastedPrompt";
import { isClaudeInternalUserRecord } from "../chat/claudeTaskNotification";
import { isClaudeCompactSummaryRecord } from "../chat/claudeCompactSummary";
import { mapAssociatedProjectPath, type ProjectPathMapping } from "./projectPathMapper";
import { normalizeProjectKey, pathExists } from "../utils/fsUtils";
import { antigravityReader } from "../antigravity/antigravityReader";
import { projectAntigravityChat } from "../antigravity/antigravityChatModel";
import { antigravitySessionIdentity } from "../antigravity/antigravitySessionSummary";
import { ANTIGRAVITY_PROFILE, ANTIGRAVITY_UUID, AntigravityReadError } from "../antigravity/antigravityTypes";
import { readSessionJsonlLines } from "../sessions/codexHistoryBase";
import { CodexAnswerVisibility, readCodexAnswerRestriction } from "../sessions/codexAnswerVisibility";
import {
  CodexFileChangeEventDeduper,
  isSuccessfulCodexFileChangeEvent,
  readCodexFileChangeEvent,
} from "../sessions/codexFileChangeEvents";
import {
  isCodexCompanionPageRecord,
  readCodexAsyncQuestionMessage,
  readCodexRolloutRecordKind,
} from "../sessions/codexRolloutCompatibility";

export type HandoffTarget = "codex" | "claude" | "antigravity";

export interface CreateHandoffOptions {
  globalStorageUri: vscode.Uri;
  session: SessionSummary;
  target: HandoffTarget;
  sourceSessionsRoot: string;
  pathRewrite?: HandoffPathRewriteContext;
  sessionInventory?: readonly SessionSummary[];
  assertCurrent?: () => void;
  token?: { readonly isCancellationRequested: boolean };
  validateSource?: () => Promise<void>;
  selection?: HandoffSelection;
}

export interface HandoffResult {
  directoryUri: vscode.Uri;
  handoffUri: vscode.Uri;
  metadataUri: vscode.Uri;
  handoffPath: string;
  promptText: string;
  source: SessionSource;
  target: HandoffTarget;
  createdAtIso: string;
}

export interface CleanupHandoffsResult {
  removedDirectories: number;
  removedHandoffs: number;
  removedBytes: number;
  failedPaths: string[];
}

export interface ResolveHandoffLocationOptions {
  globalStorageUri: vscode.Uri;
  session: SessionSummary;
  sourceSessionsRoot: string;
  target?: HandoffTarget;
}

export interface HandoffLocation {
  directoryUri: vscode.Uri;
  handoffUri: vscode.Uri;
  metadataUri: vscode.Uri;
  handoffPath: string;
  source: SessionSource;
  target: HandoffTarget;
}

interface HandoffFilePair {
  body: Buffer;
  metadata: Buffer;
}

export interface HandoffSelection {
  readonly location: HandoffLocation;
  readonly originalDirectory: string;
  readonly sessionKey: string;
  readonly sessionsRoot: string;
  readonly codexDestination?: { mode: "new" } | { mode: "update"; files: HandoffFilePair };
}

export interface HandoffPathRewriteContext {
  mode: "recorded" | "relocated";
  recordedCwd?: string | null;
  displayCwd?: string | null;
  mappings?: readonly ProjectPathMapping[];
}

export interface HandoffPathRewriteMetadata {
  mode: "recorded" | "relocated";
  recordedCwd: string | null;
  displayCwd: string | null;
  mappings: ProjectPathMapping[];
  fingerprint: string;
}

type HandoffRole = "user" | "assistant" | "developer";

interface HandoffMessage {
  isContext?: boolean;
  inputId?: string;
  role: HandoffRole;
  text: string;
}

interface HandoffDiffBlock {
  path: string;
  changeType?: string;
  diff: string;
}

interface ParsedSessionContext {
  messages: HandoffMessage[];
  diffBlocks: HandoffDiffBlock[];
  invalidJsonLines: number;
  totalLines: number;
  native?: { profile: typeof ANTIGRAVITY_PROFILE; digest: string; partial: boolean; identityKey: string };
}

interface HandoffDirectoryInfo {
  uri: vscode.Uri;
  createdAtMs: number;
  guard: HandoffDirectoryGuard;
}
interface HandoffDirectoryGuard {
  readonly canonical: string;
  readonly ancestors: readonly { readonly path: string; readonly dev: number; readonly ino: number; readonly birthtimeMs: number }[];
}

export interface HandoffMetadata {
  schemaVersion?: 1 | 2;
  createdAt?: string;
  lastGeneratedAt?: string;
  source?: SessionSource;
  target?: HandoffTarget;
  pathRewrite?: HandoffPathRewriteMetadata;
  codexAnswerProjection?: true;
  native?: { profile: typeof ANTIGRAVITY_PROFILE; digest: string; partial: boolean; identityKey: string };
}

interface ClaudeToolCall {
  callId?: string;
  name?: string;
  input?: unknown;
}

const HANDOFF_ROOT_DIR = "handoffs";
const HANDOFF_FILE_NAME = "handoff.md";
const METADATA_FILE_NAME = "metadata.json";
const HANDOFF_SOURCE_DIRS: readonly SessionSource[] = ["codex", "claude", "antigravity"];
const RETENTION_DAYS = 30;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
const MAX_HANDOFF_DIRECTORIES = 100;
const MAX_HANDOFF_CHARS = 1_200_000;
const MAX_TRANSCRIPT_CHARS = 1_000_000;
const MAX_GOAL_CHARS = 24_000;
const MAX_DIFF_CHARS = 180_000;
const MAX_SINGLE_DIFF_CHARS = 60_000;
const MAX_DIFF_BLOCKS = 60;
const MAX_SYNTHETIC_WRITE_LINES = 4_000;
const MAX_HANDOFF_PATH_SEGMENT_LENGTH = 120;
const MAX_MANAGED_HANDOFF_BYTES = 8 * 1024 * 1024;
const PATH_REWRITE_ALGORITHM_VERSION = 1;
const maintenanceQueues = new Map<string, Promise<void>>();
const protectionByDirectory = new Map<string, { owners: number; until: number }>();
const clearListeners = new Set<() => void>();
let clearGeneration = 0;
function pruneHandoffProtection(now = Date.now()): void {
  for (const [key, entry] of protectionByDirectory) if (!entry.owners && entry.until <= now) protectionByDirectory.delete(key);
}

export function onWillClearHandoffs(listener: () => void): { dispose(): void } {
  clearListeners.add(listener); return { dispose: () => { clearListeners.delete(listener); } };
}
export function protectHandoffDirectory(directory: string): { dispose(): void; retainFor(milliseconds: number): void } {
  pruneHandoffProtection();
  const key = normalizeFsPathKey(directory), entry = protectionByDirectory.get(key) ?? { owners: 0, until: 0 }; entry.owners++; protectionByDirectory.set(key, entry);
  let disposed = false;
  return {
    retainFor(milliseconds) { if (!disposed && Number.isFinite(milliseconds)) entry.until = Math.max(entry.until, Date.now() + Math.max(0, Math.min(120000, milliseconds))); },
    dispose() { if (disposed) return; disposed = true; entry.owners--; if (!entry.owners && entry.until <= Date.now()) protectionByDirectory.delete(key); },
  };
}
async function withHandoffMaintenance<T>(storage: vscode.Uri, operation: () => Promise<T>): Promise<T> {
  const key = normalizeFsPathKey(storage.fsPath), previous = maintenanceQueues.get(key) ?? Promise.resolve();
  const result = previous.then(operation, operation), settled = result.then(() => undefined, () => undefined); maintenanceQueues.set(key, settled);
  try { return await result; }
  finally { if (maintenanceQueues.get(key) === settled) maintenanceQueues.delete(key); }
}
const ABSOLUTE_PATH_START_RE = /[A-Za-z]:[\\/]|\\\\[^\\/\s"'`<>|]+[\\/][^\\/\s"'`<>|]+[\\/]|\/(?!\/)/g;
const TRAILING_PATH_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", ")", "]", "}", "、", "。", "，", "．"]);

// Create or update a cross-agent handoff in global storage.
export async function createHandoff(options: CreateHandoffOptions): Promise<HandoffResult> {
  const generation = clearGeneration;
  const checked = { ...options, assertCurrent: () => {
    if (generation !== clearGeneration || options.token?.isCancellationRequested) throw new Error("Handoff generation was invalidated.");
    options.assertCurrent?.();
  } };
  const original = resolveHandoffLocation(options);
  const originalProtection = protectHandoffDirectory(original.directoryUri.fsPath);
  let selectedProtection: ReturnType<typeof protectHandoffDirectory> | undefined;
  try {
    const selection = options.selection ?? await selectCurrentHandoffLocation(options);
    const location = requireHandoffSelection(options, original, selection);
    if (location.directoryUri.fsPath !== original.directoryUri.fsPath) {
      selectedProtection = protectHandoffDirectory(location.directoryUri.fsPath);
    }
    checked.assertCurrent();
    return await createHandoffCore(checked, selection);
  } finally {
    selectedProtection?.dispose();
    originalProtection.dispose();
  }
}

async function createHandoffCore(options: CreateHandoffOptions, selection: HandoffSelection): Promise<HandoffResult> {
  const { location, codexDestination } = selection;
  const createdAt = new Date();
  const createdAtIso = createdAt.toISOString();
  const source = options.session.source;
  const target = options.target;
  const mirror = buildHandoffDirectoryMirror(options.session, options.sourceSessionsRoot);
  const directoryUri = location.directoryUri;
  const pathRewrite = normalizeHandoffPathRewriteContext(options.pathRewrite);

  const context = await parseSessionForHandoff(options.session, options.sessionInventory, options.token);
  options.assertCurrent?.();
  const markdown = clampText(
    buildHandoffMarkdown({
      session: options.session,
      context,
      pathRewrite,
    }),
    MAX_HANDOFF_CHARS,
  );

  const handoffUri = location.handoffUri;
  const metadataUri = location.metadataUri;
  const sourceSessionStat = await statSourceSession(options.session.fsPath);

  const metadata = {
    schemaVersion: source === "antigravity" ? 2 : 1,
    createdAt: createdAtIso,
    lastGeneratedAt: createdAtIso,
    source,
    target,
    direction: `${source}-to-${target}`,
    sourceSessionId: options.session.meta.id ?? null,
    sourceSessionPath: options.session.fsPath,
    sourceSessionsRoot: options.sourceSessionsRoot,
    sourceSessionRelativePath: mirror.relativePath,
    sourceSessionMtime: sourceSessionStat?.mtime ?? null,
    sourceSessionSize: sourceSessionStat?.size ?? null,
    handoffPath: handoffUri.fsPath,
    handoffPathMode: mirror.mode,
    transcriptMode: "tail-prioritized-message-excerpt-with-file-changes",
    pathRewrite,
    ...(context.native ? { native: context.native } : {}),
    ...(source === "codex" ? { codexAnswerProjection: true } : {}),
    includes: ["file changes when recoverable"],
    excludes: ["tool calls", "tool outputs"],
    retention: {
      days: RETENTION_DAYS,
      maxEntries: MAX_HANDOFF_DIRECTORIES,
    },
  };
  if (context.native && (await antigravityReader.readSession(options.session.fsPath, options.token)).digest !== context.native.digest) throw new AntigravityReadError("sourceChanged");
  await options.validateSource?.();
  options.assertCurrent?.();
  await withHandoffMaintenance(options.globalStorageUri, async () => {
    options.assertCurrent?.();
    await publishHandoffFiles(options.globalStorageUri, directoryUri, markdown, `${JSON.stringify(metadata, null, 2)}\n`, options.assertCurrent, codexDestination);
  });

  await cleanupHandoffs(options.globalStorageUri, { mode: "expired", preserveDirectoryFsPath: directoryUri.fsPath });

  return {
    directoryUri,
    handoffUri,
    metadataUri,
    handoffPath: handoffUri.fsPath,
    promptText: buildHandoffPrompt(handoffUri.fsPath),
    source,
    target,
    createdAtIso,
  };
}

// Delete generated handoffs. "expired" keeps recent entries, "all" removes everything.
export async function cleanupHandoffs(
  globalStorageUri: vscode.Uri,
  options?: { mode?: "expired" | "all"; preserveDirectoryFsPath?: string; now?: Date },
): Promise<CleanupHandoffsResult> {
  if (options?.mode === "all") { clearGeneration++; for (const listener of clearListeners) listener(); }
  return withHandoffMaintenance(globalStorageUri, () => cleanupHandoffsCore(globalStorageUri, options));
}

async function cleanupHandoffsCore(globalStorageUri: vscode.Uri, options?: { mode?: "expired" | "all"; preserveDirectoryFsPath?: string; now?: Date }): Promise<CleanupHandoffsResult> {
  pruneHandoffProtection();
  const mode = options?.mode ?? "expired";
  const handoffRootUri = vscode.Uri.joinPath(globalStorageUri, HANDOFF_ROOT_DIR);
  let rootGuard: HandoffDirectoryGuard;
  try {
    rootGuard = await inspectHandoffDirectory(globalStorageUri, handoffRootUri);
  } catch (error) {
    const absent = error && typeof error === "object" && "code" in error && error.code === "ENOENT";
    return { removedDirectories: 0, removedHandoffs: 0, removedBytes: 0, failedPaths: absent ? [] : [handoffRootUri.fsPath] };
  }
  if (mode === "all") {
    try {
      const stats = await collectDirectoryStats(globalStorageUri, handoffRootUri, rootGuard);
      assertHandoffDirectoryGuard(await inspectHandoffDirectory(globalStorageUri, handoffRootUri), rootGuard);
      await vscode.workspace.fs.delete(handoffRootUri, { recursive: true, useTrash: false });
      return {
        removedDirectories: stats.fileCount > 0 ? 1 : 0,
        removedHandoffs: stats.fileCount,
        removedBytes: stats.bytes,
        failedPaths: [],
      };
    } catch {
      return {
        removedDirectories: 0,
        removedHandoffs: 0,
        removedBytes: 0,
        failedPaths: [handoffRootUri.fsPath],
      };
    }
  }

  const nowMs = (options?.now ?? new Date()).getTime();
  const preserveKey = normalizeFsPathKey(options?.preserveDirectoryFsPath);
  const failedPaths: string[] = [];
  const directories = await listCurrentHandoffDirectories(globalStorageUri, handoffRootUri, rootGuard, failedPaths);
  const ordered = directories.slice().sort((a, b) => b.createdAtMs - a.createdAtMs);
  let removedDirectories = 0;
  let removedHandoffs = 0;
  let removedBytes = 0;

  for (let index = 0; index < ordered.length; index += 1) {
    const dir = ordered[index]!;
    const directoryKey = normalizeFsPathKey(dir.uri.fsPath);
    if (directoryKey === preserveKey) continue;
    const protection = protectionByDirectory.get(directoryKey);
    if (protection && (protection.owners > 0 || protection.until > nowMs)) continue;
    if (protection) protectionByDirectory.delete(directoryKey);

    const shouldDelete =
      nowMs - dir.createdAtMs > RETENTION_MS ||
      index >= MAX_HANDOFF_DIRECTORIES;
    if (!shouldDelete) continue;

    try {
      const stats = await collectDirectoryStats(globalStorageUri, dir.uri, dir.guard);
      // Recheck every ancestor after metadata/stat awaits and immediately before recursive deletion.
      assertHandoffDirectoryGuard(await inspectHandoffDirectory(globalStorageUri, dir.uri), dir.guard);
      const lateProtection = protectionByDirectory.get(directoryKey);
      if (lateProtection && (lateProtection.owners > 0 || lateProtection.until > nowMs)) continue;
      await vscode.workspace.fs.delete(dir.uri, { recursive: true, useTrash: false });
      removedDirectories += 1;
      removedHandoffs += stats.fileCount;
      removedBytes += stats.bytes;
    } catch {
      failedPaths.push(dir.uri.fsPath);
    }
  }

  return { removedDirectories, removedHandoffs, removedBytes, failedPaths };
}

export function resolveHandoffLocation(options: ResolveHandoffLocationOptions): HandoffLocation {
  if (options.session.source === "antigravity" && options.target === undefined) throw new Error("An explicit native handoff target is required.");
  const target = options.target ?? resolveDefaultHandoffTarget(options.session.source);
  if (!["codex", "claude", "antigravity"].includes(target) || options.session.source === target) throw new Error("Invalid handoff target.");
  if (!isHandoffFileUri(options.globalStorageUri)) throw new Error("Unsupported handoff storage.");
  const handoffRootUri = vscode.Uri.joinPath(vscode.Uri.file(options.globalStorageUri.fsPath), HANDOFF_ROOT_DIR);
  const mirror = buildHandoffDirectoryMirror(options.session, options.sourceSessionsRoot);
  const directoryUri = vscode.Uri.joinPath(handoffRootUri, ...mirror.segments);
  const handoffUri = vscode.Uri.joinPath(directoryUri, HANDOFF_FILE_NAME);
  const metadataUri = vscode.Uri.joinPath(directoryUri, METADATA_FILE_NAME);
  return {
    directoryUri,
    handoffUri,
    metadataUri,
    handoffPath: handoffUri.fsPath,
    source: options.session.source,
    target,
  };
}

function requireHandoffSelection(
  options: ResolveHandoffLocationOptions,
  original: HandoffLocation,
  selection: HandoffSelection,
): HandoffLocation {
  const { location } = selection;
  if (selection.originalDirectory !== original.directoryUri.fsPath || selection.sessionKey !== options.session.cacheKey ||
    selection.sessionsRoot !== options.sourceSessionsRoot || location.source !== original.source || location.target !== original.target) {
    throw new Error("Handoff selection no longer matches the requested session.");
  }
  return location;
}

export async function selectCurrentHandoffLocation(options: ResolveHandoffLocationOptions): Promise<HandoffSelection> {
  const original = resolveHandoffLocation(options);
  const scope = { originalDirectory: original.directoryUri.fsPath, sessionKey: options.session.cacheKey,
    sessionsRoot: options.sourceSessionsRoot };
  if (options.session.source !== "codex") return { ...scope, location: original };
  const suffix = crypto.createHash("sha256").update(normalizeFsPathKey(original.directoryUri.fsPath), "utf8").digest("hex").slice(0, 24);
  const sibling = vscode.Uri.joinPath(original.directoryUri, "..", `codex-display-${suffix}`);
  const handoffUri = vscode.Uri.joinPath(sibling, HANDOFF_FILE_NAME);
  const metadataUri = vscode.Uri.joinPath(sibling, METADATA_FILE_NAME);
  const protectedLocation = { ...original, directoryUri: sibling, handoffUri, metadataUri, handoffPath: handoffUri.fsPath };
  const protectedFiles = await readProjectedHandoffPair(options.globalStorageUri, protectedLocation);
  if (protectedFiles) return { ...scope, location: protectedLocation, codexDestination: { mode: "update", files: protectedFiles } };
  const originalFiles = await readProjectedHandoffPair(options.globalStorageUri, original);
  if (originalFiles) return { ...scope, location: original, codexDestination: { mode: "update", files: originalFiles } };
  if (!await isHandoffLocationOccupied(original)) return { ...scope, location: original, codexDestination: { mode: "new" } };
  if (await isHandoffLocationOccupied(protectedLocation)) throw new Error("Protected handoff location is unavailable.");
  return { ...scope, location: protectedLocation, codexDestination: { mode: "new" } };
}

async function readProjectedHandoffPair(storage: vscode.Uri, location: HandoffLocation): Promise<HandoffFilePair | undefined> {
  try {
    const directory = await ensureHandoffDirectory(storage, location.directoryUri, false);
    const [body, metadata] = await Promise.all([
      boundedFile(path.join(directory, HANDOFF_FILE_NAME), MAX_MANAGED_HANDOFF_BYTES),
      boundedFile(path.join(directory, METADATA_FILE_NAME), 65536),
    ]);
    if (body && metadata && parseHandoffMetadata(metadata).codexAnswerProjection) return { body, metadata };
    return undefined;
  } catch { return undefined; }
}

async function isHandoffLocationOccupied(location: HandoffLocation): Promise<boolean> {
  for (const file of [location.handoffPath, location.metadataUri.fsPath]) {
    try {
      await fs.lstat(file);
      return true;
    } catch (error) {
      if (!isMissingHandoffPath(error)) throw error;
    }
  }
  return false;
}

export async function canReuseHandoffFile(storage: vscode.Uri, location: HandoffLocation): Promise<boolean> {
  if (location.source !== "codex") return pathExists(location.handoffPath);
  try {
    const directory = await ensureHandoffDirectory(storage, location.directoryUri, false);
    const body = await fs.lstat(path.join(directory, HANDOFF_FILE_NAME));
    return body.isFile() && !body.isSymbolicLink() && body.size <= MAX_MANAGED_HANDOFF_BYTES &&
      (await readHandoffMetadata(vscode.Uri.file(path.join(directory, METADATA_FILE_NAME)))).codexAnswerProjection === true;
  } catch {
    return false;
  }
}

function resolveDefaultHandoffTarget(source: SessionSource): HandoffTarget {
  return source === "claude" ? "codex" : "claude";
}

export function buildHandoffPrompt(handoffPath: string): string {
  return [
    t("handoff.template.prompt.readFile"),
    "",
    handoffPath,
    "",
    t("handoff.template.prompt.omissions"),
  ].join("\n");
}

export async function isAntigravityHandoffStale(metadata: HandoffMetadata, session: SessionSummary): Promise<boolean> {
  if (session.source !== "antigravity") return false;
  if (metadata.schemaVersion !== 2 || metadata.native?.identityKey !== session.identityKey || metadata.native.profile !== ANTIGRAVITY_PROFILE) return true;
  try { return (await antigravityReader.readSession(session.fsPath)).digest !== metadata.native.digest; }
  catch { return true; }
}

export async function updateHandoffTarget(options: ResolveHandoffLocationOptions & {
  target: HandoffTarget;
  selection?: HandoffSelection;
  assertCurrent?: () => void;
}): Promise<void> {
  const generation = clearGeneration;
  const selection = options.selection ?? await selectCurrentHandoffLocation(options);
  const location = requireHandoffSelection(options, resolveHandoffLocation(options), selection);
  const { codexDestination } = selection;
  if (options.session.source === "codex" && codexDestination?.mode !== "update") throw new Error("Protected handoff is unavailable.");
  await withHandoffMaintenance(options.globalStorageUri, async () => {
    const check = (): void => {
      if (generation !== clearGeneration) throw new Error("Handoff target update was invalidated.");
      options.assertCurrent?.();
    };
    check();
    const directory = await ensureHandoffDirectory(options.globalStorageUri, location.directoryUri, false);
    const raw = await boundedFile(path.join(directory, METADATA_FILE_NAME), 65536);
    const body = await boundedFile(path.join(directory, HANDOFF_FILE_NAME), MAX_MANAGED_HANDOFF_BYTES);
    if (!raw || !body) throw new Error("Handoff files are unavailable.");
    const metadata = parseHandoffMetadata(raw);
    if (metadata.source !== options.session.source ||
        (options.session.source === "codex" && !metadata.codexAnswerProjection) ||
        (options.session.source === "antigravity" && metadata.native?.identityKey !== options.session.identityKey)) {
      throw new Error("Handoff metadata does not match its source.");
    }
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const parsed = JSON.parse(decoder.decode(raw)) as Record<string, unknown>;
    parsed.target = options.target;
    parsed.direction = options.session.source + "-to-" + options.target;
    check();
    await publishHandoffFiles(options.globalStorageUri, location.directoryUri, decoder.decode(body), JSON.stringify(parsed, null, 2) + "\n", check, codexDestination);
  });
}

async function parseSessionForHandoff(
  session: SessionSummary,
  sessionInventory?: readonly SessionSummary[],
  token?: { readonly isCancellationRequested: boolean },
): Promise<ParsedSessionContext> {
  if (session.source === "antigravity") {
    const locator = antigravityReader.locator(session.fsPath), data = await antigravityReader.readSession(session.fsPath, token);
    if (session.meta.id !== data.metadata.conversationId || session.identityKey !== antigravitySessionIdentity(locator.rootPath, data.metadata.conversationId)) throw new AntigravityReadError("sourceChanged");
    const { model, issues } = projectAntigravityChat(data, session.fsPath, locator.rootPath, { includeDetails: false, images: { enabled: false, maxSizeMB: 1, thumbnailSize: "small" } });
    const messages: HandoffMessage[] = [];
    for (const item of model.items) {
      if (item.type !== "message" || item.role !== "user" && item.role !== "assistant") continue;
      const text = sanitizeMessageText([item.text, ...buildAttachmentSummaryLines(item.attachments ?? [], { mode: "resume" })].filter(Boolean).join("\n"));
      if (text) messages.push({ role: item.role, text });
    }
    return { messages, diffBlocks: [], invalidJsonLines: issues.length ? 1 : 0, totalLines: data.steps.length,
      native: { profile: ANTIGRAVITY_PROFILE, digest: data.digest, partial: issues.length > 0, identityKey: session.identityKey } };
  }
  const pastedPromptResolver = await createClaudePastedPromptResolver(session.fsPath);
  const messages: HandoffMessage[] = [];
  const queuedInputs = new ClaudeQueuedInputTracker();
  const diffBlocks: HandoffDiffBlock[] = [];
  const seenCodexAsyncQuestionIds = new Set<string>();
  const fileChangeDeduper = new CodexFileChangeEventDeduper();
  const answerVisibility = session.source === "codex" ? new CodexAnswerVisibility() : undefined;
  let invalidJsonLines = 0;
  let totalLines = 0;

  for await (const record of readSessionJsonlLines(session.fsPath, session.source, {
    claudeSessionsRoot: session.source === "claude" ? session.storage.rootPath : undefined,
    applyCodexRollbacks: true,
    sessionInventory,
    token,
  })) {
    const { line } = record;
    totalLines += 1;
    if (!line.trim()) continue;

    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      invalidJsonLines += 1;
      continue;
    }

    const protectedRecord = answerVisibility?.project(obj);
    if (protectedRecord) obj = await protectedRecord;
    if (session.source === "claude" && !isClaudeVoiceCallRecord(obj)) {
      const input = queuedInputs.accept(obj, record.lineIndex);
      if (input) {
        messages.push({ role: "user", text: sanitizeMessageText(input.body), inputId: input.inputId });
        continue;
      }
    }
    if (await collectCodexMessage(obj, messages, seenCodexAsyncQuestionIds)) {
      collectCodexDiffBlocks(obj, diffBlocks, fileChangeDeduper);
      continue;
    }
    await collectClaudeMessage(obj, messages, pastedPromptResolver);
    collectClaudeDiffBlocks(obj, diffBlocks);
    collectCodexDiffBlocks(obj, diffBlocks, fileChangeDeduper);
  }

  return { messages: messages.filter((message) => !message.inputId || queuedInputs.isVisible(message.inputId)),
    diffBlocks, invalidJsonLines, totalLines };
}

async function collectCodexMessage(
  obj: any,
  messages: HandoffMessage[],
  seenAsyncQuestionIds: Set<string>,
): Promise<boolean> {
  if (readCodexAnswerRestriction(obj) || isCodexCompanionPageRecord(obj)) return true;
  const asyncQuestion = readCodexAsyncQuestionMessage(obj);
  if (asyncQuestion) {
    if (seenAsyncQuestionIds.has(asyncQuestion.itemId)) return true;
    const text = sanitizeMessageText(asyncQuestion.text);
    if (!text) return true;
    seenAsyncQuestionIds.add(asyncQuestion.itemId);
    messages.push({ role: "assistant", text });
    return true;
  }
  const recordKind = readCodexRolloutRecordKind(obj);
  if (recordKind && recordKind !== "response_item") return true;
  if (obj?.type !== "response_item") return false;
  if (obj?.payload?.type !== "message") return true;

  const role = obj?.payload?.role;
  if (role !== "user" && role !== "assistant" && role !== "developer") return true;

  const content = obj?.payload?.content;
  if (role === "user" && isCodexProtocolContextContent(content)) return true;

  const extracted = await extractCodexMessageContent(content, undefined, { enabled: false }, { role });
  const text = sanitizeMessageText(
    combineHandoffText(buildHandoffAttachmentSummary(extracted.attachments), extracted.text),
  );
  if (!text) return true;

  messages.push({
    role,
    text,
  });
  return true;
}

async function collectClaudeMessage(
  obj: any,
  messages: HandoffMessage[],
  pastedPromptResolver?: ClaudePastedPromptResolver,
): Promise<boolean> {
  if (isClaudeVoiceCallRecord(obj)) return true;
  const role = detectClaudeMessageRole(obj);
  if (!role) return false;
  if (isClaudeInternalUserRecord(obj)) return true;

  const rawContent = getClaudeMessageContent(obj);
  const pastedPrompt = role === "user" ? await pastedPromptResolver?.resolve(obj, rawContent) : undefined;
  const controlContent = selectClaudeControlContent(rawContent, pastedPrompt);
  if (role === "user" && extractClaudeRequestInterruptionContent(controlContent, obj)) return true;
  if (role === "user" && extractClaudeLocalCommandOutputContent(controlContent)) return true;
  if (extractClaudeTerminalOutput(obj, controlContent)) return true;
  const extracted = await extractClaudeMessageContent(rawContent, undefined, { enabled: false }, { role, pastedPrompt, record: obj });
  const text = sanitizeMessageText(combineHandoffText(buildHandoffAttachmentSummary(extracted.attachments), extracted.text));
  if (!text) return true;

  messages.push({
    role,
    text,
    ...(isClaudeCompactSummaryRecord(obj) ? { isContext: true } : {}),
  });
  return true;
}

function collectCodexDiffBlocks(
  obj: any,
  diffBlocks: HandoffDiffBlock[],
  fileChangeDeduper: CodexFileChangeEventDeduper,
): void {
  if (diffBlocks.length >= MAX_DIFF_BLOCKS) return;
  const fileChangeEvent = readCodexFileChangeEvent(obj);
  if (!fileChangeEvent || !isSuccessfulCodexFileChangeEvent(fileChangeEvent)) return;
  if (fileChangeDeduper.shouldSuppress(fileChangeEvent)) return;

  const changes = fileChangeEvent.changes;
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return;

  for (const [rawPath, rawChange] of Object.entries(changes as Record<string, unknown>)) {
    if (diffBlocks.length >= MAX_DIFF_BLOCKS) break;
    const change = rawChange && typeof rawChange === "object" ? (rawChange as Record<string, unknown>) : {};
    const unifiedDiff = typeof change.unified_diff === "string" ? sanitizeMessageText(change.unified_diff) : "";
    if (!unifiedDiff) continue;
    appendDiffBlock(diffBlocks, {
      path: rawPath,
      changeType: typeof change.type === "string" ? change.type : undefined,
      diff: clampText(unifiedDiff, MAX_SINGLE_DIFF_CHARS),
    });
  }
}

function collectClaudeDiffBlocks(obj: any, diffBlocks: HandoffDiffBlock[]): void {
  if (isClaudeVoiceCallRecord(obj)) return;
  if (diffBlocks.length >= MAX_DIFF_BLOCKS) return;
  if (isClaudeInternalUserRecord(obj)) return;
  if (!detectClaudeMessageRole(obj)) return;

  const toolCalls = extractClaudeToolCalls(getClaudeMessageContent(obj));
  for (const toolCall of toolCalls) {
    if (diffBlocks.length >= MAX_DIFF_BLOCKS) break;
    for (const block of buildClaudeToolDiffBlocks(toolCall)) {
      appendDiffBlock(diffBlocks, block);
      if (diffBlocks.length >= MAX_DIFF_BLOCKS) break;
    }
  }
}

function buildClaudeToolDiffBlocks(toolCall: ClaudeToolCall): HandoffDiffBlock[] {
  const toolName = normalizeToolName(toolCall.name);
  if (!toolName.includes("edit") && !toolName.includes("write")) return [];

  const input = normalizeToolInput(toolCall.input);
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const inputRecord = input as Record<string, unknown>;
  const filePath = readStringField(inputRecord, ["file_path", "filePath", "path", "target_file", "targetPath"]);
  if (!filePath) return [];

  if (toolName.includes("multiedit")) {
    const edits = Array.isArray(inputRecord.edits) ? inputRecord.edits : [];
    const chunks: string[] = [];
    for (let index = 0; index < edits.length; index += 1) {
      const edit = edits[index];
      if (!edit || typeof edit !== "object" || Array.isArray(edit)) continue;
      const editRecord = edit as Record<string, unknown>;
      const oldText = readStringField(editRecord, ["old_string", "oldString"]);
      const newText = readStringField(editRecord, ["new_string", "newString"]);
      if (oldText === undefined || newText === undefined || oldText === newText) continue;
      chunks.push(buildReplacementDiff(oldText, newText, `@@ Claude MultiEdit ${index + 1} @@`));
    }
    if (chunks.length === 0) return [];
    return [
      {
        path: filePath,
        changeType: "update",
        diff: clampText(sanitizeMessageText(chunks.join("\n\n")), MAX_SINGLE_DIFF_CHARS),
      },
    ];
  }

  if (toolName.includes("edit")) {
    const oldText = readStringField(inputRecord, ["old_string", "oldString"]);
    const newText = readStringField(inputRecord, ["new_string", "newString"]);
    if (oldText === undefined || newText === undefined || oldText === newText) return [];
    return [
      {
        path: filePath,
        changeType: "update",
        diff: clampText(sanitizeMessageText(buildReplacementDiff(oldText, newText, "@@ Claude Edit @@")), MAX_SINGLE_DIFF_CHARS),
      },
    ];
  }

  if (toolName.includes("write")) {
    const content = readStringField(inputRecord, ["content"]);
    if (content === undefined) return [];
    return [
      {
        path: filePath,
        changeType: "write",
        diff: clampText(sanitizeMessageText(buildWriteDiff(content)), MAX_SINGLE_DIFF_CHARS),
      },
    ];
  }

  return [];
}

function appendDiffBlock(diffBlocks: HandoffDiffBlock[], block: HandoffDiffBlock): void {
  if (diffBlocks.length >= MAX_DIFF_BLOCKS) return;
  const key = `${block.path}\u0000${block.changeType ?? ""}\u0000${block.diff}`;
  const duplicate = diffBlocks.some((existing) => `${existing.path}\u0000${existing.changeType ?? ""}\u0000${existing.diff}` === key);
  if (duplicate) return;
  diffBlocks.push(block);
}

function buildHandoffMarkdown(params: {
  session: SessionSummary;
  context: ParsedSessionContext;
  pathRewrite: HandoffPathRewriteMetadata;
}): string {
  const { session, context, pathRewrite } = params;
  const lines: string[] = [];
  const sourceLabel = session.source === "antigravity" ? "Antigravity" : session.source === "claude" ? "Claude Code" : "Codex";
  const currentGoal = rewriteHandoffFreeText(findLatestUserMessage(context.messages) ?? "", pathRewrite);
  const transcript = buildTranscriptExcerpt(context.messages, MAX_TRANSCRIPT_CHARS, pathRewrite);
  const diffs = buildDiffSection(context.diffBlocks, pathRewrite);
  const displayCwd = pathRewrite.mode === "relocated" ? pathRewrite.displayCwd : session.meta.cwd;

  lines.push("# Handoff");
  lines.push("");
  lines.push(`- Source: \`${sourceLabel}\``);
  lines.push(`- Source session file: \`${session.fsPath}\``);
  if (displayCwd) lines.push(`- CWD: \`${displayCwd}\``);
  if (pathRewrite.mode === "relocated") {
    if (pathRewrite.recordedCwd) lines.push(`- Recorded CWD: \`${pathRewrite.recordedCwd}\``);
    const mappingText = pathRewrite.mappings.map((mapping) => `${mapping.sourceCwd} -> ${mapping.targetCwd}`).join("; ");
    if (mappingText) lines.push(`- Path Mapping: \`${mappingText}\``);
  }
  lines.push("");
  lines.push("> Transcript is tail-prioritized. Tool calls and tool outputs are omitted. File changes are included when recoverable.");
  if (context.native?.partial) lines.push(t("antigravity.history.partial"));
  lines.push("");
  lines.push("## Latest User Request");
  lines.push("");
  lines.push(currentGoal ? clampText(currentGoal, MAX_GOAL_CHARS) : "(no user request extracted)");
  lines.push("");
  lines.push("## Transcript Excerpt");
  lines.push("");
  lines.push(transcript);
  if (diffs) {
    lines.push("");
    lines.push("## File Changes");
    lines.push("");
    lines.push(diffs);
  }
  lines.push("");

  return lines.join("\n");
}

function buildTranscriptExcerpt(
  messages: readonly HandoffMessage[],
  maxChars: number,
  pathRewrite: HandoffPathRewriteMetadata,
): string {
  if (messages.length === 0) return "(no messages extracted)";

  const blocks = messages.map((message) => renderMessageBlock(message, pathRewrite));
  const selected: string[] = [];
  let used = 0;
  let omitted = 0;

  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i]!;
    if (used + block.length + 2 > maxChars) {
      omitted = i + 1;
      if (selected.length === 0) {
        selected.unshift(clampText(block, maxChars));
      }
      break;
    }
    selected.unshift(block);
    used += block.length + 2;
  }

  const prefix = omitted > 0 ? [`(${omitted} earlier message(s) omitted due to size limits)`, ""] : [];
  return [...prefix, ...selected].join("\n\n");
}

function renderMessageBlock(message: HandoffMessage, pathRewrite: HandoffPathRewriteMetadata): string {
  const lines = [`### ${message.isContext ? "context" : message.role}`];
  lines.push("");
  lines.push(rewriteHandoffFreeText(message.text, pathRewrite));
  return lines.join("\n");
}

function buildHandoffAttachmentSummary(attachments: readonly ChatAttachment[]): string {
  const lines = buildAttachmentSummaryLines(attachments, { mode: "handoff" });
  if (lines.length === 0) return "";
  return ["Attachments and referenced files from previous session:", ...lines].join("\n");
}

function combineHandoffText(attachmentSummary: string, text: string): string {
  const cleanText = String(text ?? "").trim();
  if (!attachmentSummary) return cleanText;
  return cleanText ? `${attachmentSummary}\n\n${cleanText}` : attachmentSummary;
}

function buildDiffSection(diffBlocks: readonly HandoffDiffBlock[], pathRewrite: HandoffPathRewriteMetadata): string {
  if (diffBlocks.length === 0) return "";
  const lines: string[] = [];
  let used = 0;

  for (const block of diffBlocks) {
    const headerPath = rewriteHandoffPath(block.path, pathRewrite);
    const header = `### ${headerPath}${block.changeType ? ` (${block.changeType})` : ""}`;
    const body = ["```diff", block.diff, "```"].join("\n");
    const next = `${header}\n\n${body}`;
    if (used + next.length > MAX_DIFF_CHARS) {
      lines.push("(additional file changes omitted due to size limits)");
      break;
    }
    lines.push(next);
    used += next.length + 2;
  }

  return lines.join("\n\n");
}

function findLatestUserMessage(messages: readonly HandoffMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role === "user" && !message.isContext && message.text.trim().length > 0) return message.text.trim();
  }
  return null;
}

export function isHandoffPathRewriteStale(
  metadata: HandoffMetadata | null | undefined,
  context: HandoffPathRewriteContext | null | undefined,
): boolean {
  const current = normalizeHandoffPathRewriteContext(context);
  const existing = metadata?.pathRewrite;
  if (!existing?.fingerprint) return current.mode !== "recorded";
  return existing.fingerprint !== current.fingerprint;
}

function normalizeHandoffPathRewriteContext(
  context: HandoffPathRewriteContext | null | undefined,
): HandoffPathRewriteMetadata {
  const recordedCwd = normalizeOptionalPath(context?.recordedCwd);
  const displayCwd = normalizeOptionalPath(context?.displayCwd);
  const mappings = normalizePathRewriteMappings(context?.mappings);
  const canRelocate =
    context?.mode === "relocated" &&
    !!recordedCwd &&
    !!displayCwd &&
    normalizeProjectKey(recordedCwd) !== normalizeProjectKey(displayCwd) &&
    mappings.length > 0;
  const mode: "recorded" | "relocated" = canRelocate ? "relocated" : "recorded";
  const normalized: Omit<HandoffPathRewriteMetadata, "fingerprint"> = {
    mode,
    recordedCwd: recordedCwd ?? null,
    displayCwd: mode === "relocated" ? displayCwd : (recordedCwd ?? displayCwd ?? null),
    mappings: mode === "relocated" ? mappings : [],
  };
  return {
    ...normalized,
    fingerprint: buildPathRewriteFingerprint(normalized),
  };
}

function normalizePathRewriteMappings(mappings: readonly ProjectPathMapping[] | null | undefined): ProjectPathMapping[] {
  const seen = new Set<string>();
  const out: ProjectPathMapping[] = [];
  if (!Array.isArray(mappings)) return out;

  for (const mapping of mappings) {
    const sourceCwd = normalizeOptionalPath(mapping?.sourceCwd);
    const targetCwd = normalizeOptionalPath(mapping?.targetCwd);
    if (!sourceCwd || !targetCwd) continue;
    const sourceKey = normalizeProjectKey(sourceCwd);
    const targetKey = normalizeProjectKey(targetCwd);
    if (!sourceKey || !targetKey || sourceKey === targetKey) continue;
    const key = `${sourceKey}\u0000${targetKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ sourceCwd, targetCwd });
  }

  return out.sort((a, b) => {
    const aSource = normalizeProjectKey(a.sourceCwd);
    const bSource = normalizeProjectKey(b.sourceCwd);
    if (aSource !== bSource) return aSource.localeCompare(bSource);
    const aTarget = normalizeProjectKey(a.targetCwd);
    const bTarget = normalizeProjectKey(b.targetCwd);
    if (aTarget !== bTarget) return aTarget.localeCompare(bTarget);
    if (a.sourceCwd !== b.sourceCwd) return a.sourceCwd.localeCompare(b.sourceCwd);
    return a.targetCwd.localeCompare(b.targetCwd);
  });
}

function buildPathRewriteFingerprint(metadata: Omit<HandoffPathRewriteMetadata, "fingerprint">): string {
  const payload = {
    algorithmVersion: PATH_REWRITE_ALGORITHM_VERSION,
    mode: metadata.mode,
    recordedKey: normalizeProjectKey(metadata.recordedCwd ?? ""),
    displayKey: normalizeProjectKey(metadata.displayCwd ?? ""),
    recordedCwd: metadata.recordedCwd,
    displayCwd: metadata.displayCwd,
    mappings: metadata.mappings.map((mapping) => ({
      sourceKey: normalizeProjectKey(mapping.sourceCwd),
      targetKey: normalizeProjectKey(mapping.targetCwd),
      sourceCwd: mapping.sourceCwd,
      targetCwd: mapping.targetCwd,
    })),
  };
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

function rewriteHandoffFreeText(text: string, pathRewrite: HandoffPathRewriteMetadata): string {
  if (pathRewrite.mode !== "relocated") return text;
  const source = String(text ?? "");
  if (!source) return source;

  const scanner = new RegExp(ABSOLUTE_PATH_START_RE.source, "g");
  let output = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(source)) !== null) {
    const start = match.index;
    if (!isPathTokenBoundary(source, start) || isUrlEmbeddedPathStart(source, start)) {
      continue;
    }
    const token = readPathToken(source, start);
    scanner.lastIndex = Math.max(scanner.lastIndex, token.end);
    if (!token.value || token.value.includes("\n")) continue;
    const replacement = rewritePathTokenValue(token.value, pathRewrite);
    if (!replacement) continue;
    output += source.slice(lastIndex, start);
    output += replacement;
    lastIndex = token.end;
  }

  if (lastIndex === 0) return source;
  return output + source.slice(lastIndex);
}

function rewriteHandoffPath(pathText: string, pathRewrite: HandoffPathRewriteMetadata): string {
  if (pathRewrite.mode !== "relocated") return pathText;
  const direct = rewritePathTokenValue(pathText, pathRewrite);
  return direct ?? pathText;
}

function rewritePathTokenValue(tokenValue: string, pathRewrite: HandoffPathRewriteMetadata): string | null {
  const parts = splitPathTokenDecorations(tokenValue);
  if (!parts) return null;
  if (isLikelyUrlToken(parts.pathText)) return null;
  const mapped = mapAssociatedProjectPath(parts.pathText, pathRewrite.mappings);
  if (!mapped) return null;
  return `${mapped.fsPath}${parts.locationSuffix}${parts.trailing}`;
}

function readPathToken(text: string, start: number): { value: string; end: number } {
  const opener = start > 0 ? text[start - 1] : "";
  const closer = opener === "<" ? ">" : opener === "\"" || opener === "'" || opener === "`" ? opener : "";
  if (closer) {
    const end = text.indexOf(closer, start);
    if (end >= 0) return { value: text.slice(start, end), end };
  }

  let end = start;
  while (end < text.length) {
    const ch = text[end]!;
    if (/\s/u.test(ch) || ch === "\"" || ch === "'" || ch === "`" || ch === "<" || ch === ">" || ch === "|") break;
    end += 1;
  }
  return { value: text.slice(start, end), end };
}

function splitPathTokenDecorations(
  tokenValue: string,
): { pathText: string; locationSuffix: string; trailing: string } | null {
  let pathText = String(tokenValue ?? "").trim();
  if (!pathText) return null;
  let trailing = "";
  while (pathText.length > 0 && TRAILING_PATH_PUNCTUATION.has(pathText[pathText.length - 1]!)) {
    trailing = pathText[pathText.length - 1]! + trailing;
    pathText = pathText.slice(0, -1);
  }

  let locationSuffix = "";
  const suffixMatch = pathText.match(/(#L\d+|:\d+(?::\d+)?)$/iu);
  if (suffixMatch?.index !== undefined) {
    locationSuffix = suffixMatch[0];
    pathText = pathText.slice(0, suffixMatch.index);
  }
  if (!pathText) return null;
  return { pathText, locationSuffix, trailing };
}

function isPathTokenBoundary(text: string, start: number): boolean {
  if (start <= 0) return true;
  return !/[A-Za-z0-9_]/u.test(text[start - 1]!);
}

function isUrlEmbeddedPathStart(text: string, start: number): boolean {
  const leftBoundary = Math.max(
    text.lastIndexOf(" ", start - 1),
    text.lastIndexOf("\n", start - 1),
    text.lastIndexOf("\t", start - 1),
    text.lastIndexOf("\"", start - 1),
    text.lastIndexOf("'", start - 1),
    text.lastIndexOf("`", start - 1),
    text.lastIndexOf("<", start - 1),
  );
  const prefix = text.slice(leftBoundary + 1, start).toLowerCase();
  return prefix.includes("://");
}

function isLikelyUrlToken(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(String(value ?? "").trim());
}

function normalizeOptionalPath(value: string | null | undefined): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function extractClaudeToolCalls(content: unknown): ClaudeToolCall[] {
  const items = Array.isArray(content) ? content : content && typeof content === "object" ? [content] : [];
  const toolCalls: ClaudeToolCall[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const type = typeof obj.type === "string" ? obj.type : "";
    if (type !== "tool_use") continue;
    toolCalls.push({
      callId: typeof obj.id === "string" ? obj.id : typeof obj.tool_use_id === "string" ? obj.tool_use_id : undefined,
      name: typeof obj.name === "string" ? obj.name : undefined,
      input: obj.input,
    });
  }
  return toolCalls;
}

function normalizeToolInput(input: unknown): unknown {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function readStringField(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}

function normalizeToolName(value: unknown): string {
  return String(value ?? "").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function buildReplacementDiff(oldText: string, newText: string, header: string): string {
  const oldLines = splitContentLines(oldText);
  const newLines = splitContentLines(newText);
  return [
    "--- before",
    "+++ after",
    header,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n");
}

function buildWriteDiff(content: string): string {
  const lines = splitContentLines(content);
  const selected = lines.slice(0, MAX_SYNTHETIC_WRITE_LINES).map((line) => `+${line}`);
  if (lines.length > selected.length) {
    selected.push(`+[truncated: ${lines.length - selected.length} additional line(s) omitted]`);
  }
  return ["--- before", "+++ after", "@@ Claude Write @@", ...selected].join("\n");
}

function splitContentLines(value: string): string[] {
  const normalized = String(value ?? "").replace(/^\uFEFF/u, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized) return [];
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function detectClaudeMessageRole(obj: any): "user" | "assistant" | null {
  return detectClaudeMaterializedMessageRole(obj);
}

function getClaudeMessageContent(obj: any): unknown {
  if (obj?.message && typeof obj.message === "object" && "content" in obj.message) {
    return (obj.message as { content?: unknown }).content;
  }
  if (obj && typeof obj === "object" && "content" in obj) return (obj as { content?: unknown }).content;
  return undefined;
}

function sanitizeMessageText(text: string): string {
  const normalized = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "";
  return redactSensitiveText(normalized);
}

function redactSensitiveText(text: string): string {
  return text
    .replace(/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_ANTHROPIC_KEY]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"'\s]{8,}/gi, "$1=[REDACTED]");
}

function clampText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const keep = Math.max(0, maxChars - 80);
  return `${text.slice(0, keep)}\n\n[truncated: size limit reached]`;
}

async function boundedFile(file: string, maximum: number): Promise<Buffer | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    const named = await fs.lstat(file);
    if (!named.isFile() || named.isSymbolicLink() || named.size > maximum) throw new Error("Invalid handoff file.");
    handle = await fs.open(file, "r"); const before = await handle.stat();
    if (before.dev !== named.dev || before.ino !== named.ino || before.birthtimeMs !== named.birthtimeMs ||
      !before.isFile() || before.size > maximum) throw new Error("Handoff file changed.");
    const bytes = Buffer.alloc(before.size + 1); let total = 0;
    while (total < bytes.length) { const read = await handle.read(bytes, total, bytes.length - total, null); if (!read.bytesRead) break; total += read.bytesRead; }
    const after = await handle.stat();
    if (total > maximum || total !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Handoff file changed.");
    return bytes.subarray(0, total);
  } catch (error) {
    if (!handle && error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  } finally { await handle?.close(); }
}

function isHandoffFileUri(uri: vscode.Uri): boolean {
  if (!path.isAbsolute(uri.fsPath) || uri.fsPath.includes("\0")) return false;
  // Desktop hosts may expose the same private local directory through the user-data provider.
  return uri.scheme === "file" || (uri.scheme === "vscode-userdata" && !uri.authority && !/^[\\/]{2}/u.test(uri.fsPath));
}

async function ensureHandoffDirectory(storage: vscode.Uri, directory: vscode.Uri, create = true): Promise<string> {
  if (!isHandoffFileUri(storage) || !isHandoffFileUri(directory)) throw new Error("Unsupported handoff storage.");
  const relative = path.relative(storage.fsPath, directory.fsPath), parts = relative.split(path.sep);
  if (parts[0] !== HANDOFF_ROOT_DIR || parts.some(part => !part || part === "." || part === "..") || path.isAbsolute(relative)) throw new Error("Invalid handoff directory.");
  if (create) await fs.mkdir(storage.fsPath, { recursive: true });
  let current = await fs.realpath(storage.fsPath);
  for (const part of parts) {
    current = path.join(current, part);
    if (create) { try { await fs.mkdir(current); } catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error; } }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(current) !== current) throw new Error("Invalid handoff directory.");
  }
  return current;
}

export async function validateExistingHandoffFile(storage: vscode.Uri, location: HandoffLocation): Promise<boolean> {
  try { const directory = await ensureHandoffDirectory(storage, location.directoryUri, false); return Boolean(await boundedFile(path.join(directory, HANDOFF_FILE_NAME), 8 * 1024 * 1024)); }
  catch { return false; }
}

async function publishHandoffFiles(
  storage: vscode.Uri, directory: vscode.Uri, markdown: string, metadata: string,
  assertCurrent?: () => void, codexDestination?: HandoffSelection["codexDestination"],
): Promise<void> {
  const target = await ensureHandoffDirectory(storage, directory), body = path.join(target, HANDOFF_FILE_NAME), meta = path.join(target, METADATA_FILE_NAME);
  const previousBody = codexDestination
    ? codexDestination.mode === "update" ? codexDestination.files.body : undefined
    : await boundedFile(body, MAX_MANAGED_HANDOFF_BYTES);
  const previousMeta = codexDestination
    ? codexDestination.mode === "update" ? codexDestination.files.metadata : undefined
    : await boundedFile(meta, 65536);
  const bodyBytes = Buffer.from(markdown, "utf8"), metaBytes = Buffer.from(metadata, "utf8");
  const verifyDestination = async (file: string, expected: Buffer | undefined, maximum: number): Promise<void> => {
    const current = await boundedFile(file, maximum);
    if (expected ? !current?.equals(expected) : current !== undefined) throw new Error("Handoff destination changed.");
  };
  const nonce = crypto.randomUUID(), bodyTemp = path.join(target, `.handoff-${nonce}.tmp`), metaTemp = path.join(target, `.metadata-${nonce}.tmp`);
  const rollbackTemps: string[] = []; let bodyPublished = false, metaPublished = false;
  const restore = async (file: string, previous: Buffer | undefined, published: Buffer, maximum: number): Promise<void> => {
    const temporary = previous && path.join(target, `.rollback-${crypto.randomUUID()}.tmp`);
    if (temporary) {
      rollbackTemps.push(temporary);
      await fs.writeFile(temporary, previous, { flag: "wx" });
    }
    if (codexDestination) {
      const current = await boundedFile(file, maximum);
      if (!current?.equals(published)) return;
    }
    if (temporary) await fs.rename(temporary, file);
    else await fs.rm(file, { force: true });
  };
  try {
    await fs.writeFile(bodyTemp, bodyBytes, { flag: "wx" });
    await fs.writeFile(metaTemp, metaBytes, { flag: "wx" });
    assertCurrent?.(); await ensureHandoffDirectory(storage, directory);
    if (codexDestination) {
      await verifyDestination(meta, previousMeta, 65536);
      await verifyDestination(body, previousBody, MAX_MANAGED_HANDOFF_BYTES);
    }
    assertCurrent?.();
    // A newly selected name never becomes an update after another process claims it.
    if (codexDestination?.mode === "new") await fs.copyFile(bodyTemp, body, fs.constants.COPYFILE_EXCL);
    else await fs.rename(bodyTemp, body);
    bodyPublished = true;
    if (codexDestination) await verifyDestination(meta, previousMeta, 65536);
    assertCurrent?.();
    if (codexDestination?.mode === "new") await fs.copyFile(metaTemp, meta, fs.constants.COPYFILE_EXCL);
    else await fs.rename(metaTemp, meta);
    metaPublished = true;
    assertCurrent?.();
  } catch (error) {
    try {
      await ensureHandoffDirectory(storage, directory, false);
      if (bodyPublished) await restore(body, previousBody, bodyBytes, MAX_MANAGED_HANDOFF_BYTES);
      if (metaPublished) await restore(meta, previousMeta, metaBytes, 65536);
    }
    catch { throw new Error("Handoff publication rollback failed."); }
    throw error;
  } finally {
    // These generated temporary files are the only files removed on a failed publication.
    const removed = await Promise.allSettled([bodyTemp, metaTemp, ...rollbackTemps].map(file => fs.rm(file, { force: true })));
    if (removed.some(result => result.status === "rejected")) throw new Error("Handoff temporary cleanup failed.");
  }
}

function buildHandoffDirectoryMirror(
  session: SessionSummary,
  sourceSessionsRoot: string,
): { segments: string[]; relativePath: string | null; mode: "source-relative-mirror" | "hash-fallback" } {
  if (session.source === "antigravity") {
    const id = session.meta.id, identity = session.identityKey;
    if (typeof id !== "string" || !ANTIGRAVITY_UUID.test(id) || session.storage.rootKind !== "antigravitySessions" || session.storage.archiveState !== "active"
      || path.resolve(sourceSessionsRoot) !== path.resolve(session.storage.rootPath) || session.fsPath !== path.join(session.storage.rootPath, "conversations", id + ".db")
      || identity !== antigravitySessionIdentity(session.storage.rootPath, id)) throw new AntigravityReadError("storage");
    const rootHash = /^antigravity:root:([0-9a-f]{64}):id:/.exec(identity)?.[1];
    if (!rootHash) throw new AntigravityReadError("storage");
    return { segments: ["antigravity", rootHash, "conversations", id], relativePath: `conversations/${id}.db`, mode: "source-relative-mirror" };
  }
  const relativePath = resolveSafeRelativePath(sourceSessionsRoot, session.fsPath);
  if (relativePath) {
    const rawParts = relativePath.split(/[\\/]+/u).filter((part) => part.trim().length > 0);
    if (rawParts.length > 0) {
      const lastPart = rawParts[rawParts.length - 1]!;
      const parsedLast = path.parse(lastPart);
      rawParts[rawParts.length - 1] = parsedLast.name || lastPart;
      const safeParts = rawParts.map((part) => sanitizePathSegment(part));
      if (safeParts.length > 0) {
        return {
          segments: [session.source, ...safeParts],
          relativePath,
          mode: "source-relative-mirror",
        };
      }
    }
  }

  return {
    segments: [session.source, "by-hash", buildShortSessionId(session)],
    relativePath,
    mode: "hash-fallback",
  };
}

function resolveSafeRelativePath(rootFsPath: string, targetFsPath: string): string | null {
  const root = String(rootFsPath ?? "").trim();
  const target = String(targetFsPath ?? "").trim();
  if (!root || !target) return null;

  try {
    const relativePath = path.relative(path.resolve(root), path.resolve(target));
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;
    return relativePath;
  } catch {
    return null;
  }
}

function sanitizePathSegment(value: string): string {
  const original = String(value ?? "");
  let segment = original
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!segment || segment === "." || segment === "..") segment = "_";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(segment)) segment = `_${segment}`;
  if (segment.length <= MAX_HANDOFF_PATH_SEGMENT_LENGTH) return segment;

  const digest = crypto.createHash("sha256").update(original).digest("hex").slice(0, 8);
  return `${segment.slice(0, MAX_HANDOFF_PATH_SEGMENT_LENGTH - 9)}-${digest}`;
}

function buildShortSessionId(session: SessionSummary): string {
  const idInput = `${session.source}:${session.meta.id ?? ""}:${session.fsPath}`;
  return crypto.createHash("sha256").update(idInput).digest("hex").slice(0, 16);
}

async function listCurrentHandoffDirectories(storage: vscode.Uri, handoffRootUri: vscode.Uri, rootGuard: HandoffDirectoryGuard, failedPaths: string[]): Promise<HandoffDirectoryInfo[]> {
  const groups = await Promise.all(
    HANDOFF_SOURCE_DIRS.map((source) => listHandoffDirectories(storage, vscode.Uri.joinPath(handoffRootUri, source), rootGuard, failedPaths)),
  );
  return groups.flat();
}

async function listHandoffDirectories(storage: vscode.Uri, rootUri: vscode.Uri, rootGuard: HandoffDirectoryGuard, failedPaths: string[]): Promise<HandoffDirectoryInfo[]> {
  const out: HandoffDirectoryInfo[] = [];
  const stack: vscode.Uri[] = [rootUri];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: [string, vscode.FileType][];
    let guard: HandoffDirectoryGuard;
    try {
      guard = await inspectHandoffDirectory(storage, dir);
      assertHandoffDirectoryGuard(guard, rootGuard);
      entries = await vscode.workspace.fs.readDirectory(dir);
      assertHandoffDirectoryGuard(await inspectHandoffDirectory(storage, dir), guard);
    } catch (error) {
      if (!isMissingHandoffPath(error)) failedPaths.push(dir.fsPath);
      continue;
    }

    const hasHandoffFile = entries.some(
      ([name, type]) => name === HANDOFF_FILE_NAME && (type & vscode.FileType.File) !== 0,
    );
    if (hasHandoffFile) {
      try {
        const createdAtMs = await readHandoffCreatedAtMs(dir);
        assertHandoffDirectoryGuard(await inspectHandoffDirectory(storage, dir), guard);
        out.push({ uri: dir, createdAtMs, guard });
      } catch { failedPaths.push(dir.fsPath); }
      continue;
    }

    for (const [name, type] of entries) {
      if ((type & vscode.FileType.SymbolicLink) !== 0) { failedPaths.push(vscode.Uri.joinPath(dir, name).fsPath); continue; }
      if ((type & vscode.FileType.Directory) === 0) continue;
      stack.push(vscode.Uri.joinPath(dir, name));
    }
  }

  return out;
}

async function readHandoffCreatedAtMs(directoryUri: vscode.Uri): Promise<number> {
  const metadataUri = vscode.Uri.joinPath(directoryUri, METADATA_FILE_NAME);
  const metadata = await readHandoffMetadata(metadataUri);
  const timestamp = metadata.lastGeneratedAt ?? metadata.createdAt;
  const ms = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
  if (Number.isFinite(ms)) return ms;

  try {
    const stat = await vscode.workspace.fs.stat(directoryUri);
    if (Number.isFinite(stat.mtime)) return stat.mtime;
  } catch {
    // Fall through to Unix epoch.
  }
  return 0;
}

export async function readHandoffMetadata(metadataUri: vscode.Uri): Promise<HandoffMetadata> {
  try {
    if (!isHandoffFileUri(metadataUri)) return {};
    const bytes = await boundedFile(metadataUri.fsPath, 65536);
    return bytes ? parseHandoffMetadata(bytes) : {};
  } catch {
    return {};
  }
}

function parseHandoffMetadata(bytes: Buffer): HandoffMetadata {
  try {
    const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) return {};
    const source = parsed.source === "codex" || parsed.source === "claude" || parsed.source === "antigravity" && parsed.schemaVersion === 2 ? parsed.source : undefined;
    const target = parsed.target === "codex" || parsed.target === "claude" || parsed.target === "antigravity" ? parsed.target : undefined;
    if (!source || !target || source === target) return {};
    if ((source === "antigravity") !== (parsed.schemaVersion === 2)) return {};
    const native = parsed.native as Record<string, unknown> | undefined;
    if (source === "antigravity" && (!native || typeof native !== "object" || native.profile !== ANTIGRAVITY_PROFILE || typeof native.digest !== "string" || !/^[0-9a-f]{64}$/.test(native.digest)
      || typeof native.partial !== "boolean" || typeof native.identityKey !== "string" || !/^antigravity:root:[0-9a-f]{64}:id:/.test(native.identityKey)
      || !ANTIGRAVITY_UUID.test(native.identityKey.slice("antigravity:root:".length + 64 + ":id:".length)))) return {};
    return {
      schemaVersion: parsed.schemaVersion,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : undefined,
      lastGeneratedAt: typeof parsed.lastGeneratedAt === "string" ? parsed.lastGeneratedAt : undefined,
      source,
      target,
      pathRewrite: sanitizePathRewriteMetadata(parsed.pathRewrite),
      ...(source === "codex" && parsed.codexAnswerProjection === true ? { codexAnswerProjection: true } : {}),
      ...(source === "antigravity" ? { native: native as unknown as NonNullable<HandoffMetadata["native"]> } : {}),
    };
  } catch {
    return {};
  }
}

function sanitizePathRewriteMetadata(value: unknown): HandoffPathRewriteMetadata | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const mode = record.mode === "relocated" ? "relocated" : record.mode === "recorded" ? "recorded" : undefined;
  const fingerprint = typeof record.fingerprint === "string" ? record.fingerprint.trim() : "";
  if (!mode || !fingerprint) return undefined;
  const rawMappings = Array.isArray(record.mappings) ? record.mappings : [];
  const mappings = normalizePathRewriteMappings(
    rawMappings.map((mapping) => {
      const item = mapping && typeof mapping === "object" ? (mapping as Record<string, unknown>) : {};
      return {
        sourceCwd: typeof item.sourceCwd === "string" ? item.sourceCwd : "",
        targetCwd: typeof item.targetCwd === "string" ? item.targetCwd : "",
      };
    }),
  );
  return {
    mode,
    recordedCwd: normalizeOptionalPath(typeof record.recordedCwd === "string" ? record.recordedCwd : null),
    displayCwd: normalizeOptionalPath(typeof record.displayCwd === "string" ? record.displayCwd : null),
    mappings: mode === "relocated" ? mappings : [],
    fingerprint,
  };
}

async function statSourceSession(fsPath: string): Promise<{ mtime: number; size: number } | null> {
  try {
    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
    return { mtime: stat.mtime, size: stat.size };
  } catch {
    return null;
  }
}

function isMissingHandoffPath(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

async function inspectHandoffDirectory(storage: vscode.Uri, directory: vscode.Uri): Promise<HandoffDirectoryGuard> {
  if (!isHandoffFileUri(storage) || !isHandoffFileUri(directory)) throw new Error("Unsupported handoff storage.");
  const relative = path.relative(storage.fsPath, directory.fsPath), parts = relative.split(path.sep);
  if (parts[0] !== HANDOFF_ROOT_DIR || parts.some(part => !part || part === "." || part === "..") || path.isAbsolute(relative)) throw new Error("Invalid handoff directory.");
  let current = await fs.realpath(storage.fsPath);
  const ancestors: HandoffDirectoryGuard["ancestors"][number][] = [];
  for (const part of ["", ...parts]) {
    if (part) current = path.join(current, part);
    const before = await fs.lstat(current);
    if (!before.isDirectory() || before.isSymbolicLink() || normalizeFsPathKey(await fs.realpath(current)) !== normalizeFsPathKey(current)) throw new Error("Invalid handoff directory.");
    const after = await fs.lstat(current);
    if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.birthtimeMs !== after.birthtimeMs) throw new Error("Handoff directory changed.");
    ancestors.push({ path: current, dev: after.dev, ino: after.ino, birthtimeMs: after.birthtimeMs });
  }
  return { canonical: current, ancestors };
}

function assertHandoffDirectoryGuard(current: HandoffDirectoryGuard, expected: HandoffDirectoryGuard): void {
  // A child guard must retain every previously verified ancestor identity.
  if (current.ancestors.length < expected.ancestors.length || expected.ancestors.some((item, index) => {
    const actual = current.ancestors[index]!;
    return normalizeFsPathKey(actual.path) !== normalizeFsPathKey(item.path) || actual.dev !== item.dev || actual.ino !== item.ino || actual.birthtimeMs !== item.birthtimeMs;
  })) throw new Error("Handoff directory changed.");
}

async function collectDirectoryStats(storage: vscode.Uri, rootUri: vscode.Uri, rootGuard: HandoffDirectoryGuard): Promise<{ fileCount: number; bytes: number }> {
  const stack: vscode.Uri[] = [rootUri];
  let fileCount = 0;
  let bytes = 0;

  while (stack.length > 0) {
    const dir = stack.pop()!;
    const guard = await inspectHandoffDirectory(storage, dir);
    assertHandoffDirectoryGuard(guard, rootGuard);
    const entries = await vscode.workspace.fs.readDirectory(dir);
    assertHandoffDirectoryGuard(await inspectHandoffDirectory(storage, dir), guard);

    for (const [name, type] of entries) {
      if ((type & vscode.FileType.SymbolicLink) !== 0) throw new Error("Invalid handoff entry.");
      const child = vscode.Uri.joinPath(dir, name);
      if ((type & vscode.FileType.Directory) !== 0) {
        stack.push(child);
        continue;
      }
      if ((type & vscode.FileType.File) === 0) continue;
      const stat = await fs.lstat(child.fsPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid handoff entry.");
      assertHandoffDirectoryGuard(await inspectHandoffDirectory(storage, dir), guard);
      if (name === HANDOFF_FILE_NAME) fileCount += 1;
      bytes += stat.size;
    }
  }

  return { fileCount, bytes };
}

function normalizeFsPathKey(value: string | undefined): string {
  const raw = String(value ?? "").trim(); if (!raw) return "";
  const normalized = path.normalize(raw);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
