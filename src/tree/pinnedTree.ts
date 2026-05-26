import * as path from "node:path";
import * as vscode from "vscode";
import type { HistoryService } from "../services/historyService";
import type { PinEntry, PinStore } from "../services/pinStore";
import type { SessionAnnotationStore } from "../services/sessionAnnotationStore";
import type { ProjectAliasStore } from "../services/projectAliasStore";
import type { ArchiveLocationFilter, SessionSource, SessionSourceFilter, SessionSummary } from "../sessions/sessionTypes";
import type { DateScope } from "../types/dateScope";
import {
  HistoryEmptyNode,
  MissingPinnedNode,
  PinnedDropHintNode,
  ProjectNode,
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
import { buildSessionHoverTooltip } from "./sessionTooltipUtils";

const NO_CWD_PROJECT_KEY = "__no_cwd__";

export type PinnedSortMode = "pinnedAt" | "historyDate";

type PinnedVisibleEntry = {
  projectKey: string;
  cwd: string | null;
  pinnedAt: number;
  fsPath: string;
  node: SessionNode | MissingPinnedNode;
  session: SessionSummary | null;
};

// Provides the pinned sessions view.
export class PinnedTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly historyService: HistoryService;
  private readonly pinStore: PinStore;
  private readonly annotationStore: SessionAnnotationStore;
  private readonly projectAliasStore: ProjectAliasStore;
  private filter: DateScope;
  private sourceFilter: SessionSourceFilter;
  private tagFilter: string[];
  private archiveLocationFilter: ArchiveLocationFilter;
  private projectCwd: string | null;
  private projectGrouped: boolean;
  private sortMode: PinnedSortMode;
  private readonly codexIconPath: { light: vscode.Uri; dark: vscode.Uri };
  private readonly claudeIconPath: { light: vscode.Uri; dark: vscode.Uri };
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined | null | void>();
  private initialLoadComplete = false;
  public readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    historyService: HistoryService,
    pinStore: PinStore,
    annotationStore: SessionAnnotationStore,
    projectAliasStore: ProjectAliasStore,
    filter: DateScope,
    sourceFilter: SessionSourceFilter,
    tagFilter: readonly string[],
    archiveLocationFilter: ArchiveLocationFilter,
    projectCwd: string | null,
    projectGrouped: boolean,
    sortMode: PinnedSortMode,
    extensionUri: vscode.Uri,
  ) {
    this.historyService = historyService;
    this.pinStore = pinStore;
    this.annotationStore = annotationStore;
    this.projectAliasStore = projectAliasStore;
    this.filter = filter;
    this.sourceFilter = normalizeSourceFilter(sourceFilter);
    this.tagFilter = normalizeTagFilter(tagFilter);
    this.archiveLocationFilter = archiveLocationFilter;
    this.projectCwd = typeof projectCwd === "string" && projectCwd.trim().length > 0 ? projectCwd.trim() : null;
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
  }

  public refresh(): void {
    this.emitter.fire();
  }

  public markInitialLoadComplete(): void {
    if (this.initialLoadComplete) return;
    this.initialLoadComplete = true;
    this.refresh();
  }

  public setTagFilter(tags: readonly string[]): void {
    this.tagFilter = normalizeTagFilter(tags);
  }

  public setFilter(filter: DateScope): void {
    this.filter = filter;
  }

  public setSourceFilter(sourceFilter: SessionSourceFilter): void {
    this.sourceFilter = normalizeSourceFilter(sourceFilter);
  }

  public setArchiveLocationFilter(archiveLocationFilter: ArchiveLocationFilter): void {
    this.archiveLocationFilter = archiveLocationFilter;
  }

  public setProjectFilter(projectCwd: string | null): void {
    this.projectCwd = typeof projectCwd === "string" && projectCwd.trim().length > 0 ? projectCwd.trim() : null;
  }

  public setProjectGrouped(projectGrouped: boolean): void {
    this.projectGrouped = projectGrouped;
  }

  public setSortMode(sortMode: PinnedSortMode): void {
    this.sortMode = normalizePinnedSortMode(sortMode);
  }

  public setFilters(
    filter: DateScope,
    projectCwd: string | null,
    sourceFilter: SessionSourceFilter,
    tagFilter: readonly string[],
    archiveLocationFilter: ArchiveLocationFilter,
  ): void {
    // Update filters in bulk; the caller triggers refresh.
    this.setFilter(filter);
    this.setProjectFilter(projectCwd);
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
    const projectCwd = this.projectCwd;
    if (!projectCwd) return true;
    const cwd = getSessionCwd(session);
    if (!cwd) return false;
    return normalizeProjectKey(cwd) === normalizeProjectKey(projectCwd);
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
        item.tooltip = t(
          this.sortMode === "historyDate"
            ? "tree.tooltip.pinnedProject.historyDateWithAlias"
            : "tree.tooltip.pinnedProject.pinnedAtWithAlias",
          element.alias,
          element.cwd ?? t("tree.project.noCwd"),
          element.sessionCount,
          element.latestLabel,
        );
      } else {
        item.tooltip = t(
          this.sortMode === "historyDate"
            ? "tree.tooltip.pinnedProject.historyDate"
            : "tree.tooltip.pinnedProject.pinnedAt",
          element.cwd ?? t("tree.project.noCwd"),
          element.sessionCount,
          element.latestLabel,
        );
      }
      return item;
    }
    if (element instanceof SessionNode) {
      // Truncate the tree title to ~20 full-width characters (40 half-width units) and append "...".
      const shortTitle = truncateByDisplayWidth(element.session.displayTitle, 40, "...");
      const annotation = this.annotationStore.get(element.session.fsPath);
      const projectAlias = this.projectAliasStore.getAliasByCwd(getSessionCwd(element.session));
      const item = new vscode.TreeItem(
        `${element.session.localDate} ${element.session.timeLabel} ${shortTitle}`,
      );
      item.description = buildSessionDescription(element.session, annotation?.tags ?? [], projectAlias);
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
        return this.collectVisibleEntries()
          .filter((entry) => entry.projectKey === element.key)
          .map((entry) => entry.node);
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
        entries.push({
          projectKey: cwd ? normalizeProjectKey(cwd) : NO_CWD_PROJECT_KEY,
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
          cwd: null,
          pinnedAt: p.pinnedAt,
          fsPath: p.fsPath,
          node: new MissingPinnedNode(p.fsPath),
          session: null,
        });
      }
    }
    entries.sort((a, b) => comparePinnedVisibleEntries(a, b, this.sortMode));
    return entries;
  }

  private buildProjectNodes(entries: readonly PinnedVisibleEntry[]): ProjectNode[] {
    const groups = new Map<string, { cwd: string | null; entries: PinnedVisibleEntry[] }>();

    for (const entry of entries) {
      const existing = groups.get(entry.projectKey);
      if (existing) {
        existing.entries.push(entry);
        if (!existing.cwd && entry.cwd) existing.cwd = entry.cwd;
        continue;
      }
      groups.set(entry.projectKey, { cwd: entry.cwd, entries: [entry] });
    }

    return Array.from(groups.entries()).map(([key, group]) => {
      const first = group.entries[0] ?? null;
      const latestLabel = formatProjectLatestLabel(first, this.sortMode);
      const fallbackLabel = buildProjectLabel(group.cwd);
      const alias = this.projectAliasStore.getAliasByCwd(group.cwd) ?? null;
      return new ProjectNode({
        key,
        label: alias ?? fallbackLabel,
        cwd: group.cwd,
        alias,
        fallbackLabel,
        sessionCount: group.entries.length,
        latestLabel,
        description: buildProjectDescription(group.cwd, group.entries.length),
      });
    });
  }

  private resolveSourceIconPath(source: SessionSource): { light: vscode.Uri; dark: vscode.Uri } {
    return source === "claude" ? this.claudeIconPath : this.codexIconPath;
  }
}

