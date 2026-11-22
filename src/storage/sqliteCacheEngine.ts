import { selectSqliteCacheFile } from "./sqliteCacheLocation";
import { constants } from "node:buffer";
import { createHash } from "node:crypto";
import { canonicalSqliteJson, decodeSqliteStoredText, decodeSqliteTextChunk, encodeSqliteStoredText, isSqliteFtsEligible, isWithinSqliteGramBudget,
  SQLITE_CACHE_BATCH_BYTES, SQLITE_CACHE_BATCH_RECORDS, SQLITE_CACHE_METADATA_BYTES, SQLITE_STORED_TEXT_MAX_BYTES } from "./sqliteCacheCodec";
import { initializeSqliteCacheSchema, sqliteContextIdentity, validateSqliteCacheSchema } from "./sqliteCacheSchema";
import { configureSqliteConnection, isRecord, loadSqliteModule, probeSqliteCacheRuntime, SqliteCacheError, sqliteInteger, sqliteText, sqliteUtf8, supportsSqliteCheckpointObservation,
  type SqliteDatabase, type SqliteRow, type SqliteValue } from "./sqliteRuntime";
import type { SqliteCacheRequest, SqliteMessageStage, SqliteStageRecord } from "./sqliteCacheTypes";

const EXPIRY_MS = 5 * 60 * 1000;
const SOURCES = new Set(["codex", "claude", "antigravity", "none"]);
interface ReadConnection {
  db: SqliteDatabase;
  context: string;
  sealed: boolean;
  plan?: string;
  allCandidates: boolean;
  lastCandidate: number;
}

// This synchronous engine runs only inside the cache Worker, never on the Extension Host.
export class SqliteCacheEngine {
  private writer?: SqliteDatabase;
  private file = "";
  private owner = "";
  private canObserveCheckpoint = false;
  private readonly readers = new Map<string, ReadConnection>();
  private preparedPublish?: { operation: string; deadline: number; timer: ReturnType<typeof setTimeout> };

  constructor(private readonly onFatalError: () => void = () => { throw new SqliteCacheError("io"); }) {}

  public execute(request: SqliteCacheRequest): unknown {
    if (!isRecord(request) || typeof request.kind !== "string") throw new SqliteCacheError("invalidData");
    if (request.kind === "init") return this.initialize(request);
    const db = this.db();
    if (this.preparedPublish && request.kind !== "publish" && request.kind !== "rollbackPublish" && request.kind !== "dispose") {
      throw new SqliteCacheError("busy");
    }
    switch (request.kind) {
      case "context": return this.context(request);
      case "head": {
        const row = db.prepare("SELECT head_generation FROM cache_contexts WHERE context_id=?").get(handle(request.context));
        if (!row) throw new SqliteCacheError("generation");
        return sqliteInteger(row.head_generation);
      }
      case "list": return this.list(request);
      case "begin": return this.begin(request);
      case "entry": return this.entry(request);
      case "stage": return this.stage(request);
      case "reuse": return this.reuse(request);
      case "finishEntry": return this.finishEntry(request);
      case "preparePublish": return this.preparePublish(request.operation);
      case "rollbackPublish": return this.rollbackPublish(request.operation);
      case "publish": return this.publish(request);
      case "abandon": {
        db.prepare("UPDATE cache_operations SET state='abandoned' WHERE operation_id=? AND owner=? AND state='staging'")
          .run(handle(request.operation), this.owner);
        db.prepare("DELETE FROM cache_operation_entries WHERE operation_id IN (SELECT operation_id FROM cache_operations WHERE operation_id=? AND owner=? AND state='abandoned')")
          .run(request.operation, this.owner);
        return null;
      }
      case "open": return this.open(request);
      case "scope": return this.scope(request);
      case "candidates": return this.candidates(request);
      case "seal": {
        const read = this.read(request.reader, false);
        if (!read.plan) throw new SqliteCacheError("invalidData");
        read.db.exec("PRAGMA query_only=ON");
        if (read.db.prepare("PRAGMA query_only").get()?.query_only !== 1) throw new SqliteCacheError("runtime");
        read.sealed = true;
        return null;
      }
      case "messages": return this.messages(request);
      case "chunks":
      case "texts": {
        const read = this.read(request.reader, true);
        const sql = `SELECT c.ordinal,c.codec, ${boundedBlob("c.text_json")} AS text_json FROM search_text_chunks c
          JOIN search_messages m ON m.content_id=c.content_id JOIN temp.scope s ON s.version=m.entry_version_id
          WHERE m.message_id=? AND c.ordinal>? ORDER BY c.ordinal LIMIT 16`;
        const values = [sqliteInteger(request.message, 1), sqliteInteger(request.after, -1)];
        // Decode once in the Worker; fixed chunk/count bounds replace another JSON serialization.
        const rows: SqliteRow[] = [];
        let bytes = 2;
        for (const row of read.db.prepare(sql).iterate(...values)) {
          const value = decodeSqliteStoredText(row.codec, row.text_json);
          const decoded: SqliteRow = request.kind === "texts" ? { ordinal: sqliteInteger(row.ordinal), text: value.text }
            : { ordinal: sqliteInteger(row.ordinal), text_json: value.json };
          if (request.kind === "chunks") {
            const size = Buffer.byteLength(JSON.stringify(decoded), "utf8") + 1;
            if (rows.length && bytes + size > 1048576) break;
            bytes += size;
          }
          rows.push(decoded);
        }
        return rows;
      }
      case "hints": return this.hints(request);
      case "paths": {
        const read = this.read(request.reader, true);
        return readPage(read.db, `SELECT p.ordinal, ${boundedBlob("p.path_json")} AS path_json FROM search_hint_paths p
          JOIN temp.scope s ON s.version=p.entry_version_id WHERE s.cache_key=? AND p.hint_ordinal=? AND p.ordinal>?
          ORDER BY p.ordinal LIMIT 64`, [key(request.key), sqliteInteger(request.hint), sqliteInteger(request.after, -1)], ["path_json"]);
      }
      case "values": {
        const read = this.read(request.reader, true);
        return readPage(read.db, `SELECT c.ordinal, ${boundedBlob("c.text_json")} AS text_json FROM cache_value_chunks c
          JOIN temp.scope s ON s.version=c.entry_version_id WHERE s.cache_key=? AND c.ordinal>? ORDER BY c.ordinal LIMIT 16`,
          [key(request.key), sqliteInteger(request.after, -1)], ["text_json"]);
      }
      case "close": return this.close(request.reader);
      case "heartbeat": return this.heartbeat();
      case "checkpoint": return this.checkpoint(request.observe);
      case "maintenance": return this.maintenance();
      case "clearFamily": {
        if (!["history", "search", "analysis"].includes(request.family)) throw new SqliteCacheError("invalidData");
        return transaction(db, () => {
          const maximum = db.prepare("SELECT max(head_generation) AS head FROM cache_contexts WHERE family=?").get(request.family)?.head;
          if (maximum !== null && sqliteInteger(maximum) >= Number.MAX_SAFE_INTEGER) throw new SqliteCacheError("generation");
          db.prepare("UPDATE cache_operations SET state='abandoned' WHERE context_id IN(SELECT context_id FROM cache_contexts WHERE family=?) AND state='staging'").run(request.family);
          db.prepare("DELETE FROM cache_operation_entries WHERE operation_id IN(SELECT p.operation_id FROM cache_operations p JOIN cache_contexts c USING(context_id) WHERE c.family=?)").run(request.family);
          db.prepare("DELETE FROM cache_entries WHERE context_id IN(SELECT context_id FROM cache_contexts WHERE family=?)").run(request.family);
          db.prepare("UPDATE cache_contexts SET head_generation=head_generation+1 WHERE family=?").run(request.family);
          return null;
        });
      }
      case "dispose": {
        if (this.preparedPublish) this.rollbackPublish(this.preparedPublish.operation);
        for (const id of this.readers.keys()) this.close(id);
        db.prepare("DELETE FROM cache_context_owners WHERE owner_id=?").run(this.owner);
        db.prepare("UPDATE cache_operations SET state='abandoned' WHERE owner=? AND state='staging'").run(this.owner);
        db.close(); this.writer = undefined;
        return null;
      }
      default: throw new SqliteCacheError("invalidData");
    }
  }

