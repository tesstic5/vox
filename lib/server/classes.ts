/**
 * Classes and group appointments.
 *
 * One person, one practitioner, one room, one hour is the atom of this product —
 * and it is wrong for a class. A yoga session, a birthing group, a training
 * evening: eight people in the same room at the same time, one instructor, one
 * roster.
 *
 * **The model.** A *class* is a service with a capacity (`ServiceDoc.capacity` ≥ 2;
 * unset or 1 means one-to-one). A *session* is one scheduled occurrence of it —
 * instructor, site, room, start, length, seats. A *seat* is an ordinary booking
 * that carries `sessionId`. That last choice is the whole trick: because a seat is
 * a booking, every machine already built keeps working on it without a single
 * special case — reminders, the confirmation and its manage link, money and
 * receipts, the client's timeline, records and privacy. Nothing had to learn about
 * classes to keep serving them.
 *
 * **The one rule that makes capacity work.** A seat is *not* a busy block; the
 * session is. `availability.ts` skips bookings that carry a `sessionId` and reads
 * the sessions themselves, so the eight clients share their room happily while the
 * class as a whole blocks the practitioner and the room against everything else —
 * and a class with nobody booked yet *still* blocks them, which a seats-only model
 * would get wrong the moment the first booking was cancelled.
 *
 * **Nothing here is asynchronous, and that is a decision, not an accident.** The
 * store is a single process with one writer, so a seat count read and the seat
 * written against it cannot interleave. If this ever grows a second process, the
 * count has to move under the same lock as the write — a class that sells nine
 * seats out of eight is worse than one that refuses a sale.
 */

import { get, insert, list, newId, nowIso, update, type Doc } from './db';
import { audit } from './audit';
import { providerById, serviceById, locationById } from './practice';
import { BookingFundingError, bookingById, bookingsFor, upsertBooking, type BookingDoc } from './bookings';
import { isFree } from './availability';
import { ensureClientForBooking, findClientByNumber, setConsent } from './clients';
import { cancelMessage, messagesFor, queueMessage } from './messages';
import { freeRoomFor } from './rooms';
import { formatClock, dateStrIn, addDays, zonedToUtc } from './availability';
import { classWaiters, closeClassQueue, offerClassPlace } from './class-waitlist';
import { attachPackHold, packOnSeatStatus, packOnSessionCancelled } from './packs';
import { commitBookingFunding } from './funding';

/* ------------------------------------------------------------------- types */

export type ClassSessionDoc = Doc & {
  orgId: string;
  /** The class itself — a service whose `capacity` says how many fit. */
  serviceId: string;
  /** The instructor. */
  providerId: string;
  locationId: string;
  /** The room the whole class occupies. Optional: an outdoor or online class has none. */
  roomId?: string;
  startsAt: string;
  durationMinutes: number;
  /** Seats. Copied from the service when the session is made, overridable here. */
  capacity: number;
  status: 'scheduled' | 'cancelled';
  notes?: string;
  /** Who cancelled it, and why — the roster's own memory. */
  cancelledAt?: string;
  cancelledBy?: string;
  cancelledReason?: string;
  /** Present when this session was made as part of a weekly run. */
  seriesId?: string;
  seriesIndex?: number;
  createdBy?: string;
};

