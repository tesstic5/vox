import { NextResponse, type NextRequest } from 'next/server';
import { clientIp, fail, ok, publicOrigin, rateLimit, rateHeaders, readJson, requestId } from '@/lib/server/api';
import { requestMagicLink } from '@/lib/server/auth-flows';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/auth/magic/request — mail a single-use sign-in link. */
export async function POST(req: NextRequest) {
  const rid = requestId();
  const limit = rateLimit(`magic-ip:${clientIp(req)}`, 15, 15 * 60_000);
  if (!limit.allowed) {
    return fail('RATE_LIMITED', 'Too many sign-in links requested from this address. Try again shortly.', {
      requestId: rid,
      headers: { 'retry-after': String(Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 1000))), ...rateHeaders(limit) },
    });
  }
  const body = await readJson<{ email?: string }>(req);
  if (body instanceof NextResponse) return body;
  const email = (body.email ?? '').trim().toLowerCase();
  if (!email) return fail('VALIDATION_ERROR', 'Send the `email` address to sign in.', { param: 'email', requestId: rid });

  // Per-address, like the reset form, and silent for the same reason.
  const perAddress = rateLimit(`magic-mail:${email}`, 3, 15 * 60_000);
  if (!perAddress.allowed) return ok({ requested: true, expiresInMinutes: 15, email }, { requestId: rid });

  const result = await requestMagicLink(email, { origin: publicOrigin(req), ip: clientIp(req) });
  if ('ok' in result && result.ok === false) {
    return fail(result.error === 'EMAIL_UNAVAILABLE' ? 'EMAIL_UNAVAILABLE' : 'INTERNAL_ERROR', result.message, { requestId: rid });
  }
  const sent = result as { requested: true; expiresInMinutes: number };
  return ok({ requested: true, expiresInMinutes: sent.expiresInMinutes, email }, { requestId: rid });
}
