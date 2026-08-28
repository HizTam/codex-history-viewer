export type SettingsPanelValue = boolean | number | string | readonly string[];

export type SettingsTargetKind = "global" | "workspace" | "workspaceFolder";
export type SettingsSourceBadge = "codex" | "claude";

export interface SettingsTargetModel {
  id: string;
  kind: SettingsTargetKind;
  label: string;
}

export interface SettingsOptionModel {
  value: string;
  label: string;
  description?: string;
}

export type SettingsControlKind = "switch" | "select" | "multi" | "number" | "path";
export type SettingsPageKind = "settings" | "maintenance" | "about";
export type SettingsNavigationGroup = "settings" | "management" | "information";
export type SettingsIconName =
  | "general"
  | "sources"
  | "history"
  | "search"
  | "session"
  | "resume"
  | "maintenance"
  | "about";

export interface SettingsSettingModel {
  key: string;
  categoryId: string;
  card: string;
  label: string;
  description: string;
  control: SettingsControlKind;
  value: SettingsPanelValue;
  valueToken: string;
  configured: boolean;
  modified: boolean;
  invalid: boolean;
  experimental: boolean;
  sourceBadge?: SettingsSourceBadge;
  resourceImpact: boolean;
  canReset: boolean;
  disabledReason?: string;
  overriddenBy?: string;
  unit?: string;
  minimum?: number;
  maximum?: number;
  step?: number;
  options?: readonly SettingsOptionModel[];
}

export interface SettingsPageModel {
  id: string;
  kind: SettingsPageKind;
  group: SettingsNavigationGroup;
  icon: SettingsIconName;
  label: string;
  description?: string;
  settingCount?: number;
}

export type SettingsMaintenanceActionId =
  | "resetSettings"
  | "exportUserSettings"
  | "importUserSettings"
  | "exportWorkspaceSettings"
  | "importWorkspaceSettings"
  | "exportFolderSettings"
  | "importFolderSettings"
  | "rebuildCache"
  | "rebuildSearchIndex"
  | "clearSearchHistory"
  | "cleanupMissingPins"
  | "cleanupHandoffs"
  | "emptyTrash"
  | "openNativeSettings";

export type SettingsMaintenanceActionTone = "normal" | "warning" | "danger";

export interface SettingsMaintenanceActionModel {
  id: SettingsMaintenanceActionId;
  label: string;
  description: string;
  buttonLabel: string;
  tone: SettingsMaintenanceActionTone;
}

export interface SettingsMaintenanceCardModel {
  id: string;
  title: string;
  actions: readonly SettingsMaintenanceActionModel[];
}

export interface SettingsAboutModel {
  displayName: string;
  headerMetadata: string;
  versionLabel: string;
  version: string;
  licenseLabel: string;
  licenseName: string;
  copyright: string;
  versionTab: string;
  licenseTab: string;
  thirdPartyTab: string;
  sponsorLabel: string;
  licenseText: string;
  thirdPartyText: string;
}

export interface SettingsPanelLabels {
  target: string;
  navigation: string;
  navigationSettings: string;
  navigationManagement: string;
  navigationInformation: string;
  collapseNavigation: string;
  expandNavigation: string;
  openNavigation: string;
  closeNavigation: string;
  invalid: string;
  experimental: string;
  codexBadge: string;
  claudeBadge: string;
  resourceImpact: string;
  overridden: string;
  resetSetting: string;
  browseFolder: string;
  saving: string;
  saved: string;
  selectAtLeastOne: string;
  invalidValue: string;
}

export interface SettingsPanelSnapshot {
  version: 2;
  revision: number;
  language: "ja" | "en";
  title: string;
  activeTargetId: string;
  targets: readonly SettingsTargetModel[];
  pages: readonly SettingsPageModel[];
  settings: readonly SettingsSettingModel[];
  maintenanceCards: readonly SettingsMaintenanceCardModel[];
  about: SettingsAboutModel;
  labels: SettingsPanelLabels;
}

export type SettingsPanelHostMessage =
  | { type: "snapshot"; snapshot: SettingsPanelSnapshot }
  | { type: "updateSucceeded"; requestId: number; message: string }
  | { type: "updateRejected"; requestId: number; message: string; snapshot: SettingsPanelSnapshot }
  | { type: "actionCompleted"; requestId: number; message: string }
  | { type: "actionFailed"; requestId?: number; message: string }
  | { type: "browseCancelled"; requestId: number };
