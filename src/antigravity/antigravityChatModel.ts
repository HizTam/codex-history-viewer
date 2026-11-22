import * as path from "node:path";
import { createHash } from "node:crypto";
import { isRecord } from "../storage/sqliteRuntime";
import type { ChatAntigravityTurnFileChanges, ChatAntigravityTurnFileDiff, ChatAttachment, ChatMessageItem, ChatPatchEntry, ChatPatchGroupItem, ChatSessionModel, ChatTimelineItem, ChatToolItem, ChatTurnSummary, ChatUsageItem } from "../chat/chatTypes";
import type { ChatSessionModelBuildOptions, ChatSessionModelWithActivityEvidence } from "../chat/chatModelBuilder";
import { createChatSourceActivityEvidence, isLiveActivityFresh, LIVE_RUNNING_STALE_MS } from "../chat/liveActivity";
import { t } from "../i18n";
import { antigravityReader } from "./antigravityReader";
import { antigravitySessionIdentity, antigravityWorkspacePath } from "./antigravitySessionSummary";
import { antigravityNativeKey, setAntigravityTargetFingerprint } from "./antigravityIdentity";
import type { AntigravitySessionData } from "./antigravityReaderTypes";
import type { AntigravityAttachment, AntigravityFileEdit, AntigravityIssue, AntigravityStep, AntigravityToolCall } from "./antigravityTypes";
import { normalizeAntigravityEditPath } from "./antigravityFileEdit";
import { compareAntigravityTurnText, composeAntigravityEditText } from "./antigravityTurnDiff";

interface ToolOperation {
  readonly step: AntigravityStep;
  readonly call: AntigravityToolCall;
  readonly position: number;
  readonly result?: AntigravityStep;
  readonly duplicate: boolean;
}
export interface AntigravityChatProjection extends ChatSessionModelWithActivityEvidence {
  readonly digest: string;
  readonly issues: readonly AntigravityIssue[];
  readonly usagePartial: boolean;
}
interface NativeTurn {
  readonly summary: ChatTurnSummary;
  readonly executionId?: string;
  readonly items: ChatTimelineItem[];
  active: boolean;
  latestActivity?: string;
  terminal: boolean;
}

export function antigravityToolArguments(call: AntigravityToolCall): Readonly<Record<string, unknown>> | undefined {
  try {
    const parsed: unknown = JSON.parse(call.argumentsJson);
    if (!isRecord(parsed)) return undefined;
    const pending = [{ value: parsed as unknown, depth: 0 }]; let count = 0;
    while (pending.length) {
      const { value, depth } = pending.pop()!;
      if (++count > 10000 || depth > 32) return undefined;
      if (Array.isArray(value)) for (const item of value) pending.push({ value: item, depth: depth + 1 });
      else if (isRecord(value)) for (const item of Object.values(value)) pending.push({ value: item, depth: depth + 1 });
    }
    return parsed;
  } catch { return undefined; }
}
function argument(args: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined {
  const value = args && Object.hasOwn(args, key) ? args[key] : undefined;
  return typeof value === "string" ? value : undefined;
}
function attachment(value: AntigravityAttachment, options: ChatSessionModelBuildOptions, nativeKey: string): ChatAttachment {
  if (value.kind === "image") {
    const mime = value.mimeType?.toLowerCase(), allowed = mime && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime);
    const maximum = Math.min(options.images?.maxSizeMB ?? 20, 12) * 1024 * 1024;
    const enabled = options.images?.enabled !== false;
    if (enabled && allowed && value.base64 && Buffer.byteLength(value.base64, "base64") <= maximum) {
      // Native position and content isolate lazy payloads across steps, attachments and rewrites.
      const id = `ag-image-${createHash("sha256").update(nativeKey).update("\0").update(mime).update("\0").update(value.base64).digest("hex")}`;
      return { id, type: "image", source: "data", status: "available", src: `data:${mime};base64,${value.base64}`, mimeType: mime, label: value.label };
    }
    return { type: "image", source: "reference", status: "unavailable", mimeType: mime, label: value.label,
      reason: !enabled ? "disabled" : value.base64 && allowed ? "tooLarge" : "unsupported" };
  }
  const file = value.uri ? antigravityWorkspacePath([value.uri]) : value.path && path.isAbsolute(value.path) && !value.path.startsWith("\\\\") && !/[\u0000-\u001f]/.test(value.path) ? value.path : undefined;
  return { type: "fileReference", source: "antigravity", path: file, label: value.label ?? (file ? path.basename(file) : undefined) };
}