/** A session with its names, its clock and its seat count — what a screen wants. */
export type SessionSummary = {
  id: string;
  serviceId: string;
  serviceName: string;
  providerId: string;
  providerName?: string;
  locationId: string;
  locationName?: string;
  timezone: string;
  roomId?: string;
  roomName?: string;
  startsAt: string;
  durationMinutes: number;
  capacity: number;
  seats: number;
  seatsLeft: number;
  /** How many people are in line for a place — the queue's size, not who is in it. */
  waiting: number;
  status: 'scheduled' | 'cancelled';
  notes?: string;
  createdBy?: string;
  /** Same-day clock, in the site's own timezone. */
  local: { date: string; start: string; end: string; timezone: string; spoken: string };
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/* ------------------------------------------------------------------- store */

export function classSessionsFor(orgId: string, filter?: (s: ClassSessionDoc) => boolean) {
  return list<ClassSessionDoc>('classSessions', (s) => s.orgId === orgId && (!filter || filter(s)));
}

export function classSessionById(orgId: string, id: string) {
  const doc = get<ClassSessionDoc>('classSessions', id);
  return doc && doc.orgId === orgId ? doc : undefined;
}

/** The seats actually held: a cancelled seat is not a seat. */
export function seatsFor(orgId: string, sessionId: string): BookingDoc[] {
  return bookingsFor(orgId, (b) => b.sessionId === sessionId && b.status !== 'cancelled');
}

export function seatsLeft(orgId: string, session: ClassSessionDoc): number {
  return Math.max(0, Number(session.capacity ?? 0) - seatsFor(orgId, session.id).length);
}

/** The live class service behind a session, when it still exists. */
export function classFor(orgId: string, session: ClassSessionDoc) {
  return serviceById(orgId, session.serviceId);
}

/* --------------------------------------------------------------- summaries */

function roomNameOf(orgId: string, roomId?: string) {
  if (!roomId) return undefined;
  const room = get<Doc & { orgId?: string; name?: string }>('rooms', roomId);
  return room && room.orgId === orgId ? (room.name as string | undefined) : undefined;
}

export function summariseSession(orgId: string, session: ClassSessionDoc): SessionSummary {
  const service = serviceById(orgId, session.serviceId);
  const provider = providerById(orgId, session.providerId);
  const site = locationById(orgId, session.locationId);
  const timezone = site?.timezone ?? 'UTC';
  const at = new Date(session.startsAt).getTime();
  const start = formatClock(at, timezone);
  const end = formatClock(at + Number(session.durationMinutes ?? 60) * 60_000, timezone);
  const date = dateStrIn(timezone, at);
  const weekday = WEEKDAYS[new Date(zonedToUtc(...(date.split('-').map(Number) as [number, number, number]), 12, 0, timezone)).getUTCDay()];
  const seats = seatsFor(orgId, session.id).length;
  return {
    id: session.id,
    serviceId: session.serviceId,
    serviceName: service?.name ?? 'Class',
    providerId: session.providerId,
    providerName: provider?.name,
    locationId: session.locationId,
    locationName: site?.name,
    timezone,
    roomId: session.roomId,
    roomName: roomNameOf(orgId, session.roomId),
    startsAt: session.startsAt,
    durationMinutes: Number(session.durationMinutes ?? 60),
    capacity: Number(session.capacity ?? 0),
    seats,
    seatsLeft: Math.max(0, Number(session.capacity ?? 0) - seats),
    waiting: classWaiters(orgId, session.id).length,
    status: session.status,
    notes: session.notes,
    createdBy: session.createdBy,
    local: {
      date,
      start,
      end,
      timezone,
      spoken: `${weekday} ${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} at ${start}`,
    },
  };
}

export function listClassSessions(
  orgId: string,
  opts: { from?: string; to?: string; locationId?: string; serviceId?: string; includeCancelled?: boolean } = {}
): SessionSummary[] {
  const fromMs = opts.from ? new Date(`${opts.from}T00:00:00Z`).getTime() : Number.NEGATIVE_INFINITY;
  const toMs = opts.to ? new Date(`${opts.to}T23:59:59Z`).getTime() : Number.POSITIVE_INFINITY;
  return classSessionsFor(orgId, (s) => {
    if (!opts.includeCancelled && s.status === 'cancelled') return false;
    if (opts.locationId && s.locationId !== opts.locationId) return false;
    if (opts.serviceId && s.serviceId !== opts.serviceId) return false;
    // The window compares instants generously: the caller passes local dates and a
    // session three hours either side of midnight is still "that day" somewhere.
    const at = new Date(String(s.startsAt)).getTime();
    return at >= fromMs - 86_400_000 && at <= toMs + 86_400_000;
  })
    .map((s) => summariseSession(orgId, s))
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
}

/* ------------------------------------------------------------------ writes */

export type ClassWriteResult =
  | { ok: true; sessions: SessionSummary[] }
  | { ok: false; code: string; message: string; param?: string };

/**
 * Make a class session — or a weekly run of them.
 *
 * The clashes are checked with the same engine that guards every other booking:
 * the instructor's rota, their breaks, the site's hours, the room. A class that
 * could be created on top of a client's appointment would make the capacity rule
 * meaningless, because the diary would already be double-booked.
 */
export function createClassSession(input: {
  orgId: string;
  actor: string;
  actorName?: string;
  serviceId: string;
  providerId: string;
  locationId: string;
  roomId?: string;
  startsAt: string;
  durationMinutes?: number;
  capacity?: number;
  notes?: string;
  /** Repeat weekly, this many occurrences in total (1 = just the one). */
  repeatWeeks?: number;
}): ClassWriteResult {
  const service = serviceById(input.orgId, input.serviceId);
  if (!service || !service.active) {
    return { ok: false, code: 'NOT_FOUND', message: 'That class is not in the service list.', param: 'serviceId' };
  }
  const provider = providerById(input.orgId, input.providerId);
  if (!provider || !provider.active) {
    return { ok: false, code: 'NOT_FOUND', message: 'That instructor is not on the team.', param: 'providerId' };
  }
  if (provider.serviceIds.length && !provider.serviceIds.includes(service.id)) {
    return { ok: false, code: 'VALIDATION_ERROR', message: `${provider.name} does not run ${service.name}.`, param: 'providerId' };
  }
  const site = locationById(input.orgId, input.locationId);
  if (!site || !site.active) {
    return { ok: false, code: 'NOT_FOUND', message: 'That site is not one of yours.', param: 'locationId' };
  }
  if (provider.locationIds.length && !provider.locationIds.includes(site.id)) {
    return { ok: false, code: 'VALIDATION_ERROR', message: `${provider.name} does not work at ${site.name}.`, param: 'locationId' };
  }

  const startMs = new Date(String(input.startsAt ?? '')).getTime();
  if (!Number.isFinite(startMs)) return { ok: false, code: 'VALIDATION_ERROR', message: 'Pick a date and time for the class.', param: 'startsAt' };
  const duration = Math.round(Number(input.durationMinutes ?? service.durationMinutes) || 60);
  if (duration < 10 || duration > 12 * 60) {
    return { ok: false, code: 'VALIDATION_ERROR', message: 'A class runs from 10 minutes to 12 hours.', param: 'durationMinutes' };
  }

  const capacity = Math.round(Number(input.capacity ?? service.capacity ?? 0) || 0);
  if (capacity < 2) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: `A class needs at least 2 seats. ${service.name} is set up as a one-to-one service — give it a capacity in the service list, or pass one here.`,
      param: 'capacity',
    };
  }
  if (capacity > 200) return { ok: false, code: 'VALIDATION_ERROR', message: 'A class holds up to 200 people.', param: 'capacity' };

  const repeat = Math.max(1, Math.min(Math.round(Number(input.repeatWeeks ?? 1) || 1), 52));
  const seriesId = repeat > 1 ? newId('cls_') : undefined;
  const made: ClassSessionDoc[] = [];
  const clashes: string[] = [];

  for (let index = 0; index < repeat; index += 1) {
    const at = new Date(startMs + index * 7 * 86_400_000).toISOString();
    const judgement = isFree({
      orgId: input.orgId,
      providerId: provider.id,
      startsAt: at,
      durationMinutes: duration,
      service,
      roomId: input.roomId,
      locationId: site.id,
    });
    if (!judgement.free) {
      clashes.push(
        repeat > 1
          ? `${formatClock(Date.parse(at), site.timezone)} on ${dateStrIn(site.timezone, Date.parse(at))} — ${judgement.reason ?? 'that time is taken'}`
          : (judgement.reason ?? 'That time is taken for the instructor or the room.')
      );
      continue;
    }
    made.push(
      insert<ClassSessionDoc>('classSessions', {
        id: newId('ses_'),
        orgId: input.orgId,
        serviceId: service.id,
        providerId: provider.id,
        locationId: site.id,
        // A class occupies a room like anything else in the diary. Chosen by the
        // desk when they say so, otherwise the one that is free — the same rule
        // `upsertBooking` uses, so a class can never be created into thin air
        // while a private appointment is quietly handed its room.
        roomId:
          input.roomId ??
          freeRoomFor(input.orgId, {
            locationId: site.id,
            startsAt: at,
            durationMinutes: duration,
            serviceId: service.id,
          })?.id,
        startsAt: at,
        durationMinutes: duration,
        capacity,
        status: 'scheduled',
        notes: input.notes?.slice(0, 500),
        seriesId,
        seriesIndex: seriesId ? index : undefined,
        createdBy: input.actorName ?? input.actor,
        createdAt: nowIso(),
      })
    );
  }

  if (!made.length) {
    return { ok: false, code: 'CONFLICT', message: clashes[0] ?? 'That time is taken.', param: 'startsAt' };
  }

  /**
   * A service that was one-to-one until somebody booked a class into it *is* a
   * class service now, and the catalogue should say so — otherwise the next
   * person reads "capacity 1" on the service list while the diary holds eight.
   */
  if (!service.capacity || Number(service.capacity) < capacity) {
    update<Doc>('services', service.id, { capacity });
    audit({ orgId: input.orgId, actor: input.actor, action: 'service.capacity_set', target: service.id, detail: `${service.name} now holds ${capacity}` });
  }

  audit({
    orgId: input.orgId,
    actor: input.actorName ? `${input.actor} (${input.actorName})` : input.actor,
    action: 'class.sessions_created',
    target: made[0].id,
    detail: `${service.name} × ${made.length} at ${site.name}, ${capacity} seats`,
  });

  return { ok: true, sessions: made.map((s) => summariseSession(input.orgId, s)) };
}

