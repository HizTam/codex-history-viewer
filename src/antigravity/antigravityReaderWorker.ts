import { parentPort } from "node:worker_threads";
import { isRecord } from "../storage/sqliteRuntime";
import { readAntigravityDatabase, safeAntigravityError } from "./antigravityReaderEngine";
import { validateAntigravityRequest } from "./antigravityReaderValidation";

const port = parentPort;
if (!port) throw new Error("The Antigravity reader requires a parent port.");
let active = false;
port.on("message", (envelope: unknown) => {
  if (!isRecord(envelope) || typeof envelope.id !== "number" || !Number.isSafeInteger(envelope.id) || envelope.id < 1) return;
  const id = envelope.id;
  if (active) { port.postMessage({ id, ok: false, code: "busy" }); return; }
  // A shared flag remains observable while synchronous native SQLite is executing.
  if (!(envelope.cancel instanceof SharedArrayBuffer) || envelope.cancel.byteLength !== 4) { port.postMessage({ id, ok: false, code: "format" }); return; }
  let request;
  try { request = validateAntigravityRequest(envelope.request); }
  catch (error) { port.postMessage({ id, ok: false, code: safeAntigravityError(error).code }); return; }
  active = true;
  const flag = new Int32Array(envelope.cancel);
  void readAntigravityDatabase(request, () => Atomics.load(flag, 0) !== 0, () => port.postMessage({ id, progress: true }))
    .then(result => port.postMessage({ id, ok: true, result }), error => port.postMessage({ id, ok: false, code: safeAntigravityError(error).code }))
    .finally(() => { active = false; });
});