  private db(): SqliteDatabase {
    if (!this.writer) throw new SqliteCacheError("disposed");
    return this.writer;
  }

  private initialize(request: Extract<SqliteCacheRequest, { kind: "init" }>): unknown {
    if (this.writer) throw new SqliteCacheError("invalidData");
    this.owner = handle(request.owner);
    const runtime = probeSqliteCacheRuntime();
    this.file = selectSqliteCacheFile(sqliteText(request.file));
    const db = new (loadSqliteModule().DatabaseSync)(this.file, { allowExtension: false });
    try {
      configureSqliteConnection(db);
      initializeSqliteCacheSchema(db);
      if (db.prepare("PRAGMA journal_mode=WAL").get()?.journal_mode !== "wal") throw new SqliteCacheError("storage");
      const pageSize = sqliteInteger(db.prepare("PRAGMA page_size").get()?.page_size, 512, 65536);
      db.exec(`PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=${Math.floor(64 * 1048576 / pageSize)}`);
      this.canObserveCheckpoint = supportsSqliteCheckpointObservation(runtime.version);
      this.writer = db;
      return { runtime };
    } catch (error) { db.close(); throw error; }
  }

  private context(request: Extract<SqliteCacheRequest, { kind: "context" }>): unknown {
    if (!["history", "search", "analysis"].includes(request.family)) throw new SqliteCacheError("invalidData");
    const json = sqliteText(request.json, 1024 * 1024);
    try { if (canonicalSqliteJson(JSON.parse(json)) !== json) throw new Error(); }
    catch { throw new SqliteCacheError("invalidData"); }
    const id = sqliteContextIdentity(request.family, json);
    const db = this.db();
    return transaction(db, () => {
      const now = Date.now();
      db.prepare("INSERT OR IGNORE INTO cache_contexts(context_id,family,context_json,last_used) VALUES(?,?,?,?)")
        .run(id, request.family, json, now);
      const row = db.prepare(`SELECT ${boundedBlob("context_json")} AS context_json, head_generation FROM cache_contexts WHERE context_id=?`).get(id);
      if (!row || sqliteUtf8(row.context_json) !== json) throw new SqliteCacheError("corrupt");
      db.prepare(`DELETE FROM cache_context_owners WHERE owner_id=? AND context_id IN
        (SELECT context_id FROM cache_contexts WHERE family=? AND context_id<>?)`).run(this.owner, request.family, id);
      db.prepare("INSERT OR REPLACE INTO cache_context_owners(owner_id,context_id,heartbeat) VALUES(?,?,?)").run(this.owner, id, now);
      db.prepare("UPDATE cache_contexts SET last_used=? WHERE context_id=?").run(now, id);
      return { id, head: sqliteInteger(row.head_generation) };
    });
  }

  private list(request: Extract<SqliteCacheRequest, { kind: "list" }>): unknown {
    const rows = readPage(this.db(), `SELECT ${boundedBlob("e.cache_key")} AS cache_key, v.entry_version_id,
      ${boundedBlob("v.source")} AS source, ${boundedBlob("v.identity_key")} AS identity_key, ${boundedBlob("v.input_signature")} AS input_signature,
      ${boundedBlob("v.semantic_digest")} AS semantic_digest, ${boundedBlob("v.metadata_json")} AS metadata_json
      FROM cache_entries e JOIN cache_entry_versions v USING(entry_version_id)
      WHERE e.context_id=? AND (? IS NULL OR e.cache_key>?) AND v.complete=1 ORDER BY e.cache_key LIMIT 256`,
      [handle(request.context), request.after === null ? null : key(request.after), request.after === null ? null : key(request.after)],
      ["cache_key", "source", "identity_key", "input_signature", "semantic_digest", "metadata_json"]);
    return rows.map(row => ({ key: parseKey(row.cache_key), version: sqliteInteger(row.entry_version_id, 1), source: row.source,
      identity: parseKey(row.identity_key), inputSignature: sqliteUtf8(row.input_signature), semanticDigest: row.semantic_digest, metadata: sqliteUtf8(row.metadata_json) }));
  }

