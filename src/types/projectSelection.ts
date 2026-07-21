export const MAX_PROJECT_SELECTION_GROUPS = 32;

export interface ProjectSelectionGroup {
  canonicalGroupKey: string;
  representativeCwd: string;
}

export type ProjectSelection =
  | { kind: "all" }
  | { kind: "none" }
  | { kind: "groups"; groups: readonly ProjectSelectionGroup[] };

export type ProjectGroupKeyResolver = (cwd: string) => string | null | undefined;

export function parseProjectSelection(value: unknown): ProjectSelection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind === "all") return { kind: "all" };
  if (raw.kind === "none") return { kind: "none" };
  if (raw.kind !== "groups" || !Array.isArray(raw.groups)) return null;
  if (raw.groups.length < 1 || raw.groups.length > MAX_PROJECT_SELECTION_GROUPS) return null;
  const groups: ProjectSelectionGroup[] = [];
  const seen = new Set<string>();
  for (const candidate of raw.groups) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const group = candidate as Record<string, unknown>;
    const canonicalGroupKey = boundedString(group.canonicalGroupKey);
    const representativeCwd = boundedString(group.representativeCwd);
    if (!canonicalGroupKey || !representativeCwd || seen.has(canonicalGroupKey)) return null;
    seen.add(canonicalGroupKey);
    groups.push({ canonicalGroupKey, representativeCwd });
  }
  return { kind: "groups", groups };
}

export function projectSelectionFromCwds(
  projectCwd: string | null | undefined,
  projectScopeCwd: string | null | undefined,
  resolveGroupKey: ProjectGroupKeyResolver,
): ProjectSelection {
  const candidates = [projectCwd, projectScopeCwd]
    .map((value) => typeof value === "string" ? value.trim() : "")
    .filter(Boolean);
  if (candidates.length === 0) return { kind: "all" };
  const groups: ProjectSelectionGroup[] = [];
  const seen = new Set<string>();
  for (const representativeCwd of candidates) {
    const canonicalGroupKey = String(resolveGroupKey(representativeCwd) ?? "").trim();
    if (!canonicalGroupKey) return { kind: "none" };
    if (seen.has(canonicalGroupKey)) continue;
    seen.add(canonicalGroupKey);
    groups.push({ canonicalGroupKey, representativeCwd });
  }
  return groups.length === 1 ? { kind: "groups", groups } : { kind: "none" };
}

export function reconcileProjectSelection(
  selection: ProjectSelection,
  resolveGroupKey: ProjectGroupKeyResolver,
): ProjectSelection {
  if (selection.kind !== "groups") return selection;
  const groups: ProjectSelectionGroup[] = [];
  const seen = new Set<string>();
  for (const group of selection.groups) {
    const canonicalGroupKey = String(resolveGroupKey(group.representativeCwd) ?? "").trim();
    if (!canonicalGroupKey || seen.has(canonicalGroupKey)) continue;
    seen.add(canonicalGroupKey);
    groups.push({ canonicalGroupKey, representativeCwd: group.representativeCwd });
  }
  return groups.length > 0 ? { kind: "groups", groups } : { kind: "none" };
}

export function matchProjectSelection(
  cwd: string | null | undefined,
  selection: ProjectSelection,
  resolveGroupKey: ProjectGroupKeyResolver,
): boolean {
  if (selection.kind === "all") return true;
  if (selection.kind === "none") return false;
  const projectCwd = typeof cwd === "string" ? cwd.trim() : "";
  if (!projectCwd) return false;
  const canonicalGroupKey = String(resolveGroupKey(projectCwd) ?? "").trim();
  return Boolean(canonicalGroupKey && selection.groups.some((group) => group.canonicalGroupKey === canonicalGroupKey));
}

export function getSingleProjectSelectionCwd(selection: ProjectSelection): string | null {
  return selection.kind === "groups" && selection.groups.length === 1
    ? selection.groups[0]?.representativeCwd ?? null
    : null;
}

export function isSameProjectSelection(left: ProjectSelection, right: ProjectSelection): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind !== "groups" || right.kind !== "groups") return true;
  if (left.groups.length !== right.groups.length) return false;
  const rightKeys = new Set(right.groups.map((group) => group.canonicalGroupKey));
  return left.groups.every((group) => rightKeys.has(group.canonicalGroupKey));
}

function boundedString(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 && text.length <= 32_768 ? text : "";
}
