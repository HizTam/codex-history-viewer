import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import * as vscode from "vscode";
import type { SearchIndexToolContent } from "../settings";
import type { HistoryIndex } from "../sessions/sessionTypes";
import { readJson, writeJson } from "../storage/jsonStorage";
import { normalizeWhitespace } from "../utils/textUtils";
import type { DebugLogger } from "./logger";

const SEARCH_INDEX_FILE_VERSION = 7;
const MAX_COMMAND_META_LENGTH = 1000;
const MAX_RECURSIVE_META_DEPTH = 5;

export type IndexedSearchRole = "user" | "assistant" | "developer" | "tool";

export interface IndexedSearchMessage {
  messageIndex: number;
  role: IndexedSearchRole;
  source: "message" | "toolArguments" | "toolOutput";
  text: string;
}

export interface IndexedFileChangeHint {
  messageIndex: number;
  paths: string[];
  timestampIso?: string;
  origin: "codexPatch" | "toolArguments" | "toolOutput";
  hasDiffLikeContent: boolean;
}

interface SearchIndexEntryV1 {
  fsPath: string;
  mtimeMs: number;
  size: number;
  messages: IndexedSearchMessage[];
  fileChangeHints?: IndexedFileChangeHint[];
}

interface SearchIndexContext {
  codexSessionsRoot: string;
  codexArchivedSessionsRoot: string;
  claudeSessionsRoot: string;
  includeCodex: boolean;
  includeCodexArchived: boolean;
  includeClaude: boolean;
  indexToolContent: SearchIndexToolContent;
}

interface SearchIndexCacheContext {
  codexSessionsRoot: string;
  codexArchivedSessionsRoot?: string;
  claudeSessionsRoot: string;
  includeCodex: boolean;
  includeCodexArchived?: boolean;
  includeClaude: boolean;
  indexToolContent?: SearchIndexToolContent;
}

interface SearchIndexFileV2 {
  version: typeof SEARCH_INDEX_FILE_VERSION;
  context: SearchIndexCacheContext;
  entries: Record<string, SearchIndexEntryV1>;
}

// Maintains an incremental on-disk search index for session files.
export class SearchIndexService {
  private readonly cacheUri: vscode.Uri;
  private readonly logger?: DebugLogger;
  private loaded = false;
  private context: SearchIndexContext = {
    codexSessionsRoot: "",
    codexArchivedSessionsRoot: "",
    claudeSessionsRoot: "",
    includeCodex: true,
    includeCodexArchived: false,
    includeClaude: false,
    indexToolContent: "toolCallsAndOutputs",
  };
  private readonly entries = new Map<string, SearchIndexEntryV1>();

  constructor(globalStorageUri: vscode.Uri, logger?: DebugLogger) {
    this.cacheUri = vscode.Uri.joinPath(globalStorageUri, "search-index.v2.json");
    this.logger = logger;
  }

  public async ensureUpToDate(params: {
    index: HistoryIndex;
    codexSessionsRoot: string;
    codexArchivedSessionsRoot: string;
    claudeSessionsRoot: string;
    includeCodex: boolean;
    includeCodexArchived: boolean;
    includeClaude: boolean;
    indexToolContent: SearchIndexToolContent;
    token?: vscode.CancellationToken;
    progress?: vscode.Progress<{ message?: string; increment?: number }>;
    forceRebuild?: boolean;
  }): Promise<void> {
    const totalStartedAt = nowMs();
    const { index, token, progress, forceRebuild } = params;
    let orphanRemoved = 0;
    let statMiss = 0;
    let missingRemoved = 0;
    let cacheHit = 0;
    let rebuilt = 0;
    let buildMs = 0;
    let writeMs = 0;

    const context: SearchIndexContext = {
      codexSessionsRoot: params.codexSessionsRoot,
      codexArchivedSessionsRoot: params.codexArchivedSessionsRoot,
      claudeSessionsRoot: params.claudeSessionsRoot,
      includeCodex: params.includeCodex,
      includeCodexArchived: params.includeCodexArchived,
      includeClaude: params.includeClaude,
      indexToolContent: params.indexToolContent,
    };
    await this.loadIfNeeded(context, !!forceRebuild);

    let dirty = false;

    const activeKeys = new Set(index.sessions.map((s) => s.cacheKey));
    orphanRemoved = this.cleanupOrphanEntries(activeKeys);
    if (orphanRemoved > 0) dirty = true;

    const total = index.sessions.length;
    for (let i = 0; i < total; i += 1) {
      throwIfCancelled(token);
      const session = index.sessions[i]!;
      progress?.report({ message: `index ${i + 1}/${total}` });

      const uri = vscode.Uri.file(session.fsPath);
      let stat: vscode.FileStat | null = null;
      try {
        stat = await vscode.workspace.fs.stat(uri);
      } catch {
        statMiss += 1;
        if (this.entries.delete(session.cacheKey)) {
          missingRemoved += 1;
          dirty = true;
        }
        continue;
      }

      const cached = this.entries.get(session.cacheKey);
      const unchanged =
        !!cached &&
        cached.fsPath === session.fsPath &&
        cached.mtimeMs === stat.mtime &&
        cached.size === stat.size;
      if (unchanged) {
        cacheHit += 1;
        continue;
      }

      const buildStartedAt = nowMs();
      const indexed = await buildIndexedSession(session.fsPath, {
        indexToolContent: context.indexToolContent,
        token,
      });
      buildMs += elapsedMs(buildStartedAt);
      this.entries.set(session.cacheKey, {
        fsPath: session.fsPath,
        mtimeMs: stat.mtime,
        size: stat.size,
        messages: indexed.messages,
        fileChangeHints: indexed.fileChangeHints,
      });
      rebuilt += 1;
      dirty = true;
    }

    if (dirty) {
      const writeStartedAt = nowMs();
      await this.save();
      writeMs = elapsedMs(writeStartedAt);
    }

    this.logger?.debug(
      [
        "search.index ensure done",
        `totalMs=${elapsedMs(totalStartedAt)}`,
        `sessions=${total}`,
        `orphanRemoved=${orphanRemoved}`,
        `statMiss=${statMiss}`,
        `missingRemoved=${missingRemoved}`,
        `cacheHit=${cacheHit}`,
        `rebuilt=${rebuilt}`,
        `buildMs=${buildMs}`,
        `writeMs=${writeMs}`,
        `forceRebuild=${forceRebuild ? 1 : 0}`,
      ].join(" "),
    );
  }

