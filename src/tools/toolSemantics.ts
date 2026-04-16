import { t } from "../i18n";
import type { ChatToolItem } from "../chat/chatTypes";
import type { ChatToolPresentation, NormalizedToolKind } from "./toolTypes";

type JsonLikeRecord = Record<string, unknown>;

const TOOL_KIND_ALIASES: Record<NormalizedToolKind, readonly string[]> = {
  bash: ["bash", "shell", "shell_command", "powershell", "run_command", "run_in_terminal"],
  read: ["read", "read_file", "open_file", "cat", "view_file", "read_mcp_resource"],
  write: ["write", "write_file", "create_file", "create", "delete_file", "rename_file", "move_file"],
  edit: ["edit", "apply_patch", "multi_edit", "str_replace", "replace", "insert", "delete", "rename", "move"],
  grep: ["grep", "search_file_content", "search_text", "find_in_file"],
  glob: ["glob", "find_files", "search_files", "list_files"],
  webSearch: ["web_search", "search_query", "image_query", "websearch"],
  webFetch: ["web_fetch", "fetch", "open", "open_url"],
  agent: ["agent", "spawn_agent", "send_input", "wait_agent", "resume_agent", "close_agent", "update_plan"],
  unknown: [],
};

const FILE_PATH_KEYS = [
  "path",
  "file",
  "file_path",
  "filepath",
  "filePath",
  "target_file",
  "targetPath",
  "fsPath",
  "relative_workspace_path",
] as const;

const COMMAND_KEYS = ["command", "cmd", "script"] as const;
const WORKDIR_KEYS = ["workdir", "cwd", "working_directory"] as const;
const QUERY_KEYS = ["q", "query", "pattern", "search", "search_query"] as const;
const URL_KEYS = ["url", "uri", "href", "ref_id"] as const;

export function buildToolPresentation(tool: ChatToolItem): ChatToolPresentation {
  const normalizedName = normalizeToolName(tool.name);
  const parsedArgs = parseToolPayload(tool.argumentsText);
  const parsedOutput = parseToolPayload(tool.outputText);
  const toolKind = resolveToolKind(normalizedName);
  const fallbackTitle = getLocalizedTitle(toolKind);
  const primaryFallback = normalizeInlineText(tool.name) || "tool";

  switch (toolKind) {
    case "bash":
      return {
        toolKind,
        title: fallbackTitle,
        primaryText: firstNonEmpty(extractString(parsedArgs, COMMAND_KEYS), primaryFallback),
        secondaryText: buildShellSecondary(parsedArgs),
        badgeText: buildShellBadge(parsedOutput, tool.outputText),
        severity: detectShellSeverity(parsedOutput, tool.outputText),
        messageIndex: tool.messageIndex,
      };
    case "read": {
      const filePath = extractFilePath(parsedArgs);
      return {
        toolKind,
        title: fallbackTitle,
        primaryText: firstNonEmpty(filePath, primaryFallback),
        secondaryText: buildReadSecondary(parsedArgs),
        relatedFilePath: filePath,
        messageIndex: tool.messageIndex,
      };
    }
    case "write": {
      const filePath = extractFilePath(parsedArgs);
      return {
        toolKind,
        title: fallbackTitle,
        primaryText: firstNonEmpty(filePath, primaryFallback),
        secondaryText: buildWriteSecondary(parsedArgs),
        badgeText: buildWriteBadge(normalizedName),
        relatedFilePath: filePath,
        messageIndex: tool.messageIndex,
      };
    }
    case "edit": {
      const filePath = extractFilePath(parsedArgs);
      return {
        toolKind,
        title: fallbackTitle,
        primaryText: firstNonEmpty(filePath, primaryFallback),
        secondaryText: buildEditSecondary(parsedArgs),
        badgeText: buildEditBadge(normalizedName),
        relatedFilePath: filePath,
        messageIndex: tool.messageIndex,
      };
    }
    case "grep":
      return {
        toolKind,
        title: fallbackTitle,
        primaryText: firstNonEmpty(extractString(parsedArgs, QUERY_KEYS), primaryFallback),
        secondaryText: buildScopedSecondary(parsedArgs),
        messageIndex: tool.messageIndex,
      };
    case "glob":
      return {
        toolKind,
        title: fallbackTitle,
        primaryText: firstNonEmpty(extractString(parsedArgs, QUERY_KEYS), primaryFallback),
        secondaryText: buildScopedSecondary(parsedArgs),
        messageIndex: tool.messageIndex,
      };
    case "webSearch":
      return {
        toolKind,
        title: fallbackTitle,
        primaryText: firstNonEmpty(extractString(parsedArgs, QUERY_KEYS), primaryFallback),
        messageIndex: tool.messageIndex,
      };
    case "webFetch":
      return {
        toolKind,
        title: fallbackTitle,
        primaryText: firstNonEmpty(extractString(parsedArgs, URL_KEYS), primaryFallback),
        messageIndex: tool.messageIndex,
      };
    case "agent":
      return {
        toolKind,
        title: fallbackTitle,
        primaryText: firstNonEmpty(extractAgentPrimary(parsedArgs), primaryFallback),
        secondaryText: buildAgentSecondary(parsedArgs),
        messageIndex: tool.messageIndex,
      };
    default:
      return {
        toolKind: "unknown",
        title: getLocalizedTitle("unknown"),
        primaryText: primaryFallback,
        secondaryText: buildUnknownSecondary(tool),
        messageIndex: tool.messageIndex,
      };
  }
}

