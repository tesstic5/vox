/**
 * Practice reports.
 *
 * The P7 gate is one sentence an owner should be able to answer from one screen:
 * *who earns what, what does it cost us, who does not turn up.* Three of those are
 * only answerable from rows that already exist — P6's ledger, P1's rota, P2's
 * statuses, P3's booking source, P4's outreach, the call records — so this module
 * is mostly composition: it reads the same collections the rest of the product
 * writes and never invents a number the source rows cannot produce.
 *
 * Three rules hold everywhere in here:
 *
 *  1. **One window, stated once.** Every figure in a report covers the same
 *     from/to, resolved in the practice's own timezone (a day is the practice's
 *     day, not UTC's). A report whose halves cover different periods is a
 *     spreadsheet argument, not a report.
 *  2. **Percentages come with their denominator.** A no-show rate is useless
 *     without the number of appointments it was computed over, so every rate is
 *     returned beside its counts.
 *  3. **Money is minor units, and cost is money too.** Expenses arrive in minor
 *     units from P6; call spend arrives in dollars from the metering. They are
 *     converted once, here, so a margin on this screen is the same arithmetic as
 *     a balance on the money screen.
 */

import { list, listAllByOrg, nowIso, type Doc } from './db';
import { addDays, breaksForDate, dateStrIn, weekdayOf, windowsForDate, zoneParts } from './availability';
import { clockToMinutes, locationsFor, practiceProfile, providersFor, recallIntervalDays, rotaFor, rotaChangesFor, servicesFor } from './practice';
import { bookingsFor, type BookingDoc } from './bookings';
import { clientsFor, type ClientDoc } from './clients';
import { type CallDoc } from './calls';
import { balanceMinorOf, expensesFor, formatMoney, invoicesFor, moneySettingsFor, paymentsFor, splitExact, toMinor, type ExpenseDoc } from './money';
import { contactFor, messagesFor } from './messages';
import { lastSeenFor } from './recalls';
import { outreachRules } from './outreach-rules';
import { noShowReport } from './outreach-report';

/* ------------------------------------------------------------------ ranges */

export type ReportRange = {
  /** Local calendar dates at the practice, `YYYY-MM-DD`. Inclusive. */
  from: string;
  to: string;
  label: string;
  days: number;
  timezone: string;
};

