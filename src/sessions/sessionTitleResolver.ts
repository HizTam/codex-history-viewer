import * as path from "node:path";
import {
  resolveCodexAgentTaskLabel,
  sanitizeCachedCodexAgentMetadata,
} from "../agents/codexAgentMetadata";
import type { HistoryTitleSource } from "../settings";
import { isCodexProtocolContextStartText, normalizeWhitespace } from "../utils/textUtils";
import type { PreviewMessage, SessionSummary } from "./sessionTypes";

function sanitizeTitle(value: unknown): string | undefined {
  const normalized = normalizeWhitespace(typeof value === "string" ? value : "").trim();
  if (!normalized) return undefined;
  return normalized.length > 300 ? `${normalized.slice(0, 299)}...` : normalized;
}

export function isSessionProtocolContextTitle(value: unknown): boolean {
  const normalized = normalizeWhitespace(typeof value === "string" ? value : "").trim();
  return isCodexProtocolContextStartText(normalized);
}

export function resolvePreviewSessionTitleCandidate(messages: readonly PreviewMessage[]): string | undefined {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    const userText = sanitizeTitle(message.text);
    if (!userText || isSessionProtocolContextTitle(userText)) continue;
    if (isUiTitleGenerationPrompt(userText)) {
      const nextAssistant = messages
        .slice(index + 1)
        .find((candidate) => candidate.role === "assistant" && sanitizeTitle(candidate.text));
      const generatedTitle = sanitizeTitle(nextAssistant?.text);
      if (generatedTitle && !isSessionProtocolContextTitle(generatedTitle)) return generatedTitle;
    }
    return userText;
  }
  return undefined;
}

function resolveNativeTitle(
  session: SessionSummary,
  codexTitlesById: ReadonlyMap<string, string>,
): string | undefined {
  if (session.source === "codex") {
    const sessionId = typeof session.meta.id === "string" ? session.meta.id.trim() : "";
    const nativeTitle = sanitizeTitle((sessionId && codexTitlesById.get(sessionId)) ?? session.nativeTitle);
    return nativeTitle && !isSessionProtocolContextTitle(nativeTitle) ? nativeTitle : undefined;
  }

  return sanitizeTitle(session.nativeTitle);
}

export function resolveSessionDisplayTitle(params: {
  session: SessionSummary;
  titleSource: HistoryTitleSource;
  codexTitlesById?: ReadonlyMap<string, string>;
  customTitle?: string;
}): SessionSummary {
  const codexTitlesById = params.codexTitlesById ?? new Map<string, string>();
  const nativeTitle = resolveNativeTitle(params.session, codexTitlesById);
  const generatedTitle = resolveGeneratedTitle(params.session);
  const originalTitle = params.titleSource === "nativeWhenAvailable" ? nativeTitle ?? generatedTitle : generatedTitle;
  const customTitle = sanitizeTitle(params.customTitle);
  const displayTitle = customTitle ?? originalTitle;

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
  const snippet = sanitizeTitle(session.snippet);
  const snippetIsUsable = Boolean(
    snippet &&
    !isSessionProtocolContextTitle(snippet) &&
    snippet !== fileNameFallback,
  );
  if (snippetIsUsable) return snippet!;

  const previewTitle = resolvePreviewSessionTitleCandidate(session.previewMessages);
  if (previewTitle) return previewTitle;

  const metadata = sanitizeCachedCodexAgentMetadata(session.meta.codexAgent).value;
  const taskLabel = resolveCodexAgentTaskLabel(metadata, "");
  if (taskLabel) return taskLabel;

  if (snippet && !isSessionProtocolContextTitle(snippet)) return snippet;
  return fileNameFallback;
}

function isUiTitleGenerationPrompt(text: string): boolean {
  return /^Generate a concise UI title \(20-40 characters\) for this task\b/iu.test(text.trim());
}

export function resolveSessionDisplayTitles(params: {
  sessions: readonly SessionSummary[];
  titleSource: HistoryTitleSource;
  codexTitlesById?: ReadonlyMap<string, string>;
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
