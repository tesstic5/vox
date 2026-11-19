import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth } from '@/lib/server/api';
import { campaignById, campaignsFor, updateCampaign, withinQuietHours } from '@/lib/server/booking-campaigns';
import { describeBooking, dueBookings } from '@/lib/server/bookings';
import { remove } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const campaign = campaignById(ctx.orgId, id);
  if (!campaign) return fail('NOT_FOUND', `No campaign with id ${id}.`, { requestId: ctx.requestId });

  const due = dueBookings(ctx.orgId, { withinHours: campaign.withinHours, skipAttempted: true });
  return ok(
    {
      ...campaign,
      dueNow: due.length,
      inQuietHours: withinQuietHours(campaign),
      upcoming: due.slice(0, 10).map((b) => ({
        bookingId: b.id,
        externalId: b.externalId,
        customer: b.customer.name,
        to: b.customer.number,
        description: describeBooking(b),
        attempts: b.attempts.length,
      })),
    },
    { requestId: ctx.requestId }
  );
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson<Record<string, never>>(req);
  if (body instanceof NextResponse) return body;
  const allowed = ['name', 'kind', 'assistantId', 'numberId', 'carrierId', 'withinHours', 'maxPerRun', 'quietHours', 'pacingSeconds', 'retry', 'instructions', 'status', 'channels'];
  const patch: Record<string, unknown> = {};
  for (const key of allowed) if (key in body) patch[key] = (body as Record<string, unknown>)[key];
  if (patch.status && !['active', 'paused'].includes(String(patch.status))) {
    return fail('VALIDATION_ERROR', '`status` must be "active" or "paused".', { param: 'status', requestId: ctx.requestId });
  }
  const updated = updateCampaign(ctx.orgId, id, patch as never);
  if (!updated) return fail('NOT_FOUND', `No campaign with id ${id}.`, { requestId: ctx.requestId });
  return ok({ ...updated, dueNow: dueBookings(ctx.orgId, { withinHours: updated.withinHours, skipAttempted: true }).length, inQuietHours: withinQuietHours(updated) }, { requestId: ctx.requestId });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (!campaignById(ctx.orgId, id)) return fail('NOT_FOUND', `No campaign with id ${id}.`, { requestId: ctx.requestId });
  remove('bookingCampaigns', id);
  return ok({ id, deleted: true, remaining: campaignsFor(ctx.orgId).length, note: 'Bookings are untouched — only the dialling schedule is gone.' }, { requestId: ctx.requestId });
}
