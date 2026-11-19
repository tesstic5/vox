/**
 * Inspect or restore a Voxera store backup, with loud safety boundaries.
 *
 * PostgreSQL custom archives are checked with pg_restore, checksum-verified when
 * a sidecar exists, and restored in one transaction. Applying a PostgreSQL
 * archive requires the app to be stopped and an explicit destructive phrase;
 * the current target is dumped beside the chosen archive before replacement.
 *
 *   npm run store:restore -- /backups/voxera-postgres....dump --check
 *   npm run store:restore -- /backups/voxera-postgres....dump --apply \
 *     --confirm-postgres=REPLACE_POSTGRES_TARGET
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import zlib from 'node:zlib';
import { dataDir } from '../lib/server/paths';
import { dedicatedPostgresClient } from '../lib/server/postgres';

const args = process.argv.slice(2);
const fileArg = args.find((arg) => !arg.startsWith('--'));
const check = args.includes('--check');
const apply = args.includes('--apply');
const postgresConfirmed = args.includes('--confirm-postgres=REPLACE_POSTGRES_TARGET');
const activeDataDir = dataDir();
const sqlitePath = path.join(activeDataDir, 'voxera-db.sqlite');
const jsonPath = path.join(activeDataDir, 'voxera-db.json');

if (!fileArg || (!check && !apply)) {
  console.error('usage: npm run store:restore -- <backup> [--check | --apply] [--confirm-postgres=REPLACE_POSTGRES_TARGET]');
  process.exit(2);
}
const file = path.resolve(fileArg);
if (!fs.existsSync(file)) {
  console.error(`no such backup: ${file}`);
  process.exit(1);
}
const postgresArchive = file.endsWith('.dump');
if (postgresArchive && apply && !postgresConfirmed) {
  console.error('refusing PostgreSQL restore: add --confirm-postgres=REPLACE_POSTGRES_TARGET after reviewing --check output');
  process.exit(2);
}

async function sha256(target: string) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(target)) hash.update(chunk);
  return hash.digest('hex');
}

async function verifyChecksum(target: string) {
  const actual = await sha256(target);
  const sidecar = `${target}.sha256`;
  if (fs.existsSync(sidecar)) {
    const expected = fs.readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0];
    if (!expected || expected !== actual) throw new Error(`SHA-256 mismatch: expected ${expected || '(empty sidecar)'}, got ${actual}`);
    console.log('  checksum sidecar: verified');
  } else {
    console.log('  checksum sidecar: absent (record the SHA-256 shown below before moving this archive)');
  }
  return actual;
}

function commandFailure(result: SpawnSyncReturns<string>) {
  return result.error?.message || result.stderr?.trim() || `exit ${result.status}`;
}

function toolMajor(binary: string) {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`${binary} is required (${commandFailure(result)})`);
  const match = `${result.stdout} ${result.stderr}`.match(/(\d+)(?:\.\d+)?/);
  if (!match) throw new Error(`could not read ${binary} version`);
  return Number(match[1]);
}

function databaseUrl() {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) throw new Error('PostgreSQL restore requires DATABASE_URL');
  return value;
}

function serverMajor() {
  const client = dedicatedPostgresClient('voxera-restore-version');
  try {
    const row = client.query<{ server_version_num: string | number }>('SHOW server_version_num')[0];
    return Math.floor(Number(row?.server_version_num ?? 0) / 10_000);
  } finally {
    client.close();
  }
}

function postgresConnectionEnv() {
  const parsed = new URL(databaseUrl());
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('DATABASE_URL must be a postgresql:// URL');
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!database) throw new Error('DATABASE_URL must name a target database');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || '5432',
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: database,
    PGCONNECT_TIMEOUT: parsed.searchParams.get('connect_timeout') || process.env.PGCONNECT_TIMEOUT || '10',
  };
  const sslmode = parsed.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  return { env, database };
}

function inspectPostgresArchive() {
  const binary = process.env.PG_RESTORE_BIN?.trim() || 'pg_restore';
  const clientMajor = toolMajor(binary);
  const databaseMajor = serverMajor();
  if (clientMajor < databaseMajor) throw new Error(`pg_restore ${clientMajor} cannot safely restore to PostgreSQL ${databaseMajor}`);
  const result = spawnSync(binary, ['--list', file], { encoding: 'utf8', timeout: 120_000 });
  if (result.error || result.status !== 0) throw new Error(`pg_restore could not read the archive: ${commandFailure(result)}`);
  const toc = result.stdout.split('\n').filter((line) => line && !line.startsWith(';'));
  const tableData = toc.filter((line) => line.includes(' TABLE DATA '));
  const hasDocs = toc.some((line) => / TABLE(?: DATA)? .* voxera_docs /.test(` ${line} `) || line.includes(' voxera_docs '));
  console.log(`  archive TOC: ${toc.length} object(s), ${tableData.length} table-data section(s)`);
  console.log(`  target: PostgreSQL ${databaseMajor} · client tools ${clientMajor}`);
  if (!hasDocs) throw new Error('archive does not contain the Voxera document table');
}

function dumpCurrentTarget(destination: string) {
  const binary = process.env.PG_DUMP_BIN?.trim() || 'pg_dump';
  const clientMajor = toolMajor(binary);
  const databaseMajor = serverMajor();
  if (clientMajor < databaseMajor) throw new Error(`pg_dump ${clientMajor} cannot safely back up PostgreSQL ${databaseMajor}`);
  const result = spawnSync(binary, ['--format=custom', '--compress=9', '--no-owner', '--no-acl', '--file', destination], {
    encoding: 'utf8',
    env: postgresConnectionEnv().env,
    timeout: 30 * 60 * 1000,
  });
  if (result.error || result.status !== 0) {
    fs.rmSync(destination, { force: true });
    throw new Error(`pre-restore pg_dump failed: ${commandFailure(result)}`);
  }
  fs.chmodSync(destination, 0o600);
}

async function restorePostgres() {
  const restoreBinary = process.env.PG_RESTORE_BIN?.trim() || 'pg_restore';
  const { env, database } = postgresConnectionEnv();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safety = path.join(path.dirname(file), `voxera-postgres.before-restore-${stamp}.dump`);
  const safetyTmp = `${safety}.tmp`;
  console.log(`\ncreating reversible pre-restore backup → ${safety}`);
  dumpCurrentTarget(safetyTmp);
  fs.renameSync(safetyTmp, safety);
  const safetySha = await sha256(safety);
  fs.writeFileSync(`${safety}.sha256`, `${safetySha}  ${path.basename(safety)}\n`, { mode: 0o600 });

  const result = spawnSync(
    restoreBinary,
    ['--clean', '--if-exists', '--no-owner', '--no-acl', '--single-transaction', '--exit-on-error', '--dbname', database, file],
    { encoding: 'utf8', env, timeout: 30 * 60 * 1000 },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`pg_restore failed; its single transaction was rolled back. Safety backup: ${safety}. Detail: ${commandFailure(result)}`);
  }

  const client = dedicatedPostgresClient('voxera-restore-verify');
  try {
    const count = client.query<{ n: string | number }>('SELECT COUNT(*)::text AS n FROM voxera_docs')[0];
    const collections = client.query<{ n: string | number }>('SELECT COUNT(DISTINCT collection)::text AS n FROM voxera_docs')[0];
    const writable = client.query<{ ok: number }>("SELECT 1 AS ok")[0]?.ok === 1;
    console.log(`\nrestored PostgreSQL archive: ${Number(count?.n ?? 0)} documents across ${Number(collections?.n ?? 0)} collections`);
    console.log(`target read check: ${writable ? 'ok' : 'failed'}`);
  } finally {
    client.close();
  }
  console.log(`pre-restore target retained at ${safety}`);
}

async function inspectSqlite(target: string) {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(target, { readonly: true });
  try {
    const integrity = String(db.pragma('integrity_check', { simple: true }));
    const total = (db.prepare('SELECT COUNT(*) AS n FROM docs').get() as { n: number }).n;
    const collections = (db.prepare('SELECT COUNT(DISTINCT collection) AS n FROM docs').get() as { n: number }).n;
    const orgs = (db.prepare("SELECT body FROM docs WHERE collection = 'orgs'").all() as { body: string }[]).map((row) => JSON.parse(row.body) as { name?: string });
    const bookings = (db.prepare("SELECT COUNT(*) AS n FROM docs WHERE collection = 'bookings'").get() as { n: number }).n;
    return { integrity, total, collections, orgs: orgs.map((org) => org.name).filter(Boolean), bookings };
  } finally {
    db.close();
  }
}

async function appIsRunning() {
  try {
    const healthUrl = process.env.VOXERA_HEALTH_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}/api/health`;
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function restoreLocal(plain: string, isSqlite: boolean) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.mkdirSync(activeDataDir, { recursive: true });
  if (fs.existsSync(sqlitePath)) fs.renameSync(sqlitePath, path.join(activeDataDir, `voxera-db.replaced-${stamp}.sqlite`));
  for (const suffix of ['-wal', '-shm']) fs.rmSync(`${sqlitePath}${suffix}`, { force: true });
  if (isSqlite) {
    fs.copyFileSync(plain, sqlitePath);
    console.log(`\nrestored → ${sqlitePath}`);
  } else {
    fs.copyFileSync(plain, jsonPath);
    console.log(`\nrestored → ${jsonPath} (imported into SQLite on next boot)`);
  }
}

async function run() {
  const actualSha = await verifyChecksum(file);
  console.log(`backup ${file}`);
  console.log(`  ${(fs.statSync(file).size / 1e6).toFixed(1)} MB · sha256 ${actualSha}`);

  if (postgresArchive) {
    inspectPostgresArchive();
    if (check && !apply) {
      console.log('\n--check only: archive parsed and checksum verified; nothing was changed.');
      return;
    }
    if (await appIsRunning()) throw new Error('refusing to restore: the app is answering on its port. Stop it first');
    await restorePostgres();
    console.log('start the app, check /api/health, and run the staging acceptance suite before relying on the restore.');
    return;
  }

  const packed = file.endsWith('.gz');
  const plain = packed ? path.join(os.tmpdir(), `voxera-restore-${process.pid}${file.endsWith('.sqlite.gz') ? '.sqlite' : '.json'}`) : file;
  try {
    if (packed) fs.writeFileSync(plain, zlib.gunzipSync(fs.readFileSync(file)));
    const isSqlite = plain.endsWith('.sqlite');
    if (isSqlite) {
      const info = await inspectSqlite(plain);
      console.log(`  integrity_check: ${info.integrity}`);
      console.log(`  ${info.total} documents across ${info.collections} collections · ${info.bookings} bookings`);
      console.log(`  workspaces: ${info.orgs.join(', ') || '(none)'}`);
      if (info.integrity !== 'ok') throw new Error('backup is not internally consistent');
    } else {
      const parsed = JSON.parse(fs.readFileSync(plain, 'utf8')) as { collections?: Record<string, unknown[]> };
      const collections = parsed.collections ?? {};
      console.log(`  ${Object.values(collections).reduce((sum, docs) => sum + docs.length, 0)} documents across ${Object.keys(collections).length} collections`);
    }
    if (check && !apply) {
      console.log('\n--check only: nothing was changed. Re-run with --apply to restore.');
      return;
    }
    if (await appIsRunning()) throw new Error('refusing to restore: the app is answering on its port. Stop it first');
    await restoreLocal(plain, isSqlite);
    console.log('start the app and check /api/health before relying on it.');
  } finally {
    if (packed) fs.rmSync(plain, { force: true });
  }
}

run().catch((error) => {
  console.error('restore failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
