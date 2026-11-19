import { NextResponse, type NextRequest } from 'next/server';
import { clientIp, fail, ok, rateLimit, rateHeaders, readJson, requestId, publicOrigin } from '@/lib/server/api';
import { requestPasswordReset } from '@/lib/server/auth-flows';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/password/request — mail a single-use reset link.
 *
 * The answer is the same whether or not the address exists: `{requested:true}`.
 * A reset form that says "no account with that email" is an account-enumeration
 * oracle, and the person who owns the address learns nothing extra from the
 * identical reply.
 */
export async function POST(req: NextRequest) {
  const rid = requestId();
  // Two limits, because they defend different things.
  //
  // The address limit stops somebody using this form to bomb one person's inbox
  // from many machines. It answers exactly like a successful request, because
  // telling a stranger "that address is over the limit" is telling them the
  // address exists.
  //
  // The address-of-origin limit defends the platform and gets an honest 429.
  const limit = rateLimit(`pwreset-ip:${clientIp(req)}`, 15, 15 * 60_000);
  if (!limit.allowed) {
    return fail('RATE_LIMITED', 'Too many reset requests from this address. Try again shortly.', {
      requestId: rid,
      headers: { 'retry-after': String(Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 1000))), ...rateHeaders(limit) },
    });
  }
  const body = await readJson<{ email?: string }>(req);
  if (body instanceof NextResponse) return body;
  const email = (body.email ?? '').trim().toLowerCase();
  if (!email) return fail('VALIDATION_ERROR', 'Send the `email` address to reset.', { param: 'email', requestId: rid });

  const perAddress = rateLimit(`pwreset-mail:${email}`, 3, 15 * 60_000);
  if (!perAddress.allowed) {
    return ok({ requested: true, expiresInMinutes: 15, email }, { requestId: rid });
  }

  const result = await requestPasswordReset(email, { origin: publicOrigin(req), ip: clientIp(req) });
  if ('ok' in result && result.ok === false) {
    return fail(result.error === 'EMAIL_UNAVAILABLE' ? 'EMAIL_UNAVAILABLE' : 'INTERNAL_ERROR', result.message, { requestId: rid });
  }
  const sent = result as { requested: true; expiresInMinutes: number };
  return ok({ requested: true, expiresInMinutes: sent.expiresInMinutes, email }, { requestId: rid });
}
