import * as path from "node:path";
import * as vscode from "vscode";
import type { HistoryService } from "../services/historyService";
import type { PinStore } from "../services/pinStore";
import type { SessionAnnotationStore } from "../services/sessionAnnotationStore";
import type { ProjectAliasStore } from "../services/projectAliasStore";
import { NO_CWD_PROJECT_KEY, type ProjectAssociationStore } from "../services/projectAssociationStore";
import {
  HistoryEmptyNode,
  SessionNode,
  DayNode,
  MonthNode,
  type ProjectAssociatedSource,
  type ProjectParentAssociation,
  type ProjectSortMetadata,
  RelatedGroupNode,
  ProjectDayNode,
  ProjectMonthNode,
  ProjectNode,
  ProjectYearNode,
  TreeNode,
  YearNode,
  toTreeItemContextValue,
} from "./treeNodes";
import type { ArchiveLocationFilter, SessionSourceFilter, SessionSummary } from "../sessions/sessionTypes";
import {
  compareNullableSessionSortKeys,
  getSessionCreatedSortKey,
  getSessionLastActivitySortKey,
  maxSessionSortKey,
  minSessionSortKey,
} from "../sessions/sessionSortKeys";
import type { DateScope } from "../types/dateScope";
import { getConfig } from "../settings";
import { normalizeProjectKey } from "../utils/fsUtils";
import { safeDisplayPath, truncateByDisplayWidth } from "../utils/textUtils";
import { t } from "../i18n";
import { buildSessionDescription } from "./sessionDescriptionUtils";
import {
  buildSessionHoverTooltip,
  formatSessionDateTimeForAxis,
  getSessionDatePartsForAxis,
  sessionDateLabelKeyForAxis,
  type SessionDateAxis,
} from "./sessionTooltipUtils";
import { matchProjectByCanonicalKey } from "../services/projectPathMapper";
import {
  appendAssociatedSourceLines,
  buildAssociatedSources,
  buildDirectGroupOnlySourcesByTargetKey,
  buildProjectGroupTreeNodes,
  type ProjectGroupTreeBuildContext,
} from "./projectGroupTreeBuilder";

export type HistoryViewMode = "date" | "latest";
export type HistorySortOrder =
  | "createdDesc"
  | "createdAsc"
  | "lastActivityDesc"
  | "lastActivityAsc"
  | "titleAsc"
  | "titleDesc";

export type HistoryRevealIdentity =
  | { kind: "session"; fsPath: string }
  | { kind: "project"; key: string; parentKey: string | null }
  | { kind: "relatedGroup"; key: string; parentKey: string | null }
  | { kind: "year"; year: string }
  | { kind: "month"; year: string; month: string }
  | { kind: "day"; year: string; month: string; day: string }
  | { kind: "projectYear"; projectKey: string; year: string }
  | { kind: "projectMonth"; projectKey: string; year: string; month: string }
  | { kind: "projectDay"; projectKey: string; year: string; month: string; day: string };

type HistoryProjectBucket = {
  key: string;
  groupKey: string;
  cwd: string | null;
  sessions: SessionSummary[];
  associatedSourceCwds: Map<string, string>;
  hasTargetSession: boolean;
};

type HistoryProjectBuildContext = ProjectGroupTreeBuildContext<HistoryProjectBucket>;

