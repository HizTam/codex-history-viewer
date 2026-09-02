import * as crypto from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { finished } from "node:stream/promises";
import * as vscode from "vscode";
import type { HistoryService } from "./historyService";
import type { SessionSummary } from "../sessions/sessionTypes";
import { formatTimeHmsInTimeZone, pad2, toYmdInTimeZone } from "../utils/dateUtils";
import { buildSessionSummary, tryReadSessionMeta } from "../sessions/sessionSummary";
import type { CodexHistoryViewerConfig } from "../settings";
import { resolveDateTimeSettings } from "../utils/dateTimeSettings";
import {
  readSessionJsonlLines,
  resolveCodexLogicalHistoryPlan,
  type CodexLogicalHistoryPlan,
} from "../sessions/codexHistoryBase";

// Copies a past session into "today" (promote). The source file is never modified.

export async function promoteSessionCopyToToday(
  session: SessionSummary,
  historyService: HistoryService,
  config: CodexHistoryViewerConfig,
): Promise<SessionSummary> {
  const historyIndex = historyService.getIndex();
  const sessionsRoot = historyIndex.sessionsRoot;
  const dateTime = resolveDateTimeSettings();
  const now = new Date();
  const ymd = toYmdInTimeZone(now, dateTime.timeZone);
  const yyyy = String(ymd.year);
  const mm = pad2(ymd.month);
  const dd = pad2(ymd.day);

  const destDir = path.join(sessionsRoot, yyyy, mm, dd);
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(destDir));

  const newId = crypto.randomUUID();
  const hms = formatTimeHmsInTimeZone(now, dateTime.timeZone);
  const [hh, mi, ss] = hms.split(":");
  const fileNameSafe =
    typeof hh === "string" && typeof mi === "string" && typeof ss === "string" && hh.length === 2 && mi.length === 2 && ss.length === 2
      ? `rollout-${yyyy}-${mm}-${dd}T${hh}-${mi}-${ss}-${newId}.jsonl`
      : `rollout-${yyyy}-${mm}-${dd}T${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}-${newId}.jsonl`;
  const destPath = path.join(destDir, fileNameSafe);
  const tempPath = `${destPath}.tmp`;
  const sessionInventory = historyIndex.historySources ?? historyIndex.sessions;
  const historyPlan = session.source === "codex" && session.meta.codexHistoryBase
    ? await resolveCodexLogicalHistoryPlan(session.fsPath, sessionInventory)
    : undefined;

  // Compute the delta (ms) to shift the timeline to "now".
  const firstLogicalSegment = historyPlan?.segments.find(
    (segment) => (segment.endByteOffset ?? segment.size) > 0,
  );
  const originalMeta = await tryReadSessionMeta(firstLogicalSegment?.fsPath ?? session.fsPath);
  const originalStartMs = originalMeta?.timestampIso ? Date.parse(originalMeta.timestampIso) : NaN;
  const newStartMs = Date.now();
  const deltaMs = Number.isFinite(originalStartMs) ? newStartMs - originalStartMs : 0;

  try {
    await copyAndShiftJsonl({
      srcPath: session.fsPath,
      destPath: tempPath,
      newSessionId: newId,
      newSessionStartIso: new Date(newStartMs).toISOString(),
      deltaMs,
      source: session.source,
      sessionInventory,
      historyPlan,
      materializeHistoryBase: historyPlan?.complete === true,
    });
    if (historyPlan) {
      const currentPlan = await resolveCodexLogicalHistoryPlan(session.fsPath, sessionInventory);
      if (currentPlan.signature !== historyPlan.signature) {
        throw new Error("The paginated session changed while it was being promoted.");
      }
    }
    await fsp.rename(tempPath, destPath);
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await fsp.utimes(destPath, now, now);
  await touchPathQuiet(destDir);
  await touchPathQuiet(sessionsRoot);

  const summary =
    (await buildSessionSummary({
      sessionsRoot,
      fsPath: destPath,
      previewMaxMessages: config.previewMaxMessages,
      timeZone: dateTime.timeZone,
    })) ?? session;

  return summary;
}

async function touchPathQuiet(targetPath: string): Promise<void> {
  try {
    const now = new Date();
    await fsp.utimes(targetPath, now, now);
  } catch {
    // Even if timestamp update fails, keep using the copied session as-is.
  }
}

async function copyAndShiftJsonl(params: {
  srcPath: string;
  destPath: string;
  newSessionId: string;
  newSessionStartIso: string;
  deltaMs: number;
  source: SessionSummary["source"];
  sessionInventory: readonly SessionSummary[];
  historyPlan?: CodexLogicalHistoryPlan;
  materializeHistoryBase: boolean;
}): Promise<void> {
  const {
    srcPath,
    destPath,
    newSessionId,
    newSessionStartIso,
    deltaMs,
    source,
    sessionInventory,
    historyPlan,
    materializeHistoryBase,
  } = params;
  const output = fs.createWriteStream(destPath, { encoding: "utf8" });
  const outputFinished = finished(output);
  void outputFinished.catch(() => undefined);
  let primarySessionMetaWritten = false;

  try {
    for await (const record of readSessionJsonlLines(srcPath, source, {
      sessionInventory,
      ...(historyPlan ? { plan: historyPlan } : {}),
    })) {
      const { line } = record;
      if (!line) {
        await writeJsonlChunk(output, outputFinished, "\n");
        continue;
      }
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        await writeJsonlChunk(output, outputFinished, `${line}\n`);
        continue;
      }

      if (obj?.type === "session_meta" && obj?.payload && typeof obj.payload === "object") {
        obj.payload.id = newSessionId;
        if (!primarySessionMetaWritten) {
          obj.payload.timestamp = newSessionStartIso;
          primarySessionMetaWritten = true;
        } else if (typeof obj.payload.timestamp === "string") {
          const payloadTimestampMs = Date.parse(obj.payload.timestamp);
          if (Number.isFinite(payloadTimestampMs)) {
            obj.payload.timestamp = new Date(payloadTimestampMs + deltaMs).toISOString();
          }
        }
        if (materializeHistoryBase) {
          delete obj.payload.history_mode;
          delete obj.payload.history_base;
        }
      }

      if (typeof obj?.timestamp === "string") {
        const ms = Date.parse(obj.timestamp);
        if (Number.isFinite(ms)) obj.timestamp = new Date(ms + deltaMs).toISOString();
      }

      await writeJsonlChunk(output, outputFinished, `${JSON.stringify(obj)}\n`);
    }
    output.end();
    await outputFinished;
  } catch (error) {
    output.destroy();
    await outputFinished.catch(() => undefined);
    throw error;
  }
}

async function writeJsonlChunk(
  output: fs.WriteStream,
  outputFinished: Promise<void>,
  chunk: string,
): Promise<void> {
  if (output.destroyed || output.writableEnded) {
    await outputFinished;
    throw new Error("The promoted session output stream closed unexpectedly.");
  }
  if (output.write(chunk)) return;
  await Promise.race([
    once(output, "drain").then(() => undefined),
    outputFinished.then(() => {
      throw new Error("The promoted session output stream closed before draining.");
    }),
  ]);
}
