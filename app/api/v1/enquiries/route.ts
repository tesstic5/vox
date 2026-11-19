import { NextResponse, type NextRequest } from 'next/server';
import { listBody, ok, readJson, requireAuth, requireWriteRole } from '@/lib/server/api';
import { createEnquiry, enquiriesFor, fieldServiceSummary, type EnquiryUrgency, type SiteAddress } from '@/lib/server/field-service';
import { fieldActor, fieldCoordinationRole, fieldFailure, fieldModuleCreateDenied, technicianJobIds } from '@/lib/server/field-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['field:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  let rows = enquiriesFor(ctx.orgId, {
    status: url.searchParams.get('status') ?? undefined,
    clientId: url.searchParams.get('clientId') ?? undefined,
    query: url.searchParams.get('q') ?? undefined,
  });
  const assignedJobs = technicianJobIds(ctx);
  if (assignedJobs) rows = rows.filter((row) => row.assignedTo === ctx.userId || (row.jobId ? assignedJobs.has(row.jobId) : false));
  return ok(listBody(rows, { summary: assignedJobs ? undefined : fieldServiceSummary(ctx.orgId) }), { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['field:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireWriteRole(ctx) ?? fieldCoordinationRole(ctx) ?? fieldModuleCreateDenied(ctx);
  if (denied) return denied;
  const body = await readJson<{
    clientId?: string;
    customer?: { name?: string; number?: string; email?: string };
    description?: string;
    urgency?: EnquiryUrgency;
    siteAddress?: SiteAddress;
    assignedTo?: string;
    source?: string;
    callId?: string;
  }>(req);
  if (body instanceof NextResponse) return body;
  const source = ctx.auth === 'key' && body.source === 'assistant' ? 'assistant' : 'manual';
  const result = createEnquiry({
    orgId: ctx.orgId,
    clientId: body.clientId,
    customer: body.customer,
    description: String(body.description ?? ''),
    urgency: body.urgency,
    siteAddress: body.siteAddress ?? ({} as SiteAddress),
    assignedTo: body.assignedTo,
    source,
    callId: source === 'assistant' ? body.callId : undefined,
    actor: fieldActor(ctx),
  });
  if (!result.ok) return fieldFailure(result, ctx.requestId)!;
  return ok(result.value, { status: 201, requestId: ctx.requestId });
}
