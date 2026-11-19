/**
 * store-replace-check — the guard for the bug that emptied the store once.
 *
 * `replaceAll()` is the maintenance path that says "this cache is now the whole
 * state". It sets the cache, clears the dirty list and calls the flush with
 * `replace: true`. The SQLite flush used to honour that as *delete every row,
 * then write the pending ids* — and the pending list had just been cleared, so
 * the result was an empty table and a 28 MB backup standing next to it.
 *
 * This check runs the real functions against a throwaway store and asserts the
 * arithmetic that would have caught it: same docs in, same docs out. It is meant
 * to be run from a temporary directory (the gate does `cd "$(mktemp -d)"`) so it
 * cannot touch the project's `data/`, and the first check proves that.
 */
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../lib/server/db';
import { withDestructiveMaintenance } from '../lib/server/maintenance-replace';

process.env.VOXERA_STORE = 'sqlite';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

/**
 * The store takes its directory from the working directory, so the real work has
 * to happen somewhere disposable. When invoked normally this re-runs itself from
 * a fresh temp directory and forwards its exit code; the child sees the marker and
 * does the checking. That keeps the gate honest — it cannot write into `data/` —
 * without teaching the store about test directories.
 */
if (process.env.VOXERA_REPLACE_CHILD !== '1') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxera-replace-'));
  const run = spawnSync(path.join(REPO, 'node_modules/.bin/tsx'), [path.join(REPO, 'scripts/store-replace-check.ts')], {
    cwd: dir,
    env: { ...process.env, VOXERA_REPLACE_CHILD: '1' },
    stdio: 'inherit',
  });
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(run.status ?? 1);
}

const DIR = process.cwd();

let passes = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (ok) passes += 1;
  else failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} — ${label}${detail ? ` (${detail})` : ''}`);
}

check('running outside the project directory', path.resolve(DIR) !== path.resolve(REPO), DIR);
check('the engine under test is the one the app runs', db.storeDriver() === 'sqlite', db.storeDriver());

// Three collections, deliberately uneven, so a dropped one cannot hide behind another.
db.insert('alpha', { id: 'a1', name: 'one' });
db.insert('alpha', { id: 'a2', name: 'two' });
db.insert('beta', { id: 'b1', name: 'bee' });
db.insert('gamma', { id: 'g1', name: 'gee' });
db.insert('gamma', { id: 'g2', name: 'ghee' });
db.insert('gamma', { id: 'g3', name: 'three' });
db.flushNow();

const sqliteFile = db.storePath();
check('the store wrote into this directory', sqliteFile.startsWith(DIR) && fs.existsSync(sqliteFile), path.relative(DIR, sqliteFile));

const reader = new Database(sqliteFile, { readonly: true });
const countIn = (collection: string) =>
  (reader.prepare('SELECT COUNT(*) AS c FROM docs WHERE collection = ?').get(collection) as { c: number }).c;

const before = db.dumpAll();
const beforeTotal = Object.values(before.collections).reduce((n, rows) => n + rows.length, 0);
check('six documents went in', beforeTotal === 6, String(beforeTotal));

// The exact shape a maintenance script builds: read everything, change some of
// it, hand the whole thing back.
for (const row of before.collections.alpha ?? []) row.name = 'renamed';
const next = { collections: { ...before.collections } };
next.collections.beta = [];

withDestructiveMaintenance('verify intentional throwaway store replacement', (capability) =>
  db.replaceAll(next as never, capability));

// Five, not six: `beta` was emptied deliberately. The number that matters is
// that nothing *else* went missing — the failure this guards was a total of zero.
const afterTotal = (reader.prepare('SELECT COUNT(*) AS c FROM docs').get() as { c: number }).c;
check('every document that should survive did', afterTotal === 5, String(afterTotal));
check('the edited collection kept both rows', countIn('alpha') === 2, String(countIn('alpha')));
check('an untouched collection survived too', countIn('gamma') === 3, String(countIn('gamma')));
check('a collection emptied on purpose stays empty', countIn('beta') === 0, String(countIn('beta')));

const renamed = reader.prepare("SELECT body FROM docs WHERE collection = 'alpha' AND id = 'a1'").get() as { body: string };
check('the edit itself was written', JSON.parse(renamed.body).name === 'renamed', JSON.parse(renamed.body).name);

// Read back through the public API, which is what the app would serve next.
const reread = db.list<{ id: string; name?: string }>('alpha', () => true);
check('the API reads the replaced store back', reread.length === 2 && reread.some((r) => r.name === 'renamed'), `${reread.length} row(s)`);

console.log(`\n  ${passes} passed, ${failures} failed — a replace keeps the store it was handed.\n`);
process.exit(failures ? 1 : 0);
