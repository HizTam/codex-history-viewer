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
import type { DateScope } from "../types/dateScope";
import { getConfig } from "../settings";
import { normalizeProjectKey } from "../utils/fsUtils";
import { safeDisplayPath, truncateByDisplayWidth } from "../utils/textUtils";
import { t } from "../i18n";
import { buildSessionDescription } from "./sessionDescriptionUtils";
import { buildSessionHoverTooltip } from "./sessionTooltipUtils";
import { matchProjectByCanonicalKey } from "../services/projectPathMapper";
import {
  appendAssociatedSourceLines,
  buildAssociatedSources,
  buildDirectGroupOnlySourcesByTargetKey,
  buildProjectGroupTreeNodes,
  compareProjectTreeNodes,
  type ProjectGroupTreeBuildContext,
} from "./projectGroupTreeBuilder";

export type HistoryViewMode = "date" | "latest";

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
  private initialLoadComplete = false;
  private readonly codexIconPath: { light: vscode.Uri; dark: vscode.Uri };
  private readonly claudeIconPath: { light: vscode.Uri; dark: vscode.Uri };
  private readonly canonicalProjectKeyCache = new Map<string, string>();
  private filteredSessionsCache: SessionSummary[] | null = null;
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
    if (element instanceof ProjectYearNode) {
      const item = new vscode.TreeItem(element.year, vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue = toTreeItemContextValue(element);
      item.tooltip = t("tree.tooltip.year", element.year);
      return item;
    }
    if (element instanceof ProjectMonthNode) {
      const item = new vscode.TreeItem(element.month, vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue = toTreeItemContextValue(element);
      item.tooltip = t("tree.tooltip.month", `${element.year}-${element.month}`);
      return item;
    }
    if (element instanceof ProjectDayNode) {
      const item = new vscode.TreeItem(element.day, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = element.ymd;
      item.contextValue = toTreeItemContextValue(element);
      item.tooltip = t("tree.tooltip.day", element.ymd);
      return item;
    }
    if (element instanceof YearNode) {
      const item = new vscode.TreeItem(element.year, vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue = toTreeItemContextValue(element);
      item.tooltip = t("tree.tooltip.year", element.year);
      return item;
    }
    if (element instanceof MonthNode) {
      const item = new vscode.TreeItem(element.month, vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue = toTreeItemContextValue(element);
      item.tooltip = t("tree.tooltip.month", `${element.year}-${element.month}`);
      return item;
    }
    if (element instanceof DayNode) {
      const item = new vscode.TreeItem(element.day, vscode.TreeItemCollapsibleState.Collapsed);
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
    const prefix = this.viewMode === "latest" ? `${session.localDate} ${session.timeLabel}` : session.timeLabel;
    const label = `${prefix} ${shortTitle}`;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    const annotation = this.annotationStore.get(session.fsPath);
    const projectDisplayCwd = this.getProjectDisplayCwd(getSessionCwd(session));
    const projectAlias = this.projectAliasStore.getAliasByCwd(projectDisplayCwd);
    item.description = buildSessionDescription(session, annotation?.tags ?? [], projectAlias, projectDisplayCwd);
    const node = new SessionNode(session, pinned);
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
    });
    return item;
  }

  private resolveSourceIconPath(source: SessionSummary["source"]): { light: vscode.Uri; dark: vscode.Uri } {
    return source === "claude" ? this.claudeIconPath : this.codexIconPath;
  }

  private getFilteredSessions(): SessionSummary[] {
    if (this.filteredSessionsCache) return this.filteredSessionsCache;
    this.filteredSessionsCache = this.historyService.getIndex().sessions.filter((s) => this.matchesSession(s));
    return this.filteredSessionsCache;
  }

  private buildProjectNodes(sessions: readonly SessionSummary[]): TreeNode[] {
    const context = this.buildProjectBuildContext(sessions);
    return buildProjectGroupTreeNodes({
      context,
      createProjectNode: (bucket, parentAssociation) => this.createProjectNodeFromBucket(bucket, parentAssociation),
      getRepresentativeCwd: (targetKey, bucket) => this.getRepresentativeCwdForProjectKey(targetKey, bucket?.cwd ?? null),
      getAliasByCwd: (cwd) => this.projectAliasStore.getAliasByCwd(cwd) ?? null,
      buildProjectLabel,
      compareNodes: compareProjectTreeNodes,
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
    const latest = group.sessions[0];
    const fallbackLabel = buildProjectLabel(group.cwd);
    const alias = this.projectAliasStore.getAliasByCwd(group.cwd) ?? null;
    const label = alias ?? fallbackLabel;
    const associatedSources = buildAssociatedSources(
      group.cwd ? this.projectAssociationStore.getRelocationSourcesForTargetCwd(group.cwd) : [],
      group.associatedSourceCwds,
    );
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
      latestLabel: latest ? `${latest.localDate} ${latest.timeLabel}` : "",
      description,
      associatedSources,
      targetMissingHistory: !group.hasTargetSession && associatedSources.length > 0,
      parentAssociation,
    });
  }

  private getProjectSessions(projectKey: string): SessionSummary[] {
    const cached = this.projectSessionsByRelocationKey.get(projectKey);
    if (cached) return cached;
    return this.getFilteredSessions().filter((session) => {
      const cwd = getSessionCwd(session);
      const key = cwd ? this.getRelocationProjectKey(cwd) : NO_CWD_PROJECT_KEY;
      return key === projectKey;
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
      const nodes = this.buildProjectNodes(this.getFilteredSessions());
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

  public async getChildren(element?: TreeNode): Promise<TreeNode[]> {
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
      const nodes = this.getFilteredSessions().map((s) => new SessionNode(s, this.pinStore.isPinned(s.fsPath)));
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
          const filtered = sessions.filter((s) => this.matchesSession(s));
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
      const filtered = sessions.filter((s) => this.matchesSession(s));
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
