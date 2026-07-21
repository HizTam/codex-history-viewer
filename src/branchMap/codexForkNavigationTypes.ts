import type { ChatSessionModel } from "../chat/chatTypes";
import type { HistoryIndex, SessionSummary } from "../sessions/sessionTypes";
import type { ClaudeBranchMessageAnchor } from "./claudeBranchMapTypes";
import type { CodexForkComponent } from "./codexForkRelationTypes";

export interface CodexForkFileInventoryEntry {
  cacheKey: string;
  mtimeMs: number;
  size: number;
  signature: string;
}

export interface CodexForkNavigationTarget {
  id: string;
  sessionCacheKey: string;
  sessionIdentityKey: string;
  chatMessageIndex: number;
  role: "user" | "assistant";
  inventorySignature: string;
}

export interface CodexForkPresentationOccurrence {
  id: string;
  sessionIdentityKey: string;
  sessionCacheKey: string;
  historyFirst?: ClaudeBranchMessageAnchor;
  preBranch?: ClaudeBranchMessageAnchor;
  branchStart: ClaudeBranchMessageAnchor;
  historyEnd?: ClaudeBranchMessageAnchor;
  isBookmarked: boolean;
  hasTags: boolean;
  hasNote: boolean;
}

export interface CodexForkPresentationChoice {
  id: string;
  kind: "parentContinuation" | "child";
  sessionIdentityKey: string;
  preview: string;
  occurrence: CodexForkPresentationOccurrence;
}

export interface CodexForkPresentationGroup {
  id: string;
  parentSessionIdentityKey: string;
  parentAnchor: ClaudeBranchMessageAnchor;
  anchorMessageIndex: number;
  parentGroupId?: string;
  parentChoiceId?: string;
  choices: CodexForkPresentationChoice[];
}

export interface CodexForkNavigationSnapshot {
  source: "codex";
  baseSessionCacheKey: string;
  baseSessionIdentityKey: string;
  indexGeneration: number;
  inventoryFingerprint: string;
  fingerprint: string;
  cursorSalt: string;
  sessions: readonly SessionSummary[];
  component: CodexForkComponent;
  relationPartial: boolean;
  groups: readonly CodexForkPresentationGroup[];
  inventoryByCacheKey: ReadonlyMap<string, CodexForkFileInventoryEntry>;
  targetById: ReadonlyMap<string, CodexForkNavigationTarget>;
}

export interface CodexForkNavigationLoadProgress {
  completed: number;
  total: number;
  cacheHitCount: number;
  rebuiltCount: number;
}

export interface LoadCodexForkNavigationOptions {
  shouldContinue?: () => boolean;
  onProgress?: (progress: CodexForkNavigationLoadProgress) => void;
}

export interface CodexForkOverlayPageOptions {
  cursor?: string;
  focusGroupId?: string;
  activeChatMessageIndex?: number;
}

export interface CodexForkNavigationDependencies {
  statFile?: (fsPath: string) => Promise<{ mtimeMs: number; size: number }>;
  buildChatModel?: (fsPath: string) => Promise<ChatSessionModel>;
  getPresentationState?: (
    session: SessionSummary,
    branchStart: ClaudeBranchMessageAnchor,
  ) => CodexForkPresentationState;
}

export interface CodexForkPresentationState {
  isBookmarked: boolean;
  hasTags: boolean;
  hasNote: boolean;
}

export interface CodexForkHistoryInventory {
  getIndex(): HistoryIndex;
  getIndexGeneration(): number;
  hasCompleteCodexAgentMetadata(): boolean;
  isCodexAgentMetadataVerified(session: SessionSummary): boolean;
  ensureCodexAgentMetadata(options?: {
    shouldApply?: () => boolean;
  }): Promise<{
    complete: boolean;
    cancelled: boolean;
  }>;
}

export interface ResolvedCodexForkNavigationTarget {
  target: CodexForkNavigationTarget;
  session: SessionSummary;
}
