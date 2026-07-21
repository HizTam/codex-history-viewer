import * as vscode from "vscode";
import type { PinStore } from "../services/pinStore";
import type { SessionAnnotationStore } from "../services/sessionAnnotationStore";
import type { ProjectAliasStore } from "../services/projectAliasStore";
import type { ProjectAssociationStore } from "../services/projectAssociationStore";
import type { SessionSource, SessionSummary } from "../sessions/sessionTypes";
import {
  SearchHelpNode,
  type SearchHit,
  SearchHitNode,
  SearchRootNode,
  SearchSessionNode,
  SessionNode,
  TreeNode,
  toTreeItemContextValue,
} from "./treeNodes";
import { t } from "../i18n";
import { getConfig } from "../settings";
import { truncateByDisplayWidth } from "../utils/textUtils";
import { buildSessionDescription } from "./sessionDescriptionUtils";
import {
  appendCodexAgentTooltipLines,
  appendSessionTooltipDateLines,
  appendSessionTooltipTitleLines,
  buildTreeRowTooltip,
} from "./sessionTooltipUtils";
import { CodexAgentRunsService } from "../agents/codexAgentRunsService";
import type { CodexAgentPresentation } from "../agents/codexAgentRunsTypes";
import { SessionIconResolver } from "../ui/sessionIconResolver";

