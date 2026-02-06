import type { Ymd } from "../utils/dateUtils";

// Minimal session info extracted from JSONL (for display/search/actions).
export interface SessionMetaInfo {
  id?: string;
  timestampIso?: string; // session_meta.payload.timestamp (UTC ISO expected)
  cwd?: string;
  originator?: string;
  cliVersion?: string;
  modelProvider?: string;
  source?: string;
}

export type ChatRole = "user" | "assistant";

export interface PreviewMessage {
  role: ChatRole;
  text: string;
}

export interface SessionSummary {
  fsPath: string;
  cacheKey: string;
  meta: SessionMetaInfo;
  inferredYmd?: Ymd; // Set only if inferred from the path
  localDate: string; // YYYY-MM-DD (display time zone date)
  timeLabel: string; // HH:MM (display time zone time)
  snippet: string; // Short text for list display
  cwdShort: string;
  previewMessages: PreviewMessage[];
}

export interface HistoryIndex {
  sessionsRoot: string;
  sessions: SessionSummary[];
  byYmd: Map<string, SessionSummary[]>; // key: YYYY-MM-DD
  byYm: Map<string, Map<string, SessionSummary[]>>; // YYYY -> (MM -> sessions)
  byY: Map<string, Map<string, Map<string, SessionSummary[]>>>; // YYYY -> MM -> DD -> sessions
}
