export type ToolDisplayMode = "detailsOnly" | "compactCards";

export type NormalizedToolKind =
  | "bash"
  | "read"
  | "write"
  | "edit"
  | "grep"
  | "glob"
  | "webSearch"
  | "webFetch"
  | "agent"
  | "unknown";

export type ChatToolSeverity = "info" | "warning" | "error";

export interface ChatToolPresentation {
  toolKind: NormalizedToolKind;
  title: string;
  primaryText: string;
  secondaryText?: string;
  badgeText?: string;
  severity?: ChatToolSeverity;
  relatedFilePath?: string;
  messageIndex?: number;
  recentEditId?: string;
  hasDiff?: boolean;
}
