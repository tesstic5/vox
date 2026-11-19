import * as React from 'react';
import { AuthCard, VerifyEmail } from '@/components/site/AuthFlows';

export const metadata = {
  title: 'Verify your email',
  description: 'Confirm your email address to publish assistants and provision numbers.',
};

export default function VerifyEmailPage() {
  return (
    <AuthCard
      eyebrow="Almost there"
      title="Verify it, then build."
      lede="Unverified accounts can draft agents; verification is what unlocks publishing, numbers, and the API."
      aside={
        <div className="space-y-3">
          {[
            { t: 'Publishing unlocked', d: 'Releasing an assistant is refused until the code is accepted.' },
            { t: 'Numbers unlocked', d: 'Buying or importing a phone number needs a verified address too.' },
            { t: 'No lockout', d: 'Five wrong attempts locks the code for an hour, not the account.' },
          ].map((x) => (
            <div key={x.t} className="rounded-xl border border-slate-900/[0.045] bg-ink-850/50 p-4">
              <div className="text-[13px] font-medium text-slate-900">{x.t}</div>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-slateink-300">{x.d}</p>
            </div>
          ))}
        </div>
      }
    >
      <VerifyEmail />
    </AuthCard>
  );
}
