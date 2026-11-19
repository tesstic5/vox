/**
 * The diary.
 *
 * `bookings` *is* the appointment record (PRACTICE.md §2b), so this module is
 * the operational layer on top of it: the calendar range a receptionist looks
 * at, moving and resizing an appointment with the availability engine's
 * blessing, the status lifecycle, repeat series, and the wait list.
 *
 * Two rules shape everything here:
 *
 *   1. **One calendar.** Every write goes through the same clash check the AI
 *      tools and the public booking page use, so a receptionist dragging a
 *      block and a caller asking for the same time cannot both win.
 *   2. **Nothing is lost.** A cancelled appointment keeps its row and its
 *      history; the diary hides it, the client's timeline keeps it.
 */

import { list, update, insert, remove, type Doc } from './db';
import { addDays, zonedToUtc } from './availability';
import { audit } from './audit';
import { cancelRemindersFor } from './messages';
import { isFree } from './availability';
import { BookingFundingError, bookingsFor, upsertBooking, type BookingDoc, type BookingStatus } from './bookings';
import { clientById, ensureClientForBooking, noteAppointmentForClient } from './clients';
import { patientAlertsFor } from './patient-alerts';
import { locationById, locationsFor, practiceTimezone, providerById, serviceById } from './practice';
import { classSessionsFor, summariseSession } from './classes';
import { deliverWebhook } from './webhooks';
import { recordAccess } from './access-log';
import { freeRoomFor, roomNameOf } from './rooms';
import { invoiceFromBooking, moneySettingsFor } from './money';
import { packOnSeatStatus } from './packs';
import { practiceIsRunnable } from './practice-setup';
import { commitBookingFunding } from './funding';

export type WaitEntryDoc = Doc & {
  orgId: string;
  clientId?: string;
  name: string;
  number: string;
  email?: string;
  serviceId?: string;
  providerId?: string;
  locationId?: string;
  /**
   * The class session this person is waiting for a *place* in, when that is what
   * they asked for.
   *
   * A class entry is not a slot entry: the time is fixed, the room is held and
   * the instructor is already booked, so the only thing that can come free is a
   * place. Set, the entry is invisible to the slot matcher below (its window is
   * the class's own date, and would otherwise match a private appointment on the
   * same day) and is served by `lib/server/class-waitlist.ts` instead.
   */
  sessionId?: string;
  /** Window the client said they could come in. */
  from: string;
  to?: string;
  notes?: string;
  status: 'waiting' | 'offered' | 'booked' | 'expired' | 'cancelled';
  createdAt: string;
  updatedAt: string;
};

/* ------------------------------------------------------------------- range */

export type DiaryAppointment = BookingDoc & {
  providerName?: string;
  serviceName?: string;
  locationName?: string;
  /** The room the visit occupies, by name — a record id is no use on a screen. */
  roomName?: string;
  clientName?: string;
  hasAlerts?: boolean;
};

/**
 * A class on the grid (A8).
 *
 * Drawn once, whatever its roster: the seats are *people in* the class, not eight
 * appointments in the same room. The block carries the count so the desk can see
 * at a glance how full the evening is.
 */
export type DiarySession = {
  id: string;
  serviceId: string;
  serviceName: string;
  providerId: string;
  providerName?: string;
  locationId: string;
  locationName?: string;
  roomId?: string;
  roomName?: string;
  startsAt: string;
  durationMinutes: number;
  capacity: number;
  seats: number;
  seatsLeft: number;
  status: 'scheduled' | 'cancelled';
  /** Minutes from the grid's local midnight — the same clock the blocks use. */
  localStart: number;
  localEnd: number;
};

export type DiaryDay = {
  date: string;
  /** Minutes from local midnight — the grid the calendar draws. */
  appointments: (DiaryAppointment & { localStart: number; localEnd: number })[];
  /** Classes at this site on this day, with their rosters counted. */
  sessions: DiarySession[];
  stats: { booked: number; cancelled: number; minutes: number; classes: number; seats: number };
};

/**
 * What the calendar asks for: everything in a window, through the site's clock.
 *
 * Without a `locationId` the window is interpreted in the practice's first
 * site's timezone and every appointment is returned in *its own* site's clock,
 * so a mixed-timezone practice still draws one honest grid per column.
 */
