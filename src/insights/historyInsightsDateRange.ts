import { matchesDateScope, type DateScope } from "../types/dateScope";
import type { HistoryInsightsDateRange } from "./historyInsightsTypes";

export function dateScopeToHistoryInsightsDateRange(scope: DateScope): HistoryInsightsDateRange {
  switch (scope.kind) {
    case "year":
      return { from: `${scope.yyyy}-01-01`, to: `${scope.yyyy}-12-31` };
    case "month": {
      const [year, month] = scope.ym.split("-").map(Number);
      const lastDay = daysInGregorianMonth(year, month);
      return { from: `${scope.ym}-01`, to: `${scope.ym}-${String(lastDay).padStart(2, "0")}` };
    }
    case "day":
      return { from: scope.ymd, to: scope.ymd };
    case "range":
      return { from: scope.from, to: scope.to };
    case "all":
    default:
      return { from: null, to: null };
  }
}

function daysInGregorianMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function sanitizeHistoryInsightsDateRange(value: unknown): HistoryInsightsDateRange | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const from = sanitizeDateRangeEndpoint(raw.from);
  const to = sanitizeDateRangeEndpoint(raw.to);
  if (from === undefined || to === undefined) return null;
  if (from && to && from > to) return null;
  return { from, to };
}

export function historyInsightsDateRangeToDateScope(range: HistoryInsightsDateRange): DateScope {
  if (!range.from && !range.to) return { kind: "all" };
  if (range.from && range.from === range.to) return { kind: "day", ymd: range.from };
  return { kind: "range", from: range.from, to: range.to };
}

export function matchesHistoryInsightsDateRange(localDate: string, range: HistoryInsightsDateRange): boolean {
  if (!isValidHistoryInsightsDate(localDate)) return false;
  if (range.from && localDate < range.from) return false;
  if (range.to && localDate > range.to) return false;
  return true;
}

export function matchesHistoryDateScope(localDate: string, scope: DateScope): boolean {
  return matchesDateScope(localDate, scope);
}

function sanitizeDateRangeEndpoint(value: unknown): string | null | undefined {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.length !== 10 || !isValidHistoryInsightsDate(value)) return undefined;
  return value;
}

function isValidHistoryInsightsDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return false;
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}` === value;
}
