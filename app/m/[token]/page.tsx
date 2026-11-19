import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { bookingForToken, manageView, offeredSlots } from '@/lib/server/manage';
import { rememberOrigin } from '@/lib/server/manage-links';
import { ManageAppointment } from './ManageAppointment';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The client's own appointment, at `/m/<token>`.
 *
 * The link that goes out in every confirmation and reminder. It is public by
 * nature — it is texted to a person — and deliberately plain: what is booked,
 * when, where, and the two things they can do about it. No workspace chrome, no
 * other appointment, no client record.
 *
 * `noindex`, like the payment link: a link that reaches a search engine is a
 * link that leaks. And the token names one appointment only, so a forwarded link
 * shows nothing about anybody else.
 */
export const metadata: Metadata = {
  title: 'Your appointment',
  robots: { index: false, follow: false },
};

export default async function ManagePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const booking = bookingForToken(token);
  if (!booking) notFound();

  const orgId = String(booking.orgId);

  /**
   * Where this workspace is reachable from — recorded the moment somebody opens
   * a link, because this is one of the few places where we know the public
   * address *and* have a workspace in hand. Tomorrow's reminders are queued by a
   * scheduler with no request in sight, so without this the link they carry
   * would have to come from an environment variable nobody remembers to set.
   */
  const inbound = await headers();
  const host = (inbound.get('x-forwarded-host') ?? inbound.get('host') ?? '').split(',')[0].trim();
  if (host && !host.startsWith('0.0.0.0')) {
    const proto = inbound.get('x-forwarded-proto')?.split(',')[0].trim() || (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
    rememberOrigin(orgId, `${proto}://${host}`);
  }

  const view = manageView(orgId, booking);
  let slots = { timezone: view.timezone, days: [] } as Awaited<ReturnType<typeof offeredSlots>>;
  if (view.canChange) {
    try { slots = await offeredSlots(orgId, booking); }
    catch { /* the page remains usable for status/call details without inventing availability */ }
  }

  return <ManageAppointment token={token} initial={{ view, slots }} />;
}
