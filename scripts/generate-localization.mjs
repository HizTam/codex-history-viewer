// Generate all locale-dependent assets from validated, repository-owned data.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const json = value => JSON.stringify(value, null, 2) + "\n";
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const fail = message => { throw new Error(message); };
let totalInputBytes = 0;

function safePath(relative) {
  if (typeof relative !== "string" || path.isAbsolute(relative) || relative.includes("\\") || relative.split("/").some(s => !s || s === "." || s === "..")) fail("Unsafe localization path");
  const absolute = path.resolve(root, relative);
  let cursor = root;
  for (const part of relative.split("/")) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) continue;
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink() || !fs.realpathSync(cursor).toLowerCase().startsWith(root.toLowerCase() + path.sep)) fail("Linked localization path: " + relative);
  }
  return absolute;
}

function parseJson(relative, limit = 4 * 1024 * 1024) {
  const absolute = safePath(relative);
  const stat = fs.statSync(absolute);
  if (!stat.isFile() || stat.size > limit) fail("Invalid localization file size/type: " + relative);
  totalInputBytes += stat.size;
  if (totalInputBytes > 32 * 1024 * 1024) fail("Localization inputs exceed 32 MiB");
  const bytes = fs.readFileSync(absolute);
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (text.startsWith("\uFEFF") || text.includes("\r") || text.includes("\uFFFD")) fail("Localization requires UTF-8 without BOM and LF: " + relative);
  const parsed = JSON.parse(text);
  const ast = ts.parseJsonText(relative, text);
  const visit = node => {
    if (ts.isObjectLiteralExpression(node)) {
      const names = new Set();
      for (const property of node.properties) {
        const name = property.name?.text;
        if (typeof name !== "string" || names.has(name) || forbidden.has(name)) fail("Duplicate/unsafe JSON key in " + relative);
        names.add(name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return parsed;
}

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Expected object: " + name);
  return value;
}

function fields(value, allowed, name) {
  object(value, name);
  if (Object.keys(value).some(key => !allowed.includes(key))) fail("Unknown field: " + name);
  if (value.schemaVersion !== 1) fail("Unsupported schema: " + name);
}

function localeId(value) {
  if (typeof value !== "string" || value.length > 63 || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(value)) fail("Invalid locale ID");
  let result;
  try {
    const canonical = Intl.getCanonicalLocales(value)[0];
    if (new Intl.Locale(canonical).baseName !== canonical) fail("Locale extensions are unsupported");
    result = canonical.toLowerCase();
  } catch { fail("Invalid locale ID: " + value); }
  if (result === "auto") fail("Reserved locale ID");
  return result;
}

function checkTranslationText(text, locale, name) {
  // Japanese mojibake heuristics must not reject legitimate characters in other languages.
  if (/\?{3,}/u.test(text) || (new Intl.Locale(locale).language === "ja" && /\u7AB6\uFF66|\u7E67/u.test(text))) fail("Suspected garbled translation: " + name);
}

function stringMap(value, name, locale) {
  object(value, name);
  for (const [key, text] of Object.entries(value)) {
    if (!key || forbidden.has(key) || typeof text !== "string" || text.length === 0 || text.length > 64000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/u.test(text)) fail("Invalid translation: " + name + "." + key);
    if (key.startsWith("generated.")) fail("Reserved translation namespace: " + key);
    checkTranslationText(text, locale, name + "." + key);
  }
}

const placeholders = value => [...value.matchAll(/\{\d+\}/g)].map(m => m[0]).sort().join(",");
function completeMap(pack, baseline, section) {
  const supplied = pack[section];
  stringMap(supplied, pack.locale + "." + section, pack.locale);
  for (const [key, value] of Object.entries(supplied)) {
    if (!Object.hasOwn(baseline, key)) fail("Unknown translation key: " + pack.locale + "." + key);
    if (placeholders(value) !== placeholders(baseline[key])) fail("Placeholder mismatch: " + pack.locale + "." + key);
  }
  const missing = Object.keys(baseline).filter(key => !Object.hasOwn(supplied, key));
  if (missing.length && pack.completeness === "complete") fail("Missing translations: " + pack.locale + "." + section + " (" + missing.length + ")");
  if (missing.length) process.stdout.write(`${pack.locale}: ${section} default translations: ${missing.length}\n`);
  return { ...baseline, ...supplied };
}

function packageParts(pkg) {
  const language = pkg.contributes.configuration.properties["codexHistoryViewer.ui.language"];
  return { commands: pkg.contributes.commands, submenus: pkg.contributes.submenus, menus: pkg.contributes.menus, language: Object.fromEntries(["enum", "enumItemLabels", "enumDescriptions"].map(key => [key, language[key]])) };
}

function displayName(display, selected) {
  try {
    if (Intl.DisplayNames.supportedLocalesOf([display]).length) {
      const value = new Intl.DisplayNames([display], { type: "language", fallback: "none" }).of(selected.locale);
      if (value) return value;
    }
  } catch { /* Use the pack's safe native name when ICU has no language data. */ }
  return selected.nativeName || selected.locale;
}

function calculate() {
  const requiredNode = fs.readFileSync(safePath(".node-version"), "utf8").trim();
  if (process.versions.node !== requiredNode) fail("Localization generation requires Node " + requiredNode + " (current: " + process.versions.node + "); use the version in .node-version. See DEVELOPMENT.ja.md.");
  if (process.versions.icu !== "77.1") fail("Localization generation requires ICU 77.1 (current: " + process.versions.icu + "); use the official Node build specified in .node-version. See DEVELOPMENT.ja.md.");
  const config = parseJson("localization/catalog.config.json");
  fields(config, ["schemaVersion", "defaultLocale"], "catalog");
  const defaultLocale = localeId(config.defaultLocale);
  const packs = fs.readdirSync(safePath("localization/locales")).filter(name => name.endsWith(".json")).sort().map(name => {
    const pack = parseJson("localization/locales/" + name);
    fields(pack, ["schemaVersion", "locale", "nativeName", "order", "aliases", "completeness", "manifest", "runtime"], name);
    if (pack.locale !== localeId(pack.locale) || name !== pack.locale + ".json") fail("Locale filename/canonical ID mismatch: " + name);
    if (typeof pack.nativeName !== "string" || !pack.nativeName.trim() || pack.nativeName.length > 128 || /[\u0000-\u001f\u007f-\u009f]/u.test(pack.nativeName)) fail("Invalid nativeName: " + name);
    checkTranslationText(pack.nativeName, pack.locale, name + ".nativeName");
    if (pack.order !== undefined && (!Number.isInteger(pack.order) || pack.order < 0 || pack.order > 10000)) fail("Invalid locale order: " + name);
    if (Object.hasOwn(pack, "completeness") && !["complete", "partial"].includes(pack.completeness)) fail("Invalid completeness: " + name);
    if (pack.aliases !== undefined && !Array.isArray(pack.aliases)) fail("Invalid aliases: " + name);
    // Normalize the field and its position without accepting explicit invalid values.
    return { completeness: "partial", ...pack };
  }).sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || (a.locale < b.locale ? -1 : a.locale > b.locale ? 1 : 0));
  const ids = packs.map(p => p.locale);
  if (new Set(ids).size !== ids.length) fail("Duplicate locale");
  const defaults = packs.find(p => p.locale === defaultLocale);
  if (!defaults || defaults.completeness !== "complete") fail("Default locale must be complete");
  stringMap(defaults.runtime, "default.runtime", defaultLocale);
  stringMap(defaults.manifest, "default.manifest", defaultLocale);
  const aliases = {};
  for (const pack of packs) for (const raw of pack.aliases ?? []) {
    const alias = localeId(raw);
    if (ids.includes(alias) || Object.hasOwn(aliases, alias)) fail("Locale/alias collision: " + alias);
    aliases[alias] = pack.locale;
  }
  const messages = Object.fromEntries(packs.map(pack => [pack.locale, { manifest: completeMap(pack, defaults.manifest, "manifest"), runtime: completeMap(pack, defaults.runtime, "runtime") }]));
  const ui = parseJson("localization/ui-contributions.json");
  fields(ui, ["schemaVersion", "commands", "submenus", "menus", "aliases"], "ui-contributions");
  const webview = parseJson("localization/webview-keys.json");
  fields(webview, ["schemaVersion", "panels"], "webview-keys");
  object(webview.panels, "panels");
  for (const [panel, keys] of Object.entries(webview.panels)) {
    object(keys, panel);
    for (const key of Object.values(keys)) if (typeof key !== "string" || !Object.hasOwn(defaults.runtime, key)) fail("Unknown webview runtime key: " + key);
  }
  const usage = parseJson("localization/key-usage.json");
  fields(usage, ["schemaVersion", "dynamicRuntime", "technicalLocales"], "key-usage");
  for (const row of usage.dynamicRuntime) {
    if (!Array.isArray(row.keys) || row.keys.length === 0 || row.keys.some(key => !Object.hasOwn(defaults.runtime, key))) fail("Unknown dynamic runtime key set");
  }
  for (const relative of fs.readdirSync(path.join(root, "src"), { recursive: true }).filter(name => name.endsWith(".ts") && !name.startsWith("generated"))) {
    const file = path.join(root, "src", relative);
    const ast = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const checkKey = expression => {
      if (ts.isStringLiteral(expression)) { if (!Object.hasOwn(defaults.runtime, expression.text)) fail("Unknown static runtime key: " + expression.text); }
      else if (ts.isConditionalExpression(expression)) { checkKey(expression.whenTrue); checkKey(expression.whenFalse); }
    };
    const visit = node => { if (ts.isCallExpression(node) && node.expression.getText(ast) === "t" && node.arguments.length) checkKey(node.arguments[0]); ts.forEachChild(node, visit); };
    visit(ast);
  }
  const fingerprint = hash(JSON.stringify({ config, packs, ui, webview, usage, schema: 1, node: requiredNode, icu: process.versions.icu }));
  const outputs = new Map();
  const names = Object.fromEntries(packs.map(display => [display.locale, Object.fromEntries(packs.map(selected => [selected.locale, displayName(display.locale, selected)]))]));
  const commonManifest = {};
  const localeCondition = locale => locale === defaultLocale ? ids.filter(id => id !== defaultLocale).map(id => `codexHistoryViewer.uiLang != '${id}'`).join(" && ") || "true" : `codexHistoryViewer.uiLang == '${locale}'`;
  const substitute = (value, locale) => {
    if (typeof value === "string") return value.replaceAll("{locale}", locale).replaceAll("{localeCondition}", "(" + localeCondition(locale) + ")");
    if (Array.isArray(value)) return value.map(v => substitute(v, locale));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, locale)]));
    return value;
  };
  const expand = (rows, kind) => {
    if (!Array.isArray(rows)) fail("Invalid UI rows: " + kind);
    return rows.flatMap(row => {
      if (typeof row.expandLocales !== "boolean") fail("Missing explicit locale expansion");
      return (row.expandLocales ? ids : [defaultLocale]).map(locale => {
        const value = substitute(row.value, locale);
        if (!value || typeof value !== "object") fail("Invalid UI definition");
        if (row.titleKey) {
          const text = messages[locale].manifest[row.titleKey];
          if (!text) fail("Missing UI title key: " + row.titleKey);
          const key = "generated.ui." + locale + "." + kind + "." + row.titleKey.replace(/^ui\.(?:command|submenu)\./, "");
          commonManifest[key] = text;
          value[kind === "command" ? "title" : "label"] = "%" + key + "%";
        }
        return { value, menu: row.menu ? substitute(row.menu, locale) : undefined };
      });
    });
  };
  const commands = expand(ui.commands, "command").map(row => row.value);
  const submenus = expand(ui.submenus, "submenu").map(row => row.value);
  const menus = {};
  for (const row of expand(ui.menus, "menu")) (menus[row.menu] ??= []).push(row.value);
  for (const [list, property] of [[commands, "command"], [submenus, "id"]]) if (new Set(list.map(item => item[property])).size !== list.length) fail("Duplicate UI contribution ID");
  const commandAliases = ui.aliases.flatMap(row => (row.expandLocales ? ids : [defaultLocale]).map(locale => ({ id: substitute(row.id, locale), target: row.target })));
  if (new Set(commandAliases.map(a => a.id)).size !== commandAliases.length || commandAliases.some(a => typeof a.id !== "string" || typeof a.target !== "string" || !commands.some(c => c.command === a.id) || !/^codexHistoryViewer\.[a-zA-Z0-9.]+$/.test(a.target))) fail("Invalid UI command alias");
  const catalog = [];
  for (const pack of packs) {
    const locale = pack.locale;
    const bundleFile = locale === defaultLocale ? "bundle.l10n.json" : `bundle.l10n.${locale}.json`;
    const bundleText = json(messages[locale].runtime);
    outputs.set("l10n/" + bundleFile, bundleText);
    catalog.push({ locale, nativeName: pack.nativeName, names: names[locale], bundleFile, bundleSha256: hash(bundleText) });
    const manifest = { ...messages[locale].manifest, ...commonManifest };
    for (const id of ids) {
      manifest["generated.locale." + id + ".label"] = names[locale][id];
      const template = messages[locale].runtime["localization.languageDescription"];
      if (!template) fail("Missing localization.languageDescription");
      manifest["generated.locale." + id + ".description"] = template.replaceAll("{0}", names[locale][id]);
    }
    const verifyReferences = value => {
      if (typeof value === "string" && /^%[^%]+%$/.test(value) && !Object.hasOwn(manifest, value.slice(1, -1))) fail("Unknown manifest reference: " + value);
      else if (Array.isArray(value)) value.forEach(verifyReferences);
      else if (value && typeof value === "object") Object.values(value).forEach(verifyReferences);
    };
    verifyReferences({ commands, submenus, menus });
    for (const tag of [locale, ...Object.keys(aliases).filter(a => aliases[a] === locale)]) outputs.set(`package.nls.${tag}.json`, json(manifest));
    if (locale === defaultLocale) outputs.set("package.nls.json", json(manifest));
  }
  const header = "// Generated by scripts/generate-localization.mjs. Edit localization sources instead.\n";
  outputs.set("src/generated/localeCatalog.ts", header + `export const DEFAULT_LOCALE = ${JSON.stringify(defaultLocale)} as const;\nexport const SUPPORTED_LOCALES = ${JSON.stringify(ids)} as const;\nexport type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];\nexport const LOCALE_ALIASES: Readonly<Record<string, SupportedLocale>> = ${json(aliases).trim()};\nexport const LOCALE_CATALOG = ${json(catalog).trim()} as const;\nexport const LOCALIZATION_FINGERPRINT = ${JSON.stringify(fingerprint)};\n`);
  outputs.set("src/generated/defaultRuntimeMessages.ts", header + "export const DEFAULT_RUNTIME_MESSAGES: Readonly<Record<string, string>> = " + json(defaults.runtime).trim() + ";\n");
  outputs.set("src/generated/uiCommandAliases.ts", header + "export const UI_COMMAND_ALIASES = " + json(commandAliases).trim() + " as const;\n");
  outputs.set("src/generated/webviewI18n.ts", header + "export const WEBVIEW_I18N_KEYS = " + json(webview.panels).trim() + " as const;\nexport type LocalizedPanelKind = keyof typeof WEBVIEW_I18N_KEYS;\n");
  const defaultPanels = Object.fromEntries(Object.entries(webview.panels).map(([panel, keys]) => [panel, Object.fromEntries(Object.entries(keys).map(([prop, key]) => [prop, defaults.runtime[key]]))]));
  const browserData = JSON.stringify({ schemaVersion: 1, fingerprint, defaultLocale, locales: ids, aliases, panels: defaultPanels, runtime: defaults.runtime }).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  outputs.set("media/generated/localization.js", header + `(function (root) {\n  "use strict";\n  const data = ${browserData};\n  const normalize = value => {\n    if (typeof value !== "string") return data.defaultLocale;\n    let id = value.toLowerCase();\n    while (id) { if (data.locales.includes(id)) return id; if (Object.hasOwn(data.aliases, id)) return data.aliases[id]; const at = id.lastIndexOf("-"); if (at < 0) break; id = id.slice(0, at); }\n    return data.defaultLocale;\n  };\n  const api = Object.freeze({ ...data, normalize });\n  if (typeof module === "object" && module.exports) module.exports = api;\n  else Object.defineProperty(root, "CHVLocalization", { value: api });\n})(globalThis);\n`);
  const pkg = parseJson("package.json");
  const oldPackageHash = hash(JSON.stringify(packageParts(pkg)));
  Object.assign(pkg.contributes, { commands, submenus, menus });
  const language = pkg.contributes.configuration.properties["codexHistoryViewer.ui.language"];
  language.enum = ["auto", ...ids];
  language.enumItemLabels = ["%cfg.uiLanguage.labelAuto%", ...ids.map(id => `%generated.locale.${id}.label%`)];
  language.enumDescriptions = ["%cfg.uiLanguage.enumAuto%", ...ids.map(id => `%generated.locale.${id}.description%`)];
  const packageHash = hash(JSON.stringify(packageParts(pkg)));
  outputs.set("package.json", json(pkg));
  if ([...outputs.values()].reduce((sum, text) => sum + Buffer.byteLength(text), 0) > 64 * 1024 * 1024) fail("Generated localization assets exceed 64 MiB");
  const previous = parseJson("localization/generated-files.json");
  fields(previous, ["schemaVersion", "files", "packageHash"], "generated-files");
  const ownedPath = p => /^(?:package\.nls(?:\.[a-z0-9-]+)?\.json|l10n\/bundle\.l10n(?:\.[a-z0-9-]+)?\.json|src\/generated\/(?:localeCatalog|defaultRuntimeMessages|uiCommandAliases|webviewI18n)\.ts|media\/generated\/localization\.js)$/.test(p);
  for (const p of Object.keys(previous.files)) if (!ownedPath(p)) fail("Unsafe owned output path");
  const files = {};
  for (const [p, text] of outputs) {
    if (p === "package.json") {
      if (oldPackageHash !== previous.packageHash && oldPackageHash !== packageHash) fail("Hand-edited generated package subtree; edit ui-contributions instead");
      continue;
    }
    const absolute = safePath(p);
    const nextHash = hash(text);
    if (fs.existsSync(absolute)) {
      const currentHash = hash(fs.readFileSync(absolute));
      if (currentHash !== previous.files[p] && currentHash !== nextHash) fail("Hand-edited generated output: " + p);
    }
    files[p] = nextHash;
  }
  const obsolete = Object.keys(previous.files).filter(p => !outputs.has(p));
  for (const p of obsolete) if (fs.existsSync(safePath(p)) && hash(fs.readFileSync(safePath(p))) !== previous.files[p]) fail("Refusing to remove modified generated output: " + p);
  outputs.set("localization/generated-files.json", json({ schemaVersion: 1, files, packageHash }));
  return { outputs, obsolete, fingerprint };
}