  public getMessages(cacheKey: string): IndexedSearchMessage[] | null {
    return this.entries.get(cacheKey)?.messages ?? null;
  }

  public getFileChangeHints(cacheKey: string): IndexedFileChangeHint[] | null {
    return this.entries.get(cacheKey)?.fileChangeHints ?? null;
  }

  private cleanupOrphanEntries(activeKeys: ReadonlySet<string>): number {
    let removed = 0;
    for (const key of Array.from(this.entries.keys())) {
      if (activeKeys.has(key)) continue;
      this.entries.delete(key);
      removed += 1;
    }
    return removed;
  }

  private async loadIfNeeded(nextContext: SearchIndexContext, forceRebuild: boolean): Promise<void> {
    const normalizedContext = normalizeContext(nextContext);
    if (forceRebuild) {
      this.context = normalizedContext;
      this.entries.clear();
      this.loaded = true;
      return;
    }
    if (this.loaded) {
      if (!isSameContext(this.context, normalizedContext)) {
        this.context = normalizedContext;
        this.entries.clear();
      }
      return;
    }

    const raw = await readJson<SearchIndexFileV2>(this.cacheUri);
    if (!isValidCacheFile(raw) || !isSameContext(raw.context, normalizedContext)) {
      this.context = normalizedContext;
      this.entries.clear();
      this.loaded = true;
      return;
    }

    this.context = normalizeContext(raw.context);
    this.entries.clear();
    for (const [key, entry] of Object.entries(raw.entries)) {
      this.entries.set(key, entry);
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    const entries: Record<string, SearchIndexEntryV1> = {};
    for (const [key, value] of this.entries.entries()) entries[key] = value;
    const payload: SearchIndexFileV2 = {
      version: SEARCH_INDEX_FILE_VERSION,
      context: this.context,
      entries,
    };
    // Search index files can grow large, so save without pretty-printing to reduce size.
    await writeJson(this.cacheUri, payload, { pretty: false });
  }
}

function throwIfCancelled(token?: vscode.CancellationToken): void {
  if (token?.isCancellationRequested) {
    throw new vscode.CancellationError();
  }
}

function nowMs(): number {
  return Date.now();
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, nowMs() - startedAt);
}

async function buildIndexedSession(
  fsPath: string,
  options: { indexToolContent: SearchIndexToolContent; token?: vscode.CancellationToken },
): Promise<{ messages: IndexedSearchMessage[]; fileChangeHints: IndexedFileChangeHint[] }> {
  const state: BuildState = {
    messages: [],
    fileChangeHints: [],
    messageIndex: 0,
    toolAnchorByCallId: new Map(),
    indexToolContent: options.indexToolContent,
  };

  const stream = fs.createReadStream(fsPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      throwIfCancelled(options.token);
      if (!line) continue;

      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (indexCodexRecord(obj, state)) continue;
      if (indexClaudeRecord(obj, state)) continue;
    }
  } finally {
    rl.close();
    stream.close();
  }

  return {
    messages: state.messages,
    fileChangeHints: dedupeFileChangeHints(state.fileChangeHints),
  };
}

