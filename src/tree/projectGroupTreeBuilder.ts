import type { ProjectAssociation } from "../services/projectAssociationStore";
import { t } from "../i18n";
import { maxSessionSortKey, minSessionSortKey } from "../sessions/sessionSortKeys";
import {
  ProjectNode,
  type ProjectSortMetadata,
  RelatedGroupNode,
  type ProjectAssociatedSource,
  type ProjectParentAssociation,
  type TreeNode,
} from "./treeNodes";

export interface ProjectGroupBucketBase {
  key: string;
  groupKey: string;
  cwd: string | null;
}

export interface ProjectGroupTreeBuildContext<TBucket extends ProjectGroupBucketBase> {
  buckets: Map<string, TBucket>;
  directGroupOnlySourcesByTargetKey: Map<string, ProjectAssociation[]>;
}

export interface ProjectGroupTreeBuilderOptions<TBucket extends ProjectGroupBucketBase> {
  context: ProjectGroupTreeBuildContext<TBucket>;
  createProjectNode(bucket: TBucket, parentAssociation: ProjectParentAssociation | null): ProjectNode;
  getRepresentativeCwd(targetKey: string, bucket: TBucket | undefined): string | null;
  getAliasByCwd(cwd: string | null): string | null;
  buildProjectLabel(cwd: string | null): string;
  compareNodes(left: TreeNode, right: TreeNode): number;
}

export function buildDirectGroupOnlySourcesByTargetKey(
  associations: readonly ProjectAssociation[],
): Map<string, ProjectAssociation[]> {
  const byTarget = new Map<string, ProjectAssociation[]>();
  for (const association of associations) {
    if (association.mode !== "groupOnly") continue;
    const existing = byTarget.get(association.targetKey);
    if (existing) existing.push(association);
    else byTarget.set(association.targetKey, [association]);
  }
  for (const sources of byTarget.values()) {
    sources.sort((a, b) => a.sourceCwd.localeCompare(b.sourceCwd));
  }
  return byTarget;
}

export function buildProjectGroupTreeNodes<TBucket extends ProjectGroupBucketBase>(
  options: ProjectGroupTreeBuilderOptions<TBucket>,
): TreeNode[] {
  const rootKeys = new Set<string>();
  for (const bucket of options.context.buckets.values()) rootKeys.add(bucket.groupKey);

  const nodes: TreeNode[] = [];
  for (const rootKey of rootKeys) {
    const node = buildProjectSubtree(rootKey, null, new Set<string>(), options);
    if (node) nodes.push(node);
  }

  nodes.sort(options.compareNodes);
  return nodes;
}

function buildProjectSubtree<TBucket extends ProjectGroupBucketBase>(
  targetKey: string,
  parentAssociation: ProjectParentAssociation | null,
  visited: Set<string>,
  options: ProjectGroupTreeBuilderOptions<TBucket>,
): TreeNode | null {
  if (visited.has(targetKey)) return null;
  const nextVisited = new Set(visited);
  nextVisited.add(targetKey);

  const targetBucket = options.context.buckets.get(targetKey);
  const childNodes: TreeNode[] = [];
  for (const association of getDirectGroupOnlySources(options.context, targetKey)) {
    const childParentAssociation = toProjectParentAssociation(association);
    const child = buildProjectSubtree(association.sourceKey, childParentAssociation, nextVisited, options);
    if (child) childNodes.push(child);
  }

  if (childNodes.length === 0) {
    return targetBucket ? options.createProjectNode(targetBucket, parentAssociation) : null;
  }

  const children: TreeNode[] = [];
  if (targetBucket) children.push(options.createProjectNode(targetBucket, null));
  children.push(...childNodes);

  const sortedChildren = children.slice();
  const targetProject = sortedChildren.find((child) => child instanceof ProjectNode && child.key === targetKey);
  sortedChildren.sort((left, right) => {
    if (targetProject && left === targetProject) return -1;
    if (targetProject && right === targetProject) return 1;
    return options.compareNodes(left, right);
  });

  const cwd = options.getRepresentativeCwd(targetKey, targetBucket);
  const fallbackLabel = options.buildProjectLabel(cwd);
  const alias = options.getAliasByCwd(cwd);
  const label = t("projectAssociation.group.label", alias ?? fallbackLabel);
  const sessionCount = sortedChildren.reduce((sum, child) => sum + getProjectTreeSessionCount(child), 0);
  const projectCount = sortedChildren.reduce((sum, child) => sum + getProjectTreeProjectCount(child), 0);
  const latestLabel = sortedChildren.reduce((best, child) => {
    const next = getProjectTreeLatestLabel(child);
    return !best || (next && best < next) ? next : best;
  }, "");
  const sort = buildRelatedGroupSortMetadata(targetKey, sortedChildren);
  const directSources = getDirectGroupOnlySources(options.context, targetKey).map((source) => ({
    cwd: source.sourceCwd,
    mode: source.mode,
  }));

  return new RelatedGroupNode({
    key: targetKey,
    label,
    cwd,
    alias,
    fallbackLabel,
    sessionCount,
    projectCount,
    latestLabel,
    description: t("projectAssociation.group.description", projectCount, sessionCount),
    directSources,
    children: sortedChildren,
    parentAssociation,
    sort,
  });
}

