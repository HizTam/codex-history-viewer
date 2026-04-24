import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { CodexHistoryViewerConfig } from "../settings";
import { normalizeCacheKey, pathExists } from "../utils/fsUtils";
import type { DebugLogger } from "./logger";

interface WatchRoot {
  source: "codex" | "claude";
  root: string;
  pattern: string;
}

type PollTargetProvider = () => readonly string[];

export class AutoRefreshService implements vscode.Disposable {
  private readonly refresh: (changedFsPaths: readonly string[]) => Promise<void>;
  private readonly pollTargets?: PollTargetProvider;
  private readonly logger?: DebugLogger;
  private readonly watchers: vscode.Disposable[] = [];
  private debounceMs = 2000;
  private minIntervalMs = 5000;
  private enabled = false;
  private visible = false;
  private focused = false;
  private readonly pendingFsPaths = new Set<string>();
  private refreshInFlight = false;
  private disposed = false;
  private lastRefreshAt = 0;
  private rootSignature = "";
  private timer: NodeJS.Timeout | null = null;
  private timerDueAt = 0;
  private pollingTimer: NodeJS.Timeout | null = null;
  private readonly polledMtimeByKey = new Map<string, number>();

  constructor(
    refresh: (changedFsPaths: readonly string[]) => Promise<void>,
    pollTargets?: PollTargetProvider,
    logger?: DebugLogger,
  ) {
    this.refresh = refresh;
    this.pollTargets = pollTargets;
    this.logger = logger;
  }

  public async configure(config: CodexHistoryViewerConfig, visible: boolean, focused: boolean): Promise<void> {
    if (this.disposed) return;

    this.visible = visible;
    this.focused = focused;
    this.debounceMs = config.autoRefresh.debounceMs;
    this.minIntervalMs = config.autoRefresh.minIntervalMs;

    if (!config.autoRefresh.enabled) {
      this.enabled = false;
      this.pendingFsPaths.clear();
      this.rootSignature = "";
      this.clearTimer();
      this.clearPollingTimer();
      this.polledMtimeByKey.clear();
      this.disposeWatchers();
      this.logger?.debug("autoRefresh disabled");
      return;
    }

    const roots = await resolveWatchRoots(config);
    if (this.disposed) return;

    this.enabled = true;
    const nextSignature = buildRootSignature(roots);
    if (nextSignature !== this.rootSignature) {
      this.rootSignature = nextSignature;
      this.rebuildWatchers(roots);
    }

    if (this.pendingFsPaths.size > 0 && this.canRun()) this.schedule();
    this.ensurePolling();
  }

  public setVisible(visible: boolean): void {
    this.visible = visible;
    if (!this.enabled) return;

    if (!this.canRun()) {
      this.clearTimer();
      this.clearPollingTimer();
      return;
    }

    if (this.pendingFsPaths.size > 0) this.schedule();
    this.pollOpenTargets();
  }

  public setFocused(focused: boolean): void {
    this.focused = focused;
    if (!this.enabled) return;

    if (!this.canRun()) {
      this.clearTimer();
      this.clearPollingTimer();
      return;
    }

    if (this.pendingFsPaths.size > 0) this.schedule();
    this.pollOpenTargets();
  }

