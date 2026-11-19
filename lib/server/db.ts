/**
 * The document store.
 *
 * Three engines, one API.
 *
 * **PostgreSQL** is the Dokploy production engine: JSONB documents, transactional
 * row writes, database-enforced global ownership and cross-process versioning.
 *
 * **SQLite** remains the local/single-node engine: documents
 * live in a `docs(collection, id, body)` table, each write is a transaction, and a
 * change costs one row instead of rewriting the whole file. That matters because
 * the previous engine serialised the entire store on every flush — 115 ms of
 * `JSON.stringify` plus 80 ms of I/O at 25 MB, synchronously, on every batched
 * write, growing linearly forever. The write path was the single thing standing
 * between this being a pilot and being a service.
 *
 * **JSON** (`VOXERA_STORE=json`) is the engine this product shipped with and is
 * kept for one reason: it is the migration source and the fallback if the native
 * module is unavailable in some deployment. It is fully functional and every gate
 * still passes against it.
 *
 * Both engines put the same in-memory cache in front of the file, and both keep
 * the same read semantics — `list()` in insertion order, newest first, because
 * callers rely on it. What differs is what a flush writes: the JSON engine
 * rewrites everything, SQLite writes the rows that changed.
 *
 * Server-only: importing this from a client component would pull `node:fs` and
 * `better-sqlite3` into the browser bundle, so every caller is a route handler.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from './paths';
import { closeSharedPostgres, dedicatedPostgresClient, pgQuery, pgTransaction } from './postgres';
import { runPostgresSchemaMigrations, runSqliteSchemaMigrations } from './schema-migrations';
import { assertDestructiveMaintenanceCapability } from './maintenance-replace';

const DATA_DIR = dataDir();
const DB_PATH = path.join(DATA_DIR, 'voxera-db.json');
const SQLITE_PATH = path.join(DATA_DIR, 'voxera-db.sqlite');

/** Which engine. Production sets this explicitly; local development defaults to SQLite. */
type StoreEngine = 'postgres' | 'sqlite' | 'json';
const configuredEngine = process.env.VOXERA_STORE?.trim().toLowerCase();
let engine: StoreEngine = configuredEngine === 'postgres' ? 'postgres' : configuredEngine === 'json' ? 'json' : 'sqlite';

export type Doc = { id: string; createdAt?: string; updatedAt?: string } & Record<string, unknown>;

type DbShape = {
  version: number;
  collections: Record<string, Doc[]>;
};

/**
 * The in-memory cache: one array per collection, in the order `list()` returns.
 *
 * This replaces the old whole-database object because the SQLite engine loads a
 * collection the first time it is asked for. The JSON engine fills every
 * collection at once from the file, so for it the two behave identically.
 */
let cache: Map<string, Doc[]> | null = null;
let writeTimer: NodeJS.Timeout | null = null;
/** Rows that changed since the last flush, so a flush writes only those. */
const pending = new Map<string, Set<string>>();
/** Rows deleted since the last flush. */
const pendingDeletes = new Map<string, Set<string>>();
/** SQLite only: the `data_version` we last saw, to notice other processes. */
let lastDataVersion = 0;
/** PostgreSQL: deployment-global change generation and bounded poll time. */
let lastPostgresVersion = -1;
let lastPostgresVersionCheck = 0;
/** SQLite only: the opened handle. */
let handle: { exec(sql: string): unknown; prepare(sql: string): any; transaction<T>(fn: () => T): () => T; pragma(sql: string, opts?: { simple?: boolean }): unknown; close(): void } | null = null;
/** Identity of the file we last read or wrote, so we notice other writers. */
let stamp: string | null = null;
/**
 * Documents we have deleted since the last flush, per collection.
 *
 * A merge-on-write store needs a record of *removals*: without it, re-reading
 * the file before a write would resurrect everything this process deleted.
 * Cleared whenever we reload from disk (at that point disk is the whole truth).
 */
const tombstones = new Map<string, Set<string>>();

function tombstone(collection: string, id: string) {
  const set = tombstones.get(collection) ?? new Set<string>();
  set.add(id);
  tombstones.set(collection, set);
}

/* -------------------------------------------------------------- postgres --- */

let postgresReady = false;

export function ensurePostgresSchema() {
  if (postgresReady) return;
  // DDL is idempotent, and the advisory lock keeps two containers in a rolling
  // deployment from attempting the same migration concurrently.
  pgQuery("SELECT pg_advisory_lock(hashtext('voxera:schema'))");
  try {
    const migrations = [
      `CREATE TABLE IF NOT EXISTS voxera_docs (
        seq BIGSERIAL PRIMARY KEY,
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        body JSONB NOT NULL,
        UNIQUE (collection, id)
      )`,
      `CREATE TABLE IF NOT EXISTS voxera_meta (
        key TEXT PRIMARY KEY,
        value BIGINT NOT NULL
      )`,
      `INSERT INTO voxera_meta (key, value) VALUES ('data_version', 0)
        ON CONFLICT (key) DO NOTHING`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_collection_age
        ON voxera_docs (collection, seq DESC)`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_org_collection_age
        ON voxera_docs (collection, (body ->> 'orgId'), seq DESC)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS voxera_docs_unique_carrier_number
        ON voxera_docs ((body ->> 'number'))
        WHERE collection = 'numbers'
          AND body ? 'carrierSid'
          AND COALESCE(body ->> 'status', 'active') <> 'released'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS voxera_docs_unique_pending_number_claim
        ON voxera_docs ((body ->> 'number'))
        WHERE collection = 'numberClaims'`,
    ];
    for (const migration of migrations) pgQuery(migration);
    runPostgresSchemaMigrations({
      query: (sql, values = []) => pgQuery(sql, values),
      transaction: (work) => pgTransaction(work),
    });
  } finally {
    pgQuery("SELECT pg_advisory_unlock(hashtext('voxera:schema'))");
  }
  const row = pgQuery<{ value: string | number }>("SELECT value::text AS value FROM voxera_meta WHERE key = 'data_version'")[0];
  lastPostgresVersion = Number(row?.value ?? 0);
  lastPostgresVersionCheck = Date.now();
  postgresReady = true;
}

function postgresVersion(): number {
  ensurePostgresSchema();
  const row = pgQuery<{ value: string | number }>("SELECT value::text AS value FROM voxera_meta WHERE key = 'data_version'")[0];
  return Number(row?.value ?? 0);
}

function bumpPostgresVersion(): number {
  const row = pgQuery<{ value: string | number }>(
    "UPDATE voxera_meta SET value = value + 1 WHERE key = 'data_version' RETURNING value::text AS value"
  )[0];
  return Number(row?.value ?? lastPostgresVersion + 1);
}

function docBody(value: unknown): Doc {
  if (typeof value === 'string') return JSON.parse(value) as Doc;
  if (value && typeof value === 'object') return value as Doc;
  throw new Error('PostgreSQL returned an invalid document body');
}

function insertPostgresRows(rows: Array<{ collection: string; id: string; body: string }>) {
  const batchSize = 250;
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const values: Array<string> = [];
    const placeholders = batch.map((row, index) => {
      const base = index * 3;
      values.push(row.collection, row.id, row.body);
      return `($${base + 1}, $${base + 2}, $${base + 3}::jsonb)`;
    });
    pgQuery(
      `INSERT INTO voxera_docs (collection, id, body) VALUES ${placeholders.join(', ')}
       ON CONFLICT (collection, id) DO UPDATE SET body = EXCLUDED.body`,
      values
    );
  }
}

export function postgresCollectionStats(): Record<string, number> {
  ensurePostgresSchema();
  const rows = pgQuery<{ collection: string; n: string | number }>('SELECT collection, COUNT(*)::text AS n FROM voxera_docs GROUP BY collection');
  return Object.fromEntries(rows.map((row) => [row.collection, Number(row.n)]));
}

export function dumpPostgresAll(): { collections: Record<string, Doc[]> } {
  ensurePostgresSchema();
  const rows = pgQuery<{ collection: string; body: unknown }>('SELECT collection, body FROM voxera_docs ORDER BY collection, seq DESC');
  const collections: Record<string, Doc[]> = {};
  for (const row of rows) (collections[row.collection] ??= []).push(docBody(row.body));
  return { collections };
}

/** Destructive target-side import used only by the explicit migration tool. */
export function replacePostgresFromDump(
  next: { collections: Record<string, Doc[]> },
  allowReplace = false,
  maintenanceCapability?: unknown,
): Record<string, number> {
  ensurePostgresSchema();
  const existing = pgQuery<{ n: string | number }>('SELECT COUNT(*)::text AS n FROM voxera_docs')[0];
  const replacingExisting = Number(existing?.n ?? 0) > 0;
  if (replacingExisting && !allowReplace) {
    throw new Error('PostgreSQL target is not empty; refusing to replace it without explicit confirmation');
  }
  if (replacingExisting) assertDestructiveMaintenanceCapability(maintenanceCapability);
  pgTransaction(() => {
    if (replacingExisting) pgQuery("SELECT set_config('voxera.allow_immutable_maintenance', 'on', true)");
    pgQuery('DELETE FROM voxera_docs');
    const rows: Array<{ collection: string; id: string; body: string }> = [];
    for (const [collection, docs] of Object.entries(next.collections)) {
      for (let index = docs.length - 1; index >= 0; index -= 1) {
        const doc = docs[index];
        rows.push({ collection, id: doc.id, body: JSON.stringify(doc) });
      }
    }
    insertPostgresRows(rows);
    bumpPostgresVersion();
  });
  return postgresCollectionStats();
}

