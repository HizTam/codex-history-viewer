import type { SessionSummary } from "./sessionTypes";
import { formatYmdHmsInTimeZone } from "../utils/dateUtils";
import { resolveDateTimeSettings } from "../utils/dateTimeSettings";

export type SessionSortKey = string;
export type SortDirection = "asc" | "desc";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

export function getSessionCreatedSortKey(session: SessionSummary): SessionSortKey | null {
  return (
    buildDisplayDateTimeSortKey(session.startedLocalDate, session.startedTimeLabel) ??
    buildDisplayDateTimeSortKey(session.localDate, session.timeLabel) ??
    buildIsoDateTimeSortKey(session.startedAtIso)
  );
}

export function getSessionLastActivitySortKey(session: SessionSummary): SessionSortKey | null {
  return (
    buildDisplayDateTimeSortKey(session.lastActivityLocalDate, session.lastActivityTimeLabel) ??
    getSessionCreatedSortKey(session) ??
    buildIsoDateTimeSortKey(session.lastActivityAtIso)
  );
}

export function getSessionDisplayDateSortKey(session: SessionSummary): SessionSortKey | null {
  return buildDisplayDateTimeSortKey(session.localDate, session.timeLabel);
}

export function compareNullableSessionSortKeys(
  left: SessionSortKey | null,
  right: SessionSortKey | null,
  direction: SortDirection,
): number {
  const leftValid = isValidSortKey(left);
  const rightValid = isValidSortKey(right);
  if (!leftValid && !rightValid) return 0;
  if (!leftValid) return 1;
  if (!rightValid) return -1;
  if (left === right) return 0;
  return direction === "asc" ? left.localeCompare(right) : right.localeCompare(left);
}

export function minSessionSortKey(current: SessionSortKey | null, candidate: SessionSortKey | null): SessionSortKey | null {
  if (!isValidSortKey(candidate)) return current;
  if (!isValidSortKey(current)) return candidate;
  return candidate < current ? candidate : current;
}

export function maxSessionSortKey(current: SessionSortKey | null, candidate: SessionSortKey | null): SessionSortKey | null {
  if (!isValidSortKey(candidate)) return current;
  if (!isValidSortKey(current)) return candidate;
  return candidate > current ? candidate : current;
}

function buildDisplayDateTimeSortKey(dateValue: unknown, timeValue: unknown): SessionSortKey | null {
  const date = typeof dateValue === "string" ? dateValue.trim() : "";
  const dateMatch = DATE_RE.exec(date);
  if (!dateMatch) return null;

  const time = typeof timeValue === "string" ? timeValue.trim() : "";
  const timeMatch = TIME_RE.exec(time);
  const hour = timeMatch?.[1] ?? "00";
  const minute = timeMatch?.[2] ?? "00";
  const second = timeMatch?.[3] ?? "00";
  return `${dateMatch[1]}${dateMatch[2]}${dateMatch[3]}${hour}${minute}${second}`;
}

function buildIsoDateTimeSortKey(value: unknown): SessionSortKey | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  const formatted = formatYmdHmsInTimeZone(new Date(ms), resolveDateTimeSettings().timeZone);
  return buildDisplayDateTimeSortKey(formatted.slice(0, 10), formatted.slice(11));
}

function isValidSortKey(value: SessionSortKey | null): value is SessionSortKey {
  return typeof value === "string" && value.length > 0;
}
