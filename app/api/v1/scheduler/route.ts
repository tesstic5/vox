import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireWriteRole } from '@/lib/server/api';
import { actorLabel } from '@/lib/server/access-log';
import { JOBS, jobStates, runJob, setJobEnabled, tick, type JobName } from '@/lib/server/scheduler';
import { dueRuleNames, outreachRules } from '@/lib/server/outreach-rules';
import { messagingTimezone } from '@/lib/server/messages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The scheduler, visible.
 *
 * "Why did nobody get a reminder?" is answerable here: each job shows whether it
 * is on, when it last ran, what it said, and when it will run again. `POST
 * {action:'run'}` runs one job now; `{action:'tick'}` runs everything that is due,
 * which is what a deployment without a long-lived process should point its cron at.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const states = jobStates(ctx.orgId);
  const now = Date.now();
  const jobs = JOBS.map((definition) => {
    const state = states.find((s) => s.name === definition.name);
    const lastRunAt = state?.lastRunAt;
    const dueAt = lastRunAt ? new Date(lastRunAt).getTime() + definition.everyMinutes * 60_000 : now;
    return {
      name: definition.name,
      label: definition.label,
      description: definition.description,
      everyMinutes: definition.everyMinutes,
      global: Boolean(definition.global),
      enabled: state?.enabled !== false,
      runs: state?.runs ?? 0,
      failures: state?.failures ?? 0,
      lastRunAt: lastRunAt ?? null,
      lastResult: state?.lastResult ?? null,
      nextRunAt: new Date(Math.max(dueAt, now)).toISOString(),
      dueNow: dueAt <= now,
    };
  });

  return ok(
    {
      jobs,
      // Whether the process is actually ticking. A deployment that set
      // VOXERA_SCHEDULER=0 still answers here — it just says so.
      running: process.env.VOXERA_SCHEDULER !== '0',
      tickSeconds: 60,
      rules: outreachRules(ctx.orgId),
      rulesActive: dueRuleNames(ctx.orgId),
      timezone: messagingTimezone(ctx.orgId),
      serverTime: new Date(now).toISOString(),
    },
    { requestId: ctx.requestId }
  );
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireWriteRole(ctx);
  if (denied) return denied;
  const body = await readJson<{ action?: 'run' | 'tick' | 'toggle'; job?: string; enabled?: boolean; force?: boolean }>(req);
  if (body instanceof NextResponse) return body;
  const { actor } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });

  if (body.action === 'toggle') {
    const job = JOBS.find((j) => j.name === body.job);
    if (!job) return fail('NOT_FOUND', `No job called ${String(body.job ?? '')}.`, { requestId: ctx.requestId });
    const state = setJobEnabled(ctx.orgId, job.name as JobName, body.enabled !== false, actor);
    return ok({ job: { name: state?.name ?? job.name, enabled: state?.enabled !== false } }, { requestId: ctx.requestId });
  }

  if (body.action === 'run') {
    const job = JOBS.find((j) => j.name === body.job);
    if (!job) return fail('NOT_FOUND', `No job called ${String(body.job ?? '')}.`, { requestId: ctx.requestId });
    // A paused job stays paused: "why is nothing going out?" must have exactly one
    // answer, and it is the switch. `force: true` is the operator saying "I know,
    // do it once anyway" — and the audit trail keeps that distinction.
    const result = await runJob(ctx.orgId, job.name as JobName, { actor, force: body.force === true });
    return ok({ run: result, jobs: jobStates(ctx.orgId) }, { requestId: ctx.requestId });
  }

  // The cron target. Running everything that is due twice in a row is safe by
  // construction — every job is idempotent — which is the property that makes it
  // reasonable to expose at all.
  const runs = await tick(ctx.orgId);
  return ok(
    {
      ran: runs.length,
      runs,
      summary: runs.map((r) => `${r.ok ? '✓' : '✗'} ${r.name}: ${r.detail}`),
    },
    { requestId: ctx.requestId }
  );
}
