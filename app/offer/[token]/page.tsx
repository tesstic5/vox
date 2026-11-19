import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { offerByToken } from '@/lib/server/wait-offers';
import { ClaimOffer } from './ClaimOffer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `/offer/<token>` — the page a freed-slot text points at.
 *
 * `noindex`, like the client's appointment link and the payment link: a link that
 * reaches a search engine is a link that leaks. The token names one offer, so a
 * forwarded link shows nothing about anybody else.
 *
 * The page itself talks to `/api/public/offer/<token>` rather than reading the
 * database directly, so the state it prints is the state the claim will be checked
 * against — one code path, not two that can disagree.
 */
export const metadata: Metadata = {
  title: 'A time has opened up',
  robots: { index: false, follow: false },
};

export default async function OfferPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const offer = offerByToken(token);
  if (!offer) notFound();

  // The page hands the browser the token and nothing else: the panel reads the
  // offer live from the API, so two open tabs cannot show two different truths.
  return <ClaimOffer token={token} />;
}
