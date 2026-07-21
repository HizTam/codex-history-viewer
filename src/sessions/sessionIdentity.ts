import type { SessionSource } from "./sessionTypes";
import { stableTextSha256 } from "../utils/stableTextHash";

export const SESSION_IDENTITY_KEY_MAX_LENGTH = 32_768;

export function boundSessionIdentityKey(source: SessionSource, candidate: string): string {
  if (candidate.length > 0 && candidate.length <= SESSION_IDENTITY_KEY_MAX_LENGTH) return candidate;
  const digest = stableTextSha256(candidate);
  return `${source}:hash:${digest}`;
}

export function isBoundedSessionIdentityKey(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= SESSION_IDENTITY_KEY_MAX_LENGTH;
}
