import { normalizeCacheKey } from "../utils/fsUtils";
import {
  FILE_CHANGE_HISTORY_PAGE_SIZE,
  type FileChangeHistoryCandidate,
  type FileChangeHistoryCard,
  type FileChangeHistoryOrigin,
} from "./fileChangeHistoryTypes";

export function sanitizeFileChangeHistoryOrigin(value: unknown): FileChangeHistoryOrigin | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const validText = (text: unknown): text is string =>
    typeof text === "string" && text.length > 0 && text.length <= 32_768 && !/[\u0000-\u001f\u007f]/u.test(text);
  if (!validText(source.sessionFsPath) || !validText(source.entryId)) return undefined;
  return { sessionFsPath: source.sessionFsPath, entryId: source.entryId };
}

export function prioritizeFileChangeHistoryOrigin(
  candidates: FileChangeHistoryCandidate[],
  origin: FileChangeHistoryOrigin | undefined,
): FileChangeHistoryCandidate[] {
  if (!origin) return candidates;
  // Origins only select an already eligible candidate; they never authorize a file read.
  const key = normalizeCacheKey(origin.sessionFsPath);
  const index = candidates.findIndex(candidate => normalizeCacheKey(candidate.session.fsPath) === key);
  if (index <= 0) return candidates;
  return [candidates[index]!, ...candidates.slice(0, index), ...candidates.slice(index + 1)];
}

export function selectFileChangeHistoryWindow(
  cards: FileChangeHistoryCard[],
  entryId: string,
): { cards: FileChangeHistoryCard[]; revealCardId?: string } {
  const index = cards.findIndex(card => card.entry.id === entryId);
  if (index < 0 || cards.some((card, other) => other !== index && card.entry.id === entryId)) return { cards };
  // Keep the first window fixed so restoring N cards reproduces N-card pagination.
  const start = Math.max(0, Math.min(index - Math.floor(FILE_CHANGE_HISTORY_PAGE_SIZE / 2), cards.length - FILE_CHANGE_HISTORY_PAGE_SIZE));
  const end = start + FILE_CHANGE_HISTORY_PAGE_SIZE;
  return {
    cards: cards.slice(start, end).concat(cards.slice(0, start), cards.slice(end)),
    revealCardId: cards[index]!.id,
  };
}