  private begin(request: Extract<SqliteCacheRequest, { kind: "begin" }>): unknown {
    const db = this.db();
    return transaction(db, () => {
      const context = handle(request.context);
      const head = sqliteInteger(request.head);
      this.verifyOwner(context);
      if (db.prepare("SELECT head_generation FROM cache_contexts WHERE context_id=?").get(context)?.head_generation !== head) {
        throw new SqliteCacheError("generation");
      }
      db.prepare("INSERT INTO cache_operations(operation_id,owner,context_id,base_generation,state,heartbeat) VALUES(?,?,?,?,'staging',?)")
        .run(handle(request.operation), this.owner, context, head, Date.now());
      return null;
    });
  }

  private verifyOwner(context: string): void {
    const row = this.db().prepare("SELECT heartbeat FROM cache_context_owners WHERE owner_id=? AND context_id=?").get(this.owner, context);
    if (!row || sqliteInteger(row.heartbeat) < Date.now() - EXPIRY_MS) throw new SqliteCacheError("expired");
  }

  private operation(operation: string): SqliteRow {
    const row = this.db().prepare(`SELECT ${boundedBlob("context_id")} AS context_id,base_generation,heartbeat
      FROM cache_operations WHERE operation_id=? AND owner=? AND state='staging'`).get(handle(operation), this.owner);
    if (!row || sqliteInteger(row.heartbeat) < Date.now() - EXPIRY_MS) throw new SqliteCacheError("expired");
    row.context_id = handle(sqliteUtf8(row.context_id));
    this.verifyOwner(row.context_id);
    return row;
  }

  private entry(request: Extract<SqliteCacheRequest, { kind: "entry" }>): unknown {
    const db = this.db();
    return transaction(db, () => {
      this.operation(request.operation);
      const entry = request.entry;
      if (!isRecord(entry) || !SOURCES.has(entry.source)) throw new SqliteCacheError("invalidData");
      const result = db.prepare(`INSERT INTO cache_entry_versions(operation_id,cache_key,source,identity_key,input_signature,semantic_digest,metadata_json)
        VALUES(?,?,?,?,?,?,?)`).run(handle(request.operation), key(entry.key), entry.source, key(entry.identity),
          sqliteText(entry.inputSignature, 1024 * 1024), digest(entry.semanticDigest), jsonText(entry.metadata));
      return sqliteInteger(result.lastInsertRowid, 1);
    });
  }

  private verifyVersion(operation: string, version: number): void {
    this.operation(operation);
    const entry = this.db().prepare("SELECT complete FROM cache_entry_versions WHERE entry_version_id=? AND operation_id=?")
      .get(sqliteInteger(version, 1), handle(operation));
    if (!entry || entry.complete !== 0) throw new SqliteCacheError("invalidData");
  }

  private stage(request: Extract<SqliteCacheRequest, { kind: "stage" }>): unknown {
    if (!Array.isArray(request.records) || request.records.length > SQLITE_CACHE_BATCH_RECORDS
      || Buffer.byteLength(JSON.stringify(request.records), "utf8") > SQLITE_CACHE_BATCH_BYTES) throw new SqliteCacheError("invalidData");
    const db = this.db();
    return transaction(db, () => {
      this.verifyVersion(request.operation, request.version);
      for (const record of request.records) this.stageRecord(request.version, record);
      db.prepare("UPDATE cache_operations SET heartbeat=? WHERE operation_id=?").run(Date.now(), request.operation);
      return null;
    });
  }

  private reuse(request: Extract<SqliteCacheRequest, { kind: "reuse" }>): unknown {
    if (!Array.isArray(request.records) || request.records.length > SQLITE_CACHE_BATCH_RECORDS
      || Buffer.byteLength(JSON.stringify(request.records), "utf8") > SQLITE_CACHE_BATCH_BYTES) throw new SqliteCacheError("invalidData");
    const db = this.db();
    return transaction(db, () => {
      this.verifyVersion(request.operation, request.version);
      const operation = this.operation(request.operation);
      const previous = sqliteInteger(request.previous, 1);
      // Only the current version of the same source identity may supply shared immutable text.
      const valid = db.prepare(`SELECT 1 FROM cache_entries e JOIN cache_entry_versions old ON old.entry_version_id=e.entry_version_id
        JOIN cache_entry_versions next ON next.entry_version_id=? WHERE e.context_id=? AND e.entry_version_id=?
        AND old.complete=1 AND old.cache_key=next.cache_key AND old.source=next.source AND old.identity_key=next.identity_key`)
        .get(request.version, operation.context_id, previous);
      if (!valid) throw new SqliteCacheError("generation");
      const reused: number[] = [];
      const requested = new Set<number>();
      for (const record of request.records) {
        if (!isRecord(record) || record.kind !== "message" || Object.prototype.hasOwnProperty.call(record, "eligible")) throw new SqliteCacheError("invalidData");
        this.validateMessage({ ...record, eligible: false });
        const ordinal = sqliteInteger(record.ordinal);
        if (requested.has(ordinal)) throw new SqliteCacheError("invalidData");
        requested.add(ordinal);
        const row = db.prepare(`SELECT c.content_id,c.fts_eligible FROM search_messages m JOIN search_contents c USING(content_id)
          WHERE m.entry_version_id=? AND m.ordinal=? AND c.complete=1 AND c.staging_version IS NULL
          AND c.digest=? AND c.text_units=? AND m.text_units=c.text_units AND m.fts_eligible=c.fts_eligible`)
          .get(previous, ordinal, digest(record.digest), sqliteInteger(record.units, 0, constants.MAX_STRING_LENGTH));
        if (!row) continue;
        this.stageMessage(request.version, { ...record, eligible: sqliteInteger(row.fts_eligible, 0, 1) === 1 }, sqliteInteger(row.content_id, 1));
        reused.push(ordinal);
      }
      db.prepare("UPDATE cache_operations SET heartbeat=? WHERE operation_id=?").run(Date.now(), request.operation);
      return reused;
    });
  }

  private validateMessage(record: SqliteMessageStage): string {
    if (!["user", "assistant", "developer", "tool"].includes(record.role)
      || !["message", "toolArguments", "toolOutput"].includes(record.source) || typeof record.eligible !== "boolean") throw new SqliteCacheError("invalidData");
    const units = sqliteInteger(record.units, 0, constants.MAX_STRING_LENGTH);
    if (record.eligible && units > 1048576) throw new SqliteCacheError("invalidData");
    sqliteInteger(record.ordinal); return jsonText(record.metadata);
  }

