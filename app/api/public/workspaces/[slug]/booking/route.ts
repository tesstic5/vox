import { NextResponse, type NextRequest } from 'next/server';
import { clientIp, fail, ok, readJson, requestId } from '@/lib/server/api';
import { bookFromPublicPage, publicProviders, publicServices, publicSites, publicWorkspace } from '@/lib/server/booking-page';
import { practiceProfile, termsForOrg } from '@/lib/server/practice';
import { rateLimit, rateHeaders } from '@/lib/server/ratelimit';
import { queueMessage, confirmationBody } from '@/lib/server/messages';
import { locationById, providerById, serviceById } from '@/lib/server/practice';
import { formatClock } from '@/lib/server/availability';
import { manageLinkFor } from '@/lib/server/manage-links';
import { classSessionById, joinClassSession, publicClassSessions } from '@/lib/server/classes';
import { classSpoken, joinClassWaitList } from '@/lib/server/class-waitlist';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The public booking page's API.
 *
 * Unauthenticated by design — that is what a booking page is — so everything it
 * returns is chosen for a stranger: the services offered, the people who deliver
 * them, the sites, and the free times. Never a client, never another booking,
 * never who is busy at 10:20.
 *
 * `GET` is one call, because a page that needs five round trips to show a form
 * loses the people on a bad connection.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const workspace = publicWorkspace(slug);
  if (!workspace) {
    return fail('NOT_FOUND', 'That booking page does not exist.', { requestId: requestId() });
  }
  const { org, settings, notice } = workspace;
  const terms = termsForOrg(org.id);
  const profile = practiceProfile(org.id);
  const url = new URL(req.url);
  const serviceId = url.searchParams.get('serviceId') ?? undefined;
  const providerId = url.searchParams.get('providerId') ?? undefined;

  return ok(
    {
      workspace: {
        slug: org.slug,
        name: org.name,
        terms,
        timezone: publicSites(org.id)[0]?.timezone ?? 'UTC',
      },
      booking: {
        enabled: settings.enabled,
        showProviders: settings.showProviders,
        minNoticeMinutes: profile.minNoticeMinutes,
        maxAdvanceDays: profile.maxAdvanceDays,
        slotStepMinutes: profile.slotStepMinutes,
      },
      services: settings.enabled ? publicServices(org.id) : [],
      providers: settings.enabled && settings.showProviders ? publicProviders(org.id, serviceId) : [],
      sites: settings.enabled ? publicSites(org.id) : [],
      /**
       * The classes (A8): what is coming, where, with whom, and how many seats are
       * left. Deliberately not the roster — a booking page tells a stranger what
       * they can join, never who else has joined.
       */
      classes: settings.enabled
        ? publicClassSessions(org.id).map((c) => ({
            sessionId: c.id,
            serviceId: c.serviceId,
            serviceName: c.serviceName,
            instructor: c.providerName,
            site: c.locationName,
            room: c.roomName,
            startsAt: c.startsAt,
            durationMinutes: c.durationMinutes,
            capacity: c.capacity,
            seatsLeft: c.seatsLeft,
            /** Full classes are offered as a queue rather than hidden. */
            full: c.seatsLeft <= 0,
            local: { date: c.local.date, start: c.local.start, end: c.local.end, spoken: c.local.spoken, timezone: c.local.timezone },
          }))
        : [],
      selected: { serviceId, providerId },
      notice,
    },
    { requestId: requestId() }
  );
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = { requestId: requestId() };
  const ip = clientIp(req);
  const body = await readJson<{
    startsAt?: string;
    serviceId?: string;
    /** Present when the person is joining a class rather than picking a time (A8). */
    sessionId?: string;
    /** With a sessionId: ask for a place in a full class instead of taking one. */
    wait?: boolean;
    providerId?: string;
    locationId?: string;
    name?: string;
    number?: string;
    email?: string;
    notes?: string;
    consentSms?: boolean;
    consentEmail?: boolean;
  }>(req);
  if (body instanceof NextResponse) return body;

  /**
   * Waiting for a place in a class that is full.
   *
   * Same page and the same form as joining, a different verb: there is no place to
   * take, so the person asks to be told when one comes free. The answer says where
   * they are in line, because a queue you cannot see is a queue nobody trusts.
   */
  if (body.sessionId && body.wait) {
    const workspace = publicWorkspace(slug);
    if (!workspace) return fail('NOT_FOUND', 'That booking page does not exist.', { requestId: ctx.requestId });
    const limited = rateLimit(`pub-class:${ip}`, 20, 10 * 60_000);
    if (!limited.allowed) {
      return fail('RATE_LIMITED', 'Too many attempts from this connection. Try again in a few minutes.', { requestId: ctx.requestId, headers: rateHeaders(limited) });
    }
    const session = classSessionById(workspace.org.id, String(body.sessionId));
    if (!session) return fail('NOT_FOUND', 'That class session does not exist.', { param: 'sessionId', requestId: ctx.requestId });

    const joined = joinClassWaitList({
      orgId: workspace.org.id,
      session,
      name: String(body.name ?? ''),
      number: String(body.number ?? ''),
      email: body.email ? String(body.email) : undefined,
      source: 'online',
      actor: 'online-booking',
      consentSms: Boolean(body.consentSms),
    });
    if (!joined.ok) {
      return fail(joined.code as Parameters<typeof fail>[0], joined.message, { param: joined.param, requestId: ctx.requestId });
    }

    return ok(
      {
        wait: {
          entryId: joined.entry.id,
          position: joined.position,
          already: joined.already,
          className: String(serviceById(workspace.org.id, session.serviceId)?.name ?? 'that class'),
          spoken: classSpoken(workspace.org.id, session),
        },
      },
      { requestId: ctx.requestId, status: joined.already ? 200 : 201 }
    );
  }

  /**
   * Joining a class is a different request from booking a slot, and it goes
   * through the class module so the capacity rule has exactly one home: the
   * count and the seat are written by the same function, and the seat is an
   * ordinary booking that the rest of the product already serves.
   */
  if (body.sessionId) {
    const workspace = publicWorkspace(slug);
    if (!workspace) return fail('NOT_FOUND', 'That booking page does not exist.', { requestId: ctx.requestId });
    const limited = rateLimit(`pub-class:${ip}`, 20, 10 * 60_000);
    if (!limited.allowed) {
      return fail('RATE_LIMITED', 'Too many attempts from this connection. Try again in a few minutes.', { requestId: ctx.requestId, headers: rateHeaders(limited) });
    }
    const session = classSessionById(workspace.org.id, String(body.sessionId));
    if (!session) return fail('NOT_FOUND', 'That class session does not exist.', { param: 'sessionId', requestId: ctx.requestId });

    const joined = joinClassSession({
      orgId: workspace.org.id,
      session,
      name: String(body.name ?? ''),
      number: String(body.number ?? ''),
      email: body.email ? String(body.email) : undefined,
      consentSms: Boolean(body.consentSms),
      consentEmail: Boolean(body.consentEmail),
      notes: body.notes ? String(body.notes) : undefined,
      source: 'online',
    });
    if (!joined.ok) {
      return fail(joined.code as Parameters<typeof fail>[0], joined.message, { param: joined.param, requestId: ctx.requestId });
    }

    const summary = joined.summary;
    const confirmation = queueMessage({
      orgId: workspace.org.id,
      channel: 'sms',
      to: String(joined.booking.customer?.number ?? ''),
      clientId: joined.clientId,
      bookingId: joined.booking.id,
      body: `${joined.clientName} — your place in ${summary.serviceName} is booked for ${summary.local.spoken}${summary.locationName ? ` at ${summary.locationName}` : ''}.${summary.roomName ? ` ${summary.roomName}.` : ''} Reference ${joined.booking.externalId}. Change or give up your place here: ${manageLinkFor(workspace.org.id, joined.booking.id)}`,
      source: 'online-booking',
      kind: 'confirmation',
      meta: { kind: 'confirmation', reference: String(joined.booking.externalId ?? '') },
      respectConsent: true,
      immediate: true,
    });

    return ok(
      {
        class: {
          sessionId: summary.id,
          serviceName: summary.serviceName,
          instructor: summary.providerName,
          site: summary.locationName,
          room: summary.roomName,
          seatsLeft: summary.seatsLeft,
          capacity: summary.capacity,
          local: summary.local,
        },
        booking: {
          id: joined.booking.id,
          reference: joined.booking.externalId,
          startsAt: joined.booking.startsAt,
          status: joined.booking.status,
        },
        client: { name: joined.clientName },
        already: joined.already,
        confirmation: { channel: confirmation.channel, status: confirmation.status, reason: confirmation.reason, queued: confirmation.status === 'pending' },
        calendar: `/api/public/bookings/${joined.booking.id}/appointment.ics`,
      },
      { requestId: ctx.requestId, status: joined.already ? 200 : 201 }
    );
  }

  /**
   * A bound on the success path too.
   *
   * The only limiter on this route used to sit in the *failure* branch below, so
   * a stranger could create unlimited appointments — each one a row, a client, a
   * confirmation text with a real carrier cost — simply by never failing. The
   * budget is per IP and per workspace, generous enough for a busy front desk and
   * for every gate in `scripts/`, and it is checked before anything is written.
   */
  const withinBudget = rateLimit(`public-booking:${slug}:${ip}`, 120, 10 * 60_000);
  if (!withinBudget.allowed) {
    return fail('RATE_LIMITED', 'Too many booking attempts from this address. Wait a few minutes, or call the practice.', {
      requestId: ctx.requestId,
      headers: { 'retry-after': String(Math.max(1, Math.ceil((withinBudget.resetAt - Date.now()) / 1000))), ...rateHeaders(withinBudget) },
    });
  }

  const result = await bookFromPublicPage({
    slug,
    startsAt: String(body.startsAt ?? ''),
    serviceId: String(body.serviceId ?? ''),
    providerId: body.providerId ? String(body.providerId) : undefined,
    locationId: body.locationId ? String(body.locationId) : undefined,
    name: String(body.name ?? ''),
    number: String(body.number ?? ''),
    email: body.email ? String(body.email) : undefined,
    notes: body.notes ? String(body.notes) : undefined,
    consentSms: Boolean(body.consentSms),
    consentEmail: Boolean(body.consentEmail),
    ip,
  });

  if (!result.ok) {
    const limited = rateLimit(`public-booking-error:${ip}`, 40, 10 * 60_000);
    return fail(result.code, result.message, {
      param: result.param,
      requestId: ctx.requestId,
      headers: rateHeaders(limited),
    });
  }

  const { booking, client } = result;
  const site = booking.locationId ? locationById(booking.orgId, booking.locationId) : undefined;
  const provider = booking.providerId ? providerById(booking.orgId, booking.providerId) : undefined;
  const terms = termsForOrg(booking.orgId);
  const when = site
    ? `${new Date(booking.startsAt).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: site.timezone })} at ${formatClock(new Date(booking.startsAt).getTime(), site.timezone)}`
    : new Date(booking.startsAt).toISOString();

  /**
   * The confirmation, queued — not merely claimed.
   *
   * If the person ticked the SMS box it goes; if they did not, the row is still
   * written and marked `blocked`, because "we did not text them" and "we never
   * tried to" are different facts and only one of them is auditable.
   */
  const confirmation = queueMessage({
    orgId: booking.orgId,
    channel: 'sms',
    to: booking.customer.number,
    clientId: client.id,
    bookingId: booking.id,
    body: confirmationBody({
      clientName: client.name,
      when,
      service: booking.service ?? terms.appointment.one,
      provider: provider?.name,
      site: site?.name,
      reference: booking.externalId,
      manageLink: manageLinkFor(booking.orgId, booking.id),
      terms,
    }),
    source: 'online-booking',
    meta: { kind: 'confirmation', reference: booking.externalId ?? '' },
    respectConsent: true,
    // They booked thirty seconds ago and gave us the number to hear about it.
    // Quiet hours hold back what the practice starts by itself — a reminder it
    // decided to send — not a confirmation somebody is waiting for.
    immediate: true,
  });

  return ok(
    {
      booking: {
        id: booking.id,
        reference: booking.externalId,
        startsAt: booking.startsAt,
        durationMinutes: booking.durationMinutes,
        service: booking.service,
        providerName: provider?.name,
        siteName: site?.name,
        timezone: site?.timezone ?? 'UTC',
        status: booking.status,
        local: when,
      },
      client: { name: client.name, firstName: client.firstName },
      confirmation: {
        channel: confirmation.channel,
        status: confirmation.status,
        reason: confirmation.reason,
        queued: confirmation.status === 'pending',
      },
      terms,
      /**
       * The calendar file. Public, keyed by the reference the booker just
       * received and nothing else — it contains what they already know.
       */
      calendar: `/api/public/bookings/${booking.id}/appointment.ics`,
    },
    { requestId: ctx.requestId, status: 201 }
  );
}
