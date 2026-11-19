import { NextResponse, type NextRequest } from 'next/server';
import { listBody, ok, readJson, requireAuth, requireWriteRole } from '@/lib/server/api';
import { createVisit, fieldServiceSummary, visitsFor } from '@/lib/server/field-service';
import { fieldActor, fieldCoordinationRole, fieldFailure, fieldModuleCreateDenied, technicianProviderIds } from '@/lib/server/field-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['field:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  let rows = visitsFor(ctx.orgId, {
    jobId: url.searchParams.get('jobId') ?? undefined,
    status: url.searchParams.get('status') ?? undefined,
    providerId: url.searchParams.get('providerId') ?? undefined,
    from: url.searchParams.get('from') ?? undefined,
    to: url.searchParams.get('to') ?? undefined,
  });
  const assignedProviders = technicianProviderIds(ctx);
  if (assignedProviders) rows = rows.filter((row) => row.providerId ? assignedProviders.has(row.providerId) : false);
  return ok(listBody(rows, { summary: assignedProviders ? undefined : fieldServiceSummary(ctx.orgId) }), { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['field:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireWriteRole(ctx) ?? fieldCoordinationRole(ctx) ?? fieldModuleCreateDenied(ctx);
  if (denied) return denied;
  const body = await readJson<{
    jobId?: string;
    durationMinutes?: number;
    travelBufferMinutes?: number;
    instructions?: string;
    startsAt?: string;
    providerId?: string;
    locationId?: string;
    serviceId?: string;
  }>(req);
  if (body instanceof NextResponse) return body;
  const result = createVisit({
    orgId: ctx.orgId,
    jobId: String(body.jobId ?? ''),
    durationMinutes: body.durationMinutes,
    travelBufferMinutes: body.travelBufferMinutes,
    instructions: body.instructions,
    startsAt: body.startsAt,
    providerId: body.providerId,
    locationId: body.locationId,
    serviceId: body.serviceId,
    actor: fieldActor(ctx),
  });
  const failed = fieldFailure(result, ctx.requestId);
  return failed ?? ok(result.ok ? result.value : {}, { status: 201, requestId: ctx.requestId });
}