function flushPostgres(options?: { replace?: boolean; maintenanceCapability?: unknown }) {
  ensurePostgresSchema();
  const map = cache ?? load();
  let version = lastPostgresVersion;
  pgTransaction(() => {
    if (options?.replace) {
      pgQuery("SELECT set_config('voxera.allow_immutable_maintenance', 'on', true)");
      pgQuery('DELETE FROM voxera_docs');
      const rows: Array<{ collection: string; id: string; body: string }> = [];
      for (const [collection, docs] of map) {
        // Oldest first gives the newest document the highest immutable sequence.
        for (let index = docs.length - 1; index >= 0; index -= 1) {
          const doc = docs[index];
          rows.push({ collection, id: doc.id, body: JSON.stringify(doc) });
        }
      }
      insertPostgresRows(rows);
    } else {
      for (const [collection, ids] of pendingDeletes) {
        for (const id of ids) pgQuery('DELETE FROM voxera_docs WHERE collection = $1 AND id = $2', [collection, id]);
      }
      const rows: Array<{ collection: string; id: string; body: string }> = [];
      for (const [collection, ids] of pending) {
        const docs = map.get(collection) ?? [];
        for (const id of ids) {
          const doc = docs.find((candidate) => candidate.id === id);
          if (doc) rows.push({ collection, id, body: JSON.stringify(doc) });
        }
      }
      insertPostgresRows(rows);
    }
    version = bumpPostgresVersion();
  });

  pending.clear();
  pendingDeletes.clear();
  tombstones.clear();
  lastPostgresVersion = version;
  lastPostgresVersionCheck = Date.now();
  if (process.env.VOXERA_STORE_AUDIT === '1') auditAgainstDisk(map);
}

/* ---------------------------------------------------------------- sqlite --- */

/**
 * Open the database, create the schema, and hand over the JSON store if this is
 * the first boot after the upgrade.
 *
 * `better-sqlite3` is synchronous, which is exactly why it was chosen: every
 * caller of this module is already synchronous, and an async engine would have
 * meant rewriting four hundred call sites. The cost is that a slow query blocks
 * the event loop — bounded here because every query is either a primary-key hit
 * or a scan of one collection this process already asked for.
 */
function sqlite(): NonNullable<typeof handle> {
  if (handle) return handle;
  // Required lazily so `VOXERA_STORE=json` works on a box where the native module
  // was never built — and so this file still loads in an environment without it.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require('better-sqlite3') as typeof import('better-sqlite3');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(SQLITE_PATH);

  /**
   * WAL, and FULL sync.
   *
   * WAL lets the media worker read while the request path writes — the two module
   * graphs behave like two processes, and the old file store needed a lock file
   * precisely so they would not lose each other's writes. FULL instead of NORMAL
   * because durability is the whole point of this change: a committed write
   * survives the machine losing power, at the cost of one fsync per flush (not
   * per statement — flushes are batched into a transaction).
   */
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs (
      collection TEXT NOT NULL,
      id         TEXT NOT NULL,
      pos        INTEGER NOT NULL,
      body       TEXT NOT NULL,
      PRIMARY KEY (collection, id)
    );
    CREATE INDEX IF NOT EXISTS docs_by_collection ON docs (collection, pos);
    -- Carrier-backed E.164 numbers route inbound calls to a tenant. Enforce one
    -- active owner at the storage layer as well as in route validation so two
    -- concurrent purchases cannot create an ambiguous tenant mapping.
    CREATE UNIQUE INDEX IF NOT EXISTS docs_unique_carrier_number
      ON docs (json_extract(body, '$.number'))
      WHERE collection = 'numbers'
        AND json_extract(body, '$.carrierSid') IS NOT NULL
        AND COALESCE(json_extract(body, '$.status'), 'active') != 'released';
  `);
  migrateToAgeOrder(db);
  // `migrateToAgeOrder` replaces the table on an old store, so partial indexes
  // are asserted again afterwards. `numberClaims` is a short-lived reservation
  // collection: it closes the async carrier-call race before external webhook
  // wiring is changed or a number is purchased.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS docs_unique_carrier_number
      ON docs (json_extract(body, '$.number'))
      WHERE collection = 'numbers'
        AND json_extract(body, '$.carrierSid') IS NOT NULL
        AND COALESCE(json_extract(body, '$.status'), 'active') != 'released';
    CREATE UNIQUE INDEX IF NOT EXISTS docs_unique_pending_number_claim
      ON docs (json_extract(body, '$.number'))
      WHERE collection = 'numberClaims';
  `);
  runSqliteSchemaMigrations(db);

  handle = db as unknown as NonNullable<typeof handle>;
  lastDataVersion = Number(db.pragma('data_version', { simple: true }));
  importJsonIfPresent(db);
  return handle;
}

