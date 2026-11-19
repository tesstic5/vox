import { NextResponse, type NextRequest } from 'next/server';
import { actorLabel } from '@/lib/server/access-log';
import { fail, listBody, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { assignCase, assignedUserIdsForCase, caseAssignmentsFor, caseById, endCaseAssignment, type CaseAssignmentDoc } from '@/lib/server/cases';

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
  return ok(listBody(caseAssignmentsFor(ctx.orgId, id)), { requestId: ctx.requestId });
}

export async function POST(req: NextRequest, { params }: Params) {
  const ctx = await requireAuth(req, { scopes: ['cases:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const row = caseById(ctx.orgId, id);
  if (!row) return fail('NOT_FOUND', 'That case does not exist.', { requestId: ctx.requestId });
  const denied = requirePermission(ctx, 'cases.write', { area: 'cases', patientId: row.patientId, assignedUserIds: assignedUserIdsForCase(ctx.orgId, row.id) });
  if (denied) return denied;
  const body = await readJson<{
    action?: 'assign' | 'end'; assignmentId?: string; expectedRevision?: number;
    providerId?: string; userId?: string; locationId?: string; role?: CaseAssignmentDoc['role']; startsOn?: string; endsOn?: string;
  }>(req, 32 * 1024);
  if (body instanceof NextResponse) return body;
  const { actor } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  const result = body.action === 'end'
    ? endCaseAssignment({ orgId: ctx.orgId, id: String(body.assignmentId ?? ''), expectedRevision: Number(body.expectedRevision), endsOn: String(body.endsOn ?? ''), actorId: actor })
    : assignCase({ orgId: ctx.orgId, caseId: id, providerId: body.providerId, userId: body.userId, locationId: body.locationId, role: body.role ?? 'supporting', startsOn: String(body.startsOn ?? ''), endsOn: body.endsOn, actorId: actor });
  if (!result.ok) return fail(result.code === 'NOT_FOUND' ? 'NOT_FOUND' : result.code === 'CONFLICT' ? 'CONFLICT' : 'VALIDATION_ERROR', result.error, { requestId: ctx.requestId });
  return ok({ assignment: result.value }, { status: body.action === 'end' ? 200 : 201, requestId: ctx.requestId });
}
