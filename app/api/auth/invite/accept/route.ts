import { NextResponse, type NextRequest } from 'next/server';
import { clientIp, fail, ok, rateLimit, rateHeaders, readJson, requestId } from '@/lib/server/api';
import { acceptInvite } from '@/lib/server/auth-flows';
import { setSessionCookie, sha256 } from '@/lib/server/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/invite/accept — pick a password, join the workspace, sign in.
 *
 * The temporary password the inviter can read out is *replaced* here rather than
 * supplemented: after this call the only way in is the password the invitee
 * chose. Accepting also verifies the address, because the invitation link
 * arrived in that person's inbox.
 */
export async function POST(req: NextRequest) {
  const rid = requestId();
  const limit = rateLimit(`invdo:${clientIp(req)}`, 60, 15 * 60_000);
  if (!limit.allowed) {
    return fail('RATE_LIMITED', 'Too many attempts from this address. Try again shortly.', {
      requestId: rid,
      headers: { 'retry-after': '60', ...rateHeaders(limit) },
    });
  }

  const body = await readJson<{ token?: string; name?: string; password?: string }>(req);
  if (body instanceof NextResponse) return body;
  const token = String(body.token ?? '').trim();
  if (!token) return fail('VALIDATION_ERROR', 'That invitation link is missing its token.', { param: 'token', requestId: rid });
  const perToken = // Hashed, not the token itself: rate-limit buckets are database rows, and a
  // credential must not be readable from the table that throttles it.
  rateLimit(`inv-tok:${sha256(token)}`, 5, 15 * 60_000);
  if (!perToken.allowed) return fail('RATE_LIMITED', 'Too many attempts on that invitation. Ask for a new link.', { requestId: rid });

  const result = await acceptInvite(
    token,
    { name: body.name, password: String(body.password ?? '') },
    { ip: clientIp(req), userAgent: req.headers.get('user-agent') ?? 'unknown' }
  );
  if (!result.ok) {
    const code =
      result.error === 'VALIDATION_ERROR'
        ? 'VALIDATION_ERROR'
        : result.error === 'FORBIDDEN'
          ? 'FORBIDDEN'
          : result.error.startsWith('TOKEN_')
            ? 'CONFLICT'
            : 'VALIDATION_ERROR';
    return fail(code, result.message, { param: result.param, requestId: rid });
  }

  await setSessionCookie(result.session.token);
  return ok({ joined: true, org: result.org, role: result.role, email: result.user.email, user: { id: result.user.id, name: result.user.name } }, { requestId: rid, status: 201 });
}
