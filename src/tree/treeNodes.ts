import * as vscode from "vscode";
import type { SessionSummary } from "../sessions/sessionTypes";
import { t } from "../i18n";

// Node definitions used by TreeDataProviders.

export type TreeNode =
  | YearNode
  | MonthNode
  | DayNode
  | ProjectNode
  | RelatedGroupNode
  | ProjectYearNode
  | ProjectMonthNode
  | ProjectDayNode
  | SessionNode
  | SearchRootNode
  | SearchSessionNode
  | SearchHitNode
  | SearchHelpNode
  | HistoryEmptyNode
  | MissingPinnedNode
  | PinnedDropHintNode;

export type ProjectAssociatedSourceMode = "relocate" | "groupOnly";

export interface ProjectAssociatedSource {
  cwd: string;
  mode: ProjectAssociatedSourceMode;
}

export interface ProjectParentAssociation {
  sourceCwd: string;
  targetCwd: string;
  mode: ProjectAssociatedSourceMode;
}

export class YearNode {
  public readonly kind = "year";
  public readonly year: string;

  constructor(year: string) {
    this.year = year;
  }
}

export class MonthNode {
  public readonly kind = "month";
  public readonly year: string;
  public readonly month: string;

  constructor(year: string, month: string) {
    this.year = year;
    this.month = month;
  }
}

export class DayNode {
  public readonly kind = "day";
  public readonly year: string;
  public readonly month: string;
  public readonly day: string;

  constructor(year: string, month: string, day: string) {
    this.year = year;
    this.month = month;
    this.day = day;
  }

  public get ymd(): string {
    return `${this.year}-${this.month}-${this.day}`;
  }
}

export class ProjectNode {
  public readonly kind = "project";
  public readonly key: string;
  public readonly label: string;
  public readonly cwd: string | null;
  public readonly alias: string | null;
  public readonly fallbackLabel: string;
  public readonly sessionCount: number;
  public readonly latestLabel: string;
  public readonly description: string;
  public readonly associatedSources: readonly ProjectAssociatedSource[];
  public readonly targetMissingHistory: boolean;
  public readonly parentAssociation: ProjectParentAssociation | null;

  constructor(params: {
    key: string;
    label: string;
    cwd: string | null;
    alias?: string | null;
    fallbackLabel?: string;
    sessionCount: number;
    latestLabel: string;
    description: string;
    associatedSources?: readonly ProjectAssociatedSource[];
    targetMissingHistory?: boolean;
    parentAssociation?: ProjectParentAssociation | null;
  }) {
    this.key = params.key;
    this.label = params.label;
    this.cwd = params.cwd;
    this.alias = params.alias ?? null;
    this.fallbackLabel = params.fallbackLabel ?? params.label;
    this.sessionCount = params.sessionCount;
    this.latestLabel = params.latestLabel;
    this.description = params.description;
    this.associatedSources = params.associatedSources ?? [];
    this.targetMissingHistory = params.targetMissingHistory ?? false;
    this.parentAssociation = params.parentAssociation ?? null;
  }
}

export class RelatedGroupNode {
  public readonly kind = "relatedGroup";
  public readonly key: string;
  public readonly label: string;
  public readonly cwd: string | null;
  public readonly alias: string | null;
  public readonly fallbackLabel: string;
  public readonly sessionCount: number;
  public readonly projectCount: number;
  public readonly latestLabel: string;
  public readonly description: string;
  public readonly directSources: readonly ProjectAssociatedSource[];
  public readonly children: readonly TreeNode[];
  public readonly parentAssociation: ProjectParentAssociation | null;

  constructor(params: {
    key: string;
    label: string;
    cwd: string | null;
    alias?: string | null;
    fallbackLabel?: string;
    sessionCount: number;
    projectCount: number;
    latestLabel: string;
    description: string;
    directSources?: readonly ProjectAssociatedSource[];
    children?: readonly TreeNode[];
    parentAssociation?: ProjectParentAssociation | null;
  }) {
    this.key = params.key;
    this.label = params.label;
    this.cwd = params.cwd;
    this.alias = params.alias ?? null;
    this.fallbackLabel = params.fallbackLabel ?? params.label;
    this.sessionCount = params.sessionCount;
    this.projectCount = params.projectCount;
    this.latestLabel = params.latestLabel;
    this.description = params.description;
    this.directSources = params.directSources ?? [];
    this.children = params.children ?? [];
    this.parentAssociation = params.parentAssociation ?? null;
  }
}

export class ProjectYearNode {
  public readonly kind = "projectYear";
  public readonly projectKey: string;
  public readonly year: string;

  constructor(projectKey: string, year: string) {
    this.projectKey = projectKey;
    this.year = year;
  }
}

export class ProjectMonthNode {
  public readonly kind = "projectMonth";
  public readonly projectKey: string;
  public readonly year: string;
  public readonly month: string;

  constructor(projectKey: string, year: string, month: string) {
    this.projectKey = projectKey;
    this.year = year;
    this.month = month;
  }
}

export class ProjectDayNode {
  public readonly kind = "projectDay";
  public readonly projectKey: string;
  public readonly year: string;
  public readonly month: string;
  public readonly day: string;

  constructor(projectKey: string, year: string, month: string, day: string) {
    this.projectKey = projectKey;
    this.year = year;
    this.month = month;
    this.day = day;
  }

  public get ymd(): string {
    return `${this.year}-${this.month}-${this.day}`;
  }
}

