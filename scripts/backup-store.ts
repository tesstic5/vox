/**
 * Back up the configured store and retain the newest N scheduled copies.
 *
 * PostgreSQL uses pg_dump's custom archive format; SQLite uses its online backup
 * API; JSON is packed as a migration fallback. Every artifact gets a SHA-256
 * sidecar and status.json is updated for /api/metrics. Scheduled copies still
 * need to leave the VPS — a file beside the database is not disaster recovery.
 *
 *   VOXERA_STORE=postgres DATABASE_URL=postgresql://... npm run store:backup -- /backups --keep 30
 *   npm run store:backup -- data/backups --keep 14
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import zlib from 'node:zlib';
import { dataDir, dataPath } from '../lib/server/paths';
import { dedicatedPostgresClient } from '../lib/server/postgres';

const args = process.argv.slice(2);
const keepIndex = args.indexOf('--keep');
const keep = keepIndex >= 0 ? Math.max(1, Number(args[keepIndex + 1]) || 14) : 14;
const targetArg = args.find((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--keep');
const target = path.resolve(targetArg ?? dataPath('backups'));
const engine = String(process.env.VOXERA_STORE ?? '').trim().toLowerCase();
const sqlitePath = path.join(dataDir(), 'voxera-db.sqlite');
const jsonPath = path.join(dataDir(), 'voxera-db.json');
const statusPath = process.env.VOXERA_BACKUP_STATUS ?? dataPath('backups', 'status.json');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

fs.mkdirSync(target, { recursive: true });

function writeStatus(status: Record<string, unknown>) {
  const destinations = [...new Set([statusPath, path.join(target, 'status.json')])];
  let previous: Record<string, unknown> = {};
  for (const destination of destinations) {
    try {
      previous = JSON.parse(fs.readFileSync(destination, 'utf8')) as Record<string, unknown>;
      break;
    } catch {
      /* no previous status */
    }
  }
  const at = new Date().toISOString();
  const lastSuccessAt = status.ok === true
    ? at
    : typeof previous.lastSuccessAt === 'string'
      ? previous.lastSuccessAt
      : previous.ok === true && typeof previous.at === 'string'
        ? previous.at
        : undefined;
  const body = `${JSON.stringify({ at, lastSuccessAt, ...status }, null, 2)}\n`;
  for (const destination of destinations) {
    try {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, body, { mode: 0o600 });
    } catch {
      // The backup artifact is still useful if only the observability file fails.
    }
  }
}

async function checksum(file: string) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function writeChecksum(file: string, sha256: string) {
  fs.writeFileSync(`${file}.sha256`, `${sha256}  ${path.basename(file)}\n`, { mode: 0o600 });
}

function commandVersion(binary: string): number {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`${binary} is required for PostgreSQL backups (${result.error?.message ?? (result.stderr.trim() || `exit ${result.status}`)})`);
  }
  const match = `${result.stdout} ${result.stderr}`.match(/(\d+)(?:\.\d+)?/);
  if (!match) throw new Error(`could not read ${binary} version`);
  return Number(match[1]);
}

function serverMajor(): number {
  const client = dedicatedPostgresClient('voxera-backup-version');
  try {
    const row = client.query<{ server_version_num: string | number }>('SHOW server_version_num')[0];
    return Math.floor(Number(row?.server_version_num ?? 0) / 10_000);
  } finally {
    client.close();
  }
}

function postgresConnectionEnv(databaseUrl: string): NodeJS.ProcessEnv {
  const parsed = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('DATABASE_URL must be a postgresql:// URL');
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!database) throw new Error('DATABASE_URL must name a database');
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
  return env;
}

