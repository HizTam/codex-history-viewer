import * as vscode from "vscode";
import { onWillClearHandoffs, protectHandoffDirectory, type HandoffTarget } from "../services/handoffService";

const MAX_HANDOFF_OPERATIONS = 4;

export class AntigravityHandoffCapacityError extends Error {
  constructor() { super("Handoff operation capacity reached."); }
}

type Stage = "selecting" | "reading" | "published" | "preparingTarget" | "dispatched" | "ended";
export class AntigravityHandoffInterrupted extends Error {
  constructor(public readonly reason: "stale" | "cancelled" | "timeout") { super(`Handoff operation: ${reason}`); }
}

// Additional native handoff directions share one bounded lifecycle without changing legacy dispatch.
export class AntigravityHandoffOperation {
  private stage: Stage = "selecting";
  private ended = false;
  private interruption?: AntigravityHandoffInterrupted;
  private readonly cancellation = new vscode.CancellationTokenSource();
  private readonly abortListeners = new Set<(error: AntigravityHandoffInterrupted) => void>();
  private readonly timer: ReturnType<typeof setInterval>;
  private protection?: ReturnType<typeof protectHandoffDirectory>;
  private dispatchStarted = false;
  private dispatchSettled = false;
  private pendingIo = 0;

  constructor(private readonly valid: () => boolean, private readonly physicalOwners = new Set<AntigravityHandoffOperation>()) {
    this.timer = setInterval(() => { try { this.assertCurrent(); } catch { this.cancel("stale"); } }, 250);
    this.timer.unref();
  }
  public get token(): vscode.CancellationToken { return this.cancellation.token; }
  public assertCurrent(): void {
    if (this.interruption) throw this.interruption;
    if (this.ended) throw new AntigravityHandoffInterrupted("cancelled");
    let valid = false; try { valid = this.valid(); } catch { valid = false; }
    if (!valid) { this.cancel("stale"); throw this.interruption!; }
  }
  public cancel(reason: "stale" | "cancelled" | "timeout" = "cancelled"): void {
    if (this.ended || this.interruption) return;
    this.interruption = new AntigravityHandoffInterrupted(reason); this.cancellation.cancel();
    for (const listener of this.abortListeners) listener(this.interruption);
    this.abortListeners.clear();
  }
  public setStage(stage: Exclude<Stage, "ended">): void { this.assertCurrent(); this.stage = stage; }
  public protect(directory: string): void {
    this.assertCurrent();
    if (this.stage === "selecting") throw new Error("Selection waits cannot retain handoff protection.");
    this.protection?.dispose(); this.protection = protectHandoffDirectory(directory);
  }
  public releaseForSelection(): void {
    this.assertCurrent(); this.protection?.dispose(); this.protection = undefined; this.stage = "selecting";
  }
  public async wait<T>(start: () => PromiseLike<T>, timeoutMs?: number): Promise<T> {
    this.assertCurrent();
    const tracked = timeoutMs !== undefined;
    if (tracked) {
      // A timed-out operation still owns its slot until all of its IO has settled.
      if (this.pendingIo === 0 && this.physicalOwners.size >= MAX_HANDOFF_OPERATIONS) throw new AntigravityHandoffCapacityError();
      this.pendingIo++;
      this.physicalOwners.add(this);
    }
    const pending = Promise.resolve().then(() => { this.assertCurrent(); return start(); });
    const result = tracked ? pending.finally(() => {
      if (--this.pendingIo === 0) this.physicalOwners.delete(this);
    }) : pending;
    let timeout: ReturnType<typeof setTimeout> | undefined, listener: ((error: AntigravityHandoffInterrupted) => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      listener = reject; this.abortListeners.add(listener);
      if (timeoutMs !== undefined) timeout = setTimeout(() => this.cancel("timeout"), Math.max(1, Math.min(30000, timeoutMs)));
    });
    try {
      const value = await Promise.race([result, interrupted]); this.assertCurrent(); return value;
    } finally { clearTimeout(timeout); if (listener) this.abortListeners.delete(listener); }
  }
  public async dispatch<T>(operation: () => PromiseLike<T>): Promise<T> {
    this.assertCurrent(); this.stage = "dispatched";
    return this.wait(async () => {
      this.dispatchStarted = true;
      try { return await operation(); }
      finally { this.dispatchSettled = true; }
    }, 30000);
  }
  public finish(): void {
    if (this.ended) return;
    this.cancel();
    this.ended = true; this.stage = "ended"; clearInterval(this.timer);
    if (this.dispatchStarted && !this.dispatchSettled) this.protection?.retainFor(120000);
    this.protection?.dispose(); this.protection = undefined;
    this.cancellation.cancel(); this.cancellation.dispose(); this.abortListeners.clear();
  }
}

interface RunningHandoff { target: HandoffTarget | null; kind: string; operation: AntigravityHandoffOperation; promise: Promise<boolean> }
export class AntigravityHandoffCoordinator implements vscode.Disposable {
  private readonly running = new Map<string, RunningHandoff>();
  private readonly physicalOwners = new Set<AntigravityHandoffOperation>();
  private disposed = false;
  private readonly clearSubscription = onWillClearHandoffs(() => this.cancelAll());

  public run(identity: string, target: HandoffTarget | null, kind: string, valid: () => boolean, perform: (operation: AntigravityHandoffOperation) => Promise<boolean>): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    const previous = this.running.get(identity);
    if (previous?.target === target && previous.kind === kind) return previous.promise;
    if (!previous && this.running.size >= MAX_HANDOFF_OPERATIONS) return Promise.reject(new AntigravityHandoffCapacityError());
    previous?.operation.cancel("stale");
    const operation = new AntigravityHandoffOperation(() => !this.disposed && valid(), this.physicalOwners);
    const entry: RunningHandoff = { target, kind, operation, promise: Promise.resolve(false) };
    entry.promise = Promise.resolve().then(() => { operation.assertCurrent(); return perform(operation); }).finally(() => {
      operation.finish(); if (this.running.get(identity) === entry) this.running.delete(identity);
    });
    this.running.set(identity, entry); return entry.promise;
  }
  public cancelAll(): void { for (const entry of this.running.values()) entry.operation.cancel(); }
  public dispose(): void { if (this.disposed) return; this.disposed = true; this.cancelAll(); this.clearSubscription.dispose(); }
}
