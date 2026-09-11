import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

// Revalidate this adapter whenever either upstream package is updated.
const mermaidVersion = "11.17.2";
const yamlVersion = "4.3.2";
const embeddedModule = "node_modules/mermaid/dist/chunks/mermaid.core/chunk-LNGE3PJU.mjs";
const patchedModule = "node_modules/js-yaml/dist/js-yaml.mjs";
const embeddedSha256 = "2cb4e5f8d5fd99daccb0135fda6a5583c91f39efb0bb845af9d968ed427efcb2";
const patchedSha256 = "cea276c7e15f409a1adbe5d177aba7824398a474f7cf702bd57962c7d570636f";
const watchedFiles = [
  "package.json",
  "package-lock.json",
  "node_modules/mermaid/package.json",
  "node_modules/js-yaml/package.json",
  embeddedModule,
  patchedModule,
];

function readFile(rootDir, relativePath) {
  try {
    const fullPath = path.join(rootDir, relativePath);
    const stat = lstatSync(fullPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 4 * 1024 * 1024) {
      throw new Error("Not a regular file within the size limit.");
    }
    return readFileSync(fullPath);
  } catch {
    throw new Error(`Unable to read a valid ${relativePath} for the Mermaid YAML adapter.`);
  }
}

function readJson(rootDir, relativePath) {
  const bytes = readFile(rootDir, relativePath);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`Invalid JSON in ${relativePath}.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${relativePath} must contain a JSON object.`);
  }
  return value;
}

function readVerifiedModule(rootDir, relativePath, expectedSha256) {
  const bytes = readFile(rootDir, relativePath);
  if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
    throw new Error(`${relativePath} changed. Review the Mermaid YAML adapter before rebuilding.`);
  }
  return bytes.toString("utf8");
}

function validateDependencies(rootDir) {
  const manifest = readJson(rootDir, "package.json");
  const lock = readJson(rootDir, "package-lock.json");
  for (const [name, section, version] of [
    ["mermaid", "dependencies", mermaidVersion],
    ["js-yaml", "devDependencies", yamlVersion],
  ]) {
    if (manifest[section]?.[name] !== version) {
      throw new Error(`The Mermaid YAML adapter requires ${section}.${name} pinned to ${version}.`);
    }
    if (lock.packages?.[""]?.[section]?.[name] !== version
      || lock.packages?.[`node_modules/${name}`]?.version !== version) {
      throw new Error(`package-lock.json must match ${name}@${version}. Run npm install and review the lockfile.`);
    }
    const installed = readJson(rootDir, `node_modules/${name}/package.json`);
    if (installed.name !== name || installed.version !== version) {
      throw new Error(`Installed ${name} must match ${version}. Run npm install before rebuilding.`);
    }
  }
  readVerifiedModule(rootDir, embeddedModule, embeddedSha256);
  return readVerifiedModule(rootDir, patchedModule, patchedSha256);
}

export function mermaidYamlDependencyPlugin(rootDir) {
  if (typeof rootDir !== "string" || !path.isAbsolute(rootDir)) {
    throw new Error("The Mermaid YAML adapter requires an absolute project directory.");
  }
  const embeddedPath = path.resolve(rootDir, embeddedModule);
  const patchedPath = path.resolve(rootDir, patchedModule);
  const watchFiles = watchedFiles.map(file => path.resolve(rootDir, file));
  return {
    name: "mermaid-patched-yaml",
    setup(build) {
      let patchedContents;
      let embeddedUsed = false;
      let patchedUsed = false;
      build.onStart(() => {
        // Reset on every rebuild; a failed validation must not reuse previous content.
        patchedContents = undefined;
        embeddedUsed = false;
        patchedUsed = false;
        patchedContents = validateDependencies(rootDir);
      });
      build.onLoad({ filter: /[\\/]chunk-LNGE3PJU\.mjs$/ }, args => {
        if (path.resolve(args.path) !== embeddedPath) return;
        if (patchedContents === undefined) throw new Error("Mermaid YAML dependency validation failed.");
        embeddedUsed = true;
        return {
          // Preserve Mermaid's two-export interface without modifying node_modules.
          contents: 'export { JSON_SCHEMA, load } from "./js-yaml.mjs";\n',
          loader: "js",
          resolveDir: path.dirname(patchedPath),
          watchFiles,
        };
      });
      build.onLoad({ filter: /[\\/]js-yaml[\\/]dist[\\/]js-yaml\.mjs$/ }, args => {
        if (path.resolve(args.path) !== patchedPath) return;
        if (patchedContents === undefined) throw new Error("Mermaid YAML dependency validation failed.");
        patchedUsed = true;
        // Bundle the exact bytes that passed the hash check, including in watch mode.
        return { contents: patchedContents, loader: "js", resolveDir: path.dirname(patchedPath), watchFiles };
      });
      build.onEnd(result => {
        if (result.errors.length === 0 && (!embeddedUsed || !patchedUsed)) {
          return { errors: [{ text: "Mermaid YAML replacement was not applied. Review the adapter before rebuilding." }] };
        }
      });
    },
  };
}