/** The JSON store, if this is the first boot on the new engine. */
function importJsonIfPresent(db: import('better-sqlite3').Database) {
  const existing = (db.prepare('SELECT COUNT(*) AS n FROM docs').get() as { n: number }).n;
  if (existing > 0 || !fs.existsSync(DB_PATH)) return;

  let parsed: DbShape;
  try {
    parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) as DbShape;
  } catch (error) {
    /**
     * A corrupt file must not be mistaken for an empty one.
     *
     * Importing nothing would serve a blank practice and then never notice; the
     * old file would sit there until something overwrote it. Refusing to start,
     * with the path in the message, keeps the data and makes the problem a
     * decision a person makes on purpose.
     */
    throw new Error(
      `the JSON store at ${DB_PATH} could not be parsed (${error instanceof Error ? error.message : error}); ` +
        'refusing to start so it is not overwritten. Move it aside to start with an empty store.'
    );
  }

  const insertRow = db.prepare('INSERT INTO docs (collection, id, pos, body) VALUES (?, ?, ?, ?)');
  let rows = 0;
  db.transaction(() => {
    for (const [collection, docs] of Object.entries(parsed.collections ?? {})) {
      // The file is newest-first; importing it reversed gives the oldest
      // row the lowest rowid, so `ORDER BY seq DESC` — the order every
      // reader uses — is newest-first, as the cache contract promises.
      for (let index = docs.length - 1; index >= 0; index -= 1) {
        const doc = docs[index];
        insertRow.run(collection, String(doc.id), docs.length - 1 - index, JSON.stringify(doc));
        rows += 1;
      }
    }
  })();

  // Keep the old file out of the way, under the name a restore would expect.
  try {
    const stamped = path.join(DATA_DIR, 'backups', `voxera-db.migrated-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.mkdirSync(path.dirname(stamped), { recursive: true });
    fs.renameSync(DB_PATH, stamped);
    console.log(`  store        : imported ${rows} documents into SQLite; the JSON file was moved to ${path.relative(process.cwd(), stamped)}`);
  } catch {
    console.log(`  store        : imported ${rows} documents into SQLite (could not move ${DB_PATH} aside)`);
  }
}

/**
 * One-time migration: give every row an explicit, immutable age order.
 *
 * Reads order by `seq` because `pos` cannot carry that meaning — it is
 * rewritten for the dirty rows only, so most rows hold a stale cache
 * index and ordering by it is not an ordering at all (1,656 audit rows
 * once shared pos 0). The table's implicit rowid would work, but it
 * cannot be indexed and cannot be named in a schema a reader can rely
 * on, so it is promoted to a real column.
 *
 * The copy preserves the old rowid order, which is insertion order, so
 * the migrated store keeps the age order it already had. The whole
 * migration is one transaction: it either completes or the store is
 * exactly as it was.
 */
function migrateToAgeOrder(db: import('better-sqlite3').Database) {
  const columns = db.prepare('PRAGMA table_info(docs)').all() as { name: string }[];
  if (columns.some((c) => c.name === 'seq')) return;

  console.log('  store        : adding the age-order column (one pass over the store)…');
  db.transaction(() => {
    db.exec(`
      DROP INDEX IF EXISTS docs_by_collection;
      ALTER TABLE docs RENAME TO docs_pre_age;
      CREATE TABLE docs (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        collection TEXT NOT NULL,
        id         TEXT NOT NULL,
        pos        INTEGER NOT NULL,
        body       TEXT NOT NULL,
        UNIQUE (collection, id)
      );
      CREATE INDEX docs_by_collection ON docs (collection, pos);
      CREATE INDEX docs_by_collection_age ON docs (collection, seq);
      INSERT INTO docs (collection, id, pos, body)
        SELECT collection, id, pos, body FROM docs_pre_age ORDER BY rowid;
      DROP TABLE docs_pre_age;
    `);
  })();
  const migrated = db.prepare('SELECT COUNT(*) AS n FROM docs').get() as { n: number };
  console.log(`  store        : age order in place over ${migrated.n} rows`);
}

/** Has another connection — the media worker, or a second process — committed? */
function foreignWriteHappened() {
  if (engine === 'postgres') {
    // Production defaults to a version check before every cached read so a
    // request routed to another node cannot observe a committed foreign write
    // through a local stale bucket. Operators may explicitly trade freshness
    // for a bounded poll interval, while conflict paths still invalidate below.
    const interval = Math.max(0, Math.min(5_000, Number(process.env.VOXERA_POSTGRES_CACHE_POLL_MS ?? 0) || 0));
    if (lastPostgresVersion >= 0 && Date.now() - lastPostgresVersionCheck < interval) return false;
    const now = postgresVersion();
    lastPostgresVersionCheck = Date.now();
    if (now === lastPostgresVersion) return false;
    lastPostgresVersion = now;
    return true;
  }
  const now = Number(sqlite().pragma('data_version', { simple: true }));
  if (now === lastDataVersion) return false;
  lastDataVersion = now;
  return true;
}

/* ------------------------------------------------------------------- json --- */

function emptyDb(): DbShape {
  return { version: 1, collections: {} };
}

/**
 * Cheap fingerprint of the file on disk.
 *
 * The JSON engine is served by a custom server, so `lib/server/*` is loaded twice:
 * once inside the Next bundle and once by the media worker's own module graph.
 * Both hold a cache of this same file, so a stale cache would silently undo the
 * other side's writes. Comparing the file's mtime and size before serving a read
 * keeps the two in step without a database server.
 */
function fingerprint(): string | null {
  try {
    const s = fs.statSync(DB_PATH);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return null;
  }
}

function readFromDisk(): DbShape | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) as DbShape;
    return { version: parsed.version ?? 1, collections: parsed.collections ?? {} };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------- the cache --- */

/** Fill the cache. The JSON engine fills every collection at once; SQLite is lazy. */
function load(): Map<string, Doc[]> {
  if (cache) return cache;
  cache = new Map();
  if (engine === 'json') {
    const disk = readFromDisk() ?? emptyDb();
    for (const [name, docs] of Object.entries(disk.collections)) cache.set(name, docs);
    stamp = fingerprint();
  }
  return cache;
}

function bucket(name: string): Doc[] {
  const map = load();
  if (map.has(name)) return map.get(name)!;

  if (engine === 'json') {
    map.set(name, []);
    return map.get(name)!;
  }

  if (engine === 'postgres') {
    ensurePostgresSchema();
    const rows = pgQuery<{ body: unknown }>('SELECT body FROM voxera_docs WHERE collection = $1 ORDER BY seq DESC', [name]);
    map.set(name, rows.map((row) => docBody(row.body)));
    return map.get(name)!;
  }

  const rows = sqlite().prepare('SELECT body FROM docs WHERE collection = ? ORDER BY seq DESC').all(name) as { body: string }[];
  map.set(name, rows.map((row) => JSON.parse(row.body) as Doc));
  return map.get(name)!;
}

/* ---------------------------------------------------------------- writing --- */

/**
 * A short, synchronous sleep.
 *
 * `flush()` is deliberately synchronous — it is called from request handlers and
 * from `flushNow()` after a write — so waiting for the file lock must not spin
 * the CPU or the event loop. `Atomics.wait` on a throwaway buffer blocks just
 * this thread for the given milliseconds, which is exactly the primitive needed.
 */
function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const LOCK_PATH = `${DB_PATH}.lock`;
const LOCK_STALE_MS = 5000;
const LOCK_WAIT_MS = 1500;

/**
 * Runs `fn` while holding an exclusive lock file. The JSON engine only.
 *
 * Merging before writing shrinks the lost-write window but cannot close it: two
 * processes can still both read the file, then both write, and the second write
 * replaces the first. The race check caught that (roughly one run in three)
 * after the merge landed. An `O_EXCL` lock file makes read-merge-write atomic
 * across processes — the same trick the store already uses for its temp file.
 *
 * A process that dies holding the lock would wedge the store, so a lock older
 * than `LOCK_STALE_MS` is treated as abandoned and taken over. If the lock can
 * not be had within `LOCK_WAIT_MS` the write proceeds anyway: a slightly racy
 * write beats a request that never returns.
 */
function withFileLock<T>(fn: () => T, options: { required?: boolean; waitMs?: number } = {}): T {
  const deadline = Date.now() + (options.waitMs ?? LOCK_WAIT_MS);
  let held = false;
  while (!held) {
    try {
      const fd = fs.openSync(LOCK_PATH, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      held = true;
    } catch {
      try {
        if (Date.now() - fs.statSync(LOCK_PATH).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(LOCK_PATH, { force: true });
          continue;
        }
      } catch {
        // The lock vanished between open and stat — try again immediately.
        continue;
      }
      if (Date.now() >= deadline) break;
      sleepSync(3);
    }
  }
  if (!held && options.required) throw new Error(`could not acquire the store lock within ${options.waitMs ?? LOCK_WAIT_MS}ms`);
  try {
    return fn();
  } finally {
    if (held) {
      try {
        fs.rmSync(LOCK_PATH, { force: true });
      } catch {
        /* already gone */
      }
    }
  }
}

/** Merge the file on disk with our pending state. The JSON engine only. */
function mergeWithDisk(disk: DbShape, mine: DbShape): DbShape {
  const merged: DbShape = { version: mine.version, collections: {} };
  const names = new Set([...Object.keys(mine.collections), ...Object.keys(disk.collections)]);
  for (const name of names) {
    const mineDocs = mine.collections[name] ?? [];
    const removed = tombstones.get(name);
    const diskById = new Map<string, Doc>();
    for (const d of disk.collections[name] ?? []) diskById.set(d.id, d);

    const seen = new Set<string>();
    const mergedDocs: Doc[] = [];
    for (const doc of mineDocs) {
      if (removed?.has(doc.id)) continue;
      const other = diskById.get(doc.id);
      seen.add(doc.id);
      if (!other) {
        mergedDocs.push(doc);
        continue;
      }
      const ours = Date.parse(doc.updatedAt ?? doc.createdAt ?? '') || 0;
      const theirs = Date.parse(other.updatedAt ?? other.createdAt ?? '') || 0;
      mergedDocs.push(ours >= theirs ? doc : other);
    }
    for (const [id, doc] of diskById) {
      if (seen.has(id) || removed?.has(id)) continue;
      mergedDocs.push(doc);
    }
    merged.collections[name] = mergedDocs;
  }
  return merged;
}

function asShape(map: Map<string, Doc[]>): DbShape {
  return { version: 1, collections: Object.fromEntries(map) };
}

/** Write a fully resolved JSON-store shape while the caller holds `withFileLock`. */
function writeJsonShapeDurably(db: DbShape) {
  assertGlobalNumberUniqueness(db);
  const tmp = `${DB_PATH}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(db));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, DB_PATH);
  try {
    const dir = fs.openSync(/* turbopackIgnore: true */ DATA_DIR, 'r');
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
  } catch {
    // Some filesystems do not permit directory fsync; the file itself is durable.
  }
  cache = new Map(Object.entries(db.collections));
  tombstones.clear();
  pending.clear();
  pendingDeletes.clear();
  stamp = fingerprint();
}

/** JSON fallback equivalent of the database partial unique indexes. */
function assertGlobalNumberUniqueness(shape: DbShape) {
  const uniqueNumber = (rows: Doc[], include: (row: Doc) => boolean, label: string) => {
    const seen = new Set<string>();
    for (const row of rows) {
      if (!include(row)) continue;
      const number = String(row.number ?? '').replace(/[^\d+]/g, '');
      if (!number) continue;
      if (seen.has(number)) throw new Error(`${label}: ${number} already has an active owner`);
      seen.add(number);
    }
  };
  const uniqueField = (rows: Doc[], key: string, label: string) => {
    const seen = new Set<string>();
    for (const row of rows) {
      const value = String(row[key] ?? '').trim();
      if (!value) continue;
      if (seen.has(value)) throw new Error(`${label}: duplicate ${key}`);
      seen.add(value);
    }
  };
  uniqueNumber(shape.collections.numberClaims ?? [], () => true, 'pending number claim conflict');
  uniqueNumber(
    shape.collections.numbers ?? [],
    (row) => row.carrierSid != null && row.status !== 'released',
    'carrier number conflict',
  );
  uniqueField(shape.collections.referralForms ?? [], 'slug', 'public referral address conflict');
  uniqueField(shape.collections.referralFormSubmissions ?? [], 'tokenHash', 'public referral token conflict');
  uniqueField(
    (shape.collections.referrals ?? []).filter((row) => Boolean(row.referralFormSubmissionId)),
    'referralFormSubmissionId',
    'public referral submission conflict',
  );
}

/**
 * One flush.
 *
 * SQLite: a single transaction containing only the rows that changed, so the cost
 * of a write is proportional to the write rather than to the size of the
 * practice. JSON: the old whole-file replace, fsynced and unindented.
 */
function flush(options?: { replace?: boolean; maintenanceCapability?: unknown }) {
  if (options?.replace) assertDestructiveMaintenanceCapability(options.maintenanceCapability);
  if (engine === 'json') return flushJson(options);
  if (engine === 'postgres') return flushPostgres(options);

  const db = sqlite();
  const map = cache ?? load();

  db.transaction(() => {
    /**
     * An upsert, not a replace.
     *
     * `INSERT OR REPLACE` deletes and re-inserts, which assigns the row a
     * fresh rowid — and rowid is the collection's age order, so every
     * edit would jump to the top of the feed. `ON CONFLICT DO UPDATE`
     * keeps the row where it was born.
     */
    const upsert = db.prepare(
      'INSERT INTO docs (collection, id, pos, body) VALUES (?, ?, ?, ?) ON CONFLICT(collection, id) DO UPDATE SET pos = excluded.pos, body = excluded.body'
    );

    /**
     * A replace writes the whole cache, not the pending list.
     *
     * This was the bug that emptied the store once: `replaceAll()` sets the cache
     * and clears `pending`, so replacing with `DELETE FROM docs` plus "write the
     * pending ids" left a table with nothing in it — a delete and an empty list.
     * A replace means *the cache is now the state*, so every document in it goes
     * down, and the dirty tracking is irrelevant for that write.
     *
     * The cache is newest-first and rowid is the age order, so the rows go
     * down oldest-first: the newest document leaves with the highest rowid,
     * and `ORDER BY seq DESC` reads the cache's own order back.
     */
    if (options?.replace) {
      // This flag lives in the same transaction as the replacement. A crash or
      // thrown insert rolls it back to zero, so immutable guards cannot remain
      // accidentally disabled for the next request or process.
      db.prepare('UPDATE voxera_maintenance_state SET allow_immutable_mutation = 1 WHERE id = 1').run();
      db.prepare('DELETE FROM docs').run();
      for (const [collection, docs] of map) {
        for (let index = docs.length - 1; index >= 0; index -= 1) {
          upsert.run(collection, docs[index].id, index, JSON.stringify(docs[index]));
        }
      }
      db.prepare('UPDATE voxera_maintenance_state SET allow_immutable_mutation = 0 WHERE id = 1').run();
      return;
    }

    const drop = db.prepare('DELETE FROM docs WHERE collection = ? AND id = ?');

    for (const [collection, ids] of pendingDeletes) {
      for (const id of ids) drop.run(collection, id);
    }
    for (const [collection, ids] of pending) {
      const docs = map.get(collection) ?? [];
      // `pos` is the row's place in the cached array, which is the order `list()`
      // returns. `insert()` puts new documents at the front, so the first write
      // after a restart renumbers that collection — once, and never again.
      const positions = new Map<string, number>();
      docs.forEach((doc, index) => positions.set(doc.id, index));
      for (const id of ids) {
        const doc = docs.find((d) => d.id === id);
        if (!doc) continue;
        upsert.run(collection, id, positions.get(id) ?? 0, JSON.stringify(doc));
      }
    }
  })();

  pending.clear();
  pendingDeletes.clear();
  tombstones.clear();
  // Do not sample data_version after our own commit. SQLite does not advance it
  // for writes made through this connection, and sampling here can consume a
  // concurrent node's generation while this process still holds stale buckets.

  if (process.env.VOXERA_STORE_AUDIT === '1') auditAgainstDisk(map);
}

/**
 * Prove that the cache and the database agree.
 *
 * Off by default; run with `VOXERA_STORE_AUDIT=1` to check the one assumption the
 * SQLite engine makes — that every change to a document goes through `insert`,
 * `update` or `remove`, so the dirty-id tracking cannot miss an in-place edit.
 * A mutation that never called `update()` would be silently unpersisted, and this
 * catches it instead of letting a user discover it.
 */
function auditAgainstDisk(map: Map<string, Doc[]>) {
  /**
   * Only the collections this process has loaded.
   *
   * The cache is lazy: a collection nobody has read is not in memory, and it is
   * not supposed to be. Comparing the whole table against the cache reported 1,095
   * "on disk but not in memory" rows on the first run — every one of them a
   * collection that simply had not been asked for yet. The question this audit can
   * actually answer is narrower, and is the one that matters: *of the documents
   * this process is holding, did any change without being marked dirty?*
   */
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
  };
  const sqliteSelect = engine === 'sqlite' ? sqlite().prepare('SELECT id, body FROM docs WHERE collection = ?') : undefined;
  const problems: string[] = [];
  for (const [collection, docs] of map) {
    const seen = new Map<string, string>();
    const rows = engine === 'postgres'
      ? pgQuery<{ id: string; body: unknown }>('SELECT id, body FROM voxera_docs WHERE collection = $1', [collection]).map((row) => ({ id: row.id, body: canonical(docBody(row.body)) }))
      : (sqliteSelect!.all(collection) as { id: string; body: string }[]).map((row) => ({ id: row.id, body: canonical(JSON.parse(row.body)) }));
    for (const row of rows) seen.set(row.id, row.body);
    for (const doc of docs) {
      const written = seen.get(doc.id);
      if (!written) problems.push(`${collection}/${doc.id} is in memory but not on disk`);
      else if (written !== canonical(doc)) problems.push(`${collection}/${doc.id} changed but was never marked dirty`);
      seen.delete(doc.id);
    }
    for (const id of seen.keys()) problems.push(`${collection}/${id} is on disk but not in memory`);
  }
  if (problems.length) {
    console.error(`[db] store audit found ${problems.length} disagreement(s) — something changed a document without update():`);
    for (const problem of problems.slice(0, 20)) console.error(`  ${problem}`);
  }
}

function flushJson(options?: { replace?: boolean }) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const mine = asShape(cache ?? load());
  withFileLock(() => {
    // Another writer may have appended since our last read; fold their docs in
    // before we replace the file, so our flush cannot undo their work.
    // `replace` (reset workspace) is the deliberate exception: it means this file,
    // and nothing else, is the state.
    const onDisk = fingerprint() !== stamp && !options?.replace ? readFromDisk() : null;
    const db = onDisk ? mergeWithDisk(onDisk, mine) : mine;
    /**
     * Durable replace, and compact. The helper fsyncs the file and, where the
     * filesystem permits it, the containing directory before publishing cache
     * state.
     */
    writeJsonShapeDurably(db);
  });
}

/** Writes are batched to the next tick so a burst of edits is one transaction. */
function persist() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      flush();
    } catch (err) {
      console.error('[db] write failed', err);
    }
  }, 25);
}

/** Marks a row as changed, so a flush writes only it. */
function mark(collection: string, id: string) {
  const set = pending.get(collection) ?? new Set<string>();
  set.add(id);
  pending.set(collection, set);
}

function unmark(map: Map<string, Set<string>>, collection: string, id: string) {
  const set = map.get(collection);
  if (!set) return;
  set.delete(id);
  if (set.size === 0) map.delete(collection);
}

function markDeleted(collection: string, id: string) {
  const set = pendingDeletes.get(collection) ?? new Set<string>();
  set.add(id);
  pendingDeletes.set(collection, set);
  unmark(pending, collection, id);
}

/**
 * Carrier ownership cannot live in the 25 ms batching window.
 *
 * A unique SQLite index protects the file, but if the request returned before
 * that index ran, two processes could both tell their carrier call that they won
 * and only discover the collision in the timer callback. These rows therefore
 * commit before their mutator returns; ordinary high-volume rows remain batched.
 */
function needsImmediateCommit(collection: string, doc?: Doc) {
  if (collection === 'numberClaims') return true;
  return collection === 'numbers' && Boolean(doc?.carrierId || doc?.carrierSid);
}

function resumePendingWrites() {
  if (pending.size || pendingDeletes.size) persist();
}

export function flushNow(options?: { replace?: boolean }) {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  flush(options);
}

/* ---------------------------------------------------------- atomic domain writes */

export type BatchUpsert = {
  collection: string;
  /** A full document or patch. Existing fields are preserved when this id exists. */
  doc: Doc;
  /** `null` requires absence; a number requires that exact current revision. */
  expectedRevision?: number | null;
  /** Prevents a caller from moving a row between tenants while updating it. */
  expectedOrgId?: string;
};

export type BatchDelete = {
  collection: string;
  id: string;
  expectedRevision?: number;
  expectedOrgId?: string;
};

export type BatchCommit = {
  upserts?: readonly BatchUpsert[];
  deletes?: readonly BatchDelete[];
};

export type BatchCommitResult = {
  upserts: Doc[];
  deleted: Array<{ collection: string; id: string }>;
};

export class CommitConflictError extends Error {
  readonly code = 'REVISION_CONFLICT';
  constructor(
    message: string,
    readonly target: { collection: string; id: string; expectedRevision?: number | null; actualRevision?: number },
  ) {
    super(message);
    this.name = 'CommitConflictError';
  }
}

const APPEND_ONLY_COLLECTIONS = new Set([
  'clinicalAccessEvents', 'clinicalDocumentVersions', 'documentScanEvents', 'clientMergeEvents',
  'automationEvents', 'automationRuleVersions',
  'noteTemplateVersions', 'clinicalNoteVersions', 'bodyChartAnnotationVersions', 'fundingEvents',
]);

function submittedEvidenceIsImmutable(collection: string, doc: Doc | undefined) {
  return collection === 'referralFormSubmissions' && doc?.status === 'submitted';
}

function currentRevision(doc: Doc | undefined): number | undefined {
  if (!doc) return undefined;
  const value = Number(doc.revision ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function validateBatchTarget(collection: string, id: string) {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(collection)) throw new Error(`invalid collection name ${JSON.stringify(collection)}`);
  if (!id || id.length > 240 || /[\u0000-\u001f]/.test(id)) throw new Error(`invalid document id for ${collection}`);
}

function checkPrecondition(
  current: Doc | undefined,
  target: { collection: string; id: string; expectedRevision?: number | null; expectedOrgId?: string },
) {
  const actualRevision = currentRevision(current);
  if (target.expectedRevision === null && current) {
    throw new CommitConflictError(`${target.collection}/${target.id} already exists`, {
      collection: target.collection,
      id: target.id,
      expectedRevision: null,
      actualRevision,
    });
  }
  if (typeof target.expectedRevision === 'number' && actualRevision !== target.expectedRevision) {
    throw new CommitConflictError(
      `${target.collection}/${target.id} revision changed (expected ${target.expectedRevision}, found ${actualRevision ?? 'missing'})`,
      { collection: target.collection, id: target.id, expectedRevision: target.expectedRevision, actualRevision },
    );
  }
  if (target.expectedOrgId && current && String(current.orgId ?? '') !== target.expectedOrgId) {
    throw new CommitConflictError(`${target.collection}/${target.id} does not belong to the expected workspace`, {
      collection: target.collection,
      id: target.id,
      expectedRevision: target.expectedRevision,
      actualRevision,
    });
  }
}

function nextBatchDoc(write: BatchUpsert, current: Doc | undefined, at: string): Doc {
  checkPrecondition(current, { ...write, id: write.doc.id });
  if (current && APPEND_ONLY_COLLECTIONS.has(write.collection)) {
    throw new Error(`${write.collection}/${write.doc.id} is append-only`);
  }
  if (submittedEvidenceIsImmutable(write.collection, current)) {
    throw new Error(`${write.collection}/${write.doc.id} contains immutable submitted evidence`);
  }
  const orgId = write.expectedOrgId;
  if (orgId && write.doc.orgId !== undefined && String(write.doc.orgId) !== orgId) {
    throw new Error(`${write.collection}/${write.doc.id} cannot be written into another workspace`);
  }
  const next = {
    ...(current ?? {}),
    ...write.doc,
    id: write.doc.id,
    createdAt: current?.createdAt ?? write.doc.createdAt ?? at,
    updatedAt: at,
    revision: (currentRevision(current) ?? 0) + 1,
  } as Doc;
  if (orgId && next.orgId === undefined) next.orgId = orgId;
  return next;
}

function invalidateCommittedCollections(collections: Set<string>) {
  if (!cache) return;
  for (const collection of collections) cache.delete(collection);
}

/**
 * Atomically applies a set of related document writes.
 *
 * PostgreSQL uses row/advisory locks and one transaction. SQLite starts with
 * `BEGIN IMMEDIATE`, so the precondition read and write cannot be interleaved by
 * another process. The JSON compatibility engine holds the strict store lock
 * for read-check-replace. Every changed document receives a monotonic revision.
 */
export function commitBatch(input: BatchCommit): BatchCommitResult {
  const upserts = [...(input.upserts ?? [])];
  const deletes = [...(input.deletes ?? [])];
  if (!upserts.length && !deletes.length) return { upserts: [], deleted: [] };
  if (upserts.length + deletes.length > 500) throw new Error('commitBatch accepts at most 500 document operations');

  const targets = [
    ...upserts.map((write) => ({ collection: write.collection, id: write.doc.id })),
    ...deletes.map((write) => ({ collection: write.collection, id: write.id })),
  ];
  const unique = new Set<string>();
  for (const target of targets) {
    validateBatchTarget(target.collection, target.id);
    const key = `${target.collection}\u0000${target.id}`;
    if (unique.has(key)) throw new Error(`commitBatch contains duplicate target ${target.collection}/${target.id}`);
    unique.add(key);
  }
  for (const write of deletes) {
    if (APPEND_ONLY_COLLECTIONS.has(write.collection)) throw new Error(`${write.collection}/${write.id} is append-only`);
  }

  // Legacy mutators may still be inside their short batching window. Put those
  // writes down before direct SQL so this transaction cannot later be overwritten
  // by an older cached document.
  if (writeTimer || pending.size || pendingDeletes.size) flushNow();
  refreshIfForeignWrite();

  const changedCollections = new Set(targets.map((target) => target.collection));
  const orderedTargets = [...targets].sort((a, b) => a.collection.localeCompare(b.collection) || a.id.localeCompare(b.id));
  const at = nowIso();
  const result: BatchCommitResult = { upserts: [], deleted: [] };

  if (engine === 'postgres') {
    ensurePostgresSchema();
    let version = lastPostgresVersion;
    try {
      pgTransaction(() => {
        for (const target of orderedTargets) {
          pgQuery('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [target.collection, target.id]);
        }
        const current = new Map<string, Doc | undefined>();
        for (const target of orderedTargets) {
          const row = pgQuery<{ body: unknown }>(
            'SELECT body FROM voxera_docs WHERE collection = $1 AND id = $2 FOR UPDATE',
            [target.collection, target.id],
          )[0];
          current.set(`${target.collection}\u0000${target.id}`, row ? docBody(row.body) : undefined);
        }
        for (const write of upserts) {
          const key = `${write.collection}\u0000${write.doc.id}`;
          const next = nextBatchDoc(write, current.get(key), at);
          pgQuery(
            `INSERT INTO voxera_docs (collection, id, body) VALUES ($1, $2, $3::jsonb)
             ON CONFLICT (collection, id) DO UPDATE SET body = EXCLUDED.body`,
            [write.collection, write.doc.id, JSON.stringify(next)],
          );
          result.upserts.push(next);
        }
        for (const write of deletes) {
          const key = `${write.collection}\u0000${write.id}`;
          const existing = current.get(key);
          checkPrecondition(existing, write);
          if (!existing) continue;
          if (submittedEvidenceIsImmutable(write.collection, existing)) throw new Error(`${write.collection}/${write.id} contains immutable submitted evidence`);
          pgQuery('DELETE FROM voxera_docs WHERE collection = $1 AND id = $2', [write.collection, write.id]);
          result.deleted.push({ collection: write.collection, id: write.id });
        }
        version = bumpPostgresVersion();
      });
    } catch (error) {
      // A revision/uniqueness conflict proves at least one cached target may be
      // stale (typically because another node won the same write). Invalidate
      // those buckets and force the next read to observe the shared data version.
      invalidateCommittedCollections(changedCollections);
      lastPostgresVersionCheck = 0;
      throw error;
    }
    invalidateCommittedCollections(changedCollections);
    lastPostgresVersion = version;
    lastPostgresVersionCheck = Date.now();
    return result;
  }

  if (engine === 'sqlite') {
    const db = sqlite();
    db.exec('BEGIN IMMEDIATE');
    try {
      const read = db.prepare('SELECT body FROM docs WHERE collection = ? AND id = ?');
      const current = new Map<string, Doc | undefined>();
      for (const target of orderedTargets) {
        const row = read.get(target.collection, target.id) as { body?: string } | undefined;
        current.set(`${target.collection}\u0000${target.id}`, row?.body ? (JSON.parse(row.body) as Doc) : undefined);
      }
      const upsert = db.prepare(
        `INSERT INTO docs (collection, id, pos, body) VALUES (?, ?, 0, ?)
         ON CONFLICT(collection, id) DO UPDATE SET body = excluded.body`,
      );
      for (const write of upserts) {
        const key = `${write.collection}\u0000${write.doc.id}`;
        const next = nextBatchDoc(write, current.get(key), at);
        upsert.run(write.collection, write.doc.id, JSON.stringify(next));
        result.upserts.push(next);
      }
      const drop = db.prepare('DELETE FROM docs WHERE collection = ? AND id = ?');
      for (const write of deletes) {
        const key = `${write.collection}\u0000${write.id}`;
        const existing = current.get(key);
        checkPrecondition(existing, write);
        if (!existing) continue;
        if (submittedEvidenceIsImmutable(write.collection, existing)) throw new Error(`${write.collection}/${write.id} contains immutable submitted evidence`);
        drop.run(write.collection, write.id);
        result.deleted.push({ collection: write.collection, id: write.id });
      }
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* preserve original failure */
      }
      // A failed optimistic write normally means another node won. Never leave
      // any of the touched buckets trusted after that evidence.
      invalidateCommittedCollections(changedCollections);
      throw error;
    }
    invalidateCommittedCollections(changedCollections);
    // Keep the last foreign generation we actually observed. Sampling after an
    // own commit can accidentally acknowledge another node without invalidating
    // collections that node changed.
    return result;
  }

  return withFileLock(() => {
    const disk = readFromDisk() ?? emptyDb();
    const working: DbShape = {
      version: Math.max(1, Number(disk.version ?? 1)) + 1,
      collections: Object.fromEntries(
        Object.entries(disk.collections).map(([name, docs]) => [name, docs.map((doc) => ({ ...doc }))]),
      ),
    };
    const current = new Map<string, Doc | undefined>();
    for (const target of orderedTargets) {
      current.set(
        `${target.collection}\u0000${target.id}`,
        (working.collections[target.collection] ?? []).find((doc) => doc.id === target.id),
      );
    }
    for (const write of upserts) {
      const key = `${write.collection}\u0000${write.doc.id}`;
      const existing = current.get(key);
      const next = nextBatchDoc(write, existing, at);
      const rows = (working.collections[write.collection] ??= []);
      const index = rows.findIndex((doc) => doc.id === write.doc.id);
      if (index === -1) rows.unshift(next);
      else rows[index] = next;
      result.upserts.push(next);
    }
    for (const write of deletes) {
      const key = `${write.collection}\u0000${write.id}`;
      const existing = current.get(key);
      checkPrecondition(existing, write);
      if (!existing) continue;
      if (submittedEvidenceIsImmutable(write.collection, existing)) throw new Error(`${write.collection}/${write.id} contains immutable submitted evidence`);
      working.collections[write.collection] = (working.collections[write.collection] ?? []).filter((doc) => doc.id !== write.id);
      result.deleted.push({ collection: write.collection, id: write.id });
    }
    writeJsonShapeDurably(working);
    return result;
  }, { required: true, waitMs: 5_000 });
}

const heldEntityLocks = new Set<string>();
const asyncEntityTails = new Map<string, Promise<void>>();

/**
 * Synchronous entity lock for domain decisions that span reads before a batch.
 * Commit-time revision checks remain mandatory; this lock only narrows duplicate
 * work and serialises external side-effect decisions.
 */
export function withEntityLock<T>(namespace: string, entityId: string, work: () => T): T {
  const key = `${namespace}:${entityId}`;
  if (!namespace || !entityId || key.length > 400) throw new Error('invalid entity lock key');
  if (heldEntityLocks.has(key)) return work();
  heldEntityLocks.add(key);
  try {
    if (engine === 'postgres') {
      const client = dedicatedPostgresClient('voxera-entity-lock');
      try {
        client.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
        try {
          return work();
        } finally {
          client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
        }
      } finally {
        client.close();
      }
    }

    const dir = path.join(DATA_DIR, 'entity-locks');
    fs.mkdirSync(dir, { recursive: true });
    const lockPath = path.join(dir, `${crypto.createHash('sha256').update(key).digest('hex')}.lock`);
    const deadline = Date.now() + 5_000;
    let held = false;
    while (!held) {
      try {
        const fd = fs.openSync(lockPath, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, key, at: nowIso() }));
        fs.closeSync(fd);
        held = true;
      } catch {
        try {
          if (Date.now() - fs.statSync(lockPath).mtimeMs > 30_000) {
            fs.rmSync(lockPath, { force: true });
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() >= deadline) throw new Error(`timed out waiting for entity lock ${namespace}`);
        sleepSync(5);
      }
    }
    try {
      return work();
    } finally {
      if (held) fs.rmSync(lockPath, { force: true });
    }
  } finally {
    heldEntityLocks.delete(key);
  }
}

/**
 * Async variant for mutations that must hold the same cross-process entity lock
 * while awaiting blob/provider I/O. Calls for one key queue in-process first;
 * the filesystem/advisory lock then coordinates other server processes.
 * Do not recursively request the same key from `work`.
 */
export async function withEntityLockAsync<T>(namespace: string, entityId: string, work: () => Promise<T>): Promise<T> {
  const key = `${namespace}:${entityId}`;
  if (!namespace || !entityId || key.length > 400) throw new Error('invalid entity lock key');

  const previous = asyncEntityTails.get(key) ?? Promise.resolve();
  let releaseLocal!: () => void;
  const gate = new Promise<void>((resolve) => { releaseLocal = resolve; });
  const tail = previous.catch(() => undefined).then(() => gate);
  asyncEntityTails.set(key, tail);
  await previous.catch(() => undefined);

  let releaseExternal: (() => void) | undefined;
  try {
    if (engine === 'postgres') {
      const client = dedicatedPostgresClient('voxera-async-entity-lock');
      client.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
      releaseExternal = () => {
        try { client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]); }
        finally { client.close(); }
      };
    } else {
      const dir = path.join(DATA_DIR, 'entity-locks');
      fs.mkdirSync(dir, { recursive: true });
      const lockPath = path.join(dir, `${crypto.createHash('sha256').update(key).digest('hex')}.lock`);
      const deadline = Date.now() + 15_000;
      for (;;) {
        try {
          const fd = fs.openSync(lockPath, 'wx', 0o600);
          fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, key, at: nowIso() }));
          fs.closeSync(fd);
          releaseExternal = () => fs.rmSync(lockPath, { force: true });
          break;
        } catch {
          try {
            if (Date.now() - fs.statSync(lockPath).mtimeMs > 120_000) {
              fs.rmSync(lockPath, { force: true });
              continue;
            }
          } catch {
            continue;
          }
          if (Date.now() >= deadline) throw new Error(`timed out waiting for async entity lock ${namespace}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    }
    return await work();
  } finally {
    try { releaseExternal?.(); } finally {
      releaseLocal();
      if (asyncEntityTails.get(key) === tail) asyncEntityTails.delete(key);
    }
  }
}