export function diaryRange(input: {
  orgId: string;
  from: string;
  to: string;
  providerId?: string;
  locationId?: string;
  includeClinicalAlerts?: boolean;
}): {
  days: DiaryDay[];
  timezone: string;
  gridSiteId?: string;
  providers: { id: string; name: string; colour: string }[];
  /** The sites the diary can be narrowed to — the switcher's options. */
  sites: { id: string; name: string; timezone: string }[];
  /**
   * Whether there is anything to book *into* — at least one service and one
   * practitioner. A new workspace gets a two-line explanation and a link from
   * the calendar instead of an empty grid that looks broken.
   */
  ready: boolean;
} {
  const location = input.locationId ? locationById(input.orgId, input.locationId) : undefined;
  /**
   * One grid, one clock.
   *
   * This used to fall back to UTC whenever no site was chosen — which is the
   * *default* view — while every row was still drawn in its own site's local
   * minutes. The blocks looked right and the arithmetic did not: a block dropped
   * at 14:00 on the grid was sent as 14:00Z and landed at 10:00 in New York, and
   * an evening appointment fell into the next day's column. The clock is now the
   * practice's own (the filtered site's, or the first site by name), and *every*
   * offset in this payload is measured against it, so what the grid draws is
   * what a drag writes back.
   */
  const timezone = practiceTimezone(input.orgId, location);

  const days: DiaryDay[] = [];
  const fromMs = zonedToUtc(...(input.from.split('-').map(Number) as [number, number, number]), 0, 0, timezone);
  const toMs = zonedToUtc(...(input.to.split('-').map(Number) as [number, number, number]), 0, 0, timezone) + 86_400_000;

  const rows = bookingsFor(input.orgId, (b) => {
    // A seat in a class is drawn by its session, not as an appointment of its
    // own: eight seats in one room are one block with a count, not eight
    // overlapping ones the desk has to read through.
    if (b.sessionId) return false;
    const at = new Date(String(b.startsAt)).getTime();
    if (at < fromMs || at >= toMs) return false;
    if (input.providerId && b.providerId !== input.providerId) return false;
    /**
     * A filtered diary is that site's diary, full stop.
     *
     * This used to let an appointment with *no* site through every site's filter
     * (`input.locationId && b.locationId && …`), so one unfiled booking showed up
     * on both clinic days at once — the same visit apparently in two buildings,
     * which is exactly the cross-site leak P8 exists to prevent. Unfiled
     * appointments stay visible in the unfiltered view, where the desk can give
     * them a home.
     */
    if (input.locationId && String(b.locationId ?? '') !== input.locationId) return false;
    return true;
  });

  const allProviders = list<Doc & { orgId: string; name: string; colour?: string; active?: boolean }>('providers', (p) => p.orgId === input.orgId && p.active !== false);

  let cursor = input.from;
  while (cursor <= input.to) {
    const [y, m, d] = cursor.split('-').map(Number);
    const dayStart = zonedToUtc(y, m, d, 0, 0, timezone);
    // Midnight to midnight on the grid's own clock: `+ 86_400_000` is a day and
    // an hour short on the Sunday a clock goes forward, which is a column that
    // loses its 23:00 appointment twice a year.
    const dayEnd = zonedToUtc(y, m, d + 1, 0, 0, timezone);
    const onDay = rows
      .filter((b) => {
        const at = new Date(String(b.startsAt)).getTime();
        return at >= dayStart && at < dayEnd;
      })
      .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());

    const named = onDay.map((b) => {
      const provider = b.providerId ? providerById(input.orgId, b.providerId) : undefined;
      const service = b.serviceId ? serviceById(input.orgId, b.serviceId) : undefined;
      const site = b.locationId ? locationById(input.orgId, b.locationId) : undefined;
      const client = (b as { clientId?: string }).clientId ? clientById(input.orgId, String((b as { clientId?: string }).clientId)) : undefined;
      const startMs = new Date(b.startsAt).getTime();
      // The row's offset is measured on the grid's clock — the same clock the
      // drag writes back in — and the row names its own site, so a mixed-site
      // diary reads as "13:00, at the San Francisco site" rather than as a block
      // floating on a clock nobody can see.
      const localStartMs = dayStart;
      return {
        ...b,
        providerName: provider?.name,
        serviceName: service?.name ?? b.service,
        locationName: site?.name,
        roomName: b.roomId ? roomNameOf(input.orgId, b.roomId) : undefined,
        clientName: client?.name,
        hasAlerts: Boolean(
          client && patientAlertsFor(input.orgId, client.id, { includeClinical: Boolean(input.includeClinicalAlerts) }).length,
        ),
        localStart: Math.round((startMs - localStartMs) / 60_000),
        localEnd: Math.round((startMs + b.durationMinutes * 60_000 - localStartMs) / 60_000),
      } as DiaryDay['appointments'][number];
    });

    const onDaySessions = classSessionsFor(input.orgId, (session) => {
      if (input.providerId && session.providerId !== input.providerId) return false;
      if (input.locationId && String(session.locationId ?? '') !== input.locationId) return false;
      const at = new Date(String(session.startsAt)).getTime();
      return at >= dayStart && at < dayEnd;
    })
      .map((session) => {
        const summary = summariseSession(input.orgId, session);
        const at = new Date(String(session.startsAt)).getTime();
        return {
          id: summary.id,
          serviceId: summary.serviceId,
          serviceName: summary.serviceName,
          providerId: summary.providerId,
          providerName: summary.providerName,
          locationId: summary.locationId,
          locationName: summary.locationName,
          roomId: summary.roomId,
          roomName: summary.roomName,
          startsAt: summary.startsAt,
          durationMinutes: summary.durationMinutes,
          capacity: summary.capacity,
          seats: summary.seats,
          seatsLeft: summary.seatsLeft,
          status: summary.status,
          // Measured on the grid's clock, exactly like the blocks beside it, so a
          // class and an appointment at the same hour line up.
          localStart: Math.round((at - dayStart) / 60_000),
          localEnd: Math.round((at + summary.durationMinutes * 60_000 - dayStart) / 60_000),
        } as DiarySession;
      })
      .sort((a, b) => a.localStart - b.localStart);

    days.push({
      date: cursor,
      appointments: named,
      sessions: onDaySessions,
      stats: {
        booked: named.filter((a) => a.status === 'confirmed' || a.status === 'pending' || a.status === 'arrived').length,
        cancelled: named.filter((a) => a.status === 'cancelled').length,
        minutes: named.filter((a) => a.status !== 'cancelled').reduce((sum, a) => sum + a.durationMinutes, 0),
        classes: onDaySessions.filter((s) => s.status !== 'cancelled').length,
        seats: onDaySessions.filter((s) => s.status !== 'cancelled').reduce((sum, s) => sum + s.seats, 0),
      },
    });
    cursor = addDays(cursor, 1);
  }

  return {
    days,
    timezone,
    /** The site whose clock the grid is on — `undefined` means the practice's own. */
    gridSiteId: location?.id,
    providers: allProviders.map((p) => ({ id: p.id, name: p.name, colour: p.colour ?? 'brand' })),
    sites: locationsFor(input.orgId)
      .filter((l) => l.active !== false)
      .map((l) => ({ id: l.id, name: l.name, timezone: l.timezone })),
    ready: practiceIsRunnable(input.orgId),
  };
}

