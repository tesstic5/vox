import { NextRequest } from 'next/server';
import { clientIp, fail, ok, readJson, requestId } from '@/lib/server/api';
import { rateLimit, rateHeaders } from '@/lib/server/ratelimit';
import { bookingForToken, clientCancel, clientCheckIn, clientReschedule, manageView, offeredSlots } from '@/lib/server/manage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Moving or cancelling from the client's own link.
 *
 * Every action goes through the desk's own functions — `moveAppointment`,
 * `setAppointmentStatus` — so a client moving themselves gets the same rota
 * check, clash check, room pick, reminder reset and freed-slot offer as a
 * receptionist doing it. The link changes who is asking, never what is allowed.
 *
 * `check_in` is here as well as `confirm` because they are different facts: one
 * says "yes, I am coming", the other says "I am standing in your waiting room" —
 * and the board's "who has arrived" is only true if the second one is recorded.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const id = requestId();
  // Tighter than the read: this writes to a diary.
  const limit = rateLimit(`manage-write:${clientIp(req)}`, 20, 60_000);
  if (!limit.allowed) {
    return fail('RATE_LIMITED', 'Too many changes from this connection — try again in a minute.', { requestId: id, headers: rateHeaders(limit) });
  }

  const body = await readJson<{ action?: string; startsAt?: string; reason?: string; providerId?: string; locationId?: string }>(req);
  if (body instanceof Response) return body;

  const booking = bookingForToken(token);
  if (!booking) {
    return fail('NOT_FOUND', 'That link does not match an appointment.', { requestId: id });
  }

  const orgId = String(booking.orgId);
  const action = String(body.action ?? '');

  if (action === 'move') {
    if (!body.startsAt) return fail('VALIDATION_ERROR', 'Send the new time in `startsAt`.', { param: 'startsAt', requestId: id });
    const result = await clientReschedule({
      orgId,
      booking,
      startsAt: String(body.startsAt),
      providerId: body.providerId ? String(body.providerId) : undefined,
      locationId: body.locationId ? String(body.locationId) : undefined,
    });
    if (!result.ok) {
      // A refusal carries the desk's own sentence ("… is not working on …"), and
      // the slots are re-offered so the page can show a live alternative rather
      // than a wall.
      return fail(result.error === 'schedule_unavailable' ? 'SCHEDULE_UNAVAILABLE' : result.error === 'conflict' || result.error === 'closed' ? 'CONFLICT' : 'VALIDATION_ERROR', result.message, {
        requestId: id,
        headers: rateHeaders(limit),
      });
    }
    let slots;
    try { slots = await offeredSlots(orgId, bookingForToken(token) ?? booking); }
    catch { slots = { timezone: result.view.timezone, days: [] }; }
    return ok({ view: result.view, message: result.message, slots }, { requestId: id, headers: rateHeaders(limit) });
  }

  if (action === 'cancel') {
    const result = await clientCancel({ orgId, booking, reason: body.reason });
    if (!result.ok) {
      return fail(result.error === 'schedule_unavailable' ? 'SCHEDULE_UNAVAILABLE' : result.error === 'closed' || result.error === 'conflict' ? 'CONFLICT' : 'VALIDATION_ERROR', result.message, { requestId: id, headers: rateHeaders(limit) });
    }
    return ok({ view: result.view, message: result.message }, { requestId: id, headers: rateHeaders(limit) });
  }

  if (action === 'check_in') {
    const result = clientCheckIn({ orgId, booking });
    if (!result.ok) {
      return fail(result.error === 'schedule_unavailable' ? 'SCHEDULE_UNAVAILABLE' : result.error === 'closed' ? 'CONFLICT' : 'VALIDATION_ERROR', result.message, { requestId: id, headers: rateHeaders(limit) });
    }
    return ok({ view: result.view, message: result.message }, { requestId: id, headers: rateHeaders(limit) });
  }

  if (action === 'confirm') {
    // The same path the SMS reply takes, reachable from the page for anybody who
    // would rather tap than type.
    const { setAppointmentStatus } = await import('@/lib/server/diary');
    const result = setAppointmentStatus({
      orgId,
      id: booking.id,
      status: 'confirmed',
      actor: 'client',
      actorName: `${booking.customer?.name ?? 'the client'} (self-service link)`,
      note: 'confirmed from the self-service link',
    });
    if (!result.ok) return fail('CONFLICT', result.message, { requestId: id });
    return ok({ view: manageView(orgId, result.booking), message: 'Thank you — your appointment is confirmed.' }, { requestId: id, headers: rateHeaders(limit) });
  }

  return fail('VALIDATION_ERROR', '`action` must be one of: move, cancel, confirm, check_in.', { param: 'action', requestId: id });
}
