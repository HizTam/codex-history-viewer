import type { ChatMemoryCitation, ChatMemoryCitationEntry } from "./chatTypes";

const MAX_CITATION_PATH_LENGTH = 512;
const MAX_CITATION_NOTE_LENGTH = 2_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEMORY_CITATION_OPEN_TAG = "<oai-mem-citation>";
const MEMORY_CITATION_CLOSE_TAG = "</oai-mem-citation>";
const MEMORY_CITATION_CLOSE_RE = /<\/oai-mem-citation>\s*$/i;

export function normalizeMemoryCitationPayload(value: unknown): ChatMemoryCitation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

  const source = value as Record<string, unknown>;
  const rawEntries = Array.isArray(source.entries) ? source.entries : [];
  const rawRolloutIds = Array.isArray(source.rolloutIds)
    ? source.rolloutIds
    : Array.isArray(source.rollout_ids)
      ? source.rollout_ids
      : [];

  const entries = rawEntries
    .map((entry) => normalizeMemoryCitationEntry(entry))
    .filter((entry): entry is ChatMemoryCitationEntry => entry !== undefined);
  const rolloutIds = normalizeRolloutIds(rawRolloutIds);

  if (entries.length === 0 && rolloutIds.length === 0) return undefined;
  return { entries, rolloutIds };
}

export function splitTrailingMemoryCitationBlock(text: string): {
  text: string;
  memoryCitation?: ChatMemoryCitation;
} {
  const normalizedText = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trailingBlock = findTrailingMemoryCitationBlock(normalizedText);
  if (!trailingBlock) return { text };

  const citation = parseMemoryCitationBlock(trailingBlock.block);
  if (!citation) return { text };

  return {
    text: normalizedText.slice(0, trailingBlock.start).trimEnd(),
    memoryCitation: citation,
  };
}

function findTrailingMemoryCitationBlock(text: string): { start: number; block: string } | null {
  const closeMatch = MEMORY_CITATION_CLOSE_RE.exec(text);
  if (!closeMatch || closeMatch.index < 0) return null;

  const closeStart = closeMatch.index;
  const lowerText = text.toLowerCase();
  let searchFrom = closeStart;
  while (searchFrom > 0) {
    const openStart = lowerText.lastIndexOf(MEMORY_CITATION_OPEN_TAG, searchFrom - 1);
    if (openStart < 0) return null;
    searchFrom = openStart;
    if (!isLineStart(text, openStart)) continue;

    const prefix = text.slice(0, openStart);
    if (isInsideFencedCodeBlock(prefix)) continue;

    return {
      start: openStart,
      block: text.slice(openStart + MEMORY_CITATION_OPEN_TAG.length, closeStart),
    };
  }

  return null;
}

function parseMemoryCitationBlock(block: string): ChatMemoryCitation | undefined {
  const entriesSection = readTagSection(block, "citation_entries");
  const rolloutIdsSection = readTagSection(block, "rollout_ids");

  const entries = entriesSection
    .split(/\n/)
    .map((line) => parseCitationEntryLine(line))
    .filter((entry): entry is ChatMemoryCitationEntry => entry !== undefined);
  const rolloutIds = normalizeRolloutIds(rolloutIdsSection.split(/\n/));

  if (entries.length === 0 && rolloutIds.length === 0) return undefined;
  return { entries, rolloutIds };
}

function readTagSection(block: string, tagName: string): string {
  const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`<${escapedTag}>\\s*([\\s\\S]*?)\\s*<\\/${escapedTag}>`, "i").exec(block);
  return match ? match[1] ?? "" : "";
}

function parseCitationEntryLine(line: string): ChatMemoryCitationEntry | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;

  const match = /^(.+):(\d+)(?:-(\d+))?(?:\|note=\[(.*)\])?$/.exec(trimmed);
  if (!match) return undefined;

  const path = clampText(match[1] ?? "", MAX_CITATION_PATH_LENGTH);
  if (!path) return undefined;

  const lineStart = normalizePositiveInteger(Number(match[2]));
  const rawLineEnd = match[3] !== undefined ? normalizePositiveInteger(Number(match[3])) : undefined;
  const lineEnd = rawLineEnd !== undefined && lineStart !== undefined ? Math.max(lineStart, rawLineEnd) : undefined;
  const note = clampText(match[4] ?? "", MAX_CITATION_NOTE_LENGTH);

  return {
    path,
    ...(lineStart !== undefined ? { lineStart } : {}),
    ...(lineEnd !== undefined ? { lineEnd } : {}),
    ...(note ? { note } : {}),
  };
}

function normalizeMemoryCitationEntry(value: unknown): ChatMemoryCitationEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;

  const path = clampText(typeof source.path === "string" ? source.path : "", MAX_CITATION_PATH_LENGTH);
  if (!path) return undefined;

  const lineStart = normalizePositiveInteger(source.lineStart);
  const rawLineEnd = normalizePositiveInteger(source.lineEnd);
  const lineEnd = rawLineEnd !== undefined && lineStart !== undefined ? Math.max(lineStart, rawLineEnd) : undefined;
  const note = clampText(typeof source.note === "string" ? source.note : "", MAX_CITATION_NOTE_LENGTH);

  return {
    path,
    ...(lineStart !== undefined ? { lineStart } : {}),
    ...(lineEnd !== undefined ? { lineEnd } : {}),
    ...(note ? { note } : {}),
  };
}

function normalizeRolloutIds(values: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const id = value.trim();
    if (!UUID_RE.test(id)) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

function clampText(value: string, maxLength: number): string {
  const text = value.trim();
  if (!text) return "";
  return text.length <= maxLength ? text : text.slice(0, maxLength);
}

function isLineStart(text: string, index: number): boolean {
  return index === 0 || text[index - 1] === "\n";
}

function isInsideFencedCodeBlock(prefix: string): boolean {
  let activeFence: "`" | "~" | undefined;
  for (const line of prefix.split("\n")) {
    const match = /^(?: {0,3})(`{3,}|~{3,})/.exec(line);
    if (!match) continue;
    const marker = (match[1] ?? "")[0] as "`" | "~" | undefined;
    if (!marker) continue;
    if (!activeFence) {
      activeFence = marker;
      continue;
    }
    if (activeFence === marker) activeFence = undefined;
  }
  return activeFence !== undefined;
}
