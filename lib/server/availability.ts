/**
 * Availability engine.
 *
 * One answer to "when is this practice free?", used by the diary, the public
 * booking page and the AI tools alike — because the surest way to make a
 * booking system lie is to compute slots in three places and keep two of them
 * up to date.
 *
 * A slot exists when all of this is true:
 *
 *   - the provider is on the rota that weekday, at that location, after their
 *     breaks and any one-off change for the date,
 *   - the appointment, plus its buffers, fits inside a working window,
 *   - no other appointment already overlaps the provider — or the room,
 *   - it is far enough ahead (minimum notice) and not too far ahead,
 *   - the provider actually offers the service asked for.
 *
 * Everything is computed on the location's clock and returned as UTC instants.
 * Timezones are handled by converting local wall-clock times to instants (never
 * by adding fixed offsets), so a practice in `America/New_York` gets the right
 * answer the week the clocks change.
 */

import { bookingsFor, type BookingDoc } from './bookings';
import { list, type Doc } from './db';
import {
  clockToMinutes,
  locationById,
  locationsFor,
  practiceProfile,
  providerById,
  providersFor,
  rotaChangesFor,
  rotaFor,
  serviceById,
  servicesFor,
  type ProviderDoc,
  type RotaBreak,
  type RotaChangeDoc,
  type RotaWindow,
  type ServiceDoc,
} from './practice';

/* ------------------------------------------------------------- timezone */

export type ZoneParts = { y: number; m: number; d: number; hh: number; mm: number };

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(tz: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(tz);
  if (cached) return cached;
  const made = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  formatterCache.set(tz, made);
  return made;
}

/** The wall-clock reading of an instant in a zone. */
export function zoneParts(instantMs: number, tz: string): ZoneParts {
  const parts = zoneFormatter(tz).formatToParts(new Date(instantMs));
  const pick = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  // `hour12: false` can render midnight as "24" in some ICU versions.
  const hh = pick('hour') % 24;
  return { y: pick('year'), m: pick('month'), d: pick('day'), hh, mm: pick('minute') };
}

export function dateStrIn(tz: string, instantMs = Date.now()): string {
  const p = zoneParts(instantMs, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** The instant of a local wall-clock time on a local date. */
export function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  let ts = Date.UTC(y, m - 1, d, hh, mm);
  // Two correction passes are enough for every real timezone; the third is
  // cheap insurance for zones that shift by more than an hour at once.
  for (let i = 0; i < 3; i += 1) {
    const p = zoneParts(ts, tz);
    const actual = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
    const wanted = Date.UTC(y, m - 1, d, hh, mm);
    if (actual === wanted) break;
    ts += wanted - actual;
  }
  return ts;
}

/** `YYYY-MM-DD` + n calendar days, without timezone arithmetic. */
export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d + n));
  return at.toISOString().slice(0, 10);
}

