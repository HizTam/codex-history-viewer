import { createHash } from "node:crypto";

const UNPAIRED_UTF16_HASH_DOMAIN = "codex-history-viewer:unpaired-utf16le:v1\u0000";

export function stableTextSha256(value: string): string {
  const hash = createHash("sha256");
  if (!hasUnpairedSurrogate(value)) return hash.update(value, "utf8").digest("hex");
  return hash
    .update(UNPAIRED_UTF16_HASH_DOMAIN, "utf8")
    .update(value, "utf16le")
    .digest("hex");
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return true;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return true;
  }
  return false;
}
