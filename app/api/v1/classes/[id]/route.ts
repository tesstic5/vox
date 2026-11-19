import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireApiKeyScopes, requireAuth, requirePermission, requireWriteRole } from '@/lib/server/api';
import { currentUser } from '@/lib/server/auth';
import { attendanceFor, classSessionById, joinClassSession, releaseSeat, rosterFor, summariseSession } from '@/lib/server/classes';
import { classQueueFor, joinClassWaitList } from '@/lib/server/class-waitlist';
import { STATUS_TRANSITIONS, setAppointmentStatus } from '@/lib/server/diary';
import { bookingById, type BookingStatus } from '@/lib/server/bookings';
import { assignedUserIdsForCase, caseById } from '@/lib/server/cases';
import { locationById, providerById } from '@/lib/server/practice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One class session, and the people in it (A8).
 *
 * `GET` is the roster the desk opens from the classes list or the diary: who has
 * a place, what state their place is in, and how many are left. Seat holders are
 * clients, so this is a records read — signed in, same as any other.
 *
 * `POST` is the two things a desk does to a roster: `add-seat` (put somebody in,
 * by client or by name and number — the walk-in case) and `remove-seat` (take
 * their place back, which frees it for somebody else and takes back any text
 * that was still queued for them).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;

  const session = classSessionById(ctx.orgId, id);
  if (!session) return fail('NOT_FOUND', `No class session with id ${id}.`, { requestId: ctx.requestId });

  const summary = summariseSession(ctx.orgId, session);
  return ok(
    {
      session: summary,
      roster: rosterFor(ctx.orgId, session),
      attendance: attendanceFor(ctx.orgId, session),
      /**
       * The queue for a place: who is in line, in order, and which of them has an
       * offer standing. A full class is the only place a queue can exist, so this
       * is the screen that answers "can we get her in?" without phoning around.
       */
      waitList: classQueueFor(ctx.orgId, session),
      instructor: providerById(ctx.orgId, session.providerId)?.name,
      site: locationById(ctx.orgId, session.locationId)?.name,
    },
    { requestId: ctx.requestId }
  );
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireWriteRole(ctx);
  if (denied) return denied;
  const { id } = await params;

  const session = classSessionById(ctx.orgId, id);
  if (!session) return fail('NOT_FOUND', `No class session with id ${id}.`, { requestId: ctx.requestId });

  const body = await readJson<{
    action?: string;
    clientId?: string;
    name?: string;
    number?: string;
    email?: string;
    bookingId?: string;
    caseId?: string;
    coverageId?: string;
    authorisationId?: string;
    fundingOverrideReason?: string;
    reason?: string;
    // Present so a seat can be bought at the desk: whether to allow the seat
    // without a text, and whether the person agreed to texts at all.
    consentSms?: boolean;
    /** The register: `arrived` | `completed` | `no_show` | `confirmed` (undo). */
    status?: string;
  }>(req);
  if (body instanceof NextResponse) return body;

  const who = await currentUser();
  const actorName = String((who as { user?: { name?: string } } | undefined)?.user?.name ?? '');
  const action = String(body.action ?? '');
  const auditActor = ctx.auth === 'key' ? `key:${ctx.key?.id}` : 'dashboard';
  const requireSeatCaseWrite = (bookingId: string) => {
    const seat = bookingById(ctx.orgId, bookingId);
    if (!seat?.caseId || !seat.clientId) return null;
    const keyDenied = requireApiKeyScopes(ctx, ['cases:write']);
    if (keyDenied) return keyDenied;
    return requirePermission(ctx, 'cases.write', {
      area: 'cases', patientId: seat.clientId, assignedUserIds: assignedUserIdsForCase(ctx.orgId, seat.caseId),
    });
  };

  if (action === 'add-seat') {
    let casePatientId: string | undefined;
    if (body.caseId) {
      const keyDenied = requireApiKeyScopes(ctx, ['cases:write']);
      if (keyDenied) return keyDenied;
      const caseRow = caseById(ctx.orgId, String(body.caseId));
      if (!caseRow) return fail('NOT_FOUND', 'The selected case does not exist.', { param: 'caseId', requestId: ctx.requestId });
      casePatientId = caseRow.patientId;
      if (body.clientId && String(body.clientId) !== caseRow.patientId) return fail('VALIDATION_ERROR', 'The selected case belongs to a different client.', { param: 'caseId', requestId: ctx.requestId });
      const caseDenied = requirePermission(ctx, 'cases.write', { area: 'cases', patientId: caseRow.patientId, assignedUserIds: assignedUserIdsForCase(ctx.orgId, caseRow.id) });
      if (caseDenied) return caseDenied;
    }
    const overrideReason = String(body.fundingOverrideReason ?? '').trim();
    if (overrideReason) {
      if (ctx.auth !== 'session' || !casePatientId) return fail('FORBIDDEN', 'Funding overrides require an authenticated staff session and selected case.', { requestId: ctx.requestId });
      const overrideDenied = requirePermission(ctx, 'funding.override', { area: 'cases', patientId: casePatientId });
      if (overrideDenied) return overrideDenied;
    }
    const result = joinClassSession({
      orgId: ctx.orgId,
      session,
      clientId: body.clientId ? String(body.clientId) : undefined,
      name: body.name,
      number: body.number,
      email: body.email,
      consentSms: Boolean(body.consentSms),
      caseId: body.caseId,
      coverageId: body.coverageId,
      authorisationId: body.authorisationId,
      fundingOverrideReason: overrideReason || undefined,
      source: 'dashboard',
      actorId: ctx.user?.id,
      actorName,
    });
    if (!result.ok) return fail(result.code as Parameters<typeof fail>[0], result.message, { param: result.param, requestId: ctx.requestId });
    if (result.already) {
      return ok(
        { seat: { bookingId: result.booking.id, name: result.clientName }, session: result.summary, already: true },
        { requestId: ctx.requestId }
      );
    }
    return ok(
      {
        seat: { bookingId: result.booking.id, name: result.clientName, reference: result.booking.externalId },
        session: result.summary,
        roster: rosterFor(ctx.orgId, session),
      },
      { requestId: ctx.requestId, status: 201 }
    );
  }

  if (action === 'remove-seat') {
    const bookingId = String(body.bookingId ?? '');
    if (!bookingId) return fail('VALIDATION_ERROR', '`bookingId` is required — take the seat whose place is ending.', { param: 'bookingId', requestId: ctx.requestId });
    const caseDenied = requireSeatCaseWrite(bookingId);
    if (caseDenied) return caseDenied;
    const result = releaseSeat({
      orgId: ctx.orgId,
      bookingId,
      actor: auditActor,
      actorName,
      reason: body.reason ? String(body.reason) : 'place given up at the desk',
      quiet: true,
    });
    if (!result.ok) return fail(result.code as Parameters<typeof fail>[0], result.message, { requestId: ctx.requestId });
    return ok(
      {
        session: result.summary,
        roster: rosterFor(ctx.orgId, session),
        // The place went to the front of the class's queue, if anybody was in it.
        offered: result.offered ?? 0,
        waitList: classQueueFor(ctx.orgId, session),
      },
      { requestId: ctx.requestId }
    );
  }

  /**
   * Somebody wants a place in a class that is full (or the desk is ringing them
   * back). The queue has one home — `class-waitlist.ts` — and this is the desk's
   * door into it; the public page has another, and both land in the same line.
   */
  if (action === 'add-waiter') {
    const joined = joinClassWaitList({
      orgId: ctx.orgId,
      session,
      clientId: body.clientId ? String(body.clientId) : undefined,
      name: body.name ? String(body.name) : undefined,
      number: body.number ? String(body.number) : undefined,
      email: body.email ? String(body.email) : undefined,
      source: 'dashboard',
      actor: auditActor,
      actorName,
    });
    if (!joined.ok) return fail(joined.code as Parameters<typeof fail>[0], joined.message, { param: joined.param, requestId: ctx.requestId });
    return ok(
      {
        entry: joined.entry,
        position: joined.position,
        already: joined.already,
        waitList: classQueueFor(ctx.orgId, session),
      },
      { requestId: ctx.requestId, status: joined.already ? 200 : 201 }
    );
  }

  /**
   * Marking a place — the register.
   *
   * A seat is a booking, so the lifecycle is the booking lifecycle and every rule
   * about what may follow what (`STATUS_TRANSITIONS`) already applies. What this
   * action adds is the two things the class knows and the generic status route
   * does not: that the booking has to be a place in *this* session, and that a
   * session which has been called off has no register — marking one of its
   * released seats would quietly resurrect it.
   */
  if (action === 'mark-seat' || action === 'everyone-arrived') {
    if (session.status === 'cancelled') {
      return fail('CONFLICT', 'That class was called off — its places are gone, so there is no register to mark.', { param: 'sessionId', requestId: ctx.requestId });
    }
    const mine = rosterFor(ctx.orgId, session);

    if (action === 'everyone-arrived') {
      for (const seat of mine) {
        const caseDenied = requireSeatCaseWrite(seat.bookingId);
        if (caseDenied) return caseDenied;
      }
      // The common case at the door: the whole room is here. Only places that can
      // legally become `arrived` are touched, so a seat already completed or
      // marked no-show is left as the record it is.
      const marked: string[] = [];
      for (const seat of mine) {
        if (!['pending', 'confirmed'].includes(seat.status)) continue;
        const done = setAppointmentStatus({ orgId: ctx.orgId, id: seat.bookingId, status: 'arrived', actor: auditActor, actorName, note: 'class register' });
        if (done.ok) marked.push(seat.bookingId);
      }
      return ok(
        {
          marked: marked.length,
          skipped: mine.length - marked.length,
          session: summariseSession(ctx.orgId, session),
          roster: rosterFor(ctx.orgId, session),
          attendance: attendanceFor(ctx.orgId, session),
        },
        { requestId: ctx.requestId }
      );
    }

    const bookingId = String(body.bookingId ?? '');
    const status = String(body.status ?? '') as BookingStatus;
    if (!bookingId) return fail('VALIDATION_ERROR', '`bookingId` is required — mark the place you mean.', { param: 'bookingId', requestId: ctx.requestId });
    if (!(status in STATUS_TRANSITIONS)) {
      return fail('VALIDATION_ERROR', `\`status\` must be one of: ${Object.keys(STATUS_TRANSITIONS).join(', ')}.`, { param: 'status', requestId: ctx.requestId });
    }
    if (!mine.some((seat) => seat.bookingId === bookingId)) {
      return fail('NOT_FOUND', 'That booking is not a place in this class.', { param: 'bookingId', requestId: ctx.requestId });
    }
    const caseDenied = requireSeatCaseWrite(bookingId);
    if (caseDenied) return caseDenied;
    const result = setAppointmentStatus({ orgId: ctx.orgId, id: bookingId, status, note: body.reason ? String(body.reason) : 'class register', actor: auditActor, actorName });
    if (!result.ok) {
      if (result.error === 'not_found') return fail('NOT_FOUND', result.message, { requestId: ctx.requestId });
      return fail('CONFLICT', result.message, { param: 'status', requestId: ctx.requestId });
    }
    return ok(
      {
        seat: { bookingId, status: String(result.booking.status) },
        session: summariseSession(ctx.orgId, session),
        roster: rosterFor(ctx.orgId, session),
        attendance: attendanceFor(ctx.orgId, session),
      },
      { requestId: ctx.requestId }
    );
  }

  return fail('VALIDATION_ERROR', '`action` must be one of: add-seat, remove-seat, add-waiter, mark-seat, everyone-arrived.', { param: 'action', requestId: ctx.requestId });
}
