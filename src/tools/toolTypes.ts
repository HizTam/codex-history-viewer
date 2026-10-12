export type ToolDisplayMode = "detailsOnly" | "compactCards";

export type NormalizedToolKind =
  | "bash"
  | "exec"
  | "read"
  | "write"
  | "edit"
  | "grep"
  | "glob"
  | "webSearch"
  | "webFetch"
  | "imageGeneration"
  | "sendFile"
  | "agent"
  | "wait"
  | "unknown";

export type ChatToolSeverity = "info" | "warning" | "error";

// Keep presentation data independent of the UI language and omitted raw arguments.
export type ChatToolSecondary =
  | { kind: "cwd"; value: string }
  | { kind: "line"; line: number }
  | { kind: "linesRange"; start: number; end: number }
  | { kind: "replaceSnippet"; before: string; after: string }
  | { kind: "patchReady" };

export type ChatToolBadge =
  | { kind: "created" | "deleted" | "modified" | "patched" | "renamed" }
  | { kind: "exitCode"; exitCode: number };

export interface ChatToolPresentation {
  toolKind: NormalizedToolKind;
  title?: string;
  primaryText: string;
  secondary?: ChatToolSecondary;
  badge?: ChatToolBadge;
  // Retain legacy display strings only for compatibility with older models.
  secondaryText?: string;
  badgeText?: string;
  severity?: ChatToolSeverity;
  relatedFilePath?: string;
  messageIndex?: number;
  recentEditId?: string;
  hasDiff?: boolean;
}
