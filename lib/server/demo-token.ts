/**
 * Signed tokens for the public demo line.
 *
 * A visitor has no account, so a demo turn is authorised by a token bound to a
 * single call id with a 30-minute expiry. Same shape as a download URL: HMAC
 * over `callId:expires`, compared in constant time.
 */

import crypto from 'node:crypto';

/**
 * The signing secret for the public demo line.
 *
 * This used to fall back to the literal `'voxera-demo-secret'` in every
 * environment. A hard-coded secret is not a secret: anyone who has read this file
 * can mint a token for any call id, and on a public deployment that means driving
 * somebody else's demo call. It was found by the production pass, not by a gate —
 * every gate ran against a local build where the fallback was harmless.
 *
 * The order is now: the deployment's own secret, then one derived from
 * `VOXERA_SECRET_KEY` (which production is already told to set), then a random
 * per-process value in production — unverifiable across restarts or instances but
 * never forgeable — and only in development the old fixed string, where it buys
 * nothing an attacker does not already have.
 */
let ephemeral: string | undefined;
function secret() {
  const configured = process.env.VOXERA_DEMO_SECRET?.trim();
  if (configured) return configured;
  const master = process.env.VOXERA_SECRET_KEY;
  if (master) return crypto.createHash('sha256').update(`demo:${master}`).digest('hex');
  if (process.env.NODE_ENV === 'production') {
    ephemeral ??= crypto.randomBytes(32).toString('hex');
    return ephemeral;
  }
  return 'voxera-demo-secret';
}

export function demoToken(callId: string, expires: number) {
  return crypto.createHmac('sha256', secret()).update(`${callId}:${expires}`).digest('base64url');
}

export function verifyDemoToken(callId: string, token: string) {
  const [expiresRaw, signature] = token.split('.');
  const expires = Number(expiresRaw);
  if (!expires || !signature || expires < Date.now()) return false;
  const expected = demoToken(callId, expires);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
