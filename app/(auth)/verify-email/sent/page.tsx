import * as React from 'react';
import { AuthCard, VerifyEmail } from '@/components/site/AuthFlows';

export const metadata = {
  title: 'Verification code sent',
  description: 'Your Voxera verification code is on its way.',
};

export default function VerifyEmailSentPage() {
  return (
    <AuthCard
      eyebrow="Almost there"
      title="Code sent."
      lede="Six digits, valid for fifteen minutes. Nothing you have built so far is lost while you wait."
    >
      <VerifyEmail />
    </AuthCard>
  );
}
