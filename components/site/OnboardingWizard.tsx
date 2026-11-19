'use client';

import { LinkButton } from '@/components/ui';

/** Legacy export retained for callers; authoritative onboarding lives in the dashboard. */
export function OnboardingWizard() {
  return (
    <main className="container-wide py-20">
      <div className="panel mx-auto max-w-xl p-8 text-center">
        <h1 className="text-[24px] font-semibold text-slate-900">Workspace setup moved</h1>
        <p className="mt-3 text-[13px] leading-relaxed text-slateink-400">The server-derived setup checklist creates real draft assistants, provider-backed numbers and web test-call records. It does not simulate compliance add-ons or publication.</p>
        <LinkButton href="/dashboard/setup" variant="brand" className="mt-6">Open setup checklist</LinkButton>
      </div>
    </main>
  );
}
