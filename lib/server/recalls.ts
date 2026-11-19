/**
 * Recalls that act.
 *
 * The practice's recall list has always been readable — *"23 clients are past the
 * 180-day window"* — and that was the whole of it: a number on a screen and a CSV.
 * Nobody was contacted, so the list did nothing except make somebody feel behind.
 * This module is the missing half: it decides **who is due** (using the interval
 * that belongs to their own last service, not one number for the whole practice),
 * **who may be contacted** (consent, contact details, the workspace's channels),
 * and **what to send** — the workspace's own recall wording, with the booking link.
 *
 * Three things are deliberately conservative, because marketing that misfires is
 * worse than marketing that never happens:
 *
 *   - **Somebody with an appointment in the diary is never recalled.** They are
 *     already coming in; a "we have not seen you in a while" text to a person with
 *     a visit booked for Tuesday is the sort of thing that gets a practice blocked.
 *   - **Nobody is recalled twice inside the cooldown** (`rules.recall.cooldownDays`),
 *     and a recall still sitting on the queue counts as sent.
 *   - **One run has a ceiling** (`rules.recall.maxPerDay`), so a mistake in the
 *     interval cannot turn into several thousand texts. The run reports what is
 *     left rather than pretending it finished.
 *
 * Every decision writes an audit line, and every skip says why — *"Sara Bell — an
 * appointment on 2026-10-20"*, *"recalled 12 days ago"* — because the desk asking
 * "why did nobody text my patient back?" deserves the real answer.
 */

import { get, list, nowIso, type Doc } from './db';
import { audit } from './audit';
import {
  contactFor,
  messagesFor,
  messagingTimezone,
  queueMessage,
  type MessageChannel,
  type MessageDoc,
} from './messages';
import { outreachRules, type OutreachRules } from './outreach-rules';
import { renderFor, type MergeContext } from './templates';
import { recallIntervalDays, practiceProfile, serviceById, termsForOrg, type ServiceDoc } from './practice';
import { bookingsFor, type BookingDoc } from './bookings';
import { clientById, clientsFor, type ClientDoc } from './clients';
import { dateStrIn } from './availability';
import { recordOutreach } from './outreach';
import { bookingSettings, type OrgRow } from './booking-page';
import { publicBaseUrl } from './manage-links';

const DAY = 86_400_000;

export type RecallCandidate = {
  clientId: string;
  name: string;
  number: string;
  email?: string;
  lastSeenAt?: string;
  lastSeenDays: number;
  intervalDays: number;
  intervalSource: 'service' | 'practice' | 'rule';
  overdueDays: number;
  serviceId?: string;
  serviceName?: string;
  channel?: MessageChannel;
  to?: string;
  /** Why they are not being contacted, when there is a reason. */
  blockedReason?: string;
  /** When a recall last went out (or one is waiting to). */
  lastRecallAt?: string;
  /** Why they are being left alone even though they are overdue. */
  holdReason?: string;
  /**
   * Which hold it is. The difference matters: a client who is *already booked* or
   * who already has a recall **on the queue** is never sent another one, by the job
   * or by a person; a client inside their **cooldown** can still be recalled by the
   * desk, because that is a judgement a person is allowed to make and a scheduler
   * is not.
   */
  holdKind?: 'booked' | 'queued' | 'cooldown';
};

export type RecallRun = {
  orgId: string;
  /** Messages queued by this run. */
  queued: number;
  /** Overdue people the run did not touch, with the reason. */
  skipped: { clientId: string; name: string; reason: string }[];
  /** Overdue people with no consent or no contact details. */
  blocked: { clientId: string; name: string; reason: string }[];
  /** Overdue people left for the next run because the ceiling was reached. */
  remaining: number;
  /** Sent anyway by a person, past a cooldown the job would have respected. */
  overrodeCooldown: number;
  /** Set when the whole feature is switched off for this workspace. */
  disabled?: boolean;
};