function toolOperations(data: AntigravitySessionData, issues: Set<AntigravityIssue>): { operations: Map<number, ToolOperation[]>; pairedResults: Set<number>; coverageLimited: boolean } {
  const calls = new Map<string, Array<{ step: AntigravityStep; call: AntigravityToolCall; position: number }>>();
  const results = new Map<string, AntigravityStep[]>(); let callCount = 0, resultCount = 0;
  for (const step of data.steps) {
    for (const [position, call] of (step.planner?.tools ?? []).entries()) {
      if (++callCount > 10000) { issues.add("truncated"); continue; }
      const values = calls.get(call.id) ?? []; values.push({ step, call, position }); calls.set(call.id, values);
    }
    if (step.generic && step.tool) {
      if (++resultCount > 10000) { issues.add("truncated"); continue; }
      const values = results.get(step.tool.id) ?? []; values.push(step); results.set(step.tool.id, values);
    }
  }
  const operations = new Map<number, ToolOperation[]>(), pairedResults = new Set<number>();
  for (const [id, values] of calls) {
    const outputs = results.get(id) ?? [], duplicate = values.length !== 1 || outputs.length > 1;
    if (duplicate) issues.add("duplicateTool");
    for (const value of values) {
      const candidate = !duplicate && outputs.length === 1 ? outputs[0] : undefined;
      const result = candidate && (!candidate.executionId || !value.step.executionId || candidate.executionId === value.step.executionId) ? candidate : undefined;
      if (candidate && !result) issues.add("unmatchedTool");
      if (result) pairedResults.add(result.index);
      const entries = operations.get(value.step.index) ?? []; entries.push({ ...value, result, duplicate }); operations.set(value.step.index, entries);
    }
  }
  for (const step of data.steps) {
    if (!step.generic || pairedResults.has(step.index)) continue;
    issues.add("unmatchedTool");
    if (!step.tool) continue;
    const entries = operations.get(step.index) ?? []; entries.push({ step, call: step.tool, position: 0, result: step, duplicate: (results.get(step.tool.id)?.length ?? 0) > 1 }); operations.set(step.index, entries);
  }
  return { operations, pairedResults, coverageLimited: callCount > 10000 || resultCount > 10000 };
}

type ProjectedPatch = {
  readonly entry: ChatPatchEntry;
  readonly legacyCounts: readonly [number, number];
  readonly inLegacyGroup: boolean;
};

