import { NextResponse, type NextRequest } from 'next/server';
import { createSession, setSessionCookie } from '@/lib/server/auth';
import { fail, ok, readJson, requestId, clientIp, rateLimit, rateHeaders } from '@/lib/server/api';
import { audit } from '@/lib/server/audit';
import { get, update, type Doc } from '@/lib/server/db';
import type { OrgDoc } from '@/lib/server/auth';
import { nowIso } from '@/lib/server/db';
import { checkSecondFactor, recordChallengeGuess, resolveMfaChallenge, spendMfaChallenge } from '@/lib/server/totp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/login/verify — the second half of a two-factor sign-in.
 *
 * The password step (`/api/auth/login`) returns a challenge token instead of
 * a session when the account has a live factor. Presenting that token with a
 * current authenticator code — or an unused recovery code — mints the
 * session here. Five wrong codes burn the challenge; the token itself is
 * stored hashed and never accepted twice.
 */
export async function POST(req: NextRequest) {
  const rid = requestId();
  const limit = rateLimit(`mfa-verify:${clientIp(req)}`, 10);
  if (!limit.allowed) {
    return fail('RATE_LIMITED', 'Too many code attempts. Wait a minute and try again.', {
      requestId: rid,
      headers: { 'retry-after': '60', ...rateHeaders(limit) },
    });
  }
  const body = await readJson<{ challenge?: string; code?: string }>(req);
  if (body instanceof NextResponse) return body;
  if (!body.challenge || !body.code) {
    return fail('VALIDATION_ERROR', 'Send the sign-in `challenge` and the `code` from your authenticator.', { requestId: rid });
  }

  const resolved = resolveMfaChallenge(body.challenge);
  if ('error' in resolved) return fail('UNAUTHORIZED', resolved.error, { requestId: rid });
  const { user, challenge } = resolved;

  const verdict = checkSecondFactor(user, body.code);
  if (!verdict.ok) {
    recordChallengeGuess(challenge.id);
    audit({ orgId: user.orgId, actor: user.email, action: 'auth.mfa_failed', target: user.id, detail: 'Wrong second-factor code' });
    return fail('UNAUTHORIZED', 'That code is not current. Check your authenticator and try again.', { requestId: rid });
  }
  spendMfaChallenge(challenge.id);

  const org = get<OrgDoc>('orgs', user.orgId);
  const { token, session } = createSession(user, {
    userAgent: req.headers.get('user-agent') ?? 'unknown',
    ip: clientIp(req),
  });
  await setSessionCookie(token);
  update<Doc>('users', user.id, { lastLoginAt: nowIso() });
  audit({
    orgId: user.orgId,
    actor: user.email,
    action: 'auth.login',
    target: user.id,
    detail: verdict.via === 'recovery' ? 'Signed in with password + recovery code' : 'Signed in with password + authenticator',
  });

  return ok(
    {
      user: { id: user.id, email: user.email, name: user.name, role: user.role, emailVerified: user.emailVerified },
      org: org
        ? { id: org.id, name: org.name, slug: org.slug, plan: org.plan, region: org.region, balanceMinutes: org.balanceMinutes }
        : null,
      session: { id: session.id, expiresAt: session.expiresAt },
    },
    { requestId: rid }
  );
}
