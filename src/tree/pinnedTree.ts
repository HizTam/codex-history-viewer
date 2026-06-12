import * as path from "node:path";
import * as vscode from "vscode";
import type { HistoryService } from "../services/historyService";
import type { PinEntry, PinStore } from "../services/pinStore";
import type { SessionAnnotationStore } from "../services/sessionAnnotationStore";
import type { ProjectAliasStore } from "../services/projectAliasStore";
import { NO_CWD_PROJECT_KEY, type ProjectAssociationStore } from "../services/projectAssociationStore";
import type { ArchiveLocationFilter, SessionSource, SessionSourceFilter, SessionSummary } from "../sessions/sessionTypes";
import {
  compareNullableSessionSortKeys,
  getSessionCreatedSortKey,
  getSessionDisplayDateSortKey,
  getSessionLastActivitySortKey,
} from "../sessions/sessionSortKeys";
import type { DateScope } from "../types/dateScope";
import {
  HistoryEmptyNode,
  MissingPinnedNode,
  PinnedDropHintNode,
  type ProjectAssociatedSource,
  type ProjectParentAssociation,
  ProjectNode,
  RelatedGroupNode,
  SessionNode,
  TreeNode,
  missingPinnedLabel,
  toTreeItemContextValue,
} from "./treeNodes";
import { getConfig } from "../settings";
import { formatYmdHmInTimeZone } from "../utils/dateUtils";
import { resolveDateTimeSettings } from "../utils/dateTimeSettings";
import { normalizeProjectKey } from "../utils/fsUtils";
import { safeDisplayPath, truncateByDisplayWidth } from "../utils/textUtils";
import { t } from "../i18n";
import { buildSessionDescription } from "./sessionDescriptionUtils";
import {
  buildSessionHoverTooltip,
  formatSessionDateTimeForAxis,
  sessionDateLabelKeyForAxis,
  type SessionDateAxis,
} from "./sessionTooltipUtils";
import { matchProjectByCanonicalKey } from "../services/projectPathMapper";
import {
  appendAssociatedSourceLines,
  buildAssociatedSources,
  buildDirectGroupOnlySourcesByTargetKey,
  buildProjectGroupTreeNodes,
  compareProjectTreeNodes,
  type ProjectGroupTreeBuildContext,
} from "./projectGroupTreeBuilder";

export type PinnedSortMode =
  | "pinnedAtDesc"
  | "pinnedAtAsc"
  | "createdDesc"
  | "createdAsc"
  | "lastActivityDesc"
  | "lastActivityAsc"
  | "titleAsc"
  | "titleDesc";

type PinnedVisibleEntry = {
  projectKey: string;
  relocationProjectKey: string;
  originalProjectKey: string;
  cwd: string | null;
  pinnedAt: number;
  fsPath: string;
  node: SessionNode | MissingPinnedNode;
  session: SessionSummary | null;
};

type PinnedProjectBucket = {
  key: string;
  groupKey: string;
  cwd: string | null;
  entries: PinnedVisibleEntry[];
  associatedSourceCwds: Map<string, string>;
  hasTargetSession: boolean;
};

type PinnedProjectBuildContext = ProjectGroupTreeBuildContext<PinnedProjectBucket>;