export function newId(prefix: string) {
  return `${prefix}${crypto.randomBytes(8).toString('hex')}`;
}

export function nowIso() {
  return new Date().toISOString();
}

/** Deployment-global, race-safe counter update used by PostgreSQL rate limits. */
export function incrementRateBucketAtomic(input: {
  id: string;
  windowMs: number;
  now: number;
}): { count: number; resetAt: number } {
  if (engine !== 'postgres') throw new Error('atomic PostgreSQL rate bucket requested on a different store');
  ensurePostgresSchema();
  if (pending.size || pendingDeletes.size) flushNow();
  const iso = new Date(input.now).toISOString();
  const fresh = {
    id: input.id,
    windowMs: input.windowMs,
    count: 1,
    resetAt: input.now + input.windowMs,
    createdAt: iso,
    updatedAt: iso,
  };
  let result = fresh;
  let version = lastPostgresVersion;
  pgTransaction(() => {
    const row = pgQuery<{ body: unknown }>(
      `INSERT INTO voxera_docs (collection, id, body)
       VALUES ('rateBuckets', $1, $2::jsonb)
       ON CONFLICT (collection, id) DO UPDATE SET body =
         CASE
           WHEN COALESCE((voxera_docs.body ->> 'resetAt')::bigint, 0) < $3::bigint THEN EXCLUDED.body
           ELSE jsonb_set(
             jsonb_set(voxera_docs.body, '{count}', to_jsonb(COALESCE((voxera_docs.body ->> 'count')::int, 0) + 1), true),
             '{updatedAt}', to_jsonb($4::text), true
           )
         END
       RETURNING body`,
      [input.id, JSON.stringify(fresh), input.now, iso]
    )[0];
    result = docBody(row.body) as typeof fresh;
    version = bumpPostgresVersion();
  });
  cache?.delete('rateBuckets');
  lastPostgresVersion = version;
  lastPostgresVersionCheck = Date.now();
  return { count: Number(result.count), resetAt: Number(result.resetAt) };
}