  private stageMessage(version: number, record: SqliteMessageStage, shared?: number): void {
    const metadata = this.validateMessage(record);
    const db = this.db();
    const content = shared ?? sqliteInteger(db.prepare(`INSERT INTO search_contents(staging_version,text_units,fts_eligible)
      VALUES(?,?,?)`).run(version, record.units, Number(record.eligible)).lastInsertRowid, 1);
    db.prepare(`INSERT INTO search_messages(entry_version_id,content_id,ordinal,metadata_json,role,kind,text_units,fts_eligible)
      VALUES(?,?,?,?,?,?,?,?)`).run(version, content, record.ordinal, metadata, record.role, record.source, record.units, Number(record.eligible));
  }

  private stageRecord(version: number, record: SqliteStageRecord): void {
    if (!isRecord(record)) throw new SqliteCacheError("invalidData");
    const db = this.db();
    const ordinal = sqliteInteger(record.ordinal);
    switch (record.kind) {
      case "value":
        decodeSqliteTextChunk(record.text);
        db.prepare("INSERT INTO cache_value_chunks VALUES(?,?,?)").run(version, ordinal, record.text);
        break;
      case "message": {
        this.stageMessage(version, record);
        break;
      }
      case "text": {
        const content = this.stagingContentId(version, record.message);
        const value = encodeSqliteStoredText(record.text);
        db.prepare("INSERT INTO search_text_chunks VALUES(?,?,?,?)").run(content, ordinal, value.codec, value.data);
        break;
      }
      case "gram": {
        if (!["raw", "folded"].includes(record.column) || ordinal !== 0 || typeof record.text !== "string"
          || !isSqliteFtsEligible(record.text) || !isWithinSqliteGramBudget(record.text)) throw new SqliteCacheError("invalidData");
        const content = this.stagingContentId(version, record.message);
        if (db.prepare("SELECT fts_eligible FROM search_contents WHERE content_id=?").get(content)?.fts_eligible !== 1) throw new SqliteCacheError("invalidData");
        if (db.prepare("SELECT 1 FROM search_gram_documents WHERE content_id=? AND column_kind=?").get(content, record.column)) throw new SqliteCacheError("invalidData");
        const result = db.prepare("INSERT INTO search_gram_documents(content_id,column_kind,ordinal) VALUES(?,?,?)").run(content, record.column, ordinal);
        db.prepare("INSERT INTO search_grams(rowid,raw,folded) VALUES(?,?,?)").run(result.lastInsertRowid,
          record.column === "raw" ? record.text : "", record.column === "folded" ? record.text : "");
        break;
      }
      case "hint":
        db.prepare("INSERT INTO search_file_hints VALUES(?,?,?)").run(version, ordinal, jsonText(record.metadata));
        break;
      case "path": {
        const parsed: unknown = JSON.parse(sqliteText(record.text, 262144));
        if (typeof parsed !== "string" || parsed.length > 32768) throw new SqliteCacheError("invalidData");
        db.prepare("INSERT INTO search_hint_paths VALUES(?,?,?,?)").run(version, sqliteInteger(record.hint), ordinal, JSON.stringify(parsed));
        break;
      }
      default: throw new SqliteCacheError("invalidData");
    }
  }

  private stagingContentId(version: number, ordinal: number): number {
    // An unfinished entry may refer to complete shared text, but may never mutate it.
    const row = this.db().prepare(`SELECT c.content_id FROM search_messages m JOIN search_contents c USING(content_id)
      WHERE m.entry_version_id=? AND m.ordinal=? AND c.complete=0 AND c.staging_version=?`)
      .get(version, sqliteInteger(ordinal), version);
    if (!row) throw new SqliteCacheError("invalidData");
    return sqliteInteger(row.content_id, 1);
  }

  private finishEntry(request: Extract<SqliteCacheRequest, { kind: "finishEntry" }>): unknown {
    const db = this.db();
    return transaction(db, () => {
      this.verifyVersion(request.operation, request.version);
      const counts = db.prepare(`SELECT
        (SELECT count(*) FROM search_messages WHERE entry_version_id=?) AS messages,
        (SELECT count(*) FROM search_file_hints WHERE entry_version_id=?) AS hints,
        (SELECT count(*) FROM cache_value_chunks WHERE entry_version_id=?) AS value_count`).get(request.version, request.version, request.version);
      if (counts?.messages !== sqliteInteger(request.messages) || counts.hints !== sqliteInteger(request.hints)
        || counts.value_count !== sqliteInteger(request.values)) throw new SqliteCacheError("invalidData");
      this.verifyContiguous("messages", request.version, request.messages);
      this.verifyContiguous("hints", request.version, request.hints);
      this.verifyContiguous("values", request.version, request.values);
      let after = -1;
      while (true) {
        const messages = db.prepare(`SELECT m.ordinal,m.text_units,m.fts_eligible,c.content_id,c.complete,c.staging_version,
          c.text_units AS content_units,c.fts_eligible AS content_eligible FROM search_messages m JOIN search_contents c USING(content_id)
          WHERE m.entry_version_id=? AND m.ordinal>? ORDER BY m.ordinal LIMIT 64`)
          .all(request.version, after);
        if (!messages.length) break;
        for (const message of messages) {
          after = sqliteInteger(message.ordinal);
          if (message.text_units !== message.content_units || message.fts_eligible !== message.content_eligible) throw new SqliteCacheError("invalidData");
          if (message.complete === 1 && message.staging_version === null) continue;
          if (message.complete !== 0 || message.staging_version !== request.version) throw new SqliteCacheError("invalidData");
          const content = sqliteInteger(message.content_id, 1);
          const hash = createHash("sha256");
          let chunkAfter = -1;
          let units = 0;
          while (true) {
            const chunks = db.prepare(`SELECT c.ordinal,c.codec,${boundedBlob("c.text_json")} AS text_json FROM search_text_chunks c WHERE c.content_id=? AND c.ordinal>? ORDER BY c.ordinal LIMIT 16`)
              .all(content, chunkAfter);
            if (!chunks.length) break;
            for (const chunk of chunks) {
              if (chunk.ordinal !== chunkAfter + 1) throw new SqliteCacheError("invalidData");
              const text = decodeSqliteStoredText(chunk.codec, chunk.text_json).text;
              units += text.length;
              hash.update(text, "utf16le");
              chunkAfter++;
            }
          }
          if (chunkAfter < 0 || units !== message.text_units) throw new SqliteCacheError("invalidData");
          if (message.fts_eligible === 1) {
            const gramKinds = db.prepare("SELECT column_kind,count(*) AS count,min(ordinal) AS first,max(ordinal) AS last FROM search_gram_documents WHERE content_id=? GROUP BY column_kind")
              .all(content);
            // Empty messages have no necessary trigram and never match a positive gram.
            if (units > 0 && (gramKinds.length !== 2 || gramKinds.some(row => row.first !== 0 || row.last !== 0 || row.count !== 1))) {
              throw new SqliteCacheError("invalidData");
            }
          }
          db.prepare("UPDATE search_contents SET digest=?,complete=1,staging_version=NULL WHERE content_id=? AND complete=0 AND staging_version=?")
            .run(hash.digest("hex"), content, request.version);
        }
      }
      db.prepare("UPDATE cache_entry_versions SET complete=1 WHERE entry_version_id=?").run(request.version);
      return null;
    });
  }

