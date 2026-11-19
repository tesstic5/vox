import type { Metadata } from 'next';
import { EstimateDecision } from './EstimateDecision';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Review estimate | Voxera',
  description: 'Review and record a decision on a service estimate.',
  robots: { index: false, follow: false },
};

export default async function EstimatePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <EstimateDecision token={token} />;
}
