/**
 * Outreach rules.
 *
 * The difference between a reminder system and a nuisance is a small set of
 * numbers: how far ahead to remind, on which channels, how late is too late, and
 * what happens when somebody does not turn up. Those numbers belong to the
 * practice, not to the code, so they live here — editable, per workspace, with
 * defaults that are defensible.
 *
 * Every rule is **idempotent by construction**: each one checks for a message of
 * its own kind against the same appointment before queueing another, so running
 * the scheduler twice queues nothing extra. A rule that can double-text is a rule
 * nobody leaves switched on.
 */

import { get, list, update, type Doc } from './db';
import { audit } from './audit';
import { composeBookingMessage, messagesFor, queueMessage, type MessageChannel } from './messages';
import type { BookingDoc } from './bookings';

export type OutreachRules = {
  reminder: {
    enabled: boolean;
    /** How long before the appointment the reminder should arrive. */
    leadMinutes: number;
    /** Inside this many minutes before the start, a reminder is pointless. */
    skipInsideMinutes: number;
    /**
     * How early the reminder joins the queue.
     *
     * The two are different questions. *When does it arrive?* is the lead. *When
     * does it become visible in the queue?* is this — a day ahead by default, so
     * the desk can see what is about to go out and a scheduler that misses a tick
     * does not miss the message. The row sits `pending` until its moment.
     */
    queueAheadMinutes: number;
    channels: MessageChannel[];
  };
  noShowFollowUp: {
    enabled: boolean;
    /** How long after a missed appointment the follow-up may still go. */
    withinHours: number;
    channel: MessageChannel;
  };
  /** The "thanks for coming in" text. Off by default: it is a marketing decision. */
  followUpAfterVisit: {
    enabled: boolean;
    delayMinutes: number;
  };
  /**
   * "We have not seen you in a while." Off by default: it is marketing.
   *
   * `afterDays` is the **last** fallback for the interval, behind a service's own
   * `recallDays` and the practice profile's. It stays because a workspace that set
   * this number years ago meant it, and re-timing them silently would be a change
   * nobody asked for.
   */
  recall: {
    enabled: boolean;
    afterDays: number;
    /** Channels a recall may use, in the order they are tried. */
    channels: MessageChannel[];
    /**
     * How long after a recall before the same person may be recalled again.
     *
     * Without this, "everybody overdue" is re-sent every day — the fastest way to
     * make a practice's texts feel like spam. Zero means "as soon as they are
     * overdue again", which is only sensible with a long interval.
     */
    cooldownDays: number;
    /**
     * The ceiling on one run.
     *
     * A practice with two thousand overdue clients should not discover the recall
     * feature by having two thousand texts leave in the same minute. The job sends
     * up to this many and says how many are left; the desk can send the rest, or
     * wait for tomorrow. Zero means no ceiling — the desk's own choice to make.
     */
    maxPerDay: number;
  };
  /**
   * Chasing an unpaid invoice.
   *
   * On by default, because this is not marketing: somebody bought something and
   * has not paid for it, and a practice that never mentions it is a practice that
   * never gets paid. Consent is still checked before anything is sent, and the
   * desk sees a blocked row rather than a silent one.
   *
   * The schedule is offsets in days **relative to the due date**: `-3` is three
   * days before it falls due (a courtesy nudge), `0` is the day itself, `7` and
   * `21` are after. One message per offset per invoice, ever.
   */
  overdue: {
    enabled: boolean;
    offsetsDays: number[];
    channels: MessageChannel[];
  };
};

export const DEFAULT_OUTREACH_RULES: OutreachRules = {
  reminder: { enabled: true, leadMinutes: 24 * 60, skipInsideMinutes: 60, queueAheadMinutes: 24 * 60, channels: ['sms'] },
  noShowFollowUp: { enabled: true, withinHours: 48, channel: 'sms' },
  followUpAfterVisit: { enabled: false, delayMinutes: 120 },
  recall: { enabled: false, afterDays: 180, channels: ['sms'], cooldownDays: 90, maxPerDay: 25 },
  overdue: { enabled: true, offsetsDays: [-3, 0, 7, 21], channels: ['sms'] },
};