  private verifyContiguous(kind: "messages" | "hints" | "values", version: number, count: number): void {
    const sql = {
      messages: "SELECT min(ordinal) AS first,max(ordinal) AS last FROM search_messages WHERE entry_version_id=?",
      hints: "SELECT min(ordinal) AS first,max(ordinal) AS last FROM search_file_hints WHERE entry_version_id=?",
      values: "SELECT min(ordinal) AS first,max(ordinal) AS last FROM cache_value_chunks WHERE entry_version_id=?",
    }[kind];
    const row = this.db().prepare(sql).get(version);
    if (count > 0 && (row?.first !== 0 || row.last !== count - 1)) throw new SqliteCacheError("invalidData");
  }

  private publish(request: Extract<SqliteCacheRequest, { kind: "publish" }>): unknown {
    if (!Array.isArray(request.pointers) || request.pointers.length > 256 || !Array.isArray(request.removed)
      || request.removed.length > 256 || typeof request.final !== "boolean") throw new SqliteCacheError("invalidData");
    const db = this.db();
    const apply = (): unknown => {
      const operation = this.operation(request.operation);
      for (const pointer of request.pointers) {
        if (!isRecord(pointer)) throw new SqliteCacheError("invalidData");
        const version = sqliteInteger(pointer.version, 1);
        const encodedKey = key(pointer.key);
        const valid = db.prepare(`SELECT v.entry_version_id FROM cache_entry_versions v WHERE v.entry_version_id=? AND v.cache_key=? AND v.complete=1
          AND (v.operation_id=? OR EXISTS(SELECT 1 FROM cache_entries e WHERE e.context_id=? AND e.entry_version_id=v.entry_version_id))`)
          .get(version, encodedKey, request.operation, operation.context_id);
        if (!valid) throw new SqliteCacheError("invalidData");
        db.prepare("INSERT OR REPLACE INTO cache_operation_entries VALUES(?,?,?)").run(request.operation, encodedKey, version);
      }
      for (const removed of request.removed) db.prepare("INSERT OR REPLACE INTO cache_operation_entries VALUES(?,?,NULL)").run(request.operation, key(removed));
      if (!request.final) return null;
      const head = sqliteInteger(operation.base_generation);
      if (head === Number.MAX_SAFE_INTEGER || db.prepare("SELECT head_generation FROM cache_contexts WHERE context_id=?").get(operation.context_id)?.head_generation !== head) {
        throw new SqliteCacheError("generation");
      }
      db.prepare(`DELETE FROM cache_entries WHERE context_id=? AND cache_key IN
        (SELECT cache_key FROM cache_operation_entries WHERE operation_id=? AND entry_version_id IS NULL)`)
        .run(operation.context_id, request.operation);
      db.prepare(`INSERT OR REPLACE INTO cache_entries SELECT ?, cache_key, entry_version_id FROM cache_operation_entries
        WHERE operation_id=? AND entry_version_id IS NOT NULL`).run(operation.context_id, request.operation);
      db.prepare("UPDATE cache_contexts SET head_generation=?,last_used=? WHERE context_id=?").run(head + 1, Date.now(), operation.context_id);
      db.prepare("UPDATE cache_operations SET state='published',heartbeat=? WHERE operation_id=?").run(Date.now(), request.operation);
      db.prepare("DELETE FROM cache_operation_entries WHERE operation_id=?").run(request.operation);
      return { id: operation.context_id, head: head + 1 };
    };
    if (!request.final) {
      if (this.preparedPublish) throw new SqliteCacheError("busy");
      return transaction(db, apply);
    }
    const prepared = this.preparedPublish;
    if (!prepared || prepared.operation !== handle(request.operation)) throw new SqliteCacheError("expired");
    try {
      if (Date.now() >= prepared.deadline) throw new SqliteCacheError("expired");
      const flag = cancellationFlag(request.cancelState);
      if (Atomics.load(flag, 0) !== 0) throw new SqliteCacheError("cancelled");
      const result = apply();
      if (Atomics.load(flag, 0) !== 0) throw new SqliteCacheError("cancelled");
      db.exec("COMMIT");
      clearTimeout(prepared.timer); this.preparedPublish = undefined;
      return result;
    } catch (error) { this.rollbackPublish(request.operation); throw error; }
  }

  private preparePublish(operation: string): null {
    operation = handle(operation);
    const db = this.db();
    if (this.preparedPublish) throw new SqliteCacheError("busy");
    db.exec("BEGIN IMMEDIATE");
    try {
      const job = this.operation(operation);
      if (db.prepare("SELECT head_generation FROM cache_contexts WHERE context_id=?").get(job.context_id)?.head_generation !== sqliteInteger(job.base_generation)) {
        throw new SqliteCacheError("generation");
      }
      const timer = setTimeout(() => { this.rollbackPublish(operation); }, 5000);
      timer.unref();
      this.preparedPublish = { operation, deadline: Date.now() + 5000, timer };
      return null;
    } catch (error) {
      try { db.exec("ROLLBACK"); }
      catch { this.invalidateWriter(db); }
      throw error;
    }
  }

