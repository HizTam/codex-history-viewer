import { stableTextSha256 } from "../utils/stableTextHash";

const CHAT_RENDER_FINGERPRINT_VERSION = "v1";

export function createChatRenderFingerprint(value: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") return undefined;
    return `${CHAT_RENDER_FINGERPRINT_VERSION}:${stableTextSha256(serialized)}`;
  } catch {
    // A missing fingerprint safely falls back to a full Webview render.
    return undefined;
  }
}