function projectPatches(operation: ToolOperation, args: Readonly<Record<string, unknown>> | undefined, key: string, details: boolean,
  budget: { rows: number; entries: number; recoveredRows: number; recoveredEntries: number }, issues: Set<AntigravityIssue>): ProjectedPatch[] {
  if (operation.duplicate || operation.result && [4, 5, 6, 7, 12].includes(operation.result.status)) return [];
  if (operation.call.name !== "write_file" && operation.call.name !== "edit_file") return [];
  const nativeFiles = operation.result?.generic?.files ?? [];
  const requestedPath = argument(args, "Path");
  const requestFile = requestedPath && path.isAbsolute(requestedPath) && !requestedPath.startsWith("\\\\") && !/[\u0000-\u001f]/.test(requestedPath) ? requestedPath : undefined;
  if (nativeFiles.length > 200) issues.add("truncated");
  const candidates = nativeFiles.length ? nativeFiles.slice(0, 200).flatMap(file => {
    const local = antigravityWorkspacePath([file.uri]);
    return local ? [{ path: local, additions: file.additions, deletions: file.deletions, hasDiffStats: file.hasDiffStats }] : [];
  }) : requestFile ? [{ path: requestFile, additions: undefined, deletions: undefined, hasDiffStats: undefined }] : [];
  const perPath = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const rows = perPath.get(candidate.path);
    if (rows) rows.push(candidate);
    else perPath.set(candidate.path, [candidate]);
  }
  const legacy: typeof candidates = [], recovered: typeof candidates = [];
  for (const rows of perPath.values()) {
    const first = rows[0]!;
    const representative = rows.find(row => row.hasDiffStats) ?? first;
    if (rows.every(row => row.additions === first.additions && row.deletions === first.deletions)) {
      legacy.push(representative);
      continue;
    }
    // Compare recorded counts in the same way they are presented to the user.
    const adds = representative.additions ?? (representative.hasDiffStats ? 0 : undefined);
    const deletes = representative.deletions ?? (representative.hasDiffStats ? 0 : undefined);
    if (rows.every(row => (row.additions ?? (row.hasDiffStats ? 0 : undefined)) === adds
      && (row.deletions ?? (row.hasDiffStats ? 0 : undefined)) === deletes)) {
      recovered.push(representative);
    } else {
      issues.add("unknownPayload");
    }
  }
  // Preserve the existing files and their IDs before appending newly resolvable duplicates.
  if (legacy.length > budget.entries || recovered.length > budget.recoveredEntries) issues.add("truncated");
  const selectedLegacy = legacy.slice(0, budget.entries), selectedRecovered = recovered.slice(0, budget.recoveredEntries);
  // A newly recoverable row cannot consume space reserved for an existing bookmark target.
  budget.entries -= selectedLegacy.length; budget.recoveredEntries -= selectedRecovered.length;
  return [...selectedLegacy, ...selectedRecovered].map((file, index) => {
    const inLegacyGroup = index < selectedLegacy.length;
    const rowBudget = inLegacyGroup ? "rows" : "recoveredRows";
    const before = operation.call.name === "edit_file" ? argument(args, "Target") : undefined;
    const after = operation.call.name === "edit_file" ? argument(args, "Replacement") : undefined;
    const lines = (text: string): string[] => {
      if (!text) return [];
      const values = text.replace(/\r\n?/g, "\n").split("\n", 20001);
      if (values.length <= 20000 && values.at(-1) === "") values.pop();
      return values;
    };
    const requestPresent = file.path === requestFile && before !== undefined && after !== undefined;
    const requestBounded = requestPresent && before.length + after.length <= 2 * 1024 * 1024;
    const beforeLines = requestBounded ? lines(before!) : [], afterLines = requestBounded ? lines(after!) : [];
    const lineCount = requestBounded ? beforeLines.length + afterLines.length : Infinity;
    const requestKnown = requestBounded && lineCount <= 20000;
    const canShowRequest = details && requestKnown && lineCount <= budget[rowBudget];
    if (details && lineCount <= 20000 && lineCount > budget[rowBudget]) issues.add("truncated");
    if (canShowRequest) budget[rowBudget] -= lineCount;
    const rows = canShowRequest ? [
      ...beforeLines.map(line => ({ kind: "delete" as const, leftText: line, rightText: "" })),
      ...afterLines.map(line => ({ kind: "add" as const, leftText: "", rightText: line })),
    ] : [];
    const legacyCounts = [file.additions ?? (requestKnown ? afterLines.length : 0), file.deletions ?? (requestKnown ? beforeLines.length : 0)] as const;
    // A present proto3 stats message defines omitted counters as zero.
    const added = file.additions ?? (file.hasDiffStats ? 0 : legacyCounts[0]);
    const removed = file.deletions ?? (file.hasDiffStats ? 0 : legacyCounts[1]);
    const entry: ChatPatchEntry = { id: `ag-entry-${antigravityNativeKey(key, file.path, index, "patch").slice(0, 32)}`, callId: operation.call.id,
      path: file.path, displayPath: file.path, changeType: operation.call.name === "edit_file" ? "update" : "unknown",
      evidence: "unconfirmed", incomplete: true, added, removed, detailsOmitted: !canShowRequest,
      statsAvailability: { added: file.additions !== undefined || !!file.hasDiffStats || requestKnown,
        removed: file.deletions !== undefined || !!file.hasDiffStats || requestKnown },
      detailsUnavailable: !requestKnown ? requestPresent ? "limit" : "nativeFormat" : details && !canShowRequest ? "limit" : undefined,
      hunks: canShowRequest ? [{ header: "@@ @@", rows }] : [] };
    return { entry, legacyCounts, inLegacyGroup };
  });
}

interface TurnEditOperation {
  readonly paths: readonly string[];
  readonly native?: AntigravityFileEdit;
  readonly stepIndex: number;
  readonly patch?: ChatPatchGroupItem;
  readonly incomplete: boolean;
}

function getTurnEditOperation(operation: ToolOperation, args: Readonly<Record<string, unknown>> | undefined,
  patch: ChatPatchGroupItem | undefined, native: AntigravityFileEdit | undefined): TurnEditOperation | undefined {
  const { result } = operation;
  if (operation.call.name !== "edit_file" && operation.call.name !== "write_file") return undefined;
  if (!operation.duplicate && result && [4, 5, 6, 7, 12].includes(result.status)) return undefined;
  const matched = !operation.duplicate && result?.status === 3 && result !== operation.step && result.tool?.name === operation.call.name;
  if (!matched) return { paths: [], stepIndex: operation.step.index, incomplete: true };

  const paths = new Set<string>();
  for (const entry of patch?.entries ?? []) {
    const file = normalizeAntigravityEditPath(entry.path);
    if (file) paths.add(file);
  }
  const requested = argument(args, "Path");
  const requestPath = normalizeAntigravityEditPath(requested);
  const renderFiles = result.generic?.files ?? [];
  const renderPaths = renderFiles.slice(0, 200).map(file => normalizeAntigravityEditPath(antigravityWorkspacePath([file.uri])));
  const incomplete = renderFiles.length > 200 || renderPaths.some(file => file === undefined || !paths.has(file))
    || requested !== undefined && !requestPath || (patch?.entries.length ?? 0) > 0 && paths.size === 0;
  if (native && !incomplete && (!requestPath || requestPath === native.path)
    && (!paths.size || paths.size === 1 && paths.has(native.path)) && renderPaths.every(file => file === native.path)) {
    paths.add(native.path);
    return { paths: [...paths], native, stepIndex: result.index, patch, incomplete: false };
  }
  return { paths: [...paths], stepIndex: result.index, patch, incomplete: incomplete || paths.size === 0 || !!native };
}

