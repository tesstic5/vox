/**
 * What happened to the messages we sent, and what happened to the appointments.
 *
 * Two reports, one reason: a practice-manager's questions are "is anybody being
 * told about their appointment?" and "how many people are not turning up, and is
 * it getting better?" — neither of which this build could answer before, because
 * outreach was an event nobody wrote down.
 *
 * The no-show rate is the pair `no_show / (no_show + completed)` over the window.
 * Cancellations are counted and reported separately on purpose: a patient who rang
 * ahead is not a patient who wasted a slot, and a rate that lumps them together is
 * a rate that gets argued with instead of acted on.
 */

import { list } from './db';
import { termsForOrg } from './practice';
import { recordOutreach, outreachFor, outreachStats, type OutreachDoc, type OutreachKind, type OutreachOutcome } from './outreach';
import { bookingContext, messagesFor } from './messages';
import { formatClock } from './availability';
import { locationsFor } from './practice';
import type { BookingDoc } from './bookings';

/* ------------------------------------------------------------ merge samples */

/**
 * A filled-in example for the template editor.
 *
 * Built from a real upcoming appointment when the workspace has one, so the
 * preview reads like the practice's own work rather than a marketing mock; the
 * vocabulary-only version otherwise.
 */
export function sampleMergeContext(orgId: string): Record<string, string> {
  const terms = termsForOrg(orgId);
  const site = locationsFor(orgId)[0];
  const live = list<BookingDoc>('bookings', (b) => {
    if (String(b.orgId) !== orgId) return false;
    return b.status === 'confirmed' || b.status === 'pending' || b.status === 'arrived';
  });
  // A future appointment makes the best sample: the editor should show the words a
  // patient will receive, not the words they received last month. Falls back to the
  // most recent one so a quiet week still previews against real data.
  const upcoming =
    live.filter((b) => new Date(String(b.startsAt)).getTime() > Date.now()).sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)))[0] ??
    live.sort((a, b) => String(b.startsAt).localeCompare(String(a.startsAt)))[0];

  if (upcoming) {
    const client = list<{ id: string; name?: string }>('clients', (c) => c.id === String(upcoming.clientId))[0];
    // The context is built from real data, so a template author sees their own
    // practitioners and sites in the preview, not placeholders.
    return Object.fromEntries(Object.entries(bookingContext(orgId, upcoming, client?.name)).map(([k, v]) => [k, String(v ?? '')]));
  }

  const timezone = site?.timezone ?? 'UTC';
  const sample = new Date(Date.now() + 36 * 3_600_000);
  return {
    client_first_name: 'Amara',
    client_name: 'Amara Osei',
    appointment: terms.appointment.one,
    service: `${terms.service.One} — sample`,
    provider: 'Your team',
    location: site?.name ?? 'Your site',
    when: `${sample.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: timezone })} at ${formatClock(sample.getTime(), timezone)}`,
    when_date: sample.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: timezone }),
    when_time: formatClock(sample.getTime(), timezone),
    reference: 'BK-0000',
    business: 'Your practice',
  };
}

/* ------------------------------------------------------------- outreach view */

export type OutreachSummary = {
  windowDays: number;
  total: number;
  byKind: Record<string, number>;
  byChannel: Record<string, number>;
  byOutcome: Record<string, number>;
  /** Attempts that a human actually received: answered, delivered or acted on. */
  reached: number;
  blocked: number;
  failed: number;
  /** The last dozen touches, newest first — the desk's "what has gone out" list. */
  recent: OutreachDoc[];
};