/* -------------------------------------------------------------------- move */

export type MoveResult =
  | { ok: true; booking: BookingDoc; changed: string[] }
  | { ok: false; error: 'not_found' | 'conflict' | 'invalid'; message: string; alternatives?: { startsAt: string; providerName?: string }[] };

/**
 * Move, resize or reassign an appointment.
 *
 * Whatever the change, the destination has to satisfy the same rules a new
 * booking does — otherwise dragging a block would be a way around the engine.
 */
export function moveAppointment(input: {
  orgId: string;
  id: string;
  startsAt?: string;
  durationMinutes?: number;
  providerId?: string;
  locationId?: string;
  roomId?: string;
  actor: string;
  actorName?: string;
  fundingOverride?: { by: string; reason: string };
}): MoveResult {
  const booking = bookingsFor(input.orgId, (b) => b.id === input.id)[0];
  if (!booking) return { ok: false, error: 'not_found', message: `No appointment with id ${input.id}.` };

  const startsAt = input.startsAt ?? booking.startsAt;
  if (Number.isNaN(new Date(startsAt).getTime())) return { ok: false, error: 'invalid', message: '`startsAt` must be an ISO instant.' };
  const duration = Math.max(5, Number(input.durationMinutes ?? booking.durationMinutes ?? 30));
  const providerId = input.providerId ?? booking.providerId;
  const locationId = input.locationId ?? booking.locationId;
  const service = booking.serviceId ? serviceById(input.orgId, booking.serviceId) : undefined;

  /**
   * Which room the moved appointment lands in.
   *
   * A room named by the caller is honoured. Otherwise a move to a new time or a
   * new site takes the room free *then* — the same rule a booking follows. What
   * must not happen is the old room being carried along blindly: the diary would
   * be putting two people in one room, and the clash check would only find out
   * afterwards. If no room is free, the move is refused with a reason.
   */
  const movedFrom = { at: String(booking.startsAt), locationId: booking.locationId };
  const relocating = new Date(startsAt).getTime() !== new Date(movedFrom.at).getTime() || locationId !== movedFrom.locationId;
  const pickedRoom = input.roomId
    ? { id: input.roomId }
    : relocating
      ? freeRoomFor(input.orgId, {
          locationId,
          startsAt: new Date(startsAt).toISOString(),
          durationMinutes: duration,
          serviceId: booking.serviceId,
          ignoreBookingId: booking.id,
        })
      : { id: booking.roomId };
  const roomId = input.roomId ?? pickedRoom?.id;
  if (relocating && !input.roomId && booking.roomId && !roomId) {
    const site = locationId ? locationById(input.orgId, locationId)?.name : undefined;
    return {
      ok: false,
      error: 'conflict',
      message: `Every room${site ? ` at ${site}` : ''} is taken at that time. Move another appointment, or pick a different time.`,
    };
  }

  const changed: string[] = [];
  if (new Date(startsAt).getTime() !== new Date(booking.startsAt).getTime()) changed.push('time');
  if (duration !== booking.durationMinutes) changed.push('duration');
  if (providerId !== booking.providerId) changed.push('provider');
  if (locationId !== booking.locationId) changed.push('location');
  if (roomId !== booking.roomId) changed.push('room');

  if (providerId) {
    const verdict = isFree({
      orgId: input.orgId,
      providerId,
      startsAt: new Date(startsAt).toISOString(),
      durationMinutes: duration,
      service,
      roomId,
      locationId,
      ignoreBookingId: booking.id,
    });
    if (!verdict.free) {
      return {
        ok: false,
        error: 'conflict',
        message: verdict.reason ?? 'That time is not free.',
        alternatives: verdict.conflicts.slice(0, 3).map((c) => ({ startsAt: c.startsAt, providerName: c.service })),
      };
    }
  }

  const movePatch: Partial<BookingDoc> = {
    startsAt: new Date(startsAt).toISOString(),
    durationMinutes: duration,
    providerId,
    locationId,
    roomId,
    revision: booking.revision + 1,
    history: [
      ...(booking.history ?? []),
      { at: new Date().toISOString(), event: 'moved', detail: `${booking.startsAt} → ${new Date(startsAt).toISOString()}${changed.includes('provider') ? ' (reassigned)' : ''}` },
    ].slice(-40),
  };
  const fundingMove = booking.caseId || booking.fundingAllocation
    ? commitBookingFunding({
        orgId: input.orgId,
        booking: { ...booking, ...movePatch } as BookingDoc,
        expectedRevision: Number(booking.revision ?? 0),
        actorId: input.actor,
        reason: `appointment moved (${changed.join(', ') || 'no change'})`,
        override: input.fundingOverride,
      })
    : undefined;
  if (fundingMove && !fundingMove.ok) return { ok: false, error: 'conflict', message: fundingMove.error };
  const updated = fundingMove?.ok
    ? fundingMove.value as BookingDoc
    : update<BookingDoc>('bookings', booking.id, movePatch);
  if (!updated) return { ok: false, error: 'not_found', message: 'The appointment disappeared while moving it.' };

  audit({
    orgId: input.orgId,
    actor: input.actor,
    action: 'appointment.moved',
    target: booking.id,
    detail: changed.join(', ') || 'no change',
  });
  recordAccess({
    orgId: input.orgId,
    resource: 'appointment',
    resourceId: booking.id,
    action: 'update',
    actor: input.actor,
    actorName: input.actorName,
    detail: `moved (${changed.join(', ') || 'no change'})`,
  });
  void deliverWebhook({
    orgId: input.orgId,
    event: 'appointment.moved',
    payload: {
      type: 'appointment.moved',
      appointment: { id: updated.id, externalId: updated.externalId, startsAt: updated.startsAt, durationMinutes: updated.durationMinutes, providerId: updated.providerId, status: updated.status },
      changed,
    },
  });
  return { ok: true, booking: updated, changed };
}

