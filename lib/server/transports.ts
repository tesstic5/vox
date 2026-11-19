/**
 * How a message actually leaves the building.
 *
 * One function, two channels, three answers:
 *
 *   - **SMS through the carrier.** The workspace's own connected carrier, sending
 *     from a number the workspace owns. If there is no carrier, the send fails and
 *     says so — it does not silently downgrade to a log line, because a
 *     confirmation that says "sent" while nothing left the building is the exact
 *     lie this phase exists to remove.
 *   - **Email through an HTTP provider**, configured with `VOXERA_EMAIL_PROVIDER`,
 *     `VOXERA_EMAIL_API_BASE` and `VOXERA_EMAIL_API_KEY`. The generic relay keeps
 *     Voxera's documented contract; the explicit Resend adapter translates
 *     metadata to provider-native tags rather than assuming stub JSON is portable.
 *   - **The log**, when neither is configured — and it says `log` in the row, so
 *     nobody mistakes it for delivery.
 *
 * Tests point the email relay at the provider stub; `setMessageTransport` still
 * overrides everything for a unit-level check.
 */

import { list } from './db';
import { dialerFor, MANAGED_CARRIER_ID } from './managed';
import { sendMessage as twilioSend } from './providers/twilio';
import { emailRelayAvailable, sendRelayEmail } from './email-relay';
import type { CarrierDoc } from './carriers';
import type { DeliveryOutcome, MessageDoc } from './messages';

export type TransportName = 'twilio' | 'email' | 'log';

export function transportsAvailable() {
  return {
    sms: Boolean(list<CarrierDoc>('carriers', () => true).length) || process.env.VOXERA_MANAGED_TWILIO_ENABLED === '1',
    email: emailRelayAvailable(),
    emailFrom: process.env.VOXERA_EMAIL_FROM ?? 'no-reply@voxera.email',
  };
}

/** A real active carrier-backed caller ID owned by this workspace and carrier. */
export function sendingNumberFor(orgId: string, preferredId?: string, carrierId?: string): string | undefined {
  const numbers = list<{
    id: string;
    orgId?: string;
    number?: string;
    carrierId?: string;
    carrierSid?: string;
    status?: string;
  } & Record<string, unknown>>(
    'numbers',
    (n) =>
      n.orgId === orgId &&
      n.status === 'active' &&
      Boolean(n.carrierId && n.carrierSid) &&
      (!carrierId || n.carrierId === carrierId) &&
      /^\+[1-9]\d{7,14}$/.test(String(n.number ?? ''))
  );
  const chosen = preferredId ? numbers.find((n) => n.id === preferredId) : numbers[0];
  return chosen ? String(chosen.number) : undefined;
}

/**
 * Sends one queued message.
 *
 * The org's carrier decides the SMS route: a workspace carrier if it has one, the
 * platform's otherwise. `managed` id is checked the same way a campaign does it,
 * so a message and a call placed by the same workspace travel the same path.
 */
export async function deliverWithProviders(message: MessageDoc): Promise<DeliveryOutcome> {
  const orgId = String(message.orgId);

  if (message.channel === 'email') {
    const sent = await sendRelayEmail({
      to: message.to,
      subject: message.subject ?? 'Your appointment',
      text: message.body,
      metadata: { messageId: message.id, orgId },
    });
    if (!sent.ok) return sent;
    return { ok: true, provider: 'email', providerMessageId: sent.id };
  }

  // ---- SMS through the carrier -----------------------------------------
  // The same account the workspace's calls go through: its own carrier when it has
  // connected one, the platform's when it has not. A text and a call placed by the
  // same practice should leave by the same door.
  const carrier = dialerFor(orgId);
  if (!carrier) {
    return { ok: false, reason: 'No carrier connected — connect one at Dashboard → Carriers to send texts.' };
  }
  const via = carrier.id === MANAGED_CARRIER_ID ? 'managed' : 'workspace';
  const from = sendingNumberFor(orgId, message.meta?.numberId, carrier.id);
  if (!from) {
    return { ok: false, reason: 'This workspace owns no number to send from.' };
  }

  const sent = await twilioSend(carrier, {
    to: message.to,
    from,
    body: message.body,
    statusCallback: `${carrier.webhookBase}/api/telephony/twilio/message-status`,
  });
  if (!sent.ok) return { ok: false, reason: `carrier refused: ${sent.error}` };
  // Twilio answers 201 with `queued` — accepted by the carrier is the honest
  // reading, and the status callback upgrades it to `delivered` if it gets there.
  return { ok: true, provider: 'twilio', providerMessageId: sent.data.sid, meta: { via, from } };
}
