/**
 * My day — one practitioner's own diary, told in the order they live it.
 *
 * The board (`lib/server/board.ts`) answers *"what is happening in this clinic
 * today"* for whoever is standing at the desk. This module answers a narrower,
 * more personal question: *"what is my day"* — for the person holding the
 * appointment book, read on a phone between clients.
 *
 * Three things fall out of that difference and they are the reason this is not
 * just a filtered board:
 *
 *   1. **It is one person's day, not a site's.** The practitioner's rota decides
 *      which sites they are at and between which hours; a day off is a day off
 *      with the reason attached.
 *   2. **It is read in running order, starting from now.** What is next, how many
 *      minutes until it, who has arrived and is waiting, what has been done, and
 *      what is left.
 *   3. **It says what is free.** A receptionist can see the gap between two
 *      clients; the practitioner is the one who decides whether to fill it. The
 *      gaps here are computed from the rota minus the appointments minus the
 *      rota's breaks, and each one is marked bookable or not against the
 *      practice's notice window and the shortest service the practice offers —
 *      because "free" and "bookable" are different answers and conflating them
 *      is how a slot gets promised that the diary cannot keep.
 *
 * The link between a login and a practitioner record is `providers[].userId`,
 * with a fallback on a matching email (the same rule `membersFor` uses so the
 * team screen and this page never disagree). A login with no link is not an
 * error: it is told the truth, and offered the one action that fixes it.
 *
 * Medical flags travel with the appointment: the point of a day view is that the
 * practitioner sees "anticoagulants" before the client is in the chair, not after
 * they read the record. Reading those flags is a record access and is logged as
 * one.
 */

import { list, update, type Doc } from './db';
import { audit } from './audit';
import { recordAccess } from './access-log';
import { bookingsFor, type BookingDoc } from './bookings';
import { STATUS_TRANSITIONS } from './diary';
import { addDays, dateStrIn, zonedToUtc } from './availability';
import {
  locationsFor,
  practiceProfile,
  providerById,
  providersFor,
  rotaFor,
  rotaChangesFor,
  servicesFor,
  type LocationDoc,
  type ProviderDoc,
  type RotaChangeDoc,
  type RotaWindow,
} from './practice';
import { roomsFor } from './rooms';
import type { ClientDoc } from './clients';
import { patientAlertsFor } from './patient-alerts';

/* ------------------------------------------------------------------- types */

export type DayProvider = {
  id: string;
  name: string;
  title?: string;
  colour?: string;
  email?: string;
  userId?: string;
  sites: string[];
};

export type DayAlert = { label: string; detail?: string; severity: string };

export type DayAppointment = {
  id: string;
  startsAt: string;
  /** Wall clock at the site, e.g. `9:30 AM`. Always stated, never inferred. */
  local: string;
  endsLocal: string;
  durationMinutes: number;
  status: string;
  /** Statuses this appointment may legally move to next (`STATUS_TRANSITIONS`). */
  canMoveTo: string[];
  clientId?: string;
  client: string;
  phone?: string;
  email?: string;
  service?: string;
  serviceId?: string;
  roomId?: string;
  roomName?: string;
  siteId: string;
  siteName: string;
  timezone: string;
  source?: string;
  note?: string;
  value?: number;
  /** Medical flags on the client record, surfaced where they are needed. */
  alerts: DayAlert[];
  /** Repeat series, when the visit is one of several. */
  seriesIndex?: number;
  seriesId?: string;
  /**
   * Set when this row is a **seat in a class session** rather than an ordinary
   * appointment. It stays a row — the practitioner wants to know who is coming —
   * but it is not an hour of their day, and nothing that measures time may count
   * it as one.
   */
  sessionId?: string;
};

