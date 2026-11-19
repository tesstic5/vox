/**
 * The client's own link to their appointment.
 *
 * Every confirmation and reminder this practice sends invites the client to do
 * something — change it, cancel it, confirm it — and until now every one of those
 * invitations ended in "or call us". Ringing a clinic during working hours to
 * move a 3pm is the friction that turns a moveable appointment into a no-show.
 *
 * So each appointment carries a link: `/m/<token>`, opening a page that shows
 * what is booked, offers real slots from the same availability engine the desk
 * and the AI use, and either moves or cancels it.
 *
 * Design rules, and they are the whole of it:
 *
 *   1. **The token is derived, not stored.** `bookingId + HMAC(secret)`: no table
 *      to write, nothing to expire, and the same link in yesterday's text still
 *      works. Rotating `VOXERA_MEDIA_SECRET` invalidates every link at once,
 *      which is the lever a practice needs if a number ever leaks.
 *   2. **A token is scoped to one appointment.** It cannot read a client, list a
 *      diary, or find a sibling booking. Everything it can learn, the client
 *      already knows — it is the text they received.
 *   3. **A move goes through the desk's own path.** `moveAppointment` does the
 *      clash check, the rota check, the room pick and the reminder reset, so a
 *      client moving themselves cannot do anything a receptionist could not.
 *   4. **Cancelling needs a reason.** "Too late to change" is a sentence a
 *      practice needs, and "the client said so" is a better record than silence.
 */

import { list, type Doc } from './db';
import type { BookingDoc } from './bookings';
import { setAppointmentStatus } from './diary';
import { offerFreedSlot } from './wait-offers';
import { dateStrIn, formatClock, weekdayOf, addDays } from './availability';
import { scheduleGatewayFor } from './schedule-gateway';
import { ScheduleError, stableHash } from './schedule-core';
import { locationById, practiceTimezone, providerById, serviceById, termsForOrg } from './practice';
import { queueMessage } from './messages';
import { audit } from './audit';
import { recordAccess } from './access-log';
import { manageToken, signatureMatches, tokenHandle } from './manage-links';
import { clientPackById, summarisePack } from './packs';

// The page and the routes address these through this module; the text templates
// take them straight from `manage-links`.
export { manageToken, manageUrl, publicBaseUrl, rememberOrigin } from './manage-links';

/**
 * The booking a token names, or nothing.
 *
 * No workspace is passed in, because the person holding the link does not know
 * one — the link *is* the whole of what they have. The handle is looked up
 * across the database and the signature is then checked against the booking it
 * lands on, so a token minted for one workspace's appointment cannot be replayed
 * against another's: the booking id is inside the MAC.
 */
export function bookingForToken(token: string): BookingDoc | undefined {
  const handle = tokenHandle(token);
  if (!handle || handle.length < 8) return undefined;
  const booking = list<BookingDoc>('bookings', (b) => b.id.replace(/^bkg_/, '') === handle)[0];
  if (!booking || !signatureMatches(booking.id, token)) return undefined;
  return booking;
}

/* ------------------------------------------------------------------ the view */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export type ManageView = {
  reference: string;
  status: string;
  /** Plain words, because "no_show" is not a word anybody says. */
  statusWords: string;
  startsAt: string;
  durationMinutes: number;
  timezone: string;
  service?: string;
  provider?: string;
  site?: string;
  address?: string;
  /** "Tuesday 20 October at 3:00pm" — the same sentence the text used. */
  spoken: string;
  /** False once the visit is done, cancelled or too close to change. */
  canChange: boolean;
  /**
   * Whether the client may give the time up from this page.
   *
   * Usually the same answer as `canChange` — but not for a **place in a class**
   * (A8): that can be given up right up to the start, because the seat goes back
   * to the class the moment it is released and somebody else can have it. Being
   * strict there only traps a person in a class they cannot attend.
   */
  canCancel: boolean;
  /** True when this booking is a seat in a class rather than a private slot. */
  isClassSeat: boolean;
  /** The class this is a place in, and what giving it up does. */
  classNote?: string;
  /** The pack paying for this place, in the client's own words, when one is. */
  packNote?: string;
  /** True in the window where saying "I am here" is useful to the desk. */
  canCheckIn: boolean;
  /** Why not, or what happened — the sentence the page prints either way. */
  checkInNote?: string;
  /** Why not, when `canChange` is false. */
  reason?: string;
  clientFirstName?: string;
  /** The appointment as a `.ics` the client can put in their own diary. */
  calendar?: string;
  practice?: { name: string; phone?: string };
  terms: { appointment: { one: string }; provider: { one: string }; location: { one: string } };
};

