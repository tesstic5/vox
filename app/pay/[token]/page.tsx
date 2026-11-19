import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { publicLinkView } from '@/lib/server/payments';
import { PayPage } from './PayPage';

export const dynamic = 'force-dynamic';

/**
 * A payment link, addressed as `/pay/<token>`.
 *
 * Public by nature — it is sent to a patient by text — and deliberately dull: no
 * workspace chrome, no navigation, no client name. Just what is owed, to whom, and
 * one button. The page is `noindex`: a link that reaches a search engine is a link
 * that leaks.
 */
export const metadata: Metadata = {
  title: 'Pay online',
  robots: { index: false, follow: false },
};

export default async function PayLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const view = publicLinkView(token);
  if (!view) notFound();
  return <PayPage link={view} />;
}
