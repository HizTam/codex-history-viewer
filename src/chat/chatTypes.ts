// Data model for the chat-like webview.
import type { ChatToolPresentation } from "../tools/toolTypes";

export type ChatRole = "developer" | "user" | "assistant";
export type ChatWebviewPathMode = "recorded" | "relocated";

export interface ChatSessionMeta {
  id?: string;
  timestampIso?: string;
  cwd?: string;
  displayCwd?: string;
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

export interface ChatSessionLocation {
  archiveState: "active" | "archived";
  rootKind: "codexSessions" | "codexArchivedSessions" | "claudeSessions";
}

export type ChatTimelineItem =
  | ChatMessageItem
  | ChatToolItem
  | ChatSystemEventItem
  | ChatUsageItem
  | ChatEnvironmentItem
  | ChatPatchGroupItem
  | ChatNoteItem;

export type ChatTurnStatus = "incomplete" | "completed" | "interrupted" | "rolledBack" | "unknown";
export type ChatTurnDisplayStatus = "running" | ChatTurnStatus;

export interface ChatTurnSummary {
  id: string;
  sequenceNumber: number;
  status: ChatTurnStatus;
  displayStatus?: ChatTurnDisplayStatus;
  startedAtIso?: string;
  completedAtIso?: string;
  updatedAtIso?: string;
  firstItemIndex?: number;
  lastItemIndex?: number;
  firstMessageIndex?: number;
  lastMessageIndex?: number;
  itemCount: number;
  messageCount: number;
  toolCount: number;
  patchGroupCount: number;
  patchEntryCount: number;
  usageRecordCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  systemEventCount: number;
}

export type ChatAttachmentStatus = "available" | "unavailable";
export type ChatImageAttachmentStatus = ChatAttachmentStatus;
export type ChatImageAttachmentReason = "unsupported" | "missing" | "tooLarge" | "invalid" | "remote" | "disabled";
export type ChatDocumentAttachmentReason = "unsupported" | "missing" | "tooLarge" | "invalid" | "disabled";
export type ChatDocumentKind = "pdf" | "text" | "generic";
export type ChatFileKind =
  | "pdf"
  | "word"
  | "excel"
  | "powerpoint"
  | "text"
  | "code"
  | "archive"
  | "image"
  | "generic";

export type ChatAttachment =
  | ChatImageAttachment
  | ChatDocumentAttachment
  | ChatFileReferenceAttachment
  | ChatSelectionReferenceAttachment
  | ChatNotificationAttachment
  | ChatInvokeAttachment;

export interface ChatImageAttachment {
  id?: string;
  type: "image";
  status: ChatImageAttachmentStatus;
  source: "data" | "local" | "reference";
  src?: string;
  dataOmitted?: boolean;
  mimeType?: string;
  label?: string;
  reason?: ChatImageAttachmentReason;
}

export type ChatDocumentPayload =
  | {
      kind: "text";
      text: string;
    }
  | {
      kind: "base64";
      data: string;
    };

export interface ChatDocumentAttachment {
  id?: string;
  type: "document";
  status: ChatAttachmentStatus;
  documentKind: ChatDocumentKind;
  source: "embeddedBase64" | "embeddedText" | "reference";
  label?: string;
  mimeType?: string;
  byteLength?: number;
  previewText?: string;
  dataOmitted?: boolean;
  reason?: ChatDocumentAttachmentReason;
  payload?: ChatDocumentPayload;
}

export interface ChatFileReferenceAttachment {
  id?: string;
  type: "fileReference";
  source: "codexFilesMentioned" | "claudeIdeOpenedFile";
  label?: string;
  path?: string;
  line?: number;
  endLine?: number;
  fileKind?: ChatFileKind;
}

export interface ChatSelectionReferenceAttachment {
  id?: string;
  type: "selectionReference";
  source: "claudeIdeSelection";
  label?: string;
  path?: string;
  line?: number;
  endLine?: number;
  previewText?: string;
}

export type ChatNotificationStatus = "completed" | "failed" | "running" | "cancelled" | "unknown";

export interface ChatNotificationUsage {
  subagentTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

export interface ChatNotificationAttachment {
  id?: string;
  type: "notification";
  source: "claudeTaskNotification";
  notificationKind: "task";
  taskId?: string;
  toolUseId?: string;
  status: ChatNotificationStatus;
  rawStatus?: string;
  summary?: string;
  note?: string;
  result?: string;
  usage?: ChatNotificationUsage;
  outputFile?: string;
  systemPreamble?: string;
  text?: string;
}

export interface ChatInvokeParameter {
  name: string;
  value: string;
  truncated?: boolean;
}

export interface ChatInvokeAttachment {
  id?: string;
  type: "invoke";
  source: "claudeInvokeMarkup";
  toolName: string;
  parameters: ChatInvokeParameter[];
  description?: string;
  primaryParameterName?: string;
  primaryParameterPreview?: string;
  harnessPreamble?: string;
  text?: string;
}

export interface ChatMemoryCitationEntry {
  path: string;
  lineStart?: number;
  lineEnd?: number;
  note?: string;
}

export interface ChatMemoryCitation {
  entries: ChatMemoryCitationEntry[];
  rolloutIds: string[];
}

export interface ChatMessageItem {
  type: "message";
  role: ChatRole;
  // 1-based display order for user/assistant (used for search jump). developer is undefined.
  messageIndex?: number;
  turnId?: string;
  timestampIso?: string;
  model?: string;
  effort?: string;
  text: string;
  requestText?: string;
  attachments?: ChatAttachment[];
  memoryCitation?: ChatMemoryCitation;
  // Treat large environment/rule messages as "context".
  isContext: boolean;
  bookmarkKey?: string;
  isBookmarked?: boolean;
}

export interface ChatToolItem {
  type: "tool";
  messageIndex?: number;
  turnId?: string;
  timestampIso?: string;
  name: string;
  callId?: string;
  argumentsText?: string;
  outputText?: string;
  detailsOmitted?: boolean;
  execution?: ChatToolExecution;
  presentation?: ChatToolPresentation;
  bookmarkKey?: string;
  isBookmarked?: boolean;
}

export interface ChatToolExecution {
  status?: string;
  exitCode?: number;
  durationMs?: number;
  error?: string;
}

export type ChatSystemEventKind = "requestInterrupted";
export type ChatSystemEventScope = "request" | "toolUse";

export interface ChatSystemEventItem {
  type: "systemEvent";
  kind: ChatSystemEventKind;
  source?: "codex" | "claude";
  scope?: ChatSystemEventScope;
  timestampIso?: string;
  reason?: string;
  durationMs?: number;
  turnId?: string;
  rolledBack?: boolean;
  rolledBackTurns?: number;
}

export interface ChatTokenUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
}

export interface ChatUsageItem {
  type: "usage";
  messageIndex?: number;
  turnId?: string;
  timestampIso?: string;
  model?: string;
  effort?: string;
  usage: ChatTokenUsage;
  totalUsage?: ChatTokenUsage;
  modelContextWindow?: number;
  serviceTier?: string;
  speed?: string;
  stopReason?: string;
  rateLimits?: ChatRateLimits;
  bookmarkKey?: string;
  isBookmarked?: boolean;
}

export interface ChatRateLimit {
  usedPercent?: number;
  windowMinutes?: number;
  resetsAt?: number;
  resetsInSeconds?: number;
}

export interface ChatRateLimits {
  primary?: ChatRateLimit;
  secondary?: ChatRateLimit;
  limitId?: string;
  limitName?: string;
  planType?: string;
  reachedType?: string;
}

export interface ChatEnvironmentItem {
  type: "environment";
  messageIndex?: number;
  turnId?: string;
  timestampIso?: string;
  cwd?: string;
  gitBranch?: string;
  gitCommit?: string;
  gitDirty?: boolean;
  bookmarkKey?: string;
  isBookmarked?: boolean;
}

export type ChatPatchChangeType = "create" | "delete" | "move" | "rename" | "update" | "unknown";
export type ChatPatchRowKind = "context" | "add" | "delete" | "modify";

export interface ChatPatchGroupItem {
  type: "patchGroup";
  messageIndex?: number;
  timestampIso?: string;
  turnId?: string;
  bookmarkGroupId?: string;
  entryCount: number;
  totalAdded: number;
  totalRemoved: number;
  entries: ChatPatchEntry[];
  bookmarkKey?: string;
  isBookmarked?: boolean;
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
  detailsOmitted?: boolean;
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
  bookmarkKey?: string;
  isBookmarked?: boolean;
}

export interface ChatSessionModel {
  fsPath: string;
  meta: ChatSessionMeta;
  sessionLocation?: ChatSessionLocation;
  items: ChatTimelineItem[];
  turns?: ChatTurnSummary[];
  activeTurnId?: string;
  liveRunningTurnId?: string;
  latestTurnId?: string;
  annotation?: ChatSessionAnnotation;
}
