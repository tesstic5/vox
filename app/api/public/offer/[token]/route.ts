import { NextRequest } from 'next/server';
import { clientIp, fail, ok, readJson, requestId } from '@/lib/server/api';
import { rateLimit, rateHeaders } from '@/lib/server/ratelimit';
import { practiceProfile, serviceById, termsForOrg } from '@/lib/server/practice';
import { offerByToken, offerAlternatives, offerExpiryWords, claimOffer, claimFromWaitEntry, declineOffer, offerSpeaking } from '@/lib/server/wait-offers';
import { bookingById } from '@/lib/server/bookings';
import { list, type Doc } from '@/lib/server/db';
import { manageLinkFor } from '@/lib/server/manage-links';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The page a freed-slot text points at.
 *
 * Public by nature — it is texted to somebody — and deliberately narrow: one
 * offer, one appointment, and the practice's own phone number. The token names
 * the offer and nothing else, so a forwarded link shows no other client.
 *
 * `startsAt` can be sent as well, which is what the page does when the offered
 * time has gone and the client picks one of the live alternatives it showed them.
 */
async function payload(token: string) {
  const offer = offerByToken(token);
  if (!offer) return null;

  const orgId = String(offer.orgId);
  const terms = termsForOrg(orgId);
  const expired = Date.parse(offer.expiresAt) <= Date.now();
  const status = offer.status === 'open' && expired ? 'expired' : offer.status;
  const booking = offer.claimedBookingId ? bookingById(orgId, String(offer.claimedBookingId)) : offer.bookingId ? bookingById(orgId, offer.bookingId) : undefined;

  return {
    view: {
      name: offer.name,
      firstName: String(offer.name).split(/\s+/)[0] || undefined,
      spoken: offerSpeaking(orgId, offer),
      expiresWords: offerExpiryWords(orgId, offer),
      status,
      // The words the client reads must match the state, not the row.
      canTake: status === 'open',
      alreadyTaken: status === 'claimed',
      canPickAnother: ['expired', 'withdrawn', 'open'].includes(status),
      service: (booking?.service as string) ?? undefined,
      // The practice's own name and number, so the page can always offer a way out
      // that is not a web form.
      practice: {
        name: String(list<Doc & { name?: string }>('orgs', (o) => o.id === orgId)[0]?.name ?? 'the practice'),
        phone: (() => {
          const number = list<Doc & { number?: string; active?: boolean }>('numbers', (n) => n.orgId === orgId && n.active !== false)[0];
          return number?.number ? String(number.number) : undefined;
        })(),
      },
      terms,
      /**
       * What kind of thing was offered. A place in a class and a stretch of the
       * diary are different promises, and the page must say which one it is
       * holding — the words, the button and what a claim creates all differ.
       */
      kind: offer.sessionId ? ('class' as const) : ('slot' as const),
      className: offer.sessionId ? String(serviceById(orgId, String(offer.serviceId))?.name ?? 'that class') : undefined,
      reference: booking ? String(booking.externalId ?? '') : undefined,
      manageLink: offer.claimedBookingId ? manageLinkFor(orgId, String(offer.claimedBookingId)) : undefined,
      // The next openings, shown when the time they came for is gone — or when a
      // claim could still fail with "taken", because an offer being open in our
      // records is not the same as the slot still being there. Live at the moment
      // of asking, so the page never shows a slot that has since gone.
      alternatives:
        // A place in a class is not a menu of times: there is nothing to offer
        // instead, because the thing they want is *that class*.
        offer.sessionId || status === 'claimed' || status === 'declined'
          ? { timezone: '', days: [], widened: false }
          : await offerAlternatives(orgId, offer, { widenToDays: practiceProfile(orgId).maxAdvanceDays }),
      entryId: offer.entryId,
    },
    offerId: offer.id,
  };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const id = requestId();
  // Reading is cheap and safe, but it is still an unauthenticated endpoint that
  // reads a row — so it is limited like one.
  const limit = rateLimit(`offer-read:${clientIp(req)}`, 60, 60_000);
  if (!limit.allowed) return fail('RATE_LIMITED', 'Too many requests — try again in a minute.', { requestId: id, headers: rateHeaders(limit) });

  const body = await payload(token);
  if (!body) return fail('NOT_FOUND', 'That offer link does not match anything on file.', { requestId: id });
  return ok(body, { requestId: id, headers: rateHeaders(limit) });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const id = requestId();
  const limit = rateLimit(`offer-act:${clientIp(req)}`, 20, 60_000);
  if (!limit.allowed) return fail('RATE_LIMITED', 'Too many attempts — try again in a minute.', { requestId: id, headers: rateHeaders(limit) });

  const body = await readJson<{ action?: string; startsAt?: string }>(req);
  if (body instanceof Response) return body;
  const offer = offerByToken(token);
  if (!offer) return fail('NOT_FOUND', 'That offer link does not match anything on file.', { requestId: id });

  const action = String(body.action ?? 'claim');
  if (action === 'decline') {
    const result = declineOffer({ orgId: offer.orgId, offer });
    if (!result.ok) return fail('CONFLICT', result.message, { requestId: id, headers: rateHeaders(limit) });
    return ok({ declined: true, message: result.message, ...(await payload(token)) }, { requestId: id, headers: rateHeaders(limit) });
  }

  if (action !== 'claim') {
    return fail('VALIDATION_ERROR', '`action` must be one of: claim, decline.', { param: 'action', requestId: id });
  }

  // A different time than the one offered: this is the recovery path, and the
  // engine checks it against the live diary before writing anything.
  const wanted = body.startsAt ? String(body.startsAt) : '';
  const different = wanted && Number.isFinite(Date.parse(wanted)) && Date.parse(wanted) !== Date.parse(offer.startsAt);
  const result = await (different && offer.status !== 'open'
    ? claimFromWaitEntry({ orgId: offer.orgId, entryId: offer.entryId, startsAt: wanted })
    : claimOffer({ orgId: offer.orgId, offer, startsAt: wanted || undefined }));

  if (!result.ok) {
    const code = result.error === 'not_free' || result.error === 'taken' ? 'CONFLICT' : result.error === 'expired' ? 'CONFLICT' : 'VALIDATION_ERROR';
    return fail(code, result.message, { requestId: id, headers: rateHeaders(limit) });
  }

  return ok(
    {
      claimed: true,
      booking: {
        reference: result.booking.externalId,
        startsAt: result.booking.startsAt,
        service: result.booking.service,
        status: result.booking.status,
      },
      message: offer.sessionId
        ? `You have a place — reference ${result.booking.externalId}. A confirmation is on its way.`
        : `You are booked — reference ${result.booking.externalId}. A confirmation is on its way.`,
      ...(await payload(token)),
    },
    { requestId: id, status: 201, headers: rateHeaders(limit) }
  );
}
