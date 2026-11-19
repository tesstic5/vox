/**
 * The practice's numbers, on the phone.
 *
 * Until now the assistant could act — book, move, cancel, read one client's
 * balance — but it could not *report*. "How did last month go?" was answered on
 * the Reports screen and nowhere else, which meant the person most likely to ask
 * it (the owner, driving between sites) had to be at a desk.
 *
 * Three rules shape everything here, and they are the same three the Reports
 * screen lives by:
 *
 *   1. **The figures come from the same functions the screen calls.** A number
 *      spoken on a call and a number rendered on the screen are computed once,
 *      by `reports.ts`. If they ever disagree, that is a bug in one place, not a
 *      difference of opinion between two.
 *   2. **Aggregates, never records.** No client name, no client's balance, no
 *      clinical anything crosses this boundary — not even to the owner. A phone
 *      call can be overheard in a waiting room; the screen is where names belong.
 *   3. **Identity decides scope.** A stranger who rings the practice line does
 *      not get the practice's takings. A member of the team does. Money requires
 *      an owner or an admin. Which is which is decided by the caller's own
 *      number (matched against the team's numbers on file) or, for a call placed
 *      from the dashboard, by the signed-in person's role.
 *
 * Every read and every refusal is audited, so "who looked at the practice's
 * money, and when" has an answer that is not "nobody knows".
 */

import { audit } from './audit';
import { addDays, dateStrIn } from './availability';
import type { BookingToolContext } from './booking-tools';
import { list, type Doc } from './db';
import { formatMoney, moneySettingsFor } from './money';
import {
  attendanceReport,
  attributionReport,
  rangeFrom,
  recallReport,
  revenueReport,
  utilisationReport,
  type ReportRange,
} from './reports';
import type { ToolCall } from './agent';

/** The tool name the assistant is granted. One tool, two arguments. */
export const REPORT_TOOLS = new Set(['practice_report']);

export type ReportTopic = 'revenue' | 'appointments' | 'attendance' | 'utilisation' | 'sources' | 'recalls' | 'calls';

export type ReportPeriod =
  | 'today'
  | 'yesterday'
  | 'this-week'
  | 'last-week'
  | 'this-month'
  | 'last-month'
  | 'last-30-days'
  | 'last-90-days'
  | 'this-year';

export const REPORT_TOPICS: ReportTopic[] = ['revenue', 'appointments', 'attendance', 'utilisation', 'sources', 'recalls', 'calls'];
export const REPORT_PERIODS: ReportPeriod[] = ['today', 'yesterday', 'this-week', 'last-week', 'this-month', 'last-month', 'last-30-days', 'last-90-days', 'this-year'];

/* ------------------------------------------------------------------ identity */

export type ReportIdentity = {
  /** `team` = somebody with a login; `practitioner` = a clinician's own number. */
  kind: 'team' | 'practitioner';
  name: string;
  role?: string;
  /** How we know them: the number they rang from, or the dashboard they are in. */
  via: 'number' | 'dashboard';
};

