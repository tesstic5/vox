import * as React from 'react';
import { AuthCard, MagicLinkRequest } from '@/components/site/AuthFlows';

export const metadata = {
  title: 'Sign in with a magic link',
  description: 'Passwordless sign-in for the Voxera dashboard.',
};

export default function MagicLinkPage() {
  return (
    <AuthCard
      eyebrow="Passwordless"
      title="No password, one link."
      lede="Useful on a shared machine, or when the last thing you want to think about at 2am is a password manager."
      aside={
        <div className="panel p-5">
          <div className="flex items-center gap-2 text-[12.5px] text-slateink-300">
            <span className="h-1.5 w-1.5 rounded-full bg-brand-400" />
            Same session, same permissions
          </div>
          <p className="mt-3 text-[12.5px] leading-relaxed text-slateink-300">
            A magic link creates an ordinary session with your existing role. It does not escalate privileges, and
            actions that need a second factor — key rotation, billing, member removal — still ask for one.
          </p>
        </div>
      }
    >
      <MagicLinkRequest />
    </AuthCard>
  );
}