/** Cancel one session and every seat in it, telling the people who held them. */
export function cancelClassSession(input: {
  orgId: string;
  id: string;
  actor: string;
  actorName?: string;
  reason?: string;
}): { ok: true; summary: SessionSummary; cancelledSeats: number; queueClosed: number } | { ok: false; code: string; message: string } {
  const session = classSessionById(input.orgId, input.id);
  if (!session) return { ok: false, code: 'NOT_FOUND', message: 'No such class session.' };
  if (session.status === 'cancelled') return { ok: false, code: 'CONFLICT', message: 'That session is already cancelled.' };

  const summary = summariseSession(input.orgId, session);
  const seats = seatsFor(input.orgId, session.id);
  let queued = 0;

  for (const seat of seats) {
    const seatPatch: Partial<BookingDoc> = {
      status: 'cancelled',
      revision: seat.revision + 1,
      history: [
        ...(seat.history ?? []),
        { at: nowIso(), event: 'cancelled', detail: `the class session was cancelled: ${input.reason ?? 'no reason given'}` },
      ].slice(-40),
    };
    if (seat.caseId || seat.fundingAllocation) {
      const released = commitBookingFunding({
        orgId: input.orgId,
        booking: { ...seat, ...seatPatch } as BookingDoc,
        expectedRevision: Number(seat.revision ?? 0),
        actorId: input.actor,
        reason: `class session cancelled: ${input.reason ?? 'no reason given'}`,
        disposition: 'release',
      });
      if (!released.ok) return { ok: false, code: released.code, message: released.error };
    } else {
      update<BookingDoc>('bookings', seat.id, seatPatch);
    }
    // The practice called this off, so pack places go back — never burn.
    packOnSessionCancelled({ orgId: input.orgId, booking: seat, actor: input.actor, actorName: input.actorName });
    // Everyone holding a seat hears it from the practice, on the channel they were
    // booked through — a class that vanishes silently is eight angry phone calls.
    const channel: 'sms' | 'email' = String(seat.customer?.number ?? '').trim() ? 'sms' : 'email';
    const sent = queueMessage({
      orgId: input.orgId,
      channel,
      to: String(channel === 'sms' ? seat.customer?.number ?? '' : seat.customer?.email ?? ''),
      clientId: seat.clientId,
      bookingId: seat.id,
      kind: 'confirmation',
      source: 'dashboard',
      subject: 'Class cancelled',
      // `spoken` already reads "Tuesday 20 October at 5:00pm" — prefixing the start
      // again produced "…at 5:00pm on 20 October at 5:00pm", which is how a
      // duplicated word survives a review: it only appears in the sent copy.
      body: `${seat.customer?.name ?? 'Hello'} — ${summary.serviceName} on ${summary.local.spoken} has been cancelled. ${input.reason ? `${input.reason} ` : ''}We are sorry; please call us and we will find you another time.`,
      respectConsent: true,
    });
    if (sent.status !== 'sent' && sent.status !== 'blocked') queued += 1;
  }

  const updated = update<ClassSessionDoc>('classSessions', session.id, {
    status: 'cancelled',
    cancelledAt: nowIso(),
    cancelledBy: input.actorName ?? input.actor,
    cancelledReason: input.reason?.slice(0, 300),
  }) as ClassSessionDoc;

  /**
   * The queue closes with the class: the people waiting were told they were in
   * line, so they are told the class is off — once, on a channel they can receive.
   * Their entries are `cancelled`, not `expired`: nothing expired.
   */
  const queue = closeClassQueue({
    orgId: input.orgId,
    session: updated,
    reason: input.reason,
    actor: input.actor,
    actorName: input.actorName,
  });

  audit({
    orgId: input.orgId,
    actor: input.actorName ? `${input.actor} (${input.actorName})` : input.actor,
    action: 'class.session_cancelled',
    target: session.id,
    detail: `${summary.serviceName} ${summary.local.date} ${summary.local.start} — ${seats.length} seat(s) released${queue.closed ? `, ${queue.closed} waiting place(s) closed` : ''}`,
  });

  return { ok: true, summary: summariseSession(input.orgId, updated), cancelledSeats: seats.length, queueClosed: queue.closed };
}

