/**
 * Booking campaigns.
 *
 * A campaign is the working part of the service: "call everyone booked in the
 * next 24 hours, ask whether they are still coming, and write back what they
 * said." Runs are driven by a tick — `POST /api/v1/booking-campaigns/{id}/run` —
 * which a cron, a queue worker, or a button in the dashboard can call. Nothing
 * in here assumes a scheduler exists, and nothing rings a phone unless the
 * workspace has a carrier connected.
 *
 * Safety rails that make this safe to leave running:
 *
 *   * **Quiet hours.** No dialling outside the window the client sets.
 *   * **One attempt per booking per change.** A booking edited by the client's
 *     system becomes callable again; nothing else does.
 *   * **A concurrency ceiling.** Dials are capped per tick, so a campaign cannot
 *     empty a carrier's balance in one go.
 *   * **Retries that know when to stop.** A no-answer is retried once, after a
 *     delay, and then recorded as an outcome rather than tried forever.
 */

import { get, insert, list, newId, nowIso, update, type Doc } from './db';
import { audit } from './audit';
import { dueBookings, type BookingDoc, type BookingOutcome } from './bookings';
import { createCall } from './calls';
import { MANAGED_CARRIER_ID, dialerFor } from './managed';
import { placeCall } from './providers/twilio';
import { rememberCarrierCall } from './telephony';
import { composeBookingMessage, messagesFor, queueMessage } from './messages';
import type { OutreachKind } from './outreach';

export type CampaignKind = 'confirm' | 'remind' | 'winback' | 'followup';

export type BookingCampaignDoc = Doc & {
  orgId: string;
  name: string;
  kind: CampaignKind;
  /** The assistant that makes the calls. */
  assistantId: string;
  /** The number calls go out from. */
  numberId?: string;
  carrierId?: string;
  /** Only bookings starting within this many hours are called. */
  withinHours: number;
  maxPerRun: number;
  /** Local hours during which dialling is allowed (24h clock). */
  quietHours: { start: number; end: number; timezone?: string };
  /** Seconds between dials inside one run. */
  pacingSeconds: number;
  retry: { maxAttempts: number; delayMinutes: number };
  /** Template the agent follows, filled per booking. */
  instructions: string;
  /**
   * Which channels this campaign uses.
   *
   * Calls are the expensive, high-touch channel and texts are the cheap one, and
   * most campaigns want both: a text first ("we will ring you about tomorrow"), a
   * call if that does not settle it. Defaults keep old campaigns call-only.
   */
  channels?: { call: boolean; sms: boolean };
  status: 'active' | 'paused';
  stats: {
    runs: number;
    dialled: number;
    confirmed: number;
    rescheduled: number;
    cancelled: number;
    noAnswer: number;
    failed: number;
    /** Texts queued by this campaign since it was created. */
    texted?: number;
  };
  lastRunAt?: string;
  lastRun?: {
    at: string;
    dialled: number;
    skipped: number;
    reasons: string[];
    /** True when the run was a dry run: nothing was dialled. */
    dryRun: boolean;
    deferred?: string;
  };
};

type BookingLink = { bookingId: string; externalId: string; startsAt: string };

/** The agent's brief for one booking — what it is calling about. */
export function campaignInstructions(campaign: BookingCampaignDoc, booking: BookingDoc, describe: string) {
  return campaign.instructions
    .replace(/\{\{customer\}\}/g, booking.customer.name.split(' ')[0])
    .replace(/\{\{appointment\}\}/g, describe)
    .replace(/\{\{business\}\}/g, 'the business')
    .trim();
}

export function campaignsFor(orgId: string) {
  return list<BookingCampaignDoc>('bookingCampaigns', (c) => c.orgId === orgId);
}

export function campaignById(orgId: string, id: string) {
  const doc = get<BookingCampaignDoc>('bookingCampaigns', id);
  return doc && doc.orgId === orgId ? doc : undefined;
}

