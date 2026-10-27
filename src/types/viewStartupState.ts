import { parseHistoryViewMode } from "./historyViewMode";
import type { HistoryViewMode } from "../tree/historyTree";
import { restoreHistoryProjectScopeState, type ProjectScopeMode } from "./historyProjectScope";
import type { ProjectSelection } from "./projectSelection";

export type ViewStartupMode = "restore" | "defaults";
export type ProjectDisplayMode = "list" | "project";

export interface ProjectStartupDefaults {
  startupMode: ViewStartupMode;
  display: ProjectDisplayMode;
  scope: ProjectScopeMode;
}

export interface HistoryStartupDefaults extends ProjectStartupDefaults {
  viewMode: HistoryViewMode;
}

export interface HistoryStartupState {
  viewMode: HistoryViewMode;
  display: ProjectDisplayMode;
  scope: ProjectScopeMode;
  projects: ProjectSelection;
}

export interface PinnedStartupState {
  display: ProjectDisplayMode;
  scope: ProjectScopeMode;
  projectCwd: string | null;
}

function resolveDisplay(
  defaults: ProjectStartupDefaults,
  saved: { display: unknown; legacyGrouped: unknown },
): ProjectDisplayMode {
  if (defaults.startupMode === "defaults") return defaults.display;
  if (saved.display === "list" || saved.display === "project") return saved.display;
  if (saved.display === undefined && typeof saved.legacyGrouped === "boolean") {
    return saved.legacyGrouped ? "project" : "list";
  }
  return defaults.display;
}

export function resolveHistoryStartupState(
  defaults: HistoryStartupDefaults,
  saved: {
    viewMode: unknown;
    display: unknown;
    legacyGrouped: unknown;
    scope: unknown;
    projects: ProjectSelection;
    corrupt: boolean;
  },
  currentGroup: ProjectSelection | null,
): HistoryStartupState {
  const savedViewMode = parseHistoryViewMode(saved.viewMode);
  const viewMode = defaults.startupMode === "restore" && savedViewMode !== undefined
    ? savedViewMode
    : defaults.viewMode;
  const display = resolveDisplay(defaults, saved);
  // A corrupt filter must never be widened by startup preferences.
  if (saved.corrupt) return { viewMode, display, scope: "all", projects: { kind: "none" } };
  const applyDefaultScope = defaults.startupMode === "defaults" ||
    (saved.scope === undefined && saved.projects.kind === "all");
  if (!applyDefaultScope) {
    const restored = restoreHistoryProjectScopeState(
      saved.scope === "currentGroup" ? "currentGroup" : "all",
      saved.projects,
      currentGroup,
    );
    return { viewMode, display, ...restored };
  }
  if (defaults.scope === "all") return { viewMode, display, scope: "all", projects: { kind: "all" } };
  if (currentGroup?.kind === "groups" && currentGroup.groups.length === 1) {
    return { viewMode, display, scope: "currentGroup", projects: currentGroup };
  }
  // Without a workspace, preserve any previously narrowed project condition.
  return { viewMode, display, scope: "all", projects: saved.projects };
}

export function resolvePinnedStartupState(
  defaults: ProjectStartupDefaults,
  saved: { display: unknown; legacyGrouped: unknown; scope: unknown; projectCwd: string | null },
  hasCurrentGroup: boolean,
): PinnedStartupState {
  const display = resolveDisplay(defaults, saved);
  const applyDefaultScope = defaults.startupMode === "defaults" ||
    (saved.scope === undefined && saved.projectCwd === null);
  if (!applyDefaultScope) {
    return {
      display,
      scope: saved.scope === "currentGroup" && hasCurrentGroup ? "currentGroup" : "all",
      projectCwd: saved.projectCwd,
    };
  }
  if (defaults.scope === "currentGroup" && !hasCurrentGroup) {
    return { display, scope: "all", projectCwd: saved.projectCwd };
  }
  return { display, scope: defaults.scope, projectCwd: null };
}
