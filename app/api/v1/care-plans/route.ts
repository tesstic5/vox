import { NextResponse, type NextRequest } from 'next/server';
import { actorLabel, recordAccess } from '@/lib/server/access-log';
import { fail, listBody, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import {
  carePlanById,
  carePlansForPatient,
  createCarePlan,
  createCarePlanGoal,
  goalsForCarePlan,
  updateCarePlan,
  updateCarePlanGoal,
  type CarePlanDoc,
  type CarePlanGoalDoc,
} from '@/lib/server/care-plans';
import { get } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['clinical:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  const patientId = url.searchParams.get('patientId') ?? '';
  if (!patientId) return fail('VALIDATION_ERROR', 'patientId is required.', { param: 'patientId', requestId: ctx.requestId });
  const denied = requirePermission(ctx, 'clinical.read', { area: 'clinical', patientId });
  if (denied) return denied;
  const rows = carePlansForPatient(ctx.orgId, patientId, url.searchParams.get('includeClosed') === 'true');
  const data = rows.map((plan) => ({ ...plan, goals: goalsForCarePlan(ctx.orgId, plan.id) }));
  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  recordAccess({ orgId: ctx.orgId, resource: 'care-plan', resourceId: patientId, action: 'view', actor, actorName, detail: `${rows.length} plan(s)` });
  return ok(listBody(data), { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['clinical:write'] });
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session') return fail('FORBIDDEN', 'Care-plan text must be authored by a clinician in an authenticated staff session.', { requestId: ctx.requestId });
  const body = await readJson<{
    action?: 'create' | 'update' | 'create_goal' | 'update_goal';
    id?: string; carePlanId?: string; patientId?: string; caseId?: string; expectedRevision?: number;
    title?: string; planStatus?: CarePlanDoc['status']; reviewOn?: string;
    goal?: string; actions?: string[]; goalStatus?: CarePlanGoalDoc['status'];
  }>(req, 128 * 1024);
  if (body instanceof NextResponse) return body;

  let patientId = String(body.patientId ?? '');
  if (body.action === 'update') patientId = carePlanById(ctx.orgId, String(body.id ?? ''))?.patientId ?? '';
  if (body.action === 'create_goal') patientId = carePlanById(ctx.orgId, String(body.carePlanId ?? ''))?.patientId ?? '';
  if (body.action === 'update_goal') patientId = get<CarePlanGoalDoc>('carePlanGoals', String(body.id ?? ''))?.patientId ?? '';
  if (!patientId) return fail('NOT_FOUND', 'The care plan or patient does not exist.', { requestId: ctx.requestId });
  const denied = requirePermission(ctx, 'clinical.write', { area: 'clinical', patientId });
  if (denied) return denied;
  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email });

  const result = body.action === 'update'
    ? updateCarePlan({
        orgId: ctx.orgId, id: String(body.id ?? ''), expectedRevision: Number(body.expectedRevision),
        patch: {
          ...(body.caseId !== undefined ? { caseId: body.caseId } : {}),
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.planStatus !== undefined ? { status: body.planStatus } : {}),
          ...(body.reviewOn !== undefined ? { reviewOn: body.reviewOn } : {}),
        }, actorId: actor,
      })
    : body.action === 'create_goal'
      ? createCarePlanGoal({ orgId: ctx.orgId, carePlanId: String(body.carePlanId ?? ''), goal: String(body.goal ?? ''), actions: body.actions ?? [], status: body.goalStatus, reviewOn: body.reviewOn, actorId: actor, actorName })
      : body.action === 'update_goal'
        ? updateCarePlanGoal({
            orgId: ctx.orgId, id: String(body.id ?? ''), expectedRevision: Number(body.expectedRevision),
            patch: {
              ...(body.goal !== undefined ? { goal: body.goal } : {}),
              ...(body.actions !== undefined ? { actions: body.actions } : {}),
              ...(body.goalStatus !== undefined ? { status: body.goalStatus } : {}),
              ...(body.reviewOn !== undefined ? { reviewOn: body.reviewOn } : {}),
            }, actorId: actor,
          })
        : createCarePlan({ orgId: ctx.orgId, patientId, caseId: body.caseId, title: String(body.title ?? ''), status: body.planStatus, reviewOn: body.reviewOn, actorId: actor, actorName });
  if (!result.ok) return fail(result.code === 'NOT_FOUND' ? 'NOT_FOUND' : result.code === 'CONFLICT' ? 'CONFLICT' : 'VALIDATION_ERROR', result.error, { requestId: ctx.requestId });
  const key = body.action?.includes('goal') ? 'goal' : 'carePlan';
  return ok({ [key]: result.value }, { status: body.action === 'create' || body.action === undefined || body.action === 'create_goal' ? 201 : 200, requestId: ctx.requestId });
}