/**
 * When this client was last *seen* — the date a recall window is measured from.
 *
 * `client.lastAppointmentAt` is the last appointment **on the books**, and it moves
 * forward the moment somebody books next month. Measuring a recall window from it
 * means a client with a future appointment silently disappears from the recall list,
 * which is the opposite of what the list is for — the gate caught exactly that: a
 * client overdue by ten days vanished the moment a follow-up was booked. So the
 * honest date is the latest visit that actually *happened* ('completed'), with the
 * counter as a fallback only when it is not in the future: records that predate the
 * diary's statuses still count, without dragging the date forward.
 */
export function lastSeenFor(orgId: string, client: ClientDoc, now = Date.now()): string | undefined {
  const counter = client.lastAppointmentAt ? String(client.lastAppointmentAt) : undefined;
  const counterIsPast = counter ? Date.parse(counter) <= now : false;
  const visits = bookingsFor(orgId, (b) => b.clientId === client.id && b.status === 'completed').map((b) => String(b.startsAt));
  const candidates = [...visits, ...(counterIsPast && counter ? [counter] : [])].filter((iso) => !Number.isNaN(Date.parse(iso)));
  if (!candidates.length) return undefined;
  return candidates.sort().pop();
}

/**
 * The practice's public booking page, when it has one switched on.
 *
 * A recall is the one message whose whole point is a *new* appointment, so the
 * link it carries is the booking page rather than a manage link. Online booking
 * switched off means no link at all, and `dropUnfilledLinkLines` takes the line
 * out of the message rather than sending a client to a page that refuses them.
 */
export function bookingLinkFor(orgId: string): string | undefined {
  const org = get<OrgRow>('orgs', orgId);
  if (!org) return undefined;
  const slug = String(org.slug ?? '').trim();
  if (!slug || !bookingSettings(org).enabled) return undefined;
  return `${publicBaseUrl(orgId).replace(/\/$/, '')}/book/${slug}`;
}

/** Everything the recall wording can say about one person. */
export function recallContext(orgId: string, input: { client: ClientDoc; serviceName?: string; lastSeenAt?: string }): MergeContext {
  const org = get<Doc & { name?: string }>('orgs', orgId);
  const terms = termsForOrg(orgId);
  const first = String(input.client.name ?? '').split(/\s+/)[0] || 'there';
  const lastSeen = input.lastSeenAt ? new Date(input.lastSeenAt) : undefined;
  return {
    client_first_name: first,
    client_name: String(input.client.name ?? ''),
    business: String(org?.name ?? 'the practice'),
    appointment: terms.appointment.one,
    service: input.serviceName ?? terms.appointment.one,
    last_seen: lastSeen && !Number.isNaN(lastSeen.getTime()) ? lastSeen.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' }) : '',
    booking_link: bookingLinkFor(orgId) ?? '',
  };
}

/**
 * Who is due a recall today, and what stands in the way.
 *
 * Read-only: this is the same list the report shows, plus the two judgements the
 * report has no business making — *are they already coming in?* and *were they
 * texted recently?*
 */
