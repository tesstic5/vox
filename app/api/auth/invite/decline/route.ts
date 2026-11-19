import { NextResponse, type NextRequest } from 'next/server';
import { clientIp, fail, ok, rateLimit, readJson, requestId } from '@/lib/server/api';
import { declineInvite } from '@/lib/server/auth-flows';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/auth/invite/decline — cancel the invitation behind this link. */
export async function POST(req: NextRequest) {
  const rid = requestId();
  const limit = rateLimit(`invdecline:${clientIp(req)}`, 60, 15 * 60_000);
  if (!limit.allowed) return fail('RATE_LIMITED', 'Too many attempts. Wait a minute.', { requestId: rid });
  const body = await readJson<{ token?: string }>(req);
  if (body instanceof NextResponse) return body;
  const token = String(body.token ?? '').trim();
  if (!token) return fail('VALIDATION_ERROR', 'Pass the `token` from the invitation link.', { param: 'token', requestId: rid });
  return ok(declineInvite(token), { requestId: rid });
}
