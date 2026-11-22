import { createHash } from "node:crypto";
import { extractCodexMessageContent, hasSuppressedInputAudioImageCandidate } from "../chat/chatAttachments";
import { normalizeMemoryCitationPayload, splitTrailingMemoryCitationBlock } from "../chat/memoryCitation";
import { readCodexAsyncQuestionMessage } from "./codexRolloutCompatibility";

const storedAnswerRestriction = Symbol("storedAnswerRestriction");
type RestrictedAnswer =
  | { kind: "event"; citationHash?: string; asyncQuestion?: { itemId: string; turnId?: string; hadText: boolean; textHash: string } }
  | { kind: "message"; chatIndex: boolean; transcriptIndex: boolean; searchIndex: boolean; textHash: string };
type RecordValue = Record<string, unknown> & { [storedAnswerRestriction]?: RestrictedAnswer };

const MAX_PENDING_ANSWERS = 4_096;
const MAX_RESOLVED_ANSWERS = 16_384;
interface Decision { turn?: string }

export function readCodexAnswerRestriction(value: unknown): RestrictedAnswer | undefined {
  return isRecord(value) ? (value as RecordValue)[storedAnswerRestriction] : undefined;
}

// Each projection is confined to a single logical stream. It never alters saved bytes.
export class CodexAnswerVisibility {
  private first = true;
  private unresolvedPrefix = false;
  private startedWithUnresolvedPrefix = false;
  private turn: string | undefined;
  private overflow = false;
  private readonly pending = new Map<string, Decision>();
  private readonly resolved = new Map<string, Decision>();

  public hadUnresolvedPrefix(): boolean { return this.startedWithUnresolvedPrefix; }

  public project(value: unknown): RecordValue | Promise<RecordValue> | undefined {
    if (!isRecord(value) || !isRecord(value.payload)) return undefined;
    const payload = value.payload;
    if (this.first) {
      this.first = false;
      this.unresolvedPrefix = value.type === "session_meta" && payload.history_mode === "paginated" && isRecord(payload.history_base);
      this.startedWithUnresolvedPrefix = this.unresolvedPrefix;
    }
    if (value.type === "event_msg") {
      if (payload.type === "task_started" || payload.type === "turn_started") {
        const turn = hashId(payload.turn_id);
        if (turn && turn !== this.turn) {
          this.turn = turn;
          this.unresolvedPrefix = false;
          this.pending.clear();
          this.resolved.clear();
          this.overflow = false;
        }
      }
      return this.projectCompletion(value, payload);
    }
    if (value.type !== "response_item" || payload.type !== "message" || payload.role !== "assistant" ||
      payload.phase !== "final_answer") return undefined;
    if (!this.pending.size && !this.resolved.size && !this.overflow && !this.unresolvedPrefix) return undefined;
    const key = hashId(payload.id);
    const metadata = payload.internal_chat_message_metadata_passthrough;
    const turn = hashId(payload.turn_id) ?? (isRecord(metadata) ? hashId(metadata.turn_id) : undefined);
    const pending = matchDecision(this.pending, key, turn);
    const decision = pending ?? matchDecision(this.resolved, key, turn);
    if (!decision && !this.overflow && !this.unresolvedPrefix) return undefined;
    if (pending && key) {
      if (this.resolved.size < MAX_RESOLVED_ANSWERS || this.resolved.has(key)) this.resolved.set(key, pending);
      else this.overflow = true;
      this.pending.delete(key);
    }
    return projectRestrictedMessage(value, payload);
  }