// Provides the pinned sessions view.
export class PinnedTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly historyService: HistoryService;
  private readonly pinStore: PinStore;
  private readonly annotationStore: SessionAnnotationStore;
  private readonly projectAliasStore: ProjectAliasStore;
  private readonly projectAssociationStore: ProjectAssociationStore;
  private filter: DateScope;
  private sourceFilter: SessionSourceFilter;
  private tagFilter: string[];
  private archiveLocationFilter: ArchiveLocationFilter;
  private projectCwd: string | null;
  private projectCwdKey: string | null = null;
  private projectScopeCwd: string | null;
  private projectScopeCwdKey: string | null = null;
  private projectGrouped: boolean;
  private sortMode: PinnedSortMode;
  private readonly codexIconPath: { light: vscode.Uri; dark: vscode.Uri };
  private readonly claudeIconPath: { light: vscode.Uri; dark: vscode.Uri };
  private readonly canonicalProjectKeyCache = new Map<string, string>();
  private visibleEntriesCache: PinnedVisibleEntry[] | null = null;
  private projectEntriesByRelocationKey = new Map<string, PinnedVisibleEntry[]>();
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined | null | void>();
  private initialLoadComplete = false;
  public readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    historyService: HistoryService,
    pinStore: PinStore,
    annotationStore: SessionAnnotationStore,
    projectAliasStore: ProjectAliasStore,
    projectAssociationStore: ProjectAssociationStore,
    filter: DateScope,
    sourceFilter: SessionSourceFilter,
    tagFilter: readonly string[],
    archiveLocationFilter: ArchiveLocationFilter,
    projectCwd: string | null,
    projectScopeCwd: string | null,
    projectGrouped: boolean,
    sortMode: PinnedSortMode,
    extensionUri: vscode.Uri,
  ) {
    this.historyService = historyService;
    this.pinStore = pinStore;
    this.annotationStore = annotationStore;
    this.projectAliasStore = projectAliasStore;
    this.projectAssociationStore = projectAssociationStore;
    this.filter = filter;
    this.sourceFilter = normalizeSourceFilter(sourceFilter);
    this.tagFilter = normalizeTagFilter(tagFilter);
    this.archiveLocationFilter = archiveLocationFilter;
    this.projectCwd = typeof projectCwd === "string" && projectCwd.trim().length > 0 ? projectCwd.trim() : null;
    this.projectScopeCwd =
      typeof projectScopeCwd === "string" && projectScopeCwd.trim().length > 0 ? projectScopeCwd.trim() : null;
    this.projectGrouped = projectGrouped;
    this.sortMode = normalizePinnedSortMode(sortMode);
    this.codexIconPath = {
      light: vscode.Uri.joinPath(extensionUri, "resources", "icons", "light", "source-codex.svg"),
      dark: vscode.Uri.joinPath(extensionUri, "resources", "icons", "dark", "source-codex.svg"),
    };
    this.claudeIconPath = {
      light: vscode.Uri.joinPath(extensionUri, "resources", "icons", "light", "source-claude.svg"),
      dark: vscode.Uri.joinPath(extensionUri, "resources", "icons", "dark", "source-claude.svg"),
    };
    this.recomputeProjectFilterKeys();
  }

  public refresh(): void {
    this.canonicalProjectKeyCache.clear();
    this.clearVisibleEntriesCache();
    this.recomputeProjectFilterKeys();
    this.emitter.fire();
  }

  public markInitialLoadComplete(): void {
    if (this.initialLoadComplete) return;
    this.initialLoadComplete = true;
    this.refresh();
  }

  public setTagFilter(tags: readonly string[]): void {
    this.tagFilter = normalizeTagFilter(tags);
    this.clearVisibleEntriesCache();
  }

  public setFilter(filter: DateScope): void {
    this.filter = filter;
    this.clearVisibleEntriesCache();
  }

  public setSourceFilter(sourceFilter: SessionSourceFilter): void {
    this.sourceFilter = normalizeSourceFilter(sourceFilter);
    this.clearVisibleEntriesCache();
  }

  public setArchiveLocationFilter(archiveLocationFilter: ArchiveLocationFilter): void {
    this.archiveLocationFilter = archiveLocationFilter;
    this.clearVisibleEntriesCache();
  }

  public setProjectFilter(projectCwd: string | null): void {
    this.projectCwd = typeof projectCwd === "string" && projectCwd.trim().length > 0 ? projectCwd.trim() : null;
    this.canonicalProjectKeyCache.clear();
    this.clearVisibleEntriesCache();
    this.recomputeProjectFilterKeys();
  }

  public setProjectScopeFilter(projectScopeCwd: string | null): void {
    this.projectScopeCwd =
      typeof projectScopeCwd === "string" && projectScopeCwd.trim().length > 0 ? projectScopeCwd.trim() : null;
    this.canonicalProjectKeyCache.clear();
    this.clearVisibleEntriesCache();
    this.recomputeProjectFilterKeys();
  }

  public setProjectGrouped(projectGrouped: boolean): void {
    this.projectGrouped = projectGrouped;
    this.clearVisibleEntriesCache();
  }

  public setSortMode(sortMode: PinnedSortMode): void {
    this.sortMode = normalizePinnedSortMode(sortMode);
    this.clearVisibleEntriesCache();
  }

  public setFilters(
    filter: DateScope,
    projectCwd: string | null,
    projectScopeCwd: string | null,
    sourceFilter: SessionSourceFilter,
    tagFilter: readonly string[],
    archiveLocationFilter: ArchiveLocationFilter,
  ): void {
    // Update filters in bulk; the caller triggers refresh.
    this.setFilter(filter);
    this.setProjectFilter(projectCwd);
    this.setProjectScopeFilter(projectScopeCwd);
    this.setSourceFilter(sourceFilter);
    this.setTagFilter(tagFilter);
    this.setArchiveLocationFilter(archiveLocationFilter);
  }

  private matchesTags(fsPath: string): boolean {
    if (this.tagFilter.length === 0) return true;
    const ann = this.annotationStore.get(fsPath);
    if (!ann || ann.tags.length === 0) return false;
    const tagKeys = new Set(ann.tags.map((tag) => normalizeTagKey(tag)));
    return this.tagFilter.some((tag) => tagKeys.has(normalizeTagKey(tag)));
  }

  private matchesSource(session: SessionSummary): boolean {
    if (this.sourceFilter === "all") return true;
    return session.source === this.sourceFilter;
  }

  private matchesDateFilter(session: SessionSummary): boolean {
    const filter = this.filter;
    switch (filter.kind) {
      case "all":
        return true;
      case "year":
        return session.localDate.startsWith(`${filter.yyyy}-`);
      case "month":
        return session.localDate.startsWith(`${filter.ym}-`);
      case "day":
        return session.localDate === filter.ymd;
      default:
        return false;
    }
  }

  private matchesArchiveVisibility(session: SessionSummary): boolean {
    switch (this.archiveLocationFilter) {
      case "all":
        return true;
      case "archivedOnly":
        return session.source === "codex" && session.storage.archiveState === "archived";
      case "activeOnly":
      default:
        return session.storage.archiveState !== "archived";
    }
  }

  private matchesProject(session: SessionSummary): boolean {
    return matchProjectByCanonicalKey(getSessionCwd(session), {
      projectKey: this.projectCwdKey,
      projectScopeKey: this.projectScopeCwdKey,
    }, (cwd) => this.getCanonicalProjectKey(cwd));
  }

  private matchesMissingPinnedSource(fsPath: string): boolean {
    if (this.sourceFilter === "all") return true;
    const inferred = inferSourceFromFsPath(fsPath);
    if (!inferred) return true;
    return inferred === this.sourceFilter;
  }

  private matchesPinnedArchiveVisibility(pin: PinEntry): boolean {
    const archived = isArchivedPinEntry(pin);
    if (archived) return getConfig().enableCodexArchivedSessions && this.archiveLocationFilter !== "activeOnly";
    return this.archiveLocationFilter !== "archivedOnly";
  }

  public getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element instanceof ProjectNode) {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = element.description;
      item.contextValue = toTreeItemContextValue(element);
      item.iconPath = new vscode.ThemeIcon("root-folder");
      if (element.alias) {
        item.tooltip = this.buildProjectTooltip(element, true);
      } else {
        item.tooltip = this.buildProjectTooltip(element, false);
      }
      return item;
    }
    if (element instanceof RelatedGroupNode) {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = element.description;
      item.contextValue = toTreeItemContextValue(element);
      item.iconPath = new vscode.ThemeIcon("folder-library");
      item.tooltip = this.buildRelatedGroupTooltip(element);
      return item;
    }
    if (element instanceof SessionNode) {
      // Truncate the tree title to ~20 full-width characters (40 half-width units) and append "...".
      const shortTitle = truncateByDisplayWidth(element.session.displayTitle, 40, "...");
      const annotation = this.annotationStore.get(element.session.fsPath);
      const projectDisplayCwd = this.getProjectDisplayCwd(getSessionCwd(element.session));
      const projectAlias = this.projectAliasStore.getAliasByCwd(projectDisplayCwd);
      const dateAxis = getSessionDateAxisForPinnedSortMode(this.sortMode);
      const item = new vscode.TreeItem(
        `${formatSessionDateTimeForAxis(element.session, dateAxis)} ${shortTitle}`,
      );
      item.description = buildSessionDescription(element.session, annotation?.tags ?? [], projectAlias, projectDisplayCwd);
      item.contextValue = toTreeItemContextValue(element);
      // Show source-specific icons (Codex/Claude) in the list row.
      item.iconPath = this.resolveSourceIconPath(element.session.source);

      // Clicking the title opens the reusable viewer or a session tab depending on the preview setting.
      const previewOnSelection = getConfig().previewOpenOnSelection;
      item.command = {
        command: previewOnSelection ? "codexHistoryViewer.openSessionReusable" : "codexHistoryViewer.openSession",
        title: "",
        arguments: [element],
      };

      item.tooltip = buildSessionHoverTooltip({
        session: element.session,
        annotation: annotation ? { tags: annotation.tags, note: annotation.note } : null,
        label: String(item.label ?? ""),
        description: typeof item.description === "string" ? item.description : undefined,
        mode: getConfig().previewTooltipMode,
        projectAlias,
        projectDisplayCwd,
        primaryDateTime: getPinnedSessionTooltipDateTime(element.session, dateAxis),
        primaryDateLabelKey: getPinnedSessionTooltipDateLabelKey(dateAxis),
      });
      return item;
    }
    if (element instanceof MissingPinnedNode) {
      const item = new vscode.TreeItem(`${missingPinnedLabel()}`);
      item.description = element.fsPath;
      item.contextValue = toTreeItemContextValue(element);
      item.iconPath = new vscode.ThemeIcon("warning");
      item.tooltip = t("tree.tooltip.missingPinned", element.fsPath);
      return item;
    }
    if (element instanceof HistoryEmptyNode) {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.contextValue = toTreeItemContextValue(element);
      item.iconPath = new vscode.ThemeIcon(element.iconId);
      item.tooltip = element.label;
      return item;
    }
    if (element instanceof PinnedDropHintNode) {
      const item = new vscode.TreeItem(t("tree.pinned.dropHint"), vscode.TreeItemCollapsibleState.None);
      item.description = t("tree.pinned.dropHintDescription");
      item.contextValue = toTreeItemContextValue(element);
      item.iconPath = new vscode.ThemeIcon("pinned");
      item.tooltip = t("tree.pinned.dropHintTooltip");
      return item;
    }
    return new vscode.TreeItem("?");
  }

  public async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (element) {
      if (element instanceof ProjectNode) {
        return this.getProjectEntries(element.key).map((entry) => entry.node);
      }
      if (element instanceof RelatedGroupNode) {
        return [...element.children];
      }
      return [];
    }
    if (!this.initialLoadComplete) {
      return [new HistoryEmptyNode(t("history.empty.loading"), "sync~spin")];
    }

    const entries = this.collectVisibleEntries();
    if (this.projectGrouped) {
      const nodes = this.buildProjectNodes(entries);
      if (nodes.length === 0) return [new PinnedDropHintNode()];
      return nodes;
    }

    const nodes = entries.map((entry) => entry.node);
    // Show a drop target even in the initial empty state to avoid DnD no-op right after reload.
    if (nodes.length === 0) return [new PinnedDropHintNode()];
    return nodes;
  }

  private collectVisibleEntries(): PinnedVisibleEntry[] {
    if (this.visibleEntriesCache) return this.visibleEntriesCache;
    const pins = this.pinStore.getAll();
    const entries: PinnedVisibleEntry[] = [];
    for (const p of pins) {
      const s = this.historyService.findByFsPath(p.fsPath);
      if (s) {
        if (!this.matchesArchiveVisibility(s)) continue;
        if (!this.matchesDateFilter(s)) continue;
        if (!this.matchesSource(s)) continue;
        if (!this.matchesTags(s.fsPath)) continue;
        if (!this.matchesProject(s)) continue;
        const cwd = getSessionCwd(s);
        const originalProjectKey = cwd ? normalizeProjectKey(cwd) : NO_CWD_PROJECT_KEY;
        entries.push({
          projectKey: cwd ? this.getCanonicalProjectKey(cwd) : NO_CWD_PROJECT_KEY,
          relocationProjectKey: cwd ? this.getRelocationProjectKey(cwd) : NO_CWD_PROJECT_KEY,
          originalProjectKey,
          cwd,
          pinnedAt: p.pinnedAt,
          fsPath: s.fsPath,
          node: new SessionNode(s, true),
          session: s,
        });
      } else {
        if (this.filter.kind !== "all") continue;
        if (!this.matchesPinnedArchiveVisibility(p)) continue;
        if (!this.matchesMissingPinnedSource(p.fsPath)) continue;
        if (this.projectCwd) continue;
        entries.push({
          projectKey: NO_CWD_PROJECT_KEY,
          relocationProjectKey: NO_CWD_PROJECT_KEY,
          originalProjectKey: NO_CWD_PROJECT_KEY,
          cwd: null,
          pinnedAt: p.pinnedAt,
          fsPath: p.fsPath,
          node: new MissingPinnedNode(p.fsPath),
          session: null,
        });
      }
    }
    entries.sort((a, b) => comparePinnedVisibleEntries(a, b, this.sortMode));
    this.visibleEntriesCache = entries;
    this.projectEntriesByRelocationKey = buildProjectEntriesByRelocationKey(entries);
    return entries;
  }

  private getProjectEntries(projectKey: string): PinnedVisibleEntry[] {
    this.collectVisibleEntries();
    return this.projectEntriesByRelocationKey.get(projectKey) ?? [];
  }

  private clearVisibleEntriesCache(): void {
    this.visibleEntriesCache = null;
    this.projectEntriesByRelocationKey.clear();
  }

  private buildProjectNodes(entries: readonly PinnedVisibleEntry[]): TreeNode[] {
    const context = this.buildProjectBuildContext(entries);
    const projectOrder = buildPinnedProjectOrder(context.buckets);
    return buildProjectGroupTreeNodes({
      context,
      createProjectNode: (bucket, parentAssociation) => this.createProjectNodeFromBucket(bucket, parentAssociation),
      getRepresentativeCwd: (targetKey, bucket) =>
        this.projectAssociationStore.getRepresentativeTargetCwd(targetKey) ?? bucket?.cwd ?? null,
      getAliasByCwd: (cwd) => this.projectAliasStore.getAliasByCwd(cwd) ?? null,
      buildProjectLabel,
      compareNodes: (left, right) => comparePinnedProjectTreeNodes(left, right, projectOrder),
    });
  }

  private buildProjectBuildContext(entries: readonly PinnedVisibleEntry[]): PinnedProjectBuildContext {
    const buckets = new Map<string, PinnedProjectBucket>();
    for (const entry of entries) {
      const key = entry.relocationProjectKey;
      const existing = buckets.get(key);
      if (existing) {
        existing.entries.push(entry);
        if (entry.cwd && entry.originalProjectKey === key) {
          existing.cwd = entry.cwd;
          existing.hasTargetSession = true;
        } else if (entry.cwd) {
          existing.associatedSourceCwds.set(entry.originalProjectKey, entry.cwd);
        }
        continue;
      }
      const representativeCwd =
        entry.cwd && entry.originalProjectKey === key ? entry.cwd : this.projectAssociationStore.getRepresentativeTargetCwd(key);
      const associatedSourceCwds = new Map<string, string>();
      if (entry.cwd && entry.originalProjectKey !== key) {
        associatedSourceCwds.set(entry.originalProjectKey, entry.cwd);
      }
      buckets.set(key, {
        key,
        groupKey: entry.projectKey,
        cwd: representativeCwd ?? entry.cwd,
        entries: [entry],
        associatedSourceCwds,
        hasTargetSession: !!entry.cwd && entry.originalProjectKey === key,
      });
    }

    return {
      buckets,
      directGroupOnlySourcesByTargetKey: buildDirectGroupOnlySourcesByTargetKey(this.projectAssociationStore.getAll()),
    };
  }

  private createProjectNodeFromBucket(
    group: PinnedProjectBucket,
    parentAssociation: ProjectParentAssociation | null = null,
  ): ProjectNode {
    const first = group.entries[0] ?? null;
    const latestLabel = formatProjectLatestLabel(first, this.sortMode);
    const fallbackLabel = buildProjectLabel(group.cwd);
    const alias = this.projectAliasStore.getAliasByCwd(group.cwd) ?? null;
    const associatedSources = buildAssociatedSources(
      group.cwd ? this.projectAssociationStore.getRelocationSourcesForTargetCwd(group.cwd) : [],
      group.associatedSourceCwds,
    );
    return new ProjectNode({
      key: group.key,
      label: alias ?? fallbackLabel,
      cwd: group.cwd,
      alias,
      fallbackLabel,
      sessionCount: group.entries.length,
      latestLabel,
      description: buildProjectDescription(
        group.cwd,
        group.entries.length,
        associatedSources.length,
        !group.hasTargetSession && associatedSources.length > 0,
      ),
      associatedSources,
      targetMissingHistory: !group.hasTargetSession && associatedSources.length > 0,
      parentAssociation,
    });
  }

  private getCanonicalProjectKey(cwd: string): string {
    const key = normalizeProjectKey(cwd);
    const cached = this.canonicalProjectKeyCache.get(key);
    if (cached) return cached;
    const canonical = this.projectAssociationStore.getCanonicalProjectKey(cwd) ?? key;
    this.canonicalProjectKeyCache.set(key, canonical);
    return canonical;
  }

  private recomputeProjectFilterKeys(): void {
    this.projectCwdKey = this.projectCwd ? this.getCanonicalProjectKey(this.projectCwd) : null;
    this.projectScopeCwdKey = this.projectScopeCwd ? this.getCanonicalProjectKey(this.projectScopeCwd) : null;
  }

  private getRelocationProjectKey(cwd: string): string {
    return this.projectAssociationStore.getRelocationProjectKey(cwd) ?? normalizeProjectKey(cwd);
  }

  private getProjectDisplayCwd(cwd: string | null): string | null {
    if (!cwd) return null;
    return this.projectAssociationStore.getDisplayCwd(cwd) ?? cwd;
  }

  private buildProjectTooltip(element: ProjectNode, withAlias: boolean): string {
    const lines = [
      withAlias
        ? t(
            isPinnedAtSortMode(this.sortMode)
              ? "tree.tooltip.pinnedProject.pinnedAtWithAlias"
              : "tree.tooltip.pinnedProject.historyDateWithAlias",
            element.alias ?? element.label,
            element.cwd ?? t("tree.project.noCwd"),
            element.sessionCount,
            element.latestLabel,
          )
        : t(
            isPinnedAtSortMode(this.sortMode)
              ? "tree.tooltip.pinnedProject.pinnedAt"
              : "tree.tooltip.pinnedProject.historyDate",
            element.cwd ?? t("tree.project.noCwd"),
            element.sessionCount,
            element.latestLabel,
          ),
    ];
    if (element.targetMissingHistory) lines.push(t("projectAssociation.target.missingHistory"));
    appendAssociatedSourceLines(lines, element.associatedSources, formatProjectAssociationMode);
    return lines.join("\n");
  }

  private buildRelatedGroupTooltip(element: RelatedGroupNode): string {
    const lines = [
      t(
        "projectAssociation.group.tooltip",
        element.alias ?? element.fallbackLabel,
        element.cwd ?? t("tree.project.noCwd"),
        element.projectCount,
        element.sessionCount,
        element.latestLabel,
      ),
    ];
    appendAssociatedSourceLines(lines, element.directSources, formatProjectAssociationMode);
    return lines.join("\n");
  }

  private resolveSourceIconPath(source: SessionSource): { light: vscode.Uri; dark: vscode.Uri } {
    return source === "claude" ? this.claudeIconPath : this.codexIconPath;
  }

}

