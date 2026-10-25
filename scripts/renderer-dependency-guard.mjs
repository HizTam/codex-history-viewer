import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mermaidYamlDependencyWatchFiles } from "./mermaid-yaml-dependency.mjs";

const versions = Object.freeze({
  "markdown-it": "14.3.3",
  mermaid: "11.17.2",
  dompurify: "3.4.17",
  katex: "0.18.9",
  "@azure/msal-node": "7.1.1",
  "@azure/msal-common": "16.14.3",
});
const pluginName = "verified-renderer-output";
const key = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const within = (directory, file) => key(file).startsWith(`${key(directory)}${path.sep}`);
const relative = (root, file) => within(root, file) ? path.relative(root, file).replaceAll(path.sep, "/") : "dependency file";
const fail = message => { throw new Error(message); };

function readBytes(root, file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 16 * 1024 * 1024) throw new Error("Invalid file.");
    return fs.readFileSync(file);
  } catch {
    return fail(`Cannot read a valid ${relative(root, file)}.`);
  }
}

function readJson(root, file) {
  const bytes = readBytes(root, file);
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid object.");
    return value;
  } catch {
    return fail(`Invalid JSON in ${relative(root, file)}.`);
  }
}

function nearestPackage(root, origin, name) {
  // Check the filesystem afresh; Node's resolver caches can hide newly added nested packages in watch mode.
  let directory = origin;
  while (key(directory) === key(root) || within(root, directory)) {
    const target = path.join(directory, "node_modules", name);
    if (fs.existsSync(target)) return { directory: target, manifest: path.join(target, "package.json") };
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return fail(`Cannot resolve ${name} inside the project.`);
}

function installedPackage(root, lock, origin, name, expectedVersion, expectedDirectory) {
  const located = nearestPackage(root, origin, name);
  if (expectedDirectory && key(located.directory) !== key(expectedDirectory)) {
    return fail(`${name} resolves to an unexpected nested package.`);
  }
  const manifest = readJson(root, located.manifest);
  const lockKey = relative(root, located.directory);
  const locked = lock.packages?.[lockKey];
  if (manifest.name !== name || manifest.version !== expectedVersion || locked?.version !== expectedVersion) {
    return fail(`${lockKey} must match reviewed ${name}@${expectedVersion}.`);
  }
  let entry;
  try {
    entry = createRequire(path.join(origin, "package.json")).resolve(name);
  } catch {
    return fail(`Cannot resolve the installed ${name} entry point.`);
  }
  if (!within(located.directory, entry)) return fail(`${name} has an unexpected entry point.`);
  readBytes(root, entry);
  return { ...located, entry, version: expectedVersion };
}

function declared(manifest, lock, section, name, value) {
  if (manifest[section]?.[name] !== value || lock.packages?.[""]?.[section]?.[name] !== value) {
    fail(`package.json and package-lock.json must declare ${section}.${name} as ${value}.`);
  }
}

function baseWatchFiles(root) {
  const files = [
    "package.json", "package-lock.json",
    ...["markdown-it", "mermaid", "dompurify", "katex", "@vscode/vsce", "@azure/identity", "@azure/msal-node", "@azure/msal-common"].map(name => `node_modules/${name}/package.json`),
    "node_modules/mermaid/node_modules/katex/package.json",
    "node_modules/mermaid/node_modules/dompurify/package.json",
    "node_modules/@azure/identity/node_modules/@azure/msal-node/package.json",
    "node_modules/@azure/msal-node/node_modules/@azure/msal-common/package.json",
  ].map(file => path.join(root, file));
  // Watch the adapter inputs even when its first onStart validation fails before loading its module.
  return [...files, ...mermaidYamlDependencyWatchFiles(root)];
}

export function validateRendererDependencies(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) fail("An absolute project directory is required.");
  const manifestFile = path.join(root, "package.json");
  const lockFile = path.join(root, "package-lock.json");
  const manifest = readJson(root, manifestFile);
  const lock = readJson(root, lockFile);
  declared(manifest, lock, "dependencies", "markdown-it", `^${versions["markdown-it"]}`);
  declared(manifest, lock, "dependencies", "mermaid", versions.mermaid);
  declared(manifest, lock, "devDependencies", "katex", versions.katex);
  if (manifest.overrides?.mermaid?.katex !== "$katex"
    || manifest.overrides?.mermaid?.dompurify !== versions.dompurify
    || manifest.overrides?.["@azure/identity"]?.["@azure/msal-node"] !== versions["@azure/msal-node"]) {
    fail("The reviewed Mermaid and Azure Identity dependency overrides are required.");
  }
  const installed = {};
  for (const name of ["markdown-it", "mermaid", "katex"]) {
    installed[name] = installedPackage(root, lock, root, name, versions[name], path.join(root, "node_modules", name));
  }
  const mermaidRoot = installed.mermaid.directory;
  const diagramKatex = installedPackage(root, lock, mermaidRoot, "katex", versions.katex, installed.katex.directory);
  installed.dompurify = installedPackage(root, lock, mermaidRoot, "dompurify", versions.dompurify, path.join(root, "node_modules/dompurify"));
  const vsce = nearestPackage(root, root, "@vscode/vsce");
  const vsceManifest = readJson(root, vsce.manifest);
  if (vsceManifest.name !== "@vscode/vsce" || vsceManifest.version !== lock.packages?.[relative(root, vsce.directory)]?.version) fail("The installed VSCE must match package-lock.json.");
  const identity = nearestPackage(root, vsce.directory, "@azure/identity");
  const identityManifest = readJson(root, identity.manifest);
  if (identityManifest.name !== "@azure/identity" || identityManifest.version !== lock.packages?.[relative(root, identity.directory)]?.version) fail("The installed Azure Identity must match package-lock.json.");
  installed["@azure/msal-node"] = installedPackage(root, lock, identity.directory, "@azure/msal-node", versions["@azure/msal-node"], path.join(root, "node_modules/@azure/msal-node"));
  installed["@azure/msal-common"] = installedPackage(root, lock, installed["@azure/msal-node"].directory, "@azure/msal-common", versions["@azure/msal-common"]);
  const markdownBrowser = path.join(installed["markdown-it"].directory, "dist/markdown-it.min.js");
  if (!readBytes(root, markdownBrowser).subarray(0, 512).toString("utf8").includes(`markdown-it ${versions["markdown-it"]}`)) {
    fail("The Markdown browser distribution does not match the reviewed version.");
  }
  const watchFiles = [...new Set([...baseWatchFiles(root), vsce.manifest, identity.manifest, markdownBrowser, diagramKatex.manifest, ...Object.values(installed).flatMap(item => [item.manifest, item.entry])])];
  const fingerprint = createHash("sha256");
  for (const file of [...watchFiles].sort()) {
    fingerprint.update(relative(root, file));
    if (fs.existsSync(file)) fingerprint.update(readBytes(root, file));
    else fingerprint.update("missing");
  }
  return { root, installed, watchFiles, fingerprint: fingerprint.digest("hex") };
}

