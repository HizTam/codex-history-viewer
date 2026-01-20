// Text helpers for display (normalization, snippets, etc.).

export function normalizeWhitespace(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function singleLineSnippet(s: string, maxLen: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, Math.max(0, maxLen - 1))}…`;
}

export function safeDisplayPath(fsPath: string, maxLen: number): string {
  // For long paths, prefer showing the tail by trimming the head.
  if (fsPath.length <= maxLen) return fsPath;
  const tailLen = Math.max(10, Math.floor(maxLen * 0.75));
  return `…${fsPath.slice(-tailLen)}`;
}

export function extractMyRequestForCodex(text: string): string | null {
  const s = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = s.split("\n");
  const marker = /^(?:#+\s*)?My request for Codex:\s*$/i;

  let markerIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? "").trim();
    if (marker.test(line)) {
      markerIndex = i;
      break;
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

function isWideCodePoint(codePoint: number): boolean {
  // 日本語: 「全角っぽい」文字をざっくり判定して、表示幅の近似に使う。
  // 厳密な East Asian Width の実装ではないが、ツリー表示の省略には十分。
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
  // 日本語: 文字列を「表示幅（半角=1/全角=2）」の近似で省略し、末尾に "..." を付ける。
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
