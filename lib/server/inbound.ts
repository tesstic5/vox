/**
 * What a client's reply means.
 *
 * The templates this product sends have always invited a reply — the reminder
 * says "Reply C to confirm", the confirmation says "reply to this message … to
 * change it", the recall says "Reply with a day and we will book you in" — and
 * until now only STOP and START were listened for. A client who texted "C" got
 * nothing back and stayed `pending` in the diary while believing they had
 * confirmed. That is the worst kind of missing feature: the copy shipped, the
 * behaviour did not.
 *
 * So a reply is read in one of four ways, and each has a real consequence:
 *
 *   1. **Confirm** — "C", "yes", "ok", "confirmed" … confirms their next
 *      appointment if it is still pending, and says so with the day and time.
 *   2. **Decline or cancel** — "no", "can't make it", "cancel" … marks it
 *      cancelled through the same path the desk uses, so reminders stop and the
 *      wait list is offered the freed slot.
 *   3. **A day, a time, or a plain change request** — never guessed at. It is
 *      filed for the desk as a change request and acknowledged, so the client
 *      knows a person has it. Guessing a new booking from "maybe Thursday?"
 *      would be worse than a human calling back.
 *   4. **Anything else** — recorded, not answered, exactly as before.
 *
 * Everything here also writes an `outreach` row, so the reply appears in the
 * client's own thread rather than only in an audit log nobody reads.
 */

import { list, update, type Doc } from './db';
import { normaliseNumber, findClientByNumber, type ClientDoc } from './clients';
import type { BookingDoc } from './bookings';
import { bookingsFor } from './bookings';
import { setAppointmentStatus } from './diary';
import { offerFreedSlot } from './wait-offers';
import { scheduleGatewayFor } from './schedule-gateway';
import { ScheduleError, stableHash } from './schedule-core';
import { addDays, dateStrIn, formatClock, weekdayOf } from './availability';
import { practiceTimezone, providerById, serviceById, locationById } from './practice';
import { audit } from './audit';
import { recordOutreach } from './outreach';
import { bookingLinkFor } from './recalls';

export type ReplyIntent = 'confirm' | 'decline' | 'reschedule' | 'question';

export type ReplyOutcome = {
  intent: ReplyIntent;
  /** What to text back, if anything. */
  reply?: string;
  bookingId?: string;
  /** True when a person now has something to do. */
  needsDesk?: boolean;
};

const CONFIRM = new Set(['c', 'confirm', 'confirmed', 'yes', 'y', 'yeah', 'yep', 'ok', 'okay', 'k', 'sure', '1', 'accept', 'accepted']);
const DECLINE = new Set(['no', 'n', 'nope', 'cancel', 'cancelled', 'canceled', 'cantmakeit', 'cannotmakeit', 'cantmake', 'notcoming', 'decline', 'declined', 'reschedule', 'change', 'move', '2']);

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DATE_SHAPE = /\b(\d{1,2}(?::\d{2})?\s?(?:am|pm)|\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2})\b/i;

/** Is this message asking to move rather than to answer? */
function readsAsChange(body: string): boolean {
  const lower = body.toLowerCase();
  if (WEEKDAYS.some((d) => lower.includes(d))) return true;
  if (/\b(tomorrow|today|next week|another day|different day|later|earlier|instead|reschedul|move)\b/i.test(lower)) return true;
  return DATE_SHAPE.test(body);
}

/** The appointment a reply is about: their next one that has not happened yet. */
export function nextAppointmentFor(orgId: string, clientId: string, clientNumber?: string): BookingDoc | undefined {
  const now = Date.now();
  const mine = bookingsFor(orgId, (b) => {
    const client = String((b as { clientId?: string }).clientId ?? '');
    if (clientId && client === clientId) return true;
    if (clientNumber && normaliseNumber(String(b.customer?.number ?? '')) === normaliseNumber(clientNumber)) return true;
    return false;
  })
    .filter((b) => ['pending', 'confirmed'].includes(String(b.status)))
    .filter((b) => Date.parse(String(b.startsAt)) > now - 60 * 60_000)
    .sort((a, b) => Date.parse(String(a.startsAt)) - Date.parse(String(b.startsAt)));
  return mine[0];
}

