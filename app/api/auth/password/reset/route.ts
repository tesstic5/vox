import { NextResponse, type NextRequest } from 'next/server';
import { clientIp, fail, ok, rateLimit, rateHeaders, readJson, requestId } from '@/lib/server/api';
import { completePasswordReset } from '@/lib/server/auth-flows';
import { createSession, setSessionCookie, sha256 } from '@/lib/server/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/password/reset — spend the link and set the new password.
 *
 * Two things happen that the screens have always promised: every live session is
 * ended, and then one fresh session is started for the browser that just proved
 * it holds the link. Net effect — the laptop that was signed in somewhere else
 * is signed out, and the person doing the reset is not asked to log in again.
 */
export async function POST(req: NextRequest) {
  const rid = requestId();
  // Aimed at the token, not the address. The token is what an attacker would
  // have to guess, and a practice behind one office connection has a dozen
  // people who might legitimately reset a password in the same quarter hour.
  const limit = rateLimit(`pwreset-do:${clientIp(req)}`, 60, 15 * 60_000);
  if (!limit.allowed) {
    return fail('RATE_LIMITED', 'Too many attempts from this address. Try again shortly.', {
      requestId: rid,
      headers: { 'retry-after': '60', ...rateHeaders(limit) },
    });
  }
  const body = await readJson<{ token?: string; password?: string }>(req);
  if (body instanceof NextResponse) return body;
  const token = String(body.token ?? '').trim();
  if (!token) return fail('VALIDATION_ERROR', 'That reset link is missing its token.', { param: 'token', requestId: rid });
  const perToken = // Hashed, not the token itself: rate-limit buckets are database rows, and a
  // credential must not be readable from the table that throttles it.
  rateLimit(`pwreset-tok:${sha256(token)}`, 5, 15 * 60_000);
  if (!perToken.allowed) return fail('RATE_LIMITED', 'Too many attempts on that link. Request a fresh one.', { requestId: rid });

  const result = await completePasswordReset(token, String(body.password ?? ''), {
    ip: clientIp(req),
    userAgent: req.headers.get('user-agent') ?? 'unknown',
  });
  if (!result.ok) {
    const code =
      result.error === 'VALIDATION_ERROR'
        ? 'VALIDATION_ERROR'
        : result.error === 'FORBIDDEN'
          ? 'FORBIDDEN'
          : result.error.endsWith('EXPIRED') || result.error.endsWith('USED') || result.error.endsWith('REVOKED') || result.error.endsWith('LOCKED')
            ? 'CONFLICT'
            : 'VALIDATION_ERROR';
    return fail(code, result.message, { param: result.param, requestId: rid });
  }

  const { token: sessionToken, session } = createSession(result.user, {
    userAgent: req.headers.get('user-agent') ?? 'unknown',
    ip: clientIp(req),
  });
  await setSessionCookie(sessionToken);

  return ok(
    {
      reset: true,
      email: result.email,
      sessionsEnded: result.sessionsEnded,
      session: { id: session.id, expiresAt: session.expiresAt },
    },
    { requestId: rid }
  );
}
