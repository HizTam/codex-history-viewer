import { projectAntigravityChat } from "./antigravityChatModel";
import type { AntigravitySessionData } from "./antigravityReaderTypes";
import type { IndexedFileChangeHint, IndexedSearchMessage } from "../services/searchIndexService";
import type { SearchIndexToolContent } from "../settings";
import { normalizeWhitespace } from "../utils/textUtils";

export function buildAntigravitySearch(data: AntigravitySessionData, file: string, root: string, mode: SearchIndexToolContent): { messages: IndexedSearchMessage[]; fileChangeHints: IndexedFileChangeHint[] } {
  const { model } = projectAntigravityChat(data, file, root, { includeDetails: false, images: { enabled: false, maxSizeMB: 1, thumbnailSize: "small" } });
  const messages: IndexedSearchMessage[] = [], fileChangeHints: IndexedFileChangeHint[] = [];
  for (const item of model.items) {
    if (item.type === "message" && (item.role === "user" || item.role === "assistant")) {
      messages.push({ role: item.role, messageIndex: item.messageIndex!, source: "message", text: normalizeWhitespace(item.text) });
    } else if (item.type === "antigravityProgress" && item.kind !== "redactedThinking" && item.body) {
      const previous = messages.at(-1)?.messageIndex ?? 0;
      messages.push({ role: item.kind === "queuedInput" ? "user" : "assistant", messageIndex: previous,
        source: "message", text: normalizeWhitespace(item.body), progressId: item.progressId, progressKind: item.kind });
    } else if (item.type === "tool") {
      if (mode !== "conversationOnly" && item.argumentsText) messages.push({ role: "tool", messageIndex: item.messageIndex ?? 0, source: "toolArguments", text: normalizeWhitespace(item.argumentsText) });
      if (mode === "toolCallsAndOutputs" && item.outputText) messages.push({ role: "tool", messageIndex: item.messageIndex ?? 0, source: "toolOutput", text: normalizeWhitespace(item.outputText) });
    } else if (item.type === "patchGroup") {
      fileChangeHints.push({ messageIndex: item.messageIndex ?? 0, paths: item.entries.map(entry => entry.path), timestampIso: item.timestampIso, origin: "toolOutput", hasDiffLikeContent: true });
    }
  }
  return { messages, fileChangeHints };
}
