// Data model for the chat-like webview.
import type { ChatToolPresentation } from "../tools/toolTypes";

export type ChatRole = "developer" | "user" | "assistant";

export interface ChatSessionMeta {
  id?: string;
  timestampIso?: string;
  cwd?: string;
  originator?: string;
  cliVersion?: string;
  modelProvider?: string;
  source?: string;
  historySource?: "codex" | "claude";
}

export interface ChatSessionAnnotation {
  tags: string[];
  note: string;
}

export type ChatTimelineItem = ChatMessageItem | ChatToolItem | ChatPatchGroupItem | ChatNoteItem;

export type ChatImageAttachmentStatus = "available" | "unavailable";
export type ChatImageAttachmentReason = "unsupported" | "missing" | "tooLarge" | "invalid" | "remote" | "disabled";

export interface ChatImageAttachment {
  id?: string;
  type: "image";
  status: ChatImageAttachmentStatus;
  source: "data" | "local" | "reference";
  src?: string;
  mimeType?: string;
  label?: string;
  reason?: ChatImageAttachmentReason;
}

export interface ChatMessageItem {
  type: "message";
  role: ChatRole;
  // 1-based display order for user/assistant (used for search jump). developer is undefined.
  messageIndex?: number;
  timestampIso?: string;
  text: string;
  requestText?: string;
  images?: ChatImageAttachment[];
  // Treat large environment/rule messages as "context".
  isContext: boolean;
}

export interface ChatToolItem {
  type: "tool";
  messageIndex?: number;
  timestampIso?: string;
  name: string;
  callId?: string;
  argumentsText?: string;
  outputText?: string;
  presentation?: ChatToolPresentation;
}

export type ChatPatchChangeType = "create" | "delete" | "move" | "rename" | "update" | "unknown";
export type ChatPatchRowKind = "context" | "add" | "delete" | "modify";

export interface ChatPatchGroupItem {
  type: "patchGroup";
  messageIndex?: number;
  timestampIso?: string;
  turnId?: string;
  entryCount: number;
  totalAdded: number;
  totalRemoved: number;
  entries: ChatPatchEntry[];
}

export interface ChatPatchEntry {
  id: string;
  callId?: string;
  path: string;
  displayPath: string;
  movePath?: string;
  moveDisplayPath?: string;
  changeType: ChatPatchChangeType;
  added: number;
  removed: number;
  hunks: ChatPatchHunk[];
}

export interface ChatPatchHunk {
  header: string;
  rows: ChatPatchRow[];
}

export interface ChatPatchRow {
  kind: ChatPatchRowKind;
  leftLine?: number;
  leftText: string;
  rightLine?: number;
  rightText: string;
}

export interface ChatNoteItem {
  type: "note";
  timestampIso?: string;
  title: string;
  text?: string;
}

export interface ChatSessionModel {
  fsPath: string;
  meta: ChatSessionMeta;
  items: ChatTimelineItem[];
  annotation?: ChatSessionAnnotation;
}
