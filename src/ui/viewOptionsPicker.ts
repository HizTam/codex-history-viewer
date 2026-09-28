import * as vscode from "vscode";
import { t } from "../i18n";
import type { HistorySortOrder, HistoryViewMode } from "../tree/historyTree";
import type { PinnedSortMode } from "../tree/pinnedTree";

const HISTORY_SORT_ORDERS: readonly HistorySortOrder[] = [
  "createdDesc", "createdAsc", "lastActivityDesc", "lastActivityAsc",
  "titleAsc", "titleDesc", "fileSizeDesc", "fileSizeAsc",
];

async function promptSort<T extends string>(
  pane: "history" | "pinned",
  values: readonly T[],
  current: T,
): Promise<T | undefined> {
  const items = values.map(value => ({
    label: t(`viewOptions.sort.${value}`),
    description: value === current ? t("common.current") : undefined,
    value,
  }));
  const selected = await vscode.window.showQuickPick(items, {
    title: t(`viewOptions.${pane}.sortTitle`),
    placeHolder: t("viewOptions.choose"),
  });
  // Accept only an item from this picker, never an arbitrary command or value.
  return selected && items.includes(selected) ? selected.value : undefined;
}

export function promptHistorySortOrder(current: HistorySortOrder): Promise<HistorySortOrder | undefined> {
  return promptSort("history", HISTORY_SORT_ORDERS, current);
}

export function promptPinnedSortMode(current: PinnedSortMode): Promise<PinnedSortMode | undefined> {
  return promptSort<PinnedSortMode>("pinned", ["pinnedAtDesc", "pinnedAtAsc", ...HISTORY_SORT_ORDERS], current);
}

export type ViewPresentationChange =
  | { kind: "view"; value: HistoryViewMode }
  | { kind: "display"; value: "list" | "project" }
  | { kind: "scope"; value: "all" | "currentGroup" };

type PresentationPick = vscode.QuickPickItem & { change?: ViewPresentationChange };

export async function promptViewPresentation(
  pane: "history" | "pinned",
  current: { mode?: HistoryViewMode; display: "list" | "project"; scope: "all" | "currentGroup" },
): Promise<ViewPresentationChange | undefined> {
  const items: PresentationPick[] = [];
  const section = (key: string): void => {
    items.push({ label: t(`viewOptions.section.${key}`), kind: vscode.QuickPickItemKind.Separator });
  };
  const choice = (change: ViewPresentationChange, currentValue: string | undefined): void => {
    items.push({
      label: t(`viewOptions.${change.kind}.${change.value}`),
      description: change.value === currentValue ? t("common.current") : undefined,
      change,
    });
  };
  if (pane === "history") {
    section("view");
    choice({ kind: "view", value: "date" }, current.mode);
    choice({ kind: "view", value: "latest" }, current.mode);
  }
  section("display");
  choice({ kind: "display", value: "list" }, current.display);
  choice({ kind: "display", value: "project" }, current.display);
  section("scope");
  choice({ kind: "scope", value: "currentGroup" }, current.scope);
  choice({ kind: "scope", value: "all" }, current.scope);

  const selected = await vscode.window.showQuickPick(items, {
    title: t(`viewOptions.${pane}.presentationTitle`),
    placeHolder: t("viewOptions.choose"),
  });
  // Return a single patch so changes made elsewhere while the picker was open survive.
  return selected && items.includes(selected) ? selected.change : undefined;
}