/* ------------------------------------------------------------------- seats */

export type SeatResult =
  | { ok: true; booking: BookingDoc; clientId: string; clientName: string; summary: SessionSummary; already: boolean }
  | { ok: false; code: string; message: string; param?: string };

function seatRefusal(orgId: string, session: ClassSessionDoc): SeatResult | undefined {
  const summary = summariseSession(orgId, session);
  if (session.status === 'cancelled') {
    return { ok: false, code: 'CONFLICT', message: 'That class session has been cancelled.', param: 'sessionId' };
  }
  if (new Date(String(session.startsAt)).getTime() < Date.now()) {
    return { ok: false, code: 'VALIDATION_ERROR', message: 'That class has already run. Pick an upcoming one.', param: 'sessionId' };
  }
  if (summary.seatsLeft <= 0) {
    return {
      ok: false,
      code: 'CONFLICT',
      message: `${summary.serviceName} at ${summary.local.start} is full — ${summary.capacity} of ${summary.capacity} seats taken. Ask the desk for the next one.`,
      param: 'sessionId',
    };
  }
  return undefined;
}

/**
 * Take a seat.
 *
 * The same routine serves the public page and the desk; the only difference is
 * whether the client is already known or has to be looked up by number. A person
 * who already holds a seat gets the seat they have rather than a second one —
 * pressing "join" twice is not a request for two places.
 */
