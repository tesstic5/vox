/**
 * The outreach log.
 *
 * One row per outbound touch: a text, an email, a call, whoever placed it and
 * whatever came of it. Everything that reaches a client goes through here, which
 * is what makes two questions answerable without joining four collections:
 *
 *   - *"What have we sent this person?"* — the record's timeline, filtered by kind.
 *   - *"Who does not turn up, and does reminding help?"* — the no-show report
 *     joins appointments to the outreach rows that preceded them.
 *
 * A row is written when something *happens*, never when something is intended: a
 * queued message logs nothing, the send logs the row. Intents live in `messages`;
 * this is the history, and history that records intentions is not history.
 */

import { insert, list, newId, nowIso, type Doc } from './db';

export type OutreachChannel = 'sms' | 'email' | 'call';

/** What the touch was for. Deliberately small: a report needs to group by it. */
export type OutreachKind =
  | 'confirmation'
  | 'reminder'
  | 'followup'
  | 'no_show'
  | 'winback'
  | 'recall'
  | 'payment_link'
  | 'waitlist_offer'
  /**
   * A place in a class, offered to one person in the line.
   *
   * Its own kind rather than the freed-slot one: the slot message says "first to
   * take it gets it", and that is false for a place — one place goes to one
   * person, in order, and the practice may want to word it differently.
   */
  | 'class_offer'
  /** "We have received your money." */
  | 'receipt'
  /** "We have sent your money back." */
  | 'refund'
  /** "Your money is still owed." */
  | 'overdue'
  | 'manual'
  | 'unknown';

export type OutreachOutcome =
  | 'sent'
  | 'delivered'
  | 'blocked'
  | 'failed'
  | 'answered'
  | 'no_answer'
  | 'voicemail'
  | 'confirmed'
  | 'rescheduled'
  | 'cancelled'
  | 'no_show'
  /** They replied to us — an opt-out, the one inbound reply the product acts on. */
  | 'opted_out';

export type OutreachDoc = Doc & {
  orgId: string;
  clientId?: string;
  bookingId?: string;
  channel: OutreachChannel;
  kind: OutreachKind;
  outcome: OutreachOutcome;
  /** Where it went — a number or an address, never a name. */
  to: string;
  /** The message or call this row is about. */
  messageId?: string;
  callId?: string;
  campaignId?: string;
  /** Who caused it: an agent, the scheduler, a rule, a person. */
  actor: string;
  /** Free text for the desk: the reason a message was blocked, a call summary. */
  detail?: string;
  /** The instant of the touch — the appointment is elsewhere; this is *when we acted*. */
  at: string;
  meta?: Record<string, string>;
};

export type OutreachInput = Omit<OutreachDoc, 'id' | 'at' | 'createdAt' | 'updatedAt'> & { at?: string };

export function recordOutreach(input: OutreachInput): OutreachDoc {
  const doc: OutreachDoc = {
    id: newId('out_'),
    ...input,
    at: input.at ?? nowIso(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  } as OutreachDoc;
  insert<OutreachDoc>('outreach', doc);
  return doc;
}

export function outreachFor(
  orgId: string,
  filter?: { clientId?: string; bookingId?: string; channel?: OutreachChannel; kind?: OutreachKind; since?: string; limit?: number }
) {
  const rows = list<OutreachDoc>('outreach', (row) => {
    if (row.orgId !== orgId) return false;
    if (filter?.clientId && row.clientId !== filter.clientId) return false;
    if (filter?.bookingId && row.bookingId !== filter.bookingId) return false;
    if (filter?.channel && row.channel !== filter.channel) return false;
    if (filter?.kind && row.kind !== filter.kind) return false;
    if (filter?.since && String(row.at) < filter.since) return false;
    return true;
  }).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return filter?.limit ? rows.slice(0, filter.limit) : rows;
}

/** A tally by any of the fields a desk asks about. */
export function outreachStats(orgId: string, since?: string) {
  const rows = outreachFor(orgId, { since });
  const tally = <T extends string>(pick: (row: OutreachDoc) => T) =>
    rows.reduce<Record<string, number>>((acc, row) => ({ ...acc, [pick(row)]: (acc[pick(row)] ?? 0) + 1 }), {});
  return {
    total: rows.length,
    byChannel: tally((r) => r.channel),
    byKind: tally((r) => r.kind),
    byOutcome: tally((r) => r.outcome),
    /** Did we reach anyone? The number a campaign is judged on. */
    reached: rows.filter((r) => ['answered', 'delivered', 'confirmed', 'rescheduled', 'cancelled'].includes(r.outcome)).length,
  };
}

/**
 * Touches that happened for one appointment, oldest first.
 *
 * Used by the no-show report: "was this person reminded, and did they turn up?"
 */
export function outreachForBooking(orgId: string, bookingId: string) {
  return outreachFor(orgId, { bookingId }).slice().reverse();
}
