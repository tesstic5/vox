import { NextResponse, type NextRequest } from 'next/server';
import { fail, listBody, ok, readJson, requireAuth, requireWriteRole } from '@/lib/server/api';
import { cancelMessage, deliverDueMessages, messagesFor, queueMessage } from '@/lib/server/messages';
import { queueDueReminders } from '@/lib/server/maintenance';
import { actorLabel } from '@/lib/server/access-log';
import { findClientByNumber, clientById, consentFor } from '@/lib/server/clients';
import { describeBooking, bookingById } from '@/lib/server/bookings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Outbound messages — what the practice has sent, and what is about to go.
 *
 * The desk's question is "did the reminder actually go out?", so the list carries
 * the answer (`status`, `sentAt`, `reason`) rather than only the intent. Nothing
 * here can be sent to somebody who has withdrawn consent: the queue refuses it at
 * creation and again at send time.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  const status = url.searchParams.get('status') ?? undefined;
  const bookingId = url.searchParams.get('bookingId') ?? undefined;
  const clientId = url.searchParams.get('clientId') ?? undefined;
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, 500);

  const rows = messagesFor(ctx.orgId, (m) => {
    if (status && m.status !== status) return false;
    if (bookingId && m.bookingId !== bookingId) return false;
    if (clientId && m.clientId !== clientId) return false;
    return true;
  }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  const tally = rows.reduce<Record<string, number>>((acc, m) => ({ ...acc, [m.status]: (acc[m.status] ?? 0) + 1 }), {});
  return ok(
    {
      ...listBody(rows.slice(0, limit), { total: rows.length }),
      stats: tally,
    },
    { requestId: ctx.requestId }
  );
}

/**
 * Two things this POST does, kept apart on purpose:
 *
 *  - `action: 'send'` queues a message by hand (a receptionist ringing somebody
 *    back, a note to confirm an address). Consent still applies.
 *  - `action: 'deliver'` runs the queue now. It is here rather than only in the
 *    sweep so an operator can prove delivery end to end without waiting for the
 *    timer, and so a workspace with no scheduler still works.
 */
export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireWriteRole(ctx);
  if (denied) return denied;
  const body = await readJson<{
    action?: 'send' | 'deliver' | 'queue-reminders';
    channel?: 'sms' | 'email';
    to?: string;
    clientId?: string;
    bookingId?: string;
    body?: string;
    subject?: string;
    sendAt?: string;
    limit?: number;
    /** Staff may send a transactional message with the consent on the booking. */
    force?: boolean;
  }>(req);
  if (body instanceof NextResponse) return body;
  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });

  // Queueing reminders by hand is an operator action, and an idempotent one: the
  // appointment id is the key, so running it twice queues nothing extra. It is
  // here so the rule can be proved without waiting for the timer.
  if (body.action === 'queue-reminders') {
    const queued = queueDueReminders(Date.now(), ctx.orgId);
    const pending = messagesFor(ctx.orgId, (m) => m.status === 'pending' && m.meta?.kind === 'reminder').length;
    return ok({ queued, pendingReminders: pending, leadMinutes: Number(process.env.VOXERA_REMINDER_LEAD_MINUTES ?? 1440) }, { requestId: ctx.requestId });
  }

  if ((body.action ?? 'send') === 'deliver') {
    const result = await deliverDueMessages({ orgId: ctx.orgId, limit: body.limit ?? 25 });
    return ok(
      {
        sent: result.sent,
        blocked: result.blocked,
        failed: result.failed,
        stillPending: result.skipped,
        messages: result.messages.map((m) => ({ id: m.id, status: m.status, channel: m.channel, to: m.to, reason: m.reason })),
      },
      { requestId: ctx.requestId }
    );
  }

  const channel = body.channel === 'email' ? 'email' : 'sms';
  const client = body.clientId ? clientById(ctx.orgId, body.clientId) : body.to ? findClientByNumber(ctx.orgId, body.to) : undefined;
  const to = String(body.to ?? client?.number ?? '').trim();
  if (!to && channel === 'sms') return fail('VALIDATION_ERROR', '`to` is required — there is no number to text.', { param: 'to', requestId: ctx.requestId });
  const text = String(body.body ?? '').trim();
  if (!text) return fail('VALIDATION_ERROR', '`body` is required.', { param: 'body', requestId: ctx.requestId });

  const booking = body.bookingId ? bookingById(ctx.orgId, body.bookingId) : undefined;
  if (body.bookingId && !booking) return fail('NOT_FOUND', `No booking with id ${body.bookingId}.`, { requestId: ctx.requestId });

  const consent = consentFor(ctx.orgId, { id: client?.id, number: to }, channel);
  if (!consent.granted && !body.force) {
    return fail('CONFLICT', `${client?.name ?? to} has opted out of ${channel}.`, {
      param: 'channel',
      detail: consent.reason ?? 'no consent on file',
      requestId: ctx.requestId,
    });
  }

  const message = queueMessage({
    orgId: ctx.orgId,
    channel,
    to,
    body: text,
    subject: body.subject,
    clientId: client?.id,
    bookingId: booking?.id,
    sendAt: body.sendAt,
    source: `desk:${actor}`,
    meta: { kind: 'manual', by: actorName ?? actor },
    respectConsent: !body.force,
  });

  return ok(
    {
      message: {
        id: message.id,
        channel: message.channel,
        to: message.to,
        status: message.status,
        sendAt: message.sendAt,
        reason: message.reason,
      },
      consent: { granted: consent.granted, source: consent.source },
      booking: booking ? describeBooking(booking) : undefined,
    },
    { requestId: ctx.requestId, status: 201 }
  );
}

/** Cancelling a queued message is a desk action, not a delete. */
export async function DELETE(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireWriteRole(ctx);
  if (denied) return denied;
  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  if (!id) return fail('VALIDATION_ERROR', '`id` is required.', { param: 'id', requestId: ctx.requestId });
  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  const cancelled = cancelMessage(ctx.orgId, id, actor, `cancelled by ${actorName ?? actor}`);
  if (!cancelled) return fail('NOT_FOUND', `No message with id ${id}.`, { requestId: ctx.requestId });
  return ok({ id: cancelled.id, status: cancelled.status }, { requestId: ctx.requestId });
}