export function validateRendererBundle(result, validation, outfile) {
  if (!result.metafile || !Array.isArray(result.outputFiles) || result.outputFiles.length !== 1) fail("The renderer build must produce one verified in-memory bundle.");
  const output = result.outputFiles[0];
  if (!path.isAbsolute(output.path) || key(output.path) !== key(outfile)
    || !(output.contents instanceof Uint8Array) || output.contents.byteLength === 0) fail("The renderer build has an unexpected output file or empty content.");
  const outputs = Object.entries(result.metafile.outputs || {});
  if (outputs.length !== 1 || key(path.resolve(validation.root, outputs[0][0])) !== key(outfile)
    || key(path.resolve(validation.root, outputs[0][1].entryPoint || "")) !== key(path.join(validation.root, "scripts/chatViewShiki.entry.js"))) {
    fail("The renderer build metadata has an unexpected output or entry point.");
  }
  const emitted = outputs[0][1].inputs || {};
  for (const name of ["katex", "dompurify"]) {
    const expected = validation.installed[name].directory;
    const marker = `/node_modules/${name}/`;
    const inputs = Object.keys(result.metafile.inputs || {}).filter(file => `/${file.replaceAll("\\", "/")}`.includes(marker));
    if (inputs.length === 0 || inputs.some(file => !within(expected, path.resolve(validation.root, file)))
      || !inputs.some(file => emitted[file]?.bytesInOutput > 0)) {
      fail(`The renderer bundle must contain only the reviewed root ${name} implementation.`);
    }
  }
  return output.contents;
}

