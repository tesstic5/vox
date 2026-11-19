import { NextResponse, type NextRequest } from 'next/server';
import { actorLabel } from '@/lib/server/access-log';
import { fail, listBody, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { createPayer, payersFor, type PayerDoc } from '@/lib/server/coverage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['cases:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'cases.read');
  if (denied) return denied;
  return ok(listBody(payersFor(ctx.orgId, new URL(req.url).searchParams.get('includeArchived') === 'true')), { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['cases:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'cases.write');
  if (denied) return denied;
  const body = await readJson<{ type?: PayerDoc['type']; name?: string; invoiceEmail?: string; invoicePhone?: string; billingAddress?: string; identifier?: string }>(req, 32 * 1024);
  if (body instanceof NextResponse) return body;
  const { actor } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  const result = createPayer({ orgId: ctx.orgId, type: body.type ?? 'organisation', name: String(body.name ?? ''), invoiceEmail: body.invoiceEmail, invoicePhone: body.invoicePhone, billingAddress: body.billingAddress, identifier: body.identifier, actorId: actor });
  if (!result.ok) return fail(result.code === 'CONFLICT' ? 'CONFLICT' : 'VALIDATION_ERROR', result.error, { requestId: ctx.requestId });
  return ok({ payer: result.value }, { status: 201, requestId: ctx.requestId });
}