/**
 * What a place in a class is, in the client's words (A8).
 *
 * The count is in it because it is the honest reason the page offers "give it up"
 * at 5pm for a 6pm class: the seat is worth something to somebody else.
 */
/**
 * What the pack paying for this place means, in the client's words: this
 * place comes off the pack (nothing is due), how many are left, and the one
 * rule that can cost them the place without coming — cancelling inside two
 * hours, which is the same window this link already uses for changing.
 */
function packNoteFor(orgId: string, booking: BookingDoc): string | undefined {
  const pack = booking.packId ? clientPackById(orgId, booking.packId) : undefined;
  if (!pack) return undefined;
  const summary = summarisePack(orgId, pack);
  // `placesLeft` already excludes this seat's hold, so it reads the same
  // before the class (held) and after it (spent): what remains once this
  // place is used.
  const mine = summary.placesLeft;
  const until = pack.expiresAt ? `, valid until ${String(pack.expiresAt).slice(0, 10)}` : '';
  return booking.packState === 'spent'
    ? `This place came off your ${pack.name} — ${mine} of ${pack.placesTotal} left${until}. Nothing is due.`
    : `This place will come off your ${pack.name} when you attend — ${mine} of ${pack.placesTotal} left after it${until}. Nothing is due. Cancelling inside two hours of the start still uses the place.`;
}

function classSeatNote(orgId: string, booking: BookingDoc): string {
  const sessionId = String((booking as { sessionId?: string }).sessionId ?? '');
  const seats = list<Doc & { orgId?: string; sessionId?: string; status?: string }>('bookings', (b) => b.orgId === orgId && String((b as { sessionId?: string }).sessionId ?? '') === sessionId && b.status !== 'cancelled').length;
  const session = list<Doc & { orgId?: string; capacity?: number }>('classSessions', (s) => s.id === sessionId && s.orgId === orgId)[0];
  const capacity = Number(session?.capacity ?? 0);
  return capacity
    ? `You have one of ${capacity} places in this class, and ${Math.max(0, seats - 1)} other ${seats - 1 === 1 ? 'person is' : 'people are'} booked in. Give your place up and it goes back to the class.`
    : 'You have a place in this class. Give it up and it goes back to the class.';
}

/** The number a client should ring — the practice's own inbound line. */
function practicePhone(orgId: string): string | undefined {
  const number = list<Doc & { number?: string; active?: boolean }>('numbers', (n) => n.orgId === orgId && n.active !== false)[0];
  return number?.number ? String(number.number) : undefined;
}

function statusWords(status: string): string {
  switch (status) {
    case 'pending':
      return 'Not confirmed yet';
    case 'confirmed':
      return 'Booked';
    case 'arrived':
      return 'You are checked in';
    case 'completed':
      return 'Seen';
    case 'no_show':
      return 'Missed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return 'Booked';
  }
}

/** How close to the appointment a client may still change it themselves. */
export const CHANGE_CUTOFF_HOURS = 2;

/**
 * Check-in from the client's own link.
 *
 * A window rather than a switch: from six hours before the appointment (people
 * arrive early, and a practice with a long drive may see them much earlier) until
 * an hour after it starts — past that, "I am here" is a phone call, not a tap.
 * The desk sees `arrived` on the board, which is what makes "who has arrived"
 * true rather than something a receptionist has to keep up by hand.
 */