export function removeRateBucketAtomic(id: string): boolean {
  if (engine !== 'postgres') return remove('rateBuckets', id);
  ensurePostgresSchema();
  if (pending.size || pendingDeletes.size) flushNow();
  let removed = false;
  let version = lastPostgresVersion;
  pgTransaction(() => {
    const rows = pgQuery<{ id: string }>("DELETE FROM voxera_docs WHERE collection = 'rateBuckets' AND id = $1 RETURNING id", [id]);
    removed = rows.length > 0;
    if (removed) version = bumpPostgresVersion();
  });
  cache?.delete('rateBuckets');
  lastPostgresVersion = version;
  lastPostgresVersionCheck = Date.now();
  return removed;
}

/**
 * Reading a collection notices a commit made by another connection.
 *
 * The two module graphs in this server — Next's and the media worker's — each
 * hold their own cache. Under SQLite the file lock is gone, so staleness is
 * detected with `PRAGMA data_version`, which changes whenever *another* connection
 * commits. When it does, pending local writes are flushed first (so they are not
 * thrown away by the invalidate) and the cache is dropped; the next read reloads
 * from the database and sees both sides' work.
 */
function refreshIfForeignWrite() {
  if (engine === 'json') return;
  if (!foreignWriteHappened()) return;
  if (pending.size || pendingDeletes.size) {
    try {
      flush();
    } catch (error) {
      console.error('[db] could not flush before reload', error);
    }
  }
  cache = new Map();
}