/** Weekday (0 = Sunday) of a local calendar date. */
export function weekdayOf(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** "2:00pm" — how a caller says a time, and how the agent should say it back. */
export function formatClock(instantMs: number, tz: string): string {
  const p = zoneParts(instantMs, tz);
  const suffix = p.hh >= 12 ? 'pm' : 'am';
  const hour12 = p.hh % 12 === 0 ? 12 : p.hh % 12;
  return `${hour12}:${String(p.mm).padStart(2, '0')}${suffix}`;
}

/* ------------------------------------------------------------ the engine */

export type Slot = {
  startsAt: string;
  endsAt: string;
  providerId: string;
  providerName: string;
  locationId: string;
  locationName: string;
  roomId?: string;
  roomName?: string;
  /** Local wall-clock, for display without re-deriving the zone. */
  local: { date: string; start: string; end: string; timezone: string };
  /** Only ever true with `includeTaken` — the diary says why the slot is out. */
  taken?: boolean;
};

export type AvailabilityQuery = {
  orgId: string;
  serviceId?: string;
  providerId?: string;
  locationId?: string;
  /** `YYYY-MM-DD` (a local date) or an ISO instant. Defaults to today. */
  from?: string;
  days?: number;
  limit?: number;
  /** Include slots that are already taken (for a diary view). */
  includeTaken?: boolean;
};

export type AvailabilityResult = {
  slots: Slot[];
  timezone: string;
  scanned: { days: number; providers: number; dateFrom: string; dateTo: string };
  service?: { id: string; name: string; durationMinutes: number };
  reason?: string;
};

type Busy = { id?: string; startsAt: number; endsAt: number; providerId?: string; roomId?: string };

/** Appointment bounds including buffers — what actually blocks a diary. */
function blockFor(startsAt: number, service: ServiceDoc | undefined, fallbackMinutes: number) {
  const duration = (service?.durationMinutes ?? fallbackMinutes) * 60_000;
  const before = (service?.bufferBeforeMinutes ?? 0) * 60_000;
  const after = (service?.bufferAfterMinutes ?? 0) * 60_000;
  return { start: startsAt - before, end: startsAt + duration + after, duration, before, after };
}

function busyFrom(bookings: BookingDoc[], orgId: string): Busy[] {
  return bookings
    .filter((b) => b.status !== 'cancelled')
    .map((b) => {
      const start = new Date(String(b.startsAt)).getTime();
      const duration = (Number((b as { durationMinutes?: number }).durationMinutes ?? 30) || 30) * 60_000;
      // An appointment blocks its own service's buffers as well as its length:
      // a 15-minute changeover after an installation is time the diary cannot
      // sell, whether or not the next thing is the same service.
      const service = (b as { serviceId?: string }).serviceId ? serviceById(orgId, String((b as { serviceId?: string }).serviceId)) : undefined;
      const before = (service?.bufferBeforeMinutes ?? 0) * 60_000;
      const after = (service?.bufferAfterMinutes ?? 0) * 60_000;
      return {
        // The block remembers which appointment it came from. The clash check has
        // to compare against *that* appointment's buffered bounds; finding "the
        // first block that starts at or before it" instead picks somebody else's
        // appointment and invents a conflict days away from the one being booked.
        id: b.id,
        startsAt: start - before,
        endsAt: start + duration + after,
        providerId: (b as { providerId?: string }).providerId,
        roomId: (b as { roomId?: string }).roomId,
      };
    })
    .filter((b) => Number.isFinite(b.startsAt));
}

function overlaps(aStart: number, aEnd: number, b: Busy) {
  return aStart < b.endsAt && aEnd > b.startsAt;
}

/**
 * A seat is a booking too — and it must not block like one.
 *
 * Eight people in one class share one room and one instructor, so counting their
 * bookings individually would make every seat after the first a clash with the
 * one before it. The class blocks *once*, through its session (below), whatever
 * the number of people in it — including when nobody has joined yet, which is the
 * case a "bookings only" model quietly gets wrong.
 */
function isSeat(b: { sessionId?: unknown }) {
  return Boolean(b.sessionId);
}

/**
 * Classes as busy blocks (A8).
 *
 * Read straight from the collection rather than through `classes.ts` on purpose:
 * that module imports *this* one to check a class against the diary when it is
 * created, and an import back would close the cycle.
 */
type SessionBusyRow = Doc & {
  orgId: string;
  status?: string;
  startsAt: string;
  durationMinutes?: number;
  providerId?: string;
  roomId?: string;
  serviceId?: string;
};

/** A busy block that knows it is a class, so a refusal can name it. */
type SessionBusy = Busy & { id: string; label?: string };

function sessionsBusy(orgId: string, windowTo?: number): SessionBusy[] {
  return list<SessionBusyRow>('classSessions', (s) => {
    if (s.orgId !== orgId) return false;
    if (s.status === 'cancelled') return false;
    return windowTo === undefined || new Date(String(s.startsAt)).getTime() < windowTo;
  }).map((s) => ({
    id: s.id,
    startsAt: new Date(String(s.startsAt)).getTime(),
    endsAt: new Date(String(s.startsAt)).getTime() + (Number(s.durationMinutes ?? 60) || 60) * 60_000,
    providerId: s.providerId,
    roomId: s.roomId,
    label: (s.serviceId ? serviceById(orgId, String(s.serviceId))?.name : undefined) ?? 'A class',
  })).filter((b) => Number.isFinite(b.startsAt));
}

/** The windows a provider actually works on a local date, after changes. */
export function windowsForDate(orgId: string, providerId: string, locationId: string, dateStr: string): RotaWindow[] {
  const change: RotaChangeDoc | undefined = rotaChangesFor(orgId, { providerId, from: dateStr, to: dateStr })[0];
  if (change?.kind === 'off') return [];
  if (change?.kind === 'extra' && change.windows?.length) {
    return change.windows.map((w) => ({ ...w, weekday: w.weekday ?? weekdayOf(dateStr) }));
  }
  const rota = rotaFor(orgId, providerId, locationId);
  if (!rota) return [];
  const weekday = weekdayOf(dateStr);
  return rota.windows.filter((w) => w.weekday === weekday);
}

export function breaksForDate(orgId: string, providerId: string, locationId: string): RotaBreak[] {
  return rotaFor(orgId, providerId, locationId)?.breaks ?? [];
}

export function findSlots(query: AvailabilityQuery): AvailabilityResult {
  const profile = practiceProfile(query.orgId);
  const service = query.serviceId ? serviceById(query.orgId, query.serviceId) : undefined;

  const allLocations = locationsFor(query.orgId);
  const location = query.locationId ? locationById(query.orgId, query.locationId) : undefined;
  // With one site asked for, its clock is the answer. Without one, the slots
  // below each carry their own site's clock and the top-level field becomes a
  // fallback rather than a claim about the whole result.
  const timezone = location?.timezone ?? allLocations[0]?.timezone ?? 'UTC';

  const requestedProviders = query.providerId
    ? [providerById(query.orgId, query.providerId)].filter(Boolean as unknown as (p: ProviderDoc | undefined) => p is ProviderDoc)
    : providersFor(query.orgId);
  const candidates = requestedProviders.filter((p) => {
    if (query.locationId && p.locationIds.length && !p.locationIds.includes(query.locationId)) return false;
    if (service && p.serviceIds.length && !p.serviceIds.includes(service.id)) return false;
    return true;
  });

  const dateFrom = (query.from ?? dateStrIn(timezone)).slice(0, 10);
  const days = Math.max(1, Math.min(Number(query.days ?? 7) || 7, 31));
  const dateTo = addDays(dateFrom, days - 1);
  const limit = Math.max(1, Math.min(Number(query.limit ?? 20) || 20, 200));
  const step = (service?.slotStepMinutes ?? profile.slotStepMinutes) * 60_000;
  const now = Date.now();
  const earliest = now + profile.minNoticeMinutes * 60_000;
  const latest = now + profile.maxAdvanceDays * 86_400_000;

  const windowFrom = zonedToUtc(
    ...(dateFrom.split('-').map(Number) as [number, number, number]),
    0,
    0,
    timezone
  );
  const windowTo = windowFrom + days * 86_400_000 + 86_400_000;
  // One read of the diary for the whole scan, not one per slot. Seats are skipped
  // (their session stands for them) and classes are added as blocks of their own.
  const busy = [
    ...busyFrom(bookingsFor(query.orgId, (b) => !isSeat(b) && new Date(String(b.startsAt)).getTime() < windowTo), query.orgId),
    ...sessionsBusy(query.orgId, windowTo),
  ];

  const slots: Slot[] = [];
  const locationsById = new Map(allLocations.map((l) => [l.id, l]));

  for (let dayIndex = 0; dayIndex < days && slots.length < limit; dayIndex += 1) {
    const dateStr = addDays(dateFrom, dayIndex);
    const [y, m, d] = dateStr.split('-').map(Number);

    for (const provider of candidates) {
      // A provider works at whichever locations they are assigned to; without an
      // explicit location we try each of theirs and take the first that has rota.
      const providerLocations = (query.locationId
        ? [location?.id].filter(Boolean)
        : provider.locationIds.length
          ? provider.locationIds
          : allLocations.map((l) => l.id)) as string[];

      for (const locId of providerLocations) {
        const loc = locationsById.get(locId);
        if (!loc) continue;
        const windows = windowsForDate(query.orgId, provider.id, locId, dateStr);
        if (!windows.length) continue;
        const breaks = breaksForDate(query.orgId, provider.id, locId)
          .map((b) => ({ start: clockToMinutes(b.start)!, end: clockToMinutes(b.end)! }))
          .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end));

        // The location's own clock decides the day, not the requester's: local
        // midnight is the instant every wall-clock minute below is measured
        // from, which is what makes a DST week land on the right hour.
        const dayStart = zonedToUtc(y, m, d, 0, 0, loc.timezone);

        for (const window of windows) {
          const winStart = dayStart + clockToMinutes(window.start)! * 60_000;
          const winEnd = dayStart + clockToMinutes(window.end)! * 60_000;
          for (let at = winStart; at + 0 >= winStart; at += step) {
            if (slots.length >= limit) break;
            const block = blockFor(at, service, 30);
            if (block.start < winStart || block.end > winEnd) {
              // Past the end of the window is past the end of this window; a
              // smaller step cannot bring it back.
              if (block.end > winEnd) break;
              continue;
            }
            if (at < earliest || at > latest) continue;

            // Minutes since local midnight — the clock the rota is written in.
            const blockStartLocal = Math.round((block.start - dayStart) / 60_000);
            const blockEndLocal = Math.round((block.end - dayStart) / 60_000);
            if (breaks.some((b) => blockStartLocal < b.end && blockEndLocal > b.start)) continue;

            const dateAt = dateStrIn(loc.timezone, at);
            if (dateAt !== dateStr) continue; // a DST shift can push a wall time into another day

            const clash = busy.some((b) => {
              if (b.providerId && b.providerId !== provider.id) return false;
              if (!b.providerId) return false; // unassigned work does not block a person
              return overlaps(block.start, block.end, b);
            });
            const taken = slots.some((s) => s.providerId === provider.id && Number(new Date(s.startsAt)) === at);
            if ((clash || taken) && !query.includeTaken) continue;

            const findRoom = (): { id: string; name: string } | undefined => {
              if (!loc.rooms.length) return undefined;
              return loc.rooms.find((room) => !busy.some((b) => b.roomId === room.id && overlaps(block.start, block.end, b)));
            };
            const room = clash ? undefined : findRoom();
            // A site with rooms cannot take a booking when every room is
            // taken — the desk's move path refuses exactly that — so offering
            // the slot anyway is offering a time the diary will not take
            // (the disagreement room_window_check exists to hunt). Taken
            // slots shown for context (includeTaken) are exempt: they are
            // labelled, not offered.
            if (loc.rooms.length && !room && !clash && !taken) continue;

            slots.push({
              startsAt: new Date(at).toISOString(),
              endsAt: new Date(at + block.duration).toISOString(),
              providerId: provider.id,
              providerName: provider.name,
              locationId: loc.id,
              locationName: loc.name,
              roomId: room?.id,
              roomName: room?.name,
              ...(clash || taken ? { taken: true } : {}),
              local: {
                date: dateStr,
                start: formatClock(at, loc.timezone),
                end: formatClock(at + block.duration, loc.timezone),
                timezone: loc.timezone,
              },
            });
          }
        }
      }
    }
  }

  slots.sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  const trimmed = slots.slice(0, limit);

  const reason = trimmed.length
    ? undefined
    : candidates.length === 0
      ? service
        ? `No one offers ${service.name}${query.locationId ? ' at that location' : ''}.`
        : 'No active providers match that request.'
      : `Nothing free between ${dateFrom} and ${dateTo}${service ? ` for ${service.name}` : ''}.`;

  // With no site asked for, the slots can span sites in different zones — so the
  // top-level timezone describes them only when they agree on one.
  const zones = [...new Set(trimmed.map((s) => s.local.timezone))];
  const reported = query.locationId ? timezone : zones.length === 1 ? zones[0] : timezone;

  return {
    slots: trimmed,
    timezone: reported,
    scanned: { days, providers: candidates.length, dateFrom, dateTo },
    service: service ? { id: service.id, name: service.name, durationMinutes: service.durationMinutes } : undefined,
    reason,
  };
}