function normalizePinnedSortMode(value: unknown): PinnedSortMode {
  switch (value) {
    case "pinnedAtAsc":
    case "createdDesc":
    case "createdAsc":
    case "lastActivityDesc":
    case "lastActivityAsc":
    case "titleAsc":
    case "titleDesc":
      return value;
    case "historyDate":
      return getConfig().historyDateBasis === "lastActivity" ? "lastActivityDesc" : "createdDesc";
    case "pinnedAt":
    case "pinnedAtDesc":
    default:
      return "pinnedAtDesc";
  }
}

function comparePinnedVisibleEntries(
  left: PinnedVisibleEntry,
  right: PinnedVisibleEntry,
  sortMode: PinnedSortMode,
): number {
  switch (sortMode) {
    case "pinnedAtAsc":
      return compareByPinnedAt(left, right, "asc");
    case "createdDesc":
    case "createdAsc":
      return compareBySessionTime(left, right, sortMode, getSessionCreatedSortKey);
    case "lastActivityDesc":
    case "lastActivityAsc":
      return compareBySessionTime(left, right, sortMode, getSessionLastActivitySortKey);
    case "titleAsc":
    case "titleDesc":
      return compareBySessionTitle(left, right, sortMode);
    case "pinnedAtDesc":
    default:
      return compareByPinnedAt(left, right, "desc");
  }
}