function resolveToolKind(normalizedName: string): NormalizedToolKind {
  for (const [toolKind, aliases] of Object.entries(TOOL_KIND_ALIASES) as Array<
    [NormalizedToolKind, readonly string[]]
  >) {
    if (aliases.includes(normalizedName)) return toolKind;
  }
  return "unknown";
}

function getLocalizedTitle(toolKind: NormalizedToolKind): string {
  switch (toolKind) {
    case "bash":
      return t("chat.toolCard.title.bash");
    case "read":
      return t("chat.toolCard.title.read");
    case "write":
      return t("chat.toolCard.title.write");
    case "edit":
      return t("chat.toolCard.title.edit");
    case "grep":
      return t("chat.toolCard.title.grep");
    case "glob":
      return t("chat.toolCard.title.glob");
    case "webSearch":
      return t("chat.toolCard.title.webSearch");
    case "webFetch":
      return t("chat.toolCard.title.webFetch");
    case "agent":
      return t("chat.toolCard.title.agent");
    default:
      return t("chat.toolCard.title.unknown");
  }
}

function buildShellSecondary(parsedArgs: JsonLikeRecord | null): string | undefined {
  const cwd = extractString(parsedArgs, WORKDIR_KEYS);
  return cwd ? `CWD: ${cwd}` : undefined;
}

function buildShellBadge(parsedOutput: JsonLikeRecord | null, outputText: string | undefined): string | undefined {
  const exitCode = extractExitCode(parsedOutput, outputText);
  return typeof exitCode === "number" && exitCode !== 0 ? t("chat.toolCard.badge.exitCode", exitCode) : undefined;
}

function detectShellSeverity(
  parsedOutput: JsonLikeRecord | null,
  outputText: string | undefined,
): ChatToolPresentation["severity"] {
  const exitCode = extractExitCode(parsedOutput, outputText);
  if (typeof exitCode === "number" && exitCode !== 0) return "error";
  return undefined;
}

function buildReadSecondary(parsedArgs: JsonLikeRecord | null): string | undefined {
  const lineStart = extractNumber(parsedArgs, ["line", "lineStart", "start_line", "lineno"]);
  const lineEnd = extractNumber(parsedArgs, ["lineEnd", "end_line"]);
  if (typeof lineStart === "number" && typeof lineEnd === "number" && lineEnd >= lineStart) {
    return t("chat.toolCard.meta.linesRange", lineStart, lineEnd);
  }
  if (typeof lineStart === "number") {
    return t("chat.toolCard.meta.line", lineStart);
  }
  return undefined;
}

function buildWriteSecondary(parsedArgs: JsonLikeRecord | null): string | undefined {
  const workdir = extractString(parsedArgs, WORKDIR_KEYS);
  return workdir ? `CWD: ${workdir}` : undefined;
}