export function list<T extends Doc>(collection: string, filter?: (doc: T) => boolean): T[] {
  refreshIfForeignWrite();
  const docs = bucket(collection) as T[];
  return filter ? docs.filter(filter) : [...docs];
}

/**
 * One page of an org-scoped collection, newest first, without loading the
 * rest of it.
 *
 * `list()` reads the whole collection into memory, which is fine while a
 * practice's `calls` table is measured in the hundreds and is the thing
 * that stops scaling once it is measured in the tens of thousands. This
 * pushes the `COUNT`, the `WHERE` on `orgId` and the window into SQLite
 * itself, so a page costs the page, not the collection.
 *
 * The JSON engine has no query language to push anything into; it filters
 * in memory and slices, which keeps the two engines returning the same
 * shape while only SQLite gets the scaling win.
 *
 * The page order is `rowid DESC`: rowid is assigned once, at insert,
 * and the upsert in `flush()` deliberately preserves it — so a row's
 * place in this order is when it was created, and editing it does not
 * move it. `pos` cannot carry this meaning (it is rewritten for the
 * dirty rows only, so most of a collection's rows hold a stale index),
 * which is why the ordering lives on the rowid the table already keeps.
 */
export function listPage<T extends Doc>(
  collection: string,
  orgId: string,
  opts: { limit?: number; offset?: number } = {}
): { docs: T[]; total: number } {
  refreshIfForeignWrite();
  const limit = Math.max(1, Math.min(Number(opts.limit ?? 500) || 500, 2000));
  const offset = Math.max(0, Number(opts.offset ?? 0) || 0);

  if (engine === 'json') {
    const docs = (bucket(collection) as T[]).filter((d) => (d as { orgId?: string }).orgId === orgId);
    return { docs: docs.slice(offset, offset + limit), total: docs.length };
  }

  if (pending.size || pendingDeletes.size) flushNow();
  if (engine === 'postgres') {
    ensurePostgresSchema();
    const totalRow = pgQuery<{ n: string | number }>(
      "SELECT COUNT(*)::text AS n FROM voxera_docs WHERE collection = $1 AND body ->> 'orgId' = $2",
      [collection, orgId]
    )[0];
    const rows = pgQuery<{ body: unknown }>(
      "SELECT body FROM voxera_docs WHERE collection = $1 AND body ->> 'orgId' = $2 ORDER BY seq DESC LIMIT $3 OFFSET $4",
      [collection, orgId, limit, offset]
    );
    return { docs: rows.map((row) => docBody(row.body) as T), total: Number(totalRow?.n ?? 0) };
  }

  const db = sqlite();
  // A paged read must not miss a write that is still in the flush
  // window: SQL is read directly here, bypassing the cache, so
  // anything pending has to go down first. The flush is cheap —
  // it writes only the rows that changed.
  if (pending.size || pendingDeletes.size) flushNow();
  const scoped = "collection = ? AND json_extract(body, '$.orgId') = ?";
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM docs WHERE ${scoped}`).get(collection, orgId) as { n: number }).n;
  const rows = db
    .prepare(`SELECT body FROM docs WHERE ${scoped} ORDER BY seq DESC LIMIT ? OFFSET ?`)
    .all(collection, orgId, limit, offset) as { body: string }[];
  return { docs: rows.map((row) => JSON.parse(row.body) as T), total };
}

/**
 * Rows matching top-level equality fields, newest first, without loading
 * the rest of the collection.
 *
 * `list()` with a filter still loads every row of the collection into the
 * cache and walks it — fine for a practice's services, wasteful for the
 * collections that grow with traffic (`audit`, `accessLog`,
 * `webhookDeliveries`). This pushes the equality tests into SQLite as
 * `json_extract` comparisons, exactly like `listPage`, so the cost is the
 * matching rows rather than the collection. Field values are bound as
 * parameters, never interpolated; field *names* come from call sites in
 * this codebase, and are still validated to a plain identifier shape.
 *
 * The JSON engine filters in memory, keeping the same result shape.
 */
/**
 * Exhaustive tenant-scoped read without hydrating another workspace's rows.
 * SQL engines page directly over the tenant-leading orgId expression; callers
 * that genuinely need complete aggregates should use this instead of
 * `list(collection, row => row.orgId === orgId)`.
 */
export function listAllByOrg<T extends Doc>(collection: string, orgId: string): T[] {
  const docs: T[] = [];
  let offset = 0;
  for (;;) {
    const page = listPage<T>(collection, orgId, { limit: 2000, offset });
    docs.push(...page.docs);
    offset += page.docs.length;
    if (page.docs.length === 0 || offset >= page.total) return docs;
  }
}

export function listBy<T extends Doc>(
  collection: string,
  fields: Record<string, string | number | boolean>,
  opts: { limit?: number } = {}
): T[] {
  refreshIfForeignWrite();
  const entries = Object.entries(fields);
  for (const [name] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`listBy: unsafe field name ${JSON.stringify(name)}`);
  }
  const limit = Math.max(1, Math.min(Number(opts.limit ?? 500) || 500, 10000));

  if (engine === 'json') {
    return (bucket(collection) as T[])
      .filter((d) => entries.every(([k, v]) => (d as Record<string, unknown>)[k] === v))
      .slice(0, limit);
  }

  if (pending.size || pendingDeletes.size) flushNow();
  if (engine === 'postgres') {
    ensurePostgresSchema();
    const where = entries.map(([key], index) => `body ->> '${key}' = $${index + 2}`).join(' AND ');
    const rows = pgQuery<{ body: unknown }>(
      `SELECT body FROM voxera_docs WHERE collection = $1${where ? ` AND ${where}` : ''} ORDER BY seq DESC LIMIT $${entries.length + 2}`,
      [collection, ...entries.map(([, value]) => String(value)), limit]
    );
    return rows.map((row) => docBody(row.body) as T);
  }

  const db = sqlite();
  if (pending.size || pendingDeletes.size) flushNow();
  const where = entries.map(([k]) => `json_extract(body, '$.${k}') = ?`).join(' AND ');
  const rows = db
    .prepare(`SELECT body FROM docs WHERE collection = ?${where ? ` AND ${where}` : ''} ORDER BY seq DESC LIMIT ?`)
    .all(collection, ...entries.map(([, v]) => (typeof v === 'boolean' ? (v ? 1 : 0) : v)), limit) as { body: string }[];
  return rows.map((row) => JSON.parse(row.body) as T);
}

/**
 * Read only selected scalar fields from a collection. SQL engines never load the
 * rest of each JSON document, which keeps restricted transcripts and payloads
 * out of cross-workspace operational aggregates.
 */
export function projectFields(collection: string, fieldPaths: string[]): Array<Record<string, unknown>> {
  refreshIfForeignWrite();
  const parsed = fieldPaths.map((fieldPath) => {
    const parts = fieldPath.split('.');
    if (!parts.length || parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))) {
      throw new Error(`projectFields: unsafe field path ${JSON.stringify(fieldPath)}`);
    }
    return { fieldPath, parts };
  });
  if (engine === 'json') {
    return bucket(collection).map((doc) => Object.fromEntries(parsed.map(({ fieldPath, parts }) => {
      let current: unknown = doc;
      for (const part of parts) current = current && typeof current === 'object' ? (current as Record<string, unknown>)[part] : undefined;
      return [fieldPath, current];
    })));
  }
  if (pending.size || pendingDeletes.size) flushNow();
  const aliases = parsed.map((_, index) => `f${index}`);
  if (engine === 'postgres') {
    ensurePostgresSchema();
    const select = parsed.map(({ parts }, index) => `body #>> '{${parts.join(',')}}' AS ${aliases[index]}`).join(', ');
    const rows = pgQuery<Record<string, unknown>>(`SELECT ${select} FROM voxera_docs WHERE collection = $1 ORDER BY seq DESC`, [collection]);
    return rows.map((row) => Object.fromEntries(parsed.map(({ fieldPath }, index) => [fieldPath, row[aliases[index]!]])));
  }
  const select = parsed.map(({ parts }, index) => `json_extract(body, '$.${parts.join('.')}') AS ${aliases[index]}`).join(', ');
  const rows = sqlite().prepare(`SELECT ${select} FROM docs WHERE collection = ? ORDER BY seq DESC`).all(collection) as Array<Record<string, unknown>>;
  return rows.map((row) => Object.fromEntries(parsed.map(({ fieldPath }, index) => [fieldPath, row[aliases[index]!]])));
}