// Provides the history tree (year -> month -> day -> session).
export class HistoryTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly historyService: HistoryService;
  private readonly pinStore: PinStore;
  private readonly annotationStore: SessionAnnotationStore;
  private readonly projectAliasStore: ProjectAliasStore;
  private readonly projectAssociationStore: ProjectAssociationStore;
  private viewMode: HistoryViewMode;
  private filter: DateScope;
  private projectCwd: string | null;
  private projectCwdKey: string | null = null;
  private projectScopeCwd: string | null;
  private projectScopeCwdKey: string | null = null;
  private projectGrouped: boolean;
  private sourceFilter: SessionSourceFilter;
  private tagFilter: string[];
  private archiveLocationFilter: ArchiveLocationFilter;
  private sortOrder: HistorySortOrder;
  private initialLoadComplete = false;
  private readonly codexIconPath: { light: vscode.Uri; dark: vscode.Uri };
  private readonly claudeIconPath: { light: vscode.Uri; dark: vscode.Uri };
  private readonly canonicalProjectKeyCache = new Map<string, string>();
  private filteredSessionsCache: SessionSummary[] | null = null;
  private sortedSessionsCache: SessionSummary[] | null = null;
  private projectSessionsByRelocationKey = new Map<string, SessionSummary[]>();
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined | null | void>();
  public readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    historyService: HistoryService,
    pinStore: PinStore,
    annotationStore: SessionAnnotationStore,
    projectAliasStore: ProjectAliasStore,
    projectAssociationStore: ProjectAssociationStore,
    viewMode: HistoryViewMode,
    sortOrder: HistorySortOrder,
    filter: DateScope,
    projectCwd: string | null,
    projectScopeCwd: string | null,
    projectGrouped: boolean,
    sourceFilter: SessionSourceFilter,
    tagFilter: readonly string[],
    archiveLocationFilter: ArchiveLocationFilter,
    extensionUri: vscode.Uri,
  ) {
    this.historyService = historyService;
    this.pinStore = pinStore;
    this.annotationStore = annotationStore;
    this.projectAliasStore = projectAliasStore;
    this.projectAssociationStore = projectAssociationStore;
    this.viewMode = viewMode;
    this.sortOrder = normalizeHistorySortOrder(sortOrder);
    this.filter = filter;
    this.projectCwd = typeof projectCwd === "string" && projectCwd.trim().length > 0 ? projectCwd.trim() : null;
    this.projectScopeCwd =
      typeof projectScopeCwd === "string" && projectScopeCwd.trim().length > 0 ? projectScopeCwd.trim() : null;
    this.projectGrouped = projectGrouped;
    this.sourceFilter = normalizeSourceFilter(sourceFilter);
    this.tagFilter = normalizeTagFilter(tagFilter);
    this.archiveLocationFilter = archiveLocationFilter;
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
    this.clearSessionDerivedCaches();
    this.recomputeProjectFilterKeys();
    this.emitter.fire();
  }

  private clearSessionDerivedCaches(): void {
    this.filteredSessionsCache = null;
    this.sortedSessionsCache = null;
    this.projectSessionsByRelocationKey.clear();
  }

  public markInitialLoadComplete(): void {
    if (this.initialLoadComplete) return;
    this.initialLoadComplete = true;
    this.refresh();
  }

  public setFilter(filter: DateScope): void {
    this.filter = filter;
    this.clearSessionDerivedCaches();
  }

  public setViewMode(viewMode: HistoryViewMode): void {
    this.viewMode = normalizeHistoryViewMode(viewMode);
  }

  public setSortOrder(sortOrder: HistorySortOrder): void {
    this.sortOrder = normalizeHistorySortOrder(sortOrder);
    this.sortedSessionsCache = null;
    this.projectSessionsByRelocationKey.clear();
  }

  public setProjectFilter(projectCwd: string | null): void {
    this.projectCwd = typeof projectCwd === "string" && projectCwd.trim().length > 0 ? projectCwd.trim() : null;
    this.canonicalProjectKeyCache.clear();
    this.clearSessionDerivedCaches();
    this.recomputeProjectFilterKeys();
  }

  public setProjectScopeFilter(projectScopeCwd: string | null): void {
    this.projectScopeCwd =
      typeof projectScopeCwd === "string" && projectScopeCwd.trim().length > 0 ? projectScopeCwd.trim() : null;
    this.canonicalProjectKeyCache.clear();
    this.clearSessionDerivedCaches();
    this.recomputeProjectFilterKeys();
  }

  public setProjectGrouped(projectGrouped: boolean): void {
    this.projectGrouped = projectGrouped;
  }

  public setSourceFilter(sourceFilter: SessionSourceFilter): void {
    this.sourceFilter = normalizeSourceFilter(sourceFilter);
    this.clearSessionDerivedCaches();
  }

  public setTagFilter(tags: readonly string[]): void {
    this.tagFilter = normalizeTagFilter(tags);
    this.clearSessionDerivedCaches();
  }

  public setArchiveLocationFilter(archiveLocationFilter: ArchiveLocationFilter): void {
    this.archiveLocationFilter = archiveLocationFilter;
    this.clearSessionDerivedCaches();
  }

  public setFilters(
    filter: DateScope,
    projectCwd: string | null,
    projectScopeCwd: string | null,
    sourceFilter: SessionSourceFilter,
    tagFilter: readonly string[],
  ): void {
    // Update filters in bulk; the caller triggers refresh.
    this.setFilter(filter);
    this.setProjectFilter(projectCwd);
    this.setProjectScopeFilter(projectScopeCwd);
    this.setSourceFilter(sourceFilter);
    this.setTagFilter(tagFilter);
  }

  private matchesProject(session: SessionSummary): boolean {
    return matchProjectByCanonicalKey(session.meta?.cwd, {
      projectKey: this.projectCwdKey,
      projectScopeKey: this.projectScopeCwdKey,
    }, (cwd) => this.getCanonicalProjectKey(cwd));
  }

  private matchesTags(session: SessionSummary): boolean {
    if (this.tagFilter.length === 0) return true;
    const ann = this.annotationStore.get(session.fsPath);
    if (!ann || ann.tags.length === 0) return false;
    const tagKeys = new Set(ann.tags.map((tag) => normalizeTagKey(tag)));
    return this.tagFilter.some((tag) => tagKeys.has(normalizeTagKey(tag)));
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

  private matchesSession(session: SessionSummary): boolean {
    return (
      this.matchesArchiveVisibility(session) &&
      this.matchesDateFilter(session) &&
      this.matchesProject(session) &&
      this.matchesSource(session) &&
      this.matchesTags(session)
    );
  }

  private matchesSource(session: SessionSummary): boolean {
    if (this.sourceFilter === "all") return true;
    return session.source === this.sourceFilter;
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

  private buildNoHistoryNodes(): HistoryEmptyNode[] {
    const config = getConfig();
    const nodes = [new HistoryEmptyNode(t("history.empty.noHistory.title"), "info")];

    if (config.enableCodexSource && config.enableClaudeSource) {
      nodes.push(new HistoryEmptyNode(t("history.empty.noHistory.enabledRootsHint"), "folder-opened"));
    } else if (config.enableClaudeSource) {
      nodes.push(new HistoryEmptyNode(t("history.empty.noHistory.claudeHint"), "folder-opened"));
    } else {
      nodes.push(new HistoryEmptyNode(t("history.empty.noHistory.codexHint"), "folder-opened"));
    }

    nodes.push(new HistoryEmptyNode(t("history.empty.noHistory.refreshHint"), "refresh"));

    if (!config.enableClaudeSource) {
      nodes.push(new HistoryEmptyNode(t("history.empty.noHistory.claudeDisabled"), "settings-gear"));
    }

    return nodes;
  }

  private buildFilteredEmptyNodes(): HistoryEmptyNode[] {
    return [
      new HistoryEmptyNode(t("history.empty.filtered.title"), "filter"),
      new HistoryEmptyNode(t("history.empty.filtered.hint"), "info"),
    ];
  }

  private withFilteredEmptyFallback(nodes: TreeNode[], shouldFilterSessions: boolean): TreeNode[] {
    if (nodes.length > 0) return nodes;
    return shouldFilterSessions ? this.buildFilteredEmptyNodes() : nodes;
  }

  public getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element instanceof ProjectNode) {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = buildHistoryTreeItemId(element);
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
      item.id = buildHistoryTreeItemId(element);
      item.description = element.description;
      item.contextValue = toTreeItemContextValue(element);
      item.iconPath = new vscode.ThemeIcon("folder-library");
      item.tooltip = this.buildRelatedGroupTooltip(element);
      return item;
    }
    if (element instanceof ProjectYearNode) {
      const item = new vscode.TreeItem(element.year, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = buildHistoryTreeItemId(element);
      item.contextValue = toTreeItemContextValue(element);
      item.tooltip = t("tree.tooltip.year", element.year);
      return item;
    }
    if (element instanceof ProjectMonthNode) {
      const item = new vscode.TreeItem(element.month, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = buildHistoryTreeItemId(element);
      item.contextValue = toTreeItemContextValue(element);
      item.tooltip = t("tree.tooltip.month", `${element.year}-${element.month}`);
      return item;
    }
    if (element instanceof ProjectDayNode) {
      const item = new vscode.TreeItem(element.day, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = buildHistoryTreeItemId(element);
      item.description = element.ymd;
      item.contextValue = toTreeItemContextValue(element);
      item.tooltip = t("tree.tooltip.day", element.ymd);
      return item;
    }
    if (element instanceof YearNode) {
      const item = new vscode.TreeItem(element.year, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = buildHistoryTreeItemId(element);
      item.contextValue = toTreeItemContextValue(element);
      item.tooltip = t("tree.tooltip.year", element.year);
      return item;
    }
    if (element instanceof MonthNode) {
      const item = new vscode.TreeItem(element.month, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = buildHistoryTreeItemId(element);
      item.contextValue = toTreeItemContextValue(element);
      item.tooltip = t("tree.tooltip.month", `${element.year}-${element.month}`);
      return item;
    }
    if (element instanceof DayNode) {
      const item = new vscode.TreeItem(element.day, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = buildHistoryTreeItemId(element);
      item.description = element.ymd;
      item.contextValue = toTreeItemContextValue(element);
      item.tooltip = t("tree.tooltip.day", element.ymd);
      return item;
    }
    if (element instanceof SessionNode) {
      return this.sessionToTreeItem(element.session, element.pinned);
    }
    if (element instanceof HistoryEmptyNode) {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.contextValue = toTreeItemContextValue(element);
      item.iconPath = new vscode.ThemeIcon(element.iconId);
      item.tooltip = element.label;
      return item;
    }
    // Search nodes are not used in this view.
    return new vscode.TreeItem("?");
  }

  private sessionToTreeItem(session: SessionSummary, pinned: boolean): vscode.TreeItem {
    // Truncate the tree title to ~20 full-width characters (40 half-width units) and append "...".
    const shortTitle = truncateByDisplayWidth(session.displayTitle, 40, "...");
    const dateAxis = this.getSessionRowDateAxis();
    const prefix = this.formatSessionRowDatePrefix(session, dateAxis);
    const label = `${prefix} ${shortTitle}`;
    const node = new SessionNode(session, pinned);
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = buildHistoryTreeItemId(node);
    const annotation = this.annotationStore.get(session.fsPath);
    const projectDisplayCwd = this.getProjectDisplayCwd(getSessionCwd(session));
    const projectAlias = this.projectAliasStore.getAliasByCwd(projectDisplayCwd);
    item.description = buildSessionDescription(session, annotation?.tags ?? [], projectAlias, projectDisplayCwd);
    item.contextValue = toTreeItemContextValue(node);
    // Show source-specific icons (Codex/Claude) in the list row.
    item.iconPath = this.resolveSourceIconPath(session.source);

    // Clicking the title opens the reusable viewer or a session tab depending on the preview setting.
    const previewOnSelection = getConfig().previewOpenOnSelection;
    item.command = {
      command: previewOnSelection ? "codexHistoryViewer.openSessionReusable" : "codexHistoryViewer.openSession",
      title: "",
      arguments: [node],
    };

    item.tooltip = buildSessionHoverTooltip({
      session,
      annotation: annotation ? { tags: annotation.tags, note: annotation.note } : null,
      label,
      description: typeof item.description === "string" ? item.description : undefined,
      mode: getConfig().previewTooltipMode,
      projectAlias,
      projectDisplayCwd,
      primaryDateTime: this.getSessionTooltipDateTime(session, dateAxis),
      primaryDateLabelKey: this.getSessionTooltipDateLabelKey(dateAxis),
    });
    return item;
  }

  private getSessionRowDateAxis(): SessionDateAxis {
    if (this.sortOrder === "createdAsc" || this.sortOrder === "createdDesc") return "started";
    if (this.sortOrder === "lastActivityAsc" || this.sortOrder === "lastActivityDesc") return "lastActivity";
    return "display";
  }

  private formatSessionRowDatePrefix(session: SessionSummary, axis: SessionDateAxis): string {
    const shouldShowFullDate = this.viewMode === "latest" || this.isDateAxisDifferentFromBasis(axis);
    if (shouldShowFullDate) return formatSessionDateTimeForAxis(session, axis);

    const parts = getSessionDatePartsForAxis(session, axis);
    return parts.timeLabel || formatSessionDateTimeForAxis(session, axis);
  }

  private getSessionTooltipDateLabelKey(axis: SessionDateAxis) {
    if (!this.isDateAxisDifferentFromBasis(axis)) return undefined;
    return sessionDateLabelKeyForAxis(this.getDateBasisAxis());
  }

  private getSessionTooltipDateTime(session: SessionSummary, axis: SessionDateAxis): string {
    return formatSessionDateTimeForAxis(
      session,
      this.isDateAxisDifferentFromBasis(axis) ? this.getDateBasisAxis() : axis,
    );
  }

  private isDateAxisDifferentFromBasis(axis: SessionDateAxis): boolean {
    if (axis === "display") return false;
    return axis !== this.getDateBasisAxis();
  }

  private getDateBasisAxis(): SessionDateAxis {
    return getConfig().historyDateBasis === "lastActivity" ? "lastActivity" : "started";
  }

  private resolveSourceIconPath(source: SessionSummary["source"]): { light: vscode.Uri; dark: vscode.Uri } {
    return source === "claude" ? this.claudeIconPath : this.codexIconPath;
  }

  private getFilteredSessions(): SessionSummary[] {
    if (this.filteredSessionsCache) return this.filteredSessionsCache;
    this.filteredSessionsCache = this.historyService.getIndex().sessions.filter((s) => this.matchesSession(s));
    return this.filteredSessionsCache;
  }

  private getSortedSessions(): SessionSummary[] {
    if (this.sortedSessionsCache) return this.sortedSessionsCache;
    this.sortedSessionsCache = this.sortSessions(this.getFilteredSessions());
    return this.sortedSessionsCache;
  }

  private sortSessions(sessions: readonly SessionSummary[]): SessionSummary[] {
    return sessions.slice().sort((left, right) => compareSessionsBySortOrder(left, right, this.sortOrder));
  }

  private buildProjectNodes(sessions: readonly SessionSummary[]): TreeNode[] {
    const context = this.buildProjectBuildContext(sessions);
    return buildProjectGroupTreeNodes({
      context,
      createProjectNode: (bucket, parentAssociation) => this.createProjectNodeFromBucket(bucket, parentAssociation),
      getRepresentativeCwd: (targetKey, bucket) => this.getRepresentativeCwdForProjectKey(targetKey, bucket?.cwd ?? null),
      getAliasByCwd: (cwd) => this.projectAliasStore.getAliasByCwd(cwd) ?? null,
      buildProjectLabel,
      compareNodes: (left, right) => this.compareProjectTreeNodes(left, right),
    });
  }

  private buildProjectBuildContext(sessions: readonly SessionSummary[]): HistoryProjectBuildContext {
    const buckets = new Map<string, HistoryProjectBucket>();
    for (const session of sessions) {
      const cwd = getSessionCwd(session);
      const rawKey = cwd ? normalizeProjectKey(cwd) : NO_CWD_PROJECT_KEY;
      const groupKey = cwd ? this.getCanonicalProjectKey(cwd) : NO_CWD_PROJECT_KEY;
      const key = cwd ? this.getRelocationProjectKey(cwd) : NO_CWD_PROJECT_KEY;
      const existing = buckets.get(key);
      if (existing) {
        existing.sessions.push(session);
        if (cwd && rawKey === key) {
          existing.cwd = cwd;
          existing.hasTargetSession = true;
        } else if (cwd) {
          existing.associatedSourceCwds.set(rawKey, cwd);
        }
        continue;
      }
      const representativeCwd = this.getRepresentativeCwdForProjectKey(key, cwd && rawKey === key ? cwd : null);
      const associatedSourceCwds = new Map<string, string>();
      if (cwd && rawKey !== key) associatedSourceCwds.set(rawKey, cwd);
      buckets.set(key, {
        key,
        groupKey,
        cwd: representativeCwd ?? cwd,
        sessions: [session],
        associatedSourceCwds,
        hasTargetSession: !!cwd && rawKey === key,
      });
    }

    this.projectSessionsByRelocationKey = new Map(
      Array.from(buckets.entries()).map(([key, bucket]) => [key, bucket.sessions.slice()]),
    );

    return {
      buckets,
      directGroupOnlySourcesByTargetKey: buildDirectGroupOnlySourcesByTargetKey(this.projectAssociationStore.getAll()),
    };
  }

  private createProjectNodeFromBucket(
    group: HistoryProjectBucket,
    parentAssociation: ProjectParentAssociation | null = null,
  ): ProjectNode {
    const fallbackLabel = buildProjectLabel(group.cwd);
    const alias = this.projectAliasStore.getAliasByCwd(group.cwd) ?? null;
    const label = alias ?? fallbackLabel;
    const associatedSources = buildAssociatedSources(
      group.cwd ? this.projectAssociationStore.getRelocationSourcesForTargetCwd(group.cwd) : [],
      group.associatedSourceCwds,
    );
    const sort = buildProjectSortMetadata(group.key, group.sessions);
    const description = buildProjectDescription(
      group.cwd,
      group.sessions.length,
      associatedSources.length,
      !group.hasTargetSession && associatedSources.length > 0,
    );
    return new ProjectNode({
      key: group.key,
      label,
      cwd: group.cwd,
      alias,
      fallbackLabel,
      sessionCount: group.sessions.length,
      latestLabel: buildLatestDisplayLabel(group.sessions),
      description,
      associatedSources,
      targetMissingHistory: !group.hasTargetSession && associatedSources.length > 0,
      parentAssociation,
      sort,
    });
  }

  private getProjectSessions(projectKey: string): SessionSummary[] {
    const cached = this.projectSessionsByRelocationKey.get(projectKey);
    if (cached) return cached;
    return this.getSortedSessions().filter((session) => {
      const cwd = getSessionCwd(session);
      const key = cwd ? this.getRelocationProjectKey(cwd) : NO_CWD_PROJECT_KEY;
      return key === projectKey;
    });
  }

  private compareProjectTreeNodes(left: TreeNode, right: TreeNode): number {
    if (!(left instanceof ProjectNode || left instanceof RelatedGroupNode)) {
      if (!(right instanceof ProjectNode || right instanceof RelatedGroupNode)) return 0;
      return 1;
    }
    if (!(right instanceof ProjectNode || right instanceof RelatedGroupNode)) return -1;

    if (this.sortOrder === "titleAsc" || this.sortOrder === "titleDesc") {
      const label = compareLabels(left.label, right.label);
      if (label !== 0) return this.sortOrder === "titleDesc" ? -label : label;
      return left.sort.stableKey.localeCompare(right.sort.stableKey);
    }

    const primary =
      this.sortOrder === "createdAsc" || this.sortOrder === "createdDesc"
        ? compareNullableSessionSortKeys(
            left.sort.createdSortKey,
            right.sort.createdSortKey,
            this.sortOrder === "createdAsc" ? "asc" : "desc",
          )
        : compareNullableSessionSortKeys(
            left.sort.lastActivitySortKey,
            right.sort.lastActivitySortKey,
            this.sortOrder === "lastActivityAsc" ? "asc" : "desc",
          );
    if (primary !== 0) return primary;

    const label = compareLabels(left.label, right.label);
    if (label !== 0) return label;
    return left.sort.stableKey.localeCompare(right.sort.stableKey);
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

  private getRepresentativeCwdForProjectKey(projectKey: string, fallbackCwd: string | null): string | null {
    if (projectKey === NO_CWD_PROJECT_KEY) return null;
    return this.projectAssociationStore.getRepresentativeTargetCwd(projectKey) ?? fallbackCwd;
  }

  private getProjectDisplayCwd(cwd: string | null): string | null {
    if (!cwd) return null;
    return this.projectAssociationStore.getDisplayCwd(cwd) ?? cwd;
  }

  private buildProjectTooltip(element: ProjectNode, withAlias: boolean): string {
    const lines = [
      withAlias
        ? t(
            "tree.tooltip.projectWithAlias",
            element.alias ?? element.label,
            element.cwd ?? t("tree.project.noCwd"),
            element.sessionCount,
            element.latestLabel,
          )
        : t(
            "tree.tooltip.project",
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

  private buildProjectChildren(element: TreeNode | undefined, shouldFilterSessions: boolean): TreeNode[] {
    if (!element) {
      const nodes = this.buildProjectNodes(this.getSortedSessions());
      return this.withFilteredEmptyFallback(nodes, shouldFilterSessions);
    }

    if (element instanceof ProjectNode) {
      const sessions = this.getProjectSessions(element.key);
      if (this.viewMode === "latest") return sessions.map((s) => new SessionNode(s, this.pinStore.isPinned(s.fsPath)));

      const filter = this.filter;
      switch (filter.kind) {
        case "all":
          return uniqueDateParts(sessions, "year").map((year) => new ProjectYearNode(element.key, year));
        case "year":
          return uniqueDateParts(sessions, "month").map((month) => new ProjectMonthNode(element.key, filter.yyyy, month));
        case "month": {
          const [yyyy, mm] = filter.ym.split("-");
          if (!yyyy || !mm) return [];
          return uniqueDateParts(sessions, "day").map((day) => new ProjectDayNode(element.key, yyyy, mm, day));
        }
        case "day":
          return sessions.map((s) => new SessionNode(s, this.pinStore.isPinned(s.fsPath)));
        default:
          return [];
      }
    }

    if (element instanceof RelatedGroupNode) {
      return [...element.children];
    }

    if (element instanceof ProjectYearNode) {
      const sessions = this
        .getProjectSessions(element.projectKey)
        .filter((session) => session.localDate.startsWith(`${element.year}-`));
      return uniqueDateParts(sessions, "month").map((month) => new ProjectMonthNode(element.projectKey, element.year, month));
    }

    if (element instanceof ProjectMonthNode) {
      const ym = `${element.year}-${element.month}`;
      const sessions = this
        .getProjectSessions(element.projectKey)
        .filter((session) => session.localDate.startsWith(`${ym}-`));
      return uniqueDateParts(sessions, "day").map((day) => new ProjectDayNode(element.projectKey, element.year, element.month, day));
    }

    if (element instanceof ProjectDayNode) {
      const sessions = this
        .getProjectSessions(element.projectKey)
        .filter((session) => session.localDate === element.ymd);
      return sessions.map((s) => new SessionNode(s, this.pinStore.isPinned(s.fsPath)));
    }

    return [];
  }

  public getParent(element: TreeNode): TreeNode | null {
    const identity = this.createRevealIdentity(element);
    if (!identity) return null;
    return this.findParentForIdentity(identity, undefined);
  }

  public createRevealIdentity(element: TreeNode | undefined): HistoryRevealIdentity | null {
    if (!element) return null;
    if (element instanceof SessionNode) return { kind: "session", fsPath: element.session.fsPath };
    if (element instanceof ProjectNode) {
      return { kind: "project", key: element.key, parentKey: getProjectParentKey(element.parentAssociation) };
    }
    if (element instanceof RelatedGroupNode) {
      return { kind: "relatedGroup", key: element.key, parentKey: getProjectParentKey(element.parentAssociation) };
    }
    if (element instanceof YearNode) return { kind: "year", year: element.year };
    if (element instanceof MonthNode) return { kind: "month", year: element.year, month: element.month };
    if (element instanceof DayNode) return { kind: "day", year: element.year, month: element.month, day: element.day };
    if (element instanceof ProjectYearNode) return { kind: "projectYear", projectKey: element.projectKey, year: element.year };
    if (element instanceof ProjectMonthNode) {
      return { kind: "projectMonth", projectKey: element.projectKey, year: element.year, month: element.month };
    }
    if (element instanceof ProjectDayNode) {
      return {
        kind: "projectDay",
        projectKey: element.projectKey,
        year: element.year,
        month: element.month,
        day: element.day,
      };
    }
    return null;
  }

  public resolveRevealTarget(identity: HistoryRevealIdentity): TreeNode | null {
    return this.findRevealTarget(identity, undefined);
  }

  private findRevealTarget(identity: HistoryRevealIdentity, parent: TreeNode | undefined): TreeNode | null {
    for (const child of this.getChildrenSync(parent)) {
      if (matchesRevealIdentity(child, identity)) return child;
      const nested = this.findRevealTarget(identity, child);
      if (nested) return nested;
    }
    return null;
  }

  private findParentForIdentity(identity: HistoryRevealIdentity, parent: TreeNode | undefined): TreeNode | null {
    for (const child of this.getChildrenSync(parent)) {
      if (matchesRevealIdentity(child, identity)) return parent ?? null;
      const nested = this.findParentForIdentity(identity, child);
      if (nested) return nested;
    }
    return null;
  }

  public async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    return this.getChildrenSync(element);
  }

  private getChildrenSync(element?: TreeNode): TreeNode[] {
    if (!element && !this.initialLoadComplete) {
      return [new HistoryEmptyNode(t("history.empty.loading"), "sync~spin")];
    }

    const idx = this.historyService.getIndex();
    if (!element && idx.sessions.length === 0) return this.buildNoHistoryNodes();

    const shouldFilterSessions =
      this.archiveLocationFilter !== "all" ||
      this.filter.kind !== "all" ||
      !!this.projectCwd ||
      !!this.projectScopeCwd ||
      this.sourceFilter !== "all" ||
      this.tagFilter.length > 0;
    if (this.projectGrouped) {
      return this.buildProjectChildren(element, shouldFilterSessions);
    }
    if (this.viewMode === "latest") {
      if (element) return [];
      const nodes = this.getSortedSessions().map((s) => new SessionNode(s, this.pinStore.isPinned(s.fsPath)));
      return this.withFilteredEmptyFallback(nodes, shouldFilterSessions);
    }

    if (!element) {
      const filter = this.filter;
      switch (filter.kind) {
        case "all": {
          const years = Array.from(idx.byY.keys()).sort((a, b) => (a < b ? 1 : -1));
          if (!shouldFilterSessions) return years.map((y) => new YearNode(y));

          // When project filtering is active, show only years that contain matching sessions.
          const out: YearNode[] = [];
          for (const y of years) {
            const months = idx.byY.get(y);
            if (!months) continue;
            let has = false;
            for (const [, days] of months) {
              for (const [, list] of days) {
                if (list.some((s) => this.matchesSession(s))) {
                  has = true;
                  break;
                }
              }
              if (has) break;
            }
            if (has) out.push(new YearNode(y));
          }
          return this.withFilteredEmptyFallback(out, shouldFilterSessions);
        }
        case "year": {
          const months = idx.byY.get(filter.yyyy);
          if (!months) return this.buildFilteredEmptyNodes();
          const keys = Array.from(months.keys()).sort((a, b) => (a < b ? 1 : -1));
          if (!shouldFilterSessions) return this.withFilteredEmptyFallback(keys.map((m) => new MonthNode(filter.yyyy, m)), true);

          // When filtering is active, show only months that contain matching sessions.
          const out: MonthNode[] = [];
          for (const m of keys) {
            const days = months.get(m);
            if (!days) continue;
            let has = false;
            for (const [, list] of days) {
              if (list.some((s) => this.matchesSession(s))) {
                has = true;
                break;
              }
            }
            if (has) out.push(new MonthNode(filter.yyyy, m));
          }
          return this.withFilteredEmptyFallback(out, shouldFilterSessions);
        }
        case "month": {
          const [yyyy, mm] = filter.ym.split("-");
          if (!yyyy || !mm) return [];
          const days = idx.byY.get(yyyy)?.get(mm);
          if (!days) return this.buildFilteredEmptyNodes();
          const keys = Array.from(days.keys()).sort((a, b) => (a < b ? 1 : -1));
          if (!shouldFilterSessions) return this.withFilteredEmptyFallback(keys.map((d) => new DayNode(yyyy, mm, d)), true);

          // When filtering is active, show only days that contain matching sessions.
          const out: DayNode[] = [];
          for (const d of keys) {
            const sessions = days.get(d) ?? [];
            if (sessions.some((s) => this.matchesSession(s))) out.push(new DayNode(yyyy, mm, d));
          }
          return this.withFilteredEmptyFallback(out, shouldFilterSessions);
        }
        case "day": {
          const [yyyy, mm, dd] = filter.ymd.split("-");
          if (!yyyy || !mm || !dd) return [];
          const sessions = idx.byY.get(yyyy)?.get(mm)?.get(dd) ?? [];
          const filtered = this.sortSessions(sessions.filter((s) => this.matchesSession(s)));
          return this.withFilteredEmptyFallback(
            filtered.map((s) => new SessionNode(s, this.pinStore.isPinned(s.fsPath))),
            true,
          );
        }
        default:
          return [];
      }
    }
    if (element instanceof YearNode) {
      const months = idx.byY.get(element.year);
      if (!months) return [];
      const keys = Array.from(months.keys()).sort((a, b) => (a < b ? 1 : -1));
      if (!shouldFilterSessions) return keys.map((m) => new MonthNode(element.year, m));

      const out: MonthNode[] = [];
      for (const m of keys) {
        const days = months.get(m);
        if (!days) continue;
        let has = false;
        for (const [, list] of days) {
          if (list.some((s) => this.matchesSession(s))) {
            has = true;
            break;
          }
        }
        if (has) out.push(new MonthNode(element.year, m));
      }
      return out;
    }
    if (element instanceof MonthNode) {
      const days = idx.byY.get(element.year)?.get(element.month);
      if (!days) return [];
      const keys = Array.from(days.keys()).sort((a, b) => (a < b ? 1 : -1));
      if (!shouldFilterSessions) return keys.map((d) => new DayNode(element.year, element.month, d));

      const out: DayNode[] = [];
      for (const d of keys) {
        const sessions = days.get(d) ?? [];
        if (sessions.some((s) => this.matchesSession(s))) out.push(new DayNode(element.year, element.month, d));
      }
      return out;
    }
    if (element instanceof DayNode) {
      const sessions = idx.byY.get(element.year)?.get(element.month)?.get(element.day) ?? [];
      const filtered = this.sortSessions(sessions.filter((s) => this.matchesSession(s)));
      return filtered.map((s) => new SessionNode(s, this.pinStore.isPinned(s.fsPath)));
    }
    return [];
  }
}

function normalizeTagFilter(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const tag = String(value ?? "").trim();
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
  return value === "codex" || value === "claude" ? value : "all";
}

function normalizeHistoryViewMode(value: HistoryViewMode): HistoryViewMode {
  return value === "latest" ? "latest" : "date";
}

function normalizeHistorySortOrder(value: HistorySortOrder): HistorySortOrder {
  switch (value) {
    case "createdDesc":
    case "createdAsc":
    case "lastActivityDesc":
    case "lastActivityAsc":
    case "titleAsc":
    case "titleDesc":
      return value;
    default:
      return "createdDesc";
  }
}

function compareSessionsBySortOrder(
  left: SessionSummary,
  right: SessionSummary,
  sortOrder: HistorySortOrder,
): number {
  if (sortOrder === "titleAsc" || sortOrder === "titleDesc") {
    const title = compareLabels(left.displayTitle, right.displayTitle);
    if (title !== 0) return sortOrder === "titleDesc" ? -title : title;
    const created = compareNullableSessionSortKeys(getSessionCreatedSortKey(left), getSessionCreatedSortKey(right), "desc");
    if (created !== 0) return created;
    return compareStableSessionPath(left, right);
  }

  const primary =
    sortOrder === "createdAsc" || sortOrder === "createdDesc"
      ? compareNullableSessionSortKeys(
          getSessionCreatedSortKey(left),
          getSessionCreatedSortKey(right),
          sortOrder === "createdAsc" ? "asc" : "desc",
        )
      : compareNullableSessionSortKeys(
          getSessionLastActivitySortKey(left),
          getSessionLastActivitySortKey(right),
          sortOrder === "lastActivityAsc" ? "asc" : "desc",
        );
  if (primary !== 0) return primary;

  const title = compareLabels(left.displayTitle, right.displayTitle);
  if (title !== 0) return title;
  return compareStableSessionPath(left, right);
}

function buildProjectSortMetadata(stableKey: string, sessions: readonly SessionSummary[]): ProjectSortMetadata {
  let createdSortKey: string | null = null;
  let lastActivitySortKey: string | null = null;
  for (const session of sessions) {
    createdSortKey = minSessionSortKey(createdSortKey, getSessionCreatedSortKey(session));
    lastActivitySortKey = maxSessionSortKey(lastActivitySortKey, getSessionLastActivitySortKey(session));
  }
  return { createdSortKey, lastActivitySortKey, stableKey };
}

function buildLatestDisplayLabel(sessions: readonly SessionSummary[]): string {
  let latest = "";
  for (const session of sessions) {
    const label = `${session.localDate} ${session.timeLabel}`;
    if (!latest || latest < label) latest = label;
  }
  return latest;
}

function compareLabels(left: string, right: string): number {
  return String(left ?? "").localeCompare(String(right ?? ""), undefined, { sensitivity: "base", numeric: true });
}

function compareStableSessionPath(left: SessionSummary, right: SessionSummary): number {
  return left.fsPath.localeCompare(right.fsPath);
}

function getProjectParentKey(parentAssociation: ProjectParentAssociation | null): string | null {
  return parentAssociation ? `${parentAssociation.mode}:${parentAssociation.targetCwd}:${parentAssociation.sourceCwd}` : null;
}

function buildHistoryTreeItemId(node: TreeNode): string | undefined {
  switch (node.kind) {
    case "session":
      return `history:session:${encodeTreeItemIdPart(node.session.cacheKey || node.session.fsPath)}`;
    case "project":
      return `history:project:${encodeTreeItemIdPart(getProjectParentKey(node.parentAssociation))}:${encodeTreeItemIdPart(node.key)}`;
    case "relatedGroup":
      return `history:relatedGroup:${encodeTreeItemIdPart(getProjectParentKey(node.parentAssociation))}:${encodeTreeItemIdPart(node.key)}`;
    case "year":
      return `history:date:${encodeTreeItemIdPart(node.year)}`;
    case "month":
      return `history:date:${encodeTreeItemIdPart(`${node.year}-${node.month}`)}`;
    case "day":
      return `history:date:${encodeTreeItemIdPart(node.ymd)}`;
    case "projectYear":
      return `history:project-date:${encodeTreeItemIdPart(node.projectKey)}:${encodeTreeItemIdPart(node.year)}`;
    case "projectMonth":
      return `history:project-date:${encodeTreeItemIdPart(node.projectKey)}:${encodeTreeItemIdPart(`${node.year}-${node.month}`)}`;
    case "projectDay":
      return `history:project-date:${encodeTreeItemIdPart(node.projectKey)}:${encodeTreeItemIdPart(node.ymd)}`;
    default:
      return undefined;
  }
}

function encodeTreeItemIdPart(value: string | null | undefined): string {
  return encodeURIComponent(value ?? "<null>");
}

function matchesRevealIdentity(node: TreeNode, identity: HistoryRevealIdentity): boolean {
  switch (identity.kind) {
    case "session":
      return node instanceof SessionNode && node.session.fsPath === identity.fsPath;
    case "project":
      return node instanceof ProjectNode && node.key === identity.key && getProjectParentKey(node.parentAssociation) === identity.parentKey;
    case "relatedGroup":
      return (
        node instanceof RelatedGroupNode &&
        node.key === identity.key &&
        getProjectParentKey(node.parentAssociation) === identity.parentKey
      );
    case "year":
      return node instanceof YearNode && node.year === identity.year;
    case "month":
      return node instanceof MonthNode && node.year === identity.year && node.month === identity.month;
    case "day":
      return node instanceof DayNode && node.year === identity.year && node.month === identity.month && node.day === identity.day;
    case "projectYear":
      return node instanceof ProjectYearNode && node.projectKey === identity.projectKey && node.year === identity.year;
    case "projectMonth":
      return (
        node instanceof ProjectMonthNode &&
        node.projectKey === identity.projectKey &&
        node.year === identity.year &&
        node.month === identity.month
      );
    case "projectDay":
      return (
        node instanceof ProjectDayNode &&
        node.projectKey === identity.projectKey &&
        node.year === identity.year &&
        node.month === identity.month &&
        node.day === identity.day
      );
    default:
      return false;
  }
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
  sessionCount: number,
  associatedSourceCount = 0,
  targetMissingHistory = false,
): string {
  if (!cwd) return String(sessionCount);
  const parts = [`${sessionCount}  ${safeDisplayPath(cwd, 56)}`];
  if (associatedSourceCount > 0) parts.push(t("projectAssociation.description.relatedPaths", associatedSourceCount));
  if (targetMissingHistory) parts.push(t("projectAssociation.target.missingHistory"));
  return parts.join("  ");
}

function formatProjectAssociationMode(mode: ProjectAssociatedSource["mode"]): string {
  return mode === "groupOnly" ? t("projectAssociation.mode.groupOnly") : t("projectAssociation.mode.relocate");
}

function uniqueDateParts(sessions: readonly SessionSummary[], part: "year" | "month" | "day"): string[] {
  const values: string[] = [];
  const seen = new Set<string>();
  for (const session of sessions) {
    const [year, month, day] = session.localDate.split("-");
    const value = part === "year" ? year : part === "month" ? month : day;
    if (!value || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  values.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return values;
}
