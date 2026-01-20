import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import { pathExists } from "../utils/fsUtils";

// Recursively collects rollout-*.jsonl under ~/.codex/sessions.
export async function findSessionFiles(sessionsRoot: string): Promise<string[]> {
  if (!(await pathExists(sessionsRoot))) return [];

  const results: string[] = [];
  const stack: string[] = [sessionsRoot];

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
      if (!ent.name.startsWith("rollout-")) continue;
      if (!ent.name.endsWith(".jsonl")) continue;
      results.push(full);
    }
  }

  return results;
}