export type DayGap = {
  startsAt: string;
  endsAt: string;
  /** The whole free stretch, start to end, whether or not all of it is usable. */
  minutes: number;
  local: string;
  endsLocal: string;
  /** Minutes from the moment of asking; negative once the gap has started. */
  inMinutes: number;
  bookable: boolean;
  /**
   * The earliest instant this stretch could actually be booked for: the later of
   * its own start and `now + the practice's notice window`. A stretch that began
   * an hour ago is still bookable for the rest of it, and saying otherwise would
   * throw away real time.
   */
  bookableFrom?: string;
  bookableFromLocal?: string;
  /** How much of the stretch is bookable, once notice is respected. */
  bookableMinutes: number;
  /** Why not, when `bookable` is false. */
  reason?: 'too_soon' | 'too_short' | 'too_far_ahead';
  /**
   * For `too_short`, the minutes missing to fit the shortest service. For
   * `too_soon`, the minutes by which the notice window overruns the stretch.
   */
  shortByMinutes?: number;
  /** Whether the gap is happening right now. */
  now: boolean;
  /** The stretch is over: it is history, not an opportunity. */
  past: boolean;
};

export type DayConflict = {
  kind: 'double_booked' | 'room_clash' | 'outside_hours' | 'no_room';
  appointmentId: string;
  detail: string;
};

export type DayRow = {
  date: string;
  weekday: number;
  siteId: string;
  siteName: string;
  timezone: string;
  /** `rota`, `day off`, `extra hours` — where the hours came from. */
  hoursFrom?: string;
  hours?: { from: string; to: string };
  breaks: { from: string; to: string; label?: string }[];
  /** The rota (or a one-off change) says they work this day. */
  working: boolean;
  nowLocal: string;
  isToday: boolean;
  appointments: DayAppointment[];
  counts: {
    appointments: number;
    confirmed: number;
    pending: number;
    arrived: number;
    completed: number;
    noShows: number;
    cancelled: number;
    /** Still to be seen: pending, confirmed or arrived. */
    remaining: number;
    waitingNow: number;
  };
  next?: DayAppointment;
  nextInMinutes?: number;
  free: {
    /** Free time happening now, if any. */
    now?: DayGap;
    /** The next free stretch that has not started yet. */
    next?: DayGap;
    gaps: DayGap[];
    /** Free time still to come today, in minutes. */
    freeMinutes: number;
    /** Of that, the part that could actually take a booking. */
    bookableMinutes: number;
    /** Free time already gone by, kept so the day reads whole. */
    pastMinutes: number;
  };
  conflicts: DayConflict[];
  /** Minutes of appointment time in this row. */
  bookedMinutes: number;
  /** Sum of `value` where the diary carries one. */
  bookedValue?: number;
  alerts: DayAlert[];
};

export type DayView = {
  /** True when this login resolves to a practitioner record. */
  linked: boolean;
  provider: DayProvider | null;
  /** Present only when `linked` is false: why, and what can be done about it. */
  link: {
    userId?: string;
    userEmail?: string;
    userRole?: string;
    /** Provider records this login may link itself to. */
    candidates: { id: string; name: string; title?: string; email?: string; taken?: boolean }[];
    /** Whether this login may link (owners and admins may link anyone; anybody may link themselves). */
    canLink: boolean;
  } | null;
  /** The practitioner record is linked to a different login. */
  requested?: { providerId?: string; allowed: boolean; reason?: string };
  /** Sites this practitioner works at, for the site switcher. */
  sites: { id: string; name: string; timezone: string }[];
  /** Who is reading: an owner or admin may ask for a colleague's day. */
  viewer: { role?: string; keyed: boolean; canPickPractitioner: boolean };
  /** Every practitioner in the workspace, for the "whose day" picker. */
  practitioners: { id: string; name: string; title?: string; active: boolean; linked: boolean }[];
  rows: DayRow[];
  totals: {
    days: number;
    workingDays: number;
    appointments: number;
    bookedMinutes: number;
    freeMinutes: number;
    bookableFreeMinutes: number;
    waitingNow: number;
    alerts: number;
    conflicts: number;
  };
  week: { date: string; weekday: number; working: boolean; appointments: number; hours?: { from: string; to: string } }[];
  hints: {
    minNoticeMinutes: number;
    maxAdvanceDays: number;
    slotStepMinutes: number;
    weekStart: number;
    /** The shortest active service — a gap smaller than this cannot be booked. */
    shortestServiceMinutes?: number;
    /** Statuses the practitioner may set, in the order they usually happen. */
    transitions: Record<string, string[]>;
  };
  nowIso: string;
};

