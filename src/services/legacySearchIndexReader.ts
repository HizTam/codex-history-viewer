import * as vscode from "vscode";
import type { SearchIndexEntryV1, IndexedSearchRole } from "./searchIndexService";
import type { PackedSearchMessageReader } from "./packedSearchMessages";
import {
  isSearchCacheKey,
  throwIfSearchReaderCancelled,
  validateSearchReadOptions,
  type SearchIndexPreparedSnapshot,
  type SearchIndexReadOptions,
  type SearchIndexReadSnapshot,
  type SearchIndexReadTicket,
  type SearchIndexScanReader,
} from "./searchIndexReader";

interface LegacyTicketState {
  readonly snapshot: SearchIndexReadSnapshot;
  readonly entries: ReadonlyMap<string, SearchIndexEntryV1>;
  readonly readableKeys: ReadonlySet<string>;
}

// Tickets are process-local receipts; callers cannot forge entry collections through a DTO.
const tickets = new WeakMap<SearchIndexReadTicket, LegacyTicketState>();

export function createLegacySearchSnapshot(
  getPackedReader: (entry: SearchIndexEntryV1) => PackedSearchMessageReader | undefined,
): SearchIndexReadSnapshot {
  const snapshot: SearchIndexReadSnapshot = Object.freeze({
    openReader: async (ticket: SearchIndexReadTicket, options: SearchIndexReadOptions = {}): Promise<SearchIndexScanReader> => {
      const state = tickets.get(ticket);
      if (!state || state.snapshot !== snapshot) throw new TypeError("Invalid search acquisition ticket.");
      validateSearchReadOptions(options);
      throwIfSearchReaderCancelled(options.token);
      return createLegacyReader(state.entries, state.readableKeys, getPackedReader, options);
    },
  });
  return snapshot;
}

export function prepareLegacySearchSnapshot(
  snapshot: SearchIndexReadSnapshot,
  entries: ReadonlyMap<string, SearchIndexEntryV1>,
  readableKeys: ReadonlySet<string>,
): SearchIndexPreparedSnapshot {
  const ticket: SearchIndexReadTicket = Object.freeze({ kind: "searchIndexReadTicket" });
  tickets.set(ticket, { snapshot, entries, readableKeys });
  return Object.freeze({ snapshot, ticket });
}

// Keep disposed readers independent from the receipt so they release their own map references.
function createLegacyReader(
  entries: ReadonlyMap<string, SearchIndexEntryV1> | undefined,
  readableKeys: ReadonlySet<string> | undefined,
  getPackedReader: (entry: SearchIndexEntryV1) => PackedSearchMessageReader | undefined,
  options: SearchIndexReadOptions,
): SearchIndexScanReader {
  let keys: ReadonlySet<string> | undefined = options.cacheKeys ? new Set(options.cacheKeys) : readableKeys;
  const roles: ReadonlySet<IndexedSearchRole> | undefined = options.roles ? new Set(options.roles) : undefined;
  const token = options.token;
  const check = (): void => {
    if (!entries) throw new vscode.CancellationError();
    throwIfSearchReaderCancelled(token);
  };
  const checkpoint = async (next: () => Promise<void>): Promise<void> => {
    check();
    await next();
    check();
  };
  const entryFor = (key: string): SearchIndexEntryV1 | undefined => {
    check();
    if (!isSearchCacheKey(key)) throw new TypeError("Invalid search cache key.");
    return keys?.has(key) && readableKeys?.has(key) ? entries!.get(key) : undefined;
  };
  return Object.freeze({
    iterateMessages: async function* (key: string, next: () => Promise<void>) {
      await checkpoint(next);
      const entry = entryFor(key);
      if (!entry) return;
      for (const message of entry.messages) {
        await checkpoint(next);
        if (!roles || roles.has(message.role)) yield message;
      }
    },
    getFileChangeHints: async (key: string) => entryFor(key)?.fileChangeHints ?? null,
    iterateToolTexts: async function* (key: string, next: () => Promise<void>) {
      await checkpoint(next);
      const entry = entryFor(key);
      if (!entry) return;
      const packed = getPackedReader(entry);
      if (packed) { yield* packed.iterateToolTexts(() => checkpoint(next)); return; }
      for (const message of entry.messages) {
        await checkpoint(next);
        if (message.source === "toolArguments" || message.source === "toolOutput") yield message.text;
      }
    },
    dispose: async () => { entries = undefined; readableKeys = undefined; keys = undefined; },
  });
}
