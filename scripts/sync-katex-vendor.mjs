import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRootDir = path.resolve(path.dirname(scriptPath), "..");
const exactVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const portableFontNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*\.woff2$/u;
const maxAssetBytes = 16 * 1024 * 1024;
const maxTotalBytes = 64 * 1024 * 1024;

const fixedAssets = [
  {
    source: "node_modules/katex/dist/katex.min.js",
    destination: "media/vendor/katex/katex.min.js",
  },
  {
    source: "node_modules/katex/dist/katex.min.css",
    destination: "media/vendor/katex/katex.min.css",
  },
  {
    source: "node_modules/katex/LICENSE",
    destination: "media/vendor/katex/LICENSE",
  },
];

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toDisplayPath(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function errorCode(error) {
  return error && typeof error === "object" && typeof error.code === "string"
    ? error.code
    : "UNKNOWN";
}

function readBuffer(fullPath, displayPath) {
  try {
    return readFileSync(fullPath);
  } catch (error) {
    throw new Error(`Unable to read ${displayPath} (${errorCode(error)}).`);
  }
}

function readJson(rootDir, relativePath) {
  const fullPath = path.join(rootDir, relativePath);
  let text;
  try {
    text = readFileSync(fullPath, "utf8");
  } catch (error) {
    throw new Error(`Unable to read ${toDisplayPath(relativePath)} (${errorCode(error)}).`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON in ${toDisplayPath(relativePath)}.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${toDisplayPath(relativePath)} must contain a JSON object.`);
  }
  return parsed;
}

function readPinnedVersion(rootDir) {
  const manifest = readJson(rootDir, "package.json");
  const declaredVersion = manifest.devDependencies?.katex;
  if (typeof declaredVersion !== "string" || !exactVersionPattern.test(declaredVersion)) {
    throw new Error(
      "package.json must pin devDependencies.katex to an exact version without range syntax.",
    );
  }

  const lock = readJson(rootDir, "package-lock.json");
  const lockRootVersion = lock.packages?.[""]?.devDependencies?.katex;
  const lockInstalledVersion = lock.packages?.["node_modules/katex"]?.version;
  if (lockRootVersion !== declaredVersion || lockInstalledVersion !== declaredVersion) {
    throw new Error(
      `package-lock.json does not match the pinned KaTeX version ${declaredVersion}. Run npm install and review the lockfile.`,
    );
  }

  const installedPackageRelativeDir = "node_modules/katex";
  const installedPackageDir = path.join(rootDir, installedPackageRelativeDir);
  let installedPackageStat;
  try {
    installedPackageStat = lstatSync(installedPackageDir);
  } catch (error) {
    throw new Error(
      `Unable to inspect ${installedPackageRelativeDir} (${errorCode(error)}).`,
    );
  }
  if (!installedPackageStat.isDirectory() || installedPackageStat.isSymbolicLink()) {
    throw new Error(`${installedPackageRelativeDir} must be a regular directory.`);
  }

  const installedManifest = readJson(rootDir, `${installedPackageRelativeDir}/package.json`);
  if (installedManifest.name !== "katex" || installedManifest.version !== declaredVersion) {
    throw new Error(
      `node_modules/katex does not match the pinned version ${declaredVersion}. Run npm install before checking vendor assets.`,
    );
  }
  return declaredVersion;
}

function assertRegularFile(fullPath, displayPath) {
  let stat;
  try {
    stat = lstatSync(fullPath);
  } catch (error) {
    throw new Error(`Unable to inspect ${displayPath} (${errorCode(error)}).`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${displayPath} must be a regular file.`);
  }
  if (stat.size <= 0 || stat.size > maxAssetBytes) {
    throw new Error(`${displayPath} has an invalid size (${stat.size} bytes).`);
  }
  return stat.size;
}

function loadAssets(rootDir) {
  const sourceFontRelativeDir = "node_modules/katex/dist/fonts";
  const sourceFontDir = path.join(rootDir, sourceFontRelativeDir);
  let sourceFontStat;
  try {
    sourceFontStat = lstatSync(sourceFontDir);
  } catch (error) {
    throw new Error(`Unable to inspect ${sourceFontRelativeDir} (${errorCode(error)}).`);
  }
  if (!sourceFontStat.isDirectory() || sourceFontStat.isSymbolicLink()) {
    throw new Error(`${sourceFontRelativeDir} must be a regular directory.`);
  }

  let fontEntries;
  try {
    fontEntries = readdirSync(sourceFontDir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Unable to read ${sourceFontRelativeDir} (${errorCode(error)}).`);
  }

  const fontNames = [];
  const portableFontNames = new Set();
  for (const entry of fontEntries) {
    if (!entry.name.toLowerCase().endsWith(".woff2")) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(
        `${sourceFontRelativeDir}/${JSON.stringify(entry.name)} must be a regular file.`,
      );
    }
    if (!portableFontNamePattern.test(entry.name)) {
      throw new Error(`Unsupported KaTeX font name: ${JSON.stringify(entry.name)}.`);
    }
    const portableName = entry.name.toLowerCase();
    if (portableFontNames.has(portableName)) {
      throw new Error(`Case-insensitive duplicate KaTeX font name: ${JSON.stringify(entry.name)}.`);
    }
    portableFontNames.add(portableName);
    fontNames.push(entry.name);
  }
  fontNames.sort(compareAscii);
  if (fontNames.length === 0) {
    throw new Error(`${sourceFontRelativeDir} does not contain any .woff2 files.`);
  }

  const assetSpecs = [
    ...fixedAssets,
    ...fontNames.map((fontName) => ({
      source: `${sourceFontRelativeDir}/${fontName}`,
      destination: `media/vendor/katex/fonts/${fontName}`,
    })),
  ];

  let totalBytes = 0;
  const assets = assetSpecs.map((asset) => {
    const sourcePath = path.join(rootDir, asset.source);
    const expectedSize = assertRegularFile(sourcePath, asset.source);
    const content = readBuffer(sourcePath, asset.source);
    if (content.length !== expectedSize) {
      throw new Error(`${asset.source} changed while it was being read.`);
    }
    totalBytes += content.length;
    if (totalBytes > maxTotalBytes) {
      throw new Error(`KaTeX vendor assets exceed the ${maxTotalBytes}-byte safety limit.`);
    }
    return {
      ...asset,
      content,
    };
  });

  return { assets, fontNames };
}

function inspectDestination(rootDir, assets, fontNames) {
  const issues = [];
  const destinationRootRelativeDir = "media/vendor/katex";
  const destinationRootDir = path.join(rootDir, destinationRootRelativeDir);
  if (existsSync(destinationRootDir)) {
    let stat;
    try {
      stat = lstatSync(destinationRootDir);
    } catch (error) {
      issues.push(
        `unable to inspect: ${destinationRootRelativeDir} (${errorCode(error)})`,
      );
      return issues;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      issues.push(`not a regular directory: ${destinationRootRelativeDir}`);
      return issues;
    }
  }

  for (const asset of assets) {
    const destinationPath = path.join(rootDir, asset.destination);
    if (!existsSync(destinationPath)) {
      issues.push(`missing: ${asset.destination}`);
      continue;
    }

    let stat;
    try {
      stat = lstatSync(destinationPath);
    } catch (error) {
      issues.push(`unable to inspect: ${asset.destination} (${errorCode(error)})`);
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      issues.push(`not a regular file: ${asset.destination}`);
      continue;
    }
    let destinationContent;
    try {
      destinationContent = readFileSync(destinationPath);
    } catch (error) {
      issues.push(`unable to read: ${asset.destination} (${errorCode(error)})`);
      continue;
    }
    if (!asset.content.equals(destinationContent)) {
      issues.push(`content differs: ${asset.destination}`);
    }
  }

  const destinationFontRelativeDir = "media/vendor/katex/fonts";
  const destinationFontDir = path.join(rootDir, destinationFontRelativeDir);
  if (!existsSync(destinationFontDir)) return issues;

  let destinationFontStat;
  try {
    destinationFontStat = lstatSync(destinationFontDir);
  } catch (error) {
    issues.push(`unable to inspect: ${destinationFontRelativeDir} (${errorCode(error)})`);
    return issues;
  }
  if (!destinationFontStat.isDirectory() || destinationFontStat.isSymbolicLink()) {
    issues.push(`not a regular directory: ${destinationFontRelativeDir}`);
    return issues;
  }

  const fontNameSet = new Set(fontNames);
  let destinationFontEntries;
  try {
    destinationFontEntries = readdirSync(destinationFontDir, { withFileTypes: true });
  } catch (error) {
    issues.push(`unable to read: ${destinationFontRelativeDir} (${errorCode(error)})`);
    return issues;
  }
  for (const entry of destinationFontEntries) {
    if (!entry.name.toLowerCase().endsWith(".woff2") || fontNameSet.has(entry.name)) continue;
    const displayName = portableFontNamePattern.test(entry.name)
      ? entry.name
      : JSON.stringify(entry.name);
    issues.push(`unexpected font: ${destinationFontRelativeDir}/${displayName}`);
  }
  return issues;
}

function ensureDestinationDirectory(fullPath, displayPath) {
  if (!existsSync(fullPath)) {
    try {
      mkdirSync(fullPath, { recursive: true });
    } catch (error) {
      throw new Error(`Unable to create ${displayPath} (${errorCode(error)}).`);
    }
    return;
  }
  let stat;
  try {
    stat = lstatSync(fullPath);
  } catch (error) {
    throw new Error(`Unable to inspect ${displayPath} (${errorCode(error)}).`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${displayPath} must be a regular directory.`);
  }
}

function writeAssets(rootDir, assets, fontNames) {
  const destinationRootRelativeDir = "media/vendor/katex";
  const destinationFontRelativeDir = `${destinationRootRelativeDir}/fonts`;
  const destinationRootDir = path.join(rootDir, destinationRootRelativeDir);
  const destinationFontDir = path.join(rootDir, destinationFontRelativeDir);
  ensureDestinationDirectory(destinationRootDir, destinationRootRelativeDir);
  ensureDestinationDirectory(destinationFontDir, destinationFontRelativeDir);

  // Validate every existing destination before making any changes.
  for (const asset of assets) {
    const destinationPath = path.join(rootDir, asset.destination);
    if (existsSync(destinationPath)) {
      let stat;
      try {
        stat = lstatSync(destinationPath);
      } catch (error) {
        throw new Error(`Unable to inspect ${asset.destination} (${errorCode(error)}).`);
      }
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`${asset.destination} must be a regular file.`);
      }
    }
  }

  const fontNameSet = new Set(fontNames);
  const extraFontPaths = [];
  let destinationFontEntries;
  try {
    destinationFontEntries = readdirSync(destinationFontDir, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      `Unable to read ${destinationFontRelativeDir} (${errorCode(error)}).`,
    );
  }
  for (const entry of destinationFontEntries) {
    if (!entry.name.toLowerCase().endsWith(".woff2") || fontNameSet.has(entry.name)) continue;
    const extraFontPath = path.join(destinationFontDir, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(
        `${destinationFontRelativeDir}/${JSON.stringify(entry.name)} must be a regular file.`,
      );
    }
    extraFontPaths.push(extraFontPath);
  }

  for (const asset of assets) {
    try {
      copyFileSync(path.join(rootDir, asset.source), path.join(rootDir, asset.destination));
    } catch (error) {
      throw new Error(`Unable to copy ${asset.destination} (${errorCode(error)}).`);
    }
  }
  for (const extraFontPath of extraFontPaths) {
    try {
      rmSync(extraFontPath);
    } catch (error) {
      throw new Error(
        `Unable to remove stale KaTeX font (${errorCode(error)}).`,
      );
    }
  }
}

