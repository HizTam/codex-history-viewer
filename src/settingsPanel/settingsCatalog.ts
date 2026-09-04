import type {
  SettingsControlKind,
  SettingsPanelValue,
  SettingsSourceBadge,
  SettingsTargetKind
} from "./settingsPanelTypes";

export type SettingScope = "application" | "window" | "resource";

export interface SettingsOptionDefinition {
  value: string;
  labelKey: string;
  descriptionKey?: string;
}

export interface SettingsDependency {
  reasonKey: string;
  isSatisfied: (values: ReadonlyMap<string, SettingsPanelValue>) => boolean;
}

export interface SettingsDefinition {
  relativeKey: string;
  fullKey: string;
  categoryId: string;
  cardKey: string;
  labelKey: string;
  descriptionKey: string;
  control: SettingsControlKind;
  scope: SettingScope;
  defaultValue: SettingsPanelValue;
  experimental?: boolean;
  sourceBadge?: SettingsSourceBadge;
  resourceImpact?: boolean;
  minimum?: number;
  maximum?: number;
  step?: number;
  unitKey?: string;
  options?: readonly SettingsOptionDefinition[];
  dependency?: SettingsDependency;
  presentation?: "resumeActions";
}

export interface ValidatedSettingValue {
  ok: boolean;
  value?: SettingsPanelValue;
  error: "invalid" | "range" | "empty";
}

export interface NormalizedSettingValue {
  value: SettingsPanelValue;
  invalid: boolean;
}

const SETTINGS_PREFIX = "codexHistoryViewer.";
const PATH_MAX_LENGTH = 32_768;
const PATH_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const PATH_URI_SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/u;

function option(
  relativeKey: string,
  value: string,
  includeDescription = false
): SettingsOptionDefinition {
  const prefix = "settingsPanel.option." + relativeKey + "." + value;
  return {
    value,
    labelKey: prefix + ".label",
    descriptionKey: includeDescription ? prefix + ".description" : undefined
  };
}

function definition(
  relativeKey: string,
  categoryId: string,
  cardId: string,
  control: SettingsControlKind,
  scope: SettingScope,
  defaultValue: SettingsPanelValue,
  extra: Partial<SettingsDefinition> = {}
): SettingsDefinition {
  const prefix = "settingsPanel.setting." + relativeKey;
  return {
    relativeKey,
    fullKey: SETTINGS_PREFIX + relativeKey,
    categoryId,
    cardKey: "settingsPanel.card." + cardId,
    labelKey: prefix + ".label",
    descriptionKey: prefix + ".description",
    control,
    scope,
    defaultValue,
    ...extra
  };
}

function includesSource(source: string): SettingsDependency {
  return {
    reasonKey: "settingsPanel.disabled.source." + source,
    isSatisfied: (values) => {
      const enabled = values.get("sources.enabled");
      return Array.isArray(enabled) && enabled.includes(source);
    }
  };
}

function booleanDependency(relativeKey: string, reasonKey: string): SettingsDependency {
  return {
    reasonKey,
    isSatisfied: (values) => values.get(relativeKey) === true
  };
}

function enumDependency(relativeKey: string, expected: string, reasonKey: string): SettingsDependency {
  return {
    reasonKey,
    isSatisfied: (values) => values.get(relativeKey) === expected
  };
}

const CODEX_SOURCE = includesSource("codex");
const CLAUDE_SOURCE = includesSource("claude");

