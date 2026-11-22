import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { ANTIGRAVITY_UUID } from "./antigravityTypes";

export function antigravityWatchTarget(root: string, file: string): string | undefined {
  const relative = path.relative(root, file).split(path.sep);
  if (relative.length === 1 && ["conversation_summaries.db", "conversation_summaries.db-wal"].includes(relative[0]!)) return path.join(root, "conversation_summaries.db");
  if (relative.length === 2 && relative[0] === "conversations") {
    const name = relative[1]!.replace(/-wal$/, "");
    if (name.endsWith(".db") && ANTIGRAVITY_UUID.test(name.slice(0, -3))) return path.join(root, "conversations", name);
  }
  if (relative.length === 5 && relative[0] === "brain" && ANTIGRAVITY_UUID.test(relative[1]!) && relative[2] === ".system_generated" && relative[3] === "logs"
    && ["transcript_full.jsonl", "transcript.jsonl"].includes(relative[4]!)) return path.join(root, "conversations", relative[1]! + ".db");
  return undefined;
}

// This is an invalidation hint, never proof that a persisted body cache is current.
export async function antigravityWatchStamp(root: string, file: string): Promise<string> {
  if (antigravityWatchTarget(root, file) !== file || path.dirname(file) !== path.join(root, "conversations")) throw new Error("Invalid native watch target.");
  const id = path.basename(file, ".db"), digest = createHash("sha256");
  const relatives = [path.join("conversations", id + ".db"), path.join("conversations", id + ".db-wal"), "conversation_summaries.db", "conversation_summaries.db-wal",
    path.join("brain", id, ".system_generated", "logs", "transcript_full.jsonl"), path.join("brain", id, ".system_generated", "logs", "transcript.jsonl")];
  for (const relative of relatives) {
    try {
      let directory = root;
      for (const part of relative.split(path.sep).slice(0, -1)) {
        directory = path.join(directory, part); const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid native watch directory.");
      }
      const source = path.join(root, relative), stat = await fs.lstat(source, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || await fs.realpath(source) !== source) throw new Error("Invalid native watch file.");
      digest.update(JSON.stringify([relative, String(stat.dev), String(stat.ino), String(stat.birthtimeNs), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)]));
      if (relative.endsWith("-wal")) {
        const handle = await fs.open(source, "r");
        try {
          const current = await handle.stat({ bigint: true });
          if (current.dev !== stat.dev || current.ino !== stat.ino || current.birthtimeNs !== stat.birthtimeNs) throw new Error("Native watch file changed.");
          const bytes = Buffer.alloc(32), result = await handle.read(bytes, 0, 32, 0); digest.update(bytes.subarray(0, result.bytesRead));
        } finally { await handle.close(); }
      }
    } catch (error) {
      const missing = error && typeof error === "object" && "code" in error && error.code === "ENOENT";
      digest.update(JSON.stringify([relative, missing ? "missing" : "unavailable"]));
    }
  }
  return digest.digest("hex");
}
