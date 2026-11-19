import { OnboardingWizard } from '@/components/dash/OnboardingWizard';
import { onboardingState } from '@/lib/server/onboarding';
import { currentUser } from '@/lib/server/auth';

export const dynamic = 'force-dynamic';

/**
 * /dashboard/setup — the wizard, rendered from server state so the first paint
 * already knows what this workspace has done.
 */
export default async function SetupPage() {
  const session = await currentUser();
  const initial = session ? onboardingState(session.org.id) : null;
  return <OnboardingWizard initial={initial as never} emailVerified={session?.user.emailVerified} />;
}
