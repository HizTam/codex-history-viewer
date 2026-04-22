import type { Ymd } from "../utils/dateUtils";

export type SessionSource = "codex" | "claude";
export type SessionSourceFilter = "all" | SessionSource;

// Minimal session info extracted from JSONL (for display/search/actions).
export interface SessionMetaInfo {
  id?: string;
  timestampIso?: string; // session_meta.payload.timestamp (UTC ISO expected)
  cwd?: string;
  originator?: string;
  cliVersion?: string;
  modelProvider?: string;
  source?: string;
  historySource?: SessionSource;
}

export type ChatRole = "user" | "assistant";

export interface PreviewMessage {
  role: ChatRole;
  text: string;
}

export interface SessionSummary {
  fsPath: string;
  cacheKey: string;
  source: SessionSource;
  meta: SessionMetaInfo;
  inferredYmd?: Ymd;
  startedAtIso?: string;
  lastActivityAtIso?: string;
  startedLocalDate: string;
  startedTimeLabel: string;
  lastActivityLocalDate: string;
  lastActivityTimeLabel: string;
  localDate: string;
  timeLabel: string;
  snippet: string;
  nativeTitle?: string;
  displayTitle: string;
  cwdShort: string;
  previewMessages: PreviewMessage[];
}

export interface HistoryIndex {
  sessionsRoot: string;
  sessions: SessionSummary[];
  byCacheKey: Map<string, SessionSummary>;
  byYmd: Map<string, SessionSummary[]>; // key: YYYY-MM-DD
  byYm: Map<string, Map<string, SessionSummary[]>>; // YYYY -> (MM -> sessions)
  byY: Map<string, Map<string, Map<string, SessionSummary[]>>>; // YYYY -> MM -> DD -> sessions
}