export const CHECK_IN_WINDOW_MS = 6 * 3_600_000;
export const CHECK_IN_GRACE_MS = 60 * 60_000;

/** "9:00am today" — when check-in opens, in the practice's own words. */
function checkInFromWords(orgId: string, booking: BookingDoc): string {
  const timezone = locationById(orgId, String(booking.locationId ?? ''))?.timezone ?? practiceTimezone(orgId);
  const opensAt = Date.parse(String(booking.startsAt)) - CHECK_IN_WINDOW_MS;
  const day = dateStrIn(timezone, opensAt);
  const today = dateStrIn(timezone);
  const clock = formatClock(opensAt, timezone);
  if (day === today) return `${clock} today`;
  if (day === addDays(today, 1)) return `${clock} tomorrow`;
  /**
   * Everything further out names the day it is.
   *
   * This used to read "tomorrow" for any day that was not today — so a visit on
   * the 21st opened check-in "at 3:30am tomorrow", a sentence that sends somebody
   * to the practice six days early or teaches them to stop believing the text.
   * The window is six hours, so a visit more than a day out is the **normal**
   * case for this branch, not an edge one: most notes came out of it.
   */
  return `${clock} on ${WEEKDAYS[weekdayOf(day)]} ${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;
}

export function manageView(orgId: string, booking: BookingDoc): ManageView {
  const timezone = locationById(orgId, String(booking.locationId ?? ''))?.timezone ?? practiceTimezone(orgId);
  const at = Date.parse(String(booking.startsAt));
  const date = dateStrIn(timezone, at);
  const service = booking.serviceId ? serviceById(orgId, String(booking.serviceId)) : undefined;
  const provider = booking.providerId ? providerById(orgId, String(booking.providerId)) : undefined;
  const org = list<Doc & { name?: string }>('orgs', (o) => o.id === orgId)[0];
  const site = booking.locationId ? locationById(orgId, String(booking.locationId)) : undefined;
  const settled = ['cancelled', 'completed', 'no_show'].includes(String(booking.status));
  const soon = at - Date.now() < CHANGE_CUTOFF_HOURS * 3_600_000;
  const isSeat = Boolean((booking as { sessionId?: string }).sessionId);
  const spoken = `${WEEKDAYS[weekdayOf(date)]} ${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} at ${formatClock(at, timezone)}`;

  return {
    reference: String(booking.externalId ?? booking.id),
    status: String(booking.status),
    statusWords: statusWords(String(booking.status)),
    startsAt: String(booking.startsAt),
    durationMinutes: Number(booking.durationMinutes ?? 30),
    timezone,
    service: service?.name ?? (booking.service ? String(booking.service) : undefined),
    provider: provider?.name,
    site: site?.name,
    address: site?.address,
    spoken,
    // A class seat cannot be *moved* — one person out of a group into a private
    // hour is a different appointment, and the desk should decide that. It can
    // always be given back, which is the thing a person actually needs at 5pm.
    canChange: !settled && !soon && !isSeat,
    canCancel: !settled && (isSeat || !soon),
    isClassSeat: isSeat,
    classNote: isSeat ? classSeatNote(orgId, booking) : undefined,
    packNote: booking.packId ? packNoteFor(orgId, booking) : undefined,
    canCheckIn: !settled && String(booking.status) !== 'arrived' && at - Date.now() < CHECK_IN_WINDOW_MS && Date.now() - at < CHECK_IN_GRACE_MS,
    checkInNote: settled
      ? undefined
      : String(booking.status) === 'arrived'
        ? 'You are checked in — the desk knows you are here.'
        : Date.now() - at >= CHECK_IN_GRACE_MS
          ? 'This appointment has passed — call the practice if you are still coming.'
          : at - Date.now() >= CHECK_IN_WINDOW_MS
            ? `You can check in from ${checkInFromWords(orgId, booking)}.`
            : 'Check in when you arrive and the desk will see you are here.',
    reason: settled
      ? 'This appointment has already been settled — call the practice and they will sort it out.'
      : isSeat
        ? `This is your place in ${service?.name ?? 'a class'} — a place can be given up but not moved. Give it up here, or call the practice and they will find you another one.`
        : soon
        ? `It is less than ${CHANGE_CUTOFF_HOURS} hours away, so please call the practice instead.`
        : undefined,
    clientFirstName: String(booking.customer?.name ?? '').split(/\s+/)[0] || undefined,
    /**
     * The confirmation as a calendar file.
     *
     * The route already existed — `/api/public/bookings/{id}/appointment.ics` —
     * but nothing the client could reach ever offered it: they read "you are
     * booked" and then typed it into their phone by hand. The link is keyed on the
     * appointment id, which is the first half of the token in the address bar
     * anyway, so this reveals nothing the page does not already hold.
     */
    calendar: `/api/public/bookings/${booking.id}/appointment.ics`,
    // The number a client should ring when the link cannot help: the practice's
    // own line, which is the number they were texted from.
    practice: org ? { name: String(org.name ?? 'the practice'), phone: practicePhone(orgId) } : undefined,
    terms: termsForOrg(orgId),
  };
}

/* ------------------------------------------------------------- what it offers */

/** Open slots on the days around the appointment that a client could move to. */
export async function offeredSlots(orgId: string, booking: BookingDoc, opts: { days?: number } = {}) {
  const timezone = locationById(orgId, String(booking.locationId ?? ''))?.timezone ?? practiceTimezone(orgId);
  const from = dateStrIn(timezone);
  const daysToSearch = Math.max(1, Math.min(31, opts.days ?? 14));
  const gateway = scheduleGatewayFor(orgId);
  const baseQuery = {
    serviceId: booking.serviceId ? String(booking.serviceId) : undefined,
    locationId: booking.locationId ? String(booking.locationId) : undefined,
    from,
    days: daysToSearch,
    limit: 200,
  };
  const own = booking.providerId
    ? await gateway.findSlots({ ...baseQuery, providerId: String(booking.providerId) }, {
        origin: 'public',
        idempotencyKey: `manage-slots-own:${stableHash([booking.id, from, daysToSearch])}`,
      })
    : undefined;
  const any = !booking.providerId || !own?.slots.length
    ? await gateway.findSlots(baseQuery, {
        origin: 'public',
        idempotencyKey: `manage-slots-any:${stableHash([booking.id, from, daysToSearch])}`,
      })
    : undefined;
  // When the client's own practitioner has no opening on one particular day,
  // preserve the previous useful fallback to another mapped practitioner. One
  // broad provider query is enough; do not make one provider request per day.
  const fallback = booking.providerId && own?.slots.length
    ? await gateway.findSlots(baseQuery, {
        origin: 'public',
        idempotencyKey: `manage-slots-fallback:${stableHash([booking.id, from, daysToSearch])}`,
      })
    : any;
  const out: { date: string; day: string; slots: { at: string; clock: string; with?: string; differentPerson: boolean; providerId: string; locationId: string }[] }[] = [];
  const day = (date: string) => `${WEEKDAYS[weekdayOf(date)]} ${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;
  const currentDate = dateStrIn(timezone, Date.parse(String(booking.startsAt)));

  for (let i = 0; i < daysToSearch && out.length < 6; i += 1) {
    const date = addDays(from, i);
    if (date === currentDate) continue;
    const ownOnDay = (own?.slots ?? []).filter((slot) => slot.local.date === date);
    const found = ownOnDay.length ? ownOnDay : (fallback?.slots ?? []).filter((slot) => slot.local.date === date);
    const slots = found.slice(0, 6).map((slot) => ({
      at: slot.startsAt,
      clock: slot.local.start,
      with: slot.providerName,
      differentPerson: Boolean(booking.providerId && slot.providerId !== booking.providerId),
      providerId: slot.providerId,
      locationId: slot.locationId,
    }));
    if (slots.length) out.push({ date, day: day(date), slots });
  }
  return { timezone, days: out };
}

/* ------------------------------------------------------------------- actions */

export type ManageResult = { ok: true; view: ManageView; message?: string } | { ok: false; error: string; message: string };

/** Move the client's own appointment. Every guard the desk has applies. */
export async function clientReschedule(input: {
  orgId: string;
  booking: BookingDoc;
  startsAt: string;
  /** The practitioner the offered slot belongs to, when the slot named one. */
  providerId?: string;
  /** The site the offered slot is at, when the slot named one. */
  locationId?: string;
  origin?: string;
}): Promise<ManageResult> {
  const view = manageView(input.orgId, input.booking);
  if (!view.canChange) return { ok: false, error: 'closed', message: view.reason ?? 'This appointment can no longer be changed here.' };

  const at = Date.parse(input.startsAt);
  if (Number.isNaN(at)) return { ok: false, error: 'invalid', message: 'That time was not readable.' };

  let booking: BookingDoc;
  try {
    const result = await scheduleGatewayFor(input.orgId).moveAppointment({
      bookingId: input.booking.id,
      startsAt: new Date(at).toISOString(),
      providerId: input.providerId,
      locationId: input.locationId,
    }, {
      origin: 'public',
      actor: 'client',
      idempotencyKey: `public-move:${stableHash([input.booking.id, new Date(at).toISOString(), input.providerId ?? '', input.locationId ?? ''])}`,
    });
    booking = result.booking;
  } catch (error) {
    if (error instanceof ScheduleError) {
      return { ok: false, error: 'schedule_unavailable', message: 'That move could not be completed. Your original appointment is unchanged; please call the practice.' };
    }
    return { ok: false, error: 'conflict', message: error instanceof Error ? error.message : 'That time could not be booked.' };
  }
  const after = manageView(input.orgId, booking);
  audit({ orgId: input.orgId, actor: 'client', action: 'appointment.moved_by_client', target: booking.id, detail: `${input.booking.startsAt} → ${booking.startsAt}` });

  // They moved it themselves, so they get the confirmation of what they chose —
  // and the desk's own copy is on the appointment either way.
  const client = booking.clientId ? list<Doc & { id: string; name?: string }>('clients', (c) => c.id === booking.clientId)[0] : undefined;
  queueMessage({
    orgId: input.orgId,
    channel: 'sms',
    to: String(booking.customer?.number ?? ''),
    kind: 'confirmation',
    source: 'self-service',
    bookingId: booking.id,
    clientId: client?.id,
    subject: 'Appointment moved',
    body: `Done — your appointment is now ${after.spoken}${after.provider ? ` with ${after.provider}` : ''}${after.site ? ` at ${after.site}` : ''}. Reference ${after.reference}.`,
  });
  return { ok: true, view: after, message: `Moved to ${after.spoken}.` };
}

/** Cancel the client's own appointment, with the reason they gave. */
/**
 * "I am here."
 *
 * Goes through the desk's own status path, so the diary, the board, the audit
 * trail and the records all show what a receptionist would have recorded by hand —
 * `client_checkin` is simply the name of the door it came through.
 */
export function clientCheckIn(input: { orgId: string; booking: BookingDoc }): ManageResult {
  const view = manageView(input.orgId, input.booking);
  if (String(input.booking.status) === 'arrived') return { ok: true, view, message: view.checkInNote ?? 'You are already checked in.' };
  if (!['pending', 'confirmed'].includes(String(input.booking.status))) {
    return { ok: false, error: 'closed', message: 'This appointment is no longer open for check-in — call the practice and they will sort it out.' };
  }
  if (!view.canCheckIn) {
    return { ok: false, error: 'too_early', message: view.checkInNote ?? 'Check-in is not open for this appointment yet.' };
  }

  const result = setAppointmentStatus({
    orgId: input.orgId,
    id: input.booking.id,
    status: 'arrived',
    actor: 'client',
    actorName: `${input.booking.customer?.name ?? 'the client'} (self-service link)`,
    note: 'checked in from the link in their message',
  });
  if (!result.ok) return { ok: false, error: result.error, message: result.message };

  const after = manageView(input.orgId, result.booking);
  audit({ orgId: input.orgId, actor: 'client', action: 'appointment.client_checkin', target: result.booking.id, detail: 'arrived, from their own link' });
  recordAccess({
    orgId: input.orgId,
    resource: 'appointment',
    resourceId: result.booking.id,
    action: 'update',
    actor: 'client',
    actorName: 'Self-service link',
    detail: 'client checked in',
  });
  return { ok: true, view: after, message: 'You are checked in — the desk knows you are here. Take a seat.' };
}

export async function clientCancel(input: { orgId: string; booking: BookingDoc; reason?: string }): Promise<ManageResult> {
  const view = manageView(input.orgId, input.booking);
  // `canCancel` rather than `canChange`: a class place may be given up inside the
  // usual cutoff, which is the whole point of a seat going back to the class.
  if (!view.canCancel) return { ok: false, error: 'closed', message: view.reason ?? 'This appointment can no longer be changed here.' };

  let cancelled: BookingDoc;
  try {
    const result = await scheduleGatewayFor(input.orgId).cancelAppointment({
      bookingId: input.booking.id,
      reason: input.reason ? `cancelled by the client: ${input.reason}` : 'cancelled by the client from the self-service link',
    }, {
      origin: 'public', actor: 'client',
      idempotencyKey: `public-cancel:${stableHash([input.booking.id, input.reason ?? ''])}`,
    });
    cancelled = result.booking;
  } catch (error) {
    if (error instanceof ScheduleError && !['SLOT_TAKEN', 'CONFLICT'].includes(error.code)) {
      return { ok: false, error: 'schedule_unavailable', message: 'The cancellation could not be completed. Your appointment is still in place; please call the practice.' };
    }
    return { ok: false, error: 'conflict', message: error instanceof Error ? error.message : 'The appointment could not be cancelled.' };
  }

  const after = manageView(input.orgId, cancelled);
  audit({ orgId: input.orgId, actor: 'client', action: 'appointment.cancelled_by_client', target: cancelled.id, detail: input.reason?.slice(0, 80) ?? 'no reason given' });
  recordAccess({
    orgId: input.orgId,
    resource: 'appointment',
    resourceId: cancelled.id,
    action: 'update',
    actor: 'client',
    actorName: 'Self-service link',
    detail: 'client cancelled',
  });

  const client = cancelled.clientId ? list<Doc & { id: string; name?: string }>('clients', (c) => c.id === cancelled.clientId)[0] : undefined;
  queueMessage({
    orgId: input.orgId,
    channel: 'sms',
    to: String(cancelled.customer?.number ?? ''),
    kind: 'confirmation',
    source: 'self-service',
    bookingId: cancelled.id,
    clientId: client?.id,
    subject: 'Appointment cancelled',
    body: `Cancelled — ${view.spoken} is off the books. Reply with a day that suits and we will rebook you.`,
  });

  const offers = offerFreedSlot({ orgId: input.orgId, booking: cancelled, actor: 'client', actorName: 'Self-service link' });
  const offered = offers.offered.length;
  return {
    ok: true,
    view: after,
    message: offered
      ? `Cancelled. We have offered the time to ${offered} ${offered === 1 ? 'person' : 'people'} waiting for a slot like this — first to take it gets it.`
      : 'Cancelled. Thank you for letting us know.',
  };
}
