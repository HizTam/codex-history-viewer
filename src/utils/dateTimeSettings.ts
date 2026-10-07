import * as vscode from "vscode";

import { normalizeUiLanguageSetting, type UiLanguageSetting } from "../localization/localeCatalog";
export type { UiLanguageSetting } from "../localization/localeCatalog";

export interface DateTimeSettings {
  uiLanguage: UiLanguageSetting;
  timeZone: string;
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
  const timeZone = isSupportedTimeZone(sysTz) ? sysTz : "UTC";
  return { uiLanguage: setting, timeZone };
}

export function getDateTimeSettingsKey(settings: DateTimeSettings): string {
  // Cache key for anything that depends on the display time zone.
  const tz = typeof settings.timeZone === "string" ? settings.timeZone : "UTC";
  return `timeZone=${tz}`;
}
