import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import type { SessionArchiveState, SessionRootKind, SessionSource } from "./sessionTypes";
import { pathExists } from "../utils/fsUtils";

export interface SessionDiscoveryOptions {
  codexRoot: string;
  codexArchivedRoot: string;
  claudeRoot: string;
  includeCodex: boolean;
  includeCodexArchived: boolean;
  includeClaude: boolean;
}

export interface DiscoveredSessionFile {
  fsPath: string;
  source: SessionSource;
  rootKind: SessionRootKind;
  archiveState: SessionArchiveState;
  rootPath: string;
}

// Collect session files from enabled roots.
export async function findSessionFiles(options: SessionDiscoveryOptions): Promise<DiscoveredSessionFile[]> {
  const results: DiscoveredSessionFile[] = [];
  const seen = new Set<string>();

  const pushUnique = (file: DiscoveredSessionFile): void => {
    const key = path.normalize(file.fsPath).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    results.push(file);
  };

  if (options.includeCodex && (await pathExists(options.codexRoot))) {
    const codexFiles = await collectCodexSessionFiles(options.codexRoot);
    for (const fsPath of codexFiles) {
      pushUnique({
        fsPath,
        source: "codex",
        rootKind: "codexSessions",
        archiveState: "active",
        rootPath: options.codexRoot,
      });
    }
  }

  if (options.includeCodexArchived && (await pathExists(options.codexArchivedRoot))) {
    const codexFiles = await collectCodexSessionFiles(options.codexArchivedRoot);
    for (const fsPath of codexFiles) {
      pushUnique({
        fsPath,
        source: "codex",
        rootKind: "codexArchivedSessions",
        archiveState: "archived",
        rootPath: options.codexArchivedRoot,
      });
    }
  }

  if (options.includeClaude && (await pathExists(options.claudeRoot))) {
    const claudeFiles = await collectClaudeSessionFiles(options.claudeRoot);
    for (const fsPath of claudeFiles) {
      pushUnique({
        fsPath,
        source: "claude",
        rootKind: "claudeSessions",
        archiveState: "active",
        rootPath: options.claudeRoot,
      });
    }
  }

  return results;
}

async function collectCodexSessionFiles(codexRoot: string): Promise<string[]> {
  const results: string[] = [];
  const stack: string[] = [codexRoot];

  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;

    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
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

  return results;
}

async function collectClaudeSessionFiles(claudeRoot: string): Promise<string[]> {
  const results: string[] = [];
  const stack: string[] = [claudeRoot];

  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;

    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
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

  return results;
}