/* ------------------------------------------------------------------ status */

export const STATUS_TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  pending: ['confirmed', 'arrived', 'cancelled', 'no_show'],
  confirmed: ['arrived', 'completed', 'cancelled', 'no_show', 'pending'],
  arrived: ['completed', 'cancelled', 'no_show'],
  completed: ['confirmed'],
  cancelled: ['confirmed', 'pending'],
  no_show: ['confirmed', 'cancelled', 'pending'],
};

export function setAppointmentStatus(input: {
  orgId: string;
  id: string;
  status: BookingStatus;
  note?: string;
  actor: string;
  actorName?: string;
  fundingOverride?: { by: string; reason: string };
}):
  | { ok: true; booking: BookingDoc; waitListMatches?: WaitEntryDoc[] }
  | { ok: false; error: 'not_found' | 'invalid'; message: string } {
  const booking = bookingsFor(input.orgId, (b) => b.id === input.id)[0];
  if (!booking) return { ok: false, error: 'not_found', message: `No appointment with id ${input.id}.` };
  if (booking.status === input.status) return { ok: true, booking };

  const allowed = STATUS_TRANSITIONS[booking.status] ?? [];
  if (!allowed.includes(input.status)) {
    return {
      ok: false,
      error: 'invalid',
      message: `An appointment that is \`${booking.status}\` cannot become \`${input.status}\`. Allowed: ${allowed.join(', ') || 'nothing'}.`,
    };
  }

  const now = new Date().toISOString();
  const statusPatch: Partial<BookingDoc> = {
    status: input.status,
    revision: booking.revision + 1,
    history: [
      ...(booking.history ?? []),
      { at: now, event: `status:${input.status}`, detail: input.note },
    ].slice(-40),
  };
  const fundingStatus = booking.caseId || booking.fundingAllocation
    ? commitBookingFunding({
        orgId: input.orgId,
        booking: { ...booking, ...statusPatch } as BookingDoc,
        expectedRevision: Number(booking.revision ?? 0),
        actorId: input.actor,
        reason: input.note ?? `appointment status ${booking.status} → ${input.status}`,
        override: input.fundingOverride,
      })
    : undefined;
  if (fundingStatus && !fundingStatus.ok) return { ok: false, error: 'invalid', message: fundingStatus.error };
  const updated = fundingStatus?.ok
    ? fundingStatus.value as BookingDoc
    : update<BookingDoc>('bookings', booking.id, statusPatch);
  if (!updated) return { ok: false, error: 'not_found', message: 'The appointment disappeared while updating it.' };

  // A reminder for a visit that is not happening is worse than no reminder: it
  // sends somebody to an empty waiting room. Cancelling takes the text back.
  if (input.status === 'cancelled') cancelRemindersFor(input.orgId, input.id, 'appointment cancelled');

  // A class seat may be holding a pack place: attendance spends it, a late
  // cancel or no-show burns it, an early cancel gives it back, and undoing the
  // register mark un-spends it. One hook, here, so the register, the diary,
  // the client's own link and an SMS reply all move the pack the same way.
  packOnSeatStatus({ orgId: input.orgId, booking: updated, from: booking.status, to: input.status, actor: input.actor, actorName: input.actorName });

  // The visit happened, so the bill exists (P6) — when the practice wants it that
  // way. Off by default, because a practice that bills in batches will do that on
  // purpose; on, for the practices that want the invoice waiting at the desk before
  // the patient reaches it. Either way it is a *draft*: nobody issues an invoice by
  // marking an appointment finished. Idempotent — invoicing a booking already
  // invoiced returns the existing one rather than raising a second.
  if (input.status === 'completed' && moneySettingsFor(input.orgId).autoInvoiceOnComplete) {
    const raised = invoiceFromBooking({ orgId: input.orgId, bookingId: booking.id, actor: 'system', actorName: 'Auto-invoice' });
    if (raised.ok) {
      audit({ orgId: input.orgId, actor: input.actor, action: 'invoice.drafted_from_visit', target: raised.value.id, detail: `draft for ${booking.externalId}` });
    } else if (raised.code !== 'CONFLICT') {
      // CONFLICT means "already invoiced", which is the normal second visit to this
      // line. Anything else is worth a log line rather than a failed status change.
      console.warn(`[money] could not draft an invoice for ${booking.id}: ${raised.error}`);
    }
  }

  audit({ orgId: input.orgId, actor: input.actor, action: `appointment.${input.status}`, target: booking.id, detail: input.note ?? `${booking.status} → ${input.status}` });
  recordAccess({
    orgId: input.orgId,
    resource: 'appointment',
    resourceId: booking.id,
    action: 'update',
    actor: input.actor,
    actorName: input.actorName,
    detail: `status ${booking.status} → ${input.status}`,
  });
  void deliverWebhook({
    orgId: input.orgId,
    event: `appointment.${input.status}`,
    payload: { type: `appointment.${input.status}`, appointment: { id: updated.id, externalId: updated.externalId, startsAt: updated.startsAt, status: updated.status } },
  });

  // A cancellation is the one status other people are waiting for: the wait
  // list is checked here so the diary can offer the freed time immediately.
  //
  // …unless it is a *class seat*. The class is still running in that room at that
  // hour, so offering the time to the wait list would offer somebody a slot the
  // engine will refuse them the moment they try to take it (A8).
  const freed = input.status === 'cancelled' && !booking.sessionId ? matchWaitList({ orgId: input.orgId, booking }) : [];
  return { ok: true, booking: updated, ...(freed.length ? { waitListMatches: freed } : {}) };
}

