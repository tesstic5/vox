import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, publicOrigin, readJson, requireAuth, requireVerifiedEmail } from '@/lib/server/api';
import {
  createJob,
  estimateById,
  reviseSharedEstimate,
  shareEstimate,
  updateEstimate,
  type EstimateLineInput,
  type SiteAddress,
} from '@/lib/server/field-service';
import { fieldActor, fieldFailure, fieldFinanceRole, fieldModuleCreateDenied, practitionerEstimateAllowed } from '@/lib/server/field-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['field:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const estimate = estimateById(ctx.orgId, id);
  if (!estimate) return fail('NOT_FOUND', 'No such estimate in this workspace.', { requestId: ctx.requestId });
  if (!practitionerEstimateAllowed(ctx, id)) return fail('FORBIDDEN', 'Technicians can access only estimates tied to their assigned jobs.', { requestId: ctx.requestId });
  return ok(estimate, { requestId: ctx.requestId });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['field:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = fieldFinanceRole(ctx);
  if (denied) return denied;
  const { id } = await params;
  const body = await readJson<{ lines?: EstimateLineInput[]; validUntil?: string; notes?: string; description?: string; siteAddress?: SiteAddress }>(req);
  if (body instanceof NextResponse) return body;
  const result = updateEstimate({ orgId: ctx.orgId, id, ...body, actor: fieldActor(ctx) });
  const failed = fieldFailure(result, ctx.requestId);
  return failed ?? ok(result.ok ? result.value : {}, { requestId: ctx.requestId });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['field:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = fieldFinanceRole(ctx) ?? fieldModuleCreateDenied(ctx);
  if (denied) return denied;
  const { id } = await params;
  const body = await readJson<{ action?: string; ttlDays?: number }>(req);
  if (body instanceof NextResponse) return body;
  const actor = fieldActor(ctx);

  if (body.action === 'share') {
    const verify = requireVerifiedEmail(ctx);
    if (verify) return verify;
    const result = shareEstimate({ orgId: ctx.orgId, id, actor, ttlDays: body.ttlDays });
    const failed = fieldFailure(result, ctx.requestId);
    if (failed) return failed;
    if (!result.ok) return fail('INTERNAL_ERROR', 'The estimate could not be shared.', { requestId: ctx.requestId });
    return ok(
      {
        estimate: result.value.estimate,
        acceptUrl: `${publicOrigin(req)}/estimate/${encodeURIComponent(result.value.token)}`,
        expiresAt: result.value.expiresAt,
        delivery: { status: 'not_sent', note: 'Copy this secure link into your own email or message. No delivery provider was called.' },
      },
      { requestId: ctx.requestId }
    );
  }

  if (body.action === 'revise') {
    const result = reviseSharedEstimate({ orgId: ctx.orgId, id, actor });
    const failed = fieldFailure(result, ctx.requestId);
    return failed ?? ok(result.ok ? result.value : {}, { status: 201, requestId: ctx.requestId });
  }

  if (body.action === 'convert') {
    const result = createJob({ orgId: ctx.orgId, estimateId: id, actor });
    const failed = fieldFailure(result, ctx.requestId);
    return failed ?? ok(result.ok ? result.value : {}, { status: 201, requestId: ctx.requestId });
  }

  return fail('VALIDATION_ERROR', '`action` must be share, revise or convert.', { param: 'action', requestId: ctx.requestId });
}
