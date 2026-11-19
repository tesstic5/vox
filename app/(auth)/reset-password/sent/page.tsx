import * as React from 'react';
import Link from 'next/link';
import { AuthCard, InboxPanel } from '@/components/site/AuthFlows';

export const metadata = {
  title: 'Check your inbox',
  description: 'A password reset link is on its way.',
};

export default function ResetSentPage() {
  return (
    <AuthCard
      eyebrow="Account recovery"
      title="The link is in your inbox."
      lede="It expires in fifteen minutes and works exactly once. If it does not arrive, check the spam folder before requesting another."
    >
      <InboxPanel
        email="the address on your account"
        title="Check your inbox for the reset link"
        body="We sent a single-use reset link to"
        note="Open it from the email itself — nothing on this page can sign you in, and there is no demo link to fall back on."
        secondary={
          <p className="text-[12.5px] text-slateink-400">
            Need a different route?{' '}
            <Link href="/magic-link" className="text-brand-700 hover:underline">
              Magic link
            </Link>{' '}
            ·{' '}
            <Link href="/sso" className="text-brand-700 hover:underline">
              SSO
            </Link>{' '}
            ·{' '}
            <Link href="/support" className="text-brand-700 hover:underline">
              Contact support
            </Link>
          </p>
        }
      />
    </AuthCard>
  );
}