export function createCampaign(input: Partial<BookingCampaignDoc> & { orgId: string; name: string; assistantId: string }): BookingCampaignDoc {
  const doc = insert<BookingCampaignDoc>('bookingCampaigns', {
    id: newId('bcmp_'),
    orgId: input.orgId,
    name: input.name,
    kind: input.kind ?? 'confirm',
    assistantId: input.assistantId,
    numberId: input.numberId,
    carrierId: input.carrierId,
    withinHours: input.withinHours ?? 24,
    maxPerRun: input.maxPerRun ?? 5,
    quietHours: input.quietHours ?? { start: 9, end: 19, timezone: undefined },
    pacingSeconds: input.pacingSeconds ?? 0,
    retry: input.retry ?? { maxAttempts: 2, delayMinutes: 120 },
    instructions:
      input.instructions ??
      'You are calling {{customer}} about their {{appointment}}. Confirm they are still coming; if not, offer to move it to another day or cancel it. Be brief and friendly.',
    // Calls only, until somebody asks for texts: a campaign that starts texting
    // the moment this ship lands would surprise a workspace that never asked.
    channels: input.channels ?? { call: true, sms: false },
    status: input.status ?? 'paused',
    stats: { runs: 0, dialled: 0, confirmed: 0, rescheduled: 0, cancelled: 0, noAnswer: 0, failed: 0 },
    createdAt: nowIso(),
  } as BookingCampaignDoc);
  audit({ orgId: input.orgId, actor: 'dashboard', action: 'campaign.created', target: doc.id, detail: doc.name });
  return doc;
}

export function updateCampaign(orgId: string, id: string, patch: Partial<BookingCampaignDoc>) {
  const doc = campaignById(orgId, id);
  if (!doc) return undefined;
  return update<BookingCampaignDoc>('bookingCampaigns', id, patch) as BookingCampaignDoc;
}

/** Local hour in the campaign's timezone, so quiet hours mean something. */
export function localHour(timezone?: string) {
  try {
    // Some Intl implementations render midnight as `24` even with a 24-hour
    // clock. Normalise it to hour zero so an explicit 00:00–24:00 window really
    // is open all day instead of closing for the first hour of the day.
    const rendered = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: timezone ?? 'UTC' }).format(new Date()));
    return Number.isFinite(rendered) ? ((Math.trunc(rendered) % 24) + 24) % 24 : new Date().getUTCHours();
  } catch {
    return new Date().getUTCHours();
  }
}

export function withinQuietHours(campaign: BookingCampaignDoc, hour = localHour(campaign.quietHours.timezone)) {
  const { start, end } = campaign.quietHours;
  const local = Number.isFinite(hour) ? ((Math.trunc(hour) % 24) + 24) % 24 : localHour(campaign.quietHours.timezone);
  // A window that wraps midnight (e.g. 21 → 6) is a night shift: allowed outside it.
  return start <= end ? local >= start && local < end : local >= start || local < end;
}

/** The template job each campaign kind speaks to. */
export const CAMPAIGN_TEMPLATE_KIND: Record<CampaignKind, OutreachKind> = {
  confirm: 'confirmation',
  remind: 'reminder',
  winback: 'winback',
  followup: 'followup',
};

export function campaignChannels(campaign: BookingCampaignDoc): { call: boolean; sms: boolean } {
  return campaign.channels ?? { call: true, sms: false };
}

export type RunResult = {
  ok: boolean;
  reason?: string;
  /** Which account the calls went through: the client's carrier or the platform's. */
  via?: 'workspace' | 'managed';
  dryRun: boolean;
  dialled: number;
  skipped: number;
  calls: { bookingId: string; externalId: string; to: string; callId?: string; carrierSid?: string; error?: string }[];
  /** Texts this run put in the queue. Delivery is the message queue's business. */
  texted?: number;
  deferred?: string;
};

/**
 * One tick of a campaign.
 *
 * `dryRun` is the default on purpose: an operator can see exactly who would be
 * rung, and why, before anything is dialled. Turning phones on is a deliberate
 * `{ dryRun: false }`.
 */
