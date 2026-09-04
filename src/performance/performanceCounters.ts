import { performance } from "node:perf_hooks";

export const PERFORMANCE_SAMPLE_SCHEMA_VERSION = 1 as const;

export const PERFORMANCE_COUNTER_NAMES = [
  "sessionCount",
  "successCount",
  "partialCount",
  "failureCount",
  "cancelledCount",
  "discoveryDirectoryCount",
  "discoveryFailureScopeCount",
  "statCount",
  "streamOpenCount",
  "readByteExactCount",
  "readByteEstimatedCount",
  "postScanCheckCount",
  "physicalLineCount",
  "logicalLineCount",
  "parseSuccessCount",
  "malformedLineCount",
  "segmentCount",
  "fileChangeNormalizerCallCount",
  "fileChangeRecognizedCount",
  "fileChangeSuccessCheckCount",
  "fileChangeSignatureCalculationCount",
  "fileChangeSignatureInputByteCount",
  "fileChangeDuplicateHitCount",
  "fileChangeTrackingPeak",
  "fileChangeEvictionCount",
  "cacheHitCount",
  "cacheMissCount",
  "cacheEntryRebuildCount",
  "cacheReadByteCount",
  "cacheWriteCount",
  "cacheWriteByteCount",
  "durableFingerprintHitCount",
  "historyIndexReplacementCount",
  "treeNotificationCount",
  "mapMaterializationCount",
  "snapshotGenerationCount",
  "snapshotReuseCount",
  "cooperativeYieldCount",
  "memoryObservationCount",
  "shikiRequestCount",
  "shikiExecutionCount",
  "shikiHitCount",
  "shikiMissCount",
  "shikiEvictionCount",
  "shikiRetainedEntryCount",
  "shikiRetainedCharacterCount",
  "invalidMeasurementCount",
] as const;
Object.freeze(PERFORMANCE_COUNTER_NAMES);

export type PerformanceCounterName = (typeof PERFORMANCE_COUNTER_NAMES)[number];

const PERFORMANCE_COUNTER_NAME_SET: ReadonlySet<unknown> = new Set(PERFORMANCE_COUNTER_NAMES);

const PERFORMANCE_OPERATION_KINDS = Object.freeze([
  "historyRefresh",
  "historyRebuild",
  "historySummary",
  "searchIndex",
  "sessionAnalysis",
  "shikiHighlight",
  "syntheticBenchmark",
] as const);

export type PerformanceOperationKind = (typeof PERFORMANCE_OPERATION_KINDS)[number];

export type PerformanceOutcome = "success" | "partial" | "failed" | "cancelled";

export interface PerformanceMemorySnapshot {
  readonly heapUsedBytes: number;
  readonly externalBytes: number;
  readonly rssBytes: number;
}

export interface PerformanceResponsivenessSnapshot {
  readonly maxContinuousProcessingMs: number;
  readonly cancelRequestToStopMs?: number;
}

export interface PerformanceSample {
  readonly schemaVersion: typeof PERFORMANCE_SAMPLE_SCHEMA_VERSION;
  readonly operation: PerformanceOperationKind;
  readonly outcome: PerformanceOutcome;
  readonly wallTimeMs: number;
  readonly cpuUserMicros: number;
  readonly cpuSystemMicros: number;
  readonly counters: Readonly<Record<PerformanceCounterName, number>>;
  readonly memory: {
    readonly start: PerformanceMemorySnapshot;
    readonly end: PerformanceMemorySnapshot;
    readonly peak: PerformanceMemorySnapshot;
  };
  readonly responsiveness: PerformanceResponsivenessSnapshot;
}

export interface PerformanceProbe {
  add(counter: PerformanceCounterName, amount?: number): void;
  observeMax(counter: PerformanceCounterName, value: number): void;
  observeMemory(): void;
  observeContinuousProcessingMs(value: number): void;
  setCancelRequestToStopMs(value: number): void;
  setOutcome(outcome: PerformanceOutcome): void;
}

export type PerformanceSink = (sample: PerformanceSample) => unknown;

export interface MeasurePerformanceOptions {
  readonly isCancellationError?: (error: unknown) => boolean;
}

