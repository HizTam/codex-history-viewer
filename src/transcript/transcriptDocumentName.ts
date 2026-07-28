const MAX_TRANSCRIPT_DOCUMENT_TITLE_CODE_POINTS = 120;
const WINDOWS_DEVICE_NAME_PATTERN =
  /^(?:con|prn|aux|nul|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:[.\s]|$)/iu;

// Build a safe virtual Markdown filename from an untrusted session display title.
export function buildTranscriptDocumentFileName(displayTitle: unknown): string {
  const normalized = String(displayTitle ?? "")
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]+/gu, " ")
    .replace(/[<>:"/\\|?*]+/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/^[.\s]+|[.\s]+$/gu, "");

  let baseName = Array.from(normalized).slice(0, MAX_TRANSCRIPT_DOCUMENT_TITLE_CODE_POINTS).join("");
  baseName = baseName.replace(/[.\s]+$/gu, "");
  if (!baseName || baseName === "." || baseName === "..") baseName = "session";
  if (WINDOWS_DEVICE_NAME_PATTERN.test(baseName)) baseName = `_${baseName}`;

  return baseName.toLowerCase().endsWith(".md") ? baseName : `${baseName}.md`;
}
