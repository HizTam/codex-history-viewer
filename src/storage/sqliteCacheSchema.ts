import { createHash } from "node:crypto";
import { configureSqliteConnection, loadSqliteModule, SQLITE_CACHE_FTS_OPTIONS, SqliteCacheError, type SqliteDatabase, type SqliteRow } from "./sqliteRuntime";

// Only this application's generated cache may be rebuilt in place.
export const SQLITE_CACHE_APPLICATION_ID = 0x43485633;
export const SQLITE_CACHE_SCHEMA_VERSION = 1;
const DDL = [
  `CREATE TABLE cache_contexts(
    context_id TEXT PRIMARY KEY, family TEXT NOT NULL CHECK(family IN ('history','search','analysis')),
    context_json TEXT NOT NULL, head_generation INTEGER NOT NULL DEFAULT 0, last_used INTEGER NOT NULL)`,
  `CREATE TABLE cache_context_owners(
    owner_id TEXT NOT NULL, context_id TEXT NOT NULL REFERENCES cache_contexts ON DELETE CASCADE,
    heartbeat INTEGER NOT NULL, PRIMARY KEY(owner_id, context_id))`,
  `CREATE TABLE cache_operations(
    operation_id TEXT PRIMARY KEY, owner TEXT NOT NULL, context_id TEXT NOT NULL REFERENCES cache_contexts ON DELETE CASCADE,
    base_generation INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('staging','published','abandoned')),
    heartbeat INTEGER NOT NULL)`,
  `CREATE TABLE cache_entry_versions(
    entry_version_id INTEGER PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES cache_operations,
    cache_key TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('codex','claude','antigravity','none')),
    identity_key TEXT NOT NULL, input_signature TEXT NOT NULL, semantic_digest TEXT NOT NULL,
    metadata_json TEXT NOT NULL, complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN (0,1)))`,
  `CREATE INDEX cache_versions_operation ON cache_entry_versions(operation_id)`,
  `CREATE TABLE cache_entries(
    context_id TEXT NOT NULL REFERENCES cache_contexts ON DELETE CASCADE, cache_key TEXT NOT NULL,
    entry_version_id INTEGER NOT NULL REFERENCES cache_entry_versions,
    PRIMARY KEY(context_id, cache_key))`,
  `CREATE INDEX cache_entries_version ON cache_entries(entry_version_id)`,
  `CREATE TABLE cache_operation_entries(
    operation_id TEXT NOT NULL REFERENCES cache_operations ON DELETE CASCADE, cache_key TEXT NOT NULL,
    entry_version_id INTEGER REFERENCES cache_entry_versions,
    PRIMARY KEY(operation_id, cache_key))`,
  `CREATE TABLE cache_value_chunks(
    entry_version_id INTEGER NOT NULL REFERENCES cache_entry_versions ON DELETE CASCADE,
    ordinal INTEGER NOT NULL, text_json TEXT NOT NULL, PRIMARY KEY(entry_version_id, ordinal))`,
  `CREATE TABLE search_contents(
    content_id INTEGER PRIMARY KEY, staging_version INTEGER REFERENCES cache_entry_versions ON DELETE SET NULL,
    text_units INTEGER NOT NULL, fts_eligible INTEGER NOT NULL CHECK(fts_eligible IN (0,1)),
    digest TEXT NOT NULL DEFAULT '', complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN (0,1)))`,
  `CREATE INDEX search_contents_staging ON search_contents(staging_version)`,
  `CREATE TABLE search_messages(
    message_id INTEGER PRIMARY KEY, entry_version_id INTEGER NOT NULL REFERENCES cache_entry_versions ON DELETE CASCADE,
    content_id INTEGER NOT NULL REFERENCES search_contents,
    ordinal INTEGER NOT NULL, metadata_json TEXT NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, text_units INTEGER NOT NULL,
    fts_eligible INTEGER NOT NULL CHECK(fts_eligible IN (0,1)), UNIQUE(entry_version_id, ordinal))`,
  `CREATE INDEX search_messages_content ON search_messages(content_id)`,
  `CREATE TABLE search_text_chunks(
    content_id INTEGER NOT NULL REFERENCES search_contents ON DELETE CASCADE,
    ordinal INTEGER NOT NULL, codec INTEGER NOT NULL CHECK(codec IN (0,1)), text_json BLOB NOT NULL, PRIMARY KEY(content_id, ordinal))`,
  `CREATE TABLE search_file_hints(
    entry_version_id INTEGER NOT NULL REFERENCES cache_entry_versions ON DELETE CASCADE,
    ordinal INTEGER NOT NULL, metadata_json TEXT NOT NULL, PRIMARY KEY(entry_version_id, ordinal))`,
  `CREATE TABLE search_hint_paths(
    entry_version_id INTEGER NOT NULL, hint_ordinal INTEGER NOT NULL, ordinal INTEGER NOT NULL, path_json TEXT NOT NULL,
    PRIMARY KEY(entry_version_id, hint_ordinal, ordinal),
    FOREIGN KEY(entry_version_id, hint_ordinal) REFERENCES search_file_hints(entry_version_id, ordinal) ON DELETE CASCADE)`,
  `CREATE TABLE search_gram_documents(
    document_id INTEGER PRIMARY KEY, content_id INTEGER NOT NULL REFERENCES search_contents ON DELETE CASCADE,
    column_kind TEXT NOT NULL CHECK(column_kind IN ('raw','folded')), ordinal INTEGER NOT NULL CHECK(ordinal=0),
    UNIQUE(content_id, column_kind, ordinal))`,
  `CREATE VIRTUAL TABLE search_grams USING fts5(raw, folded, ${SQLITE_CACHE_FTS_OPTIONS})`,
] as const;

