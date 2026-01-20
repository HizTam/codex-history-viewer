import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";
import * as vscode from "vscode";
import type { HistoryService } from "./historyService";
import type { SessionSummary } from "../sessions/sessionTypes";
import { pad2, toYmdLocal, ymdToString } from "../utils/dateUtils";
import { buildSessionSummary, tryReadSessionMeta } from "../sessions/sessionSummary";
import type { CodexHistoryViewerConfig } from "../settings";

// Copies a past session into "today" (promote). The source file is never modified.

export async function promoteSessionCopyToToday(
  session: SessionSummary,
  historyService: HistoryService,
  config: CodexHistoryViewerConfig,
): Promise<SessionSummary> {
  const sessionsRoot = historyService.getIndex().sessionsRoot;
  const now = new Date();
  const ymd = toYmdLocal(now);
  const yyyy = String(ymd.year);
  const mm = pad2(ymd.month);
  const dd = pad2(ymd.day);

  const destDir = path.join(sessionsRoot, yyyy, mm, dd);
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(destDir));

  const newId = crypto.randomUUID();
  const fileName = `rollout-${yyyy}-${mm}-${dd}T${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(
    now.getSeconds(),
  )}-${newId}.jsonl`;
  const destPath = path.join(destDir, fileName);
  const tempPath = `${destPath}.tmp`;

  // Compute the delta (ms) to shift the timeline to "now".
  const originalMeta = await tryReadSessionMeta(session.fsPath);
  const originalStartMs = originalMeta?.timestampIso ? Date.parse(originalMeta.timestampIso) : NaN;
  const newStartMs = Date.now();
  const deltaMs = Number.isFinite(originalStartMs) ? newStartMs - originalStartMs : 0;

  await copyAndShiftJsonl({
    srcPath: session.fsPath,
    destPath: tempPath,
    newSessionId: newId,
    newSessionStartIso: new Date(newStartMs).toISOString(),
    deltaMs,
  });

  await fsp.rename(tempPath, destPath);
  await fsp.utimes(destPath, now, now);

  const summary =
    (await buildSessionSummary({
      sessionsRoot,
      fsPath: destPath,
      previewMaxMessages: config.previewMaxMessages,
    })) ?? session;

  return summary;
}

async function copyAndShiftJsonl(params: {
  srcPath: string;
  destPath: string;
  newSessionId: string;
  newSessionStartIso: string;
  deltaMs: number;
}): Promise<void> {
  const { srcPath, destPath, newSessionId, newSessionStartIso, deltaMs } = params;

  const input = fs.createReadStream(srcPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const output = fs.createWriteStream(destPath, { encoding: "utf8" });

  try {
    for await (const line of rl) {
      if (!line) {
        output.write("\n");
        continue;
      }
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        output.write(`${line}\n`);
        continue;
      }

      if (obj?.type === "session_meta" && obj?.payload && typeof obj.payload === "object") {
        obj.payload.id = newSessionId;
        obj.payload.timestamp = newSessionStartIso;
      }

      if (typeof obj?.timestamp === "string") {
        const ms = Date.parse(obj.timestamp);
        if (Number.isFinite(ms)) obj.timestamp = new Date(ms + deltaMs).toISOString();
      }

      output.write(`${JSON.stringify(obj)}\n`);
    }
  } finally {
    rl.close();
    input.close();
    await new Promise<void>((resolve) => output.end(resolve));
  }
}
