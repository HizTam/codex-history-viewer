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

const COMPANION_PAGE_OUTPUT_ID_PATTERN = /^fco_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const COMPANION_PAGE_PART_PATTERN = /^codex_apps_selected_page_part_([1-9][0-9]{0,14})_of_([1-9][0-9]{0,14})$/u;
const COMPANION_PAGE_FRAGMENT_BYTES = 3_500;
const COMPANION_PAGE_OPEN_LIMIT = 1_024;
const COMPANION_PAGE_INSTRUCTIONS_LIMIT = 16_384;

// Additional context in paginated rollouts is distinct from similarly named tool calls.
export function isCodexCompanionPageRecord(value: unknown): boolean {
  if (!isRecord(value) || value.type !== "response_item" || !isRecord(value.payload)) return false;
  const payload = value.payload;
  if (payload.type === "function_call_output") {
    const name = payload.name;
    if (typeof name !== "string" || (name !== "codex_apps_open_page" && !name.startsWith("codex_apps_selected_page_part_"))) {
      return false;
    }
    if (!isRecord(value.metadata) || value.metadata.additional_context_tool_output !== true ||
      payload.namespace !== "agent" || typeof payload.id !== "string" || !COMPANION_PAGE_OUTPUT_ID_PATTERN.test(payload.id) ||
      (payload.call_id !== undefined && payload.call_id !== null) || typeof payload.output !== "string") {
      return false;
    }
    const meta = payload.internal_chat_message_metadata_passthrough;
    if (!isRecord(meta) || !normalizeCodexCorrelationId(meta.turn_id) ||
      typeof meta.create_time !== "number" || !Number.isFinite(meta.create_time) || meta.create_time <= 0) {
      return false;
    }
    if (name === "codex_apps_open_page") return isCodexOpenPageSnapshot(payload.output);
    const match = COMPANION_PAGE_PART_PATTERN.exec(name);
    if (!match || Number(match[1]) > Number(match[2])) return false;
    const prefix = `Companion Page snapshot part ${match[1]} of ${match[2]}:\n`;
    const output = payload.output;
    return output.length > prefix.length && output.length <= prefix.length + COMPANION_PAGE_FRAGMENT_BYTES &&
      output.startsWith(prefix) && Buffer.byteLength(output.slice(prefix.length), "utf8") <= COMPANION_PAGE_FRAGMENT_BYTES;
  }
  if (payload.type !== "message" || payload.role !== "developer" ||
    !isRecord(value.metadata) || value.metadata.client_authored !== false) return false;
  const meta = payload.internal_chat_message_metadata_passthrough;
  if (!isRecord(meta) || !Array.isArray(meta.content_item_kinds) || meta.content_item_kinds.length !== 1 ||
    !Array.isArray(meta.content_item_metadata) || meta.content_item_metadata.length !== 1 ||
    !Array.isArray(payload.content) || payload.content.length !== 1) return false;

  const kind = meta.content_item_kinds[0];
  const tag = kind === "additional_content.codex_apps_open_page_instructions" ? "codex_apps_open_page_instructions"
    : kind === "additional_content.codex_apps_selected_page_instructions" ? "codex_apps_selected_page_instructions"
      : undefined;
  const block = payload.content[0];
  const origin = meta.content_item_metadata[0]?.provenance;
  return tag !== undefined && isRecord(origin) && origin.type === "harness" && origin.hook === false &&
    isRecord(block) && block.type === "input_text" && typeof block.text === "string" &&
    block.text.length <= COMPANION_PAGE_INSTRUCTIONS_LIMIT &&
    block.text.startsWith(`<${tag}>`) && block.text.endsWith(`</${tag}>`);
}

function isCodexOpenPageSnapshot(text: string): boolean {
  if (text.length > COMPANION_PAGE_OPEN_LIMIT) return false;
  try {
    const snapshot: unknown = JSON.parse(text);
    if (!isRecord(snapshot) || !Object.hasOwn(snapshot, "page_id") || Object.keys(snapshot).length !== 1) return false;
    const id: unknown = snapshot.page_id;
    return id === null || (typeof id === "string" && id.length > 0 && id.length <= 256 && !/\s/u.test(id) && !CONTROL_CHARACTERS.test(id));
  } catch {
    return false;
  }
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
