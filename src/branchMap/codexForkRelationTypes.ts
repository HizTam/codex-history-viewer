import type { SessionSummary } from "../sessions/sessionTypes";

export type CodexForkEdgeStatus =
  | "resolved"
  | "parentUnavailable"
  | "ambiguousParent"
  | "scopeMismatch"
  | "cycleDropped";

export interface CodexForkMessageEvidence {
  role: "user" | "assistant";
  chatMessageIndex: number;
  fingerprint: string;
  stableItemId?: string;
  timestampIso?: string;
  preview?: string;
}

export interface CodexForkSessionEvidence {
  messages: CodexForkMessageEvidence[];
  truncated: boolean;
}

export interface CodexForkMessageAnchor {
  role: "user" | "assistant";
  chatMessageIndex: number;
  timestampIso?: string;
  preview?: string;
}

export interface CodexForkBranchAnchor {
  commonMessageCount: number;
  parent: CodexForkMessageAnchor;
  child: CodexForkMessageAnchor;
  parentContinuation?: CodexForkMessageAnchor;
  childBranchStart?: CodexForkMessageAnchor;
}

export interface CodexForkRelationEdge {
  childIdentityKey: string;
  parentThreadId: string;
  status: CodexForkEdgeStatus;
  parentIdentityKey?: string;
  anchor?: CodexForkBranchAnchor;
  anchorIncomplete: boolean;
}

export interface CodexForkRelationNode {
  id: string;
  parentId?: string;
  session?: SessionSummary;
  depth: number;
  isCurrent: boolean;
  unavailableParent: boolean;
  directChildCount: number;
}

export interface CodexForkComponent {
  sessionCount: number;
  forkCount: number;
  hasSupportedRelation: boolean;
  relationPartial: boolean;
  omittedCount: number;
  unavailableParentCount: number;
  ambiguousParentCount: number;
  scopeMismatchCount: number;
  cycleDroppedCount: number;
  anchorIncompleteCount: number;
  nodes: CodexForkRelationNode[];
  edges: CodexForkRelationEdge[];
}

export interface CodexForkRelationBuildInput {
  sessions: readonly SessionSummary[];
  currentSessionCacheKey: string;
  evidenceByIdentityKey?: ReadonlyMap<string, CodexForkSessionEvidence>;
}
