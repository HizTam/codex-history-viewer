export interface UndoAction {
  label: string;
  undo: () => Promise<void>;
}

// Keeps recent undo actions in memory.
export class UndoService {
  private readonly stack: UndoAction[] = [];
  private readonly onChanged: (canUndo: boolean) => void;

  constructor(onChanged: (canUndo: boolean) => void) {
    this.onChanged = onChanged;
  }

  public push(action: UndoAction): void {
    this.stack.push(action);
    this.onChanged(true);
  }

  public clear(): void {
    this.stack.length = 0;
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
    return action;
  }
}