/* ------------------------------------------------------------------ series */

export type RepeatRule = {
  every: 'day' | 'week' | 'fortnight' | 'month';
  /** Number of appointments in the series, including the first. */
  count?: number;
  /** Or: stop on/at this date. */
  until?: string;
};

export function seriesOccurrences(first: string, rule: RepeatRule): string[] {
  const count = Math.max(1, Math.min(Number(rule.count ?? 6), 52));
  const out: string[] = [new Date(first).toISOString()];
  const untilMs = rule.until ? new Date(`${rule.until.slice(0, 10)}T23:59:59Z`).getTime() : undefined;
  for (let i = 1; i < count; i += 1) {
    const base = new Date(out[out.length - 1]);
    if (rule.every === 'day') base.setUTCDate(base.getUTCDate() + 1);
    else if (rule.every === 'week') base.setUTCDate(base.getUTCDate() + 7);
    else if (rule.every === 'fortnight') base.setUTCDate(base.getUTCDate() + 14);
    else base.setUTCMonth(base.getUTCMonth() + 1);
    if (untilMs && base.getTime() > untilMs) break;
    out.push(base.toISOString());
  }
  return out;
}

/**
 * Book a repeating series.
 *
 * Occurrences that clash are *reported*, not silently dropped: a receptionist
 * creating six fortnightly appointments needs to know that the fourth lands on
 * a public holiday. The first appointment is booked for real, the rest follow,
 * and anything refused comes back in `skipped`.
 */
