/**
 * Booking tools.
 *
 * The rule engine and a model both call these, and the point of the whole
 * platform is that they do something real: a confirm call confirms a real
 * booking, a reschedule moves a real appointment to a real new time, and a
 * cancellation writes back to the record the client's system mirrors.
 *
 * Two rules keep that honest:
 *
 *   1. **A tool answers from the booking, never from a template.** "You're all
 *      set for Thursday at 2pm" is only sayable because the booking says so.
 *   2. **Nothing is invented.** If the caller's booking cannot be found, the tool
 *      says so and the agent asks a question, rather than reading out a made-up
 *      confirmation code — which is exactly the failure mode that makes a
 *      robot-caller worthless.
 *
 * When a call is linked to a booking (`call.bookingId`, set by a campaign, an
 * outbound API call, or an inbound number recognised by phone number), these run
 * in "booking mode". The same names are still available to ordinary support
 * calls, where they fall through to the generic implementations in `agent.ts`.
 */

import { list, type Doc } from './db';
import { audit } from './audit';
import { formatClock } from './availability';
import { scheduleGatewayFor } from './schedule-gateway';
import { ScheduleError, stableHash } from './schedule-core';
import { freeRoomFor, roomNameOf } from './rooms';
import { locationById, locationsFor, providerById, providersFor, rotaForOrg, serviceByNameOrId } from './practice';
import { consentFor, ensureClientForBooking, findClientByNumber } from './clients';
import { phoneAssistantPatientContext } from './phone-assistant-context';
import { confirmationBody, queueMessage } from './messages';
import { manageLinkFor } from './manage-links';
import { draftNoteFromCall, incompleteSections } from './notes';
import { balanceMinorOf, formatMoney, invoicesFor, paymentTypesFor } from './money';
import { createPaymentLink, linksFor, markLinkSent, paymentProviderFor } from './payments';
import { termsFor } from '@/lib/terms';
import {
  bookingById,
  bookingsFor,
  describeBooking,
  type BookingDoc,
} from './bookings';
import type { ToolCall } from './agent';

export type BookingToolContext = {
  orgId: string;
  callId?: string;
  /** The booking this call exists to act on, if any. */
  bookingId?: string;
  /** Caller's number — how an inbound confirmation call finds its booking. */
  callerNumber?: string;
  /** Fallback timezone for interpreting "Thursday at 2pm". */
  timezone?: string;
  /**
   * Who is asking, when that is knowable: the signed-in person on a call placed
   * from the dashboard. A phone call has no viewer — only a number, which the
   * report tool matches against the team's numbers on file.
   */
  viewer?: { name?: string; email?: string; role?: string };
};

const BOOKING_TOOLS = new Set([
  'book_appointment',
  'reschedule_appointment',
  'cancel_appointment',
  'check_availability',
  'send_confirmation',
  'draft_note',
  'create_payment_link',
  'payment_status',
  'lookup_order',
  'order_status',
]);

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * The site a caller is being sent to, but only when saying it adds anything.
 *
 * A one-site practice must never hear the name of its own building on every
 * sentence ("your visit at Northwind HQ" when there is nowhere else to go), so
 * both helpers below answer undefined unless the workspace really runs two.
 */
function multiSite(ctx: { orgId: string }) {
  const sites = locationsFor(ctx.orgId).filter((l) => l.active !== false);
  return sites.length > 1 ? sites : [];
}

/** The site a booking is at, falling back to the provider's first when it has none. */
function bookingSiteFor(ctx: { orgId: string }, booking: BookingDoc) {
  if (booking.locationId) return String(booking.locationId);
  const provider = booking.providerId ? providerById(ctx.orgId, String(booking.providerId)) : undefined;
  return provider?.locationIds?.[0];
}

function siteNameFor(ctx: { orgId: string }, locationId?: string | null) {
  if (!locationId || multiSite(ctx).length === 0) return undefined;
  return locationById(ctx.orgId, String(locationId))?.name;
}

/**
 * The site the caller says they are coming to, read out of their own sentence.
 *
 * The arguments a booking tool receives are built from what the caller said, not
 * from the model's own tool call, so a site named only in speech ("at the East
 * clinic") never reached the diary: the visit was filed at the practitioner's
 * first site and the caller was told about the wrong building. Matching is done
 * against the practice's *own* site names, and a word that could mean either site
 * ("Northwind") is deliberately ignored rather than guessed at.
 */
export function siteFromText(ctx: { orgId: string }, text?: string) {
  const said = String(text ?? '').toLowerCase();
  if (!said) return undefined;
  const sites = multiSite(ctx);
  if (!sites.length) return undefined;
  const scored = sites
    .map((site) => {
      const tokens = [...new Set(site.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3))];
      const hits = tokens.filter((t) => new RegExp(`\\b${t}\\b`).test(said));
      return { site, hits: hits.length };
    })
    .sort((a, b) => b.hits - a.hits);
  if (!scored[0].hits) return undefined;
  // A word the two sites share tells us nothing; only a clear winner counts.
  if (scored[1] && scored[1].hits === scored[0].hits) return undefined;
  return scored[0].site;
}

/** Reads "the East clinic", "Northwind East" or a raw id out of a tool argument. */
function matchSite(ctx: { orgId: string }, spoken: string) {
  const wanted = spoken.trim().toLowerCase();
  if (!wanted) return undefined;
  const sites = multiSite(ctx);
  return (
    sites.find((l) => l.id === spoken) ??
    sites.find((l) => l.name.toLowerCase() === wanted) ??
    sites.find((l) => l.name.toLowerCase().includes(wanted)) ??
    sites.find((l) => wanted.includes(l.name.toLowerCase()))
  );
}

