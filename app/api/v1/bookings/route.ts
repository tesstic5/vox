import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireApiKeyScopes, requireAuth, requireDeskRole, requirePermission } from '@/lib/server/api';
import { BookingFundingError, bookingByExternalId, bookingStats, bookingsFor, describeBooking } from '@/lib/server/bookings';
import { scheduleGatewayFor } from '@/lib/server/schedule-gateway';
import { ScheduleError, stableHash } from '@/lib/server/schedule-core';
import { clientById, ensureClientForBooking } from '@/lib/server/clients';
import { assignedUserIdsForCase, caseById } from '@/lib/server/cases';
import { locationById, providerById, serviceById } from '@/lib/server/practice';
import { roomById } from '@/lib/server/rooms';
import { isHistoricalTerminalBooking, validateBookingInput } from '@/lib/server/booking-validation';
import { actorLabel, recordAccess } from '@/lib/server/access-log';
import { appointmentsCsv } from '@/lib/server/import-export';
import { shadowPermissionDecision } from '@/lib/server/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Native appointments read and written through Voxera's diary. */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['bookings:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);

  // The appointments export: a date range, one row per appointment, money as a
  // decimal. Separate from the list because a list is paged and a file is not.
  if (url.searchParams.get('view') === 'export') {
    const { csv, rows } = appointmentsCsv(ctx.orgId, {
      from: url.searchParams.get('from') ?? undefined,
      to: url.searchParams.get('to') ?? undefined,
      locationId: url.searchParams.get('locationId') ?? undefined,
    });
    const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
    recordAccess({
      orgId: ctx.orgId,
      resource: 'appointment',
      resourceId: '*',
      action: 'export',
      actor,
      actorName,
      detail: `${rows} appointment(s)${url.searchParams.get('from') ? ` from ${url.searchParams.get('from')}` : ''}`,
    });
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="appointments_${new Date().toISOString().slice(0, 10)}.csv"`,
        'x-appointment-rows': String(rows),
        'x-request-id': ctx.requestId,
      },
    });
  }

  /**
   * Which query parameters this route honours — and nothing else.
   *
   * `?clientId=…` used to be *accepted and thrown away*: the list came back as
   * the whole diary, which reads as "this client has two hundred appointments" to
   * any screen, integration or script that asked for one client's. A filter that
   * is silently ignored is worse than one that does not exist, because the caller
   * has no way to tell the difference between a working answer and a wrong one.
   * So the filters below are real, and anything outside this set is refused by
   * name.
   */
  const SUPPORTED = new Set([
    'view', 'status', 'externalId', 'updatedSince',
    'clientId', 'caseId', 'serviceId', 'providerId', 'locationId',
    'limit', 'sort', 'cursor', 't', 'format',
  ]);
  const unknown = [...new Set(url.searchParams.keys())].filter((k) => !SUPPORTED.has(k));
  if (unknown.length) {
    return fail('VALIDATION_ERROR', `Unknown query parameter${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`, {
      param: unknown[0],
      detail: `This route reads: ${[...SUPPORTED].join(', ')}.`,
      requestId: ctx.requestId,
    });
  }

  const status = url.searchParams.get('status');
  const externalId = url.searchParams.get('externalId');
  const updatedSince = url.searchParams.get('updatedSince');
  const clientId = url.searchParams.get('clientId');
  const caseId = url.searchParams.get('caseId');
  const serviceId = url.searchParams.get('serviceId');
  const providerId = url.searchParams.get('providerId');
  const locationId = url.searchParams.get('locationId');
  const sort = url.searchParams.get('sort') ?? 'startsAt';
  if (!['startsAt', '-startsAt', 'createdAt', '-createdAt'].includes(sort)) {
    return fail('VALIDATION_ERROR', '`sort` must be startsAt, -startsAt, createdAt, or -createdAt.', { param: 'sort', requestId: ctx.requestId });
  }
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200);

  const all = bookingsFor(ctx.orgId, (b) => {
    if (status && b.status !== status) return false;
    if (externalId && b.externalId !== externalId) return false;
    if (clientId && b.clientId !== clientId) return false;
    if (caseId && b.caseId !== caseId) return false;
    if (serviceId && (b.serviceId ?? b.service) !== serviceId) return false;
    if (providerId && b.providerId !== providerId) return false;
    if (locationId && b.locationId !== locationId) return false;
    if (updatedSince) {
      // "Everything that changed since" means: touched by a sync, acted on by a
      // call, or created — whichever is latest.
      const changed = Math.max(
        new Date(b.syncedAt ?? 0).getTime(),
        new Date(b.outcomeAt ?? 0).getTime(),
        new Date(b.createdAt ?? 0).getTime()
      );
      if (changed < new Date(updatedSince).getTime()) return false;
    }
    return true;
  });

  const canReadCaseFields = (booking: (typeof all)[number]) => {
    if (!booking.caseId && !booking.fundingAllocation) return true;
    if (ctx.auth === 'key') return Boolean(ctx.key?.scopes.includes('*') || ctx.key?.scopes.includes('cases:read'));
    if (!ctx.user || !booking.clientId) return false;
    return shadowPermissionDecision(ctx.user, 'cases.read', {
      area: 'cases', patientId: booking.clientId,
      assignedUserIds: booking.caseId ? assignedUserIdsForCase(ctx.orgId, booking.caseId) : [],
    }).allowed;
  };
  const visibleBooking = (booking: (typeof all)[number]) => {
    if (canReadCaseFields(booking)) return booking;
    const {
      caseId: _caseId, coverageId: _coverageId, authorisationId: _authorisationId,
      fundingPeriodId: _fundingPeriodId, serviceRuleId: _serviceRuleId,
      fundingAllocation: _fundingAllocation, fundingSequence: _fundingSequence,
      fundingWarning: _fundingWarning, ...safe
    } = booking;
    return safe;
  };

  const descending = sort.startsWith('-');
  const sortField = sort.replace(/^-/, '') as 'startsAt' | 'createdAt';
  const sorted = all.sort((a, b) => {
    const left = Date.parse(String(a[sortField] ?? '')) || 0;
    const right = Date.parse(String(b[sortField] ?? '')) || 0;
    return descending ? right - left : left - right;
  });
  return ok(
    {
      object: 'list',
      data: sorted.slice(0, limit).map((b) => ({ ...visibleBooking(b), description: describeBooking(b) })),
      total: sorted.length,
      has_more: sorted.length > limit,
      // Kept for the dashboard builds that already read the camelCase form.
      hasMore: sorted.length > limit,
      stats: bookingStats(ctx.orgId),
    },
    { requestId: ctx.requestId }
  );
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['bookings:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireDeskRole(ctx);
  if (denied) return denied;
  const body = await readJson<Record<string, unknown>>(req);
  if (body instanceof NextResponse) return body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail('VALIDATION_ERROR', 'Request body must be an object.', { param: 'body', requestId: ctx.requestId });
  }

  const supported = new Set([
    'externalId', 'customer', 'service', 'startsAt', 'durationMinutes', 'timezone',
    'status', 'notes', 'value', 'metadata', 'providerId', 'serviceId',
    'locationId', 'roomId', 'caseId', 'coverageId', 'authorisationId',
    'fundingOverrideReason', 'checkConflicts',
  ]);
  const unknown = Object.keys(body).find((key) => !supported.has(key));
  if (unknown) return fail('VALIDATION_ERROR', `\`${unknown}\` is not supported.`, { param: unknown, requestId: ctx.requestId });
  if (body.checkConflicts !== undefined && typeof body.checkConflicts !== 'boolean') {
    return fail('VALIDATION_ERROR', '`checkConflicts` must be true or false.', { param: 'checkConflicts', requestId: ctx.requestId });
  }

  const checked = validateBookingInput(body);
  if ('error' in checked) return fail('VALIDATION_ERROR', checked.error, { param: checked.param, requestId: ctx.requestId });
  const input = checked.value;
  const existing = bookingByExternalId(ctx.orgId, input.externalId);
  const effectiveCaseId = input.caseId ?? existing?.caseId;
  let casePatientId: string | undefined;
  if ((input.coverageId || input.authorisationId) && !effectiveCaseId) {
    return fail('VALIDATION_ERROR', 'Coverage and authorisation references require an explicitly selected case.', { param: input.coverageId ? 'coverageId' : 'authorisationId', requestId: ctx.requestId });
  }
  if (effectiveCaseId) {
    const keyDenied = requireApiKeyScopes(ctx, ['cases:write']);
    if (keyDenied) return keyDenied;
    const caseRow = caseById(ctx.orgId, effectiveCaseId);
    if (!caseRow) return fail('NOT_FOUND', 'The selected case does not exist.', { param: 'caseId', requestId: ctx.requestId });
    casePatientId = caseRow.patientId;
    const caseDenied = requirePermission(ctx, 'cases.write', {
      area: 'cases', patientId: caseRow.patientId, assignedUserIds: assignedUserIdsForCase(ctx.orgId, caseRow.id),
    });
    if (caseDenied) return caseDenied;
    const patient = clientById(ctx.orgId, caseRow.patientId);
    if (!patient || patient.number !== input.customer.number) {
      return fail('VALIDATION_ERROR', 'The booking customer must be the patient on the selected case.', { param: 'caseId', requestId: ctx.requestId });
    }
  }
  if (input.fundingOverrideReason) {
    if (ctx.auth !== 'session' || !casePatientId) return fail('FORBIDDEN', 'Funding overrides require an authenticated staff session and selected case.', { requestId: ctx.requestId });
    const overrideDenied = requirePermission(ctx, 'funding.override', { area: 'cases', patientId: casePatientId });
    if (overrideDenied) return overrideDenied;
  }

  // An upsert may omit links already held by the native appointment. Use the
  // effective links for authorization and clash checks, otherwise posting the
  // same external id without providerId would quietly bypass the diary.
  const providerId = input.providerId ?? existing?.providerId;
  const serviceId = input.serviceId ?? existing?.serviceId;
  const locationId = input.locationId ?? existing?.locationId;
  const roomId = input.roomId ?? existing?.roomId;
  const provider = providerId ? providerById(ctx.orgId, providerId) : undefined;
  const service = serviceId ? serviceById(ctx.orgId, serviceId) : undefined;
  const location = locationId ? locationById(ctx.orgId, locationId) : undefined;
  const room = roomId ? roomById(ctx.orgId, roomId) : undefined;
  if (input.providerId && !provider) return fail('NOT_FOUND', `No provider with id ${input.providerId}.`, { param: 'providerId', requestId: ctx.requestId });
  if (input.serviceId && !service) return fail('NOT_FOUND', `No service with id ${input.serviceId}.`, { param: 'serviceId', requestId: ctx.requestId });
  if (input.locationId && !location) return fail('NOT_FOUND', `No location with id ${input.locationId}.`, { param: 'locationId', requestId: ctx.requestId });
  if (input.roomId && !room) return fail('NOT_FOUND', `No room with id ${input.roomId}.`, { param: 'roomId', requestId: ctx.requestId });
  if (room && locationId && room.locationId !== locationId) {
    return fail('VALIDATION_ERROR', 'The room does not belong to that location.', { param: 'roomId', requestId: ctx.requestId });
  }
  if (provider && service && provider.serviceIds.length && !provider.serviceIds.includes(service.id)) {
    return fail('VALIDATION_ERROR', 'That provider does not offer the selected service.', { param: 'serviceId', requestId: ctx.requestId });
  }
  if (provider && location && provider.locationIds.length && !provider.locationIds.includes(location.id)) {
    return fail('VALIDATION_ERROR', 'That provider is not assigned to the selected location.', { param: 'locationId', requestId: ctx.requestId });
  }

  const durationMinutes = input.durationMinutes ?? service?.durationMinutes ?? existing?.durationMinutes ?? 30;
  const candidate = { ...input, durationMinutes, status: input.status ?? existing?.status ?? 'confirmed' };
  // Conflict bypass exists only for importing already-finished history. It must
  // never be a way to double-book future work.
  if (body.checkConflicts === false && !isHistoricalTerminalBooking(candidate)) {
    return fail('VALIDATION_ERROR', '`checkConflicts: false` is allowed only for past completed, cancelled, or no-show history.', {
      param: 'checkConflicts',
      requestId: ctx.requestId,
    });
  }
  const shouldCheck = Boolean(providerId && candidate.status !== 'cancelled' && !(body.checkConflicts === false && isHistoricalTerminalBooking(candidate)));
  const gateway = scheduleGatewayFor(ctx.orgId);
  if (shouldCheck && providerId) {
    try {
      const verdict = await gateway.isFree({
        providerId,
        startsAt: input.startsAt,
        durationMinutes,
        serviceId,
        locationId,
        ignoreBookingId: existing?.id,
      }, { origin: 'staff', actor: ctx.user?.email ?? ctx.key?.id, requestId: ctx.requestId });
      if (!verdict.free) {
        return fail('CONFLICT', 'That slot is not free.', {
          param: 'startsAt',
          detail: verdict.reason ?? `Already booked: ${verdict.conflicts.map((row) => new Date(row.startsAt).toISOString()).join(', ')}`,
          requestId: ctx.requestId,
        });
      }
    } catch (error) {
      if (error instanceof ScheduleError) return fail('SCHEDULE_UNAVAILABLE', error.message, { requestId: ctx.requestId });
      throw error;
    }
  }

  const idempotencyKey = req.headers.get('idempotency-key')?.trim()
    || `staff-booking:${stableHash([ctx.orgId, input.externalId, input.startsAt, providerId ?? '', serviceId ?? '', locationId ?? ''])}`;
  try {
    const client = existing?.clientId || casePatientId
      ? undefined
      : ensureClientForBooking(ctx.orgId, input.customer, ctx.user?.email ?? ctx.key?.id ?? 'booking-api', { source: 'booking' });
    const result = await gateway.createAppointment({
      ...input,
      status: candidate.status,
      durationMinutes,
      service: input.service ?? service?.name,
      value: input.value ?? service?.price,
      source: 'client_api',
      clientId: existing?.clientId ?? casePatientId ?? client?.id,
      fundingOverrideBy: input.fundingOverrideReason ? (ctx.user?.id ?? ctx.user?.email) : undefined,
    }, {
      origin: 'staff', actor: ctx.user?.email ?? ctx.key?.id, requestId: ctx.requestId, idempotencyKey,
    });
    return ok({ ...result.booking, description: describeBooking(result.booking) }, { requestId: ctx.requestId, status: existing ? 200 : 201 });
  } catch (error) {
    if (error instanceof BookingFundingError) {
      const code = error.code === 'NOT_FOUND' ? 'NOT_FOUND' : error.code === 'LIMIT_EXCEEDED' || error.code === 'CONFLICT' ? 'CONFLICT' : 'VALIDATION_ERROR';
      return fail(code, error.message, { requestId: ctx.requestId, detail: [...(error.detail?.missing ?? []), ...(error.detail?.breaches ?? [])].join('; ') || undefined });
    }
    if (error instanceof ScheduleError) {
      const code = error.code === 'SLOT_TAKEN' || error.code === 'CONFLICT' ? 'CONFLICT' : 'SCHEDULE_UNAVAILABLE';
      return fail(code, error.message, { requestId: ctx.requestId });
    }
    return fail('VALIDATION_ERROR', error instanceof Error ? error.message : 'Could not save booking.', { requestId: ctx.requestId });
  }
}
