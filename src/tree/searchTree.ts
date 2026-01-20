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
      item.description = formatScopeLabel(element);
      item.contextValue = toTreeItemContextValue(element);
      return item;
    }
    if (element instanceof SearchSessionNode) {
      const pinned = this.pinStore.isPinned(element.session.fsPath);
      // 日本語: ツリーのタイトルは「全角20文字程度」で省略表示する（以降は "..."）。
      const shortTitle = truncateByDisplayWidth(element.session.snippet, 40, "...");
      const item = new vscode.TreeItem(
        `${element.session.localDate} ${element.session.timeLabel} ${shortTitle} (${element.hits.length})`,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.description = element.session.cwdShort;
      const node = new SessionNode(element.session, pinned);
      item.contextValue = toTreeItemContextValue(node);
      // 日本語: ピン留め状態は「時刻の左」のアイコンで表現する（未ピン留めは見えないアイコン）。
      item.iconPath = pinned ? this.pinIconPath : this.blankIconPath;

      // 日本語: タイトルクリックはビューワ表示（選択時プレビュー or openSession）にし、ピン留め/解除は右クリックメニューで行う。
      const previewOnSelection = getConfig().previewOpenOnSelection;
      if (!previewOnSelection) {
        item.command = { command: "codexHistoryViewer.openSession", title: "", arguments: [node] };
      }
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
  // 日本語: scopeValue があれば優先し、なければ従来どおりの表示にフォールバックする。
  if (typeof root.scopeValue === "string" && root.scopeValue.trim().length > 0) return root.scopeValue;
  if (root.scopeKind === "all") return t("search.filter.all");
  return "";
}
