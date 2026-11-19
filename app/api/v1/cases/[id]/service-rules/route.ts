import { NextResponse, type NextRequest } from 'next/server';
import { actorLabel } from '@/lib/server/access-log';
import { fail, listBody, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { assignedUserIdsForCase, caseById } from '@/lib/server/cases';
import { createServiceRule, serviceRulesForCase, updateServiceRule, type CaseServiceRuleDoc } from '@/lib/server/funding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const ctx = await requireAuth(req, { scopes: ['cases:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const row = caseById(ctx.orgId, id);
  if (!row) return fail('NOT_FOUND', 'That case does not exist.', { requestId: ctx.requestId });
  const denied = requirePermission(ctx, 'cases.read', { area: 'cases', patientId: row.patientId, assignedUserIds: assignedUserIdsForCase(ctx.orgId, row.id) });
  if (denied) return denied;
  return ok(listBody(serviceRulesForCase(ctx.orgId, id, true)), { requestId: ctx.requestId });
}

export async function POST(req: NextRequest, { params }: Params) {
  const ctx = await requireAuth(req, { scopes: ['cases:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const { id: caseId } = await params;
  const row = caseById(ctx.orgId, caseId);
  if (!row) return fail('NOT_FOUND', 'That case does not exist.', { requestId: ctx.requestId });
  const denied = requirePermission(ctx, 'cases.write', { area: 'cases', patientId: row.patientId, assignedUserIds: assignedUserIdsForCase(ctx.orgId, row.id) });
  if (denied) return denied;
  const body = await readJson<{
    action?: 'create' | 'update'; id?: string; expectedRevision?: number;
    serviceId?: string; providerId?: string; locationId?: string; startsOn?: string; endsOn?: string;
    unit?: CaseServiceRuleDoc['unit']; fundedPriceMinor?: number; taxRateBps?: number;
    claimCode?: string; claimCodeSource?: string; requiresAuthorisation?: boolean;
    noShowPolicy?: CaseServiceRuleDoc['noShowPolicy']; lateCancelPolicy?: CaseServiceRuleDoc['lateCancelPolicy']; lateCancellationHours?: number; active?: boolean;
  }>(req, 32 * 1024);
  if (body instanceof NextResponse) return body;
  const { actor } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  const mutable = {
    serviceId: body.serviceId, providerId: body.providerId, locationId: body.locationId,
    startsOn: String(body.startsOn ?? ''), endsOn: body.endsOn,
    unit: body.unit as CaseServiceRuleDoc['unit'], fundedPriceMinor: Number(body.fundedPriceMinor), taxRateBps: body.taxRateBps,
    claimCode: body.claimCode, claimCodeSource: body.claimCodeSource, requiresAuthorisation: body.requiresAuthorisation,
    noShowPolicy: body.noShowPolicy as CaseServiceRuleDoc['noShowPolicy'], lateCancelPolicy: body.lateCancelPolicy as CaseServiceRuleDoc['lateCancelPolicy'],
    lateCancellationHours: Number(body.lateCancellationHours), active: body.active,
  };
  const result = body.action === 'update'
    ? updateServiceRule({ orgId: ctx.orgId, id: String(body.id ?? ''), expectedRevision: Number(body.expectedRevision), patch: mutable, actorId: actor })
    : createServiceRule({ orgId: ctx.orgId, caseId, ...mutable, actorId: actor });
  if (!result.ok) return fail(result.code === 'NOT_FOUND' ? 'NOT_FOUND' : result.code === 'CONFLICT' ? 'CONFLICT' : 'VALIDATION_ERROR', result.error, { requestId: ctx.requestId });
  return ok({ serviceRule: result.value }, { status: body.action === 'update' ? 200 : 201, requestId: ctx.requestId });
}