/** Exact indexed-style lookup for a safe JSON path without hydrating the collection. */
export function findByPath<T extends Doc>(collection: string, fieldPath: string, value: string): T | undefined {
  refreshIfForeignWrite();
  const parts = fieldPath.split('.');
  if (!parts.length || parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))) {
    throw new Error(`findByPath: unsafe field path ${JSON.stringify(fieldPath)}`);
  }
  if (engine === 'json') {
    return (bucket(collection) as T[]).find((doc) => {
      let current: unknown = doc;
      for (const part of parts) current = current && typeof current === 'object' ? (current as Record<string, unknown>)[part] : undefined;
      return String(current ?? '') === value;
    });
  }
  if (pending.size || pendingDeletes.size) flushNow();
  if (engine === 'postgres') {
    ensurePostgresSchema();
    const path = `{${parts.join(',')}}`;
    const row = pgQuery<{ body: unknown }>(
      'SELECT body FROM voxera_docs WHERE collection = $1 AND body #>> $2::text[] = $3 ORDER BY seq DESC LIMIT 1',
      [collection, path, value],
    )[0];
    return row ? docBody(row.body) as T : undefined;
  }
  const row = sqlite().prepare(
    "SELECT body FROM docs WHERE collection = ? AND json_extract(body, ?) = ? ORDER BY seq DESC LIMIT 1",
  ).get(collection, `$.${parts.join('.')}`, value) as { body?: string } | undefined;
  return row?.body ? JSON.parse(row.body) as T : undefined;
}