function schemaRows(db: SqliteDatabase): SqliteRow[] {
  return db.prepare(`SELECT type,
    CASE WHEN octet_length(name)<=256 THEN name ELSE '' END AS name,
    CASE WHEN octet_length(tbl_name)<=256 THEN tbl_name ELSE '' END AS tbl_name,
    CASE WHEN octet_length(sql)<=65536 THEN sql ELSE NULL END AS sql
    FROM sqlite_schema ORDER BY name LIMIT 128`).all();
}
let expectedSchema: SqliteRow[] | undefined;
function getExpectedSchema(): SqliteRow[] {
  if (expectedSchema) return expectedSchema;
  const db = new (loadSqliteModule().DatabaseSync)(":memory:", { allowExtension: false });
  try {
    configureSqliteConnection(db);
    for (const sql of DDL) db.exec(sql);
    return expectedSchema = schemaRows(db);
  } finally { db.close(); }
}

export function readSqliteCacheSchemaState(db: SqliteDatabase): { current: boolean; empty: boolean } {
  db.exec("BEGIN");
  try {
    const state = inspectSchema(db);
    db.exec("COMMIT");
    return state;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function inspectSchema(db: SqliteDatabase): { current: boolean; empty: boolean } {
  const applicationId = db.prepare("PRAGMA application_id").get()?.application_id;
  const existing = schemaRows(db);
  if ((applicationId !== 0 || existing.length > 0) && applicationId !== SQLITE_CACHE_APPLICATION_ID) {
    throw new SqliteCacheError("foreignDatabase");
  }
  if (existing.length > 0 && db.prepare("PRAGMA encoding").get()?.encoding !== "UTF-8") throw new SqliteCacheError("schema");
  const expected = getExpectedSchema();
  const allowed = new Map(expected.map(row => [row.name, row]));
  if (existing.some(row => !allowed.has(row.name) || allowed.get(row.name)?.type !== row.type
    || allowed.get(row.name)?.tbl_name !== row.tbl_name)) throw new SqliteCacheError("foreignDatabase");
  return {
    current: JSON.stringify(existing) === JSON.stringify(expected)
      && db.prepare("PRAGMA user_version").get()?.user_version === SQLITE_CACHE_SCHEMA_VERSION,
    empty: existing.length === 0,
  };
}

export function initializeSqliteCacheSchema(db: SqliteDatabase): void {
  if (readSqliteCacheSchemaState(db).current) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    // Another Worker can have initialized and populated the cache before acquiring this transaction.
    const schema = inspectSchema(db);
    if (schema.current) {
      db.exec("COMMIT");
      return;
    }
    if (schema.empty) db.exec("PRAGMA encoding='UTF-8'");
    if (db.prepare("PRAGMA encoding").get()?.encoding !== "UTF-8") throw new SqliteCacheError("schema");
    db.exec(`PRAGMA application_id=${SQLITE_CACHE_APPLICATION_ID}`);
    // Foreign keys stay enabled; children are removed before their parents.
    for (const name of ["search_grams", "search_gram_documents", "search_hint_paths", "search_file_hints", "search_text_chunks",
      "search_messages", "search_contents", "cache_value_chunks", "cache_entries", "cache_operation_entries", "cache_entry_versions", "cache_operations", "cache_context_owners", "cache_contexts"]) {
      db.exec(`DROP TABLE IF EXISTS ${name}`);
    }
    for (const sql of DDL) db.exec(sql);
    db.exec(`PRAGMA user_version=${SQLITE_CACHE_SCHEMA_VERSION}; COMMIT`);
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function sqliteContextIdentity(family: string, contextJson: string): string {
  return createHash("sha256").update(family).update("\0").update(contextJson).digest("hex");
}

export function validateSqliteCacheSchema(db: SqliteDatabase): void {
  if (db.prepare("PRAGMA application_id").get()?.application_id !== SQLITE_CACHE_APPLICATION_ID
    || db.prepare("PRAGMA user_version").get()?.user_version !== SQLITE_CACHE_SCHEMA_VERSION
    || JSON.stringify(schemaRows(db)) !== JSON.stringify(getExpectedSchema())) throw new SqliteCacheError("schema");
}
