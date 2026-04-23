import * as vscode from "vscode";
import type { PinStore } from "../services/pinStore";
import type { SessionAnnotationStore } from "../services/sessionAnnotationStore";
import type { SessionSource } from "../sessions/sessionTypes";
import { SearchHelpNode, SearchHitNode, SearchRootNode, SearchSessionNode, SessionNode, TreeNode, toTreeItemContextValue } from "./treeNodes";
import { t } from "../i18n";
import { getConfig } from "../settings";
import { truncateByDisplayWidth } from "../utils/textUtils";
import { appendSessionTooltipDateLines } from "./sessionTooltipUtils";

// Provides the Search view (root -> session -> hit).
export class SearchTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly pinStore: PinStore;
  private readonly annotationStore: SessionAnnotationStore;
  private readonly codexIconPath: { light: vscode.Uri; dark: vscode.Uri };
  private readonly claudeIconPath: { light: vscode.Uri; dark: vscode.Uri };
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined | null | void>();
  public readonly onDidChangeTreeData = this.emitter.event;

  private rootNode: SearchRootNode | null = null;
  private sessionNodes: SearchSessionNode[] = [];
  private readonly helpNode = new SearchHelpNode();

  constructor(pinStore: PinStore, annotationStore: SessionAnnotationStore, extensionUri: vscode.Uri) {
    this.pinStore = pinStore;
    this.annotationStore = annotationStore;
    this.codexIconPath = {
      light: vscode.Uri.joinPath(extensionUri, "resources", "icons", "light", "source-codex.svg"),
      dark: vscode.Uri.joinPath(extensionUri, "resources", "icons", "dark", "source-codex.svg"),
    };
    this.claudeIconPath = {
      light: vscode.Uri.joinPath(extensionUri, "resources", "icons", "light", "source-claude.svg"),
      dark: vscode.Uri.joinPath(extensionUri, "resources", "icons", "dark", "source-claude.svg"),
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
      const annotation = this.annotationStore.get(element.session.fsPath);
      // Truncate the tree title to ~20 full-width characters (40 half-width units) and append "...".
      const shortTitle = truncateByDisplayWidth(element.session.displayTitle, 40, "...");
      const item = new vscode.TreeItem(
        `${element.session.localDate} ${element.session.timeLabel} ${shortTitle} (${element.hits.length})`,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.description = buildSessionDescription(element.session.cwdShort, annotation?.tags ?? []);
      const node = new SessionNode(element.session, pinned);
      item.contextValue = toTreeItemContextValue(node);
      // Show source-specific icons (Codex/Claude) in the list row.
      item.iconPath = this.resolveSourceIconPath(element.session.source);

      // Clicking the title opens the reusable viewer or a session tab depending on the preview setting.
      const previewOnSelection = getConfig().previewOpenOnSelection;
      item.command = {
        command: previewOnSelection ? "codexHistoryViewer.openSessionReusable" : "codexHistoryViewer.openSession",
        title: "",
        arguments: [node],
      };
      item.tooltip = buildSearchSessionTooltip(element, annotation?.tags ?? [], annotation?.note ?? "");
      return item;
    }
    if (element instanceof SearchHitNode) {
      const pinned = this.pinStore.isPinned(element.session.fsPath);
      const roleLabel = formatRoleLabel(element.hit.role, element.hit.source);
      const locationLabel = formatLocationLabel(element.hit);
      const item = new vscode.TreeItem(
        `${locationLabel} ${roleLabel}: ${element.hit.snippet}`,
        vscode.TreeItemCollapsibleState.None,
      );
      const node = new SessionNode(element.session, pinned);
      item.contextValue = toTreeItemContextValue(node);
      item.iconPath = new vscode.ThemeIcon("search");

      const previewOnSelection = getConfig().previewOpenOnSelection;
      item.command = {
        command: previewOnSelection ? "codexHistoryViewer.openSessionReusable" : "codexHistoryViewer.openSession",
        title: "",
        arguments: [element],
      };
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

  public getParent(element: TreeNode): TreeNode | null {
    // Provide parent resolution so TreeView.reveal can work.
    if (element instanceof SearchRootNode || element instanceof SearchHelpNode) return null;
    if (element instanceof SearchSessionNode) return this.rootNode;
    if (element instanceof SearchHitNode) {
      for (const sessionNode of this.sessionNodes) {
        if (sessionNode.session.cacheKey !== element.session.cacheKey) continue;
        const hitExists = sessionNode.hits.some((h) => isSameSearchHit(h, element.hit));
        if (hitExists) return sessionNode;
      }
      // If no matching session is found, treat it as directly under the root.
      return this.rootNode;
    }
    return null;
  }

  private resolveSourceIconPath(source: SessionSource): { light: vscode.Uri; dark: vscode.Uri } {
    return source === "claude" ? this.claudeIconPath : this.codexIconPath;
  }
}

function formatScopeLabel(root: SearchRootNode): string {
  // Prefer scopeValue when present; otherwise fall back to the legacy display.
  if (typeof root.scopeValue === "string" && root.scopeValue.trim().length > 0) return root.scopeValue;
  if (root.scopeKind === "all") return t("search.filter.all");
  return "";
}

function buildSearchSessionTooltip(node: SearchSessionNode, tags: readonly string[], note: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = false;
  appendSessionTooltipDateLines(md, node.session);
  md.appendMarkdown(`Source: ${sourceName(node.session.source)}  \n`);
  if (node.session.cwdShort) md.appendMarkdown(`${escapeForMarkdown(node.session.cwdShort)}  \n`);
  if (tags.length > 0) md.appendMarkdown(`Tags: ${escapeForMarkdown(tags.join(", "))}  \n`);
  if (note.trim().length > 0) md.appendMarkdown(`Note: ${escapeForMarkdown(note.trim())}  \n`);
  md.appendMarkdown(`${escapeForMarkdown(t("tree.tooltip.searchSession", node.hits.length))}\n`);
  md.appendMarkdown(`\n---\n`);
  const max = 5;
  for (const h of node.hits.slice(0, max)) {
    md.appendMarkdown(
      `- ${escapeForMarkdown(formatLocationLabel(h))} **${formatRoleLabel(h.role, h.source)}** ${escapeForMarkdown(h.snippet)}\n`,
    );
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
  md.appendMarkdown(`**${escapeForMarkdown(formatLocationLabel(node.hit))} ${formatRoleLabel(node.hit.role, node.hit.source)}**  \n`);
  md.appendMarkdown(`${escapeForMarkdown(node.hit.snippet)}\n`);
  md.appendMarkdown(`\n---\n${escapeForMarkdown(t("tree.tooltip.searchHitAction"))}\n`);
  return md;
}

function escapeForMarkdown(s: string): string {
  // Minimal escaping for embedding user content into MarkdownString.
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\*/g, "\\*").replace(/_/g, "\\_");
}

function formatRoleLabel(
  role: "user" | "assistant" | "developer" | "tool",
  source?: "message" | "toolArguments" | "toolOutput" | "annotationTag" | "annotationNote",
): string {
  if (role !== "tool") return role;
  if (source === "annotationTag") return "tag";
  if (source === "annotationNote") return "note";
  if (source === "toolArguments") return "tool.args";
  if (source === "toolOutput") return "tool.output";
  return "tool";
}

function formatLocationLabel(hit: {
  messageIndex: number;
  source?: "message" | "toolArguments" | "toolOutput" | "annotationTag" | "annotationNote";
}): string {
  if (hit.source === "annotationTag" || hit.source === "annotationNote") return "[meta]";
  if (hit.messageIndex <= 0) return "[meta]";
  return `[#${hit.messageIndex}]`;
}

function buildSessionDescription(cwdShort: string, tags: readonly string[]): string {
  const parts: string[] = [];
  if (cwdShort) parts.push(cwdShort);
  if (tags.length > 0) parts.push(`#${tags.join(" #")}`);
  return parts.join("  ");
}

function isSameSearchHit(
  a: {
    messageIndex: number;
    role: "user" | "assistant" | "developer" | "tool";
    source?: "message" | "toolArguments" | "toolOutput" | "annotationTag" | "annotationNote";
    snippet: string;
  },
  b: {
    messageIndex: number;
    role: "user" | "assistant" | "developer" | "tool";
    source?: "message" | "toolArguments" | "toolOutput" | "annotationTag" | "annotationNote";
    snippet: string;
  },
): boolean {
  return a.messageIndex === b.messageIndex && a.role === b.role && a.source === b.source && a.snippet === b.snippet;
}

function sourceName(source: SessionSource): string {
  return source === "claude" ? "Claude" : "Codex";
}
