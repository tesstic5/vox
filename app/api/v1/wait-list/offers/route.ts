import { NextResponse, type NextRequest } from 'next/server';
import { fail, listBody, ok, readJson, requireAuth, requireWriteRole } from '@/lib/server/api';
import { actorLabel } from '@/lib/server/access-log';
import { bookingById } from '@/lib/server/bookings';
import { waitListFor } from '@/lib/server/diary';
import { nextFreeSlotFor, offerById, offerFreedSlot, offersBoard, withdrawOffer } from '@/lib/server/wait-offers';
import { sessionOverlapping } from '@/lib/server/classes';
import { serviceById } from '@/lib/server/practice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The freed-slot offers the desk has out.
 *
 * A cancellation now *does* something — see `lib/server/wait-offers.ts` — and this
 * is where a receptionist sees what it did: who was offered what, whether it went
 * or was blocked, and which offers are still standing. The diary screen used to
 * answer a cancellation with a toast; this is the page behind it.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  const rows = offersBoard(ctx.orgId, { includeClosed: url.searchParams.get('includeClosed') === 'true' });
  return ok(
    listBody(rows, {
      stats: {
        open: rows.filter((r) => r.status === 'open').length,
        claimed: rows.filter((r) => r.status === 'claimed').length,
        declined: rows.filter((r) => r.status === 'declined').length,
        expired: rows.filter((r) => r.status === 'expired').length,
        withdrawn: rows.filter((r) => r.status === 'withdrawn').length,
      },
    }),
    { requestId: ctx.requestId }
  );
}

/**
 * Offer a slot by hand.
 *
 * Three shapes, because the desk has three questions. `{ bookingId }` means "this
 * appointment is gone, offer the time it freed" — the same thing a cancellation
 * does, for a desk that wants to re-run it (or offer a slot that was never
 * booked). `{ entryId, startsAt }` means "offer this person *this* time". And
 * `{ entryId }` on its own means "find them the next opening that fits", which
 * intersects their window with the diary and says which time it picked.
 */
