import * as fs from "node:fs";
import * as readline from "node:readline";
import * as vscode from "vscode";
import type { HistoryIndex } from "../sessions/sessionTypes";
import { readJson, writeJson } from "../storage/jsonStorage";
import { normalizeWhitespace } from "../utils/textUtils";

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

interface SearchIndexFileV1 {
  version: 2;
  sessionsRoot: string;
  entries: Record<string, SearchIndexEntryV1>;
}

// Maintains an incremental on-disk search index for session files.
export class SearchIndexService {
  private readonly cacheUri: vscode.Uri;
  private loaded = false;
  private sessionsRoot = "";
  private readonly entries = new Map<string, SearchIndexEntryV1>();

  constructor(globalStorageUri: vscode.Uri) {
    this.cacheUri = vscode.Uri.joinPath(globalStorageUri, "search-index.v1.json");
  }

  public async ensureUpToDate(params: {
    index: HistoryIndex;
    token?: vscode.CancellationToken;
    progress?: vscode.Progress<{ message?: string; increment?: number }>;
    forceRebuild?: boolean;
  }): Promise<void> {
    const { index, token, progress, forceRebuild } = params;
    await this.loadIfNeeded(index.sessionsRoot, !!forceRebuild);

    let dirty = false;
    if (this.sessionsRoot !== index.sessionsRoot) {
      this.sessionsRoot = index.sessionsRoot;
      this.entries.clear();
      dirty = true;
    }

    const activeKeys = new Set(index.sessions.map((s) => s.cacheKey));
    for (const key of Array.from(this.entries.keys())) {
      if (!activeKeys.has(key)) {
        this.entries.delete(key);
        dirty = true;
      }
    }

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
        if (this.entries.delete(session.cacheKey)) dirty = true;
        continue;
      }

      const cached = this.entries.get(session.cacheKey);
      const unchanged =
        !!cached &&
        cached.fsPath === session.fsPath &&
        cached.mtimeMs === stat.mtime &&
        cached.size === stat.size;
      if (unchanged) continue;

      const messages = await buildIndexedMessages(session.fsPath, token);
      this.entries.set(session.cacheKey, {
        fsPath: session.fsPath,
        mtimeMs: stat.mtime,
        size: stat.size,
        messages,
      });
      dirty = true;
    }

    if (dirty) await this.save();
  }

  public getMessages(cacheKey: string): IndexedSearchMessage[] | null {
    return this.entries.get(cacheKey)?.messages ?? null;
  }

  private async loadIfNeeded(sessionsRoot: string, forceRebuild: boolean): Promise<void> {
    if (forceRebuild) {
      this.sessionsRoot = sessionsRoot;
      this.entries.clear();
      this.loaded = true;
      return;
    }
    if (this.loaded) return;

    const raw = await readJson<SearchIndexFileV1>(this.cacheUri);
    if (!isValidCacheFile(raw) || raw.sessionsRoot !== sessionsRoot) {
      this.sessionsRoot = sessionsRoot;
      this.entries.clear();
      this.loaded = true;
      return;
    }

    this.sessionsRoot = raw.sessionsRoot;
    this.entries.clear();
    for (const [key, entry] of Object.entries(raw.entries)) {
      this.entries.set(key, entry);
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    const entries: Record<string, SearchIndexEntryV1> = {};
    for (const [key, value] of this.entries.entries()) entries[key] = value;
    const payload: SearchIndexFileV1 = {
      version: 2,
      sessionsRoot: this.sessionsRoot,
      entries,
    };
    await writeJson(this.cacheUri, payload);
  }
}

function throwIfCancelled(token?: vscode.CancellationToken): void {
  if (token?.isCancellationRequested) {
    throw new vscode.CancellationError();
  }
}

async function buildIndexedMessages(
  fsPath: string,
  token?: vscode.CancellationToken,
): Promise<IndexedSearchMessage[]> {
  const messages: IndexedSearchMessage[] = [];
  let messageIndex = 0;
  const toolAnchorByCallId = new Map<string, number>();

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
      if (obj?.type !== "response_item") continue;
      const payloadType = obj?.payload?.type;

      if (payloadType === "message") {
        const role = obj?.payload?.role;
        if (role !== "user" && role !== "assistant" && role !== "developer") continue;

        const textRaw = extractTextFromContent(obj?.payload?.content);
        const text = normalizeWhitespace(textRaw);
        if (!text) continue;

        if (role === "user" || role === "assistant") messageIndex += 1;
        const anchor = Math.max(1, messageIndex);
        messages.push({ messageIndex: anchor, role, source: "message", text });
        continue;
      }

      if (payloadType === "function_call") {
        const callId = typeof obj?.payload?.call_id === "string" ? obj.payload.call_id : "";
        const name = typeof obj?.payload?.name === "string" ? obj.payload.name : "";
        const argsRaw = typeof obj?.payload?.arguments === "string" ? obj.payload.arguments : "";
        const argsText = normalizeWhitespace(argsRaw);
        const anchor = Math.max(1, messageIndex);
        if (callId) toolAnchorByCallId.set(callId, anchor);

        // Index both tool name and arguments for search coverage.
        if (name) {
          messages.push({
            messageIndex: anchor,
            role: "tool",
            source: "toolArguments",
            text: name,
          });
        }
        if (argsText) {
          messages.push({
            messageIndex: anchor,
            role: "tool",
            source: "toolArguments",
            text: argsText,
          });
        }
        continue;
      }

      if (payloadType === "function_call_output") {
        const callId = typeof obj?.payload?.call_id === "string" ? obj.payload.call_id : "";
        const outRaw = typeof obj?.payload?.output === "string" ? obj.payload.output : "";
        const outText = normalizeWhitespace(outRaw);
        if (!outText) continue;

        const anchor = callId && toolAnchorByCallId.has(callId) ? toolAnchorByCallId.get(callId)! : Math.max(1, messageIndex);
        messages.push({
          messageIndex: anchor,
          role: "tool",
          source: "toolOutput",
          text: outText,
        });
        continue;
      }
    }
  } finally {
    rl.close();
    stream.close();
  }

  return messages;
}

function extractTextFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const maybeText = (item as any).text;
    if (typeof maybeText === "string") texts.push(maybeText);
  }
  return texts.join("");
}

function isValidCacheFile(value: unknown): value is SearchIndexFileV1 {
  if (!value || typeof value !== "object") return false;
  const obj = value as any;
  if (obj.version !== 2) return false;
  if (typeof obj.sessionsRoot !== "string") return false;
  if (!obj.entries || typeof obj.entries !== "object") return false;

  for (const [key, entry] of Object.entries(obj.entries as Record<string, unknown>)) {
    if (!isValidCacheEntry(entry)) return false;
    if (typeof key !== "string" || key.length === 0) return false;
  }
  return true;
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