export function outreachRules(orgId: string): OutreachRules {
  const org = get<Doc & { outreach?: Partial<OutreachRules> }>('orgs', orgId);
  const stored = org?.outreach ?? {};
  return {
    ...DEFAULT_OUTREACH_RULES,
    ...stored,
    reminder: { ...DEFAULT_OUTREACH_RULES.reminder, ...(stored.reminder ?? {}) },
    noShowFollowUp: { ...DEFAULT_OUTREACH_RULES.noShowFollowUp, ...(stored.noShowFollowUp ?? {}) },
    followUpAfterVisit: { ...DEFAULT_OUTREACH_RULES.followUpAfterVisit, ...(stored.followUpAfterVisit ?? {}) },
    recall: { ...DEFAULT_OUTREACH_RULES.recall, ...(stored.recall ?? {}) },
    overdue: { ...DEFAULT_OUTREACH_RULES.overdue, ...(stored.overdue ?? {}) },
  };
}

export function setOutreachRules(orgId: string, patch: Partial<OutreachRules>, actor: string): OutreachRules {
  const current = outreachRules(orgId);
  const next: OutreachRules = {
    ...current,
    ...patch,
    reminder: { ...current.reminder, ...(patch.reminder ?? {}) },
    noShowFollowUp: { ...current.noShowFollowUp, ...(patch.noShowFollowUp ?? {}) },
    followUpAfterVisit: { ...current.followUpAfterVisit, ...(patch.followUpAfterVisit ?? {}) },
    recall: { ...current.recall, ...(patch.recall ?? {}) },
    overdue: { ...current.overdue, ...(patch.overdue ?? {}) },
  };
  // Numbers that would make the rule nonsense are clamped rather than rejected:
  // the field is a number input, and a rule that cannot fire is a support ticket.
  next.reminder.leadMinutes = Math.min(Math.max(next.reminder.leadMinutes || 60, 15), 14 * 24 * 60);
  next.reminder.queueAheadMinutes = Math.min(Math.max(next.reminder.queueAheadMinutes ?? 24 * 60, 0), 30 * 24 * 60);
  next.reminder.skipInsideMinutes = Math.min(Math.max(next.reminder.skipInsideMinutes || 0, 0), 24 * 60);
  next.noShowFollowUp.withinHours = Math.min(Math.max(next.noShowFollowUp.withinHours || 1, 1), 30 * 24);
  next.followUpAfterVisit.delayMinutes = Math.min(Math.max(next.followUpAfterVisit.delayMinutes || 30, 5), 7 * 24 * 60);
  next.recall.afterDays = Math.min(Math.max(Math.round(next.recall.afterDays) || 30, 7), 3650);
  next.recall.cooldownDays = Math.min(Math.max(Math.round(next.recall.cooldownDays) || 0, 0), 3650);
  next.recall.maxPerDay = Math.min(Math.max(Math.round(next.recall.maxPerDay) || 0, 0), 5000);
  next.recall.channels = ((Array.isArray(next.recall.channels) ? next.recall.channels : ['sms']) as MessageChannel[]).filter(
    (channel) => channel === 'sms' || channel === 'email'
  );
  if (!next.recall.channels.length) next.recall.channels = ['sms'];
  // Offsets are clamped rather than rejected — the field is a text input, and a
  // rule that cannot fire is a support ticket. Sorted and deduplicated so "day 0"
  // cannot go out twice, and capped at eight so a mistyped paste cannot turn one
  // invoice into a fortnight of text messages.
  const offsets = Array.isArray(next.overdue.offsetsDays) ? next.overdue.offsetsDays : DEFAULT_OUTREACH_RULES.overdue.offsetsDays;
  next.overdue.offsetsDays = [...new Set(offsets.map((d) => Math.round(Number(d))).filter((d) => Number.isFinite(d)).map((d) => Math.min(Math.max(d, -60), 365)))]
    .sort((a, b) => a - b)
    .slice(0, 8);
  next.overdue.channels = (Array.isArray(next.overdue.channels) ? next.overdue.channels : []).filter((c) => c === 'sms' || c === 'email');
  update<Doc>('orgs', orgId, { outreach: next } as never);
  audit({ orgId, actor, action: 'outreach.rules_updated', detail: JSON.stringify(patch).slice(0, 200) });
  return next;
}

/* ----------------------------------------------------------------- rules run */

/**
 * The "we missed you" text.
 *
 * Only for appointments that were marked `no_show` — a cancellation is a decision
 * the patient already made, and texting them about it is rude.
 */
