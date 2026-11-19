import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, requireAuth } from '@/lib/server/api';
import { scheduleGatewayFor } from '@/lib/server/schedule-gateway';
import { ScheduleError } from '@/lib/server/schedule-core';
import { practiceProfile, serviceById, termsForOrg } from '@/lib/server/practice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /v1/availability — the practice's open slots.
 *
 * This is the same engine the AI tools and the diary use, deliberately: a
 * booking page that disagrees with the receptionist's screen by even one slot is
 * how double-bookings happen.
 *
 * Query: `serviceId`, `providerId`, `locationId`, `from` (`YYYY-MM-DD` or ISO),
 * `days` (1–31), `limit`, `includeTaken`.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);

  const serviceId = url.searchParams.get('serviceId') ?? undefined;
  if (serviceId && !serviceById(ctx.orgId, serviceId)) {
    return fail('NOT_FOUND', `No service with id ${serviceId}.`, { param: 'serviceId', requestId: ctx.requestId });
  }
  const days = Number(url.searchParams.get('days') ?? 7);
  if (url.searchParams.get('days') && (!Number.isFinite(days) || days < 1 || days > 31)) {
    return fail('VALIDATION_ERROR', '`days` must be between 1 and 31.', { param: 'days', requestId: ctx.requestId });
  }

  let result;
  try {
    result = await scheduleGatewayFor(ctx.orgId).findSlots({
      serviceId,
      providerId: url.searchParams.get('providerId') ?? undefined,
      locationId: url.searchParams.get('locationId') ?? undefined,
      from: url.searchParams.get('from') ?? undefined,
      days,
      limit: Number(url.searchParams.get('limit') ?? 20),
      includeTaken: url.searchParams.get('includeTaken') === 'true',
    }, { origin: 'staff', actor: ctx.user?.email ?? ctx.key?.id, requestId: ctx.requestId });
  } catch (error) {
    return fail(error instanceof ScheduleError ? 'SCHEDULE_UNAVAILABLE' : 'VALIDATION_ERROR', error instanceof Error ? error.message : 'Could not check schedule availability.', { requestId: ctx.requestId });
  }

  const profile = practiceProfile(ctx.orgId);
  return ok(
    {
      object: 'list',
      data: result.slots,
      total: result.slots.length,
      timezone: result.timezone,
      service: result.service,
      scanned: result.scanned,
      reason: result.reason,
      policy: { minNoticeMinutes: profile.minNoticeMinutes, maxAdvanceDays: profile.maxAdvanceDays, slotStepMinutes: profile.slotStepMinutes },
      terms: termsForOrg(ctx.orgId),
    },
    { requestId: ctx.requestId }
  );
}
