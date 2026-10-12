import type { ChatToolItem } from "../chat/chatTypes";
import type { ChatToolPresentation, NormalizedToolKind } from "./toolTypes";

type JsonLikeRecord = Record<string, unknown>;

const TOOL_KIND_ALIASES: Record<NormalizedToolKind, readonly string[]> = {
  bash: ["bash", "shell", "shell_command", "powershell", "run_command", "run_in_terminal"],
  read: ["read", "read_file", "open_file", "cat", "view_file", "read_mcp_resource"],
  write: ["write", "write_file", "create_file", "create", "delete_file", "rename_file", "move_file"],
  edit: ["edit", "apply_patch", "multi_edit", "str_replace", "replace", "insert", "delete", "rename", "move"],
  exec: ["exec", "functions_exec"],
  grep: ["grep", "search_file_content", "search_text", "find_in_file"],
  glob: ["glob", "find_files", "search_files", "list_files"],
  webSearch: ["web_search", "search_query", "image_query", "websearch"],
  webFetch: ["web_fetch", "fetch", "open", "open_url"],
  imageGeneration: ["image_generation", "image_generation_call", "imagegen"],
  sendFile: ["senduserfile"],
  agent: ["agent", "spawn_agent", "send_input", "wait_agent", "resume_agent", "close_agent", "update_plan"],
  wait: ["wait", "functions_wait"],
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
const MAX_PRESENTATION_LIST_ITEMS = 32;
const MAX_PRESENTATION_LIST_CHARS = 4096;

export function buildToolPresentation(tool: ChatToolItem): ChatToolPresentation {
  const normalizedName = normalizeToolName(tool.name);
  const parsedArgs = parseToolPayload(tool.argumentsText);
  const parsedOutput = parseToolPayload(tool.outputText);
  const toolKind = resolveToolKind(normalizedName);
  const primaryFallback = normalizeInlineText(tool.name) || "tool";

  switch (toolKind) {
    case "bash":
      return {
        toolKind,
        primaryText: firstNonEmpty(extractCommand(parsedArgs), primaryFallback),
        secondary: buildShellSecondary(parsedArgs),
        badge: buildShellBadge(parsedOutput, tool.outputText),
        severity: detectShellSeverity(parsedOutput, tool.outputText),
        messageIndex: tool.messageIndex,
      };
    case "read": {
      const filePath = extractFilePath(parsedArgs);
      return {
        toolKind,
        primaryText: firstNonEmpty(filePath, primaryFallback),
        secondary: buildReadSecondary(parsedArgs),
        relatedFilePath: filePath,
        messageIndex: tool.messageIndex,
      };
    }
    case "write": {
      const filePath = extractFilePath(parsedArgs);
      return {
        toolKind,
        primaryText: firstNonEmpty(filePath, primaryFallback),
        secondary: buildShellSecondary(parsedArgs),
        badge: buildWriteBadge(normalizedName),
        relatedFilePath: filePath,
        messageIndex: tool.messageIndex,
      };
    }
    case "edit": {
      const filePath = extractFilePath(parsedArgs);
      return {
        toolKind,
        primaryText: firstNonEmpty(filePath, primaryFallback),
        secondary: buildEditSecondary(parsedArgs),
        badge: buildEditBadge(normalizedName),
        relatedFilePath: filePath,
        messageIndex: tool.messageIndex,
      };
    }
    case "grep":
      return {
        toolKind,
        primaryText: firstNonEmpty(extractString(parsedArgs, QUERY_KEYS), primaryFallback),
        ...buildScopedSecondary(parsedArgs),
        messageIndex: tool.messageIndex,
      };
    case "glob":
      return {
        toolKind,
        primaryText: firstNonEmpty(extractString(parsedArgs, QUERY_KEYS), primaryFallback),
        ...buildScopedSecondary(parsedArgs),
        messageIndex: tool.messageIndex,
      };
    case "webSearch":
      return {
        toolKind,
        primaryText: firstNonEmpty(
          extractString(parsedArgs, QUERY_KEYS),
          extractStringArray(parsedArgs, ["queries"]),
          extractString(parsedArgs, URL_KEYS),
          primaryFallback,
        ),
        messageIndex: tool.messageIndex,
      };
    case "webFetch":
      return {
        toolKind,
        primaryText: firstNonEmpty(extractString(parsedArgs, URL_KEYS), primaryFallback),
        messageIndex: tool.messageIndex,
      };
    case "imageGeneration":
      return {
        toolKind,
        primaryText: firstNonEmpty(extractString(parsedArgs, ["prompt", "revised_prompt"]), primaryFallback),
        messageIndex: tool.messageIndex,
      };
    case "agent":
      return {
        toolKind,
        primaryText: firstNonEmpty(extractAgentPrimary(parsedArgs), primaryFallback),
        secondaryText: buildAgentSecondary(parsedArgs),
        messageIndex: tool.messageIndex,
      };
    case "sendFile":
    case "exec":
    case "wait":
      // Describe the operation without guessing its target or duplicating the call ID tag.
      return {
        toolKind,
        primaryText: primaryFallback,
        messageIndex: tool.messageIndex,
      };
    default:
      return {
        toolKind: "unknown",
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

function buildShellSecondary(parsedArgs: JsonLikeRecord | null): ChatToolPresentation["secondary"] {
  const cwd = extractString(parsedArgs, WORKDIR_KEYS);
  return cwd ? { kind: "cwd", value: cwd.slice(0, MAX_PRESENTATION_LIST_CHARS) } : undefined;
}

function buildShellBadge(parsedOutput: JsonLikeRecord | null, outputText: string | undefined): ChatToolPresentation["badge"] {
  const exitCode = extractExitCode(parsedOutput, outputText);
  return typeof exitCode === "number" && exitCode !== 0 ? { kind: "exitCode", exitCode } : undefined;
}

function detectShellSeverity(
  parsedOutput: JsonLikeRecord | null,
  outputText: string | undefined,
): ChatToolPresentation["severity"] {
  const exitCode = extractExitCode(parsedOutput, outputText);
  if (typeof exitCode === "number" && exitCode !== 0) return "error";
  return undefined;
}

function buildReadSecondary(parsedArgs: JsonLikeRecord | null): ChatToolPresentation["secondary"] {
  const lineStart = extractNumber(parsedArgs, ["line", "lineStart", "start_line", "lineno"]);
  const lineEnd = extractNumber(parsedArgs, ["lineEnd", "end_line"]);
  if (typeof lineStart === "number" && typeof lineEnd === "number" && lineEnd >= lineStart) {
    return { kind: "linesRange", start: lineStart, end: lineEnd };
  }
  if (typeof lineStart === "number") {
    return { kind: "line", line: lineStart };
  }
  return undefined;
}

function buildWriteBadge(normalizedName: string): ChatToolPresentation["badge"] {
  if (normalizedName.includes("create")) return { kind: "created" };
  if (normalizedName.includes("delete")) return { kind: "deleted" };
  if (normalizedName.includes("rename") || normalizedName.includes("move")) return { kind: "renamed" };
  return { kind: "modified" };
}

function buildEditSecondary(parsedArgs: JsonLikeRecord | null): ChatToolPresentation["secondary"] {
  const oldText = extractString(parsedArgs, ["old_string", "oldText", "beforeText"]);
  const newText = extractString(parsedArgs, ["new_string", "newText", "afterText"]);
  if (oldText && newText) {
    return { kind: "replaceSnippet", before: shortenInlineText(oldText), after: shortenInlineText(newText) };
  }

  const patchText = extractString(parsedArgs, ["patch", "patchText"]);
  if (patchText) return { kind: "patchReady" };
  return undefined;
}

function buildEditBadge(normalizedName: string): ChatToolPresentation["badge"] {
  if (normalizedName.includes("apply_patch")) return { kind: "patched" };
  return buildWriteBadge(normalizedName);
}

function buildScopedSecondary(parsedArgs: JsonLikeRecord | null): Pick<ChatToolPresentation, "secondary" | "secondaryText"> {
  const filePath = extractFilePath(parsedArgs);
  if (filePath) return { secondaryText: filePath };
  return { secondary: buildShellSecondary(parsedArgs) };
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

function extractCommand(parsedArgs: JsonLikeRecord | null): string | undefined {
  if (!parsedArgs) return undefined;
  for (const key of COMMAND_KEYS) {
    const value = parsedArgs[key];
    if (Array.isArray(value)) {
      const command = joinBoundedStringArray(value, " ");
      if (command) return command;
      continue;
    }
    const normalized = normalizeUnknownText(value);
    if (normalized) return normalized;
  }
  return undefined;
}

function extractStringArray(parsedArgs: JsonLikeRecord | null, keys: readonly string[]): string | undefined {
  if (!parsedArgs) return undefined;
  for (const key of keys) {
    const value = parsedArgs[key];
    if (!Array.isArray(value)) continue;
    const text = joinBoundedStringArray(value, " | ");
    if (text) return text;
  }
  return undefined;
}

function joinBoundedStringArray(value: readonly unknown[], separator: string): string {
  const parts: string[] = [];
  let remainingChars = MAX_PRESENTATION_LIST_CHARS;
  for (const item of value.slice(0, MAX_PRESENTATION_LIST_ITEMS)) {
    if (remainingChars <= 0 || typeof item !== "string") continue;
    const text = normalizeInlineText(item.slice(0, MAX_PRESENTATION_LIST_CHARS)).slice(0, remainingChars);
    if (!text) continue;
    parts.push(text);
    remainingChars -= text.length + separator.length;
  }
  return parts.join(separator).slice(0, MAX_PRESENTATION_LIST_CHARS);
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
  if (typeof value === "string" && /^-?\d+$/u.test(value.trim()) && Number.isFinite(Number(value))) return Number(value);

  const text = typeof outputText === "string" ? outputText : "";
  const match = text.match(/\bExit code:\s*(-?\d+)\b/u);
  if (!match) return undefined;
  const exitCode = Number(match[1]);
  return Number.isFinite(exitCode) ? exitCode : undefined;
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
