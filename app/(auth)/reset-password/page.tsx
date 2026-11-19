import * as React from 'react';
import { AuthCard, ResetRequest } from '@/components/site/AuthFlows';

export const metadata = {
  title: 'Reset your password',
  description: 'Request a single-use password reset link for your Voxera account.',
};

export default function ResetPasswordPage() {
  return (
    <AuthCard
      eyebrow="Account recovery"
      title="Get back into the dashboard."
      lede="Reset links are single-use and expire in fifteen minutes. Changing a password signs out every other session automatically."
      aside={
        <div className="space-y-3">
          {[
            { t: 'Single use', d: 'Each link works once, then dies — no replayable inbox link.' },
            { t: '15 minutes', d: 'Short enough that a forwarded email is useless by the time it arrives.' },
            { t: 'Sessions signed out', d: 'A stolen laptop does not stay signed in after a reset.' },
          ].map((x) => (
            <div key={x.t} className="flex gap-3.5">
              <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-brand-500/20 bg-brand-500/[0.07] text-brand-700">
                <span className="text-[13px]">•</span>
              </span>
              <div>
                <div className="text-[13.5px] font-medium text-slate-900">{x.t}</div>
                <p className="mt-1 text-[12.5px] leading-relaxed text-slateink-300">{x.d}</p>
              </div>
            </div>
          ))}
        </div>
      }
    >
      <ResetRequest />
    </AuthCard>
  );
}
