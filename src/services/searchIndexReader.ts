import * as vscode from "vscode";
import type { IndexedFileChangeHint, IndexedSearchMessage, IndexedSearchRole } from "./searchIndexService";
import type { SessionSource } from "../sessions/sessionTypes";

export type SearchCandidatePlan =
  | { readonly kind: "all" }
  | { readonly kind: "grams"; readonly column: "raw" | "folded"; readonly anyOf: readonly string[] };

export const ALL_SEARCH_CANDIDATES: SearchCandidatePlan = Object.freeze({ kind: "all" });

export interface SearchIndexReadOptions {
  readonly cacheKeys?: readonly string[];
  readonly candidatePlan?: SearchCandidatePlan;
  readonly roles?: readonly IndexedSearchRole[];
  readonly token?: vscode.CancellationToken;
}

export interface SearchIndexReadTicket {
  readonly kind: "searchIndexReadTicket";
}

export interface SearchIndexScanReader {
  readonly unavailableSources?: readonly SessionSource[];
  readonly iterateMessages: (cacheKey: string, checkpoint: () => Promise<void>) => AsyncIterable<IndexedSearchMessage>;
  readonly getFileChangeHints: (cacheKey: string) => Promise<readonly IndexedFileChangeHint[] | null>;
  readonly iterateToolTexts: (cacheKey: string, checkpoint: () => Promise<void>) => AsyncIterable<string>;
  readonly dispose: () => Promise<void>;
}

export interface SearchIndexReadSnapshot {
  readonly openReader: (ticket: SearchIndexReadTicket, options?: SearchIndexReadOptions) => Promise<SearchIndexScanReader>;
}

export interface SearchIndexPreparedSnapshot {
  readonly snapshot: SearchIndexReadSnapshot;
  readonly ticket: SearchIndexReadTicket;
  readonly unavailableSources?: readonly SessionSource[];
}

export class SearchIndexGenerationMismatchError extends Error {
  constructor() {
    super("Search index acquisition generation changed.");
    this.name = "SearchIndexGenerationMismatchError";
  }
}

// Retry acquisition, never the partially consumed result or the user's cancelled request.
export async function acquireSearchIndexReader(
  prepare: () => Promise<SearchIndexPreparedSnapshot>,
  options: SearchIndexReadOptions = {},
): Promise<SearchIndexScanReader> {
  for (let attempt = 0; ; attempt += 1) {
    throwIfSearchReaderCancelled(options.token);
    const prepared = await prepare();
    throwIfSearchReaderCancelled(options.token);
    try {
      const reader = await prepared.snapshot.openReader(prepared.ticket, options);
      if (options.token?.isCancellationRequested) {
        await reader.dispose();
        throw new vscode.CancellationError();
      }
      // Bind quality to the receipt actually opened after generation retries or backend fallback.
      if (prepared.unavailableSources === undefined) return reader;
      return Object.freeze({
        unavailableSources: prepared.unavailableSources,
        iterateMessages: (key: string, checkpoint: () => Promise<void>) => reader.iterateMessages(key, checkpoint),
        getFileChangeHints: (key: string) => reader.getFileChangeHints(key),
        iterateToolTexts: (key: string, checkpoint: () => Promise<void>) => reader.iterateToolTexts(key, checkpoint),
        dispose: () => reader.dispose(),
      });
    } catch (error) {
      throwIfSearchReaderCancelled(options.token);
      if (!(error instanceof SearchIndexGenerationMismatchError) || attempt !== 0) throw error;
    }
  }
}

export function throwIfSearchReaderCancelled(token?: vscode.CancellationToken): void {
  if (token?.isCancellationRequested) throw new vscode.CancellationError();
}

export function validateSearchReadOptions(options: SearchIndexReadOptions): void {
  if (options.cacheKeys !== undefined && (!Array.isArray(options.cacheKeys) ||
      options.cacheKeys.some(key => !isSearchCacheKey(key)))) throw new TypeError("Invalid search scope.");
  if (options.roles !== undefined && (!Array.isArray(options.roles) ||
      options.roles.some(role => !["user", "assistant", "developer", "tool"].includes(role)))) {
    throw new TypeError("Invalid search roles.");
  }
  const plan = options.candidatePlan;
  if (plan === undefined || plan.kind === "all") return;
  if (plan.kind !== "grams" || (plan.column !== "raw" && plan.column !== "folded") ||
      !Array.isArray(plan.anyOf) || plan.anyOf.length < 1 || plan.anyOf.length > 32 ||
      plan.anyOf.some(gram => typeof gram !== "string" || Array.from(gram).length !== 3 ||
        /[\u0000\uD800-\uDFFF]/u.test(gram))) throw new TypeError("Invalid search candidate plan.");
}

export function isSearchCacheKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 32_768;
}

// Every positive OR clause must provide a necessary gram; otherwise keep all candidates.
export function buildSearchCandidatePlan(
  positiveClauses: readonly (readonly string[])[],
  caseSensitive: boolean,
): SearchCandidatePlan {
  if (positiveClauses.length < 1 || positiveClauses.length > 32) return ALL_SEARCH_CANDIDATES;
  const grams: string[] = [];
  for (const clause of positiveClauses) {
    let gram: string | undefined;
    for (const term of clause) {
      if (/[\u0000\uD800-\uDFFF]/u.test(term)) continue;
      const prefix: string[] = [];
      for (const point of term) {
        prefix.push(point);
        if (prefix.length === 3) break;
      }
      if (prefix.length === 3) { gram = prefix.join(""); break; }
    }
    if (gram === undefined) return ALL_SEARCH_CANDIDATES;
    grams.push(gram);
  }
  return Object.freeze({
    kind: "grams",
    column: caseSensitive ? "raw" : "folded",
    anyOf: Object.freeze([...new Set(grams)]),
  });
}

export function buildRegexSearchCandidatePlan(body: string, flags: string): SearchCandidatePlan {
  // Only non-Unicode ignore-case has ASCII equivalence that safely agrees with toLowerCase.
  const folded = flags.includes("i");
  if (folded && (flags.includes("u") || flags.includes("v"))) return ALL_SEARCH_CANDIDATES;
  const runs: string[] = [];
  let literal = "";
  const flush = (): void => { if (literal) runs.push(literal); literal = ""; };
  for (let index = 0; index < body.length; index++) {
    const char = body[index]!;
    if (char === "\\") {
      const next = body[++index];
      // Only escaped punctuation has an unambiguous literal meaning in this subset.
      if (next === undefined || !"\\^$.*+?()[]{}|/-".includes(next)) return ALL_SEARCH_CANDIDATES;
      literal += next;
    } else if (char === ".") {
      flush();
      if (index + 1 < body.length && "*+?".includes(body[index + 1]!)) index++;
    } else if (char === "^" || char === "$") flush();
    else if ("()[]{}|*+?".includes(char)) return ALL_SEARCH_CANDIDATES;
    else literal += char;
  }
  flush();
  // Every retained run is mandatory; the longest run usually provides a useful necessary gram.
  const usable = folded ? runs.filter(run => /^[\u0001-\u007f]+$/.test(run)).map(run => run.toLowerCase()) : runs;
  usable.sort((left, right) => right.length - left.length);
  return buildSearchCandidatePlan([usable], !folded);
}
