import { build, context } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const buildOptions = {
  entryPoints: [path.join(__dirname, "chatViewShiki.entry.js")],
  outfile: path.join(rootDir, "media", "chatViewShiki.bundle.js"),
  bundle: true,
  charset: "utf8",
  format: "iife",
  globalName: "CodexHistoryViewerShikiBundle",
  legalComments: "eof",
  minify: true,
  platform: "browser",
  target: ["chrome114"],
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await context(buildOptions);
  await ctx.watch();
  console.log("Watching Shiki webview bundle...");
} else {
  await build(buildOptions);
}
