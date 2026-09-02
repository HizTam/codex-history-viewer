import { randomBytes } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { resolveUiLanguage, t } from "../i18n";
import {
  SETTINGS_DEFINITIONS,
  cloneSettingValue,
  getPresentedSettingControl,
  getPresentedSettingOptions,
  getPresentedSettingValue,
  getSettingsDefinition,
  getStoredSettingInput,
  isSettingModified,
  normalizeSettingValue,
  supportsTarget,
  validateSettingValue,
  type SettingsDefinition
} from "./settingsCatalog";
import type {
  SettingsAboutModel,
  SettingsMaintenanceActionId,
  SettingsMaintenanceCardModel,
  SettingsPageModel,
  SettingsPanelHostMessage,
  SettingsPanelSnapshot,
  SettingsPanelValue,
  SettingsSettingModel,
  SettingsTargetKind,
  SettingsTargetModel
} from "./settingsPanelTypes";

const VIEW_TYPE = "codexHistoryViewer.settings";
const CONFIGURATION_SECTION = "codexHistoryViewer";
const GLOBAL_TARGET_ID = "global";
const WORKSPACE_TARGET_ID = "workspace";
const MAX_MESSAGE_KEY_LENGTH = 256;
const MAX_TARGET_ID_LENGTH = 256;
const MAX_ACTION_ID_LENGTH = 64;
const MAX_BUNDLED_TEXT_BYTES = 512 * 1024;
const MAX_SETTINGS_BACKUP_BYTES = 1024 * 1024;
const MAX_SETTINGS_BACKUP_ENTRIES = 256;
const MAX_SETTINGS_BACKUP_NAME_LENGTH = 256;
const MAX_SETTINGS_BACKUP_URI_LENGTH = 32_768;
const SETTINGS_BACKUP_FORMAT = "codex-history-viewer-settings";
const SETTINGS_BACKUP_VERSION = 1;
const COPYRIGHT_START_YEAR = 2026;
const SPONSOR_URL = "https://github.com/sponsors/HizTam";
const ABOUT_RESOURCE_URL_BY_ID = Object.freeze({
  repository: "https://github.com/HizTam/codex-history-viewer",
  securityPolicy: "https://github.com/HizTam/codex-history-viewer/security/policy",
  reportVulnerability: "https://github.com/HizTam/codex-history-viewer/security/advisories/new",
  changelog: "https://github.com/HizTam/codex-history-viewer/blob/main/CHANGELOG.md",
  commandReference: "https://github.com/HizTam/codex-history-viewer/blob/main/docs/commands.md"
});
type AboutResourceId = keyof typeof ABOUT_RESOURCE_URL_BY_ID;
const BACKUP_METADATA_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

const PAGE_DEFINITIONS = [
  { id: "general", kind: "settings", group: "settings", icon: "general" },
  { id: "sources", kind: "settings", group: "settings", icon: "sources" },
  { id: "history", kind: "settings", group: "settings", icon: "history" },
  { id: "search", kind: "settings", group: "settings", icon: "search" },
  { id: "session", kind: "settings", group: "settings", icon: "session" },
  { id: "resume", kind: "settings", group: "settings", icon: "resume" },
  { id: "maintenance", kind: "maintenance", group: "management", icon: "maintenance" },
  { id: "about", kind: "about", group: "information", icon: "about" }
] as const;

const MAINTENANCE_COMMANDS: ReadonlyMap<SettingsMaintenanceActionId, string> = new Map([
  ["rebuildCache", "codexHistoryViewer.rebuildCache"],
  ["rebuildSearchIndex", "codexHistoryViewer.rebuildSearchIndex"],
  ["clearSearchHistory", "codexHistoryViewer.searchClearHistory"],
  ["cleanupMissingPins", "codexHistoryViewer.cleanupMissingPins"],
  ["cleanupHandoffs", "codexHistoryViewer.cleanupHandoffs"],
  ["emptyTrash", "codexHistoryViewer.emptyTrash"]
]);

const MAINTENANCE_ACTION_IDS = new Set<SettingsMaintenanceActionId>([
  "resetSettings",
  "exportUserSettings",
  "importUserSettings",
  "exportWorkspaceSettings",
  "importWorkspaceSettings",
  "exportFolderSettings",
  "importFolderSettings",
  "rebuildCache",
  "rebuildSearchIndex",
  "clearSearchHistory",
  "cleanupMissingPins",
  "cleanupHandoffs",
  "emptyTrash",
  "openNativeSettings"
]);

interface TargetContext {
  id: string;
  kind: SettingsTargetKind;
  resource?: vscode.Uri;
  workspaceIdentity?: string;
}

interface ValueTokenState {
  targetId: string;
  fullKey: string;
  fingerprint: string;
  token: string;
}

interface ParsedRequestBase {
  requestId: number;
}

interface ParsedSettingRequest extends ParsedRequestBase {
  key: string;
  targetId: string;
  valueToken: string;
  snapshotRevision: number;
}

interface ParsedUpdateRequest extends ParsedSettingRequest {
  value: unknown;
}

interface StoredSettingValue {
  definitionItem: SettingsDefinition;
  value: unknown;
  fingerprint: string;
}

interface SettingsBackupEntry {
  key: string;
  configured: boolean;
  value?: SettingsPanelValue;
}

interface SettingsBackupTarget {
  kind: SettingsTargetKind;
  name?: string;
  uri?: string;
  settings: readonly SettingsBackupEntry[];
}

interface SettingsImportChange extends StoredSettingValue {
  target: TargetContext;
  nextValue: SettingsPanelValue | undefined;
}

