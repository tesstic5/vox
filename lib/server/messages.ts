/**
 * Outbound messages — one queue, one send path.
 *
 * Until now "we texted them" was a claim the app made on the agent's behalf:
 * `send_confirmation` returned `{ queued: true }` and nothing carried it. That is
 * the kind of lie that looks fine in a demo and is embarrassing in a clinic, so
 * the confirmation a caller hears promised now becomes a row somebody can point
 * at, with the consent decision recorded next to it.
 *
 * The rules are deliberately dull:
 *
 *   - **Consent is checked again at send time**, not only when the row is made.
 *     Somebody can withdraw consent between booking and the 24-hour reminder, and
 *     the reminder must lose that race.
 *   - **Nothing sends before its time.** A row sits in `pending` until `sendAt`.
 *   - **A failure is a fact, not an exception.** The row records why, and the
 *     sweep tries again a bounded number of times.
 *
 * Delivery goes through the workspace's own connectors (`lib/server/transports.ts`):
 * SMS through the connected carrier, email through the configured relay. When
 * neither is set up the row says so and fails — it never quietly says "sent".
 *
 * Everything that leaves this queue is also written to the **outreach log**, which
 * is the history a desk reads and the no-show report counts.
 */

import { get, insert, list, newId, nowIso, update, type Doc } from './db';
import { audit } from './audit';
import { recordAccess } from './access-log';
import { consentFor } from './clients';
import { recordOutreach, type OutreachDoc, type OutreachKind } from './outreach';
import { deliverWithProviders } from './transports';
import { locationsFor, practiceProfile, providerById, serviceById, termsForOrg } from './practice';
import { formatClock } from './availability';
import { manageLinkFor } from './manage-links';
import type { BookingDoc } from './bookings';
import { renderFor, type MergeContext } from './templates';

export type MessageChannel = 'sms' | 'email';
export type MessageStatus = 'pending' | 'sent' | 'failed' | 'blocked' | 'cancelled';

export type MessageDoc = Doc & {
  orgId: string;
  clientId?: string;
  bookingId?: string;
  channel: MessageChannel;
  to: string;
  body: string;
  subject?: string;
  status: MessageStatus;
  /** When it should go. A reminder made today for Thursday is not sent today. */
  sendAt: string;
  sentAt?: string;
  attempts: number;
  provider?: string;
  providerMessageId?: string;
  /** Provider facts needed to verify later callbacks; never credentials. */
  deliveryMeta?: Record<string, string>;
  /** Why it did not go: no consent, no address, driver unhappy. */
  reason?: string;
  /** Where it came from: the booking page, the agent, the desk, a rule. */
  source: string;
  /** What job it does — 'reminder', 'confirmation', … Drives the outreach log. */
  kind?: OutreachKind;
  meta?: Record<string, string>;
};

/* ---------------------------------------------------------------- settings */

export type MessagingSettings = {
  /** Local hours during which messages may go out. Nobody wants a 3am reminder. */
  quietHours: { start: number; end: number; timezone?: string };
  /** Which channels this workspace sends on at all. */
  channels: { sms: boolean; email: boolean };
  /** Retry a failed send this many times before calling it failed. */
  maxAttempts: number;
};

export const DEFAULT_MESSAGING_SETTINGS: MessagingSettings = {
  quietHours: { start: 8, end: 20 },
  channels: { sms: true, email: true },
  maxAttempts: 3,
};

export function messagingSettings(orgId: string): MessagingSettings {
  const org = get<Doc & { messaging?: Partial<MessagingSettings> }>('orgs', orgId);
  const stored = org?.messaging ?? {};
  return {
    ...DEFAULT_MESSAGING_SETTINGS,
    ...stored,
    quietHours: { ...DEFAULT_MESSAGING_SETTINGS.quietHours, ...(stored.quietHours ?? {}) },
    channels: { ...DEFAULT_MESSAGING_SETTINGS.channels, ...(stored.channels ?? {}) },
  };
}