/** Last ten digits, so `+1 415 555 0142` and `+14155550142` are the same person. */
export function numberKey(value?: string): string {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

type UserRow = Doc & { orgId?: string; name?: string; email?: string; role?: string; phone?: string; active?: boolean };
type ProviderRow = Doc & { orgId?: string; name?: string; phone?: string; active?: boolean };

/**
 * Who is asking?
 *
 * A dashboard call knows exactly who opened it, so the signed-in person's role
 * is the answer and no matching is needed. A phone call has only a number, and a
 * number is a weaker claim — which is why money is not reachable by number alone
 * unless the number is on a login that already has the right role.
 */
export function reportIdentity(
  orgId: string,
  input: { callerNumber?: string; viewer?: { name?: string; email?: string; role?: string } }
): ReportIdentity | undefined {
  if (input.viewer?.role) {
    return { kind: 'team', name: String(input.viewer.name ?? input.viewer.email ?? 'a signed-in user'), role: String(input.viewer.role), via: 'dashboard' };
  }

  const key = numberKey(input.callerNumber);
  if (key.length < 7) return undefined;

  const users = list<UserRow>('users', (u) => u.orgId === orgId && u.active !== false && Boolean(u.phone));
  const user = users.find((u) => numberKey(u.phone) === key);
  if (user) return { kind: 'team', name: String(user.name ?? user.email ?? 'a team member'), role: String(user.role ?? 'viewer'), via: 'number' };

  // A clinician who is not a login still counts as staff for the diary numbers —
  // they are the ones ringing to ask how full tomorrow is.
  const providers = list<ProviderRow>('providers', (p) => p.orgId === orgId && p.active !== false && Boolean(p.phone));
  const provider = providers.find((p) => numberKey(p.phone) === key);
  if (provider) return { kind: 'practitioner', name: String(provider.name ?? 'a practitioner'), via: 'number' };

  return undefined;
}

/** Money is owner/admin business: the takings, the collection rate, who earned what. */
export function maySeeMoney(identity: ReportIdentity | undefined): boolean {
  return identity?.kind === 'team' && (identity.role === 'owner' || identity.role === 'admin');
}

/* --------------------------------------------------------------------- asking */

const TOPIC_RULES: { topic: ReportTopic; patterns: RegExp[] }[] = [
  {
    topic: 'revenue',
    patterns: [
      /\brevenue\b/i,
      /\btakings?\b/i,
      /\bbilled\b/i,
      /\bbilling\b/i,
      /\bcollected\b/i,
      /\bincome\b/i,
      /\bearn/i,
      /\bmoney\b/i,
      // "How did we do?" means the takings: it is the first thing an owner asks
      // and the only reading of the sentence that has a number in it.
      /\bhow (?:did|are|was|were) we (?:do|doing|go|going)\b/i,
      /\bhow much (?:did|have) we\b/i,
      /\b(?:what|how much) (?:did|have) we (?:bill|billed|take|taken|collect|collected|make|made|earn|earned)\b/i,
    ],
  },
  { topic: 'attendance', patterns: [/\bno-?shows?\b/i, /\bdid not (?:turn up|attend|show)\b/i, /\bmissed\b/i, /\bcancell?ations?\b/i, /\battendance\b/i, /\bturn(?:ed)? up\b/i] },
  { topic: 'utilisation', patterns: [/\butilis|\butiliz/i, /\bhow busy\b/i, /\bcapacity\b/i, /\bhow full\b/i, /\bslack\b/i, /\bempty (?:slots|days)\b/i] },
  {
    topic: 'sources',
    patterns: [
      /\bsources?\b/i,
      /\battribution\b/i,
      /\bmarketing\b/i,
      /\bwhere\b.{0,24}\bbookings?\b/i,
      /\bhow (?:do|did) (?:people|clients?|patients?) (?:find|hear|book)\b/i,
    ],
  },
  { topic: 'recalls', patterns: [/\brecalls?\b/i, /\bdue (?:back|for a)\b/i, /\boverdue\b/i, /\bnot been in\b/i, /\bchase\b/i] },
  {
    topic: 'calls',
    patterns: [
      /\bcalls?\b/i,
      /\bhandled\b/i,
      /\banswered\b/i,
      /\btransferred?\b/i,
      /\bthe phone\b/i,
      /\bhow many (?:did|were) (?:we )?(?:answer|call)/i,
    ],
  },
  { topic: 'appointments', patterns: [/\bappointments?\b/i, /\bvisits?\b/i, /\bdiary\b/i, /\bbooked\b/i, /\bhow many (?:people|clients|patients)\b/i] },
];

const PERIOD_RULES: { period: ReportPeriod; patterns: RegExp[] }[] = [
  { period: 'today', patterns: [/\btoday\b/i, /\bso far today\b/i] },
  { period: 'yesterday', patterns: [/\byesterday\b/i] },
  { period: 'last-week', patterns: [/\blast week\b/i] },
  { period: 'this-week', patterns: [/\bthis week\b/i, /\bweek so far\b/i] },
  { period: 'last-month', patterns: [/\blast month\b/i] },
  { period: 'this-month', patterns: [/\bthis month\b/i, /\bmonth so far\b/i, /\bmonth to date\b/i] },
  { period: 'last-90-days', patterns: [/\b(?:last|past) (?:90|ninety) days\b/i, /\bquarter\b/i, /\b3 months\b/i] },
  { period: 'this-year', patterns: [/\bthis year\b/i, /\byear to date\b/i, /\bso far this year\b/i] },
  { period: 'last-30-days', patterns: [/\b(?:last|past) (?:30|thirty) days\b/i, /\bmonth of\b/i] },
];

/**
 * What is being asked, from the words themselves.
 *
 * Deliberately keyword-based rather than clever: a caller says "how many did we
 * see last month" or "what's our no-show rate", and the honest answer is served
 * by naming the topic and the window. An unknown question defaults to the month
 * so far, which is the window a practice actually asks about.
 */
export function reportAsk(text: string): { topic: ReportTopic; period: ReportPeriod } {
  const topic = TOPIC_RULES.find((rule) => rule.patterns.some((p) => p.test(text)))?.topic ?? 'appointments';
  const period = PERIOD_RULES.find((rule) => rule.patterns.some((p) => p.test(text)))?.period ?? 'this-month';
  return { topic, period };
}

/* --------------------------------------------------------------------- ranges */

/** The window each spoken phrase means, resolved on the practice's own calendar. */
export function rangeForPeriod(orgId: string, period: string, timezone: string): ReportRange {
  const today = dateStrIn(timezone);
  switch (period) {
    case 'today':
      return rangeFrom({ from: today, to: today, timezone });
    case 'yesterday':
      return rangeFrom({ from: addDays(today, -1), to: addDays(today, -1), timezone });
    case 'this-week': {
      // Monday is the first day of the working week in every term pack we ship.
      const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
      const monday = addDays(today, -((weekday + 6) % 7));
      return rangeFrom({ from: monday, to: today, timezone });
    }
    case 'last-week': {
      const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
      const monday = addDays(today, -((weekday + 6) % 7) - 7);
      return rangeFrom({ from: monday, to: addDays(monday, 6), timezone });
    }
    case 'last-month':
      return rangeFrom({ preset: 'last-month', timezone });
    case 'this-year':
      return rangeFrom({ preset: 'year', timezone });
    case 'last-90-days':
      return rangeFrom({ preset: '90d', timezone });
    case 'this-month':
      return rangeFrom({ preset: 'month', timezone });
    default:
      return rangeFrom({ preset: '30d', timezone });
  }
}

/* -------------------------------------------------------------------- answers */

const TOPIC_NAMES: Record<ReportTopic, string> = {
  revenue: 'money',
  appointments: 'appointments',
  attendance: 'attendance',
  utilisation: 'how busy we were',
  sources: 'where bookings came from',
  recalls: 'recalls',
  calls: 'the phone',
};

function money(minor: number, currency: string): string {
  return formatMoney(minor, currency);
}

/** A sentence somebody can say out loud, built from the figures below it. */
function speak(topic: ReportTopic, range: ReportRange, figures: Record<string, unknown>): string {
  const when = range.label.toLowerCase();
  switch (topic) {
    case 'revenue': {
      const currency = String(figures.currency ?? 'USD');
      const billed = money(Number(figures.billedMinor ?? 0), currency);
      const collected = money(Number(figures.collectedMinor ?? 0), currency);
      const outstanding = money(Number(figures.outstandingMinor ?? 0), currency);
      const rows = (figures.top ?? []) as { name: string; invoicedMinor: number }[];
      const lead = rows[0] ? ` ${rows[0].name} accounts for the most at ${money(rows[0].invoicedMinor, currency)}.` : '';
      return `${range.label}: the practice billed ${billed} across ${figures.invoices ?? 0} invoices and collected ${collected}, leaving ${outstanding} outstanding.${lead}`;
    }
    case 'attendance': {
      const considered = Number(figures.considered ?? 0);
      return `${range.label}: ${figures.attended ?? 0} visits were seen and ${figures.noShows ?? 0} people did not turn up — a no-show rate of ${figures.noShowRatePct ?? 0}% of the ${considered} kept or missed. ${figures.cancelled ?? 0} more cancelled ahead of time.`;
    }
    case 'utilisation':
      return `${range.label}: the diary ran at ${figures.utilisationPct ?? 0}% of the hours the team was open — ${figures.bookedHours ?? 0} of ${figures.capacityHours ?? 0} hours booked, with ${figures.attendedHours ?? 0} actually seen.`;
    case 'sources': {
      const rows = (figures.bySource ?? []) as { label: string; bookings: number }[];
      const top = rows.slice(0, 3).map((r) => `${r.label} ${r.bookings}`).join(', ');
      return `${range.label}: ${figures.bookings ?? 0} appointments were booked, and the assistant took ${figures.assistantSharePct ?? 0}% of them. By source: ${top || 'nothing booked'}.`;
    }
    case 'recalls':
      // "Have consent" is an explicit yes; "nothing recorded" is not a refusal, and
      // what the sender would actually turn away is its own number.
      return `${range.label}: ${figures.due ?? 0} clients are past the ${figures.intervalDays ?? 180}-day recall. ${figures.reachable ?? 0} have consent on file and ${figures.optedOut ?? 0} have nothing recorded — only ${figures.blocked ?? 0} cannot be reached at all.`;
    case 'calls': {
      const c = (figures.calls ?? {}) as { total?: number; handled?: number; transferred?: number; failed?: number; minutes?: number; producedBooking?: number };
      return `${range.label}: ${c.total ?? 0} calls, of which the assistant handled ${c.handled ?? 0} end to end, ${c.transferred ?? 0} went to a person and ${c.failed ?? 0} failed. Those calls produced ${c.producedBooking ?? 0} appointments, ${c.minutes ?? 0} minutes on the line.`;
    }
    default: {
      const rows = (figures.byProvider ?? []) as { name: string; appointments: number; attended: number }[];
      const top = rows.slice(0, 3).map((r) => `${r.name} ${r.appointments}`).join(', ');
      return `${range.label}: ${figures.appointments ?? 0} appointments on the books and ${figures.attended ?? 0} seen. By practitioner: ${top || 'nothing booked'}.`;
    }
  }
}

function figuresFor(orgId: string, topic: ReportTopic, range: ReportRange): { figures: Record<string, unknown>; currency: string; basis: string } {
  switch (topic) {
    case 'revenue': {
      const r = revenueReport(orgId, range);
      return {
        currency: r.currency,
        basis: 'Reports → Revenue',
        figures: {
          currency: r.currency,
          billedMinor: r.billedMinor,
          collectedMinor: r.collectedMinor,
          outstandingMinor: r.outstandingMinor,
          creditMinor: r.creditMinor,
          collectionRatePct: r.collectionRatePct,
          invoices: r.invoices,
          top: r.byProvider.filter((row) => row.invoicedMinor > 0).slice(0, 3).map((row) => ({ name: row.name, invoicedMinor: row.invoicedMinor, appointments: row.appointments })),
        },
      };
    }
    case 'appointments': {
      const u = utilisationReport(orgId, range);
      const r = revenueReport(orgId, range);
      return {
        currency: r.currency,
        basis: 'Reports → Revenue (appointments) and Utilisation',
        figures: {
          appointments: r.byProvider.reduce((n, row) => n + row.appointments, 0),
          attended: r.byProvider.reduce((n, row) => n + row.attended, 0),
          byProvider: u.rows.map((row) => ({ name: row.name, appointments: row.appointments, attendedMinutes: row.attendedMinutes })),
          emptyDays: u.rows.reduce((n, row) => n + row.emptyDays, 0),
        },
      };
    }
    case 'attendance': {
      const a = attendanceReport(orgId, range);
      return {
        currency: moneySettingsFor(orgId).currency,
        basis: 'Reports → Attendance',
        figures: {
          attended: a.attended,
          noShows: a.noShows,
          cancelled: a.cancelled,
          considered: Array.isArray(a.considered) ? a.considered.length : Number(a.considered ?? 0),
          noShowRatePct: a.noShowRatePct,
          cancellationRatePct: a.cancellationRatePct,
          previousRatePct: a.previousRatePct,
        },
      };
    }
    case 'utilisation': {
      const u = utilisationReport(orgId, range);
      return {
        currency: moneySettingsFor(orgId).currency,
        basis: 'Reports → Utilisation',
        figures: {
          utilisationPct: u.utilisationPct,
          attendedPct: u.attendedPct,
          capacityHours: u.capacityHours,
          bookedHours: u.bookedHours,
          attendedHours: u.attendedHours,
          byProvider: u.rows.map((row) => ({ name: row.name, utilisationPct: row.utilisationPct, appointments: row.appointments })),
        },
      };
    }
    case 'sources': {
      const a = attributionReport(orgId, range);
      return {
        currency: a.currency,
        basis: 'Reports → Booking sources',
        figures: {
          bookings: a.bookings,
          assistantSharePct: a.assistantSharePct,
          bySource: a.bySource.map((row) => ({ source: row.label, bookings: row.bookings })),
          calls: a.calls,
        },
      };
    }
    case 'recalls': {
      const r = recallReport(orgId, range, { limit: 1 });
      return {
        currency: moneySettingsFor(orgId).currency,
        basis: 'Reports → Recalls (counts only)',
        figures: { due: r.due, reachable: r.reachable, optedOut: r.optedOut, blocked: r.blocked, intervalDays: r.intervalDays },
      };
    }
    default: {
      const a = attributionReport(orgId, range);
      return {
        currency: a.currency,
        basis: 'Reports → Booking sources (call outcomes)',
        figures: { calls: a.calls },
      };
    }
  }
}

/* ----------------------------------------------------------------------- tool */

const REFUSAL =
  "I can't share the practice's figures on this line — they're for the team. Happy to help with your own appointment, though: I can check a day, move you, or take a message.";
const MONEY_REFUSAL =
  "I can share the diary numbers with you, but the practice's money is owner and admin only. Your own numbers are on the Reports screen whenever you want them.";

/**
 * Runs `practice_report`, or returns `undefined` when this is some other tool.
 *
 * The refusal is a normal, successful answer rather than an error: the assistant
 * still has something true and useful to say, and a transcript should read like a
 * conversation rather than like a stack trace.
 */
export async function runReportTool(input: {
  ctx: BookingToolContext;
  name: string;
  args: Record<string, unknown>;
  text?: string;
}): Promise<ToolCall | undefined> {
  const { ctx, name } = input;
  if (!REPORT_TOOLS.has(name)) return undefined;

  const started = Date.now();
  const done = (result: Record<string, unknown>, status: 'ok' | 'error' = 'ok'): ToolCall => ({
    name,
    args: { ...input.args },
    result: JSON.stringify(result),
    ms: Math.max(40, Date.now() - started),
    status,
  });

  const identity = reportIdentity(ctx.orgId, { callerNumber: ctx.callerNumber, viewer: ctx.viewer });
  const currency = moneySettingsFor(ctx.orgId).currency;
  const timezone = ctx.timezone ?? list<Doc & { timezone?: string }>('locations', (l) => l.orgId === ctx.orgId)[0]?.timezone ?? 'UTC';

  if (!identity) {
    audit({
      orgId: ctx.orgId,
      actor: ctx.callerNumber ?? 'unknown caller',
      action: 'report.denied',
      target: ctx.callId,
      detail: 'practice figures requested by a number the practice does not know',
    });
    return done({ allowed: false, permission: 'unknown_caller', summary: REFUSAL, guidance: 'Offer to book, move or cancel their own appointment, or take a message.' });
  }

  const asked = reportAsk(input.text ?? String(input.args.question ?? ''));
  const topic = (String(input.args.topic ?? asked.topic) as ReportTopic) ?? asked.topic;
  const period = String(input.args.period ?? asked.period);
  const range = rangeForPeriod(ctx.orgId, period, timezone);

  if (topic === 'revenue' && !maySeeMoney(identity)) {
    audit({
      orgId: ctx.orgId,
      actor: identity.name,
      action: 'report.denied',
      target: ctx.callId,
      detail: `money report requested by ${identity.role ?? identity.kind}`,
    });
    return done({
      allowed: false,
      permission: 'role',
      topic,
      period: range.label,
      summary: MONEY_REFUSAL,
      guidance: 'Offer the diary figures instead — how busy, how many appointments, who did not turn up.',
    });
  }

  const { figures, basis } = figuresFor(ctx.orgId, topic, range);
  const summary = speak(topic, range, figures);

  audit({
    orgId: ctx.orgId,
    actor: identity.name,
    action: 'report.read',
    target: ctx.callId,
    detail: `${TOPIC_NAMES[topic]} · ${range.label} · ${identity.via === 'number' ? 'by number' : 'from the dashboard'}`,
  });

  return done({
    allowed: true,
    topic,
    period: range.label,
    from: range.from,
    to: range.to,
    timezone,
    currency,
    summary,
    figures,
    basis,
    spokenBy: identity.name,
  });
}
