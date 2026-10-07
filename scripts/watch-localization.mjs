// Restart only this watcher's child after a valid localization generation.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webview = process.argv.includes("--webview");
let child;
let generator;
let timer;
let running = false;
let pending = false;
let closing = false;
function launch(args) {
  return spawn(process.execPath, args, { cwd: root, stdio: "inherit", windowsHide: true });
}
async function stopProcess(processToStop) {
  if (!processToStop || processToStop.exitCode !== null || processToStop.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const killTimer = setTimeout(() => processToStop.kill("SIGKILL"), 3000);
    const deadline = setTimeout(() => finish(new Error("Unable to stop owned build watcher")), 5000);
    const finish = error => {
      clearTimeout(killTimer);
      clearTimeout(deadline);
      processToStop.removeListener("exit", onExit);
      processToStop.removeListener("error", finish);
      if (error) reject(error); else resolve();
    };
    const onExit = () => finish();
    processToStop.once("exit", onExit);
    processToStop.once("error", finish);
    processToStop.kill();
  });
}
async function rebuild() {
  if (closing) return;
  if (running) { pending = true; return; }
  running = true;
  try {
    await stopProcess(child);
    generator = launch(["scripts/generate-localization.mjs", "--write"]);
    const code = await new Promise(resolve => { generator.once("error", () => resolve(1)); generator.once("exit", resolve); });
    if (code === 0 && !closing) {
      child = launch(webview ? ["scripts/build-webview-shiki.mjs", "--watch"] : ["node_modules/typescript/bin/tsc", "--watch", "-p", "."]);
      child.once("error", () => { process.stderr.write("Unable to start localization build watcher\n"); });
    }
  } catch {
    closing = true;
    process.stderr.write("Unable to restart localization build watcher\n");
    process.exitCode = 1;
    for (const watcher of watchers) watcher.close();
  } finally {
    running = false;
    if (pending) { pending = false; void rebuild(); }
  }
}
function scheduleRebuild() {
  clearTimeout(timer);
  timer = setTimeout(() => void rebuild(), 150);
}
const watchers = [
  fs.watch(path.join(root, "localization"), { recursive: true }, (_event, filename) => {
    if (filename && filename.replaceAll("\\", "/") !== "generated-files.json") scheduleRebuild();
  }),
  fs.watch(path.join(root, ".node-version"), scheduleRebuild),
  fs.watch(path.join(root, "scripts"), (_event, filename) => {
    if (["generate-localization.mjs", "check-localization-usage.mjs"].includes(String(filename))) scheduleRebuild();
  }),
];
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  closing = true;
  clearTimeout(timer);
  for (const watcher of watchers) watcher.close();
  void Promise.all([stopProcess(child), stopProcess(generator)]).then(() => process.exit(), () => {
    process.stderr.write("Unable to stop owned localization processes\n");
    process.exit(1);
  });
});
void rebuild();
