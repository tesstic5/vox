import { spawn, spawnSync } from 'node:child_process';
import {
  closeStore,
  flushNow,
  get,
  insert,
  list,
  listBy,
  listPage,
  remove,
  replaceAll,
  resetDb,
  storeDriver,
  update,
} from '../lib/server/db';
import { claimScheduler } from '../lib/server/instance-lock';
import { withDestructiveMaintenance } from '../lib/server/maintenance-replace';
import { rateLimit } from '../lib/server/ratelimit';

let checks = 0;
function check(label: string, condition: unknown, detail?: unknown) {
  checks += 1;
  if (!condition) throw new Error(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  console.log(`PASS ${label}`);
}

if (storeDriver() !== 'postgres') throw new Error('set VOXERA_STORE=postgres');
const database = new URL(process.env.DATABASE_URL ?? '');
if (!database.pathname.includes('test') && process.env.VOXERA_ALLOW_POSTGRES_TEST_RESET !== '1') {
  throw new Error('refusing destructive PostgreSQL check: use a database whose name contains "test"');
}

const workerEnv = () => ({ ...process.env, VOXERA_POSTGRES_CACHE_POLL_MS: '0' });
const worker = (args: string[]) => {
  const result = spawnSync(process.execPath, ['node_modules/.bin/tsx', 'scripts/postgres-worker.ts', ...args], {
    cwd: process.cwd(),
    env: workerEnv(),
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`worker ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim().split('\n').at(-1) ?? '';
};

const workerAsync = (args: string[]) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/.bin/tsx', 'scripts/postgres-worker.ts', ...args], {
      cwd: process.cwd(),
      env: workerEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(`worker ${args.join(' ')} failed: ${stderr || stdout}`));
      else resolve(stdout.trim().split('\n').at(-1) ?? '');
    });
  });

async function main() {
  try {
    withDestructiveMaintenance('reset throwaway PostgreSQL check target', (capability) => resetDb(capability));
    check('PostgreSQL target starts empty', list('probe').length === 0);

    insert('probe', { id: 'one', orgId: 'org_a', kind: 'alpha', value: 1 });
    insert('probe', { id: 'two', orgId: 'org_a', kind: 'beta', value: 2 });
    insert('probe', { id: 'three', orgId: 'org_b', kind: 'alpha', value: 3 });
    flushNow();
    check('insert order is newest first', list('probe').map((row) => row.id).join(',') === 'three,two,one');
    check('primary-key get works', get('probe', 'two')?.value === 2);

    update('probe', 'one', { value: 4 });
    remove('probe', 'two');
    flushNow();
    check('update persists without moving row age', list('probe').map((row) => row.id).join(',') === 'three,one');
    check('delete persists', get('probe', 'two') === undefined);
    check('updated value persists', get('probe', 'one')?.value === 4);

    const page = listPage('probe', 'org_a', { limit: 10 });
    check('tenant page is scoped', page.total === 1 && page.docs[0]?.id === 'one', page);
    check('JSONB equality query works', listBy('probe', { kind: 'alpha' }).length === 2);

    withDestructiveMaintenance('exercise whole-store PostgreSQL replacement', (capability) =>
      replaceAll({ collections: { probe: [{ id: 'old', value: 1 }, { id: 'older', value: 0 }] } }, capability));
    check('transactional replace keeps exact state', list('probe').map((row) => row.id).join(',') === 'old,older');

    insert('numbers', { id: 'num_a', orgId: 'org_a', number: '+15550001001', carrierSid: 'PN_A', status: 'active' });
    let numberConflict = false;
    try {
      insert('numbers', { id: 'num_b', orgId: 'org_b', number: '+15550001001', carrierSid: 'PN_B', status: 'active' });
    } catch {
      numberConflict = true;
    }
    check('global carrier-number uniqueness is database enforced', numberConflict);

    insert('numberClaims', { id: 'claim_a', orgId: 'org_a', number: '+15550001002' });
    let claimConflict = false;
    try {
      insert('numberClaims', { id: 'claim_b', orgId: 'org_b', number: '+15550001002' });
    } catch {
      claimConflict = true;
    }
    check('pending number-claim uniqueness is database enforced', claimConflict);

    list('crossProcess');
    check('child process committed a row', worker(['insert', 'crossProcess', 'child-row', 'visible']) === 'inserted');
    check('cross-process version invalidates the warmed cache', list('crossProcess').some((row) => row.id === 'child-row'));

    const lease = claimScheduler();
    check('first process owns PostgreSQL scheduler lease', lease.owns);
    const blocked = JSON.parse(worker(['claim'])) as { owns: boolean };
    check('second process cannot own scheduler lease concurrently', blocked.owns === false, blocked);
    lease.release?.();
    const takeover = JSON.parse(worker(['claim'])) as { owns: boolean };
    check('standby can take scheduler lease after release', takeover.owns === true, takeover);

    const identity = `postgres-concurrency-${Date.now()}`;
    const runs = await Promise.all(Array.from({ length: 12 }, () => workerAsync(['rate', identity])));
    check('all concurrent rate-limit workers completed', runs.length === 12);
    const thirteenth = rateLimit(identity, 10_000, 60_000);
    check('PostgreSQL rate-limit increment is atomic across processes', thirteenth.remaining === 10_000 - 13, thirteenth);

    withDestructiveMaintenance('clean throwaway PostgreSQL check target', (capability) => resetDb(capability));
    console.log(`\nPostgreSQL integration: ${checks}/${checks} checks passed`);
  } finally {
    closeStore();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
