import type * as vscode from "vscode";

export interface MementoTransactionWrite {
  key: string;
  value: unknown;
}

export class MementoTransactionError extends Error {
  public readonly rollbackErrors: readonly unknown[];

  constructor(cause: unknown, rollbackErrors: readonly unknown[]) {
    super("The Memento transaction could not be committed.", { cause });
    this.name = "MementoTransactionError";
    this.rollbackErrors = rollbackErrors;
  }

  public get rollbackFailed(): boolean {
    return this.rollbackErrors.length > 0;
  }
}

export async function updateMementoTransaction(
  memento: Pick<vscode.Memento, "get" | "update">,
  writes: readonly MementoTransactionWrite[],
): Promise<void> {
  if (writes.length === 0) return;

  const previousValues = new Map<string, unknown>();
  for (const write of writes) {
    if (!previousValues.has(write.key)) previousValues.set(write.key, memento.get(write.key));
  }

  const appliedKeys: string[] = [];
  try {
    for (const write of writes) {
      await memento.update(write.key, write.value);
      appliedKeys.push(write.key);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    const restoredKeys = new Set<string>();
    for (let index = appliedKeys.length - 1; index >= 0; index -= 1) {
      const key = appliedKeys[index]!;
      if (restoredKeys.has(key)) continue;
      restoredKeys.add(key);
      try {
        await memento.update(key, previousValues.get(key));
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    throw new MementoTransactionError(error, rollbackErrors);
  }
}
