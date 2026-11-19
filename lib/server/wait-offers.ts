/**
 * The freed slot, offered to the people who asked for one.
 *
 * The diary already knew *who* was waiting (`matchWaitList`) and the answer only
 * ever reached a toast — "3 waiting clients want that slot" — which put the whole
 * job back on a receptionist's memory. This module closes that loop: a
 * cancellation texts the people whose window the slot falls inside, each with
 * their own link, and the first to accept has the appointment.
 *
 * Three things it deliberately does not do:
 *
 *  1. **It does not hold the slot.** A claim is checked against the diary like any
 *     other booking, so if somebody else took the time in the meantime the claim
 *     is refused honestly and the page offers the next openings instead. Holding
 *     would mean a cancellation could freeze a slot nobody ever claims.
 *  2. **It does not go to everybody.** A practice with forty people waiting "any
 *     time this week" gets five offers on one slot, soonest window first, and a
 *     fresh cancellation is a fresh chance for the rest.
 *  3. **It does not offer a time that has passed.** Cancelling last Tuesday's
 *     appointment is bookkeeping, not an opportunity.
 */

import { insert, list, update, newId, type Doc } from './db';
import { audit } from './audit';
import { matchWaitList, waitListFor, type WaitEntryDoc } from './diary';
import { dateStrIn, formatClock, weekdayOf } from './availability';
import type { BookingDoc } from './bookings';
import { scheduleGatewayFor } from './schedule-gateway';
import { ScheduleError, stableHash } from './schedule-core';
import { scheduleSlotFingerprint } from './schedule-adapter';
import { ensureClientForBooking } from './clients';
import { freeRoomFor } from './rooms';
import { locationById, practiceProfile, practiceTimezone, providerById, serviceById, termsForOrg } from './practice';
import { queueMessage, bookingContext } from './messages';
import { renderFor } from './templates';
import { manageLinkFor, offerIdFromToken, offerLinkFor } from './manage-links';
import { classSessionById, joinClassSession } from './classes';
import { offerClassPlace } from './class-waitlist';

export type WaitOfferDoc = Doc & {
  orgId: string;
  /** The wait-list entry this was offered to. */
  entryId: string;
  /**
   * Set when the thing offered is a **place in a class**, not a stretch of the
   * diary. The session is what makes it a place: its time is fixed, its room is
   * held, and a claim creates a seat rather than an appointment.
   */
  sessionId?: string;
  /** The appointment whose cancellation freed the slot — the desk's "why". */
  bookingId: string;
  clientId?: string;
  name: string;
  number: string;
  email?: string;
  startsAt: string;
  durationMinutes: number;
  providerId?: string;
  serviceId?: string;
  locationId?: string;
  /** Exact resource/time tuple approved when this offer was minted. */
  slotFingerprint?: string;
  status: 'open' | 'claimed' | 'declined' | 'withdrawn' | 'expired';
  channel: 'sms' | 'email';
  messageId?: string;
  createdAt: string;
  expiresAt: string;
  respondedAt?: string;
  /** The appointment the client ended up with, when they claimed this. */
  claimedBookingId?: string;
  /** Set when the desk withdrew it, or when the sweep closed it. */
  note?: string;
};

/**
 * How long an offer stands.
 *
 * Long enough for somebody to read a text at work and answer it; short enough
 * that a slot for tomorrow morning is back in the desk's hands the same
 * afternoon if nobody wants it. Never past the appointment itself — an offer for
 * a time that has already started is not an offer.
 */
export const OFFER_TTL_MS = 4 * 60 * 60 * 1000;
export const MAX_OFFERS_PER_SLOT = 5;

/**
 * One offer row, from a wait-list entry and a time.
 *
 * The single place an offer is created, so a freed slot and a replacement slot
 * (see `claimFromWaitEntry`) are the same kind of record with the same fields.
 */
function mintOffer(input: {
  orgId: string;
  entry: WaitEntryDoc;
  bookingId?: string;
  startsAt: string;
  durationMinutes: number;
  providerId?: string;
  serviceId?: string;
  locationId?: string;
  expiresAt: string;
}): WaitOfferDoc {
  const slotFingerprint = scheduleSlotFingerprint({
    serviceId: input.serviceId, locationId: input.locationId, providerId: input.providerId,
    startsAt: input.startsAt, durationMinutes: input.durationMinutes,
  });
  return insert<WaitOfferDoc>('waitOffers', {
    id: newId('wo_'),
    orgId: input.orgId,
    entryId: input.entry.id,
    bookingId: input.bookingId,
    clientId: input.entry.clientId,
    name: input.entry.name,
    number: input.entry.number,
    email: input.entry.email,
    startsAt: input.startsAt,
    durationMinutes: input.durationMinutes,
    providerId: input.providerId,
    serviceId: input.serviceId,
    locationId: input.locationId,
    slotFingerprint,
    status: 'open',
    channel: input.entry.number ? 'sms' : 'email',
    createdAt: new Date().toISOString(),
    expiresAt: input.expiresAt,
  } as WaitOfferDoc);
}

