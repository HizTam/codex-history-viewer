import * as vscode from "vscode";
import { t } from "../i18n";
import { safeDisplayPath } from "../utils/textUtils";

type UtilityNode = ActionNode | InfoNode;

interface ActionNode {
  kind: "action";
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon: vscode.ThemeIcon;
  command: vscode.Command;
}

interface InfoNode {
  kind: "info";
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon?: vscode.ThemeIcon;
}

// Control pane: aggregates global and quick actions.
export class ControlTreeDataProvider implements vscode.TreeDataProvider<UtilityNode> {
  private readonly emitter = new vscode.EventEmitter<UtilityNode | undefined | null | void>();
  public readonly onDidChangeTreeData = this.emitter.event;

  public refresh(): void {
    this.emitter.fire();
  }

  public getTreeItem(element: UtilityNode): vscode.TreeItem {
    return toTreeItem(element);
  }

  public async getChildren(element?: UtilityNode): Promise<UtilityNode[]> {
    if (element) return [];
    return [
      makeAction({
        id: "openSettings",
        label: t("control.action.openSettings"),
        description: t("control.action.openSettings.description"),
        icon: new vscode.ThemeIcon("gear"),
        command: { command: "codexHistoryViewer.openSettings", title: "" },
      }),
      makeAction({
        id: "refreshAll",
        label: t("control.action.refreshAll"),
        description: t("control.action.refreshAll.description"),
        icon: new vscode.ThemeIcon("refresh"),
        command: { command: "codexHistoryViewer.refresh", title: "", arguments: [{ view: "all" }] },
      }),
      makeAction({
        id: "importSessions",
        label: t("control.action.import"),
        description: t("control.action.import.description"),
        icon: new vscode.ThemeIcon("cloud-upload"),
        command: { command: "codexHistoryViewer.importSessions", title: "" },
      }),
      makeAction({
        id: "undo",
        label: t("control.action.undo"),
        description: t("control.action.undo.description"),
        icon: new vscode.ThemeIcon("discard"),
        command: { command: "codexHistoryViewer.undoLastAction", title: "" },
      }),
      makeAction({
        id: "search",
        label: t("quickStart.action.search"),
        description: t("quickStart.action.search.description"),
        icon: new vscode.ThemeIcon("search"),
        command: { command: "codexHistoryViewer.search", title: "" },
      }),
      makeAction({
        id: "runPreset",
        label: t("quickStart.action.runPreset"),
        description: t("quickStart.action.runPreset.description"),
        icon: new vscode.ThemeIcon("bookmark"),
        command: { command: "codexHistoryViewer.searchRunPreset", title: "" },
      }),
      makeAction({
        id: "configureSearchRoles",
        label: t("control.action.searchRoles"),
        description: t("control.action.searchRoles.description"),
        icon: new vscode.ThemeIcon("settings-gear"),
        command: { command: "codexHistoryViewer.searchConfigureDefaultRoles", title: "" },
      }),
      makeAction({
        id: "filterCurrentProject",
        label: t("quickStart.action.filterCurrentProject"),
        description: t("quickStart.action.filterCurrentProject.description"),
        icon: new vscode.ThemeIcon("folder-opened"),
        command: { command: "codexHistoryViewer.filterHistoryCurrentProject", title: "" },
      }),
      makeAction({
        id: "cleanupMissingPins",
        label: t("maintenance.action.cleanupMissingPins"),
        description: t("maintenance.action.cleanupMissingPins.description"),
        icon: new vscode.ThemeIcon("trash"),
        command: { command: "codexHistoryViewer.cleanupMissingPins", title: "" },
      }),
      makeAction({
        id: "renameTagGlobally",
        label: t("control.action.renameTagGlobally"),
        description: t("control.action.renameTagGlobally.description"),
        icon: new vscode.ThemeIcon("replace-all"),
        command: { command: "codexHistoryViewer.renameTagGlobally", title: "" },
      }),
      makeAction({
        id: "deleteTagsGlobally",
        label: t("control.action.deleteTagsGlobally"),
        description: t("control.action.deleteTagsGlobally.description"),
        icon: new vscode.ThemeIcon("trash"),
        command: { command: "codexHistoryViewer.deleteTagsGlobally", title: "" },
      }),
      makeAction({
        id: "rebuildCache",
        label: t("maintenance.action.rebuildCache"),
        description: t("maintenance.action.rebuildCache.description"),
        icon: new vscode.ThemeIcon("sync"),
        command: { command: "codexHistoryViewer.rebuildCache", title: "" },
      }),
      makeAction({
        id: "debugInfo",
        label: t("maintenance.action.debugInfo"),
        description: t("maintenance.action.debugInfo.description"),
        icon: new vscode.ThemeIcon("bug"),
        command: { command: "codexHistoryViewer.debugInfo", title: "" },
      }),
    ];
  }
}

export interface StatusSnapshot {
  enableCodexSource: boolean;
  enableClaudeSource: boolean;
  codexSessionCount: number;
  claudeSessionCount: number;
  pinCount: number;
  missingPinCount: number;
  presetCount: number;
  totalTagCount: number;
  searchHitCount: number;
  currentSearchRoles: readonly string[];
  currentSearchTagFilter: readonly string[];
  filterSummary: string;
  currentProjectCwd: string | null;
  codexSessionsRoot: string;
  claudeSessionsRoot: string;
  lastRefreshAt: number | null;
}

