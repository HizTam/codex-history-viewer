interface TextRange {
  readonly start: number;
  readonly end: number;
}

interface CodeRun extends TextRange {
  readonly blockIndex: number;
  next?: number;
}

const FOLLOWUP_PREFIX = ":codex-followup[";
const MAX_DIRECTIVE_LENGTH = 65_536;

// Project display text only; the embedded prompt is never an executable action.
export function projectCodexFollowupText(text: string): string {
  const ranges = findFollowupRemovals(text);
  return ranges.length ? removeRanges(text, ranges) : text;
}

// Map removals back to the original text items without moving image attachments.
export function projectCodexFollowupContent(content: unknown): unknown {
  if (typeof content === "string") return projectCodexFollowupText(content);
  const items = Array.isArray(content) ? content : [content];
  const texts = items.map(readItemText);
  const ranges = findFollowupRemovals(texts.join(""));
  if (!ranges.length) return content;
  let offset = 0;
  let rangeIndex = 0;
  const projected = items.map((item, index) => {
    const text = texts[index]!;
    if (!text) return item;
    const end = offset + text.length;
    const localRanges: TextRange[] = [];
    while (rangeIndex < ranges.length && ranges[rangeIndex]!.start < end) {
      const range = ranges[rangeIndex]!;
      if (range.end > offset) {
        localRanges.push({ start: Math.max(0, range.start - offset), end: Math.min(text.length, range.end - offset) });
      }
      if (range.end > end) break;
      rangeIndex += 1;
    }
    offset = end;
    return localRanges.length
      ? { ...(item as Record<string, unknown>), text: removeRanges(text, localRanges) }
      : item;
  });
  return Array.isArray(content) ? projected : projected[0];
}

function readItemText(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  const text = (item as Record<string, unknown>).text;
  return typeof text === "string" ? text : "";
}

function findFollowupRemovals(text: string): TextRange[] {
  if (!text.includes(FOLLOWUP_PREFIX)) return [];
  const protectedRanges = findMarkdownProtectedBlocks(text);
  const runs = findCodeRuns(text, protectedRanges);
  const removals: TextRange[] = [];
  let protectedIndex = 0;
  let runIndex = 0;
  let cursor = 0;
  let start = text.indexOf(FOLLOWUP_PREFIX);
  while (cursor < text.length) {
    if (start < cursor) start = text.indexOf(FOLLOWUP_PREFIX, cursor);
    if (start < 0) break;
    while (runIndex < runs.length && runs[runIndex]!.start < cursor) runIndex += 1;
    const run = runs[runIndex];
    if (run && run.start < start) {
      cursor = run.next !== undefined && !isEscaped(text, run.start) ? runs[run.next]!.end : run.end;
      continue;
    }
    while (protectedIndex < protectedRanges.length && protectedRanges[protectedIndex]!.end <= start) protectedIndex += 1;
    const protectedRange = protectedRanges[protectedIndex];
    if (protectedRange && protectedRange.start <= start) {
      cursor = protectedRange.end;
      continue;
    }
    if (text[start - 1] === ":" || isEscaped(text, start)) {
      cursor = start + FOLLOWUP_PREFIX.length;
      continue;
    }
    const parsed = parseFollowup(text, start);
    if (!parsed) {
      // An ambiguous directive owns the rest of its line; do not reinterpret its attributes.
      const newline = text.indexOf("\n", start);
      cursor = newline < 0 ? text.length : newline + 1;
      continue;
    }
    removals.push({ start, end: start + FOLLOWUP_PREFIX.length }, { start: parsed.labelEnd, end: parsed.end });
    cursor = parsed.end;
  }
  return removals;
}