  private rollbackPublish(operation: string): null {
    operation = handle(operation);
    const prepared = this.preparedPublish;
    if (!prepared) return null;
    if (prepared.operation !== handle(operation)) throw new SqliteCacheError("invalidData");
    clearTimeout(prepared.timer); this.preparedPublish = undefined;
    const db = this.db();
    try { db.exec("ROLLBACK"); }
    catch { this.invalidateWriter(db); }
    return null;
  }

  private invalidateWriter(db: SqliteDatabase): never {
    this.writer = undefined;
    try { db.close(); }
    catch { /* The Worker must exit even when native connection cleanup fails. */ }
    this.onFatalError();
    throw new SqliteCacheError("io");
  }

  private open(request: Extract<SqliteCacheRequest, { kind: "open" }>): unknown {
    const id = handle(request.reader);
    if (this.readers.has(id) || this.readers.size >= 3) throw new SqliteCacheError("busy");
    const db = new (loadSqliteModule().DatabaseSync)(this.file, { readOnly: true, allowExtension: false });
    try {
      configureSqliteConnection(db);
      db.exec("BEGIN");
      const context = handle(request.context);
      const row = db.prepare("SELECT head_generation FROM cache_contexts WHERE context_id=?").get(context);
      if (!row || row.head_generation !== sqliteInteger(request.head)) throw new SqliteCacheError("generation");
      validateSqliteCacheSchema(db);
      db.exec("CREATE TEMP TABLE scope(cache_key TEXT PRIMARY KEY, version INTEGER UNIQUE); CREATE TEMP TABLE candidates(message_id INTEGER PRIMARY KEY)");
      this.readers.set(id, { db, context, sealed: false, allCandidates: true, lastCandidate: 0 });
      return null;
    } catch (error) { db.close(); throw error; }
  }

  private read(id: string, sealed: boolean): ReadConnection {
    const read = this.readers.get(handle(id));
    if (!read || read.sealed !== sealed) throw new SqliteCacheError("invalidData");
    return read;
  }

  private scope(request: Extract<SqliteCacheRequest, { kind: "scope" }>): unknown {
    const read = this.read(request.reader, false);
    if (read.plan || !Array.isArray(request.entries) || request.entries.length > 256) throw new SqliteCacheError("invalidData");
    for (const entry of request.entries) {
      if (!isRecord(entry)) throw new SqliteCacheError("invalidData");
      const encoded = key(entry.key);
      const version = sqliteInteger(entry.version, 1);
      const current = read.db.prepare(`SELECT e.entry_version_id,${boundedBlob("v.input_signature")} AS input_signature FROM cache_entries e
        JOIN cache_entry_versions v USING(entry_version_id) WHERE e.context_id=? AND e.cache_key=? AND v.complete=1`)
        .get(read.context, encoded);
      if (current?.entry_version_id !== version || sqliteUtf8(current.input_signature) !== sqliteText(entry.inputSignature, 1048576)) {
        throw new SqliteCacheError("generation");
      }
      read.db.prepare("INSERT INTO temp.scope VALUES(?,?)").run(encoded, version);
    }
    return null;
  }

  private candidates(request: Extract<SqliteCacheRequest, { kind: "candidates" }>): unknown {
    const read = this.read(request.reader, false);
    const plan = request.plan;
    if (!isRecord(plan) || !["all", "grams"].includes(plan.kind)) throw new SqliteCacheError("invalidData");
    const json = canonicalSqliteJson(plan);
    if (read.plan && read.plan !== json) throw new SqliteCacheError("invalidData");
    read.plan = json;
    if (plan.kind === "all") return { after: 0, done: true };
    if (!["raw", "folded"].includes(plan.column) || !Array.isArray(plan.anyOf) || !plan.anyOf.length || plan.anyOf.length > 32) throw new SqliteCacheError("invalidData");
    for (const gram of plan.anyOf) if (typeof gram !== "string" || !isSqliteFtsEligible(gram) || Array.from(gram).length !== 3) throw new SqliteCacheError("invalidData");
    const after = sqliteInteger(request.after);
    if (after !== read.lastCandidate) throw new SqliteCacheError("invalidData");
    const expression = plan.anyOf.map(gram => `${plan.column} : "${gram.replace(/"/g, '""')}"`).join(" OR ");
    const rows = read.db.prepare(`SELECT d.document_id,m.message_id FROM search_grams
      JOIN search_gram_documents d ON d.document_id=search_grams.rowid JOIN search_messages m USING(content_id)
      JOIN temp.scope s ON s.version=m.entry_version_id WHERE search_grams MATCH ? AND search_grams.rowid>?
      ORDER BY search_grams.rowid LIMIT 256`).all(expression, after);
    for (const row of rows) read.db.prepare("INSERT OR IGNORE INTO temp.candidates VALUES(?)").run(row.message_id);
    read.lastCandidate = rows.length ? sqliteInteger(rows.at(-1)!.document_id, 1) : after;
    read.allCandidates = false;
    return { after: read.lastCandidate, done: rows.length < 256 };
  }

  private messages(request: Extract<SqliteCacheRequest, { kind: "messages" }>): unknown {
    const read = this.read(request.reader, true);
    if (!Array.isArray(request.roles) || request.roles.length > 4 || request.roles.some(role => !["user", "assistant", "developer", "tool"].includes(role))
      || typeof request.tools !== "boolean") throw new SqliteCacheError("invalidData");
    return readPage(read.db, `SELECT m.message_id AS id,m.ordinal,${boundedBlob("m.metadata_json")} AS metadata,m.text_units AS units
      FROM search_messages m JOIN temp.scope s ON s.version=m.entry_version_id
      WHERE s.cache_key=? AND m.ordinal>? AND (?=1 OR m.fts_eligible=0 OR EXISTS(SELECT 1 FROM temp.candidates c WHERE c.message_id=m.message_id))
      AND (?=0 OR m.kind IN ('toolArguments','toolOutput')) AND (?=0 OR m.role IN (SELECT value FROM json_each(?)))
      ORDER BY m.ordinal LIMIT 64`, [key(request.key), sqliteInteger(request.after, -1), Number(read.allCandidates),
        Number(request.tools), request.tools ? 0 : request.roles.length, JSON.stringify(request.roles)], ["metadata"]);
  }