/* ----------------------------------------------------------------- helpers */

function clockValue(value: string | number, timezone: string) {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone }).format(at);
}

function minutesOfClock(value: string) {
  const [h, m] = String(value).split(':');
  return (Number(h) || 0) * 60 + (Number(m) || 0);
}

function weekdayOf(date: string) {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

function instantOf(date: string, time: string, timezone: string) {
  const [y, m, d] = date.split('-').map(Number);
  return zonedToUtc(y, m, d, Math.floor(minutesOfClock(time) / 60), minutesOfClock(time) % 60, timezone);
}

/* -------------------------------------------------------------------- read */

/**
 * The provider record behind a login. Same rule as `membersFor`: the id link
 * first, then a matching address, because an imported rota may predate the
 * login and only carry the email.
 */
export function providerForUser(orgId: string, userId?: string, email?: string): ProviderDoc | undefined {
  const providers = providersFor(orgId, { includeInactive: true });
  if (userId) {
    const byId = providers.find((p) => p.userId === userId);
    if (byId) return byId;
  }
  const address = (email ?? '').trim().toLowerCase();
  if (address) return providers.find((p) => (p.email ?? '').trim().toLowerCase() === address);
  return undefined;
}

/** Which login, if any, holds this practitioner record. `null` = nobody does. */
export function holderOf(orgId: string, provider: ProviderDoc): { userId: string; email: string; name: string } | null {
  const linked = provider.userId;
  if (!linked) return null;
  const user = list<Doc & { id: string; orgId?: string; name?: string; email?: string }>('users', (u) => u.id === linked)[0];
  return { userId: linked, email: String(user?.email ?? ''), name: String(user?.name ?? 'another login') };
}

function shortlist(orgId: string, userId: string, email: string) {
  // A retired practitioner remains readable as history, but it is not a new
  // identity a login can claim. Reactivate it in Practice setup first; otherwise
  // the unlinked screen offers dead rota records as if they were current staff.
  return providersFor(orgId).map((p) => {
    const held = holderOf(orgId, p);
    return {
      id: p.id,
      name: p.name,
      title: p.title,
      email: p.email,
      /** Held by a different login — not offered as a link target. */
      taken: Boolean(held && held.userId !== userId),
    };
  });
}

/**
 * One practitioner's day, day by day.
 *
 * `opts.providerId` lets an owner or admin look at somebody else's day; the
 * route decides whether the caller is allowed to ask for it, and passes the
 * answer down as `allowed` so the reason a request was refused is visible in the
 * payload rather than only in a status code.
 */
export function dayViewFor(
  orgId: string,
  opts: {
    userId?: string;
    email?: string;
    role?: string;
    auth?: 'session' | 'key' | 'agent' | 'sync';
    providerId?: string;
    date?: string;
    days?: number;
    locationId?: string;
    actor?: string;
    actorName?: string;
    /** Clinical alert text is included only after the route's permission check. */
    includeClinicalAlerts?: boolean;
    now?: number;
  }
): DayView {
  const now = opts.now ?? Date.now();
  const profile = practiceProfile(orgId);
  const at = opts.date && /^\d{4}-\d{2}-\d{2}$/.test(opts.date) ? opts.date : undefined;

  const mine = opts.userId || opts.email ? providerForUser(orgId, opts.userId, opts.email) : undefined;
  const mayPickOther = opts.auth !== 'session' || ['owner', 'admin', 'developer'].includes(String(opts.role));
  const wanted = opts.providerId ? providerById(orgId, opts.providerId) : undefined;

  // Asking for somebody else's day is the owner's privilege, and the answer says
  // so either way rather than silently returning the wrong person's diary.
  const switching = Boolean(wanted && wanted.id !== mine?.id);
  const allowed = opts.auth !== 'session' ? true : switching ? mayPickOther : true;
  const provider = switching ? (allowed ? wanted : mine) : mine;

  const shortestService = servicesFor(orgId)
    .map((s) => Number(s.durationMinutes) || 0)
    .filter((n) => n > 0)
    .sort((a, b) => a - b)[0];

  const hints: DayView['hints'] = {
    minNoticeMinutes: profile.minNoticeMinutes,
    maxAdvanceDays: profile.maxAdvanceDays,
    slotStepMinutes: profile.slotStepMinutes,
    weekStart: profile.weekStart,
    shortestServiceMinutes: shortestService,
    transitions: STATUS_TRANSITIONS as unknown as Record<string, string[]>,
  };

  const allSites = locationsFor(orgId);
  const sitesForProvider: LocationDoc[] = provider
    ? allSites.filter((s) => {
        const listed = (provider.locationIds ?? []) as string[];
        return listed.length === 0 || listed.includes(s.id);
      })
    : allSites;
  const sites = (opts.locationId ? sitesForProvider.filter((s) => s.id === opts.locationId) : sitesForProvider).map((s) => ({
    id: s.id,
    name: s.name,
    timezone: s.timezone,
  }));

  if (!provider) {
    // An honest dead end: no practitioner record for this login. The page shows
    // the candidates and the link action; the API says why the rows are empty.
    return {
      linked: false,
      provider: null,
      link: {
        userId: opts.userId,
        userEmail: opts.email,
        userRole: opts.role,
        candidates: opts.userId ? shortlist(orgId, opts.userId, opts.email ?? '') : [],
        canLink: Boolean(opts.userId) && opts.auth === 'session',
      },
      requested: opts.providerId ? { providerId: opts.providerId, allowed: false, reason: 'not_linked' } : undefined,
      sites,
      viewer: { role: opts.role, keyed: opts.auth !== 'session', canPickPractitioner: opts.auth !== 'session' || mayPickOther },
      practitioners: [],
      rows: [],
      totals: {
        days: 0,
        workingDays: 0,
        appointments: 0,
        bookedMinutes: 0,
        freeMinutes: 0,
        bookableFreeMinutes: 0,
        waitingNow: 0,
        alerts: 0,
        conflicts: 0,
      },
      week: [],
      hints,
      nowIso: new Date(now).toISOString(),
    };
  }

  const days = Math.min(Math.max(Number(opts.days ?? 1) || 1, 1), 7);
  const rooms = roomsFor(orgId);
  const roomName = (id?: string) => rooms.find((r) => r.id === id)?.name;

  const rows: DayRow[] = [];
  const alertSeen = new Set<string>();
  let alertCount = 0;

  for (const site of sites) {
    const siteBookings = bookingsFor(orgId, (b) => b.locationId === site.id);
    const today = at ?? dateStrIn(site.timezone, now);

    for (let d = 0; d < days; d += 1) {
      const date = addDays(today, d);
      const weekday = weekdayOf(date);
      const changes = rotaChangesFor(orgId, { providerId: provider.id, from: date, to: date });
      const change: RotaChangeDoc | undefined = changes[0];
      const rota = rotaFor(orgId, provider.id, site.id);
      const rotaWindows: RotaWindow[] = (rota?.windows ?? []).filter((w) => w.weekday === weekday);

      const off = change?.kind === 'off';
      const windows: { start: string; end: string }[] = off
        ? []
        : change?.kind === 'extra' && change.windows?.length
          ? change.windows.map((w) => ({ start: String(w.start), end: String(w.end) }))
          : rotaWindows.map((w) => ({ start: String(w.start), end: String(w.end) }));
      const hoursFrom = off ? 'day off' : change?.kind === 'extra' && change.windows?.length ? change.reason || 'extra hours' : rota ? 'rota' : 'no rota';
      const breaks = off
        ? []
        : (rota?.breaks ?? [])
            .map((b) => ({ from: String(b.start), to: String(b.end), label: b.label }))
            .filter((b) => b.from && b.to);

      const dayBookings = siteBookings
        .filter((b) => b.providerId === provider.id && dateStrIn(site.timezone, new Date(String(b.startsAt)).getTime()) === date)
        .sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)));

      const appointments: DayAppointment[] = dayBookings.map((booking) => {
        const startsAt = String(booking.startsAt);
        const durationMinutes = Number(booking.durationMinutes ?? 30) || 30;
        const endsAt = new Date(new Date(startsAt).getTime() + durationMinutes * 60_000).toISOString();
        const client = booking.clientId
          ? list<ClientDoc>('clients', (c) => c.id === booking.clientId)[0]
          : undefined;
        const alerts: DayAlert[] = client
          ? patientAlertsFor(orgId, client.id, { includeClinical: Boolean(opts.includeClinicalAlerts) })
              .map((alert) => ({ label: alert.label, detail: alert.detail, severity: alert.severity }))
          : [];
        if (client && alerts.length && !alertSeen.has(client.id)) {
          // A clinical flag was read out to a practitioner: that is a record
          // access, so it is written down like any other.
          alertSeen.add(client.id);
          alertCount += alerts.length;
          recordAccess({
            orgId,
            resource: 'client',
            resourceId: client.id,
            action: 'view',
            actor: opts.actor ?? 'system',
            actorName: opts.actorName,
            detail: `day view · medical flag shown (${alerts.map((a) => a.label).join(', ')})`,
          });
        }
        const canMoveTo = (STATUS_TRANSITIONS as unknown as Record<string, string[]>)[String(booking.status)] ?? [];
        return {
          id: booking.id,
          startsAt,
          local: clockValue(startsAt, site.timezone),
          endsLocal: clockValue(endsAt, site.timezone),
          durationMinutes,
          status: String(booking.status),
          canMoveTo: [...canMoveTo],
          clientId: booking.clientId,
          client: String(booking.customer?.name ?? client?.name ?? 'Client'),
          phone: String(booking.customer?.number ?? client?.number ?? '') || undefined,
          email: String(booking.customer?.email ?? client?.email ?? '') || undefined,
          service: String(booking.service ?? '') || undefined,
          serviceId: booking.serviceId,
          roomId: booking.roomId,
          roomName: roomName(booking.roomId),
          siteId: site.id,
          siteName: site.name,
          timezone: site.timezone,
          source: String(booking.source ?? '') || undefined,
          note: booking.notes,
          value: typeof booking.value === 'number' ? booking.value : undefined,
          alerts,
          seriesId: booking.seriesId,
          seriesIndex: booking.seriesIndex,
          sessionId: booking.sessionId,
        };
      });

      const live = appointments.filter((a) => a.status !== 'cancelled');
      const busyRanges = live
        .filter((a) => a.status !== 'no_show')
        .map((a) => ({
          from: new Date(a.startsAt).getTime(),
          to: new Date(a.startsAt).getTime() + a.durationMinutes * 60_000,
        }));
      for (const b of breaks) {
        const from = instantOf(date, b.from, site.timezone);
        const to = instantOf(date, b.to, site.timezone);
        if (to > from) busyRanges.push({ from, to });
      }

      const freeGaps: DayGap[] = [];
      for (const window of windows) {
        const from = instantOf(date, window.start, site.timezone);
        const to = instantOf(date, window.end, site.timezone);
        if (to <= from) continue;
        // Walk the window, cutting out whatever is already spoken for.
        let cursor = from;
        const taken = busyRanges.filter((r) => r.to > from && r.from < to).sort((a, b) => a.from - b.from);
        for (const range of taken) {
          if (range.from > cursor) freeGaps.push(gapRow(cursor, Math.min(range.from, to), site.timezone, now, profile, shortestService));
          cursor = Math.max(cursor, range.to);
          if (cursor >= to) break;
        }
        if (cursor < to) freeGaps.push(gapRow(cursor, to, site.timezone, now, profile, shortestService));
      }
      const gaps = freeGaps.filter((g) => g.minutes > 0).sort((a, b) => a.startsAt.localeCompare(b.startsAt));

      const conflicts: DayConflict[] = [];
      const sorted = live.slice().sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)));
      for (let i = 0; i < sorted.length - 1; i += 1) {
        const a = sorted[i];
        const b = sorted[i + 1];
        const aEnd = new Date(a.startsAt).getTime() + a.durationMinutes * 60_000;
        if (aEnd > new Date(b.startsAt).getTime()) {
          conflicts.push({
            kind: 'double_booked',
            appointmentId: b.id,
            detail: `${a.local} runs into ${b.local} (${a.client} and ${b.client})`,
          });
        }
      }
      for (const appt of live) {
        if (appt.status === 'completed' || appt.status === 'no_show') continue;
        if (!appt.roomId) {
          conflicts.push({ kind: 'no_room', appointmentId: appt.id, detail: `${appt.local} — ${appt.client} has no room yet` });
          continue;
        }
        // A room cannot hold two people, whoever is running them.
        const at = new Date(appt.startsAt).getTime();
        const end = at + appt.durationMinutes * 60_000;
        const clash = siteBookings.find((other) => {
          if (other.id === appt.id || other.roomId !== appt.roomId) return false;
          if (String(other.status) === 'cancelled' || String(other.status) === 'no_show') return false;
          const otherAt = new Date(String(other.startsAt)).getTime();
          return otherAt < end && at < otherAt + (Number(other.durationMinutes ?? 30) || 30) * 60_000;
        });
        if (clash) {
          conflicts.push({
            kind: 'room_clash',
            appointmentId: appt.id,
            detail: `${appt.local} — ${appt.roomName ?? 'room'} is also booked for ${String(clash.customer?.name ?? 'another client')}`,
          });
        }
      }
      if (windows.length) {
        const open = instantOf(date, windows[0].start, site.timezone);
        const close = instantOf(date, windows[windows.length - 1].end, site.timezone);
        for (const appt of live) {
          const at = new Date(appt.startsAt).getTime();
          if (at < open || at + appt.durationMinutes * 60_000 > close) {
            conflicts.push({
              kind: 'outside_hours',
              appointmentId: appt.id,
              detail: `${appt.local} — ${appt.client} is outside the rota (${windows[0].start}–${windows[windows.length - 1].end})`,
            });
          }
        }
      }

      const nowAt = new Date(now).getTime();
      const upcoming = appointments.find(
        (a) => a.status !== 'cancelled' && a.status !== 'no_show' && new Date(a.startsAt).getTime() >= nowAt
      );
      const waitingNow = appointments.filter((a) => a.status === 'arrived').length;
      /**
       * A class of eight is one hour of the practitioner's day, not eight. Seats
       * are excluded here and counted in `counts.classes`/`counts.seats` instead:
       * this number answers "how much of my day is gone", and a yoga class does
       * not consume four hours of it.
       */
      const bookedMinutes = live.filter((a) => !a.sessionId).reduce((sum, a) => sum + a.durationMinutes, 0);
      const values = appointments.map((a) => a.value).filter((v): v is number => typeof v === 'number');

      rows.push({
        date,
        weekday,
        siteId: site.id,
        siteName: site.name,
        timezone: site.timezone,
        hoursFrom,
        hours: windows.length ? { from: windows[0].start, to: windows[windows.length - 1].end } : undefined,
        breaks,
        working: windows.length > 0,
        nowLocal: clockValue(now, site.timezone),
        isToday: date === dateStrIn(site.timezone, now),
        appointments,
        counts: {
          appointments: appointments.length,
          confirmed: appointments.filter((a) => a.status === 'confirmed').length,
          pending: appointments.filter((a) => a.status === 'pending').length,
          arrived: appointments.filter((a) => a.status === 'arrived').length,
          completed: appointments.filter((a) => a.status === 'completed').length,
          noShows: appointments.filter((a) => a.status === 'no_show').length,
          cancelled: appointments.filter((a) => a.status === 'cancelled').length,
          remaining: appointments.filter((a) => ['pending', 'confirmed', 'arrived'].includes(a.status)).length,
          waitingNow,
        },
        next: upcoming,
        nextInMinutes: upcoming ? Math.round((new Date(upcoming.startsAt).getTime() - nowAt) / 60_000) : undefined,
        free: {
          now: gaps.find((g) => g.now),
          next: gaps.find((g) => new Date(g.startsAt).getTime() > nowAt),
          gaps,
          freeMinutes: gaps.filter((g) => !g.past).reduce((sum, g) => sum + g.minutes, 0),
          bookableMinutes: gaps.reduce((sum, g) => sum + g.bookableMinutes, 0),
          pastMinutes: gaps.filter((g) => g.past).reduce((sum, g) => sum + g.minutes, 0),
        },
        conflicts,
        bookedMinutes,
        bookedValue: values.length ? Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100 : undefined,
        alerts: appointments.flatMap((a) => a.alerts),
      });
    }
  }

  // The week strip: the same seven days the rows cover, in one line each, so the
  // page can show "tomorrow is lighter" without a second request.
  const strip = rows.map((r) => ({
    date: r.date,
    weekday: r.weekday,
    working: r.working,
    appointments: r.counts.appointments,
    hours: r.hours,
  }));

  return {
    linked: true,
    provider: {
      id: provider.id,
      name: provider.name,
      title: provider.title,
      colour: provider.colour,
      email: provider.email,
      userId: provider.userId ?? undefined,
      sites: sites.map((s) => s.id),
    },
    link: null,
    requested: opts.providerId ? { providerId: opts.providerId, allowed: switching ? allowed : true } : undefined,
    sites,
    viewer: { role: opts.role, keyed: opts.auth !== 'session', canPickPractitioner: opts.auth !== 'session' || mayPickOther },
    practitioners: providersFor(orgId, { includeInactive: true }).map((p) => ({
      id: p.id,
      name: p.name,
      title: p.title,
      active: p.active !== false,
      linked: Boolean(p.userId),
    })),
    rows,
    totals: {
      days: rows.length,
      workingDays: rows.filter((r) => r.working).length,
      appointments: rows.reduce((sum, r) => sum + r.counts.appointments, 0),
      bookedMinutes: rows.reduce((sum, r) => sum + r.bookedMinutes, 0),
      freeMinutes: rows.reduce((sum, r) => sum + r.free.freeMinutes, 0),
      bookableFreeMinutes: rows.reduce((sum, r) => sum + r.free.bookableMinutes, 0),
      waitingNow: rows.reduce((sum, r) => sum + r.counts.waitingNow, 0),
      alerts: alertCount,
      conflicts: rows.reduce((sum, r) => sum + r.conflicts.length, 0),
    },
    week: strip,
    hints,
    nowIso: new Date(now).toISOString(),
  };
}