function parseFollowup(text: string, start: number): { labelEnd: number; end: number } | undefined {
  const limit = Math.min(text.length, start + MAX_DIRECTIVE_LENGTH);
  const labelStart = start + FOLLOWUP_PREFIX.length;
  let cursor = labelStart;
  while (cursor < limit && text[cursor] !== "]") {
    if (text[cursor] === "\n" || text[cursor] === "\r" || text[cursor] === "[") return undefined;
    cursor += 1;
  }
  const labelEnd = cursor;
  if (!text.slice(labelStart, labelEnd).trim() || text[cursor] !== "]" || text[cursor + 1] !== "{") return undefined;
  cursor += 2;
  const keys = new Set<string>();
  let hasPrompt = false;
  while (cursor < limit) {
    while (text[cursor] === " " || text[cursor] === "\t") cursor += 1;
    if (cursor >= limit) return undefined;
    if (text[cursor] === "}") return hasPrompt ? { labelEnd, end: cursor + 1 } : undefined;
    const keyStart = cursor;
    if (!/[A-Za-z_]/u.test(text[cursor]!)) return undefined;
    while (cursor < limit && /[A-Za-z0-9_.-]/u.test(text[cursor]!)) cursor += 1;
    const key = text.slice(keyStart, cursor);
    if (keys.has(key)) return undefined;
    keys.add(key);
    while (text[cursor] === " " || text[cursor] === "\t") cursor += 1;
    if (text[cursor] !== "=") return undefined;
    cursor += 1;
    while (text[cursor] === " " || text[cursor] === "\t") cursor += 1;
    const quote = text[cursor];
    if (quote !== '"' && quote !== "'") return undefined;
    cursor += 1;
    let hasValue = false;
    while (cursor < limit && text[cursor] !== quote) {
      const char = text[cursor]!;
      if (char === "\r" || char === "\n") return undefined;
      if (char.trim()) hasValue = true;
      cursor += char === "\\" && text[cursor + 1] === quote ? 2 : 1;
    }
    if (cursor >= limit || text[cursor] !== quote) return undefined;
    cursor += 1;
    if (key === "prompt") {
      if (!hasValue) return undefined;
      hasPrompt = true;
    }
    if (text[cursor] !== "}" && text[cursor] !== " " && text[cursor] !== "\t") return undefined;
  }
  return undefined;
}

function findMarkdownProtectedBlocks(text: string): TextRange[] {
  const blocks: TextRange[] = [];
  let fence: { start: number; marker: string; length: number } | undefined;
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline + 1;
    const line = text.slice(start, end);
    let content = line.trimStart();
    while (content.startsWith(">")) content = content.slice(1).trimStart();
    const listPrefix = /^(?:[-+*]|\d{1,9}[.)])[ \t]+/u.exec(content);
    if (listPrefix) content = content.slice(listPrefix[0].length).trimStart();
    const marker = /^(?:`{3,}|~{3,})/u.exec(content)?.[0];
    if (fence) {
      if (marker?.[0] === fence.marker && marker.length >= fence.length && !content.slice(marker.length).trim()) {
        blocks.push({ start: fence.start, end });
        fence = undefined;
      }
    } else if (marker && (marker[0] !== "`" || !content.slice(marker.length).includes("`"))) {
      fence = { start, marker: marker[0]!, length: marker.length };
    } else if (!line.trim() || /^(?: {4}|\t| {0,3}>)/u.test(line)) {
      blocks.push({ start, end });
    }
    start = end;
  }
  if (fence) blocks.push({ start: fence.start, end: text.length });
  return blocks;
}

function findCodeRuns(text: string, blocks: readonly TextRange[]): CodeRun[] {
  // Precompute matching run lengths, including escaped closers inside a code span.
  const runs: CodeRun[] = [];
  const backticks = /`+/gu;
  let blockIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = backticks.exec(text))) {
    while (blockIndex < blocks.length && blocks[blockIndex]!.end <= match.index) blockIndex += 1;
    if (blocks[blockIndex] && blocks[blockIndex]!.start <= match.index) continue;
    runs.push({ start: match.index, end: match.index + match[0].length, blockIndex });
  }
  const nextByLength = new Map<number, number>();
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]!;
    if (run.blockIndex !== runs[index + 1]?.blockIndex) nextByLength.clear();
    run.next = nextByLength.get(run.end - run.start);
    nextByLength.set(run.end - run.start, index);
  }
  return runs;
}

function isEscaped(text: string, offset: number): boolean {
  let start = offset;
  while (start > 0 && text[start - 1] === "\\") start -= 1;
  return (offset - start) % 2 === 1;
}

function removeRanges(text: string, ranges: readonly TextRange[]): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    parts.push(text.slice(cursor, range.start));
    cursor = range.end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}