export function find<T extends Doc>(collection: string, filter: (doc: T) => boolean): T | undefined {
  refreshIfForeignWrite();
  return (bucket(collection) as T[]).find(filter);
}

export function get<T extends Doc>(collection: string, id: string): T | undefined {
  refreshIfForeignWrite();
  return (bucket(collection) as T[]).find((d) => d.id === id);
}

export function insert<T extends Doc>(collection: string, doc: T): T {
  refreshIfForeignWrite();
  const withId = { createdAt: nowIso(), ...doc } as T;
  const docs = bucket(collection);
  docs.unshift(withId);
  mark(collection, withId.id);
  if (!needsImmediateCommit(collection, withId)) {
    persist();
    return withId;
  }
  try {
    flushNow();
    return withId;
  } catch (error) {
    const index = docs.findIndex((row) => row.id === withId.id);
    if (index !== -1) docs.splice(index, 1);
    unmark(pending, collection, withId.id);
    resumePendingWrites();
    throw error;
  }
}

export function insertMany<T extends Doc>(collection: string, docs: T[]): T[] {
  refreshIfForeignWrite();
  const withIds = docs.map((d) => ({ createdAt: nowIso(), ...d }) as T);
  bucket(collection).unshift(...withIds);
  for (const doc of withIds) mark(collection, doc.id);
  persist();
  return withIds;
}

export function update<T extends Doc>(collection: string, id: string, patch: Partial<T>): T | undefined {
  refreshIfForeignWrite();
  const docs = bucket(collection) as T[];
  const idx = docs.findIndex((d) => d.id === id);
  if (idx === -1) return undefined;
  if (APPEND_ONLY_COLLECTIONS.has(collection)) throw new Error(`${collection}/${id} is append-only`);
  const before = docs[idx];
  if (submittedEvidenceIsImmutable(collection, before)) throw new Error(`${collection}/${id} contains immutable submitted evidence`);
  docs[idx] = { ...before, ...patch, id, updatedAt: nowIso() };
  mark(collection, id);
  if (!needsImmediateCommit(collection, before) && !needsImmediateCommit(collection, docs[idx])) {
    persist();
    return docs[idx];
  }
  try {
    flushNow();
    return docs[idx];
  } catch (error) {
    docs[idx] = before;
    unmark(pending, collection, id);
    resumePendingWrites();
    throw error;
  }
}

export function remove(collection: string, id: string): boolean {
  refreshIfForeignWrite();
  const docs = bucket(collection);
  const idx = docs.findIndex((d) => d.id === id);
  if (idx === -1) return false;
  if (APPEND_ONLY_COLLECTIONS.has(collection)) throw new Error(`${collection}/${id} is append-only`);
  const removed = docs[idx];
  if (submittedEvidenceIsImmutable(collection, removed)) throw new Error(`${collection}/${id} contains immutable submitted evidence`);
  docs.splice(idx, 1);
  // Remember the deletion twice: the JSON engine's merge needs the tombstone, and
  // the SQLite engine needs the id to know which row to drop.
  tombstone(collection, id);
  markDeleted(collection, id);
  if (!needsImmediateCommit(collection, removed)) {
    persist();
    return true;
  }
  try {
    flushNow();
    return true;
  } catch (error) {
    docs.splice(idx, 0, removed);
    unmark(pendingDeletes, collection, id);
    unmark(tombstones, collection, id);
    resumePendingWrites();
    throw error;
  }
}

export function count(collection: string, filter?: (doc: Doc) => boolean): number {
  refreshIfForeignWrite();
  const docs = bucket(collection);
  return filter ? docs.filter(filter).length : docs.length;
}

/** Wipes everything. Offline/test maintenance only; never a dashboard action. */
export function resetDb(maintenanceCapability?: unknown) {
  assertDestructiveMaintenanceCapability(maintenanceCapability);
  if (cache) cache.clear();
  else cache = new Map();
  pending.clear();
  pendingDeletes.clear();
  tombstones.clear();
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  flush({ replace: true, maintenanceCapability });
}

export function dbStats() {
  refreshIfForeignWrite();
  if (engine === 'postgres') {
    ensurePostgresSchema();
    const rows = pgQuery<{ collection: string; n: string | number }>('SELECT collection, COUNT(*)::text AS n FROM voxera_docs GROUP BY collection');
    return Object.fromEntries(rows.map((row) => [row.collection, Number(row.n)]));
  }
  if (engine === 'sqlite') {
    // Straight from the database, and cheap: the index on `collection` makes this
    // a scan of the index rather than of every document. It also answers for
    // collections this process has never loaded, which `load()` cannot.
    const rows = sqlite().prepare('SELECT collection, COUNT(*) AS n FROM docs GROUP BY collection').all() as { collection: string; n: number }[];
    return Object.fromEntries(rows.map((row) => [row.collection, row.n]));
  }
  const db = load();
  return Object.fromEntries([...db.entries()].map(([k, v]) => [k, v.length]));
}

/* ------------------------------------------------- maintenance scripts --- */

/**
 * Every collection, for a maintenance script that needs to reason over the whole
 * store — the probe sweeper is the one that does. Reads through the same cache,
 * so it works identically on either engine and cannot disagree with what the app
 * would serve.
 */
export function dumpAll(): { collections: Record<string, Doc[]> } {
  refreshIfForeignWrite();
  if (engine === 'sqlite') {
    const rows = sqlite().prepare('SELECT DISTINCT collection FROM docs').all() as { collection: string }[];
    for (const row of rows) bucket(row.collection);
  } else if (engine === 'postgres') {
    ensurePostgresSchema();
    const rows = pgQuery<{ collection: string }>('SELECT DISTINCT collection FROM voxera_docs');
    for (const row of rows) bucket(row.collection);
  }
  const map = load();
  return { collections: Object.fromEntries(map) };
}

/** Replace the store with `next`, in one transaction. Offline maintenance only. */
export function replaceAll(next: { collections: Record<string, Doc[]> }, maintenanceCapability?: unknown) {
  assertDestructiveMaintenanceCapability(maintenanceCapability);
  cache = new Map(Object.entries(next.collections) as [string, Doc[]][]);
  pending.clear();
  pendingDeletes.clear();
  tombstones.clear();
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  flush({ replace: true, maintenanceCapability });
}

/** Flush pending writes and release the local database handle on shutdown. */
export function closeStore() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (pending.size || pendingDeletes.size) flushNow();
  handle?.close();
  handle = null;
  if (engine === 'postgres') {
    closeSharedPostgres();
    postgresReady = false;
  }
}

/** Which engine is live, for a script that wants to say so. */
export function storeDriver(): 'sqlite' | 'json' | 'postgres' {
  return engine;
}

/** The file behind the live engine — a check that runs on a throwaway store needs to prove it. */
export function storePath(): string {
  if (engine === 'postgres') return 'postgresql';
  return engine === 'sqlite' ? SQLITE_PATH : DB_PATH;
}

/* ------------------------------------------------------------------ helpers */

export function orgScope<T extends Doc>(collection: string, orgId: string): T[] {
  return list<T>(collection, (d) => (d as { orgId?: string }).orgId === orgId);
}

export function idParam(prefix: string, n = 12) {
  return `${prefix}${crypto.randomBytes(n).toString('hex')}`;
}