export function createSeries(input: {
  orgId: string;
  externalIdBase: string;
  customer: { name: string; number: string; email?: string };
  serviceId?: string;
  providerId?: string;
  locationId?: string;
  roomId?: string;
  startsAt: string;
  durationMinutes?: number;
  caseId?: string;
  coverageId?: string;
  authorisationId?: string;
  fundingOverrideReason?: string;
  repeat: RepeatRule;
  status?: BookingStatus;
  actor: string;
  actorName?: string;
}): { seriesId: string; booked: BookingDoc[]; skipped: { startsAt: string; reason: string }[] } {
  const seriesId = `ser_${Math.random().toString(36).slice(2, 12)}`;
  const occurrences = seriesOccurrences(input.startsAt, input.repeat);
  const service = input.serviceId ? serviceById(input.orgId, input.serviceId) : undefined;
  const booked: BookingDoc[] = [];
  const skipped: { startsAt: string; reason: string }[] = [];

  occurrences.forEach((startsAt, index) => {
    if (input.providerId) {
      const verdict = isFree({
        orgId: input.orgId,
        providerId: input.providerId,
        startsAt,
        durationMinutes: input.durationMinutes ?? service?.durationMinutes ?? 30,
        service,
        roomId: input.roomId,
      });
      if (!verdict.free) {
        skipped.push({ startsAt, reason: verdict.reason ?? 'that time is taken' });
        return;
      }
    }
    try {
      const { booking } = upsertBooking({
        orgId: input.orgId,
        externalId: `${input.externalIdBase}-${index + 1}`,
        customer: input.customer,
        service: service?.name,
        startsAt,
        durationMinutes: input.durationMinutes ?? service?.durationMinutes,
        value: service?.price,
        providerId: input.providerId,
        serviceId: input.serviceId,
        locationId: input.locationId,
        roomId: input.roomId,
        status: input.status ?? 'confirmed',
        source: 'dashboard',
        seriesId,
        seriesIndex: index,
        caseId: input.caseId,
        coverageId: input.coverageId,
        authorisationId: input.authorisationId,
        fundingOverrideReason: input.fundingOverrideReason,
        actor: input.actor,
        actorName: input.actorName,
      } as never);
      booked.push(booking);
    } catch (err) {
      if (err instanceof BookingFundingError) {
        skipped.push({ startsAt, reason: err.message });
        return;
      }
      throw err;
    }
  });

  audit({
    orgId: input.orgId,
    actor: input.actor,
    action: 'appointment.series_created',
    target: seriesId,
    detail: `${input.repeat.every} × ${booked.length}${skipped.length ? ` (${skipped.length} skipped)` : ''}`,
  });
  return { seriesId, booked, skipped };
}

