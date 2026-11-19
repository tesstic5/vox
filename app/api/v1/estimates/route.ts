import { NextResponse, type NextRequest } from 'next/server';
import { listBody, ok, readJson, requireAuth } from '@/lib/server/api';
import { createEstimate, estimatesFor, fieldServiceSummary, type EstimateLineInput, type SiteAddress } from '@/lib/server/field-service';
import { fieldActor, fieldFailure, fieldFinanceRole, fieldModuleCreateDenied, practitionerEstimateAllowed, technicianJobIds } from '@/lib/server/field-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['field:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  const rows = estimatesFor(ctx.orgId, {
    status: url.searchParams.get('status') ?? undefined,
    clientId: url.searchParams.get('clientId') ?? undefined,
    enquiryId: url.searchParams.get('enquiryId') ?? undefined,
    query: url.searchParams.get('q') ?? undefined,
  }).filter((row) => practitionerEstimateAllowed(ctx, row.id));
  return ok(listBody(rows, { summary: technicianJobIds(ctx) ? undefined : fieldServiceSummary(ctx.orgId) }), { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['field:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = fieldFinanceRole(ctx) ?? fieldModuleCreateDenied(ctx);
  if (denied) return denied;
  const body = await readJson<{
    enquiryId?: string;
    clientId?: string;
    customer?: { name?: string; number?: string; email?: string };
    siteAddress?: SiteAddress;
    description?: string;
    lines?: EstimateLineInput[];
    currency?: string;
    validUntil?: string;
    notes?: string;
  }>(req);
  if (body instanceof NextResponse) return body;
  const result = createEstimate({
    orgId: ctx.orgId,
    enquiryId: body.enquiryId,
    clientId: body.clientId,
    customer: body.customer,
    siteAddress: body.siteAddress,
    description: body.description,
    lines: body.lines ?? [],
    currency: body.currency,
    validUntil: body.validUntil,
    notes: body.notes,
    actor: fieldActor(ctx),
  });
  const failed = fieldFailure(result, ctx.requestId);
  return failed ?? ok(result.ok ? result.value : {}, { status: 201, requestId: ctx.requestId });
}