export function recallCandidates(orgId: string, now = Date.now(), opts: { clientIds?: string[] } = {}): RecallCandidate[] {
  const rules = outreachRules(orgId);
  const today = dateStrIn(messagingTimezone(orgId), now);
  const cutoff = Date.parse(`${today}T23:59:59Z`);
  const wanted = opts.clientIds ? new Set(opts.clientIds) : undefined;
  const out: RecallCandidate[] = [];

  for (const client of clientsFor(orgId, { includeArchived: false })) {
    if (wanted && !wanted.has(client.id)) continue;
    const lastSeenAt = lastSeenFor(orgId, client as ClientDoc, now);
    if (!lastSeenAt) continue;
    const at = Date.parse(String(lastSeenAt));
    if (Number.isNaN(at) || at > cutoff) continue;

    const lastVisit = latestCompletedBooking(orgId, client.id);
    const serviceId = lastVisit?.serviceId ? String(lastVisit.serviceId) : undefined;
    const interval = recallIntervalDays(orgId, serviceId, rules.recall.afterDays);
    const days = Math.floor((cutoff - at) / DAY);
    if (days <= interval.days) continue;

    const service = serviceId ? serviceById(orgId, serviceId) : undefined;
    const contact = contactFor(orgId, { clientId: client.id, number: client.number, email: client.email }, rules.recall.channels);
    const recall = lastRecallFor(orgId, client.id);
    const upcoming = nextAppointment(orgId, client.id, now);
    const coolingDown = recall?.at ? now - Date.parse(recall.at) < rules.recall.cooldownDays * DAY : false;

    out.push({
      clientId: client.id,
      name: client.name,
      number: client.number,
      email: client.email,
      lastSeenAt: String(lastSeenAt),
      lastSeenDays: days,
      intervalDays: interval.days,
      intervalSource: interval.source,
      overdueDays: days - interval.days,
      serviceId,
      serviceName: service ? String(service.name) : undefined,
      channel: contact?.channel,
      to: contact?.to,
      blockedReason: contact ? contact.blockedReason : `nothing to send to on the channels this rule uses (${rules.recall.channels.join(' / ')})`,
      lastRecallAt: recall?.at,
      holdKind: upcoming ? 'booked' : recall?.pending ? 'queued' : coolingDown ? 'cooldown' : undefined,
      holdReason: upcoming
        ? `already booked ${String(upcoming.startsAt).slice(0, 10)}`
        : recall?.pending
          ? 'a recall is already on the queue'
          : coolingDown
            ? `recalled ${Math.round((now - Date.parse(String(recall?.at))) / DAY)} day(s) ago`
            : undefined,
    });
  }

  return out.sort((a, b) => b.overdueDays - a.overdueDays);
}

/**
 * The job: queue a recall to everybody who is due and reachable.
 *
 * Returns what it did in the practice's own words, which is what the scheduler
 * screen prints and what the gate reads.
 */
export function queueRecalls(now = Date.now(), orgId?: string): RecallRun | RecallRun[] {
  const orgs = orgId ? [orgId] : list<Doc & { id: string }>('orgs').map((o) => o.id);
  const runs = orgs.map((currentOrg) => runForOrg(currentOrg, now));
  return orgId ? runs[0] : runs;
}

function runForOrg(orgId: string, now: number): RecallRun {
  const rules = outreachRules(orgId);
  const run: RecallRun = { orgId, queued: 0, skipped: [], blocked: [], remaining: 0, overrodeCooldown: 0 };
  if (!rules.recall.enabled) {
    run.disabled = true;
    return run;
  }

  const candidates = recallCandidates(orgId, now);
  const alreadyToday = messagesFor(orgId, (m) => m.kind === 'recall' && m.status !== 'cancelled' && String(m.createdAt).slice(0, 10) === new Date(now).toISOString().slice(0, 10)).length;
  let budget = rules.recall.maxPerDay > 0 ? Math.max(0, rules.recall.maxPerDay - alreadyToday) : Number.MAX_SAFE_INTEGER;

  for (const candidate of candidates) {
    if (candidate.holdReason) {
      run.skipped.push({ clientId: candidate.clientId, name: candidate.name, reason: candidate.holdReason });
      continue;
    }
    if (budget <= 0) {
      run.remaining += 1;
      continue;
    }

    const sent = attempt({ orgId, candidate, author: 'recall-rule', now });
    if (sent.queued) {
      run.queued += 1;
      budget -= 1;
    } else if (sent.blocked) {
      run.blocked.push({ clientId: candidate.clientId, name: candidate.name, reason: sent.blocked });
    }
  }

  audit({
    orgId,
    actor: 'system',
    action: 'recall.run',
    target: 'recall',
    detail: `${run.queued} queued · ${run.skipped.length} held · ${run.blocked.length} blocked${run.remaining ? ` · ${run.remaining} left for the next run` : ''}`,
  });
  return run;
}

/**
 * The desk's own hand: send a recall to these people (or to everybody due).
 *
 * The same decisions as the job — consent first, no double-recall, nobody who is
 * already booked — but without the daily ceiling, because a person pressing a
 * button has already made the judgement the ceiling exists to make for them.
 */