function buildProjectEntriesByRelocationKey(
  entries: readonly PinnedVisibleEntry[],
): Map<string, PinnedVisibleEntry[]> {
  const out = new Map<string, PinnedVisibleEntry[]>();
  for (const entry of entries) {
    const bucket = out.get(entry.relocationProjectKey);
    if (bucket) bucket.push(entry);
    else out.set(entry.relocationProjectKey, [entry]);
  }
  return out;
}

function buildPinnedProjectOrder(buckets: ReadonlyMap<string, PinnedProjectBucket>): Map<string, number> {
  const out = new Map<string, number>();
  let index = 0;
  for (const key of buckets.keys()) {
    out.set(key, index);
    index += 1;
  }
  return out;
}

function comparePinnedProjectTreeNodes(
  left: TreeNode,
  right: TreeNode,
  projectOrder: ReadonlyMap<string, number>,
): number {
  const leftOrder = getPinnedProjectTreeOrder(left, projectOrder);
  const rightOrder = getPinnedProjectTreeOrder(right, projectOrder);
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return compareProjectTreeNodes(left, right);
}

function getPinnedProjectTreeOrder(node: TreeNode, projectOrder: ReadonlyMap<string, number>): number {
  if (node instanceof ProjectNode) {
    return projectOrder.get(node.key) ?? Number.MAX_SAFE_INTEGER;
  }
  if (node instanceof RelatedGroupNode) {
    const ownOrder = projectOrder.get(node.key);
    if (ownOrder !== undefined) return ownOrder;
    return node.children.reduce(
      (best, child) => Math.min(best, getPinnedProjectTreeOrder(child, projectOrder)),
      Number.MAX_SAFE_INTEGER,
    );
  }
  return Number.MAX_SAFE_INTEGER;
}