export function cancelSeries(input: { orgId: string; seriesId: string; from?: string; actor: string; actorName?: string }) {
  // Each cancelled occurrence is its own freed slot, and each is offered by the
  // caller (the route) once it has the list — `diary` cannot import the offer
  // engine without a cycle, and a freed slot nobody offers is the defect this
  // whole phase exists to close.
  const rows = bookingsFor(input.orgId, (b) => (b as { seriesId?: string }).seriesId === input.seriesId);
  const cancelled: string[] = [];
  const fromMs = input.from ? new Date(input.from).getTime() : 0;
  for (const booking of rows) {
    if (booking.status === 'cancelled') continue;
    if (fromMs && new Date(booking.startsAt).getTime() < fromMs) continue;
    setAppointmentStatus({ orgId: input.orgId, id: booking.id, status: 'cancelled', note: 'series cancelled', actor: input.actor, actorName: input.actorName });
    cancelled.push(booking.id);
  }
  audit({ orgId: input.orgId, actor: input.actor, action: 'appointment.series_cancelled', target: input.seriesId, detail: `${cancelled.length} appointments` });
  return { seriesId: input.seriesId, cancelled: cancelled.length, ids: cancelled };
}

export function seriesFor(orgId: string, seriesId: string): BookingDoc[] {
  return bookingsFor(orgId, (b) => (b as { seriesId?: string }).seriesId === seriesId).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/* --------------------------------------------------------------- wait list */

export function waitListFor(orgId: string, opts?: { status?: WaitEntryDoc['status'][]; includeCancelled?: boolean }): WaitEntryDoc[] {
  return list<WaitEntryDoc>('waitList', (w) => {
    if (w.orgId !== orgId) return false;
    if (opts?.status) return opts.status.includes(w.status);
    if (!opts?.includeCancelled && (w.status === 'cancelled' || w.status === 'expired')) return false;
    return true;
  }).sort((a, b) => a.from.localeCompare(b.from));
}

export function addWaitEntry(
  orgId: string,
  input: { name: string; number: string; email?: string; serviceId?: string; providerId?: string; locationId?: string; from: string; to?: string; notes?: string; clientId?: string },
  actor: string,
  actorName?: string
): WaitEntryDoc {
  const now = new Date().toISOString();
  // A wait entry is also a client: someone waiting for a slot is someone the
  // practice will book, and their record already knows their number.
  const client = input.clientId
    ? clientById(orgId, input.clientId)
    : input.number
      ? ensureClientForBooking(orgId, { name: input.name, number: input.number, email: input.email }, actor, { actorName })
      : undefined;

  const entry = insert<WaitEntryDoc>('waitList', {
    id: `wl_${Math.random().toString(36).slice(2, 12)}`,
    orgId,
    clientId: client?.id,
    name: client?.name ?? input.name,
    number: client?.number ?? input.number,
    email: client?.email ?? input.email,
    serviceId: input.serviceId,
    providerId: input.providerId,
    locationId: input.locationId,
    from: input.from,
    to: input.to,
    notes: input.notes,
    status: 'waiting',
    createdAt: now,
    updatedAt: now,
  } as WaitEntryDoc);

  audit({ orgId, actor, action: 'waitlist.added', target: entry.id, detail: `${entry.name} from ${entry.from}` });
  return entry;
}

export function removeWaitEntry(
  orgId: string,
  id: string,
  actor: string,
  reason: WaitEntryDoc['status'] = 'cancelled'
): boolean {
  const entry = waitListFor(orgId, { includeCancelled: true }).find((w) => w.id === id);
  if (!entry) return false;
  update<WaitEntryDoc>('waitList', id, { status: reason, updatedAt: new Date().toISOString() } as never);
  audit({ orgId, actor, action: `waitlist.${reason}`, target: id, detail: entry.name });
  return true;
}

/** Who on the wait list wants the slot this appointment just freed. */
export function matchWaitList(input: { orgId: string; booking: BookingDoc }): WaitEntryDoc[] {
  const startMs = new Date(input.booking.startsAt).getTime();
  return waitListFor(input.orgId, { status: ['waiting', 'offered'] }).filter((w) => {
    // A place in a class is not a time to be offered. Their window is the class's
    // date, so without this line a class waiter would be texted about a private
    // appointment that happens to fall on the same day — the exact confusion the
    // `classSeat` guard exists to prevent, seen from the other side.
    if (w.sessionId) return false;
    if (w.providerId && w.providerId !== input.booking.providerId) return false;
    if (w.serviceId && w.serviceId !== input.booking.serviceId) return false;
    if (w.locationId && w.locationId !== input.booking.locationId) return false;
    const from = new Date(`${w.from.slice(0, 10)}T00:00:00Z`).getTime();
    const to = w.to ? new Date(`${w.to.slice(0, 10)}T23:59:59Z`).getTime() : from + 30 * 86_400_000;
    return startMs >= from && startMs <= to;
  });
}

/** The earliest wait entry that fits a new opening — what a receptionist offers next. */
export function nextWaitingFor(orgId: string, slotIso: string): WaitEntryDoc | undefined {
  return matchWaitList({ orgId, booking: { startsAt: slotIso, providerId: undefined, serviceId: undefined } as BookingDoc })[0];
}

export function purgeWaitList(orgId: string, actor: string): number {
  const stale = waitListFor(orgId, { status: ['waiting', 'offered'] }).filter((w) => new Date(w.to ?? w.from).getTime() < Date.now() - 86_400_000);
  for (const entry of stale) removeWaitEntry(orgId, entry.id, actor, 'expired');
  return stale.length;
}

export function deleteWaitEntry(orgId: string, id: string, actor: string): boolean {
  const entry = waitListFor(orgId, { includeCancelled: true }).find((w) => w.id === id);
  if (!entry) return false;
  remove('waitList', id);
  audit({ orgId, actor, action: 'waitlist.deleted', target: id, detail: entry.name });
  return true;
}

/* ------------------------------------------------------- booking lifecycle */

export { noteAppointmentForClient };
