import { NextResponse, type NextRequest } from 'next/server';
import { createSession, createUserWithOrg, setSessionCookie, userByEmail } from '@/lib/server/auth';
import { clientIp, fail, ok, rateLimit, rateHeaders, readJson, requestId } from '@/lib/server/api';
import { audit } from '@/lib/server/audit';
import { BUSINESS_TYPES, isBusinessType, type BusinessType } from '@/lib/business';

export const runtime = 'nodejs';

type Body = {
  email?: string;
  password?: string;
  name?: string;
  orgName?: string;
  region?: string;
  /** Optional for backward-compatible API callers; required by the signup form. */
  businessType?: BusinessType;
  otherDescription?: string;
};

export async function POST(req: NextRequest) {
  const rid = requestId();
  // Account creation runs scrypt and writes an organisation; both are worth
  // rate-limiting, and it was the one auth route with no limit at all.
  // 15 from one address in ten minutes: a script is stopped long before it makes
  // a dent, and a practice setting up several logins from one office is not.
  const limit = rateLimit(`signup:${clientIp(req)}`, 15, 10 * 60_000);
  if (!limit.allowed) {
    return fail('RATE_LIMITED', 'Too many accounts created from this address. Try again later.', {
      requestId: rid,
      headers: { 'retry-after': String(Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 1000))), ...rateHeaders(limit) },
    });
  }
  const body = await readJson<Body>(req);
  if (body instanceof NextResponse) return body;

  const email = (body.email ?? '').trim().toLowerCase();
  const password = body.password ?? '';
  const name = (body.name ?? '').trim();
  const orgName = (body.orgName ?? '').trim() || `${name.split(' ')[0] || 'New'}'s workspace`;
  const region = body.region ?? 'us-east-1';
  const businessType = body.businessType;
  const otherDescription = String(body.otherDescription ?? '').trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('VALIDATION_ERROR', 'That email address is not valid.', { param: 'email', requestId: rid });
  if (password.length < 8) return fail('VALIDATION_ERROR', 'Passwords need at least 8 characters.', { param: 'password', requestId: rid });
  if (name.length < 2) return fail('VALIDATION_ERROR', 'Please include your name.', { param: 'name', requestId: rid });
  if (businessType !== undefined && !isBusinessType(businessType)) {
    return fail('VALIDATION_ERROR', `\`businessType\` must be one of: ${BUSINESS_TYPES.join(', ')}.`, {
      param: 'businessType',
      requestId: rid,
    });
  }
  if (otherDescription.length > 120) {
    return fail('VALIDATION_ERROR', 'The business description must be 120 characters or fewer.', {
      param: 'otherDescription',
      requestId: rid,
    });
  }
  if (userByEmail(email)) return fail('CONFLICT', 'An account already exists for that email. Sign in instead.', { param: 'email', requestId: rid });

  const { user, org } = await createUserWithOrg({
    email,
    name,
    password,
    orgName,
    region,
    businessType,
    otherDescription: businessType === 'other' ? otherDescription : undefined,
  });
  const { token, session } = createSession(user, {
    userAgent: req.headers.get('user-agent') ?? 'unknown',
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '127.0.0.1',
  });
  await setSessionCookie(token);
  audit({ orgId: org.id, actor: user.email, action: 'auth.signup', target: user.id, detail: `Account created for ${org.name}` });

  return ok(
    {
      user: { id: user.id, email: user.email, name: user.name, role: user.role, emailVerified: user.emailVerified },
      org: {
        id: org.id,
        name: org.name,
        slug: org.slug,
        plan: org.plan,
        region: org.region,
        balanceMinutes: org.balanceMinutes,
        businessProfile: org.businessProfile,
      },
      session: { id: session.id, expiresAt: session.expiresAt },
    },
    { requestId: rid, status: 201 }
  );
}
