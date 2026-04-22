import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import * as vscode from "vscode";
import type { HistoryIndex } from "../sessions/sessionTypes";
import { readJson, writeJson } from "../storage/jsonStorage";
import { normalizeWhitespace } from "../utils/textUtils";
import type { DebugLogger } from "./logger";

export type IndexedSearchRole = "user" | "assistant" | "developer" | "tool";

export interface IndexedSearchMessage {
  messageIndex: number;
  role: IndexedSearchRole;
  source: "message" | "toolArguments" | "toolOutput";
  text: string;
}

interface SearchIndexEntryV1 {
  fsPath: string;
  mtimeMs: number;
  size: number;
  messages: IndexedSearchMessage[];
}

interface SearchIndexContext {
  codexSessionsRoot: string;
  claudeSessionsRoot: string;
  includeCodex: boolean;
  includeClaude: boolean;
}

interface SearchIndexFileV2 {
  version: 4;
  context: SearchIndexContext;
  entries: Record<string, SearchIndexEntryV1>;
}

// Maintains an incremental on-disk search index for session files.
export class SearchIndexService {
  private readonly cacheUri: vscode.Uri;
  private readonly logger?: DebugLogger;
  private loaded = false;
  private context: SearchIndexContext = {
    codexSessionsRoot: "",
    claudeSessionsRoot: "",
    includeCodex: true,
    includeClaude: false,
  };
  private readonly entries = new Map<string, SearchIndexEntryV1>();

  constructor(globalStorageUri: vscode.Uri, logger?: DebugLogger) {
    this.cacheUri = vscode.Uri.joinPath(globalStorageUri, "search-index.v2.json");
    this.logger = logger;
  }

  public async ensureUpToDate(params: {
    index: HistoryIndex;
    codexSessionsRoot: string;
    claudeSessionsRoot: string;
    includeCodex: boolean;
    includeClaude: boolean;
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
      claudeSessionsRoot: params.claudeSessionsRoot,
      includeCodex: params.includeCodex,
      includeClaude: params.includeClaude,
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
      const messages = await buildIndexedMessages(session.fsPath, token);
      buildMs += elapsedMs(buildStartedAt);
      this.entries.set(session.cacheKey, {
        fsPath: session.fsPath,
        mtimeMs: stat.mtime,
        size: stat.size,
        messages,
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
      version: 4,
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

async function buildIndexedMessages(
  fsPath: string,
  token?: vscode.CancellationToken,
): Promise<IndexedSearchMessage[]> {
  const state: BuildState = {
    messages: [],
    messageIndex: 0,
    toolAnchorByCallId: new Map(),
  };

  const stream = fs.createReadStream(fsPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      throwIfCancelled(token);
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

  return state.messages;
}

interface BuildState {
  messages: IndexedSearchMessage[];
  messageIndex: number;
  toolAnchorByCallId: Map<string, number>;
}

function indexCodexRecord(obj: any, state: BuildState): boolean {
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

  if (payloadType === "function_call") {
    const callId = typeof obj?.payload?.call_id === "string" ? obj.payload.call_id : "";
    const name = typeof obj?.payload?.name === "string" ? obj.payload.name : "";
    const argsRaw = typeof obj?.payload?.arguments === "string" ? obj.payload.arguments : "";
    const argsText = normalizeWhitespace(argsRaw);
    const anchor = Math.max(1, state.messageIndex);
    if (callId) state.toolAnchorByCallId.set(callId, anchor);

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

  if (payloadType === "function_call_output") {
    const callId = typeof obj?.payload?.call_id === "string" ? obj.payload.call_id : "";
    const outRaw = typeof obj?.payload?.output === "string" ? obj.payload.output : "";
    const outText = normalizeWhitespace(outRaw);
    if (!outText) return true;

    const anchor =
      callId && state.toolAnchorByCallId.has(callId)
        ? state.toolAnchorByCallId.get(callId)!
        : Math.max(1, state.messageIndex);
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
  for (const toolCall of parsed.toolCalls) {
    const callId = toolCall.callId ?? "";
    if (callId) state.toolAnchorByCallId.set(callId, anchor);

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

  for (const toolResult of parsed.toolResults) {
    const outText = normalizeWhitespace(toolResult.outputText ?? "");
    if (!outText) continue;
    const callId = toolResult.callId ?? "";
    const linkedAnchor =
      callId && state.toolAnchorByCallId.has(callId)
        ? state.toolAnchorByCallId.get(callId)!
        : anchor;
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

function isValidCacheFile(value: unknown): value is SearchIndexFileV2 {
  if (!value || typeof value !== "object") return false;
  const obj = value as any;
  if (obj.version !== 4) return false;
  if (!obj.context || typeof obj.context !== "object") return false;
  if (typeof obj.context.codexSessionsRoot !== "string") return false;
  if (typeof obj.context.claudeSessionsRoot !== "string") return false;
  if (typeof obj.context.includeCodex !== "boolean") return false;
  if (typeof obj.context.includeClaude !== "boolean") return false;
  if (!obj.entries || typeof obj.entries !== "object") return false;

  for (const [key, entry] of Object.entries(obj.entries as Record<string, unknown>)) {
    if (!isValidCacheEntry(entry)) return false;
    if (typeof key !== "string" || key.length === 0) return false;
  }
  return true;
}

function normalizeContext(context: SearchIndexContext): SearchIndexContext {
  return {
    codexSessionsRoot: normalizePathKey(context.codexSessionsRoot),
    claudeSessionsRoot: normalizePathKey(context.claudeSessionsRoot),
    includeCodex: !!context.includeCodex,
    includeClaude: !!context.includeClaude,
  };
}

function isSameContext(left: SearchIndexContext, right: SearchIndexContext): boolean {
  const a = normalizeContext(left);
  const b = normalizeContext(right);
  return (
    a.codexSessionsRoot === b.codexSessionsRoot &&
    a.claudeSessionsRoot === b.claudeSessionsRoot &&
    a.includeCodex === b.includeCodex &&
    a.includeClaude === b.includeClaude
  );
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
  return true;
}
