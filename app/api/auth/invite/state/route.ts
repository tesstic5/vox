import { type NextRequest } from 'next/server';
import { clientIp, fail, ok, rateLimit, requestId } from '@/lib/server/api';
import { inviteState } from '@/lib/server/auth-flows';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/invite/state?token=… — what the invitation screen renders.
 *
 * Public by necessity: the whole point is that the person has no account yet.
 * The token *is* the credential, so the answer contains only what the invited
 * person already knows — their own address, the workspace, who invited them.
 */
export async function GET(req: NextRequest) {
  const rid = requestId();
  const limit = rateLimit(`invstate:${clientIp(req)}`, 60);
  if (!limit.allowed) return fail('RATE_LIMITED', 'Too many attempts. Wait a minute.', { requestId: rid });

  const token = new URL(req.url).searchParams.get('token') ?? '';
  if (!token) return fail('VALIDATION_ERROR', 'Pass the `token` from the invitation link.', { param: 'token', requestId: rid });
  return ok(inviteState(token), { requestId: rid });
}