export function setMessagingSettings(orgId: string, patch: Partial<MessagingSettings>, actor: string) {
  const next = { ...messagingSettings(orgId), ...patch };
  update<Doc>('orgs', orgId, { messaging: next } as never);
  audit({ orgId, actor, action: 'messaging.settings_updated', detail: Object.keys(patch).join(', ') });
  return next;
}

/** The workspace's own clock — its first site, or UTC if it has none. */
export function messagingTimezone(orgId: string): string {
  const settings = messagingSettings(orgId);
  return settings.quietHours.timezone ?? locationsFor(orgId)[0]?.timezone ?? 'UTC';
}

/**
 * The next instant inside the allowed window.
 *
 * Returns the instant unchanged when it is already allowed, and otherwise the
 * start of the next window — so a reminder due at 03:12 waits until 08:00 rather
 * than being thrown away or delivered while the recipient is asleep.
 */
export function nextAllowedInstant(orgId: string, at: number = Date.now()): number {
  const { quietHours } = messagingSettings(orgId);
  const timezone = messagingTimezone(orgId);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(at));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const localMinutes = hour * 60 + minute;
  const start = Math.max(0, Math.min(23, quietHours.start)) * 60;
  const end = Math.max(0, Math.min(24, quietHours.end)) * 60;
  if (localMinutes >= start && localMinutes < end) return at;
  // Minutes until the window opens again (today if it has not opened yet).
  const wait = localMinutes < start ? start - localMinutes : 24 * 60 - localMinutes + start;
  return at + wait * 60_000;
}

/* --------------------------------------------------------------- reaching them */

export type Contact = { channel: MessageChannel; to: string; blockedReason?: string };

/**
 * Which channel this client can actually be reached on.
 *
 * The order is the order a practice would try: a number first (a text is read),
 * then an email. Within that, a channel the workspace has switched off, or one
 * this client has opted out of, is *skipped* if another will do — and if nothing
 * will do, the first contactable channel is returned anyway with the refusal
 * attached, so the blocked row names the reason instead of the message vanishing.
 * That is the same rule every sender follows: receipts, chases, recalls and the
 * wait-list offer all decide "who, how" in this one place.
 */
export function contactFor(
  orgId: string,
  input: { clientId?: string; number?: string; email?: string },
  preferred: MessageChannel[] = ['sms', 'email']
): Contact | undefined {
  const client = input.clientId ? get<Doc & { number?: string; email?: string }>('clients', input.clientId) : undefined;
  const number = String(input.number ?? client?.number ?? '').trim();
  const email = String(input.email ?? client?.email ?? '').trim();
  const settings = messagingSettings(orgId);

  const candidates: Contact[] = [];
  for (const channel of preferred) {
    if (channel === 'sms' && number) candidates.push({ channel: 'sms', to: number });
    if (channel === 'email' && email) candidates.push({ channel: 'email', to: email });
  }
  if (!candidates.length) return undefined;

  const allowed = (candidate: Contact) => {
    if (!settings.channels[candidate.channel]) {
      return { ok: false, reason: `${candidate.channel} is switched off for this workspace` };
    }
    const consent = consentFor(orgId, { id: input.clientId, number }, candidate.channel);
    return consent.granted ? { ok: true } : { ok: false, reason: consent.reason };
  };

  for (const candidate of candidates) {
    const verdict = allowed(candidate);
    if (verdict.ok) return candidate;
  }
  const first = candidates[0];
  const why = allowed(first);
  return { ...first, blockedReason: why.ok ? undefined : why.reason };
}

/* --------------------------------------------------------------- the queue */

export function messagesFor(orgId: string, filter?: (m: MessageDoc) => boolean) {
  return list<MessageDoc>('messages', (m) => m.orgId === orgId && (!filter || filter(m)));
}

export function messageById(orgId: string, id: string) {
  return get<MessageDoc>('messages', id) && (get<MessageDoc>('messages', id)!.orgId === orgId ? get<MessageDoc>('messages', id) : undefined);
}

