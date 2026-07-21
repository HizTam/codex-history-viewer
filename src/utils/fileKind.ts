import * as path from "node:path";

export type FilePresentationKind =
  | "pdf"
  | "word"
  | "excel"
  | "powerpoint"
  | "text"
  | "code"
  | "archive"
  | "image"
  | "generic";

export const FILE_PRESENTATION_KINDS: readonly FilePresentationKind[] = Object.freeze([
  "pdf",
  "word",
  "excel",
  "powerpoint",
  "text",
  "code",
  "archive",
  "image",
  "generic",
]);

const FILE_PRESENTATION_KIND_SET = new Set<string>(FILE_PRESENTATION_KINDS);

const CODE_EXTENSIONS = new Set([
  ".bash",
  ".bat",
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".htm",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".kt",
  ".kts",
  ".php",
  ".ps1",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".swift",
  ".ts",
  ".tsx",
  ".xml",
  ".yaml",
  ".yml",
]);

const TEXT_EXTENSIONS = new Set([
  ".csv",
  ".diff",
  ".env",
  ".ini",
  ".log",
  ".md",
  ".markdown",
  ".patch",
  ".text",
  ".toml",
  ".tsv",
  ".txt",
]);

const ARCHIVE_EXTENSIONS = new Set([".7z", ".br", ".bz2", ".gz", ".rar", ".tar", ".tgz", ".xz", ".zip"]);
const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);

export function inferFilePresentationKind(fsPath: string, fallbackLabel?: string): FilePresentationKind {
  const candidate = String(fsPath || fallbackLabel || "").trim();
  const ext = path.extname(candidate).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".doc" || ext === ".docx" || ext === ".docm" || ext === ".rtf") return "word";
  if (ext === ".xls" || ext === ".xlsx" || ext === ".xlsm") return "excel";
  if (ext === ".ppt" || ext === ".pptx" || ext === ".pptm") return "powerpoint";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (ARCHIVE_EXTENSIONS.has(ext)) return "archive";
  if (CODE_EXTENSIONS.has(ext)) return "code";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  if (isWellKnownTextFileName(fsPath) || isWellKnownTextFileName(fallbackLabel)) return "text";
  return "generic";
}

export function sanitizeFilePresentationKind(value: unknown): FilePresentationKind {
  return typeof value === "string" && FILE_PRESENTATION_KIND_SET.has(value)
    ? value as FilePresentationKind
    : "generic";
}

function isWellKnownTextFileName(value: string | undefined): boolean {
  const base = path.basename(String(value ?? "").trim()).toLowerCase();
  return (
    base === "license" ||
    base === "readme" ||
    base === "changelog" ||
    base === "authors" ||
    base === "contributors" ||
    base === "copying"
  );
}
