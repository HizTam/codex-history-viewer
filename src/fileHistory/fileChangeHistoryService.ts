import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import * as vscode from "vscode";
import type {
  ChatPatchChangeType,
  ChatPatchEntry,
  ChatPatchHunk,
  ChatPatchRow,
} from "../chat/chatTypes";
import { t } from "../i18n";
import type { CodexHistoryViewerConfig } from "../settings";
import {
  buildClaudePatchBookmarkGroupId,
  buildCodexPatchBookmarkGroupId,
  resolveClaudeToolCallId,
} from "../services/bookmarkIdentity";
import {
  detectClaudeMaterializedMessageRole,
  extractClaudeRequestInterruptionContent,
  isCodexTurnAbortedContent,
} from "../chat/chatAttachments";
import type { ProjectAssociationStore } from "../services/projectAssociationStore";
import { mapAssociatedProjectPath, type ProjectPathMapping } from "../services/projectPathMapper";
import type { SearchIndexService } from "../services/searchIndexService";
import type { HistoryIndex, SessionSource, SessionSummary } from "../sessions/sessionTypes";
import { formatYmdHmsInTimeZone, toYmdInTimeZone, ymdToString } from "../utils/dateUtils";
import { resolveDateTimeSettings } from "../utils/dateTimeSettings";
import { normalizeCacheKey } from "../utils/fsUtils";
import {
  normalizeWhitespace,
  singleLineSnippet,
} from "../utils/textUtils";
import type {
  FileChangeHistoryCandidate,
  FileChangeHistoryCard,
  FileChangeHistoryDiffStats,
  FileChangeHistoryLoadResult,
  FileChangeHistoryLoadStats,
  FileChangeHistoryMatchedSide,
  FileChangeHistoryTarget,
} from "./fileChangeHistoryTypes";

interface ParsedPatchEntry {
  entry: ChatPatchEntry;
  bookmarkGroupId?: string;
  messageIndex?: number;
  timestampIso?: string;
}

interface ParsedSessionResult {
  cards: FileChangeHistoryCard[];
  diffStats: FileChangeHistoryDiffStats;
}

interface ParsedPatchEntriesResult {
  entries: ParsedPatchEntry[];
  diffStats: FileChangeHistoryDiffStats;
}

interface ApplyPatchFileAccumulator {
  path: string;
  movePath?: string;
  changeType: ChatPatchChangeType;
  added: number;
  removed: number;
  hunks: ChatPatchHunk[];
  currentHunk: ChatPatchHunk | null;
  rightLine: number;
  pendingDeletes: string[];
  pendingAdds: string[];
}

interface ClaudeToolCall {
  callId?: string;
  name?: string;
  input?: unknown;
}

interface ClaudeParsedContent {
  messageText: string;
  toolCalls: ClaudeToolCall[];
}

type PathMatch = { matched: true; side: FileChangeHistoryMatchedSide } | { matched: false };

const MAX_SYNTHETIC_WRITE_LINES = 4000;

function createDiffStats(): FileChangeHistoryDiffStats {
  return {
    codexPatchApplyEnd: 0,
    codexApplyPatchParsed: 0,
    codexApplyPatchFailedSkipped: 0,
    codexDuplicatesSuppressed: 0,
    claudeEditParsed: 0,
    claudeMultiEditParsed: 0,
    claudeWriteParsed: 0,
    noRenderableSkipped: 0,
  };
}

function createLoadStats(): FileChangeHistoryLoadStats {
  return {
    candidateScanned: 0,
    parsedSessions: 0,
    matchedSessions: 0,
    pendingConsumed: 0,
    cardsProduced: 0,
    diffStats: createDiffStats(),
  };
}

function cloneDiffStats(stats: FileChangeHistoryDiffStats): FileChangeHistoryDiffStats {
  return { ...stats };
}

function addDiffStats(target: FileChangeHistoryDiffStats, source: FileChangeHistoryDiffStats): void {
  target.codexPatchApplyEnd += source.codexPatchApplyEnd;
  target.codexApplyPatchParsed += source.codexApplyPatchParsed;
  target.codexApplyPatchFailedSkipped += source.codexApplyPatchFailedSkipped;
  target.codexDuplicatesSuppressed += source.codexDuplicatesSuppressed;
  target.claudeEditParsed += source.claudeEditParsed;
  target.claudeMultiEditParsed += source.claudeMultiEditParsed;
  target.claudeWriteParsed += source.claudeWriteParsed;
  target.noRenderableSkipped += source.noRenderableSkipped;
}

function addClaudeDiffStats(stats: FileChangeHistoryDiffStats, toolCall: ClaudeToolCall, count: number): void {
  if (count <= 0) return;
  const toolName = normalizeToolName(toolCall.name);
  if (toolName.includes("multiedit")) stats.claudeMultiEditParsed += count;
  else if (toolName.includes("edit")) stats.claudeEditParsed += count;
  else if (toolName.includes("write")) stats.claudeWriteParsed += count;
}

export class FileChangeHistoryService {
  private readonly projectAssociationStore?: ProjectAssociationStore;

  constructor(projectAssociationStore?: ProjectAssociationStore) {
    this.projectAssociationStore = projectAssociationStore;
  }

  public buildTarget(fileUri: vscode.Uri, workspaceFolder: vscode.WorkspaceFolder): FileChangeHistoryTarget {
    return {
      fsPath: path.normalize(fileUri.fsPath),
      workspaceRoot: path.normalize(workspaceFolder.uri.fsPath),
      workspaceName: workspaceFolder.name,
      fileName: path.basename(fileUri.fsPath),
    };
  }

  public buildCandidates(params: {
    index: HistoryIndex;
    searchIndexService: SearchIndexService;
    target: FileChangeHistoryTarget;
    config: CodexHistoryViewerConfig;
  }): FileChangeHistoryCandidate[] {
    const { index, searchIndexService, target, config } = params;
    const candidates: FileChangeHistoryCandidate[] = [];
    const projectPathMappings = this.getProjectPathMappings(target);

    for (const session of index.sessions) {
      if (!isEnabledSource(session.source, config)) continue;
      if (!isSessionAllowedForWorkspace(session, target.workspaceRoot, projectPathMappings)) continue;

      // Search index hits are ranking hints; raw session parsing is the source of truth.
      const hintScore = scoreFileChangeHints(searchIndexService, session, target, projectPathMappings);
      const fallbackScore = hintScore > 0 ? 0 : scoreSearchMessages(searchIndexService, session, target, projectPathMappings);
      const matchScore = Math.max(hintScore, fallbackScore);
      candidates.push({ session, matchScore });
    }

    candidates.sort((a, b) => {
      const at = getSessionSortTime(a.session);
      const bt = getSessionSortTime(b.session);
      if (at !== bt) return at - bt;
      if (a.matchScore !== b.matchScore) return b.matchScore - a.matchScore;
      return a.session.fsPath.localeCompare(b.session.fsPath);
    });
    return candidates;
  }