export function joinClassSession(input: {
  orgId: string;
  session: ClassSessionDoc;
  name?: string;
  number?: string;
  email?: string;
  clientId?: string;
  consentSms?: boolean;
  consentEmail?: boolean;
  notes?: string;
  caseId?: string;
  coverageId?: string;
  authorisationId?: string;
  fundingOverrideReason?: string;
  source: 'online' | 'dashboard';
  actorId?: string;
  actorName?: string;
}): SeatResult {
  const session = input.session;
  const summary = summariseSession(input.orgId, session);
  const service = classFor(input.orgId, session);

  let clientId = input.clientId;
  let name = String(input.name ?? '').trim();
  let number = String(input.number ?? '').trim();

  if (clientId) {
    const client = get<Doc & { orgId?: string; name?: string; number?: string }>('clients', clientId);
    if (!client || client.orgId !== input.orgId) return { ok: false, code: 'NOT_FOUND', message: 'No such client.', param: 'clientId' };
    name = String(client.name ?? name);
    number = String(client.number ?? number);
  } else {
    if (name.length < 2) return { ok: false, code: 'VALIDATION_ERROR', message: 'Please give a name we can call you by.', param: 'name' };
    if (name.length > 120) return { ok: false, code: 'VALIDATION_ERROR', message: 'That name is longer than we can store.', param: 'name' };
    if (number.replace(/\D/g, '').length < 7) return { ok: false, code: 'VALIDATION_ERROR', message: 'That phone number does not look complete.', param: 'number' };
  }

  // Somebody already in the class — including themselves, which is the common case
  // when a page is refreshed or a button double-tapped.
  const existing = findClientByNumber(input.orgId, number);
  const alreadySeated = existing
    ? bookingsFor(input.orgId, (b) => b.sessionId === session.id && b.clientId === existing.id && b.status !== 'cancelled')[0]
    : undefined;
  if (alreadySeated) {
    return { ok: true, booking: alreadySeated, clientId: existing!.id, clientName: String(existing!.name ?? name), summary, already: true };
  }

  const refusal = seatRefusal(input.orgId, session);
  if (refusal) return refusal;

  const client = clientId
    ? get<Doc>('clients', clientId)!
    : ensureClientForBooking(input.orgId, { name, number, email: input.email || undefined }, input.source === 'online' ? 'online-booking' : 'dashboard', {
        source: input.source === 'online' ? 'online' : 'booking',
      });

  // Consent, read exactly as the public booking page reads it: a tick records
  // permission, and a blank box on a *new* record is the answer — no.
  if (!clientId) {
    const had = Boolean(findClientByNumber(input.orgId, number));
    if (input.consentSms) setConsent(input.orgId, client.id, 'sms', true, { source: 'online-booking', note: 'ticked on the class form', actor: 'online-booking' });
    else if (!had) setConsent(input.orgId, client.id, 'sms', false, { source: 'online-booking-form', note: 'not ticked on the class form', actor: 'online-booking' });
    if (input.consentEmail && input.email) setConsent(input.orgId, client.id, 'email', true, { source: 'online-booking', note: 'ticked on the class form', actor: 'online-booking' });
  }

  let bookedSeat: BookingDoc;
  try {
    ({ booking: bookedSeat } = upsertBooking({
    orgId: input.orgId,
    /**
     * Unique per seat, not per millisecond. `Date.now()` alone collides when two
     * seats are taken in the same tick — and `upsertBooking` merges on the
     * external reference, so a collision would quietly fold two people into one
     * booking. A random tail makes the reference a reference, which is what the
     * rest of the product treats it as.
     */
    externalId: `CLS-${session.id.slice(-6)}-${Date.now().toString(36).toUpperCase()}-${newId('').slice(0, 4).toUpperCase()}`,
    customer: { name, number, email: input.email || undefined },
    service: service?.name ?? 'Class',
    startsAt: session.startsAt,
    durationMinutes: session.durationMinutes,
    status: 'confirmed',
    notes: input.notes?.slice(0, 500),
    value: service?.price,
    providerId: session.providerId,
    serviceId: session.serviceId,
    locationId: session.locationId,
    roomId: session.roomId,
    clientId: client.id,
    caseId: input.caseId,
    coverageId: input.coverageId,
    authorisationId: input.authorisationId,
    fundingOverrideReason: input.fundingOverrideReason,
    fundingOverrideBy: input.actorId,
    source: input.source,
    sessionId: session.id,
    }));
  } catch (error) {
    if (error instanceof BookingFundingError) return { ok: false, code: error.code === 'LIMIT_EXCEEDED' ? 'CONFLICT' : error.code, message: error.message, param: 'caseId' };
    throw error;
  }

  // A client holding a pack for this class has already paid for the place:
  // hold one against the pack (soonest-expiring first). It is spent only when
  // they actually come — see `packOnSeatStatus`.
  const booking = attachPackHold(input.orgId, bookedSeat);

  audit({
    orgId: input.orgId,
    actor: input.actorName ? `${input.source === 'online' ? 'online-booking' : 'dashboard'} (${input.actorName})` : (input.source === 'online' ? 'online-booking' : 'dashboard'),
    action: 'class.seat_taken',
    target: booking.id,
    detail: `${summary.serviceName} ${summary.local.date} ${summary.local.start} — ${name}${summary.seatsLeft - 1 <= 0 ? ' (last seat)' : ''}`,
  });

  return { ok: true, booking, clientId: client.id, clientName: name, summary: summariseSession(input.orgId, session), already: false };
}

