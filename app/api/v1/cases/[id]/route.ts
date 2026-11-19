import { NextResponse, type NextRequest } from 'next/server';
import { actorLabel, recordAccess } from '@/lib/server/access-log';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { assignedUserIdsForCase, caseAssignmentsFor, caseById, updateCase, type CaseDoc } from '@/lib/server/cases';
import { authorisationsForCase, fundingPeriodsForCase, serviceRulesForCase } from '@/lib/server/funding';

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
  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  recordAccess({ orgId: ctx.orgId, resource: 'case', resourceId: row.id, action: 'view', actor, actorName, detail: row.patientId });
  return ok({
    case: row,
    assignments: caseAssignmentsFor(ctx.orgId, row.id),
    fundingPeriods: fundingPeriodsForCase(ctx.orgId, row.id),
    serviceRules: serviceRulesForCase(ctx.orgId, row.id, true),
    authorisations: authorisationsForCase(ctx.orgId, row.id),
  }, { requestId: ctx.requestId });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const ctx = await requireAuth(req, { scopes: ['cases:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const row = caseById(ctx.orgId, id);
  if (!row) return fail('NOT_FOUND', 'That case does not exist.', { requestId: ctx.requestId });
  const denied = requirePermission(ctx, 'cases.write', { area: 'cases', patientId: row.patientId, assignedUserIds: assignedUserIdsForCase(ctx.orgId, row.id) });
  if (denied) return denied;
  const body = await readJson<{
    expectedRevision?: number;
    patch?: Partial<Pick<CaseDoc,
      'name' | 'number' | 'type' | 'status' | 'primaryProviderId' | 'payerId' | 'coverageId' | 'referralId' |
      'startsOn' | 'endsOn' | 'trackingMode' | 'limitAppointments' | 'limitMinutes' | 'limitBudgetMinor' |
      'limitPolicy' | 'enforcementMode' | 'warningThresholdPct'>>;
  }>(req, 64 * 1024);
  if (body instanceof NextResponse) return body;
  const { actor } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  const result = updateCase({ orgId: ctx.orgId, id, expectedRevision: Number(body.expectedRevision), patch: body.patch ?? {}, actorId: actor });
  if (!result.ok) return fail(result.code === 'NOT_FOUND' ? 'NOT_FOUND' : result.code === 'CONFLICT' ? 'CONFLICT' : 'VALIDATION_ERROR', result.error, { requestId: ctx.requestId });
  return ok({ case: result.value }, { requestId: ctx.requestId });
}
