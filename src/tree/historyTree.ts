import * as vscode from "vscode";
import type { HistoryService } from "../services/historyService";
import type { PinStore } from "../services/pinStore";
import type { SessionAnnotationStore } from "../services/sessionAnnotationStore";
import { SessionNode, DayNode, MonthNode, TreeNode, YearNode, toTreeItemContextValue } from "./treeNodes";
import type { SessionSource, SessionSourceFilter, SessionSummary } from "../sessions/sessionTypes";
import type { DateScope } from "../types/dateScope";
import { getConfig } from "../settings";
import { normalizeCacheKey } from "../utils/fsUtils";
import { truncateByDisplayWidth } from "../utils/textUtils";
import { t } from "../i18n";
import { appendSessionTooltipDateLines } from "./sessionTooltipUtils";

// Provides the history tree (year → month → day → session).
export class HistoryTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly historyService: HistoryService;
  private readonly pinStore: PinStore;
  private readonly annotationStore: SessionAnnotationStore;
  private filter: DateScope;
  private projectCwd: string | null;
  private sourceFilter: SessionSourceFilter;
  private tagFilter: string[];
  private readonly codexIconPath: { light: vscode.Uri; dark: vscode.Uri };
  private readonly claudeIconPath: { light: vscode.Uri; dark: vscode.Uri };
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined | null | void>();
  public readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    historyService: HistoryService,
    pinStore: PinStore,
    annotationStore: SessionAnnotationStore,
    filter: DateScope,
    projectCwd: string | null,
    sourceFilter: SessionSourceFilter,
    tagFilter: readonly string[],
    extensionUri: vscode.Uri,
  ) {
    this.historyService = historyService;
    this.pinStore = pinStore;
    this.annotationStore = annotationStore;
    this.filter = filter;
    this.projectCwd = typeof projectCwd === "string" && projectCwd.trim().length > 0 ? projectCwd.trim() : null;
    this.sourceFilter = normalizeSourceFilter(sourceFilter);
    this.tagFilter = normalizeTagFilter(tagFilter);
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

  public setFilter(filter: DateScope): void {
    this.filter = filter;
  }

  public setProjectFilter(projectCwd: string | null): void {
    this.projectCwd = typeof projectCwd === "string" && projectCwd.trim().length > 0 ? projectCwd.trim() : null;
  }

  public setSourceFilter(sourceFilter: SessionSourceFilter): void {
    this.sourceFilter = normalizeSourceFilter(sourceFilter);
  }

  public setTagFilter(tags: readonly string[]): void {
    this.tagFilter = normalizeTagFilter(tags);
  }

  public setFilters(
    filter: DateScope,
    projectCwd: string | null,
    sourceFilter: SessionSourceFilter,
    tagFilter: readonly string[],
  ): void {
    // Update filters in bulk; the caller triggers refresh.
    this.setFilter(filter);
    this.setProjectFilter(projectCwd);
    this.setSourceFilter(sourceFilter);
    this.setTagFilter(tagFilter);
  }

  private matchesProject(session: SessionSummary): boolean {
    const projectCwd = this.projectCwd;
    if (!projectCwd) return true;
    const cwd = session.meta?.cwd;
    if (typeof cwd !== "string" || cwd.trim().length === 0) return false;
    return normalizeCacheKey(cwd) === normalizeCacheKey(projectCwd);
  }

  private matchesTags(session: SessionSummary): boolean {
    if (this.tagFilter.length === 0) return true;
    const ann = this.annotationStore.get(session.fsPath);
    if (!ann || ann.tags.length === 0) return false;
    const tagKeys = new Set(ann.tags.map((tag) => normalizeTagKey(tag)));
    return this.tagFilter.some((tag) => tagKeys.has(normalizeTagKey(tag)));
  }

  private matchesSession(session: SessionSummary): boolean {
    return this.matchesProject(session) && this.matchesSource(session) && this.matchesTags(session);
  }

  private matchesSource(session: SessionSummary): boolean {
    if (this.sourceFilter === "all") return true;
    return session.source === this.sourceFilter;
  }

  public getTreeItem(element: TreeNode): vscode.TreeItem {
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
    // Search nodes are not used in this view.
    return new vscode.TreeItem("?");
  }

  private sessionToTreeItem(session: SessionSummary, pinned: boolean): vscode.TreeItem {
    // Truncate the tree title to ~20 full-width characters (40 half-width units) and append "...".
    const shortTitle = truncateByDisplayWidth(session.displayTitle, 40, "...");
    const label = `${session.timeLabel} ${shortTitle}`;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    const annotation = this.annotationStore.get(session.fsPath);
    item.description = buildSessionDescription(session.cwdShort, annotation?.tags ?? []);
    const node = new SessionNode(session, pinned);
    item.contextValue = toTreeItemContextValue(node);
    // Show source-specific icons (Codex/Claude) in the list row.
    item.iconPath = this.resolveSourceIconPath(session.source);

    // Clicking the title opens the viewer (preview on selection or openSession); pin/unpin is done via the context menu.
    const previewOnSelection = getConfig().previewOpenOnSelection;
    if (!previewOnSelection) {
      item.command = { command: "codexHistoryViewer.openSession", title: "", arguments: [node] };
    }

    // Tooltip preview shows short user/assistant excerpts.
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = false;
    appendSessionTooltipDateLines(md, session);
    md.appendMarkdown(`Source: ${sourceName(session.source)}  \n`);
    if (session.cwdShort) md.appendMarkdown(`${escapeForMarkdown(session.cwdShort)}  \n`);
    if (annotation && annotation.tags.length > 0) {
      md.appendMarkdown(`Tags: ${escapeForMarkdown(annotation.tags.join(", "))}  \n`);
    }
    if (annotation && annotation.note.length > 0) {
      md.appendMarkdown(`Note: ${escapeForMarkdown(annotation.note)}  \n`);
    }
    md.appendMarkdown(`\n---\n`);
    for (const msg of session.previewMessages) {
      md.appendMarkdown(`**${msg.role}**  \n`);
      md.appendMarkdown(`${escapeForMarkdown(msg.text)}\n\n`);
    }
    md.appendMarkdown(`---\n${escapeForMarkdown(t("tree.tooltip.sessionActions"))}\n`);
    item.tooltip = md;
    return item;
  }

  private resolveSourceIconPath(source: SessionSource): { light: vscode.Uri; dark: vscode.Uri } {
    return source === "claude" ? this.claudeIconPath : this.codexIconPath;
  }

  public async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    const idx = this.historyService.getIndex();
    const shouldFilterSessions = !!this.projectCwd || this.sourceFilter !== "all" || this.tagFilter.length > 0;
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
          return out;
        }
        case "year": {
          const months = idx.byY.get(filter.yyyy);
          if (!months) return [];
          const keys = Array.from(months.keys()).sort((a, b) => (a < b ? 1 : -1));
          if (!shouldFilterSessions) return keys.map((m) => new MonthNode(filter.yyyy, m));

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
          return out;
        }
        case "month": {
          const [yyyy, mm] = filter.ym.split("-");
          if (!yyyy || !mm) return [];
          const days = idx.byY.get(yyyy)?.get(mm);
          if (!days) return [];
          const keys = Array.from(days.keys()).sort((a, b) => (a < b ? 1 : -1));
          if (!shouldFilterSessions) return keys.map((d) => new DayNode(yyyy, mm, d));

          // When filtering is active, show only days that contain matching sessions.
          const out: DayNode[] = [];
          for (const d of keys) {
            const sessions = days.get(d) ?? [];
            if (sessions.some((s) => this.matchesSession(s))) out.push(new DayNode(yyyy, mm, d));
          }
          return out;
        }
        case "day": {
          const [yyyy, mm, dd] = filter.ymd.split("-");
          if (!yyyy || !mm || !dd) return [];
          const sessions = idx.byY.get(yyyy)?.get(mm)?.get(dd) ?? [];
          const filtered = sessions.filter((s) => this.matchesSession(s));
          return filtered.map((s) => new SessionNode(s, this.pinStore.isPinned(s.fsPath)));
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

function escapeForMarkdown(s: string): string {
  // Minimal escaping for embedding user content into MarkdownString (part of XSS mitigation).
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\*/g, "\\*").replace(/_/g, "\\_");
}

function buildSessionDescription(cwdShort: string, tags: readonly string[]): string {
  const parts: string[] = [];
  if (cwdShort) parts.push(cwdShort);
  if (tags.length > 0) parts.push(`#${tags.join(" #")}`);
  return parts.join("  ");
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

function sourceName(source: SessionSource): string {
  return source === "claude" ? "Claude" : "Codex";
}
