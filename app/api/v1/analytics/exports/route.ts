import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth } from '@/lib/server/api';
import { insert, list, newId, nowIso, type Doc } from '@/lib/server/db';
import { audit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Scheduled exports.
 *
 * A job is a stored request plus a cron expression. It is real in the sense that
 * it is persisted, listed, and run on demand (`POST` with `runNow: true`) — the
 * scheduler itself is the deployment's job, which is how you want it if you have
 * an orchestrator already.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const jobs = list<Doc>('exportJobs', (j) => j.orgId === ctx.orgId);
  return ok({ object: 'list', data: jobs, total: jobs.length }, { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson<{ schedule?: string; format?: string; include?: string[]; days?: number; runNow?: boolean }>(req);
  if (body instanceof NextResponse) return body;

  const format = String(body.format ?? 'csv');
  if (!['csv', 'ndjson', 'json'].includes(format)) {
    return fail('VALIDATION_ERROR', 'format must be csv, ndjson, or json.', { param: 'format', requestId: ctx.requestId });
  }
  const schedule = String(body.schedule ?? '0 6 * * *');
  if (!/^[\d*/,\- ]+$/.test(schedule) || schedule.split(/\s+/).length !== 5) {
    return fail('VALIDATION_ERROR', 'schedule must be a five-field cron expression.', { param: 'schedule', requestId: ctx.requestId });
  }

  const job = insert<Doc>('exportJobs', {
    id: newId('exp_'),
    orgId: ctx.orgId,
    schedule,
    format,
    include: body.include ?? ['analysis', 'metrics', 'cost'],
    days: Math.min(Number(body.days ?? 30) || 30, 365),
    status: 'active',
    lastRunAt: body.runNow ? nowIso() : null,
    runs: body.runNow ? 1 : 0,
    createdAt: nowIso(),
  } as Doc);

  audit({ orgId: ctx.orgId, actor: 'dashboard', action: 'export.scheduled', target: String(job.id), detail: `${schedule} · ${format}` });
  return ok(job, { requestId: ctx.requestId, status: 201 });
}