export function offersFor(
  orgId: string,
  filter?: { status?: WaitOfferDoc['status'][]; entryId?: string; bookingId?: string }
): WaitOfferDoc[] {
  return list<WaitOfferDoc>('waitOffers', (o) => {
    if (o.orgId !== orgId) return false;
    if (filter?.status && !filter.status.includes(o.status)) return false;
    if (filter?.entryId && o.entryId !== filter.entryId) return false;
    if (filter?.bookingId && o.bookingId !== filter.bookingId) return false;
    return true;
  }).sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.createdAt.localeCompare(b.createdAt));
}

/**
 * The offer a link names — or nothing.
 *
 * The signature is checked in `manage-links.ts` (same secret, a different HMAC
 * domain) before the row is even looked for, so a made-up id cannot be used to
 * probe what exists.
 */
export function offerByToken(token: string): WaitOfferDoc | undefined {
  const id = offerIdFromToken(token);
  if (!id) return undefined;
  return list<WaitOfferDoc>('waitOffers', (o) => o.id === id)[0];
}

/** A single offer by id, scoped to the workspace asking. */
export function offerById(orgId: string, id: string): WaitOfferDoc | undefined {
  return list<WaitOfferDoc>('waitOffers', (o) => o.id === id && o.orgId === orgId)[0];
}

/**
 * The sentence a person reads: "Tuesday 20 October at 3:00pm".
 *
 * Built from `dateStrIn` / `formatClock` / `weekdayOf` — the same three helpers
 * the confirmation text and the phone agent use — so an offer for a New York
 * appointment is described on New York's clock, and the words on this screen match
 * the words in the message that brought the person here.
 */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The site's own clock, and the workspace's when the offer names no site. */
function offerTimezone(orgId: string, offer: Pick<WaitOfferDoc, 'locationId'>): string {
  return locationById(orgId, String(offer.locationId ?? ''))?.timezone ?? practiceTimezoneOf(orgId);
}

function practiceTimezoneOf(orgId: string): string {
  // One clock for the practice, resolved in one place — the same helper the diary
  // uses, so an offer for tomorrow morning is dated the way the diary dates it.
  return practiceTimezone(orgId);
}

function spokenAt(ms: number, timezone: string): string {
  const date = dateStrIn(timezone, ms);
  return `${DAYS[weekdayOf(date)]} ${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} at ${formatClock(ms, timezone)}`;
}

/** The sentence a person reads: "Tuesday 20 October at 3:00pm". */
export function offerSpeaking(orgId: string, offer: WaitOfferDoc): string {
  return spokenAt(Date.parse(offer.startsAt), offerTimezone(orgId, offer));
}

/**
 * When this offer stops standing, in the clinic's own words.
 *
 * "by 4:00pm today" is actionable; a raw timestamp is a puzzle. The day is only
 * named when it is not today, because "today" is the common case and the most
 * useful word.
 */