export const SETTINGS_DEFINITIONS: readonly SettingsDefinition[] = [
  definition("ui.language", "general", "general.display", "select", "application", "auto", {
    options: ["auto", "ja", "en"].map((value) => option("ui.language", value))
  }),
  definition("delete.useTrash", "general", "general.safety", "switch", "application", true),
  definition("webview.restoreAfterReload", "general", "general.startup", "switch", "window", false, {
    experimental: true
  }),

  definition("sources.enabled", "sources", "sources.load", "multi", "application", ["codex"], {
    options: ["codex", "claude"].map((value) => option("sources.enabled", value, true))
  }),
  definition("sessionsRoot", "sources", "sources.codex", "path", "application", "", {
    dependency: CODEX_SOURCE,
    sourceBadge: "codex"
  }),
  definition(
    "codex.archivedSessions.enabled",
    "sources",
    "sources.codex",
    "switch",
    "application",
    false,
    { dependency: CODEX_SOURCE, sourceBadge: "codex" }
  ),
  definition(
    "codex.archivedSessionsRoot",
    "sources",
    "sources.codex",
    "path",
    "application",
    "",
    {
      dependency: {
        reasonKey: "settingsPanel.disabled.codexArchive",
        isSatisfied: (values) =>
          CODEX_SOURCE.isSatisfied(values) && values.get("codex.archivedSessions.enabled") === true
      },
      sourceBadge: "codex"
    }
  ),
  definition("claude.sessionsRoot", "sources", "sources.claude", "path", "application", "", {
    dependency: CLAUDE_SOURCE,
    sourceBadge: "claude"
  }),

  definition("preview.openOnSelection", "history", "history.behavior", "switch", "application", true),
  definition("history.dateBasis", "history", "history.behavior", "select", "application", "started", {
    options: ["started", "lastActivity"].map((value) => option("history.dateBasis", value))
  }),
  definition(
    "history.titleSource",
    "history",
    "history.behavior",
    "select",
    "application",
    "generated",
    {
      options: ["generated", "nativeWhenAvailable"].map((value) =>
        option("history.titleSource", value, true)
      )
    }
  ),
  definition("ui.timeGuide.enabled", "history", "history.behavior", "switch", "application", false),
  definition(
    "sessionRow.showTimestamp",
    "history",
    "history.sessionRows",
    "switch",
    "application",
    true
  ),
  definition(
    "sessionRow.showProject",
    "history",
    "history.sessionRows",
    "switch",
    "application",
    true
  ),
  definition("preview.tooltipMode", "history", "history.tooltip", "select", "application", "full", {
    options: ["full", "compact", "titleOnly"].map((value) => option("preview.tooltipMode", value)),
    resourceImpact: true
  }),
  definition("preview.maxMessages", "history", "history.tooltip", "number", "application", 6, {
    minimum: 1,
    maximum: 50,
    step: 1,
    resourceImpact: true,
    dependency: enumDependency(
      "preview.tooltipMode",
      "full",
      "settingsPanel.disabled.fullTooltip"
    )
  }),
  definition("autoRefresh.enabled", "history", "history.refresh", "switch", "application", false, {
    resourceImpact: true
  }),
  definition("autoRefresh.debounceMs", "history", "history.refresh", "number", "application", 2000, {
    minimum: 500,
    maximum: 60_000,
    step: 100,
    unitKey: "settingsPanel.unit.ms",
    resourceImpact: true,
    dependency: booleanDependency("autoRefresh.enabled", "settingsPanel.disabled.autoRefresh")
  }),
  definition(
    "autoRefresh.minIntervalMs",
    "history",
    "history.refresh",
    "number",
    "application",
    5000,
    {
      minimum: 1000,
      maximum: 300_000,
      step: 100,
      unitKey: "settingsPanel.unit.ms",
      resourceImpact: true,
      dependency: booleanDependency("autoRefresh.enabled", "settingsPanel.disabled.autoRefresh")
    }
  ),

  definition("search.defaultRoles", "search", "search.defaults", "multi", "application", [
    "user",
    "assistant"
  ], {
    options: ["user", "assistant", "developer", "tool"].map((value) =>
      option("search.defaultRoles", value, true)
    )
  }),
  definition("search.caseSensitive", "search", "search.defaults", "switch", "application", false),
  definition("search.maxResults", "search", "search.defaults", "number", "application", 500, {
    minimum: 1,
    maximum: 10_000,
    step: 1,
    resourceImpact: true
  }),
  definition(
    "search.indexToolContent",
    "search",
    "search.index",
    "select",
    "application",
    "toolCallsAndOutputs",
    {
      options: ["conversationOnly", "toolCalls", "toolCallsAndOutputs"].map((value) =>
        option("search.indexToolContent", value)
      ),
      resourceImpact: true
    }
  ),

  definition("chat.openPosition", "session", "session.content", "select", "application", "top", {
    options: ["top", "lastMessage", "latest"].map((value) => option("chat.openPosition", value))
  }),
  definition("chat.stickyUserPrompt", "session", "session.content", "switch", "application", true),
  definition(
    "chat.performanceMode",
    "session",
    "session.content",
    "select",
    "application",
    "auto",
    {
      options: ["auto", "normal", "simplified"].map((value) =>
        option("chat.performanceMode", value, true)
      ),
      resourceImpact: true
    }
  ),
  definition(
    "chat.toolDisplayMode",
    "session",
    "session.content",
    "select",
    "application",
    "detailsOnly",
    {
      options: ["detailsOnly", "compactCards"].map((value) =>
        option("chat.toolDisplayMode", value, true)
      ),
      resourceImpact: true
    }
  ),
  definition(
    "chat.userLongMessageFolding",
    "session",
    "session.content",
    "select",
    "application",
    "off",
    {
      options: ["off", "auto", "always"].map((value) =>
        option("chat.userLongMessageFolding", value)
      )
    }
  ),
  definition(
    "chat.assistantLongMessageFolding",
    "session",
    "session.content",
    "select",
    "application",
    "off",
    {
      options: ["off", "auto", "always"].map((value) =>
        option("chat.assistantLongMessageFolding", value)
      )
    }
  ),
  definition(
    "chat.turnTimeline.mode",
    "session",
    "session.content",
    "select",
    "window",
    "off",
    {
      options: ["off", "basic", "live"].map((value) => option("chat.turnTimeline.mode", value)),
      resourceImpact: true
    }
  ),
  definition("agentRuns.enabled", "session", "session.navigation", "switch", "application", false, {
    experimental: true,
    sourceBadge: "codex",
    resourceImpact: true
  }),
  definition(
    "branchNavigation.enabled",
    "session",
    "session.navigation",
    "switch",
    "application",
    false,
    { experimental: true, resourceImpact: true }
  ),
  definition("images.enabled", "session", "session.images", "switch", "application", true, {
    resourceImpact: true
  }),
  definition("images.maxSizeMB", "session", "session.images", "number", "application", 20, {
    minimum: 1,
    maximum: 100,
    step: 1,
    unitKey: "settingsPanel.unit.mb",
    resourceImpact: true,
    dependency: booleanDependency("images.enabled", "settingsPanel.disabled.images")
  }),
  definition(
    "images.thumbnailSize",
    "session",
    "session.images",
    "select",
    "application",
    "medium",
    {
      options: ["small", "medium", "large"].map((value) =>
        option("images.thumbnailSize", value)
      ),
      dependency: booleanDependency("images.enabled", "settingsPanel.disabled.images")
    }
  ),

  definition("resume.openTarget", "resume", "resume.resume", "select", "application", "sidebar", {
    options: ["sidebar", "panel"].map((value) => option("resume.openTarget", value, true)),
    sourceBadge: "codex"
  }),
  definition(
    "resume.codexMethod",
    "resume",
    "resume.resume",
    "select",
    "application",
    "extension",
    {
      options: ["extension", "cli", "both"].map((value) =>
        option("resume.codexMethod", value, true)
      ),
      presentation: "resumeActions",
      sourceBadge: "codex"
    }
  ),
  definition(
    "resume.claudeMethod",
    "resume",
    "resume.resume",
    "select",
    "application",
    "extension",
    {
      options: ["extension", "cli", "both"].map((value) =>
        option("resume.claudeMethod", value, true)
      ),
      presentation: "resumeActions",
      sourceBadge: "claude"
    }
  ),
  definition("handoff.enabled", "resume", "resume.integration", "switch", "application", true),
  definition(
    "fileChangeHistory.explorerContextMenu.enabled",
    "resume",
    "resume.integration",
    "switch",
    "resource",
    false
  )
];

