import { NextResponse, type NextRequest } from 'next/server';
import { actorLabel } from '@/lib/server/access-log';
import { archivePayer, payerById, updatePayer, type PayerDoc } from '@/lib/server/coverage';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const ctx = await requireAuth(req, { scopes: ['cases:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'cases.read');
  if (denied) return denied;
  const row = payerById(ctx.orgId, (await params).id);
  return row ? ok({ payer: row }, { requestId: ctx.requestId }) : fail('NOT_FOUND', 'That payer does not exist.', { requestId: ctx.requestId });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const ctx = await requireAuth(req, { scopes: ['cases:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'cases.write');
  if (denied) return denied;
  const body = await readJson<{
    action?: 'update' | 'archive'; expectedRevision?: number;
    patch?: Partial<Pick<PayerDoc, 'type' | 'name' | 'invoiceEmail' | 'invoicePhone' | 'billingAddress' | 'identifier'>>;
  }>(req, 32 * 1024);
  if (body instanceof NextResponse) return body;
  const { actor } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  const id = (await params).id;
  const result = body.action === 'archive'
    ? archivePayer({ orgId: ctx.orgId, id, expectedRevision: Number(body.expectedRevision), actorId: actor })
    : updatePayer({ orgId: ctx.orgId, id, expectedRevision: Number(body.expectedRevision), patch: body.patch ?? {}, actorId: actor });
  if (!result.ok) return fail(result.code === 'NOT_FOUND' ? 'NOT_FOUND' : result.code === 'CONFLICT' ? 'CONFLICT' : 'VALIDATION_ERROR', result.error, { requestId: ctx.requestId });
  return ok({ payer: result.value }, { requestId: ctx.requestId });
}