/** "Tuesday 20 October at 3:00pm, with Marcus Ito at Northwind East" — sayable. */
export function describeForClient(orgId: string, booking: BookingDoc): string {
  const timezone = locationById(orgId, String(booking.locationId ?? ''))?.timezone ?? practiceTimezone(orgId);
  const at = Date.parse(String(booking.startsAt));
  const date = dateStrIn(timezone, at);
  // `WEEKDAYS` is lowercase because the reply reader matches against lowercase
  // text; the sentence this feeds starts with the day, so it gets its capital.
  const day = WEEKDAYS[weekdayOf(date)].replace(/^./, (c) => c.toUpperCase());
  const provider = booking.providerId ? providerById(orgId, String(booking.providerId)) : undefined;
  const site = booking.locationId ? locationById(orgId, String(booking.locationId)) : undefined;
  const service = booking.serviceId ? serviceById(orgId, String(booking.serviceId)) : undefined;
  const month = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][Number(date.slice(5, 7)) - 1];
  return [
    `${day} ${Number(date.slice(8, 10))} ${month} at ${formatClock(at, timezone)}`,
    provider ? `with ${provider.name}` : '',
    site ? `at ${site.name}` : '',
    service ? `(${service.name})` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * The answer when somebody replies and there is nothing booked for them.
 *
 * Recall texts invite a reply ("reply with a day and we will find you a time"),
 * and a client who has no upcoming appointment can still reply "C" — meaning
 * *yes, I would like to come back*. The old answer here was *"Is there anything
 * you need before your visit?"*, a sentence about a visit that does not exist.
 * The honest answer says what is true, offers the way to book, and puts the
 * message in front of a person either way.
 */
function nothingBookedReply(orgId: string, purpose: 'confirm' | 'decline'): string {
  const link = bookingLinkFor(orgId);
  const tail = link ? ` Book whenever suits: ${link} — or reply with a day and we will find you a time.` : ' Reply with a day that suits and we will find you a time.';
  return purpose === 'confirm'
    ? `Thanks — there is nothing booked for you at the moment.${tail}`
    : `Thanks — there is nothing booked for you, so there was nothing to cancel.${tail}`;
}

/**
 * Reads a reply and does the thing it asks for.
 *
 * Returns what was done so the webhook can answer in TwiML; the caller owns the
 * transport, this owns the meaning.
 */
export async function handleClientReply(input: {
  orgId: string;
  from: string;
  body: string;
  /** The number the client texted — recorded on the outreach row. */
  to: string;
  messageId?: string;
}): Promise<ReplyOutcome> {
  const client = findClientByNumber(input.orgId, input.from);
  const keyword = input.body.toLowerCase().replace(/[^a-z0-9]/g, '');
  const booking = client ? nextAppointmentFor(input.orgId, client.id, input.from) : undefined;
  const when = booking ? describeForClient(input.orgId, booking) : '';

  /**
   * Every branch writes an outreach row, so the reply shows in the client's own
   * thread rather than only in a log nobody reads. The row's `outcome` is
   * `answered` — the client answered us — and `meta` is strings only, because
   * that is what the collection stores; `needsDesk` is written as the word the
   * desk's queue looks for.
   */
  const log = (detail: string, extra: Record<string, string | undefined> = {}) => {
    const meta: Record<string, string> = { keyword };
    if (input.messageId) meta.inboundMessageId = input.messageId;
    if (booking?.id) meta.bookingId = booking.id;
    for (const [key, value] of Object.entries(extra)) if (value !== undefined) meta[key] = value;
    recordOutreach({
      orgId: input.orgId,
      clientId: client?.id,
      bookingId: booking?.id,
      channel: 'sms',
      kind: 'manual',
      outcome: 'answered',
      to: input.to,
      actor: 'carrier',
      detail,
      meta,
    });
  };

  // ---- confirm ------------------------------------------------------------
  if (CONFIRM.has(keyword)) {
    if (!booking) {
      // Nothing to confirm — most often a reply to a recall. Filed for a person,
      // because "yes please" from a lapsed client is the whole point of a recall.
      log(`replied "${input.body}" with nothing on the diary`, { needsDesk: 'true', reason: 'no_upcoming_appointment' });
      return { intent: 'question', needsDesk: true, reply: nothingBookedReply(input.orgId, 'confirm') };
    }
    if (booking.status === 'confirmed') {
      log(`already confirmed, replied "${input.body}"`);
      return { intent: 'confirm', bookingId: booking.id, reply: `You're all set for ${when}. See you then.` };
    }
    // Through the desk's own path: the wait list, the reminders and the audit
    // trail all behave exactly as if a receptionist had confirmed it.
    setAppointmentStatus({
      orgId: input.orgId,
      id: booking.id,
      status: 'confirmed',
      actor: 'carrier',
      actorName: `${client?.name ?? 'Client'} by SMS`,
      note: `confirmed by SMS reply "${input.body}"`,
    });
    audit({ orgId: input.orgId, actor: 'carrier', action: 'appointment.confirmed_by_reply', target: booking.id, detail: input.body.slice(0, 40) });
    log(`confirmed by reply "${input.body}"`);
    return { intent: 'confirm', bookingId: booking.id, reply: `Confirmed — ${when}. Reply STOP to opt out, or call us if anything changes.` };
  }

  // ---- decline ------------------------------------------------------------
  if (DECLINE.has(keyword)) {
    if (!booking) {
      log(`replied "${input.body}" with nothing on the diary`, { needsDesk: 'true', reason: 'no_upcoming_appointment' });
      return { intent: 'question', needsDesk: true, reply: nothingBookedReply(input.orgId, 'decline') };
    }
    let cancelledBooking: BookingDoc | undefined;
    try {
      const cancelled = await scheduleGatewayFor(input.orgId).cancelAppointment({
          bookingId: booking.id,
          reason: `cancelled by SMS reply "${input.body}"`,
        }, {
          origin: 'public',
          actor: 'carrier',
          idempotencyKey: `sms-cancel:${stableHash([booking.id, input.messageId ?? '', input.body])}`,
        });
      cancelledBooking = cancelled.booking;
    } catch (error) {
      const scheduleUnavailable = error instanceof ScheduleError;
      log(`cancellation requested but not confirmed: "${input.body}"`, { needsDesk: 'true', reason: scheduleUnavailable ? 'schedule_unavailable' : 'cancellation_failed' });
      return {
        intent: 'decline', bookingId: booking.id, needsDesk: true,
        reply: 'We could not complete that cancellation. Your appointment is still in place; the desk has your message and will contact you.',
      };
    }
    // Same as every other door: the freed time is offered, not just noted.
    offerFreedSlot({ orgId: input.orgId, booking: cancelledBooking, actor: 'carrier', actorName: 'SMS reply' });
    audit({ orgId: input.orgId, actor: 'carrier', action: 'appointment.cancelled_by_reply', target: booking.id, detail: input.body.slice(0, 40) });
    log(`cancelled by reply "${input.body}"`, { needsDesk: 'true', reason: 'cancelled' });
    return {
      intent: 'decline',
      bookingId: booking.id,
      needsDesk: true,
      reply: `Sorry to miss you — ${when} is cancelled. Reply with a day that suits and we'll rebook you.`,
    };
  }

  // ---- asking for a different time ---------------------------------------
  if (readsAsChange(input.body)) {
    // Never guessed at. A person books it; the client is told a person has it.
    log(`change requested: "${input.body}"`, { request: input.body.slice(0, 160), needsDesk: 'true' });
    audit({
      orgId: input.orgId,
      actor: 'carrier',
      action: 'appointment.change_requested_by_reply',
      target: booking?.id ?? client?.id ?? input.from,
      detail: input.body.slice(0, 80),
    });
    return {
      intent: 'reschedule',
      bookingId: booking?.id,
      needsDesk: true,
      reply: `Thanks — we have your note${booking ? ` about ${when}` : ''}. Someone from the desk will text or call you shortly to sort it out.`,
    };
  }

  // ---- anything else ------------------------------------------------------
  log(`inbound "${input.body.slice(0, 80)}"`, { needsDesk: 'true' });
  return { intent: 'question', needsDesk: true, reply: 'Thanks — we have your message. A person will get back to you shortly.' };
}

/**
 * A reply the desk has dealt with.
 *
 * The queue is a to-do list, and a to-do list that cannot be ticked is a nag. The
 * row stays — it is a message from a client and it belongs in their thread — so
 * the resolution is a flag on the row rather than a delete.
 */
export function resolveDeskRequest(input: { orgId: string; id: string; actor: string; actorName?: string; note?: string }) {
  const row = list<Doc & { meta?: Record<string, string> }>('outreach', (o) => o.id === input.id && o.orgId === input.orgId)[0];
  if (!row) return { ok: false as const, error: 'not_found', message: 'No such request.' };
  const meta: Record<string, string> = { ...(row.meta ?? {}), handled: 'true' };
  if (input.note) meta.handledNote = input.note.slice(0, 200);
  meta.handledBy = input.actorName ?? input.actor;
  update<Doc & { meta?: Record<string, string> }>('outreach', row.id, { meta });
  audit({ orgId: input.orgId, actor: input.actor, action: 'reply.handled', target: row.id, detail: input.note ?? 'dealt with' });
  return { ok: true as const, id: row.id };
}

/** Every open change request a client has texted in — what the desk reads. */
export function deskRequests(orgId: string, limit = 25) {
  const rows = list<Doc & { kind?: string; meta?: Record<string, unknown>; at?: string; clientId?: string; detail?: string }>(
    'outreach',
    (o) => {
      const meta = o.meta as { needsDesk?: unknown; handled?: unknown } | undefined;
      const wanted = meta?.needsDesk === true || meta?.needsDesk === 'true';
      const done = meta?.handled === true || meta?.handled === 'true';
      return o.orgId === orgId && wanted && !done;
    }
  );
  return rows
    .sort((a, b) => String(b.at ?? b.createdAt ?? '').localeCompare(String(a.at ?? a.createdAt ?? '')))
    .slice(0, limit)
    .map((o) => {
      const meta = (o.meta ?? {}) as { bookingId?: string; request?: string; keyword?: string };
      const client = o.clientId ? list<ClientDoc>('clients', (c) => c.id === o.clientId)[0] : undefined;
      const booking = meta.bookingId ? bookingsFor(orgId, (b) => b.id === meta.bookingId)[0] : undefined;
      return {
        id: o.id,
        at: String(o.at ?? o.createdAt ?? ''),
        clientName: client?.name ?? 'Unknown number',
        clientNumber: client?.number,
        detail: String(o.detail ?? ''),
        request: meta.request,
        appointment: booking ? describeForClient(orgId, booking) : undefined,
      };
    });
}

/** "Tomorrow" and "Tuesday" as dates — used only to tell a client we understood. */
export function spokeADay(body: string, timezone: string): string | undefined {
  const lower = body.toLowerCase();
  const today = dateStrIn(timezone);
  if (/\btomorrow\b/.test(lower)) return addDays(today, 1);
  if (/\btoday\b/.test(lower)) return today;
  const named = WEEKDAYS.findIndex((d) => lower.includes(d));
  return named >= 0 ? addDays(today, ((named - weekdayOf(today) + 7) % 7) || 7) : undefined;
}