/** Give a seat back. Used by the desk and by the client's own link. */
export function releaseSeat(input: {
  orgId: string;
  bookingId: string;
  actor: string;
  actorName?: string;
  reason?: string;
  /** The desk giving a place back to the rota deserves a different sentence. */
  quiet?: boolean;
}): { ok: true; summary?: SessionSummary; offered?: number } | { ok: false; code: string; message: string } {
  const booking = bookingById(input.orgId, input.bookingId);
  if (!booking) return { ok: false, code: 'NOT_FOUND', message: 'No such booking.' };
  if (!booking.sessionId) return { ok: false, code: 'VALIDATION_ERROR', message: 'That booking is not a place in a class.' };
  const session = classSessionById(input.orgId, booking.sessionId);
  if (!session) return { ok: false, code: 'NOT_FOUND', message: 'That class session no longer exists.' };
  if (booking.status === 'cancelled') {
    return { ok: true, summary: summariseSession(input.orgId, session) };
  }

  const seatPatch: Partial<BookingDoc> = {
    status: 'cancelled',
    revision: booking.revision + 1,
    history: [
      ...(booking.history ?? []),
      { at: nowIso(), event: 'cancelled', detail: `${input.reason ?? 'seat released'}` },
    ].slice(-40),
  };
  if (booking.caseId || booking.fundingAllocation) {
    const funded = commitBookingFunding({
      orgId: input.orgId,
      booking: { ...booking, ...seatPatch } as BookingDoc,
      expectedRevision: Number(booking.revision ?? 0),
      actorId: input.actor,
      reason: input.reason ?? 'class seat released',
    });
    if (!funded.ok) return { ok: false, code: funded.code, message: funded.error };
  } else {
    update<BookingDoc>('bookings', booking.id, seatPatch);
  }

  // The pack consequence of giving a place back: early releases the hold,
  // inside the late-cancel window the place burns — the same rule the status
  // lifecycle applies, told through the same hook.
  packOnSeatStatus({ orgId: input.orgId, booking, from: booking.status, to: 'cancelled', actor: input.actor, actorName: input.actorName });

  // A chase for a class the client is no longer attending is the rudest message
  // this product can send, so anything still queued for the booking is pulled.
  for (const pending of messagesFor(input.orgId, (m) => m.bookingId === booking.id && m.status === 'pending')) {
    cancelMessage(input.orgId, pending.id, input.quiet ? 'seat released' : 'cancelled by the client');
  }

  audit({
    orgId: input.orgId,
    actor: input.actorName ? `${input.actor} (${input.actorName})` : input.actor,
    action: 'class.seat_released',
    target: booking.id,
    detail: `${booking.customer?.name ?? 'a client'} left ${summariseSession(input.orgId, session).serviceName} — ${input.reason ?? 'no reason given'}`,
  });

  /**
   * The place is free, so it goes to the front of the class's own queue.
   *
   * This is the desk's door out of a seat; the client's link and an SMS reply come
   * through `offerFreedSlot`, which hands a class seat to the same queue. A place
   * given back at 9am and a place given back at 9pm must reach the same person.
   */
  const offered = offerClassPlace({
    orgId: input.orgId,
    session,
    bookingId: booking.id,
    actor: input.actor,
    actorName: input.actorName,
  });

  return { ok: true, summary: summariseSession(input.orgId, session), offered: offered.offered.length };
}