function compareByPinnedAt(left: PinnedVisibleEntry, right: PinnedVisibleEntry, direction: "asc" | "desc"): number {
  return (
    compareNumber(left.pinnedAt, right.pinnedAt, direction) ||
    compareSessionDisplayDate(left.session, right.session, direction) ||
    compareFsPath(left.fsPath, right.fsPath)
  );
}

function compareBySessionTime(
  left: PinnedVisibleEntry,
  right: PinnedVisibleEntry,
  sortMode: "createdDesc" | "createdAsc" | "lastActivityDesc" | "lastActivityAsc",
  getSortKey: (session: SessionSummary) => string | null,
): number {
  if (left.session && !right.session) return -1;
  if (!left.session && right.session) return 1;
  if (!left.session || !right.session) {
    return compareNumberDesc(left.pinnedAt, right.pinnedAt) || compareFsPath(left.fsPath, right.fsPath);
  }
  const direction = sortMode.endsWith("Asc") ? "asc" : "desc";
  return (
    compareNullableSessionSortKeys(getSortKey(left.session), getSortKey(right.session), direction) ||
    compareLabels(left.session.displayTitle, right.session.displayTitle) ||
    compareNumber(left.pinnedAt, right.pinnedAt, direction) ||
    compareFsPath(left.fsPath, right.fsPath)
  );
}