function gapRow(
  from: number,
  to: number,
  timezone: string,
  now: number,
  profile: { minNoticeMinutes: number; maxAdvanceDays: number },
  shortestService?: number
): DayGap {
  const minutes = Math.max(0, Math.round((to - from) / 60_000));
  const inMinutes = Math.round((from - now) / 60_000);
  const noticeFrom = now + profile.minNoticeMinutes * 60_000;
  // Where the bookable part begins: a stretch already under way starts being
  // bookable from now plus notice, not never.
  const bookableFrom = Math.max(from, noticeFrom);
  const bookableMinutes = Math.max(0, Math.round((to - bookableFrom) / 60_000));
  const tooFar = from - now > profile.maxAdvanceDays * 86_400_000;
  const tooSoon = bookableFrom >= to;
  const tooShort = !tooSoon && Boolean(shortestService && bookableMinutes < shortestService);
  const reason: DayGap['reason'] = tooFar ? 'too_far_ahead' : tooSoon ? 'too_soon' : tooShort ? 'too_short' : undefined;
  return {
    startsAt: new Date(from).toISOString(),
    endsAt: new Date(to).toISOString(),
    minutes,
    local: clockValue(from, timezone),
    endsLocal: clockValue(to, timezone),
    inMinutes,
    bookable: !reason,
    bookableFrom: new Date(Math.min(bookableFrom, to)).toISOString(),
    bookableFromLocal: clockValue(Math.min(bookableFrom, to), timezone),
    bookableMinutes: reason ? 0 : bookableMinutes,
    reason,
    shortByMinutes:
      reason === 'too_short' && shortestService
        ? shortestService - bookableMinutes
        : reason === 'too_soon'
          ? Math.max(1, Math.round((noticeFrom - to) / 60_000))
          : undefined,
    now: from <= now && now < to,
    past: to <= now,
  };
}