const lockRecovery = " If another localization generator/watch is running, wait for it to finish. Otherwise, remove only .l10n-build/lock and run npm run generate:l10n. See DEVELOPMENT.ja.md.";

async function main() {
  if (!["--write", "--check"].includes(mode)) fail("Use --write or --check");
  if (mode === "--check") {
    if (fs.existsSync(path.join(root, ".l10n-build", "lock"))) fail("Localization generation is locked." + lockRecovery);
    const { outputs, obsolete } = calculate();
    const changed = [...outputs].filter(([p, text]) => !fs.existsSync(safePath(p)) || !fs.readFileSync(safePath(p)).equals(Buffer.from(text, "utf8")));
    if (changed.length || obsolete.length) fail("Stale localization assets; run npm run generate:l10n (" + [...changed.map(([p]) => p), ...obsolete].join(", ") + ")");
    process.stdout.write("Localization verified\n");
    return;
  }
  // A directory lock has bounded waiting and is never removed based only on a PID.
  const staging = safePath(".l10n-build");
  fs.mkdirSync(staging, { recursive: true });
  const lock = path.join(staging, "lock");
  const deadline = Date.now() + 30000;
  let acquired = false;
  try {
    while (!acquired) {
      try { fs.mkdirSync(lock); acquired = true; }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (Date.now() >= deadline) fail("Localization generation is locked after waiting 30 seconds." + lockRecovery);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    const { outputs, obsolete } = calculate();
    const changed = [...outputs].filter(([p, text]) => !fs.existsSync(safePath(p)) || !fs.readFileSync(safePath(p)).equals(Buffer.from(text, "utf8")));
    if (mode === "--check") {
      if (changed.length || obsolete.length) fail("Stale localization assets; run npm run generate:l10n (" + [...changed.map(([p]) => p), ...obsolete].join(", ") + ")");
    } else {
      // Validate every output before writing. Publish ownership last for crash recovery.
      for (const [p, text] of changed) {
        if (p === "localization/generated-files.json") continue;
        const destination = safePath(p);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const temporary = path.join(staging, crypto.randomBytes(12).toString("hex") + ".tmp");
        fs.writeFileSync(temporary, text, { encoding: "utf8", flag: "wx" });
        fs.renameSync(temporary, destination);
        if (p === "package.json") continue;
      }
      for (const p of obsolete) if (fs.existsSync(safePath(p))) fs.unlinkSync(safePath(p));
      const owner = "localization/generated-files.json";
      if (changed.some(([p]) => p === owner)) {
        const temporary = path.join(staging, crypto.randomBytes(12).toString("hex") + ".tmp");
        fs.writeFileSync(temporary, outputs.get(owner), { encoding: "utf8", flag: "wx" });
        fs.renameSync(temporary, safePath(owner));
      }
    }
    process.stdout.write("Localization " + (mode === "--check" ? "verified" : "generated") + "\n");
  } finally {
    if (acquired) fs.rmdirSync(lock);
  }
}

main().catch(error => { process.stderr.write("Localization: " + error.message + "\n"); process.exitCode = 1; });
