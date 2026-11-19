import type { NextRequest } from 'next/server';
import { externalPublicOrigin } from './api';
import { authTokenForNumber, resolveTenantByNumber, verifyTwilioSignature } from './telephony';

/** Canonical public URL Twilio signed; never substitute an untrusted Host in production. */
export function twilioWebhookUrl(req: NextRequest): string | undefined {
  const incoming = new URL(req.url);
  const origin = externalPublicOrigin(req);
  if (!origin) return undefined;
  return `${origin}${incoming.pathname}${incoming.search}`;
}

/**
 * Verify a form callback with the token belonging to the workspace number in
 * the payload/call. The deployment token remains the fallback for an explicitly
 * configured managed carrier account.
 */
export function verifyTwilioWebhook(req: NextRequest, params: Record<string, string>, numberCandidates: Array<string | undefined>) {
  const url = twilioWebhookUrl(req);
  if (!url) return { ok: false, enforced: false, reason: 'no trusted public callback URL is configured' };
  const number = numberCandidates.find((candidate) => Boolean(candidate && resolveTenantByNumber(candidate)));
  return verifyTwilioSignature({
    signature: req.headers.get('x-twilio-signature'),
    url,
    params,
    authToken: number ? authTokenForNumber(number) : process.env.TWILIO_AUTH_TOKEN,
  });
}
