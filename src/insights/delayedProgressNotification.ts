export interface DelayedProgressDisposable {
  dispose(): void;
}

export interface DelayedProgressCancellationToken {
  onCancellationRequested(listener: () => void): DelayedProgressDisposable;
}

export interface DelayedProgressScheduler {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface DelayedProgressNotificationOptions {
  delayMs: number;
  isActive: () => boolean;
  onCancel: () => void;
  show: (
    task: (token: DelayedProgressCancellationToken) => Promise<void>,
  ) => PromiseLike<void>;
  scheduler?: DelayedProgressScheduler;
}

const defaultScheduler: DelayedProgressScheduler = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class DelayedProgressNotification implements DelayedProgressDisposable {
  private readonly options: DelayedProgressNotificationOptions;
  private readonly scheduler: DelayedProgressScheduler;
  private timerHandle: unknown | undefined;
  private completion: (() => void) | undefined;
  private cancellationRegistration: DelayedProgressDisposable | undefined;
  private disposed = false;

  constructor(options: DelayedProgressNotificationOptions) {
    this.options = options;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.timerHandle = this.scheduler.set(() => this.start(), options.delayMs);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timerHandle !== undefined) {
      this.scheduler.clear(this.timerHandle);
      this.timerHandle = undefined;
    }
    this.cancellationRegistration?.dispose();
    this.cancellationRegistration = undefined;
    const completion = this.completion;
    this.completion = undefined;
    completion?.();
  }

  private start(): void {
    this.timerHandle = undefined;
    if (this.disposed || !this.options.isActive()) {
      this.dispose();
      return;
    }
    let shown: PromiseLike<void>;
    try {
      shown = this.options.show(async (token) => {
        if (this.disposed || !this.options.isActive()) return;
        await new Promise<void>((resolve) => {
          this.completion = resolve;
          const registration = token.onCancellationRequested(() => {
            if (this.disposed) return;
            if (this.options.isActive()) {
              try {
                this.options.onCancel();
              } finally {
                this.dispose();
              }
            } else {
              this.dispose();
            }
          });
          if (this.disposed || !this.options.isActive()) {
            registration.dispose();
            if (this.completion === resolve) this.completion = undefined;
            resolve();
            return;
          }
          this.cancellationRegistration = registration;
        });
      });
    } catch {
      this.dispose();
      return;
    }
    // A secondary notification failure must not fail the analysis operation.
    void Promise.resolve(shown).catch(() => this.dispose());
  }
}
