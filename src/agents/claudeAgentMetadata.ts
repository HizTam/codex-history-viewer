import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ClaudeAgentMetadata, SessionSummary } from "../sessions/sessionTypes";
import { boundSessionIdentityKey } from "../sessions/sessionIdentity";

const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const MAX_METADATA_BYTES = 65_536;
const UNSAFE_PART = /[\u0000-\u001f\u007f-\u009f/\\:]/u;

export interface ClaudeAgentPath {
  rootPath: string;
  project: string;
  ownerSessionId: string;
  relativePath: string;
  agentId: string;
}

export function isClaudePathPart(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value !== "." && value !== ".." && !UNSAFE_PART.test(value) && !/[. ]$/u.test(value);
}

// Recover a relocated root only when the complete portable layout matches the physical path.
export function resolveClaudeRootFromRelativePath(fsPath: string, relativePath: string): string | undefined {
  if (!path.isAbsolute(fsPath) || typeof relativePath !== "string" || relativePath.length > 4_096) return undefined;
  const parts = relativePath.replace(/\\/gu, "/").split("/");
  if (parts.length > 36 || !parts.every(isClaudePathPart)) return undefined;
  let root = fsPath;
  for (const _part of parts) root = path.dirname(root);
  return path.relative(path.join(root, ...parts), fsPath) === "" ? root : undefined;
}

export function parseClaudeAgentPath(fsPath: string, rootPath?: string): ClaudeAgentPath | undefined {
  if (!path.isAbsolute(fsPath)) return undefined;
  let root = rootPath;
  if (!root) {
    const parts = path.normalize(fsPath).split(path.sep);
    const marker = parts.indexOf("subagents");
    // Without a verified root, repeated markers cannot identify the owner safely.
    if (marker < 3 || marker !== parts.lastIndexOf("subagents")) return undefined;
    root = parts.slice(0, marker - 2).join(path.sep) || path.parse(fsPath).root;
  }
  if (!path.isAbsolute(root)) return undefined;
  const relative = path.relative(root, fsPath);
  const parts = relative.split(path.sep);
  if (path.isAbsolute(relative) || parts.length < 4 || parts.length > 36 || parts[2] !== "subagents" || !parts.every(isClaudePathPart)) return undefined;
  const match = /^agent-([A-Za-z0-9_-]{1,128})\.jsonl$/u.exec(parts.at(-1)!);
  if (!match) return undefined;
  return { rootPath: root, project: parts[0]!, ownerSessionId: parts[1]!, relativePath: parts.slice(3).join("/"), agentId: match[1]! };
}

export function hasClaudeAgentPathShape(fsPath: string, rootPath?: string): boolean {
  if (!path.isAbsolute(fsPath) || !/^agent-[A-Za-z0-9_-]{1,128}\.jsonl$/u.test(path.basename(fsPath))) return false;
  if (rootPath && path.isAbsolute(rootPath)) {
    const relative = path.relative(rootPath, fsPath);
    const parts = relative.split(path.sep);
    if (!path.isAbsolute(relative) && parts.every(isClaudePathPart)) return parts[2] === "subagents";
  }
  return path.normalize(fsPath).split(path.sep).includes("subagents");
}

// Check each component as well as the final real path; junctions are not transcript authority.
export async function isSafeClaudeFile(fsPath: string, root: string): Promise<boolean> {
  try {
    const relative = path.relative(root, fsPath);
    const parts = relative.split(path.sep);
    if (path.isAbsolute(relative) || !parts.every(isClaudePathPart)) return false;
    const realRoot = await fs.realpath(root);
    let current = root;
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) return false;
    }
    const realRelative = path.relative(realRoot, await fs.realpath(fsPath));
    return !path.isAbsolute(realRelative) && realRelative.split(path.sep).every(isClaudePathPart);
  } catch {
    return false;
  }
}

export async function readClaudeAgentMetadata(fsPath: string, rootPath: string): Promise<ClaudeAgentMetadata | undefined> {
  const location = parseClaudeAgentPath(fsPath, rootPath);
  if (!location || !await isSafeClaudeFile(fsPath, rootPath)) return undefined;
  const { rootPath: _root, ...identity } = location;
  const sidecar = fsPath.replace(/\.jsonl$/u, ".meta.json");
  let metadataStamp = "missing";
  try {
    const stat = await fs.lstat(sidecar);
    metadataStamp = `${stat.mtimeMs}:${stat.size}`;
    if (!stat.isFile() || stat.size > MAX_METADATA_BYTES || !await isSafeClaudeFile(sidecar, rootPath)) {
      return { ...identity, metadataState: "invalid", metadataStamp };
    }
    const handle = await fs.open(sidecar, "r");
    let value: unknown;
    try {
      const opened = await handle.stat();
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size || opened.mtimeMs !== stat.mtimeMs ||
        !await isSafeClaudeFile(sidecar, rootPath)) throw new Error("metadataChanged");
      const buffer = Buffer.alloc(MAX_METADATA_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_METADATA_BYTES) throw new Error("metadataLimit");
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)));
      const after = await handle.stat();
      if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error("metadataChanged");
    } finally {
      await handle.close();
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("metadataShape");
    const raw = value as Record<string, unknown>;
    const result: ClaudeAgentMetadata = { ...identity, metadataState: "valid", metadataStamp };
    for (const key of ["parentAgentId", "toolUseId", "agentType", "description", "name"] as const) {
      const field = raw[key];
      if (field === undefined) continue;
      if (typeof field !== "string" || field.length > (key === "description" ? 4_096 : 256) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(field)) throw new Error("metadataField");
      if (key === "parentAgentId" && !AGENT_ID.test(field)) throw new Error("metadataParent");
      result[key] = field.replace(/\s+/gu, " ").trim().slice(0, 256);
    }
    if (raw.isFork !== undefined) {
      if (typeof raw.isFork !== "boolean") throw new Error("metadataFork");
      result.isFork = raw.isFork;
    }
    if (raw.spawnDepth !== undefined) {
      if (!Number.isSafeInteger(raw.spawnDepth) || (raw.spawnDepth as number) < 0 || (raw.spawnDepth as number) > 1_024) throw new Error("metadataDepth");
      result.spawnDepth = raw.spawnDepth as number;
    }
    return result;
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
    return { ...identity, metadataState: missing ? "missing" : "invalid", metadataStamp };
  }
}

export function claudeAgentIdentity(metadata: ClaudeAgentPath | ClaudeAgentMetadata): string {
  return boundSessionIdentityKey("claude", `claude:agent:${JSON.stringify([metadata.project, metadata.ownerSessionId, metadata.relativePath])}`);
}

export function claudeRelationKey(project: string, owner: string, agentId?: string): string {
  return `claude:${JSON.stringify([project, owner, agentId ?? null])}`;
}

export function claudeSessionRelationKey(session: SessionSummary): string {
  const agent = session.meta.claudeAgent;
  if (agent) return claudeRelationKey(agent.project, agent.ownerSessionId, agent.agentId);
  const relative = path.relative(session.storage.rootPath, session.fsPath).split(path.sep);
  if (relative.length !== 2 || !relative.every(isClaudePathPart) || !relative[1]!.endsWith(".jsonl")) return "";
  const owner = relative[1]!.slice(0, -6);
  if (session.meta.id && session.meta.id !== owner) return "";
  return claudeRelationKey(relative[0]!, owner);
}
