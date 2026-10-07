// Validate static calls and explicitly catalogued dynamic runtime key sets.
import fs from "node:fs";
import ts from "typescript";
const config = JSON.parse(fs.readFileSync("localization/catalog.config.json", "utf8"));
const pack = JSON.parse(fs.readFileSync(`localization/locales/${config.defaultLocale}.json`, "utf8"));
const usage = JSON.parse(fs.readFileSync("localization/key-usage.json", "utf8"));
const webview = JSON.parse(fs.readFileSync("localization/webview-keys.json", "utf8"));
const errors = [];
const check = (key, file) => { if (!Object.hasOwn(pack.runtime, key)) errors.push(file + ": unknown runtime key " + key); };
for (const row of usage.dynamicRuntime) for (const key of row.keys) check(key, row.file);
const seen = new Set();
for (const relative of fs.readdirSync("src", { recursive: true }).filter(p => p.endsWith(".ts") && !p.startsWith("generated"))) {
  const file = "src/" + relative.replaceAll("\\", "/");
  const source = fs.readFileSync(file, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const inspectKey = expression => {
    if (ts.isStringLiteral(expression)) check(expression.text, file);
    else if (ts.isConditionalExpression(expression)) { inspectKey(expression.whenTrue); inspectKey(expression.whenFalse); }
    else {
      const text = expression.getText(ast).replace(/\s+/g, " ");
      const row = usage.dynamicRuntime.find(row => row.file === file && row.expression === text);
      if (!row || !row.keys.length) errors.push(file + ": uncatalogued dynamic runtime key " + text);
      else seen.add(row);
    }
  };
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "t" && node.arguments.length) inspectKey(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(ast);
}
for (const row of usage.dynamicRuntime) if (!seen.has(row)) errors.push(row.file + ": stale dynamic key entry " + row.expression);
for (const [panel, map] of Object.entries(webview.panels)) for (const key of Object.values(map)) check(key, panel);
const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
const nls = JSON.parse(fs.readFileSync("package.nls.json", "utf8"));
const visitManifest = value => {
  if (typeof value === "string" && /^%[^%]+%$/.test(value) && !Object.hasOwn(nls, value.slice(1, -1))) errors.push("Unknown manifest message key: " + value);
  else if (Array.isArray(value)) value.forEach(visitManifest);
  else if (value && typeof value === "object") Object.values(value).forEach(visitManifest);
};
visitManifest(manifest.contributes);
if (errors.length) { process.stderr.write(errors.join("\n") + "\n"); process.exitCode = 1; }
else process.stdout.write("Localization key usage verified\n");
