// Compatibility entry point: validate every bundled language and all generated assets.
const { spawnSync } = require("node:child_process");
for (const args of [["scripts/generate-localization.mjs", "--check"], ["scripts/check-localization-usage.mjs"]]) {
  const result = spawnSync(process.execPath, args, { stdio: "inherit", windowsHide: true });
  if (result.error || result.status !== 0) { process.exitCode = 1; break; }
}
