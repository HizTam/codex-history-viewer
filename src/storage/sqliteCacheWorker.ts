import { parentPort, workerData } from "node:worker_threads";
import { SqliteCacheEngine } from "./sqliteCacheEngine";
import { isRecord, probeSqliteCacheRuntime, safeSqliteError, SqliteCacheError, sqliteInteger } from "./sqliteRuntime";
import type { SqliteCacheRequest } from "./sqliteCacheTypes";

// Native errors are reduced to fixed codes; SQL, values and source paths never cross this boundary.
const port = parentPort;
if (!port) throw new Error("The cache Worker requires a parent port.");
const engine = workerData === "probeRuntime" ? undefined : new SqliteCacheEngine();
port.on("message", (envelope: unknown) => {
  if (!isRecord(envelope)) return;
  let id: number;
  try { id = sqliteInteger(envelope.id, 1); } catch { return; }
  try {
    const request = envelope.request;
    if (!engine) {
      if (!isRecord(request) || request.kind !== "probeRuntime") throw new SqliteCacheError("invalidData");
      port.postMessage({ id, ok: true, result: probeSqliteCacheRuntime() });
      return;
    }
    const result = engine.execute(request as SqliteCacheRequest);
    port.postMessage({ id, ok: true, result });
    if (isRecord(request) && request.kind === "dispose") port.close();
  } catch (error) {
    const code = !engine && !(error instanceof SqliteCacheError) ? "runtime" : safeSqliteError(error);
    port.postMessage({ id, ok: false, code });
  }
});
