import * as fs from "node:fs/promises";
import * as path from "node:path";
import { antigravityReader } from "./antigravityReader";
import { ANTIGRAVITY_MAX_SESSIONS, ANTIGRAVITY_UUID } from "./antigravityTypes";
import type { AntigravitySummaryRecord } from "./antigravityTypes";
import type { DiscoveredSessionFile } from "../sessions/sessionDiscovery";
import { isRecord } from "../storage/sqliteRuntime";

export interface AntigravityDiscoveryResult {
  readonly files: DiscoveredSessionFile[];
  readonly failureCount: number;
  readonly allowedRoots: readonly string[];
  readonly cloudOnlyCount: number;
}

// Only the two fixed native locations are inspected; source records cannot add roots.
export async function discoverAntigravitySessions(roots: readonly string[], enabled: boolean): Promise<AntigravityDiscoveryResult> {
  const allowedRoots = await antigravityReader.readyFor(roots, enabled);
  if (!enabled) return { files: [], failureCount: 0, allowedRoots, cloudOnlyCount: 0 };
  let failureCount = antigravityReader.getConfigurationFailureCount(), cloudOnlyCount = 0;
  const files: DiscoveredSessionFile[] = [];
  const summaries = new Map<string, ReadonlyMap<string, AntigravitySummaryRecord>>();
  for (const root of allowedRoots) {
    const directory = path.join(root, "conversations");
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) { failureCount++; continue; }
      const entries = await fs.opendir(directory);
      for await (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".db") || !ANTIGRAVITY_UUID.test(entry.name.slice(0, -3))) continue;
        if (files.length >= ANTIGRAVITY_MAX_SESSIONS) { failureCount++; break; }
        files.push({ fsPath: path.join(directory, entry.name), source: "antigravity", rootKind: "antigravitySessions", archiveState: "active", rootPath: root });
      }
    } catch (error) { if (!isRecord(error) || error.code !== "ENOENT") failureCount++; }
    try {
      await fs.lstat(path.join(root, "conversation_summaries.db"));
      const result = await antigravityReader.readSummaries(root);
      if (result.partial) failureCount++;
      summaries.set(root, new Map(result.summaries.map(summary => [summary.conversationId, summary])));
    } catch (error) { if (!isRecord(error) || error.code !== "ENOENT") failureCount++; }
  }
  const filesById = new Map<string, DiscoveredSessionFile[]>();
  for (const file of files) {
    const id = path.basename(file.fsPath, ".db"), values = filesById.get(id) ?? [];
    values.push(file); filesById.set(id, values);
  }
  const assigned = new Map<string, AntigravitySummaryRecord[]>();
  for (const [root, records] of summaries) for (const [id, summary] of records) {
    const candidates = filesById.get(id) ?? [];
    const local = candidates.find(file => file.rootPath === root);
    const target = local ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!target) { cloudOnlyCount++; continue; }
    if (local) target.antigravitySummary = summary;
    else { const values = assigned.get(target.fsPath) ?? []; values.push(summary); assigned.set(target.fsPath, values); }
  }
  for (const file of files) {
    const candidates = assigned.get(file.fsPath);
    if (!file.antigravitySummary && candidates?.length === 1) file.antigravitySummary = candidates[0];
  }
  return { files, failureCount, allowedRoots, cloudOnlyCount };
}
