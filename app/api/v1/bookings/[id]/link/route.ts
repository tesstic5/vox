import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, requireAuth } from '@/lib/server/api';
import { bookingById } from '@/lib/server/bookings';
import { manageView } from '@/lib/server/manage';
import { manageLinkFor } from '@/lib/server/manage-links';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The client's own link for one appointment, for the desk to hand over.
 *
 * Every confirmation and reminder already carries this link, but a receptionist
 * on the phone needs to *read it out* — "I have texted you a link, and here it is
 * if it does not arrive" — and the dashboard had no way to produce it on demand.
 * The answer includes what the client will actually be able to do with it, so the
 * desk does not promise a change the page will refuse two hours beforehand.
 *
 * This staff lookup requires booking read access. The returned manage token is
 * the credential used later by the client-facing public route.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['bookings:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const booking = bookingById(ctx.orgId, id);
  if (!booking) return fail('NOT_FOUND', `No appointment with id ${id}.`, { requestId: ctx.requestId });

  const url = manageLinkFor(ctx.orgId, booking.id);
  const view = manageView(ctx.orgId, booking);
  return ok(
    {
      appointmentId: booking.id,
      reference: booking.externalId,
      // Empty when the deployment does not know its own public address — a link
      // that cannot be opened is worse than no link, so its absence is the answer.
      url: url ?? null,
      token: url ? url.split('/').pop() : null,
      opens: Boolean(url),
      canChange: view.canChange,
      canCheckIn: view.canCheckIn,
      reason: view.reason ?? null,
      note: url ? undefined : 'This deployment does not know its own public address, so the link cannot be built. Set VOXERA_PUBLIC_URL.',
    },
    { requestId: ctx.requestId }
  );
}
