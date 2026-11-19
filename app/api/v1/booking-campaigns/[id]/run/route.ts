import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth } from '@/lib/server/api';
import { campaignById, runCampaign } from '@/lib/server/booking-campaigns';
import { describeBooking } from '@/lib/server/bookings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** A run may dial several numbers in sequence, so give it room. */
export const maxDuration = 60;

/**
 * One tick of a campaign.
 *
 * `POST …/run` is a dry run — it reports who *would* be rung and why, and dials
 * nothing. `POST …/run { "dryRun": false }` places the calls. That default is
 * deliberate: pointing a scheduler at this endpoint should never be able to ring
 * strangers by accident.
 *
 * Every run returns its `reasons`, including the boring ones — outside calling
 * hours, nobody due, no carrier connected — because "the campaign ran and nothing
 * happened" is the question an operator will ask.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const campaign = campaignById(ctx.orgId, id);
  if (!campaign) return fail('NOT_FOUND', `No campaign with id ${id}.`, { requestId: ctx.requestId });

  const body = await readJson<{ dryRun?: boolean; atHour?: number }>(req);
  if (body instanceof NextResponse) return body;

  // An explicit `status: paused` campaign refuses to dial, even on request: the
  // switch has to mean something.
  if (body.dryRun === false && campaign.status !== 'active') {
    return fail('VALIDATION_ERROR', 'This campaign is paused. PATCH it to `active` before dialling, or run a dry run.', {
      param: 'dryRun',
      requestId: ctx.requestId,
    });
  }

  const result = await runCampaign({
    orgId: ctx.orgId,
    campaignId: id,
    dryRun: body.dryRun !== false,
    atHour: typeof body.atHour === 'number' ? body.atHour : undefined,
    describe: describeBooking,
  });

  return ok(result, { requestId: ctx.requestId, status: result.ok ? 200 : 409 });
}
