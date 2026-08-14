import { t } from "../i18n";
import type { ImportSessionsPreflight } from "../services/importExportService";
import type { SessionMetadataRestorePreview } from "../services/sessionMetadataBackupService";

type Translate = (key: string, ...args: Array<string | number | boolean>) => string;

export function buildMetadataRestoreConfirmation(
  preflight: ImportSessionsPreflight,
  preview: SessionMetadataRestorePreview,
  metadataOnlyPreview: SessionMetadataRestorePreview | null,
  translate: Translate = t,
): string {
  const changes = buildNonZeroLines(translate, [
    [preview.setTagSessions, "metadataBackup.confirm.setTags"],
    [preview.clearedTagSessions, "metadataBackup.confirm.clearTags"],
    [preview.restoredNotes, "metadataBackup.confirm.addNotes"],
    [preview.overwrittenNotes, "metadataBackup.confirm.overwriteNotes"],
    [preview.clearedNotes, "metadataBackup.confirm.clearNotes"],
    [preview.restoredTitles, "metadataBackup.confirm.addTitles"],
    [preview.overwrittenTitles, "metadataBackup.confirm.overwriteTitles"],
    [preview.clearedTitles, "metadataBackup.confirm.clearTitles"],
    [preview.hiddenSessions, "metadataBackup.confirm.addHidden"],
    [preview.shownSessions, "metadataBackup.confirm.showSessions"],
    [preview.pinnedSessions, "metadataBackup.confirm.addPins"],
    [preview.unpinnedSessions, "metadataBackup.confirm.unpinSessions"],
    [preview.setBookmarkSessions, "metadataBackup.confirm.setBookmarks"],
    [preview.clearedBookmarkSessions, "metadataBackup.confirm.clearBookmarks"],
  ]);
  const unavailable = buildNonZeroLines(translate, [
    [preview.unmatched, "metadataBackup.confirm.unmatched"],
    [preview.ambiguous, "metadataBackup.confirm.ambiguous"],
    [preview.invalidBookmarks, "metadataBackup.confirm.invalidBookmarks"],
    [preview.hiddenLimitSkipped, "metadataBackup.confirm.hiddenLimit"],
  ]);
  const jsonlChanges = buildNonZeroLines(translate, [
    [preflight.imported, "metadataBackup.confirm.jsonlAdd"],
    [preflight.overwritten, "metadataBackup.confirm.jsonlOverwrite"],
    [preflight.unchanged, "metadataBackup.confirm.jsonlUnchanged"],
    [preflight.skipped, "metadataBackup.confirm.jsonlSkip"],
    [preflight.failed, "metadataBackup.confirm.jsonlFailed"],
  ]);
  const safeSourceDirectory = sanitizeSourceDirectory(preflight.sourceDir, translate);
  const sections = [
    [
      translate("metadataBackup.confirm.importTitle", preview.matched),
      translate("metadataBackup.confirm.sources", preview.matchedCodex, preview.matchedClaude),
      translate("metadataBackup.confirm.sourceDirectory", safeSourceDirectory),
    ].join("\n"),
    [translate("metadataBackup.confirm.jsonlPlan"), ...(
      jsonlChanges.length > 0 ? jsonlChanges : [translate("metadataBackup.confirm.jsonlNoChanges")]
    )].join("\n"),
    [translate("metadataBackup.confirm.changes"), ...(changes.length > 0 ? changes : [translate("metadataBackup.confirm.noChanges")])].join("\n"),
  ];
  if (metadataOnlyPreview && metadataOnlyPreview.matched > 0) {
    sections.push(translate("metadataBackup.confirm.metadataOnlyTargets", metadataOnlyPreview.matched));
  }
  if (unavailable.length > 0) {
    sections.push([translate("metadataBackup.confirm.unavailable"), ...unavailable].join("\n"));
  }
  sections.push(translate("metadataBackup.confirm.safety"));
  return sections.join("\n\n");
}

function sanitizeSourceDirectory(value: string, translate: Translate): string {
  const normalized = String(value ?? "").trim();
  if (normalized.length === 0 || /[\p{Cc}\p{Cf}]/u.test(normalized)) {
    return translate("metadataBackup.confirm.unknownSourceDirectory");
  }
  return normalized.length <= 2048
    ? normalized
    : translate("metadataBackup.confirm.truncatedSourceDirectory", normalized.slice(-2047));
}

function buildNonZeroLines(
  translate: Translate,
  values: ReadonlyArray<readonly [number, string]>,
): string[] {
  return values
    .filter(([count]) => Number.isSafeInteger(count) && count > 0)
    .map(([count, key]) => translate(key, count));
}
