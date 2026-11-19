import crypto from 'node:crypto';

export type ResendWebhookEvent = {
  type: string;
  created_at?: string;
  data?: {
    email_id?: string;
    message_id?: string;
    bounce?: { message?: string; type?: string; subType?: string };
    failed?: { reason?: string };
    [key: string]: unknown;
  };
};

function signingKey(secret: string) {
  const encoded = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const key = Buffer.from(encoded, 'base64');
  if (key.length < 16) throw new Error('invalid Resend webhook secret');
  return key;
}

function equalBase64(expected: Buffer, candidate: string) {
  let actual: Buffer;
  try {
    actual = Buffer.from(candidate, 'base64');
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** Verify the raw Standard Webhooks/Svix envelope used by Resend. */
export function verifyResendWebhook(input: {
  payload: string;
  id: string;
  timestamp: string;
  signature: string;
  secret: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): ResendWebhookEvent {
  if (!input.id || !input.timestamp || !input.signature) throw new Error('missing Resend webhook headers');
  const timestamp = Number(input.timestamp);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? 300;
  if (!Number.isInteger(timestamp) || Math.abs(now - timestamp) > tolerance) throw new Error('stale Resend webhook');

  const signed = `${input.id}.${input.timestamp}.${input.payload}`;
  const expected = crypto.createHmac('sha256', signingKey(input.secret)).update(signed).digest();
  const candidates = input.signature
    .split(/\s+/)
    .map((part) => part.split(',', 2))
    .filter(([version, value]) => version === 'v1' && Boolean(value))
    .map(([, value]) => value);
  if (!candidates.some((candidate) => equalBase64(expected, candidate))) throw new Error('invalid Resend webhook signature');

  const event = JSON.parse(input.payload) as ResendWebhookEvent;
  if (!event || typeof event.type !== 'string' || typeof event.data?.email_id !== 'string') throw new Error('invalid Resend webhook payload');
  return event;
}

export function resendReceipt(event: ResendWebhookEvent): { status?: 'delivered' | 'failed'; reason?: string; withdrawConsent: boolean } {
  switch (event.type) {
    case 'email.delivered':
      return { status: 'delivered', withdrawConsent: false };
    case 'email.bounced': {
      // A temporary mailbox/provider condition is still a failed attempt, but it
      // is not evidence that the recipient withdrew permission or that the
      // address is permanently unusable. Only Resend's explicit Permanent class
      // closes future email consent; complaints and suppression do so below.
      const permanent = event.data?.bounce?.type?.trim().toLowerCase() === 'permanent';
      return { status: 'failed', reason: event.data?.bounce?.message ?? 'email bounced', withdrawConsent: permanent };
    }
    case 'email.complained':
      return { status: 'failed', reason: 'recipient reported the email as spam', withdrawConsent: true };
    case 'email.suppressed':
      return { status: 'failed', reason: 'email provider suppressed the recipient', withdrawConsent: true };
    case 'email.failed':
      return { status: 'failed', reason: event.data?.failed?.reason ?? 'email provider reported failure', withdrawConsent: false };
    default:
      return { withdrawConsent: false };
  }
}