/* ----------------------------------------------------------------- publics */

/**
 * What a stranger may see about a practice's classes.
 *
 * Chosen for a stranger: the class, who runs it, where, when, how many seats are
 * left — and never who else is in it. The roster is the practice's business.
 */
export function publicClassSessions(orgId: string, opts: { from?: string; to?: string; horizonDays?: number } = {}) {
  const horizon = Math.max(1, Math.min(Number(opts.horizonDays ?? 60) || 60, 180));
  const now = Date.now();
  const until = now + horizon * 86_400_000;
  return classSessionsFor(orgId, (s) => {
    if (s.status !== 'scheduled') return false;
    const at = new Date(String(s.startsAt)).getTime();
    return at >= now && at <= until;
  })
    .map((s) => summariseSession(orgId, s))
    /**
     * Full classes are listed too, now that there is somewhere to wait for one:
     * a page that hides a full class is honest only if the visitor has no way to
     * ask for a place. `seatsLeft: 0` is what the card uses to offer the queue.
     */
    .filter((s) => s.capacity >= 2)
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
}

/** The roster: who is in it, and what state their seat is in. */
/**
 * How many of the places are held, and what has become of them.
 *
 * The roster has always shown each seat's status; this is the same information
 * counted, so a desk can say "four of eight, three here" without reading down a
 * list — and so the screen has a number to show rather than a guess at one.
 * `seats` counts places still held (a given-back place is not a seat), while
 * `capacity` is what the class was sold as.
 */