interface BuildState {
  messages: IndexedSearchMessage[];
  fileChangeHints: IndexedFileChangeHint[];
  messageIndex: number;
  toolAnchorByCallId: Map<string, number>;
  indexToolContent: SearchIndexToolContent;
}

function indexCodexRecord(obj: any, state: BuildState): boolean {
  if (obj?.type === "event_msg") {
    const payloadType = typeof obj?.payload?.type === "string" ? obj.payload.type : "";
    if (payloadType === "patch_apply_end") {
      const anchor = Math.max(1, state.messageIndex);
      addFileChangeHint(state, {
        messageIndex: anchor,
        paths: extractCodexPatchChangePaths(obj?.payload?.changes),
        timestampIso:
          typeof obj?.payload?.timestamp === "string"
            ? obj.payload.timestamp
            : typeof obj?.timestamp === "string"
              ? obj.timestamp
              : undefined,
        origin: "codexPatch",
        hasDiffLikeContent: true,
      });
    }
    return true;
  }

  if (obj?.type !== "response_item") return false;
  const payloadType = obj?.payload?.type;

  if (payloadType === "message") {
    const role = obj?.payload?.role;
    if (role !== "user" && role !== "assistant" && role !== "developer") return true;

    const textRaw = extractTextFromCodexContent(obj?.payload?.content);
    const text = normalizeWhitespace(textRaw);
    if (!text) return true;

    if (role === "user" || role === "assistant") state.messageIndex += 1;
    const anchor = Math.max(1, state.messageIndex);
    state.messages.push({ messageIndex: anchor, role, source: "message", text });
    return true;
  }

  if (payloadType === "function_call" || payloadType === "custom_tool_call") {
    const callId = typeof obj?.payload?.call_id === "string" ? obj.payload.call_id : "";
    const anchor = Math.max(1, state.messageIndex);
    if (callId) state.toolAnchorByCallId.set(callId, anchor);

    if (!shouldIndexToolCalls(state.indexToolContent)) return true;

    const name =
      typeof obj?.payload?.name === "string" && obj.payload.name.trim()
        ? obj.payload.name
        : payloadType === "custom_tool_call"
          ? "custom_tool_call"
          : "";
    const timestampIso = typeof obj?.timestamp === "string" ? obj.timestamp : undefined;
    const rawInput =
      payloadType === "custom_tool_call"
        ? getCustomToolInput(obj?.payload)
        : typeof obj?.payload?.arguments === "string"
          ? tryParseJson(obj.payload.arguments) ?? obj.payload.arguments
          : obj?.payload?.arguments;
    const argsText =
      payloadType === "custom_tool_call"
        ? buildCustomToolCallMetaText(obj?.payload)
        : typeof obj?.payload?.arguments === "string"
          ? normalizeWhitespace(obj.payload.arguments)
          : "";

    addFileChangeHint(state, {
      messageIndex: anchor,
      paths: collectFileChangeHintPaths(rawInput, name),
      timestampIso,
      origin: "toolArguments",
      hasDiffLikeContent: hasDiffLikeContent(rawInput),
    });

    if (name) {
      state.messages.push({
        messageIndex: anchor,
        role: "tool",
        source: "toolArguments",
        text: name,
      });
    }
    if (argsText) {
      state.messages.push({
        messageIndex: anchor,
        role: "tool",
        source: "toolArguments",
        text: argsText,
      });
    }
    return true;
  }

  if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
    if (!shouldIndexToolOutputs(state.indexToolContent)) return true;

    const callId = typeof obj?.payload?.call_id === "string" ? obj.payload.call_id : "";
    const outText =
      payloadType === "custom_tool_call_output"
        ? buildCustomToolOutputMetaText(obj?.payload)
        : typeof obj?.payload?.output === "string"
          ? normalizeWhitespace(obj.payload.output)
          : "";
    const rawOutput = payloadType === "custom_tool_call_output" ? obj?.payload?.output : obj?.payload?.output;
    if (!outText) return true;

    const anchor =
      callId && state.toolAnchorByCallId.has(callId)
        ? state.toolAnchorByCallId.get(callId)!
        : Math.max(1, state.messageIndex);
    addFileChangeHint(state, {
      messageIndex: anchor,
      paths: collectFileChangeHintPaths(rawOutput, ""),
      timestampIso: typeof obj?.timestamp === "string" ? obj.timestamp : undefined,
      origin: "toolOutput",
      hasDiffLikeContent: hasDiffLikeContent(rawOutput),
    });
    state.messages.push({
      messageIndex: anchor,
      role: "tool",
      source: "toolOutput",
      text: outText,
    });
    return true;
  }

  return true;
}