function buildTurnFileChanges(turn: NativeTurn, operations: readonly TurnEditOperation[], itemIndices: ReadonlyMap<ChatTimelineItem, number>,
  afterItemIndex: number, countIncomplete: boolean, budget: { bytes: number; rows: number; files: number; cards: number; pathBytes: number }): ChatAntigravityTurnFileChanges | undefined {
  if (budget.cards <= 0) return undefined;
  const paths = new Map<string, { edits: AntigravityFileEdit[]; incomplete: boolean }>();
  const editItemIndices: number[] = [];
  let pathBytes = 0;
  for (const operation of [...operations].sort((a, b) => a.stepIndex - b.stepIndex)) {
    countIncomplete ||= operation.incomplete;
    for (const file of operation.paths) {
      let record = paths.get(file);
      if (!record) {
        pathBytes += Buffer.byteLength(file, "utf8");
        if (paths.size >= Math.min(200, budget.files) || pathBytes > budget.pathBytes) return undefined;
        record = { edits: [], incomplete: false };
        paths.set(file, record);
      }
      if (operation.native) record.edits.push(operation.native);
      else record.incomplete = true;
    }
    const index = operation.patch && itemIndices.get(operation.patch);
    if (!operation.incomplete && index !== undefined) editItemIndices.push(index);
  }
  if (!paths.size) return undefined;
  budget.files -= paths.size; budget.cards--; budget.pathBytes -= pathBytes;
  const files: ChatAntigravityTurnFileDiff[] = [];
  let totalsKnown = !countIncomplete, added = 0, removed = 0;
  for (const [file, record] of paths) {
    const text = !record.incomplete && composeAntigravityEditText(record.edits);
    if (!text) {
      files.push({ path: file });
      totalsKnown = false;
      continue;
    }
    const diff = compareAntigravityTurnText(text.before, text.after, budget);
    files.push({ path: file, ...diff });
    added += diff.stats?.added ?? 0; removed += diff.stats?.removed ?? 0;
  }
  return { id: turn.summary.id, afterItemIndex, editItemIndices, files, countIncomplete, running: turn.active && !turn.terminal,
    ...(totalsKnown ? { stats: { added, removed } } : {}) };
}

function usageStepIndices(data: AntigravitySessionData, issues: Set<AntigravityIssue>): Set<number> {
  const retained = new Set<number>();
  interface Unit { parent?: Unit; rank: number; index: number; ambiguous: boolean }
  const units = new Map<string, Unit>();
  const rootOf = (unit: Unit): Unit => {
    let root = unit;
    while (root.parent) root = root.parent;
    while (unit.parent) { const parent = unit.parent; unit.parent = root; unit = parent; }
    return root;
  };
  for (const step of data.steps) {
    const usage = step.usage; if (!usage) continue;
    const aliases = [usage.messageId ? JSON.stringify([step.executionId, usage.providerNumber, "message", usage.messageId]) : undefined,
      usage.responseId ? JSON.stringify([step.executionId, usage.providerNumber, "response", usage.responseId]) : undefined].filter((value): value is string => value !== undefined);
    if (aliases.length === 0) { retained.add(step.index); continue; }
    const existing = [...new Set(aliases.map(alias => units.get(alias)).filter((value): value is Unit => value !== undefined).map(rootOf))];
    let unit = existing[0] ?? { rank: 0, index: step.index, ambiguous: false };
    if (existing.length > 1) {
      // A contradictory join taints the entire connected component, including earlier rows.
      let other = existing[1]!;
      if (unit.rank < other.rank) [unit, other] = [other, unit];
      other.parent = unit;
      if (unit.rank === other.rank) unit.rank++;
      unit.ambiguous = true;
      issues.add("unknownUsage");
    }
    unit.index = step.index;
    for (const alias of aliases) units.set(alias, unit);
  }
  for (const unit of units.values()) { const root = rootOf(unit); if (!root.ambiguous) retained.add(root.index); }
  return retained;
}