export type QueueInput = {
  orgId: string;
  /** Optional deterministic id for retry-safe domain jobs. */
  id?: string;
  channel: MessageChannel;
  to: string;
  body: string;
  subject?: string;
  clientId?: string;
  bookingId?: string;
  sendAt?: string;
  source: string;
  meta?: Record<string, string>;
  /** Staff can insist; even then consent is checked, and the reason is recorded. */
  respectConsent?: boolean;
  /** Which job this message does — drives the outreach log and the reports. */
  kind?: OutreachKind;
  /**
   * Skip the quiet-hours deferral. Only for a message a person asked for *now*:
   * a desk replying to somebody who just rang is not marketing.
   */
  immediate?: boolean;
};

/**
 * Puts a message on the queue. It is not sent here — a send that happens when
 * the row is created cannot be scheduled, retried or cancelled, and every one of
 * those is a thing reminders need.
 */
export function queueMessage(input: QueueInput): MessageDoc {
  if (input.id) {
    const existing = get<MessageDoc>('messages', input.id);
    if (existing) {
      if (existing.orgId !== input.orgId) throw new Error('message id belongs to another workspace');
      return existing;
    }
  }
  const settings = messagingSettings(input.orgId);
  const consent = input.respectConsent === false ? undefined : consentFor(input.orgId, { id: input.clientId, number: input.to }, input.channel);
  const blocked = consent && !consent.granted;
  // A channel the workspace has turned off is a fact worth recording, not a
  // reason to silently drop the row.
  const channelOff = !settings.channels[input.channel];
  const requestedAt = input.sendAt ? new Date(input.sendAt).getTime() : Date.now();
  const sendAt = input.immediate || blocked || channelOff ? requestedAt : nextAllowedInstant(input.orgId, requestedAt);
  const doc: MessageDoc = {
    id: input.id ?? newId('msg_'),
    orgId: input.orgId,
    clientId: input.clientId,
    bookingId: input.bookingId,
    channel: input.channel,
    to: input.to,
    body: input.body,
    subject: input.subject,
    status: blocked || channelOff ? 'blocked' : 'pending',
    sendAt: new Date(sendAt).toISOString(),
    attempts: 0,
    reason: blocked ? consent?.reason ?? 'no consent on file' : channelOff ? `${input.channel} is switched off for this workspace` : undefined,
    source: input.source,
    kind: input.kind ?? (input.meta?.kind as OutreachKind | undefined) ?? 'unknown',
    meta: input.meta,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  } as MessageDoc;
  insert<MessageDoc>('messages', doc);
  if (input.clientId) {
    recordAccess({
      orgId: input.orgId,
      resource: 'client',
      resourceId: input.clientId,
      action: 'message',
      actor: input.source,
      detail: `${blocked ? 'blocked ' : ''}${input.channel} ${blocked ? `(${doc.reason})` : 'queued'}`,
    });
  }
  audit({
    orgId: input.orgId,
    actor: input.source,
    action: blocked || channelOff ? 'message.blocked' : 'message.queued',
    target: doc.id,
    detail: `${input.channel} → ${input.to}${blocked || channelOff ? ` (${doc.reason})` : ''}`,
  });
  // A refused message is an outreach fact too: "we tried and were not allowed to"
  // is exactly what a records-keeping system must be able to show.
  if (doc.status === 'blocked') {
    recordOutreach({
      orgId: input.orgId,
      clientId: input.clientId,
      bookingId: input.bookingId,
      channel: input.channel,
      kind: doc.kind as OutreachKind,
      outcome: 'blocked',
      to: input.to,
      messageId: doc.id,
      actor: input.source,
      detail: doc.reason,
    });
  }
  return doc;
}

export function cancelMessage(orgId: string, id: string, actor: string, reason = 'cancelled') {
  const existing = messageById(orgId, id);
  if (!existing) return undefined;
  if (existing.status === 'sent') return existing;
  return update<MessageDoc>('messages', id, { status: 'cancelled', reason, updatedAt: nowIso() } as never);
}

