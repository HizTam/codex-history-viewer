import type { PerformanceProbe } from "../performance/performanceCounters";
import {
  readSessionJsonlLines,
  type CodexLogicalHistoryPlan,
  type SessionJsonlReadOptions,
} from "../sessions/codexHistoryBase";
import {
  readCodexContextManagementKind,
  readCodexControlToolKind,
  readCodexRolloutRecordKind,
  type CodexContextManagementKind,
  type CodexControlToolKind,
  type CodexRolloutRecordKind,
} from "../sessions/codexRolloutCompatibility";
import type { SessionSource, SessionSummary } from "../sessions/sessionTypes";
import { normalizeCacheKey } from "../utils/fsUtils";

interface AnalysisRecordPosition {
  readonly lineIndex: number;
  readonly physicalLineIndex: number;
  readonly sourceFsPath: string;
  readonly segmentKey: string;
  readonly isLeaf: boolean;
}

export type AnalysisRecordEnvelope =
  | (AnalysisRecordPosition & { readonly kind: "empty" })
  | (AnalysisRecordPosition & { readonly kind: "whitespace" })
  | (AnalysisRecordPosition & { readonly kind: "malformed" })
  | (AnalysisRecordPosition & {
      readonly kind: "parsed";
      readonly value: unknown;
      readonly codexRecordKind?: CodexRolloutRecordKind;
      readonly codexControlToolKind?: CodexControlToolKind;
      readonly codexContextManagementKind?: CodexContextManagementKind;
    });

export interface AnalysisRecordPipelineOptions {
  readonly sessionInventory?: readonly SessionSummary[];
  readonly plan?: CodexLogicalHistoryPlan;
  readonly token?: SessionJsonlReadOptions["token"];
  readonly cancellationErrorFactory?: SessionJsonlReadOptions["cancellationErrorFactory"];
  readonly performanceProbe?: PerformanceProbe;
}

// Projects each physical JSONL line into one immutable, position-aware envelope.
export async function* readAnalysisRecordEnvelopes(
  fsPath: string,
  source: SessionSource,
  options: AnalysisRecordPipelineOptions = {},
): AsyncGenerator<AnalysisRecordEnvelope> {
  let previousSourceFsPath: string | undefined;
  let segmentKey = "";
  for await (const record of readSessionJsonlLines(fsPath, source, options)) {
    if (record.sourceFsPath !== previousSourceFsPath) {
      previousSourceFsPath = record.sourceFsPath;
      segmentKey = normalizeCacheKey(record.sourceFsPath);
    }
    if (record.line.length === 0) {
      yield {
        kind: "empty",
        lineIndex: record.lineIndex,
        physicalLineIndex: record.physicalLineIndex,
        sourceFsPath: record.sourceFsPath,
        segmentKey,
        isLeaf: record.isLeaf,
      };
      continue;
    }
    if (record.line.trim().length === 0) {
      yield {
        kind: "whitespace",
        lineIndex: record.lineIndex,
        physicalLineIndex: record.physicalLineIndex,
        sourceFsPath: record.sourceFsPath,
        segmentKey,
        isLeaf: record.isLeaf,
      };
      continue;
    }
    try {
      const value: unknown = JSON.parse(record.line);
      options.performanceProbe?.add("parseSuccessCount");
      const codexRecordKind = source === "codex" ? readCodexRolloutRecordKind(value) : undefined;
      const codexControlToolKind = source === "codex" ? readCodexControlToolKind(value) : undefined;
      const codexContextManagementKind = source === "codex"
        ? readCodexContextManagementKind(value)
        : undefined;
      yield {
        kind: "parsed",
        lineIndex: record.lineIndex,
        physicalLineIndex: record.physicalLineIndex,
        sourceFsPath: record.sourceFsPath,
        segmentKey,
        isLeaf: record.isLeaf,
        value,
        ...(codexRecordKind ? { codexRecordKind } : {}),
        ...(codexControlToolKind ? { codexControlToolKind } : {}),
        ...(codexContextManagementKind ? { codexContextManagementKind } : {}),
      };
    } catch {
      options.performanceProbe?.add("malformedLineCount");
      yield {
        kind: "malformed",
        lineIndex: record.lineIndex,
        physicalLineIndex: record.physicalLineIndex,
        sourceFsPath: record.sourceFsPath,
        segmentKey,
        isLeaf: record.isLeaf,
      };
    }
  }
}
