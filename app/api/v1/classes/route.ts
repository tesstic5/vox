import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireApiKeyScopes, requireAuth, requirePermission, requireWriteRole } from '@/lib/server/api';
import { currentUser } from '@/lib/server/auth';
import { cancelClassSession, classSessionById, createClassSession, listClassSessions, rosterFor } from '@/lib/server/classes';
import { bookingById } from '@/lib/server/bookings';
import { assignedUserIdsForCase } from '@/lib/server/cases';
import { locationsFor, providersFor, servicesFor } from '@/lib/server/practice';
import { roomsFor } from '@/lib/server/rooms';
import { dateStrIn, addDays, zonedToUtc } from '@/lib/server/availability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The desk's classes (A8).
 *
 * `GET` is the list the classes page and the diary read: sessions with their
 * names, their site's clock and their seat count. It answers for a window —
 * a fortnight by default — because a class list is read as "what is coming", not
 * as a filing cabinet.
 *
 * `POST` is one route with an `action`, matching the rest of the product's write
 * paths: `create` (optionally a weekly run), `cancel` (which releases every seat
 * and tells the people holding them). Roles are the desk's usual ones — anyone
 * who may write to the diary may run a class; a `viewer` may not.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const { orgId } = ctx;
  const url = new URL(req.url);

  const sites = locationsFor(orgId);
  const timezone = sites[0]?.timezone ?? 'UTC';
  const from = url.searchParams.get('from') ?? dateStrIn(timezone);
  const to = url.searchParams.get('to') ?? addDays(from, 14);
  const locationId = url.searchParams.get('locationId') ?? undefined;
  const serviceId = url.searchParams.get('serviceId') ?? undefined;
  const includeCancelled = url.searchParams.get('includeCancelled') === 'true';

  const sessions = listClassSessions(orgId, { from, to, locationId, serviceId, includeCancelled });
  return ok(
    {
      sessions,
      range: { from, to },
      /** The class services — every service in the catalogue with a capacity. */
      classes: servicesFor(orgId)
        .filter((s) => s.active && Number(s.capacity ?? 0) >= 2)
        .map((s) => ({ id: s.id, name: s.name, capacity: Number(s.capacity ?? 0), durationMinutes: s.durationMinutes, price: s.price })),
      sites: sites.filter((s) => s.active).map((s) => ({ id: s.id, name: s.name, timezone: s.timezone })),
      /**
       * The people who can run a class and the rooms one can be held in, read
       * here rather than fetched by the page three more times: the form a desk
       * fills in needs all of it at once, and a class list is not a big payload.
       */
      instructors: providersFor(orgId)
        .filter((p) => p.active)
        .map((p) => ({ id: p.id, name: p.name, locationIds: p.locationIds, serviceIds: p.serviceIds })),
      rooms: roomsFor(orgId).filter((r) => r.active !== false).map((r) => ({ id: r.id, name: r.name, locationId: r.locationId })),
      totals: {
        sessions: sessions.length,
        seats: sessions.reduce((sum, s) => sum + s.seats, 0),
        seatsLeft: sessions.reduce((sum, s) => sum + s.seatsLeft, 0),
        capacity: sessions.reduce((sum, s) => sum + s.capacity, 0),
      },
    },
    { requestId: ctx.requestId }
  );
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireWriteRole(ctx);
  if (denied) return denied;
  const { orgId } = ctx;
  const id = ctx.requestId;
  const who = await currentUser();
  const actorName = String((who as { user?: { name?: string } } | undefined)?.user?.name ?? '');

  const body = await readJson<{
    action?: string;
    sessionId?: string;
    serviceId?: string;
    providerId?: string;
    locationId?: string;
    roomId?: string;
    startsAt?: string;
    /** Or the site's own wall clock, which is what a desk form actually collects. */
    date?: string;
    time?: string;
    durationMinutes?: number;
    capacity?: number;
    notes?: string;
    repeatWeeks?: number;
    reason?: string;
  }>(req);
  if (body instanceof NextResponse) return body;

  const action = String(body.action ?? '');
  const actor = ctx.auth === 'key' ? `key:${ctx.key?.id}` : 'dashboard';

  if (action === 'create') {
    /**
     * A date and a time on a form are in the *site's* clock, not UTC. Converting
     * them here — with the same DST-safe helper the diary uses — is deliberate:
     * a second conversion written in the browser is how D1 happened.
     */
    let startsAt = String(body.startsAt ?? '');
    if (!startsAt && body.date && body.time) {
      const site = locationsFor(orgId).find((l) => l.id === String(body.locationId ?? ''));
      const [y, m, d] = String(body.date).split('-').map(Number);
      const [hh, mm] = String(body.time).split(':').map(Number);
      if (!site || ![y, m, d, hh, mm].every((n) => Number.isFinite(n))) {
        return fail('VALIDATION_ERROR', 'A class needs a site, a date and a time.', { param: 'date', requestId: id });
      }
      startsAt = new Date(zonedToUtc(y, m, d, hh, mm, site.timezone)).toISOString();
    }
    const result = createClassSession({
      orgId,
      actor,
      actorName,
      serviceId: String(body.serviceId ?? ''),
      providerId: String(body.providerId ?? ''),
      locationId: String(body.locationId ?? ''),
      roomId: body.roomId ? String(body.roomId) : undefined,
      startsAt,
      durationMinutes: body.durationMinutes,
      capacity: body.capacity,
      notes: body.notes,
      repeatWeeks: body.repeatWeeks,
    });
    if (!result.ok) return fail(result.code as Parameters<typeof fail>[0], result.message, { param: result.param, requestId: id });
    return ok({ sessions: result.sessions, created: result.sessions.length }, { requestId: id, status: 201 });
  }

  if (action === 'cancel') {
    const sessionId = String(body.sessionId ?? '');
    const session = classSessionById(orgId, sessionId);
    if (session) {
      for (const rosterSeat of rosterFor(orgId, session)) {
        const seat = bookingById(orgId, rosterSeat.bookingId);
        if (!seat?.caseId || !seat.clientId) continue;
        const keyDenied = requireApiKeyScopes(ctx, ['cases:write']);
        if (keyDenied) return keyDenied;
        const caseDenied = requirePermission(ctx, 'cases.write', {
          area: 'cases', patientId: seat.clientId, assignedUserIds: assignedUserIdsForCase(orgId, seat.caseId),
        });
        if (caseDenied) return caseDenied;
      }
    }
    const result = cancelClassSession({ orgId, id: sessionId, actor, actorName, reason: body.reason });
    if (!result.ok) return fail(result.code as Parameters<typeof fail>[0], result.message, { param: 'sessionId', requestId: id });
    return ok({ session: result.summary, cancelledSeats: result.cancelledSeats, queueClosed: result.queueClosed }, { requestId: id });
  }

  return fail('VALIDATION_ERROR', '`action` must be one of: create, cancel.', { param: 'action', requestId: id });
}