  public async loadCards(params: {
    target: FileChangeHistoryTarget;
    candidates: readonly FileChangeHistoryCandidate[];
    nextCandidateIndex: number;
    pendingCards: readonly FileChangeHistoryCard[];
    limit: number;
    token?: vscode.CancellationToken;
  }): Promise<FileChangeHistoryLoadResult> {
    const cards: FileChangeHistoryCard[] = [];
    let pendingCards = [...params.pendingCards];
    let nextCandidateIndex = Math.max(0, Math.floor(params.nextCandidateIndex));
    const limit = Math.max(1, Math.floor(params.limit));
    const stats = createLoadStats();
    const projectPathMappings = this.getProjectPathMappings(params.target);

    while (cards.length < limit && pendingCards.length > 0) {
      const next = pendingCards.shift();
      if (next) {
        cards.push(next);
        stats.pendingConsumed += 1;
      }
    }

    while (cards.length < limit && nextCandidateIndex < params.candidates.length) {
      throwIfCancelled(params.token);
      const candidate = params.candidates[nextCandidateIndex]!;
      nextCandidateIndex += 1;
      stats.candidateScanned += 1;
      const parsed = await this.parseSession(candidate.session, params.target, projectPathMappings, params.token);
      stats.parsedSessions += 1;
      addDiffStats(stats.diffStats, parsed.diffStats);
      if (parsed.cards.length === 0) continue;
      stats.matchedSessions += 1;

      const remaining = limit - cards.length;
      cards.push(...parsed.cards.slice(0, remaining));
      if (parsed.cards.length > remaining) {
        pendingCards = parsed.cards.slice(remaining).concat(pendingCards);
      }
    }

    const exhausted = nextCandidateIndex >= params.candidates.length && pendingCards.length === 0;
    stats.cardsProduced = cards.length;
    return { cards, nextCandidateIndex, pendingCards, exhausted, stats };
  }

  private async parseSession(
    session: SessionSummary,
    target: FileChangeHistoryTarget,
    projectPathMappings: readonly ProjectPathMapping[],
    token?: vscode.CancellationToken,
  ): Promise<ParsedSessionResult> {
    const parsed =
      session.source === "codex"
        ? await parseCodexSession(session, target, projectPathMappings, token)
        : await parseClaudeSession(session, target, projectPathMappings, token);
    const renderableEntries = parsed.entries.filter((item) => hasRenderableDiff(item.entry));
    const diffStats = cloneDiffStats(parsed.diffStats);
    diffStats.noRenderableSkipped += parsed.entries.length - renderableEntries.length;
    const cards = renderableEntries.map((item, index) => toHistoryCard(session, target, projectPathMappings, item, index));
    cards.sort((a, b) => {
      const at = parseTimeMs(a.timestampIso);
      const bt = parseTimeMs(b.timestampIso);
      if (at !== bt) return at - bt;
      return a.id.localeCompare(b.id);
    });
    return { cards, diffStats };
  }

  private getProjectPathMappings(target: FileChangeHistoryTarget): ProjectPathMapping[] {
    const store = this.projectAssociationStore;
    if (!store || store.isEmpty()) return [];
    return store.getRelocationSourcesForTargetCwd(target.workspaceRoot).map((source) => ({
      sourceCwd: source.sourceCwd,
      targetCwd: target.workspaceRoot,
    }));
  }
}