function buildWriteBadge(normalizedName: string): string | undefined {
  if (normalizedName.includes("create")) return t("chat.toolCard.badge.created");
  if (normalizedName.includes("delete")) return t("chat.toolCard.badge.deleted");
  if (normalizedName.includes("rename") || normalizedName.includes("move")) return t("chat.toolCard.badge.renamed");
  return t("chat.toolCard.badge.modified");
}

function buildEditSecondary(parsedArgs: JsonLikeRecord | null): string | undefined {
  const oldText = extractString(parsedArgs, ["old_string", "oldText", "beforeText"]);
  const newText = extractString(parsedArgs, ["new_string", "newText", "afterText"]);
  if (oldText && newText) {
    return t("chat.toolCard.meta.replaceSnippet", shortenInlineText(oldText), shortenInlineText(newText));
  }

  const patchText = extractString(parsedArgs, ["patch", "patchText"]);
  if (patchText) return t("chat.toolCard.meta.patchReady");
  return undefined;
}

function buildEditBadge(normalizedName: string): string | undefined {
  if (normalizedName.includes("apply_patch")) return t("chat.toolCard.badge.patched");
  if (normalizedName.includes("delete")) return t("chat.toolCard.badge.deleted");
  if (normalizedName.includes("rename") || normalizedName.includes("move")) return t("chat.toolCard.badge.renamed");
  return t("chat.toolCard.badge.modified");
}

function buildScopedSecondary(parsedArgs: JsonLikeRecord | null): string | undefined {
  const filePath = extractFilePath(parsedArgs);
  if (filePath) return filePath;

  const cwd = extractString(parsedArgs, WORKDIR_KEYS);
  return cwd ? `CWD: ${cwd}` : undefined;
}

function extractAgentPrimary(parsedArgs: JsonLikeRecord | null): string | undefined {
  return firstNonEmpty(
    extractString(parsedArgs, ["message", "prompt", "query"]),
    extractString(parsedArgs, ["target", "agent_id", "id"]),
  );
}

function buildAgentSecondary(parsedArgs: JsonLikeRecord | null): string | undefined {
  return firstNonEmpty(
    extractString(parsedArgs, ["agent_type", "model"]),
    extractString(parsedArgs, ["reasoning_effort"]),
  );
}

function buildUnknownSecondary(tool: ChatToolItem): string | undefined {
  if (typeof tool.callId === "string" && tool.callId.trim().length > 0) return tool.callId.trim();
  return undefined;
}

function extractFilePath(parsedArgs: JsonLikeRecord | null): string | undefined {
  return extractString(parsedArgs, FILE_PATH_KEYS);
}

function extractString(parsedArgs: JsonLikeRecord | null, keys: readonly string[]): string | undefined {
  if (!parsedArgs) return undefined;
  for (const key of keys) {
    const value = parsedArgs[key];
    const normalized = normalizeUnknownText(value);
    if (normalized) return normalized;
  }
  return undefined;
}

function extractNumber(parsedArgs: JsonLikeRecord | null, keys: readonly string[]): number | undefined {
  if (!parsedArgs) return undefined;
  for (const key of keys) {
    const value = parsedArgs[key];
    const num =
      typeof value === "number"
        ? value
        : typeof value === "string" && /^-?\d+$/u.test(value.trim())
          ? Number(value.trim())
          : NaN;
    if (Number.isFinite(num)) return num;
  }
  return undefined;
}

function extractExitCode(parsedOutput: JsonLikeRecord | null, outputText: string | undefined): number | undefined {
  const value =
    parsedOutput?.exitCode ??
    parsedOutput?.exit_code ??
    parsedOutput?.code ??
    parsedOutput?.status_code;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/u.test(value.trim())) return Number(value.trim());

  const text = typeof outputText === "string" ? outputText : "";
  const match = text.match(/\bExit code:\s*(-?\d+)\b/u);
  if (!match) return undefined;
  return Number(match[1]);
}

function parseToolPayload(text: string | undefined): JsonLikeRecord | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonLikeRecord) : null;
  } catch {
    return null;
  }
}

function normalizeToolName(name: string): string {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

function normalizeUnknownText(value: unknown): string | undefined {
  if (typeof value === "string") return normalizeInlineText(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function normalizeInlineText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function shortenInlineText(value: string, maxLength = 40): string {
  const normalized = normalizeInlineText(value);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}