/**
 * What the carrier says happened after we handed the message over.
 *
 * "Sent" means a carrier accepted it, which is not the same as a phone buzzing.
 * The status callback upgrades the row when it can — `delivered` is a fact, and a
 * report that cannot tell the two apart is a report that overstates itself. It
 * **upgrades** the outreach row rather than appending one: one touch, one row, its
 * outcome refined as the truth arrives.
 */
export function applyDeliveryReceipt(input: {
  providerMessageId: string;
  status: string;
  errorCode?: string;
  errorMessage?: string;
}): { message?: MessageDoc; outreachOutcome?: 'delivered' | 'failed' } {
  const message = list<MessageDoc>('messages', (m) => m.providerMessageId === input.providerMessageId)[0];
  if (!message) return {};

  const failed = input.status === 'failed' || input.status === 'undelivered';
  // Provider webhooks are at-least-once and may arrive out of order. A terminal
  // failure/bounce must not later become "delivered" because an older callback
  // was retried after it.
  const delivered = input.status === 'delivered' && message.status !== 'failed';

  if (failed) {
    update<MessageDoc>('messages', message.id, {
      status: 'failed',
      reason: input.errorMessage ?? `carrier reported ${input.status}`,
      updatedAt: nowIso(),
    } as never);
  } else if (delivered) {
    update<MessageDoc>('messages', message.id, {
      meta: { ...(message.meta ?? {}), deliveredAt: nowIso() },
      updatedAt: nowIso(),
    } as never);
  }

  const row = list<OutreachDoc>('outreach', (o) => o.messageId === message.id)[0];
  if (row && (failed || delivered)) {
    update<OutreachDoc>('outreach', row.id, {
      outcome: failed ? 'failed' : 'delivered',
      detail: failed ? input.errorMessage ?? `carrier reported ${input.status}` : row.detail,
      updatedAt: nowIso(),
    } as never);
    return { message, outreachOutcome: failed ? 'failed' : 'delivered' };
  }
  return { message };
}

/* ------------------------------------------------------------- the delivery */

export type DeliveryOutcome =
  | { ok: true; provider: string; providerMessageId?: string; /** Which account it went through: the workspace's or the platform's. */ meta?: Record<string, string> }
  | { ok: false; reason: string };

export type MessageTransport = (message: MessageDoc, options?: { dryRun?: boolean }) => Promise<DeliveryOutcome>;

let transport: MessageTransport | undefined;

/** Tests and the media worker can swap the driver; production keeps the queue's own. */
export function setMessageTransport(next: MessageTransport | undefined) {
  transport = next;
}

/**
 * The default driver: records the send without pretending a carrier did it.
 *
 * This is honest on purpose. A build with no messaging provider configured says
 * so in the row (`provider: 'log'`), rather than a `sent` status that would make
 * a receptionist tell a patient to expect a text that never left the building.
 */
export const logTransport: MessageTransport = async (message) => ({
  ok: true,
  provider: 'log',
  providerMessageId: `log_${message.id}`,
});

/**
 * Sends everything that is due. Called by the maintenance sweep, and directly by
 * a route that wants to prove the path end to end.
 *
 * Returns a tally rather than throwing: one bad row must not stop the queue.
 */