/**
 * Resolves "Thursday", "tomorrow", "2026-10-02" and "2pm" into an instant.
 *
 * Deliberately narrow: a wrong guess about a day is worse than asking again, so a
 * bare weekday is read as the next occurrence, and an unparseable value returns
 * undefined and the tool declines instead of inventing.
 */
/** Reads a day out of "Thursday", "tomorrow", "2026-10-02", "the 12th". */
export function resolveDay(input: { date?: string; from?: Date }): { at?: Date; day?: string; error?: string } {
  const from = input.from ?? new Date();
  const dateText = String(input.date ?? '').trim().toLowerCase();
  let day: Date | undefined;

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
  if (iso) {
    day = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
  } else if (/tomorrow|next day/.test(dateText)) {
    day = new Date(from.getTime() + 86_400_000);
  } else if (/today|tonight|this afternoon|this morning|this evening/.test(dateText)) {
    day = from;
  } else {
    for (let i = 0; i < DAYS.length; i += 1) {
      if (dateText.includes(DAYS[i])) {
        const delta = (i - from.getUTCDay() + 7) % 7 || 7;
        day = new Date(from.getTime() + delta * 86_400_000);
        break;
      }
    }
    const dayNum = /(?:^|\s)(\d{1,2})(?:st|nd|rd|th)?(?:\s|$)/.exec(dateText);
    if (!day && dayNum) {
      const candidate = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), Number(dayNum[1])));
      if (candidate.getTime() < from.getTime()) candidate.setUTCMonth(candidate.getUTCMonth() + 1);
      day = candidate;
    }
  }

  if (!day) return { error: `could not read a day from "${input.date ?? ''}"` };
  return {
    at: day,
    day: day.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }),
  };
}

export function resolveWhen(input: { date?: string; time?: string; from?: Date; timezone?: string }): { iso?: string; day?: string; clock?: string; error?: string } {
  const from = input.from ?? new Date();
  const tz = input.timezone ?? 'UTC';
  const dateText = String(input.date ?? '').trim().toLowerCase();
  const timeText = String(input.time ?? '').trim().toLowerCase();

  let day: Date | undefined;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
  if (iso) {
    day = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
  } else if (/tomorrow|next day/.test(dateText)) {
    day = new Date(from.getTime() + 86_400_000);
  } else if (/today|tonight|this afternoon|this morning|this evening/.test(dateText)) {
    day = from;
  } else {
    for (let i = 0; i < DAYS.length; i += 1) {
      if (dateText.includes(DAYS[i])) {
        const delta = (i - from.getUTCDay() + 7) % 7 || 7;
        day = new Date(from.getTime() + delta * 86_400_000);
        break;
      }
    }
    // "the 12th", "12 October", "Oct 12"
    const dayNum = /(?:^|\s)(\d{1,2})(?:st|nd|rd|th)?(?:\s|$)/.exec(dateText);
    if (!day && dayNum) {
      const candidate = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), Number(dayNum[1])));
      if (candidate.getTime() < from.getTime()) candidate.setUTCMonth(candidate.getUTCMonth() + 1);
      day = candidate;
    }
  }

  if (!day) return { error: `could not read a day from "${input.date ?? ''}"` };

  const clock = parseClock(timeText);
  if (!clock) return { error: `could not read a time from "${input.time ?? ''}"` };

  const when = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), clock.hours, clock.minutes));
  return {
    iso: when.toISOString(),
    day: when.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: tz }),
    clock: when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }),
  };
}

