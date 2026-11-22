import type { SearchCandidatePlan } from "../services/searchIndexReader";
import type { SqliteRuntimeInfo } from "./sqliteRuntime";

// Worker requests contain bounded DTOs and never accept SQL or identifier fragments.
export type SqliteCacheFamily = "history" | "search" | "analysis";
export interface SqliteCacheContext {
  readonly id: string;
  readonly head: number;
}
export interface SqliteCacheEntry {
  readonly key: string;
  readonly version: number;
  readonly source: "codex" | "claude" | "antigravity" | "none";
  readonly identity: string;
  readonly inputSignature: string;
  readonly semanticDigest: string;
  readonly metadata: string;
}
export type SqliteStageRecord =
  | { kind: "value"; ordinal: number; text: string }
  | { kind: "message"; ordinal: number; metadata: string; role: string; source: string; units: number; eligible: boolean }
  | { kind: "text"; message: number; ordinal: number; text: string }
  | { kind: "gram"; message: number; ordinal: number; column: "raw" | "folded"; text: string }
  | { kind: "hint"; ordinal: number; metadata: string }
  | { kind: "path"; hint: number; ordinal: number; text: string };

export type SqliteMessageStage = Extract<SqliteStageRecord, { kind: "message" }>;
export type SqliteReuseMessage = Omit<SqliteMessageStage, "eligible"> & { digest: string };

export interface SqliteReadScope {
  readonly key: string;
  readonly version: number;
  readonly inputSignature: string;
}
export interface SqliteMessageDescriptor {
  readonly id: number;
  readonly ordinal: number;
  readonly metadata: string;
  readonly units: number;
}
export type SqliteCacheRequest =
  | { kind: "init"; file: string; owner: string }
  | { kind: "context"; family: SqliteCacheFamily; json: string }
  | { kind: "head"; context: string }
  | { kind: "list"; context: string; after: string | null }
  | { kind: "begin"; context: string; head: number; operation: string }
  | { kind: "entry"; operation: string; entry: Omit<SqliteCacheEntry, "version"> }
  | { kind: "stage"; operation: string; version: number; records: readonly SqliteStageRecord[] }
  | { kind: "reuse"; operation: string; version: number; previous: number; records: readonly SqliteReuseMessage[] }
  | { kind: "finishEntry"; operation: string; version: number; messages: number; hints: number; values: number }
  | { kind: "preparePublish"; operation: string }
  | { kind: "rollbackPublish"; operation: string }
  | { kind: "publish"; operation: string; pointers: readonly { key: string; version: number }[]; removed: readonly string[]; final: boolean; cancelState?: SharedArrayBuffer }
  | { kind: "abandon"; operation: string }
  | { kind: "open"; reader: string; context: string; head: number }
  | { kind: "scope"; reader: string; entries: readonly SqliteReadScope[] }
  | { kind: "candidates"; reader: string; plan: SearchCandidatePlan; after: number }
  | { kind: "seal"; reader: string }
  | { kind: "messages"; reader: string; key: string; after: number; roles: readonly string[]; tools: boolean }
  | { kind: "chunks"; reader: string; message: number; after: number }
  | { kind: "texts"; reader: string; message: number; after: number }
  | { kind: "hints"; reader: string; key: string; after: number }
  | { kind: "paths"; reader: string; key: string; hint: number; after: number }
  | { kind: "values"; reader: string; key: string; after: number }
  | { kind: "close"; reader: string }
  | { kind: "heartbeat" }
  | { kind: "maintenance" }
  | { kind: "clearFamily"; family: SqliteCacheFamily }
  | { kind: "checkpoint"; observe?: boolean }
  | { kind: "dispose" };

export type SqliteCacheWorkerRequest = SqliteCacheRequest | { kind: "probeRuntime" };

export interface SqliteWorkerEnvelope {
  readonly id: number;
  readonly request: SqliteCacheWorkerRequest;
}
export type SqliteCacheReadRequest = Extract<SqliteCacheRequest, { kind: "messages" | "chunks" | "hints" | "paths" | "values" }>;
export interface SqliteWorkerReady {
  readonly runtime: SqliteRuntimeInfo;
}
