import * as path from "node:path";
import * as vscode from "vscode";
import type { HistoryService } from "../services/historyService";
import type { PinEntry, PinStore } from "../services/pinStore";
import type { SessionAnnotationStore } from "../services/sessionAnnotationStore";
import type { ArchiveLocationFilter, SessionSource, SessionSourceFilter, SessionSummary } from "../sessions/sessionTypes";
import {
  HistoryEmptyNode,
  MissingPinnedNode,
  PinnedDropHintNode,
  SessionNode,
  TreeNode,
  missingPinnedLabel,
  toTreeItemContextValue,
} from "./treeNodes";
import { getConfig } from "../settings";
import { truncateByDisplayWidth } from "../utils/textUtils";
import { t } from "../i18n";
import { buildSessionHoverTooltip } from "./sessionTooltipUtils";

// Provides the pinned sessions view.
export class PinnedTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly historyService: HistoryService;
  private readonly pinStore: PinStore;
  private readonly annotationStore: SessionAnnotationStore;
  private sourceFilter: SessionSourceFilter;
  private tagFilter: string[];
  private archiveLocationFilter: ArchiveLocationFilter;
  private readonly codexIconPath: { light: vscode.Uri; dark: vscode.Uri };
  private readonly claudeIconPath: { light: vscode.Uri; dark: vscode.Uri };
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined | null | void>();
  private initialLoadComplete = false;
  public readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    historyService: HistoryService,
    pinStore: PinStore,
    annotationStore: SessionAnnotationStore,
    sourceFilter: SessionSourceFilter,
    tagFilter: readonly string[],
    archiveLocationFilter: ArchiveLocationFilter,
    extensionUri: vscode.Uri,
  ) {
    this.historyService = historyService;
    this.pinStore = pinStore;
    this.annotationStore = annotationStore;
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

  public setSourceFilter(sourceFilter: SessionSourceFilter): void {
    this.sourceFilter = normalizeSourceFilter(sourceFilter);
  }

  public setArchiveLocationFilter(archiveLocationFilter: ArchiveLocationFilter): void {
    this.archiveLocationFilter = archiveLocationFilter;
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
    if (element instanceof SessionNode) {
      // Truncate the tree title to ~20 full-width characters (40 half-width units) and append "...".
      const shortTitle = truncateByDisplayWidth(element.session.displayTitle, 40, "...");
      const annotation = this.annotationStore.get(element.session.fsPath);
      const item = new vscode.TreeItem(
        `${element.session.localDate} ${element.session.timeLabel} ${shortTitle}`,
      );
      item.description = buildSessionDescription(element.session, annotation?.tags ?? []);
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
    if (element) return [];
    if (!this.initialLoadComplete) {
      return [new HistoryEmptyNode(t("history.empty.loading"), "sync~spin")];
    }

    const pins = this.pinStore.getAll().sort((a, b) => b.pinnedAt - a.pinnedAt);
    const nodes: TreeNode[] = [];
    for (const p of pins) {
      const s = this.historyService.findByFsPath(p.fsPath);
      if (s) {
        if (!this.matchesArchiveVisibility(s)) continue;
        if (!this.matchesSource(s)) continue;
        if (!this.matchesTags(s.fsPath)) continue;
        nodes.push(new SessionNode(s, true));
      } else {
        if (!this.matchesPinnedArchiveVisibility(p)) continue;
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

function buildSessionDescription(session: SessionSummary, tags: readonly string[]): string {
  const parts: string[] = [];
  if (session.storage.archiveState === "archived") parts.push(t("tree.description.archived"));
  if (session.cwdShort) parts.push(session.cwdShort);
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
