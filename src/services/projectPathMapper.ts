import * as path from "node:path";
import { normalizeProjectKey } from "../utils/fsUtils";

export interface ProjectPathMapping {
  sourceCwd: string;
  targetCwd: string;
}

export interface ProjectPathMappingResult {
  fsPath: string;
  sourceCwd: string;
  targetCwd: string;
}

export interface CanonicalProjectFilter {
  projectKey: string | null;
  projectScopeKey: string | null;
}

export type CanonicalProjectKeyResolver = (projectCwd: string) => string | null | undefined;

export function mapAssociatedProjectPath(
  fsPath: string,
  mappings: readonly ProjectPathMapping[],
): ProjectPathMappingResult | null {
  const candidate = String(fsPath ?? "").trim();
  if (!candidate || !isAbsolutePathLike(candidate)) return null;

  let best: { result: ProjectPathMappingResult; sourceKey: string } | null = null;
  for (const mapping of mappings) {
    const sourceCwd = String(mapping.sourceCwd ?? "").trim();
    const targetCwd = String(mapping.targetCwd ?? "").trim();
    if (!sourceCwd || !targetCwd) continue;

    const rel = relativePathInside(sourceCwd, candidate);
    if (rel === null) continue;
    const sourceKey = normalizeProjectKey(sourceCwd);
    if (!sourceKey) continue;
    const mapped = rel ? path.join(targetCwd, rel) : targetCwd;
    const result = { fsPath: mapped, sourceCwd, targetCwd };
    if (!best || compareProjectPathMappingSourceKey(sourceKey, best.sourceKey) > 0) {
      best = { result, sourceKey };
    }
  }

  return best?.result ?? null;
}

export function isSameProjectPath(left: string | null | undefined, right: string | null | undefined): boolean {
  const leftKey = normalizeProjectKey(String(left ?? ""));
  const rightKey = normalizeProjectKey(String(right ?? ""));
  return !!leftKey && !!rightKey && leftKey === rightKey;
}

export function resolveCanonicalProjectKey(
  projectCwd: string | null | undefined,
  resolve?: CanonicalProjectKeyResolver,
): string {
  const cwd = String(projectCwd ?? "").trim();
  if (!cwd) return "";
  const resolved = resolve?.(cwd);
  return typeof resolved === "string" && resolved.trim().length > 0 ? resolved : normalizeProjectKey(cwd);
}

export function matchProjectByCanonicalKey(
  cwd: string | null | undefined,
  filter: CanonicalProjectFilter,
  resolve?: CanonicalProjectKeyResolver,
): boolean {
  if (!filter.projectKey && !filter.projectScopeKey) return true;
  const sessionCwd = typeof cwd === "string" && cwd.trim().length > 0 ? cwd.trim() : null;
  if (!sessionCwd) return !filter.projectKey;
  const sessionKey = resolveCanonicalProjectKey(sessionCwd, resolve);
  if (filter.projectScopeKey && sessionKey !== filter.projectScopeKey) return false;
  if (filter.projectKey && sessionKey !== filter.projectKey) return false;
  return true;
}

function relativePathInside(basePath: string, candidatePath: string): string | null {
  const baseKey = normalizeProjectKey(basePath);
  const candidateKey = normalizeProjectKey(candidatePath);
  if (!baseKey || !candidateKey) return null;
  if (baseKey === candidateKey) return "";
  if (isProjectRootKey(baseKey)) {
    if (!candidateKey.startsWith(baseKey)) return null;
  } else if (!candidateKey.startsWith(`${baseKey}/`)) {
    return null;
  }

  const baseSegmentCount = splitProjectKeySegments(baseKey).length;
  const rel = splitPreservedPathSegments(candidatePath).slice(baseSegmentCount).join(path.sep);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel;
}

function isAbsolutePathLike(input: string): boolean {
  const text = String(input ?? "").trim();
  if (!text) return false;
  if (/^[a-zA-Z]:[\\/]/.test(text)) return true;
  if (text.startsWith("\\\\")) return true;
  return text.startsWith("/");
}

function splitProjectKeySegments(projectKey: string): string[] {
  return String(projectKey ?? "")
    .split("/")
    .filter((segment) => segment.length > 0);
}

function splitPreservedPathSegments(fsPath: string): string[] {
  const normalized = path.normalize(String(fsPath ?? "").trim().replace(/[\\/]+/g, path.sep)).replace(/\\/g, "/");
  return normalized.split("/").filter((segment) => segment.length > 0);
}

function isProjectRootKey(projectKey: string): boolean {
  return projectKey === "/" || /^[a-z]:\/$/i.test(projectKey);
}

function compareProjectPathMappingSourceKey(leftKey: string, rightKey: string): number {
  const leftSegments = splitProjectKeySegments(leftKey).length;
  const rightSegments = splitProjectKeySegments(rightKey).length;
  if (leftSegments !== rightSegments) return leftSegments - rightSegments;
  return leftKey.length - rightKey.length;
}
