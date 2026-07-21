export const HISTORY_CACHE_FILE_NAME = "cache.v9.json";
export const SEARCH_INDEX_FILE_NAME = "search-index.v2.json";
export const SESSION_ANALYSIS_INDEX_FILE_NAME = "session-analysis-index.v1.json";

export const HISTORY_CACHE_FILE_PATTERN = /^cache\.v\d+\.json$/i;
export const SEARCH_INDEX_FILE_PATTERN = /^search-index\.v\d+\.json$/i;
export const SESSION_ANALYSIS_INDEX_FILE_PATTERN = /^session-analysis-index\.v\d+\.json$/i;

export function isLegacyVersionedCacheFile(
  fileName: string,
  currentFileName: string,
  pattern: RegExp,
): boolean {
  const normalized = String(fileName ?? "").trim().toLowerCase();
  if (!normalized || normalized === currentFileName.toLowerCase()) return false;
  pattern.lastIndex = 0;
  return pattern.test(normalized);
}