  private hints(request: Extract<SqliteCacheRequest, { kind: "hints" }>): unknown {
    return readPage(this.read(request.reader, true).db, `SELECT h.ordinal,${boundedBlob("h.metadata_json")} AS metadata FROM search_file_hints h
      JOIN temp.scope s ON s.version=h.entry_version_id WHERE s.cache_key=? AND h.ordinal>? ORDER BY h.ordinal LIMIT 64`,
      [key(request.key), sqliteInteger(request.after, -1)], ["metadata"]);
  }

  private close(id: string): null {
    const read = this.readers.get(handle(id));
    if (read) { this.readers.delete(id); read.db.close(); }
    return null;
  }

  private heartbeat(): null {
    const db = this.db();
    const now = Date.now();
    db.prepare("UPDATE cache_context_owners SET heartbeat=? WHERE owner_id=? AND heartbeat>=?").run(now, this.owner, now - EXPIRY_MS);
    db.prepare("UPDATE cache_operations SET heartbeat=? WHERE owner=? AND state='staging' AND heartbeat>=?").run(now, this.owner, now - EXPIRY_MS);
    return null;
  }

  private checkpoint(observe?: boolean): unknown {
    if (observe !== undefined && typeof observe !== "boolean") throw new SqliteCacheError("invalidData");
    const db = this.db();
    const row = db.prepare(observe && this.canObserveCheckpoint ? "PRAGMA wal_checkpoint(NOOP)" : "PRAGMA wal_checkpoint(PASSIVE)").get();
    const pageSize = db.prepare("PRAGMA page_size").get()?.page_size;
    if (!row || typeof row.busy !== "number" || typeof row.log !== "number" || typeof row.checkpointed !== "number"
      || row.busy < 0 || row.log < 0 || row.checkpointed < 0 || typeof pageSize !== "number" || !Number.isSafeInteger(pageSize) || pageSize <= 0) {
      throw new SqliteCacheError("walPressure");
    }
    const pendingBytes = Math.max(0, row.log - row.checkpointed) * pageSize;
    if (!Number.isSafeInteger(pendingBytes)) throw new SqliteCacheError("walPressure");
    return { busy: row.busy, pendingBytes, readers: this.readers.size };
  }

  private maintenance(): unknown {
    const db = this.db();
    return transaction(db, () => {
      const now = Date.now();
      db.prepare("DELETE FROM cache_context_owners WHERE heartbeat<?").run(now - EXPIRY_MS);
      db.prepare("UPDATE cache_operations SET state='abandoned' WHERE state='staging' AND heartbeat<?").run(now - EXPIRY_MS);
      db.prepare("DELETE FROM cache_operation_entries WHERE operation_id IN(SELECT operation_id FROM cache_operations WHERE state='abandoned')").run();
      const inactive = db.prepare(`SELECT ${boundedBlob("c.context_id")} AS context_id FROM cache_contexts c
        WHERE NOT EXISTS(SELECT 1 FROM cache_context_owners o WHERE o.context_id=c.context_id)
        AND NOT EXISTS(SELECT 1 FROM cache_operations p WHERE p.context_id=c.context_id AND p.state='staging' AND p.heartbeat>=?)
        AND (c.last_used<? OR c.context_id<>(SELECT r.context_id FROM cache_contexts r WHERE r.family=c.family
          AND NOT EXISTS(SELECT 1 FROM cache_context_owners o WHERE o.context_id=r.context_id)
          AND NOT EXISTS(SELECT 1 FROM cache_operations p WHERE p.context_id=r.context_id AND p.state='staging' AND p.heartbeat>=?)
          ORDER BY r.last_used DESC,r.context_id LIMIT 1))
        ORDER BY c.last_used DESC,c.context_id LIMIT 64`).all(now - EXPIRY_MS, now - 7 * 86400000, now - EXPIRY_MS);
      const retiredIds: string[] = [];
      let retired = 0;
      for (const row of inactive) {
        row.context_id = handle(sqliteUtf8(row.context_id));
        db.prepare("DELETE FROM cache_entries WHERE context_id=?").run(row.context_id);
        // Keep operation receipts until their unreferenced immutable versions have been collected.
        db.prepare("DELETE FROM cache_operation_entries WHERE operation_id IN(SELECT operation_id FROM cache_operations WHERE context_id=?)").run(row.context_id);
        db.prepare("UPDATE cache_operations SET state='abandoned' WHERE context_id=?").run(row.context_id);
        retiredIds.push(sqliteText(row.context_id));
        retired++;
      }
      const versions = db.prepare(`SELECT v.entry_version_id FROM cache_entry_versions v JOIN cache_operations p USING(operation_id)
        WHERE p.state<>'staging' AND NOT EXISTS(SELECT 1 FROM cache_entries e WHERE e.entry_version_id=v.entry_version_id)
        AND NOT EXISTS(SELECT 1 FROM cache_operation_entries x WHERE x.entry_version_id=v.entry_version_id) LIMIT 1`).all();
      let reclaimed = 0;
      for (const row of versions) {
        // Bound individual cleanup transactions even when one entry contains a very large transcript.
        db.prepare("DELETE FROM cache_value_chunks WHERE rowid IN(SELECT rowid FROM cache_value_chunks WHERE entry_version_id=? LIMIT 256)").run(row.entry_version_id);
        db.prepare("DELETE FROM search_messages WHERE message_id IN(SELECT message_id FROM search_messages WHERE entry_version_id=? LIMIT 256)").run(row.entry_version_id);
        // Completed content has already relinquished ownership; bound abandoned staging ownership too.
        db.prepare(`UPDATE search_contents SET staging_version=NULL WHERE content_id IN
          (SELECT content_id FROM search_contents WHERE staging_version=? LIMIT 256)`).run(row.entry_version_id);
        db.prepare("DELETE FROM search_hint_paths WHERE rowid IN(SELECT rowid FROM search_hint_paths WHERE entry_version_id=? LIMIT 256)").run(row.entry_version_id);
        if (!db.prepare("SELECT 1 FROM search_hint_paths WHERE entry_version_id=? LIMIT 1").get(row.entry_version_id)) {
          db.prepare("DELETE FROM search_file_hints WHERE rowid IN(SELECT rowid FROM search_file_hints WHERE entry_version_id=? LIMIT 256)").run(row.entry_version_id);
        }
        const remaining = db.prepare(`SELECT 1 FROM cache_value_chunks WHERE entry_version_id=? UNION ALL
          SELECT 1 FROM search_messages WHERE entry_version_id=? UNION ALL SELECT 1 FROM search_file_hints WHERE entry_version_id=?
          UNION ALL SELECT 1 FROM search_contents WHERE staging_version=? LIMIT 1`)
          .get(row.entry_version_id, row.entry_version_id, row.entry_version_id, row.entry_version_id);
        if (!remaining) { db.prepare("DELETE FROM cache_entry_versions WHERE entry_version_id=?").run(row.entry_version_id); reclaimed++; }
      }
      // All logical references, including unfinished operations, protect shared text and its FTS documents.
      const orphans = db.prepare(`SELECT c.content_id FROM search_contents c
        WHERE NOT EXISTS(SELECT 1 FROM search_messages m WHERE m.content_id=c.content_id) LIMIT 256`).all();
      let remainingDocuments = 256, remainingChunks = 256, remainingContents = 256;
      for (const orphan of orphans) {
        const documents = db.prepare("SELECT document_id FROM search_gram_documents WHERE content_id=? LIMIT ?").all(orphan.content_id, remainingDocuments);
        for (const document of documents) {
          db.prepare("DELETE FROM search_grams WHERE rowid=?").run(document.document_id);
          db.prepare("DELETE FROM search_gram_documents WHERE document_id=?").run(document.document_id);
        }
        remainingDocuments -= documents.length;
        const chunks = db.prepare("DELETE FROM search_text_chunks WHERE rowid IN(SELECT rowid FROM search_text_chunks WHERE content_id=? LIMIT ?)").run(orphan.content_id, remainingChunks);
        remainingChunks -= sqliteInteger(Number(chunks.changes), 0, 256);
        if (!db.prepare("SELECT 1 FROM search_gram_documents WHERE content_id=? UNION ALL SELECT 1 FROM search_text_chunks WHERE content_id=? LIMIT 1")
          .get(orphan.content_id, orphan.content_id)) { db.prepare("DELETE FROM search_contents WHERE content_id=?").run(orphan.content_id); remainingContents--; }
        if (remainingContents === 0) break;
      }
      db.prepare(`DELETE FROM cache_operations WHERE state<>'staging' AND NOT EXISTS
        (SELECT 1 FROM cache_entry_versions v WHERE v.operation_id=cache_operations.operation_id)`).run();
      for (const id of retiredIds) {
        db.prepare(`DELETE FROM cache_contexts WHERE context_id=? AND NOT EXISTS(SELECT 1 FROM cache_entries WHERE context_id=?)
          AND NOT EXISTS(SELECT 1 FROM cache_operations WHERE context_id=?) AND NOT EXISTS(SELECT 1 FROM cache_context_owners WHERE context_id=?)`)
          .run(id, id, id, id);
      }
      return { retired, reclaimed, more: versions.length > 0 || orphans.length > 0 || inactive.length >= 64 };
    });
  }
}

