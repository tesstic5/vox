import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireApiKeyScopes, requireAuth, requirePermission } from '@/lib/server/api';
import { STATUS_TRANSITIONS, setAppointmentStatus } from '@/lib/server/diary';
import { bookingById } from '@/lib/server/bookings';
import { requireBookingActionRole } from '@/lib/server/booking-access';
import { actorLabel } from '@/lib/server/access-log';
import { offerFreedSlot } from '@/lib/server/wait-offers';
import type { BookingStatus } from '@/lib/server/bookings';
import { scheduleGatewayFor } from '@/lib/server/schedule-gateway';
import { ScheduleError, stableHash } from '@/lib/server/schedule-core';
import { assignedUserIdsForCase } from '@/lib/server/cases';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The lifecycle: booked → confirmed → arrived → completed, or off the rails into
 * cancelled / no-show.
 *
 * Transitions are checked rather than accepted wholesale, because "completed"
 * after "cancelled with no appointment in between" is a data-entry mistake that
 * reports itself as a treatment that never happened.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['bookings:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const booking = bookingById(ctx.orgId, id);
  if (!booking) return fail('NOT_FOUND', `No appointment with id ${id}.`, { requestId: ctx.requestId });
  const denied = requireBookingActionRole(ctx, booking);
  if (denied) return denied;
  if (booking.caseId && booking.clientId) {
    const keyDenied = requireApiKeyScopes(ctx, ['cases:write']);
    if (keyDenied) return keyDenied;
    const caseDenied = requirePermission(ctx, 'cases.write', {
      area: 'cases', patientId: booking.clientId, assignedUserIds: assignedUserIdsForCase(ctx.orgId, booking.caseId),
    });
    if (caseDenied) return caseDenied;
  }
  const body = await readJson<{ status?: string; note?: string; fundingOverrideReason?: string }>(req);
  if (body instanceof NextResponse) return body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail('VALIDATION_ERROR', 'Request body must be an object.', { param: 'body', requestId: ctx.requestId });
  }
  const unknown = Object.keys(body).find((key) => !['status', 'note', 'fundingOverrideReason'].includes(key));
  if (unknown) return fail('VALIDATION_ERROR', `\`${unknown}\` is not supported.`, { param: unknown, requestId: ctx.requestId });
  if (body.note !== undefined && String(body.note).length > 1_000) {
    return fail('VALIDATION_ERROR', '`note` is too long.', { param: 'note', requestId: ctx.requestId });
  }
  const overrideReason = String(body.fundingOverrideReason ?? '').trim();
  if (overrideReason && (overrideReason.length > 500 || /[\u0000-\u001f]/.test(overrideReason))) {
    return fail('VALIDATION_ERROR', '`fundingOverrideReason` must be plain text up to 500 characters.', { param: 'fundingOverrideReason', requestId: ctx.requestId });
  }
  if (overrideReason) {
    if (ctx.auth !== 'session' || !booking.clientId) return fail('FORBIDDEN', 'Funding overrides require an authenticated staff session.', { requestId: ctx.requestId });
    const overrideDenied = requirePermission(ctx, 'funding.override', { area: 'cases', patientId: booking.clientId });
    if (overrideDenied) return overrideDenied;
  }

  const status = body.status as BookingStatus;
  if (!Object.keys(STATUS_TRANSITIONS).includes(String(status))) {
    return fail('VALIDATION_ERROR', `\`status\` must be one of: ${Object.keys(STATUS_TRANSITIONS).join(', ')}.`, { param: 'status', requestId: ctx.requestId });
  }
  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  const gateway = scheduleGatewayFor(ctx.orgId);
  let result: { ok: true; booking: typeof booking; changed: boolean } | ReturnType<typeof setAppointmentStatus>;
  if (status === 'cancelled') {
    const key = req.headers.get('idempotency-key')?.trim() || `staff-cancel:${stableHash([ctx.orgId, id, body.note ?? ''])}`;
    try {
      const cancelled = await gateway.cancelAppointment({ bookingId: id, reason: body.note, fundingOverrideReason: overrideReason || undefined }, {
        origin: 'staff', actor, requestId: ctx.requestId, idempotencyKey: key,
      });
      result = { ok: true, booking: cancelled.booking, changed: true };
    } catch (error) {
      if (error instanceof ScheduleError) return fail(error.code === 'CONFLICT' ? 'CONFLICT' : 'SCHEDULE_UNAVAILABLE', error.message, { requestId: ctx.requestId });
      return fail('CONFLICT', error instanceof Error ? error.message : 'Could not cancel appointment.', { requestId: ctx.requestId });
    }
  } else {
    result = setAppointmentStatus({
      orgId: ctx.orgId, id, status, note: body.note, actor, actorName,
      fundingOverride: overrideReason ? { by: actor, reason: overrideReason } : undefined,
    });
    if (!result.ok) {
      if (result.error === 'not_found') return fail('NOT_FOUND', result.message, { requestId: ctx.requestId });
      return fail('CONFLICT', result.message, { param: 'status', requestId: ctx.requestId });
    }
  }

  // A cancellation is the one status with somebody waiting behind it: the people
  // whose window this slot falls inside are texted their own link, and the answer
  // says who got one so the desk can see the offer leaving rather than infer it.
  const offers = status === 'cancelled' ? offerFreedSlot({ orgId: ctx.orgId, booking: result.booking, actor, actorName }) : undefined;
  return ok(
    {
      ...result,
      offers: offers
        ? {
            offered: offers.offered.length,
            alreadyOffered: offers.alreadyOffered,
            skipped: offers.skipped,
            names: offers.offered.map((o) => o.name),
            /**
             * A seat is not a slot: the *slot* wait list is never texted about a
             * class hour. The place itself has its own queue, so the answer says
             * which of the two things happened rather than leaving an empty list
             * to interpret.
             */
            ...(offers.classSeat
              ? {
                  classSeat: true,
                  classOffers: offers.classOffers ?? 0,
                  note: offers.classOffers
                    ? 'A place in a class came free — the class keeps its hour, and the next person on its wait list was offered the place.'
                    : 'A place in a class was given back — the class keeps its hour, and nobody is waiting for a place in it.',
                }
              : {}),
          }
        : undefined,
    },
    { requestId: ctx.requestId }
  );
}
