import * as vscode from "vscode";
import type { HistoryService } from "../services/historyService";
import type { PinStore } from "../services/pinStore";
import { MissingPinnedNode, SessionNode, TreeNode, missingPinnedLabel, toTreeItemContextValue } from "./treeNodes";
import { getConfig } from "../settings";
import { truncateByDisplayWidth } from "../utils/textUtils";
import { t } from "../i18n";

// Provides the pinned sessions view.
export class PinnedTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly historyService: HistoryService;
  private readonly pinStore: PinStore;
  private readonly pinIconPath: { light: vscode.Uri; dark: vscode.Uri };
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined | null | void>();
  public readonly onDidChangeTreeData = this.emitter.event;

  constructor(historyService: HistoryService, pinStore: PinStore, extensionUri: vscode.Uri) {
    this.historyService = historyService;
    this.pinStore = pinStore;
    this.pinIconPath = {
      light: vscode.Uri.joinPath(extensionUri, "resources", "icons", "light", "pin.svg"),
      dark: vscode.Uri.joinPath(extensionUri, "resources", "icons", "dark", "pin.svg"),
    };
  }

  public refresh(): void {
    this.emitter.fire();
  }

  public getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element instanceof SessionNode) {
      // Truncate the tree title to ~20 full-width characters (40 half-width units) and append "...".
      const shortTitle = truncateByDisplayWidth(element.session.snippet, 40, "...");
      const item = new vscode.TreeItem(`${element.session.localDate} ${element.session.timeLabel} ${shortTitle}`);
      item.description = element.session.cwdShort;
      item.contextValue = toTreeItemContextValue(element);
      // This view is always pinned, so always show the pin icon left of the time label.
      item.iconPath = this.pinIconPath;

      // Clicking the title opens the viewer (preview on selection or openSession); unpin is done via the context menu.
      const previewOnSelection = getConfig().previewOpenOnSelection;
      if (!previewOnSelection) {
        item.command = { command: "codexHistoryViewer.openSession", title: "", arguments: [element] };
      }

      // Show a short preview in the tooltip for quicker scanning.
      const md = new vscode.MarkdownString(undefined, true);
      md.isTrusted = false;
      md.appendMarkdown(`**${element.session.localDate} ${element.session.timeLabel}**  \n`);
      if (element.session.cwdShort) md.appendMarkdown(`${escapeForMarkdown(element.session.cwdShort)}  \n`);
      md.appendMarkdown(`\n---\n`);
      for (const msg of element.session.previewMessages) {
        md.appendMarkdown(`**${msg.role}**  \n`);
        md.appendMarkdown(`${escapeForMarkdown(msg.text)}\n\n`);
      }
      md.appendMarkdown(`---\n${escapeForMarkdown(t("tree.tooltip.sessionActions"))}\n`);
      item.tooltip = md;
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
    return new vscode.TreeItem("?");
  }

  public async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (element) return [];
    const pins = this.pinStore.getAll().sort((a, b) => b.pinnedAt - a.pinnedAt);
    const nodes: TreeNode[] = [];
    for (const p of pins) {
      const s = this.historyService.findByFsPath(p.fsPath);
      if (s) nodes.push(new SessionNode(s, true));
      else nodes.push(new MissingPinnedNode(p.fsPath));
    }
    return nodes;
  }
}

function escapeForMarkdown(s: string): string {
  // Minimal escaping for embedding user content into MarkdownString.
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\*/g, "\\*").replace(/_/g, "\\_");
}
