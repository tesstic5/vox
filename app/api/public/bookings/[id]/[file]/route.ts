import { NextResponse } from 'next/server';
import { get } from '@/lib/server/db';
import { buildIcs } from '@/lib/server/ics';
import { locationById, providerById, termsForOrg } from '@/lib/server/practice';
import type { BookingDoc } from '@/lib/server/bookings';
import { formatClock } from '@/lib/server/availability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The confirmation as a calendar file.
 *
 * Deliberately narrow: the path needs the booking id, the file must be named
 * `appointment.ics`, and what comes back is what the person who booked already
 * knows — when, where, and what it is. No client number, no record id, nothing
 * about anybody else.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; file: string }> }) {
  const { id, file } = await params;
  if (!/^appointment\.ics$/i.test(file)) {
    return NextResponse.json({ error: { code: 'NOT_FOUND', message: `No calendar file called ${file}.` } }, { status: 404 });
  }
  const booking = get<BookingDoc>('bookings', id);
  if (!booking) {
    return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'No appointment with that reference.' } }, { status: 404 });
  }
  // Cancelled appointments still produce a file — with STATUS:CANCELLED, so a
  // calendar that already holds the event updates it instead of keeping a ghost.
  const orgId = String(booking.orgId);
  const site = booking.locationId ? locationById(orgId, booking.locationId) : undefined;
  const provider = booking.providerId ? providerById(orgId, booking.providerId) : undefined;
  const terms = termsForOrg(orgId);
  const starts = new Date(booking.startsAt);
  const when = site
    ? `${starts.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: site.timezone })} at ${formatClock(starts.getTime(), site.timezone)}`
    : starts.toISOString();

  const ics = buildIcs({
    uid: `${booking.orgId}-${booking.id}`,
    startsAt: booking.startsAt,
    durationMinutes: booking.durationMinutes ?? 30,
    summary: `${booking.service ?? terms.appointment.One}${provider ? ` with ${provider.name}` : ''}`,
    description: `${booking.externalId ? `Reference ${booking.externalId}. ` : ''}Booked for ${when}.`,
    location: site ? [site.name, site.address].filter(Boolean).join(', ') : undefined,
    organizer: provider?.name,
    status: booking.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED',
  });

  return new NextResponse(ics, {
    status: 200,
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': `attachment; filename="appointment.ics"`,
      'cache-control': 'no-store',
    },
  });
}