const PRESETS: Record<string, { days?: number; label: string; month?: 'this' | 'last'; year?: boolean }> = {
  '30d': { days: 30, label: 'Last 30 days' },
  '90d': { days: 90, label: 'Last 90 days' },
  '6m': { days: 182, label: 'Last 6 months' },
  '12m': { days: 365, label: 'Last 12 months' },
  month: { label: 'This month', month: 'this' },
  'last-month': { label: 'Last month', month: 'last' },
  year: { label: 'This year', year: true },
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Resolves the window a report covers.
 *
 * Two sources and a rule: an explicit `from`/`to` always wins (an accountant
 * asking for a tax quarter must get exactly that), otherwise a preset, otherwise
 * 90 days. Dates are the practice's own — a booking at 22:00 in New York belongs
 * to that New York day, not to tomorrow in UTC.
 */
export function rangeFrom(input: { preset?: string | null; from?: string | null; to?: string | null; days?: number; timezone?: string } = {}): ReportRange {
  const timezone = input.timezone ?? 'UTC';
  const today = dateStrIn(timezone);
  const parts = zoneParts(Date.now(), timezone);
  const monthStart = `${parts.y}-${String(parts.m).padStart(2, '0')}-01`;

  let from: string;
  let to = today;
  let label: string;

  if (input.from && ISO_DATE.test(input.from)) {
    from = input.from;
    to = input.to && ISO_DATE.test(input.to) ? input.to : today;
    label = `${from} → ${to}`;
  } else {
    const preset = PRESETS[input.preset ?? (input.days ? 'custom' : '90d')] ?? PRESETS['90d'];
    if (input.days && !PRESETS[input.preset ?? '']) {
      from = addDays(today, -(Math.max(1, Math.floor(input.days)) - 1));
      label = `Last ${Math.floor(input.days)} days`;
    } else if (preset.month === 'this') {
      from = monthStart;
      label = preset.label;
    } else if (preset.month === 'last') {
      const previousMonthEnd = addDays(monthStart, -1);
      from = `${previousMonthEnd.slice(0, 7)}-01`;
      to = previousMonthEnd;
      label = preset.label;
    } else if (preset.year) {
      from = `${parts.y}-01-01`;
      label = preset.label;
    } else {
      from = addDays(today, -((preset.days ?? 90) - 1));
      label = preset.label;
    }
  }

  const days = Math.max(1, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1);
  return { from, to, label, days, timezone };
}

/** Every local date in the window, oldest first — the axis capacity is summed over. */
function datesIn(range: ReportRange): string[] {
  const out: string[] = [];
  for (let d = range.from; d <= range.to && out.length < 800; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The instant a local date turns over, so a booking can be placed in a day. */
function instantOf(dateStr: string, timezone: string) {
  return Date.parse(`${dateStr}T00:00:00Z`);
}

/** Is this appointment inside the window, judged on the practice's calendar? */
function inRange(booking: BookingDoc, range: ReportRange): boolean {
  const at = Date.parse(String(booking.startsAt ?? ''));
  if (Number.isNaN(at)) return false;
  const day = dateStrIn(range.timezone, at);
  return day >= range.from && day <= range.to;
}

const minutesBetween = (start: string, end: string) => Math.max(0, (clockToMinutes(end) ?? 0) - (clockToMinutes(start) ?? 0));

/* ---------------------------------------------------------------- revenue */

export type RevenueRow = {
  id: string;
  name: string;
  appointments: number;
  attended: number;
  invoicedMinor: number;
  collectedMinor: number;
  outstandingMinor: number;
  averageMinor: number;
};

/**
 * Who earns what, per practitioner and per service.
 *
 * Practitioners come from P6's own attribution (the provider on the invoice
 * line — the person who did the work). Services are grouped by the service on
 * the invoice line, which is why a line carries `serviceId`: a report that
 * guessed a service from the appointment would double-count a visit billed on
 * two lines.
 */
export function revenueReport(orgId: string, range: ReportRange) {
  const settings = moneySettingsFor(orgId);
  const invoices = invoicesFor(orgId, { from: range.from, to: range.to, includeDrafts: false, includeVoid: false }).filter((i) => i.kind === 'invoice');
  const credits = invoicesFor(orgId, { from: range.from, to: range.to, includeDrafts: false, includeVoid: false }).filter((i) => i.kind === 'credit');
  const bookings = bookingsFor(orgId, (b) => inRange(b, range));

  const providerNames = new Map(providersFor(orgId, { includeInactive: true }).map((p) => [p.id, String(p.name)]));
  const serviceNames = new Map(servicesFor(orgId, { includeInactive: true }).map((s) => [s.id, String(s.name)]));

  const blank = (id: string, name: string): RevenueRow => ({
    id,
    name,
    appointments: 0,
    attended: 0,
    invoicedMinor: 0,
    collectedMinor: 0,
    outstandingMinor: 0,
    averageMinor: 0,
  });

  const byProvider = new Map<string, RevenueRow>();
  const byService = new Map<string, RevenueRow>();

  /**
   * Two counts per provider and per service: what was *booked* in the window and
   * what actually *attended*.
   *
   * `appointments` was declared and shown as a column but never filled, so every
   * row read "0 appointments" beside real money — a screen that contradicts
   * itself. Booked uses the same definition as the utilisation report (a slot
   * still held: pending, confirmed, arrived, completed or missed), so the two
   * tabs cannot disagree about how many visits a person had.
   */
  const holds = new Set(['pending', 'confirmed', 'arrived', 'completed', 'no_show']);
  const bump = (key: string, map: Map<string, RevenueRow>, name: string, field: 'appointments' | 'attended') => {
    const row = map.get(key) ?? blank(key, name);
    row[field] += 1;
    map.set(key, row);
  };
  for (const booking of bookings) {
    if (holds.has(String(booking.status))) {
      if (booking.providerId) bump(String(booking.providerId), byProvider, providerNames.get(String(booking.providerId)) ?? 'Unassigned', 'appointments');
      if (booking.serviceId) bump(String(booking.serviceId), byService, serviceNames.get(String(booking.serviceId)) ?? 'Unassigned', 'appointments');
    }
    if (booking.status === 'completed') {
      if (booking.providerId) bump(String(booking.providerId), byProvider, providerNames.get(String(booking.providerId)) ?? 'Unassigned', 'attended');
      if (booking.serviceId) bump(String(booking.serviceId), byService, serviceNames.get(String(booking.serviceId)) ?? 'Unassigned', 'attended');
    }
  }

  for (const invoice of invoices) {
    // Allocation of an invoice to a provider or service is per line; that is what
    // the line's own fields are for. A line with neither lands under Unassigned
    // rather than being spread across the practice.
    for (const line of invoice.lines) {
      const gross = Number(line.grossMinor ?? 0);
      const providerId = line.providerId ? String(line.providerId) : '';
      const serviceId = line.serviceId ? String(line.serviceId) : '';
      const providerRow = byProvider.get(providerId || 'unassigned') ?? blank(providerId || 'unassigned', providerId ? providerNames.get(providerId) ?? 'Unknown' : 'Unassigned');
      const serviceRow = byService.get(serviceId || 'unassigned') ?? blank(serviceId || 'unassigned', serviceId ? serviceNames.get(serviceId) ?? 'Unknown' : 'Unassigned');
      byProvider.set(providerRow.id, { ...providerRow, invoicedMinor: providerRow.invoicedMinor + gross });
      byService.set(serviceRow.id, { ...serviceRow, invoicedMinor: serviceRow.invoicedMinor + gross });
    }
  }
  for (const invoice of invoices) {
    // Money is split across the invoice's own lines by weight, with the
    // largest-remainder rule the invoice engine uses — so the shares add back up
    // to the cent instead of drifting a cent per line, and a practitioner row can
    // never claim more of a payment than the invoice took.
    const weights = invoice.lines.map((l) => Number(l.grossMinor ?? 0));
    const totalGross = weights.reduce((sum, w) => sum + w, 0);
    const add = (lineIndex: number, field: 'collectedMinor' | 'outstandingMinor', amountMinor: number) => {
      const line = invoice.lines[lineIndex];
      const providerId = line.providerId ? String(line.providerId) : 'unassigned';
      const serviceId = line.serviceId ? String(line.serviceId) : 'unassigned';
      const p = byProvider.get(providerId) ?? blank(providerId, providerId === 'unassigned' ? 'Unassigned' : providerNames.get(providerId) ?? 'Unknown');
      const sv = byService.get(serviceId) ?? blank(serviceId, serviceId === 'unassigned' ? 'Unassigned' : serviceNames.get(serviceId) ?? 'Unknown');
      byProvider.set(providerId, { ...p, [field]: p[field] + amountMinor });
      byService.set(serviceId, { ...sv, [field]: sv[field] + amountMinor });
    };

    if (!totalGross) {
      // An invoice with nothing on it cannot be attributed to anyone; it still
      // counts as billed against the practice as a whole.
      continue;
    }

    for (const payment of paymentsFor(orgId, { invoiceId: invoice.id })) {
      if (payment.status !== 'settled') continue;
      const sign = payment.direction === 'in' ? 1 : -1;
      const applied = payment.allocations.filter((a) => a.invoiceId === invoice.id).reduce((sum, a) => sum + a.amountMinor, 0) * sign;
      if (!applied) continue;
      splitExact(applied, weights).forEach((part, index) => {
        if (part) add(index, 'collectedMinor', part);
      });
    }

    const open = balanceMinorOf(invoice);
    if (open > 0) {
      splitExact(open, weights).forEach((part, index) => {
        if (part) add(index, 'outstandingMinor', part);
      });
    }
  }

  const finishRows = (map: Map<string, RevenueRow>) =>
    [...map.values()]
      .map((row) => ({ ...row, averageMinor: row.attended ? Math.round(row.invoicedMinor / row.attended) : 0 }))
      .sort((a, b) => b.invoicedMinor - a.invoicedMinor || a.name.localeCompare(b.name));

  const creditTotal = credits.reduce((sum, i) => sum + Math.abs(Number(i.totalMinor ?? 0)), 0);
  const billed = invoices.reduce((sum, i) => sum + Number(i.totalMinor ?? 0), 0);
  const paid = paymentsFor(orgId, { from: range.from, to: range.to })
    .filter((p) => p.status === 'settled')
    .reduce((sum, p) => sum + (p.direction === 'in' ? p.amountMinor : -p.amountMinor), 0);
  const outstanding = Math.max(0, billed - paid - creditTotal);

  /**
   * Rows have to add back up to the figures the practice is reading.
   *
   * They did not, once: a payment taken in the window that no invoice *of* the
   * window can explain — money on account, a bill settled before the window
   * opened, a refund out of an older one — was counted in the total and placed on
   * no row, so the columns silently disagreed with each other by exactly that
   * amount. The remainder goes under Unassigned, which is the truth: this window
   * cannot attribute it to a practitioner or a service.
   */
  const placeRemainder = (map: Map<string, RevenueRow>) => {
    const rows = [...map.values()];
    const collectedDrift = paid - rows.reduce((sum, r) => sum + r.collectedMinor, 0);
    const owedDrift = outstanding - rows.reduce((sum, r) => sum + r.outstandingMinor, 0);
    if (!collectedDrift && !owedDrift) return { collectedDrift, owedDrift };
    const row = map.get('unassigned') ?? blank('unassigned', 'Unassigned');
    map.set('unassigned', { ...row, collectedMinor: row.collectedMinor + collectedDrift, outstandingMinor: row.outstandingMinor + owedDrift });
    return { collectedDrift, owedDrift };
  };
  const drift = placeRemainder(byProvider);
  placeRemainder(byService);

  return {
    range,
    currency: settings.currency,
    billedMinor: billed,
    collectedMinor: paid,
    creditMinor: creditTotal,
    outstandingMinor: outstanding,
    /** Collected money this window cannot place on one of its own invoices. */
    unattributedMinor: drift.collectedDrift,
    collectionRatePct: billed ? Math.round((paid / billed) * 1000) / 10 : 0,
    invoices: invoices.length,
    byProvider: finishRows(byProvider),
    byService: finishRows(byService),
    /** Per-day billing, for the trend on the screen and the spreadsheet. */
    byDay: datesIn(range).map((date) => ({
      date,
      invoicedMinor: invoices.filter((i) => String(i.issueDate ?? i.createdAt ?? '').slice(0, 10) === date).reduce((sum, i) => sum + Number(i.totalMinor ?? 0), 0),
    })),
  };
}

/* ------------------------------------------------------------ utilisation */

export type UtilisationRow = {
  providerId: string;
  name: string;
  capacityMinutes: number;
  bookedMinutes: number;
  attendedMinutes: number;
  cancelledMinutes: number;
  utilisationPct: number;
  attendedPct: number;
  appointments: number;
  /** Days with rota but not a single appointment — the shape of a wasted week. */
  emptyDays: number;
};

/**
 * How much of the diary the practice actually used.
 *
 * Capacity is the rota after one-off changes: a day marked `off` contributes
 * nothing, an `extra` day contributes its own hours, and breaks are subtracted
 * only on days that run to the normal rota (a Saturday clinic does not inherit
 * Tuesday's lunch). Booked is every appointment that still holds the slot —
 * a cancellation gives the time back, and is reported separately so a practice
 * can tell "we were quiet" from "people cancelled on us".
 */
export function utilisationReport(orgId: string, range: ReportRange) {
  const providers = providersFor(orgId, { includeInactive: true }).filter((p) => p.active !== false);
  const locations = locationsFor(orgId, { includeInactive: true });
  const bookings = bookingsFor(orgId, (b) => inRange(b, range));
  const holds = new Set(['pending', 'confirmed', 'arrived', 'completed', 'no_show']);

  /**
   * Classes, so a seat is not mistaken for an appointment.
   *
   * Bookings that carry a `sessionId` are seats: eight of them share one hour of
   * one practitioner's diary. Counting each as a full appointment would let a
   * single class push utilisation past 100%, which is exactly the kind of number
   * that makes a report worthless. The rule here is the same one the diary uses —
   * **the session is the hour, the seats are people in it** — so every figure
   * below counts a session once, from the session's own length, and only while it
   * still holds a seat or is still scheduled.
   */
  const sessions = new Map(
    list<Doc & { id: string; serviceId?: string; providerId?: string; startsAt?: string; durationMinutes?: number; status?: string }>(
      'classSessions',
      (s) => s.orgId === orgId
    ).map((s) => [String(s.id), s])
  );
  /** Minutes a practitioner really spent holding these rows. */
  const heldMinutes = (rows: BookingDoc[]) => {
    let minutes = 0;
    const counted = new Set<string>();
    for (const row of rows) {
      const sessionId = (row as { sessionId?: string }).sessionId;
      if (!sessionId) {
        minutes += Number(row.durationMinutes ?? 0);
        continue;
      }
      if (counted.has(sessionId)) continue;
      counted.add(sessionId);
      const session = sessions.get(sessionId);
      // A session that has been cancelled frees its hour, so it contributes
      // nothing; the seats are cancelled with it and would say the same.
      if (session && session.status === 'cancelled') continue;
      minutes += Number(session?.durationMinutes ?? row.durationMinutes ?? 0);
    }
    return minutes;
  };

  const rows: UtilisationRow[] = [];
  for (const provider of providers) {
    let capacityMinutes = 0;
    let emptyDays = 0;
    const perDay = new Map<string, number>();

    for (const date of datesIn(range)) {
      let dayCapacity = 0;
      for (const location of locations) {
        const windows = windowsForDate(orgId, provider.id, location.id, date);
        if (!windows.length) continue;
        const change = rotaChangesFor(orgId, { providerId: provider.id, from: date, to: date })[0];
        // Breaks belong to the rota they were written into; an `extra` day runs the
        // hours it was given, not Tuesday's lunch break.
        const breaks = change?.kind === 'extra' ? [] : rotaFor(orgId, provider.id, location.id)?.breaks ?? [];
        const breakMinutes = breaks.reduce((sum, b) => sum + minutesBetween(b.start, b.end), 0);
        dayCapacity += windows.reduce((sum, w) => sum + minutesBetween(w.start, w.end), 0) - breakMinutes;
      }
      dayCapacity = Math.max(0, dayCapacity);
      capacityMinutes += dayCapacity;
      perDay.set(date, dayCapacity);
    }

    const mine = bookings.filter((b) => String(b.providerId ?? '') === provider.id);
    const mineHeld = mine.filter((b) => holds.has(String(b.status)));
    const bookedMinutes = heldMinutes(mineHeld);
    const attendedMinutes = heldMinutes(mine.filter((b) => b.status === 'completed'));
    // A cancelled *seat* does not give the hour back — the class still runs.
    const cancelledMinutes = heldMinutes(
      mine.filter((b) => b.status === 'cancelled').filter((b) => {
        const sessionId = (b as { sessionId?: string }).sessionId;
        return !sessionId || sessions.get(sessionId)?.status === 'cancelled';
      })
    );

    const busyDays = new Set(mineHeld.map((b) => dateStrIn(range.timezone, Date.parse(String(b.startsAt)))));
    for (const [date, capacity] of perDay) if (capacity > 0 && !busyDays.has(date)) emptyDays += 1;

    rows.push({
      providerId: provider.id,
      name: String(provider.name),
      capacityMinutes,
      bookedMinutes,
      attendedMinutes,
      cancelledMinutes,
      utilisationPct: capacityMinutes ? Math.round((bookedMinutes / capacityMinutes) * 1000) / 10 : 0,
      attendedPct: capacityMinutes ? Math.round((attendedMinutes / capacityMinutes) * 1000) / 10 : 0,
      // People in the diary, not slots: a class of eight is eight people who
      // turned up for one appointment in the day's shape.
      appointments: mineHeld.length,
      emptyDays,
    });
  }

  const capacityMinutes = rows.reduce((sum, r) => sum + r.capacityMinutes, 0);
  const bookedMinutes = rows.reduce((sum, r) => sum + r.bookedMinutes, 0);
  const attendedMinutes = rows.reduce((sum, r) => sum + r.attendedMinutes, 0);
  const hours = (minutes: number) => Math.round((minutes / 60) * 10) / 10;

  return {
    range,
    capacityMinutes,
    bookedMinutes,
    attendedMinutes,
    cancelledMinutes: rows.reduce((sum, r) => sum + r.cancelledMinutes, 0),
    utilisationPct: capacityMinutes ? Math.round((bookedMinutes / capacityMinutes) * 1000) / 10 : 0,
    attendedPct: capacityMinutes ? Math.round((attendedMinutes / capacityMinutes) * 1000) / 10 : 0,
    capacityHours: hours(capacityMinutes),
    bookedHours: hours(bookedMinutes),
    attendedHours: hours(attendedMinutes),
    rows: rows.sort((a, b) => b.capacityMinutes - a.capacityMinutes || a.name.localeCompare(b.name)),
  };
}

/* ------------------------------------------------------------- attendance */

/**
 * Who does not turn up.
 *
 * P4's `noShowReport` already answers this and is reused rather than re-derived —
 * two no-show rates computed two ways is exactly the kind of disagreement a
 * practice stops trusting. What P7 adds is *when* it happens: by weekday and by
 * hour, which is the part a practice can act on (move the Monday 8am, over-book
 * the Friday 5pm).
 */
export function attendanceReport(orgId: string, range: ReportRange) {
  const base = noShowReport(orgId, { from: range.from, to: range.to });
  const bookings = bookingsFor(orgId, (b) => inRange(b, range));
  const settled = bookings.filter((b) => ['completed', 'no_show', 'cancelled'].includes(String(b.status)));
  const considered = settled.filter((b) => b.status !== 'cancelled');

  const group = (keyOf: (b: BookingDoc) => string | undefined) => {
    const map = new Map<string, { key: string; attended: number; noShows: number; cancelled: number }>();
    for (const booking of settled) {
      const key = keyOf(booking) ?? 'unknown';
      const row = map.get(key) ?? { key, attended: 0, noShows: 0, cancelled: 0 };
      if (booking.status === 'completed') row.attended += 1;
      if (booking.status === 'no_show') row.noShows += 1;
      if (booking.status === 'cancelled') row.cancelled += 1;
      map.set(key, row);
    }
    return [...map.values()]
      .map((row) => ({ ...row, rate: row.attended + row.noShows ? Math.round((row.noShows / (row.attended + row.noShows)) * 1000) / 10 : 0 }))
      .sort((a, b) => b.noShows - a.noShows || b.attended - a.attended);
  };

  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const byWeekday = group((b) => WEEKDAYS[weekdayOf(dateStrIn(range.timezone, Date.parse(String(b.startsAt))))] ?? 'Unknown');
  const byHour = group((b) => {
    const parts = zoneParts(Date.parse(String(b.startsAt)), range.timezone);
    return `${String(parts.hh).padStart(2, '0')}:00`;
  }).sort((a, b) => a.key.localeCompare(b.key));

  const attended = considered.filter((b) => b.status === 'completed').length;
  const noShows = considered.filter((b) => b.status === 'no_show').length;
  const cancelled = settled.filter((b) => b.status === 'cancelled').length;

  return {
    range,
    attended,
    noShows,
    cancelled,
    considered,
    noShowRatePct: considered.length ? Math.round((noShows / considered.length) * 1000) / 10 : 0,
    cancellationRatePct: settled.length ? Math.round((cancelled / settled.length) * 1000) / 10 : 0,
    previousRatePct: base.previousRate,
    byProvider: base.byProvider.map((r) => ({ ...r, attended: Math.max(0, r.booked - r.noShows) })),
    byService: base.byService.map((r) => ({ ...r, attended: Math.max(0, r.booked - r.noShows) })),
    byWeekday,
    byHour,
  };
}

/* ------------------------------------------------------------------ costs */

export type CostRow = { key: string; label: string; amountMinor: number };

/**
 * What it costs us.
 *
 * Two halves that a practice actually pays: what it buys (P6's expenses, by
 * category) and what the phones cost (the call records' own metered spend —
 * platform, speech, language, voice, carrier). They are added once, in minor
 * units, and presented beside what came in so the margin is a subtraction
 * somebody can check.
 */
export function costsReport(orgId: string, range: ReportRange) {
  const settings = moneySettingsFor(orgId);
  const expenses = expensesFor(orgId, { from: range.from, to: range.to });
  const calls = listAllByOrg<CallDoc>('calls', orgId).filter((c) => {
    const day = dateStrIn(range.timezone, Date.parse(String(c.startedAt ?? '')));
    return day >= range.from && day <= range.to;
  });

  const byCategory = new Map<string, number>();
  for (const expense of expenses) {
    const key = String(expense.category ?? 'other');
    byCategory.set(key, (byCategory.get(key) ?? 0) + Number(expense.amountMinor ?? 0));
  }

  // Accumulated in minor units, one call at a time: a call's cost is what the
  // workspace was actually billed, so the itemisation has to add up to the same
  // total rather than to a total rounded from the sum.
  const spend = { platform: 0, stt: 0, tts: 0, llm: 0, telephony: 0 };
  let callSpendMinor = 0;
  let callSpendTotalMinor = 0;
  for (const call of calls) {
    const cost = (call.cost ?? {}) as Record<string, number>;
    for (const key of Object.keys(spend) as (keyof typeof spend)[]) {
      const minor = toMinor(Number(cost[key] ?? 0), settings.currency);
      spend[key] += minor;
      callSpendMinor += minor;
    }
    callSpendTotalMinor += toMinor(Number(cost.total ?? 0), settings.currency);
  }
  // The metered total is the number of record, and the parts are reconciled to it
  // with the same largest-remainder rule the ledger uses — so the breakdown a
  // practice reads is the bill it pays, to the cent.
  if (callSpendTotalMinor && callSpendMinor !== callSpendTotalMinor) {
    const keys = Object.keys(spend) as (keyof typeof spend)[];
    const fixed = splitExact(callSpendTotalMinor, keys.map((k) => spend[k]));
    keys.forEach((k, i) => {
      spend[k] = fixed[i];
    });
    callSpendMinor = fixed.reduce((sum, n) => sum + n, 0);
  }
  const expenseMinor = expenses.reduce((sum, e: ExpenseDoc) => sum + Number(e.amountMinor ?? 0), 0);
  const revenue = revenueReport(orgId, range);
  const totalMinor = expenseMinor + callSpendMinor;

  return {
    range,
    currency: settings.currency,
    expensesMinor: expenseMinor,
    callSpendMinor,
    totalMinor,
    costPerCallMinor: calls.length ? Math.round(callSpendMinor / calls.length) : 0,
    costPerBookingMinor: revenue.invoices ? Math.round(totalMinor / Math.max(1, revenue.byProvider.reduce((sum, r) => sum + r.attended, 0))) : 0,
    expenses: expenses.length,
    calls: calls.length,
    callMinutes: Math.round(calls.reduce((sum, c) => sum + Number(c.durationSeconds ?? 0), 0) / 60),
    byCategory: [...byCategory.entries()]
      .map(([key, amountMinor]) => ({ key, label: key.replace(/_/g, ' '), amountMinor }))
      .sort((a, b) => b.amountMinor - a.amountMinor),
    /** The bill, line by line, so "voice" is not a mystery number. */
    callSpendBreakdown: (Object.keys(spend) as (keyof typeof spend)[]).map((key) => ({
      key,
      label: { platform: 'Platform', stt: 'Transcription', tts: 'Voice', llm: 'Language model', telephony: 'Carrier minutes' }[key],
      amountMinor: spend[key],
      amount: spend[key] / 100,
    })),
    collectedMinor: revenue.collectedMinor,
    marginMinor: revenue.collectedMinor - totalMinor,
    netMinor: revenue.billedMinor - totalMinor,
  };
}

/* ------------------------------------------------------------ attribution */

/**
 * Where the work comes from, and what the assistant answered.
 *
 * The three sources a practice can actually compare are its own dashboard, its
 * online page and the phone. `call` is the interesting one for this product: it
 * is the share of the diary the AI receptionist produced, so the assistant's
 * value is a number rather than a claim.
 */
export function attributionReport(orgId: string, range: ReportRange) {
  const bookings = bookingsFor(orgId, (b) => inRange(b, range));
  const settings = moneySettingsFor(orgId);
  const invoices = invoicesFor(orgId, { from: range.from, to: range.to, includeDrafts: false, includeVoid: false }).filter((i) => i.kind === 'invoice');
  const revenueByBooking = new Map<string, number>();
  for (const invoice of invoices) {
    for (const bookingId of invoice.bookingIds ?? []) {
      revenueByBooking.set(String(bookingId), (revenueByBooking.get(String(bookingId)) ?? 0) + Number(invoice.totalMinor ?? 0));
    }
  }

  const rows = new Map<string, { key: string; label: string; bookings: number; attended: number; noShows: number; cancelled: number; billedMinor: number }>();
  const LABELS: Record<string, string> = {
    online: 'Online booking page',
    call: 'Phone / assistant',
    dashboard: 'Front desk',
    client_api: 'Your other system',
    seed: 'Imported',
  };
  for (const booking of bookings) {
    const key = String(booking.source ?? 'unknown');
    const row = rows.get(key) ?? { key, label: LABELS[key] ?? key.replace(/_/g, ' '), bookings: 0, attended: 0, noShows: 0, cancelled: 0, billedMinor: 0 };
    row.bookings += 1;
    if (booking.status === 'completed') row.attended += 1;
    if (booking.status === 'no_show') row.noShows += 1;
    if (booking.status === 'cancelled') row.cancelled += 1;
    row.billedMinor += revenueByBooking.get(String(booking.id)) ?? 0;
    rows.set(key, row);
  }

  // Calls, and what became of them. A call that reached a booking is counted
  // from the booking's own `callIds`, so a call cannot claim credit twice.
  const calls = listAllByOrg<CallDoc>('calls', orgId).filter((c) => {
    const day = dateStrIn(range.timezone, Date.parse(String(c.startedAt ?? '')));
    return day >= range.from && day <= range.to;
  });
  const bookingCalls = new Set(bookings.flatMap((b) => (b.callIds ?? []).map(String)));
  const transferred = (call: CallDoc) =>
    /transfer/i.test(String(call.endedReason ?? '')) || (call.toolCalls ?? []).some((t) => /transfer/i.test(String(t.name)));
  const handled = calls.filter((c) => c.status === 'ended' && !transferred(c));
  const failed = calls.filter((c) => c.status === 'failed');

  return {
    range,
    currency: settings.currency,
    bookings: bookings.length,
    bySource: [...rows.values()].sort((a, b) => b.bookings - a.bookings),
    calls: {
      total: calls.length,
      handled: handled.length,
      transferred: calls.filter(transferred).length,
      failed: failed.length,
      inProgress: calls.filter((c) => c.status === 'in-progress' || c.status === 'queued').length,
      producedBooking: calls.filter((c) => bookingCalls.has(String(c.id))).length,
      minutes: Math.round(calls.reduce((sum, c) => sum + Number(c.durationSeconds ?? 0), 0) / 60),
      answerRatePct: calls.length ? Math.round((handled.length / calls.length) * 1000) / 10 : 0,
    },
    /** Bookings that arrived by phone, as a share of everything booked. */
    assistantSharePct: bookings.length
      ? Math.round(((rows.get('call')?.bookings ?? 0) / bookings.length) * 1000) / 10
      : 0,
  };
}

/* ---------------------------------------------------------------- recalls */

export type RecallRow = {
  clientId: string;
  name: string;
  number: string;
  lastSeenAt?: string;
  lastSeenDays?: number;
  overdueDays: number;
  visits: number;
  consentSms: boolean;
  consentEmail: boolean;
  /** Consent on file for a text or an email — not the same as reachable. */
  withConsent: boolean;
  /** What the sender would do with them: a channel, switched on, allowed. */
  reachable: boolean;
  /** Why not, when they cannot be reached. Absent means the sender would send. */
  blockedReason?: string;
  /** The window *this* client is judged by — theirs, not the practice's. */
  intervalDays: number;
  /** Where that number came from, so the desk can see why somebody is on the list. */
  intervalSource: 'service' | 'practice' | 'rule';
  /** The service their last visit was for, if the diary still knows it. */
  serviceId?: string;
  serviceName?: string;
  /** When a recall last went to them, and when they may be recalled again. */
  lastRecallAt?: string;
  recallDueAt?: string;
  /** Already on the queue — waiting for the next delivery tick. */
  queued: boolean;
};

/**
 * Who has not been seen in a while.
 *
 * The interval is the practice's own (`recallDays`, six months by default) and
 * the arithmetic is deliberately plain: days since the last completed visit,
 * minus the interval, is how overdue they are. A client with no visits at all is
 * not "overdue" — they were never in, and chasing them is a marketing question,
 * not a recall — so they are excluded rather than reported as infinitely late.
 */
export function recallReport(orgId: string, range: ReportRange, opts: { intervalDays?: number; limit?: number } = {}) {
  const profile = practiceProfile(orgId);
  const practiceWindow = Math.max(1, Math.floor(opts.intervalDays ?? profile.recallDays));
  const cutoff = Date.parse(`${range.to}T23:59:59Z`);
  const rows: RecallRow[] = [];
  const serviceNames = new Map(servicesFor(orgId, { includeInactive: true }).map((s) => [s.id, String(s.name)]));
  // The channels the recall rule uses, so every row can carry the *sender's* own
  // verdict on it rather than a guess made here. A client with no consent record
  // is not refused — `consentFor` treats nothing recorded as nothing refused — so
  // a screen that calls them blocked is a screen that disagrees with the texts it
  // sends from the same button.
  const recallRule = outreachRules(orgId).recall;
  const recallChannels = recallRule.channels;

  for (const client of clientsFor(orgId, { includeArchived: false })) {
    // The date a window is measured from is "the last visit that happened", not
    // "the last appointment on the books" — see `lastSeenFor`. The list and the
    // sender share it, so a screen and a text can never disagree.
    const lastSeenAt = lastSeenFor(orgId, client as ClientDoc);
    if (!lastSeenAt) continue;
    const at = Date.parse(String(lastSeenAt));
    if (Number.isNaN(at)) continue;
    const days = Math.floor((cutoff - at) / 86_400_000);

    // Whose window is this? The service they were last seen for, unless the desk
    // asked for one number for everybody (`?recallDays=`).
    const lastBooking = latestCompletedBooking(orgId, client.id);
    const serviceId = lastBooking?.serviceId ? String(lastBooking.serviceId) : undefined;
    const interval = opts.intervalDays ? { days: practiceWindow, source: 'practice' as const } : recallIntervalDays(orgId, serviceId, recallRule.afterDays);
    if (days <= interval.days) continue;

    const recall = lastRecallFor(orgId, client.id);
    const queued = recall?.pending ?? false;
    const contact = contactFor(orgId, { clientId: client.id, number: client.number, email: client.email }, recallChannels);
    const blockedReason = contact?.blockedReason;
    rows.push({
      clientId: client.id,
      name: client.name,
      number: client.number,
      lastSeenAt: String(lastSeenAt),
      lastSeenDays: days,
      overdueDays: days - interval.days,
      visits: Number(client.appointmentCount ?? 0),
      consentSms: client.consents?.sms?.granted === true,
      consentEmail: client.consents?.email?.granted === true,
      /** Consent on file for at least one channel — not the same as reachable. */
      withConsent: client.consents?.sms?.granted === true || client.consents?.email?.granted === true,
      /** The sender's verdict: a channel exists, is switched on, and allows it. */
      reachable: Boolean(contact && !blockedReason),
      blockedReason,
      intervalDays: interval.days,
      intervalSource: interval.source,
      serviceId,
      serviceName: serviceId ? serviceNames.get(serviceId) : undefined,
      lastRecallAt: recall?.at,
      recallDueAt: recall?.dueAt,
      queued,
    });
  }

  rows.sort((a, b) => b.overdueDays - a.overdueDays);
  const withConsent = rows.filter((r) => r.withConsent).length;
  const blocked = rows.filter((r) => !r.reachable).length;
  const services = servicesFor(orgId, { includeInactive: false }).map((s) => ({
    id: s.id,
    name: String(s.name),
    // `null` reads as "the practice's own window" rather than as zero, which is
    // the difference between "nobody thought about this service" and "this
    // service can never be recalled".
    recallDays: s.recallDays && s.recallDays > 0 ? Math.round(s.recallDays) : null,
  }));
  return {
    range,
    /** The practice's own window — what a service with no interval of its own uses. */
    intervalDays: practiceWindow,
    services,
    due: rows.length,
    /** Consent on file for a text or an email. */
    reachable: withConsent,
    /** No consent on file — which is not a refusal. */
    optedOut: rows.length - withConsent,
    /** What the sender would actually refuse, and why, per row. */
    blocked,
    rows: rows.slice(0, Math.max(1, Math.min(500, opts.limit ?? 200))),
  };
}

/** The client's most recent completed visit — what decides their recall window. */
function latestCompletedBooking(orgId: string, clientId: string): BookingDoc | undefined {
  return bookingsFor(orgId, (b) => b.clientId === clientId && b.status === 'completed').sort((a, b) =>
    String(b.startsAt).localeCompare(String(a.startsAt))
  )[0];
}

/**
 * When this client was last recalled, and whether one is on the queue.
 *
 * A recall is a marketing message, so the practice deserves to see that it has
 * already been sent rather than sending it twice — and a client who was recalled
 * last week should not be at the top of today's list.
 */
function lastRecallFor(orgId: string, clientId: string): { at: string; dueAt?: string; pending: boolean } | undefined {
  const rows = messagesFor(orgId, (m) => m.clientId === clientId && m.kind === 'recall' && m.status !== 'cancelled').sort((a, b) =>
    String(b.createdAt).localeCompare(String(a.createdAt))
  );
  if (!rows.length) return undefined;
  const newest = rows[0];
  return {
    at: String(newest.sentAt ?? newest.createdAt),
    dueAt: newest.status === 'pending' ? String(newest.sendAt) : undefined,
    pending: newest.status === 'pending',
  };
}

/* --------------------------------------------------------------- overview */

/** The one screen: every headline, and the parts it was assembled from. */
export function reportsOverview(orgId: string, range: ReportRange, opts: { include?: string; intervalDays?: number; limit?: number } = {}) {
  const revenue = revenueReport(orgId, range);
  const utilisation = utilisationReport(orgId, range);
  const attendance = attendanceReport(orgId, range);
  const costs = costsReport(orgId, range);
  const attribution = attributionReport(orgId, range);
  // The recall window and page size travel with the overview too: the screen that
  // offers "measure everybody by this window" reads this route, and a knob that
  // only works on the per-view call is a knob that does nothing where it is shown.
  const recalls = recallReport(orgId, range, { intervalDays: opts.intervalDays, limit: opts.limit });

  const want = (key: string) => !opts.include || opts.include.split(',').map((s) => s.trim()).includes(key);
  return {
    range,
    currency: revenue.currency,
    generatedAt: nowIso(),
    earned: {
      billedMinor: revenue.billedMinor,
      collectedMinor: revenue.collectedMinor,
      outstandingMinor: revenue.outstandingMinor,
      collectionRatePct: revenue.collectionRatePct,
      invoices: revenue.invoices,
      topProvider: revenue.byProvider[0] ? { name: revenue.byProvider[0].name, invoicedMinor: revenue.byProvider[0].invoicedMinor } : null,
      topService: revenue.byService[0] ? { name: revenue.byService[0].name, invoicedMinor: revenue.byService[0].invoicedMinor, visits: revenue.byService[0].attended } : null,
    },
    costs: {
      totalMinor: costs.totalMinor,
      practiceMinor: costs.expensesMinor,
      callsMinor: costs.callSpendMinor,
      marginMinor: costs.marginMinor,
      netMinor: costs.netMinor,
      callMinutes: costs.callMinutes,
    },
    attendance: {
      attended: attendance.attended,
      noShows: attendance.noShows,
      cancelled: attendance.cancelled,
      noShowRatePct: attendance.noShowRatePct,
      previousRatePct: attendance.previousRatePct,
      worstWeekday: attendance.byWeekday.filter((r) => r.noShows > 0)[0] ?? null,
    },
    diary: {
      capacityHours: utilisation.capacityHours,
      bookedHours: utilisation.bookedHours,
      attendedHours: utilisation.attendedHours,
      utilisationPct: utilisation.utilisationPct,
      attendedPct: utilisation.attendedPct,
      emptyDays: utilisation.rows.reduce((sum, r) => sum + r.emptyDays, 0),
    },
    acquisition: {
      bookings: attribution.bookings,
      bySource: attribution.bySource,
      assistantSharePct: attribution.assistantSharePct,
      calls: attribution.calls,
    },
    recalls: { due: recalls.due, reachable: recalls.reachable, intervalDays: recalls.intervalDays },
    // The screens behind the headlines, so the page fetches once and tabs are
    // instant — and so an API caller gets the same numbers the page shows.
    sections: {
      revenue: want('revenue') ? revenue : undefined,
      utilisation: want('utilisation') ? utilisation : undefined,
      attendance: want('attendance') ? attendance : undefined,
      costs: want('costs') ? costs : undefined,
      attribution: want('attribution') ? attribution : undefined,
      recalls: want('recalls') ? recalls : undefined,
    },
  };
}

/* ----------------------------------------------------------------- export */

/** RFC-4180 quoting: a comma in a service name must not become a column. */
function cell(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers: string[], rows: (string | number | boolean | undefined)[][]): string {
  return [headers, ...rows].map((row) => row.map(cell).join(',')).join('\n');
}

export type ReportKind = 'revenue' | 'utilisation' | 'attendance' | 'costs' | 'attribution' | 'recalls';

/**
 * A spreadsheet of whichever report was asked for.
 *
 * Amounts are exported as decimals (`123.45`), because that is what a
 * spreadsheet expects — the integer minor units are the product's own currency
 * and the reason the arithmetic is exact, not a format to hand a bookkeeper.
 */
export function exportReport(orgId: string, range: ReportRange, kind: ReportKind): { filename: string; csv: string; rows: number } {
  const stamp = `${range.from}_${range.to}`;
  if (kind === 'utilisation') {
    const report = utilisationReport(orgId, range);
    return {
      filename: `utilisation_${stamp}.csv`,
      rows: report.rows.length,
      csv: toCsv(
        ['Practitioner', 'CapacityHours', 'BookedHours', 'AttendedHours', 'UtilisationPct', 'AttendedPct', 'Appointments', 'EmptyDays'],
        report.rows.map((r) => [
          r.name,
          (r.capacityMinutes / 60).toFixed(2),
          (r.bookedMinutes / 60).toFixed(2),
          (r.attendedMinutes / 60).toFixed(2),
          r.utilisationPct,
          r.attendedPct,
          r.appointments,
          r.emptyDays,
        ])
      ),
    };
  }
  if (kind === 'attendance') {
    const report = attendanceReport(orgId, range);
    return {
      filename: `attendance_${stamp}.csv`,
      rows: report.byProvider.length,
      csv: toCsv(
        ['Practitioner', 'Attended', 'NoShows', 'NoShowRatePct'],
        report.byProvider.map((r) => [r.name, r.attended ?? 0, r.noShows, r.rate])
      ),
    };
  }
  if (kind === 'costs') {
    const report = costsReport(orgId, range);
    const settings = moneySettingsFor(orgId);
    const money = (minor: number) => (minor / 10 ** (settings.currency === 'JPY' ? 0 : 2)).toFixed(settings.currency === 'JPY' ? 0 : 2);
    return {
      filename: `costs_${stamp}.csv`,
      rows: report.byCategory.length + report.callSpendBreakdown.length,
      csv: toCsv(
        ['Kind', 'Category', 'Amount'],
        [
          ...report.byCategory.map((r) => ['expense', r.label, money(r.amountMinor)]),
          ...report.callSpendBreakdown.map((r) => ['call spend', String(r.label), money(r.amountMinor)]),
          ['total', '', money(report.totalMinor)],
        ]
      ),
    };
  }
  if (kind === 'attribution') {
    const report = attributionReport(orgId, range);
    return {
      filename: `attribution_${stamp}.csv`,
      rows: report.bySource.length,
      csv: toCsv(
        ['Source', 'Bookings', 'Attended', 'NoShows', 'Cancelled', 'Billed'],
        report.bySource.map((r) => [r.label, r.bookings, r.attended, r.noShows, r.cancelled, formatMoney(r.billedMinor, report.currency)])
      ),
    };
  }
  if (kind === 'recalls') {
    const report = recallReport(orgId, range);
    return {
      filename: `recalls_${stamp}.csv`,
      rows: report.rows.length,
      csv: toCsv(
        ['Client', 'Number', 'LastSeen', 'DaysSince', 'DaysOverdue', 'Visits', 'Sms', 'Email', 'Sendable', 'BlockedBecause'],
        report.rows.map((r) => [
          r.name,
          r.number,
          r.lastSeenAt ?? '',
          r.lastSeenDays ?? '',
          r.overdueDays,
          r.visits,
          r.consentSms,
          r.consentEmail,
          r.reachable,
          r.blockedReason ?? '',
        ])
      ),
    };
  }
  const report = revenueReport(orgId, range);
  return {
    filename: `revenue_${stamp}.csv`,
    rows: report.byProvider.length + report.byService.length,
    csv: toCsv(
      ['Group', 'Name', 'Visits', 'Invoiced', 'Collected', 'Outstanding', 'AveragePerVisit'],
      [
        ...report.byProvider.map((r) => ['practitioner', r.name, r.attended, report.currency === 'JPY' ? r.invoicedMinor : (r.invoicedMinor / 100).toFixed(2), report.currency === 'JPY' ? r.collectedMinor : (r.collectedMinor / 100).toFixed(2), report.currency === 'JPY' ? r.outstandingMinor : (r.outstandingMinor / 100).toFixed(2), report.currency === 'JPY' ? r.averageMinor : (r.averageMinor / 100).toFixed(2)]),
        ...report.byService.map((r) => ['service', r.name, r.attended, report.currency === 'JPY' ? r.invoicedMinor : (r.invoicedMinor / 100).toFixed(2), report.currency === 'JPY' ? r.collectedMinor : (r.collectedMinor / 100).toFixed(2), report.currency === 'JPY' ? r.outstandingMinor : (r.outstandingMinor / 100).toFixed(2), report.currency === 'JPY' ? r.averageMinor : (r.averageMinor / 100).toFixed(2)]),
      ]
    ),
  };
}
