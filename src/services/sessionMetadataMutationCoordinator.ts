import { AsyncLocalStorage } from "node:async_hooks";

// Serializes metadata mutations that span otherwise independent Memento stores.
export class SessionMetadataMutationCoordinator {
  private queue: Promise<void> = Promise.resolve();
  private readonly ownership = new AsyncLocalStorage<boolean>();

  public runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.ownership.getStore() === true) return operation();
    const coordinatedOperation = () => this.ownership.run(true, operation);
    const result = this.queue.then(coordinatedOperation, coordinatedOperation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
