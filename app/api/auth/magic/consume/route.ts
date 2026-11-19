import { NextResponse, type NextRequest } from 'next/server';
import { clientIp, fail, ok, rateLimit, readJson, requestId } from '@/lib/server/api';
import { consumeMagicLink } from '@/lib/server/auth-flows';
import { setSessionCookie, sha256 } from '@/lib/server/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/magic/consume — swap the link for a session.
 *
 * A POST rather than a GET, deliberately: mail providers and security scanners
 * happily fetch every link in a message, and a GET that signs people in means a
 * scanner burns the link before its owner clicks it. The landing page reads the
 * token (GET .../state) and this call does the spending.
 */
export async function POST(req: NextRequest) {
  const rid = requestId();
  const limit = rateLimit(`magicdo:${clientIp(req)}`, 60, 15 * 60_000);
  if (!limit.allowed) return fail('RATE_LIMITED', 'Too many sign-in attempts. Wait a minute and try again.', { requestId: rid });

  const body = await readJson<{ token?: string }>(req);
  if (body instanceof NextResponse) return body;
  const token = String(body.token ?? '').trim();
  if (!token) return fail('VALIDATION_ERROR', 'That sign-in link is missing its token.', { param: 'token', requestId: rid });
  const perToken = // Hashed, not the token itself: rate-limit buckets are database rows, and a
  // credential must not be readable from the table that throttles it.
  rateLimit(`magic-tok:${sha256(token)}`, 5, 15 * 60_000);
  if (!perToken.allowed) return fail('RATE_LIMITED', 'Too many attempts on that link. Request a fresh one.', { requestId: rid });

  const result = await consumeMagicLink(token, {
    ip: clientIp(req),
    userAgent: req.headers.get('user-agent') ?? 'unknown',
  });
  if (!result.ok) {
    const code = result.error === 'FORBIDDEN' ? 'FORBIDDEN' : result.error.startsWith('TOKEN_') ? 'CONFLICT' : 'VALIDATION_ERROR';
    return fail(code, result.message, { requestId: rid });
  }

  await setSessionCookie(result.session.token);
  return ok(
    {
      signedIn: true,
      user: { id: result.user.id, email: result.user.email, name: result.user.name, role: result.user.role, emailVerified: result.user.emailVerified },
    },
    { requestId: rid }
  );
}
