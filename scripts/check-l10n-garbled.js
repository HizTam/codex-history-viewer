/* eslint-disable no-console */
const fs = require("node:fs");
const path = require("node:path");

const targets = [
  "l10n/bundle.l10n.json",
  "l10n/bundle.l10n.ja.json",
  "package.nls.json",
  "package.nls.ja.json",
];

// Detect patterns that are likely mojibake.
const suspiciousPatterns = [
  /\uFFFD/u, // replacement character
  /窶ｦ/u,
  /繧/u,
];

let failed = false;

for (const rel of targets) {
  const full = path.join(process.cwd(), rel);
  if (!fs.existsSync(full)) continue;
  const text = fs.readFileSync(full, "utf8");

  // Validate JSON syntax.
  try {
    JSON.parse(text);
  } catch (err) {
    failed = true;
    console.error(`[check:l10n] Invalid JSON: ${rel}`);
    continue;
  }

  const hasSuspicious = suspiciousPatterns.some((re) => re.test(text));
  if (hasSuspicious) {
    failed = true;
    console.error(`[check:l10n] Suspicious mojibake pattern found: ${rel}`);
  }
}

if (failed) {
  process.exitCode = 1;
  console.error("[check:l10n] Failed.");
} else {
  console.log("[check:l10n] OK");
}
