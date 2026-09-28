import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Bundle the portable decoder so older CommonJS extension hosts need no ESM loader or native addon.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = process.argv[2] ?? path.join(root, "dist/vendor/zstd.cjs");
// Derive the license banner from the installed package; retain the manifest's exact dependency pin.
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const decoder = JSON.parse(await readFile(path.join(root, "node_modules/@hpcc-js/wasm-zstd/package.json"), "utf8"));
const decoderVersion = decoder?.version;
if (decoder?.name !== "@hpcc-js/wasm-zstd" || typeof decoderVersion !== "string" || decoderVersion.length > 64 ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(decoderVersion) ||
    decoderVersion !== manifest?.dependencies?.["@hpcc-js/wasm-zstd"]) {
  throw new Error("The portable decoder package does not match the pinned dependency version.");
}
await build({
  absWorkingDir: root,
  entryPoints: ["@hpcc-js/wasm-zstd"],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  minify: true,
  legalComments: "inline",
  banner: { js: `/* @hpcc-js/wasm-zstd ${decoderVersion}; licenses: resources/licenses/wasm-zstd.txt */` },
});