export function sendRecalls(input: {
  orgId: string;
  clientIds?: string[];
  actor: string;
  actorName?: string;
  /** Send to everybody due, not just the ids given. */
  all?: boolean;
  /** Override the ceiling for this one action. */
  limit?: number;
}): RecallRun {
  const run: RecallRun = { orgId: input.orgId, queued: 0, skipped: [], blocked: [], remaining: 0, overrodeCooldown: 0 };
  const candidates = recallCandidates(input.orgId, Date.now(), { clientIds: input.all ? undefined : input.clientIds });
  const cap = Math.max(0, Math.min(input.limit ?? 200, 500));
  let sent = 0;

  for (const candidate of candidates) {
    // Two holds a person may not override, and one they may. Already booked is a no
    // — they are coming in. Already on the queue is a no — pressing the button
    // twice is a duplicate, not a decision. *Recalled recently* is theirs to judge:
    // "she asked us to remind her" is a real sentence, and the run says it happened.
    if (candidate.holdKind === 'booked' || candidate.holdKind === 'queued') {
      run.skipped.push({ clientId: candidate.clientId, name: candidate.name, reason: candidate.holdReason ?? 'held' });
      continue;
    }
    if (sent >= cap) {
      run.remaining += 1;
      continue;
    }

    const outcome = attempt({ orgId: input.orgId, candidate, author: input.actor, actorName: input.actorName, now: Date.now() });
    if (outcome.queued) {
      run.queued += 1;
      sent += 1;
      if (candidate.holdKind === 'cooldown') run.overrodeCooldown += 1;
    } else if (outcome.blocked) {
      run.blocked.push({ clientId: candidate.clientId, name: candidate.name, reason: outcome.blocked });
    }
  }

  audit({
    orgId: input.orgId,
    actor: input.actor,
    action: 'recall.sent_by_desk',
    target: 'recall',
    detail: `${run.queued} queued · ${run.blocked.length} blocked · ${run.skipped.length} held`,
  });
  return run;
}

/**
 * One attempt at one person: send it, or record why it could not go.
 *
 * A refusal is worth keeping. The consent check lives in `queueMessage`, which
 * writes a `blocked` row and an outreach entry — "we tried and were not allowed to"
 * is a fact about the client's record, and the desk asking "why did nobody text
 * Sarah back?" deserves to see it in her own thread rather than in a log.
 */
function attempt(input: {
  orgId: string;
  candidate: RecallCandidate;
  author: string;
  actorName?: string;
  now: number;
}): { queued: boolean; blocked?: string } {
  const { candidate } = input;
  if (!candidate.channel || !candidate.to) {
    return { queued: false, blocked: candidate.blockedReason ?? 'no number or email on file' };
  }
  const message = sendRecall({
    orgId: input.orgId,
    candidate,
    channel: candidate.channel,
    to: candidate.to,
    author: input.author,
    actorName: input.actorName,
    now: input.now,
  });
  if (!message) return { queued: false, blocked: candidate.blockedReason ?? 'no way to reach them' };
  if (message.status === 'blocked') return { queued: false, blocked: message.reason ?? candidate.blockedReason ?? 'blocked by consent' };
  return { queued: true };
}