// Avoid allocating a counter set when measurement is disabled.
export async function measurePerformanceOperation<T>(
  operation: PerformanceOperationKind,
  sink: PerformanceSink | undefined,
  task: (probe: PerformanceProbe | undefined) => T | Promise<T>,
  options: MeasurePerformanceOptions = {},
): Promise<T> {
  if (!sink) return task(undefined);

  const validOperation = isPerformanceOperationKind(operation);
  const collector = new PerformanceCollector(validOperation ? operation : "syntheticBenchmark");
  if (!validOperation) collector.probe.add("invalidMeasurementCount");
  let thrownOutcome: PerformanceOutcome | undefined;
  try {
    return await task(collector.probe);
  } catch (error) {
    thrownOutcome = safelyMatchesCancellation(options.isCancellationError, error)
      ? "cancelled"
      : "failed";
    throw error;
  } finally {
    collector.deliver(sink, thrownOutcome);
  }
}

class PerformanceCollector {
  private readonly counters = createEmptyCounters();
  private readonly startedAt = safeNow();
  private readonly startedCpu = safeCpuUsage();
  private readonly startMemory = safeMemoryUsage();
  private peakMemory = this.startMemory;
  private outcome: PerformanceOutcome = "success";
  private maxContinuousProcessingMs = 0;
  private cancelRequestToStopMs: number | undefined;

  public readonly probe: PerformanceProbe = Object.freeze({
    add: (counter: PerformanceCounterName, amount = 1) => this.add(counter, amount),
    observeMax: (counter: PerformanceCounterName, value: number) => this.observeMax(counter, value),
    observeMemory: () => this.observeMemory(),
    observeContinuousProcessingMs: (value: number) => this.observeContinuousProcessingMs(value),
    setCancelRequestToStopMs: (value: number) => this.setCancelRequestToStopMs(value),
    setOutcome: (outcome: PerformanceOutcome) => this.setOutcome(outcome),
  });

  public constructor(private readonly operation: PerformanceOperationKind) {}

  public deliver(sink: PerformanceSink, thrownOutcome?: PerformanceOutcome): void {
    const endedAt = safeNow();
    const endMemory = safeMemoryUsage();
    this.peakMemory = maxMemory(this.peakMemory, endMemory);
    const cpu = safeCpuUsage(this.startedCpu);
    const outcome = thrownOutcome ?? this.outcome;
    this.incrementOutcomeCounter(outcome);

    const sample: PerformanceSample = Object.freeze({
      schemaVersion: PERFORMANCE_SAMPLE_SCHEMA_VERSION,
      operation: this.operation,
      outcome,
      wallTimeMs: normalizeDuration(endedAt - this.startedAt),
      cpuUserMicros: normalizeCounterValue(cpu.user),
      cpuSystemMicros: normalizeCounterValue(cpu.system),
      counters: Object.freeze({ ...this.counters }),
      memory: Object.freeze({
        start: this.startMemory,
        end: endMemory,
        peak: this.peakMemory,
      }),
      responsiveness: Object.freeze({
        maxContinuousProcessingMs: this.maxContinuousProcessingMs,
        ...(this.cancelRequestToStopMs !== undefined
          ? { cancelRequestToStopMs: this.cancelRequestToStopMs }
          : {}),
      }),
    });

    try {
      const delivered = sink(sample);
      if (isPromiseLike(delivered)) {
        void Promise.resolve(delivered).catch(() => undefined);
      }
    } catch {
      // Measurement must never affect the measured operation.
    }
  }

  private add(counter: PerformanceCounterName, amount: number): void {
    if (!PERFORMANCE_COUNTER_NAME_SET.has(counter) || !isNonNegativeSafeInteger(amount)) {
      this.recordInvalidMeasurement();
      return;
    }
    this.counters[counter] = saturatingAdd(this.counters[counter], amount);
  }

  private observeMax(counter: PerformanceCounterName, value: number): void {
    if (!PERFORMANCE_COUNTER_NAME_SET.has(counter) || !isNonNegativeSafeInteger(value)) {
      this.recordInvalidMeasurement();
      return;
    }
    this.counters[counter] = Math.max(this.counters[counter], value);
  }

