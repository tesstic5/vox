import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireDeskRole } from '@/lib/server/api';
import { bookingByExternalId, bookingsFor, describeBooking, upsertBooking, type BookingInput } from '@/lib/server/bookings';
import { update } from '@/lib/server/db';
import { audit } from '@/lib/server/audit';
import { isHistoricalTerminalBooking, validateBookingInput } from '@/lib/server/booking-validation';
import { isFree } from '@/lib/server/availability';
import { locationById, providerById, serviceById, type ServiceDoc } from '@/lib/server/practice';
import { roomById } from '@/lib/server/rooms';
import { actorLabel } from '@/lib/server/access-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /v1/bookings/sync — controlled bulk import into the native diary.
 *
 * The supplied source snapshot is imported into Voxera’s native appointment records
 * right now: upsert everything, mark what it did not send as gone, and report
 * what happened. The write-back direction is separate — outcomes we learn on a
 * call land in our mirror's `outcome` field and go out as webhooks, so you can
 * pull them (this endpoint's `outcomes` array) or subscribe to them.
 *
 * `mode: 'full'` means "this payload is everything this source has" and therefore
 * requires a stable `sourceId`. Only absent rows previously written by that same
 * source are flagged `removedFromSource`; records from other integrations or the
 * product UI are untouched. Nothing is deleted.
 */
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
  const topUnknown = Object.keys(body).find((key) => !['bookings', 'mode', 'sourceId'].includes(key));
  if (topUnknown) return fail('VALIDATION_ERROR', `\`${topUnknown}\` is not supported.`, { param: topUnknown, requestId: ctx.requestId });

  const rows = Array.isArray(body.bookings) ? body.bookings : [];
  if (!rows.length) return fail('VALIDATION_ERROR', 'Send `bookings` as a non-empty array.', { param: 'bookings', requestId: ctx.requestId });
  if (rows.length > 500) return fail('VALIDATION_ERROR', 'Sync at most 500 bookings per request.', { param: 'bookings', requestId: ctx.requestId });
  const mode = body.mode === undefined ? 'partial' : body.mode;
  if (mode !== 'full' && mode !== 'partial') {
    return fail('VALIDATION_ERROR', '`mode` must be full or partial.', { param: 'mode', requestId: ctx.requestId });
  }
  const sourceId = body.sourceId === undefined ? undefined : String(body.sourceId).trim();
  if (sourceId !== undefined && (!sourceId || sourceId.length > 100 || !/^[a-zA-Z0-9._:-]+$/.test(sourceId))) {
    return fail('VALIDATION_ERROR', '`sourceId` must be 1 to 100 letters, numbers, dots, colons, underscores, or hyphens.', { param: 'sourceId', requestId: ctx.requestId });
  }
  if (mode === 'full' && !sourceId) {
    return fail('VALIDATION_ERROR', '`sourceId` is required for a full sync so one integration cannot remove another integration\'s work.', {
      param: 'sourceId',
      requestId: ctx.requestId,
    });
  }

  // Validate response filters before any upsert. A bad `since` must not produce
  // an error response after changing the diary.
  const url = new URL(req.url);
  const unknownQuery = [...new Set(url.searchParams.keys())].find((key) => key !== 'since');
  if (unknownQuery) return fail('VALIDATION_ERROR', `Unknown query parameter: ${unknownQuery}.`, { param: unknownQuery, requestId: ctx.requestId });
  const since = url.searchParams.get('since');
  const border = since ? Date.parse(since) : 0;
  if (since && !Number.isFinite(border)) {
    return fail('VALIDATION_ERROR', '`since` must be a valid ISO timestamp.', { param: 'since', requestId: ctx.requestId });
  }

  const rowFields = new Set([
    'externalId', 'customer', 'service', 'startsAt', 'durationMinutes', 'timezone',
    'status', 'notes', 'value', 'metadata', 'providerId', 'serviceId',
    'locationId', 'roomId',
  ]);
  const prepared: BookingInput[] = [];
  const errors: { externalId: string; error: string }[] = [];
  const seen = new Set<string>();
  type Scheduled = {
    input: BookingInput;
    existingId?: string;
    providerId?: string;
    locationId?: string;
    roomId?: string;
    service?: ServiceDoc;
    from: number;
    to: number;
  };
  const scheduled: Scheduled[] = [];

  for (const raw of rows) {
    const label = raw && typeof raw === 'object' && !Array.isArray(raw) ? String((raw as { externalId?: unknown }).externalId ?? '').trim() : '(missing)';
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const unknown = Object.keys(raw).find((key) => !rowFields.has(key));
      if (unknown) {
        errors.push({ externalId: label || '(missing)', error: `${unknown} is not supported` });
        continue;
      }
    }
    if (label && label !== '(missing)' && seen.has(label)) {
      errors.push({ externalId: label, error: 'externalId appears more than once in this payload' });
      continue;
    }
    if (label && label !== '(missing)') seen.add(label);

    const checked = validateBookingInput(raw);
    if ('error' in checked) {
      errors.push({ externalId: label || '(missing)', error: checked.error });
      continue;
    }
    const input = checked.value;
    const existing = bookingByExternalId(ctx.orgId, input.externalId);
    if (existing?.caseId || existing?.fundingAllocation) {
      errors.push({ externalId: input.externalId, error: 'case-funded bookings cannot be changed by bulk sync; use the individual booking lifecycle endpoint so allocation is atomic' });
      continue;
    }
    const providerId = input.providerId ?? existing?.providerId;
    const serviceId = input.serviceId ?? existing?.serviceId;
    const locationId = input.locationId ?? existing?.locationId;
    const roomId = input.roomId ?? existing?.roomId;
    const provider = providerId ? providerById(ctx.orgId, providerId) : undefined;
    const service = serviceId ? serviceById(ctx.orgId, serviceId) : undefined;
    const location = locationId ? locationById(ctx.orgId, locationId) : undefined;
    const room = roomId ? roomById(ctx.orgId, roomId) : undefined;
    let relationError = '';
    if (input.providerId && !provider) relationError = `providerId ${input.providerId} does not belong to this workspace`;
    else if (input.serviceId && !service) relationError = `serviceId ${input.serviceId} does not belong to this workspace`;
    else if (input.locationId && !location) relationError = `locationId ${input.locationId} does not belong to this workspace`;
    else if (input.roomId && !room) relationError = `roomId ${input.roomId} does not belong to this workspace`;
    else if (room && locationId && room.locationId !== locationId) relationError = 'roomId does not belong to locationId';
    else if (provider && service && provider.serviceIds.length && !provider.serviceIds.includes(service.id)) relationError = 'the provider does not offer the selected service';
    else if (provider && location && provider.locationIds.length && !provider.locationIds.includes(location.id)) relationError = 'the provider is not assigned to the selected location';
    if (relationError) {
      errors.push({ externalId: input.externalId, error: relationError });
      continue;
    }

    const durationMinutes = input.durationMinutes ?? service?.durationMinutes ?? existing?.durationMinutes ?? 30;
    const normalized: BookingInput = {
      ...input,
      durationMinutes,
      service: input.service ?? service?.name,
    };
    prepared.push(normalized);
    const before = service?.bufferBeforeMinutes ?? 0;
    const after = service?.bufferAfterMinutes ?? 0;
    const start = Date.parse(normalized.startsAt);
    scheduled.push({
      input: normalized,
      existingId: existing?.id,
      providerId,
      locationId,
      roomId,
      service,
      from: start - before * 60_000,
      to: start + durationMinutes * 60_000 + after * 60_000,
    });
  }

  // Ignore all rows this atomic payload is replacing, then test the proposed
  // snapshot against appointments outside it and against every other proposed
  // row. This permits swaps while still refusing new double bookings.
  if (!errors.length) {
    const replacing = scheduled.map((row) => row.existingId).filter((id): id is string => Boolean(id));
    for (const row of scheduled) {
      const status = row.input.status ?? bookingByExternalId(ctx.orgId, row.input.externalId)?.status ?? 'confirmed';
      if (status === 'cancelled' || isHistoricalTerminalBooking({ ...row.input, status })) continue;
      if (row.providerId) {
        const verdict = isFree({
          orgId: ctx.orgId,
          providerId: row.providerId,
          startsAt: row.input.startsAt,
          durationMinutes: row.input.durationMinutes ?? 30,
          service: row.service,
          roomId: row.roomId,
          locationId: row.locationId,
          ignoreBookingIds: replacing,
        });
        if (!verdict.free) errors.push({ externalId: row.input.externalId, error: verdict.reason ?? 'the proposed slot conflicts with an existing booking' });
      } else if (row.roomId) {
        const roomConflict = bookingsFor(ctx.orgId, (booking) =>
          !replacing.includes(booking.id) &&
          booking.status !== 'cancelled' &&
          booking.roomId === row.roomId &&
          row.from < Date.parse(booking.startsAt) + booking.durationMinutes * 60_000 &&
          row.to > Date.parse(booking.startsAt)
        )[0];
        if (roomConflict) errors.push({ externalId: row.input.externalId, error: 'the proposed room is already booked at that time' });
      }
    }
    for (let index = 0; index < scheduled.length; index += 1) {
      const row = scheduled[index];
      const rowStatus = row.input.status ?? bookingByExternalId(ctx.orgId, row.input.externalId)?.status ?? 'confirmed';
      if (rowStatus === 'cancelled' || isHistoricalTerminalBooking({ ...row.input, status: rowStatus })) continue;
      for (const other of scheduled.slice(0, index)) {
        const otherStatus = other.input.status ?? bookingByExternalId(ctx.orgId, other.input.externalId)?.status ?? 'confirmed';
        if (otherStatus === 'cancelled' || isHistoricalTerminalBooking({ ...other.input, status: otherStatus })) continue;
        const sameProvider = Boolean(row.providerId && row.providerId === other.providerId);
        const sameRoom = Boolean(row.roomId && row.roomId === other.roomId);
        if ((sameProvider || sameRoom) && row.from < other.to && row.to > other.from) {
          errors.push({ externalId: row.input.externalId, error: `conflicts with ${other.input.externalId} in this payload` });
          break;
        }
      }
    }
  }

  // A full sync must be all-or-nothing: removing rows after accepting a partly
  // malformed source snapshot would turn validation mistakes into missing work.
  if (errors.length) {
    return fail('VALIDATION_ERROR', 'The sync payload contains invalid bookings; nothing was written.', {
      param: 'bookings',
      detail: JSON.stringify(errors.slice(0, 10)),
      requestId: ctx.requestId,
    });
  }

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  for (const row of prepared) {
    const existing = bookingByExternalId(ctx.orgId, row.externalId);
    const res = upsertBooking({
      ...row,
      orgId: ctx.orgId,
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(row.metadata ?? {}),
        ...(sourceId ? { syncSourceId: sourceId } : {}),
        removedFromSource: 'false',
      },
      source: 'client_api',
    });
    if (res.created) created += 1;
    else if (res.changed) updated += 1;
    else unchanged += 1;
  }

  let removed = 0;
  if (mode === 'full') {
    const sent = new Set(prepared.map((row) => row.externalId));
    // A source snapshot owns only rows previously written by that integration.
    // Online, dashboard, call, wait-list, and field-work appointments are not
    // silently disabled merely because an external scheduler did not send them.
    for (const booking of bookingsFor(ctx.orgId, (row) => row.source === 'client_api' && row.metadata?.syncSourceId === sourceId)) {
      if (sent.has(booking.externalId)) continue;
      if (booking.caseId || booking.fundingAllocation) continue;
      if (booking.metadata?.removedFromSource === 'true') continue;
      update('bookings', booking.id, {
        metadata: { ...(booking.metadata ?? {}), removedFromSource: 'true' },
        revision: booking.revision + 1,
      });
      removed += 1;
    }
  }

  // Outcomes learned on calls since the client last asked — the write-back half
  // of the integration, in the same shape the webhooks deliver.
  const outcomes = bookingsFor(ctx.orgId, (b) => Boolean(b.outcomeAt) && new Date(b.outcomeAt as string).getTime() >= border).map((b) => ({
    externalId: b.externalId,
    bookingId: b.id,
    outcome: b.outcome,
    note: b.outcomeNote,
    at: b.outcomeAt,
    startsAt: b.startsAt,
    callIds: b.callIds ?? [],
  }));

  const { actor } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  audit({ orgId: ctx.orgId, actor, action: 'bookings.sync', detail: `${created} created, ${updated} updated, ${removed} removed` });

  return ok(
    {
      created,
      updated,
      unchanged,
      removed,
      errors,
      mode,
      sourceId: sourceId ?? null,
      outcomes,
      note: removed ? `${removed} booking(s) were not in the payload — flagged removedFromSource and excluded from campaigns. Nothing was deleted.` : undefined,
    },
    { requestId: ctx.requestId }
  );
}

