import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import type { SessionArchiveState, SessionRootKind, SessionSource } from "./sessionTypes";
import type { PerformanceProbe } from "../performance/performanceCounters";

export interface SessionDiscoveryOptions {
  codexRoot: string;
  codexArchivedRoot: string;
  claudeRoot: string;
  includeCodex: boolean;
  includeCodexArchived: boolean;
  includeClaude: boolean;
  performanceProbe?: PerformanceProbe;
}

export interface DiscoveredSessionFile {
  fsPath: string;
  source: SessionSource;
  rootKind: SessionRootKind;
  archiveState: SessionArchiveState;
  rootPath: string;
}

export interface SessionDiscoveryResult {
  readonly files: DiscoveredSessionFile[];
  readonly failureCount: number;
}

interface SessionFileCollection {
  readonly files: string[];
  readonly failureCount: number;
}

// Collect session files from enabled roots.
export async function findSessionFiles(options: SessionDiscoveryOptions): Promise<DiscoveredSessionFile[]> {
  return (await discoverSessionFiles(options)).files;
}

// Preserve failed discovery scopes so callers do not publish an incomplete inventory.
export async function discoverSessionFiles(options: SessionDiscoveryOptions): Promise<SessionDiscoveryResult> {
  const results: DiscoveredSessionFile[] = [];
  const seen = new Set<string>();
  let failureCount = 0;

  const pushUnique = (file: DiscoveredSessionFile): void => {
    const key = path.normalize(file.fsPath).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    results.push(file);
  };

  if (options.includeCodex) {
    const collected = await collectExistingRoot(
      options.codexRoot,
      collectCodexSessionFiles,
      options.performanceProbe,
    );
    failureCount += collected.failureCount;
    for (const fsPath of collected.files) {
      pushUnique({
        fsPath,
        source: "codex",
        rootKind: "codexSessions",
        archiveState: "active",
        rootPath: options.codexRoot,
      });
    }
  }

  if (options.includeCodexArchived) {
    const collected = await collectExistingRoot(
      options.codexArchivedRoot,
      collectCodexSessionFiles,
      options.performanceProbe,
    );
    failureCount += collected.failureCount;
    for (const fsPath of collected.files) {
      pushUnique({
        fsPath,
        source: "codex",
        rootKind: "codexArchivedSessions",
        archiveState: "archived",
        rootPath: options.codexArchivedRoot,
      });
    }
  }

  if (options.includeClaude) {
    const collected = await collectExistingRoot(
      options.claudeRoot,
      collectClaudeSessionFiles,
      options.performanceProbe,
    );
    failureCount += collected.failureCount;
    for (const fsPath of collected.files) {
      pushUnique({
        fsPath,
        source: "claude",
        rootKind: "claudeSessions",
        archiveState: "active",
        rootPath: options.claudeRoot,
      });
    }
  }

  return { files: results, failureCount };
}

async function collectExistingRoot(
  rootPath: string,
  collector: (rootPath: string, performanceProbe?: PerformanceProbe) => Promise<SessionFileCollection>,
  performanceProbe?: PerformanceProbe,
): Promise<SessionFileCollection> {
  try {
    await fs.stat(rootPath);
  } catch (error) {
    if (isNotFoundError(error)) return { files: [], failureCount: 0 };
    observeDiscoveryFailure(performanceProbe);
    return { files: [], failureCount: 1 };
  }
  return collector(rootPath, performanceProbe);
}

async function collectCodexSessionFiles(
  codexRoot: string,
  performanceProbe?: PerformanceProbe,
): Promise<SessionFileCollection> {
  const results: string[] = [];
  const stack: string[] = [codexRoot];
  let failureCount = 0;

  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;

    let entries: Dirent[];
    try {
      performanceProbe?.add("discoveryDirectoryCount");
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      failureCount += 1;
      observeDiscoveryFailure(performanceProbe);
      continue;
    }

    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      if (!ent.name.startsWith("rollout-") || !ent.name.endsWith(".jsonl")) continue;
      results.push(full);
    }
  }

  return { files: results, failureCount };
}

async function collectClaudeSessionFiles(
  claudeRoot: string,
  performanceProbe?: PerformanceProbe,
): Promise<SessionFileCollection> {
  const results: string[] = [];
  const stack: string[] = [claudeRoot];
  let failureCount = 0;

  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;

    let entries: Dirent[];
    try {
      performanceProbe?.add("discoveryDirectoryCount");
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      failureCount += 1;
      observeDiscoveryFailure(performanceProbe);
      continue;
    }

    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      if (!ent.name.endsWith(".jsonl")) continue;

      // Only include primary session files under `.claude/projects/<project>/<session>.jsonl`.
      const relParts = path.relative(claudeRoot, full).split(path.sep).filter((part) => part.length > 0);
      if (relParts.length !== 2) continue;
      results.push(full);
    }
  }

  return { files: results, failureCount };
}

function observeDiscoveryFailure(performanceProbe?: PerformanceProbe): void {
  performanceProbe?.add("discoveryFailureScopeCount");
  performanceProbe?.setOutcome("partial");
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "FileNotFound";
}