function indexClaudeRecord(obj: any, state: BuildState): boolean {
  const role = detectClaudeMessageRole(obj);
  if (!role) return false;

  const parsed = parseClaudeMessageContent(getClaudeMessageContent(obj));
  const messageText = normalizeWhitespace(parsed.messageText);
  if (messageText) {
    state.messageIndex += 1;
    const anchor = Math.max(1, state.messageIndex);
    state.messages.push({ messageIndex: anchor, role, source: "message", text: messageText });
  }

  const anchor = Math.max(1, state.messageIndex);
  const indexToolCalls = shouldIndexToolCalls(state.indexToolContent);
  const indexToolOutputs = shouldIndexToolOutputs(state.indexToolContent);
  const timestampIso = typeof obj?.timestamp === "string" ? obj.timestamp : undefined;

  for (const toolCall of parsed.toolCalls) {
    const callId = toolCall.callId ?? "";
    if (callId) state.toolAnchorByCallId.set(callId, anchor);
    addFileChangeHint(state, {
      messageIndex: anchor,
      paths: collectFileChangeHintPaths(parseToolArgumentsForHints(toolCall.argumentsText), toolCall.name ?? ""),
      timestampIso,
      origin: "toolArguments",
      hasDiffLikeContent: hasDiffLikeContent(toolCall.argumentsText),
    });
    if (!indexToolCalls) continue;

    const name = normalizeWhitespace(toolCall.name ?? "");
    if (name) {
      state.messages.push({
        messageIndex: anchor,
        role: "tool",
        source: "toolArguments",
        text: name,
      });
    }

    const args = normalizeWhitespace(toolCall.argumentsText ?? "");
    if (args) {
      state.messages.push({
        messageIndex: anchor,
        role: "tool",
        source: "toolArguments",
        text: args,
      });
    }
  }

  if (!indexToolOutputs) return true;

  for (const toolResult of parsed.toolResults) {
    const outText = normalizeWhitespace(toolResult.outputText ?? "");
    if (!outText) continue;
    const callId = toolResult.callId ?? "";
    const linkedAnchor =
      callId && state.toolAnchorByCallId.has(callId)
        ? state.toolAnchorByCallId.get(callId)!
        : anchor;
    addFileChangeHint(state, {
      messageIndex: linkedAnchor,
      paths: collectFileChangeHintPaths(outText, ""),
      timestampIso,
      origin: "toolOutput",
      hasDiffLikeContent: hasDiffLikeContent(outText),
    });
    state.messages.push({
      messageIndex: linkedAnchor,
      role: "tool",
      source: "toolOutput",
      text: outText,
    });
  }

  return true;
}

function extractTextFromCodexContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const maybeText = (item as { text?: unknown }).text;
    if (typeof maybeText === "string") texts.push(maybeText);
  }
  return texts.join("");
}

function parseClaudeMessageContent(content: unknown): {
  messageText: string;
  toolCalls: Array<{ callId?: string; name?: string; argumentsText?: string }>;
  toolResults: Array<{ callId?: string; outputText?: string }>;
} {
  if (typeof content === "string") {
    return { messageText: content, toolCalls: [], toolResults: [] };
  }
  const items = Array.isArray(content) ? content : content && typeof content === "object" ? [content] : null;
  if (!items) {
    return { messageText: "", toolCalls: [], toolResults: [] };
  }

  const messageTexts: string[] = [];
  const toolCalls: Array<{ callId?: string; name?: string; argumentsText?: string }> = [];
  const toolResults: Array<{ callId?: string; outputText?: string }> = [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const type = typeof (item as { type?: unknown }).type === "string" ? (item as { type: string }).type : "";

    if (type === "text" || type === "input_text" || type === "output_text") {
      const text = typeof (item as { text?: unknown }).text === "string" ? (item as { text: string }).text : "";
      if (text) messageTexts.push(text);
      continue;
    }

    if (type === "tool_use") {
      const callId =
        typeof (item as { id?: unknown }).id === "string"
          ? (item as { id: string }).id
          : typeof (item as { tool_use_id?: unknown }).tool_use_id === "string"
            ? (item as { tool_use_id: string }).tool_use_id
            : undefined;
      const name = typeof (item as { name?: unknown }).name === "string" ? (item as { name: string }).name : undefined;
      const input = (item as { input?: unknown }).input;
      const argumentsText =
        typeof input === "string" ? input : input !== undefined ? safeJsonStringify(input) : undefined;
      toolCalls.push({ callId, name, argumentsText });
      continue;
    }

    if (type === "tool_result") {
      const callId =
        typeof (item as { tool_use_id?: unknown }).tool_use_id === "string"
          ? (item as { tool_use_id: string }).tool_use_id
          : typeof (item as { id?: unknown }).id === "string"
            ? (item as { id: string }).id
            : undefined;
      const outputText = extractClaudeToolResultText((item as { content?: unknown }).content);
      toolResults.push({ callId, outputText });
      continue;
    }

    if (typeof (item as { text?: unknown }).text === "string") {
      messageTexts.push((item as { text: string }).text);
    }
  }
  return {
    messageText: messageTexts.join(""),
    toolCalls,
    toolResults,
  };
}