export async function deliverDueMessages(
  options: { orgId?: string; limit?: number; dryRun?: boolean; now?: number } = {}
): Promise<{ sent: number; failed: number; blocked: number; skipped: number; messages: MessageDoc[] }> {
  const now = options.now ?? Date.now();
  const driver = transport ?? deliverWithProviders;
  const due = messagesFor(options.orgId ?? '', () => true)
    .filter((m) => (options.orgId ? m.orgId === options.orgId : true))
    .filter((m) => m.status === 'pending' && new Date(m.sendAt).getTime() <= now)
    .sort((a, b) => String(a.sendAt).localeCompare(String(b.sendAt)))
    .slice(0, options.limit ?? 25);

  let sent = 0;
  let failed = 0;
  let blocked = 0;
  const touched: MessageDoc[] = [];

  for (const message of due) {
    // The consent check at send time, because consent can be withdrawn in the
    // hours between queueing a reminder and the reminder going out.
    const consent = consentFor(message.orgId, { id: message.clientId, number: message.to }, message.channel);
    if (!consent.granted) {
      const updated = update<MessageDoc>('messages', message.id, {
        status: 'blocked',
        reason: consent.reason ?? 'consent withdrawn before send',
        updatedAt: nowIso(),
      } as never);
      if (updated) touched.push(updated);
      blocked += 1;
      recordOutreach({
        orgId: message.orgId,
        clientId: message.clientId,
        bookingId: message.bookingId,
        channel: message.channel,
        kind: (message.kind ?? 'unknown') as OutreachKind,
        outcome: 'blocked',
        to: message.to,
        messageId: message.id,
        actor: message.source,
        detail: consent.reason ?? 'consent withdrawn before send',
      });
      continue;
    }

    // Quiet hours apply at send time as well as queue time: a reminder queued
    // inside the window can still come due after it closes.
    const allowedAt = nextAllowedInstant(message.orgId, now);
    if (allowedAt > now && message.kind === 'reminder') {
      const deferred = update<MessageDoc>('messages', message.id, {
        sendAt: new Date(allowedAt).toISOString(),
        reason: undefined,
        updatedAt: nowIso(),
      } as never);
      if (deferred) touched.push(deferred);
      continue;
    }

    let outcome: DeliveryOutcome;
    try {
      outcome = await driver(message, { dryRun: options.dryRun });
    } catch (error) {
      outcome = { ok: false, reason: error instanceof Error ? error.message : 'transport threw' };
    }

    const attempts = (message.attempts ?? 0) + 1;
    const settings = messagingSettings(message.orgId);
    if (outcome.ok) {
      const updated = update<MessageDoc>('messages', message.id, {
        status: 'sent',
        sentAt: nowIso(),
        attempts,
        provider: outcome.provider,
        providerMessageId: outcome.providerMessageId,
        deliveryMeta: outcome.meta,
        reason: undefined,
        updatedAt: nowIso(),
      } as never);
      if (updated) touched.push(updated);
      sent += 1;
      recordOutreach({
        orgId: message.orgId,
        clientId: message.clientId,
        bookingId: message.bookingId,
        channel: message.channel,
        kind: (message.kind ?? 'unknown') as OutreachKind,
        outcome: 'sent',
        to: message.to,
        messageId: message.id,
        actor: message.source,
        detail: message.subject ? `${message.subject}` : undefined,
        meta: {
          provider: outcome.provider ?? 'unknown',
          ...(outcome.providerMessageId ? { providerMessageId: outcome.providerMessageId } : {}),
          ...(outcome.meta ?? {}),
        },
      });
    } else {
      const exhausted = attempts >= settings.maxAttempts;
      const updated = update<MessageDoc>('messages', message.id, {
        status: exhausted ? 'failed' : 'pending',
        attempts,
        // A retry waits a little, so a carrier that is down for a minute is not
        // hammered three times in the same second.
        sendAt: exhausted ? message.sendAt : new Date(now + 5 * 60_000 * attempts).toISOString(),
        reason: outcome.reason,
        updatedAt: nowIso(),
      } as never);
      if (updated) touched.push(updated);
      failed += 1;
      if (exhausted) {
        recordOutreach({
          orgId: message.orgId,
          clientId: message.clientId,
          bookingId: message.bookingId,
          channel: message.channel,
          kind: (message.kind ?? 'unknown') as OutreachKind,
          outcome: 'failed',
          to: message.to,
          messageId: message.id,
          actor: message.source,
          detail: outcome.reason,
        });
      }
    }
  }

  const skipped = messagesFor(options.orgId ?? '', () => true).filter((m) => m.status === 'pending').length;
  return { sent, failed, blocked, skipped, messages: touched };
}

/**
 * Cancelling an appointment cancels its reminders.
 *
 * A reminder for a visit that is not happening is worse than no reminder: it
 * sends somebody to an empty waiting room on a day the practice is closed.
 */