export function attendanceFor(orgId: string, session: ClassSessionDoc) {
  const seats = rosterFor(orgId, session);
  const count = (status: string) => seats.filter((seat) => seat.status === status).length;
  return {
    capacity: session.capacity,
    seats: seats.length,
    /** Nobody has arrived yet but the class is still to come. */
    confirmed: count('confirmed') + count('pending'),
    arrived: count('arrived'),
    completed: count('completed'),
    noShow: count('no_show'),
    /** Places not taken. */
    free: Math.max(0, session.capacity - seats.length),
    /** Somebody is recorded as having come. */
    attended: count('arrived') + count('completed'),
  };
}

/**
 * The class session that occupies a stretch of time, if any.
 *
 * Used where something is about to treat an hour as a free *slot* — the wait-list
 * desk offering a time, for instance. A class hour is not a slot: it is one room
 * and one instructor held for a roster, and promising it to a waiting client is
 * promising something that will be refused when they tap the link.
 */
export function sessionOverlapping(orgId: string, input: { startsAt: string; durationMinutes?: number; locationId?: string; providerId?: string }) {
  const at = Date.parse(input.startsAt);
  if (!Number.isFinite(at)) return undefined;
  const end = at + Math.max(1, Number(input.durationMinutes ?? 30)) * 60_000;
  return classSessionsFor(orgId, (session) => {
    if (session.status === 'cancelled') return false;
    if (input.locationId && session.locationId !== input.locationId) return false;
    if (input.providerId && session.providerId !== input.providerId) return false;
    const start = Date.parse(String(session.startsAt));
    return start < end && start + Number(session.durationMinutes ?? 60) * 60_000 > at;
  })[0];
}

export function rosterFor(orgId: string, session: ClassSessionDoc) {
  return bookingsFor(orgId, (b) => b.sessionId === session.id && b.status !== 'cancelled')
    .map((b) => ({
      bookingId: b.id,
      clientId: b.clientId,
      name: String(b.customer?.name ?? 'Client'),
      number: String(b.customer?.number ?? ''),
      status: String(b.status),
      reference: String(b.externalId ?? b.id),
      at: String(b.createdAt ?? ''),
      /** Pack funding for this seat, when a pack holds or settled it. */
      packId: b.packId,
      packState: b.packState,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Sessions on a window, keyed by local date — the diary and the board read this. */
export function sessionsByDate(orgId: string, from: string, to: string, opts: { locationId?: string; providerId?: string } = {}) {
  const byDate = new Map<string, SessionSummary[]>();
  for (const session of classSessionsFor(orgId, (s) => {
    if (opts.locationId && s.locationId !== opts.locationId) return false;
    if (opts.providerId && s.providerId !== opts.providerId) return false;
    return true;
  })) {
    const summary = summariseSession(orgId, session);
    if (summary.local.date < from || summary.local.date > to) continue;
    const list_ = byDate.get(summary.local.date) ?? [];
    list_.push(summary);
    byDate.set(summary.local.date, list_);
  }
  return byDate;
}

/** The next time this class runs — what a recall or a "join us" message can point at. */
export function nextSessionFor(orgId: string, serviceId: string) {
  const upcoming = classSessionsFor(orgId, (s) => s.serviceId === serviceId && s.status === 'scheduled' && new Date(String(s.startsAt)).getTime() > Date.now())
    .map((s) => summariseSession(orgId, s))
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  return upcoming[0];
}

/** A date, `n` days on, in a site's clock — a small helper the desk page shares. */
export function localDatePlus(timezone: string, days: number) {
  return addDays(dateStrIn(timezone), days);
}
