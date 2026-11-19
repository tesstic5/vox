import * as React from 'react';
import { AuthCard, InviteAccept } from '@/components/site/AuthFlows';

export const metadata = {
  title: 'Accept your invitation',
  description: 'Join a Voxera organisation with the role your admin assigned.',
};

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <AuthCard
      eyebrow="Invitation"
      title="You were invited to build on Voxera."
      lede="Roles decide what the dashboard shows you: viewers read calls, developers build and test, admins publish and manage members."
      aside={
        <div className="panel p-5">
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-slateink-400">Link reference</div>
          <div className="mt-2 font-mono text-[12px] text-slate-900">{token}</div>
          <p className="mt-4 text-[12.5px] leading-relaxed text-slateink-300">
            Invitations are single-tenant: accepting one adds this account to that organisation without affecting any
            other organisation you belong to. Switching between them happens from the account menu.
          </p>
        </div>
      }
    >
      <InviteAccept token={token} />
    </AuthCard>
  );
}
