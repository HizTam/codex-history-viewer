const MAX_INITIAL_BRANCH_TREE_NODE_ESTIMATE = 180;
const FALLBACK_GROUP_PAGE_SIZE = 2;
const INITIAL_CHOICE_PAGE_SIZE = 20;

export function getInitialBranchOverlayGroupPageSize(
  groups: readonly { choices: readonly unknown[] }[],
): number {
  let estimatedNodes = 0;
  for (const group of groups) {
    estimatedNodes += 4 + Math.min(group.choices.length, INITIAL_CHOICE_PAGE_SIZE) * 2;
    if (estimatedNodes > MAX_INITIAL_BRANCH_TREE_NODE_ESTIMATE) {
      return FALLBACK_GROUP_PAGE_SIZE;
    }
  }
  return Math.max(1, groups.length);
}