function detectClaudeMessageRole(obj: any): "user" | "assistant" | null {
  const messageRole = typeof obj?.message?.role === "string" ? obj.message.role : "";
  if (messageRole === "user" || messageRole === "assistant") return messageRole;

  const envelopeType = typeof obj?.type === "string" ? obj.type : "";
  if (envelopeType === "user" || envelopeType === "assistant") return envelopeType;

  const topRole = typeof obj?.role === "string" ? obj.role : "";
  if (topRole === "user" || topRole === "assistant") return topRole;

  return null;
}

function getClaudeMessageContent(obj: any): unknown {
  if (obj?.message && typeof obj.message === "object" && "content" in obj.message) {
    return (obj.message as { content?: unknown }).content;
  }
  if (obj && typeof obj === "object" && "content" in obj) return (obj as { content?: unknown }).content;
  return undefined;
}

function extractClaudeToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === "string") {
        parts.push(item);
        continue;
      }
      if (item && typeof item === "object") {
        const type = typeof (item as { type?: unknown }).type === "string" ? (item as { type: string }).type : "";
        if (type === "text" || type === "input_text" || type === "output_text") {
          const text = typeof (item as { text?: unknown }).text === "string" ? (item as { text: string }).text : "";
          if (text) parts.push(text);
          continue;
        }
        if (typeof (item as { text?: unknown }).text === "string") {
          parts.push((item as { text: string }).text);
          continue;
        }
      }
      parts.push(safeJsonStringify(item));
    }
    return parts.join("\n");
  }
  if (content === undefined) return "";
  return safeJsonStringify(content);
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function buildCustomToolCallMetaText(payload: any): string {
  const name = typeof payload?.name === "string" ? payload.name : "";
  const input = getCustomToolInput(payload);
  const action = inferToolAction(name);
  const meta: CustomToolCallMeta = {
    commands: [],
    files: [],
    paths: [],
    sawDiffLikeText: false,
  };

  collectCustomToolCallMeta(input, meta, { depth: 0, key: "", action });
  const parts: string[] = [];
  if (action) parts.push(`action: ${action}`);
  if (meta.commands.length > 0) parts.push(`command: ${dedupeStrings(meta.commands).join(" | ")}`);
  if (meta.files.length > 0) parts.push(`files: ${dedupeStrings(meta.files).join(", ")}`);
  if (meta.paths.length > 0) parts.push(`paths: ${dedupeStrings(meta.paths).join(", ")}`);
  if (meta.sawDiffLikeText && meta.files.length === 0) parts.push("diff: omitted");
  return normalizeWhitespace(parts.join(" "));
}

function buildCustomToolOutputMetaText(payload: any): string {
  const fields = new Map<string, string>();
  collectExecutionMetaFields(payload?.output, fields, 0);
  collectExecutionMetaFields(payload, fields, 0);
  if (fields.size === 0) return "";

  const parts = ["tool_output: custom_tool_call_output"];
  for (const [key, value] of fields.entries()) parts.push(`${key}: ${value}`);
  return normalizeWhitespace(parts.join(" "));
}

interface CustomToolCallMeta {
  commands: string[];
  files: string[];
  paths: string[];
  sawDiffLikeText: boolean;
}

function addFileChangeHint(state: BuildState, hint: IndexedFileChangeHint): void {
  const paths = dedupeStrings(hint.paths.map((value) => cleanupDiffPath(value)).filter((value) => value.length > 0));
  if (paths.length === 0) return;
  state.fileChangeHints.push({
    messageIndex: Math.max(1, Math.floor(hint.messageIndex)),
    paths,
    ...(hint.timestampIso ? { timestampIso: hint.timestampIso } : {}),
    origin: hint.origin,
    hasDiffLikeContent: hint.hasDiffLikeContent,
  });
}

function extractCodexPatchChangePaths(changes: unknown): string[] {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return [];
  const paths: string[] = [];
  for (const [rawPath, rawChange] of Object.entries(changes as Record<string, unknown>)) {
    addMetaValue(paths, rawPath);
    if (rawChange && typeof rawChange === "object") {
      const movePath = (rawChange as { move_path?: unknown }).move_path;
      if (typeof movePath === "string") addMetaValue(paths, movePath);
      const unifiedDiff = (rawChange as { unified_diff?: unknown }).unified_diff;
      if (typeof unifiedDiff === "string") {
        for (const filePath of extractPatchFilePaths(unifiedDiff)) addMetaValue(paths, filePath);
      }
    }
  }
  return dedupeStrings(paths);
}