  private projectCompletion(value: RecordValue, payload: RecordValue): RecordValue | undefined {
    const modern = payload.type === "item_completed" && isRecord(payload.item) && payload.item.type === "AgentMessage";
    const answer = modern ? payload.item as RecordValue : payload;
    if ((!modern && payload.type !== "agent_message") || answer.phase !== "final_answer") return undefined;
    const moderation = isRecord(answer.moderation) ? answer.moderation : undefined;
    const restrictNow = moderation && restrictsAnswer(moderation);
    if (!restrictNow && !this.overflow && !this.unresolvedPrefix && !this.pending.size && !this.resolved.size) return undefined;
    const key = hashId(modern ? answer.id : moderation?.item_id);
    if (!key && !this.unresolvedPrefix) return undefined;
    const turn = hashId(payload.turn_id) ?? hashId(payload.turnId) ?? this.turn;
    const alreadyRestricted = matchDecision(this.pending, key, turn) ?? matchDecision(this.resolved, key, turn);
    if (!alreadyRestricted && !this.overflow && !this.unresolvedPrefix && !restrictNow) return undefined;
    if (!alreadyRestricted && key) {
      if (this.pending.size < MAX_PENDING_ANSWERS || this.pending.has(key)) this.pending.set(key, { turn });
      else this.overflow = true;
    }
    const citationHash = !modern && typeof payload.message === "string" && normalizeMemoryCitationPayload(payload.memory_citation)
      ? hashCodexAnswerText(normalizeAnswerText(splitTrailingMemoryCitationBlock(payload.message).text)) : undefined;
    const question = modern ? readCodexAsyncQuestionMessage(value) : undefined;
    const restricted: RestrictedAnswer = { kind: "event", ...(citationHash ? { citationHash } : {}), ...(question ? {
      asyncQuestion: {
        itemId: question.itemId, turnId: question.turnId, hadText: question.text.trim().length > 0,
        textHash: hashCodexAnswerText(normalizeAnswerText(question.text)),
      },
    } : {}) };
    // Discard all display-dependent contents, including generated question choices and citations.
    return modern
      ? { ...value, payload: { ...payload, item: { ...answer, content: [], questions: undefined, memory_citation: undefined } },
        [storedAnswerRestriction]: restricted }
      : { ...value, payload: { ...payload, message: "", questions: undefined, memory_citation: undefined }, [storedAnswerRestriction]: restricted };
  }
}

async function projectRestrictedMessage(value: RecordValue, payload: RecordValue): Promise<RecordValue> {
  const content = payload.content;
  // Protected local paths and media are never loaded while deriving the old anchor decisions.
  const parsed = await extractCodexMessageContent(content, undefined, { enabled: false }, { role: "assistant" });
  const split = splitTrailingMemoryCitationBlock(parsed.text);
  const hasAudio = hasSuppressedInputAudioImageCandidate(content);
  const attachments = parsed.attachments.length > 0;
  const normalized = normalizeAnswerText(split.text);
  const hasVisibleText = normalized.length > 0;
  return {
    ...value, payload: { ...payload, content: [] },
    [storedAnswerRestriction]: {
      kind: "message",
      chatIndex: hasVisibleText || attachments || Boolean(split.memoryCitation) || hasAudio,
      textHash: hashCodexAnswerText(normalized),
      transcriptIndex: parsed.text.trim().length > 0 || attachments || hasAudio,
      searchIndex: hasVisibleText || attachments || hasAudio,
    },
  };
}

function restrictsAnswer(moderation: RecordValue): boolean {
  const { moderated, display } = moderation;
  if (typeof moderated !== "boolean") return false;
  if (display === undefined || display === null) return moderated;
  if (!isRecord(display) || display.version !== 1 || display.mode !== "show" ||
    (display.trustedContacts !== "check" && display.trustedContacts !== "skip")) return true;
  const annotation = display.annotation;
  return annotation !== undefined && annotation !== null &&
    (!isRecord(annotation) || annotation.kind !== "wellbeingHelpline" ||
      (annotation.subject !== "answer" && annotation.subject !== "prompt"));
}

function hashId(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return hashCodexAnswerText(value);
}

export function hashCodexAnswerText(value: string): string {
  return createHash("sha256").update(value, "utf16le").digest("hex");
}

function normalizeAnswerText(value: string): string {
  return value.replace(/\r\n?/gu, "\n").trim();
}

function matchDecision(records: Map<string, Decision>, key: string | undefined, turn: string | undefined): Decision | undefined {
  const decision = key ? records.get(key) : undefined;
  return decision && (!decision.turn || !turn || decision.turn === turn) ? decision : undefined;
}

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
