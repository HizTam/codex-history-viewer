/* eslint-disable no-console */
const fs = require("node:fs");
const path = require("node:path");

const targetPairs = [
  {
    name: "runtime",
    en: "l10n/bundle.l10n.json",
    ja: "l10n/bundle.l10n.ja.json",
  },
  {
    name: "manifest",
    en: "package.nls.json",
    ja: "package.nls.ja.json",
  },
];

// Detect patterns that are likely mojibake.
const suspiciousPatterns = [
  /\uFFFD/u, // replacement character
  /\u7AB6\uFF66/u,
  /\u7E67/u,
];

let failed = false;
const bundles = new Map();

for (const pair of targetPairs) {
  for (const rel of [pair.en, pair.ja]) {
    const full = path.join(process.cwd(), rel);
    if (!fs.existsSync(full)) {
      failed = true;
      console.error(`[check:l10n] Missing localization file: ${rel}`);
      continue;
    }
    const text = fs.readFileSync(full, "utf8");

    // Validate JSON syntax and the expected flat string map shape.
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      failed = true;
      console.error(`[check:l10n] Invalid JSON: ${rel}`);
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      failed = true;
      console.error(`[check:l10n] Localization file must contain an object: ${rel}`);
      continue;
    }
    const invalidValueKeys = Object.entries(parsed)
      .filter(([, value]) => typeof value !== "string")
      .map(([key]) => key);
    if (invalidValueKeys.length > 0) {
      failed = true;
      for (const key of invalidValueKeys) {
        console.error(`[check:l10n] Localization value must be a string: ${rel}: ${key}`);
      }
      continue;
    }
    bundles.set(rel, parsed);

    const hasSuspicious = suspiciousPatterns.some((re) => re.test(text));
    if (hasSuspicious) {
      failed = true;
      console.error(`[check:l10n] Suspicious mojibake pattern found: ${rel}`);
    }
  }
}

function placeholderSignature(value) {
  return [...value.matchAll(/\{(\d+)\}/gu)]
    .map((match) => Number(match[1]))
    .sort((left, right) => left - right)
    .join(",");
}

for (const pair of targetPairs) {
  const enBundle = bundles.get(pair.en);
  const jaBundle = bundles.get(pair.ja);
  if (!enBundle || !jaBundle) continue;

  const enKeys = Object.keys(enBundle);
  const jaKeys = Object.keys(jaBundle);
  const enKeySet = new Set(enKeys);
  const jaKeySet = new Set(jaKeys);

  for (const key of enKeys) {
    if (!jaKeySet.has(key)) {
      failed = true;
      console.error(`[check:l10n] Missing Japanese key (${pair.name}): ${key}`);
      continue;
    }
    const enSignature = placeholderSignature(enBundle[key]);
    const jaSignature = placeholderSignature(jaBundle[key]);
    if (enSignature !== jaSignature) {
      failed = true;
      console.error(
        `[check:l10n] Placeholder mismatch (${pair.name}): ${key} (en: ${enSignature || "none"}, ja: ${jaSignature || "none"})`,
      );
    }
  }

  for (const key of jaKeys) {
    if (enKeySet.has(key)) continue;
    failed = true;
    console.error(`[check:l10n] Missing English key (${pair.name}): ${key}`);
  }
}

if (failed) {
  process.exitCode = 1;
  console.error("[check:l10n] Failed.");
} else {
  console.log("[check:l10n] OK");
}