function transaction<T>(db: SqliteDatabase, run: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const value = run(); db.exec("COMMIT"); return value; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
function handle(value: unknown): string {
  const text = sqliteText(value, 80);
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(text)) throw new SqliteCacheError("invalidData");
  return text;
}
function cancellationFlag(value: unknown): Int32Array {
  if (!(value instanceof SharedArrayBuffer) || value.byteLength !== 4) throw new SqliteCacheError("invalidData");
  const flag = new Int32Array(value);
  if (![0, 1].includes(Atomics.load(flag, 0))) throw new SqliteCacheError("invalidData");
  return flag;
}
function key(value: unknown): string { return JSON.stringify(sqliteText(value)); }
function parseKey(value: unknown): string {
  try { return sqliteText(JSON.parse(sqliteText(sqliteUtf8(value), 196610))); }
  catch { throw new SqliteCacheError("invalidData"); }
}
function readPage(db: SqliteDatabase, sql: string, values: SqliteValue[], fields: readonly string[]): SqliteRow[] {
  const rows: SqliteRow[] = [];
  let bytes = 2;
  for (const row of db.prepare(sql).iterate(...values)) {
    for (const field of fields) row[field] = sqliteUtf8(row[field]);
    const size = Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
    if (size > 8 * 1048576) throw new SqliteCacheError("corrupt");
    if (rows.length && bytes + size > 1048576) break;
    rows.push(row); bytes += size;
    if (rows.length >= 256) break;
  }
  return rows;
}
const BLOB_COLUMNS: ReadonlySet<string> = new Set(["context_json", "context_id", "c.context_id", "c.text_json", "p.path_json", "e.cache_key", "v.source",
  "v.identity_key", "v.input_signature", "v.semantic_digest", "v.metadata_json", "m.metadata_json", "h.metadata_json"]);
function boundedBlob(column: string): string {
  // These identifiers are fixed at the call sites and are never supplied by a Worker request.
  if (!BLOB_COLUMNS.has(column)) throw new SqliteCacheError("invalidData");
  const limit = column === "c.text_json" ? SQLITE_STORED_TEXT_MAX_BYTES : SQLITE_CACHE_METADATA_BYTES;
  return `CASE WHEN octet_length(${column})<=${limit} THEN CAST(${column} AS BLOB) ELSE NULL END`;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new SqliteCacheError("invalidData");
  return value;
}
function jsonText(value: unknown): string {
  let text = sqliteText(value, SQLITE_CACHE_METADATA_BYTES);
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error();
    if (/[\uD800-\uDFFF]/u.test(text)) text = JSON.stringify(parsed);
  }
  catch { throw new SqliteCacheError("invalidData"); }
  if (Buffer.byteLength(text, "utf8") > SQLITE_CACHE_METADATA_BYTES) throw new SqliteCacheError("invalidData");
  return text;
}
