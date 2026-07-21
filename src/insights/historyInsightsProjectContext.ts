import * as path from "node:path";
import type { ProjectAssociationStore } from "../services/projectAssociationStore";
import { normalizeProjectKey } from "../utils/fsUtils";
import { safeDisplayPath } from "../utils/textUtils";

const MAX_PROJECT_PATH_HINT_LENGTH = 80;

export interface HistoryInsightsAggregationProjectContext {
  contextKey: string;
  displayName: string;
  pathHint: string;
  physicalCwd: string;
}

export function buildHistoryInsightsProjectContext(
  physicalCwd: string,
  associationStore: ProjectAssociationStore,
  getProjectDisplayName: (projectCwd: string) => string,
): HistoryInsightsAggregationProjectContext | null {
  const cwd = String(physicalCwd ?? "").trim();
  if (!cwd) return null;
  const contextKey = normalizeProjectKey(cwd);
  if (!contextKey) return null;
  const displayCwd = associationStore.getDisplayCwd(cwd) ?? cwd;
  const displayName = String(getProjectDisplayName(displayCwd) ?? "").trim();
  return {
    contextKey,
    displayName,
    pathHint: buildBoundedProjectPathHint(cwd),
    physicalCwd: cwd,
  };
}

export function buildBoundedProjectPathHint(projectCwd: string): string {
  const raw = String(projectCwd ?? "").trim();
  if (!raw) return "";
  const segments = raw.replace(/\\/gu, "/").split("/").map((segment) => segment.trim()).filter(Boolean);
  const withoutDrive = segments.filter((segment, index) => !(index === 0 && /^[A-Za-z]:$/u.test(segment)));
  const tail = withoutDrive.slice(-2).join("/");
  return safeDisplayPath(tail, MAX_PROJECT_PATH_HINT_LENGTH);
}

export function resolveProjectRelativeFilePath(filePath: string, projectCwd: string): string | null {
  const rawFilePath = String(filePath ?? "").trim();
  const rawProjectCwd = String(projectCwd ?? "").trim();
  if (!rawFilePath || !rawProjectCwd) return null;
  const pathApi = selectPathApi(rawFilePath, rawProjectCwd);
  if (!pathApi.isAbsolute(rawFilePath) || !pathApi.isAbsolute(rawProjectCwd)) return null;
  const relative = pathApi.relative(pathApi.normalize(rawProjectCwd), pathApi.normalize(rawFilePath));
  if (!relative || pathApi.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${pathApi.sep}`)) return null;
  return safeDisplayPath(relative.replace(/\\/gu, "/"), 160);
}

function selectPathApi(filePath: string, projectCwd: string): path.PlatformPath {
  return isWindowsAbsolutePath(filePath) || isWindowsAbsolutePath(projectCwd) ? path.win32 : path.posix;
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value);
}