export function publishBundleAtomically(outfile, contents, beforeCommit, fileSystem = fs) {
  const temporary = path.join(path.dirname(outfile), `.${path.basename(outfile)}.${process.pid}.${randomUUID()}.tmp`);
  let failure;
  let descriptor;
  let ownedTemporary = false;
  let committed = false;
  try {
    fileSystem.mkdirSync(path.dirname(outfile), { recursive: true });
    descriptor = fileSystem.openSync(temporary, "wx");
    ownedTemporary = true;
    fileSystem.writeFileSync(descriptor, contents);
    fileSystem.closeSync(descriptor);
    descriptor = undefined;
    beforeCommit?.();
    // Never remove the existing bundle: rename either replaces it or leaves it intact.
    fileSystem.renameSync(temporary, outfile);
    committed = true;
  } catch {
    failure = new Error("Cannot publish the verified renderer bundle; the previous bundle was retained.");
  } finally {
    if (descriptor !== undefined) {
      try { fileSystem.closeSync(descriptor); }
      catch { failure = new Error("Cannot close the temporary renderer bundle after publishing failed."); }
    }
    if (ownedTemporary && !committed) {
      try { fileSystem.unlinkSync(temporary); }
      catch (error) {
        if (error?.code !== "ENOENT") failure = new Error("Cannot clean up the temporary renderer bundle after publishing failed.");
      }
    }
  }
  if (failure) throw failure;
}

export function rendererDependencyGuardPlugin(root, outfile) {
  if (typeof root !== "string" || !path.isAbsolute(root) || !path.isAbsolute(outfile)
    || key(outfile) !== key(path.join(root, "media/chatViewShiki.bundle.js"))) fail("The renderer guard requires the expected project bundle output.");
  const entry = path.join(root, "scripts/chatViewShiki.entry.js");
  return {
    name: pluginName,
    setup(build) {
      if (build.initialOptions.write !== false || build.initialOptions.metafile !== true
        || build.initialOptions.plugins?.at(-1)?.name !== pluginName) fail("The renderer guard must run last with write:false and metafile:true.");
      let validation;
      let validationError;
      build.onStart(() => {
        validation = undefined;
        validationError = undefined;
        try { validation = validateRendererDependencies(root); }
        catch (error) { validationError = error; }
      });
      build.onLoad({ filter: /[\\/]chatViewShiki\.entry\.js$/ }, args => {
        if (key(args.path) !== key(entry)) return;
        const watchFiles = [...new Set([...baseWatchFiles(root), ...(validation?.watchFiles || [])])];
        const watchDirs = [path.join(root, "node_modules"), path.join(root, "node_modules/mermaid"), path.join(root, "node_modules/mermaid/node_modules"), path.join(root, "node_modules/@azure/identity")];
        if (validationError) return { errors: [{ text: validationError.message }], watchFiles, watchDirs };
        return { contents: readBytes(root, entry).toString("utf8"), loader: "js", resolveDir: path.dirname(entry), watchFiles, watchDirs };
      });
      build.onEnd(result => {
        if (result.errors.length > 0) return;
        try {
          if (!validation || validationError) fail(validationError?.message || "Renderer dependencies were not verified for this build.");
          const unchanged = () => {
            if (validateRendererDependencies(root).fingerprint !== validation.fingerprint) fail("Renderer dependencies changed during the build. Rebuild with a stable dependency set.");
          };
          unchanged();
          const contents = validateRendererBundle(result, validation, outfile);
          publishBundleAtomically(outfile, contents, unchanged);
        } catch (error) {
          return { errors: [{ text: error.message }] };
        }
      });
    },
  };
}
