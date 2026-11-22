// Text helpers for display (normalization, snippets, etc.).

const CODEX_SESSION_START_CONTEXT_TAGS = [
  "recommended_plugins",
  "permissions instructions",
  "collaboration_mode",
  "skills_instructions",
  "apps_instructions",
  "plugins_instructions",
  "multi_agent_mode",
  "environment_context",
  "user_instructions",
  "instructions",
] as const;

const CODEX_SESSION_START_MARKER_TAGS = [
  "recommended_plugins",
  "permissions instructions",
  "collaboration_mode",
  "skills_instructions",
  "apps_instructions",
  "plugins_instructions",
  "multi_agent_mode",
] as const;

export function normalizeWhitespace(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function singleLineSnippet(s: string, maxLen: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, Math.max(0, maxLen - 1))}...`;
}

export function safeDisplayPath(fsPath: string, maxLen: number): string {
  // For long paths, prefer showing the tail by trimming the head.
  if (fsPath.length <= maxLen) return fsPath;
  const tailLen = Math.max(10, Math.floor(maxLen * 0.75));
  return `...${fsPath.slice(-tailLen)}`;
}

export function extractMyRequestForCodex(text: string): string | null {
  const s = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = s.split("\n");
  const marker = /^(?:#+\s*)?My request(?: for Codex)?:\s*$/i;

  let markerIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? "").trim();
    if (marker.test(line)) {
      markerIndex = i;
    }
  }
  if (markerIndex < 0) return null;

  const body = lines.slice(markerIndex + 1).join("\n").trim();
  return body.length > 0 ? body : null;
}

export function extractTaskSectionText(text: string): string | null {
  // Extract a Markdown "Task" section (e.g. "# Task" / "## Task") and return only its body.
  // This is used for the compact user view when "details" are hidden.
  const normalized = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");

  const isFenceLine = (line: string): boolean => /^\s*```/.test(line);

  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = String(lines[i] ?? "");
    if (isFenceLine(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const m = line.match(/^(#{1,6})\s*Task\s*$/i);
    if (!m) continue;
    const level = m[1]!.length;

    let start = i + 1;
    for (; start < lines.length; start += 1) {
      if (String(lines[start] ?? "").trim().length !== 0) break;
    }

    let end = lines.length;
    inFence = false;
    for (let j = start; j < lines.length; j += 1) {
      const l = String(lines[j] ?? "");
      if (isFenceLine(l)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;

      const hm = l.match(/^(#{1,6})\s+.+/);
      if (hm && hm[1]!.length <= level) {
        end = j;
        break;
      }
    }

    const body = lines.slice(start, end).join("\n").trim();
    return body.length > 0 ? body : null;
  }

  const inline = normalized.match(/(?:^|\n)Task\s*:\s*([^\n]+)/i);
  if (inline) {
    const body = String(inline[1] ?? "").trim();
    return body.length > 0 ? body : null;
  }

  return null;
}

export function extractUserRequestText(text: string): string | null {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) return null;

  const byMarker = extractMyRequestForCodex(normalized);
  if (byMarker) return byMarker;

  const byHeading = extractUserContentFromHeading(normalized);
  if (byHeading) return byHeading;

  return null;
}

export function isBoilerplateUserMessageText(text: string): boolean {
  const t = String(text ?? "").trimStart();
  if (!t) return false;
  // Derived or source-agnostic text has lost the provenance of a Codex Page snapshot.
  if (parseCodexProtocolContextText(t, false) !== null) return true;
  // Treat meta tags as boilerplate only when the line contains only the tag payload.
  if (t.startsWith("<ide_opened_file>")) return stripTransportMetaTags(t).length === 0;
  if (t.startsWith("<local-command-caveat>")) return stripTransportMetaTags(t).length === 0;
  if (/^<command-(name|message|args)>/i.test(t)) return stripTransportMetaTags(t).length === 0;
  return false;
}

export function isCodexProtocolContextStartText(value: unknown, includePageSnapshots = false): boolean {
  const text = String(value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimStart();
  if (!text) return false;
  const lower = text.toLowerCase();
  if (lower.startsWith("<external_codex_apps_open_page>") || includePageSnapshots && text.startsWith(CODEX_PAGE_SNAPSHOT_PREFIX)) {
    return parseCodexProtocolContextText(text, includePageSnapshots) !== null;
  }
  if (CODEX_SESSION_START_CONTEXT_TAGS.some((tagName) => lower.startsWith(`<${tagName}>`))) return true;
  return /^# AGENTS\.md instructions(?:[^\n]*)?(?:\n|$)/iu.test(text);
}

const CODEX_PAGE_SNAPSHOT_PREFIX = "<external_codex_apps_selected_page_part_";

export function hasCodexPageSnapshotPrefix(value: unknown): value is string {
  return typeof value === "string" && value.trimStart().startsWith(CODEX_PAGE_SNAPSHOT_PREFIX);
}

export function isCodexSelectedPageSnapshotText(value: unknown): boolean {
  return hasCodexPageSnapshotPrefix(value) && isCodexProtocolContextText(value);
}

export function isCodexProtocolContextText(text: string): boolean {
  return parseCodexProtocolContextText(text) !== null;
}

export function isCodexSessionStartContextText(text: string): boolean {
  return parseCodexProtocolContextText(text)?.hasSessionStartMarker === true;
}

function parseCodexProtocolContextText(text: string, includePageSnapshots = true): { blockCount: number; hasSessionStartMarker: boolean } | null {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) return null;
  const folded = normalized.toLowerCase();
  // Length-changing case-folds inside snapshot JSON must not shift tag offsets.
  const lower = folded.length === normalized.length ? folded : normalized.replace(/[A-Z]/g, character => character.toLowerCase());

  let blockCount = 0;
  let hasSessionStartMarker = false;
  let cursor = 0;
  while (cursor < normalized.length) {
    const consumed = consumeCodexSessionStartContextBlock(normalized, lower, cursor, includePageSnapshots);
    if (!consumed || consumed.end <= cursor) return null;
    blockCount += 1;
    hasSessionStartMarker = hasSessionStartMarker || consumed.isSessionStartMarker;
    cursor = skipWhitespace(normalized, consumed.end);
  }
  return blockCount > 0 ? { blockCount, hasSessionStartMarker } : null;
}

export function isCodexTurnAbortedMessageText(text: string): boolean {
  return isSingleXmlLikeBlock(text, "turn_aborted");
}

export function isCodexUserInstructionsMessageText(text: string): boolean {
  return isSingleXmlLikeBlock(text, "user_instructions");
}

export function getClaudeRequestInterruptedScope(text: string): "request" | "toolUse" | null {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (normalized === "[Request interrupted by user]") return "request";
  if (normalized === "[Request interrupted by user for tool use]") return "toolUse";
  return null;
}

export function isClaudeRequestInterruptedMessageText(text: string): boolean {
  return getClaudeRequestInterruptedScope(text) !== null;
}

function isSingleXmlLikeBlock(text: string, tagName: string): boolean {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) return false;
  const openTag = `<${tagName}>`;
  const closeTag = `</${tagName}>`;
  if (!normalized.startsWith(openTag) || !normalized.endsWith(closeTag)) return false;
  const body = normalized.slice(openTag.length, normalized.length - closeTag.length);
  return !body.includes(openTag) && !body.includes(closeTag);
}

function consumeCodexSessionStartContextBlock(
  text: string,
  lower: string,
  cursor: number,
  includePageSnapshots: boolean,
): { end: number; isSessionStartMarker: boolean } | null {
  const pageTag = "external_codex_apps_open_page";
  const pageOpen = `<${pageTag}>`;
  if (lower.startsWith(pageOpen, cursor)) {
    const contentStart = cursor + pageOpen.length;
    const closeTag = `</${pageTag}>`;
    const closeIndex = lower.indexOf(closeTag, contentStart);
    if (closeIndex < 0 || closeIndex - contentStart > 4_096) return null;
    try {
      const payload: unknown = JSON.parse(text.slice(contentStart, closeIndex));
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
      const keys = Object.keys(payload);
      if (keys.length !== 1 || keys[0] !== "page_id") return null;
      const id = (payload as { page_id: unknown }).page_id;
      if (!isCodexPageId(id)) return null;
      return { end: closeIndex + closeTag.length, isSessionStartMarker: false };
    } catch {
      // Invalid or incomplete protocol data remains visible as ordinary input.
      return null;
    }
  }
  const pageSnapshot = /<external_codex_apps_selected_page_part_([1-9]\d{0,5})_of_([1-9]\d{0,5})>Companion Page snapshot part \1 of \2:\n/y;
  pageSnapshot.lastIndex = cursor;
  const snapshot = includePageSnapshots && text.startsWith(CODEX_PAGE_SNAPSHOT_PREFIX, cursor) ? pageSnapshot.exec(text) : null;
  if (snapshot) {
    if (Number(snapshot[1]) > Number(snapshot[2])) return null;
    const closeTag = `</external_codex_apps_selected_page_part_${snapshot[1]}_of_${snapshot[2]}>`;
    const contentStart = pageSnapshot.lastIndex;
    const closeIndex = findPageSnapshotJsonEnd(text, contentStart);
    if (closeIndex === undefined || !text.startsWith(closeTag, closeIndex)) return null;
    try {
      // Classify a complete snapshot envelope while preserving quoted or malformed input.
      const value: unknown = JSON.parse(text.slice(contentStart, closeIndex));
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const payload = value as Record<string, unknown>;
      if (Object.keys(payload).length !== 2 || !Object.hasOwn(payload, "page_id") || !Object.hasOwn(payload, "document_view")) return null;
      if (!isCodexPageId(payload.page_id)) return null;
      return { end: closeIndex + closeTag.length, isSessionStartMarker: false };
    } catch {
      return null;
    }
  }

  const xmlBlock = consumeKnownCodexContextXmlBlock(lower, cursor);
  if (xmlBlock) {
    return {
      end: xmlBlock.end,
      isSessionStartMarker: CODEX_SESSION_START_MARKER_TAGS.some((tagName) => tagName === xmlBlock.tagName),
    };
  }

  const headingPattern = /# AGENTS\.md instructions(?:[^\n]*)?(?:\n|$)/iuy;
  headingPattern.lastIndex = cursor;
  const heading = headingPattern.exec(text);
  if (!heading) return null;

  const blockStart = skipWhitespace(text, headingPattern.lastIndex);
  const instructions = consumeKnownCodexContextXmlBlock(lower, blockStart, "instructions");
  if (!instructions || instructions.end <= blockStart) return null;
  return { end: instructions.end, isSessionStartMarker: true };
}

// Find the end of the bounded JSON value before looking for the enclosing transport tag.
function findPageSnapshotJsonEnd(text: string, start: number): number | undefined {
  const limit = Math.min(text.length, start + 1_048_576);
  let cursor = start;
  while (cursor < limit && /[ \t\n\r]/u.test(text[cursor]!)) cursor++;
  if (text[cursor] !== "{") return undefined;
  let depth = 0, quoted = false;
  for (; cursor < limit; cursor++) {
    const character = text[cursor];
    if (quoted) {
      if (character === "\\") cursor++;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{" || character === "[") depth++;
    else if (character === "}" || character === "]") {
      if (--depth !== 0) continue;
      cursor++;
      while (cursor < limit && /[ \t\n\r]/u.test(text[cursor]!)) cursor++;
      return cursor;
    }
  }
  return undefined;
}

function isCodexPageId(value: unknown): boolean {
  return value === null || (typeof value === "string" && value.length <= 1_024 && Boolean(value.trim()) && !/[\u0000-\u001f\u007f]/u.test(value));
}

function consumeKnownCodexContextXmlBlock(
  lower: string,
  cursor: number,
  requiredTagName?: string,
): { end: number; tagName: (typeof CODEX_SESSION_START_CONTEXT_TAGS)[number] } | null {
  for (const tagName of CODEX_SESSION_START_CONTEXT_TAGS) {
    if (requiredTagName && tagName !== requiredTagName) continue;
    const openTag = `<${tagName}>`;
    if (!lower.startsWith(openTag, cursor)) continue;

    const closeTag = `</${tagName}>`;
    const contentStart = cursor + openTag.length;
    const closeIndex = lower.indexOf(closeTag, contentStart);
    if (closeIndex < 0) return { end: -1, tagName };
    const nestedOpenIndex = lower.indexOf(openTag, contentStart);
    if (nestedOpenIndex >= 0 && nestedOpenIndex < closeIndex) return { end: -1, tagName };
    return { end: closeIndex + closeTag.length, tagName };
  }
  return null;
}

function skipWhitespace(text: string, cursor: number): number {
  let next = cursor;
  while (next < text.length && /\s/u.test(text[next]!)) next += 1;
  return next;
}

export function stripTransportMetaTags(text: string): string {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let out = normalized;
  // Remove full-line transport metadata blocks.
  out = out.replace(/^[ \t]*<ide_opened_file>[\s\S]*?<\/ide_opened_file>[ \t]*(?:\n|$)/gim, "");
  out = out.replace(/^[ \t]*<local-command-caveat>[\s\S]*?<\/local-command-caveat>[ \t]*(?:\n|$)/gim, "");
  out = out.replace(/^[ \t]*<(command-name|command-message|command-args)>[\s\S]*?<\/\1>[ \t]*(?:\n|$)/gim, "");
  // Keep adjacent closing tags from merging with user-visible text.
  out = out.replace(
    /(<\/(?:ide_opened_file|local-command-caveat|command-name|command-message|command-args)>)(?![ \t]*\n)/gi,
    "$1\n",
  );
  return normalizeWhitespace(out);
}

export function extractCompactUserText(text: string, options?: { preserveClaudeInterruptionText?: boolean }): string | null {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) return null;

  // Prefer explicit Task/Request sections when present.
  const base = extractTaskSectionText(normalized) ?? extractUserRequestText(normalized) ?? normalized;
  const compact = stripTransportMetaTags(base);
  // Suppress boilerplate-only user messages after metadata cleanup.
  if (isBoilerplateUserMessageText(compact)) return null;
  if (isCodexTurnAbortedMessageText(compact)) return null;
  if (!options?.preserveClaudeInterruptionText && isClaudeRequestInterruptedMessageText(compact)) return null;
  return compact.length > 0 ? compact : null;
}

function isWideCodePoint(codePoint: number): boolean {
  // Roughly detect "wide" characters to approximate display width.
  // Not a strict East Asian Width implementation, but sufficient for truncating tree labels.
  if (codePoint >= 0x1100 && codePoint <= 0x115f) return true; // Hangul Jamo
  if (codePoint >= 0x2e80 && codePoint <= 0xa4cf) return true; // CJK / Yi / etc
  if (codePoint >= 0xac00 && codePoint <= 0xd7a3) return true; // Hangul Syllables
  if (codePoint >= 0xf900 && codePoint <= 0xfaff) return true; // CJK Compatibility Ideographs
  if (codePoint >= 0xfe10 && codePoint <= 0xfe19) return true; // Vertical forms
  if (codePoint >= 0xfe30 && codePoint <= 0xfe6f) return true; // CJK Compatibility Forms
  if (codePoint >= 0xff01 && codePoint <= 0xff60) return true; // Fullwidth forms
  if (codePoint >= 0xffe0 && codePoint <= 0xffe6) return true; // Fullwidth symbols
  if (codePoint >= 0x1f300 && codePoint <= 0x1faff) return true; // Emoji (rough)
  if (codePoint >= 0x20000 && codePoint <= 0x3fffd) return true; // CJK Ext (rough)
  return false;
}

export function truncateByDisplayWidth(text: string, maxHalfWidthUnits: number, suffix = "..."): string {
  // Truncate a string by approximate display width (half-width=1, full-width=2) and append a suffix (default: "...").
  const s = String(text ?? "");
  const max = Number.isFinite(maxHalfWidthUnits) ? Math.floor(maxHalfWidthUnits) : 0;
  if (max <= 0) return "";

  let width = 0;
  let end = 0; // UTF-16 index
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    const w = isWideCodePoint(cp) ? 2 : 1;
    if (width + w > max) return `${s.slice(0, end)}${suffix}`;
    width += w;
    end += ch.length;
  }
  return s;
}

function extractUserContentFromHeading(text: string): string | null {
  // Handles a common markdown wrapper like:
  // ## [#8] User
  // - Timestamp: `...`
  //
  // <actual user input>
  const lines = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const firstNonEmpty = lines.findIndex((l) => String(l ?? "").trim().length > 0);
  if (firstNonEmpty < 0) return null;

  const head = String(lines[firstNonEmpty] ?? "").trim();
  if (!/^#+\s*\[#\d+\]\s*User\s*$/i.test(head)) return null;

  let i = firstNonEmpty + 1;
  for (; i < lines.length; i += 1) {
    const line = String(lines[i] ?? "");
    if (line.trim().length === 0) break;
  }
  // Skip the first empty line after metadata.
  for (; i < lines.length; i += 1) {
    if (String(lines[i] ?? "").trim().length !== 0) break;
  }

  const body = lines.slice(i).join("\n").trim();
  return body.length > 0 ? body : null;
}
