import * as vscode from "vscode";
import type { SessionSummary } from "../sessions/sessionTypes";
import { t } from "../i18n";

// Node definitions used by TreeDataProviders.

export type TreeNode =
  | YearNode
  | MonthNode
  | DayNode
  | SessionNode
  | SearchRootNode
  | SearchSessionNode
  | SearchHitNode
  | SearchHelpNode
  | MissingPinnedNode;

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

export interface SearchHit {
  messageIndex: number; // 1-based (display order for user/assistant)
  role: "user" | "assistant";
  snippet: string;
}

export class SearchRootNode {
  public readonly kind = "searchRoot";
  public readonly query: string;
  public readonly scopeKind: "all" | "year" | "month" | "day";
  public readonly scopeValue?: string;
  public readonly totalHits: number;

  constructor(params: { query: string; scopeKind: "all" | "year" | "month" | "day"; scopeValue?: string; totalHits: number }) {
    this.query = params.query;
    this.scopeKind = params.scopeKind;
    this.scopeValue = params.scopeValue;
    this.totalHits = params.totalHits;
  }
}

export class SearchSessionNode {
  public readonly kind = "searchSession";
  public readonly session: SessionSummary;
  public readonly hits: SearchHit[];

  constructor(session: SessionSummary, hits: SearchHit[]) {
    this.session = session;
    this.hits = hits;
  }
}

export class SearchHitNode {
  public readonly kind = "searchHit";
  public readonly session: SessionSummary;
  public readonly hit: SearchHit;
  public readonly query: string;

  constructor(session: SessionSummary, hit: SearchHit, query: string) {
    this.session = session;
    this.hit = hit;
    this.query = query;
  }
}

export class SearchHelpNode {
  public readonly kind = "searchHelp";
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
    case "session":
      return node.pinned ? "codexHistoryViewer.sessionPinned" : "codexHistoryViewer.session";
    case "missingPinned":
      return "codexHistoryViewer.sessionMissing";
    case "searchRoot":
      return "codexHistoryViewer.searchRoot";
    case "searchSession":
      return "codexHistoryViewer.searchSession";
    case "searchHit":
      return "codexHistoryViewer.searchHit";
    case "searchHelp":
      return "codexHistoryViewer.searchHelp";
    default:
      return "codexHistoryViewer.unknown";
  }
}

export function missingPinnedLabel(): string {
  return t("tree.pinned.missing");
}
