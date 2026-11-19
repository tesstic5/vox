import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth } from '@/lib/server/api';
import { canEditMoney, canReadMoney } from '@/lib/server/money';
import { clientPackById, extendPack, refundPackUnused, summarisePack, transferPack } from '@/lib/server/packs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One pack a client holds, and the three things the desk may do to it after
 * the sale: extend it (reasoned), transfer what is left (reasoned), refund
 * what was never spent. All three are books work, so all three need a
 * money-edit role — a refund is money leaving, and an extension or transfer
 * quietly rewrites what money is owed to whom.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (!(ctx.auth === 'key' || canReadMoney(ctx.user?.role))) {
    return fail('FORBIDDEN', 'This role cannot read the practice books.', { requestId: ctx.requestId });
  }
  const { id } = await params;
  const pack = clientPackById(ctx.orgId, id);
  if (!pack) return fail('NOT_FOUND', `No pack with id ${id}.`, { requestId: ctx.requestId });
  return ok({ pack: summarisePack(ctx.orgId, pack) }, { requestId: ctx.requestId });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (!canEditMoney(ctx.user?.role)) {
    return fail('FORBIDDEN', 'Changing a pack is owner, admin or developer work.', { requestId: ctx.requestId });
  }
  const { id } = await params;
  const body = await readJson<{ action?: string; months?: number; reason?: string; toClientId?: string }>(req);
  if (body instanceof NextResponse) return body;
  const actor = ctx.auth === 'key' ? `key:${ctx.key?.id}` : 'dashboard';
  const action = String(body.action ?? '');

  if (action === 'extend') {
    const result = extendPack({ orgId: ctx.orgId, packId: id, months: Number(body.months), reason: String(body.reason ?? ''), actor });
    if (!result.ok) return fail(result.code as Parameters<typeof fail>[0], result.message, { param: result.param, requestId: ctx.requestId });
    return ok({ pack: result.value }, { requestId: ctx.requestId });
  }
  if (action === 'transfer') {
    const result = transferPack({ orgId: ctx.orgId, packId: id, toClientId: String(body.toClientId ?? ''), reason: String(body.reason ?? ''), actor });
    if (!result.ok) return fail(result.code as Parameters<typeof fail>[0], result.message, { param: result.param, requestId: ctx.requestId });
    return ok({ pack: result.value }, { requestId: ctx.requestId });
  }
  if (action === 'refund-unused') {
    const result = refundPackUnused({ orgId: ctx.orgId, packId: id, actor, actorName: ctx.user?.name });
    if (!result.ok) return fail(result.code as Parameters<typeof fail>[0], result.message, { requestId: ctx.requestId });
    return ok({ pack: result.value.pack, refundedMinor: result.value.refundedMinor }, { requestId: ctx.requestId });
  }
  return fail('VALIDATION_ERROR', '`action` must be one of: extend, transfer, refund-unused.', { param: 'action', requestId: ctx.requestId });
}
