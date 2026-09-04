import type { ChatTokenUsage, ChatTokenUsageField } from "./chatTypes";

const DIRECT_TOKEN_FIELDS = [
  ["inputTokens", "input_tokens"],
  ["cachedInputTokens", "cached_input_tokens"],
  ["cacheReadInputTokens", "cache_read_input_tokens"],
  ["outputTokens", "output_tokens"],
  ["reasoningOutputTokens", "reasoning_output_tokens"],
  ["totalTokens", "total_tokens"],
] as const;

const CACHE_CREATION_ALIASES = [
  "cache_creation_input_tokens",
  "cache_write_input_tokens",
] as const;

// Normalizes provider token fields without adding values from equivalent aliases.
export function extractChatTokenUsage(value: unknown): ChatTokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const usage: ChatTokenUsage = {};
  const invalidFields: ChatTokenUsageField[] = [];

  for (const [key, rawKey] of DIRECT_TOKEN_FIELDS) {
    if (!(rawKey in value)) continue;
    const normalized = normalizeTokenInteger(value[rawKey]);
    if (normalized === undefined) invalidFields.push(key);
    else usage[key] = normalized;
  }

  const cacheCreation = readAliasedTokenInteger(value, CACHE_CREATION_ALIASES);
  if (cacheCreation.kind === "valid") usage.cacheCreationInputTokens = cacheCreation.value;
  else if (cacheCreation.kind === "invalid") invalidFields.push("cacheCreationInputTokens");

  if (invalidFields.length > 0) usage.invalidFields = invalidFields;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function readAliasedTokenInteger(
  value: Readonly<Record<string, unknown>>,
  aliases: readonly string[],
): { readonly kind: "absent" } | { readonly kind: "invalid" } | { readonly kind: "valid"; readonly value: number } {
  let observed = false;
  let normalizedValue: number | undefined;
  for (const alias of aliases) {
    if (!(alias in value)) continue;
    observed = true;
    const normalized = normalizeTokenInteger(value[alias]);
    if (normalized === undefined) return { kind: "invalid" };
    if (normalizedValue !== undefined && normalizedValue !== normalized) return { kind: "invalid" };
    normalizedValue = normalized;
  }
  if (!observed || normalizedValue === undefined) return { kind: "absent" };
  return { kind: "valid", value: normalizedValue };
}

function normalizeTokenInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