export const HIDDEN_SETTINGS = new Set([
  "codexHistoryViewer.ui.alwaysShowHeaderActions",
  "codexHistoryViewer.debug.logging.enabled"
]);

const DEFINITIONS_BY_FULL_KEY = new Map(
  SETTINGS_DEFINITIONS.map((item) => [item.fullKey, item] as const)
);

export function getSettingsDefinition(fullKey: string): SettingsDefinition | undefined {
  return DEFINITIONS_BY_FULL_KEY.get(fullKey);
}

export function supportsTarget(scope: SettingScope, targetKind: SettingsTargetKind): boolean {
  if (targetKind === "global") {
    return true;
  }
  if (targetKind === "workspace") {
    return scope === "window" || scope === "resource";
  }
  return scope === "resource";
}

export function cloneSettingValue(value: SettingsPanelValue): SettingsPanelValue {
  return Array.isArray(value) ? [...value] : value;
}

export function getPresentedSettingControl(
  definitionItem: SettingsDefinition
): SettingsControlKind {
  return definitionItem.presentation === "resumeActions" ? "multi" : definitionItem.control;
}

export function getPresentedSettingValue(
  definitionItem: SettingsDefinition,
  value: SettingsPanelValue
): SettingsPanelValue {
  if (definitionItem.presentation !== "resumeActions") {
    return cloneSettingValue(value);
  }
  if (value === "extension") {
    return ["extension"];
  }
  if (value === "cli") {
    return ["cli"];
  }
  if (value === "both") {
    return ["extension", "cli"];
  }
  return [];
}

export function getPresentedSettingOptions(
  definitionItem: SettingsDefinition
): readonly SettingsOptionDefinition[] | undefined {
  return definitionItem.presentation === "resumeActions"
    ? definitionItem.options?.filter((item) => item.value === "extension" || item.value === "cli")
    : definitionItem.options;
}

