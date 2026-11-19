import { NextResponse, type NextRequest } from 'next/server';
import { fail, listBody, ok, readJson, requireAuth } from '@/lib/server/api';
import { campaignsFor, createCampaign, withinQuietHours } from '@/lib/server/booking-campaigns';
import { list, type Doc } from '@/lib/server/db';
import { dueBookings, describeBooking, bookingStats } from '@/lib/server/bookings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Campaigns: "call everyone booked tomorrow and confirm they are coming."
 *
 * A campaign is the standing instruction; a *run* is one tick of it. Runs are
 * driven from outside — `POST /v1/booking-campaigns/{id}/run` from a cron, a
 * queue worker, or the dashboard button — so nothing here depends on a scheduler
 * being deployed with the app.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const campaigns = campaignsFor(ctx.orgId).map((c) => ({
    ...c,
    dueNow: dueBookings(ctx.orgId, { withinHours: c.withinHours, skipAttempted: true }).length,
    inQuietHours: withinQuietHours(c),
  }));
  return ok(listBody(campaigns, { stats: bookingStats(ctx.orgId) }), { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson<{
    name?: string;
    kind?: string;
    assistantId?: string;
    numberId?: string;
    carrierId?: string;
    withinHours?: number;
    maxPerRun?: number;
    quietHours?: { start?: number; end?: number; timezone?: string };
    pacingSeconds?: number;
    instructions?: string;
    channels?: { call?: boolean; sms?: boolean };
    status?: string;
  }>(req);
  if (body instanceof NextResponse) return body;
  if (!body.name) return fail('VALIDATION_ERROR', '`name` is required.', { param: 'name', requestId: ctx.requestId });
  if (!body.assistantId) return fail('VALIDATION_ERROR', '`assistantId` is required — a campaign needs an agent to speak.', { param: 'assistantId', requestId: ctx.requestId });

  const campaign = createCampaign({
    orgId: ctx.orgId,
    name: body.name,
    kind: body.kind as never,
    assistantId: body.assistantId,
    numberId: body.numberId,
    carrierId: body.carrierId,
    withinHours: body.withinHours,
    maxPerRun: body.maxPerRun,
    quietHours: body.quietHours
      ? { start: Number(body.quietHours.start ?? 9), end: Number(body.quietHours.end ?? 19), timezone: body.quietHours.timezone }
      : undefined,
    pacingSeconds: body.pacingSeconds,
    instructions: body.instructions,
    channels: body.channels ? { call: body.channels.call !== false, sms: body.channels.sms === true } : undefined,
    status: (body.status as never) ?? 'paused',
  });

  // An assistant that cannot move or cancel a booking will take the call and then
  // have nothing to do with it — worth saying at creation, not at 6pm.
  const assistant = list<Doc & { tools?: string[] }>('assistants', (a) => a.id === body.assistantId && a.orgId === ctx.orgId)[0];
  const assistantTools = new Set(assistant?.tools ?? []);
  const warnings: string[] = [];
  if (assistant && !assistantTools.has('reschedule_appointment')) warnings.push('This assistant has no `reschedule_appointment` tool — it can confirm, but not move an appointment.');
  if (assistant && !assistantTools.has('cancel_appointment')) warnings.push('This assistant has no `cancel_appointment` tool — it cannot cancel for the customer.');
  if (assistant && !assistantTools.has('lookup_order') && !assistantTools.has('order_status')) warnings.push('This assistant cannot look up the booking, so it will ask rather than tell the customer when their appointment is.');

  const due = dueBookings(ctx.orgId, { withinHours: campaign.withinHours, skipAttempted: true });
  return ok(
    {
      ...campaign,
      dueNow: due.length,
      warnings,
      preview: due.slice(0, 5).map((b) => ({ externalId: b.externalId, customer: b.customer.name, to: b.customer.number, description: describeBooking(b) })),
      note:
        campaign.status === 'paused'
          ? 'Created paused, so nothing rings until you run it. POST …/run?dryRun=false to dial for real.'
          : 'Active — a run will dial when it is inside calling hours.',
    },
    { requestId: ctx.requestId, status: 201 }
  );
}
