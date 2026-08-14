import { isValidByteCount } from "../utils/formatBytes";
import { compareNullableSessionSortKeys, getSessionCreatedSortKey } from "./sessionSortKeys";
import type { SessionSummary } from "./sessionTypes";

export type FileSizeSortDirection = "asc" | "desc";

export function normalizeSessionFileSizeBytes(value: unknown): number | null {
  return isValidByteCount(value) ? value : null;
}

export function compareSessionFileSizeBytes(
  left: unknown,
  right: unknown,
  direction: FileSizeSortDirection,
): number {
  const leftSize = normalizeSessionFileSizeBytes(left);
  const rightSize = normalizeSessionFileSizeBytes(right);
  if (leftSize === null) return rightSize === null ? 0 : 1;
  if (rightSize === null) return -1;
  if (leftSize === rightSize) return 0;
  if (direction === "asc") return leftSize < rightSize ? -1 : 1;
  return leftSize > rightSize ? -1 : 1;
}

export function totalSessionFileSizeBytes(values: readonly unknown[]): number | null {
  if (values.length === 0) return null;

  let total = 0;
  for (const value of values) {
    const size = normalizeSessionFileSizeBytes(value);
    if (size === null) return null;
    total = total > Number.MAX_SAFE_INTEGER - size ? Number.MAX_SAFE_INTEGER : total + size;
  }
  return total;
}

export function compareSessionSummariesByFileSize(
  left: SessionSummary,
  right: SessionSummary,
  direction: FileSizeSortDirection,
): number {
  const fileSize = compareSessionFileSizeBytes(left.fileSizeBytes, right.fileSizeBytes, direction);
  if (fileSize !== 0) return fileSize;

  const title = compareLabels(left.displayTitle, right.displayTitle);
  if (title !== 0) return title;

  const created = compareNullableSessionSortKeys(getSessionCreatedSortKey(left), getSessionCreatedSortKey(right), "desc");
  if (created !== 0) return created;
  return left.fsPath.localeCompare(right.fsPath);
}

function compareLabels(left: string, right: string): number {
  return String(left ?? "").localeCompare(String(right ?? ""), undefined, { sensitivity: "base", numeric: true });
}
