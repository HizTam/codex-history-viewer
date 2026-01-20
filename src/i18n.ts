import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";

type UiLanguageSetting = "auto" | "en" | "ja";
type ResolvedUiLanguage = Exclude<UiLanguageSetting, "auto">;

type L10nBundle = Record<string, string>;

const bundleCache: Partial<Record<Exclude<UiLanguageSetting, "auto">, L10nBundle>> = {};

function readUiLanguageSetting(): UiLanguageSetting {
  const cfg = vscode.workspace.getConfiguration("codexHistoryViewer");
  const raw = (cfg.get<string>("ui.language") ?? "auto").trim().toLowerCase();
  if (raw === "en" || raw === "ja" || raw === "auto") return raw;
  return "auto";
}

export function resolveUiLanguage(setting: UiLanguageSetting = readUiLanguageSetting()): ResolvedUiLanguage {
  if (setting === "en" || setting === "ja") return setting;

  const envLang = typeof vscode.env.language === "string" ? vscode.env.language.trim().toLowerCase() : "";
  if (envLang.startsWith("ja")) return "ja";
  return "en";
}

function readBundleFile(lang: Exclude<UiLanguageSetting, "auto">): L10nBundle | null {
  const fileName = lang === "ja" ? "bundle.l10n.ja.json" : "bundle.l10n.json";
  const filePath = path.join(__dirname, "..", "l10n", fileName);
  try {
    const raw = fs.readFileSync(filePath, { encoding: "utf8" });
    const obj = JSON.parse(raw) as unknown;
    if (!obj || typeof obj !== "object") return null;
    const out: L10nBundle = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

function getBundle(lang: Exclude<UiLanguageSetting, "auto">): L10nBundle | null {
  const cached = bundleCache[lang];
  if (cached) return cached;
  const loaded = readBundleFile(lang);
  if (!loaded) return null;
  bundleCache[lang] = loaded;
  return loaded;
}

function formatPlaceholders(template: string, args: Array<string | number | boolean>): string {
  return template.replace(/\{(\d+)\}/g, (_m, g1) => {
    const idx = Number(g1);
    const v = args[idx];
    return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : `{${g1}}`;
  });
}

// Thin wrapper over VS Code localization with an optional per-extension UI language override.
export function t(key: string, ...args: Array<string | number | boolean>): string {
  const lang = resolveUiLanguage();
  const primary = getBundle(lang);
  const fallback = lang === "ja" ? getBundle("en") : null;
  const template = primary?.[key] ?? fallback?.[key];
  if (typeof template === "string") return formatPlaceholders(template, args);

  const viaVscode = vscode.l10n.t(key, ...args);
  if (viaVscode !== key) return viaVscode;

  const en = getBundle("en");
  const enTemplate = en?.[key];
  return typeof enTemplate === "string" ? formatPlaceholders(enTemplate, args) : viaVscode;
}