async function parseCodexSession(
  session: SessionSummary,
  target: FileChangeHistoryTarget,
  projectPathMappings: readonly ProjectPathMapping[],
  token?: vscode.CancellationToken,
): Promise<ParsedPatchEntriesResult> {
  const out: ParsedPatchEntry[] = [];
  const diffStats = createDiffStats();
  const stream = fs.createReadStream(session.fsPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let messageIndex = 0;
  let lineIndex = 0;
  const pendingApplyPatchEntries = new Map<string, ParsedPatchEntry[]>();
  const mergeStateByGroup = new Map<string, Map<string, number>>();

  try {
    for await (const line of rl) {
      throwIfCancelled(token);
      lineIndex += 1;
      if (!line) continue;

      const obj = parseJsonLine(line);
      if (!obj) continue;

      if (obj?.type === "response_item" && obj?.payload?.type === "message") {
        const role = obj?.payload?.role;
        if (role === "user" && isCodexTurnAbortedContent(obj?.payload?.content)) continue;
        if (role === "user" || role === "assistant") messageIndex += 1;
        continue;
      }

      const customApplyPatchInput = readCodexCustomApplyPatchInput(obj);
      if (customApplyPatchInput !== undefined) {
        const callId = typeof obj?.payload?.call_id === "string" ? obj.payload.call_id : `apply_patch:${lineIndex}`;
        const timestampIso = typeof obj?.timestamp === "string" ? obj.timestamp : undefined;
        const entries = buildCodexApplyPatchEntries(customApplyPatchInput, session.meta.cwd, target, projectPathMappings, callId);
        if (entries.length > 0) {
          diffStats.codexApplyPatchParsed += entries.length;
          const bookmarkGroupId = `apply:${callId}`;
          pendingApplyPatchEntries.set(
            callId,
            entries.map((entry) => ({
              entry,
              bookmarkGroupId,
              messageIndex: messageIndex > 0 ? messageIndex : undefined,
              timestampIso: timestampIso ?? session.lastActivityAtIso ?? session.startedAtIso ?? session.meta.timestampIso,
            })),
          );
        }
        continue;
      }

      if (obj?.type === "response_item" && isCodexToolCallOutput(obj?.payload?.type)) {
        const callId = typeof obj?.payload?.call_id === "string" ? obj.payload.call_id : undefined;
        const outputText = typeof obj?.payload?.output === "string" ? obj.payload.output : undefined;
        if (callId && isApplyPatchFailureOutput(outputText)) {
          diffStats.codexApplyPatchFailedSkipped += pendingApplyPatchEntries.get(callId)?.length ?? 0;
          pendingApplyPatchEntries.delete(callId);
        }
        continue;
      }

      if (obj?.type !== "event_msg" || obj?.payload?.type !== "patch_apply_end") continue;
      const rawCallId = typeof obj?.payload?.call_id === "string" ? obj.payload.call_id : undefined;
      const callId = rawCallId ?? `patch:${lineIndex}`;
      const groupKey = buildCodexPatchBookmarkGroupId(obj, lineIndex);
      const timestampIso =
        typeof obj?.payload?.timestamp === "string"
          ? obj.payload.timestamp
          : typeof obj?.timestamp === "string"
            ? obj.timestamp
            : undefined;
      const entries = buildCodexPatchEntries(obj?.payload?.changes, session.meta.cwd, target, projectPathMappings, callId);
      const removedByCallIdCount = rawCallId ? pendingApplyPatchEntries.get(rawCallId)?.length ?? 0 : 0;
      const removedByCallId = rawCallId ? pendingApplyPatchEntries.delete(rawCallId) : false;
      if (removedByCallId) diffStats.codexDuplicatesSuppressed += removedByCallIdCount;
      if (!removedByCallId && entries.length > 0) {
        diffStats.codexDuplicatesSuppressed += removeMatchingPendingApplyPatchEntries(
          pendingApplyPatchEntries,
          entries,
          messageIndex > 0 ? messageIndex : undefined,
        );
      }
      if (isPatchApplyEndFailure(obj)) continue;
      diffStats.codexPatchApplyEnd += entries.length;
      for (const entry of entries) {
        const merged = appendMergedParsedPatchEntry(
          out,
          {
            entry,
            bookmarkGroupId: groupKey,
            messageIndex: messageIndex > 0 ? messageIndex : undefined,
            timestampIso: timestampIso ?? session.lastActivityAtIso ?? session.startedAtIso ?? session.meta.timestampIso,
          },
          groupKey,
          mergeStateByGroup,
        );
        if (merged) diffStats.codexDuplicatesSuppressed += 1;
      }
    }
  } finally {
    rl.close();
    stream.close();
  }

  for (const [key, entries] of pendingApplyPatchEntries.entries()) {
    for (const parsed of entries) {
      const merged = appendMergedParsedPatchEntry(out, parsed, `apply:${key}`, mergeStateByGroup);
      if (merged) diffStats.codexDuplicatesSuppressed += 1;
    }
  }
  return { entries: out, diffStats };
}

async function parseClaudeSession(
  session: SessionSummary,
  target: FileChangeHistoryTarget,
  projectPathMappings: readonly ProjectPathMapping[],
  token?: vscode.CancellationToken,
): Promise<ParsedPatchEntriesResult> {
  const out: ParsedPatchEntry[] = [];
  const diffStats = createDiffStats();
  const stream = fs.createReadStream(session.fsPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let messageIndex = 0;
  let lineIndex = 0;

  try {
    for await (const line of rl) {
      throwIfCancelled(token);
      lineIndex += 1;
      if (!line) continue;

      const obj = parseJsonLine(line);
      if (!obj) continue;
      const role = detectClaudeMessageRole(obj);
      if (!role) continue;

      const rawContent = getClaudeMessageContent(obj);
      if (role === "user" && extractClaudeRequestInterruptionContent(rawContent)) continue;
      const parsed = parseClaudeMessageContent(rawContent);
      if (normalizeWhitespace(parsed.messageText)) messageIndex += 1;
      const timestampIso = resolveClaudeDiffTimestamp(obj, session);

      for (let toolCallIndex = 0; toolCallIndex < parsed.toolCalls.length; toolCallIndex += 1) {
        const toolCall = parsed.toolCalls[toolCallIndex]!;
        const callId = resolveClaudeToolCallId(toolCall.callId, lineIndex, toolCallIndex);
        const bookmarkGroupId = buildClaudePatchBookmarkGroupId(toolCall.callId, lineIndex, toolCallIndex, messageIndex);
        const entries = buildClaudeToolUsePatchEntries(toolCall, session.meta.cwd, target, projectPathMappings, callId);
        addClaudeDiffStats(diffStats, toolCall, entries.length);
        for (const entry of entries) {
          out.push({
            entry,
            bookmarkGroupId,
            messageIndex: messageIndex > 0 ? messageIndex : undefined,
            timestampIso,
          });
        }
      }
    }
  } finally {
    rl.close();
    stream.close();
  }

  return { entries: out, diffStats };
}

function buildCodexPatchEntries(
  changes: unknown,
  sessionCwd: string | undefined,
  target: FileChangeHistoryTarget,
  projectPathMappings: readonly ProjectPathMapping[],
  callId: string,
): ChatPatchEntry[] {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return [];
  const entries: ChatPatchEntry[] = [];
  let index = 0;
  for (const [rawPath, rawChange] of Object.entries(changes as Record<string, unknown>)) {
    const change = rawChange && typeof rawChange === "object" ? (rawChange as Record<string, unknown>) : {};
    const movePath = typeof change.move_path === "string" ? change.move_path : undefined;
    const match = matchPatchPaths(rawPath, movePath, sessionCwd, target, projectPathMappings);
    if (!match.matched) {
      index += 1;
      continue;
    }

    const unifiedDiff = typeof change.unified_diff === "string" ? change.unified_diff : "";
    const content = typeof change.content === "string" ? change.content : undefined;
    const changeType = normalizePatchChangeType(change.type);
    const parsed = parseCodexPatchApplyEndChange(changeType, unifiedDiff, content);
    const id = `${callId}:${index}`;
    entries.push({
      id,
      callId,
      path: rawPath,
      displayPath: formatPatchDisplayPath(rawPath, sessionCwd, target.workspaceRoot, projectPathMappings),
      movePath,
      moveDisplayPath: movePath ? formatPatchDisplayPath(movePath, sessionCwd, target.workspaceRoot, projectPathMappings) : undefined,
      changeType,
      added: parsed.added,
      removed: parsed.removed,
      hunks: parsed.hunks,
    });
    index += 1;
  }
  return entries;
}

function readCodexCustomApplyPatchInput(obj: any): string | undefined {
  if (obj?.type !== "response_item" || obj?.payload?.type !== "custom_tool_call") return undefined;
  if (normalizeToolName(obj?.payload?.name) !== "applypatch") return undefined;
  return typeof obj?.payload?.input === "string" ? obj.payload.input : undefined;
}

function buildCodexApplyPatchEntries(
  patchText: string,
  sessionCwd: string | undefined,
  target: FileChangeHistoryTarget,
  projectPathMappings: readonly ProjectPathMapping[],
  callId: string,
): ChatPatchEntry[] {
  const lines = String(patchText ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const entries: ChatPatchEntry[] = [];
  let current: ApplyPatchFileAccumulator | null = null;
  let index = 0;

  const flush = (): void => {
    if (!current) return;
    flushApplyPatchPendingRows(current);
    const match = matchPatchPaths(current.path, current.movePath, sessionCwd, target, projectPathMappings);
    if (match.matched && hasRenderableApplyPatch(current)) {
      entries.push({
        id: `${callId}:apply:${index}`,
        callId,
        path: current.path,
        displayPath: formatPatchDisplayPath(current.path, sessionCwd, target.workspaceRoot, projectPathMappings),
        movePath: current.movePath,
        moveDisplayPath: current.movePath
          ? formatPatchDisplayPath(current.movePath, sessionCwd, target.workspaceRoot, projectPathMappings)
          : undefined,
        changeType: current.changeType,
        added: current.added,
        removed: current.removed,
        hunks: current.hunks,
      });
      index += 1;
    }
    current = null;
  };

  for (const line of lines) {
    if (line === "*** Begin Patch" || line === "*** End Patch") continue;
    if (line.startsWith("*** Add File: ")) {
      flush();
      current = createApplyPatchFileAccumulator(line.slice("*** Add File: ".length), "create");
      current.currentHunk = { header: "@@ -0,0 +1 @@", rows: [] };
      current.hunks.push(current.currentHunk);
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      flush();
      current = createApplyPatchFileAccumulator(line.slice("*** Update File: ".length), "update");
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      flush();
      current = createApplyPatchFileAccumulator(line.slice("*** Delete File: ".length), "delete");
      continue;
    }
    if (!current) continue;

    if (line.startsWith("*** Move to: ")) {
      current.movePath = line.slice("*** Move to: ".length).trim();
      current.changeType = "move";
      continue;
    }
    if (line === "*** End of File") continue;
    if (line.startsWith("*** ")) continue;

    if (line.startsWith("@@")) {
      flushApplyPatchPendingRows(current);
      current.currentHunk = { header: line, rows: [] };
      current.hunks.push(current.currentHunk);
      continue;
    }

    appendApplyPatchChangeLine(current, line);
  }
  flush();
  return entries;
}

function removeMatchingPendingApplyPatchEntries(
  pendingApplyPatchEntries: Map<string, ParsedPatchEntry[]>,
  entries: ChatPatchEntry[],
  messageIndex?: number,
): number {
  const targetSignature = buildPatchEntriesSignature(entries);
  if (!targetSignature) return 0;

  let fallbackKey: string | undefined;
  let fallbackCount = 0;
  for (const [key, pending] of pendingApplyPatchEntries.entries()) {
    if (buildPatchEntriesSignature(pending.map((item) => item.entry)) !== targetSignature) continue;
    if (messageIndex && pending.some((item) => item.messageIndex === messageIndex)) {
      pendingApplyPatchEntries.delete(key);
      return pending.length;
    }
    fallbackKey = key;
    fallbackCount = pending.length;
  }

  if (!fallbackKey) return 0;
  pendingApplyPatchEntries.delete(fallbackKey);
  return fallbackCount;
}

function appendMergedParsedPatchEntry(
  out: ParsedPatchEntry[],
  parsed: ParsedPatchEntry,
  groupKey: string,
  mergeStateByGroup: Map<string, Map<string, number>>,
): boolean {
  const entry = parsed.entry;
  const resetKey = getCodexPatchMergePath(entry);
  const canMerge = entry.changeType === "update" && !entry.movePath && !entry.moveDisplayPath;
  let mergeState = mergeStateByGroup.get(groupKey);
  if (!mergeState) {
    mergeState = new Map<string, number>();
    mergeStateByGroup.set(groupKey, mergeState);
  }

  if (canMerge && resetKey) {
    const existingIndex = mergeState.get(resetKey);
    if (existingIndex !== undefined) {
      out[existingIndex] = mergeParsedPatchEntry(out[existingIndex]!, parsed);
      return true;
    }
  }

  out.push(cloneParsedPatchEntry(parsed));
  if (!resetKey) return false;
  if (canMerge) mergeState.set(resetKey, out.length - 1);
  else mergeState.delete(resetKey);
  return false;
}

function mergeParsedPatchEntry(base: ParsedPatchEntry, next: ParsedPatchEntry): ParsedPatchEntry {
  return {
    ...base,
    bookmarkGroupId: next.bookmarkGroupId ?? base.bookmarkGroupId,
    timestampIso: next.timestampIso ?? base.timestampIso,
    entry: mergePatchEntry(base.entry, next.entry),
  };
}

function cloneParsedPatchEntry(parsed: ParsedPatchEntry): ParsedPatchEntry {
  return {
    ...parsed,
    entry: clonePatchEntry(parsed.entry),
  };
}

function mergePatchEntry(base: ChatPatchEntry, next: ChatPatchEntry): ChatPatchEntry {
  return {
    ...base,
    added: (base.added || 0) + (next.added || 0),
    removed: (base.removed || 0) + (next.removed || 0),
    detailsOmitted: base.detailsOmitted === true || next.detailsOmitted === true ? true : undefined,
    hunks: [...(base.hunks ?? []), ...(next.hunks ?? [])],
  };
}

function clonePatchEntry(entry: ChatPatchEntry): ChatPatchEntry {
  return {
    ...entry,
    hunks: [...(entry.hunks ?? [])],
  };
}

function getCodexPatchMergePath(entry: ChatPatchEntry): string {
  const raw = entry.movePath || entry.moveDisplayPath || entry.path || entry.displayPath;
  return normalizePatchSignaturePath(raw).toLowerCase();
}

function isPatchApplyEndFailure(obj: any): boolean {
  const payload = obj?.payload && typeof obj.payload === "object" ? obj.payload : {};
  if (typeof payload.success === "boolean") return !payload.success;
  const status = typeof payload.status === "string" ? payload.status.trim().toLowerCase() : "";
  return (
    status === "failed" ||
    status === "failure" ||
    status === "error" ||
    status === "cancelled" ||
    status === "canceled"
  );
}

function isCodexToolCallOutput(payloadType: unknown): boolean {
  return payloadType === "function_call_output" || payloadType === "custom_tool_call_output";
}

function isApplyPatchFailureOutput(outputText: string | undefined): boolean {
  const text = String(outputText ?? "").trim().toLowerCase();
  if (!text) return false;
  return (
    text.includes("apply_patch verification failed") ||
    text.includes("apply_patch failed") ||
    text.includes("failed to apply patch") ||
    text.includes("failed to find expected lines") ||
    text.includes("invalid context")
  );
}

function buildPatchEntriesSignature(entries: ChatPatchEntry[]): string {
  if (entries.length === 0) return "";
  return entries.map(buildPatchEntrySignature).sort().join("\n");
}

function buildPatchEntrySignature(entry: ChatPatchEntry): string {
  return [
    normalizePatchSignaturePath(entry.path || entry.displayPath),
    normalizePatchSignaturePath(entry.movePath || entry.moveDisplayPath || ""),
    entry.changeType || "unknown",
    String(entry.added || 0),
    String(entry.removed || 0),
  ].join("\u0001");
}

function normalizePatchSignaturePath(value: string | undefined): string {
  let text = String(value ?? "").trim().replace(/^"|"$/g, "");
  const tabIndex = text.indexOf("\t");
  if (tabIndex >= 0) text = text.slice(0, tabIndex).trim();
  if (text.startsWith("a/") || text.startsWith("b/")) text = text.slice(2);
  if (text === "/dev/null") return "";
  return path.normalize(text).replace(/\\/g, "/");
}

function createApplyPatchFileAccumulator(filePath: string, changeType: ChatPatchChangeType): ApplyPatchFileAccumulator {
  return {
    path: filePath.trim(),
    changeType,
    added: 0,
    removed: 0,
    hunks: [],
    currentHunk: null,
    rightLine: 1,
    pendingDeletes: [],
    pendingAdds: [],
  };
}

function hasRenderableApplyPatch(acc: ApplyPatchFileAccumulator): boolean {
  return acc.hunks.some((hunk) => hunk.rows.length > 0);
}

function appendApplyPatchChangeLine(acc: ApplyPatchFileAccumulator, line: string): void {
  if (!acc.currentHunk) {
    acc.currentHunk = { header: "@@", rows: [] };
    acc.hunks.push(acc.currentHunk);
  }

  if (acc.changeType === "create") {
    if (!line.startsWith("+")) return;
    acc.currentHunk.rows.push({
      kind: "add",
      leftText: "",
      rightLine: acc.rightLine,
      rightText: line.slice(1),
    });
    acc.rightLine += 1;
    acc.added += 1;
    return;
  }

  const marker = line[0];
  const text = line.slice(1);
  if (marker === " ") {
    flushApplyPatchPendingRows(acc);
    acc.currentHunk.rows.push({
      kind: "context",
      leftText: text,
      rightText: text,
    });
    return;
  }
  if (marker === "-") {
    acc.pendingDeletes.push(text);
    acc.removed += 1;
    return;
  }
  if (marker === "+") {
    acc.pendingAdds.push(text);
    acc.added += 1;
  }
}

function flushApplyPatchPendingRows(acc: ApplyPatchFileAccumulator): void {
  const hunk = acc.currentHunk;
  if (!hunk || (acc.pendingDeletes.length === 0 && acc.pendingAdds.length === 0)) return;
  const count = Math.max(acc.pendingDeletes.length, acc.pendingAdds.length);
  for (let i = 0; i < count; i += 1) {
    const leftText = acc.pendingDeletes[i];
    const rightText = acc.pendingAdds[i];
    hunk.rows.push({
      kind: leftText !== undefined && rightText !== undefined ? "modify" : leftText !== undefined ? "delete" : "add",
      leftText: leftText ?? "",
      rightText: rightText ?? "",
    });
  }
  acc.pendingDeletes = [];
  acc.pendingAdds = [];
}

function buildClaudeToolUsePatchEntries(
  toolCall: ClaudeToolCall,
  sessionCwd: string | undefined,
  target: FileChangeHistoryTarget,
  projectPathMappings: readonly ProjectPathMapping[],
  callId: string,
): ChatPatchEntry[] {
  const input = typeof toolCall.input === "string" ? parseJsonLine(toolCall.input) ?? toolCall.input : toolCall.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const toolName = normalizeToolName(toolCall.name);
  const filePath = readPathField(input);
  if (!filePath) return [];
  if (!matchPatchPaths(filePath, undefined, sessionCwd, target, projectPathMappings).matched) return [];

  const entries: ChatPatchEntry[] = [];
  const baseId = `${callId}:0`;

  if (toolName.includes("multiedit")) {
    const edits = Array.isArray((input as { edits?: unknown }).edits) ? (input as { edits: unknown[] }).edits : [];
    const hunks: ChatPatchHunk[] = [];
    let added = 0;
    let removed = 0;
    for (let i = 0; i < edits.length; i += 1) {
      const edit = edits[i];
      if (!edit || typeof edit !== "object") continue;
      const oldText = readStringField(edit, ["old_string", "oldString"]);
      const newText = readStringField(edit, ["new_string", "newString"]);
      if (oldText === undefined || newText === undefined || oldText === newText) continue;
      const hunk = buildSyntheticReplacementHunk(oldText, newText, `@@ edit ${i + 1} @@`);
      added += countAddedRows(hunk);
      removed += countRemovedRows(hunk);
      hunks.push(hunk);
    }
    if (hunks.length > 0) {
      entries.push(buildSyntheticEntry(baseId, callId, filePath, sessionCwd, target, projectPathMappings, "update", added, removed, hunks));
    }
    return entries;
  }

  if (toolName.includes("edit")) {
    const oldText = readStringField(input, ["old_string", "oldString"]);
    const newText = readStringField(input, ["new_string", "newString"]);
    if (oldText === undefined || newText === undefined || oldText === newText) return [];
    const hunk = buildSyntheticReplacementHunk(oldText, newText);
    entries.push(
      buildSyntheticEntry(
        baseId,
        callId,
        filePath,
        sessionCwd,
        target,
        projectPathMappings,
        "update",
        countAddedRows(hunk),
        countRemovedRows(hunk),
        [hunk],
      ),
    );
    return entries;
  }

  if (toolName.includes("write")) {
    const content = readStringField(input, ["content"]);
    if (content === undefined) return [];
    const hunk = buildSyntheticCreateHunk(content, MAX_SYNTHETIC_WRITE_LINES);
    if (hunk.rows.length === 0) return [];
    entries.push(
      buildSyntheticEntry(
        baseId,
        callId,
        filePath,
        sessionCwd,
        target,
        projectPathMappings,
        "create",
        countAddedRows(hunk),
        0,
        [hunk],
      ),
    );
  }

  return entries;
}

function buildSyntheticEntry(
  id: string,
  callId: string,
  filePath: string,
  sessionCwd: string | undefined,
  target: FileChangeHistoryTarget,
  projectPathMappings: readonly ProjectPathMapping[],
  changeType: ChatPatchChangeType,
  added: number,
  removed: number,
  hunks: ChatPatchHunk[],
): ChatPatchEntry {
  return {
    id,
    callId,
    path: filePath,
    displayPath: formatPatchDisplayPath(filePath, sessionCwd, target.workspaceRoot, projectPathMappings),
    changeType,
    added,
    removed,
    hunks,
  };
}

function buildSyntheticReplacementHunk(oldText: string, newText: string, header = "@@ -1 +1 @@"): ChatPatchHunk {
  const oldLines = splitContentLines(oldText);
  const newLines = splitContentLines(newText);
  const rows: ChatPatchRow[] = [];
  const count = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < count; i += 1) {
    const hasOld = i < oldLines.length;
    const hasNew = i < newLines.length;
    rows.push({
      kind: hasOld && hasNew ? "modify" : hasOld ? "delete" : "add",
      leftLine: hasOld ? i + 1 : undefined,
      leftText: hasOld ? oldLines[i]! : "",
      rightLine: hasNew ? i + 1 : undefined,
      rightText: hasNew ? newLines[i]! : "",
    });
  }
  return { header, rows };
}

function buildSyntheticCreateHunk(content: string, maxLines: number): ChatPatchHunk {
  const lines = splitContentLines(content).slice(0, Math.max(0, maxLines));
  return {
    header: `@@ -0,0 +1,${lines.length} @@`,
    rows: lines.map((line, index) => ({
      kind: "add",
      leftText: "",
      rightLine: index + 1,
      rightText: line,
    })),
  };
}

function toHistoryCard(
  session: SessionSummary,
  target: FileChangeHistoryTarget,
  projectPathMappings: readonly ProjectPathMapping[],
  parsed: ParsedPatchEntry,
  index: number,
): FileChangeHistoryCard {
  const entry = parsed.entry;
  const timestampIso = parsed.timestampIso;
  const dateInfo = formatCardDate(timestampIso);
  const matched = matchPatchPaths(entry.path, entry.movePath, session.meta.cwd, target, projectPathMappings);
  const side = matched.matched ? matched.side : "path";
  const sourceLabel = getSourceLabel(session.source);
  const id = `fch-${hashString(
    [session.cacheKey, parsed.messageIndex ?? "", timestampIso ?? "", entry.id, index].join("\u0000"),
  )}`;
  return {
    id,
    source: session.source,
    sourceLabel,
    sessionFsPath: session.fsPath,
    sessionCacheKey: session.cacheKey,
    sessionTitle: resolveSessionTitle(session, sourceLabel, timestampIso),
    sessionCwd: session.meta.cwd,
    bookmarkGroupId: parsed.bookmarkGroupId,
    messageIndex: parsed.messageIndex,
    timestampIso,
    localDate: dateInfo.localDate,
    dateTimeLabel: dateInfo.dateTimeLabel,
    changeType: entry.changeType,
    matchedSide: side,
    path: entry.path,
    displayPath: entry.displayPath,
    movePath: entry.movePath,
    moveDisplayPath: entry.moveDisplayPath,
    added: entry.added,
    removed: entry.removed,
    entry,
  };
}

function scoreFileChangeHints(
  searchIndexService: SearchIndexService,
  session: SessionSummary,
  target: FileChangeHistoryTarget,
  projectPathMappings: readonly ProjectPathMapping[],
): number {
  const hints = searchIndexService.getFileChangeHints(session.cacheKey) ?? [];
  let score = 0;
  for (const hint of hints) {
    for (const hintPath of hint.paths) {
      if (!matchesPathCandidate(hintPath, session.meta.cwd, target, projectPathMappings)) continue;
      score = Math.max(score, hint.origin === "codexPatch" ? 100 : hint.hasDiffLikeContent ? 80 : 40);
    }
  }
  return score;
}

function scoreSearchMessages(
  searchIndexService: SearchIndexService,
  session: SessionSummary,
  target: FileChangeHistoryTarget,
  projectPathMappings: readonly ProjectPathMapping[],
): number {
  const messages = searchIndexService.getMessages(session.cacheKey) ?? [];
  const needles = buildSearchNeedles(target, projectPathMappings);
  for (const message of messages) {
    if (message.source === "message") continue;
    const haystack = message.text.toLowerCase();
    if (needles.some((needle) => needle.length > 0 && haystack.includes(needle))) return 20;
  }
  return 0;
}

function buildSearchNeedles(
  target: FileChangeHistoryTarget,
  projectPathMappings: readonly ProjectPathMapping[],
): string[] {
  const relative = safeRelativePath(target.workspaceRoot, target.fsPath);
  const values = [target.fsPath, relative, path.basename(target.fsPath)];

  for (const sourcePath of buildAssociatedTargetPaths(target.fsPath, projectPathMappings)) {
    values.push(sourcePath);
    for (const mapping of projectPathMappings) {
      if (!isPathInsideOrEqual(sourcePath, mapping.sourceCwd)) continue;
      values.push(safeRelativePath(mapping.sourceCwd, sourcePath));
    }
  }

  return buildPathNeedleVariants(values);
}

function buildAssociatedTargetPaths(
  targetPath: string,
  projectPathMappings: readonly ProjectPathMapping[],
): string[] {
  const out: string[] = [];
  const normalizedTargetPath = path.normalize(targetPath);
  for (const mapping of projectPathMappings) {
    const sourceCwd = String(mapping.sourceCwd ?? "").trim();
    const targetCwd = String(mapping.targetCwd ?? "").trim();
    if (!sourceCwd || !targetCwd) continue;
    if (!isPathInsideOrEqual(normalizedTargetPath, targetCwd)) continue;
    const rel = safeRelativePath(targetCwd, normalizedTargetPath);
    out.push(rel ? path.join(sourceCwd, rel) : sourceCwd);
  }
  return dedupeStrings(out);
}

function buildPathNeedleVariants(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (!text) continue;
    out.push(text);
    out.push(text.replace(/\\/g, "/"));
    out.push(text.replace(/\//g, "\\"));
  }
  return dedupeStrings(out.map((value) => value.toLowerCase()));
}

function isEnabledSource(source: SessionSource, config: CodexHistoryViewerConfig): boolean {
  return source === "codex" ? config.enableCodexSource || config.enableCodexArchivedSessions : config.enableClaudeSource;
}

function isSessionAllowedForWorkspace(
  session: SessionSummary,
  workspaceRoot: string,
  projectPathMappings: readonly ProjectPathMapping[],
): boolean {
  const cwd = typeof session.meta.cwd === "string" ? session.meta.cwd.trim() : "";
  if (!cwd) return true;
  if (isPathInsideOrEqual(cwd, workspaceRoot) || isPathInsideOrEqual(workspaceRoot, cwd)) return true;
  return projectPathMappings.some(
    (mapping) => isPathInsideOrEqual(cwd, mapping.sourceCwd) || isPathInsideOrEqual(mapping.sourceCwd, cwd),
  );
}

function matchPatchPaths(
  rawPath: string | undefined,
  movePath: string | undefined,
  sessionCwd: string | undefined,
  target: FileChangeHistoryTarget,
  projectPathMappings: readonly ProjectPathMapping[],
): PathMatch {
  const pathMatches = rawPath ? matchesPathCandidate(rawPath, sessionCwd, target, projectPathMappings) : false;
  const moveMatches = movePath ? matchesPathCandidate(movePath, sessionCwd, target, projectPathMappings) : false;
  if (pathMatches && moveMatches) return { matched: true, side: "both" };
  if (pathMatches) return { matched: true, side: "path" };
  if (moveMatches) return { matched: true, side: "movePath" };
  return { matched: false };
}

function matchesPathCandidate(
  rawPath: string,
  sessionCwd: string | undefined,
  target: FileChangeHistoryTarget,
  projectPathMappings: readonly ProjectPathMapping[],
): boolean {
  const targetKey = normalizePathForCompare(target.fsPath);
  for (const candidate of resolvePathCandidates(rawPath, sessionCwd, target.workspaceRoot, projectPathMappings)) {
    if (normalizePathForCompare(candidate) === targetKey) return true;
  }
  return false;
}

function resolvePathCandidates(
  rawPath: string,
  sessionCwd: string | undefined,
  workspaceRoot: string,
  projectPathMappings: readonly ProjectPathMapping[],
): string[] {
  const cleaned = cleanupDiffPath(rawPath);
  if (!cleaned) return [];
  const values: string[] = [];
  if (path.isAbsolute(cleaned)) {
    values.push(path.normalize(cleaned));
  } else {
    if (sessionCwd) values.push(path.resolve(sessionCwd, cleaned));
    values.push(path.resolve(workspaceRoot, cleaned));
  }
  const mappedValues = values
    .map((value) => mapAssociatedProjectPath(value, projectPathMappings)?.fsPath)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => path.normalize(value));
  values.push(...mappedValues);
  return dedupeStrings(values);
}

function cleanupDiffPath(value: string): string {
  let text = String(value ?? "").trim().replace(/^"|"$/g, "");
  const tabIndex = text.indexOf("\t");
  if (tabIndex >= 0) text = text.slice(0, tabIndex).trim();
  if (text.startsWith("a/") || text.startsWith("b/")) text = text.slice(2);
  return text === "/dev/null" ? "" : text;
}

function formatPatchDisplayPath(
  rawPath: string,
  sessionCwd: string | undefined,
  workspaceRoot: string,
  projectPathMappings: readonly ProjectPathMapping[],
): string {
  const candidates = resolvePathCandidates(rawPath, sessionCwd, workspaceRoot, projectPathMappings);
  for (const candidate of candidates) {
    const rel = safeRelativePath(workspaceRoot, candidate);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
  }
  if (sessionCwd && path.isAbsolute(rawPath)) {
    const rel = safeRelativePath(sessionCwd, rawPath);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
  }
  return path.normalize(rawPath);
}

function parseCodexPatchApplyEndChange(
  changeType: ChatPatchChangeType,
  unifiedDiff: string,
  content: string | undefined,
): { added: number; removed: number; hunks: ChatPatchHunk[] } {
  if (unifiedDiff.length > 0) return parseUnifiedDiff(unifiedDiff);
  if (content === undefined || (changeType !== "create" && changeType !== "delete")) {
    return { added: 0, removed: 0, hunks: [] };
  }

  const lines = splitContentLines(content);
  const isCreate = changeType === "create";
  const hunk: ChatPatchHunk = {
    header: isCreate ? `@@ -0,0 +1,${lines.length} @@` : `@@ -1,${lines.length} +0,0 @@`,
    rows: lines.map((line, index) =>
      isCreate
        ? {
            kind: "add",
            leftText: "",
            rightLine: index + 1,
            rightText: line,
          }
        : {
            kind: "delete",
            leftLine: index + 1,
            leftText: line,
            rightText: "",
          },
    ),
  };

  return {
    added: isCreate ? lines.length : 0,
    removed: isCreate ? 0 : lines.length,
    hunks: lines.length > 0 ? [hunk] : [],
  };
}

function parseUnifiedDiff(diffText: string): { added: number; removed: number; hunks: ChatPatchHunk[] } {
  const lines = String(diffText ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const hunks: ChatPatchHunk[] = [];
  let added = 0;
  let removed = 0;
  let currentHunk: ChatPatchHunk | null = null;
  let currentLeftLine = 0;
  let currentRightLine = 0;
  let pendingDeletes: Array<{ line: number; text: string }> = [];
  let pendingAdds: Array<{ line: number; text: string }> = [];

  const flushPendingRows = (): void => {
    if (!currentHunk || (pendingDeletes.length === 0 && pendingAdds.length === 0)) return;
    const count = Math.max(pendingDeletes.length, pendingAdds.length);
    for (let i = 0; i < count; i += 1) {
      const left = pendingDeletes[i];
      const right = pendingAdds[i];
      currentHunk.rows.push({
        kind: left && right ? "modify" : left ? "delete" : "add",
        leftLine: left?.line,
        leftText: left?.text ?? "",
        rightLine: right?.line,
        rightText: right?.text ?? "",
      });
    }
    pendingDeletes = [];
    pendingAdds = [];
  };

  for (const rawLine of lines) {
    if (rawLine.startsWith("@@")) {
      flushPendingRows();
      const parsedHeader = parsePatchHeader(rawLine);
      currentLeftLine = parsedHeader?.leftStart ?? 0;
      currentRightLine = parsedHeader?.rightStart ?? 0;
      currentHunk = { header: rawLine, rows: [] };
      hunks.push(currentHunk);
      continue;
    }
    if (!currentHunk || !rawLine || rawLine.startsWith("\\")) continue;
    const marker = rawLine[0];
    const text = rawLine.slice(1);
    if (marker === " ") {
      flushPendingRows();
      currentHunk.rows.push({
        kind: "context",
        leftLine: currentLeftLine,
        leftText: text,
        rightLine: currentRightLine,
        rightText: text,
      });
      currentLeftLine += 1;
      currentRightLine += 1;
      continue;
    }
    if (marker === "-") {
      removed += 1;
      pendingDeletes.push({ line: currentLeftLine, text });
      currentLeftLine += 1;
      continue;
    }
    if (marker === "+") {
      added += 1;
      pendingAdds.push({ line: currentRightLine, text });
      currentRightLine += 1;
    }
  }

  flushPendingRows();
  return { added, removed, hunks };
}

function parsePatchHeader(header: string): { leftStart: number; rightStart: number } | null {
  const match = header.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/u);
  if (!match) return null;
  return { leftStart: Number(match[1]), rightStart: Number(match[2]) };
}

function parseClaudeMessageContent(content: unknown): ClaudeParsedContent {
  const items = Array.isArray(content) ? content : content && typeof content === "object" ? [content] : null;
  if (!items) return { messageText: typeof content === "string" ? content : "", toolCalls: [] };

  const messageTexts: string[] = [];
  const toolCalls: ClaudeToolCall[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const type = typeof obj.type === "string" ? obj.type : "";
    if (type === "text" || type === "input_text" || type === "output_text") {
      if (typeof obj.text === "string") messageTexts.push(obj.text);
      continue;
    }
    if (type === "tool_use") {
      toolCalls.push({
        callId: typeof obj.id === "string" ? obj.id : typeof obj.tool_use_id === "string" ? obj.tool_use_id : undefined,
        name: typeof obj.name === "string" ? obj.name : undefined,
        input: obj.input,
      });
      continue;
    }
    if (type === "tool_result") continue;
    if (typeof obj.text === "string") messageTexts.push(obj.text);
  }
  return { messageText: messageTexts.join(""), toolCalls };
}

function getClaudeMessageContent(obj: any): unknown {
  if (obj?.message && typeof obj.message === "object" && "content" in obj.message) return obj.message.content;
  if (obj && typeof obj === "object" && "content" in obj) return obj.content;
  return undefined;
}

function detectClaudeMessageRole(obj: any): "user" | "assistant" | null {
  return detectClaudeMaterializedMessageRole(obj);
}

function resolveClaudeDiffTimestamp(obj: any, session: SessionSummary): string | undefined {
  if (typeof obj?.timestamp === "string") return obj.timestamp;
  if (typeof obj?.message?.timestamp === "string") return obj.message.timestamp;
  return session.lastActivityAtIso ?? session.startedAtIso ?? session.meta.timestampIso;
}

function normalizePatchChangeType(value: unknown): ChatPatchChangeType {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "add") return "create";
  if (normalized === "remove") return "delete";
  if (
    normalized === "create" ||
    normalized === "delete" ||
    normalized === "move" ||
    normalized === "rename" ||
    normalized === "update"
  ) {
    return normalized;
  }
  return "unknown";
}

function hasRenderableDiff(entry: ChatPatchEntry): boolean {
  if ((entry.added || 0) > 0 || (entry.removed || 0) > 0) return true;
  return Array.isArray(entry.hunks) && entry.hunks.some((hunk) => Array.isArray(hunk.rows) && hunk.rows.length > 0);
}

function countAddedRows(hunk: ChatPatchHunk): number {
  return hunk.rows.filter((row) => row.kind === "add" || row.kind === "modify").length;
}

function countRemovedRows(hunk: ChatPatchHunk): number {
  return hunk.rows.filter((row) => row.kind === "delete" || row.kind === "modify").length;
}

function splitContentLines(value: string): string[] {
  const normalized = String(value ?? "").replace(/^\uFEFF/u, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized) return [];
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function readPathField(value: Record<string, unknown>): string | undefined {
  return readStringField(value, ["file_path", "filePath", "path", "target_file", "targetPath"]);
}

function readStringField(value: unknown, keys: readonly string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}

function normalizeToolName(value: unknown): string {
  return String(value ?? "").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function formatCardDate(timestampIso: string | undefined): { localDate: string; dateTimeLabel: string } {
  const date = timestampIso ? new Date(timestampIso) : null;
  if (!date || !Number.isFinite(date.getTime())) {
    return {
      localDate: t("fileChangeHistory.unknownDate"),
      dateTimeLabel: t("fileChangeHistory.unknownDate"),
    };
  }
  const timeZone = resolveDateTimeSettings().timeZone;
  return {
    localDate: ymdToString(toYmdInTimeZone(date, timeZone)),
    dateTimeLabel: formatYmdHmsInTimeZone(date, timeZone),
  };
}

function resolveSessionTitle(session: SessionSummary, sourceLabel: string, timestampIso: string | undefined): string {
  const first =
    session.displayTitle?.trim() ||
    session.customTitle?.trim() ||
    session.nativeTitle?.trim() ||
    session.previewMessages.map((message) => message.text).find((text) => text.trim().length > 0)?.trim();
  if (first) return singleLineSnippet(first, 120);

  const dateLabel = formatCardDate(timestampIso).localDate;
  if (dateLabel && dateLabel !== t("fileChangeHistory.unknownDate")) {
    return `${sourceLabel} session - ${dateLabel}`;
  }
  return t("fileChangeHistory.untitledSession");
}

function getSourceLabel(source: SessionSource): string {
  return source === "codex" ? "Codex" : "Claude Code";
}

function getSessionSortTime(session: SessionSummary): number {
  return parseTimeMs(session.startedAtIso ?? session.lastActivityAtIso ?? session.meta.timestampIso);
}

function parseTimeMs(value: string | undefined): number {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
}

function parseJsonLine(line: string): any | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function safeRelativePath(from: string, to: string): string {
  try {
    return path.relative(from, to);
  } catch {
    return "";
  }
}

function isPathInsideOrEqual(child: string, parent: string): boolean {
  const rel = safeRelativePath(path.normalize(parent), path.normalize(child));
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function normalizePathForCompare(fsPath: string): string {
  return normalizeCacheKey(path.normalize(fsPath));
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function throwIfCancelled(token?: vscode.CancellationToken): void {
  if (token?.isCancellationRequested) throw new vscode.CancellationError();
}
