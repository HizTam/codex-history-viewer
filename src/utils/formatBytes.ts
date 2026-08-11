const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function isValidByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// Keep the existing adaptive precision used by status and cleanup UI.
export function formatBytesForUi(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const { value, unitIndex } = scaleBytes(bytes);
  const rounded = value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return `${rounded} ${BYTE_UNITS[unitIndex]}`;
}

export function formatSessionFileSize(bytes: unknown): string | undefined {
  if (!isValidByteCount(bytes)) return undefined;
  if (bytes === 0) return "0 B";
  const { value, unitIndex } = scaleBytes(bytes);
  if (unitIndex === 0) return `${bytes} B`;
  const fractionDigits = unitIndex === 1 ? 1 : 2;
  return `${value.toFixed(fractionDigits)} ${BYTE_UNITS[unitIndex]}`;
}

function scaleBytes(bytes: number): { value: number; unitIndex: number } {
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return { value, unitIndex };
}