export function cancelRemindersFor(orgId: string, bookingId: string, reason = 'appointment cancelled') {
  const pending = messagesFor(orgId, (m) => m.bookingId === bookingId && m.meta?.kind === 'reminder' && m.status === 'pending');
  for (const message of pending) {
    update<MessageDoc>('messages', message.id, { status: 'cancelled', reason, updatedAt: nowIso() } as never);
  }
  return pending.length;
}

/* ------------------------------------------------------- templates & context */

/**
 * Everything a template can say about one appointment.
 *
 * Built once, here, so the reminder, the confirmation, the "we missed you" text
 * and the email all describe the same appointment the same way — and so a new
 * merge field is added in one place.
 */
export function bookingContext(orgId: string, booking: BookingDoc, clientName?: string): MergeContext {
  const site = booking.locationId ? locationsFor(orgId).find((l) => l.id === booking.locationId) : undefined;
  // The appointment's own timezone wins: a booking made against the New York site
  // must be described in New York time, whatever the workspace default is.
  const timezone = booking.timezone ?? site?.timezone ?? messagingTimezone(orgId);
  const provider = booking.providerId ? providerById(orgId, String(booking.providerId)) : undefined;
  const service = booking.serviceId ? serviceById(orgId, String(booking.serviceId)) : undefined;
  const terms = termsForOrg(orgId);
  const starts = new Date(String(booking.startsAt));
  const name = clientName ?? booking.customer.name;

  return {
    client_first_name: name.split(/\s+/)[0] || 'there',
    client_name: name,
    appointment: terms.appointment.one,
    service: service?.name ?? booking.service ?? terms.appointment.One,
    provider: provider?.name ?? '',
    location: site?.name ?? '',
    when: `${starts.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: timezone })} at ${formatClock(starts.getTime(), timezone)}`,
    when_date: starts.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: timezone }),
    when_time: formatClock(starts.getTime(), timezone),
    reference: String(booking.externalId ?? ''),
    business: termsForOrg(orgId) && orgName(orgId),
    // The client's own link to this appointment. Empty when the deployment does
    // not know its own public address — a template that uses it then renders a
    // line with nothing in it, which `renderTemplate` collapses rather than
    // leaving "Change it here: " hanging in a text.
    manage_link: (() => {
      return manageLinkFor(orgId, booking.id) ?? '';
    })(),
  };
}

function orgName(orgId: string) {
  const org = get<Doc & { name?: string }>('orgs', orgId);
  return String(org?.name ?? 'the practice');
}

/**
 * Renders the message for a job, from the workspace's template.
 *
 * Falls back to a simple sentence when a workspace has no template for that kind
 * (they may have retired them all) — a booking still deserves a confirmation.
 */
export function composeBookingMessage(input: {
  orgId: string;
  kind: OutreachKind;
  channel: MessageChannel;
  booking: BookingDoc;
  clientName?: string;
  fallback: string;
}): { body: string; subject?: string; templateId?: string } {
  const context = bookingContext(input.orgId, input.booking, input.clientName);
  const rendered = renderFor({ orgId: input.orgId, kind: input.kind as never, channel: input.channel, context, fallback: input.fallback });
  return { body: rendered.body, subject: rendered.subject, templateId: rendered.templateId };
}

/* ------------------------------------------------------------------ helpers */

/** The body of a booking confirmation, in the workspace's own words. */
export function confirmationBody(input: {
  clientName: string;
  when: string;
  service: string;
  provider?: string;
  site?: string;
  reference?: string;
  /** The client's own link, when this deployment has a public address to build it from. */
  manageLink?: string;
  terms: { appointment: { one: string }; provider: { one: string } };
}): string {
  const where = input.site ? ` at ${input.site}` : '';
  const with_ = input.provider ? ` with ${input.provider}` : '';
  const link = input.manageLink ? ` Need to change it? ${input.manageLink}` : '';
  return `Hi ${input.clientName.split(/\s+/)[0]} — your ${input.terms.appointment.one} is ${input.when}${with_}${where}. ${input.service}.${input.reference ? ` Reference ${input.reference}.` : ''}${link} Reply STOP to opt out.`;
}