function compareBySessionTitle(
  left: PinnedVisibleEntry,
  right: PinnedVisibleEntry,
  sortMode: "titleAsc" | "titleDesc",
): number {
  if (left.session && !right.session) return -1;
  if (!left.session && right.session) return 1;
  if (!left.session || !right.session) {
    return compareNumberDesc(left.pinnedAt, right.pinnedAt) || compareFsPath(left.fsPath, right.fsPath);
  }
  const title = compareLabels(left.session.displayTitle, right.session.displayTitle);
  if (title !== 0) return sortMode === "titleDesc" ? -title : title;
  return (
    compareNullableSessionSortKeys(getSessionCreatedSortKey(left.session), getSessionCreatedSortKey(right.session), "desc") ||
    compareNumberDesc(left.pinnedAt, right.pinnedAt) ||
    compareFsPath(left.fsPath, right.fsPath)
  );
}

function compareSessionDisplayDate(left: SessionSummary | null, right: SessionSummary | null, direction: "asc" | "desc"): number {
  if (!left || !right) return 0;
  return compareNullableSessionSortKeys(getSessionDisplayDateSortKey(left), getSessionDisplayDateSortKey(right), direction);
}

function compareLabels(left: string, right: string): number {
  return String(left ?? "").localeCompare(String(right ?? ""), undefined, { sensitivity: "base", numeric: true });
}

