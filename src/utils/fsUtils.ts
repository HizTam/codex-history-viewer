import * as fs from "node:fs/promises";
import * as path from "node:path";

// Small filesystem helpers.
export async function pathExists(fsPath: string): Promise<boolean> {
  try {
    await fs.access(fsPath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(fsPath: string): Promise<void> {
  await fs.mkdir(fsPath, { recursive: true });
}

export async function statSafe(fsPath: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const st = await fs.stat(fsPath);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

export async function readFirstLineUtf8(fsPath: string, maxBytes = 512 * 1024): Promise<string | null> {
  // Efficiently read only the first line of a JSONL file (typically session_meta).
  const handle = await fs.open(fsPath, "r");
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
    if (bytesRead <= 0) return null;

    const text = buf.subarray(0, bytesRead).toString("utf8");
    const idx = text.indexOf("\n");
    const line = idx >= 0 ? text.slice(0, idx) : text;
    return line.replace(/\r$/, "");
  } finally {
    await handle.close();
  }
}

export function normalizeCacheKey(fsPath: string): string {
  // Avoid cache misses caused by Windows case/path-separator differences.
  const normalized = path.normalize(fsPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
