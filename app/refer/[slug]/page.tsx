import type { Metadata } from 'next';
import { PublicReferral } from './PublicReferral';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Secure referral · Voxera',
  description: 'Send a secure referral to a participating practice.',
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
};

export default async function ReferralPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <PublicReferral slug={slug} />;
}
