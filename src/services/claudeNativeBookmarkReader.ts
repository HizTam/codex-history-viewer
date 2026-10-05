import * as fs from "node:fs";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import { normalizeCacheKey } from "../utils/fsUtils";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_BOOKMARKS = 16_384;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type NativeBookmarkReadResult =
  | { status: "ok"; uuids: readonly string[] }
  | { status: "missing" | "unavailable" };

export function isClaudeBookmarkSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value);
}

export function readClaudeMessageUuid(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 128 &&
    !/[\u0000-\u001f\u007f]/u.test(value) ? value : undefined;
}

export function resolveClaudeNativeBookmarkDirectory(storage: { scheme: string; fsPath: string }): string | undefined {
  // Desktop VS Code can expose profile storage through vscode-userdata instead of file.
  if ((storage.scheme !== "file" && storage.scheme !== "vscode-userdata") || !path.isAbsolute(storage.fsPath)) return undefined;
  return path.join(storage.fsPath, "..", "anthropic.claude-code", "session-bookmarks");
}

// The native store is external input; this reader intentionally has no mutation API.
export class ClaudeNativeBookmarkReader {
  constructor(private readonly directory: string) {}

  public async read(sessionId: string): Promise<NativeBookmarkReadResult> {
    if (!isClaudeBookmarkSessionId(sessionId)) return { status: "unavailable" };
    const file = path.join(this.directory, `${sessionId}.json`);
    let openedFile = false;
    try {
      const directoryStat = await fs.promises.lstat(this.directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return { status: "unavailable" };
      const realDirectory = await fs.promises.realpath(this.directory);
      // Resolve linked ancestors once and anchor the read to the store's direct child.
      const realFile = path.join(realDirectory, `${sessionId}.json`);
      const before = await fs.promises.lstat(file);
      if (!before.isFile() || before.isSymbolicLink() || before.size === 0 || before.size > MAX_FILE_BYTES) {
        return { status: "unavailable" };
      }
      const handle = await fs.promises.open(realFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      openedFile = true;
      try {
        const opened = await handle.stat();
        if (!sameFile(before, opened)) return { status: "unavailable" };
        const buffer = Buffer.alloc(opened.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        const after = await handle.stat();
        const current = await fs.promises.lstat(file);
        const currentDirectory = await fs.promises.lstat(this.directory);
        if (!currentDirectory.isDirectory() || currentDirectory.isSymbolicLink() ||
          currentDirectory.dev !== directoryStat.dev || currentDirectory.ino !== directoryStat.ino ||
          normalizeCacheKey(await fs.promises.realpath(this.directory)) !== normalizeCacheKey(realDirectory) ||
          normalizeCacheKey(await fs.promises.realpath(file)) !== normalizeCacheKey(realFile)) {
          return { status: "unavailable" };
        }
        if (length !== opened.size || !sameFile(opened, after) || !sameFile(after, current)) {
          return { status: "unavailable" };
        }
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)));
        return parseNativeBookmarks(value);
      } finally {
        await handle.close();
      }
    } catch (error) {
      // A disappearance during a read is transient, not evidence of a native deletion.
      return { status: !openedFile && (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "unavailable" };
    }
  }
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return right.isFile() && !right.isSymbolicLink() && left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function parseNativeBookmarks(value: unknown): NativeBookmarkReadResult {
  if (!value || typeof value !== "object") return { status: "unavailable" };
  const data = value as Record<string, unknown>;
  if (!finiteNumber(data.updatedAt) || (data.projects !== undefined && typeof data.projects !== "string") ||
    !Array.isArray(data.bookmarks) || data.bookmarks.length > MAX_BOOKMARKS) return { status: "unavailable" };
  const uuids = new Set<string>();
  for (const entry of data.bookmarks) {
    if (!entry || typeof entry !== "object") return { status: "unavailable" };
    const uuid = readClaudeMessageUuid(entry.uuid);
    if (!uuid || !finiteNumber(entry.addedAt) || (entry.writtenAt !== undefined && !finiteNumber(entry.writtenAt))) {
      return { status: "unavailable" };
    }
    uuids.add(uuid);
  }
  return { status: "ok", uuids: [...uuids] };
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
