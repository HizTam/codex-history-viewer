import { isCodexProtocolContextContent } from "../chat/chatAttachments";
import { normalizeCodexCorrelationId } from "./codexRolloutCompatibility";

export interface CodexRollbackRange {
  readonly startLineIndex: number;
  readonly endLineIndex: number;
}

export interface CodexRollbackProjection {
  readonly ranges: readonly CodexRollbackRange[];
  readonly hasRollback: boolean;
  readonly revision?: number;
}

interface HistoryTurn {
  readonly startLineIndex: number;
  readonly id?: string;
  readonly explicit: boolean;
  hasUser: boolean;
  lastUserSource?: "event" | "response";
  userPairComplete: boolean;
  hasOutput: boolean;
}

// Keep only turn boundaries and removed ranges; never retain message bodies.
export class CodexRollbackTracker {
  private readonly turns: HistoryTurn[] = [];
  private readonly ranges: CodexRollbackRange[] = [];
  private current: HistoryTurn | undefined;
  private pendingContextStart: number | undefined;
  private hasRollback = false;
  private revision: number | undefined;

  public get isWithinExplicitTurn(): boolean {
    return this.current?.explicit === true;
  }

  public accept(value: unknown, lineIndex: number): number | undefined {
    if (!isRecord(value) || !isRecord(value.payload)) return undefined;
    const payload = value.payload;
    if (value.type === "event_msg") {
      if (payload.type === "thread_rolled_back") {
        const count = payload.num_turns;
        // The wire format uses u32. Malformed markers must not erase history.
        if (!Number.isInteger(count) || typeof count !== "number" || count < 0 || count > 0xffff_ffff) {
          return undefined;
        }
        const removed = count > 0 ? Math.min(count, this.turns.length) : 0;
        const startLineIndex = removed > 0
          ? this.turns[this.turns.length - removed]!.startLineIndex
          : lineIndex;
        if (removed > 0) {
          this.turns.length -= removed;
          this.current = undefined;
          this.pendingContextStart = undefined;
          this.hasRollback = true;
          this.revision = lineIndex;
        }
        this.exclude(startLineIndex, lineIndex);
        return startLineIndex;
      }
      if (payload.type === "task_started") {
        const id = normalizeCodexCorrelationId(payload.turn_id);
        if (id) this.startTurn(lineIndex, true, id);
      } else if (payload.type === "task_complete") {
        const id = normalizeCodexCorrelationId(payload.turn_id);
        if (!id || id === this.current?.id || !this.turns.some(turn => turn.id === id)) {
          this.current = undefined;
          this.pendingContextStart = undefined;
        }
      } else if (payload.type === "user_message") {
        this.acceptUser(lineIndex, "event");
      } else if (isRenderableEvent(payload.type)) {
        this.acceptOutput(lineIndex);
      }
    } else if (value.type === "turn_context") {
      if (!this.current) this.pendingContextStart ??= lineIndex;
    } else if (value.type === "response_item" && payload.type === "message") {
      if (payload.role === "user") {
        if (isCodexProtocolContextContent(payload.content)) {
          if (!this.current) this.pendingContextStart ??= lineIndex;
        } else {
          this.acceptUser(lineIndex, "response");
        }
      } else if (payload.role === "assistant") {
        this.acceptOutput(lineIndex);
      } else if (payload.role === "developer" && !this.current) {
        this.pendingContextStart ??= lineIndex;
      }
    } else if (value.type === "compacted") {
      this.acceptOutput(lineIndex);
    }
    return undefined;
  }

  public finalize(): CodexRollbackProjection {
    return {
      ranges: this.ranges.map(range => ({ ...range })), hasRollback: this.hasRollback,
      ...(this.revision !== undefined ? { revision: this.revision } : {}),
    };
  }

  private acceptUser(lineIndex: number, source: "event" | "response"): void {
    // A persisted user event and response item can describe the same input.
    const paired = this.current?.hasUser && !this.current.userPairComplete &&
      !this.current.hasOutput && this.current.lastUserSource !== source;
    if (!this.current || (!this.current.explicit && this.current.hasUser && !paired)) {
      this.startTurn(this.pendingContextStart ?? lineIndex, false);
    }
    this.current!.hasUser = true;
    this.current!.lastUserSource = source;
    if (paired) this.current!.userPairComplete = true;
  }

  private acceptOutput(lineIndex: number): void {
    if (!this.current) this.startTurn(this.pendingContextStart ?? lineIndex, false);
    this.current!.hasOutput = true;
  }

  private startTurn(startLineIndex: number, explicit: boolean, id?: string): void {
    this.current = { startLineIndex, explicit, ...(id ? { id } : {}), hasUser: false, hasOutput: false, userPairComplete: false };
    this.turns.push(this.current);
    this.pendingContextStart = undefined;
  }

  private exclude(startLineIndex: number, endLineIndex: number): void {
    while (this.ranges.length > 0 && this.ranges[this.ranges.length - 1]!.endLineIndex >= startLineIndex - 1) {
      startLineIndex = Math.min(startLineIndex, this.ranges.pop()!.startLineIndex);
    }
    this.ranges.push({ startLineIndex, endLineIndex });
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRenderableEvent(type: unknown): boolean {
  return typeof type === "string" && (
    type === "agent_message" || type === "agent_reasoning" || type === "context_compacted" ||
    type === "exec_command_begin" || type === "exec_command_end" ||
    type === "patch_apply_begin" || type === "patch_apply_end" ||
    type === "mcp_tool_call_begin" || type === "mcp_tool_call_end" ||
    type === "web_search_begin" || type === "web_search_end" ||
    type === "item_started" || type === "item_completed"
  );
}