function runPgDump(file: string) {
  const binary = process.env.PG_DUMP_BIN?.trim() || 'pg_dump';
  const clientMajor = commandVersion(binary);
  const databaseMajor = serverMajor();
  if (clientMajor < databaseMajor) {
    throw new Error(`pg_dump ${clientMajor} cannot safely dump PostgreSQL ${databaseMajor}; install a ${databaseMajor}+ client`);
  }
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('VOXERA_STORE=postgres backup requires DATABASE_URL');
  const result = spawnSync(
    binary,
    ['--format=custom', '--compress=9', '--no-owner', '--no-acl', '--file', file],
    {
      encoding: 'utf8',
      env: postgresConnectionEnv(databaseUrl),
      timeout: 30 * 60 * 1000,
    },
  );
  if (result.error || result.status !== 0) {
    fs.rmSync(file, { force: true });
    throw new Error(`pg_dump failed: ${result.error?.message ?? (result.stderr.trim() || `exit ${result.status}`)}`);
  }
}

async function backupPostgres() {
  const name = path.join(target, `voxera-postgres.${stamp}.dump`);
  const temporary = path.join(target, `.${path.basename(name)}.tmp`);
  runPgDump(temporary);
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, name);
  const bytes = fs.statSync(name).size;
  const sha256 = await checksum(name);
  writeChecksum(name, sha256);
  console.log(`backed up PostgreSQL ${(bytes / 1e6).toFixed(1)} MB → ${name}`);
  console.log(`sha256 ${sha256}`);
  return { file: name, bytes, sha256, engine: 'postgres' as const };
}

async function backupSqlite() {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(sqlitePath, { readonly: true });
  const name = path.join(target, `voxera-db.${stamp}.sqlite.gz`);
  const temporary = path.join(target, `.${path.basename(name)}.tmp`);
  const raw = `${temporary}.raw`;
  try {
    await db.backup(raw);
  } finally {
    db.close();
  }
  fs.writeFileSync(temporary, zlib.gzipSync(fs.readFileSync(raw), { level: 9 }), { mode: 0o600 });
  fs.rmSync(raw, { force: true });
  fs.renameSync(temporary, name);
  const bytes = fs.statSync(name).size;
  const sha256 = await checksum(name);
  writeChecksum(name, sha256);
  console.log(`backed up SQLite ${(bytes / 1e6).toFixed(1)} MB → ${name}`);
  console.log(`sha256 ${sha256}`);
  return { file: name, bytes, sha256, engine: 'sqlite' as const };
}

async function backupJson() {
  const name = path.join(target, `voxera-db.${stamp}.json.gz`);
  const temporary = path.join(target, `.${path.basename(name)}.tmp`);
  fs.writeFileSync(temporary, zlib.gzipSync(fs.readFileSync(jsonPath), { level: 9 }), { mode: 0o600 });
  fs.renameSync(temporary, name);
  const bytes = fs.statSync(name).size;
  const sha256 = await checksum(name);
  writeChecksum(name, sha256);
  console.log(`backed up JSON ${(bytes / 1e6).toFixed(1)} MB → ${name}`);
  console.log(`sha256 ${sha256}`);
  return { file: name, bytes, sha256, engine: 'json' as const };
}

function prune() {
  const copies = fs
    .readdirSync(target)
    .filter((file) => /^(?:voxera-postgres|voxera-db)\.\d{4}-\d{2}-\d{2}T/.test(file) && !file.endsWith('.sha256'))
    .sort()
    .reverse();
  for (const old of copies.slice(keep)) {
    fs.rmSync(path.join(target, old), { force: true });
    fs.rmSync(path.join(target, `${old}.sha256`), { force: true });
  }
  return Math.min(copies.length, keep);
}

async function run() {
  const result = engine === 'postgres'
    ? await backupPostgres()
    : fs.existsSync(sqlitePath)
      ? await backupSqlite()
      : fs.existsSync(jsonPath)
        ? await backupJson()
        : undefined;
  if (!result) throw new Error(`no store at ${sqlitePath} or ${jsonPath}`);
  const copies = prune();
  console.log(`${copies} scheduled copy(ies) kept in ${target} (--keep ${keep})`);
  writeStatus({ ok: true, engine: result.engine, file: path.basename(result.file), bytes: result.bytes, sha256: result.sha256, copies, keep });
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('backup failed:', message);
  writeStatus({ ok: false, engine: engine || 'local', error: message });
  process.exit(1);
});
