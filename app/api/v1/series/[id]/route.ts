import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireWriteRole } from '@/lib/server/api';
import { cancelSeries, seriesFor } from '@/lib/server/diary';
import { actorLabel } from '@/lib/server/access-log';
import { offerFreedSlot } from '@/lib/server/wait-offers';
import { bookingById } from '@/lib/server/bookings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const rows = seriesFor(ctx.orgId, id);
  if (!rows.length) return fail('NOT_FOUND', `No series with id ${id}.`, { requestId: ctx.requestId });
  return ok({ object: 'list', seriesId: id, data: rows, total: rows.length }, { requestId: ctx.requestId });
}

/** DELETE cancels the series from a point onwards — or all of it. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireWriteRole(ctx);
  if (denied) return denied;
  const body = await readJson<{ from?: string }>(req);
  if (body instanceof NextResponse) return body;
  if (!seriesFor(ctx.orgId, id).length) return fail('NOT_FOUND', `No series with id ${id}.`, { requestId: ctx.requestId });
  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  const result = cancelSeries({ orgId: ctx.orgId, seriesId: id, from: body.from, actor, actorName });

  // A cancelled series frees one slot per occurrence, so each is offered on its
  // own merits — the same thing a single cancellation does, repeated.
  let offered = 0;
  for (const bookingId of result.ids) {
    const row = bookingById(ctx.orgId, bookingId);
    if (!row) continue;
    offered += offerFreedSlot({ orgId: ctx.orgId, booking: row, actor, actorName }).offered.length;
  }
  return ok({ ...result, offered }, { requestId: ctx.requestId });
}