export function outreachSummary(orgId: string, days = 30): OutreachSummary {
  const from = Date.now() - Math.max(1, days) * 86_400_000;
  const since = new Date(from).toISOString();
  const rows = outreachFor(orgId, { since });
  const stats = outreachStats(orgId, since);
  const count = (key: (row: (typeof rows)[number]) => string) =>
    rows.reduce<Record<string, number>>((acc, row) => {
      const value = key(row);
      acc[value] = (acc[value] ?? 0) + 1;
      return acc;
    }, {});
  return {
    windowDays: days,
    total: rows.length,
    byKind: count((r) => String(r.kind)),
    byChannel: count((r) => String(r.channel)),
    byOutcome: count((r) => String(r.outcome)),
    reached: stats.reached,
    blocked: rows.filter((r) => r.outcome === 'blocked').length,
    failed: rows.filter((r) => r.outcome === 'failed').length,
    recent: rows.slice(0, 12),
  };
}

/* ---------------------------------------------------------------- no-shows */

export type NoShowReport = {
  from: string;
  to: string;
  /** Appointments in the window that could have happened: kept, missed or cancelled. */
  considered: number;
  attended: number;
  noShows: number;
  cancelled: number;
  /** The headline number, as a value and a printable string. */
  noShowRate: number;
  noShowRateLabel: string;
  /** Same rate for the window immediately before, so the trend is visible. */
  previousRate: number | null;
  previousRateLabel: string | null;
  byProvider: { providerId: string; name: string; booked: number; noShows: number; rate: number }[];
  byService: { serviceId: string; name: string; booked: number; noShows: number; rate: number }[];
  byWeekday: { weekday: string; booked: number; noShows: number; rate: number }[];
  outreach: { followUpsSent: number; remindersSent: number; confirmationsSent: number; blocked: number; failed: number };
  /** The appointments behind the count, so a number can always be traced to rows. */
  rows: { id: string; clientName: string; startsAt: string; providerName: string; serviceName: string; reference: string }[];
  /**
   * Appointments that finished and nobody settled.
   *
   * A no-show rate is only as good as the attendance data under it, and the gap
   * between "the appointment happened" and "somebody marked it" is where these
   * numbers quietly go wrong. Listed with a button, so closing it takes two
   * clicks rather than a resolution.
   */
  unsettled: {
    count: number;
    rows: { id: string; clientName: string; startsAt: string; providerName: string; serviceName: string; reference: string; status: string }[];
  };
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * The day of the week *in the practice's timezone*.
 *
 * `new Date(x).getDay()` reads the server's clock, so a Monday 09:00 appointment
 * in Karachi is Sunday 23:00 in a UTC container — and a report that says Sunday is
 * a report nobody trusts.
 */
function weekdayInZone(at: string | Date, timezone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' }).format(new Date(at));
  const index = WEEKDAYS.indexOf(name);
  return index === -1 ? new Date(at).getDay() : index;
}

function rateOf(noShows: number, considered: number) {
  if (!considered) return { value: 0, label: '0%' };
  const value = noShows / considered;
  return { value, label: `${value >= 0.1 ? (value * 100).toFixed(0) : (value * 100).toFixed(1)}%` };
}

/**
 * The no-show rate over a window, with the same figure for the window before it.
 *
 * "12%" is not actionable; "12%, up from 8%" is.
 */
export function noShowReport(orgId: string, options: { days?: number; from?: string; to?: string } = {}): NoShowReport {
  const days = options.days ?? 30;
  const toMs = options.to ? new Date(options.to).getTime() : Date.now();
  const fromMs = options.from ? new Date(options.from).getTime() : toMs - days * 86_400_000;

  const all = list<BookingDoc>('bookings', (b) => String(b.orgId) === orgId);
  const inWindow = (b: BookingDoc, from: number, to: number) => {
    const at = new Date(String(b.startsAt ?? 0)).getTime();
    return at >= from && at <= to;
  };
  /** Appointments in a window that reached a verdict: kept, missed, or cancelled. */
  const settled = (b: BookingDoc) => b.status === 'completed' || b.status === 'no_show' || b.status === 'cancelled';

  const rows = all.filter((b) => inWindow(b, fromMs, toMs) && settled(b));
  const attended = rows.filter((b) => b.status === 'completed').length;
  const noShows = rows.filter((b) => b.status === 'no_show').length;
  const cancelled = rows.filter((b) => b.status === 'cancelled').length;
  const considered = attended + noShows;
  const headline = rateOf(noShows, considered);

  const previousTo = fromMs;
  const previousFrom = previousTo - (toMs - fromMs);
  const previousRows = all.filter((b) => inWindow(b, previousFrom, previousTo) && settled(b));
  const previous = rateOf(
    previousRows.filter((b) => b.status === 'no_show').length,
    previousRows.filter((b) => b.status === 'completed').length + previousRows.filter((b) => b.status === 'no_show').length
  );

  const group = (keyOf: (b: BookingDoc) => string | undefined) => {
    const map = new Map<string, { booked: number; noShows: number }>();
    for (const booking of rows) {
      const key = keyOf(booking) ?? 'unassigned';
      const entry = map.get(key) ?? { booked: 0, noShows: 0 };
      if (booking.status === 'completed' || booking.status === 'no_show') entry.booked += 1;
      if (booking.status === 'no_show') entry.noShows += 1;
      map.set(key, entry);
    }
    return map;
  };

  const providerNames = new Map(
    list<{ id: string; name?: string; orgId?: string }>('providers', (p) => String(p.orgId) === orgId).map((p) => [p.id, String(p.name ?? 'Unknown')])
  );
  const serviceNames = new Map(
    list<{ id: string; name?: string; orgId?: string }>('services', (s) => String(s.orgId) === orgId).map((s) => [s.id, String(s.name ?? 'Unknown')])
  );

  const byProvider = [...group((b) => (b.providerId ? String(b.providerId) : undefined))]
    .map(([providerId, counts]) => ({
      providerId,
      name: providerNames.get(providerId) ?? 'Unassigned',
      booked: counts.booked,
      noShows: counts.noShows,
      rate: rateOf(counts.noShows, counts.booked).value,
    }))
    .sort((a, b) => b.noShows - a.noShows || b.booked - a.booked);

  const byService = [...group((b) => (b.serviceId ? String(b.serviceId) : undefined))]
    .map(([serviceId, counts]) => ({
      serviceId,
      name: serviceNames.get(serviceId) ?? 'Unassigned',
      booked: counts.booked,
      noShows: counts.noShows,
      rate: rateOf(counts.noShows, counts.booked).value,
    }))
    .sort((a, b) => b.noShows - a.noShows || b.booked - a.booked);

  const timezone = locationsFor(orgId)[0]?.timezone ?? 'UTC';
  void timezone;
  const weekdayCounts = new Map<string, { booked: number; noShows: number }>();
  for (const booking of rows) {
    if (booking.status === 'cancelled') continue;
    const weekday = WEEKDAYS[weekdayInZone(booking.startsAt, timezone)];
    const entry = weekdayCounts.get(weekday) ?? { booked: 0, noShows: 0 };
    entry.booked += 1;
    if (booking.status === 'no_show') entry.noShows += 1;
    weekdayCounts.set(weekday, entry);
  }
  const byWeekday = [...weekdayCounts]
    .map(([weekday, counts]) => ({ weekday, booked: counts.booked, noShows: counts.noShows, rate: rateOf(counts.noShows, counts.booked).value }))
    .sort((a, b) => WEEKDAYS.indexOf(a.weekday) - WEEKDAYS.indexOf(b.weekday));

  const kindCount = (kind: OutreachKind, outcome?: OutreachOutcome) =>
    list<OutreachDoc>('outreach', (r) => {
      if (String(r.orgId) !== orgId) return false;
      const at = new Date(String(r.at)).getTime();
      if (at < fromMs || at > toMs) return false;
      if (r.kind !== kind) return false;
      return outcome ? r.outcome === outcome : true;
    }).length;

  const followUps = messagesFor(orgId, (m) => {
    const at = new Date(String(m.sentAt ?? 0)).getTime();
    return at >= fromMs && at <= toMs && m.kind === 'no_show' && m.status === 'sent';
  }).length;

  const clientNames = new Map(
    list<{ id: string; name?: string; orgId?: string }>('clients', (c) => String(c.orgId) === orgId).map((c) => [c.id, String(c.name ?? 'Unknown')])
  );

  // Anything that started more than four hours ago and is still open: long enough
  // that the appointment is over, recent enough that somebody remembers it.
  const unsettled = all
    .filter((b) => {
      const at = new Date(String(b.startsAt ?? 0)).getTime();
      if (at > toMs - 4 * 3_600_000) return false;
      return b.status === 'pending' || b.status === 'confirmed' || b.status === 'arrived';
    })
    .sort((a, b) => String(b.startsAt).localeCompare(String(a.startsAt)))
    .slice(0, 25);

  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    considered,
    attended,
    noShows,
    cancelled,
    noShowRate: headline.value,
    noShowRateLabel: headline.label,
    previousRate: previousRows.length ? previous.value : null,
    previousRateLabel: previousRows.length ? previous.label : null,
    byProvider,
    byService,
    byWeekday,
    outreach: {
      followUpsSent: followUps,
      remindersSent: kindCount('reminder', 'sent'),
      confirmationsSent: kindCount('confirmation', 'sent'),
      blocked: list<OutreachDoc>('outreach', (r) => {
        if (String(r.orgId) !== orgId) return false;
        const at = new Date(String(r.at)).getTime();
        return at >= fromMs && at <= toMs && r.outcome === 'blocked';
      }).length,
      failed: list<OutreachDoc>('outreach', (r) => {
        if (String(r.orgId) !== orgId) return false;
        const at = new Date(String(r.at)).getTime();
        return at >= fromMs && at <= toMs && r.outcome === 'failed';
      }).length,
    },
    rows: rows
      .sort((a, b) => String(b.startsAt).localeCompare(String(a.startsAt)))
      .slice(0, 50)
      .map((b) => ({
        id: b.id,
        clientName: clientNames.get(String(b.clientId)) ?? b.customer.name,
        startsAt: String(b.startsAt),
        providerName: b.providerId ? providerNames.get(String(b.providerId)) ?? 'Unassigned' : 'Unassigned',
        serviceName: b.serviceId ? serviceNames.get(String(b.serviceId)) ?? '' : String(b.service ?? ''),
        reference: String(b.externalId ?? ''),
      })),
    unsettled: {
      count: unsettled.length,
      rows: unsettled.map((b) => ({
        id: b.id,
        clientName: clientNames.get(String(b.clientId)) ?? b.customer.name,
        startsAt: String(b.startsAt),
        providerName: b.providerId ? providerNames.get(String(b.providerId)) ?? 'Unassigned' : 'Unassigned',
        serviceName: b.serviceId ? serviceNames.get(String(b.serviceId)) ?? '' : String(b.service ?? ''),
        reference: String(b.externalId ?? ''),
        status: String(b.status),
      })),
    },
  };
}

/**
 * Records that a member of staff reached somebody by phone.
 *
 * The one outreach row this build writes from outside the message queue: a
 * receptionist ringing a patient is outreach too, and a no-show report that cannot
 * see phone calls blames the reminders for what a phone call fixed.
 */
export function recordManualTouch(input: {
  orgId: string;
  clientId?: string;
  bookingId?: string;
  channel: 'sms' | 'email' | 'call';
  kind: OutreachKind;
  outcome: OutreachOutcome;
  to?: string;
  note?: string;
  actor: string;
  actorName?: string;
}) {
  return recordOutreach({
    orgId: input.orgId,
    clientId: input.clientId,
    bookingId: input.bookingId,
    channel: input.channel,
    kind: input.kind,
    outcome: input.outcome,
    to: input.to ?? '',
    actor: input.actor,
    actorName: input.actorName,
    detail: input.note,
    meta: { manual: 'true' },
  });
}
