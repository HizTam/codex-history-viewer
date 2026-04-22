export interface UndoAction {
  label: string;
  undo: () => Promise<void>;
  cleanup?: (reason: UndoCleanupReason) => Promise<void> | void;
}

export type UndoCleanupReason = "discarded" | "cleared" | "undone";

export interface UndoServiceOptions {
  maxActions?: number;
}

export const DEFAULT_UNDO_MAX_ACTIONS = 20;

// Keeps recent undo actions in memory.
export class UndoService {
  private readonly stack: UndoAction[] = [];
  private readonly onChanged: (canUndo: boolean) => void;
  private readonly maxActions: number;

  constructor(onChanged: (canUndo: boolean) => void, options: UndoServiceOptions = {}) {
    this.onChanged = onChanged;
    this.maxActions = normalizeMaxActions(options.maxActions);
  }

  public push(action: UndoAction): void {
    this.stack.push(action);
    const discarded = this.trimToLimit();
    for (const oldAction of discarded) this.scheduleCleanup(oldAction, "discarded");
    this.onChanged(this.canUndo());
  }

  public clear(): void {
    const cleared = this.stack.splice(0);
    for (const action of cleared) this.scheduleCleanup(action, "cleared");
    this.onChanged(false);
  }

  public canUndo(): boolean {
    return this.stack.length > 0;
  }

  public async undoLast(): Promise<UndoAction | null> {
    const action = this.stack.pop() ?? null;
    this.onChanged(this.stack.length > 0);
    if (!action) return null;
    await action.undo();
    await this.cleanupAction(action, "undone");
    return action;
  }

  private trimToLimit(): UndoAction[] {
    if (this.stack.length <= this.maxActions) return [];
    const removeCount = this.stack.length - this.maxActions;
    return this.stack.splice(0, removeCount);
  }

  private scheduleCleanup(action: UndoAction, reason: UndoCleanupReason): void {
    void this.cleanupAction(action, reason);
  }

  private async cleanupAction(action: UndoAction, reason: UndoCleanupReason): Promise<void> {
    if (!action.cleanup) return;
    try {
      await action.cleanup(reason);
    } catch {
      // Cleanup must not break undo availability or command flow.
    }
  }
}

function normalizeMaxActions(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_UNDO_MAX_ACTIONS;
  return Math.max(1, n);
}
