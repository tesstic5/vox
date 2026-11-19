import { NextResponse, type NextRequest } from 'next/server';
import { audit } from '@/lib/server/audit';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { deadLettersFor, resolveDeadLetter, retryDeadLetter, type DeadLetterDoc } from '@/lib/server/domain-jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function publicDeadLetter(row: DeadLetterDoc) {
  return {
    id: row.id,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    sourceKind: row.sourceKind,
    redactedFailure: row.redactedFailure,
    firstFailedAt: row.firstFailedAt,
    lastFailedAt: row.lastFailedAt,
    attempts: row.attempts,
    status: row.status,
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedBy,
    resolution: row.resolution,
    revision: row.revision,
  };
}

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session' || !ctx.user) {
    return fail('FORBIDDEN', 'Clinical job operations require a signed-in person.', { requestId: ctx.requestId });
  }
  const denied = requirePermission(ctx, 'privacy.manage');
  if (denied) return denied;
  const value = new URL(req.url).searchParams.get('status') ?? 'open';
  if (!['open', 'resolved', 'all'].includes(value)) {
    return fail('VALIDATION_ERROR', '`status` must be open, resolved or all.', { param: 'status', requestId: ctx.requestId });
  }
  const all = deadLettersFor(ctx.orgId, value as 'open' | 'resolved' | 'all');
  const data = all.slice(0, 200).map(publicDeadLetter);
  return ok(
    { object: 'list', data, total: all.length, has_more: all.length > data.length },
    { requestId: ctx.requestId, headers: { 'cache-control': 'no-store' } },
  );
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session' || !ctx.user) {
    return fail('FORBIDDEN', 'Clinical job operations require a signed-in person.', { requestId: ctx.requestId });
  }
  const denied = requirePermission(ctx, 'privacy.manage');
  if (denied) return denied;
  const body = await readJson<{
    action?: 'retry' | 'resolve'; id?: string; expectedRevision?: number; reason?: string;
  }>(req);
  if (body instanceof NextResponse) return body;
  if (!['retry', 'resolve'].includes(String(body.action ?? ''))) {
    return fail('VALIDATION_ERROR', '`action` must be retry or resolve.', { param: 'action', requestId: ctx.requestId });
  }
  if (!Number.isSafeInteger(body.expectedRevision)) {
    return fail('VALIDATION_ERROR', '`expectedRevision` is required.', { param: 'expectedRevision', requestId: ctx.requestId });
  }
  try {
    if (body.action === 'retry') {
      const saved = retryDeadLetter({
        orgId: ctx.orgId,
        id: String(body.id ?? ''),
        expectedRevision: body.expectedRevision!,
        actor: ctx.user.email,
        reason: String(body.reason ?? ''),
      });
      audit({
        orgId: ctx.orgId, actor: ctx.user.email, action: 'clinical_job.dead_letter.retried',
        target: saved.deadLetter.id, detail: `job=${saved.job.id};type=${saved.job.type}`,
      });
      return ok(
        { deadLetter: publicDeadLetter(saved.deadLetter), job: { id: saved.job.id, type: saved.job.type, status: saved.job.status, runAt: saved.job.runAt, revision: saved.job.revision } },
        { requestId: ctx.requestId, headers: { 'cache-control': 'no-store' } },
      );
    }
    const saved = resolveDeadLetter({
      orgId: ctx.orgId,
      id: String(body.id ?? ''),
      expectedRevision: body.expectedRevision!,
      actor: ctx.user.email,
      resolution: String(body.reason ?? ''),
    });
    audit({ orgId: ctx.orgId, actor: ctx.user.email, action: 'clinical_job.dead_letter.resolved', target: saved.id, detail: saved.sourceKind });
    return ok({ deadLetter: publicDeadLetter(saved) }, { requestId: ctx.requestId, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The dead letter could not be changed.';
    const code = message.includes('not found') ? 'NOT_FOUND' : message.includes('changed') || message.includes('already') || message.includes('no longer') ? 'CONFLICT' : 'VALIDATION_ERROR';
    return fail(code, message, { requestId: ctx.requestId });
  }
}