  private observeMemory(): void {
    this.counters.memoryObservationCount = saturatingAdd(
      this.counters.memoryObservationCount,
      1,
    );
    this.peakMemory = maxMemory(this.peakMemory, safeMemoryUsage());
  }

  private observeContinuousProcessingMs(value: number): void {
    const normalized = normalizeOptionalDuration(value);
    if (normalized === undefined) {
      this.recordInvalidMeasurement();
      return;
    }
    this.maxContinuousProcessingMs = Math.max(this.maxContinuousProcessingMs, normalized);
  }

  private setCancelRequestToStopMs(value: number): void {
    const normalized = normalizeOptionalDuration(value);
    if (normalized === undefined) {
      this.recordInvalidMeasurement();
      return;
    }
    this.cancelRequestToStopMs = normalized;
  }

  private setOutcome(outcome: PerformanceOutcome): void {
    if (!isPerformanceOutcome(outcome)) {
      this.recordInvalidMeasurement();
      return;
    }
    if (performanceOutcomeRank(outcome) > performanceOutcomeRank(this.outcome)) this.outcome = outcome;
  }

  private incrementOutcomeCounter(outcome: PerformanceOutcome): void {
    const counter: PerformanceCounterName = outcome === "success"
      ? "successCount"
      : outcome === "partial"
        ? "partialCount"
        : outcome === "failed"
          ? "failureCount"
          : "cancelledCount";
    this.counters[counter] = saturatingAdd(this.counters[counter], 1);
  }

  private recordInvalidMeasurement(): void {
    this.counters.invalidMeasurementCount = saturatingAdd(
      this.counters.invalidMeasurementCount,
      1,
    );
  }
}

function createEmptyCounters(): Record<PerformanceCounterName, number> {
  return Object.fromEntries(PERFORMANCE_COUNTER_NAMES.map((name) => [name, 0])) as Record<
    PerformanceCounterName,
    number
  >;
}

function safelyMatchesCancellation(
  predicate: ((error: unknown) => boolean) | undefined,
  error: unknown,
): boolean {
  if (!predicate) return false;
  try {
    return predicate(error) === true;
  } catch {
    return false;
  }
}

function safeNow(): number {
  try {
    const value = performance.now();
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function safeCpuUsage(previousValue?: NodeJS.CpuUsage): NodeJS.CpuUsage {
  try {
    return process.cpuUsage(previousValue);
  } catch {
    return { user: 0, system: 0 };
  }
}

function safeMemoryUsage(): PerformanceMemorySnapshot {
  try {
    const value = process.memoryUsage();
    return Object.freeze({
      heapUsedBytes: normalizeCounterValue(value.heapUsed),
      externalBytes: normalizeCounterValue(value.external),
      rssBytes: normalizeCounterValue(value.rss),
    });
  } catch {
    return Object.freeze({ heapUsedBytes: 0, externalBytes: 0, rssBytes: 0 });
  }
}

function maxMemory(
  left: PerformanceMemorySnapshot,
  right: PerformanceMemorySnapshot,
): PerformanceMemorySnapshot {
  return Object.freeze({
    heapUsedBytes: Math.max(left.heapUsedBytes, right.heapUsedBytes),
    externalBytes: Math.max(left.externalBytes, right.externalBytes),
    rssBytes: Math.max(left.rssBytes, right.rssBytes),
  });
}

function normalizeCounterValue(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value));
}

function normalizeDuration(value: number): number {
  return normalizeOptionalDuration(value) ?? 0;
}

function normalizeOptionalDuration(value: number): number | undefined {
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function saturatingAdd(left: number, right: number): number {
  return right > Number.MAX_SAFE_INTEGER - left ? Number.MAX_SAFE_INTEGER : left + right;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return !!value && (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function";
}

function isPerformanceOperationKind(value: unknown): value is PerformanceOperationKind {
  return (PERFORMANCE_OPERATION_KINDS as readonly unknown[]).includes(value);
}

function isPerformanceOutcome(value: unknown): value is PerformanceOutcome {
  return value === "success" || value === "partial" || value === "failed" || value === "cancelled";
}

function performanceOutcomeRank(outcome: PerformanceOutcome): number {
  return outcome === "success" ? 0 : outcome === "partial" ? 1 : outcome === "failed" ? 2 : 3;
}