export function offerExpiryWords(orgId: string, offer: WaitOfferDoc): string {
  const timezone = offerTimezone(orgId, offer);
  const at = Date.parse(offer.expiresAt);
  const today = dateStrIn(timezone);
  const day = dateStrIn(timezone, at);
  const clock = formatClock(at, timezone);
  if (day === today) return `${clock} today`;
  const short = `${DAYS[weekdayOf(day)]} ${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;
  return `${clock} on ${short}`;
}

/**
 * Offer a slot that has just been freed to the people waiting for one.
 *
 * Called from every path that cancels an appointment — the desk, the client's own
 * link, an SMS reply, a cancelled series — so the behaviour is the same whichever
 * door the cancellation came through.
 */
export function offerFreedSlot(input: {
  orgId: string;
  booking: BookingDoc;
  actor?: string;
  actorName?: string;
  /** The desk asking for offers on a slot it chose, rather than a cancellation. */
  manual?: boolean;
}): { offered: WaitOfferDoc[]; alreadyOffered: number; skipped: number; past: boolean; classSeat?: boolean; classOffers?: number } {
  const orgId = input.orgId;
  const booking = input.booking;

  /**
   * A place in a class is not a slot.
   *
   * Giving a seat back frees a *place in a class that is still running* — the
   * room and the instructor are still held for the roster. Offering that hour to
   * somebody waiting for a private appointment would text them a claim link that
   * the booking engine then refuses, which is a promise the product cannot keep.
   * The guard lives here, at the one choke point every caller goes through —
   * cancellation from the desk, the client's own link, an SMS reply, a series
   * cancellation, and the manual offer screen — because fixing only the caller
   * that was noticed would leave the other four able to do it.
   */
  const seatSessionId = (booking as { sessionId?: string }).sessionId;
  if (seatSessionId) {
    /**
     * A place in a class is not a slot — but it *is* something, and it has its own
     * queue. A manual offer (the desk asking to fill a *time*) stays refused: the
     * time is not free, the class is still running in its room. A cancellation is
     * an event, and the place it freed goes to the person at the front of that
     * class's line.
     */
    if (input.manual) return { offered: [], alreadyOffered: 0, skipped: 0, past: false, classSeat: true };
    const session = classSessionById(orgId, String(seatSessionId));
    if (!session) return { offered: [], alreadyOffered: 0, skipped: 0, past: false, classSeat: true };
    const result = offerClassPlace({ orgId, session, bookingId: booking.id, actor: input.actor ?? 'system', actorName: input.actorName });
    return {
      offered: result.offered,
      alreadyOffered: 0,
      skipped: result.skipped,
      past: result.reason === 'past',
      classSeat: true,
      classOffers: result.offered.length,
    };
  }
  const startsAt = Date.parse(String(booking.startsAt));
  if (!Number.isFinite(startsAt) || startsAt <= Date.now()) {
    return { offered: [], alreadyOffered: 0, skipped: 0, past: true };
  }

  const matches = matchWaitList({ orgId, booking }).filter((entry) => Boolean(entry.number || entry.email));
  const open = offersFor(orgId, { status: ['open'] });
  const mine = open.filter((o) => o.startsAt === booking.startsAt);
  const alreadyOffered = matches.filter((entry) => mine.some((o) => o.entryId === entry.id)).length;

  // Soonest window first: somebody who said "any day this week" is likelier to
  // take tomorrow's slot than somebody whose window opens in a fortnight.
  const queue = matches
    .filter((entry) => !mine.some((o) => o.entryId === entry.id))
    .sort((a, b) => a.from.localeCompare(b.from) || a.createdAt.localeCompare(b.createdAt));
  const chosen = queue.slice(0, Math.max(0, MAX_OFFERS_PER_SLOT - mine.length));
  const expiresAt = new Date(Math.min(Date.now() + OFFER_TTL_MS, startsAt)).toISOString();

  const offered: WaitOfferDoc[] = [];
  for (const entry of chosen) {
    const offer = mintOffer({
      orgId,
      entry,
      bookingId: booking.id,
      startsAt: String(booking.startsAt),
      durationMinutes: Number(booking.durationMinutes ?? 30),
      providerId: entry.providerId ?? booking.providerId,
      serviceId: entry.serviceId ?? booking.serviceId,
      locationId: entry.locationId ?? booking.locationId,
      expiresAt,
    });

    // The entry is now "offered", which is a fact the desk reads on the wait-list
    // screen — and it stays matchable, so a second cancellation can offer them
    // again while this one stands.
    update<WaitEntryDoc>('waitList', entry.id, { status: 'offered', updatedAt: new Date().toISOString() } as never);

    const link = offerLinkFor(orgId, offer.id);
    const words = offerSpeaking(orgId, offer);
    const expiresWords = offerExpiryWords(orgId, offer);
    const context = {
      ...bookingContext(orgId, { ...booking, startsAt: offer.startsAt } as BookingDoc, entry.name),
      client_first_name: String(entry.name).split(/\s+/)[0] || 'there',
      claim_link: link ?? '',
      offer_expires: expiresWords,
    };
    const rendered = renderFor({
      orgId,
      kind: 'waitlist_offer',
      channel: offer.channel,
      context,
      // The sentence is built so a link is never followed by a full stop: a
      // messenger that keeps the punctuation turns a one-tap link into a 404, and
      // the person holding the phone has no way to know why.
      fallback: link
        ? `Hi ${context.client_first_name} — a ${words} has just opened up. First to take it gets it: ${link}`
        : `Hi ${context.client_first_name} — a ${words} has just opened up. Reply here and it is yours.`,
    });

    const message = queueMessage({
      orgId,
      channel: offer.channel,
      to: offer.channel === 'email' ? String(entry.email ?? '') : String(entry.number),
      clientId: entry.clientId,
      body: rendered.body,
      subject: rendered.subject,
      kind: 'waitlist_offer',
      source: 'waitlist',
      meta: { kind: 'waitlist_offer', offerId: offer.id, entryId: entry.id },
    });
    update<WaitOfferDoc>('waitOffers', offer.id, { messageId: message.id } as never);

    audit({
      orgId,
      actor: input.actor ?? 'system',
      action: 'waitlist.offered',
      target: offer.id,
      detail: `${entry.name} ← ${words} (${offer.channel}${message.status === 'blocked' ? ', blocked' : ''})`,
    });
    offered.push({ ...offer, messageId: message.id });
  }

  return { offered, alreadyOffered, skipped: Math.max(0, queue.length - chosen.length), past: false };
}

/** The board of open offers for the desk, with the slot in the clinic's own words. */
export function offersBoard(orgId: string, opts: { includeClosed?: boolean } = {}) {
  expireOffers(orgId);
  const rows = offersFor(orgId, opts.includeClosed ? undefined : { status: ['open'] });
  return rows.map((offer) => ({
    ...offer,
    /** Which kind of thing is out: a stretch of the diary, or a place in a class. */
    kind: offer.sessionId ? ('class' as const) : ('slot' as const),
    className: offer.sessionId ? (serviceById(orgId, String(offer.serviceId))?.name ?? 'a class') : undefined,
    spoken: offerSpeaking(orgId, offer),
    expiresWords: offerExpiryWords(orgId, offer),
    entry: waitListFor(orgId, { includeCancelled: true }).find((w) => w.id === offer.entryId),
    serviceName: offer.serviceId ? serviceById(orgId, String(offer.serviceId))?.name : undefined,
    providerName: offer.providerId ? providerById(orgId, String(offer.providerId))?.name : undefined,
    siteName: offer.locationId ? locationById(orgId, String(offer.locationId))?.name : undefined,
  }));
}

/**
 * Close offers whose window has passed and put their entries back in the queue.
 *
 * An entry whose own window has since passed does not go back to `waiting` — it
 * becomes `expired`, because "still waiting for last Tuesday" is not a state
 * anybody can act on. Runs on the housekeeping sweep and before the desk reads
 * the board, so a stale offer is never shown as live.
 */
export function expireOffers(orgId?: string, now = Date.now()): number {
  const stale = list<WaitOfferDoc>('waitOffers', (o) => (orgId ? o.orgId === orgId : true) && o.status === 'open').filter(
    (o) => Date.parse(o.expiresAt) <= now
  );
  for (const offer of stale) {
    update<WaitOfferDoc>('waitOffers', offer.id, { status: 'expired', respondedAt: new Date(now).toISOString(), note: 'nobody took it in time' } as never);
    releaseEntry(offer, 'expired');
    audit({ orgId: offer.orgId, actor: 'system', action: 'waitlist.offer_expired', target: offer.id, detail: `${offer.name} did not answer in time` });
  }
  return stale.length;
}

/** Back into the queue, unless their own window has gone. */
function releaseEntry(offer: WaitOfferDoc, why: 'expired' | 'declined' | 'withdrawn') {
  const entry = waitListFor(offer.orgId, { includeCancelled: true }).find((w) => w.id === offer.entryId);
  if (!entry || entry.status !== 'offered') return;
  /**
   * A class entry goes back in the queue only while there is still a class to be
   * in. Its window is the class's *date*, so the date rule below would put
   * somebody back in line at 4pm for a class that ran at noon — waiting for
   * something that has already happened. The offer carries the start it was for.
   */
  const windowEnd = offer.sessionId
    ? Date.parse(String(offer.startsAt))
    : Date.parse(`${entry.to ?? entry.from}T23:59:59Z`);
  const status = Number.isFinite(windowEnd) && windowEnd < Date.now() ? 'expired' : 'waiting';
  update<WaitEntryDoc>('waitList', entry.id, { status, updatedAt: new Date().toISOString() } as never);
  if (status === 'waiting') {
    audit({ orgId: offer.orgId, actor: 'system', action: 'waitlist.back_in_queue', target: entry.id, detail: `${offer.name} — offer ${why}` });
  }
}

/**
 * The client takes a place in the class they queued for.
 *
 * Deliberately not `upsertBooking`: a seat is a seat, and the capacity rule has
 * exactly one home (`joinClassSession`). The offer is the promise; the class's own
 * rule is what keeps it — so a place that went while the offer stood is refused
 * in words that name the class, not silently written over the top of a full room.
 */
function claimClassOffer(input: { orgId: string; offer: WaitOfferDoc; actorName?: string }): OfferClaimResult {
  const { orgId, offer } = input;
  const session = classSessionById(orgId, String(offer.sessionId));
  if (!session) {
    update<WaitOfferDoc>('waitOffers', offer.id, { status: 'withdrawn', respondedAt: new Date().toISOString(), note: 'the class no longer exists' } as never);
    releaseEntry(offer, 'withdrawn');
    return { ok: false, error: 'gone', message: 'That class is no longer on the diary. Call the practice and they will find you another one.' };
  }
  if (session.status !== 'scheduled') {
    update<WaitOfferDoc>('waitOffers', offer.id, { status: 'withdrawn', respondedAt: new Date().toISOString(), note: 'the class was called off' } as never);
    releaseEntry(offer, 'withdrawn');
    return { ok: false, error: 'gone', message: 'That class was called off — there is no place to take. Call the practice and they will find you another one.' };
  }
  if (Date.parse(String(session.startsAt)) <= Date.now()) {
    update<WaitOfferDoc>('waitOffers', offer.id, { status: 'expired', respondedAt: new Date().toISOString(), note: 'claimed after the class began' } as never);
    releaseEntry(offer, 'expired');
    return { ok: false, error: 'expired', message: 'That class has already run. Call the practice and they will find you the next one.' };
  }

  const joined = joinClassSession({
    orgId,
    session,
    clientId: offer.clientId,
    name: offer.name,
    number: offer.number,
    email: offer.email,
    source: 'online',
  });
  if (!joined.ok) {
    // The place went while the offer stood — somebody at the desk sold it. The
    // entry goes back in line (another place may still come free) and the client is
    // told the truth rather than shown a confirmation for a class they are not in.
    update<WaitOfferDoc>('waitOffers', offer.id, {
      status: 'withdrawn',
      respondedAt: new Date().toISOString(),
      note: 'the place was taken while the offer stood',
    } as never);
    releaseEntry(offer, 'withdrawn');
    return { ok: false, error: 'taken', message: joined.message };
  }

  update<WaitOfferDoc>('waitOffers', offer.id, {
    status: 'claimed',
    respondedAt: new Date().toISOString(),
    claimedBookingId: joined.booking.id,
  } as never);
  const entry = waitListFor(orgId, { includeCancelled: true }).find((w) => w.id === offer.entryId);
  if (entry && entry.status === 'offered') {
    update<WaitEntryDoc>('waitList', entry.id, { status: 'booked', updatedAt: new Date().toISOString() } as never);
  }

  // This person is in the class now, so any *other* offer they were holding stops
  // standing. Offers to other people for the same class stay up: they were for
  // other places, and a class can free more than one at once.
  for (const other of offersFor(orgId, { status: ['open'], entryId: offer.entryId }).filter((o) => o.id !== offer.id)) {
    update<WaitOfferDoc>('waitOffers', other.id, { status: 'withdrawn', respondedAt: new Date().toISOString(), note: 'the client is booked' } as never);
    audit({ orgId, actor: 'system', action: 'waitlist.offer_withdrawn', target: other.id, detail: 'client took a place' });
  }

  const summary = joined.summary;
  queueMessage({
    orgId,
    channel: 'sms',
    to: String(joined.booking.customer?.number ?? offer.number),
    clientId: joined.booking.clientId ?? offer.clientId,
    bookingId: joined.booking.id,
    body:
      `${joined.clientName} — your place in ${summary.serviceName} is booked for ${summary.local.spoken}` +
      `${summary.locationName ? ` at ${summary.locationName}` : ''}.${summary.roomName ? ` ${summary.roomName}.` : ''} ` +
      `Reference ${joined.booking.externalId}. Change or give up your place here: ${manageLinkFor(orgId, joined.booking.id)}`,
    source: 'waitlist',
    kind: 'confirmation',
    meta: { kind: 'confirmation', reference: String(joined.booking.externalId ?? '') },
    respectConsent: true,
    immediate: true,
  });

  audit({
    orgId,
    actor: input.actorName ? `online-booking (${input.actorName})` : 'online-booking',
    action: 'class.wait_claimed',
    target: joined.booking.id,
    detail: `${offer.name} ← a place in ${summary.serviceName} ${summary.local.spoken}, from the wait list`,
  });

  return { ok: true, offer, booking: joined.booking };
}

export type OfferClaimResult =
  | { ok: true; offer: WaitOfferDoc; booking: BookingDoc }
  | { ok: false; error: 'gone' | 'expired' | 'taken' | 'invalid' | 'not_free'; message: string };

/**
 * The client takes the time.
 *
 * `startsAt` lets them pick one of the alternatives the page showed when their
 * slot had already gone — same person, same queue entry, different opening.
 */
export async function claimOffer(input: { orgId: string; offer: WaitOfferDoc; startsAt?: string; actorName?: string }): Promise<OfferClaimResult> {
  const orgId = input.orgId;
  const offer = list<WaitOfferDoc>('waitOffers', (o) => o.id === input.offer.id)[0];
  if (!offer) return { ok: false, error: 'invalid', message: 'That offer is no longer on file.' };
  if (offer.status === 'claimed') return { ok: false, error: 'taken', message: 'You already have this one — check your messages for the confirmation.' };
  if (offer.status !== 'open') {
    return { ok: false, error: 'expired', message: 'That offer has closed. Reply to our message, or call the practice, and we will find you a time.' };
  }
  if (Date.parse(offer.expiresAt) <= Date.now()) {
    update<WaitOfferDoc>('waitOffers', offer.id, { status: 'expired', respondedAt: new Date().toISOString(), note: 'claimed after the window closed' } as never);
    releaseEntry(offer, 'expired');
    return { ok: false, error: 'expired', message: 'That one has just gone — the link was only good until it closed. Call the practice and they will find you the next time.' };
  }

  // A place in a class is taken by sitting in it, not by booking a time.
  if (offer.sessionId) return claimClassOffer({ orgId, offer, actorName: input.actorName });

  const startsAt = input.startsAt && Number.isFinite(Date.parse(input.startsAt)) ? new Date(input.startsAt).toISOString() : offer.startsAt;
  const service = offer.serviceId ? serviceById(orgId, String(offer.serviceId)) : undefined;
  const durationMinutes = service?.durationMinutes ?? offer.durationMinutes ?? 30;

  // The diary has the last word. Somebody may have booked the slot by phone while
  // this person was reading the text. A provider is what the clash check runs
  // against, so an offer with nobody named (a wait entry that did not mind who
  // they saw, on a slot with no practitioner) is accepted as it stands — the same
  // booking a receptionist would make by hand.
  const gateway = scheduleGatewayFor(orgId);
  if (offer.providerId) {
    try {
      const verdict = await gateway.isFree({
        providerId: String(offer.providerId),
        locationId: offer.locationId,
        serviceId: offer.serviceId,
        startsAt,
        durationMinutes,
      }, { origin: 'waitlist', offerId: offer.id, idempotencyKey: `wait-offer-check:${offer.id}:${startsAt}` });
      const claimingOriginalSlot = Date.parse(startsAt) === Date.parse(offer.startsAt);
      if (!verdict.free || (claimingOriginalSlot && offer.slotFingerprint && verdict.slotFingerprint !== offer.slotFingerprint)) {
        return { ok: false, error: 'not_free', message: 'That time has just been taken or changed. Here are the next openings — or call the practice and they will sort it out.' };
      }
    } catch (error) {
      if (error instanceof ScheduleError) {
        return { ok: false, error: 'not_free', message: 'That appointment time could not be checked. Nothing has been booked; please call the practice.' };
      }
      throw error;
    }
  }

  const provider = offer.providerId ? providerById(orgId, String(offer.providerId)) : undefined;
  const site = offer.locationId ? locationById(orgId, String(offer.locationId)) : undefined;
  const siteName = site ? site.name : undefined;
  const providerName = provider ? provider.name : undefined;
  const externalId = `wl-${offer.id.replace(/^wo_/, '').slice(0, 8)}`;
  const localClient = offer.clientId
    ? { id: offer.clientId }
    : ensureClientForBooking(orgId, { name: offer.name, number: offer.number, email: offer.email }, 'waitlist', { source: 'waitlist' });
  let created;
  try {
    created = await gateway.createAppointment({
      externalId,
      customer: { name: offer.name, number: offer.number, email: offer.email },
      service: service?.name ?? termsForOrg(orgId).appointment.one,
      startsAt,
      durationMinutes,
      timezone: site?.timezone,
      value: service?.price,
      providerId: offer.providerId,
      serviceId: offer.serviceId,
      locationId: offer.locationId,
      roomId: freeRoomFor(orgId, { locationId: offer.locationId, startsAt, durationMinutes, serviceId: offer.serviceId })?.id,
      status: 'confirmed',
      source: 'waitlist',
      clientId: localClient.id,
    }, {
      origin: 'waitlist', actor: input.actorName ? `client:${input.actorName}` : 'client', offerId: offer.id,
      idempotencyKey: `wait-offer-claim:${offer.id}:${stableHash(startsAt).slice(0, 24)}`,
    });
  } catch (error) {
    if (error instanceof ScheduleError) {
      return { ok: false, error: 'not_free', message: 'The appointment could not be booked. Nothing has been booked; please call the practice.' };
    }
    throw error;
  }

  const words = offerSpeaking(orgId, { ...offer, startsAt });
  const message = queueMessage({
    orgId,
    channel: 'sms',
    to: offer.number,
    clientId: created.booking.clientId ?? offer.clientId,
    bookingId: created.booking.id,
    kind: 'confirmation',
    source: 'waitlist',
    immediate: true,
    subject: 'Your appointment',
    body: `Done — ${words} is yours${providerName ? ` with ${providerName}` : ''}${siteName ? ` at ${siteName}` : ''}. Reference ${created.booking.externalId}. Change it any time with the link in this message. Reply STOP to opt out.`,
    meta: { kind: 'confirmation', reference: created.booking.externalId ?? '' },
  });

  update<WaitOfferDoc>('waitOffers', offer.id, {
    status: 'claimed',
    respondedAt: new Date().toISOString(),
    claimedBookingId: created.booking.id,
  } as never);
  const entry = waitListFor(orgId, { includeCancelled: true }).find((w) => w.id === offer.entryId);
  if (entry && entry.status === 'offered') {
    update<WaitEntryDoc>('waitList', entry.id, { status: 'booked', updatedAt: new Date().toISOString() } as never);
  }

  // This person is booked now, so any *other* offer they were holding stops
  // standing — otherwise a text about tomorrow's slot leads to a page that invites
  // somebody who already has an appointment to take another one.
  for (const other of offersFor(orgId, { status: ['open'], entryId: offer.entryId }).filter((o) => o.id !== offer.id)) {
    update<WaitOfferDoc>('waitOffers', other.id, { status: 'withdrawn', respondedAt: new Date().toISOString(), note: 'the client is booked' } as never);
    audit({ orgId, actor: 'system', action: 'waitlist.offer_withdrawn', target: other.id, detail: 'client took a different time' });
  }

  // Everybody else holding a link for this slot is told, rather than left to find
  // out when they tap it. Their entries go back in the queue for the next one.
  for (const other of offersFor(orgId, { status: ['open'] }).filter((o) => o.id !== offer.id && o.startsAt === offer.startsAt)) {
    update<WaitOfferDoc>('waitOffers', other.id, { status: 'withdrawn', respondedAt: new Date().toISOString(), note: 'somebody else took the slot' } as never);
    releaseEntry(other, 'withdrawn');
    queueMessage({
      orgId,
      channel: other.channel,
      to: other.channel === 'email' ? String(other.email ?? '') : String(other.number),
      clientId: other.clientId,
      kind: 'manual',
      source: 'waitlist',
      subject: 'That time has gone',
      body: `Sorry — somebody got to ${words} first. You are still on our wait list and we will text you the next one that fits.`,
    });
    audit({ orgId, actor: 'system', action: 'waitlist.offer_withdrawn', target: other.id, detail: 'slot taken by somebody else' });
  }

  audit({ orgId, actor: 'client', action: 'waitlist.offer_claimed', target: offer.id, detail: `${offer.name} took ${words} (ref ${created.booking.externalId})` });
  return { ok: true, offer: { ...offer, status: 'claimed', claimedBookingId: created.booking.id }, booking: created.booking, messageId: message.id } as never;
}

/** "No thanks" from the client's own link. */
export function declineOffer(input: { orgId: string; offer: WaitOfferDoc }): { ok: boolean; message: string } {
  const offer = list<WaitOfferDoc>('waitOffers', (o) => o.id === input.offer.id)[0];
  if (!offer) return { ok: false, message: 'That offer is no longer on file.' };
  if (offer.status === 'claimed') return { ok: false, message: 'You already have that one.' };
  if (offer.status !== 'open') return { ok: false, message: 'That offer had already closed.' };
  update<WaitOfferDoc>('waitOffers', offer.id, { status: 'declined', respondedAt: new Date().toISOString() } as never);
  releaseEntry(offer, 'declined');
  audit({ orgId: input.orgId, actor: 'client', action: 'waitlist.offer_declined', target: offer.id, detail: `${offer.name} passed on this one` });
  return { ok: true, message: 'Understood — you stay on the wait list and we will offer you the next time that fits.' };
}

/** The desk takes an offer back. */
export function withdrawOffer(input: { orgId: string; offerId: string; actor: string; actorName?: string }): { ok: boolean; message: string } {
  const offer = list<WaitOfferDoc>('waitOffers', (o) => o.id === input.offerId && o.orgId === input.orgId)[0];
  if (!offer) return { ok: false, message: 'No offer with that id.' };
  if (offer.status !== 'open') return { ok: false, message: `That offer is already ${offer.status}.` };
  update<WaitOfferDoc>('waitOffers', offer.id, { status: 'withdrawn', respondedAt: new Date().toISOString(), note: `withdrawn by ${input.actorName ?? input.actor}` } as never);
  releaseEntry(offer, 'withdrawn');
  audit({ orgId: input.orgId, actor: input.actor, action: 'waitlist.offer_withdrawn', target: offer.id, detail: `withdrawn from ${offer.name}` });
  return { ok: true, message: `Withdrawn from ${offer.name}. They stay on the wait list.` };
}

/**
 * Somebody on the wait list takes a *different* slot than the one offered.
 *
 * This is the recovery path: their link opened after the offer closed, or the
 * slot was taken while they were reading the text, and the page has shown them
 * live openings instead. Rather than reopen a closed offer — which would make the
 * record say something untrue — a fresh offer is minted for the slot they chose
 * and claimed in the same breath. The wait-list entry is the constant; the offers
 * are a history of what was put in front of them.
 */
export async function claimFromWaitEntry(input: { orgId: string; entryId: string; startsAt?: string }): Promise<OfferClaimResult> {
  const entry = waitListFor(input.orgId, { includeCancelled: true }).find((w) => w.id === input.entryId);
  if (!entry) return { ok: false, error: 'invalid', message: 'We cannot find your wait-list entry — please call the practice.' };
  if (entry.status === 'booked') return { ok: false, error: 'taken', message: 'You already have an appointment from this list — check your messages.' };
  if (entry.status === 'cancelled' || entry.status === 'expired') {
    return { ok: false, error: 'expired', message: 'That request has closed. Call the practice and they will find you a time.' };
  }

  const timezone = locationById(input.orgId, String(entry.locationId ?? ''))?.timezone ?? practiceTimezoneOf(input.orgId);
  const startsAt = input.startsAt && Number.isFinite(Date.parse(input.startsAt)) ? new Date(input.startsAt).toISOString() : undefined;
  if (!startsAt || startsAt <= new Date().toISOString()) {
    return { ok: false, error: 'invalid', message: 'Pick one of the times shown, or call the practice.' };
  }
  // The time has to be really free, and it has to be one the workspace offers —
  // otherwise this would be a way to book the practice at 3am by quoting a clock.
  const service = entry.serviceId ? serviceById(input.orgId, entry.serviceId) : undefined;
  const durationMinutes = service?.durationMinutes ?? 30;
  const options = await offerAlternatives(input.orgId, {
    id: '',
    orgId: input.orgId,
    entryId: entry.id,
    name: entry.name,
    number: entry.number,
    startsAt,
    durationMinutes,
    providerId: entry.providerId,
    serviceId: entry.serviceId,
    locationId: entry.locationId,
    status: 'open',
    channel: 'sms',
    createdAt: new Date().toISOString(),
    expiresAt: new Date().toISOString(),
  } as WaitOfferDoc, { widenToDays: practiceProfile(input.orgId).maxAdvanceDays });
  const matching = options.days.flatMap((d) => d.slots).find((slot) => Date.parse(slot.at) === Date.parse(startsAt));
  if (!matching) {
    return { ok: false, error: 'not_free', message: 'That opening has gone. The list below is live — pick another.' };
  }

  const offer = mintOffer({
    orgId: input.orgId,
    entry,
    startsAt,
    durationMinutes,
    providerId: matching.providerId,
    serviceId: entry.serviceId,
    locationId: matching.locationId,
    expiresAt: new Date(Math.min(Date.now() + OFFER_TTL_MS, Date.parse(startsAt))).toISOString(),
  });
  audit({ orgId: input.orgId, actor: 'client', action: 'waitlist.offer_taken_after_expiry', target: offer.id, detail: `${entry.name} chose an alternative (${timezone})` });
  return await claimOffer({ orgId: input.orgId, offer });
}

/**
 * The earliest opening that fits one wait-list entry's own window.
 *
 * This is what the desk means by "offer them the next one": the entry says which
 * days they can come and who they would like to see, and the diary says what is
 * free — so the two are intersected here rather than left to somebody reading a
 * grid.
 */
export async function nextFreeSlotFor(orgId: string, entry: WaitEntryDoc): Promise<{ startsAt: string; spoken: string } | undefined> {
  const timezone = locationById(orgId, String(entry.locationId ?? ''))?.timezone ?? practiceTimezoneOf(orgId);
  const from = String(entry.from).slice(0, 10);
  const spanDays = entry.to
    ? Math.max(1, Math.round((Date.parse(`${entry.to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1)
    : 30;
  const found = await scheduleGatewayFor(orgId).findSlots({
    serviceId: entry.serviceId,
    providerId: entry.providerId,
    locationId: entry.locationId,
    from,
    days: Math.min(31, spanDays),
    limit: 1,
  }, { origin: 'staff', idempotencyKey: `wait-next:${entry.id}:${from}` });
  const slot = found.slots?.[0];
  if (!slot) return undefined;
  return { startsAt: String(slot.startsAt), spoken: spokenAt(Date.parse(String(slot.startsAt)), slot.local?.timezone ?? timezone) };
}