function compareNumber(left: number, right: number, direction: "asc" | "desc"): number {
  return direction === "asc" ? compareNumberAsc(left, right) : compareNumberDesc(left, right);
}

function compareNumberAsc(left: number, right: number): number {
  const leftValue = Number.isFinite(left) ? left : 0;
  const rightValue = Number.isFinite(right) ? right : 0;
  return leftValue - rightValue;
}

function compareNumberDesc(left: number, right: number): number {
  const leftValue = Number.isFinite(left) ? left : 0;
  const rightValue = Number.isFinite(right) ? right : 0;
  return rightValue - leftValue;
}

function compareFsPath(left: string, right: string): number {
  return left.localeCompare(right);
}

function getSessionDateAxisForPinnedSortMode(sortMode: PinnedSortMode): SessionDateAxis {
  if (sortMode === "createdDesc" || sortMode === "createdAsc") return "started";
  if (sortMode === "lastActivityDesc" || sortMode === "lastActivityAsc") return "lastActivity";
  return "display";
}

function getPinnedSessionTooltipDateLabelKey(axis: SessionDateAxis) {
  if (!isPinnedSessionDateAxisDifferentFromBasis(axis)) return undefined;
  return sessionDateLabelKeyForAxis(getDateBasisAxis());
}

function getPinnedSessionTooltipDateTime(session: SessionSummary, axis: SessionDateAxis): string {
  return formatSessionDateTimeForAxis(
    session,
    isPinnedSessionDateAxisDifferentFromBasis(axis) ? getDateBasisAxis() : axis,
  );
}

function isPinnedSessionDateAxisDifferentFromBasis(axis: SessionDateAxis): boolean {
  if (axis === "display") return false;
  return axis !== getDateBasisAxis();
}

function getDateBasisAxis(): SessionDateAxis {
  return getConfig().historyDateBasis === "lastActivity" ? "lastActivity" : "started";
}

