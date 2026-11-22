import type { ChatAntigravityTurnFileDiff } from "../chat/chatTypes";
import type { AntigravityFileEdit } from "./antigravityTypes";

type DiffRow = NonNullable<ChatAntigravityTurnFileDiff["rows"]>[number];
type DiffResult = Omit<ChatAntigravityTurnFileDiff, "path">;

export function composeAntigravityEditText(edits: readonly AntigravityFileEdit[]): { before: string; after: string } | undefined {
  let firstBefore: string[] | undefined, previousAfter: string[] | undefined, lastBefore: string[] | undefined;
  for (const edit of edits) {
    if (edit.start !== 0 || previousAfter && edit.kind === 1) return undefined;
    const before: string[] = [], after: string[] = [];
    for (const line of edit.lines) {
      if (line.kind !== 1) before.push(line.text);
      if (line.kind !== 2) after.push(line.text);
    }
    if (previousAfter && (previousAfter.length !== before.length || previousAfter.some((line, index) => line !== before[index]))) return undefined;
    firstBefore ??= before;
    previousAfter = after;
    lastBefore = before;
  }
  const last = edits.at(-1);
  if (!firstBefore || !previousAfter || !lastBefore || !last) return undefined;
  // The native block replaces a range in an LF split. Splitting the empty base retains one empty element.
  const applied = lastBefore.join("\n").split("\n");
  applied.splice(last.start, last.end - last.start, previousAfter.join("\n"));
  return { before: firstBefore.join("\n"), after: applied.join("\n") };
}

function uniqueLines(lines: readonly string[]): Map<string, number> {
  const unique = new Map<string, number>();
  for (const [index, line] of lines.entries()) unique.set(line, unique.has(line) ? -1 : index);
  return unique;
}

function orderedAnchors(before: readonly string[], after: readonly string[]): readonly (readonly [number, number])[] {
  const left = uniqueLines(before), right = uniqueLines(after);
  const matches: Array<{ old: number; next: number; rank: number }> = [];
  const ends: number[] = [];
  for (const [index, line] of before.entries()) {
    const next = right.get(line);
    if (left.get(line) !== index || next === undefined || next < 0) continue;
    let low = 0, high = ends.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (ends[middle]! < next) low = middle + 1;
      else high = middle;
    }
    ends[low] = next;
    matches.push({ old: index, next, rank: low + 1 });
  }
  // Resolve equal-length subsequences deterministically, from the end of the old text.
  const anchors: Array<readonly [number, number]> = [[before.length, after.length]];
  let rank = ends.length, nextLimit = after.length;
  for (let index = matches.length - 1; index >= 0 && rank > 0; index--) {
    const match = matches[index]!;
    if (match.rank !== rank || match.next >= nextLimit) continue;
    anchors.push([match.old, match.next]); rank--; nextLimit = match.next;
  }
  anchors.push([0, 0]);
  return anchors.reverse();
}

export function compareAntigravityTurnText(before: string, after: string, detailBudget: { bytes: number; rows: number }): DiffResult {
  if (before === after) return { stats: { added: 0, removed: 0 }, rows: [] };
  // A nonempty old file uses LF-terminated line identities, including the distinction at EOF.
  const oldLines = before.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const newLines = before ? after.match(/[^\n]*\n|[^\n]+$/g) ?? [] : after ? after.split("\n") : [];
  const byteCount = Buffer.byteLength(before, "utf8") + Buffer.byteLength(after, "utf8");
  const maxRows = oldLines.length + newLines.length;
  const rows: DiffRow[] | undefined = maxRows <= detailBudget.rows && byteCount <= detailBudget.bytes ? [] : undefined;
  if (rows) { detailBudget.rows -= maxRows; detailBudget.bytes -= byteCount; }
  function append(kind: DiffRow["kind"], lines: readonly string[], start: number, end: number): void {
    if (!rows) return;
    for (let index = start; index < end; index++) {
      const line = lines[index]!, terminated = line.endsWith("\n");
      rows.push({ kind, text: terminated ? line.slice(0, -1) : line,
        ...(before && !terminated ? { noFinalNewline: true } : {}) });
    }
  }
  if (!before) {
    // The native all-insert path counts the terminal empty split element separately.
    append("add", newLines, 0, newLines.length);
    return { stats: { added: newLines.length, removed: 0 }, rows };
  }
  let oldCursor = 0, nextCursor = 0, added = 0, removed = 0;
  for (const [old, next] of orderedAnchors(oldLines, newLines)) {
    if (old < oldCursor || next < nextCursor) continue;
    let oldStart = old, nextStart = next, oldEnd = old, nextEnd = next;
    while (oldStart > oldCursor && nextStart > nextCursor && oldLines[oldStart - 1] === newLines[nextStart - 1]) { oldStart--; nextStart--; }
    while (oldEnd < oldLines.length && nextEnd < newLines.length && oldLines[oldEnd] === newLines[nextEnd]) { oldEnd++; nextEnd++; }
    removed += oldStart - oldCursor;
    added += nextStart - nextCursor;
    append("delete", oldLines, oldCursor, oldStart);
    append("add", newLines, nextCursor, nextStart);
    append("context", oldLines, oldStart, oldEnd);
    oldCursor = oldEnd; nextCursor = nextEnd;
  }
  return { stats: { added, removed }, rows };
}