function collectFileChangeHintPaths(value: unknown, toolName: string): string[] {
  const meta: CustomToolCallMeta = {
    commands: [],
    files: [],
    paths: [],
    sawDiffLikeText: false,
  };
  collectCustomToolCallMeta(value, meta, { depth: 0, key: "", action: inferToolAction(toolName) });
  return dedupeStrings([...meta.files, ...meta.paths]);
}

function parseToolArgumentsForHints(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return tryParseJson(value) ?? value;
}

function hasDiffLikeContent(value: unknown): boolean {
  if (typeof value === "string") {
    return /^\s*(?:\*\*\*|diff --git|--- |\+\+\+ |@@ )/mu.test(value);
  }
  if (Array.isArray(value)) return value.some((item) => hasDiffLikeContent(item));
  if (!value || typeof value !== "object") return false;
  for (const item of Object.values(value as Record<string, unknown>)) {
    if (hasDiffLikeContent(item)) return true;
  }
  return false;
}

function dedupeFileChangeHints(hints: IndexedFileChangeHint[]): IndexedFileChangeHint[] {
  const seen = new Set<string>();
  const out: IndexedFileChangeHint[] = [];
  for (const hint of hints) {
    const key = [
      hint.messageIndex,
      hint.origin,
      hint.timestampIso ?? "",
      hint.hasDiffLikeContent ? "1" : "0",
      hint.paths.map((value) => value.toLowerCase()).sort().join("\u0000"),
    ].join("\u0001");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hint);
  }
  return out;
}

function getCustomToolInput(payload: any): unknown {
  if (payload && typeof payload === "object" && "input" in payload) return payload.input;
  if (!payload || typeof payload !== "object" || !("arguments" in payload)) return undefined;
  const rawArgs = payload.arguments;
  if (typeof rawArgs !== "string") return rawArgs;
  const parsed = tryParseJson(rawArgs);
  return parsed === undefined ? rawArgs : parsed;
}

function collectCustomToolCallMeta(
  value: unknown,
  meta: CustomToolCallMeta,
  context: { depth: number; key: string; action?: string },
): void {
  if (context.depth > MAX_RECURSIVE_META_DEPTH || value === undefined || value === null) return;
  const key = normalizeMetaKey(context.key);

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const text = normalizeMetaScalar(value);
    if (!text || looksLikeDataUri(text)) return;

    if (isCommandKey(key) || (!key && context.action === "run")) {
      addMetaValue(meta.commands, normalizeCommandMeta(text));
      return;
    }
    if (isFilePathKey(key)) {
      addMetaValue(meta.files, text);
      return;
    }
    if (isDirectoryPathKey(key)) {
      addMetaValue(meta.paths, text);
      return;
    }

    const diffPaths = extractPatchFilePaths(text);
    if (diffPaths.length > 0) {
      meta.sawDiffLikeText = true;
      for (const filePath of diffPaths) addMetaValue(meta.files, filePath);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectCustomToolCallMeta(item, meta, { ...context, depth: context.depth + 1 });
    }
    return;
  }

  if (typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveMetaKey(childKey)) continue;
      collectCustomToolCallMeta(childValue, meta, {
        depth: context.depth + 1,
        key: childKey,
        action: context.action,
      });
    }
  }
}

function collectExecutionMetaFields(value: unknown, fields: Map<string, string>, depth: number): void {
  if (depth > MAX_RECURSIVE_META_DEPTH || value === undefined || value === null) return;
  if (typeof value === "string") {
    const parsed = tryParseJson(value);
    if (parsed !== undefined) collectExecutionMetaFields(parsed, fields, depth + 1);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectExecutionMetaFields(item, fields, depth + 1);
    return;
  }
  if (typeof value !== "object") return;

  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const key = normalizeMetaKey(rawKey);
    if (isSensitiveMetaKey(rawKey)) continue;
    const targetKey = normalizeExecutionMetaKey(key);
    if (targetKey && isExecutionMetaScalar(rawValue)) {
      const valueText = normalizeExecutionMetaValue(targetKey, rawValue);
      if (valueText) fields.set(targetKey, valueText);
      continue;
    }
    collectExecutionMetaFields(rawValue, fields, depth + 1);
  }
}

