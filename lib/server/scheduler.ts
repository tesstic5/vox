/**
 * The scheduler.
 *
 * Until now the platform had a sweep that ran when it felt like it and a set of
 * routes a cron *could* call — which meant that in practice nothing happened
 * unless somebody pressed a button. This is the missing piece: named jobs, each
 * with a cadence, a last run, a next run and a result, all persisted so a restart
 * does not lose the schedule and an operator can see why nothing went out.
 *
 * Design notes worth keeping:
 *
 *   - **Jobs are per workspace** (except retention, which is about the file
 *     itself). One practice's reminder cadence has nothing to do with another's.
 *   - **State lives in the database**, not in memory, so two processes and a
 *     restart agree about what has run.
 *   - **A job that throws is a job that failed**, recorded as such. The tick
 *     continues: one broken job must not stop the others.
 *   - **`everyMinutes` is a floor, not a promise.** Ticks are cheap; a job whose
 *     time has not come is skipped.
 */

import { list, update, insert, nowIso, type Doc } from './db';
import { audit } from './audit';
import { deliverDueMessages } from './messages';
import { queueDueReminders } from './maintenance';
import { queueNoShowFollowUps, queueVisitFollowUps } from './outreach-rules';
import { queueOverdueChases } from './money-chase';
import { queueRecalls } from './recalls';
import { sweep } from './maintenance';
import { runCampaign } from './booking-campaigns';
import { describeBooking, type BookingDoc } from './bookings';
import { runDueDomainJobs } from './domain-jobs';

export type JobName =
  | 'retention'
  | 'deliver-messages'
  | 'queue-reminders'
  | 'no-show-followups'
  | 'visit-followups'
  | 'overdue-chase'
  | 'recalls'
  | 'campaign-tick'
  | 'domain-jobs';

export type JobState = Doc & {
  orgId: string;
  name: JobName;
  enabled: boolean;
  everyMinutes: number;
  lastRunAt?: string;
  nextRunAt?: string;
  lastResult?: { at: string; ok: boolean; detail: string };
  runs: number;
  failures: number;
};

export type JobDefinition = {
  name: JobName;
  label: string;
  everyMinutes: number;
  /** Retention is about the database file, not about one workspace. */
  global?: boolean;
  description: string;
  run: (orgId: string) => Promise<string> | string;
};

/**
 * The menu. Adding a job means adding one entry here — the scheduler, the API and
 * the dashboard pick it up with no further wiring.
 */
