import type { HistoryTitleSource } from "../settings";
import { normalizeWhitespace } from "../utils/textUtils";
import type { SessionSummary } from "./sessionTypes";

function sanitizeTitle(value: unknown): string | undefined {
  const normalized = normalizeWhitespace(typeof value === "string" ? value : "").trim();
  if (!normalized) return undefined;
  return normalized.length > 300 ? `${normalized.slice(0, 299)}...` : normalized;
}

function resolveNativeTitle(
  session: SessionSummary,
  codexTitlesById: ReadonlyMap<string, string>,
): string | undefined {
  if (session.source === "codex") {
    const sessionId = typeof session.meta.id === "string" ? session.meta.id.trim() : "";
    return sanitizeTitle((sessionId && codexTitlesById.get(sessionId)) ?? session.nativeTitle);
  }

  return sanitizeTitle(session.nativeTitle);
}

export function resolveSessionDisplayTitle(params: {
  session: SessionSummary;
  titleSource: HistoryTitleSource;
  codexTitlesById?: ReadonlyMap<string, string>;
}): SessionSummary {
  const codexTitlesById = params.codexTitlesById ?? new Map<string, string>();
  const nativeTitle = resolveNativeTitle(params.session, codexTitlesById);
  const displayTitle = params.titleSource === "nativeWhenAvailable" ? nativeTitle ?? params.session.snippet : params.session.snippet;

  return {
    ...params.session,
    nativeTitle,
    displayTitle,
  };
}

export function resolveSessionDisplayTitles(params: {
  sessions: readonly SessionSummary[];
  titleSource: HistoryTitleSource;
  codexTitlesById?: ReadonlyMap<string, string>;
}): SessionSummary[] {
  return params.sessions.map((session) =>
    resolveSessionDisplayTitle({
      session,
      titleSource: params.titleSource,
      codexTitlesById: params.codexTitlesById,
    }),
  );
}