/**
 * Is this provider free for this long at this instant?
 *
 * The booking path needs the same judgement the slot search makes, or a caller
 * could be given a time the diary would refuse. Buffers are taken from the
 * service on purpose: an installation with a 15-minute travel buffer must not be
 * booked against a consultation that ends on the hour.
 */
export function isFree(input: {
  orgId: string;
  providerId: string;
  startsAt: string;
  durationMinutes: number;
  service?: ServiceDoc;
  roomId?: string;
  locationId?: string;
  ignoreBookingId?: string;
  /** Used by atomic sync validation when several existing rows move together. */
  ignoreBookingIds?: string[];
}): { free: boolean; reason?: string; conflicts: Array<{ id: string; startsAt: string; service?: string }> } {
  const start = new Date(input.startsAt).getTime();
  if (!Number.isFinite(start)) return { free: false, reason: 'That start time is not a valid date.', conflicts: [] };

  // Hours, holidays and breaks come first: "we are closed then" is a more useful
  // answer than "someone else has it", and it is the same answer the slot search
  // would have given by simply not offering the time.
  const window = windowVerdict({
    orgId: input.orgId,
    providerId: input.providerId,
    startsAt: input.startsAt,
    durationMinutes: input.durationMinutes,
    service: input.service,
    locationId: input.locationId,
  });
  if (!window.ok) return { free: false, reason: window.reason, conflicts: [] };

  const block = blockFor(start, input.service, input.durationMinutes);

  /**
   * A class blocks the person running it (A8).
   *
   * The room half of the check below reads the merged busy list, but the
   * practitioner half only ever looked at *bookings* — so a session whose room had
   * not been chosen could be quietly double-booked by a private appointment at the
   * same hour. A class is a commitment of somebody's time whether or not a room
   * has been picked for it.
   */
  const classHits = sessionsBusy(input.orgId).filter(
    (session) => overlaps(block.start, block.end, session) && (session.providerId === input.providerId || Boolean(input.roomId && session.roomId === input.roomId))
  );
  if (classHits.length) {
    return {
      free: false,
      reason: `${[...new Set(classHits.map((c) => c.label ?? 'A class'))].join(' and ')} is on at that time.`,
      conflicts: classHits.map((c) => ({ id: c.id, startsAt: new Date(c.startsAt).toISOString(), service: c.label })),
    };
  }

  // The appointment being moved is not in its own way: a reschedule that keeps
  // its room (or its practitioner) would otherwise clash with itself, and a
  // resize — same time, longer — would be refused with "that room is already
  // booked" by the very appointment sitting in it.
  const ignored = new Set([...(input.ignoreBookingIds ?? []), ...(input.ignoreBookingId ? [input.ignoreBookingId] : [])]);
  const notSelf = (b: BookingDoc) => !ignored.has(b.id) && !isSeat(b);
  const busy = [
    ...busyFrom(bookingsFor(input.orgId, notSelf), input.orgId),
    ...sessionsBusy(input.orgId),
  ].filter((b) => b.providerId === input.providerId || (input.roomId && b.roomId === input.roomId));
  const others = busyFrom(bookingsFor(input.orgId, notSelf), input.orgId);
  const conflicts = bookingsFor(input.orgId, notSelf).filter((b) => {
    if (b.status === 'cancelled') return false;
    if ((b as { providerId?: string }).providerId !== input.providerId) return false;
    const busyBlock = others.find((o) => o.id === b.id);
    const at = new Date(String(b.startsAt)).getTime();
    const end = at + (Number((b as { durationMinutes?: number }).durationMinutes ?? 30) || 30) * 60_000;
    // Buffered bounds, so a changeover counts as a clash rather than a squeeze.
    const from = busyBlock ? Math.min(busyBlock.startsAt, at) : at;
    const to = busyBlock ? Math.max(busyBlock.endsAt, end) : end;
    return block.start < to && block.end > from;
  });
  if (conflicts.length) {
    return {
      free: false,
      conflicts: conflicts.map((c) => ({ id: c.id, startsAt: String(c.startsAt), service: String(c.service ?? '') })),
    };
  }
  const roomClash = input.roomId && busy.some((b) => b.roomId === input.roomId && overlaps(block.start, block.end, b));
  if (roomClash) return { free: false, reason: 'That room is already booked at that time.', conflicts: [] };
  return { free: true, conflicts: [] };
}