function getDirectGroupOnlySources<TBucket extends ProjectGroupBucketBase>(
  context: ProjectGroupTreeBuildContext<TBucket>,
  targetKey: string,
): readonly ProjectAssociation[] {
  return context.directGroupOnlySourcesByTargetKey.get(targetKey) ?? [];
}

function toProjectParentAssociation(association: ProjectAssociation): ProjectParentAssociation {
  return {
    sourceCwd: association.sourceCwd,
    targetCwd: association.targetCwd,
    mode: association.mode,
  };
}

export function buildAssociatedSources(
  associations: readonly ProjectAssociation[],
  fallbackCwdsByKey: ReadonlyMap<string, string>,
): ProjectAssociatedSource[] {
  const byKey = new Map<string, ProjectAssociatedSource>();
  for (const association of associations) {
    byKey.set(association.sourceKey, { cwd: association.sourceCwd, mode: association.mode });
  }
  for (const [key, cwd] of fallbackCwdsByKey.entries()) {
    if (!byKey.has(key)) byKey.set(key, { cwd, mode: "relocate" });
  }
  return Array.from(byKey.values()).sort((a, b) => a.cwd.localeCompare(b.cwd));
}

export function appendAssociatedSourceLines(
  lines: string[],
  associatedSources: readonly ProjectAssociatedSource[],
  formatMode: (mode: ProjectAssociatedSource["mode"]) => string,
): void {
  if (associatedSources.length === 0) return;
  lines.push(t("projectAssociation.tooltip.associatedSources"));
  const max = 5;
  for (const source of associatedSources.slice(0, max)) {
    lines.push(`${source.cwd} (${formatMode(source.mode)})`);
  }
  if (associatedSources.length > max) {
    lines.push(t("projectAssociation.tooltip.moreSources", associatedSources.length - max));
  }
}

export function compareProjectTreeNodes(left: TreeNode, right: TreeNode): number {
  const leftLatest = getProjectTreeLatestLabel(left);
  const rightLatest = getProjectTreeLatestLabel(right);
  if (leftLatest !== rightLatest) return leftLatest < rightLatest ? 1 : -1;
  return getProjectTreeLabel(left).localeCompare(getProjectTreeLabel(right));
}

function getProjectTreeLabel(node: TreeNode): string {
  if (node instanceof ProjectNode || node instanceof RelatedGroupNode) return node.label;
  return "";
}

function getProjectTreeLatestLabel(node: TreeNode): string {
  if (node instanceof ProjectNode || node instanceof RelatedGroupNode) return node.latestLabel;
  return "";
}

function getProjectTreeSessionCount(node: TreeNode): number {
  if (node instanceof ProjectNode || node instanceof RelatedGroupNode) return node.sessionCount;
  return 0;
}

function getProjectTreeProjectCount(node: TreeNode): number {
  if (node instanceof ProjectNode) return 1;
  if (node instanceof RelatedGroupNode) return node.projectCount;
  return 0;
}

function buildRelatedGroupSortMetadata(targetKey: string, children: readonly TreeNode[]): ProjectSortMetadata {
  let createdSortKey: string | null = null;
  let lastActivitySortKey: string | null = null;

  for (const child of children) {
    if (!(child instanceof ProjectNode || child instanceof RelatedGroupNode)) continue;
    createdSortKey = minSessionSortKey(createdSortKey, child.sort.createdSortKey);
    lastActivitySortKey = maxSessionSortKey(lastActivitySortKey, child.sort.lastActivitySortKey);
  }

  return { createdSortKey, lastActivitySortKey, stableKey: targetKey };
}
