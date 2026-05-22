import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import * as vscode from "vscode";
import { t } from "../i18n";
import type { SessionSource, SessionSummary } from "../sessions/sessionTypes";
import {
  buildAttachmentSummaryLines,
  extractClaudeMessageContent,
  extractCodexMessageContent,
} from "../chat/chatAttachments";
import type { ChatAttachment } from "../chat/chatTypes";

export type HandoffTarget = "codex" | "claude";

export interface CreateHandoffOptions {
  globalStorageUri: vscode.Uri;
  session: SessionSummary;
  target: HandoffTarget;
  sourceSessionsRoot: string;
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

type HandoffRole = "user" | "assistant" | "developer";

interface HandoffMessage {
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
}

interface HandoffDirectoryInfo {
  uri: vscode.Uri;
  createdAtMs: number;
}

interface HandoffMetadata {
  createdAt?: string;
  lastGeneratedAt?: string;
  source?: SessionSource;
  target?: HandoffTarget;
}

interface ClaudeToolCall {
  callId?: string;
  name?: string;
  input?: unknown;
}

const HANDOFF_ROOT_DIR = "handoffs";
const HANDOFF_FILE_NAME = "handoff.md";
const METADATA_FILE_NAME = "metadata.json";
const HANDOFF_SOURCE_DIRS: readonly SessionSource[] = ["codex", "claude"];
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

// Create or update a cross-agent handoff in global storage.
export async function createHandoff(options: CreateHandoffOptions): Promise<HandoffResult> {
  const createdAt = new Date();
  const createdAtIso = createdAt.toISOString();
  const source = options.session.source;
  const target = options.target;
  const location = resolveHandoffLocation({
    globalStorageUri: options.globalStorageUri,
    session: options.session,
    sourceSessionsRoot: options.sourceSessionsRoot,
    target,
  });
  const mirror = buildHandoffDirectoryMirror(options.session, options.sourceSessionsRoot);
  const directoryUri = location.directoryUri;
  await vscode.workspace.fs.createDirectory(directoryUri);

  const context = await parseSessionForHandoff(options.session);
  const markdown = clampText(
    buildHandoffMarkdown({
      session: options.session,
      context,
    }),
    MAX_HANDOFF_CHARS,
  );

  const handoffUri = location.handoffUri;
  const metadataUri = location.metadataUri;
  await vscode.workspace.fs.writeFile(handoffUri, Buffer.from(markdown, "utf8"));
  const sourceSessionStat = await statSourceSession(options.session.fsPath);

  const metadata = {
    schemaVersion: 1,
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
    includes: ["file changes when recoverable"],
    excludes: ["tool calls", "tool outputs"],
    retention: {
      days: RETENTION_DAYS,
      maxEntries: MAX_HANDOFF_DIRECTORIES,
    },
  };
  await vscode.workspace.fs.writeFile(metadataUri, Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, "utf8"));

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
  const mode = options?.mode ?? "expired";
  const handoffRootUri = vscode.Uri.joinPath(globalStorageUri, HANDOFF_ROOT_DIR);
  if (mode === "all") {
    try {
      await vscode.workspace.fs.stat(handoffRootUri);
    } catch {
      return { removedDirectories: 0, removedHandoffs: 0, removedBytes: 0, failedPaths: [] };
    }

    const stats = await collectDirectoryStats(handoffRootUri);
    try {
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
  const directories = await listCurrentHandoffDirectories(handoffRootUri);
  const ordered = directories.slice().sort((a, b) => b.createdAtMs - a.createdAtMs);
  const failedPaths: string[] = [];
  let removedDirectories = 0;
  let removedHandoffs = 0;
  let removedBytes = 0;

  for (let index = 0; index < ordered.length; index += 1) {
    const dir = ordered[index]!;
    if (normalizeFsPathKey(dir.uri.fsPath) === preserveKey) continue;

    const shouldDelete =
      nowMs - dir.createdAtMs > RETENTION_MS ||
      index >= MAX_HANDOFF_DIRECTORIES;
    if (!shouldDelete) continue;

    const stats = await collectDirectoryStats(dir.uri);
    try {
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
  const target = options.target ?? resolveDefaultHandoffTarget(options.session.source);
  const handoffRootUri = vscode.Uri.joinPath(options.globalStorageUri, HANDOFF_ROOT_DIR);
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

async function parseSessionForHandoff(session: SessionSummary): Promise<ParsedSessionContext> {
  const stream = fs.createReadStream(session.fsPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const messages: HandoffMessage[] = [];
  const diffBlocks: HandoffDiffBlock[] = [];
  let invalidJsonLines = 0;
  let totalLines = 0;

  try {
    for await (const line of rl) {
      totalLines += 1;
      if (!line.trim()) continue;

      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        invalidJsonLines += 1;
        continue;
      }

      if (await collectCodexMessage(obj, messages)) {
        collectCodexDiffBlocks(obj, diffBlocks);
        continue;
      }
      await collectClaudeMessage(obj, messages);
      collectClaudeDiffBlocks(obj, diffBlocks);
      collectCodexDiffBlocks(obj, diffBlocks);
    }
  } finally {
    rl.close();
    stream.close();
  }

  return { messages, diffBlocks, invalidJsonLines, totalLines };
}

async function collectCodexMessage(obj: any, messages: HandoffMessage[]): Promise<boolean> {
  if (obj?.type !== "response_item") return false;
  if (obj?.payload?.type !== "message") return true;

  const role = obj?.payload?.role;
  if (role !== "user" && role !== "assistant" && role !== "developer") return true;

  const extracted = await extractCodexMessageContent(obj?.payload?.content, undefined, { enabled: false });
  const text = sanitizeMessageText(combineHandoffText(buildHandoffAttachmentSummary(extracted.attachments), extracted.text));
  if (!text) return true;

  messages.push({
    role,
    text,
  });
  return true;
}

async function collectClaudeMessage(obj: any, messages: HandoffMessage[]): Promise<boolean> {
  const role = detectClaudeMessageRole(obj);
  if (!role) return false;

  const extracted = await extractClaudeMessageContent(getClaudeMessageContent(obj), undefined, { enabled: false });
  const text = sanitizeMessageText(combineHandoffText(buildHandoffAttachmentSummary(extracted.attachments), extracted.text));
  if (!text) return true;

  messages.push({
    role,
    text,
  });
  return true;
}

function collectCodexDiffBlocks(obj: any, diffBlocks: HandoffDiffBlock[]): void {
  if (diffBlocks.length >= MAX_DIFF_BLOCKS) return;
  if (obj?.type !== "event_msg" || obj?.payload?.type !== "patch_apply_end") return;

  const changes = obj?.payload?.changes;
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
  if (diffBlocks.length >= MAX_DIFF_BLOCKS) return;
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
}): string {
  const { session, context } = params;
  const lines: string[] = [];
  const sourceLabel = session.source === "claude" ? "Claude Code" : "OpenAI Codex";
  const currentGoal = findLatestUserMessage(context.messages);
  const transcript = buildTranscriptExcerpt(context.messages, MAX_TRANSCRIPT_CHARS);
  const diffs = buildDiffSection(context.diffBlocks);

  lines.push("# Handoff");
  lines.push("");
  lines.push(`- Source: \`${sourceLabel}\``);
  lines.push(`- Source session file: \`${session.fsPath}\``);
  if (session.meta.cwd) lines.push(`- CWD: \`${session.meta.cwd}\``);
  lines.push("");
  lines.push("> Transcript is tail-prioritized. Tool calls and tool outputs are omitted. File changes are included when recoverable.");
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

function buildTranscriptExcerpt(messages: readonly HandoffMessage[], maxChars: number): string {
  if (messages.length === 0) return "(no messages extracted)";

  const blocks = messages.map((message) => renderMessageBlock(message));
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

function renderMessageBlock(message: HandoffMessage): string {
  const lines = [`### ${message.role}`];
  lines.push("");
  lines.push(message.text);
  return lines.join("\n");
}

function buildHandoffAttachmentSummary(attachments: readonly ChatAttachment[]): string {
  const lines = buildAttachmentSummaryLines(attachments);
  if (lines.length === 0) return "";
  return ["Attachments and referenced files from previous session:", ...lines].join("\n");
}

function combineHandoffText(attachmentSummary: string, text: string): string {
  const cleanText = String(text ?? "").trim();
  if (!attachmentSummary) return cleanText;
  return cleanText ? `${attachmentSummary}\n\n${cleanText}` : attachmentSummary;
}

function buildDiffSection(diffBlocks: readonly HandoffDiffBlock[]): string {
  if (diffBlocks.length === 0) return "";
  const lines: string[] = [];
  let used = 0;

  for (const block of diffBlocks) {
    const header = `### ${block.path}${block.changeType ? ` (${block.changeType})` : ""}`;
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
    if (message.role === "user" && message.text.trim().length > 0) return message.text.trim();
  }
  return null;
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

function buildHandoffDirectoryMirror(
  session: SessionSummary,
  sourceSessionsRoot: string,
): { segments: string[]; relativePath: string | null; mode: "source-relative-mirror" | "hash-fallback" } {
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

async function listCurrentHandoffDirectories(handoffRootUri: vscode.Uri): Promise<HandoffDirectoryInfo[]> {
  const groups = await Promise.all(
    HANDOFF_SOURCE_DIRS.map((source) => listHandoffDirectories(vscode.Uri.joinPath(handoffRootUri, source))),
  );
  return groups.flat();
}

async function listHandoffDirectories(rootUri: vscode.Uri): Promise<HandoffDirectoryInfo[]> {
  const out: HandoffDirectoryInfo[] = [];
  const stack: vscode.Uri[] = [rootUri];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      continue;
    }

    const hasHandoffFile = entries.some(
      ([name, type]) => name === HANDOFF_FILE_NAME && (type & vscode.FileType.File) !== 0,
    );
    if (hasHandoffFile) {
      out.push({
        uri: dir,
        createdAtMs: await readHandoffCreatedAtMs(dir),
      });
      continue;
    }

    for (const [name, type] of entries) {
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

async function readHandoffMetadata(metadataUri: vscode.Uri): Promise<HandoffMetadata> {
  try {
    const raw = Buffer.from(await vscode.workspace.fs.readFile(metadataUri)).toString("utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const source = parsed.source === "codex" || parsed.source === "claude" ? parsed.source : undefined;
    const target = parsed.target === "codex" || parsed.target === "claude" ? parsed.target : undefined;
    return {
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : undefined,
      lastGeneratedAt: typeof parsed.lastGeneratedAt === "string" ? parsed.lastGeneratedAt : undefined,
      source,
      target,
    };
  } catch {
    return {};
  }
}

async function statSourceSession(fsPath: string): Promise<{ mtime: number; size: number } | null> {
  try {
    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
    return { mtime: stat.mtime, size: stat.size };
  } catch {
    return null;
  }
}

async function collectDirectoryStats(rootUri: vscode.Uri): Promise<{ fileCount: number; bytes: number }> {
  const stack: vscode.Uri[] = [rootUri];
  let fileCount = 0;
  let bytes = 0;

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      continue;
    }

    for (const [name, type] of entries) {
      const child = vscode.Uri.joinPath(dir, name);
      if ((type & vscode.FileType.Directory) !== 0) {
        stack.push(child);
        continue;
      }
      if ((type & vscode.FileType.File) === 0) continue;
      if (name === HANDOFF_FILE_NAME) fileCount += 1;
      try {
        const stat = await vscode.workspace.fs.stat(child);
        bytes += stat.size;
      } catch {
        // Keep cleanup moving even if one file cannot be stated.
      }
    }
  }

  return { fileCount, bytes };
}

function normalizeFsPathKey(value: string | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}
