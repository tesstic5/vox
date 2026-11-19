#!/usr/bin/env node
/**
 * Deployment-global number ownership race and expiry gate.
 *
 * Uses the configured store and two real Node processes so the reservation proof
 * does not rely on one event loop. Local SQLite runs use an isolated temporary
 * store; PostgreSQL runs use test-only rows in the disposable target and remove
 * them before exit. The gate also exercises stale-claim cleanup,
 * compensation/retry, the active-number partial unique index, and reuse after a
 * provider-backed number is explicitly released.
 */
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let passed = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (ok) passed += 1;
  else failures.push(label);
}

function runWorker(
  tsx: string,
  workerScript: string,
  barrier: string,
  worker: string,
  number: string,
  orgId: string,
  dataDir: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(tsx, [workerScript, barrier, worker, number, orgId], {
      cwd: process.cwd(),
      env: { ...process.env, VOXERA_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

function workerResult(output: string) {
  const line = output.split('\n').findLast((row) => row.startsWith('RESULT '));
  if (!line) return undefined;
  return JSON.parse(line.slice('RESULT '.length)) as {
    worker: string;
    ok: boolean;
    reservation?: { id: string; orgId: string; number: string; expiresAt: string };
    conflict?: { orgId?: string; number?: string };
    error?: string;
  };
}

async function waitFor(files: string[], timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!files.every(existsSync)) {
    if (Date.now() > deadline) {
      const missing = files.filter((file) => !existsSync(file));
      throw new Error(`workers did not become ready: ${missing.join(', ')}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'voxera-number-owner-'));
  process.env.VOXERA_DATA_DIR = dataDir;
  const barrier = join(dataDir, 'go');
  const number = '+14155558888';

  try {
    // Initialise schema and indexes before racing the workers. Dynamic imports
    // matter: VOXERA_DATA_DIR must be fixed before db.ts computes its paths.
    const db = await import('../lib/server/db');
    const ownership = await import('../lib/server/number-ownership');
    const driver = db.storeDriver();
    db.list('numberClaims');

    const tsx = resolve('node_modules/.bin/tsx');
    const workerScript = resolve('scripts/number-reservation-worker.ts');
    const first = runWorker(tsx, workerScript, barrier, 'a', number, 'org_race_a', dataDir);
    const second = runWorker(tsx, workerScript, barrier, 'b', number, 'org_race_b', dataDir);
    await waitFor([`${barrier}.a.ready`, `${barrier}.b.ready`]);
    writeFileSync(barrier, 'go');
    const outputs = await Promise.all([first, second]);
    const results = outputs.map((row) => workerResult(row.stdout));
    const winners = results.filter((row) => row?.ok);
    const losers = results.filter((row) => row && !row.ok);

    check(
      'two processes reach the reservation barrier',
      results.every(Boolean),
      outputs.map((row) => `exit=${row.code}`).join(', '),
    );
    check(
      'exactly one concurrent reservation wins',
      winners.length === 1 && losers.length === 1,
      JSON.stringify(results),
    );
    check(
      'the loser observes the deployment-global owner',
      Boolean(losers[0]?.conflict?.orgId) && losers[0]?.conflict?.orgId === winners[0]?.reservation?.orgId,
      `${losers[0]?.conflict?.orgId ?? 'none'} vs ${winners[0]?.reservation?.orgId ?? 'none'}`,
    );

    const afterRace = db.list<{ id: string; orgId: string; number: string; expiresAt: string }>(
      'numberClaims',
      (row) => row.number === number,
    );
    check(
      `${driver} contains one pending owner after the cross-process race`,
      afterRace.length === 1 && afterRace[0].orgId === winners[0]?.reservation?.orgId,
      `${afterRace.length} row(s)`,
    );

    // Age the real winning row. The next preflight must remove it and reserve in
    // one path rather than leaving an expired unique-index blocker behind.
    db.update('numberClaims', afterRace[0].id, { expiresAt: new Date(Date.now() - 1_000).toISOString() });
    const afterExpiry = ownership.reserveNumberClaim({
      number,
      orgId: 'org_after_expiry',
      carrierId: 'car_after_expiry',
      operation: 'purchase',
    });
    check(
      'an expired reservation is swept and the exact number can be retried',
      afterExpiry.ok && afterExpiry.reservation.orgId === 'org_after_expiry',
      JSON.stringify(afterExpiry),
    );
    const rowsAfterExpiry = db.list<{ id: string; orgId: string; number: string }>(
      'numberClaims',
      (row) => row.number === number,
    );
    check(
      'expiry cleanup removes the stale row instead of accumulating claims',
      rowsAfterExpiry.length === 1 && rowsAfterExpiry[0].orgId === 'org_after_expiry',
      JSON.stringify(rowsAfterExpiry),
    );

    // This is the compensation primitive used after a provider mutation fails.
    ownership.releaseNumberReservation(afterExpiry.ok ? afterExpiry.reservation : undefined);
    const afterCompensation = ownership.reserveNumberClaim({
      number,
      orgId: 'org_after_compensation',
      carrierId: 'car_after_compensation',
      operation: 'adopt',
    });
    check(
      'releasing a failed operation reservation permits an exact retry',
      afterCompensation.ok && afterCompensation.reservation.orgId === 'org_after_compensation',
      JSON.stringify(afterCompensation),
    );
    if (afterCompensation.ok) ownership.releaseNumberReservation(afterCompensation.reservation);

    const activeId = 'num_active_a';
    db.insert('numbers', {
      id: activeId,
      orgId: 'org_owner_a',
      number,
      carrierId: 'car_owner_a',
      carrierSid: 'PNownerA',
      status: 'active',
      createdAt: new Date().toISOString(),
    });
    let duplicateRejected = false;
    try {
      db.insert('numbers', {
        id: 'num_active_b_collision',
        orgId: 'org_owner_b',
        number,
        carrierId: 'car_owner_b',
        carrierSid: 'PNownerB',
        status: 'active',
        createdAt: new Date().toISOString(),
      });
    } catch {
      duplicateRejected = true;
    }
    check('the storage index rejects a second active E.164 owner', duplicateRejected);
    const activeClaims = ownership.claimsForNumber(number);
    check(
      'routing resolves to one active owner after the collision',
      activeClaims.length === 1 && activeClaims[0].orgId === 'org_owner_a',
      JSON.stringify(activeClaims.map((row) => row.orgId)),
    );

    db.update('numbers', activeId, { status: 'released' });
    let reused = false;
    try {
      db.insert('numbers', {
        id: 'num_active_b',
        orgId: 'org_owner_b',
        number,
        carrierId: 'car_owner_b',
        carrierSid: 'PNownerB',
        status: 'active',
        createdAt: new Date().toISOString(),
      });
      reused = true;
    } catch {
      reused = false;
    }
    check('explicit release permits a new active owner', reused);
    const reassigned = ownership.claimsForNumber(number);
    check(
      'released history is excluded from inbound routing',
      reassigned.length === 1 && reassigned[0].orgId === 'org_owner_b',
      JSON.stringify(reassigned.map((row) => `${row.orgId}:${row.status}`)),
    );

    // PostgreSQL uses the disposable suite database rather than a temporary file,
    // so remove every fixed-number probe explicitly. SQLite is cleaned by removing
    // its temporary directory below, but closing both engines avoids native handles
    // surviving into process shutdown.
    if (driver === 'postgres') {
      for (const row of db.list<{ id: string; number?: string }>('numberClaims', (candidate) => candidate.number === number)) {
        db.remove('numberClaims', row.id);
      }
      for (const row of db.list<{ id: string; number?: string }>('numbers', (candidate) => candidate.number === number)) {
        db.remove('numbers', row.id);
      }
      db.flushNow();
    }
    db.closeStore();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(`\n${passed} PASS / ${failures.length} FAIL`);
  if (failures.length) {
    failures.forEach((failure) => console.log(`  · ${failure}`));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
