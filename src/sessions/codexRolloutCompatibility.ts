import type { CodexAsyncQuestionDefinition } from "./codexQuestionReplies";
import { projectCodexFollowupText } from "./codexFollowup";

export type CodexRolloutRecordKind =
  | "session_meta"
  | "response_item"
  | "inter_agent_communication"
  | "inter_agent_communication_metadata"
  | "compacted"
  | "turn_context"
  | "token_usage_record"
  | "world_state"
  | "security_risk_score"
  | "event_msg"
  | "realtime_item";

export type CodexControlToolKind = "asyncQuestion" | "newContext";

export type CodexContextManagementKind =
  | "contextCompactedEvent"
  | "contextCompactionItem";

export interface CodexAsyncQuestionMessage {
  readonly itemId: string;
  readonly text: string;
  readonly turnId?: string;
  readonly questions?: readonly CodexAsyncQuestionDefinition[];
}

export interface CodexTokenUsageRecord {
  readonly threadId: string;
  readonly turnId: string;
  readonly sessionId: string;
  readonly rootTurnId: string;
  readonly responseId: string;
  readonly usage: Readonly<Record<string, unknown>>;
  readonly turnTokenUsage: Readonly<Record<string, unknown>>;
  readonly threadTokenUsage: Readonly<Record<string, unknown>>;
}

const MAX_CORRELATION_ID_LENGTH = 1_024;
const MAX_ASYNC_QUESTION_COUNT = 32;
const MAX_ASYNC_OPTION_COUNT = 64;
const MAX_ASYNC_PART_LENGTH = 16_384;
const MAX_ASYNC_TOTAL_LENGTH = 262_144;
const MAX_ASYNC_CONTENT_ITEM_COUNT = 64;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

// Recognizes only rollout variants declared by the Codex 0.153 history wire format.
export function readCodexRolloutRecordKind(value: unknown): CodexRolloutRecordKind | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.type) {
    case "session_meta":
    case "response_item":
    case "inter_agent_communication":
    case "inter_agent_communication_metadata":
    case "compacted":
    case "turn_context":
    case "token_usage_record":
    case "world_state":
    case "security_risk_score":
    case "event_msg":
    case "realtime_item":
      return value.type;
    default:
      return undefined;
  }
}

export function readCodexControlToolKind(value: unknown): CodexControlToolKind | undefined {
  if (!isRecord(value) || value.type !== "response_item" || !isRecord(value.payload)) return undefined;
  const payloadType = value.payload.type;
  if (payloadType !== "function_call" && payloadType !== "custom_tool_call") return undefined;
  if (value.payload.name === "request_user_input_async") return "asyncQuestion";
  if (value.payload.name === "new_context") return "newContext";
  return undefined;
}

export function readCodexContextManagementKind(
  value: unknown,
): CodexContextManagementKind | undefined {
  if (!isRecord(value) || value.type !== "event_msg" || !isRecord(value.payload)) return undefined;
  if (value.payload.type === "context_compacted") return "contextCompactedEvent";
  if (
    value.payload.type === "item_completed" &&
    isRecord(value.payload.item) &&
    value.payload.item.type === "ContextCompaction"
  ) {
    return "contextCompactionItem";
  }
  return undefined;
}

// Projects the completed async question item into the existing assistant-message contract.
export function readCodexAsyncQuestionMessage(value: unknown): CodexAsyncQuestionMessage | undefined {
  if (!isRecord(value) || value.type !== "event_msg" || !isRecord(value.payload)) return undefined;
  if (value.payload.type !== "item_completed" || !isRecord(value.payload.item)) return undefined;
  const item = value.payload.item;
  if (
    item.type !== "AgentMessage" ||
    item.phase !== "final_answer" ||
    item.delivery !== "async"
  ) {
    return undefined;
  }

  const itemId = normalizeCodexCorrelationId(item.id);
  if (!itemId) return undefined;
  const questionLength = measureAsyncQuestions(item.questions);
  if (questionLength === undefined) return undefined;
  const content = readAsyncQuestionContent(item.content);
  if (!content || content.length + questionLength > MAX_ASYNC_TOTAL_LENGTH) return undefined;

  const turnId = normalizeCodexCorrelationId(value.payload.turn_id ?? value.payload.turnId);
  return {
    itemId,
    text: projectCodexFollowupText(content),
    ...(turnId ? { turnId } : {}),
    ...(Array.isArray(item.questions) && item.questions.length > 0 ? {
      questions: item.questions.map((question: CodexAsyncQuestionDefinition) => ({
        title: question.title,
        ...(question.options ? { options: [...question.options] } : {}),
      })),
    } : {}),
  };
}

