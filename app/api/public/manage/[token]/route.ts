import { NextRequest } from 'next/server';
import { clientIp, fail, ok, requestId } from '@/lib/server/api';
import { rateLimit, rateHeaders } from '@/lib/server/ratelimit';
import { bookingForToken, manageView, offeredSlots } from '@/lib/server/manage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The appointment behind a client's own link.
 *
 * No session, no key — the token *is* the credential, and it is scoped to one
 * appointment: it cannot list a diary, read a client, or reach a sibling booking.
 * Rate limited per connection because a page that offers real diary slots is
 * worth scraping, and the honest answer to a scraper is 429.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const id = requestId();
  const limit = rateLimit(`manage:${clientIp(req)}`, 60, 60_000);
  if (!limit.allowed) {
    return fail('RATE_LIMITED', 'Too many requests — try again in a minute.', { requestId: id, headers: rateHeaders(limit) });
  }

  const booking = bookingForToken(token);
  if (!booking) {
    return fail('NOT_FOUND', 'That link does not match an appointment. It may have been replaced — check your most recent message from the practice.', { requestId: id });
  }

  const orgId = String(booking.orgId);
  const view = manageView(orgId, booking);
  try {
    const slots = view.canChange ? await offeredSlots(orgId, booking) : { timezone: view.timezone, days: [] };
    return ok({ view, slots }, { requestId: id, headers: rateHeaders(limit) });
  } catch {
    return fail('SCHEDULE_UNAVAILABLE', 'Alternative appointment times could not be loaded. Your appointment is unchanged; please call the practice.', {
      requestId: id,
      headers: rateHeaders(limit),
    });
  }
}
