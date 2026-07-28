import * as path from "node:path";
import * as vscode from "vscode";

export type CliResumePathClassification = "local" | "remote" | "invalid";

export type ScheduledProbeResult<T> =
  | { status: "completed"; value: T }
  | { status: "failed"; error: unknown }
  | { status: "timeout" }
  | { status: "cancelled" };

type ScheduledProbe<T> = {
  operation: () => Promise<T>;
  isCancelled: () => boolean;
  deadline: number;
  queueTimer: NodeJS.Timeout | null;
  settled: boolean;
  resolve: (result: ScheduledProbeResult<T>) => void;
};

const PROBE_TIMEOUT_MS = 1_000;
const MAX_CONCURRENT_PROBES = 4;
const PATH_ENTRY_MAX_LENGTH = 4_096;

export function classifyCliResumeNativePath(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
): CliResumePathClassification {
  if (typeof value !== "string" || value.length === 0 || value.length > PATH_ENTRY_MAX_LENGTH) return "invalid";
  if (/[\u0000-\u001f\u007f]/u.test(value)) return "invalid";

  if (platform === "win32") {
    const slashNormalized = value.replace(/\//g, "\\");
    if (/^(?:\\\\|\\\?\?\\)/u.test(slashNormalized)) return "remote";
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value)) return "remote";
    return path.win32.isAbsolute(value) && /^[A-Za-z]:[\\/]/u.test(value) ? "local" : "invalid";
  }

  if (value.startsWith("//") || /^\\\\|^\\\?\?\\/u.test(value)) return "remote";
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value)) return "remote";
  return path.posix.isAbsolute(value) ? "local" : "invalid";
}

// Keeps the number of unresolved filesystem operations bounded across all probes.
export class CliResumeProbeScheduler implements vscode.Disposable {
  private readonly queue: Array<ScheduledProbe<unknown>> = [];
  private activeCount = 0;
  private disposed = false;

  public schedule<T>(
    operation: () => Promise<T>,
    isCancelled: () => boolean,
    timeoutMs = PROBE_TIMEOUT_MS,
  ): Promise<ScheduledProbeResult<T>> {
    if (this.disposed || isCancelled()) return Promise.resolve({ status: "cancelled" });
    return new Promise<ScheduledProbeResult<T>>((resolve) => {
      const boundedTimeoutMs = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 0;
      const item: ScheduledProbe<T> = {
        operation,
        isCancelled,
        deadline: Date.now() + boundedTimeoutMs,
        queueTimer: null,
        settled: false,
        resolve,
      };
      // Start the deadline at enqueue time so saturated slots cannot retain queued probes indefinitely.
      item.queueTimer = setTimeout(() => this.expireQueued(item), boundedTimeoutMs);
      this.queue.push(item as ScheduledProbe<unknown>);
      this.drain();
    });
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const item of this.queue.splice(0)) this.settle(item, { status: "cancelled" });
  }

  private drain(): void {
    while (!this.disposed && this.activeCount < MAX_CONCURRENT_PROBES && this.queue.length > 0) {
      const item = this.queue.shift()!;
      if (item.settled) continue;
      if (item.isCancelled()) {
        this.settle(item, { status: "cancelled" });
        continue;
      }
      if (Date.now() >= item.deadline) {
        this.settle(item, { status: "timeout" });
        continue;
      }
      this.start(item);
    }
  }

  private start<T>(item: ScheduledProbe<T>): void {
    if (item.queueTimer) {
      clearTimeout(item.queueTimer);
      item.queueTimer = null;
    }
    this.activeCount += 1;
    const timer = setTimeout(
      () => this.settle(item, { status: "timeout" }),
      Math.max(0, item.deadline - Date.now()),
    );

    let operationPromise: Promise<T>;
    try {
      operationPromise = item.operation();
    } catch (error) {
      operationPromise = Promise.reject(error);
    }
    void operationPromise.then(
      (value) => this.settle(
        item,
        item.isCancelled()
          ? { status: "cancelled" }
          : Date.now() >= item.deadline
            ? { status: "timeout" }
            : { status: "completed", value },
      ),
      (error) => this.settle(
        item,
        item.isCancelled()
          ? { status: "cancelled" }
          : Date.now() >= item.deadline
            ? { status: "timeout" }
            : { status: "failed", error },
      ),
    ).finally(() => {
      clearTimeout(timer);
      this.activeCount = Math.max(0, this.activeCount - 1);
      this.drain();
    });
  }

  private expireQueued<T>(item: ScheduledProbe<T>): void {
    if (item.settled) return;
    const index = this.queue.indexOf(item as ScheduledProbe<unknown>);
    if (index < 0) return;
    this.queue.splice(index, 1);
    this.settle(item, { status: "timeout" });
    this.drain();
  }

  private settle<T>(item: ScheduledProbe<T>, result: ScheduledProbeResult<T>): void {
    if (item.settled) return;
    item.settled = true;
    if (item.queueTimer) {
      clearTimeout(item.queueTimer);
      item.queueTimer = null;
    }
    item.resolve(result);
  }
}
