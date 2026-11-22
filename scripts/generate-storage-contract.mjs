import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = "src/generated/storageContractFingerprint.ts";
const entryPoints = [
  "src/services/historyService.ts", "src/services/searchIndexService.ts",
  "src/analysis/sessionAnalysisIndexService.ts", "src/storage/searchIndexStorage.ts",
  "src/storage/sqliteCacheWorker.ts", "src/storage/sqliteCacheCodec.ts",
  "src/antigravity/antigravityReaderWorker.ts",
];
const isUiBoundary = file => file === output || file === "src/i18n.ts" || file.startsWith("src/localization/")
  || file.startsWith("src/generated/") || file.startsWith("src/ui/") || file.startsWith("src/tree/");

// Resolve the actual runtime dependency graph; timestamps and UI-only resources are not inputs.
export function computeStorageContract(read = file => fs.readFileSync(file, "utf8")) {
  const config = ts.readConfigFile(path.join(root, "tsconfig.json"), file => read(file));
  if (config.error) throw new Error("Cannot read storage contract compiler configuration.");
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
  const pending = [...entryPoints];
  const files = new Map();
  const packages = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (files.has(file) || isUiBoundary(file)) continue;
    if (!file.startsWith("src/") || path.isAbsolute(file) || file.split("/").includes("..")) throw new Error("Unsafe storage contract input.");
    const absolute = path.join(root, file);
    const text = read(absolute);
    files.set(file, text);
    const source = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true);
    const imports = [];
    function visit(node) {
      if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly !== true && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
      if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])
        && ((ts.isIdentifier(node.expression) && node.expression.text === "require") || node.expression.kind === ts.SyntaxKind.ImportKeyword)) imports.push(node.arguments[0].text);
      ts.forEachChild(node, visit);
    }
    visit(source);
    for (const name of imports) {
      if (name.startsWith("node:") || name === "vscode") continue;
      const resolved = ts.resolveModuleName(name, absolute, options, ts.sys).resolvedModule;
      if (name.startsWith(".")) {
        if (!resolved) {
          // The separately bundled decoder is represented by its package lock below.
          if (name.endsWith("/vendor/zstd.cjs")) {
            packages.add("node_modules/@hpcc-js/wasm-zstd");
            files.set("scripts/build-zstd.mjs", read(path.join(root, "scripts/build-zstd.mjs")));
            continue;
          }
          if (name.endsWith("package.json")) continue;
          throw new Error("Unresolved local storage contract dependency: " + file);
        }
        const relative = path.relative(root, resolved.resolvedFileName).split(path.sep).join("/");
        if (relative.endsWith(".ts") && !isUiBoundary(relative)) pending.push(relative);
      } else {
        const packageName = name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0];
        if (resolved?.isExternalLibraryImport) packages.add("node_modules/" + packageName);
      }
    }
  }
  const lock = JSON.parse(read(path.join(root, "package-lock.json")));
  const dependencies = new Map();
  const queue = [...packages];
  while (queue.length) {
    const name = queue.pop();
    if (dependencies.has(name)) continue;
    const info = lock.packages?.[name];
    if (!info) throw new Error("Storage dependency missing from lockfile: " + name);
    dependencies.set(name, info);
    for (const dependency of Object.keys({ ...info.dependencies, ...info.optionalDependencies }).sort()) {
      let prefix = name;
      let candidate;
      while (prefix) {
        const nested = prefix + "/node_modules/" + dependency;
        if (lock.packages[nested]) { candidate = nested; break; }
        const previous = prefix.lastIndexOf("/node_modules/");
        prefix = previous < 0 ? "" : prefix.slice(0, previous);
      }
      candidate ??= "node_modules/" + dependency;
      if (lock.packages[candidate]) queue.push(candidate);
      else if (!Object.hasOwn(info.optionalDependencies ?? {}, dependency)) throw new Error("Storage transitive dependency missing from lockfile.");
    }
  }
  const digest = crypto.createHash("sha256");
  for (const [name, text] of [...files].sort(([a], [b]) => a.localeCompare(b, "en"))) digest.update(name + "\0" + text + "\0");
  for (const [name, info] of [...dependencies].sort(([a], [b]) => a.localeCompare(b, "en"))) digest.update(name + "\0" + JSON.stringify(info) + "\0");
  return { fingerprint: digest.digest("hex"), files: [...files.keys()].sort(), dependencies: [...dependencies.keys()].sort() };
}

export function writeStorageContract(check = false) {
  const result = computeStorageContract();
  const text = "// Generated from the storage producer dependency graph; do not edit by hand.\n"
    + `export const STORAGE_CONTRACT_FINGERPRINT = "${result.fingerprint}";\n`;
  if (check) {
    if (fs.readFileSync(path.join(root, output), "utf8") !== text) throw new Error("Storage contract fingerprint is stale.");
  } else {
    if (!fs.existsSync(path.join(root, output)) || fs.readFileSync(path.join(root, output), "utf8") !== text) fs.writeFileSync(path.join(root, output), text, "utf8");
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (!["--check", "--write", "--watch"].includes(mode)) throw new Error("Use --check, --write or --watch.");
  const result = writeStorageContract(mode === "--check");
  console.log(`Storage contract: ${result.files.length} modules, ${result.dependencies.length} dependencies`);
  if (mode === "--watch") {
    let timer;
    let closing = false;
    const watchers = [];
    const close = () => { closing = true; clearTimeout(timer); for (const watcher of watchers) watcher.close(); };
    const schedule = () => {
      if (closing) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        try { writeStorageContract(); }
        catch { process.stderr.write("Storage contract generation failed; restart the build watcher after fixing the source.\n"); process.exitCode = 1; close(); }
      }, 100);
    };
    watchers.push(fs.watch(path.join(root, "src"), { recursive: true }, (_event, filename) => {
      const file = String(filename ?? "").replaceAll("\\", "/");
      if (file.endsWith(".ts") && !file.startsWith("generated/")) schedule();
    }));
    watchers.push(fs.watch(path.join(root, "package-lock.json"), schedule));
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, close);
  }
}
