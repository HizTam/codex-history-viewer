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

export class AutoRefreshService implements vscode.Disposable {
  private readonly refresh: () => Promise<void>;
  private readonly logger?: DebugLogger;
  private readonly watchers: vscode.Disposable[] = [];
  private debounceMs = 2000;
  private minIntervalMs = 5000;
  private enabled = false;
  private visible = false;
  private focused = false;
  private pending = false;
  private refreshInFlight = false;
  private disposed = false;
  private lastRefreshAt = 0;
  private rootSignature = "";
  private timer: NodeJS.Timeout | null = null;

  constructor(refresh: () => Promise<void>, logger?: DebugLogger) {
    this.refresh = refresh;
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
      this.pending = false;
      this.rootSignature = "";
      this.clearTimer();
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

    if (this.pending && this.canRun()) this.schedule();
  }

  public setVisible(visible: boolean): void {
    this.visible = visible;
    if (!this.enabled) return;

    if (!this.canRun()) {
      this.clearTimer();
      return;
    }

    if (this.pending) this.schedule();
  }

  public setFocused(focused: boolean): void {
    this.focused = focused;
    if (!this.enabled) return;

    if (!this.canRun()) {
      this.clearTimer();
      return;
    }

    if (this.pending) this.schedule();
  }

  public dispose(): void {
    this.disposed = true;
    this.clearTimer();
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

    this.pending = true;
    this.logger?.debug(`autoRefresh event kind=${kind}`);

    if (!this.canRun()) {
      this.clearTimer();
      this.logger?.debug(
        this.visible ? "autoRefresh deferred while window is inactive" : "autoRefresh deferred while history view is hidden",
      );
      return;
    }

    this.schedule();
  }

  private schedule(): void {
    if (this.disposed || !this.canRun() || !this.pending) return;

    this.clearTimer();
    const now = Date.now();
    const dueAt = Math.max(now + this.debounceMs, this.lastRefreshAt + this.minIntervalMs);
    const delayMs = Math.max(0, dueAt - now);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runRefresh();
    }, delayMs);
  }

  private async runRefresh(): Promise<void> {
    if (this.disposed || !this.canRun() || !this.pending) return;

    if (this.refreshInFlight) {
      this.schedule();
      return;
    }

    this.pending = false;
    this.refreshInFlight = true;
    try {
      await this.refresh();
      this.lastRefreshAt = Date.now();
      this.logger?.debug("autoRefresh refreshed history");
    } catch (error) {
      this.logger?.debug(`autoRefresh failed: ${formatError(error)}`);
    } finally {
      this.refreshInFlight = false;
    }

    if (this.pending) this.schedule();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private canRun(): boolean {
    return this.enabled && this.visible && this.focused;
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
