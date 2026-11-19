/**
 * The queue for a place in a full class.
 *
 * The slot wait-list answers "when could I come?" — its unit is a stretch of a
 * practitioner's diary that is free to sell. A class is the opposite: the time is
 * fixed, the room is held for the whole hour and the instructor is already booked,
 * so the only thing that can come free is a **place**. That difference is why this
 * is a second kind of entry rather than a new colour on the first one:
 *
 *  - the entry names the **session**, not a window;
 *  - the order is first-come-first-served and the person is told their position,
 *    because a class has one time and there is nothing to sort;
 *  - one place is offered to exactly **one** person. The slot list offers to five
 *    because it is a race against a shared link; a place offered to five people
 *    would mean four "sorry, that went" texts for one chair.
 *
 * Everything a screen needs is here; the routes only translate. The module is
 * deliberately self-contained — it imports `classes.ts` and `wait-offers.ts` as
 * *types only* — so the import graph stays acyclic:
 * `classes → class-waitlist` and `wait-offers → classes`.
 */

import { get, insert, list, update, newId, nowIso, type Doc } from './db';
import { audit } from './audit';
import { queueMessage } from './messages';
import { renderFor } from './templates';
import { offerLinkFor } from './manage-links';
import { dateStrIn, formatClock, weekdayOf } from './availability';
import { locationById, practiceTimezone, providerById, serviceById } from './practice';
import { ensureClientForBooking, findClientByNumber, setConsent } from './clients';
import type { ClassSessionDoc } from './classes';
import type { WaitEntryDoc } from './diary';
import type { WaitOfferDoc } from './wait-offers';

/**
 * How many people one class will queue before the answer is "call us".
 *
 * A queue is a promise to ring somebody; a list of fifty for a class of eight is
 * a list nobody rings. Twenty is more than a practice would ever chase by hand and
 * far less than a runaway loop can write.
 */
export const MAX_CLASS_WAITERS = 20;

/** Four hours: the same reading window the slot offers use. */
const OFFER_TTL_MS = 4 * 60 * 60 * 1000;