/* -------------------------------------------------------------------- link */

export type LinkResult =
  | { ok: true; provider: { id: string; name: string }; user: { id: string; name: string; email: string } }
  | { ok: false; error: 'not_found' | 'conflict' | 'forbidden'; message: string };

/**
 * Tie a login to a practitioner record, or untie it with `providerId: null`.
 *
 * Two rules, and both are about not losing track of who is who:
 *
 *   - a practitioner record already held by a *different* login is refused, not
 *     reassigned, because silently moving it would hand one person's diary to
 *     another;
 *   - linking a *different* person's record is an owner/admin action, while
 *     linking your own is something you can do for yourself.
 */
export function linkProviderToUser(
  orgId: string,
  input: {
    providerId: string | null;
    userId: string;
    actor: string;
    actorName?: string;
    /** The login making the request, and what it may do. */
    actorId?: string;
    actorRole?: string;
  }
): LinkResult {
  const target = list<Doc & { id: string; orgId?: string; name?: string; email?: string; role?: string }>('users', (u) => u.id === input.userId)[0];
  if (!target) return { ok: false, error: 'not_found', message: 'No such login in this workspace.' };

  const isSelf = input.actorId === input.userId;
  const mayLinkOthers = ['owner', 'admin', 'developer'].includes(String(input.actorRole));
  if (!isSelf && !mayLinkOthers) {
    return {
      ok: false,
      error: 'forbidden',
      message: 'Only an owner or admin can attach a practitioner record to somebody else. Ask an owner, or link your own.',
    };
  }

  const provider = input.providerId ? providerById(orgId, input.providerId) : undefined;
  if (input.providerId && !provider) return { ok: false, error: 'not_found', message: `No practitioner with id ${input.providerId}.` };
  if (provider?.active === false) {
    return {
      ok: false,
      error: 'conflict',
      message: `${provider.name} is retired. Reactivate that practitioner before linking a login.`,
    };
  }

  if (provider) {
    const held = holderOf(orgId, provider);
    if (held && held.userId !== input.userId) {
      return {
        ok: false,
        error: 'conflict',
        message: `${provider.name} is already linked to ${held.email || held.name}. Unlink that login first.`,
      };
    }
  }

  // One practitioner per login, and one login per practitioner. Whatever *this
  // login* held before is freed — nobody else's link is touched, because moving
  // somebody else's diary is not a side effect of claiming your own.
  const wasHeld = providersFor(orgId, { includeInactive: true }).find((p) => p.userId === input.userId);
  if (wasHeld && wasHeld.id !== provider?.id) {
    update<ProviderDoc>('providers', wasHeld.id, { userId: null });
  }
  if (provider) update<ProviderDoc>('providers', provider.id, { userId: input.userId });

  audit({
    orgId,
    actor: input.actor,
    action: provider ? 'day.provider_linked' : 'day.provider_unlinked',
    target: provider?.id ?? wasHeld?.id ?? input.userId,
    detail: provider
      ? `${provider.name} ↔ ${target.email}`
      : wasHeld
        ? `${target.email} is no longer ${wasHeld.name}`
        : `${target.email} had no practitioner record to unlink`,
    kind: 'account',
  });

  return {
    ok: true,
    provider: { id: provider?.id ?? '', name: provider?.name ?? wasHeld?.name ?? '' },
    user: { id: target.id, name: String(target.name ?? ''), email: String(target.email ?? '') },
  };
}