export function getStoredSettingInput(
  definitionItem: SettingsDefinition,
  input: unknown
): unknown {
  if (definitionItem.presentation !== "resumeActions") {
    return input;
  }
  if (!Array.isArray(input) || input.length < 1 || input.length > 2) {
    return undefined;
  }
  const selected = new Set<"extension" | "cli">();
  for (const item of input) {
    if (item !== "extension" && item !== "cli") {
      return undefined;
    }
    selected.add(item);
  }
  if (selected.size !== input.length) {
    return undefined;
  }
  if (selected.size === 2) {
    return "both";
  }
  return selected.has("extension") ? "extension" : "cli";
}

export function isSettingModified(
  configured: boolean,
  current: NormalizedSettingValue,
  baseline: NormalizedSettingValue
): boolean {
  if (!configured) {
    return false;
  }
  return (
    current.invalid ||
    baseline.invalid ||
    !settingValuesEqual(current.value, baseline.value)
  );
}

function settingValuesEqual(left: SettingsPanelValue, right: SettingsPanelValue): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => item === right[index])
    );
  }
  return left === right;
}

export function validateSettingValue(
  definitionItem: SettingsDefinition,
  input: unknown
): ValidatedSettingValue {
  if (definitionItem.control === "switch") {
    return typeof input === "boolean"
      ? { ok: true, value: input, error: "invalid" }
      : { ok: false, error: "invalid" };
  }

  if (definitionItem.control === "number") {
    if (typeof input !== "number" || !Number.isSafeInteger(input)) {
      return { ok: false, error: "invalid" };
    }
    if (
      (definitionItem.minimum !== undefined && input < definitionItem.minimum) ||
      (definitionItem.maximum !== undefined && input > definitionItem.maximum)
    ) {
      return { ok: false, error: "range" };
    }
    return { ok: true, value: input, error: "invalid" };
  }

  if (definitionItem.control === "path") {
    if (typeof input !== "string") {
      return { ok: false, error: "invalid" };
    }
    const trimmed = input.trim();
    if (
      trimmed.length > PATH_MAX_LENGTH ||
      PATH_CONTROL_CHARACTERS.test(trimmed) ||
      (PATH_URI_SCHEME_PREFIX.test(trimmed) && !WINDOWS_DRIVE_PREFIX.test(trimmed))
    ) {
      return { ok: false, error: "invalid" };
    }
    return { ok: true, value: trimmed, error: "invalid" };
  }

  const allowedValues = definitionItem.options?.map((item) => item.value) ?? [];
  if (definitionItem.control === "select") {
    return typeof input === "string" && allowedValues.includes(input)
      ? { ok: true, value: input, error: "invalid" }
      : { ok: false, error: "invalid" };
  }

  if (!Array.isArray(input)) {
    return { ok: false, error: "invalid" };
  }
  if (input.length === 0) {
    return { ok: false, error: "empty" };
  }
  if (input.length > allowedValues.length) {
    return { ok: false, error: "invalid" };
  }
  if (input.some((item) => typeof item !== "string")) {
    return { ok: false, error: "invalid" };
  }
  const stringInput = input as string[];
  const uniqueInput = new Set(stringInput);
  if (
    uniqueInput.size !== stringInput.length ||
    [...uniqueInput].some((item) => !allowedValues.includes(item))
  ) {
    return { ok: false, error: "invalid" };
  }
  const ordered = allowedValues.filter((item) => uniqueInput.has(item));
  return { ok: true, value: ordered, error: "invalid" };
}

export function normalizeSettingValue(
  definitionItem: SettingsDefinition,
  input: unknown
): NormalizedSettingValue {
  const validation = validateSettingValue(definitionItem, input);
  if (validation.ok && validation.value !== undefined) {
    return { value: cloneSettingValue(validation.value), invalid: false };
  }

  if (definitionItem.control === "number" && typeof input === "number" && Number.isFinite(input)) {
    const minimum = definitionItem.minimum ?? Number.MIN_SAFE_INTEGER;
    const maximum = definitionItem.maximum ?? Number.MAX_SAFE_INTEGER;
    return {
      value: Math.max(minimum, Math.min(maximum, Math.round(input))),
      invalid: true
    };
  }

  if (definitionItem.control === "multi" && Array.isArray(input)) {
    const allowedValues = definitionItem.options?.map((item) => item.value) ?? [];
    const supplied = new Set(input.filter((item): item is string => typeof item === "string"));
    const filtered = allowedValues.filter((item) => supplied.has(item));
    if (filtered.length > 0) {
      return { value: filtered, invalid: true };
    }
  }

  return { value: cloneSettingValue(definitionItem.defaultValue), invalid: true };
}