export const JOBS: JobDefinition[] = [
  {
    name: 'deliver-messages',
    label: 'Send queued messages',
    everyMinutes: 2,
    description: 'Sends everything that has come due and not been sent, re-checking consent first.',
    run: async (orgId) => {
      const result = await deliverDueMessages({ orgId, limit: 25 });
      return `${result.sent} sent, ${result.blocked} blocked, ${result.failed} failed`;
    },
  },
  {
    name: 'queue-reminders',
    label: 'Queue appointment reminders',
    everyMinutes: 15,
    description: 'Queues a reminder for every appointment inside the lead window — once per appointment.',
    run: (orgId) => {
      const queued = queueDueReminders(Date.now(), orgId);
      return queued ? `${queued} queued` : 'nothing due';
    },
  },
  {
    name: 'no-show-followups',
    label: 'Follow up missed appointments',
    everyMinutes: 30,
    description: 'Texts the people who did not turn up, while the appointment is still recent.',
    run: (orgId) => {
      const queued = queueNoShowFollowUps(Date.now(), orgId);
      return queued ? `${queued} queued` : 'nothing to follow up';
    },
  },
  {
    name: 'visit-followups',
    label: 'Follow up completed visits',
    everyMinutes: 30,
    description: 'The "thanks for coming in" message. Off unless the workspace switches it on.',
    run: (orgId) => {
      const queued = queueVisitFollowUps(Date.now(), orgId);
      return queued ? `${queued} queued` : 'nothing to follow up';
    },
  },
  {
    name: 'overdue-chase',
    label: 'Chase unpaid invoices',
    everyMinutes: 60,
    description:
      'One message per step of the practice\'s schedule per invoice — before it falls due, on the day, then after — with the payment link. A paid bill takes its chase back.',
    run: (orgId) => {
      const result = queueOverdueChases(Date.now(), orgId);
      if (result.skipped) return result.skipped;
      const parts = [
        result.queued ? `${result.queued} queued` : null,
        result.refreshed ? `${result.refreshed} refreshed` : null,
        result.withdrawn ? `${result.withdrawn} withdrawn` : null,
      ].filter(Boolean);
      return parts.length ? parts.join(', ') : 'nothing to chase';
    },
  },
  {
    name: 'recalls',
    label: 'Recall lapsed clients',
    everyMinutes: 24 * 60,
    description:
      'Once a day, texts the clients who are past the recall window for the service they were last seen for — never somebody who is already booked, never twice inside the cooldown, and never more than the daily ceiling. Off until the practice switches it on.',
    run: (orgId) => {
      const result = queueRecalls(Date.now(), orgId);
      const run = Array.isArray(result) ? result.find((r) => r.orgId === orgId) : result;
      if (!run || run.disabled) return 'the recall rule is switched off for this workspace';
      const parts = [
        run.queued ? `${run.queued} queued` : null,
        run.skipped.length ? `${run.skipped.length} held` : null,
        run.blocked.length ? `${run.blocked.length} blocked` : null,
        run.remaining ? `${run.remaining} left for the next run` : null,
      ].filter(Boolean);
      return parts.length ? parts.join(', ') : 'nobody was due a recall';
    },
  },
  {
    name: 'campaign-tick',
    label: 'Run due campaigns',
    everyMinutes: 5,
    description: 'Ticks every active campaign. A paused campaign, or one outside its calling hours, does nothing.',
    run: async (orgId) => {
      const campaigns = list<Doc & { id: string; status?: string; name?: string }>('bookingCampaigns', (c) => c.orgId === orgId && c.status === 'active');
      if (!campaigns.length) return 'no active campaigns';
      const results: string[] = [];
      for (const campaign of campaigns) {
        const outcome = await runCampaign({
          orgId,
          campaignId: campaign.id,
          dryRun: false,
          describe: (booking: BookingDoc) => describeBooking(booking),
        });
        results.push(`${campaign.name ?? campaign.id}: ${outcome.dialled} dialled${outcome.reason ? ` (${outcome.reason})` : ''}`);
      }
      return results.join('; ');
    },
  },
  {
    name: 'domain-jobs',
    label: 'Clinical and document jobs',
    everyMinutes: 1,
    description: 'Claims durable document scans and clinical background work using revision-checked leases.',
    run: async (orgId) => {
      const result = await runDueDomainJobs(orgId, { limit: 10 });
      return result.claimed
        ? `${result.completed} completed, ${result.retried} retrying, ${result.failed} failed`
        : 'nothing due';
    },
  },
  {
    name: 'retention',
    label: 'Retention sweep', 
    everyMinutes: 6 * 60,
    global: true,
    description: 'Expires sessions, request logs, audit rows beyond their window, and purges records past retention.',
    run: () => {
      const result = sweep();
      const total = Object.values(result.removed).reduce((a, b) => a + b, 0);
      return total ? `swept ${total} row(s)` : 'nothing to sweep';
    },
  },
];

export function jobByName(name: string) {
  return JOBS.find((job) => job.name === name);
}

/** Every workspace the scheduler should act for. */
function scopedOrgs(explicit?: string) {
  if (explicit) return [explicit].filter((id) => list<Doc>('orgs', (o) => o.id === id).length > 0);
  return list<Doc & { id: string }>('orgs').map((o) => o.id);
}

export function jobStates(orgId: string): JobState[] {
  const states = list<JobState>('scheduler', (s) => s.orgId === orgId);
  return JOBS.map((definition) => {
    const existing = states.find((s) => s.name === definition.name);
    return (
      existing ?? {
        id: `job_${orgId}_${definition.name}`,
        orgId,
        name: definition.name,
        enabled: true,
        everyMinutes: definition.everyMinutes,
        runs: 0,
        failures: 0,
      }
    );
  });
}

function saveState(orgId: string, name: JobName, patch: Partial<JobState>) {
  const id = `job_${orgId}_${name}`;
  const existing = list<JobState>('scheduler', (s) => s.id === id)[0];
  if (existing) return update<JobState>('scheduler', id, { ...patch, updatedAt: nowIso() } as never);
  return insert<JobState>('scheduler', {
    id,
    orgId,
    name,
    enabled: true,
    everyMinutes: patch.everyMinutes ?? jobByName(name)?.everyMinutes ?? 15,
    runs: 0,
    failures: 0,
    ...patch,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  } as JobState);
}

