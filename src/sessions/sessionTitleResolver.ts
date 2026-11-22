import * as path from "node:path";
import {
  resolveCodexAgentTaskLabel,
  sanitizeCachedCodexAgentMetadata,
} from "../agents/codexAgentMetadata";
import type { HistoryTitleSource } from "../settings";
import { hasCodexPageSnapshotPrefix, isCodexProtocolContextStartText, normalizeWhitespace } from "../utils/textUtils";
import type { PreviewMessage, SessionSummary } from "./sessionTypes";

function sanitizeTitle(value: unknown, preserveWhitespace = false): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = preserveWhitespace ? value.trim() : normalizeWhitespace(value);
  if (!normalized) return undefined;
  return normalized.length > 300 ? `${normalized.slice(0, 299)}...` : normalized;
}

export function isSessionProtocolContextTitle(value: unknown, source?: SessionSummary["source"]): boolean {
  return typeof value === "string" && isCodexProtocolContextStartText(value, source === "codex");
}

function sanitizeGeneratedTitle(value: unknown, source?: SessionSummary["source"]): string | undefined {
  if (isSessionProtocolContextTitle(value, source)) return undefined;
  return sanitizeTitle(value, source === "codex" && hasCodexPageSnapshotPrefix(value));
}

export function resolvePreviewSessionTitleCandidate(messages: readonly PreviewMessage[], source?: SessionSummary["source"]): string | undefined {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    const userText = sanitizeGeneratedTitle(message.text, source);
    if (!userText) continue;
    if (isUiTitleGenerationPrompt(userText)) {
      const nextAssistant = messages
        .slice(index + 1)
        .find((candidate) => candidate.role === "assistant" && sanitizeTitle(candidate.text));
      const generatedTitle = sanitizeGeneratedTitle(nextAssistant?.text, source);
      if (generatedTitle) return generatedTitle;
    }
    return userText;
  }
  return undefined;
}

function resolveNativeTitle(
  session: SessionSummary,
  codexTitlesById: ReadonlyMap<string, string | null>,
): string | undefined {
  if (session.source === "codex") {
    const sessionId = typeof session.meta.id === "string" ? session.meta.id.trim() : "";
    const liveTitle = codexTitlesById.get(sessionId);
    return liveTitle === null ? undefined : sanitizeGeneratedTitle(liveTitle ?? session.nativeTitle, "codex");
  }

  return sanitizeTitle(session.nativeTitle);
}

export function resolveSessionDisplayTitle(params: {
  session: SessionSummary;
  titleSource: HistoryTitleSource;
  codexTitlesById?: ReadonlyMap<string, string | null>;
  customTitle?: string;
}): SessionSummary {
  const codexTitlesById = params.codexTitlesById ?? new Map<string, string>();
  const nativeTitle = resolveNativeTitle(params.session, codexTitlesById);
  const generatedTitle = resolveGeneratedTitle(params.session);
  const originalTitle = params.titleSource === "nativeWhenAvailable" ? nativeTitle ?? generatedTitle : generatedTitle;
  const customTitle = sanitizeTitle(params.customTitle);
  const displayTitle = customTitle ?? originalTitle;

  if (
    params.session.nativeTitle === nativeTitle &&
    params.session.originalTitle === originalTitle &&
    params.session.customTitle === customTitle &&
    params.session.displayTitle === displayTitle
  ) {
    return params.session;
  }

  return {
    ...params.session,
    nativeTitle,
    originalTitle,
    customTitle,
    displayTitle,
  };
}

function resolveGeneratedTitle(session: SessionSummary): string {
  const fileNameFallback = sanitizeTitle(path.basename(session.fsPath)) ?? session.fsPath;
  const snippet = sanitizeGeneratedTitle(session.snippet, session.source);
  if (snippet && snippet !== fileNameFallback) return snippet;

  const previewTitle = resolvePreviewSessionTitleCandidate(session.previewMessages, session.source);
  if (previewTitle) return previewTitle;

  const metadata = sanitizeCachedCodexAgentMetadata(session.meta.codexAgent).value;
  const taskLabel = resolveCodexAgentTaskLabel(metadata, "");
  if (taskLabel) return taskLabel;

  return snippet ?? fileNameFallback;
}

function isUiTitleGenerationPrompt(text: string): boolean {
  return /^Generate a concise UI title \(20-40 characters\) for this task\b/iu.test(text.trim());
}

export function resolveSessionDisplayTitles(params: {
  sessions: readonly SessionSummary[];
  titleSource: HistoryTitleSource;
  codexTitlesById?: ReadonlyMap<string, string | null>;
  getCustomTitle?: (session: SessionSummary) => string | undefined;
}): SessionSummary[] {
  return params.sessions.map((session) =>
    resolveSessionDisplayTitle({
      session,
      titleSource: params.titleSource,
      codexTitlesById: params.codexTitlesById,
      customTitle: params.getCustomTitle?.(session),
    }),
  );
}
