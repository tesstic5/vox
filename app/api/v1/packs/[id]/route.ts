import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth } from '@/lib/server/api';
import { canEditMoney, canTakePayment } from '@/lib/server/money';
import { packProductById, purchasePack, updatePackProduct } from '@/lib/server/packs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One pack product. `PATCH` re-prices or retires it (packs already sold keep
 * the terms they were bought on). `POST` sells it: taking the money is the
 * one money write a receptionist may do, like any other payment.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (!canEditMoney(ctx.user?.role)) {
    return fail('FORBIDDEN', 'Pricing a pack is owner, admin or developer work.', { requestId: ctx.requestId });
  }
  const { id } = await params;
  if (!packProductById(ctx.orgId, id)) return fail('NOT_FOUND', `No pack product with id ${id}.`, { requestId: ctx.requestId });
  const body = await readJson<{ name?: string; places?: number; priceMinor?: number; expiryMonths?: number; active?: boolean }>(req);
  if (body instanceof NextResponse) return body;
  const result = updatePackProduct({
    orgId: ctx.orgId,
    id,
    patch: body,
    actor: ctx.auth === 'key' ? `key:${ctx.key?.id}` : 'dashboard',
  });
  if (!result.ok) return fail(result.code as Parameters<typeof fail>[0], result.message, { param: result.param, requestId: ctx.requestId });
  return ok({ product: result.value }, { requestId: ctx.requestId });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (!canTakePayment(ctx.user?.role)) {
    return fail('FORBIDDEN', 'This role cannot take payment.', { requestId: ctx.requestId });
  }
  const { id } = await params;
  const body = await readJson<{ action?: string; clientId?: string; method?: string }>(req);
  if (body instanceof NextResponse) return body;
  if (String(body.action ?? 'purchase') !== 'purchase') {
    return fail('VALIDATION_ERROR', '`action` must be `purchase`.', { param: 'action', requestId: ctx.requestId });
  }
  const result = purchasePack({
    orgId: ctx.orgId,
    productId: id,
    clientId: String(body.clientId ?? ''),
    method: body.method ? String(body.method) : undefined,
    actor: ctx.auth === 'key' ? `key:${ctx.key?.id}` : 'dashboard',
    actorName: ctx.user?.name,
  });
  if (!result.ok) return fail(result.code as Parameters<typeof fail>[0], result.message, { param: result.param, requestId: ctx.requestId });
  return ok({ pack: result.value }, { requestId: ctx.requestId, status: 201 });
}
