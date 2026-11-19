import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, rateLimit, readJson, requestId } from '@/lib/server/api';
import { currentUser } from '@/lib/server/auth';
import { confirmVerificationCode } from '@/lib/server/auth-flows';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/auth/verify/confirm — spend a six-digit code. */
export async function POST(req: NextRequest) {
  const rid = requestId();
  const session = await currentUser();
  if (!session) return fail('UNAUTHORIZED', 'Sign in first — verification codes belong to an account.', { requestId: rid });

  // Per account: the attempt budget that matters is the one on the code itself
  // (five wrong guesses), and this limiter only exists to stop a script grinding
  // through codes faster than a person could.
  const limit = rateLimit(`verify-do:${session.user.id}`, 60, 15 * 60_000);
  if (!limit.allowed) {
    return fail('RATE_LIMITED', 'Too many attempts. Wait a minute.', { requestId: rid, headers: { 'retry-after': '60' } });
  }

  const body = await readJson<{ code?: string }>(req);
  if (body instanceof NextResponse) return body;

  const result = await confirmVerificationCode(session.user, String(body.code ?? ''));
  if (!result.ok) {
    const code = result.error === 'LOCKED' ? 'CONFLICT' : result.error === 'WRONG_CODE' ? 'VALIDATION_ERROR' : 'VALIDATION_ERROR';
    return fail(code, result.message, {
      param: result.error === 'WRONG_CODE' ? 'code' : undefined,
      requestId: rid,
      ...(result.attemptsLeft !== undefined ? { detail: `attempts_left:${result.attemptsLeft}` } : {}),
    });
  }

  return ok(
    {
      verified: true,
      alreadyVerified: Boolean(result.alreadyVerified),
      email: result.user.email,
      // Said out loud because it is what verification actually buys.
      unlocks: ['publish an assistant', 'buy a phone number', 'create API keys'],
    },
    { requestId: rid }
  );
}
