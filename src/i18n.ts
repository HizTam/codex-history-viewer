import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { DEFAULT_RUNTIME_MESSAGES } from "./generated/defaultRuntimeMessages";
import { DEFAULT_LOCALE, LOCALE_CATALOG, resolveLocale, type SupportedLocale } from "./localization/localeCatalog";

type Bundle = Readonly<Record<string, string>>;
const bundleCache = new Map<SupportedLocale, Bundle | null>();
let warned = false;
let missingKeyWarned = false;
let currentLocale: SupportedLocale | undefined;
let localeRevision = 0;

function readBundle(locale: SupportedLocale): Bundle | null {
  if (bundleCache.has(locale)) return bundleCache.get(locale) ?? null;
  const entry = LOCALE_CATALOG.find(candidate => candidate.locale === locale);
  let result: Bundle | null = null;
  try {
    if (!entry) throw new Error("Unknown catalog locale");
    // Only generated filenames can reach the filesystem; settings never become paths.
    const filename = path.join(__dirname, "..", "l10n", entry.bundleFile);
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("Invalid bundle size");
    const bytes = fs.readFileSync(filename);
    if (createHash("sha256").update(bytes).digest("hex") !== entry.bundleSha256) throw new Error("Invalid bundle digest");
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.entries(parsed).some(([key, value]) => !Object.hasOwn(DEFAULT_RUNTIME_MESSAGES, key) || typeof value !== "string" || !value)) throw new Error("Invalid bundle map");
    if (Object.keys(parsed).length !== Object.keys(DEFAULT_RUNTIME_MESSAGES).length) throw new Error("Incomplete bundle map");
    result = Object.freeze(parsed as Record<string, string>);
  } catch {
    // Cache failures too, and report a payload-free diagnostic only once.
    if (!warned) {
      warned = true;
      console.warn("[localization] Bundled language data unavailable");
      void vscode.window.showWarningMessage(DEFAULT_RUNTIME_MESSAGES["localization.bundleUnavailable"]);
    }
  }
  bundleCache.set(locale, result);
  return result;
}

export function resolveUiLanguage(setting: unknown = vscode.workspace.getConfiguration("codexHistoryViewer").get<unknown>("ui.language")): SupportedLocale {
  const requested = resolveLocale(setting, vscode.env.language);
  const effective = readBundle(requested) ? requested : DEFAULT_LOCALE;
  if (effective !== currentLocale) {
    currentLocale = effective;
    localeRevision += 1;
  }
  return effective;
}

export function getLocaleState(): { language: SupportedLocale; localeRevision: number } {
  const language = resolveUiLanguage();
  return { language, localeRevision };
}

export function t(key: string, ...args: Array<string | number | boolean>): string {
  const locale = resolveUiLanguage();
  const template = readBundle(locale)?.[key] ?? DEFAULT_RUNTIME_MESSAGES[key];
  if (typeof template !== "string") {
    if (!missingKeyWarned) { missingKeyWarned = true; console.warn("[localization] Unknown runtime message key"); }
    return key;
  }
  return template.replace(/\{(\d+)\}/g, (match, index: string) => {
    const value = args[Number(index)];
    return value === undefined ? match : String(value);
  });
}