/** The openings a client can be shown when the offered time has gone. */
export async function offerAlternatives(orgId: string, offer: WaitOfferDoc, opts: { days?: number; widenToDays?: number } = {}) {
  const timezone = offerTimezone(orgId, offer);
  const today = dateStrIn(timezone);
  const look = (days: number) =>
    scheduleGatewayFor(orgId).findSlots({
      serviceId: offer.serviceId,
      providerId: offer.providerId,
      locationId: offer.locationId,
      from: today,
      days: Math.min(31, days),
      limit: 6,
    }, { origin: 'waitlist', offerId: offer.id, idempotencyKey: `wait-alternatives:${offer.id}:${today}:${days}` });

  /**
   * The next fortnight first, because that is what a person means by "the next
   * openings". But a busy practice can be full for longer than that, and an empty
   * list is the least useful answer a page that has just said "that one has gone"
   * can give — so the search widens to the practice's own booking horizon and the
   * result is labelled, rather than the client being left with nothing to tap.
   */
  const fortnight = opts.days ?? 14;
  let found = await look(fortnight);
  let widened = false;
  const horizon = opts.widenToDays ?? 0;
  if (!(found.slots ?? []).length && horizon > fortnight) {
    const further = await look(horizon);
    if ((further.slots ?? []).length) {
      found = further;
      widened = true;
    }
  }
  const days: { date: string; day: string; slots: { at: string; clock: string; with?: string; differentPerson: boolean; providerId: string; locationId: string }[] }[] = [];
  for (const slot of found.slots ?? []) {
    const date = String(slot.local?.date ?? '');
    let bucket = days.find((d) => d.date === date);
    if (!bucket) {
      bucket = {
        date,
        day: `${DAYS[weekdayOf(date)]} ${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`,
        slots: [],
      };
      days.push(bucket);
    }
    bucket.slots.push({
      at: String(slot.startsAt),
      clock: String(slot.local?.start ?? ''),
      with: slot.providerName,
      differentPerson: Boolean(offer.providerId && slot.providerId !== offer.providerId),
      providerId: slot.providerId,
      locationId: slot.locationId,
    });
  }
  return { timezone, days, widened };
}