/**
 * Why a specific time cannot be used — working hours, one-off changes, breaks
 * and buffers, before any clash is even considered.
 *
 * Split out so `isFree` and `findSlots` cannot drift apart: a time the search
 * never offers is a time a move must refuse.
 */
export function windowVerdict(input: {
  orgId: string;
  providerId: string;
  startsAt: string;
  durationMinutes: number;
  service?: ServiceDoc;
  locationId?: string;
}): { ok: true } | { ok: false; reason: string } {
  const start = new Date(input.startsAt).getTime();
  if (!Number.isFinite(start)) return { ok: false, reason: 'That start time is not a valid date.' };
  const provider = providerById(input.orgId, input.providerId);
  if (!provider) return { ok: false, reason: 'That provider no longer exists.' };

  const sites = input.locationId
    ? [locationById(input.orgId, input.locationId)].filter(Boolean)
    : (provider.locationIds.length ? provider.locationIds : locationsFor(input.orgId).map((l) => l.id))
        .map((id) => locationById(input.orgId, id))
        .filter(Boolean);
  if (!sites.length) return { ok: false, reason: 'That provider is not assigned to any location.' };

  const reasons: string[] = [];
  for (const site of sites) {
    const localDate = dateStrIn(site!.timezone, start);
    const windows = windowsForDate(input.orgId, provider.id, site!.id, localDate);
    if (!windows.length) {
      reasons.push(`not working on ${localDate} at ${site!.name}`);
      continue;
    }
    const [y, m, d] = localDate.split('-').map(Number);
    const dayStart = zonedToUtc(y, m, d, 0, 0, site!.timezone);
    const block = blockFor(start, input.service, input.durationMinutes);
    const startLocal = Math.round((block.start - dayStart) / 60_000);
    const endLocal = Math.round((block.end - dayStart) / 60_000);

    const inside = windows.some((w) => startLocal >= (clockToMinutes(w.start) ?? 0) && endLocal <= (clockToMinutes(w.end) ?? 0));
    if (!inside) {
      reasons.push(`outside working hours at ${site!.name} (${windows.map((w) => `${w.start}–${w.end}`).join(', ')})`);
      continue;
    }
    const breaks = breaksForDate(input.orgId, provider.id, site!.id)
      .map((b) => ({ start: clockToMinutes(b.start) ?? 0, end: clockToMinutes(b.end) ?? 0, label: b.label ?? 'break' }))
      .filter((b) => b.end > b.start);
    const onBreak = breaks.find((b) => startLocal < b.end && endLocal > b.start);
    if (onBreak) {
      reasons.push(`that time is ${onBreak.label}`);
      continue;
    }
    return { ok: true };
  }
  return { ok: false, reason: reasons[0] ?? 'that time is not available' };
}

