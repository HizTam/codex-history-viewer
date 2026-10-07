import { DEFAULT_LOCALE, LOCALE_ALIASES, LOCALE_CATALOG, SUPPORTED_LOCALES } from "../generated/localeCatalog";
import type { SupportedLocale } from "../generated/localeCatalog";

export { DEFAULT_LOCALE, LOCALE_CATALOG, SUPPORTED_LOCALES };
export type { SupportedLocale };
export type UiLanguageSetting = "auto" | SupportedLocale;

// Accept language identifiers, never paths, Unicode extensions or private-use tags.
export function canonicalLocale(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  if (id.length > 63 || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(id)) return undefined;
  try {
    const canonical = Intl.getCanonicalLocales(id)[0];
    return new Intl.Locale(canonical).baseName === canonical ? canonical.toLowerCase() : undefined;
  } catch { return undefined; }
}

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function matchLocale(value: unknown): SupportedLocale | undefined {
  const id = canonicalLocale(value);
  return id ? (isSupportedLocale(id) ? id : LOCALE_ALIASES[id]) : undefined;
}

export function normalizeUiLanguageSetting(value: unknown): UiLanguageSetting {
  return matchLocale(value) ?? "auto";
}

export function resolveLocale(setting: unknown, environment: unknown): SupportedLocale {
  const explicit = matchLocale(setting);
  if (explicit) return explicit;
  let candidate = canonicalLocale(environment);
  while (candidate) {
    const matched = matchLocale(candidate);
    if (matched) return matched;
    const boundary = candidate.lastIndexOf("-");
    candidate = boundary < 0 ? undefined : candidate.slice(0, boundary);
  }
  return DEFAULT_LOCALE;
}

export function localeDisplayName(locale: SupportedLocale, display: SupportedLocale): string {
  return LOCALE_CATALOG.find(entry => entry.locale === display)?.names[locale]
    ?? LOCALE_CATALOG.find(entry => entry.locale === locale)?.nativeName ?? locale;
}