/** GET /v1/bookings/sync — what a sync would do, without doing it. */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['bookings:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const all = bookingsFor(ctx.orgId);
  // Outcomes are the half the client cannot compute themselves, so a poller can
  // read them here as well as receive them by webhook.
  const since = new URL(req.url).searchParams.get('since');
  const border = since ? Date.parse(since) : 0;
  if (since && !Number.isFinite(border)) {
    return fail('VALIDATION_ERROR', '`since` must be a valid ISO timestamp.', { param: 'since', requestId: ctx.requestId });
  }
  const outcomes = all
    .filter((b) => Boolean(b.outcomeAt) && new Date(b.outcomeAt as string).getTime() >= border)
    .map((b) => ({
      externalId: b.externalId,
      bookingId: b.id,
      outcome: b.outcome,
      note: b.outcomeNote,
      at: b.outcomeAt,
      startsAt: b.startsAt,
      callIds: b.callIds ?? [],
    }));

  return ok(
    {
      inMirror: all.length,
      outcomes,
      byStatus: all.reduce<Record<string, number>>((acc, b) => ({ ...acc, [b.status]: (acc[b.status] ?? 0) + 1 }), {}),
      lastSyncedAt: all.map((b) => b.syncedAt).filter(Boolean).sort().pop(),
      sample: all.slice(0, 3).map((b) => ({ externalId: b.externalId, description: describeBooking(b), status: b.status, outcome: b.outcome })),
      howTo: 'POST { bookings: BookingInput[], mode: "full", sourceId: "your-stable-integration-id" } — full flags only rows missing from that same source.',
    },
    { requestId: ctx.requestId }
  );
}
