import { isSameProjectSelection, type ProjectSelection } from "./projectSelection";

export type ProjectScopeMode = "all" | "currentGroup";
export type HistoryProjectScopePolicy = "preserve" | "explicitSelection" | "clear";

export interface HistoryProjectScopeState {
  projects: ProjectSelection;
  scope: ProjectScopeMode;
}

function isCurrentGroupProjectSelection(
  selection: ProjectSelection | null,
): selection is Extract<ProjectSelection, { kind: "groups" }> {
  return selection?.kind === "groups" && selection.groups.length === 1;
}

export function restoreHistoryProjectScopeState(
  savedScope: ProjectScopeMode,
  restoredProjects: ProjectSelection,
  currentGroupProjects: ProjectSelection | null,
  options: { followCurrentGroup?: boolean } = {},
): HistoryProjectScopeState {
  if (savedScope !== "currentGroup") {
    return { projects: restoredProjects, scope: "all" };
  }
  if (options.followCurrentGroup && isCurrentGroupProjectSelection(currentGroupProjects)) {
    return { projects: currentGroupProjects, scope: "currentGroup" };
  }
  if (
    isCurrentGroupProjectSelection(currentGroupProjects) &&
    isSameProjectSelection(restoredProjects, currentGroupProjects)
  ) {
    return { projects: restoredProjects, scope: "currentGroup" };
  }
  // Preserve the narrower V2 selection when an old scope marker is inconsistent.
  return { projects: restoredProjects, scope: "all" };
}

export function resolveHistoryProjectFilterState(
  currentScope: ProjectScopeMode,
  nextProjects: ProjectSelection,
  currentGroupProjects: ProjectSelection | null,
  policy: HistoryProjectScopePolicy,
): HistoryProjectScopeState {
  if (policy === "explicitSelection") {
    return { projects: nextProjects, scope: "all" };
  }

  if (policy === "clear") {
    if (currentScope === "currentGroup" && isCurrentGroupProjectSelection(currentGroupProjects)) {
      return { projects: currentGroupProjects, scope: "currentGroup" };
    }
    return { projects: { kind: "all" }, scope: "all" };
  }

  if (currentScope === "currentGroup") {
    if (
      isCurrentGroupProjectSelection(currentGroupProjects) &&
      isSameProjectSelection(nextProjects, currentGroupProjects)
    ) {
      return { projects: nextProjects, scope: "currentGroup" };
    }
    // A changed or missing workspace invalidates the marker without changing the saved target.
    return { projects: nextProjects, scope: "all" };
  }
  return { projects: nextProjects, scope: "all" };
}