/** One recall, rendered through the workspace's own wording and queued. */
function sendRecall(input: {
  orgId: string;
  candidate: RecallCandidate;
  channel: MessageChannel;
  to: string;
  author: string;
  actorName?: string;
  now: number;
}): MessageDoc | undefined {
  const client = clientById(input.orgId, input.candidate.clientId);
  if (!client) return undefined;
  const context = recallContext(input.orgId, {
    client,
    serviceName: input.candidate.serviceName,
    lastSeenAt: input.candidate.lastSeenAt,
  });
  const rendered = renderFor({
    orgId: input.orgId,
    kind: 'recall',
    channel: input.channel,
    context,
    fallback: `Hi {{client_first_name}} — it has been a while since your last {{appointment}} at {{business}}. Would you like us to find you a time?`,
  });

  const message = queueMessage({
    orgId: input.orgId,
    channel: input.channel,
    to: input.to,
    clientId: input.candidate.clientId,
    body: rendered.body,
    subject: rendered.subject,
    kind: 'recall',
    source: 'recall-rule',
    meta: {
      kind: 'recall',
      intervalDays: String(input.candidate.intervalDays),
      intervalSource: input.candidate.intervalSource,
      overdueDays: String(input.candidate.overdueDays),
      lastSeen: String(input.candidate.lastSeenAt ?? '').slice(0, 10),
      serviceId: input.candidate.serviceId ?? '',
      templateId: rendered.templateId ?? '',
      sentBy: input.author,
    },
  });

  // A blocked row is a refusal worth recording in the client's own thread, exactly
  // as the money loop does — "we tried and were not allowed to" is a fact.
  recordOutreach({
    orgId: input.orgId,
    clientId: input.candidate.clientId,
    channel: input.channel,
    kind: 'recall',
    outcome: message.status === 'blocked' ? 'blocked' : 'recall_queued',
    to: input.to,
    messageId: message.id,
    actor: input.author,
    detail: `recalled after ${input.candidate.lastSeenDays} days (window ${input.candidate.intervalDays}, ${input.candidate.intervalSource})`,
    at: nowIso(),
  });
  audit({
    orgId: input.orgId,
    actor: input.author,
    action: message.status === 'blocked' ? 'recall.blocked' : 'recall.queued',
    target: input.candidate.clientId,
    detail: `${input.candidate.name} — ${input.candidate.lastSeenDays} days since their last visit, window ${input.candidate.intervalDays} (${input.candidate.intervalSource})${message.status === 'blocked' ? ` — ${message.reason}` : ''}`,
  });
  return message;
}

/** What the desk's screen shows about the loop: on or off, and what happened today. */
export function recallState(orgId: string, now = Date.now()) {
  const rules: OutreachRules = outreachRules(orgId);
  const profile = practiceProfile(orgId);
  const today = new Date(now).toISOString().slice(0, 10);
  const sentToday = messagesFor(orgId, (m) => m.kind === 'recall' && String(m.createdAt).slice(0, 10) === today);
  const candidates = recallCandidates(orgId, now);
  return {
    enabled: rules.recall.enabled,
    channels: rules.recall.channels,
    cooldownDays: rules.recall.cooldownDays,
    maxPerDay: rules.recall.maxPerDay,
    /** The practice's own window — what a service with none of its own uses. */
    practiceIntervalDays: Math.round(profile.recallDays),
    ruleFallbackDays: rules.recall.afterDays,
    due: candidates.length,
    reachable: candidates.filter((c) => !c.blockedReason && !c.holdReason).length,
    held: candidates.filter((c) => c.holdReason).length,
    blocked: candidates.filter((c) => !c.holdReason && c.blockedReason).length,
    sentToday: sentToday.filter((m) => m.status !== 'cancelled').length,
    queuedToday: sentToday.filter((m) => m.status === 'pending').length,
    /** The services that carry their own interval, for the screen's explainer. */
    servicesWithOwnInterval: list<ServiceDoc>('services', (s) => s.orgId === orgId && Boolean(s.recallDays)).map((s) => ({
      id: s.id,
      name: String(s.name),
      recallDays: Number(s.recallDays),
    })),
  };
}

/* ------------------------------------------------------------------ helpers */

function latestCompletedBooking(orgId: string, clientId: string): BookingDoc | undefined {
  return bookingsFor(orgId, (b) => b.clientId === clientId && b.status === 'completed').sort((a, b) =>
    String(b.startsAt).localeCompare(String(a.startsAt))
  )[0];
}

/** The next appointment they are still expected at, if any. */
function nextAppointment(orgId: string, clientId: string, now: number): BookingDoc | undefined {
  return bookingsFor(
    orgId,
    (b) =>
      b.clientId === clientId &&
      ['pending', 'confirmed', 'arrived'].includes(String(b.status)) &&
      new Date(String(b.startsAt)).getTime() >= now
  ).sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)))[0];
}

function lastRecallFor(orgId: string, clientId: string): { at: string; pending: boolean } | undefined {
  const rows = messagesFor(orgId, (m) => m.clientId === clientId && m.kind === 'recall' && m.status !== 'cancelled').sort((a, b) =>
    String(b.createdAt).localeCompare(String(a.createdAt))
  );
  if (!rows.length) return undefined;
  return { at: String(rows[0].sentAt ?? rows[0].createdAt), pending: rows[0].status === 'pending' };
}