function parseClock(text: string) {
  const match = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/.exec(text.trim());
  if (!match) return undefined;
  let hours = Number(match[1]);
  const minutes = Number(match[2] ?? 0);
  const meridiem = match[3];
  if (meridiem === 'pm' && hours < 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;
  if (!meridiem && hours <= 7) hours += 12; // "at 2" after noon is nearly always 2pm
  if (hours > 23) return undefined;
  return { hours, minutes };
}

/** The booking a call is about: by id, else by the caller's number. */
export function bookingInScope(ctx: BookingToolContext): BookingDoc | undefined {
  if (ctx.bookingId) {
    const byId = bookingById(ctx.orgId, ctx.bookingId);
    if (byId) return byId;
  }
  if (ctx.callerNumber) {
    const digits = ctx.callerNumber.replace(/\D/g, '').slice(-10);
    const open = bookingsFor(ctx.orgId, (b) => b.status !== 'completed' && b.status !== 'cancelled');
    return open.find((b) => b.customer.number.replace(/\D/g, '').endsWith(digits));
  }
  return undefined;
}

/**
 * Runs a booking-aware tool.
 *
 * Returns `undefined` when the tool is not a booking tool, or when no booking is
 * in scope — the caller then falls through to the generic implementation, so a
 * support call that is not about a booking behaves exactly as before.
 */
export async function runBookingTool(input: {
  ctx: BookingToolContext;
  name: string;
  args: Record<string, unknown>;
  /** The caller's words, used when the model omitted a date the caller did name. */
  text?: string;
}): Promise<ToolCall | undefined> {
  const { ctx, name } = input;
  if (!BOOKING_TOOLS.has(name)) return undefined;
  // The tools that act on *a* booking need one in scope (or a caller number to
  // find it by). Availability does not: "when is the practice free?" is a
  // question about the diary, and a dashboard test call deserves the real
  // answer as much as a live one does.
  if (name !== 'check_availability' && !ctx.bookingId && !ctx.callerNumber) return undefined;

  const started = Date.now();
  const booking = bookingInScope(ctx);
  const gateway = scheduleGatewayFor(ctx.orgId);
  const args = { ...input.args };
  const done = (result: Record<string, unknown>, status: 'ok' | 'error' = 'ok'): ToolCall => ({
    name,
    args: Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && v !== '')),
    result: JSON.stringify(result),
    ms: Math.max(40, Date.now() - started),
    status,
  });

  // ---- looking the booking up -------------------------------------------
  if (/lookup_order|order_status/.test(name)) {
    if (!booking) {
      return done(
        {
          found: false,
          note: 'No appointment is on file for this number — ask the caller for the day they booked, or offer to book one.',
        },
        'ok'
      );
    }
    return done({
      found: true,
      reference: booking.externalId,
      appointment: describeBooking(booking),
      startsAt: booking.startsAt,
      status: booking.status,
      service: booking.service,
      customer: booking.customer.name,
      timezone: booking.timezone ?? ctx.timezone ?? 'UTC',
    });
  }

  // ---- availability ------------------------------------------------------
  if (name === 'check_availability') {
    // A day is the question here — a clock is not, and demanding one made the
    // agent answer "I have nothing on that day" for a perfectly good Thursday.
    const resolved = resolveDay({ date: String(args.date ?? 'tomorrow'), from: undefined });
    if (resolved.error) {
      return done({ slots: [], note: `${resolved.error}. Ask the caller which day they mean.` }, 'error');
    }
    const dayIso = resolved.at!.toISOString();
    const dateStr = dayIso.slice(0, 10);

    // The practice's own diary answers first: working hours, holidays, buffers
    // and the people who can actually do the job. This is the same engine the
    // dashboard and the booking page read.
    if (rotaForOrg(ctx.orgId).length > 0) {
      const service = args.service ? serviceByNameOrId(ctx.orgId, String(args.service)) : undefined;
      const asked = String(args.provider ?? args.with ?? '');
      const provider = asked
        ? providersFor(ctx.orgId).find((p) => p.name.toLowerCase().includes(asked.toLowerCase()))
        : undefined;
      /**
       * The day asked for, or — when the caller named no day at all — the next
       * two weeks.
       *
       * "Do you have anything this week?" is the most common question a
       * receptionist hears, and resolving it to "tomorrow" quietly turned it
       * into the wrong answer. A caller with no day in mind gets the next few
       * openings with their dates attached, which is what they were asking for.
       */
      const dayNamed = Boolean(String(args.date ?? '').trim()) || /(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today)/i.test(String(input.text ?? ''));
      const scanDays = dayNamed ? 1 : 14;
      // "Do you have anything at the East clinic?" is a question about a place, and
      // answering it with a slot at the other one is how a caller drives to the
      // wrong building.
      const askedSite = matchSite(ctx, String(args.site ?? args.location ?? '')) ?? siteFromText(ctx, input.text);
      let found;
      try {
        found = await gateway.findSlots({
          serviceId: service?.id,
          providerId: provider?.id,
          locationId: askedSite?.id,
          from: dateStr,
          days: scanDays,
          limit: scanDays > 1 ? 60 : 40,
        }, { origin: 'phone', callId: ctx.callId, idempotencyKey: `phone-availability:${ctx.callId ?? 'inbound'}:${dateStr}:${service?.id ?? ''}:${provider?.id ?? ''}:${askedSite?.id ?? ''}` });
      } catch (error) {
        if (error instanceof ScheduleError) {
          return done({
            slots: [], unavailable: true, requiresStaffHandoff: true,
            note: 'Appointment availability is unavailable, so no time can be promised. Offer to take a callback request.',
          }, 'error');
        }
        throw error;
      }

      // "Thursday afternoon" is a real question, and answering it with 9:00am
      // is how a booking call goes wrong. Filter to the part of the day the
      // caller named — unless that leaves nothing, in which case the whole day
      // is the more useful answer.
      const spoken = String(input.text ?? '').toLowerCase();
      const period: [number, number] | undefined = /afternoon/.test(spoken)
        ? [12 * 60, 17 * 60]
        : /evening|tonight/.test(spoken)
          ? [16 * 60, 22 * 60]
          : /morning/.test(spoken)
            ? [0, 12 * 60]
            : undefined;
      let pool = found.slots;
      if (period) {
        const narrowed = pool.filter((s) => {
          const clock = parseClock(s.local.start);
          if (!clock) return true;
          const at = clock.hours * 60 + clock.minutes;
          return at >= period[0] && at < period[1];
        });
        if (narrowed.length) pool = narrowed;
      }
      // A caller hears times, not rosters: two providers free at 1:00pm is one
      // offer, not two. The full per-provider picture stays in the diary.
      const seen = new Set<string>();
      pool = pool.filter((s) => (seen.has(s.local.start) ? false : (seen.add(s.local.start), true)));
      if (scanDays === 1) {
        pool = pool.slice(0, 6);
        const names = [...new Set(pool.map((s) => s.providerName))];
        return done({
          day: resolved.day,
          date: dateStr,
          // Display strings the agent can read aloud; `times` keeps the precision.
          slots: pool.map((s) => s.local.start),
          times: pool.map((s) => s.startsAt),
          // Which building each time is at. Only present when the practice has
          // more than one, so a single-site agent's answer is unchanged.
          sites: pool.map((s) => siteNameFor(ctx, s.locationId)),
          at: siteNameFor(ctx, pool[0]?.locationId),
          providers: names,
          provider: names.length === 1 ? names[0] : undefined,
          service: found.service?.name,
          timezone: found.timezone,
          note: found.reason,
        });
      }
      // No day asked for: offer one opening per day, earliest first, and say
      // which day each one is on — an unqualified "1:00pm" would be a guess.
      const perDay = new Map<string, typeof pool[number]>();
      for (const s of pool) if (!perDay.has(s.local.date)) perDay.set(s.local.date, s);
      const offers = [...perDay.values()].slice(0, 5).map((s) => ({
        date: s.local.date,
        weekday: new Date(`${s.local.date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' }),
        time: s.local.start,
        startsAt: s.startsAt,
        providerName: s.providerName,
        site: siteNameFor(ctx, s.locationId),
      }));
      const names = [...new Set(offers.map((o) => o.providerName))];
      return done({
        asked: 'next two weeks',
        offers,
        // Both shapes, because the agent may read either and both must be real.
        slots: offers.map((o) => `${o.weekday} ${o.time}`),
        times: offers.map((o) => o.startsAt),
        providers: names,
        provider: names.length === 1 ? names[0] : undefined,
        service: found.service?.name,
        timezone: found.timezone,
        note: found.reason ?? 'No day was named, so these are the next openings, one per day.',
      });
    }

    // No rota configured: use conservative standard times excluding appointments already present.
    const dayStart = new Date(`${dateStr}T00:00:00.000Z`).getTime();
    const taken = bookingsFor(ctx.orgId, (b) => {
      const at = new Date(b.startsAt).getTime();
      return b.status !== 'cancelled' && at >= dayStart && at < dayStart + 86_400_000;
    }).map((b) => new Date(b.startsAt).toISOString());
    const open = ['9:15am', '11:40am', '2:00pm', '4:30pm'].filter((slot) => {
      const clock = parseClock(slot)!;
      const at = new Date(dayStart + clock.hours * 3_600_000 + clock.minutes * 60_000).toISOString();
      return !taken.includes(at);
    });
    return done({ day: resolved.day, date: dateStr, slots: open, taken: taken.length, timezone: ctx.timezone ?? 'UTC' });
  }

  // ---- booking / moving / cancelling ------------------------------------
  if (name === 'book_appointment' || name === 'reschedule_appointment') {
    const resolved = resolveWhen({
      date: String(args.date ?? ''),
      time: String(args.time ?? ''),
      timezone: ctx.timezone,
    });
    if (resolved.error) return done({ booked: false, note: `${resolved.error}. Ask again for both the day and the time.` }, 'error');

    if (booking) {
      const providerForBooking = (booking as { providerId?: string }).providerId
        ? providerById(ctx.orgId, String((booking as { providerId?: string }).providerId))
        : undefined;
      if (providerForBooking) {
        let verdict;
        try {
          verdict = await gateway.isFree({
            providerId: providerForBooking.id,
            // The visit is at the site it is already at: a move is a change of time,
            // and checking the provider's first site instead could pass a slot that
            // is closed at the site the caller is coming to.
            locationId: (booking as { locationId?: string }).locationId,
            serviceId: (booking as { serviceId?: string }).serviceId,
            startsAt: resolved.iso!,
            durationMinutes: Number((booking as { durationMinutes?: number }).durationMinutes ?? 30),
            ignoreBookingId: booking.id,
          }, { origin: 'phone', callId: ctx.callId, idempotencyKey: `phone-move-check:${ctx.callId ?? booking.id}:${resolved.iso}` });
        } catch (error) {
          if (error instanceof ScheduleError) {
            return done({ moved: false, unavailable: true, requiresStaffHandoff: true, note: 'Appointment availability could not be checked. Do not promise a move; offer a staff callback.' }, 'error');
          }
          throw error;
        }
        if (!verdict.free) {
          // Offer what actually works next, rather than asking the caller to
          // guess a second time.
          const alternatives = (await gateway.findSlots({
            providerId: providerForBooking.id,
            serviceId: (booking as { serviceId?: string }).serviceId,
            locationId: (booking as { locationId?: string }).locationId,
            from: resolved.iso!.slice(0, 10), days: 7, limit: 20,
          }, { origin: 'phone', callId: ctx.callId, idempotencyKey: `phone-move-alternatives:${ctx.callId ?? booking.id}:${resolved.iso}` })).slots
            .filter((slot) => slot.startsAt !== resolved.iso)
            .slice(0, 3);
          return done(
            {
              moved: false,
              taken: true,
              note: verdict.reason ?? 'That time is already booked.',
              alternatives: alternatives.map((s) => `${s.local.date} at ${s.local.start}`),
              offers: alternatives.map((s) => ({ date: s.local.date, time: s.local.start, startsAt: s.startsAt })),
            },
            'error',
          );
        }
      }
      /**
       * The room has to move with the time.
       *
       * `isFree` answers for the person, not the four walls: a provider can be
       * free at 3pm in a room that is already occupied. Without this the agent
       * quietly created a double-booked room, which the front desk discovers by
       * walking two patients to the same door. The rule is the diary's own
       * (`moveAppointment`): keep the room if it is free at the new time, take
       * another free one at the site, and if the site has none, say so and offer
       * other times rather than moving the visit into a wall.
       */
      const siteId = (booking as { locationId?: string }).locationId ?? bookingSiteFor(ctx, booking);
      const hadRoom = Boolean((booking as { roomId?: string }).roomId);
      const movedRoom = freeRoomFor(ctx.orgId, {
        locationId: siteId,
        startsAt: resolved.iso!,
        durationMinutes: Number((booking as { durationMinutes?: number }).durationMinutes ?? 30),
        serviceId: (booking as { serviceId?: string }).serviceId,
        ignoreBookingId: booking.id,
      });
      if (hadRoom && siteId && !movedRoom) {
        const siteName = locationById(ctx.orgId, String(siteId))?.name;
        // A booking always has a practitioner in practice, but the room rule does
        // not depend on one: with nobody assigned there is simply nothing to offer
        // as an alternative, and the refusal still stands.
        const alternatives = providerForBooking
          ? (await gateway.findSlots({
              providerId: providerForBooking.id,
              serviceId: (booking as { serviceId?: string }).serviceId,
              locationId: siteId,
              from: resolved.iso!.slice(0, 10), days: 7, limit: 20,
            }, { origin: 'phone', callId: ctx.callId, idempotencyKey: `phone-room-alternatives:${ctx.callId ?? booking.id}:${resolved.iso}` })).slots.slice(0, 3)
          : [];
        return done(
          {
            moved: false,
            taken: true,
            note: `Every room${siteName ? ` at ${siteName}` : ''} is taken at that time.`,
            alternatives: alternatives.map((s) => `${s.local.date} at ${s.local.start}`),
            offers: alternatives.map((s) => ({ date: s.local.date, time: s.local.start, startsAt: s.startsAt })),
          },
          'error',
        );
      }

      try {
        const moved = await gateway.moveAppointment({
          bookingId: booking.id,
          startsAt: resolved.iso!,
          roomId: hadRoom ? movedRoom?.id : undefined,
          note: `moved during call to ${resolved.day} at ${resolved.clock}`,
        }, {
          origin: 'phone', actor: 'agent', callId: ctx.callId,
          idempotencyKey: `phone-move:${ctx.callId ?? booking.id}:${stableHash([booking.id, resolved.iso!]).slice(0, 32)}`,
        });
        const updated = moved.booking;
        return done({
          moved: true,
          confirmed: moved.confirmed,
          reference: booking.externalId,
          appointment: describeBooking(updated, siteNameFor(ctx, siteId)),
          site: siteNameFor(ctx, siteId),
          room: updated.roomId ? roomNameOf(ctx.orgId, updated.roomId) : undefined,
          startsAt: resolved.iso,
          smsSent: true,
        });
      } catch (error) {
        if (error instanceof ScheduleError) {
          return done({ moved: false, unavailable: true, requiresStaffHandoff: true, note: 'The appointment could not be moved. Do not say it was moved; offer a staff callback.' }, 'error');
        }
        throw error;
      }
    }

    // No booking in scope: this is a new one. With practice data present it goes
    // on the real diary — checked for clashes first, so the agent cannot promise
    // a slot the receptionist's screen says is taken.
    const service = args.service ? serviceByNameOrId(ctx.orgId, String(args.service)) : undefined;
    const hasPractice = rotaForOrg(ctx.orgId).length > 0 || providersFor(ctx.orgId).length > 0;
    const askedProvider = String(args.provider ?? args.with ?? '');
    const provider =
      (askedProvider ? providersFor(ctx.orgId).find((p) => p.name.toLowerCase().includes(askedProvider.toLowerCase())) : undefined) ??
      (service
        ? providersFor(ctx.orgId).find((p) => p.serviceIds.length === 0 || p.serviceIds.includes(service.id))
        : undefined);

    /**
     * Which site the visit is at.
     *
     * The provider's own list used to decide this silently (`locationIds[0]`),
     * which meant an agent that had just read out "Thursday at 10 at Northwind
     * East" could file the appointment at HQ — the caller drives to the wrong
     * building, and the desk at the right one sees an empty diary. The spoken
     * site wins; failing that the provider's site is used *and said out loud* in
     * the confirmation, so the agent can correct a caller who assumed.
     */
    const askedSite =
      matchSite(ctx, String(args.site ?? args.location ?? '')) ?? siteFromText(ctx, input.text);
    const bookingSite = askedSite ?? (provider?.locationIds?.[0] ? locationById(ctx.orgId, provider.locationIds[0]) : undefined);

    if (hasPractice && provider) {
      let verdict;
      try {
        verdict = await gateway.isFree({
          providerId: provider.id,
          locationId: bookingSite?.id,
          serviceId: service?.id,
          startsAt: resolved.iso!,
          durationMinutes: service?.durationMinutes ?? 30,
        }, { origin: 'phone', callId: ctx.callId, idempotencyKey: `phone-create-check:${ctx.callId ?? 'inbound'}:${resolved.iso}` });
      } catch (error) {
        if (error instanceof ScheduleError) {
          return done({ booked: false, unavailable: true, requiresStaffHandoff: true, note: 'Appointment availability could not be checked. Do not promise a booking; offer a staff callback.' }, 'error');
        }
        throw error;
      }
      if (!verdict.free) {
        const alternatives = (await gateway.findSlots({
          providerId: provider.id,
          serviceId: service?.id,
          locationId: bookingSite?.id,
          from: resolved.iso!.slice(0, 10), days: 7, limit: 20,
        }, { origin: 'phone', callId: ctx.callId, idempotencyKey: `phone-create-alternatives:${ctx.callId ?? 'inbound'}:${resolved.iso}` })).slots.slice(0, 3);
        return done(
          {
            booked: false,
            taken: true,
            note: `That time is already booked${verdict.conflicts.length ? ` (${verdict.conflicts.map((c) => c.service || 'another appointment').join(', ')})` : ''}.`,
            alternatives: alternatives.map((s) => `${s.local.date} at ${s.local.start}`),
            offers: alternatives.map((s) => ({ date: s.local.date, time: s.local.start, startsAt: s.startsAt })),
          },
          'error'
        );
      }
    }

    // Who is this? A unique exact number gives the minimum booking/contact
    // context. Clinical/admin alert content is deliberately excluded from the
    // phone-assistant boundary and remains on permissioned staff screens.
    const minimumContext = ctx.callerNumber ? phoneAssistantPatientContext(ctx.orgId, ctx.callerNumber) : undefined;
    if (minimumContext?.match === 'review_required') {
      return done({ booked: false, reviewRequired: true, requiresStaffHandoff: true, note: 'This number has more than one exact patient match. Do not identify a patient or link a booking; transfer to staff for identity review.' }, 'error');
    }
    const known = minimumContext?.match === 'exact_unique' ? minimumContext.patient : undefined;
    const callerName = String(args.name ?? known?.name ?? 'Caller');

    const localClient = known?.id
      ? findClientByNumber(ctx.orgId, ctx.callerNumber ?? '')
      : ensureClientForBooking(ctx.orgId, { name: callerName, number: ctx.callerNumber ?? '', email: known?.email }, 'agent', { source: 'call' });
    if (!localClient) {
      return done({ booked: false, reviewRequired: true, requiresStaffHandoff: true, note: 'The patient record could not be linked exactly. Transfer to staff.' }, 'error');
    }
    try {
      const bookingHash = stableHash([ctx.orgId, ctx.callId ?? ctx.callerNumber ?? '', localClient.id, resolved.iso!, service?.id ?? '', provider?.id ?? '', bookingSite?.id ?? '']);
      const created = await gateway.createAppointment({
        externalId: `vox-${bookingHash.slice(0, 18)}`,
        customer: { name: callerName, number: ctx.callerNumber ?? '', email: known?.email },
        service: service?.name ?? String(args.service ?? 'Appointment'),
        startsAt: resolved.iso!,
        durationMinutes: service?.durationMinutes ?? 30,
        value: service?.price,
        providerId: provider?.id,
        serviceId: service?.id,
        locationId: bookingSite?.id ?? provider?.locationIds?.[0],
        status: 'confirmed',
        source: 'call',
        clientId: localClient.id,
      }, {
        origin: 'phone', actor: 'agent', callId: ctx.callId,
        idempotencyKey: `phone-create:${bookingHash}`,
      });
      audit({ orgId: ctx.orgId, actor: 'agent', action: 'booking.created_by_call', target: created.booking.id, detail: `${resolved.day} ${resolved.clock}${provider ? ` with ${provider.name}` : ''} · confirmed` });
      const siteZone = bookingSite?.timezone;
      const smsConsent = consentFor(ctx.orgId, { id: created.booking.clientId, number: created.booking.customer.number }, 'sms');
      const siteName = siteNameFor(ctx, bookingSite?.id);
      return done({
        booked: true,
        confirmed: created.confirmed,
        reference: created.booking.externalId,
        client: created.booking.clientId,
        appointment: describeBooking(created.booking, siteName),
        site: siteName,
        startsAt: resolved.iso,
        when: siteZone ? `${resolved.day} at ${formatClock(new Date(resolved.iso!).getTime(), siteZone)}` : `${resolved.day} at ${resolved.clock}`,
        provider: provider?.name,
        service: service?.name,
        requiresStaffHandoff: minimumContext?.requiresStaffHandoff ?? false,
        smsSent: smsConsent.granted,
        smsBlockedReason: smsConsent.granted ? undefined : smsConsent.reason,
      });
    } catch (error) {
      if (error instanceof ScheduleError) {
        return done({ booked: false, unavailable: true, requiresStaffHandoff: true, note: 'The appointment could not be booked. Do not say it is booked; offer a staff callback.' }, 'error');
      }
      throw error;
    }
  }

  if (name === 'cancel_appointment') {
    if (!booking) {
      return done({ cancelled: false, note: 'No appointment is on file for this number — ask the caller which day they booked.' }, 'error');
    }
    try {
      const cancellationHash = stableHash([booking.id, ctx.callId ?? '', String(args.reason ?? '')]);
      const cancelled = await gateway.cancelAppointment({
        bookingId: booking.id,
        reason: String(args.reason ?? 'caller asked to cancel'),
      }, {
        origin: 'phone', actor: 'agent', callId: ctx.callId,
        idempotencyKey: `phone-cancel:${cancellationHash}`,
      });
      return done({
        cancelled: true,
        confirmed: cancelled.confirmed,
        reference: booking.externalId,
        previously: describeBooking(booking, siteNameFor(ctx, booking.locationId)),
        status: cancelled.booking.status,
      });
    } catch (error) {
      if (error instanceof ScheduleError) {
        return done({ cancelled: false, unavailable: true, requiresStaffHandoff: true, note: 'The appointment could not be cancelled. Do not say it was cancelled; offer a staff callback.' }, 'error');
      }
      throw error;
    }
  }

  if (name === 'send_confirmation') {
    // On a call about an appointment the record is the booking; on an inbound
    // call it is whoever rang. Either way the confirmation cannot be sent to a
    // client who has withdrawn consent — and the agent is told why, so it can
    // say so out loud instead of claiming a text that never went.
    const clientRef = booking
      ? { id: (booking as { clientId?: string }).clientId, number: booking.customer.number }
      : { number: ctx.callerNumber };
    const channel = args.channel === 'email' ? 'email' : 'sms';
    const consent = consentFor(ctx.orgId, clientRef, channel as 'sms' | 'email');
    if (!consent.granted) {
      return done(
        {
          queued: false,
          blocked: true,
          reason: consent.reason ?? 'no consent on file',
          to: booking?.customer.number ?? ctx.callerNumber,
          channel,
          note: 'Do not promise a message. Read the details out instead, or ask them to note them down.',
        },
        'error',
      );
    }
    /**
     * The message the agent just promised goes on the queue, for real.
     *
     * Until now this returned `queued: true` and nothing carried it — the kind of
     * claim that looks fine in a demo and is embarrassing in a clinic. The row
     * records the consent it relied on, and the sender re-checks that consent at
     * send time, so somebody who withdraws it in between does not get the text.
     */
    const to = channel === 'email' ? String(booking?.customer.email ?? '') : String(booking?.customer.number ?? ctx.callerNumber ?? '');
    const summary = String(args.summary ?? (booking ? describeBooking(booking) : 'your appointment'));
    const site = booking?.locationId ? locationById(ctx.orgId, String(booking.locationId)) : undefined;
    const provider = booking?.providerId ? providerById(ctx.orgId, String(booking.providerId)) : undefined;
    const starts = booking ? new Date(String(booking.startsAt)) : undefined;
    const terms = termsFor(ctx.orgId);
    const message = to
      ? queueMessage({
          orgId: ctx.orgId,
          channel,
          to,
          clientId: (booking as { clientId?: string } | undefined)?.clientId,
          bookingId: booking?.id,
          subject: channel === 'email' ? `Your ${terms.appointment.one}` : undefined,
          body:
            starts && site
              ? confirmationBody({
                  clientName: booking?.customer.name ?? 'there',
                  when: `${starts.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: site.timezone })} at ${formatClock(starts.getTime(), site.timezone)}`,
                  service: booking?.service ?? summary,
                  provider: provider?.name,
                  site: site.name,
                  reference: booking?.externalId,
                  manageLink: booking ? manageLinkFor(ctx.orgId, booking.id) : undefined,
                  terms,
                })
              : summary,
          sendAt: booking ? new Date(Math.max(Date.now(), new Date(String(booking.startsAt)).getTime() - 24 * 3_600_000)).toISOString() : undefined,
          source: 'agent',
          meta: { kind: 'confirmation', by: 'agent', reference: booking?.externalId ?? '' },
          respectConsent: true,
          // The caller is on the line and just asked for it.
          immediate: true,
        })
      : undefined;

    return done({
      queued: Boolean(message) && message!.status === 'pending',
      messageId: message?.id,
      status: message?.status,
      to: to || 'no address on file',
      channel,
      consent: consent.source ?? 'transactional',
      summary,
      reference: booking?.externalId,
      note: message ? undefined : 'No number or email on file — ask the caller to note the details down.',
    });
  }

  if (name === 'draft_note') {
    /**
     * The agent writes down what happened — and signs nothing.
     *
     * This is the one tool whose *whole* value is the restriction: a draft tied to
     * the appointment and the client, marked `agent`, with the call attached, and
     * left for a practitioner to read, correct and sign. Anyone who has watched a
     * clinician write up six visits at the end of a day knows why it exists; anyone
     * who has read a record system's audit trail knows why it must not finalise it.
     */
    const clientId = booking ? String((booking as { clientId?: string }).clientId ?? '') : findClientByNumber(ctx.orgId, String(ctx.callerNumber ?? ''))?.id ?? '';
    if (!clientId) {
      return done(
        {
          drafted: false,
          note: 'No client record is attached to this call, so there is nowhere to file the note. Offer to take their number so the practice can call back.',
        },
        'error',
      );
    }
    const summary = String(args.summary ?? args.content ?? '').trim();
    const explicit = (args.sections ?? {}) as Record<string, string>;
    const drafted = draftNoteFromCall({
      orgId: ctx.orgId,
      clientId,
      bookingId: booking?.id,
      serviceId: booking?.serviceId ? String(booking.serviceId) : undefined,
      providerId: booking?.providerId ? String(booking.providerId) : undefined,
      callId: ctx.callId,
      content: explicit,
      summary,
      actor: 'agent',
      actorName: 'AI receptionist',
    });
    if (!drafted.ok) return done({ drafted: false, error: drafted.error }, 'error');
    return done({
      drafted: true,
      noteId: drafted.note.id,
      status: drafted.note.status,
      template: drafted.note.templateName,
      missing: incompleteSections(drafted.note),
      note: 'A draft for a person to read and sign — it is not part of the record until somebody finalises it.',
    });
  }

  if (name === 'create_payment_link') {
    /**
     * Texts or emails a link to pay an outstanding invoice.
     *
     * The whole reason this tool exists in a *practice* assistant is the sentence
     * at the end of a call — "can I pay that now?" — and the honest answer is a
     * link, not card details read aloud down a phone line. Three rules:
     *
     *   - **The amount is the invoice's, not the caller's.** A link is created for
     *     what is actually outstanding (or less, if they ask to pay part of it);
     *     the agent cannot ask for more than is owed.
     *   - **The link is a real object.** It is created through the same module the
     *     dashboard uses, recorded against the invoice, and sending it queues a
     *     real message through the consent-checked queue — the agent does not
     *     "read out a URL".
     *   - **Nothing is taken here.** The tool asks for money; the money arrives
     *     later, through the provider (or the sandbox), and is recorded then.
     */
    const clientId = booking ? String((booking as { clientId?: string }).clientId ?? '') : findClientByNumber(ctx.orgId, String(ctx.callerNumber ?? ''))?.id ?? '';
    if (!clientId) {
      return done({ sent: false, note: 'No client record is attached to this call, so there is no invoice to pay. Offer to take their number so the practice can send a link.' }, 'error');
    }
    const open = invoicesFor(ctx.orgId, { clientId }).filter((i) => i.kind === 'invoice' && ['issued', 'partly_paid', 'overdue'].includes(i.status) && balanceMinorOf(i) > 0);
    if (!open.length) {
      return done({ sent: false, amountDue: 'nothing', note: 'This client has nothing outstanding. Say so plainly — do not invent a balance.' });
    }
    const wantedNumber = String(args.invoice ?? args.invoiceNumber ?? '').trim().toLowerCase();
    const invoice = (wantedNumber ? open.find((i) => String(i.number ?? '').toLowerCase() === wantedNumber) : open[0]) ?? open[0];
    const dueMinor = balanceMinorOf(invoice);
    const askedMinor = args.amount ? Math.round(Number(String(args.amount).replace(/[^0-9.]/g, '')) * 100) : dueMinor;
    const amountMinor = Math.max(1, Math.min(askedMinor || dueMinor, dueMinor));
    const channel = args.channel === 'email' ? 'email' : 'sms';
    const to = channel === 'email' ? String(args.to ?? '') || 'the address on file' : String(args.to ?? ctx.callerNumber ?? '');
    const created = await createPaymentLink({
      orgId: ctx.orgId,
      invoiceId: invoice.id,
      amountMinor,
      origin: process.env.VOXERA_PUBLIC_URL ?? 'http://localhost:3000',
      actor: 'agent',
      actorName: 'AI receptionist',
      note: 'asked for on a call',
    });
    if (!created.ok) return done({ sent: false, error: created.error }, 'error');

    const provider = paymentProviderFor(ctx.orgId);
    // The link goes out the way every other message does — the consent-checked
    // queue, sent immediately, because the caller is on the line expecting it.
    const clientRef = booking ? { id: clientId, number: booking.customer.number } : { id: clientId, number: ctx.callerNumber };
    const consent = consentFor(ctx.orgId, clientRef, channel as 'sms' | 'email');
    let messageId: string | undefined;
    let delivered = false;
    let deliveryNote: string | undefined;
    if (!consent.granted) {
      return done(
        {
          sent: false,
          blocked: true,
          reason: consent.reason ?? 'no consent on file',
          linkId: created.link.id,
          amountOnLink: formatMoney(amountMinor, invoice.currency),
          note: 'Do not promise a link. The practice has no consent to text or email this client — offer to take the payment at the desk instead, or ask them to call the practice.',
        },
        'error',
      );
    }
    if ((channel === 'email' && to.includes('@')) || (channel === 'sms' && to)) {
      const message = queueMessage({
        orgId: ctx.orgId,
        clientId,
        bookingId: booking?.id,
        channel,
        to,
        subject: channel === 'email' ? `${invoice.number} — payment link from the practice` : undefined,
        body:
          channel === 'email'
            ? `${formatMoney(amountMinor, invoice.currency)} is outstanding on ${invoice.number}. Pay securely here: ${created.link.url}`
            : `${created.link.description}: pay ${formatMoney(amountMinor, invoice.currency)} securely here ${created.link.url}`,
        kind: 'payment_link',
        source: 'agent',
        immediate: true,
      });
      messageId = message.id;
      markLinkSent(ctx.orgId, created.link.id, channel);
      // The caller is waiting: carry the queue now rather than at the next tick,
      // and report what the carrier did — not what we hoped it would do.
      const { deliverDueMessages } = await import('./messages');
      await deliverDueMessages({ orgId: ctx.orgId, limit: 10 });
      const after = list<Doc & { id?: string; status?: string; reason?: string }>('messages', () => true).find((m) => m.id === message.id);
      delivered = after?.status === 'sent';
      deliveryNote = after?.reason;
    }

    return done({
      sent: Boolean(messageId),
      invoice: invoice.number,
      amountDue: formatMoney(dueMinor, invoice.currency),
      amountOnLink: formatMoney(amountMinor, invoice.currency),
      linkId: created.link.id,
      channel,
      to,
      sandbox: provider.driver === 'sandbox',
      messageId,
      delivered,
      deliveryError: delivered ? undefined : deliveryNote,
      note: delivered
        ? `The link is on its way by ${channel}. Tell the caller to expect it, and that it is for ${formatMoney(amountMinor, invoice.currency)}.`
        : messageId
          ? `The link exists but the ${channel} did not go through${deliveryNote ? ` (${deliveryNote})` : ''}. Do not promise it arrived — say a colleague will follow up.`
          : 'The link was created but no message could be queued (no number or address on file). Say that a colleague will arrange payment instead.',
    });
  }

  if (name === 'payment_status') {
    /**
     * What this client still owes, and whether a link has been paid.
     *
     * Read-only, and it answers the two questions callers actually ring about:
     * "how much is it?" and "did my payment go through?". It refuses to guess: no
     * invoice, no number.
     */
    const clientId = booking ? String((booking as { clientId?: string }).clientId ?? '') : findClientByNumber(ctx.orgId, String(ctx.callerNumber ?? ''))?.id ?? '';
    if (!clientId) {
      return done({ found: false, note: 'No client record is attached to this call. Ask for their number and offer a call back from the practice.' }, 'error');
    }
    const open = invoicesFor(ctx.orgId, { clientId }).filter((i) => i.kind === 'invoice' && ['issued', 'partly_paid', 'overdue'].includes(i.status));
    const links = linksFor(ctx.orgId, { clientId });
    const lastLink = links[0];
    const outstanding = open.reduce((sum, i) => sum + balanceMinorOf(i), 0);
    return done({
      found: open.length > 0 || links.length > 0,
      outstanding: open.length ? formatMoney(outstanding, open[0].currency) : 'nothing',
      invoices: open.slice(0, 5).map((i) => ({ number: i.number, due: formatMoney(balanceMinorOf(i), i.currency), dueDate: i.dueDate })),
      lastLink: lastLink ? { status: lastLink.status, amount: formatMoney(lastLink.amountMinor, lastLink.currency), sentAt: lastLink.sentAt, paidAt: lastLink.paidAt } : undefined,
      note: open.length
        ? 'Read the amount back exactly, and never read out card numbers — there are none here.'
        : 'Nothing is outstanding. Do not invent a balance; say the account is clear.',
    });
  }

  return undefined;
}

/** Bookings a workspace can call about right now — used by the dashboard and campaigns. */
export function bookableFor(orgId: string, limit = 20) {
  return list<Doc & { startsAt?: string }>('bookings', (b) => (b as { orgId?: string }).orgId === orgId).slice(0, limit);
}