export class SettingsPanelManager implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private panelDisposables: vscode.Disposable[] = [];
  private readonly folderIdsByUri = new Map<string, string>();
  private readonly foldersById = new Map<string, vscode.WorkspaceFolder>();
  private readonly valueTokens = new Map<string, ValueTokenState>();
  private licenseText: string | undefined;
  private thirdPartyText: string | undefined;
  private bundledDocumentsLoaded = false;
  private activeTargetId = GLOBAL_TARGET_ID;
  private nextFolderId = 1;
  private panelGeneration = 0;
  private revision = 0;
  private publishTimer: ReturnType<typeof setTimeout> | undefined;
  private operationQueue: Promise<void> = Promise.resolve();
  private operationActive = false;
  private snapshotRequestedDuringOperation = false;
  private disposed = false;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(CONFIGURATION_SECTION)) {
          this.scheduleSnapshot();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.rebuildFolderTargets();
        this.scheduleSnapshot();
      })
    );
    this.rebuildFolderTargets();
    void this.loadBundledDocuments();
  }

  public registerSerializer(subscriptions: vscode.Disposable[]): void {
    subscriptions.push(
      vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
        deserializeWebviewPanel: (panel) => {
          this.restoreSerializedPanel(panel);
          return Promise.resolve();
        }
      })
    );
  }

  public open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active, false);
      void this.publishSnapshot();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      t("settingsPanel.title"),
      vscode.ViewColumn.Active,
      this.buildPanelOptions()
    );
    this.initializePanel(panel);
  }

  private restoreSerializedPanel(panel: vscode.WebviewPanel): void {
    if (this.disposed) {
      panel.dispose();
      return;
    }
    if (this.panel && this.panel !== panel) {
      panel.dispose();
      return;
    }
    this.initializePanel(panel);
  }

  private initializePanel(panel: vscode.WebviewPanel): void {
    this.disposePanelSubscriptions();
    const generation = this.panelGeneration + 1;
    this.panelGeneration = generation;
    panel.webview.options = this.buildWebviewOptions();
    panel.title = t("settingsPanel.title");
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "resources", "extension-icon.svg");
    this.panel = panel;

    this.panelDisposables.push(
      panel.onDidDispose(() => {
        if (this.panel !== panel) {
          return;
        }
        this.panel = undefined;
        this.disposePanelSubscriptions();
      }),
      panel.webview.onDidReceiveMessage((message: unknown) => {
        void this.handleMessage(message, generation).catch(() => {
          void this.postActionFailed(undefined, t("settingsPanel.error.unexpected"), generation);
        });
      })
    );
    panel.webview.html = this.createHtml(panel.webview);
  }

  private buildWebviewOptions(): vscode.WebviewOptions {
    return {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")]
    };
  }

  private buildPanelOptions(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return {
      ...this.buildWebviewOptions(),
      retainContextWhenHidden: true
    };
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.publishTimer) {
      clearTimeout(this.publishTimer);
      this.publishTimer = undefined;
    }
    this.disposePanelSubscriptions();
    this.panel?.dispose();
    this.panel = undefined;
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  private disposePanelSubscriptions(): void {
    for (const disposable of this.panelDisposables.splice(0)) {
      disposable.dispose();
    }
  }

  private async handleMessage(message: unknown, generation: number): Promise<void> {
    if (!this.isCurrentPanelGeneration(generation) || !isRecord(message) || typeof message.type !== "string") {
      return;
    }

    switch (message.type) {
      case "ready":
        await this.publishSnapshot(generation);
        return;
      case "selectTarget":
        await this.handleSelectTarget(message, generation);
        return;
      case "updateSetting": {
        const request = this.parseUpdateRequest(message);
        if (!request) {
          await this.postActionFailed(undefined, t("settingsPanel.error.invalidRequest"), generation);
          return;
        }
        this.enqueueOperation(
          () => this.updateSetting(request, false, generation),
          request.requestId,
          generation
        );
        return;
      }
      case "resetSetting": {
        const request = this.parseSettingRequest(message);
        if (!request) {
          await this.postActionFailed(undefined, t("settingsPanel.error.invalidRequest"), generation);
          return;
        }
        this.enqueueOperation(
          () => this.updateSetting(request, true, generation),
          request.requestId,
          generation
        );
        return;
      }
      case "browseFolder": {
        const request = this.parseSettingRequest(message);
        if (!request) {
          await this.postActionFailed(undefined, t("settingsPanel.error.invalidRequest"), generation);
          return;
        }
        await this.browseFolder(request, generation);
        return;
      }
      case "runMaintenanceAction": {
        const request = this.parseMaintenanceRequest(message);
        if (!request) {
          await this.postActionFailed(undefined, t("settingsPanel.error.invalidRequest"), generation);
          return;
        }
        this.enqueueOperation(
          () => this.runMaintenanceAction(request, generation),
          request.requestId,
          generation
        );
        return;
      }
      case "openSponsor":
        await this.openSponsor(generation);
        return;
      case "openAboutResource": {
        const resourceId = parseAboutResourceId(message.resourceId);
        if (!resourceId) {
          await this.postActionFailed(undefined, t("settingsPanel.error.invalidRequest"), generation);
          return;
        }
        await this.openAboutResource(resourceId, generation);
        return;
      }
      default:
        return;
    }
  }

  private async openSponsor(generation: number): Promise<void> {
    try {
      const opened = await vscode.env.openExternal(vscode.Uri.parse(SPONSOR_URL));
      if (!opened) {
        await this.postActionFailed(undefined, t("settingsPanel.error.openSponsor"), generation);
      }
    } catch {
      await this.postActionFailed(undefined, t("settingsPanel.error.openSponsor"), generation);
    }
  }

  private async openAboutResource(
    resourceId: AboutResourceId,
    generation: number
  ): Promise<void> {
    try {
      const opened = await vscode.env.openExternal(
        vscode.Uri.parse(ABOUT_RESOURCE_URL_BY_ID[resourceId])
      );
      if (!opened) {
        await this.postActionFailed(
          undefined,
          t("settingsPanel.error.openAboutResource"),
          generation
        );
      }
    } catch {
      await this.postActionFailed(
        undefined,
        t("settingsPanel.error.openAboutResource"),
        generation
      );
    }
  }

  private enqueueOperation(
    action: () => Promise<void>,
    requestId: number,
    generation: number
  ): void {
    const run = async (): Promise<void> => {
      if (!this.isCurrentPanelGeneration(generation)) {
        return;
      }
      this.operationActive = true;
      if (this.publishTimer) {
        clearTimeout(this.publishTimer);
        this.publishTimer = undefined;
        this.snapshotRequestedDuringOperation = true;
      }
      try {
        await action();
      } catch {
        await this.postActionFailed(requestId, t("settingsPanel.error.unexpected"), generation);
      } finally {
        this.operationActive = false;
        if (this.snapshotRequestedDuringOperation) {
          this.snapshotRequestedDuringOperation = false;
          this.scheduleSnapshot();
        }
      }
    };
    this.operationQueue = this.operationQueue.then(run, run);
  }

  private async handleSelectTarget(message: Record<string, unknown>, generation: number): Promise<void> {
    if (
      typeof message.targetId !== "string" ||
      message.targetId.length === 0 ||
      message.targetId.length > MAX_TARGET_ID_LENGTH
    ) {
      await this.postActionFailed(undefined, t("settingsPanel.error.unknownTarget"), generation);
      return;
    }
    const target = this.getTargetContext(message.targetId);
    if (!target) {
      await this.postActionFailed(undefined, t("settingsPanel.error.unknownTarget"), generation);
      return;
    }
    this.activeTargetId = target.id;
    await this.publishSnapshot(generation);
  }

  private parseUpdateRequest(message: Record<string, unknown>): ParsedUpdateRequest | undefined {
    const base = this.parseSettingRequest(message);
    return base && Object.prototype.hasOwnProperty.call(message, "value")
      ? { ...base, value: message.value }
      : undefined;
  }

  private parseSettingRequest(message: Record<string, unknown>): ParsedSettingRequest | undefined {
    if (
      !isSafeRequestId(message.requestId) ||
      typeof message.key !== "string" ||
      message.key.length === 0 ||
      message.key.length > MAX_MESSAGE_KEY_LENGTH ||
      typeof message.targetId !== "string" ||
      message.targetId.length === 0 ||
      message.targetId.length > MAX_TARGET_ID_LENGTH ||
      typeof message.valueToken !== "string" ||
      message.valueToken.length < 16 ||
      message.valueToken.length > 128 ||
      typeof message.snapshotRevision !== "number" ||
      !Number.isSafeInteger(message.snapshotRevision) ||
      message.snapshotRevision < 0
    ) {
      return undefined;
    }
    return {
      requestId: message.requestId,
      key: message.key,
      targetId: message.targetId,
      valueToken: message.valueToken,
      snapshotRevision: message.snapshotRevision
    };
  }

  private parseMaintenanceRequest(
    message: Record<string, unknown>
  ): { requestId: number; actionId: SettingsMaintenanceActionId } | undefined {
    if (
      !isSafeRequestId(message.requestId) ||
      typeof message.actionId !== "string" ||
      message.actionId.length === 0 ||
      message.actionId.length > MAX_ACTION_ID_LENGTH ||
      !MAINTENANCE_ACTION_IDS.has(message.actionId as SettingsMaintenanceActionId)
    ) {
      return undefined;
    }
    return {
      requestId: message.requestId,
      actionId: message.actionId as SettingsMaintenanceActionId
    };
  }

  private async updateSetting(
    request: ParsedSettingRequest | ParsedUpdateRequest,
    reset: boolean,
    generation: number
  ): Promise<void> {
    const target = this.getTargetContext(request.targetId);
    const definitionItem = getSettingsDefinition(request.key);
    if (
      !target ||
      target.id !== this.activeTargetId ||
      !definitionItem ||
      !supportsTarget(definitionItem.scope, target.kind)
    ) {
      await this.rejectUpdate(request.requestId, t("settingsPanel.error.invalidRequest"), generation);
      return;
    }
    if (!this.isCurrentToken(request, definitionItem, target)) {
      await this.rejectUpdate(request.requestId, t("settingsPanel.error.stale"), generation);
      return;
    }

    let nextValue: SettingsPanelValue | undefined;
    if (!reset) {
      const input = getStoredSettingInput(
        definitionItem,
        (request as ParsedUpdateRequest).value
      );
      const validation = validateSettingValue(definitionItem, input);
      if (!validation.ok || validation.value === undefined) {
        const message =
          validation.error === "range"
            ? t("settingsPanel.error.range", definitionItem.minimum ?? "", definitionItem.maximum ?? "")
            : validation.error === "empty"
              ? t("settingsPanel.error.empty")
              : t("settingsPanel.error.invalidValue");
        await this.rejectUpdate(request.requestId, message, generation);
        return;
      }
      nextValue = cloneSettingValue(validation.value);
    }

    try {
      const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION, target.resource);
      await configuration.update(
        definitionItem.relativeKey,
        nextValue,
        toConfigurationTarget(target.kind)
      );
      await this.publishSnapshot(generation, true);
      await this.postMessage(
        { type: "updateSucceeded", requestId: request.requestId, message: t("settingsPanel.saved") },
        generation
      );
    } catch {
      await this.rejectUpdate(request.requestId, t("settingsPanel.error.saveFailed"), generation);
    }
  }

  private async browseFolder(request: ParsedSettingRequest, generation: number): Promise<void> {
    const target = this.getTargetContext(request.targetId);
    const definitionItem = getSettingsDefinition(request.key);
    if (
      !target ||
      target.id !== this.activeTargetId ||
      !definitionItem ||
      definitionItem.control !== "path" ||
      !supportsTarget(definitionItem.scope, target.kind)
    ) {
      await this.postActionFailed(request.requestId, t("settingsPanel.error.invalidRequest"), generation);
      return;
    }
    if (!this.isCurrentToken(request, definitionItem, target)) {
      await this.rejectUpdate(request.requestId, t("settingsPanel.error.stale"), generation);
      return;
    }

    let selected: readonly vscode.Uri[] | undefined;
    try {
      selected = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: t("settingsPanel.browseFolder"),
        title: t("settingsPanel.folderPicker.title")
      });
    } catch {
      await this.postActionFailed(request.requestId, t("settingsPanel.error.folderPicker"), generation);
      return;
    }
    if (!selected || selected.length !== 1) {
      await this.postMessage({ type: "browseCancelled", requestId: request.requestId }, generation);
      return;
    }
    const uri = selected[0];
    if (uri.scheme !== "file") {
      await this.postActionFailed(request.requestId, t("settingsPanel.error.localFolderOnly"), generation);
      return;
    }
    if (!this.isCurrentPanelGeneration(generation)) {
      return;
    }
    this.enqueueOperation(
      () => this.updateSetting({ ...request, value: uri.fsPath }, false, generation),
      request.requestId,
      generation
    );
  }

  private async runMaintenanceAction(
    request: { requestId: number; actionId: SettingsMaintenanceActionId },
    generation: number
  ): Promise<void> {
    try {
      if (request.actionId === "resetSettings") {
        await this.resetUserSettings(request.requestId, generation);
        return;
      }
      if (request.actionId === "exportUserSettings") {
        await this.exportSettings(request.requestId, generation, "global");
        return;
      }
      if (request.actionId === "importUserSettings") {
        await this.importSettings(request.requestId, generation, "global");
        return;
      }
      if (request.actionId === "exportWorkspaceSettings") {
        await this.exportSettings(request.requestId, generation, "workspace");
        return;
      }
      if (request.actionId === "importWorkspaceSettings") {
        await this.importSettings(request.requestId, generation, "workspace");
        return;
      }
      if (request.actionId === "exportFolderSettings") {
        await this.exportSettings(request.requestId, generation, "workspaceFolder");
        return;
      }
      if (request.actionId === "importFolderSettings") {
        await this.importSettings(request.requestId, generation, "workspaceFolder");
        return;
      }
      if (request.actionId === "openNativeSettings") {
        await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:" + this.context.extension.id);
      } else {
        const command = MAINTENANCE_COMMANDS.get(request.actionId);
        if (!command) {
          await this.postActionFailed(request.requestId, t("settingsPanel.error.invalidRequest"), generation);
          return;
        }
        await vscode.commands.executeCommand(command);
      }
      await this.postMessage({ type: "actionCompleted", requestId: request.requestId, message: "" }, generation);
    } catch {
      const errorMessage = request.actionId === "openNativeSettings"
        ? t("settingsPanel.error.openNativeSettings")
        : t("settingsPanel.error.actionFailed");
      await this.postActionFailed(request.requestId, errorMessage, generation);
    }
  }

  private async resetUserSettings(requestId: number, generation: number): Promise<void> {
    const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
    const configured: StoredSettingValue[] = [];
    for (const definitionItem of SETTINGS_DEFINITIONS) {
      const value = configuration.inspect<unknown>(definitionItem.relativeKey)?.globalValue;
      if (value !== undefined) {
        configured.push({
          definitionItem,
          value,
          fingerprint: fingerprintValue(value)
        });
      }
    }
    if (configured.length === 0) {
      await this.postMessage(
        { type: "actionCompleted", requestId, message: t("settingsPanel.maintenance.reset.none") },
        generation
      );
      return;
    }

    const confirmLabel = t("settingsPanel.maintenance.reset.confirmAction");
    const choice = await vscode.window.showWarningMessage(
      t("settingsPanel.maintenance.reset.confirm", configured.length),
      { modal: true },
      confirmLabel
    );
    if (choice !== confirmLabel) {
      await this.postMessage({ type: "actionCompleted", requestId, message: "" }, generation);
      return;
    }
    if (!this.isCurrentPanelGeneration(generation)) {
      return;
    }

    for (const item of configured) {
      const latest = configuration.inspect<unknown>(item.definitionItem.relativeKey)?.globalValue;
      if (fingerprintValue(latest) !== item.fingerprint) {
        await this.postActionFailed(requestId, t("settingsPanel.maintenance.reset.stale"), generation);
        return;
      }
    }

    const changed: StoredSettingValue[] = [];
    try {
      for (const item of configured) {
        await configuration.update(
          item.definitionItem.relativeKey,
          undefined,
          vscode.ConfigurationTarget.Global
        );
        changed.push(item);
      }
    } catch {
      let rollbackFailed = false;
      for (const item of changed.reverse()) {
        try {
          const latest = configuration.inspect<unknown>(item.definitionItem.relativeKey)?.globalValue;
          if (latest !== undefined) {
            rollbackFailed = true;
            continue;
          }
          await configuration.update(
            item.definitionItem.relativeKey,
            item.value,
            vscode.ConfigurationTarget.Global
          );
        } catch {
          rollbackFailed = true;
        }
      }
      await this.publishSnapshot(generation, true);
      await this.postActionFailed(
        requestId,
        rollbackFailed
          ? t("settingsPanel.maintenance.reset.partialFailed")
          : t("settingsPanel.maintenance.reset.failed"),
        generation
      );
      return;
    }

    await this.publishSnapshot(generation, true);
    await this.postMessage(
      {
        type: "actionCompleted",
        requestId,
        message: t("settingsPanel.maintenance.reset.completed", configured.length)
      },
      generation
    );
  }

  private async exportSettings(
    requestId: number,
    generation: number,
    kind: SettingsTargetKind
  ): Promise<void> {
    const target = await this.resolveBackupOperationTarget(kind, "export");
    if (target === null) {
      await this.postActionFailed(requestId, t("settingsPanel.maintenance.backup.targetUnavailable"), generation);
      return;
    }
    if (!target) {
      await this.postMessage({ type: "actionCompleted", requestId, message: "" }, generation);
      return;
    }
    if (!this.isCurrentPanelGeneration(generation)) {
      return;
    }

    const entries: SettingsBackupEntry[] = [];
    for (const definitionItem of SETTINGS_DEFINITIONS) {
      if (!supportsTarget(definitionItem.scope, target.kind)) {
        continue;
      }
      const value = this.readTargetValue(definitionItem, target);
      if (value === undefined) {
        entries.push({ key: definitionItem.fullKey, configured: false });
        continue;
      }
      const validation = validateSettingValue(definitionItem, value);
      if (!validation.ok || validation.value === undefined) {
        await this.postActionFailed(
          requestId,
          t(
            "settingsPanel.maintenance.export.invalidSetting",
            t(definitionItem.labelKey),
            this.getTargetDisplayLabel(target)
          ),
          generation
        );
        return;
      }
      entries.push({
        key: definitionItem.fullKey,
        configured: true,
        value: cloneSettingValue(validation.value)
      });
    }

    const folder = target.kind === "workspaceFolder" ? this.foldersById.get(target.id) : undefined;
    const targetName =
      target.kind === "workspaceFolder"
        ? folder?.name
        : target.kind === "workspace"
          ? vscode.workspace.name
          : undefined;
    const targetUri =
      target.kind === "workspaceFolder"
        ? target.resource?.toString()
        : target.kind === "workspace"
          ? vscode.workspace.workspaceFile?.toString()
          : undefined;
    const backupTarget: SettingsBackupTarget = {
      kind: target.kind,
      name: isBackupName(targetName) ? targetName : undefined,
      uri: isBackupUri(targetUri) ? targetUri : undefined,
      settings: entries
    };
    const exportedAt = new Date().toISOString();

    const destination = await vscode.window.showSaveDialog({
      defaultUri: buildSettingsBackupDefaultUri(backupTarget, exportedAt),
      filters: { JSON: ["json"] },
      saveLabel: t("settingsPanel.maintenance.export.saveLabel"),
      title: t("settingsPanel.maintenance.export.title")
    });
    if (!destination) {
      await this.postMessage({ type: "actionCompleted", requestId, message: "" }, generation);
      return;
    }
    if (!this.isCurrentPanelGeneration(generation)) {
      return;
    }
    if (!this.isSameTargetAvailable(target)) {
      await this.postActionFailed(
        requestId,
        t("settingsPanel.maintenance.backup.targetChanged"),
        generation
      );
      return;
    }
    const payload = {
      format: SETTINGS_BACKUP_FORMAT,
      version: SETTINGS_BACKUP_VERSION,
      extensionId: this.context.extension.id,
      exportedAt,
      target: {
        kind: backupTarget.kind,
        name: backupTarget.name,
        uri: backupTarget.uri
      },
      settings: backupTarget.settings
    };
    const bytes = new TextEncoder().encode(JSON.stringify(payload, undefined, 2) + "\n");
    if (bytes.byteLength > MAX_SETTINGS_BACKUP_BYTES) {
      await this.postActionFailed(requestId, t("settingsPanel.maintenance.export.tooLarge"), generation);
      return;
    }
    try {
      await vscode.workspace.fs.writeFile(destination, bytes);
      await this.postMessage(
        { type: "actionCompleted", requestId, message: t("settingsPanel.maintenance.export.completed") },
        generation
      );
    } catch {
      await this.postActionFailed(requestId, t("settingsPanel.maintenance.export.failed"), generation);
    }
  }

  private async importSettings(
    requestId: number,
    generation: number,
    expectedKind: SettingsTargetKind
  ): Promise<void> {
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { JSON: ["json"] },
      openLabel: t("settingsPanel.maintenance.import.openLabel"),
      title: t("settingsPanel.maintenance.import.title")
    });
    if (!selected || selected.length !== 1) {
      await this.postMessage({ type: "actionCompleted", requestId, message: "" }, generation);
      return;
    }
    if (!this.isCurrentPanelGeneration(generation)) {
      return;
    }

    let fileBytes: Uint8Array;
    try {
      const stat = await vscode.workspace.fs.stat(selected[0]);
      if ((stat.type & vscode.FileType.File) === 0 || stat.size > MAX_SETTINGS_BACKUP_BYTES) {
        await this.postActionFailed(requestId, t("settingsPanel.maintenance.import.invalidFile"), generation);
        return;
      }
      fileBytes = await vscode.workspace.fs.readFile(selected[0]);
      if (fileBytes.byteLength > MAX_SETTINGS_BACKUP_BYTES) {
        await this.postActionFailed(requestId, t("settingsPanel.maintenance.import.invalidFile"), generation);
        return;
      }
    } catch {
      await this.postActionFailed(requestId, t("settingsPanel.maintenance.import.readFailed"), generation);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fileBytes));
    } catch {
      await this.postActionFailed(requestId, t("settingsPanel.maintenance.import.invalidFile"), generation);
      return;
    }
    const backupTarget = this.validateSettingsBackup(parsed);
    if (!backupTarget) {
      await this.postActionFailed(requestId, t("settingsPanel.maintenance.import.invalidFile"), generation);
      return;
    }
    if (backupTarget.kind !== expectedKind) {
      await this.postActionFailed(requestId, t("settingsPanel.maintenance.import.scopeMismatch"), generation);
      return;
    }

    const target = await this.resolveBackupOperationTarget(expectedKind, "import");
    if (target === null) {
      await this.postActionFailed(requestId, t("settingsPanel.maintenance.backup.targetUnavailable"), generation);
      return;
    }
    if (!target) {
      await this.postMessage({ type: "actionCompleted", requestId, message: "" }, generation);
      return;
    }
    if (!this.isCurrentPanelGeneration(generation)) {
      return;
    }
    const changes: SettingsImportChange[] = [];
    for (const entry of backupTarget.settings) {
      const definitionItem = getSettingsDefinition(entry.key);
      if (!definitionItem) {
        continue;
      }
      const currentValue = this.readTargetValue(definitionItem, target);
      const nextValue = entry.configured
        ? cloneSettingValue(entry.value as SettingsPanelValue)
        : undefined;
      if (fingerprintValue(currentValue) !== fingerprintValue(nextValue)) {
        changes.push({
          target,
          definitionItem,
          value: currentValue,
          fingerprint: fingerprintValue(currentValue),
          nextValue
        });
      }
    }
    if (changes.length === 0) {
      await this.postMessage(
        {
          type: "actionCompleted",
          requestId,
          message: t("settingsPanel.maintenance.import.noChanges", this.getTargetDisplayLabel(target))
        },
        generation
      );
      return;
    }

    const confirmLabel = t("settingsPanel.maintenance.import.confirmAction");
    const choice = await vscode.window.showWarningMessage(
      t(
        "settingsPanel.maintenance.import.confirm",
        changes.length,
        this.getBackupTargetDisplayLabel(backupTarget),
        this.getTargetDisplayLabel(target)
      ),
      { modal: true },
      confirmLabel
    );
    if (choice !== confirmLabel) {
      await this.postMessage({ type: "actionCompleted", requestId, message: "" }, generation);
      return;
    }
    if (!this.isCurrentPanelGeneration(generation)) {
      return;
    }
    if (!this.isSameTargetAvailable(target)) {
      await this.postActionFailed(
        requestId,
        t("settingsPanel.maintenance.backup.targetChanged"),
        generation
      );
      return;
    }
    for (const change of changes) {
      const latest = this.readTargetValue(change.definitionItem, change.target);
      if (fingerprintValue(latest) !== change.fingerprint) {
        await this.postActionFailed(requestId, t("settingsPanel.maintenance.import.stale"), generation);
        return;
      }
    }

    const changed: SettingsImportChange[] = [];
    try {
      for (const change of changes) {
        const configuration = vscode.workspace.getConfiguration(
          CONFIGURATION_SECTION,
          change.target.resource
        );
        await configuration.update(
          change.definitionItem.relativeKey,
          change.nextValue,
          toConfigurationTarget(change.target.kind)
        );
        changed.push(change);
      }
    } catch {
      let rollbackFailed = false;
      for (const change of changed.reverse()) {
        try {
          const latest = this.readTargetValue(change.definitionItem, change.target);
          if (fingerprintValue(latest) !== fingerprintValue(change.nextValue)) {
            rollbackFailed = true;
            continue;
          }
          const configuration = vscode.workspace.getConfiguration(
            CONFIGURATION_SECTION,
            change.target.resource
          );
          await configuration.update(
            change.definitionItem.relativeKey,
            change.value,
            toConfigurationTarget(change.target.kind)
          );
        } catch {
          rollbackFailed = true;
        }
      }
      await this.publishSnapshot(generation, true);
      await this.postActionFailed(
        requestId,
        rollbackFailed
          ? t("settingsPanel.maintenance.import.partialFailed")
          : t("settingsPanel.maintenance.import.failed"),
        generation
      );
      return;
    }

    await this.publishSnapshot(generation, true);
    await this.postMessage(
      {
        type: "actionCompleted",
        requestId,
        message: t(
          "settingsPanel.maintenance.import.completed",
          changes.length,
          this.getTargetDisplayLabel(target)
        )
      },
      generation
    );
  }

  private validateSettingsBackup(value: unknown): SettingsBackupTarget | undefined {
    if (
      !isRecord(value) ||
      value.format !== SETTINGS_BACKUP_FORMAT ||
      value.version !== SETTINGS_BACKUP_VERSION ||
      value.extensionId !== this.context.extension.id ||
      !isRecord(value.target) ||
      !isSettingsTargetKind(value.target.kind) ||
      (value.target.name !== undefined && !isBackupName(value.target.name)) ||
      (value.target.uri !== undefined && !isBackupUri(value.target.uri)) ||
      !Array.isArray(value.settings) ||
      value.settings.length > MAX_SETTINGS_BACKUP_ENTRIES
    ) {
      return undefined;
    }
    const entries: SettingsBackupEntry[] = [];
    const keys = new Set<string>();
    for (const item of value.settings) {
      if (
        !isRecord(item) ||
        typeof item.key !== "string" ||
        item.key.length === 0 ||
        item.key.length > MAX_MESSAGE_KEY_LENGTH ||
        typeof item.configured !== "boolean" ||
        keys.has(item.key)
      ) {
        return undefined;
      }
      keys.add(item.key);
      const definitionItem = getSettingsDefinition(item.key);
      if (!definitionItem) {
        entries.push({ key: item.key, configured: item.configured });
        continue;
      }
      if (!supportsTarget(definitionItem.scope, value.target.kind)) {
        return undefined;
      }
      if (!item.configured) {
        if (Object.prototype.hasOwnProperty.call(item, "value")) {
          return undefined;
        }
        entries.push({ key: item.key, configured: false });
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(item, "value")) {
        return undefined;
      }
      const validation = validateSettingValue(definitionItem, item.value);
      if (!validation.ok || validation.value === undefined) {
        return undefined;
      }
      entries.push({
        key: item.key,
        configured: true,
        value: cloneSettingValue(validation.value)
      });
    }
    return {
      kind: value.target.kind,
      name: value.target.name,
      uri: value.target.uri,
      settings: entries
    };
  }

  private async resolveBackupOperationTarget(
    kind: SettingsTargetKind,
    operation: "export" | "import"
  ): Promise<TargetContext | null | undefined> {
    this.rebuildFolderTargets();
    if (kind === "global") {
      return { id: GLOBAL_TARGET_ID, kind: "global" };
    }
    if (kind === "workspace") {
      return this.getTargetContext(WORKSPACE_TARGET_ID) ?? null;
    }
    const folders = [...this.foldersById.entries()];
    if (folders.length === 0) {
      return null;
    }
    if (folders.length === 1) {
      return { id: folders[0][0], kind: "workspaceFolder", resource: folders[0][1].uri };
    }
    const selected = await vscode.window.showWorkspaceFolderPick({
      placeHolder: t("settingsPanel.maintenance.backup.folderPicker." + operation)
    });
    if (!selected) {
      return undefined;
    }
    const entry = folders.find(([, folder]) => folder.uri.toString() === selected.uri.toString());
    return entry
      ? { id: entry[0], kind: "workspaceFolder", resource: entry[1].uri }
      : null;
  }

  private getTargetDisplayLabel(target: TargetContext): string {
    if (target.kind === "global") {
      return t("settingsPanel.target.global");
    }
    if (target.kind === "workspace") {
      return t("settingsPanel.target.workspace");
    }
    return t("settingsPanel.target.folder", this.foldersById.get(target.id)?.name ?? "?");
  }

  private getBackupTargetDisplayLabel(target: SettingsBackupTarget): string {
    if (target.kind === "global") {
      return t("settingsPanel.target.global");
    }
    if (target.kind === "workspace") {
      return target.name
        ? t("settingsPanel.maintenance.backup.source.workspace", target.name)
        : t("settingsPanel.target.workspace");
    }
    return target.name
      ? t("settingsPanel.target.folder", target.name)
      : t("settingsPanel.maintenance.backup.source.folder");
  }

  private isCurrentToken(
    request: ParsedSettingRequest,
    definitionItem: SettingsDefinition,
    target: TargetContext
  ): boolean {
    const expected = this.valueTokens.get(this.tokenKey(target.id, definitionItem.fullKey));
    return Boolean(
      expected &&
      expected.token === request.valueToken &&
      expected.targetId === target.id &&
      expected.fullKey === definitionItem.fullKey &&
      expected.fingerprint === this.readTargetFingerprint(definitionItem, target)
    );
  }

  private readTargetValue(definitionItem: SettingsDefinition, target: TargetContext): unknown {
    const inspected = vscode.workspace
      .getConfiguration(CONFIGURATION_SECTION, target.resource)
      .inspect<unknown>(definitionItem.relativeKey);
    if (!inspected) {
      return undefined;
    }
    if (target.kind === "global") {
      return inspected.globalValue;
    }
    if (target.kind === "workspace") {
      return inspected.workspaceValue;
    }
    return inspected.workspaceFolderValue;
  }

  private readTargetFingerprint(definitionItem: SettingsDefinition, target: TargetContext): string {
    const inspected = vscode.workspace
      .getConfiguration(CONFIGURATION_SECTION, target.resource)
      .inspect<unknown>(definitionItem.relativeKey);
    const rawValue = this.readTargetValue(definitionItem, target);
    if (rawValue !== undefined) {
      return this.getTargetIdentity(target) + ":configured:" + fingerprintValue(rawValue);
    }
    return (
      this.getTargetIdentity(target) +
      ":inherited:" +
      fingerprintValue(this.readInheritedValue(definitionItem, target, inspected))
    );
  }

  private async rejectUpdate(requestId: number, message: string, generation: number): Promise<void> {
    if (!this.isCurrentPanelGeneration(generation)) {
      return;
    }
    await this.postMessage(
      { type: "updateRejected", requestId, message, snapshot: this.buildSnapshot() },
      generation
    );
  }

  private async postActionFailed(
    requestId: number | undefined,
    message: string,
    generation: number
  ): Promise<void> {
    await this.postMessage({ type: "actionFailed", requestId, message }, generation);
  }

  private scheduleSnapshot(): void {
    if (!this.panel || this.disposed) {
      return;
    }
    if (this.operationActive) {
      this.snapshotRequestedDuringOperation = true;
      return;
    }
    if (this.publishTimer) {
      clearTimeout(this.publishTimer);
    }
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined;
      void this.publishSnapshot();
    }, 40);
  }

  private async publishSnapshot(
    expectedGeneration?: number,
    allowDuringOperation = false
  ): Promise<void> {
    if (
      !this.panel ||
      this.disposed ||
      (expectedGeneration !== undefined && !this.isCurrentPanelGeneration(expectedGeneration))
    ) {
      return;
    }
    if (this.operationActive && !allowDuringOperation) {
      this.snapshotRequestedDuringOperation = true;
      return;
    }
    if (allowDuringOperation) {
      this.snapshotRequestedDuringOperation = false;
    }
    const snapshot = this.buildSnapshot();
    this.panel.title = snapshot.title;
    await this.postMessage({ type: "snapshot", snapshot }, expectedGeneration);
  }

  private async postMessage(
    message: SettingsPanelHostMessage,
    expectedGeneration?: number
  ): Promise<void> {
    const panel = this.panel;
    if (
      !panel ||
      this.disposed ||
      (expectedGeneration !== undefined && !this.isCurrentPanelGeneration(expectedGeneration))
    ) {
      return;
    }
    try {
      await panel.webview.postMessage(message);
    } catch {
      // Message delivery may race with panel disposal; no external state needs rollback.
    }
  }

  private isCurrentPanelGeneration(generation: number): boolean {
    return Boolean(this.panel) && generation === this.panelGeneration && !this.disposed;
  }

  private buildSnapshot(): SettingsPanelSnapshot {
    this.rebuildFolderTargets();
    const targets = this.getTargetModels();
    if (!targets.some((target) => target.id === this.activeTargetId)) {
      this.activeTargetId = GLOBAL_TARGET_ID;
    }
    const target = this.getTargetContext(this.activeTargetId) ?? {
      id: GLOBAL_TARGET_ID,
      kind: "global" as const
    };

    const compatibleDefinitions = SETTINGS_DEFINITIONS.filter((definitionItem) =>
      supportsTarget(definitionItem.scope, target.kind)
    );
    const values = new Map<string, SettingsPanelValue>();
    const inspectedValues = compatibleDefinitions.map((definitionItem) => {
      const state = this.inspectSetting(definitionItem, target);
      values.set(definitionItem.relativeKey, state.value);
      return { definitionItem, state };
    });

    const settings: SettingsSettingModel[] = inspectedValues.map(({ definitionItem, state }) => ({
      key: definitionItem.fullKey,
      categoryId: definitionItem.categoryId,
      card: t(definitionItem.cardKey),
      label: t(definitionItem.labelKey),
      description: t(definitionItem.descriptionKey),
      control: getPresentedSettingControl(definitionItem),
      value: getPresentedSettingValue(definitionItem, state.value),
      valueToken: state.valueToken,
      configured: state.configured,
      modified: state.modified,
      invalid: state.invalid,
      experimental: definitionItem.experimental === true,
      sourceBadge: definitionItem.sourceBadge,
      resourceImpact: definitionItem.resourceImpact === true,
      canReset:
        state.modified &&
        (state.invalid || definitionItem.control !== "switch" || target.kind !== "global"),
      disabledReason:
        definitionItem.dependency && !definitionItem.dependency.isSatisfied(values)
          ? t(definitionItem.dependency.reasonKey)
          : undefined,
      overriddenBy: this.getOverrideLabel(definitionItem, target),
      unit: definitionItem.unitKey ? t(definitionItem.unitKey) : undefined,
      minimum: definitionItem.minimum,
      maximum: definitionItem.maximum,
      step: definitionItem.step,
      options: getPresentedSettingOptions(definitionItem)?.map((item) => ({
        value: item.value,
        label: t(item.labelKey),
        description: item.descriptionKey ? t(item.descriptionKey) : undefined
      }))
    }));

    const pages: SettingsPageModel[] = PAGE_DEFINITIONS.flatMap((page) => {
      const settingCount = settings.filter((setting) => setting.categoryId === page.id).length;
      if (page.kind === "settings" && settingCount === 0) {
        return [];
      }
      return [{
        id: page.id,
        kind: page.kind,
        group: page.group,
        icon: page.icon,
        label: t("settingsPanel.category." + page.id + ".label"),
        ...(page.kind === "about"
          ? {}
          : { description: t("settingsPanel.category." + page.id + ".description") }),
        settingCount: page.kind === "settings" ? settingCount : undefined
      }];
    });

    this.revision += 1;
    return {
      version: 2,
      revision: this.revision,
      language: resolveUiLanguage(),
      title: t("settingsPanel.title"),
      activeTargetId: target.id,
      targets,
      pages,
      settings,
      maintenanceCards: this.buildMaintenanceCards(),
      about: this.buildAboutModel(),
      labels: {
        target: t("settingsPanel.target"),
        navigation: t("settingsPanel.navigation"),
        navigationSettings: t("settingsPanel.navigation.settings"),
        navigationManagement: t("settingsPanel.navigation.management"),
        navigationInformation: t("settingsPanel.navigation.information"),
        collapseNavigation: t("settingsPanel.navigation.collapse"),
        expandNavigation: t("settingsPanel.navigation.expand"),
        openNavigation: t("settingsPanel.navigation.open"),
        closeNavigation: t("settingsPanel.navigation.close"),
        invalid: t("settingsPanel.invalid"),
        experimental: t("settingsPanel.experimental"),
        codexBadge: t("settingsPanel.sourceBadge.codex"),
        claudeBadge: t("settingsPanel.sourceBadge.claude"),
        resourceImpact: t("settingsPanel.resourceImpact"),
        overridden: t("settingsPanel.overridden"),
        resetSetting:
          target.kind === "global"
            ? t("settingsPanel.resetDefaultTooltip")
            : t("settingsPanel.resetInheritedTooltip"),
        browseFolder: t("settingsPanel.browseFolder"),
        saving: t("settingsPanel.saving"),
        saved: t("settingsPanel.saved"),
        selectAtLeastOne: t("settingsPanel.selectAtLeastOne"),
        invalidValue: t("settingsPanel.error.invalidValue")
      }
    };
  }

  private buildMaintenanceCards(): SettingsMaintenanceCardModel[] {
    const action = (
      id: SettingsMaintenanceActionId,
      tone: "normal" | "warning" | "danger" = "normal"
    ) => ({
      id,
      label: t("settingsPanel.maintenance.action." + id + ".label"),
      description: t("settingsPanel.maintenance.action." + id + ".description"),
      buttonLabel: t("settingsPanel.maintenance.action." + id + ".button"),
      tone
    });
    return [
      {
        id: "settings",
        title: t("settingsPanel.maintenance.card.settings"),
        actions: [action("resetSettings", "warning")]
      },
      {
        id: "backupUser",
        title: t("settingsPanel.maintenance.card.backupUser"),
        actions: [
          action("exportUserSettings"),
          action("importUserSettings", "warning")
        ]
      },
      {
        id: "backupWorkspace",
        title: t("settingsPanel.maintenance.card.backupWorkspace"),
        actions: [
          action("exportWorkspaceSettings"),
          action("importWorkspaceSettings", "warning")
        ]
      },
      {
        id: "backupFolder",
        title: t("settingsPanel.maintenance.card.backupFolder"),
        actions: [
          action("exportFolderSettings"),
          action("importFolderSettings", "warning")
        ]
      },
      {
        id: "cache",
        title: t("settingsPanel.maintenance.card.cache"),
        actions: [action("rebuildCache"), action("rebuildSearchIndex")]
      },
      {
        id: "cleanup",
        title: t("settingsPanel.maintenance.card.cleanup"),
        actions: [
          action("clearSearchHistory"),
          action("cleanupMissingPins"),
          action("cleanupHandoffs", "warning"),
          action("emptyTrash", "danger")
        ]
      },
      {
        id: "advanced",
        title: t("settingsPanel.maintenance.card.advanced"),
        actions: [action("openNativeSettings")]
      }
    ];
  }

  private buildAboutModel(): SettingsAboutModel {
    const packageJson: unknown = this.context.extension.packageJSON;
    const version = readPackageString(packageJson, "version") ?? "2.13.0";
    const licenseName = readPackageString(packageJson, "license") ?? "MIT";
    const currentYear = new Date().getFullYear();
    const copyrightEndYear = Number.isSafeInteger(currentYear) && currentYear >= COPYRIGHT_START_YEAR
      ? currentYear
      : COPYRIGHT_START_YEAR;
    const copyrightYears = copyrightEndYear === COPYRIGHT_START_YEAR
      ? String(COPYRIGHT_START_YEAR)
      : `${COPYRIGHT_START_YEAR}-${copyrightEndYear}`;
    const copyright = t("settingsPanel.about.copyright", copyrightYears);
    return {
      displayName: t("settingsPanel.productName"),
      headerMetadata: t("settingsPanel.headerMetadata", version, licenseName, copyright),
      versionLabel: t("settingsPanel.about.version"),
      version,
      licenseLabel: t("settingsPanel.about.license"),
      licenseName,
      copyright,
      versionTab: t("settingsPanel.about.versionTab"),
      licenseTab: t("settingsPanel.about.licenseTab"),
      thirdPartyTab: t("settingsPanel.about.thirdPartyTab"),
      starLabel: t("settingsPanel.about.star"),
      starTooltip: t("settingsPanel.about.starTooltip"),
      sponsorLabel: t("settingsPanel.about.sponsor"),
      sponsorTooltip: t("settingsPanel.about.sponsorTooltip"),
      resourcesLabel: t("settingsPanel.about.resources"),
      securityPolicyLabel: t("settingsPanel.about.securityPolicy"),
      securityPolicyTooltip: t("settingsPanel.about.securityPolicyTooltip"),
      reportVulnerabilityLabel: t("settingsPanel.about.reportVulnerability"),
      reportVulnerabilityTooltip: t("settingsPanel.about.reportVulnerabilityTooltip"),
      changelogLabel: t("settingsPanel.about.changelog"),
      changelogTooltip: t("settingsPanel.about.changelogTooltip"),
      commandReferenceLabel: t("settingsPanel.about.commandReference"),
      commandReferenceTooltip: t("settingsPanel.about.commandReferenceTooltip"),
      licenseText: this.getBundledDocumentText(this.licenseText),
      thirdPartyText: this.getBundledDocumentText(this.thirdPartyText)
    };
  }

  private getBundledDocumentText(document: string | undefined): string {
    if (document !== undefined) {
      return document;
    }
    return t(
      this.bundledDocumentsLoaded
        ? "settingsPanel.about.documentUnavailable"
        : "settingsPanel.about.documentLoading"
    );
  }

  private async loadBundledDocuments(): Promise<void> {
    const [licenseText, thirdPartyText] = await Promise.all([
      readFirstBundledText(this.context.extensionUri, ["LICENSE.txt", "LICENSE"]),
      readBundledText(this.context.extensionUri, "THIRD_PARTY_NOTICES.txt")
    ]);
    this.licenseText = licenseText;
    this.thirdPartyText = thirdPartyText;
    this.bundledDocumentsLoaded = true;
    this.scheduleSnapshot();
  }

  private inspectSetting(
    definitionItem: SettingsDefinition,
    target: TargetContext
  ): {
    value: SettingsPanelValue;
    configured: boolean;
    modified: boolean;
    invalid: boolean;
    valueToken: string;
  } {
    const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION, target.resource);
    const inspected = configuration.inspect<unknown>(definitionItem.relativeKey);
    const rawValue = this.readTargetValue(definitionItem, target);
    const configured = rawValue !== undefined;
    const inheritedValue = this.readInheritedValue(definitionItem, target, inspected);
    const baseline = normalizeSettingValue(definitionItem, inheritedValue);
    const normalized = configured ? normalizeSettingValue(definitionItem, rawValue) : baseline;
    const modified = isSettingModified(configured, normalized, baseline);
    const fingerprint = configured
      ? this.getTargetIdentity(target) + ":configured:" + fingerprintValue(rawValue)
      : this.getTargetIdentity(target) + ":inherited:" + fingerprintValue(inheritedValue);
    const key = this.tokenKey(target.id, definitionItem.fullKey);
    const previous = this.valueTokens.get(key);
    const valueToken =
      previous?.fingerprint === fingerprint ? previous.token : randomBytes(18).toString("base64url");
    this.valueTokens.set(key, {
      targetId: target.id,
      fullKey: definitionItem.fullKey,
      fingerprint,
      token: valueToken
    });
    return {
      value: normalized.value,
      configured,
      modified,
      invalid: normalized.invalid,
      valueToken
    };
  }

  private readInheritedValue(
    definitionItem: SettingsDefinition,
    target: TargetContext,
    inspected: ReturnType<vscode.WorkspaceConfiguration["inspect"]>
  ): unknown {
    if (!inspected) {
      return definitionItem.defaultValue;
    }
    if (target.kind === "global") {
      return inspected.defaultValue ?? definitionItem.defaultValue;
    }
    if (target.kind === "workspace") {
      return inspected.globalValue ?? inspected.defaultValue ?? definitionItem.defaultValue;
    }
    return inspected.workspaceValue ?? inspected.globalValue ?? inspected.defaultValue ?? definitionItem.defaultValue;
  }

  private getOverrideLabel(
    definitionItem: SettingsDefinition,
    target: TargetContext
  ): string | undefined {
    if (target.kind === "workspaceFolder") {
      return undefined;
    }
    const inspected = vscode.workspace
      .getConfiguration(CONFIGURATION_SECTION, target.resource)
      .inspect<unknown>(definitionItem.relativeKey);
    if (!inspected) {
      return undefined;
    }
    if (target.kind === "global" && inspected.workspaceValue !== undefined) {
      return t("settingsPanel.target.workspace");
    }
    if (definitionItem.scope !== "resource") {
      return undefined;
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const folderInspection = vscode.workspace
        .getConfiguration(CONFIGURATION_SECTION, folder.uri)
        .inspect<unknown>(definitionItem.relativeKey);
      if (folderInspection?.workspaceFolderValue !== undefined) {
        return t("settingsPanel.target.folder", folder.name);
      }
    }
    return undefined;
  }

  private tokenKey(targetId: string, fullKey: string): string {
    return targetId + "\u0000" + fullKey;
  }

  private rebuildFolderTargets(): void {
    this.foldersById.clear();
    const activeFolderUris = new Set<string>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const uriKey = folder.uri.toString();
      activeFolderUris.add(uriKey);
      let id = this.folderIdsByUri.get(uriKey);
      if (!id) {
        id = "folder:" + this.nextFolderId;
        this.nextFolderId += 1;
        this.folderIdsByUri.set(uriKey, id);
      }
      this.foldersById.set(id, folder);
    }
    for (const uriKey of this.folderIdsByUri.keys()) {
      if (!activeFolderUris.has(uriKey)) {
        this.folderIdsByUri.delete(uriKey);
      }
    }
    const hasWorkspace = Boolean(vscode.workspace.workspaceFile) || (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
    for (const [key, state] of this.valueTokens) {
      const targetStillExists =
        state.targetId === GLOBAL_TARGET_ID ||
        (state.targetId === WORKSPACE_TARGET_ID && hasWorkspace) ||
        this.foldersById.has(state.targetId);
      if (!targetStillExists) {
        this.valueTokens.delete(key);
      }
    }
  }

  private getTargetModels(): SettingsTargetModel[] {
    const targets: SettingsTargetModel[] = [
      { id: GLOBAL_TARGET_ID, kind: "global", label: t("settingsPanel.target.global") }
    ];
    if (vscode.workspace.workspaceFile || (vscode.workspace.workspaceFolders?.length ?? 0) > 0) {
      targets.push({
        id: WORKSPACE_TARGET_ID,
        kind: "workspace",
        label: t("settingsPanel.target.workspace")
      });
    }
    for (const [id, folder] of this.foldersById) {
      targets.push({
        id,
        kind: "workspaceFolder",
        label: t("settingsPanel.target.folder", folder.name)
      });
    }
    return targets;
  }

  private getTargetContext(targetId: string): TargetContext | undefined {
    if (targetId === GLOBAL_TARGET_ID) {
      return { id: targetId, kind: "global" };
    }
    if (targetId === WORKSPACE_TARGET_ID) {
      return vscode.workspace.workspaceFile || (vscode.workspace.workspaceFolders?.length ?? 0) > 0
        ? {
            id: targetId,
            kind: "workspace",
            workspaceIdentity: this.getWorkspaceIdentity()
          }
        : undefined;
    }
    const folder = this.foldersById.get(targetId);
    return folder ? { id: targetId, kind: "workspaceFolder", resource: folder.uri } : undefined;
  }

  private getWorkspaceIdentity(): string {
    const workspaceFile = vscode.workspace.workspaceFile;
    if (workspaceFile) {
      return "workspace-file:" + workspaceFile.toString();
    }
    const folderUris = (vscode.workspace.workspaceFolders ?? [])
      .map((folder) => folder.uri.toString())
      .sort();
    return "workspace-folders:" + JSON.stringify(folderUris);
  }

  private getTargetIdentity(target: TargetContext): string {
    return target.kind === "workspace"
      ? target.id + ":" + (target.workspaceIdentity ?? "unavailable")
      : target.id;
  }

  private isSameTargetAvailable(expected: TargetContext): boolean {
    this.rebuildFolderTargets();
    const current = this.getTargetContext(expected.id);
    return Boolean(
      current &&
      current.kind === expected.kind &&
      current.resource?.toString() === expected.resource?.toString() &&
      current.workspaceIdentity === expected.workspaceIdentity
    );
  }

  private createHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(18).toString("base64");
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "settingsPanel.css")
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "settingsPanel.js")
    );
    const language = resolveUiLanguage();
    const csp = [
      "default-src 'none'",
      "style-src " + webview.cspSource,
      "script-src 'nonce-" + nonce + "'",
      "img-src 'none'",
      "font-src 'none'",
      "connect-src 'none'"
    ].join("; ");
    return [
      "<!DOCTYPE html>",
      '<html lang="' + escapeHtml(language) + '">',
      "<head>",
      '<meta charset="UTF-8">',
      '<meta http-equiv="Content-Security-Policy" content="' + escapeHtml(csp) + '">',
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
      '<link rel="stylesheet" href="' + escapeHtml(styleUri.toString()) + '">',
      "<title>" + escapeHtml(t("settingsPanel.title")) + "</title>",
      "</head>",
      "<body>",
      '<div id="app" class="settings-app"></div>',
      '<script nonce="' + escapeHtml(nonce) + '" src="' + escapeHtml(scriptUri.toString()) + '"></script>',
      "</body>",
      "</html>"
    ].join("\n");
  }
}

