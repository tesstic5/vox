import { type NextRequest } from 'next/server';
import { clientIp, fail, ok, publicOrigin, rateLimit, requestId } from '@/lib/server/api';
import { currentUser } from '@/lib/server/auth';
import { sendVerificationCode, verificationSummary } from '@/lib/server/auth-flows';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET  /api/auth/verify — what the verify screen needs on load.
 * POST /api/auth/verify — send (or re-send) the six-digit code.
 *
 * Both need a session, because the code belongs to the account that is signed
 * in: there is no way to ask for somebody else's code, and no email address in
 * the request to spoof.
 */
export async function GET(req: NextRequest) {
  const rid = requestId();
  const session = await currentUser();
  if (!session) return fail('UNAUTHORIZED', 'Sign in first — verification codes belong to an account.', { requestId: rid });
  return ok(verificationSummary(session.user), { requestId: rid });
}

export async function POST(req: NextRequest) {
  const rid = requestId();
  const session = await currentUser();
  if (!session) return fail('UNAUTHORIZED', 'Sign in first — verification codes belong to an account.', { requestId: rid });

  // Per account, not per address. The person asking is signed in, so the identity
  // is known — and limiting by IP would punish a whole practice behind one office
  // connection for one person's clicking.
  const limit = rateLimit(`verify-send:${session.user.id}`, 10, 15 * 60_000);
  if (!limit.allowed) {
    return fail('RATE_LIMITED', 'That is a lot of codes. Wait a few minutes before asking for another.', {
      requestId: rid,
      headers: { 'retry-after': '60' },
    });
  }

  const result = await sendVerificationCode(session.user, { origin: publicOrigin(req), ip: clientIp(req) });
  if (!result.ok) {
    const code = result.error === 'LOCKED' ? 'CONFLICT' : result.error === 'EMAIL_UNAVAILABLE' ? 'EMAIL_UNAVAILABLE' : 'VALIDATION_ERROR';
    return fail(code, result.message, { requestId: rid, headers: result.retryAt ? { 'retry-after': '3600' } : undefined });
  }
  if (result.alreadyVerified) return ok({ sent: false, alreadyVerified: true, email: result.to }, { requestId: rid });
  return ok({ sent: true, email: result.to, expiresAt: result.expiresAt, attemptsLeft: result.attemptsLeft }, { requestId: rid });
}
