import { currentUser } from '@/lib/server/auth';
import { isPlatformOperator } from '@/lib/server/operator';
import { twoFactorSummary } from '@/lib/server/totp';
import { ok, requestId } from '@/lib/server/api';
import { effectiveBusinessProfile } from '@/lib/business';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const rid = requestId();
  const session = await currentUser();
  if (!session) return ok({ authenticated: false }, { requestId: rid });
  const { user, org, session: s } = session;
  return ok(
    {
      authenticated: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        emailVerified: user.emailVerified,
        twoFactorEnabled: user.twoFactorEnabled,
        twoFactor: twoFactorSummary(user),
        platformOperator: isPlatformOperator(user),
        createdAt: user.createdAt,
      },
      org: {
        id: org.id,
        name: org.name,
        slug: org.slug,
        plan: org.plan,
        region: org.region,
        balanceMinutes: org.balanceMinutes,
        business: effectiveBusinessProfile(org.businessProfile),
      },
      session: { id: s.id, expiresAt: s.expiresAt },
    },
    { requestId: rid }
  );
}
