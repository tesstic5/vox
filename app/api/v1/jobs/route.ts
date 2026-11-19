import { NextResponse, type NextRequest } from 'next/server';
import { listBody, ok, readJson, requireAuth, requireWriteRole } from '@/lib/server/api';
import { createJob, fieldServiceSummary, jobsFor, type EstimateLineInput, type SiteAddress } from '@/lib/server/field-service';
import { fieldActor, fieldCoordinationRole, fieldFailure, fieldModuleCreateDenied, technicianJobIds } from '@/lib/server/field-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['field:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  let rows = jobsFor(ctx.orgId, {
    status: url.searchParams.get('status') ?? undefined,
    clientId: url.searchParams.get('clientId') ?? undefined,
    query: url.searchParams.get('q') ?? undefined,
  });
  const assigned = technicianJobIds(ctx);
  if (assigned) rows = rows.filter((row) => assigned.has(row.id));
  return ok(listBody(rows, { summary: assigned ? undefined : fieldServiceSummary(ctx.orgId) }), { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['field:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireWriteRole(ctx) ?? fieldCoordinationRole(ctx) ?? fieldModuleCreateDenied(ctx);
  if (denied) return denied;
  const body = await readJson<{
    estimateId?: string;
    enquiryId?: string;
    clientId?: string;
    customer?: { name?: string; number?: string; email?: string };
    siteAddress?: SiteAddress;
    description?: string;
    lines?: EstimateLineInput[];
  }>(req);
  if (body instanceof NextResponse) return body;
  const result = createJob({ orgId: ctx.orgId, ...body, actor: fieldActor(ctx) });
  const failed = fieldFailure(result, ctx.requestId);
  return failed ?? ok(result.ok ? result.value : {}, { status: 201, requestId: ctx.requestId });
}