function toConfigurationTarget(kind: SettingsTargetKind): vscode.ConfigurationTarget {
  if (kind === "global") {
    return vscode.ConfigurationTarget.Global;
  }
  if (kind === "workspace") {
    return vscode.ConfigurationTarget.Workspace;
  }
  return vscode.ConfigurationTarget.WorkspaceFolder;
}

function fingerprintValue(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "unserializable:" + typeof value : encoded;
  } catch {
    return "unserializable:" + typeof value;
  }
}

async function readBundledText(
  extensionUri: vscode.Uri,
  filename: string
): Promise<string | undefined> {
  try {
    const resource = vscode.Uri.joinPath(extensionUri, filename);
    const stat = await vscode.workspace.fs.stat(resource);
    if ((stat.type & vscode.FileType.File) === 0 || stat.size > MAX_BUNDLED_TEXT_BYTES) {
      return undefined;
    }
    const bytes = await vscode.workspace.fs.readFile(resource);
    if (bytes.byteLength > MAX_BUNDLED_TEXT_BYTES) {
      return undefined;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

async function readFirstBundledText(
  extensionUri: vscode.Uri,
  filenames: readonly string[]
): Promise<string | undefined> {
  for (const filename of filenames) {
    const text = await readBundledText(extensionUri, filename);
    if (text !== undefined) {
      return text;
    }
  }
  return undefined;
}

function buildSettingsBackupDefaultUri(target: SettingsBackupTarget, exportedAt: string): vscode.Uri {
  const type =
    target.kind === "global" ? "user" : target.kind === "workspace" ? "workspace" : "folder";
  const safeName = target.kind === "global" ? undefined : sanitizeBackupFilenamePart(target.name);
  const timestamp = exportedAt.slice(0, 19).replace("T", "_").replace(/:/g, "-") + "Z";
  const parts = [SETTINGS_BACKUP_FORMAT, type];
  if (safeName) {
    parts.push(safeName);
  }
  parts.push(timestamp);
  const filename = parts.join("-") + ".json";
  return vscode.Uri.file(path.join(os.homedir(), filename));
}

function sanitizeBackupFilenamePart(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const sanitized = Array.from(
    value
      .normalize("NFC")
      .replace(/[\u0000-\u001f\u007f<>:"/\\|?*\u202a-\u202e\u2066-\u2069]/gu, "-")
      .replace(/\s+/gu, "-")
      .replace(/-+/gu, "-")
      .replace(/^[.\- ]+|[.\- ]+$/gu, "")
  )
    .slice(0, 60)
    .join("")
    .replace(/[.\- ]+$/gu, "");
  return sanitized || undefined;
}

function readPackageString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[key];
  return typeof candidate === "string" && candidate.length > 0 && candidate.length <= 128
    ? candidate
    : undefined;
}

function parseAboutResourceId(value: unknown): AboutResourceId | undefined {
  switch (value) {
    case "repository":
    case "securityPolicy":
    case "reportVulnerability":
    case "changelog":
    case "commandReference":
      return value;
    default:
      return undefined;
  }
}

function isSafeRequestId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSettingsTargetKind(value: unknown): value is SettingsTargetKind {
  return value === "global" || value === "workspace" || value === "workspaceFolder";
}

function isBackupName(value: unknown): value is string {
  return isSafeBackupMetadata(value, MAX_SETTINGS_BACKUP_NAME_LENGTH);
}

function isBackupUri(value: unknown): value is string {
  return isSafeBackupMetadata(value, MAX_SETTINGS_BACKUP_URI_LENGTH);
}

function isSafeBackupMetadata(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !BACKUP_METADATA_CONTROL_CHARACTERS.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
