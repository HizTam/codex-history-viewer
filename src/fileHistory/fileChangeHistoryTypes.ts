import type { ChatPatchChangeType, ChatPatchEntry } from "../chat/chatTypes";
import type { SessionSource, SessionSummary } from "../sessions/sessionTypes";

export const FILE_CHANGE_HISTORY_PAGE_SIZE = 100;

export type FileChangeHistoryMatchedSide = "path" | "movePath" | "both";

export interface FileChangeHistoryTarget {
  fsPath: string;
  workspaceRoot: string;
  workspaceName: string;
  fileName: string;
}

export interface FileChangeHistoryCandidate {
  session: SessionSummary;
  matchScore: number;
}

export interface FileChangeHistoryCard {
  id: string;
  source: SessionSource;
  sourceLabel: string;
  sessionFsPath: string;
  sessionCacheKey: string;
  sessionTitle: string;
  sessionCwd?: string;
  bookmarkGroupId?: string;
  messageIndex?: number;
  timestampIso?: string;
  localDate: string;
  dateTimeLabel: string;
  changeType: ChatPatchChangeType;
  matchedSide: FileChangeHistoryMatchedSide;
  path: string;
  displayPath: string;
  movePath?: string;
  moveDisplayPath?: string;
  added: number;
  removed: number;
  bookmarkKey?: string;
  isBookmarked?: boolean;
  entry: ChatPatchEntry;
}

export interface FileChangeHistoryLoadResult {
  cards: FileChangeHistoryCard[];
  nextCandidateIndex: number;
  pendingCards: FileChangeHistoryCard[];
  exhausted: boolean;
  stats: FileChangeHistoryLoadStats;
}

export interface FileChangeHistoryDiffStats {
  codexPatchApplyEnd: number;
  codexApplyPatchParsed: number;
  codexApplyPatchFailedSkipped: number;
  codexDuplicatesSuppressed: number;
  claudeEditParsed: number;
  claudeMultiEditParsed: number;
  claudeWriteParsed: number;
  noRenderableSkipped: number;
}

export interface FileChangeHistoryLoadStats {
  candidateScanned: number;
  parsedSessions: number;
  matchedSessions: number;
  pendingConsumed: number;
  cardsProduced: number;
  diffStats: FileChangeHistoryDiffStats;
}

export interface FileChangeHistorySourceCounts {
  codex: number;
  claude: number;
}

export interface FileChangeHistoryWebviewModel {
  target: FileChangeHistoryTarget;
  cards: FileChangeHistoryCard[];
  sourceCounts: FileChangeHistorySourceCounts;
  enabledSources: { codex: boolean; claude: boolean };
  totalCount: number;
  hasMore: boolean;
  noMore: boolean;
}

export interface FileChangeHistoryRevealTarget {
  kind: "patchEntry";
  messageIndex?: number;
  timestampIso?: string;
  filePath: string;
  movePath?: string;
  entryId?: string;
}
