import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireApiKeyScopes, requireAuth, requireDeskRole, requirePermission } from '@/lib/server/api';
import { applyOutcome, BOOKING_OUTCOMES, bookingById, describeBooking, upsertBooking, type BookingOutcome } from '@/lib/server/bookings';
import { scheduleGatewayFor } from '@/lib/server/schedule-gateway';
import { ScheduleError, stableHash } from '@/lib/server/schedule-core';
import { assignedUserIdsForCase } from '@/lib/server/cases';
import { shadowPermissionDecision } from '@/lib/server/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['bookings:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const booking = bookingById(ctx.orgId, id);
  if (!booking) return fail('NOT_FOUND', `No booking with id ${id}.`, { requestId: ctx.requestId });
  const canReadCase = !booking.caseId || (ctx.auth === 'key'
    ? Boolean(ctx.key?.scopes.includes('*') || ctx.key?.scopes.includes('cases:read'))
    : Boolean(ctx.user && booking.clientId && shadowPermissionDecision(ctx.user, 'cases.read', {
        area: 'cases', patientId: booking.clientId, assignedUserIds: assignedUserIdsForCase(ctx.orgId, booking.caseId),
      }).allowed));
  if (canReadCase) return ok({ ...booking, description: describeBooking(booking) }, { requestId: ctx.requestId });
  const {
    caseId: _caseId, coverageId: _coverageId, authorisationId: _authorisationId,
    fundingPeriodId: _fundingPeriodId, serviceRuleId: _serviceRuleId,
    fundingAllocation: _fundingAllocation, fundingSequence: _fundingSequence,
    fundingWarning: _fundingWarning, ...safe
  } = booking;
  return ok({ ...safe, description: describeBooking(booking) }, { requestId: ctx.requestId });
}

/** PATCH editable non-scheduling details on a native appointment. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['bookings:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireDeskRole(ctx);
  if (denied) return denied;
  const booking = bookingById(ctx.orgId, id);
  if (!booking) return fail('NOT_FOUND', `No booking with id ${id}.`, { requestId: ctx.requestId });
  if (booking.caseId && booking.clientId) {
    const keyDenied = requireApiKeyScopes(ctx, ['cases:write']);
    if (keyDenied) return keyDenied;
    const caseDenied = requirePermission(ctx, 'cases.write', {
      area: 'cases', patientId: booking.clientId, assignedUserIds: assignedUserIdsForCase(ctx.orgId, booking.caseId),
    });
    if (caseDenied) return caseDenied;
  }
  const body = await readJson<{ startsAt?: string; status?: string; notes?: string; customerName?: string; customerNumber?: string; outcome?: string }>(req);
  if (body instanceof NextResponse) return body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail('VALIDATION_ERROR', 'Request body must be an object.', { param: 'body', requestId: ctx.requestId });
  }
  const allowed = new Set(['startsAt', 'status', 'notes', 'customerName', 'customerNumber', 'outcome']);
  const unknown = Object.keys(body).find((key) => !allowed.has(key));
  if (unknown) return fail('VALIDATION_ERROR', `\`${unknown}\` is not editable.`, { param: unknown, requestId: ctx.requestId });
  if (body.startsAt !== undefined) {
    return fail('VALIDATION_ERROR', 'Use the move action to change startsAt so availability and room conflicts are checked.', {
      param: 'startsAt',
      detail: `/api/v1/bookings/${id}/move`,
      requestId: ctx.requestId,
    });
  }
  if (body.outcome && !BOOKING_OUTCOMES.includes(body.outcome as BookingOutcome)) {
    return fail('VALIDATION_ERROR', '`outcome` is not recognised.', { param: 'outcome', requestId: ctx.requestId });
  }
  if (body.status !== undefined) {
    return fail('VALIDATION_ERROR', 'Use the status action so lifecycle transitions, audit history and cancellation wait-list offers are applied.', {
      param: 'status',
      detail: `/api/v1/bookings/${id}/status`,
      requestId: ctx.requestId,
    });
  }
  if (body.notes !== undefined && String(body.notes).length > 4_000) return fail('VALIDATION_ERROR', '`notes` is too long.', { param: 'notes', requestId: ctx.requestId });
  if (body.customerName !== undefined && (!String(body.customerName).trim() || String(body.customerName).length > 160)) {
    return fail('VALIDATION_ERROR', '`customerName` must be 1 to 160 characters.', { param: 'customerName', requestId: ctx.requestId });
  }
  if (body.customerNumber !== undefined && !/^\+[1-9]\d{7,14}$/.test(String(body.customerNumber).replace(/[^\d+]/g, ''))) {
    return fail('VALIDATION_ERROR', '`customerNumber` must be E.164.', { param: 'customerNumber', requestId: ctx.requestId });
  }
  if (body.outcome && Object.keys(body).some((key) => !['outcome', 'notes'].includes(key))) {
    return fail('VALIDATION_ERROR', '`outcome` can be combined only with `notes`.', { param: 'outcome', requestId: ctx.requestId });
  }
  if (!Object.keys(body).length) return fail('VALIDATION_ERROR', 'Provide an editable field.', { requestId: ctx.requestId });

  if (body.outcome) {
    const gateway = scheduleGatewayFor(ctx.orgId);
    if (body.outcome === 'cancelled' || body.outcome === 'declined') {
      try {
        const result = await gateway.cancelAppointment({ bookingId: booking.id, reason: body.notes }, {
          origin: 'staff', actor: ctx.user?.email ?? ctx.key?.id,
          idempotencyKey: req.headers.get('idempotency-key')?.trim() || `staff-outcome-cancel:${stableHash([booking.id, body.notes ?? ''])}`,
        });
        return ok({ ...result.booking, description: describeBooking(result.booking) }, { requestId: ctx.requestId });
      } catch (error) {
        return fail(error instanceof ScheduleError && !['SLOT_TAKEN', 'CONFLICT'].includes(error.code) ? 'SCHEDULE_UNAVAILABLE' : 'CONFLICT', error instanceof Error ? error.message : 'Could not cancel appointment.', { requestId: ctx.requestId });
      }
    }
    const updated = applyOutcome({
      orgId: ctx.orgId,
      bookingId: booking.id,
      outcome: body.outcome as never,
      note: body.notes,
      actor: 'client',
    });
    return ok({ ...updated, description: updated ? describeBooking(updated) : undefined }, { requestId: ctx.requestId });
  }

  const res = upsertBooking({
    orgId: ctx.orgId,
    externalId: booking.externalId,
    customer: {
      name: body.customerName ? String(body.customerName).trim() : booking.customer.name,
      number: body.customerNumber ? String(body.customerNumber).replace(/[^\d+]/g, '') : booking.customer.number,
      email: booking.customer.email,
    },
    service: booking.service,
    startsAt: booking.startsAt,
    status: booking.status,
    notes: body.notes ?? booking.notes,
    source: 'client_api',
  });
  return ok({ ...res.booking, description: describeBooking(res.booking) }, { requestId: ctx.requestId });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['bookings:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireDeskRole(ctx);
  if (denied) return denied;
  const booking = bookingById(ctx.orgId, id);
  if (!booking) return fail('NOT_FOUND', `No booking with id ${id}.`, { requestId: ctx.requestId });
  return fail('VALIDATION_ERROR', 'Appointments are historical records and cannot be permanently deleted. Cancel the appointment instead.', {
    param: 'id',
    detail: `/api/v1/bookings/${id}/status`,
    requestId: ctx.requestId,
  });
}
