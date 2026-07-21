import { isValidYyyy, isValidYyyyMm, isValidYyyyMmDd } from "../utils/dateUtils";

export type DateScope =
  | { kind: "all" }
  | { kind: "year"; yyyy: string }
  | { kind: "month"; ym: string } // YYYY-MM
  | { kind: "day"; ymd: string } // YYYY-MM-DD
  | { kind: "range"; from: string | null; to: string | null };

export function sanitizeDateScope(scope: unknown): DateScope {
  if (!scope || typeof scope !== "object") return { kind: "all" };
  const kind = (scope as any).kind;
  if (kind === "all") return { kind: "all" };
  if (kind === "year") {
    const yyyy = String((scope as any).yyyy ?? "").trim();
    return isValidYyyy(yyyy) ? { kind: "year", yyyy } : { kind: "all" };
  }
  if (kind === "month") {
    const ym = String((scope as any).ym ?? "").trim();
    return isValidYyyyMm(ym) ? { kind: "month", ym } : { kind: "all" };
  }
  if (kind === "day") {
    const ymd = String((scope as any).ymd ?? "").trim();
    return isValidYyyyMmDd(ymd) ? { kind: "day", ymd } : { kind: "all" };
  }
  if (kind === "range") {
    const from = sanitizeRangeEndpoint((scope as any).from);
    const to = sanitizeRangeEndpoint((scope as any).to);
    if (from === undefined || to === undefined || (from && to && from > to)) return { kind: "all" };
    if (!from && !to) return { kind: "all" };
    if (from && from === to) return { kind: "day", ymd: from };
    return { kind: "range", from, to };
  }
  return { kind: "all" };
}

export function parseDateScopeStrict(scope: unknown): DateScope | null {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return null;
  const raw = scope as Record<string, unknown>;
  if (raw.kind === "all") return { kind: "all" };
  if (raw.kind === "year" && typeof raw.yyyy === "string" && isValidYyyy(raw.yyyy)) {
    return { kind: "year", yyyy: raw.yyyy };
  }
  if (raw.kind === "month" && typeof raw.ym === "string" && isValidYyyyMm(raw.ym)) {
    return { kind: "month", ym: raw.ym };
  }
  if (raw.kind === "day" && typeof raw.ymd === "string" && isValidYyyyMmDd(raw.ymd)) {
    return { kind: "day", ymd: raw.ymd };
  }
  if (raw.kind !== "range") return null;
  const from = sanitizeRangeEndpoint(raw.from);
  const to = sanitizeRangeEndpoint(raw.to);
  if (from === undefined || to === undefined || (!from && !to) || (from && to && from >= to)) return null;
  return { kind: "range", from, to };
}

export function getDateScopeValue(scope: DateScope): string | undefined {
  switch (scope.kind) {
    case "all":
      return undefined;
    case "year":
      return scope.yyyy;
    case "month":
      return scope.ym;
    case "day":
      return scope.ymd;
    case "range":
      return `${scope.from ?? ""}..${scope.to ?? ""}`;
    default:
      return undefined;
  }
}

export function isSameDateScope(left: DateScope, right: DateScope): boolean {
  return left.kind === right.kind && getDateScopeValue(left) === getDateScopeValue(right);
}

export function matchesDateScope(localDate: string, scope: DateScope): boolean {
  switch (scope.kind) {
    case "all":
      return true;
    case "year":
      return localDate.startsWith(`${scope.yyyy}-`);
    case "month":
      return localDate.startsWith(`${scope.ym}-`);
    case "day":
      return localDate === scope.ymd;
    case "range":
      return (!scope.from || localDate >= scope.from) && (!scope.to || localDate <= scope.to);
    default:
      return false;
  }
}

function sanitizeRangeEndpoint(value: unknown): string | null | undefined {
  if (value === null || value === "" || value === undefined) return null;
  return typeof value === "string" && isValidYyyyMmDd(value) ? value : undefined;
}