export function setJobEnabled(orgId: string, name: JobName, enabled: boolean, actor: string) {
  const state = saveState(orgId, name, { enabled });
  audit({ orgId, actor, action: 'scheduler.job_updated', target: `${name}`, detail: enabled ? 'enabled' : 'paused' });
  return state;
}

export type JobRun = { name: JobName; orgId: string; ok: boolean; detail: string; ms: number };

/** Runs one job now, whatever the schedule says. */
export async function runJob(
  orgId: string,
  name: JobName,
  options: { force?: boolean; actor?: string; /** Reuse the tick's snapshot instead of scanning scheduler state once per job. */ state?: JobState } = {}
): Promise<JobRun> {
  const definition = jobByName(name);
  const started = Date.now();
  if (!definition) return { name, orgId, ok: false, detail: `No job called ${name}.`, ms: 0 };

  const state = options.state ?? jobStates(orgId).find((s) => s.name === name);
  if (state && !state.enabled && !options.force) {
    return { name, orgId, ok: false, detail: 'This job is paused.', ms: 0 };
  }

  try {
    const detail = await definition.run(orgId);
    const ms = Date.now() - started;
    saveState(orgId, name, {
      lastRunAt: nowIso(),
      nextRunAt: new Date(Date.now() + definition.everyMinutes * 60_000).toISOString(),
      lastResult: { at: nowIso(), ok: true, detail },
      runs: (state?.runs ?? 0) + 1,
    });
    if (options.actor) audit({ orgId, actor: options.actor, action: 'scheduler.ran_job', target: name, detail });
    return { name, orgId, ok: true, detail, ms };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'job threw';
    saveState(orgId, name, {
      lastRunAt: nowIso(),
      nextRunAt: new Date(Date.now() + definition.everyMinutes * 60_000).toISOString(),
      lastResult: { at: nowIso(), ok: false, detail },
      failures: (state?.failures ?? 0) + 1,
    });
    return { name, orgId, ok: false, detail, ms: Date.now() - started };
  }
}

/**
 * One tick: everything that is due, for every workspace that has it switched on.
 *
 * The retention job runs once rather than per workspace — it is about the file,
 * and running it N times would be N times the same work.
 */
export async function tick(orgId?: string, now = Date.now()): Promise<JobRun[]> {
  const runs: JobRun[] = [];
  let retentionDone = false;
  for (const target of scopedOrgs(orgId)) {
    // One scheduler snapshot per workspace. The previous loop rebuilt this list
    // for every one of the eight definitions, turning each minute into 8 × N
    // scans of the same collection before any useful work began.
    const states = jobStates(target);
    for (const definition of JOBS) {
      if (definition.global) {
        if (retentionDone) continue;
      }
      const state = states.find((s) => s.name === definition.name);
      if (!state?.enabled) continue;
      const dueAt = state.lastRunAt ? new Date(state.lastRunAt).getTime() + definition.everyMinutes * 60_000 : 0;
      if (dueAt > now) continue;
      runs.push(await runJob(target, definition.name, { state }));
      if (definition.global) retentionDone = true;
    }
  }
  return runs;
}

/**
 * Starts the timer that drives everything.
 *
 * Sixty seconds, because the shortest cadence is a couple of minutes and being a
 * minute late for a reminder is not a thing anybody notices. Unref'd so it never
 * holds the process open.
 */
export function startScheduler(intervalMs = 60_000, hooks: { onRun?: (failed: boolean) => void } = {}) {
  let running = false;
  const run = async () => {
    if (running) return; // a slow tick must not overlap itself
    running = true;
    try {
      const runs = await tick();
      // Zero-work delivery and disabled optional rules are the normal minute-by-
      // minute case, not an operator event. Keep failures and actual changes so a
      // large tenant set cannot flood startup logs with hundreds of identical
      // "0 sent" lines while still hiding the one run that failed.
      const quiet = /^(?:nothing|no active|the recall rule is switched off|0 sent, 0 blocked, 0 failed)/;
      const interesting = runs.filter((r) => !r.ok || !quiet.test(r.detail));
      if (interesting.length) {
        console.log(
          `  scheduler    : ${interesting
            .map((r) => `${r.name}${r.ok ? '' : ' FAILED'} (${r.detail})`)
            .join(', ')}`
        );
      }
      hooks.onRun?.(runs.some((r) => !r.ok));
    } catch (error) {
      hooks.onRun?.(true);
      console.error('  scheduler    : tick failed —', error instanceof Error ? error.message : error);
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