function inferToolAction(name: string): string | undefined {
  const normalized = normalizeToolNameForMeta(name);
  if (!normalized) return undefined;
  if (/(?:applypatch|patch|edit|write|replace|insert|delete|rename|move|multiedit)/u.test(normalized)) return "edit";
  if (/(?:shell|command|exec|bash|powershell|python|npm|run)/u.test(normalized)) return "run";
  if (/(?:search|grep|ripgrep|rg|find)/u.test(normalized)) return "search";
  if (/(?:read|open|cat|view|list|ls)/u.test(normalized)) return "read";
  return undefined;
}

function extractPatchFilePaths(text: string): string[] {
  if (!/^\s*(?:\*\*\*|diff --git|--- |\+\+\+ )/mu.test(text)) return [];

  const out: string[] = [];
  for (const line of text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    const patchHeader = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/u.exec(line);
    if (patchHeader) {
      addMetaValue(out, cleanupDiffPath(patchHeader[1] ?? ""));
      continue;
    }

    const moveHeader = /^\*\*\* Move to:\s*(.+)$/u.exec(line);
    if (moveHeader) {
      addMetaValue(out, cleanupDiffPath(moveHeader[1] ?? ""));
      continue;
    }

    const gitHeader = /^diff --git\s+a\/(.+?)\s+b\/(.+)$/u.exec(line);
    if (gitHeader) {
      addMetaValue(out, cleanupDiffPath(gitHeader[1] ?? ""));
      addMetaValue(out, cleanupDiffPath(gitHeader[2] ?? ""));
      continue;
    }

    const sideHeader = /^(?:---|\+\+\+)\s+(.+)$/u.exec(line);
    if (sideHeader) addMetaValue(out, cleanupDiffPath(sideHeader[1] ?? ""));
  }
  return dedupeStrings(out);
}

function cleanupDiffPath(value: string): string {
  let text = normalizeMetaScalar(value).replace(/^"|"$/g, "");
  const tabIndex = text.indexOf("\t");
  if (tabIndex >= 0) text = text.slice(0, tabIndex).trim();
  if (text.startsWith("a/") || text.startsWith("b/")) text = text.slice(2);
  return text === "/dev/null" ? "" : text;
}

function normalizeCommandMeta(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= MAX_COMMAND_META_LENGTH) return text;
  return `${text.slice(0, MAX_COMMAND_META_LENGTH - 3)}...`;
}

function normalizeMetaScalar(value: string | number | boolean): string {
  return String(value).replace(/\s+/g, " ").trim();
}

