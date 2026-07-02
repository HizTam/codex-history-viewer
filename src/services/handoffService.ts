import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import * as vscode from "vscode";
import { t } from "../i18n";
import type { SessionSource, SessionSummary } from "../sessions/sessionTypes";
import {
  buildAttachmentSummaryLines,
  detectClaudeMaterializedMessageRole,
  extractClaudeMessageContent,
  extractCodexMessageContent,
} from "../chat/chatAttachments";
import type { ChatAttachment } from "../chat/chatTypes";
import { mapAssociatedProjectPath, type ProjectPathMapping } from "./projectPathMapper";
import { normalizeProjectKey } from "../utils/fsUtils";

export type HandoffTarget = "codex" | "claude";

export interface CreateHandoffOptions {
  globalStorageUri: vscode.Uri;
  session: SessionSummary;
  target: HandoffTarget;
  sourceSessionsRoot: string;
  pathRewrite?: HandoffPathRewriteContext;
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

export interface HandoffMetadata {
  createdAt?: string;
  lastGeneratedAt?: string;
  source?: SessionSource;
  target?: HandoffTarget;
  pathRewrite?: HandoffPathRewriteMetadata;
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
const PATH_REWRITE_ALGORITHM_VERSION = 1;
const ABSOLUTE_PATH_START_RE = /[A-Za-z]:[\\/]|\\\\[^\\/\s"'`<>|]+[\\/][^\\/\s"'`<>|]+[\\/]|\/(?!\/)/g;
const TRAILING_PATH_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", ")", "]", "}", "、", "。", "，", "．"]);

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
  const pathRewrite = normalizeHandoffPathRewriteContext(options.pathRewrite);

  const context = await parseSessionForHandoff(options.session);
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
    pathRewrite,
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

  const extracted = await extractClaudeMessageContent(getClaudeMessageContent(obj), undefined, { enabled: false }, { role });
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
  if (isPatchApplyEndFailure(obj)) return;

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

function isPatchApplyEndFailure(obj: any): boolean {
  const payload = obj?.payload && typeof obj.payload === "object" ? obj.payload : {};
  if (typeof payload.success === "boolean") return !payload.success;
  const status = typeof payload.status === "string" ? payload.status.trim().toLowerCase() : "";
  return status === "failed" || status === "failure" || status === "error" || status === "cancelled" || status === "canceled";
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
  pathRewrite: HandoffPathRewriteMetadata;
}): string {
  const { session, context, pathRewrite } = params;
  const lines: string[] = [];
  const sourceLabel = session.source === "claude" ? "Claude Code" : "OpenAI Codex";
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
  const lines = [`### ${message.role}`];
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
    if (message.role === "user" && message.text.trim().length > 0) return message.text.trim();
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

export async function readHandoffMetadata(metadataUri: vscode.Uri): Promise<HandoffMetadata> {
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
      pathRewrite: sanitizePathRewriteMetadata(parsed.pathRewrite),
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