// All consumers use this projection for message numbering, tools, usage and change evidence.
export function projectAntigravityChat(data: AntigravitySessionData, fsPath: string, root: string, options: ChatSessionModelBuildOptions = {}): AntigravityChatProjection {
  const issues = new Set(data.issues), items: ChatTimelineItem[] = [], turns: NativeTurn[] = [];
  const executionTurns = new Map<string, NativeTurn>(), ambiguousExecutions = new Set<string>(), { operations, pairedResults, coverageLimited } = toolOperations(data, issues);
  const evidence = createChatSourceActivityEvidence(), usageSteps = usageStepIndices(data, issues);
  const patchBudget = { rows: 200000, entries: 100000, recoveredRows: 2000, recoveredEntries: 1000 };
  const showTurnChanges = options.includeAntigravityTurnFileChanges === true;
  const nativeEdits = showTurnChanges ? new Map(data.fileEdits?.map(row => [row.stepIndex, row.edit])) : undefined;
  const unavailableEdits = showTurnChanges ? new Set(data.unavailableFileEditSteps) : undefined;
  const editOperations = new Map<NativeTurn, TurnEditOperation[]>(), uncertainTurns = new Set<NativeTurn>();
  let missingEditCoverage = data.fileEditScanIncomplete === true || coverageLimited;
  const markIncomplete = (turn?: NativeTurn): void => {
    if (turn) uncertainTurns.add(turn);
    else missingEditCoverage = true;
  };
  const showTurns = options.turnTimelineMode !== undefined && options.turnTimelineMode !== "off";
  const hasExecutions = data.steps.some(step => Boolean(step.executionId));
  let current: NativeTurn | undefined, messageIndex = 0;
  const nativeKey = (step: AntigravityStep, kind: string): string => antigravityNativeKey(data.metadata.conversationId, data.metadata.trajectoryId, step.index, kind);
  const add = (item: ChatTimelineItem, step: AntigravityStep, kind: Parameters<typeof setAntigravityTargetFingerprint>[1], key: string, semantic: unknown, turn?: NativeTurn, partial = false): void => {
    if (showTurns && turn && item.type !== "note") (item as { turnId?: string }).turnId = turn.summary.id;
    setAntigravityTargetFingerprint(item, kind, key, semantic, partial || step.issues.length > 0);
    items.push(item); turn?.items.push(item);
  };
  for (const step of data.steps) {
    const timestamp = step.createdAtIso ?? step.startedAtIso;
    evidence.lastValidRecordLineIndex = step.index + 1; evidence.lastValidRecordOrdinal = step.index;
    evidence.lastValidRecordTimestampIso = step.completedAtIso ?? timestamp;
    if (evidence.lastValidRecordTimestampIso) evidence.latestValidTopLevelTimestampIso = evidence.lastValidRecordTimestampIso;
    if (step.input && !step.input.queued && (step.input.text || step.input.attachments.length)) {
      const summary: ChatTurnSummary = { id: `ag-turn-${nativeKey(step, "turn").slice(0, 32)}`, sequenceNumber: turns.length + 1, status: "incomplete",
        startedAtIso: timestamp, itemCount: 0, messageCount: 0, toolCount: 0, patchGroupCount: 0, patchEntryCount: 0, usageRecordCount: 0,
        inputTokens: 0, outputTokens: 0, totalTokens: 0, systemEventCount: 0 };
      current = { summary, executionId: step.executionId, items: [], active: false, terminal: false }; turns.push(current);
      if (step.executionId) {
        if (executionTurns.has(step.executionId) || ambiguousExecutions.has(step.executionId)) {
          issues.add("invalidStep"); executionTurns.delete(step.executionId); ambiguousExecutions.add(step.executionId);
        } else executionTurns.set(step.executionId, current);
      }
    }
    const turn = step.input && !step.input.queued ? current : step.executionId ? executionTurns.get(step.executionId) : !hasExecutions ? current : current?.executionId ? undefined : current;
    if (!turn && (step.planner || step.generic) && hasExecutions) issues.add("invalidStep");
    if (showTurnChanges && step.type === 132 && (!step.generic || step.status === 3 && !pairedResults.has(step.index)
      && (step.generic.files.length > 0 || nativeEdits?.has(step.index) || unavailableEdits?.has(step.index)))) markIncomplete(turn);
    if (turn) {
      const activity = step.completedAtIso ?? timestamp;
      if (activity && (!turn.latestActivity || Date.parse(activity) >= Date.parse(turn.latestActivity))) turn.latestActivity = activity;
      turn.summary.updatedAtIso = turn.latestActivity;
      if (!turn.terminal && (step.input || step.planner || step.generic) && !step.issues.includes("jsonlFallback")) {
        turn.active = [1, 2, 8, 9, 11].includes(step.status);
        turn.summary.runningActivityAtIso = turn.active ? activity : undefined;
      }
      if (step.input || step.planner) {
        if ([6, 12].includes(step.status) || step.planner?.stopReason === 16) {
          turn.summary.status = "interrupted"; turn.summary.completedAtIso = step.completedAtIso; turn.terminal = true; turn.active = false;
          turn.summary.runningActivityAtIso = undefined;
        } else if (step.planner?.text && step.planner.tools.length === 0 && step.planner.stopReason === 2 && step.status === 3 && !turn.terminal) {
          turn.summary.status = "completed"; turn.summary.completedAtIso = step.completedAtIso; turn.terminal = true; turn.active = false;
          turn.summary.runningActivityAtIso = undefined;
        } else if (step.planner?.stopReason !== undefined && ![0, 1, 2, 10].includes(step.planner.stopReason) && !turn.terminal) turn.summary.status = "unknown";
      }
    }
    if (step.input) {
      if (step.input.queued) {
        const key = nativeKey(step, "queuedInput");
        add({ type: "antigravityProgress", source: "antigravity", kind: "queuedInput", progressId: `ag-${key.slice(0, 32)}`, body: step.input.text, timestampIso: timestamp }, step, "note", key, ["queuedInput", step.input.text, step.input.attachments], turn);
      } else if (step.input.text || step.input.attachments.length) {
        const attachments = step.input.attachments.map((value, position) => attachment(value, options, nativeKey(step, `attachment:${position}`)));
        const item: ChatMessageItem = { type: "message", role: "user", messageIndex: ++messageIndex, timestampIso: timestamp, text: step.input.text, attachments, isContext: false };
        add(item, step, "message", nativeKey(step, "user"), [step.input.text, step.input.attachments], turn);
      }
    }
    if (step.planner) {
      const planner = step.planner;
      if (planner.thinking || planner.redactedThinking || planner.thinkingDurationMs !== undefined) {
        const kind = planner.redactedThinking ? "redactedThinking" : "thinking", key = nativeKey(step, kind);
        add({ type: "antigravityProgress", source: "antigravity", kind, progressId: `ag-${key.slice(0, 32)}`, body: planner.thinking ?? "", durationMs: planner.thinkingDurationMs, timestampIso: timestamp }, step, "note", key, [kind, planner.thinking ?? ""], turn);
      }
      if (planner.text) add({ type: "message", role: "assistant", messageIndex: ++messageIndex, timestampIso: timestamp, text: planner.text, model: step.usage?.model, isContext: false }, step, "message", nativeKey(step, "assistant"), planner.text, turn);
    }
    for (const [position, call] of (step.fallbackTools ?? []).entries()) {
      if (showTurnChanges && (call.name === "edit_file" || call.name === "write_file")) markIncomplete(turn);
      add({ type: "tool", messageIndex, name: call.name, argumentsText: call.argumentsJson, timestampIso: timestamp }, step, "tool", nativeKey(step, `fallbackTool:${position}`), [call.name, call.argumentsJson], turn, true);
    }
    if (step.fallbackInput) add({ type: "note", title: t("antigravity.input.unattributed"), text: step.fallbackInput, timestampIso: timestamp, alwaysVisible: true }, step, "note", nativeKey(step, "fallbackInput"), step.fallbackInput, undefined, true);
    const unpairedOutput = step.fallbackOutput ?? (step.generic && !step.tool && !pairedResults.has(step.index) ? step.generic.output : undefined);
    if (unpairedOutput) add({ type: "tool", messageIndex, name: t("antigravity.tool.unidentified"), outputText: unpairedOutput, timestampIso: timestamp }, step, "tool", nativeKey(step, "unidentifiedOutput"), unpairedOutput, turn, true);
    for (const operation of operations.get(step.index) ?? []) {
      const args = antigravityToolArguments(operation.call), key = nativeKey(step, `tool:${operation.position}:${operation.call.id}`);
      const file = argument(args, "Path"), command = argument(args, "CommandLine");
      const kind = operation.call.name === "run_command" ? "exec" : operation.call.name === "read_file" ? "read" : operation.call.name === "write_file" ? "write" : operation.call.name === "edit_file" ? "edit" : "unknown";
      const item: ChatToolItem = { type: "tool", messageIndex, name: operation.call.name, callId: operation.call.id, timestampIso: timestamp,
        argumentsText: operation.call.argumentsJson, outputText: operation.result?.generic?.output,
        execution: operation.result ? { status: operation.result.status === 3 ? "completed" : operation.result.status === 7 ? "error" : "unknown" } : undefined,
        presentation: { toolKind: kind, primaryText: command ?? file ?? operation.call.name, relatedFilePath: file, messageIndex } };
      add(item, step, "tool", key, [item.name, item.argumentsText, item.outputText, operation.result?.status], turn, operation.duplicate || !operation.result);
      const patches = projectPatches(operation, args, key, options.includeDetails !== false, patchBudget, issues);
      let patchGroup: ChatPatchGroupItem | undefined;
      if (patches.length) {
        const entries = patches.map(patch => patch.entry);
        const group: ChatPatchGroupItem = patchGroup = { type: "patchGroup", messageIndex, timestampIso: operation.result?.completedAtIso ?? timestamp,
          incomplete: true, bookmarkGroupId: `ag-patch-${key.slice(0, 32)}`, entryCount: entries.length,
          totalAdded: entries.reduce((sum, entry) => sum + entry.added, 0), totalRemoved: entries.reduce((sum, entry) => sum + entry.removed, 0), entries };
        group.statsAvailability = { added: entries.every(entry => entry.statsAvailability?.added), removed: entries.every(entry => entry.statsAvailability?.removed) };
        // Retain bookmark fingerprints saved before the display counts distinguished omitted scalars from missing statistics.
        const legacyFiles = operation.result?.generic?.files.map(({ hasDiffStats: _hasDiffStats, ...file }) => file);
        const legacyPatches = patches.filter(patch => patch.inLegacyGroup);
        const bookmarkPatches = legacyPatches.length ? legacyPatches : patches;
        add(group, step, "patchGroup", nativeKey(step, `patch:${operation.position}:${operation.call.id}`),
          [bookmarkPatches.map(({ entry, legacyCounts }) => [entry.path, entry.changeType, ...legacyCounts]),
            argument(args, "Target"), argument(args, "Replacement"), legacyFiles], turn, true);
      }
      if (showTurnChanges) {
        const native = operation.result && nativeEdits?.get(operation.result.index);
        const edit = getTurnEditOperation(operation, args, patchGroup, native);
        if (edit && turn) {
          const edits = editOperations.get(turn);
          if (edits) edits.push(edit);
          else editOperations.set(turn, [edit]);
        } else if (edit || native || operation.result && unavailableEdits?.has(operation.result.index)) markIncomplete(turn);
      }
    }
    if (step.usage && usageSteps.has(step.index)) {
      const usage = step.usage;
      const item: ChatUsageItem = { type: "usage", messageIndex, timestampIso: timestamp, model: usage.model ?? (usage.modelNumber !== undefined ? `#${usage.modelNumber}` : undefined),
        usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadInputTokens: usage.cacheReadTokens, cacheCreationInputTokens: usage.cacheWriteTokens, reasoningOutputTokens: usage.thinkingOutputTokens } };
      // Keep native per-record fields. The turn summary derives a lower bound from input and output.
      add(item, step, "usage", nativeKey(step, "usage"), [usage.model, usage.modelNumber, usage.providerNumber, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.thinkingOutputTokens, usage.responseOutputTokens], turn);
    }
  }
  if (issues.size) {
    const item: ChatTimelineItem = { type: "note", noticeKind: "antigravityPartial", alwaysVisible: true,
      title: t("antigravity.history.partialTitle"), text: t("antigravity.history.partial") };
    setAntigravityTargetFingerprint(item, "note", antigravityNativeKey(data.metadata.conversationId, data.metadata.trajectoryId, 0, "quality"), [...issues].sort(), true);
    // Source coverage applies to the session. Place the notice before the turn timeline.
    items.unshift(item);
  }
  const sum = (values: readonly number[]): number => values.reduce((result, value) => Number.isSafeInteger(result + value) ? result + value : result, 0);
  const itemIndices = new Map(items.map((item, index) => [item, index]));
  const usagePartial = [...issues].some(issue => ["unknownStep", "invalidStep", "unknownPayload", "unknownUsage", "truncated", "jsonlFallback"].includes(issue))
    || data.steps.some(step => step.issues.some(issue => ["unknownStep", "invalidStep", "unknownPayload", "unknownUsage", "truncated", "jsonlFallback"].includes(issue)));
  const summaries: ChatAntigravityTurnFileChanges[] = [];
  const turnDiffBudget = { bytes: 2 * 1024 * 1024, rows: 20000, files: 4000, cards: 1000, pathBytes: 1024 * 1024 };
  for (const [turnIndex, turn] of turns.entries()) {
    const summary = turn.summary, indices = turn.items.map(item => itemIndices.get(item)).filter((index): index is number => index !== undefined);
    const messages = turn.items.filter((item): item is ChatMessageItem => item.type === "message"), usage = turn.items.filter((item): item is ChatUsageItem => item.type === "usage");
    summary.itemCount = indices.length; summary.firstItemIndex = indices[0]; summary.lastItemIndex = indices.at(-1);
    summary.messageCount = messages.length; summary.firstMessageIndex = messages[0]?.messageIndex; summary.lastMessageIndex = messages.at(-1)?.messageIndex;
    summary.toolCount = turn.items.filter(item => item.type === "tool").length;
    const groups = turn.items.filter((item): item is ChatPatchGroupItem => item.type === "patchGroup"); summary.patchGroupCount = groups.length; summary.patchEntryCount = sum(groups.map(group => group.entryCount));
    summary.usageRecordCount = usage.length; summary.inputTokens = sum(usage.map(item => item.usage.inputTokens ?? 0)); summary.outputTokens = sum(usage.map(item => item.usage.outputTokens ?? 0));
    const tokenAvailability = (key: "inputTokens" | "outputTokens"): "available" | "partial" | "unavailable" => {
      const present = usage.filter(item => item.usage[key] !== undefined);
      let accumulated = 0;
      for (const record of present) { accumulated += record.usage[key]!; if (!Number.isSafeInteger(accumulated)) return "unavailable"; }
      return !present.length ? "unavailable" : !usagePartial && present.length === usage.length ? "available" : "partial";
    };
    const inputAvailability = tokenAvailability("inputTokens");
    const outputAvailability = tokenAvailability("outputTokens");
    const total = summary.inputTokens + summary.outputTokens;
    const totalAvailability = inputAvailability !== "unavailable" && outputAvailability !== "unavailable" && Number.isSafeInteger(total)
      ? "partial" : "unavailable";
    if (totalAvailability === "partial") summary.totalTokens = total;
    summary.tokenAvailability = { inputTokens: inputAvailability, outputTokens: outputAvailability, totalTokens: totalAvailability };
    const edits = editOperations.get(turn);
    if (edits && (!turn.executionId || !ambiguousExecutions.has(turn.executionId))) {
      const nextStart = turns[turnIndex + 1]?.items[0];
      const startNext = (nextStart && itemIndices.get(nextStart)) ?? items.length;
      let anchor: number | undefined;
      for (let index = indices.length - 1; index >= 0; index--) {
        if (indices[index]! < startNext) { anchor = indices[index]; break; }
      }
      if (anchor !== undefined) {
        const changes = buildTurnFileChanges(turn, edits, itemIndices, anchor, missingEditCoverage || uncertainTurns.has(turn), turnDiffBudget);
        if (changes) {
          summaries.push(changes);
          summary.antigravityChangedFiles = { count: changes.files.length, incomplete: changes.countIncomplete };
        }
      }
    }
    const live = options.turnTimelineMode === "live" && turn === turns.at(-1) && !turn.terminal && turn.active && summary.runningActivityAtIso && isLiveActivityFresh(Date.parse(summary.runningActivityAtIso), Date.now(), LIVE_RUNNING_STALE_MS);
    if (live) summary.displayStatus = "running";
  }
  const cwd = antigravityWorkspacePath(data.metadata.workspaceUris);
  const model: ChatSessionModel = { fsPath, identityKey: antigravitySessionIdentity(root, data.metadata.conversationId), meta: { historySource: "antigravity", id: data.metadata.conversationId, timestampIso: data.metadata.createdAtIso, cwd },
    sessionLocation: { rootKind: "antigravitySessions", archiveState: "active" }, items,
    ...(summaries.length ? { antigravityTurnFileChanges: summaries } : {}),
    turns: showTurns ? turns.map(turn => turn.summary) : undefined,
    activeTurnId: showTurns && turns.at(-1) && !turns.at(-1)!.terminal ? turns.at(-1)!.summary.id : undefined,
    latestTurnId: showTurns ? turns.at(-1)?.summary.id : undefined };
  return { model, activityEvidence: evidence, digest: data.digest, issues: [...issues], usagePartial };
}

export async function buildAntigravityChatModel(fsPath: string, options: ChatSessionModelBuildOptions = {}): Promise<AntigravityChatProjection> {
  await antigravityReader.ready();
  const locator = antigravityReader.locator(fsPath), data = await antigravityReader.readSession(
    fsPath, options.foregroundAntigravityRead, options.includeAntigravityTurnFileChanges === true, Boolean(options.foregroundAntigravityRead),
  );
  return projectAntigravityChat(data, fsPath, locator.rootPath, options);
}