export function manageKatexVendor({ rootDir = defaultRootDir, mode }) {
  if (mode !== "check" && mode !== "write") {
    throw new Error('mode must be either "check" or "write".');
  }
  const resolvedRootDir = path.resolve(rootDir);
  const version = readPinnedVersion(resolvedRootDir);
  const { assets, fontNames } = loadAssets(resolvedRootDir);

  if (mode === "write") {
    writeAssets(resolvedRootDir, assets, fontNames);
  }

  const issues = inspectDestination(resolvedRootDir, assets, fontNames);
  if (issues.length > 0) {
    const detail = issues.map((issue) => `  - ${issue}`).join("\n");
    throw new Error(
      `Bundled KaTeX does not match installed KaTeX ${version}:\n${detail}\nRun "npm run sync:katex" and review the resulting vendor changes.`,
    );
  }
  return { version, assetCount: assets.length };
}

function runCli() {
  const argumentsList = process.argv.slice(2);
  if (
    argumentsList.length !== 1 ||
    (argumentsList[0] !== "--check" && argumentsList[0] !== "--write")
  ) {
    throw new Error("Usage: node scripts/sync-katex-vendor.mjs --check|--write");
  }

  const mode = argumentsList[0] === "--write" ? "write" : "check";
  const result = manageKatexVendor({ mode });
  const action = mode === "write" ? "Synchronized" : "OK";
  const commandName = mode === "write" ? "sync:katex" : "check:katex";
  console.log(
    `[${commandName}] ${action} (KaTeX ${result.version}; ${result.assetCount} vendor files).`,
  );
}

if (path.resolve(process.argv[1] || "") === scriptPath) {
  try {
    runCli();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[katex:vendor] ${message}`);
    process.exitCode = 1;
  }
}