type BookingRow = Doc & {
  orgId?: string;
  sessionId?: string;
  status?: string;
  clientId?: string;
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/* --------------------------------------------------------------- the facts */

function liveSeats(orgId: string, sessionId: string): BookingRow[] {
  return list<BookingRow>('bookings', (b) => b.orgId === orgId && b.sessionId === sessionId && b.status !== 'cancelled');
}

export function classSeatsLeft(orgId: string, session: ClassSessionDoc): number {
  return Math.max(0, Number(session.capacity ?? 0) - liveSeats(orgId, session.id).length);
}

/** The class's own clock — the site's timezone, never the server's. */
function sessionTimezone(orgId: string, session: ClassSessionDoc): string {
  return locationById(orgId, String(session.locationId ?? ''))?.timezone ?? practiceTimezone(orgId);
}

/** "Tuesday 20 October at 6:00pm" — the sentence the message and the screen share. */
export function classSpoken(orgId: string, session: ClassSessionDoc): string {
  const timezone = sessionTimezone(orgId, session);
  const ms = Date.parse(String(session.startsAt));
  const date = dateStrIn(timezone, ms);
  return `${DAYS[weekdayOf(date)]} ${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} at ${formatClock(ms, timezone)}`;
}

/** "by 4:00pm today", in the class's own clock — an expiry a person can act on. */
function expiryWords(orgId: string, session: ClassSessionDoc, iso: string): string {
  const timezone = sessionTimezone(orgId, session);
  const at = Date.parse(iso);
  const today = dateStrIn(timezone);
  const day = dateStrIn(timezone, at);
  const clock = formatClock(at, timezone);
  if (day === today) return `${clock} today`;
  return `${clock} on ${DAYS[weekdayOf(day)]} ${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;
}

function className(orgId: string, session: ClassSessionDoc): string {
  return serviceById(orgId, session.serviceId)?.name ?? 'that class';
}

/* ------------------------------------------------------------- the entries */

/** Everyone still in line for a session, oldest first — the order is the promise. */
export function classWaiters(orgId: string, sessionId: string): WaitEntryDoc[] {
  return list<WaitEntryDoc>(
    'waitList',
    (w) => w.orgId === orgId && w.sessionId === sessionId && (w.status === 'waiting' || w.status === 'offered')
  ).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/** The offers out for a session that nobody has answered yet. */
export function classOpenOffers(orgId: string, sessionId: string): WaitOfferDoc[] {
  return list<WaitOfferDoc>('waitOffers', (o) => o.orgId === orgId && o.sessionId === sessionId && o.status === 'open').sort((a, b) =>
    String(a.createdAt).localeCompare(String(b.createdAt))
  );
}

/** What the desk reads beside a roster: who is in line, in order, and what is out. */
export function classQueueFor(orgId: string, session: ClassSessionDoc) {
  const waiting = classWaiters(orgId, session.id);
  const offers = classOpenOffers(orgId, session.id);
  return {
    count: waiting.length,
    waiting: waiting.map((entry, index) => ({
      id: entry.id,
      position: index + 1,
      name: entry.name,
      number: entry.number,
      email: entry.email,
      clientId: entry.clientId,
      status: entry.status,
      joinedAt: entry.createdAt,
      notes: entry.notes,
      /** An offer is out: the desk can see the queue is being worked, not stuck. */
      offerId: offers.find((o) => o.entryId === entry.id)?.id,
      offeredUntil: offers.find((o) => o.entryId === entry.id)?.expiresAt,
    })),
    openOffers: offers.length,
    seatsLeft: classSeatsLeft(orgId, session),
  };
}

/* ---------------------------------------------------------------- joining */

export type JoinClassWaitResult =
  | { ok: true; entry: WaitEntryDoc; position: number; already: boolean }
  | { ok: false; code: 'NOT_FOUND' | 'CONFLICT' | 'VALIDATION_ERROR'; message: string; param?: string };

/**
 * Put somebody in line for a place.
 *
 * Five refusals, each one a thing a person would otherwise be told wrongly:
 * a class that has gone, a queue for a class that is not full (book the place —
 * waiting while seats exist turns the queue into a soft hold), somebody already
 * in the class, somebody already in line (they get the place in line they have,
 * not a second one), and a queue already at its cap.
 */
export function joinClassWaitList(input: {
  orgId: string;
  session: ClassSessionDoc;
  name?: string;
  number?: string;
  email?: string;
  clientId?: string;
  source: 'online' | 'dashboard';
  actor: string;
  actorName?: string;
  consentSms?: boolean;
}): JoinClassWaitResult {
  const { orgId, session } = input;

  if (session.status !== 'scheduled') {
    return { ok: false, code: 'CONFLICT', message: 'That class was called off — there is no need to wait for a place in it.' };
  }
  if (Date.parse(String(session.startsAt)) <= Date.now()) {
    return { ok: false, code: 'CONFLICT', message: 'That class has already run. The desk can tell you when the next one is.' };
  }

  let clientId = input.clientId;
  let name = String(input.name ?? '').trim();
  let number = String(input.number ?? '').trim();
  let email = input.email ? String(input.email) : undefined;

  if (clientId) {
    const client = get<Doc & { orgId?: string; name?: string; number?: string; email?: string }>('clients', clientId);
    if (!client || client.orgId !== orgId) return { ok: false, code: 'NOT_FOUND', message: 'No such client.', param: 'clientId' };
    name = String(client.name ?? name);
    number = String(client.number ?? number);
    email = email ?? (client.email ? String(client.email) : undefined);
  } else {
    if (name.length < 2) return { ok: false, code: 'VALIDATION_ERROR', message: 'Please give a name we can call you by.', param: 'name' };
    if (number.replace(/\D/g, '').length < 7) return { ok: false, code: 'VALIDATION_ERROR', message: 'That phone number does not look complete.', param: 'number' };
  }

  // Somebody already in the class has the thing the queue is for.
  const known = clientId ? clientId : findClientByNumber(orgId, number)?.id;
  if (known && liveSeats(orgId, session.id).some((seat) => String(seat.clientId ?? '') === known)) {
    return { ok: false, code: 'CONFLICT', message: 'That person already has a place in this class.' };
  }

  // Pressing twice is not two places, and a place in line is worth keeping.
  const existing = classWaiters(orgId, session.id).find(
    (w) => (known && w.clientId === known) || (number && w.number === number && !known)
  );
  if (existing) {
    return { ok: true, entry: existing, position: classWaiters(orgId, session.id).findIndex((w) => w.id === existing.id) + 1, already: true };
  }

  const left = classSeatsLeft(orgId, session);
  if (left > 0) {
    return {
      ok: false,
      code: 'CONFLICT',
      message: `There ${left === 1 ? 'is' : 'are'} ${left} place${left === 1 ? '' : 's'} left in that class — take one instead of waiting for it.`,
      param: 'sessionId',
    };
  }

  const queue = classWaiters(orgId, session.id);
  if (queue.length >= MAX_CLASS_WAITERS) {
    return { ok: false, code: 'CONFLICT', message: 'The wait list for that class is full. Please call the practice — they can find you another class.', param: 'sessionId' };
  }

  const client = clientId
    ? get<Doc>('clients', clientId)!
    : ensureClientForBooking(orgId, { name, number, email }, input.source === 'online' ? 'online-booking' : 'dashboard', {
        source: input.source === 'online' ? 'online' : 'booking',
      });

  // Consent, read exactly as the class form reads it: a tick records permission,
  // and a blank box on a new record is the answer — no.
  if (!clientId) {
    const had = Boolean(findClientByNumber(orgId, number));
    if (input.consentSms) setConsent(orgId, client.id, 'sms', true, { source: 'class-waitlist', note: 'ticked on the wait-list form', actor: input.actor });
    else if (!had) setConsent(orgId, client.id, 'sms', false, { source: 'class-waitlist-form', note: 'not ticked on the wait-list form', actor: input.actor });
  }

  const timezone = sessionTimezone(orgId, session);
  const day = dateStrIn(timezone, Date.parse(String(session.startsAt)));
  const entry = insert<WaitEntryDoc>('waitList', {
    id: newId('wl_'),
    orgId,
    sessionId: session.id,
    clientId: client.id,
    name: String(client.name ?? name),
    number: String(client.number ?? number),
    email: email ?? (client.email ? String(client.email) : undefined),
    serviceId: session.serviceId,
    providerId: session.providerId,
    locationId: session.locationId,
    // The window is the class's own day, which is what the wait-list screen groups
    // by and what the purge rule reads. It is never used to match a slot: entries
    // carrying a `sessionId` are skipped by the slot matcher.
    from: day,
    to: day,
    status: 'waiting',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  } as WaitEntryDoc);

  const position = classWaiters(orgId, session.id).findIndex((w) => w.id === entry.id) + 1;
  audit({
    orgId,
    actor: input.actorName ? `${input.actor} (${input.actorName})` : input.actor,
    action: 'class.wait_joined',
    target: entry.id,
    detail: `${entry.name} is ${position === 1 ? 'first' : `${position}${position === 2 ? 'nd' : position === 3 ? 'rd' : 'th'}`} in line for ${className(orgId, session)} ${classSpoken(orgId, session)}`,
  });

  return { ok: true, entry, position, already: false };
}

/* -------------------------------------------------------------- the offer */

export type OfferClassPlaceResult = {
  offered: WaitOfferDoc[];
  /** How many are in line and were not reached this time. */
  skipped: number;
  reason?: 'past' | 'closed' | 'no-room' | 'already-offered' | 'nobody-waiting';
};

/**
 * Offer a place that has just come free to the person at the front of the line.
 *
 * One place, one offer. Called from every path that gives a seat back — the desk
 * taking it away and the client giving it up — so the behaviour does not depend on
 * which door the place left by.
 */
export function offerClassPlace(input: {
  orgId: string;
  session: ClassSessionDoc;
  /** The seat that came free, for the audit trail and the desk's "why". */
  bookingId?: string;
  actor: string;
  actorName?: string;
}): OfferClassPlaceResult {
  const { orgId, session } = input;

  if (session.status !== 'scheduled') return { offered: [], skipped: 0, reason: 'closed' };
  const startMs = Date.parse(String(session.startsAt));
  if (startMs <= Date.now()) return { offered: [], skipped: 0, reason: 'past' };

  const free = classSeatsLeft(orgId, session);
  const open = classOpenOffers(orgId, session.id);
  const queue = classWaiters(orgId, session.id).filter((w) => w.status === 'waiting');
  if (!queue.length) return { offered: [], skipped: 0, reason: 'nobody-waiting' };

  // A place already offered is a place already spoken for: only what is free
  // *and not yet out on an offer* can be offered again.
  const spare = free - open.length;
  if (spare <= 0) return { offered: [], skipped: queue.length, reason: 'already-offered' };

  const expiresAt = new Date(Math.min(Date.now() + OFFER_TTL_MS, startMs)).toISOString();
  if (Date.parse(expiresAt) <= Date.now()) return { offered: [], skipped: queue.length, reason: 'past' };

  const chosen = queue.slice(0, spare);
  const offered: WaitOfferDoc[] = [];
  const timezone = sessionTimezone(orgId, session);
  const spoken = classSpoken(orgId, session);
  const name = className(orgId, session);

  for (const entry of chosen) {
    const offer = insert<WaitOfferDoc>('waitOffers', {
      id: newId('wo_'),
      orgId,
      entryId: entry.id,
      /** A class offer names the session: that is what makes it a *place*. */
      sessionId: session.id,
      bookingId: input.bookingId,
      clientId: entry.clientId,
      name: entry.name,
      number: entry.number,
      email: entry.email,
      startsAt: String(session.startsAt),
      durationMinutes: Number(session.durationMinutes ?? 60),
      providerId: session.providerId,
      serviceId: session.serviceId,
      locationId: session.locationId,
      status: 'open',
      channel: entry.number ? 'sms' : 'email',
      createdAt: nowIso(),
      expiresAt,
    } as WaitOfferDoc);

    update<WaitEntryDoc>('waitList', entry.id, { status: 'offered', updatedAt: nowIso() } as never);

    const link = offerLinkFor(orgId, offer.id);
    const first = String(entry.name).split(/\s+/)[0] || 'there';
    const provider = providerById(orgId, String(session.providerId))?.name;
    const site = locationById(orgId, String(session.locationId))?.name;
    const expired = expiryWords(orgId, session, expiresAt);
    const context = {
      client_first_name: first,
      client_name: entry.name,
      service: name,
      appointment: name,
      provider: provider ?? '',
      location: site ?? '',
      when: spoken,
      when_date: spoken,
      when_time: formatClock(startMs, timezone),
      claim_link: link ?? '',
      offer_expires: expired,
    };
    const rendered = renderFor({
      orgId,
      kind: 'class_offer',
      channel: offer.channel,
      context,
      // The sentence is built so a link is never followed by a full stop: a
      // messenger that keeps the punctuation turns a one-tap link into a 404.
      fallback: link
        ? `Hi ${first} — a place in ${name} on ${spoken} has just come free. You are ${queue.findIndex((w) => w.id === entry.id) === 0 ? 'first' : 'next'} in line. Take it here: ${link}`
        : `Hi ${first} — a place in ${name} on ${spoken} has just come free. Reply here and it is yours.`,
    });

    const message = queueMessage({
      orgId,
      channel: offer.channel,
      to: offer.channel === 'email' ? String(entry.email ?? '') : String(entry.number),
      clientId: entry.clientId,
      body: rendered.body,
      subject: rendered.subject,
      kind: 'class_offer',
      source: 'waitlist',
      meta: { kind: 'class_offer', offerId: offer.id, entryId: entry.id, sessionId: session.id },
    });
    update<WaitOfferDoc>('waitOffers', offer.id, { messageId: message.id } as never);

    audit({
      orgId,
      actor: input.actorName ? `${input.actor} (${input.actorName})` : input.actor,
      action: 'class.place_offered',
      target: offer.id,
      detail: `${entry.name} ← a place in ${name} ${spoken} (${offer.channel}${message.status === 'blocked' ? ', blocked' : ''})${input.bookingId ? `, freed by ${input.bookingId}` : ''}`,
    });
    offered.push({ ...offer, messageId: message.id });
  }

  return { offered, skipped: Math.max(0, queue.length - chosen.length) };
}

/* -------------------------------------------------------------- the close */

/**
 * The class was called off: close the queue and tell the people in it, once.
 *
 * Their entries become `cancelled`, not `expired` — nothing expired; the thing
 * they were waiting for no longer exists. Any offer standing is withdrawn.
 */
export function closeClassQueue(input: {
  orgId: string;
  session: ClassSessionDoc;
  reason?: string;
  actor: string;
  actorName?: string;
}): { closed: number; told: number } {
  const { orgId, session } = input;
  const spoken = classSpoken(orgId, session);
  const name = className(orgId, session);

  let withdrawn = 0;
  for (const offer of classOpenOffers(orgId, session.id)) {
    update<WaitOfferDoc>('waitOffers', offer.id, {
      status: 'withdrawn',
      respondedAt: nowIso(),
      note: 'the class was called off',
    } as never);
    withdrawn += 1;
  }

  const queue = classWaiters(orgId, session.id);
  let closed = 0;
  let told = 0;
  for (const entry of queue) {
    update<WaitEntryDoc>('waitList', entry.id, {
      status: 'cancelled',
      updatedAt: nowIso(),
      notes: [entry.notes, 'the class was called off'].filter(Boolean).join(' · ').slice(0, 500),
    } as never);
    closed += 1;

    // One message per person, on the channel they can actually receive.
    const channel: 'sms' | 'email' = String(entry.number ?? '').trim() ? 'sms' : 'email';
    const to = channel === 'sms' ? String(entry.number) : String(entry.email ?? '');
    if (!to) continue;
    const sent = queueMessage({
      orgId,
      channel,
      to,
      clientId: entry.clientId,
      kind: 'manual',
      source: 'dashboard',
      subject: 'Class called off',
      body:
        `${entry.name} — ${name} on ${spoken} has been called off, so the wait list for it is closed. ` +
        `${input.reason ? `${input.reason} ` : ''}Nothing is owed. Call us and we will find you another class.`,
      respectConsent: true,
    });
    if (sent.status !== 'blocked') told += 1;
  }

  if (closed || withdrawn) {
    audit({
      orgId,
      actor: input.actorName ? `${input.actor} (${input.actorName})` : input.actor,
      action: 'class.queue_closed',
      target: session.id,
      detail: `${name} ${spoken} — ${closed} in line closed, ${withdrawn} offer(s) withdrawn, ${told} told`,
    });
  }
  return { closed, told };
}
