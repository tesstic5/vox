import { type NextRequest } from 'next/server';
import { clientIp, fail, ok, rateLimit, requestId } from '@/lib/server/api';
import { passwordResetState } from '@/lib/server/auth-flows';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/password/state?token=… — is this reset link still usable?
 *
 * Read-only: it never spends the token, because the page that calls it is a
 * landing screen a mail client may have already fetched. Only pressing the
 * button spends anything.
 */
export async function GET(req: NextRequest) {
  const rid = requestId();
  const limit = rateLimit(`pwstate:${clientIp(req)}`, 60);
  if (!limit.allowed) return fail('RATE_LIMITED', 'Too many attempts. Wait a minute.', { requestId: rid });

  const token = new URL(req.url).searchParams.get('token') ?? '';
  if (!token) return fail('VALIDATION_ERROR', 'Pass the `token` from the reset link.', { param: 'token', requestId: rid });
  return ok(passwordResetState(token), { requestId: rid });
}
