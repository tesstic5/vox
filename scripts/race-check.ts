/**
 * Regression check for the merge-on-write fix in `lib/server/db.ts`.
 *
 * The store is loaded twice in a running deployment — once inside the Next
 * bundle, once by the media worker — and each copy batches writes for 25 ms
 * before replacing the whole JSON file. Before the fix, the writer whose flush
 * landed second replaced the file with its own stale copy and everything the
 * other writer had just committed vanished.
 *
 * This script reproduces that interleaving with two child processes:
 *
 *   A ("app")    inserts in a tight loop so it always has a write pending,
 *                then flushes at the end of the burst.
 *   B ("worker") inserts inside A's pending window and flushes immediately.
 *
 * Both writers' rows must exist afterwards. Run it with the app stopped if you
 * want an isolated local-file read; it cleans up its own rows on every engine.
 *
 *   npx tsx scripts/race-check.ts
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = path.join(process.cwd(), 'data', 'voxera-db.json');
const SQLITE_PATH = path.join(process.cwd(), 'data', 'voxera-db.sqlite');
/**
 * Which engine this run is checking.
 *
 * The check exists for the JSON engine's merge-on-write, which is a real hazard:
 * a whole-file replace can lose the other writer's rows. SQLite and PostgreSQL
 * answer with transactions, so the same interleaving must also keep both rows.
 * Honour the explicitly configured production engine instead of writing there
 * and then accidentally inspecting the local SQLite fallback.
 */
const configuredEngine = String(process.env.VOXERA_STORE ?? '').trim().toLowerCase();
const ENGINE: 'postgres' | 'sqlite' | 'json' = configuredEngine === 'postgres'
  ? 'postgres'
  : fs.existsSync(SQLITE_PATH)
    ? 'sqlite'
    : 'json';
const MODULE = 'scripts/race-check.ts';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function child(role: 'app' | 'worker') {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn('npx', ['tsx', MODULE, `--role=${role}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => (err += String(d)));
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${role} exited ${code}: ${err.slice(0, 400)}`))));
  });
}

async function role(which: string) {
  const db = await import('../lib/server/db');
  if (which === 'app') {
    // A burst of edits: every insert reschedules the 25 ms flush, so this
    // process always has an unwritten change while B writes.
    for (let i = 0; i < 10; i += 1) {
      db.insert('calls', { id: `call_RACECHK_a${i}`, orgId: 'race_check', probe: true } as never);
      await sleep(12);
    }
    db.flushNow();
    return;
  }
  const dbw = await import('../lib/server/db');
  await sleep(50); // land inside the other process's pending window
  dbw.insert('calls', { id: 'call_RACECHK_b', orgId: 'race_check', probe: true } as never);
  dbw.flushNow();
}

/**
 * Waits for the merge to land before judging.
 *
 * The fix is a merge-on-write, so the survivor appears when the *next* flush
 * runs — reading the file the instant the two writers exit can see the
 * pre-merge bytes and report a loss that did not happen (it did, once). The
 * check therefore polls, and only calls it a failure if the rows never arrive.
 */
async function callIds(): Promise<string[]> {
  if (ENGINE === 'json') {
    const raw = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) as { collections: Record<string, { id: string }[]> };
    return (raw.collections.calls ?? []).map((c) => c.id);
  }
  if (ENGINE === 'postgres') {
    const db = await import('../lib/server/db');
    return db
      .list<{ id: string }>('calls', (row) => row.id.startsWith('call_RACECHK_'))
      .map((row) => row.id)
      .sort();
  }
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(SQLITE_PATH, { readonly: true });
  const rows = db.prepare("SELECT id FROM docs WHERE collection = 'calls'").all() as { id: string }[];
  db.close();
  return rows.map((r) => r.id);
}

async function readRows(): Promise<{ appRows: string[]; workerRow: boolean }> {
  const ids = (await callIds()).filter((id) => id.startsWith('call_RACECHK_'));
  return { appRows: ids.filter((id) => id.startsWith('call_RACECHK_a')), workerRow: ids.includes('call_RACECHK_b') };
}

async function verifyAndClean() {
  let { appRows, workerRow } = await readRows();
  const deadline = Date.now() + 4000;
  while ((appRows.length !== 10 || !workerRow) && Date.now() < deadline) {
    await sleep(150);
    ({ appRows, workerRow } = await readRows());
  }
  console.log(`wrote 10 app rows + 1 worker row; the ${ENGINE} store contains ${appRows.length} app rows, worker row: ${workerRow ? 'yes' : 'NO'}`);
  const ok = appRows.length === 10 && workerRow;
  console.log(ok ? 'RACE CHECK: PASS — a flush inside the pending window no longer discards the other writer.' : 'RACE CHECK: FAIL — rows were lost.');

  const db = await import('../lib/server/db');
  const ids = (await callIds()).filter((id) => id.startsWith('call_RACECHK_'));
  for (const id of ids) db.remove('calls', id);
  db.flushNow();
  db.closeStore();
  return ok;
}

async function main() {
  const args = process.argv.slice(2);
  const roleArg = args.find((a) => a.startsWith('--role='))?.split('=')[1];

  if (roleArg) {
    await role(roleArg);
    const db = await import('../lib/server/db');
    db.closeStore();
    return;
  }

  const before = ENGINE === 'json' ? fs.readFileSync(DB_PATH, 'utf8') : '';
  console.log(`starting two writers against the ${ENGINE} store …`);
  await Promise.all([child('app'), sleep(20).then(() => child('worker'))]);
  const ok = await verifyAndClean();
  if (!ok) {
    console.error('the store after the run is left as-is for inspection; the probe rows were cleaned up.');
    if (before) fs.writeFileSync('/tmp/voxera-db.race-check.before.json', before);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('race-check failed to run', err);
  process.exit(1);
});