export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireWriteRole(ctx);
  if (denied) return denied;

  const body = await readJson<{ bookingId?: string; entryId?: string; startsAt?: string }>(req);
  if (body instanceof NextResponse) return body;
  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });

  if (body.bookingId) {
    const booking = bookingById(ctx.orgId, String(body.bookingId));
    if (!booking) return fail('NOT_FOUND', `No appointment with id ${body.bookingId}.`, { requestId: ctx.requestId });
    const result = offerFreedSlot({ orgId: ctx.orgId, booking, actor, actorName, manual: true });
    if (result.classSeat) {
      return fail(
        'CONFLICT',
        'That is a place in a class, not a slot — the class is still running in its room with its instructor. Give the place back and the class keeps its hour; the wait list cannot be offered it.',
        { requestId: ctx.requestId }
      );
    }
    if (result.past) return fail('VALIDATION_ERROR', 'That appointment is in the past — there is nothing to offer.', { requestId: ctx.requestId });
    return ok(
      {
        offered: result.offered.length,
        alreadyOffered: result.alreadyOffered,
        skipped: result.skipped,
        names: result.offered.map((o) => o.name),
        rows: result.offered,
      },
      { requestId: ctx.requestId, status: result.offered.length ? 201 : 200 }
    );
  }

  if (body.entryId) {
    const entry = waitListFor(ctx.orgId, { includeCancelled: true }).find((w) => w.id === body.entryId);
    if (!entry) return fail('NOT_FOUND', `No wait-list entry with id ${body.entryId}.`, { requestId: ctx.requestId });
    if (entry.status === 'booked') {
      return fail(
        'CONFLICT',
        `${entry.name} already has an appointment from this wait-list request — do not offer them another one.`,
        { requestId: ctx.requestId }
      );
    }
    if (entry.status === 'cancelled' || entry.status === 'expired') {
      return fail(
        'CONFLICT',
        `That wait-list request is ${entry.status} and cannot receive another offer. Add a new request if the person still wants an appointment.`,
        { requestId: ctx.requestId }
      );
    }
    /**
     * Somebody in line for a place in a class is not waiting for a time. Their
     * offer comes from a seat being given back in *that* class; minting a private
     * slot here would text them a link to an appointment they never asked for,
     * which is the same confusion as offering a class hour to a slot waiter — from
     * the other direction.
     */
    if (entry.sessionId) {
      return fail(
        'CONFLICT',
        'That person is waiting for a place in a class, not for a time. Give a seat back in that class and they will be offered it — or put them straight on its roster.',
        { requestId: ctx.requestId }
      );
    }
    // No time given means "the next one that fits them", which is what a desk
    // asking on the phone actually wants: the entry's window intersected with
    // what the diary has free.
    let startsAt = String(body.startsAt ?? '');
    let picked: string | undefined;
    if (!startsAt) {
      const next = await nextFreeSlotFor(ctx.orgId, entry);
      if (!next) {
        return fail('CONFLICT', `Nothing free between ${entry.from}${entry.to ? ` and ${entry.to}` : ''} for ${entry.name} — extend their window or offer a specific time.`, { requestId: ctx.requestId });
      }
      startsAt = next.startsAt;
      picked = next.spoken;
    }
    if (!Number.isFinite(Date.parse(startsAt))) return fail('VALIDATION_ERROR', '`startsAt` must be a date.', { param: 'startsAt', requestId: ctx.requestId });
    if (Date.parse(startsAt) <= Date.now()) return fail('VALIDATION_ERROR', 'That time has already passed.', { param: 'startsAt', requestId: ctx.requestId });

    const durationMinutes = entry.serviceId ? serviceById(ctx.orgId, entry.serviceId)?.durationMinutes ?? 30 : 30;
    // A time the desk typed by hand is still checked against the diary's own
    // truth: if a class is running then, the whole service duration is not free to promise.
    const clash = sessionOverlapping(ctx.orgId, { startsAt, durationMinutes, locationId: entry.locationId, providerId: entry.providerId });
    if (clash) {
      return fail(
        'CONFLICT',
        `A class is on at that time${clash.serviceId ? ' in the diary' : ''} — its room and instructor are held for a roster, so the hour is not free to offer. Offer a different time, or add them to the class roster instead.`,
        { param: 'startsAt', requestId: ctx.requestId }
      );
    }

    // A one-entry offer is minted through the same engine as a cancellation's, by
    // handing it a booking-shaped slot with no booking behind it.
    const pseudo = {
      id: `manual-${entry.id}`,
      orgId: ctx.orgId,
      externalId: '',
      customer: { name: entry.name, number: entry.number, email: entry.email },
      service: '',
      startsAt,
      durationMinutes,
      status: 'cancelled',
      source: 'dashboard',
      attempts: [],
      providerId: entry.providerId,
      serviceId: entry.serviceId,
      locationId: entry.locationId,
    } as never;
    const result = offerFreedSlot({ orgId: ctx.orgId, booking: pseudo, actor, actorName, manual: true });
    return ok(
      { offered: result.offered.length, names: result.offered.map((o) => o.name), rows: result.offered, startsAt, picked },
      { requestId: ctx.requestId, status: result.offered.length ? 201 : 200 }
    );
  }

  return fail('VALIDATION_ERROR', 'Send either `bookingId`, or `entryId` with `startsAt`.', { requestId: ctx.requestId });
}

/** Takes an offer back — the slot is the desk's again and the person stays in the queue. */
export async function DELETE(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireWriteRole(ctx);
  if (denied) return denied;
  const url = new URL(req.url);
  const id = url.searchParams.get('id') ?? '';
  if (!id) return fail('VALIDATION_ERROR', 'Send the offer id as `?id=`.', { param: 'id', requestId: ctx.requestId });
  if (!offerById(ctx.orgId, id)) return fail('NOT_FOUND', `No offer with id ${id}.`, { requestId: ctx.requestId });
  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  const result = withdrawOffer({ orgId: ctx.orgId, offerId: id, actor, actorName });
  if (!result.ok) return fail('CONFLICT', result.message, { requestId: ctx.requestId });
  return ok({ withdrawn: true, message: result.message }, { requestId: ctx.requestId });
}