export function readCodexTokenUsageRecord(value: unknown): CodexTokenUsageRecord | undefined {
  if (!isRecord(value) || value.type !== "token_usage_record") return undefined;
  return readTokenUsagePayload(value.payload);
}

export function readCodexCompactedTokenUsageRecord(value: unknown): CodexTokenUsageRecord | undefined {
  if (!isRecord(value) || value.type !== "compacted" || !isRecord(value.payload)) return undefined;
  return readTokenUsagePayload(value.payload.latest_token_usage_record);
}

export function normalizeCodexCorrelationId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > MAX_CORRELATION_ID_LENGTH ||
    CONTROL_CHARACTERS.test(trimmed)
  ) {
    return undefined;
  }
  return trimmed;
}

function readTokenUsagePayload(value: unknown): CodexTokenUsageRecord | undefined {
  if (!isRecord(value)) return undefined;
  const threadId = normalizeCodexCorrelationId(value.thread_id);
  const turnId = normalizeCodexCorrelationId(value.turn_id);
  const sessionId = normalizeCodexCorrelationId(value.session_id);
  const rootTurnId = normalizeCodexCorrelationId(value.root_turn_id);
  const responseId = normalizeCodexCorrelationId(value.response_id);
  if (!threadId || !turnId || !sessionId || !rootTurnId || !responseId) return undefined;
  if (!isRecord(value.usage) || !isRecord(value.turn_token_usage) || !isRecord(value.thread_token_usage)) {
    return undefined;
  }
  return {
    threadId,
    turnId,
    sessionId,
    rootTurnId,
    responseId,
    usage: value.usage,
    turnTokenUsage: value.turn_token_usage,
    threadTokenUsage: value.thread_token_usage,
  };
}

function measureAsyncQuestions(value: unknown): number | undefined {
  if (value === undefined || value === null) return 0;
  if (!Array.isArray(value) || value.length > MAX_ASYNC_QUESTION_COUNT) {
    return undefined;
  }
  let totalLength = 0;
  for (const question of value) {
    if (!isRecord(question) || !isNonEmptyBoundedText(question.title)) return undefined;
    totalLength += question.title.length;
    if (totalLength > MAX_ASYNC_TOTAL_LENGTH) return undefined;
    const options = question.options;
    if (options === undefined || options === null) continue;
    if (!Array.isArray(options) || options.length < 1 || options.length > MAX_ASYNC_OPTION_COUNT) {
      return undefined;
    }
    for (const option of options) {
      if (!isNonEmptyBoundedText(option)) return undefined;
      totalLength += option.length;
      if (totalLength > MAX_ASYNC_TOTAL_LENGTH) return undefined;
    }
  }
  return totalLength;
}

function readAsyncQuestionContent(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ASYNC_CONTENT_ITEM_COUNT) {
    return undefined;
  }
  const parts: string[] = [];
  let totalLength = 0;
  for (const content of value) {
    if (!isRecord(content) || content.type !== "Text" || typeof content.text !== "string") {
      return undefined;
    }
    totalLength += content.text.length;
    if (totalLength > MAX_ASYNC_TOTAL_LENGTH) return undefined;
    parts.push(content.text);
  }
  const text = parts.join("");
  return text.trim() ? text : undefined;
}

function isNonEmptyBoundedText(value: unknown): value is string {
  return typeof value === "string" &&
    value.length <= MAX_ASYNC_PART_LENGTH &&
    value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
