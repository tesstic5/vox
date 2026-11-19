import { NextResponse, type NextRequest } from 'next/server';
import { actorLabel, recordAccess } from '@/lib/server/access-log';
import { fail, listBody, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import {
  assignedUserIdsForCase,
  casesFor,
  createCase,
  type CaseDoc,
  type CaseEnforcementMode,
  type CaseLimitPolicy,
  type CaseStatus,
  type CaseTrackingMode,
} from '@/lib/server/cases';
import { shadowPermissionDecision } from '@/lib/server/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['cases:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'cases.read');
  if (denied) return denied;
  const url = new URL(req.url);
  const patientId = url.searchParams.get('patientId') || undefined;
  const status = url.searchParams.get('status') as CaseStatus | null;
  const rows = casesFor(ctx.orgId, {
    patientId,
    status: status || undefined,
    includeClosed: url.searchParams.get('includeClosed') === 'true',
  }).filter((row) => ctx.auth !== 'session' || !ctx.user || shadowPermissionDecision(ctx.user, 'cases.read', {
    area: 'cases', patientId: row.patientId, assignedUserIds: assignedUserIdsForCase(ctx.orgId, row.id),
  }).allowed);
  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  recordAccess({ orgId: ctx.orgId, resource: 'case', resourceId: patientId ?? '*', action: 'list', actor, actorName, detail: `${rows.length} case(s)` });
  return ok(listBody(rows), { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['cases:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson<{
    patientId?: string; name?: string; number?: string; type?: CaseDoc['type']; status?: CaseStatus;
    primaryProviderId?: string; payerId?: string; coverageId?: string; referralId?: string;
    startsOn?: string; endsOn?: string; trackingMode?: CaseTrackingMode;
    limitAppointments?: number; limitMinutes?: number; limitBudgetMinor?: number;
    limitPolicy?: CaseLimitPolicy; enforcementMode?: CaseEnforcementMode; warningThresholdPct?: number;
  }>(req, 64 * 1024);
  if (body instanceof NextResponse) return body;
  const patientId = String(body.patientId ?? '');
  const denied = requirePermission(ctx, 'cases.write', { area: 'cases', patientId });
  if (denied) return denied;
  const { actor } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  const result = createCase({
    orgId: ctx.orgId, patientId,
    name: String(body.name ?? ''), number: String(body.number ?? ''), type: body.type ?? 'other', status: body.status,
    primaryProviderId: body.primaryProviderId, payerId: body.payerId, coverageId: body.coverageId, referralId: body.referralId,
    startsOn: String(body.startsOn ?? ''), endsOn: body.endsOn,
    trackingMode: body.trackingMode ?? 'appointments',
    limitAppointments: body.limitAppointments, limitMinutes: body.limitMinutes, limitBudgetMinor: body.limitBudgetMinor,
    limitPolicy: body.limitPolicy, enforcementMode: body.enforcementMode, warningThresholdPct: body.warningThresholdPct,
    actorId: actor,
  });
  if (!result.ok) return fail(result.code === 'CONFLICT' ? 'CONFLICT' : result.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'VALIDATION_ERROR', result.error, { requestId: ctx.requestId });
  return ok({ case: result.value }, { status: 201, requestId: ctx.requestId });
}