/** The next few free starts for a provider — used to offer alternatives after a clash. */
export function alternativesNear(input: {
  orgId: string;
  providerId: string;
  around: string;
  durationMinutes: number;
  serviceId?: string;
  locationId?: string;
  limit?: number;
  /** The appointment being moved — it must not block its own old slot. */
  ignoreBookingId?: string;
}): Slot[] {
  const site = input.locationId ? locationById(input.orgId, input.locationId) : undefined;
  const day = dateStrIn(site?.timezone ?? 'UTC', new Date(input.around).getTime());
  const found = findSlots({
    orgId: input.orgId,
    providerId: input.providerId,
    serviceId: input.serviceId,
    locationId: input.locationId,
    from: day,
    days: 7,
    limit: 60,
  }).slots.filter((s) => s.startsAt !== new Date(input.around).toISOString() && s.providerId === input.providerId);

  // Same time-of-day first: a caller moving "Thursday afternoon" wants another
  // afternoon, not 9am the next morning.
  const aroundMs = new Date(input.around).getTime();
  const clockShift = (slot: Slot) => Math.abs(new Date(slot.startsAt).getTime() - aroundMs);
  const sameHalf = found.filter((s) => (new Date(s.startsAt).getUTCHours() >= 12) === (new Date(input.around).getUTCHours() >= 12));

  // One slot per day, so three offers are three real choices.
  const seen = new Set<string>();
  const pick = (rows: Slot[]) =>
    rows
      .sort((a, b) => clockShift(a) - clockShift(b))
      .filter((s) => (seen.has(s.local.date) ? false : (seen.add(s.local.date), true)))
      .slice(0, input.limit ?? 3);
  const chosen = pick(sameHalf.length ? sameHalf : found);
  if (chosen.length < (input.limit ?? 3)) chosen.push(...pick(found).filter((s) => !chosen.includes(s)));
  void input.durationMinutes;
  void input.ignoreBookingId;
  return chosen;
}

/** Convenience for callers that have a service name from a model. */
export function resolveServiceForBooking(orgId: string, value: string | undefined): ServiceDoc | undefined {
  if (!value) return undefined;
  const needle = value.trim().toLowerCase();
  return (
    servicesFor(orgId, { includeInactive: true }).find((s) => s.name.toLowerCase() === needle) ??
    servicesFor(orgId, { includeInactive: true }).find((s) => s.name.toLowerCase().includes(needle) || needle.includes(s.name.toLowerCase()))
  );
}
