export type ClaudeBranchConfidence = "exact" | "secondary" | "unresolved";
export type ClaudeBranchEdgeKind = "parent" | "compactBoundary" | "unresolved";

export interface ClaudeBranchLane {
  id: string;
  order: number;
  label: string;
  isBaseSession: boolean;
  hasTags: boolean;
  hasNote: boolean;
}

export interface ClaudeBranchOccurrenceView {
  id: string;
  laneId: string;
  chatMessageIndex: number;
  recordOrdinal: number;
  timestampIso?: string;
  isBookmarked: boolean;
}

export interface ClaudeBranchChoice {
  id: string;
  nodeId: string;
  preview: string;
  occurrenceIds: string[];
  laneIds: string[];
}

export interface ClaudeBranchGroup {
  id: string;
  parentNodeId: string;
  choices: ClaudeBranchChoice[];
}

export interface ClaudeBranchNode {
  id: string;
  parentId?: string;
  depth: number;
  preview: string;
  timestampIso?: string;
  confidence: ClaudeBranchConfidence;
  occurrenceCount: number;
  occurrences: ClaudeBranchOccurrenceView[];
  laneIds: string[];
  hasConflict: boolean;
  compactBoundary: boolean;
}

export interface ClaudeBranchEdge {
  id: string;
  from: string;
  to: string;
  kind: ClaudeBranchEdgeKind;
}

// This model remains Extension Host-only and is never serialized to the session Webview.
export interface ClaudeBranchMapModel {
  version: 1;
  projectLabel: string;
  baseSessionLabel: string;
  generatedAtIso: string;
  refreshing: boolean;
  stale: boolean;
  lanes: ClaudeBranchLane[];
  nodes: ClaudeBranchNode[];
  edges: ClaudeBranchEdge[];
  groups: ClaudeBranchGroup[];
  unresolvedCount: number;
  excludedSidechainCount: number;
  unavailableSessionCount: number;
  partial: boolean;
}

export interface ClaudeBranchMessageAnchor {
  role: "user" | "assistant";
  chatMessageIndex: number;
  timestampIso?: string;
  preview?: string;
}

export interface ClaudeBranchOccurrenceOption {
  id: string;
  sessionLabel: string;
  isCurrent: boolean;
  historyFirst?: ClaudeBranchMessageAnchor;
  preBranch?: ClaudeBranchMessageAnchor;
  branchStart: ClaudeBranchMessageAnchor;
  historyEnd?: ClaudeBranchMessageAnchor;
  isBookmarked: boolean;
  hasTags: boolean;
  hasNote: boolean;
}

export interface ClaudeChatBranchChoice {
  id: string;
  choiceIndex: number;
  preview: string;
  occurrenceCount: number;
  occurrences: ClaudeBranchOccurrenceOption[];
}

export interface ClaudeChatBranchGroup {
  id: string;
  anchorChatMessageIndex: number;
  currentChoiceIndex: number;
  choiceCount: number;
  choices: ClaudeChatBranchChoice[];
}

export interface ClaudeBranchCommonRange {
  first: ClaudeBranchMessageAnchor;
  last: ClaudeBranchMessageAnchor;
}

export interface ClaudeBranchOverlayGroup {
  id: string;
  groupIndex: number;
  parentGroupId?: string;
  parentChoiceId?: string;
  choiceCount: number;
  currentChoiceIndex: number;
  activeLineage: boolean;
  commonRange?: ClaudeBranchCommonRange;
  choices: ClaudeChatBranchChoice[];
  previousChoiceCursor?: string;
  nextChoiceCursor?: string;
  previousChoiceCount: number;
  nextChoiceCount: number;
}

export interface ClaudeBranchOverlayPageModel {
  title: string;
  groups: ClaudeBranchOverlayGroup[];
  totalGroupCount: number;
  routeCount: number;
  currentGroupId: string;
  previousCursor?: string;
  nextCursor?: string;
  previousGroupCount: number;
  nextGroupCount: number;
  relationPartial: boolean;
  navigationIncomplete: boolean;
}

export interface ClaudeChatBranchNavigationModel {
  version: 3;
  generation: number;
  groupCount: number;
  groups: ClaudeChatBranchGroup[];
  overlay: ClaudeBranchOverlayPageModel;
}
