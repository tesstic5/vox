import * as React from 'react';
import Link from 'next/link';
import { AuthCard, InboxPanel } from '@/components/site/AuthFlows';

export const metadata = {
  title: 'Check your inbox',
  description: 'Your magic link is on the way.',
};

export default function MagicLinkSentPage() {
  return (
    <AuthCard
      eyebrow="Passwordless"
      title="Check your inbox."
      lede="The link signs you straight into the dashboard and works once, for fifteen minutes."
    >
      <InboxPanel
        email="the address on your account"
        title="Your magic link is on the way"
        body="A single-use sign-in link was sent to"
        note="Open it from the email and press the button on the page it opens. Nothing here can sign you in, and the link expires in fifteen minutes."
        secondary={
          <p className="text-[12.5px] text-slateink-400">
            Prefer a password?{' '}
            <Link href="/reset-password" className="text-brand-700 hover:underline">
              Reset it instead
            </Link>
            .
          </p>
        }
      />
    </AuthCard>
  );
}