  public dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.clearPollingTimer();
    this.disposeWatchers();
  }

  private rebuildWatchers(roots: readonly WatchRoot[]): void {
    this.clearTimer();
    this.disposeWatchers();

    for (const root of roots) {
      const pattern = new vscode.RelativePattern(vscode.Uri.file(root.root), root.pattern);
      const watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);
      watcher.onDidCreate((uri) => this.onFileEvent("create", uri));
      watcher.onDidChange((uri) => this.onFileEvent("change", uri));
      watcher.onDidDelete((uri) => this.onFileEvent("delete", uri));
      this.watchers.push(watcher);
      this.logger?.debug(`autoRefresh watch source=${root.source} pattern=${root.pattern}`);
    }

    if (roots.length === 0) {
      this.logger?.debug("autoRefresh enabled with no existing watch roots");
    }
  }

  private disposeWatchers(): void {
    while (this.watchers.length > 0) {
      this.watchers.pop()?.dispose();
    }
  }

  private onFileEvent(kind: "create" | "change" | "delete", uri: vscode.Uri): void {
    if (this.disposed || !this.enabled) return;
    if (!isJsonlFileUri(uri)) return;

    this.pendingFsPaths.add(uri.fsPath);
    this.logger?.debug(`autoRefresh event kind=${kind} file=${path.basename(uri.fsPath)}`);

    if (!this.canRun()) {
      this.clearTimer();
      this.logger?.debug(this.visible ? "autoRefresh deferred while window is inactive" : "autoRefresh deferred while all consumers are hidden");
      return;
    }

    this.schedule();
  }

  private schedule(): void {
    if (this.disposed || !this.canRun() || this.pendingFsPaths.size === 0) return;
    if (this.refreshInFlight) return;

    const now = Date.now();
    const dueAt = Math.max(now + this.debounceMs, this.lastRefreshAt + this.minIntervalMs);
    this.scheduleAt(dueAt);
  }

  private scheduleAt(dueAt: number): void {
    if (this.disposed || !this.canRun() || this.pendingFsPaths.size === 0) return;
    if (this.timer && Math.abs(this.timerDueAt - dueAt) < 10) return;

    this.clearTimer();
    const delayMs = Math.max(0, Math.ceil(dueAt - Date.now()));
    this.timerDueAt = Date.now() + delayMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerDueAt = 0;
      void this.runRefresh();
    }, delayMs);
  }

  private async runRefresh(): Promise<void> {
    if (this.disposed || !this.canRun() || this.pendingFsPaths.size === 0) return;

    if (this.refreshInFlight) {
      this.schedule();
      return;
    }

    const quietDelayMs = this.getPendingQuietDelayMs();
    if (quietDelayMs > 0) {
      this.scheduleAt(Date.now() + quietDelayMs);
      return;
    }

    const changedFsPaths = Array.from(this.pendingFsPaths);
    this.pendingFsPaths.clear();
    this.refreshInFlight = true;
    try {
      await this.refresh(changedFsPaths);
      this.lastRefreshAt = Date.now();
      this.logger?.debug("autoRefresh refreshed history");
    } catch (error) {
      for (const fsPath of changedFsPaths) {
        this.pendingFsPaths.add(fsPath);
      }
      this.logger?.debug(`autoRefresh failed: ${formatError(error)}`);
    } finally {
      this.refreshInFlight = false;
    }

    if (this.pendingFsPaths.size > 0) this.schedule();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.timerDueAt = 0;
  }

  private ensurePolling(): void {
    if (this.pollingTimer || this.disposed || !this.canRun() || !this.pollTargets) return;
    this.schedulePolling(this.getPollingIntervalMs());
  }

  private schedulePolling(delayMs: number): void {
    if (this.pollingTimer || this.disposed || !this.canRun() || !this.pollTargets) return;
    this.pollingTimer = setTimeout(() => {
      this.pollingTimer = null;
      this.pollOpenTargets();
    }, Math.max(0, Math.ceil(delayMs)));
  }

  private clearPollingTimer(): void {
    if (!this.pollingTimer) return;
    clearTimeout(this.pollingTimer);
    this.pollingTimer = null;
  }

  private canRun(): boolean {
    return this.enabled && this.visible && this.focused;
  }

  private pollOpenTargets(): void {
    if (this.disposed || !this.canRun() || !this.pollTargets) return;

    const targets = this.pollTargets()
      .map((fsPath) => (typeof fsPath === "string" ? fsPath.trim() : ""))
      .filter((fsPath) => fsPath && path.extname(fsPath).toLowerCase() === ".jsonl");
    const targetKeys = new Set<string>();

    for (const fsPath of targets) {
      const key = normalizeCacheKey(fsPath);
      targetKeys.add(key);
      const previousMtimeMs = this.polledMtimeByKey.get(key);

      try {
        const stat = fs.statSync(fsPath);
        if (!stat.isFile()) continue;
        const nextMtimeMs = stat.mtimeMs;
        this.polledMtimeByKey.set(key, nextMtimeMs);
        if (previousMtimeMs !== undefined && nextMtimeMs > previousMtimeMs + 1) {
          this.pendingFsPaths.add(fsPath);
          this.logger?.debug(`autoRefresh poll change file=${path.basename(fsPath)}`);
          this.schedule();
        }
      } catch {
        if (previousMtimeMs !== undefined) {
          this.polledMtimeByKey.delete(key);
          this.pendingFsPaths.add(fsPath);
          this.logger?.debug(`autoRefresh poll missing file=${path.basename(fsPath)}`);
          this.schedule();
        }
      }
    }

    for (const key of Array.from(this.polledMtimeByKey.keys())) {
      if (!targetKeys.has(key)) this.polledMtimeByKey.delete(key);
    }

    if (targets.length > 0) this.schedulePolling(this.getPollingIntervalMs());
  }

  private getPollingIntervalMs(): number {
    return Math.max(500, Math.min(2_000, Math.floor(this.debounceMs / 2)));
  }

  private getPendingQuietDelayMs(): number {
    const now = Date.now();
    let latestMtimeMs = 0;
    for (const fsPath of this.pendingFsPaths) {
      try {
        const stat = fs.statSync(fsPath);
        if (stat.isFile()) latestMtimeMs = Math.max(latestMtimeMs, stat.mtimeMs);
      } catch {
        // Deleted or inaccessible files should not block refresh.
      }
    }

    if (latestMtimeMs <= 0) return 0;
    const quietUntil = latestMtimeMs + this.debounceMs;
    return quietUntil > now ? Math.ceil(quietUntil - now) : 0;
  }
}

async function resolveWatchRoots(config: CodexHistoryViewerConfig): Promise<WatchRoot[]> {
  const candidates: WatchRoot[] = [];
  if (config.enableCodexSource) {
    candidates.push({ source: "codex", root: config.sessionsRoot, pattern: "**/rollout-*.jsonl" });
  }
  if (config.enableClaudeSource) {
    candidates.push({ source: "claude", root: config.claudeSessionsRoot, pattern: "*/*.jsonl" });
  }

  const out: WatchRoot[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const root = String(candidate.root ?? "").trim();
    if (!root || !(await pathExists(root))) continue;
    const key = `${candidate.source}:${normalizeCacheKey(root)}:${candidate.pattern}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...candidate, root });
  }
  return out;
}

function buildRootSignature(roots: readonly WatchRoot[]): string {
  return roots
    .map((root) => `${root.source}:${normalizeCacheKey(root.root)}:${root.pattern}`)
    .sort()
    .join("|");
}

function isJsonlFileUri(uri: vscode.Uri): boolean {
  return uri.scheme === "file" && path.extname(uri.fsPath).toLowerCase() === ".jsonl";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
