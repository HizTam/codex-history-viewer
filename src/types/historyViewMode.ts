export type HistoryViewMode = "date" | "sessionsList";

// Accept the previous stored value without treating arbitrary strings as a session list.
export function parseHistoryViewMode(value: unknown): HistoryViewMode | undefined {
  if (value === "date") return "date";
  if (value === "sessionsList" || value === "latest") return "sessionsList";
  return undefined;
}

// Callers that distinguish missing saved state must use the parser before choosing a fallback.
export function normalizeHistoryViewMode(value: unknown): HistoryViewMode {
  return parseHistoryViewMode(value) ?? "date";
}
