import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth } from '@/lib/server/api';
import { canEditMoney, canReadMoney } from '@/lib/server/money';
import { createPackProduct, packLiability, packProductsFor, packSummariesFor } from '@/lib/server/packs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Class packs: the products a practice sells ("10 × Yoga — $200"), the packs
 * clients hold, and the liability line (money held for places not yet taken).
 *
 * Reading the books is open to desk roles; pricing a pack is owner/admin/
 * developer work (`canEditMoney`), the same rule as the rest of Money.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (!(ctx.auth === 'key' || canReadMoney(ctx.user?.role))) {
    return fail('FORBIDDEN', 'This role cannot read the practice books.', { requestId: ctx.requestId });
  }
  const url = new URL(req.url);
  const clientId = url.searchParams.get('clientId') ?? undefined;
  return ok(
    {
      products: packProductsFor(ctx.orgId, { includeInactive: true }),
      packs: packSummariesFor(ctx.orgId, { clientId }),
      liability: packLiability(ctx.orgId),
    },
    { requestId: ctx.requestId }
  );
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (!canEditMoney(ctx.user?.role)) {
    return fail('FORBIDDEN', 'Pricing a pack is owner, admin or developer work.', { requestId: ctx.requestId });
  }
  const body = await readJson<{ serviceId?: string; name?: string; places?: number; priceMinor?: number; expiryMonths?: number }>(req);
  if (body instanceof NextResponse) return body;
  const result = createPackProduct({
    orgId: ctx.orgId,
    serviceId: String(body.serviceId ?? ''),
    name: String(body.name ?? ''),
    places: Number(body.places),
    priceMinor: Number(body.priceMinor),
    expiryMonths: body.expiryMonths === undefined ? undefined : Number(body.expiryMonths),
    actor: ctx.auth === 'key' ? `key:${ctx.key?.id}` : 'dashboard',
    actorName: ctx.user?.name,
  });
  if (!result.ok) return fail(result.code as Parameters<typeof fail>[0], result.message, { param: result.param, requestId: ctx.requestId });
  return ok({ product: result.value }, { requestId: ctx.requestId, status: 201 });
}
