import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import { pathExists } from "../utils/fsUtils";

export interface SessionDiscoveryOptions {
  codexRoot: string;
  claudeRoot: string;
  includeCodex: boolean;
  includeClaude: boolean;
}

// Collect session files from enabled roots.
export async function findSessionFiles(options: SessionDiscoveryOptions): Promise<string[]> {
  const results: string[] = [];
  const seen = new Set<string>();

  const pushUnique = (fsPath: string): void => {
    const key = path.normalize(fsPath).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    results.push(fsPath);
  };

  if (options.includeCodex && (await pathExists(options.codexRoot))) {
    const codexFiles = await collectCodexSessionFiles(options.codexRoot);
    for (const fsPath of codexFiles) pushUnique(fsPath);
  }

  if (options.includeClaude && (await pathExists(options.claudeRoot))) {
    const claudeFiles = await collectClaudeSessionFiles(options.claudeRoot);
    for (const fsPath of claudeFiles) pushUnique(fsPath);
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
