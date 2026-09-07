export interface CodexQuestionReply {
  readonly questionItemId: string;
  readonly question: string;
  readonly answer: string;
  readonly options?: readonly string[];
  readonly selectedOptionIndex?: number;
}

export interface CodexAsyncQuestionDefinition {
  readonly title: string;
  readonly options?: readonly string[];
}

interface QuestionEntry {
  readonly title: string;
  readonly options: readonly string[];
  readonly length: number;
}

const OPEN_TAG = "<send_user_message_question_reply>";
const CLOSE_TAG = "</send_user_message_question_reply>";
const MAX_REPLY_COUNT = 32;
const MAX_REPLY_LENGTH = 262_144;
const MAX_PART_LENGTH = 16_384;
const MAX_ID_LENGTH = 1_024;
const MAX_TRACKED_QUESTIONS = 256;
const MAX_TRACKED_LENGTH = 1_048_576;
const ID_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

// Accept only a complete, standalone protocol message, never quoted or mixed content.
export function readCodexQuestionReplies(content: unknown): CodexQuestionReply[] | undefined {
  let text: string;
  if (typeof content === "string") text = content;
  else {
    if (!Array.isArray(content) || content.length !== 1) return undefined;
    const item: unknown = content[0];
    if (!isRecord(item) || (item.type !== "text" && item.type !== "input_text") || typeof item.text !== "string") {
      return undefined;
    }
    text = item.text;
  }
  if (text.length > MAX_REPLY_LENGTH || !text.includes(OPEN_TAG)) return undefined;
  const trimmed = text.trim();
  if (!trimmed.startsWith(OPEN_TAG) || !trimmed.endsWith(CLOSE_TAG)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(OPEN_TAG.length, -CLOSE_TAG.length));
  } catch {
    // Preserve the original user text when a protocol-like payload is incomplete or invalid.
    return undefined;
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  if (entries.length < 1 || entries.length > MAX_REPLY_COUNT) return undefined;
  const replies: CodexQuestionReply[] = [];
  for (const entry of entries) {
    if (
      !isRecord(entry) ||
      typeof entry.questionItemId !== "string" ||
      !entry.questionItemId.trim() ||
      entry.questionItemId.length > MAX_ID_LENGTH ||
      ID_CONTROL_CHARACTERS.test(entry.questionItemId) ||
      typeof entry.question !== "string" ||
      !entry.question.trim() ||
      entry.question.length > MAX_PART_LENGTH ||
      typeof entry.answer !== "string" ||
      entry.answer.length > MAX_PART_LENGTH
    ) return undefined;
    replies.push({ questionItemId: entry.questionItemId, question: entry.question, answer: entry.answer });
  }
  return replies;
}

// Keep persisted/searchable text locale-independent; translated labels belong to the view.
export function formatCodexQuestionRepliesText(replies: readonly CodexQuestionReply[]): string {
  return replies.map((reply) => `${reply.question}\n${reply.answer}`).join("\n\n");
}

export class CodexQuestionReplyResolver {
  private readonly entries = new Map<string, QuestionEntry | null>();
  private trackedLength = 0;

  public observe(message: {
    readonly itemId: string;
    readonly text: string;
    readonly questions?: readonly CodexAsyncQuestionDefinition[];
  }): void {
    // The caller supplies a bounded, validated completed async question message.
    if (!message.questions?.length) {
      this.add(message.itemId, message.text, []);
      return;
    }
    message.questions.forEach((question, index) => {
      this.add(JSON.stringify(["request_user_input_async", message.itemId, index]), question.title, question.options ?? []);
    });
  }

  public resolve(replies: readonly CodexQuestionReply[]): CodexQuestionReply[] {
    return replies.map((reply) => {
      const entry = this.entries.get(reply.questionItemId);
      if (!entry || entry.title !== reply.question || entry.options.length === 0) return { ...reply };
      const matches = entry.options.flatMap((option, index) => option === reply.answer ? [index] : []);
      return {
        ...reply,
        options: [...entry.options],
        ...(matches.length === 1 ? { selectedOptionIndex: matches[0] } : {}),
      };
    });
  }

  private add(id: string, title: string, options: readonly string[]): void {
    if (this.entries.has(id)) {
      const previous = this.entries.get(id);
      if (previous && (previous.title !== title || !sameOptions(previous.options, options))) {
        this.trackedLength -= previous.length;
        this.entries.set(id, null);
      }
      return;
    }
    const length = id.length + title.length + options.reduce((total, option) => total + option.length, 0);
    if (length > MAX_TRACKED_LENGTH) return;
    this.entries.set(id, { title, options: [...options], length });
    this.trackedLength += length;
    while (this.entries.size > MAX_TRACKED_QUESTIONS || this.trackedLength > MAX_TRACKED_LENGTH) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.trackedLength -= this.entries.get(oldest.value)?.length ?? 0;
      this.entries.delete(oldest.value);
    }
  }
}

function sameOptions(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
