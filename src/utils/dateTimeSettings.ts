import * as vscode from "vscode";

export type UiLanguageSetting = "auto" | "en" | "ja";

export interface DateTimeSettings {
  uiLanguage: UiLanguageSetting;
  timeZone: string;
}

function normalizeUiLanguageSetting(raw: unknown): UiLanguageSetting {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return v === "ja" || v === "en" || v === "auto" ? v : "auto";
}

export function readUiLanguageSetting(): UiLanguageSetting {
  const cfg = vscode.workspace.getConfiguration("codexHistoryViewer");
  return normalizeUiLanguageSetting(cfg.get<string>("ui.language") ?? "auto");
}

function resolveSystemTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof tz === "string" && tz.trim().length > 0) return tz.trim();
  } catch {
    // Ignore and fall back to UTC.
  }
  return "UTC";
}

function isSupportedTimeZone(timeZone: string): boolean {
  const tz = typeof timeZone === "string" ? timeZone.trim() : "";
  if (!tz) return false;
  try {
    // Creating a formatter validates the IANA TZ name.
    void new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function resolveDateTimeSettings(setting: UiLanguageSetting = readUiLanguageSetting()): DateTimeSettings {
  const sysTz = resolveSystemTimeZone();
  const desired = setting === "ja" ? "Asia/Tokyo" : sysTz;

  const timeZone = isSupportedTimeZone(desired) ? desired : isSupportedTimeZone(sysTz) ? sysTz : "UTC";
  return { uiLanguage: setting, timeZone };
}

export function getDateTimeSettingsKey(settings: DateTimeSettings): string {
  // Cache key for anything that depends on UI language/time zone.
  const lang = typeof settings.uiLanguage === "string" ? settings.uiLanguage : "auto";
  const tz = typeof settings.timeZone === "string" ? settings.timeZone : "UTC";
  return `uiLanguage=${lang};timeZone=${tz}`;
}

