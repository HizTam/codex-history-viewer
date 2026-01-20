import { isValidYyyy, isValidYyyyMm, isValidYyyyMmDd } from "../utils/dateUtils";

export type DateScope =
  | { kind: "all" }
  | { kind: "year"; yyyy: string }
  | { kind: "month"; ym: string } // YYYY-MM
  | { kind: "day"; ymd: string }; // YYYY-MM-DD

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
  return { kind: "all" };
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
    default:
      return undefined;
  }
}

