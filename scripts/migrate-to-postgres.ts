/**
 * Copy the active SQLite/JSON store into PostgreSQL and verify every collection.
 *
 * The source engine is selected with VOXERA_STORE (normally sqlite) and may be
 * isolated with VOXERA_DATA_DIR. DATABASE_URL is always the PostgreSQL target.
 * The target must be empty unless the deliberately noisy confirmation is used.
 *
 *   VOXERA_STORE=sqlite DATABASE_URL=postgresql://... npx tsx scripts/migrate-to-postgres.ts --check
 *   VOXERA_STORE=sqlite DATABASE_URL=postgresql://... npx tsx scripts/migrate-to-postgres.ts --apply
 *   VOXERA_ALLOW_DESTRUCTIVE_MAINTENANCE=1 ... --apply --replace --confirm-replace=DELETE_POSTGRES_TARGET
 *
 * Replacement is intentionally refused in NODE_ENV=production; restore into a
 * verified staging target and perform the production cutover through the backup
 * procedure rather than weakening append-only runtime guards.
 */

import crypto from 'node:crypto';
import { closeStore, dumpAll, dumpPostgresAll, postgresCollectionStats, replacePostgresFromDump, storeDriver } from '../lib/server/db';
import { withDestructiveMaintenance } from '../lib/server/maintenance-replace';

const args = new Set(process.argv.slice(2));
const check = args.has('--check');
const apply = args.has('--apply');
const replace = args.has('--replace');
const confirmed = args.has('--confirm-replace=DELETE_POSTGRES_TARGET');

if ((!check && !apply) || (replace && !confirmed)) {
  console.error(
    'usage: npx tsx scripts/migrate-to-postgres.ts [--check | --apply] ' +
      '[--replace --confirm-replace=DELETE_POSTGRES_TARGET]'
  );
  process.exit(2);
}
if (storeDriver() === 'postgres') {
  console.error('The source cannot be PostgreSQL. Set VOXERA_STORE=sqlite or json and point VOXERA_DATA_DIR at the source store.');
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL must point at the PostgreSQL target.');
  process.exit(2);
}

function total(counts: Record<string, number>) {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

function countsFor(collections: Record<string, unknown[]>) {
  return Object.fromEntries(Object.entries(collections).map(([name, rows]) => [name, rows.length]));
}

function diff(source: Record<string, number>, target: Record<string, number>) {
  const names = [...new Set([...Object.keys(source), ...Object.keys(target)])].sort();
  return names.filter((name) => (source[name] ?? 0) !== (target[name] ?? 0)).map((name) => `${name}: source ${source[name] ?? 0}, target ${target[name] ?? 0}`);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function digests(collections: Record<string, unknown[]>) {
  return Object.fromEntries(
    Object.entries(collections).map(([name, rows]) => [name, crypto.createHash('sha256').update(canonical(rows)).digest('hex')])
  );
}

try {
  const source = dumpAll();
  const sourceCounts = countsFor(source.collections);
  const before = postgresCollectionStats();
  console.log(`source ${storeDriver()}: ${total(sourceCounts)} documents across ${Object.keys(sourceCounts).length} collections`);
  console.log(`target postgres: ${total(before)} documents across ${Object.keys(before).length} collections`);

  if (check && !apply) {
    const mismatches = diff(sourceCounts, before);
    if (mismatches.length === 0) console.log('collection counts already match');
    else for (const line of mismatches.slice(0, 100)) console.log(`different ${line}`);
    console.log('--check only: nothing was changed');
    process.exit(0);
  }

  const after = replace && confirmed
    ? withDestructiveMaintenance('operator-confirmed PostgreSQL target replacement', (capability) =>
        replacePostgresFromDump(source, true, capability))
    : replacePostgresFromDump(source, false);
  const mismatches = diff(sourceCounts, after);
  const sourceDigests = digests(source.collections);
  const targetDigests = digests(dumpPostgresAll().collections);
  const digestMismatches = Object.keys(sourceDigests).filter((name) => sourceDigests[name] !== targetDigests[name]);
  if (mismatches.length || digestMismatches.length) {
    console.error('PostgreSQL verification failed:');
    for (const line of mismatches) console.error(`  ${line}`);
    for (const name of digestMismatches) console.error(`  ${name}: document-content digest differs`);
    process.exitCode = 1;
    throw new Error('migration verification failed');
  }
  console.log(`migrated and verified ${total(after)} documents across ${Object.keys(after).length} collections (counts + SHA-256 content digests)`);
  console.log('Keep the source store and pre-migration PostgreSQL backup until the staging acceptance suite passes.');
} finally {
  closeStore();
}
