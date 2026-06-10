import * as path from "node:path";
import * as vscode from "vscode";
import {
  HISTORY_CACHE_FILE_NAME,
  HISTORY_CACHE_FILE_PATTERN,
  SEARCH_INDEX_FILE_NAME,
  SEARCH_INDEX_FILE_PATTERN,
} from "../storage/cacheFiles";

const TRASH_DIR_NAMES = ["undo-delete", "deleted"] as const;
const ORPHANED_TEMP_JSON_MIN_AGE_MS = 60 * 60 * 1000;
const TEMP_JSON_FILE_PATTERN = /^.+\.tmp-[a-z0-9]+-[a-z0-9]*\.json$/i;

export interface StorageStats {
  globalStorageBytes: number;
  trashFileCount: number;
  trashBytes: number;
  handoffCount: number;
  handoffBytes: number;
}

export interface EmptyTrashResult {
  removedTrashFiles: number;
  removedLegacyFiles: number;
  failedPaths: string[];
}

// Collect total size, trash stats, and generated handoff stats under globalStorage.
export async function collectStorageStats(globalStorageUri: vscode.Uri): Promise<StorageStats> {
  const files = await listFilesRecursive(globalStorageUri);
  const rootFsPath = normalizeFsPath(globalStorageUri.fsPath);

  let globalStorageBytes = 0;
  let trashFileCount = 0;
  let trashBytes = 0;
  let handoffCount = 0;
  let handoffBytes = 0;

  for (const fileUri of files) {
    const fileSize = await readFileSize(fileUri);
    if (fileSize === null) continue;
    globalStorageBytes += fileSize;

    const topSegment = resolveTopLevelSegment(rootFsPath, normalizeFsPath(fileUri.fsPath));
    if (!topSegment) continue;
    if (topSegment === "undo-delete" || topSegment === "deleted") {
      trashFileCount += 1;
      trashBytes += fileSize;
      continue;
    }
    if (topSegment === "handoffs") {
      if (path.basename(fileUri.fsPath).toLowerCase() === "handoff.md") handoffCount += 1;
      handoffBytes += fileSize;
    }
  }

  return { globalStorageBytes, trashFileCount, trashBytes, handoffCount, handoffBytes };
}

// Manually clean trash-equivalent data, legacy cache files, and old temp files.
export async function emptyTrashAndCleanupLegacy(globalStorageUri: vscode.Uri): Promise<EmptyTrashResult> {
  const failedPaths: string[] = [];
  let removedTrashFiles = 0;

  for (const dirName of TRASH_DIR_NAMES) {
    const dirUri = vscode.Uri.joinPath(globalStorageUri, dirName);
    const removed = await clearDirectory(dirUri, failedPaths);
    removedTrashFiles += removed;
  }

  const legacyFiles = await listLegacyFiles(globalStorageUri);
  let removedLegacyFiles = 0;
  for (const legacyFile of legacyFiles) {
    try {
      await vscode.workspace.fs.delete(legacyFile, { recursive: false, useTrash: false });
      removedLegacyFiles += 1;
    } catch {
      failedPaths.push(legacyFile.fsPath);
    }
  }

  return { removedTrashFiles, removedLegacyFiles, failedPaths };
}

// List generated files that are safe to remove from global storage.
export async function listLegacyFiles(globalStorageUri: vscode.Uri): Promise<vscode.Uri[]> {
  const out: vscode.Uri[] = [];
  const currentHistoryCacheFile = HISTORY_CACHE_FILE_NAME.toLowerCase();
  const currentSearchIndexFile = SEARCH_INDEX_FILE_NAME.toLowerCase();
  const now = Date.now();
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(globalStorageUri);
  } catch {
    return out;
  }

  for (const [name, type] of entries) {
    if ((type & vscode.FileType.File) === 0) continue;
    const lowerName = name.toLowerCase();
    const fileUri = vscode.Uri.joinPath(globalStorageUri, name);

    if (
      HISTORY_CACHE_FILE_PATTERN.test(lowerName) &&
      lowerName !== currentHistoryCacheFile
    ) {
      out.push(fileUri);
      continue;
    }
    if (
      SEARCH_INDEX_FILE_PATTERN.test(lowerName) &&
      lowerName !== currentSearchIndexFile
    ) {
      out.push(fileUri);
      continue;
    }
    if (
      TEMP_JSON_FILE_PATTERN.test(lowerName) &&
      await isOlderThan(fileUri, now, ORPHANED_TEMP_JSON_MIN_AGE_MS)
    ) {
      out.push(fileUri);
    }
  }

  return out;
}

async function clearDirectory(dirUri: vscode.Uri, failedPaths: string[]): Promise<number> {
  const fileUris = await listFilesRecursive(dirUri);
  if (fileUris.length === 0) {
    await ensureDirectoryExists(dirUri, failedPaths);
    return 0;
  }

  try {
    await vscode.workspace.fs.delete(dirUri, { recursive: true, useTrash: false });
    await ensureDirectoryExists(dirUri, failedPaths);
    return fileUris.length;
  } catch {
    // Fall back to per-file deletion for environments where directory deletion fails.
  }

  let removed = 0;
  for (const fileUri of fileUris) {
    try {
      await vscode.workspace.fs.delete(fileUri, { recursive: false, useTrash: false });
      removed += 1;
    } catch {
      failedPaths.push(fileUri.fsPath);
    }
  }

  try {
    await vscode.workspace.fs.delete(dirUri, { recursive: true, useTrash: false });
  } catch {
    // Continue even if removing an empty directory fails.
  }
  await ensureDirectoryExists(dirUri, failedPaths);
  return removed;
}

async function ensureDirectoryExists(dirUri: vscode.Uri, failedPaths: string[]): Promise<void> {
  try {
    await vscode.workspace.fs.createDirectory(dirUri);
  } catch {
    failedPaths.push(dirUri.fsPath);
  }
}

async function listFilesRecursive(rootUri: vscode.Uri): Promise<vscode.Uri[]> {
  const files: vscode.Uri[] = [];
  const stack: vscode.Uri[] = [rootUri];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      continue;
    }

    for (const [name, type] of entries) {
      const child = vscode.Uri.joinPath(dir, name);
      if ((type & vscode.FileType.Directory) !== 0) {
        stack.push(child);
      }
      if ((type & vscode.FileType.File) !== 0) {
        files.push(child);
      }
    }
  }

  return files;
}

async function readFileSize(fileUri: vscode.Uri): Promise<number | null> {
  try {
    const st = await vscode.workspace.fs.stat(fileUri);
    return st.size;
  } catch {
    return null;
  }
}

async function isOlderThan(fileUri: vscode.Uri, now: number, minAgeMs: number): Promise<boolean> {
  try {
    const st = await vscode.workspace.fs.stat(fileUri);
    return Number.isFinite(st.mtime) && now - st.mtime >= minAgeMs;
  } catch {
    return false;
  }
}

function resolveTopLevelSegment(rootFsPath: string, fileFsPath: string): string | null {
  const rel = path.relative(rootFsPath, fileFsPath);
  if (!rel) return null;
  const parts = rel.split(/[\\/]+/).filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  return parts[0]!.toLowerCase();
}

function normalizeFsPath(fsPath: string): string {
  return path.normalize(String(fsPath ?? "").trim());
}
