import { detectClaudeMaterializedMessageRole } from "./chatAttachments";
import { isPotentialImageAttachmentItem } from "./chatImageAttachments";

export const CLAUDE_TERMINAL_OUTPUT_MAX_CHARS = 64_000;

export interface ClaudeTerminalOutput {
  stdout?: string;
  stderr?: string;
  exitCode?: string;
  truncated?: boolean;
}

// Native terminal output is a complete text-only user record without another origin.
export function extractClaudeTerminalOutput(record: unknown, content: unknown): ClaudeTerminalOutput | null {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const obj = record as Record<string, unknown>;
  if (obj.type !== "user" || obj.origin !== undefined || detectClaudeMaterializedMessageRole(obj) !== "user") return null;

  const text = readText(content);
  if (text === null || (!text.startsWith("<bash-stdout>") && !text.startsWith("<bash-stderr>"))) return null;
  const normalized = text.replace(/\r\n?/gu, "\n").trimEnd();
  let cursor = 0;
  let invalid = false;
  const readBlock = (tag: string): string | undefined => {
    const open = `<${tag}>`;
    const close = `</${tag}>`;
    if (!normalized.startsWith(open, cursor)) return undefined;
    const start = cursor + open.length;
    const end = normalized.indexOf(close, start);
    if (end < 0) {
      invalid = true;
      return undefined;
    }
    const body = normalized.slice(start, end);
    if (/<\/?bash-(?:stdout|stderr|exit-code)\b/u.test(body)) invalid = true;
    cursor = end + close.length;
    while (cursor < normalized.length && /\s/u.test(normalized[cursor]!)) cursor++;
    return body;
  };

  const stdout = readBlock("bash-stdout");
  const stderr = readBlock("bash-stderr");
  const exitCode = stdout !== undefined ? readBlock("bash-exit-code") : undefined;
  if (invalid || cursor !== normalized.length || (stdout === undefined && stderr === undefined)) return null;
  if (exitCode !== undefined && !/^-?\d{1,10}$/u.test(exitCode.trim())) return null;

  const result: ClaudeTerminalOutput = {};
  for (const [name, raw] of [["stdout", stdout], ["stderr", stderr]] as const) {
    if (raw === undefined) continue;
    const persistedOpen = "<persisted-output>";
    const persistedClose = "</persisted-output>";
    const persisted = raw.startsWith(persistedOpen) && raw.endsWith(persistedClose) &&
      raw.indexOf(persistedClose) === raw.length - persistedClose.length;
    const body = persisted ? raw.slice(persistedOpen.length, -persistedClose.length) : raw;
    // Decode only the transport's three entities, once; persisted previews are already decoded.
    const bounded = body.slice(0, CLAUDE_TERMINAL_OUTPUT_MAX_CHARS * 5 + 5);
    const decoded = persisted ? bounded : bounded.replace(/&(amp|lt|gt);/gu, (_, entity: string) =>
      entity === "amp" ? "&" : entity === "lt" ? "<" : ">",
    );
    let end = Math.min(decoded.length, CLAUDE_TERMINAL_OUTPUT_MAX_CHARS);
    // Preserve a Unicode pair when the display limit falls inside an astral character.
    const last = decoded.charCodeAt(end - 1);
    const next = decoded.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
    result[name] = decoded.slice(0, end);
    if (body.length > bounded.length || decoded.length > CLAUDE_TERMINAL_OUTPUT_MAX_CHARS) result.truncated = true;
  }
  if (exitCode !== undefined) result.exitCode = exitCode.trim();
  return result;
}

export function getClaudeTerminalOutputText(output: ClaudeTerminalOutput): string {
  return [output.stdout, output.stderr, output.exitCode].filter(value => typeof value === "string" && value.length > 0).join("\n");
}

function readText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const texts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    if (item.type !== "text" || typeof item.text !== "string" || isPotentialImageAttachmentItem(item)) return null;
    texts.push(item.text);
  }
  return texts.join("\n");
}
