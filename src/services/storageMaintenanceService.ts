import * as path from "node:path";
import * as vscode from "vscode";

const TRASH_DIR_NAMES = ["undo-delete", "deleted"] as const;

const CURRENT_HISTORY_CACHE_FILE = "cache.v6.json";
const CURRENT_SEARCH_INDEX_FILE = "search-index.v2.json";
const HISTORY_CACHE_FILE_PATTERN = /^cache\.v\d+\.json$/i;
const SEARCH_INDEX_FILE_PATTERN = /^search-index\.v\d+\.json$/i;

export interface StorageStats {
  globalStorageBytes: number;
  trashFileCount: number;
  trashBytes: number;
}

export interface EmptyTrashResult {
  removedTrashFiles: number;
  removedLegacyFiles: number;
  failedPaths: string[];
}

// Collect total size and trash stats (undo-delete/deleted) under globalStorage.
export async function collectStorageStats(globalStorageUri: vscode.Uri): Promise<StorageStats> {
  const files = await listFilesRecursive(globalStorageUri);
  const rootFsPath = normalizeFsPath(globalStorageUri.fsPath);

  let globalStorageBytes = 0;
  let trashFileCount = 0;
  let trashBytes = 0;

  for (const fileUri of files) {
    const fileSize = await readFileSize(fileUri);
    if (fileSize === null) continue;
    globalStorageBytes += fileSize;

    const topSegment = resolveTopLevelSegment(rootFsPath, normalizeFsPath(fileUri.fsPath));
    if (!topSegment) continue;
    if (topSegment === "undo-delete" || topSegment === "deleted") {
      trashFileCount += 1;
      trashBytes += fileSize;
    }
  }

  return { globalStorageBytes, trashFileCount, trashBytes };
}

// Manually clean trash-equivalent data and legacy cache/index files.
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

// List legacy cache/index files that are no longer used by current versions.
export async function listLegacyFiles(globalStorageUri: vscode.Uri): Promise<vscode.Uri[]> {
  const out: vscode.Uri[] = [];
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(globalStorageUri);
  } catch {
    return out;
  }

  for (const [name, type] of entries) {
    if ((type & vscode.FileType.File) === 0) continue;
    const lowerName = name.toLowerCase();

    if (
      HISTORY_CACHE_FILE_PATTERN.test(lowerName) &&
      lowerName !== CURRENT_HISTORY_CACHE_FILE
    ) {
      out.push(vscode.Uri.joinPath(globalStorageUri, name));
      continue;
    }
    if (
      SEARCH_INDEX_FILE_PATTERN.test(lowerName) &&
      lowerName !== CURRENT_SEARCH_INDEX_FILE
    ) {
      out.push(vscode.Uri.joinPath(globalStorageUri, name));
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