function normalizePinnedSortMode(value: PinnedSortMode): PinnedSortMode {
  return value === "historyDate" ? "historyDate" : "pinnedAt";
}

function comparePinnedVisibleEntries(
  left: PinnedVisibleEntry,
  right: PinnedVisibleEntry,
  sortMode: PinnedSortMode,
): number {
  if (sortMode === "historyDate") return compareByHistoryDate(left, right);
  return compareByPinnedAt(left, right);
}

function compareByPinnedAt(left: PinnedVisibleEntry, right: PinnedVisibleEntry): number {
  return (
    compareNumberDesc(left.pinnedAt, right.pinnedAt) ||
    compareSessionDisplayDateDesc(left.session, right.session) ||
    compareFsPath(left.fsPath, right.fsPath)
  );
}

function compareByHistoryDate(left: PinnedVisibleEntry, right: PinnedVisibleEntry): number {
  if (left.session && !right.session) return -1;
  if (!left.session && right.session) return 1;
  return (
    compareSessionDisplayDateDesc(left.session, right.session) ||
    compareNumberDesc(left.pinnedAt, right.pinnedAt) ||
    compareFsPath(left.fsPath, right.fsPath)
  );
}

function compareSessionDisplayDateDesc(left: SessionSummary | null, right: SessionSummary | null): number {
  if (!left || !right) return 0;
  if (left.localDate !== right.localDate) return left.localDate < right.localDate ? 1 : -1;
  if (left.timeLabel !== right.timeLabel) return left.timeLabel < right.timeLabel ? 1 : -1;
  return 0;
}

function compareNumberDesc(left: number, right: number): number {
  const leftValue = Number.isFinite(left) ? left : 0;
  const rightValue = Number.isFinite(right) ? right : 0;
  return rightValue - leftValue;
}

function compareFsPath(left: string, right: string): number {
  return left.localeCompare(right);
}

function formatProjectLatestLabel(entry: PinnedVisibleEntry | null, sortMode: PinnedSortMode): string {
  if (!entry) return "-";
  if (sortMode === "historyDate") {
    return entry.session ? `${entry.session.localDate} ${entry.session.timeLabel}` : "-";
  }
  return formatPinnedAtLabel(entry.pinnedAt);
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

function buildProjectDescription(cwd: string | null, pinCount: number): string {
  if (!cwd) return String(pinCount);
  return `${pinCount}  ${safeDisplayPath(cwd, 56)}`;
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