export function queueNoShowFollowUps(now = Date.now(), orgId?: string): number {
  const rules = orgId ? outreachRules(orgId) : undefined;
  const orgs = orgId ? [orgId] : list<Doc & { id: string }>('orgs').map((o) => o.id);

  let queued = 0;
  for (const currentOrg of orgs) {
    const orgRules = rules ?? outreachRules(currentOrg);
    if (!orgRules.noShowFollowUp.enabled) continue;
    const windowMs = orgRules.noShowFollowUp.withinHours * 3_600_000;
    const missed = list<BookingDoc>('bookings', (b) => {
      if (String(b.orgId) !== currentOrg) return false;
      if (b.status !== 'no_show') return false;
      const at = new Date(String(b.startsAt ?? 0)).getTime();
      return at < now && now - at <= windowMs;
    });

    for (const booking of missed) {
      if (!booking.clientId) continue;
      const already = messagesFor(currentOrg, (m) => m.bookingId === booking.id && m.kind === 'no_show' && m.status !== 'cancelled');
      if (already.length) continue;
      const composed = composeBookingMessage({
        orgId: currentOrg,
        kind: 'no_show',
        channel: orgRules.noShowFollowUp.channel,
        booking,
        fallback: 'We missed you today — reply with a day that suits and we will rebook you.',
      });
      const client = get<Doc & { name?: string; email?: string }>('clients', String(booking.clientId));
      queueMessage({
        orgId: currentOrg,
        channel: orgRules.noShowFollowUp.channel,
        to: orgRules.noShowFollowUp.channel === 'email' ? String(booking.customer.email ?? client?.email ?? '') : booking.customer.number,
        clientId: String(booking.clientId),
        bookingId: booking.id,
        body: composed.body,
        subject: composed.subject,
        kind: 'no_show',
        source: 'no-show-rule',
        meta: { kind: 'no_show', reference: booking.externalId ?? '', templateId: composed.templateId ?? '' },
        respectConsent: true,
      });
      queued += 1;
    }
  }
  return queued;
}

/** The "thanks for coming in" text, a little after the appointment ends. */
export function queueVisitFollowUps(now = Date.now(), orgId?: string): number {
  const orgs = orgId ? [orgId] : list<Doc & { id: string }>('orgs').map((o) => o.id);
  let queued = 0;
  for (const currentOrg of orgs) {
    const rules = outreachRules(currentOrg);
    if (!rules.followUpAfterVisit.enabled) continue;
    const delayMs = rules.followUpAfterVisit.delayMinutes * 60_000;
    const candidates = list<BookingDoc>('bookings', (b) => {
      if (String(b.orgId) !== currentOrg) return false;
      if (b.status !== 'completed') return false;
      const endsAt = new Date(String(b.startsAt ?? 0)).getTime() + (Number(b.durationMinutes ?? 30) || 30) * 60_000;
      return now >= endsAt + delayMs && now <= endsAt + delayMs + 24 * 3_600_000;
    });
    for (const booking of candidates) {
      if (!booking.clientId) continue;
      const already = messagesFor(currentOrg, (m) => m.bookingId === booking.id && m.kind === 'followup' && m.status !== 'cancelled');
      if (already.length) continue;
      const composed = composeBookingMessage({
        orgId: currentOrg,
        kind: 'followup',
        channel: 'sms',
        booking,
        fallback: 'Thanks for coming in today.',
      });
      queueMessage({
        orgId: currentOrg,
        channel: 'sms',
        to: booking.customer.number,
        clientId: String(booking.clientId),
        bookingId: booking.id,
        body: composed.body,
        kind: 'followup',
        source: 'followup-rule',
        meta: { kind: 'followup', reference: booking.externalId ?? '', templateId: composed.templateId ?? '' },
        respectConsent: true,
      });
      queued += 1;
    }
  }
  return queued;
}

/**
 * Which rules want to run for a workspace right now — the scheduler's menu.
 *
 * Returned as data so the dashboard can show what will happen and the scheduler
 * can time itself without either one knowing the others' internals.
 */
export function dueRuleNames(orgId: string): string[] {
  const rules = outreachRules(orgId);
  return [
    rules.reminder.enabled ? 'reminders' : null,
    rules.noShowFollowUp.enabled ? 'no-show follow-ups' : null,
    rules.followUpAfterVisit.enabled ? 'visit follow-ups' : null,
    rules.overdue.enabled && rules.overdue.offsetsDays.length ? 'invoice chases' : null,
    rules.recall.enabled ? 'recalls' : null,
  ].filter(Boolean) as string[];
}