// Provides the Search view (root -> session -> hit).
export class SearchTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly pinStore: PinStore;
  private readonly annotationStore: SessionAnnotationStore;
  private readonly projectAliasStore: ProjectAliasStore;
  private readonly projectAssociationStore: ProjectAssociationStore;
  private readonly codexAgentRuns: CodexAgentRunsService;
  private readonly sessionIconResolver: SessionIconResolver;
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined | null | void>();
  public readonly onDidChangeTreeData = this.emitter.event;

  private rootNode: SearchRootNode | null = null;
  private sessionNodes: SearchSessionNode[] = [];
  private readonly helpNode = new SearchHelpNode();

  constructor(
    pinStore: PinStore,
    annotationStore: SessionAnnotationStore,
    projectAliasStore: ProjectAliasStore,
    projectAssociationStore: ProjectAssociationStore,
    codexAgentRunsOrExtensionUri: CodexAgentRunsService | vscode.Uri,
    sessionIconResolver?: SessionIconResolver,
  ) {
    this.pinStore = pinStore;
    this.annotationStore = annotationStore;
    this.projectAliasStore = projectAliasStore;
    this.projectAssociationStore = projectAssociationStore;
    if (isCodexAgentRunsService(codexAgentRunsOrExtensionUri)) {
      this.codexAgentRuns = codexAgentRunsOrExtensionUri;
      this.sessionIconResolver = sessionIconResolver!;
    } else {
      this.codexAgentRuns = new CodexAgentRunsService({ getIndex: () => emptyHistoryIndex() } as never);
      this.sessionIconResolver = new SessionIconResolver(codexAgentRunsOrExtensionUri);
    }
  }

  public get root(): SearchRootNode | null {
    return this.rootNode;
  }

  public get visibleTotalHits(): number {
    return this.getVisibleSessionNodes().reduce((sum, node) => sum + node.hits.length, 0);
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
      const visibleTotalHits = this.visibleTotalHits;
      const item = new vscode.TreeItem(
        `${element.query} (${visibleTotalHits})`,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      const scopeLabel = formatScopeLabel(element);
      item.description = scopeLabel;
      item.contextValue = toTreeItemContextValue(element);
      item.tooltip = t("tree.tooltip.searchRoot", element.query, scopeLabel || t("search.filter.all"), visibleTotalHits);
      return item;
    }
    if (element instanceof SearchSessionNode) {
      const pinned = this.pinStore.isPinned(element.session.fsPath);
      const annotation = this.annotationStore.get(element.session.fsPath);
      // Truncate the tree title to ~20 full-width characters (40 half-width units) and append "...".
      const shortTitle = truncateByDisplayWidth(element.session.displayTitle, 40, "...");
      const projectDisplayCwd = this.getProjectDisplayCwd(getSessionCwd(element.session));
      const projectAlias = this.projectAliasStore.getAliasByCwd(projectDisplayCwd);
      const config = getConfig();
      const agentPresentation = config.agentRunsEnabled && element.session.source === "codex"
        ? this.codexAgentRuns.getPresentation(element.session, t("codexAgentRuns.subagent"))
        : undefined;
      const label = `${element.session.localDate} ${element.session.timeLabel} ${shortTitle} (${element.hits.length})`;
      const item = new vscode.TreeItem(
        label,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.description = buildSessionDescription(
        element.session,
        annotation?.tags ?? [],
        projectAlias,
        projectDisplayCwd,
        agentPresentation,
      );
      const node = new SessionNode(element.session, pinned);
      item.contextValue = toTreeItemContextValue(
        node,
        agentPresentation?.relation,
        Boolean(agentPresentation?.parentSession),
      );
      // Show source-specific icons (Codex/Claude) in the list row.
      item.iconPath = this.sessionIconResolver.resolve(
        element.session,
        config.agentRunsEnabled && this.codexAgentRuns.isPresentationEnabled(),
        agentPresentation?.relation,
      );

      // Clicking the title opens the reusable viewer or a session tab depending on the preview setting.
      const previewOnSelection = getConfig().previewOpenOnSelection;
      item.command = {
        command: previewOnSelection ? "codexHistoryViewer.openSessionReusable" : "codexHistoryViewer.openSession",
        title: "",
        arguments: [element],
      };
      item.tooltip = buildSearchSessionTooltip(
        element,
        annotation?.tags ?? [],
        annotation?.note ?? "",
        label,
        typeof item.description === "string" ? item.description : undefined,
        projectAlias,
        projectDisplayCwd,
        agentPresentation,
      );
      return item;
    }
    if (element instanceof SearchHitNode) {
      const pinned = this.pinStore.isPinned(element.session.fsPath);
      const roleLabel = formatRoleLabel(element.hit.role, element.hit.source);
      const locationLabel = formatLocationLabel(element.hit);
      const label = `${locationLabel} ${roleLabel}: ${element.hit.snippet}`;
      const item = new vscode.TreeItem(
        label,
        vscode.TreeItemCollapsibleState.None,
      );
      const node = new SessionNode(element.session, pinned);
      const config = getConfig();
      const agentPresentation = config.agentRunsEnabled && element.session.source === "codex"
        ? this.codexAgentRuns.getPresentation(element.session, t("codexAgentRuns.subagent"))
        : undefined;
      item.contextValue = toTreeItemContextValue(
        node,
        agentPresentation?.relation,
        Boolean(agentPresentation?.parentSession),
      );
      item.iconPath = new vscode.ThemeIcon("search");

      const previewOnSelection = getConfig().previewOpenOnSelection;
      item.command = {
        command: previewOnSelection ? "codexHistoryViewer.openSessionReusable" : "codexHistoryViewer.openSession",
        title: "",
        arguments: [element],
      };
      item.tooltip =
        getConfig().previewTooltipMode === "titleOnly" ? buildTreeRowTooltip(label) : buildSearchHitTooltip(element);
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
    if (element instanceof SearchRootNode) return this.getVisibleSessionNodes();
    if (element instanceof SearchSessionNode) {
      return element.hits.map((h) => {
        const preferredMessageIndex =
          h.role === "user" || h.role === "assistant" ? h.messageIndex : undefined;
        const baseSeed = element.pageSearchSeed ?? {
          queryInput: this.rootNode?.query ?? "",
          caseSensitive: false,
        };
        return new SearchHitNode(element.session, h, this.rootNode?.query ?? "", {
          queryInput: baseSeed.queryInput,
          caseSensitive: baseSeed.caseSensitive,
          autoOpen: false,
          ...(typeof preferredMessageIndex === "number" ? { preferredMessageIndex } : {}),
        });
      });
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

  private getVisibleSessionNodes(): SearchSessionNode[] {
    return this.sessionNodes;
  }

  private getProjectDisplayCwd(cwd: string | null): string | null {
    if (!cwd) return null;
    return this.projectAssociationStore.getDisplayCwd(cwd) ?? cwd;
  }
}

function isCodexAgentRunsService(value: CodexAgentRunsService | vscode.Uri): value is CodexAgentRunsService {
  return typeof (value as CodexAgentRunsService).getPresentation === "function";
}

function emptyHistoryIndex() {
  return {
    sessionsRoot: "",
    roots: { codexSessionsRoot: "", codexArchivedSessionsRoot: "", claudeSessionsRoot: "" },
    sessions: [],
    byCacheKey: new Map(),
    byIdentityKey: new Map(),
    byYmd: new Map(),
    byYm: new Map(),
    byY: new Map(),
  };
}

function formatScopeLabel(root: SearchRootNode): string {
  // Prefer scopeValue when present; otherwise fall back to the legacy display.
  if (typeof root.scopeValue === "string" && root.scopeValue.trim().length > 0) return root.scopeValue;
  if (root.scopeKind === "all") return t("search.filter.all");
  return "";
}

function buildSearchSessionTooltip(
  node: SearchSessionNode,
  tags: readonly string[],
  note: string,
  label: string,
  description?: string,
  projectAlias?: string,
  projectDisplayCwd?: string | null,
  agentPresentation?: CodexAgentPresentation,
): string | vscode.MarkdownString {
  const mode = getConfig().previewTooltipMode;
  if (mode === "titleOnly") return buildTreeRowTooltip(label, description);

  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = false;
  appendSessionTooltipTitleLines(md, node.session);
  appendSessionTooltipDateLines(md, node.session);
  appendCodexAgentTooltipLines(md, agentPresentation);
  md.appendMarkdown(`Source: ${sourceName(node.session.source)}  \n`);
  if (node.session.storage.archiveState === "archived") {
    md.appendMarkdown(`${escapeForMarkdown(t("tree.tooltip.location"))}: ${escapeForMarkdown(t("session.location.archived"))}  \n`);
  }
  const alias = String(projectAlias ?? "").trim();
  const cwd = typeof node.session.meta?.cwd === "string" ? node.session.meta.cwd.trim() : "";
  const displayCwd = typeof projectDisplayCwd === "string" ? projectDisplayCwd.trim() : "";
  if (alias) {
    md.appendMarkdown(`${escapeForMarkdown(t("tree.tooltip.projectLabel"))}: ${escapeForMarkdown(alias)}  \n`);
  }
  if (displayCwd && cwd && displayCwd !== cwd) {
    md.appendMarkdown(`${escapeForMarkdown(t("tree.tooltip.displayCwdLabel"))}: ${escapeForMarkdown(displayCwd)}  \n`);
    md.appendMarkdown(`${escapeForMarkdown(t("tree.tooltip.originalCwdLabel"))}: ${escapeForMarkdown(cwd)}  \n`);
  } else if (alias && cwd) {
    md.appendMarkdown(`${escapeForMarkdown(t("tree.tooltip.cwdLabel"))}: ${escapeForMarkdown(cwd)}  \n`);
  } else if (node.session.cwdShort) {
    md.appendMarkdown(`${escapeForMarkdown(node.session.cwdShort)}  \n`);
  }
  if (tags.length > 0) md.appendMarkdown(`Tags: ${escapeForMarkdown(tags.join(", "))}  \n`);
  if (note.trim().length > 0) md.appendMarkdown(`Note: ${escapeForMarkdown(note.trim())}  \n`);
  md.appendMarkdown(`${escapeForMarkdown(t("tree.tooltip.searchSession", node.hits.length))}\n`);
  if (mode === "compact") return md;

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
  source?: SearchHit["source"],
): string {
  if (role !== "tool") return role;
  if (source === "annotationTag") return "tag";
  if (source === "annotationNote") return "note";
  if (source === "customTitle") return "custom title";
  if (source === "originalTitle") return "original title";
  if (source === "toolArguments") return "tool.args";
  if (source === "toolOutput") return "tool.output";
  return "tool";
}

function formatLocationLabel(hit: {
  messageIndex: number;
  source?: SearchHit["source"];
}): string {
  if (
    hit.source === "annotationTag" ||
    hit.source === "annotationNote" ||
    hit.source === "customTitle" ||
    hit.source === "originalTitle"
  ) {
    return "[meta]";
  }
  if (hit.messageIndex <= 0) return "[meta]";
  return `[#${hit.messageIndex}]`;
}

function isSameSearchHit(
  a: {
    messageIndex: number;
    role: "user" | "assistant" | "developer" | "tool";
    source?: SearchHit["source"];
    snippet: string;
  },
  b: {
    messageIndex: number;
    role: "user" | "assistant" | "developer" | "tool";
    source?: SearchHit["source"];
    snippet: string;
  },
): boolean {
  return a.messageIndex === b.messageIndex && a.role === b.role && a.source === b.source && a.snippet === b.snippet;
}

function sourceName(source: SessionSource): string {
  return source === "claude" ? "Claude Code" : "Codex";
}

function getSessionCwd(session: SessionSummary): string | null {
  const cwd = typeof session.meta?.cwd === "string" ? session.meta.cwd.trim() : "";
  return cwd.length > 0 ? cwd : null;
}
