import type { AntigravityFileEdit, AntigravityIssue, AntigravityMetadata, AntigravitySessionLocator, AntigravityStep, AntigravitySummaryRecord } from "./antigravityTypes";

export interface AntigravitySessionData {
  readonly metadata: AntigravityMetadata;
  readonly steps: readonly AntigravityStep[];
  readonly fileEdits?: readonly { readonly stepIndex: number; readonly edit: AntigravityFileEdit }[];
  readonly unavailableFileEditSteps?: readonly number[];
  readonly fileEditScanIncomplete?: true;
  readonly digest: string;
  readonly issues: readonly AntigravityIssue[];
}
export interface AntigravitySummaryData {
  readonly summaries: readonly AntigravitySummaryRecord[];
  readonly partial: boolean;
}
export type AntigravityReaderRequest =
  | { readonly kind: "session"; readonly locator: AntigravitySessionLocator; readonly includeFileEdits?: true }
  | { readonly kind: "metadata"; readonly locator: AntigravitySessionLocator }
  | { readonly kind: "summaries"; readonly rootPath: string };
export type AntigravityReaderResult = AntigravitySessionData | AntigravityMetadata | AntigravitySummaryData;
export interface AntigravityWorkerRequest {
  readonly id: number;
  readonly request: AntigravityReaderRequest;
  readonly cancel: SharedArrayBuffer;
}

export interface AntigravityCancellationToken {
  readonly isCancellationRequested: boolean;
  readonly onCancellationRequested?: (listener: () => void) => { dispose(): void };
}
