import type * as vscode from "vscode";

export const HISTORY_INSIGHTS_APPLY_TO_HISTORY_KEY = "codexHistoryViewer.historyInsights.applyToHistory.v1";

export interface HistoryInsightsApplyPreferenceUpdateResult {
  ok: boolean;
  value: boolean;
}

export function sanitizeHistoryInsightsApplyPreference(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export class HistoryInsightsApplyPreferenceStore {
  private readonly workspaceState: Pick<vscode.Memento, "get" | "update">;
  private value: boolean;
  private updateQueue: Promise<void> = Promise.resolve();

  constructor(workspaceState: Pick<vscode.Memento, "get" | "update">) {
    this.workspaceState = workspaceState;
    this.value = sanitizeHistoryInsightsApplyPreference(
      workspaceState.get<unknown>(HISTORY_INSIGHTS_APPLY_TO_HISTORY_KEY),
    ) ?? false;
  }

  public get current(): boolean {
    return this.value;
  }

  public update(enabled: boolean): Promise<HistoryInsightsApplyPreferenceUpdateResult> {
    const operation = this.updateQueue.then(async () => {
      const previous = this.value;
      try {
        await this.workspaceState.update(HISTORY_INSIGHTS_APPLY_TO_HISTORY_KEY, enabled);
        this.value = enabled;
        return { ok: true, value: enabled };
      } catch {
        return { ok: false, value: previous };
      }
    });
    this.updateQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