export async function runCampaign(input: {
  orgId: string;
  campaignId: string;
  dryRun?: boolean;
  /** Test/ops hook: pretend the clock is this hour, for quiet-hour tests. */
  atHour?: number;
  describe: (booking: BookingDoc) => string;
  /** Injected so the runner stays testable without a carrier. */
  dial?: (args: { campaign: BookingCampaignDoc; booking: BookingDoc; to: string; from: string }) => Promise<{ ok: true; sid: string } | { ok: false; error: string }>;
}): Promise<RunResult> {
  const campaign = campaignById(input.orgId, input.campaignId);
  if (!campaign) return { ok: false, reason: 'campaign_not_found', dryRun: true, dialled: 0, skipped: 0, calls: [] };
  if (input.dryRun === false && campaign.status !== 'active') {
    return { ok: false, reason: 'campaign_paused', dryRun: true, dialled: 0, skipped: 0, calls: [] };
  }

  const hour = input.atHour ?? localHour(campaign.quietHours.timezone);
  if (!withinQuietHours(campaign, hour)) {
    const deferred = `Outside calling hours (${campaign.quietHours.start}:00–${campaign.quietHours.end}:00 ${campaign.quietHours.timezone ?? 'UTC'}; now ${hour}:00).`;
    update<BookingCampaignDoc>('bookingCampaigns', campaign.id, {
      lastRunAt: nowIso(),
      lastRun: { at: nowIso(), dialled: 0, skipped: 0, reasons: [deferred], dryRun: input.dryRun !== false, deferred },
    });
    const quietCarrier = dialerFor(input.orgId, campaign.carrierId);
    return {
      ok: true,
      dryRun: input.dryRun !== false,
      via: quietCarrier?.id === MANAGED_CARRIER_ID ? 'managed' : quietCarrier ? 'workspace' : undefined,
      dialled: 0,
      skipped: 0,
      calls: [],
      reason: 'quiet_hours',
      deferred,
    };
  }

  // Due = inside the window, still open, and not already called since it changed.
  const due = dueBookings(input.orgId, { withinHours: campaign.withinHours, skipAttempted: true, limit: campaign.maxPerRun });
  const skippedForRetry = dueBookings(input.orgId, { withinHours: campaign.withinHours }).filter((b) => !due.includes(b) && shouldRetry(campaign, b));

  const reasons: string[] = [];
  const calls: RunResult['calls'] = [];
  const dryRun = input.dryRun !== false;
  // Which account a real run would dial on — resolved up front so the dry run can
  // say it too, and so nothing downstream has to guess.
  const carrier = dialerFor(input.orgId, campaign.carrierId);
  const via = carrier?.id === MANAGED_CARRIER_ID ? ('managed' as const) : carrier ? ('workspace' as const) : undefined;

  if (!due.length && !skippedForRetry.length) {
    reasons.push(`No bookings inside ${campaign.withinHours}h need a call.`);
  }

  const channels = campaignChannels(campaign);

  if (dryRun) {
    for (const b of due) calls.push({ bookingId: b.id, externalId: b.externalId, to: b.customer.number });
    if (due.length) {
      const what = [channels.call ? 'dialled' : null, channels.sms ? 'texted' : null].filter(Boolean).join(' and ');
      reasons.push(`${due.length} booking(s) would be ${what || 'left alone (no channels on)'}.`);
    }
    update<BookingCampaignDoc>('bookingCampaigns', campaign.id, {
      lastRunAt: nowIso(),
      lastRun: { at: nowIso(), dialled: 0, skipped: due.length, reasons, dryRun: true },
    });
    return { ok: true, dryRun: true, via, dialled: 0, skipped: due.length, calls, reason: reasons[0] };
  }

  // ---- texts ------------------------------------------------------------
  // Queued here, sent by the message queue: the campaign's job is to decide who
  // should hear from us, not to reach into the carrier itself. Idempotent per
  // booking, so a campaign that ticks every five minutes texts somebody once.
  let texted = 0;
  if (channels.sms) {
    const kind = CAMPAIGN_TEMPLATE_KIND[campaign.kind];
    for (const booking of due) {
      if (!booking.clientId) continue;
      const already = messagesFor(input.orgId, (m) => m.bookingId === booking.id && m.kind === kind && m.status !== 'cancelled');
      if (already.length) continue;
      const composed = composeBookingMessage({
        orgId: input.orgId,
        kind,
        channel: 'sms',
        booking,
        fallback: campaign.instructions?.slice(0, 300) ?? '',
      });
      if (!composed.body.trim()) continue;
      queueMessage({
        orgId: input.orgId,
        channel: 'sms',
        to: booking.customer.number,
        clientId: String(booking.clientId),
        bookingId: booking.id,
        body: composed.body,
        kind,
        source: `campaign:${campaign.id}`,
        meta: { kind, campaignId: campaign.id, reference: booking.externalId ?? '' },
        respectConsent: true,
      });
      texted += 1;
    }
    if (texted) reasons.push(`${texted} text(s) queued.`);
  }

  // ---- calls ------------------------------------------------------------
  // Nothing to dial is a successful run, not a failed one: reporting "no carrier"
  // for a run that had nobody to ring would train an operator to ignore the one
  // failure that matters.
  if (channels.call && !due.length && !skippedForRetry.length && !texted) {
    update<BookingCampaignDoc>('bookingCampaigns', campaign.id, {
      lastRunAt: nowIso(),
      lastRun: { at: nowIso(), dialled: 0, skipped: 0, reasons, dryRun: false },
      stats: { ...campaign.stats, runs: campaign.stats.runs + 1 },
    });
    return { ok: true, dryRun: false, via, dialled: 0, skipped: 0, calls, texted, reason: 'nothing_due' };
  }

  if (!channels.call) {
    update<BookingCampaignDoc>('bookingCampaigns', campaign.id, {
      lastRunAt: nowIso(),
      lastRun: { at: nowIso(), dialled: 0, skipped: 0, reasons, dryRun: false },
      stats: { ...campaign.stats, runs: campaign.stats.runs + 1, texted: (campaign.stats.texted ?? 0) + texted },
    });
    audit({ orgId: input.orgId, actor: 'campaign', action: 'campaign.run', target: campaign.id, detail: `${texted} texted (calls off)` });
    return { ok: true, dryRun: false, via, dialled: 0, skipped: 0, calls, texted, reason: reasons[0] };
  }


  // ---- real dialling ----------------------------------------------------
  if (!carrier) {
    const reason = 'No carrier connected — nothing can be dialled. Connect one at Dashboard → Carriers, or set the deployment’s managed telephony keys.';
    update<BookingCampaignDoc>('bookingCampaigns', campaign.id, {
      lastRunAt: nowIso(),
      lastRun: { at: nowIso(), dialled: 0, skipped: due.length, reasons: [reason], dryRun: false },
    });
    return { ok: false, reason: 'no_carrier', dryRun: false, dialled: 0, skipped: due.length, calls: [] };
  }

  const from = fromNumberFor(input.orgId, campaign);
  if (!from) {
    return { ok: false, reason: 'no_number', dryRun: false, dialled: 0, skipped: due.length, calls: [] };
  }

  let dialled = 0;
  const dial = input.dial ?? defaultDial;
  for (const booking of due) {
    const result = await dial({ campaign, booking, to: booking.customer.number, from });
    if (result.ok) {
      dialled += 1;
      calls.push({ bookingId: booking.id, externalId: booking.externalId, to: booking.customer.number, carrierSid: result.sid });
    } else {
      calls.push({ bookingId: booking.id, externalId: booking.externalId, to: booking.customer.number, error: result.error });
      reasons.push(`${booking.customer.number}: ${result.error}`);
      recordAttempt({ orgId: input.orgId, campaign, booking, outcome: 'failed', detail: result.error });
    }
    if (campaign.pacingSeconds) await new Promise((r) => setTimeout(r, campaign.pacingSeconds * 1000));
  }

  if (due.length) reasons.push(`${dialled}/${due.length} dialled.`);

  update<BookingCampaignDoc>('bookingCampaigns', campaign.id, {
    lastRunAt: nowIso(),
    lastRun: { at: nowIso(), dialled, skipped: 0, reasons, dryRun: false },
    stats: {
      ...campaign.stats,
      runs: campaign.stats.runs + 1,
      dialled: campaign.stats.dialled + dialled,
      texted: (campaign.stats.texted ?? 0) + texted,
    },
  });
  audit({ orgId: input.orgId, actor: 'campaign', action: 'campaign.run', target: campaign.id, detail: `${dialled} dialled, ${texted} texted` });

  return { ok: true, dryRun: false, via, dialled, skipped: 0, calls, texted, reason: reasons[0] };
}