export class SessionNode {
  public readonly kind = "session";
  public readonly session: SessionSummary;
  public readonly pinned: boolean;

  constructor(session: SessionSummary, pinned: boolean) {
    this.session = session;
    this.pinned = pinned;
  }
}

export class MissingPinnedNode {
  public readonly kind = "missingPinned";
  public readonly fsPath: string;

  constructor(fsPath: string) {
    this.fsPath = fsPath;
  }
}

export class PinnedDropHintNode {
  public readonly kind = "pinnedDropHint";
}

export interface SearchHit {
  messageIndex: number; // 1-based (display order for user/assistant)
  role: "user" | "assistant" | "developer" | "tool";
  source?: "message" | "toolArguments" | "toolOutput" | "annotationTag" | "annotationNote" | "customTitle" | "originalTitle";
  snippet: string;
}

export interface SessionPageSearchSeed {
  queryInput: string;
  caseSensitive: boolean;
  preferredMessageIndex?: number;
  autoOpen?: boolean;
}

export class SearchRootNode {
  public readonly kind = "searchRoot";
  public readonly query: string;
  public readonly scopeKind: "all" | "year" | "month" | "day";
  public readonly scopeValue?: string;
  public readonly totalHits: number;
  public readonly pageSearchSeed?: SessionPageSearchSeed;

  constructor(params: {
    query: string;
    scopeKind: "all" | "year" | "month" | "day";
    scopeValue?: string;
    totalHits: number;
    pageSearchSeed?: SessionPageSearchSeed;
  }) {
    this.query = params.query;
    this.scopeKind = params.scopeKind;
    this.scopeValue = params.scopeValue;
    this.totalHits = params.totalHits;
    this.pageSearchSeed = params.pageSearchSeed;
  }
}

export class SearchSessionNode {
  public readonly kind = "searchSession";
  public readonly session: SessionSummary;
  public readonly hits: SearchHit[];
  public readonly pageSearchSeed?: SessionPageSearchSeed;

  constructor(session: SessionSummary, hits: SearchHit[], pageSearchSeed?: SessionPageSearchSeed) {
    this.session = session;
    this.hits = hits;
    this.pageSearchSeed = pageSearchSeed;
  }
}

export class SearchHitNode {
  public readonly kind = "searchHit";
  public readonly session: SessionSummary;
  public readonly hit: SearchHit;
  public readonly query: string;
  public readonly pageSearchSeed?: SessionPageSearchSeed;

  constructor(session: SessionSummary, hit: SearchHit, query: string, pageSearchSeed?: SessionPageSearchSeed) {
    this.session = session;
    this.hit = hit;
    this.query = query;
    this.pageSearchSeed = pageSearchSeed;
  }
}

export class SearchHelpNode {
  public readonly kind = "searchHelp";
}

export class HistoryEmptyNode {
  public readonly kind = "historyEmpty";
  public readonly label: string;
  public readonly iconId: string;

  constructor(label: string, iconId = "info") {
    this.label = label;
    this.iconId = iconId;
  }
}

export function isSessionNode(element: unknown): element is SessionNode | SearchSessionNode | SearchHitNode {
  if (!element || typeof element !== "object") return false;
  const maybe = element as any;
  return !!maybe.session && typeof maybe.session.fsPath === "string";
}

export function toTreeItemContextValue(node: TreeNode): string {
  // Centralize contextValue strings used by package.json menus/viewItem conditions.
  switch (node.kind) {
    case "year":
      return "codexHistoryViewer.year";
    case "month":
      return "codexHistoryViewer.month";
    case "day":
      return "codexHistoryViewer.day";
    case "project":
      return node.cwd ? "codexHistoryViewer.project.withCwd" : "codexHistoryViewer.project.noCwd";
    case "relatedGroup":
      return node.cwd ? "codexHistoryViewer.relatedGroup.withCwd" : "codexHistoryViewer.relatedGroup.noCwd";
    case "projectYear":
      return "codexHistoryViewer.projectYear";
    case "projectMonth":
      return "codexHistoryViewer.projectMonth";
    case "projectDay":
      return "codexHistoryViewer.projectDay";
    case "session":
      return withCustomTitleMarker(
        node.pinned
          ? `codexHistoryViewer.sessionPinned.${node.session.source}`
          : `codexHistoryViewer.session.${node.session.source}`,
        node.session,
      );
    case "missingPinned":
      return "codexHistoryViewer.sessionMissing";
    case "pinnedDropHint":
      return "codexHistoryViewer.pinnedDropHint";
    case "searchRoot":
      return "codexHistoryViewer.searchRoot";
    case "searchSession":
      return withCustomTitleMarker(`codexHistoryViewer.searchSession.${node.session.source}`, node.session);
    case "searchHit":
      return withCustomTitleMarker(`codexHistoryViewer.searchHit.${node.session.source}`, node.session);
    case "searchHelp":
      return "codexHistoryViewer.searchHelp";
    case "historyEmpty":
      return "codexHistoryViewer.historyEmpty";
    default:
      return "codexHistoryViewer.unknown";
  }
}

function withCustomTitleMarker(base: string, session: SessionSummary): string {
  const archivedBase = session.storage.archiveState === "archived" ? `${base}.archived` : base;
  return session.customTitle ? `${archivedBase}.customTitle` : archivedBase;
}

export function missingPinnedLabel(): string {
  return t("tree.pinned.missing");
}
