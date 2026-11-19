import { NextResponse, type NextRequest } from 'next/server';
import { createSession, setSessionCookie, userByEmail, verifyPassword } from '@/lib/server/auth';
import { fail, ok, rateLimit, rateHeaders, readJson, requestId, clientIp } from '@/lib/server/api';
import { clearFailures, failureCount, recordFailure } from '@/lib/server/ratelimit';
import { createMfaChallenge, twoFactorLive } from '@/lib/server/totp';
import { audit } from '@/lib/server/audit';
import { get, update, type Doc } from '@/lib/server/db';
import type { OrgDoc } from '@/lib/server/auth';
import { nowIso } from '@/lib/server/db';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const rid = requestId();
  const body = await readJson<{ email?: string; password?: string }>(req);
  if (body instanceof NextResponse) return body;

  const email = (body.email ?? '').trim().toLowerCase();
  const password = body.password ?? '';

  // Credential stuffing is the reason this limiter exists: 10 tries per minute per IP.
  const limit = rateLimit(`login:${clientIp(req)}`, 10);
  if (!limit.allowed) {
    return fail('RATE_LIMITED', 'Too many sign-in attempts. Wait a minute and try again.', {
      requestId: rid,
      headers: { 'retry-after': '60', ...rateHeaders(limit) },
    });
  }

  // The account throttle sits *in front of* the password check, and it counts
  // failures only. The IP limit above stops one machine knocking on every
  // door; this one stops every machine knocking on the same door — a sprayed
  // account locks for fifteen minutes no matter where the guesses come from,
  // while a person who simply signs in a lot never accumulates anything.
  const ACCOUNT_FAILURE_LIMIT = 5;
  const failures = failureCount(`login-account:${email}`);
  if (failures.count >= ACCOUNT_FAILURE_LIMIT) {
    const waitSeconds = Math.max(1, Math.ceil((failures.resetAt - Date.now()) / 1000));
    audit({ orgId: userByEmail(email)?.orgId ?? 'unknown', actor: email, action: 'auth.login_refused', detail: `account throttled after ${failures.count} failed attempts` });
    return fail('RATE_LIMITED', 'Too many failed sign-in attempts for that account. Wait fifteen minutes and try again.', {
      requestId: rid,
      headers: { 'retry-after': String(waitSeconds) },
    });
  }

  const user = userByEmail(email);
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    // Failures accrue to real accounts only. A made-up address has nobody to
    // lock out, and counting it would let a stranger keep a *string* throttled
    // forever; the per-IP limit above is the control for that traffic.
    if (user) recordFailure(`login-account:${email}`);
    return fail('UNAUTHORIZED', 'That email and password combination does not match an account.', { requestId: rid });
  }
  clearFailures(`login-account:${email}`);
  // A deactivated login is not a login. Saying so plainly (rather than "wrong
  // password") is kinder to the person who was told they had left, and it is the
  // only honest answer: the password is right, the account is closed.
  if (user.active === false) {
    audit({ orgId: user.orgId, actor: email, action: 'auth.login_refused', target: user.id, detail: 'deactivated account' });
    return fail('FORBIDDEN', 'That account has been deactivated. Ask an owner or admin to switch it back on.', { requestId: rid });
  }

  // Two-factor: the password was right, which earns a five-minute challenge,
  // not a session. The session is minted by /api/auth/login/verify once a
  // current authenticator code (or an unused recovery code) comes back.
  if (twoFactorLive(user)) {
    const challenge = createMfaChallenge(user.id);
    audit({ orgId: user.orgId, actor: user.email, action: 'auth.mfa_challenge', target: user.id, detail: 'Password accepted; second factor requested' });
    return ok({ mfaRequired: true, challenge: challenge.token, expiresAt: challenge.expiresAt }, { requestId: rid });
  }

  const org = get<OrgDoc>('orgs', user.orgId);
  const { token, session } = createSession(user, {
    userAgent: req.headers.get('user-agent') ?? 'unknown',
    ip: clientIp(req),
  });
  await setSessionCookie(token);
  update<Doc>('users', user.id, { lastLoginAt: nowIso() });
  audit({ orgId: user.orgId, actor: user.email, action: 'auth.login', target: user.id, detail: 'Signed in with password' });

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
