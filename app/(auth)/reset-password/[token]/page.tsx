import * as React from 'react';
import { AuthCard, ResetConfirm } from '@/components/site/AuthFlows';

export const metadata = {
  title: 'Choose a new password',
  description: 'Set a new password for your Voxera account.',
};

export default async function ResetConfirmPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <AuthCard
      eyebrow="Account recovery"
      title="Pick something long, not something clever."
      lede="Length beats symbol soup. Every other session is signed out the moment the new password is saved."
    >
      <ResetConfirm token={token} />
    </AuthCard>
  );
}