// Status pane: shows counts and filter state.
export class StatusTreeDataProvider implements vscode.TreeDataProvider<UtilityNode> {
  private readonly emitter = new vscode.EventEmitter<UtilityNode | undefined | null | void>();
  public readonly onDidChangeTreeData = this.emitter.event;
  private readonly getSnapshot: () => StatusSnapshot;

  constructor(getSnapshot: () => StatusSnapshot) {
    this.getSnapshot = getSnapshot;
  }

  public refresh(): void {
    this.emitter.fire();
  }

  public getTreeItem(element: UtilityNode): vscode.TreeItem {
    return toTreeItem(element);
  }

  public async getChildren(element?: UtilityNode): Promise<UtilityNode[]> {
    if (element) return [];
    const s = this.getSnapshot();
    const currentProject = typeof s.currentProjectCwd === "string" && s.currentProjectCwd.trim().length > 0 ? s.currentProjectCwd : null;
    const currentSearchRoles = s.currentSearchRoles.map((x) => String(x).trim()).filter((x) => x.length > 0);
    const currentSearchTags = s.currentSearchTagFilter.map((x) => String(x).trim()).filter((x) => x.length > 0);
    const refreshed =
      typeof s.lastRefreshAt === "number" && Number.isFinite(s.lastRefreshAt)
        ? new Date(s.lastRefreshAt).toLocaleString()
        : t("status.value.none");
    const items: UtilityNode[] = [];

    if (s.enableCodexSource) {
      items.push(
        makeInfo(
          "status.sessions.codex",
          t("status.label.sessionsCodex"),
          String(s.codexSessionCount),
          new vscode.ThemeIcon("list-unordered"),
        ),
      );
    }
    if (s.enableClaudeSource) {
      items.push(
        makeInfo(
          "status.sessions.claude",
          t("status.label.sessionsClaude"),
          String(s.claudeSessionCount),
          new vscode.ThemeIcon("list-unordered"),
        ),
      );
    }

    items.push(
      makeInfo("status.pins", t("status.label.pins"), String(s.pinCount), new vscode.ThemeIcon("pinned")),
      makeInfo("status.missingPins", t("status.label.missingPins"), String(s.missingPinCount), new vscode.ThemeIcon("warning")),
      makeInfo("status.presets", t("status.label.presets"), String(s.presetCount), new vscode.ThemeIcon("bookmark")),
      makeInfo("status.totalTags", t("status.label.totalTags"), String(s.totalTagCount), new vscode.ThemeIcon("tag")),
      makeInfo("status.searchHits", t("status.label.searchHits"), String(s.searchHitCount), new vscode.ThemeIcon("search")),
      makeInfo(
        "status.searchRoles",
        t("status.label.searchRoles"),
        currentSearchRoles.length > 0 ? currentSearchRoles.join(", ") : t("status.value.none"),
        new vscode.ThemeIcon("settings-gear"),
      ),
      makeInfo(
        "status.searchTags",
        t("status.label.searchTags"),
        currentSearchTags.length > 0 ? currentSearchTags.map((x) => `#${x}`).join(", ") : t("status.value.none"),
        new vscode.ThemeIcon("tag"),
      ),
      makeInfo("status.filter", t("status.label.filter"), s.filterSummary || t("history.filter.all"), new vscode.ThemeIcon("filter")),
      makeInfo(
        "status.currentProject",
        t("status.label.currentProject"),
        currentProject ? safeDisplayPath(currentProject, 64) : t("status.value.none"),
        new vscode.ThemeIcon("folder-library"),
        currentProject ?? undefined,
      ),
      makeInfo("status.lastRefresh", t("status.label.lastRefresh"), refreshed, new vscode.ThemeIcon("history")),
    );

    if (s.enableCodexSource) {
      items.push(
        makeInfo(
          "status.sessionsRoot.codex",
          t("status.label.sessionsRootCodex"),
          safeDisplayPath(s.codexSessionsRoot, 64),
          new vscode.ThemeIcon("folder-opened"),
          s.codexSessionsRoot,
        ),
      );
    }
    if (s.enableClaudeSource) {
      items.push(
        makeInfo(
          "status.sessionsRoot.claude",
          t("status.label.sessionsRootClaude"),
          safeDisplayPath(s.claudeSessionsRoot, 64),
          new vscode.ThemeIcon("folder-opened"),
          s.claudeSessionsRoot,
        ),
      );
    }

    return items;
  }
}

function makeAction(params: {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon: vscode.ThemeIcon;
  command: vscode.Command;
}): ActionNode {
  return {
    kind: "action",
    id: params.id,
    label: params.label,
    description: params.description,
    tooltip: params.tooltip,
    icon: params.icon,
    command: params.command,
  };
}

function makeInfo(
  id: string,
  label: string,
  description?: string,
  icon?: vscode.ThemeIcon,
  tooltip?: string,
): InfoNode {
  return { kind: "info", id, label, description, icon, tooltip };
}

function toTreeItem(node: UtilityNode): vscode.TreeItem {
  if (node.kind === "action") {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.description = node.description;
    item.tooltip = node.tooltip;
    item.iconPath = node.icon;
    item.command = node.command;
    item.contextValue = "codexHistoryViewer.utilityAction";
    return item;
  }

  const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
  item.description = node.description;
  item.tooltip = node.tooltip;
  if (node.icon) item.iconPath = node.icon;
  item.contextValue = "codexHistoryViewer.utilityInfo";
  return item;
}
