import { t } from "../i18n";

export type ClaudeAdvisorStatus = "called" | "reviewed" | "redacted" | "declined" | "unavailable";

interface ClaudeAdvisorEvent {
  blockIndex: number;
  status: ClaudeAdvisorStatus;
  text?: string;
  truncated?: true;
}

const ADVISOR_TOOL_ID = /^srvtoolu_[a-zA-Z0-9_-]{1,128}$/u;
const MAX_ADVICE_CHARS = 16_384;
const MAX_RECORD_ADVICE_CHARS = 65_536;

export function isClaudeAdvisorBlock(block: Record<string, unknown>): boolean {
  return block.type === "advisor_tool_result" || (block.type === "server_tool_use" && block.name === "advisor");
}

export function readClaudeAdvisorEvents(record: unknown): ClaudeAdvisorEvent[] {
  if (!isRecord(record) || record.type !== "assistant" || !isRecord(record.message)) return [];
  const { role, content } = record.message;
  if ((role !== undefined && role !== "assistant") || !Array.isArray(content)) return [];

  const events: ClaudeAdvisorEvent[] = [];
  let remaining = MAX_RECORD_ADVICE_CHARS;
  for (const [blockIndex, block] of content.entries()) {
    if (!isRecord(block) || !isClaudeAdvisorBlock(block)) continue;
    if (block.type === "server_tool_use") {
      if (isAdvisorToolId(block.id)) events.push({ blockIndex, status: "called" });
      continue;
    }
    if (!isAdvisorToolId(block.tool_use_id) || !isRecord(block.content)) continue;
    const result = block.content;
    if (result.type === "advisor_tool_result_error") {
      events.push({ blockIndex, status: "unavailable" });
      continue;
    }
    if (result.type !== "advisor_result" && result.type !== "advisor_redacted_result") continue;
    if (result.stop_reason === "refusal") {
      events.push({ blockIndex, status: "declined" });
      continue;
    }
    if (result.type === "advisor_redacted_result") {
      events.push({ blockIndex, status: "redacted" });
      continue;
    }
    const raw = result.text;
    if (typeof raw !== "string") {
      events.push({ blockIndex, status: "reviewed" });
      continue;
    }
    // Keep a single source-row budget and never return encrypted content or raw errors.
    const limit = Math.min(MAX_ADVICE_CHARS, remaining);
    const truncated = raw.length > limit;
    let text = raw.slice(0, limit);
    if (truncated && /[\ud800-\udbff]$/u.test(text)) text = text.slice(0, -1);
    remaining -= text.length;
    text = text.replace(/\r\n?/gu, "\n").trim();
    events.push({ blockIndex, status: "reviewed", ...(text ? { text } : {}), ...(truncated ? { truncated: true } : {}) });
  }
  return events;
}

export function getClaudeAdvisorStatusLabel(status: ClaudeAdvisorStatus): string {
  switch (status) {
    case "called": return t("chat.claudeAdvisor.called");
    case "reviewed": return t("chat.claudeAdvisor.reviewed");
    case "redacted": return t("chat.claudeAdvisor.redacted");
    case "declined": return t("chat.claudeAdvisor.declined");
    case "unavailable": return t("chat.claudeAdvisor.unavailable");
  }
}

function isAdvisorToolId(value: unknown): value is string {
  return typeof value === "string" && ADVISOR_TOOL_ID.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
