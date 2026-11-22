import { antigravityReader } from "../antigravity/antigravityReader";
import { createHash } from "node:crypto";
import { projectAntigravityChat } from "../antigravity/antigravityChatModel";
import { AntigravityReadError } from "../antigravity/antigravityTypes";
import type { ChatUsageItem } from "../chat/chatTypes";
import type { SessionAnalysisAdapterInput } from "./sessionAnalysisAdapter";
import { SESSION_ANALYSIS_ANTIGRAVITY_PARSER_VERSION, type AnalysisAvailability, type AnalysisNumber, type ModelUsageStats, type SessionAnalysisEntry, type SessionUsageStats } from "./sessionAnalysisTypes";

const unavailable = (): AnalysisNumber => ({ availability: "unavailable" });
function boundedName(value: string, maximum: number): string {
  // A suffix preserves distinct native names even when their display prefixes coincide.
  if (value.length <= maximum) return value;
  let prefix = value.slice(0, maximum - 75);
  if (/[\uD800-\uDBFF]/.test(prefix.at(-1) ?? "")) prefix = prefix.slice(0, -1);
  return `${prefix} [sha256:${createHash("sha256").update(value).digest("hex")}]`;
}
export class AntigravitySessionAnalysisAdapter {
  public async analyze(input: SessionAnalysisAdapterInput): Promise<SessionAnalysisEntry> {
    if (input.session.source !== "antigravity") throw new Error("Antigravity adapter received an incompatible source.");
    const check = (): void => { if (input.token?.isCancellationRequested) throw input.cancellationErrorFactory?.() ?? new AntigravityReadError("cancelled"); };
    check();
    const data = input.antigravityData ?? await antigravityReader.readSession(input.session.fsPath, input.token);
    check();
    const { model, issues, usagePartial } = projectAntigravityChat(data, input.session.fsPath, input.session.storage.rootPath, { turnTimelineMode: "basic", images: { enabled: false, maxSizeMB: 1, thumbnailSize: "small" } });
    const missingContent = issues.some(issue => ["unknownStep", "invalidStep", "truncated"].includes(issue))
      || data.steps.some(step => step.type === 14 && !step.input || step.type === 15 && !step.planner || step.type === 132 && !step.generic);
    const countsAvailability: AnalysisAvailability = missingContent ? "partial" : "available";
    const tools = model.items.filter(item => item.type === "tool"), calls = tools.filter(item => item.callId || item.argumentsText !== undefined);
    const usage = model.items.filter((item): item is ChatUsageItem => item.type === "usage");
    const warnings = issues.map(issue => `antigravity:${issue}`), count = (value: number): AnalysisNumber => ({ value, availability: countsAvailability });
    const toolCounts = new Map<string, number>();
    for (const tool of calls) {
      const name = boundedName(tool.name, 256); if (toolCounts.size < 2000 || toolCounts.has(name)) toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
      else if (!warnings.includes("toolUsageLimit:2000")) warnings.push("toolUsageLimit:2000");
    }
    const total = (records: readonly ChatUsageItem[], key: keyof ChatUsageItem["usage"]): AnalysisNumber => {
      let sum = 0, present = 0;
      for (const record of records) {
        const value = record.usage[key];
        if (typeof value !== "number") continue;
        if (!Number.isSafeInteger(sum + value)) { if (!warnings.includes("tokenUsageOverflow")) warnings.push("tokenUsageOverflow"); return unavailable(); }
        sum += value; present++;
      }
      return present ? { value: sum, availability: usagePartial || present !== records.length ? "partial" : "available" } : unavailable();
    };
    const byModel = new Map<string, ChatUsageItem[]>();
    for (const record of usage) {
      if (!record.model) continue;
      const name = boundedName(record.model, 512);
      if (byModel.size >= 2000 && !byModel.has(name)) { if (!warnings.includes("modelUsageLimit:2000")) warnings.push("modelUsageLimit:2000"); continue; }
      const values = byModel.get(name) ?? []; values.push(record); byModel.set(name, values);
    }
    const modelUsage: ModelUsageStats[] = [...byModel].map(([name, records]) => {
      const inputTokens = total(records, "inputTokens"), outputTokens = total(records, "outputTokens");
      return { model: name, inputTokens: inputTokens.value ?? 0, outputTokens: outputTokens.value ?? 0, totalTokens: 0,
        availability: { inputTokens: inputTokens.availability, outputTokens: outputTokens.availability, totalTokens: "unavailable" } };
    });
    const usageStats: SessionUsageStats = {
      inputTokens: total(usage, "inputTokens"), outputTokens: total(usage, "outputTokens"), cachedInputTokens: unavailable(),
      cacheReadInputTokens: total(usage, "cacheReadInputTokens"), cacheCreationInputTokens: total(usage, "cacheCreationInputTokens"), reasoningOutputTokens: total(usage, "reasoningOutputTokens"),
      reportedTotalTokens: unavailable(), derivedTotalTokens: unavailable(), modelUsage, modelEffortUsage: [], aggregationMethod: "antigravityMessageSum",
    };
    check();
    const session = input.session;
    return {
      cacheKey: session.cacheKey, identityKey: session.identityKey, fsPath: session.fsPath, source: "antigravity", storage: { ...session.storage },
      projectCwd: model.meta.cwd ?? session.meta.cwd, startedAtIso: data.metadata.createdAtIso ?? session.startedAtIso, lastActivityAtIso: session.lastActivityAtIso,
      mtimeMs: input.mtimeMs, size: input.size, historySignature: `antigravity:${data.digest}`, parserVersion: SESSION_ANALYSIS_ANTIGRAVITY_PARSER_VERSION,
      completeness: issues.length || warnings.length ? "partial" : "complete",
      messageStats: {
        userMessageCount: count(model.items.filter(item => item.type === "message" && item.role === "user").length),
        assistantMessageCount: count(model.items.filter(item => item.type === "message" && item.role === "assistant").length),
        developerMessageCount: unavailable(), toolCallCount: { value: calls.length, availability: issues.some(issue => ["unmatchedTool", "duplicateTool"].includes(issue)) ? "partial" : countsAvailability },
        toolOutputCount: count(tools.filter(item => item.outputText !== undefined).length),
        turnCount: count(model.turns?.length ?? 0), completedTurnCount: count(model.turns?.filter(turn => turn.status === "completed").length ?? 0),
        interruptedTurnCount: count(model.turns?.filter(turn => turn.status === "interrupted").length ?? 0), rolledBackTurnCount: unavailable(),
        toolUsage: [...toolCounts].map(([name, callCount]) => ({ name, callCount })).sort((a, b) => b.callCount - a.callCount || a.name.localeCompare(b.name)),
      },
      usageStats,
      // Initial native support has display/request evidence, never confirmed applied changes.
      fileChangeStats: { changeEventCount: unavailable(), distinctFileCount: unavailable(), linesAdded: unavailable(), linesRemoved: unavailable(), files: [] },
      claudeGraphRecords: [], warnings: warnings.slice(0, 20),
    };
  }
}
