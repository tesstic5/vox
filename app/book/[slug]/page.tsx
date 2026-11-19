import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { publicSites, publicWorkspace } from '@/lib/server/booking-page';
import { termsForOrg } from '@/lib/server/practice';
import { BookingPage } from './BookingPage';

export const dynamic = 'force-dynamic';

/**
 * A workspace's booking page, addressed as `/book/<slug>` — one memorable path,
 * no query string, because this is the link a practice puts on its website and
 * in its Google profile.
 *
 * The metadata is the workspace's, not Voxera's: a patient who finds the page by
 * searching for the clinic should see the clinic's name in the tab, and the
 * page says "Powered by Voxera" in the footer rather than in the title.
 */
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const workspace = publicWorkspace(slug);
  if (!workspace) return { title: 'Booking page not found' };
  const site = publicSites(workspace.org.id)[0];
  const terms = termsForOrg(workspace.org.id);
  const title = `Book a ${terms.appointment.one} · ${workspace.org.name}`;
  return {
    title,
    description: `Choose a ${terms.service.one}, pick a time, and it is confirmed straight away. ${site ? `${site.name}${site.address ? `, ${site.address}` : ''}.` : ''}`,
    robots: { index: false, follow: false },
  };
}

export default async function PublicBookingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const workspace = publicWorkspace(slug);
  if (!workspace) notFound();
  return <BookingPage slug={slug} workspaceName={workspace.org.name ?? 'Book an appointment'} />;
}
