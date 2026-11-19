import { NextResponse, type NextRequest } from 'next/server';
import { fail, listBody, ok, readJson, requireAuth, requireWriteRole } from '@/lib/server/api';
import { actorLabel } from '@/lib/server/access-log';
import { outreachFor, outreachStats } from '@/lib/server/outreach';
import { noShowReport, recordManualTouch, outreachSummary } from '@/lib/server/outreach-report';
import { clientById, findClientByNumber } from '@/lib/server/clients';
import { bookingById, describeBooking } from '@/lib/server/bookings';
import { outreachRules, setOutreachRules } from '@/lib/server/outreach-rules';
import { messagingSettings, setMessagingSettings, messagingTimezone } from '@/lib/server/messages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The outreach log, the rules behind it, and the two questions a practice manager
 * actually asks: *is anybody being told?* and *who is not turning up?*
 *
 * `GET ?view=log` is the timeline, `?view=rules` the rule switches, `?view=report`
 * the no-show report, `?view=settings` the quiet hours and channels.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  const view = url.searchParams.get('view') ?? 'log';
  const days = Math.min(Math.max(Number(url.searchParams.get('days') ?? 30) || 30, 1), 365);

  if (view === 'rules') {
    return ok(
      {
        rules: outreachRules(ctx.orgId),
        settings: messagingSettings(ctx.orgId),
        timezone: messagingTimezone(ctx.orgId),
      },
      { requestId: ctx.requestId }
    );
  }

  if (view === 'report') {
    const report = noShowReport(ctx.orgId, { days });
    return ok({ report, summary: outreachSummary(ctx.orgId, days) }, { requestId: ctx.requestId });
  }

  if (view === 'summary') {
    return ok({ summary: outreachSummary(ctx.orgId, days) }, { requestId: ctx.requestId });
  }

  const clientId = url.searchParams.get('clientId') ?? undefined;
  const bookingId = url.searchParams.get('bookingId') ?? undefined;
  const kind = url.searchParams.get('kind') ?? undefined;
  const channel = url.searchParams.get('channel') ?? undefined;
  const since = url.searchParams.get('since') ?? undefined;
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, 500);

  const rows = outreachFor(ctx.orgId, {
    clientId,
    bookingId,
    kind: kind as never,
    channel: channel as never,
    since,
  });

  return ok(
    {
      ...listBody(rows.slice(0, limit), { total: rows.length }),
      stats: outreachStats(ctx.orgId, since),
      // Rows carry ids; the desk needs names, so they are joined here rather than
      // left for the browser to fetch one call at a time.
      names: Object.fromEntries(
        rows
          .map((row) => row.clientId)
          .filter((id, index, all): id is string => Boolean(id) && all.indexOf(id) === index)
          .map((id) => [id, clientById(ctx.orgId, id)?.name ?? 'Unknown client'])
      ),
    },
    { requestId: ctx.requestId }
  );
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireWriteRole(ctx);
  if (denied) return denied;
  const body = await readJson<{
    action?: 'log-touch' | 'save-rules' | 'save-settings';
    clientId?: string;
    bookingId?: string;
    to?: string;
    channel?: 'sms' | 'email' | 'call';
    kind?: string;
    outcome?: string;
    note?: string;
    rules?: Record<string, unknown>;
    settings?: Record<string, unknown>;
  }>(req);
  if (body instanceof NextResponse) return body;
  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });

  if (body.action === 'log-touch') {
    const channel = body.channel === 'email' || body.channel === 'call' ? body.channel : 'sms';
    const client = body.clientId ? clientById(ctx.orgId, body.clientId) : body.to ? findClientByNumber(ctx.orgId, String(body.to)) : undefined;
    const booking = body.bookingId ? bookingById(ctx.orgId, body.bookingId) : undefined;
    if (body.bookingId && !booking) return fail('NOT_FOUND', `No booking with id ${body.bookingId}.`, { requestId: ctx.requestId });
    if (!client && !booking) return fail('VALIDATION_ERROR', 'A touch needs a client or an appointment to attach to.', { requestId: ctx.requestId });
    if (!body.outcome) return fail('VALIDATION_ERROR', '`outcome` is required — what came of the touch?', { param: 'outcome', requestId: ctx.requestId });

    const row = recordManualTouch({
      orgId: ctx.orgId,
      clientId: client?.id,
      bookingId: booking?.id,
      channel,
      kind: (body.kind as never) ?? 'manual',
      outcome: body.outcome as never,
      to: String(body.to ?? client?.number ?? ''),
      note: typeof body.note === 'string' ? body.note.slice(0, 500) : undefined,
      actor,
      actorName,
    });
    return ok(
      {
        outreach: { id: row.id, channel: row.channel, kind: row.kind, outcome: row.outcome, at: row.at },
        booking: booking ? describeBooking(booking) : undefined,
      },
      { requestId: ctx.requestId, status: 201 }
    );
  }

  if (body.action === 'save-rules') {
    const rules = setOutreachRules(ctx.orgId, (body.rules ?? {}) as never, actor);
    return ok({ rules, timezone: messagingTimezone(ctx.orgId) }, { requestId: ctx.requestId });
  }

  if (body.action === 'save-settings') {
    const settings = setMessagingSettings(ctx.orgId, (body.settings ?? {}) as never, actor);
    return ok({ settings, timezone: messagingTimezone(ctx.orgId) }, { requestId: ctx.requestId });
  }

  return fail('VALIDATION_ERROR', `Unknown action "${String(body.action ?? '')}".`, { requestId: ctx.requestId });
}
