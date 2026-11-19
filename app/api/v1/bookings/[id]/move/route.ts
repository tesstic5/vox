import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireApiKeyScopes, requireAuth, requirePermission } from '@/lib/server/api';
import { scheduleGatewayFor } from '@/lib/server/schedule-gateway';
import { ScheduleError, stableHash } from '@/lib/server/schedule-core';
import { actorLabel } from '@/lib/server/access-log';
import { bookingById } from '@/lib/server/bookings';
import { locationById, providerById } from '@/lib/server/practice';
import { roomById } from '@/lib/server/rooms';
import { requireBookingActionRole } from '@/lib/server/booking-access';
import { assignedUserIdsForCase } from '@/lib/server/cases';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /v1/bookings/{id}/move — drag, resize or reassign an appointment.
 *
 * Its own verb rather than a PATCH because it means something specific: the
 * destination has to satisfy the availability engine, exactly like a new
 * booking. There is deliberately no conflict-bypass flag: overlapping work must
 * be resolved rather than hidden in an override.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['bookings:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson<Record<string, unknown>>(req);
  if (body instanceof NextResponse) return body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail('VALIDATION_ERROR', 'Request body must be an object.', { param: 'body', requestId: ctx.requestId });
  }
  const supported = new Set(['startsAt', 'durationMinutes', 'providerId', 'locationId', 'roomId', 'fundingOverrideReason']);
  const unknown = Object.keys(body).find((key) => !supported.has(key));
  if (unknown) {
    const message = unknown === 'force'
      ? 'Conflict bypass is not available. Choose a free time, provider, and room.'
      : `\`${unknown}\` is not supported.`;
    return fail('VALIDATION_ERROR', message, { param: unknown, requestId: ctx.requestId });
  }
  if (!Object.keys(body).length) return fail('VALIDATION_ERROR', 'Provide a time, duration, provider, location, or room to change.', { requestId: ctx.requestId });

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
  const overrideReason = String(body.fundingOverrideReason ?? '').trim();
  if (overrideReason && (overrideReason.length > 500 || /[\u0000-\u001f]/.test(overrideReason))) {
    return fail('VALIDATION_ERROR', '`fundingOverrideReason` must be plain text up to 500 characters.', { param: 'fundingOverrideReason', requestId: ctx.requestId });
  }
  if (overrideReason) {
    if (ctx.auth !== 'session' || !booking.clientId) return fail('FORBIDDEN', 'Funding overrides require an authenticated staff session.', { requestId: ctx.requestId });
    const overrideDenied = requirePermission(ctx, 'funding.override', { area: 'cases', patientId: booking.clientId });
    if (overrideDenied) return overrideDenied;
  }
  const startsAt = body.startsAt === undefined ? undefined : String(body.startsAt);
  if (startsAt !== undefined && (!startsAt.trim() || !Number.isFinite(Date.parse(startsAt)))) {
    return fail('VALIDATION_ERROR', '`startsAt` must be a valid ISO timestamp.', { param: 'startsAt', requestId: ctx.requestId });
  }
  const durationMinutes = body.durationMinutes === undefined ? undefined : Number(body.durationMinutes);
  if (durationMinutes !== undefined && (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 1_440)) {
    return fail('VALIDATION_ERROR', '`durationMinutes` must be an integer from 5 to 1440.', { param: 'durationMinutes', requestId: ctx.requestId });
  }
  const idField = (name: 'providerId' | 'locationId' | 'roomId') => {
    const value = body[name];
    return value === undefined ? undefined : String(value).trim();
  };
  const providerId = idField('providerId');
  const locationId = idField('locationId');
  const roomId = idField('roomId');
  if (ctx.auth === 'session' && ctx.user?.role === 'practitioner' && body.providerId !== undefined && providerId !== booking.providerId) {
    return fail('FORBIDDEN', "Practitioners cannot move an appointment into another practitioner's diary.", {
      param: 'providerId',
      requestId: ctx.requestId,
    });
  }
  if (body.providerId !== undefined && (!providerId || !providerById(ctx.orgId, providerId))) {
    return fail('NOT_FOUND', `No provider with id ${providerId || '(empty)'}.`, { param: 'providerId', requestId: ctx.requestId });
  }
  if (body.locationId !== undefined && (!locationId || !locationById(ctx.orgId, locationId))) {
    return fail('NOT_FOUND', `No location with id ${locationId || '(empty)'}.`, { param: 'locationId', requestId: ctx.requestId });
  }
  const room = roomId ? roomById(ctx.orgId, roomId) : undefined;
  if (body.roomId !== undefined && (!roomId || !room)) {
    return fail('NOT_FOUND', `No room with id ${roomId || '(empty)'}.`, { param: 'roomId', requestId: ctx.requestId });
  }
  const effectiveLocationId = locationId ?? booking.locationId;
  if (room && effectiveLocationId && room.locationId !== effectiveLocationId) {
    return fail('VALIDATION_ERROR', 'The room does not belong to that location.', { param: 'roomId', requestId: ctx.requestId });
  }
  const effectiveProvider = providerById(ctx.orgId, providerId ?? booking.providerId ?? '');
  if (effectiveProvider && effectiveLocationId && effectiveProvider.locationIds.length && !effectiveProvider.locationIds.includes(effectiveLocationId)) {
    return fail('VALIDATION_ERROR', 'That provider is not assigned to the selected location.', { param: 'locationId', requestId: ctx.requestId });
  }
  if (effectiveProvider && booking.serviceId && effectiveProvider.serviceIds.length && !effectiveProvider.serviceIds.includes(booking.serviceId)) {
    return fail('VALIDATION_ERROR', 'That provider does not offer the appointment service.', { param: 'providerId', requestId: ctx.requestId });
  }

  const { actor } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  const destination = startsAt ? new Date(startsAt).toISOString() : booking.startsAt;
  const idempotencyKey = req.headers.get('idempotency-key')?.trim()
    || `staff-move:${stableHash([ctx.orgId, id, destination, durationMinutes ?? booking.durationMinutes, providerId ?? booking.providerId ?? '', locationId ?? booking.locationId ?? '', roomId ?? booking.roomId ?? ''])}`;
  try {
    const result = await scheduleGatewayFor(ctx.orgId).moveAppointment({
      bookingId: id,
      startsAt: destination,
      durationMinutes,
      providerId,
      locationId,
      roomId,
      fundingOverrideReason: overrideReason || undefined,
    }, { origin: 'staff', actor, requestId: ctx.requestId, idempotencyKey });
    return ok({ ...result.booking, changed: true, confirmed: result.confirmed }, { requestId: ctx.requestId });
  } catch (error) {
    if (error instanceof ScheduleError) {
      return fail(error.code === 'SLOT_TAKEN' ? 'CONFLICT' : 'SCHEDULE_UNAVAILABLE', error.message, { param: 'startsAt', requestId: ctx.requestId });
    }
    const message = error instanceof Error ? error.message : 'Could not move appointment.';
    return fail(message.includes('not found') ? 'NOT_FOUND' : message.includes('free') || message.includes('taken') ? 'CONFLICT' : 'VALIDATION_ERROR', message, { requestId: ctx.requestId });
  }
}
