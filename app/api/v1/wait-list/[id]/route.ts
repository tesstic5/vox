import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireWriteRole } from '@/lib/server/api';
import { deleteWaitEntry, removeWaitEntry } from '@/lib/server/diary';
import { actorLabel } from '@/lib/server/access-log';
import { waitListFor } from '@/lib/server/diary';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** PATCH closes an entry (`booked`, `cancelled`, `offered`). DELETE removes it. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireWriteRole(ctx);
  if (denied) return denied;
  const body = await readJson<{ status?: 'booked' | 'cancelled' | 'offered' | 'expired' }>(req);
  if (body instanceof NextResponse) return body;
  const entry = waitListFor(ctx.orgId, { includeCancelled: true }).find((w) => w.id === id);
  if (!entry) return fail('NOT_FOUND', `No wait-list entry with id ${id}.`, { requestId: ctx.requestId });
  const { actor } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  removeWaitEntry(ctx.orgId, id, actor, body.status ?? 'cancelled');
  return ok({ id, status: body.status ?? 'cancelled' }, { requestId: ctx.requestId });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireWriteRole(ctx);
  if (denied) return denied;
  const { actor } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  if (!deleteWaitEntry(ctx.orgId, id, actor)) return fail('NOT_FOUND', `No wait-list entry with id ${id}.`, { requestId: ctx.requestId });
  return ok({ id, deleted: true }, { requestId: ctx.requestId });
}