function formatProjectLatestLabel(entry: PinnedVisibleEntry | null, sortMode: PinnedSortMode): string {
  if (!entry) return "-";
  if (isPinnedAtSortMode(sortMode)) return formatPinnedAtLabel(entry.pinnedAt);
  if (!entry.session) return "-";
  if (sortMode === "createdDesc" || sortMode === "createdAsc") {
    return formatCreatedSessionDateLabel(entry.session);
  }
  if (sortMode === "lastActivityDesc" || sortMode === "lastActivityAsc") {
    return formatLastActivitySessionDateLabel(entry.session);
  }
  return formatSessionDateLabel(entry.session.localDate, entry.session.timeLabel);
}

function isPinnedAtSortMode(sortMode: PinnedSortMode): boolean {
  return sortMode === "pinnedAtDesc" || sortMode === "pinnedAtAsc";
}

function formatSessionDateLabel(date: string, time: string): string {
  const datePart = String(date ?? "").trim();
  const timePart = String(time ?? "").trim();
  if (!datePart) return "-";
  return timePart ? `${datePart} ${timePart}` : datePart;
}

function formatCreatedSessionDateLabel(session: SessionSummary): string {
  const started = formatSessionDateLabel(session.startedLocalDate, session.startedTimeLabel);
  return started === "-" ? formatSessionDateLabel(session.localDate, session.timeLabel) : started;
}

function formatLastActivitySessionDateLabel(session: SessionSummary): string {
  const lastActivity = formatSessionDateLabel(session.lastActivityLocalDate, session.lastActivityTimeLabel);
  return lastActivity === "-" ? formatCreatedSessionDateLabel(session) : lastActivity;
}

function formatPinnedAtLabel(pinnedAt: number): string {
  if (!Number.isFinite(pinnedAt) || pinnedAt <= 0) return "-";
  return formatYmdHmInTimeZone(new Date(pinnedAt), resolveDateTimeSettings().timeZone);
}

function getSessionCwd(session: SessionSummary): string | null {
  const cwd = typeof session.meta?.cwd === "string" ? session.meta.cwd.trim() : "";
  return cwd.length > 0 ? cwd : null;
}

function buildProjectLabel(cwd: string | null): string {
  if (!cwd) return t("tree.project.noCwd");
  const normalized = cwd.replace(/[\\/]+/g, path.sep);
  const base = path.basename(path.normalize(normalized)).trim();
  return base.length > 0 ? base : safeDisplayPath(cwd, 60);
}

function buildProjectDescription(
  cwd: string | null,
  pinCount: number,
  associatedSourceCount = 0,
  targetMissingHistory = false,
): string {
  if (!cwd) return String(pinCount);
  const parts = [`${pinCount}  ${safeDisplayPath(cwd, 56)}`];
  if (associatedSourceCount > 0) parts.push(t("projectAssociation.description.relatedPaths", associatedSourceCount));
  if (targetMissingHistory) parts.push(t("projectAssociation.target.missingHistory"));
  return parts.join("  ");
}

function formatProjectAssociationMode(mode: ProjectAssociatedSource["mode"]): string {
  return mode === "groupOnly" ? t("projectAssociation.mode.groupOnly") : t("projectAssociation.mode.relocate");
}

function normalizeTagFilter(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const tag = String(raw ?? "").trim();
    if (!tag) continue;
    const key = normalizeTagKey(tag);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

function normalizeTagKey(value: string): string {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeSourceFilter(value: SessionSourceFilter): SessionSourceFilter {
  if (value === "codex" || value === "claude") return value;
  return "all";
}

function inferSourceFromFsPath(fsPath: string): SessionSource | null {
  const cfg = getConfig();
  if (isPathInsideRoot(fsPath, cfg.sessionsRoot)) return "codex";
  if (isPathInsideRoot(fsPath, cfg.codexArchivedSessionsRoot)) return "codex";
  if (isPathInsideRoot(fsPath, cfg.claudeSessionsRoot)) return "claude";

  const base = path.basename(fsPath).toLowerCase();
  if (base.startsWith("rollout-")) return "codex";
  if (base.endsWith(".jsonl")) return "claude";
  return null;
}

function isArchivedPinEntry(pin: PinEntry): boolean {
  const cfg = getConfig();
  if (pin.archiveState === "archived") return true;
  if (pin.rootKind === "codexArchivedSessions") return true;
  return isPathInsideRoot(pin.fsPath, cfg.codexArchivedSessionsRoot);
}

function isPathInsideRoot(fsPath: string, rootPath: string): boolean {
  const root = String(rootPath ?? "").trim();
  if (!root) return false;
  const rel = path.relative(root, fsPath);
  if (!rel) return true;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}
