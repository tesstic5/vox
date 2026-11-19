import { type NextRequest } from 'next/server';
import { clientIp, fail, ok, rateLimit, requestId } from '@/lib/server/api';
import { magicLinkState } from '@/lib/server/auth-flows';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/auth/magic/state?token=… — read-only check for the landing screen. */
export async function GET(req: NextRequest) {
  const rid = requestId();
  const limit = rateLimit(`magicstate:${clientIp(req)}`, 60);
  if (!limit.allowed) return fail('RATE_LIMITED', 'Too many attempts. Wait a minute.', { requestId: rid });

  const token = new URL(req.url).searchParams.get('token') ?? '';
  if (!token) return fail('VALIDATION_ERROR', 'Pass the `token` from the sign-in link.', { param: 'token', requestId: rid });
  return ok(magicLinkState(token), { requestId: rid });
}