function normalizeMetaKey(value: string): string {
  return String(value ?? "").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function normalizeToolNameForMeta(value: string): string {
  return String(value ?? "").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function normalizeExecutionMetaKey(key: string): string | null {
  if (key === "status" || key === "state") return "status";
  if (key === "exitcode" || key === "exitstatus") return "exitCode";
  if (key === "durationms" || key === "elapsedms") return "durationMs";
  if (key === "success" || key === "ok") return "success";
  if (key === "error" || key === "iserror") return "error";
  return null;
}

function normalizeExecutionMetaValue(key: string, value: string | number | boolean): string {
  if (key === "error") {
    if (value === false || value === "false" || value === "") return "";
    return value === true ? "true" : "true";
  }
  const text = normalizeMetaScalar(value);
  return looksLikeDataUri(text) ? "" : normalizeCommandMeta(text);
}

function isCommandKey(key: string): boolean {
  return key === "command" || key === "cmd" || key === "script" || key === "commandline" || key === "shellcommand";
}

function isFilePathKey(key: string): boolean {
  return (
    key === "path" ||
    key === "paths" ||
    key === "file" ||
    key === "files" ||
    key === "filepath" ||
    key === "filepaths" ||
    key === "filename" ||
    key === "targetfile" ||
    key === "targetpath"
  );
}

function isDirectoryPathKey(key: string): boolean {
  return key === "cwd" || key === "workdir" || key === "workdirectory" || key === "workingdirectory";
}

function isSensitiveMetaKey(key: string): boolean {
  const normalized = normalizeMetaKey(key);
  return /(?:secret|token|apikey|password|credential|authorization|authheader)/u.test(normalized);
}

function isExecutionMetaScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function looksLikeDataUri(value: string): boolean {
  return /^data:[^,]+,/iu.test(value);
}

function addMetaValue(target: string[], value: string): void {
  const text = normalizeMetaScalar(value);
  if (!text || looksLikeDataUri(text)) return;
  target.push(text);
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function shouldIndexToolCalls(mode: SearchIndexToolContent): boolean {
  return mode === "toolCalls" || mode === "toolCallsAndOutputs";
}

function shouldIndexToolOutputs(mode: SearchIndexToolContent): boolean {
  return mode === "toolCallsAndOutputs";
}

function isValidCacheFile(value: unknown): value is SearchIndexFileV2 {
  if (!value || typeof value !== "object") return false;
  const obj = value as any;
  if (obj.version !== SEARCH_INDEX_FILE_VERSION) return false;
  if (!obj.context || typeof obj.context !== "object") return false;
  if (typeof obj.context.codexSessionsRoot !== "string") return false;
  if (obj.context.codexArchivedSessionsRoot !== undefined && typeof obj.context.codexArchivedSessionsRoot !== "string") {
    return false;
  }
  if (typeof obj.context.claudeSessionsRoot !== "string") return false;
  if (typeof obj.context.includeCodex !== "boolean") return false;
  if (obj.context.includeCodexArchived !== undefined && typeof obj.context.includeCodexArchived !== "boolean") {
    return false;
  }
  if (typeof obj.context.includeClaude !== "boolean") return false;
  if (obj.context.indexToolContent !== undefined && !isSearchIndexToolContent(obj.context.indexToolContent)) return false;
  if (!obj.entries || typeof obj.entries !== "object") return false;

  for (const [key, entry] of Object.entries(obj.entries as Record<string, unknown>)) {
    if (!isValidCacheEntry(entry)) return false;
    if (typeof key !== "string" || key.length === 0) return false;
  }
  return true;
}

function normalizeContext(context: SearchIndexCacheContext): SearchIndexContext {
  return {
    codexSessionsRoot: normalizePathKey(context.codexSessionsRoot),
    codexArchivedSessionsRoot: normalizePathKey(context.codexArchivedSessionsRoot ?? ""),
    claudeSessionsRoot: normalizePathKey(context.claudeSessionsRoot),
    includeCodex: !!context.includeCodex,
    includeCodexArchived: !!context.includeCodexArchived,
    includeClaude: !!context.includeClaude,
    indexToolContent: normalizeSearchIndexToolContent(context.indexToolContent),
  };
}

function isSameContext(left: SearchIndexCacheContext, right: SearchIndexCacheContext): boolean {
  const a = normalizeContext(left);
  const b = normalizeContext(right);
  return (
    a.codexSessionsRoot === b.codexSessionsRoot &&
    a.codexArchivedSessionsRoot === b.codexArchivedSessionsRoot &&
    a.claudeSessionsRoot === b.claudeSessionsRoot &&
    a.includeCodex === b.includeCodex &&
    a.includeCodexArchived === b.includeCodexArchived &&
    a.includeClaude === b.includeClaude &&
    a.indexToolContent === b.indexToolContent
  );
}

function normalizeSearchIndexToolContent(value: unknown): SearchIndexToolContent {
  return isSearchIndexToolContent(value) ? value : "toolCallsAndOutputs";
}

function isSearchIndexToolContent(value: unknown): value is SearchIndexToolContent {
  return value === "conversationOnly" || value === "toolCalls" || value === "toolCallsAndOutputs";
}

function normalizePathKey(fsPath: string): string {
  const normalized = path.normalize(String(fsPath ?? "").trim());
  return normalized.toLowerCase();
}

function isValidCacheEntry(value: unknown): value is SearchIndexEntryV1 {
  if (!value || typeof value !== "object") return false;
  const obj = value as any;
  if (typeof obj.fsPath !== "string") return false;
  if (typeof obj.mtimeMs !== "number" || !Number.isFinite(obj.mtimeMs)) return false;
  if (typeof obj.size !== "number" || !Number.isFinite(obj.size)) return false;
  if (!Array.isArray(obj.messages)) return false;
  for (const m of obj.messages) {
    if (!m || typeof m !== "object") return false;
    if (typeof (m as any).messageIndex !== "number" || !Number.isFinite((m as any).messageIndex)) return false;
    const role = (m as any).role;
    if (role !== "user" && role !== "assistant" && role !== "developer" && role !== "tool") return false;
    const source = (m as any).source;
    if (source !== "message" && source !== "toolArguments" && source !== "toolOutput") return false;
    if (typeof (m as any).text !== "string") return false;
  }
  if (obj.fileChangeHints !== undefined) {
    if (!Array.isArray(obj.fileChangeHints)) return false;
    for (const hint of obj.fileChangeHints) {
      if (!hint || typeof hint !== "object") return false;
      const h = hint as any;
      if (typeof h.messageIndex !== "number" || !Number.isFinite(h.messageIndex)) return false;
      if (!Array.isArray(h.paths) || h.paths.some((p: unknown) => typeof p !== "string")) return false;
      if (h.timestampIso !== undefined && typeof h.timestampIso !== "string") return false;
      if (h.origin !== "codexPatch" && h.origin !== "toolArguments" && h.origin !== "toolOutput") return false;
      if (typeof h.hasDiffLikeContent !== "boolean") return false;
    }
  }
  return true;
}
