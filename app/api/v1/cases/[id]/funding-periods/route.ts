import { NextResponse, type NextRequest } from 'next/server';
import { actorLabel } from '@/lib/server/access-log';
import { fail, listBody, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { assignedUserIdsForCase, caseById } from '@/lib/server/cases';
import { createFundingPeriod, fundingPeriodsForCase, updateFundingPeriod, type FundingPeriodDoc, type FundingVector } from '@/lib/server/funding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ id: string }> };

function errorResponse(result: { code: string; error: string }, requestId: string) {
  return fail(result.code === 'NOT_FOUND' ? 'NOT_FOUND' : result.code === 'CONFLICT' ? 'CONFLICT' : 'VALIDATION_ERROR', result.error, { requestId });
}

export async function GET(req: NextRequest, { params }: Params) {
  const ctx = await requireAuth(req, { scopes: ['cases:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const row = caseById(ctx.orgId, id);
  if (!row) return fail('NOT_FOUND', 'That case does not exist.', { requestId: ctx.requestId });
  const denied = requirePermission(ctx, 'cases.read', { area: 'cases', patientId: row.patientId, assignedUserIds: assignedUserIdsForCase(ctx.orgId, row.id) });
  if (denied) return denied;
  return ok(listBody(fundingPeriodsForCase(ctx.orgId, id)), { requestId: ctx.requestId });
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
    action?: 'create' | 'update'; id?: string; expectedRevision?: number; startsOn?: string; endsOn?: string;
    allowed?: FundingVector; rolloverPolicy?: FundingPeriodDoc['rolloverPolicy']; rollover?: FundingVector;
  }>(req, 32 * 1024);
  if (body instanceof NextResponse) return body;
  const { actor } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  const result = body.action === 'update'
    ? updateFundingPeriod({ orgId: ctx.orgId, id: String(body.id ?? ''), expectedRevision: Number(body.expectedRevision), startsOn: String(body.startsOn ?? ''), endsOn: String(body.endsOn ?? ''), allowed: body.allowed ?? { appointments: 0, minutes: 0, budgetMinor: 0 }, rolloverPolicy: body.rolloverPolicy ?? 'none', rollover: body.rollover ?? { appointments: 0, minutes: 0, budgetMinor: 0 }, actorId: actor })
    : createFundingPeriod({ orgId: ctx.orgId, caseId: id, startsOn: String(body.startsOn ?? ''), endsOn: String(body.endsOn ?? ''), allowed: body.allowed ?? { appointments: 0, minutes: 0, budgetMinor: 0 }, rolloverPolicy: body.rolloverPolicy, rollover: body.rollover, actorId: actor });
  if (!result.ok) return errorResponse(result, ctx.requestId);
  return ok({ fundingPeriod: result.value }, { status: body.action === 'update' ? 200 : 201, requestId: ctx.requestId });
}
