import type { Memento } from "vscode";

interface Snapshot<T> {
  readonly source: unknown;
  readonly value: T;
}

// Reuse validated indexes while observing replacements in VS Code's in-memory Memento.
export class MementoSnapshotCache<T> {
  private readonly memento: Memento;
  private readonly key: string;
  private readonly materialize: (value: unknown) => T;
  private snapshot: Snapshot<T> | null = null;
  private writing = false;
  private invalidated = false;

  constructor(memento: Memento, key: string, materialize: (value: unknown) => T) {
    this.memento = memento;
    this.key = key;
    this.materialize = materialize;
  }

  public read(): T {
    // Memento.update replaces its local value before persistence completes.
    if (this.writing && this.snapshot) return this.snapshot.value;
    const source = this.memento.get<unknown>(this.key);
    if (this.snapshot && !this.invalidated && Object.is(this.snapshot.source, source)) return this.snapshot.value;
    const value = this.materialize(source);
    this.snapshot = { source, value };
    this.invalidated = false;
    return value;
  }

  public invalidate(): void {
    this.invalidated = true;
    if (!this.writing) this.snapshot = null;
  }

  public async write(value: unknown): Promise<void> {
    // Callers serialize the complete read-modify-write operation, not just persistence.
    if (this.writing) throw new Error("Concurrent metadata snapshot writes must be serialized.");
    const previous = this.read();
    let writeSource = this.snapshot!.source;
    this.writing = true;
    try {
      const completion = this.memento.update(this.key, value);
      writeSource = this.memento.get<unknown>(this.key);
      await completion;
    } catch (error) {
      // Ignore this failed optimistic value, but accept a later external replacement.
      this.snapshot = { source: writeSource, value: previous };
      throw error;
    } finally {
      this.writing = false;
    }
    // An external update may have arrived while this write was awaiting completion.
    this.invalidate();
    this.read();
  }
}
