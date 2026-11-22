import * as path from "node:path";

export type DebugFieldValue = string | number | boolean | null | undefined;

export function nowMs(): number {
  return Date.now();
}

export function elapsedMs(startedAt: number): number {
  const elapsed = Date.now() - startedAt;
  return Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : 0;
}

export function formatDebugFields(eventName: string, fields: Record<string, DebugFieldValue>): string {
  const parts = [sanitizeDebugToken(eventName, "event")];
  for (const [key, value] of Object.entries(fields)) {
    const safeKey = sanitizeDebugToken(key, "key");
    const safeValue = sanitizeDebugValue(value);
    if (safeValue === undefined) continue;
    parts.push(`${safeKey}=${safeValue}`);
  }
  return parts.join(" ");
}

export function safeDebugBasename(fsPath: unknown, fallback = "unknown"): string {
  const text = typeof fsPath === "string" ? fsPath.trim() : "";
  if (!text) return fallback;
  // Native database filenames contain conversation IDs and must never enter diagnostic output.
  if (path.extname(text).toLowerCase() === ".db") return "native-database";
  return sanitizeDebugToken(path.basename(text.replace(/\\/g, "/")), fallback);
}

export function sanitizeDebugError(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? "unknown");
  const withoutControls = raw.replace(/[\r\n\t]/g, " ");
  return sanitizePathLikeText(withoutControls).trim().slice(0, 160) || "unknown";
}

export function sanitizeDebugToken(value: unknown, fallback: string): string {
  const text = String(value ?? "").trim().replace(/[^a-zA-Z0-9_.-]/g, "_");
  return text ? text.slice(0, 96) : fallback;
}

function sanitizeDebugValue(value: DebugFieldValue): string | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? String(Math.round(value)) : undefined;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (value == null) return undefined;
  const text = sanitizePathLikeText(String(value).replace(/[\r\n\t]/g, " ").trim());
  return text ? text.slice(0, 160) : undefined;
}

function sanitizePathLikeText(value: string): string {
  return value
    .replace(/[A-Za-z]:[\\/][^\s'")\]}]+/g, "<path>")
    .replace(/(?:^|\s)\/(?:[^/\s'")\]}]+\/){1,}[^\s'")\]}]+/g, " <path>");
}
