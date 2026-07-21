import type { SessionSummary } from "../sessions/sessionTypes";

export type CodexAgentRelationKind = "none" | "parent" | "child" | "both";

export interface CodexAgentPresentation {
  relation: CodexAgentRelationKind;
  taskLabel: string;
  directChildCount: number;
  parentSession?: SessionSummary;
  parentUnavailable: boolean;
  canShowComponent: boolean;
}

export interface CodexAgentComponentNode {
  id: string;
  parentId?: string;
  session?: SessionSummary;
  unavailableParent: boolean;
  isCurrent: boolean;
  isSubagent: boolean;
  taskLabel: string;
  agentRole: string;
  directChildCount: number;
}

export interface CodexAgentComponent {
  sessionCount: number;
  agentCount: number;
  relationPartial: boolean;
  omittedCount: number;
  nodes: CodexAgentComponentNode[];
}

export interface CodexAgentRunsWebviewNode {
  id: string;
  parentId?: string;
  navigationTarget?: string;
  actionTarget?: string;
  title: string;
  titleIsCustom: boolean;
  taskLabel: string;
  agentRole: string;
  started: string;
  lastActivity: string;
  directChildCount: number;
  isCurrent: boolean;
  isSubagent: boolean;
  unavailableParent: boolean;
  isPinned: boolean;
  isBookmarked: boolean;
  hasTags: boolean;
  hasNote: boolean;
}

export interface CodexAgentRunsWebviewModel {
  sessionCount: number;
  agentCount: number;
  relationPartial: boolean;
  omittedCount: number;
  pinRevision: number;
  nodes: CodexAgentRunsWebviewNode[];
}
