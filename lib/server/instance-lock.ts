/**
 * One owner for the scheduler.
 *
 * The store is safe to share now — SQLite's WAL mode is designed for several
 * connections, and the engine detects another process's commits. **The scheduler
 * is not.** It ticks every minute and sends reminders, follow-ups, campaign
 * dialling and the send queue; two instances ticking means every reminder is sent
 * twice, which a practice experiences as texting its patients in duplicate.
 *
 * So the rule is: any number of web replicas, exactly one job runner. This module
 * decides which process owns it, using an exclusive lock file beside the store —
 * the same machine only, which is all the store supports anyway.
 *
 *   - First process in: owns the scheduler, writes a heartbeat every 30 s.
 *   - Second process: does not own it, says so once, and runs with the scheduler
 *     disabled. It still serves every request correctly.
 *   - A process that died holding it: the heartbeat goes stale after 90 s and the
 *     next boot takes over.
 *
 * `VOXERA_SCHEDULER=0` still means "do not run jobs" even for the owner, which is
 * how the offline gates and the backup sidecar work.
 */

import fs from 'node:fs';
import path from 'node:path';
import { dataPath } from './paths';
import { dedicatedPostgresClient } from './postgres';

const LOCK = dataPath('.scheduler.lock');
const HEARTBEAT_MS = 30_000;
/** A lock older than this has no live owner — three missed heartbeats. */
const STALE_MS = 90_000;

type Holder = { pid: number; startedAt: string; host: string };

function readHolder(): Holder | null {
  try {
    return JSON.parse(fs.readFileSync(LOCK, 'utf8')) as Holder;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 asks "may I signal this pid" without sending anything.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to somebody else — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function stale(): boolean {
  try {
    return Date.now() - fs.statSync(LOCK).mtimeMs > STALE_MS;
  } catch {
    return false;
  }
}

/** PostgreSQL advisory locks survive containers but release with the connection. */
function claimPostgresScheduler(): { owns: boolean; reason: string; release?: () => void } {
  let client: ReturnType<typeof dedicatedPostgresClient>;
  try {
    client = dedicatedPostgresClient('voxera-scheduler-lock');
    const row = client.query<{ owns: boolean | string }>(
      "SELECT pg_try_advisory_lock(hashtext('voxera'), hashtext('scheduler')) AS owns"
    )[0];
    const owns = row?.owns === true || row?.owns === 't' || row?.owns === 'true';
    if (!owns) {
      client.close();
      return { owns: false, reason: 'another deployment instance owns the PostgreSQL scheduler lease' };
    }
  } catch (error) {
    return { owns: false, reason: `could not acquire the PostgreSQL scheduler lease (${error instanceof Error ? error.message : error})` };
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      client.query("SELECT pg_advisory_unlock(hashtext('voxera'), hashtext('scheduler'))");
    } catch {
      /* closing the connection releases it anyway */
    }
    try {
      client.close();
    } catch {
      /* already closed */
    }
  };
  process.once('exit', release);
  process.once('SIGTERM', release);
  process.once('SIGINT', release);
  return { owns: true, reason: 'this process owns the PostgreSQL scheduler lease', release };
}

/**
 * Try to become the job runner.
 *
 * Returns whether this process owns the scheduler, and — when it does not — who
 * does, so the log line can name the process rather than saying "busy".
 */
export function claimScheduler(): { owns: boolean; holder?: Holder; reason: string; release?: () => void } {
  if (process.env.VOXERA_STORE === 'postgres') return claimPostgresScheduler();
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  const mine: Holder = { pid: process.pid, startedAt: new Date().toISOString(), host: osHost() };

  const existing = readHolder();
  const occupied = existing ? pidAlive(existing.pid) && !stale() : false;

  if (occupied && existing && existing.pid !== process.pid) {
    return { owns: false, holder: existing, reason: 'another live instance owns the scheduler' };
  }

  // Nothing live holds it: take it. O_EXCL would be stricter, but a lock left by a
  // process that died cannot be removed with O_EXCL, and the staleness check above
  // already covers the race that matters.
  try {
    fs.rmSync(LOCK, { force: true });
    fs.writeFileSync(LOCK, JSON.stringify(mine), { mode: 0o600 });
  } catch (error) {
    return { owns: false, reason: `could not write the scheduler lock (${error instanceof Error ? error.message : error})` };
  }

  const heartbeat = setInterval(() => {
    try {
      const now = new Date();
      fs.utimesSync(LOCK, now, now);
    } catch {
      // The lock vanished (somebody deleted it, or the volume was remounted). Put
      // it back rather than silently losing ownership half way through a run.
      try {
        fs.writeFileSync(LOCK, JSON.stringify(mine), { mode: 0o600 });
      } catch {
        /* nothing more to do */
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const release = () => {
    clearInterval(heartbeat);
    const holder = readHolder();
    if (holder?.pid === process.pid) {
      try {
        fs.rmSync(LOCK, { force: true });
      } catch {
        /* already gone */
      }
    }
  };
  process.on('exit', release);
  process.on('SIGTERM', release);
  process.on('SIGINT', release);

  return { owns: true, reason: 'this process owns the scheduler', release };
}

function osHost(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require('node:os') as typeof import('node:os')).hostname();
  } catch {
    return 'unknown';
  }
}
