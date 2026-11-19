import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireWriteRole } from '@/lib/server/api';
import { createSeries, type RepeatRule } from '@/lib/server/diary';
import { actorLabel } from '@/lib/server/access-log';
import { providerById, serviceById } from '@/lib/server/practice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KINDS: RepeatRule['every'][] = ['day', 'week', 'fortnight', 'month'];

/**
 * Repeat appointments — the physio every Tuesday for six weeks, the check-up
 * every three months.
 *
 * Clashing occurrences are reported back rather than dropped, so whoever
 * created the series knows the fourth one landed on a public holiday.
 */
export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireWriteRole(ctx);
  if (denied) return denied;
  const body = await readJson<{
    customer?: { name?: string; number?: string; email?: string };
    startsAt?: string;
    durationMinutes?: number;
    serviceId?: string;
    providerId?: string;
    locationId?: string;
    roomId?: string;
    repeat?: { every?: string; count?: number; until?: string };
    externalIdBase?: string;
  }>(req);
  if (body instanceof NextResponse) return body;

  const number = String(body.customer?.number ?? '').replace(/[^\d+]/g, '');
  if (!number) return fail('VALIDATION_ERROR', '`customer.number` is required.', { param: 'customer.number', requestId: ctx.requestId });
  const startsAt = String(body.startsAt ?? '');
  if (Number.isNaN(new Date(startsAt).getTime())) return fail('VALIDATION_ERROR', '`startsAt` must be an ISO instant.', { param: 'startsAt', requestId: ctx.requestId });
  const every = body.repeat?.every as RepeatRule['every'];
  if (!KINDS.includes(every)) return fail('VALIDATION_ERROR', `\`repeat.every\` must be one of: ${KINDS.join(', ')}.`, { param: 'repeat.every', requestId: ctx.requestId });
  if (body.providerId && !providerById(ctx.orgId, body.providerId)) return fail('NOT_FOUND', `No provider with id ${body.providerId}.`, { param: 'providerId', requestId: ctx.requestId });
  if (body.serviceId && !serviceById(ctx.orgId, body.serviceId)) return fail('NOT_FOUND', `No service with id ${body.serviceId}.`, { param: 'serviceId', requestId: ctx.requestId });

  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  const result = createSeries({
    orgId: ctx.orgId,
    externalIdBase: body.externalIdBase ?? `ser-${Date.now().toString(36)}`,
    customer: { name: body.customer?.name ?? 'Client', number, email: body.customer?.email },
    serviceId: body.serviceId,
    providerId: body.providerId,
    locationId: body.locationId,
    roomId: body.roomId,
    startsAt: new Date(startsAt).toISOString(),
    durationMinutes: body.durationMinutes,
    repeat: { every, count: body.repeat?.count, until: body.repeat?.until },
    actor,
    actorName,
  });
  if (!result.booked.length) {
    return fail('CONFLICT', result.skipped[0]?.reason ?? 'None of those times were free.', {
      param: 'startsAt',
      detail: `Skipped: ${result.skipped.map((s) => s.startsAt).join(', ')}`,
      requestId: ctx.requestId,
    });
  }
  return ok(result, { requestId: ctx.requestId, status: 201 });
}