/** A booking that was attempted but is allowed another try. */
function shouldRetry(campaign: BookingCampaignDoc, booking: BookingDoc) {
  const attempts = booking.attempts.filter((a) => a.outcome === 'no_answer' || a.outcome === 'voicemail' || a.outcome === 'failed');
  if (!attempts.length || attempts.length >= campaign.retry.maxAttempts) return false;
  const last = new Date(attempts[attempts.length - 1].at).getTime();
  return Date.now() - last >= campaign.retry.delayMinutes * 60_000;
}

/** The number a campaign dials from: its own, or the first one assigned. */
function fromNumberFor(orgId: string, campaign: BookingCampaignDoc) {
  const numbers = list<Doc & { number?: string }>('numbers', (n) => n.orgId === orgId);
  const chosen = campaign.numberId ? numbers.find((n) => n.id === campaign.numberId) : numbers[0];
  return chosen ? String(chosen.number ?? '') : '';
}

/** Places one call through the carrier, and links it to the booking. */
async function defaultDial(args: { campaign: BookingCampaignDoc; booking: BookingDoc; to: string; from: string }) {
  const { campaign, booking } = args;
  const carrier = dialerFor(campaign.orgId, campaign.carrierId);
  if (!carrier) return { ok: false as const, error: 'no carrier connected' };

  const origin = carrier.webhookBase;
  const placed = await placeCall(carrier, {
    to: args.to,
    from: args.from,
    voiceUrl: `${origin}/api/telephony/twilio/voice`,
    statusCallback: `${origin}/api/telephony/twilio/status`,
    machineDetection: true,
    record: true,
  });
  if (!placed.ok) return { ok: false as const, error: placed.error };

  // A call record exists before the phone rings, so the media worker, the
  // webhooks and the dashboard all have something to attach to.
  const { call: created } = createCall({
    orgId: campaign.orgId,
    assistantId: campaign.assistantId,
    type: 'outbound',
    from: args.from,
    to: args.to,
    customer: { name: booking.customer.name, number: booking.customer.number },
    source: `campaign:${campaign.kind}`,
    bookingId: booking.id,
    campaignId: campaign.id,
    purpose: campaign.instructions,
    numberId: campaign.numberId,
  });

  if (created) {
    rememberCarrierCall(placed.data.sid, created.id, campaign.orgId);
    update<Doc>('bookings', booking.id, {
      callIds: [...(booking.callIds ?? []), created.id],
      attempts: [...booking.attempts, { at: nowIso(), callId: created.id, outcome: 'no_answer', detail: 'dialled, awaiting outcome' }].slice(-20),
      revision: booking.revision + 1,
    });
    audit({ orgId: campaign.orgId, actor: 'campaign', action: 'booking.dialled', target: booking.id, detail: `${booking.externalId} → ${args.to} (${placed.data.sid})` });
  }

  return { ok: true as const, sid: placed.data.sid };
}

export function recordAttempt(input: { orgId: string; campaign: BookingCampaignDoc; booking: BookingDoc; outcome: BookingOutcome; detail?: string; callId?: string }) {
  const fresh = get<BookingDoc>('bookings', input.booking.id);
  if (!fresh) return;
  if (input.outcome === 'failed') {
    update<BookingCampaignDoc>('bookingCampaigns', input.campaign.id, {
      stats: { ...input.campaign.stats, failed: input.campaign.stats.failed + 1 },
    });
  }
  update<BookingDoc>('bookings', fresh.id, {
    attempts: [...fresh.attempts, { at: nowIso(), callId: input.callId, outcome: input.outcome, detail: input.detail }].slice(-20),
    revision: fresh.revision + 1,
  });
}
