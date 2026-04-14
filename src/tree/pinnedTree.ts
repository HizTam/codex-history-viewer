import * as path from "node:path";
import * as vscode from "vscode";
import type { HistoryService } from "../services/historyService";
import type { PinStore } from "../services/pinStore";
import type { SessionAnnotationStore } from "../services/sessionAnnotationStore";
import type { SessionSource, SessionSourceFilter, SessionSummary } from "../sessions/sessionTypes";
import { MissingPinnedNode, PinnedDropHintNode, SessionNode, TreeNode, missingPinnedLabel, toTreeItemContextValue } from "./treeNodes";
import { getConfig } from "../settings";
import { truncateByDisplayWidth } from "../utils/textUtils";
import { t } from "../i18n";
import { appendSessionTooltipDateLines } from "./sessionTooltipUtils";

// Provides the pinned sessions view.
export class PinnedTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly historyService: HistoryService;
  private readonly pinStore: PinStore;
  private readonly annotationStore: SessionAnnotationStore;
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
    sourceFilter: SessionSourceFilter,
    tagFilter: readonly string[],
    extensionUri: vscode.Uri,
  ) {
    this.historyService = historyService;
    this.pinStore = pinStore;
    this.annotationStore = annotationStore;
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

  public setTagFilter(tags: readonly string[]): void {
    this.tagFilter = normalizeTagFilter(tags);
  }

  public setSourceFilter(sourceFilter: SessionSourceFilter): void {
    this.sourceFilter = normalizeSourceFilter(sourceFilter);
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

  private matchesMissingPinnedSource(fsPath: string): boolean {
    if (this.sourceFilter === "all") return true;
    const inferred = inferSourceFromFsPath(fsPath);
    if (!inferred) return true;
    return inferred === this.sourceFilter;
  }

  public getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element instanceof SessionNode) {
      // Truncate the tree title to ~20 full-width characters (40 half-width units) and append "...".
      const shortTitle = truncateByDisplayWidth(element.session.snippet, 40, "...");
      const annotation = this.annotationStore.get(element.session.fsPath);
      const item = new vscode.TreeItem(
        `${element.session.localDate} ${element.session.timeLabel} ${shortTitle}`,
      );
      item.description = buildSessionDescription(element.session.cwdShort, annotation?.tags ?? []);
      item.contextValue = toTreeItemContextValue(element);
      // Show source-specific icons (Codex/Claude) in the list row.
      item.iconPath = this.resolveSourceIconPath(element.session.source);

      // Clicking the title opens the viewer (preview on selection or openSession); unpin is done via the context menu.
      const previewOnSelection = getConfig().previewOpenOnSelection;
      if (!previewOnSelection) {
        item.command = { command: "codexHistoryViewer.openSession", title: "", arguments: [element] };
      }

      // Show a short preview in the tooltip for quicker scanning.
      const md = new vscode.MarkdownString(undefined, true);
      md.isTrusted = false;
      appendSessionTooltipDateLines(md, element.session);
      md.appendMarkdown(`Source: ${sourceName(element.session.source)}  \n`);
      if (element.session.cwdShort) md.appendMarkdown(`${escapeForMarkdown(element.session.cwdShort)}  \n`);
      if (annotation && annotation.tags.length > 0) {
        md.appendMarkdown(`Tags: ${escapeForMarkdown(annotation.tags.join(", "))}  \n`);
      }
      if (annotation && annotation.note.length > 0) {
        md.appendMarkdown(`Note: ${escapeForMarkdown(annotation.note)}  \n`);
      }
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
    if (element) return [];
    const pins = this.pinStore.getAll().sort((a, b) => b.pinnedAt - a.pinnedAt);
    const nodes: TreeNode[] = [];
    for (const p of pins) {
      const s = this.historyService.findByFsPath(p.fsPath);
      if (s) {
        if (!this.matchesSource(s)) continue;
        if (!this.matchesTags(s.fsPath)) continue;
        nodes.push(new SessionNode(s, true));
      } else {
        if (!this.matchesMissingPinnedSource(p.fsPath)) continue;
        nodes.push(new MissingPinnedNode(p.fsPath));
      }
    }
    // Show a drop target even in the initial empty state to avoid DnD no-op right after reload.
    if (nodes.length === 0) return [new PinnedDropHintNode()];
    return nodes;
  }

  private resolveSourceIconPath(source: SessionSource): { light: vscode.Uri; dark: vscode.Uri } {
    return source === "claude" ? this.claudeIconPath : this.codexIconPath;
  }
}

function escapeForMarkdown(s: string): string {
  // Minimal escaping for embedding user content into MarkdownString.
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

function sourceName(source: SessionSource): string {
  return source === "claude" ? "Claude" : "Codex";
}

function inferSourceFromFsPath(fsPath: string): SessionSource | null {
  const cfg = getConfig();
  if (isPathInsideRoot(fsPath, cfg.sessionsRoot)) return "codex";
  if (isPathInsideRoot(fsPath, cfg.claudeSessionsRoot)) return "claude";

  const base = path.basename(fsPath).toLowerCase();
  if (base.startsWith("rollout-")) return "codex";
  if (base.endsWith(".jsonl")) return "claude";
  return null;
}

function isPathInsideRoot(fsPath: string, rootPath: string): boolean {
  const root = String(rootPath ?? "").trim();
  if (!root) return false;
  const rel = path.relative(root, fsPath);
  if (!rel) return true;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}
