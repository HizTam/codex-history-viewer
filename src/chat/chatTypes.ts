// Data model for the chat-like webview.

export type ChatRole = "developer" | "user" | "assistant";

export interface ChatSessionMeta {
  id?: string;
  timestampIso?: string;
  cwd?: string;
  originator?: string;
  cliVersion?: string;
  modelProvider?: string;
  source?: string;
}

export type ChatTimelineItem = ChatMessageItem | ChatToolItem | ChatNoteItem;

export interface ChatMessageItem {
  type: "message";
  role: ChatRole;
  // 1-based display order for user/assistant (used for search jump). developer is undefined.
  messageIndex?: number;
  timestampIso?: string;
  text: string;
  requestText?: string;
  // Treat large environment/rule messages as "context".
  isContext: boolean;
}

export interface ChatToolItem {
  type: "tool";
  timestampIso?: string;
  name: string;
  callId?: string;
  argumentsText?: string;
  outputText?: string;
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
}
