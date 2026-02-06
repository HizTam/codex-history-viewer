import * as vscode from "vscode";
import type { PinStore } from "../services/pinStore";
import { SearchHelpNode, SearchHitNode, SearchRootNode, SearchSessionNode, SessionNode, TreeNode, toTreeItemContextValue } from "./treeNodes";
import { t } from "../i18n";
import { getConfig } from "../settings";
import { truncateByDisplayWidth } from "../utils/textUtils";

// Provides the Search view (root → session → hit).
export class SearchTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly pinStore: PinStore;
  private readonly pinIconPath: { light: vscode.Uri; dark: vscode.Uri };
  private readonly blankIconPath: { light: vscode.Uri; dark: vscode.Uri };
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined | null | void>();
  public readonly onDidChangeTreeData = this.emitter.event;

  private rootNode: SearchRootNode | null = null;
  private sessionNodes: SearchSessionNode[] = [];
  private readonly helpNode = new SearchHelpNode();

  constructor(pinStore: PinStore, extensionUri: vscode.Uri) {
    this.pinStore = pinStore;
    this.pinIconPath = {
      light: vscode.Uri.joinPath(extensionUri, "resources", "icons", "light", "pin.svg"),
      dark: vscode.Uri.joinPath(extensionUri, "resources", "icons", "dark", "pin.svg"),
    };
    this.blankIconPath = {
      light: vscode.Uri.joinPath(extensionUri, "resources", "icons", "light", "blank.svg"),
      dark: vscode.Uri.joinPath(extensionUri, "resources", "icons", "dark", "blank.svg"),
    };
  }

  public get root(): SearchRootNode | null {
    return this.rootNode;
  }

  public refresh(): void {
    this.emitter.fire();
  }

  public clear(): void {
    this.rootNode = null;
    this.sessionNodes = [];
    this.refresh();
  }

  public setResults(results: { root: SearchRootNode; sessions: SearchSessionNode[] }): void {
    this.rootNode = results.root;
    this.sessionNodes = results.sessions;
    this.refresh();
  }

  public getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element instanceof SearchRootNode) {
      const item = new vscode.TreeItem(
        `${element.query} (${element.totalHits})`,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      const scopeLabel = formatScopeLabel(element);
      item.description = scopeLabel;
      item.contextValue = toTreeItemContextValue(element);
      item.tooltip = t("tree.tooltip.searchRoot", element.query, scopeLabel || t("search.filter.all"), element.totalHits);
      return item;
    }
    if (element instanceof SearchSessionNode) {
      const pinned = this.pinStore.isPinned(element.session.fsPath);
      // Truncate the tree title to ~20 full-width characters (40 half-width units) and append "...".
      const shortTitle = truncateByDisplayWidth(element.session.snippet, 40, "...");
      const item = new vscode.TreeItem(
        `${element.session.localDate} ${element.session.timeLabel} ${shortTitle} (${element.hits.length})`,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.description = element.session.cwdShort;
      const node = new SessionNode(element.session, pinned);
      item.contextValue = toTreeItemContextValue(node);
      // Represent pinned state with an icon left of the time label (use an invisible icon when unpinned).
      item.iconPath = pinned ? this.pinIconPath : this.blankIconPath;

      // Clicking the title opens the viewer (preview on selection or openSession); pin/unpin is done via the context menu.
      const previewOnSelection = getConfig().previewOpenOnSelection;
      if (!previewOnSelection) {
        item.command = { command: "codexHistoryViewer.openSession", title: "", arguments: [node] };
      }
      item.tooltip = buildSearchSessionTooltip(element);
      return item;
    }
    if (element instanceof SearchHitNode) {
      const pinned = this.pinStore.isPinned(element.session.fsPath);
      const roleLabel = element.hit.role;
      const item = new vscode.TreeItem(
        `[#${element.hit.messageIndex}] ${roleLabel}: ${element.hit.snippet}`,
        vscode.TreeItemCollapsibleState.None,
      );
      const node = new SessionNode(element.session, pinned);
      item.contextValue = toTreeItemContextValue(node);
      item.iconPath = new vscode.ThemeIcon("search");

      const previewOnSelection = getConfig().previewOpenOnSelection;
      if (!previewOnSelection) {
        item.command = { command: "codexHistoryViewer.openSession", title: "", arguments: [element] };
      }
      item.tooltip = buildSearchHitTooltip(element);
      return item;
    }
    if (element instanceof SearchHelpNode) {
      const item = new vscode.TreeItem(t("search.help.start"), vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("search");
      item.contextValue = toTreeItemContextValue(element);
      item.command = { command: "codexHistoryViewer.search", title: "" };
      item.tooltip = t("search.help.tooltip");
      return item;
    }
    return new vscode.TreeItem("?");
  }

  public async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) return this.rootNode ? [this.rootNode] : [this.helpNode];
    if (element instanceof SearchRootNode) return this.sessionNodes;
    if (element instanceof SearchSessionNode) {
      return element.hits.map((h) => new SearchHitNode(element.session, h, this.rootNode?.query ?? ""));
    }
    return [];
  }
}

function formatScopeLabel(root: SearchRootNode): string {
  // Prefer scopeValue when present; otherwise fall back to the legacy display.
  if (typeof root.scopeValue === "string" && root.scopeValue.trim().length > 0) return root.scopeValue;
  if (root.scopeKind === "all") return t("search.filter.all");
  return "";
}

function buildSearchSessionTooltip(node: SearchSessionNode): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = false;
  md.appendMarkdown(`**${node.session.localDate} ${node.session.timeLabel}**  \n`);
  if (node.session.cwdShort) md.appendMarkdown(`${escapeForMarkdown(node.session.cwdShort)}  \n`);
  md.appendMarkdown(`${escapeForMarkdown(t("tree.tooltip.searchSession", node.hits.length))}\n`);
  md.appendMarkdown(`\n---\n`);
  const max = 5;
  for (const h of node.hits.slice(0, max)) {
    md.appendMarkdown(`- [#${h.messageIndex}] **${h.role}** ${escapeForMarkdown(h.snippet)}\n`);
  }
  if (node.hits.length > max) {
    md.appendMarkdown(`\n${escapeForMarkdown(t("tree.tooltip.searchSessionMore", node.hits.length - max))}\n`);
  }
  md.appendMarkdown(`\n---\n${escapeForMarkdown(t("tree.tooltip.sessionActions"))}\n`);
  return md;
}

function buildSearchHitTooltip(node: SearchHitNode): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = false;
  md.appendMarkdown(`**[#${node.hit.messageIndex}] ${node.hit.role}**  \n`);
  md.appendMarkdown(`${escapeForMarkdown(node.hit.snippet)}\n`);
  md.appendMarkdown(`\n---\n${escapeForMarkdown(t("tree.tooltip.searchHitAction"))}\n`);
  return md;
}

function escapeForMarkdown(s: string): string {
  // Minimal escaping for embedding user content into MarkdownString.
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\*/g, "\\*").replace(/_/g, "\\_");
}
