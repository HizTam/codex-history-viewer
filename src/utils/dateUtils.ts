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

export function ymdToString(ymd: Ymd): string {
  return `${ymd.year}-${pad2(ymd.month)}-${pad2(ymd.day)}`;
}

export function formatTimeHmLocal(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
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
