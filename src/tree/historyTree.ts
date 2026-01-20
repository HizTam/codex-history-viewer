import * as vscode from "vscode";
import type { HistoryService } from "../services/historyService";
import type { PinStore } from "../services/pinStore";
import { SessionNode, DayNode, MonthNode, TreeNode, YearNode, toTreeItemContextValue } from "./treeNodes";
import type { SessionSummary } from "../sessions/sessionTypes";
import type { DateScope } from "../types/dateScope";
import { getConfig } from "../settings";
import { normalizeCacheKey } from "../utils/fsUtils";
import { truncateByDisplayWidth } from "../utils/textUtils";

// Provides the history tree (year → month → day → session).
export class HistoryTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly historyService: HistoryService;
  private readonly pinStore: PinStore;
  private filter: DateScope;
  private projectCwd: string | null;
  private readonly pinIconPath: { light: vscode.Uri; dark: vscode.Uri };
  private readonly blankIconPath: { light: vscode.Uri; dark: vscode.Uri };
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined | null | void>();
  public readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    historyService: HistoryService,
    pinStore: PinStore,
    filter: DateScope,
    projectCwd: string | null,
    extensionUri: vscode.Uri,
  ) {
    this.historyService = historyService;
    this.pinStore = pinStore;
    this.filter = filter;
    this.projectCwd = typeof projectCwd === "string" && projectCwd.trim().length > 0 ? projectCwd.trim() : null;
    this.pinIconPath = {
      light: vscode.Uri.joinPath(extensionUri, "resources", "icons", "light", "pin.svg"),
      dark: vscode.Uri.joinPath(extensionUri, "resources", "icons", "dark", "pin.svg"),
    };
    this.blankIconPath = {
      light: vscode.Uri.joinPath(extensionUri, "resources", "icons", "light", "blank.svg"),
      dark: vscode.Uri.joinPath(extensionUri, "resources", "icons", "dark", "blank.svg"),
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

  public setFilters(filter: DateScope, projectCwd: string | null): void {
    // 日本語: フィルタはまとめて更新し、表示更新（refresh）は呼び出し側で行う。
    this.setFilter(filter);
    this.setProjectFilter(projectCwd);
  }

  private matchesProject(session: SessionSummary): boolean {
    const projectCwd = this.projectCwd;
    if (!projectCwd) return true;
    const cwd = session.meta?.cwd;
    if (typeof cwd !== "string" || cwd.trim().length === 0) return false;
    return normalizeCacheKey(cwd) === normalizeCacheKey(projectCwd);
  }

  public getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element instanceof YearNode) {
      const item = new vscode.TreeItem(element.year, vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue = toTreeItemContextValue(element);
      return item;
    }
    if (element instanceof MonthNode) {
      const item = new vscode.TreeItem(element.month, vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue = toTreeItemContextValue(element);
      return item;
    }
    if (element instanceof DayNode) {
      const item = new vscode.TreeItem(element.day, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = element.ymd;
      item.contextValue = toTreeItemContextValue(element);
      return item;
    }
    if (element instanceof SessionNode) {
      return this.sessionToTreeItem(element.session, element.pinned);
    }
    // Search nodes are not used in this view.
    return new vscode.TreeItem("?");
  }

  private sessionToTreeItem(session: SessionSummary, pinned: boolean): vscode.TreeItem {
    // 日本語: ツリーのタイトルは「全角20文字程度」で省略表示する（以降は "..."）。
    const shortTitle = truncateByDisplayWidth(session.snippet, 40, "...");
    const label = `${session.timeLabel} ${shortTitle}`;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.description = session.cwdShort;
    const node = new SessionNode(session, pinned);
    item.contextValue = toTreeItemContextValue(node);
    // 日本語: ピン留め状態は「時刻の左」のアイコンで表現する（未ピン留めは見えないアイコン）。
    item.iconPath = pinned ? this.pinIconPath : this.blankIconPath;

    // 日本語: タイトルクリックはビューワ表示（選択時プレビュー or openSession）にし、ピン留め/解除は右クリックメニューで行う。
    const previewOnSelection = getConfig().previewOpenOnSelection;
    if (!previewOnSelection) {
      item.command = { command: "codexHistoryViewer.openSession", title: "", arguments: [node] };
    }

    // Tooltip preview shows short user/assistant excerpts.
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = false;
    md.appendMarkdown(`**${session.localDate} ${session.timeLabel}**  \n`);
    if (session.cwdShort) md.appendMarkdown(`${session.cwdShort}  \n`);
    md.appendMarkdown(`\n---\n`);
    for (const msg of session.previewMessages) {
      md.appendMarkdown(`**${msg.role}**  \n`);
      md.appendMarkdown(`${escapeForMarkdown(msg.text)}\n\n`);
    }
    item.tooltip = md;
    return item;
  }

  public async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    const idx = this.historyService.getIndex();
    if (!element) {
      const filter = this.filter;
      switch (filter.kind) {
        case "all": {
          const years = Array.from(idx.byY.keys()).sort((a, b) => (a < b ? 1 : -1));
          if (!this.projectCwd) return years.map((y) => new YearNode(y));

          // 日本語: プロジェクト絞り込み時は、該当セッションが存在する年だけ表示する。
          const out: YearNode[] = [];
          for (const y of years) {
            const months = idx.byY.get(y);
            if (!months) continue;
            let has = false;
            for (const [, days] of months) {
              for (const [, list] of days) {
                if (list.some((s) => this.matchesProject(s))) {
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
          if (!this.projectCwd) return keys.map((m) => new MonthNode(filter.yyyy, m));

          // 日本語: プロジェクト絞り込み時は、該当セッションが存在する月だけ表示する。
          const out: MonthNode[] = [];
          for (const m of keys) {
            const days = months.get(m);
            if (!days) continue;
            let has = false;
            for (const [, list] of days) {
              if (list.some((s) => this.matchesProject(s))) {
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
          if (!this.projectCwd) return keys.map((d) => new DayNode(yyyy, mm, d));

          // 日本語: プロジェクト絞り込み時は、該当セッションが存在する日だけ表示する。
          const out: DayNode[] = [];
          for (const d of keys) {
            const sessions = days.get(d) ?? [];
            if (sessions.some((s) => this.matchesProject(s))) out.push(new DayNode(yyyy, mm, d));
          }
          return out;
        }
        case "day": {
          const [yyyy, mm, dd] = filter.ymd.split("-");
          if (!yyyy || !mm || !dd) return [];
          const sessions = idx.byY.get(yyyy)?.get(mm)?.get(dd) ?? [];
          const filtered = this.projectCwd ? sessions.filter((s) => this.matchesProject(s)) : sessions;
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
      if (!this.projectCwd) return keys.map((m) => new MonthNode(element.year, m));

      const out: MonthNode[] = [];
      for (const m of keys) {
        const days = months.get(m);
        if (!days) continue;
        let has = false;
        for (const [, list] of days) {
          if (list.some((s) => this.matchesProject(s))) {
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
      if (!this.projectCwd) return keys.map((d) => new DayNode(element.year, element.month, d));

      const out: DayNode[] = [];
      for (const d of keys) {
        const sessions = days.get(d) ?? [];
        if (sessions.some((s) => this.matchesProject(s))) out.push(new DayNode(element.year, element.month, d));
      }
      return out;
    }
    if (element instanceof DayNode) {
      const sessions = idx.byY.get(element.year)?.get(element.month)?.get(element.day) ?? [];
      const filtered = this.projectCwd ? sessions.filter((s) => this.matchesProject(s)) : sessions;
      return filtered.map((s) => new SessionNode(s, this.pinStore.isPinned(s.fsPath)));
    }
    return [];
  }
}

function escapeForMarkdown(s: string): string {
  // Minimal escaping for embedding user content into MarkdownString (part of XSS mitigation).
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\*/g, "\\*").replace(/_/g, "\\_");
}
