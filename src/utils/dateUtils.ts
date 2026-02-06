// Date/time formatting and validation helpers.

export interface Ymd {
  year: number;
  month: number;
  day: number;
}

export function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

export function toYmdLocal(d: Date): Ymd {
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

type YmdHmsParts = { year: number; month: number; day: number; hour: string; minute: string; second: string };

const dtfYmdHmsCache = new Map<string, Intl.DateTimeFormat>();

function getDtfYmdHms(timeZone: string): Intl.DateTimeFormat | null {
  const tz = typeof timeZone === "string" ? timeZone.trim() : "";
  if (!tz) return null;
  if (dtfYmdHmsCache.has(tz)) return dtfYmdHmsCache.get(tz)!;
  try {
    // Force Latin digits so numeric parsing is stable across locale-specific numeral systems.
    const dtf = new Intl.DateTimeFormat("en-US-u-nu-latn", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    dtfYmdHmsCache.set(tz, dtf);
    return dtf;
  } catch {
    return null;
  }
}

function partsFromDtf(dtf: Intl.DateTimeFormat, d: Date): YmdHmsParts | null {
  const out: Partial<Record<keyof YmdHmsParts, string>> = {};
  try {
    for (const p of dtf.formatToParts(d)) {
      if (p.type === "year" || p.type === "month" || p.type === "day" || p.type === "hour" || p.type === "minute" || p.type === "second") {
        out[p.type] = p.value;
      }
    }
  } catch {
    return null;
  }

  const year = Number(out.year);
  const month = Number(out.month);
  const day = Number(out.day);
  const hour = out.hour;
  const minute = out.minute;
  const second = out.second;

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (typeof hour !== "string" || typeof minute !== "string" || typeof second !== "string") return null;

  return { year, month, day, hour, minute, second };
}

function getYmdHmsInTimeZone(d: Date, timeZone: string): YmdHmsParts {
  const dtf = getDtfYmdHms(timeZone);
  if (dtf) {
    const parts = partsFromDtf(dtf, d);
    if (parts) return parts;
  }
  // Fallback to system local time when the requested time zone cannot be applied.
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    hour: pad2(d.getHours()),
    minute: pad2(d.getMinutes()),
    second: pad2(d.getSeconds()),
  };
}

export function toYmdInTimeZone(d: Date, timeZone: string): Ymd {
  const p = getYmdHmsInTimeZone(d, timeZone);
  return { year: p.year, month: p.month, day: p.day };
}

export function ymdToString(ymd: Ymd): string {
  return `${ymd.year}-${pad2(ymd.month)}-${pad2(ymd.day)}`;
}

export function formatTimeHmLocal(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function formatTimeHmInTimeZone(d: Date, timeZone: string): string {
  const p = getYmdHmsInTimeZone(d, timeZone);
  return `${p.hour}:${p.minute}`;
}

export function formatTimeHmsInTimeZone(d: Date, timeZone: string): string {
  const p = getYmdHmsInTimeZone(d, timeZone);
  return `${p.hour}:${p.minute}:${p.second}`;
}

export function formatYmdHmInTimeZone(d: Date, timeZone: string): string {
  const p = getYmdHmsInTimeZone(d, timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${p.hour}:${p.minute}`;
}

export function formatYmdHmsInTimeZone(d: Date, timeZone: string): string {
  const p = getYmdHmsInTimeZone(d, timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${p.hour}:${p.minute}:${p.second}`;
}

export function isValidYyyy(s: string): boolean {
  return /^\d{4}$/.test(s);
}

export function isValidYyyyMm(s: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(s)) return false;
  const [y, m] = s.split("-").map((x) => Number(x));
  return y >= 1970 && y <= 9999 && m >= 1 && m <= 12;
}

export function isValidYyyyMmDd(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map((x) => Number(x));
  if (!(y >= 1970 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}
