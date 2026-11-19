import { NextResponse, type NextRequest } from 'next/server';
import { audit } from '@/lib/server/audit';
import { actorLabel, recordAccess } from '@/lib/server/access-log';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { clientById } from '@/lib/server/clients';
import { requireClinicalWriteMode } from '@/lib/server/clinical-readiness';
import {
  assignmentsForPatient,
  createCaseloadAssignment,
  createExplicitRecordGrant,
  endCaseloadAssignment,
  explicitRecordGrantsFor,
  revokeExplicitRecordGrant,
  type CaseloadAssignmentDoc,
  type ScopeArea,
} from '@/lib/server/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['clients:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'clients.read', { area: 'clients', patientId: id });
  if (denied) return denied;
  if (!clientById(ctx.orgId, id)) return fail('NOT_FOUND', `No client with id ${id}.`, { requestId: ctx.requestId });
  return ok({
    object: 'assignment_set',
    patientId: id,
    caseload: assignmentsForPatient(ctx.orgId, id, { includeEnded: new URL(req.url).searchParams.get('includeEnded') === 'true' }),
    explicit: explicitRecordGrantsFor(ctx.orgId, id, { includeRevoked: new URL(req.url).searchParams.get('includeEnded') === 'true' }),
  }, { requestId: ctx.requestId, headers: { 'cache-control': 'no-store' } });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['clients:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'clients.write', { area: 'clients', patientId: id });
  if (denied) return denied;
  if (!clientById(ctx.orgId, id)) return fail('NOT_FOUND', `No client with id ${id}.`, { requestId: ctx.requestId });
  const body = await readJson<{
    scope?: 'caseload' | 'explicit'; userId?: string; providerId?: string; caseId?: string;
    kind?: CaseloadAssignmentDoc['kind']; area?: ScopeArea; reason?: string; startsAt?: string; endsAt?: string; expiresAt?: string;
  }>(req);
  if (body instanceof NextResponse) return body;
  try {
    requireClinicalWriteMode(ctx.orgId, req.headers.get('x-voxera-synthetic-data') === '1');
    const actorId = ctx.user?.id ?? `api:${ctx.key?.id ?? 'key'}`;
    const saved = body.scope === 'explicit'
      ? createExplicitRecordGrant({
          orgId: ctx.orgId, patientId: id, userId: String(body.userId ?? ''),
          area: String(body.area ?? 'clinical') as ScopeArea, reason: String(body.reason ?? ''),
          expiresAt: body.expiresAt, actorId,
        })
      : createCaseloadAssignment({
          orgId: ctx.orgId, patientId: id, userId: body.userId, providerId: body.providerId,
          caseId: body.caseId, kind: body.kind ?? 'secondary', actorId, startsAt: body.startsAt, endsAt: body.endsAt,
        });
    const actor = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
    recordAccess({ orgId: ctx.orgId, resource: 'client', resourceId: id, action: 'update', ...actor, detail: `${body.scope === 'explicit' ? 'explicit record grant' : 'caseload assignment'} created` });
    audit({ orgId: ctx.orgId, actor: actor.actorName ?? actor.actor, action: 'client.assignment.created', target: id, detail: saved.id });
    return ok(saved, { status: 201, requestId: ctx.requestId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The assignment could not be created.';
    return fail(message.includes('not found') ? 'NOT_FOUND' : message.includes('changed') ? 'CONFLICT' : message.includes('disabled') || message.includes('acknowledgement') ? 'FORBIDDEN' : 'VALIDATION_ERROR', message, { requestId: ctx.requestId });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['clients:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'clients.write', { area: 'clients', patientId: id });
  if (denied) return denied;
  const body = await readJson<{ assignmentId?: string; grantId?: string; expectedRevision?: number; reason?: string }>(req);
  if (body instanceof NextResponse) return body;
  if (!Number.isSafeInteger(body.expectedRevision)) return fail('VALIDATION_ERROR', '`expectedRevision` is required.', { param: 'expectedRevision', requestId: ctx.requestId });
  try {
    requireClinicalWriteMode(ctx.orgId, req.headers.get('x-voxera-synthetic-data') === '1');
    const actorId = ctx.user?.id ?? `api:${ctx.key?.id ?? 'key'}`;
    const saved = body.grantId
      ? revokeExplicitRecordGrant({ orgId: ctx.orgId, patientId: id, grantId: body.grantId, actorId, reason: String(body.reason ?? ''), expectedRevision: body.expectedRevision! })
      : endCaseloadAssignment({ orgId: ctx.orgId, patientId: id, assignmentId: String(body.assignmentId ?? ''), actorId, expectedRevision: body.expectedRevision! });
    const actor = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
    recordAccess({ orgId: ctx.orgId, resource: 'client', resourceId: id, action: 'update', ...actor, detail: body.grantId ? 'explicit record grant revoked' : 'caseload assignment ended' });
    audit({ orgId: ctx.orgId, actor: actor.actorName ?? actor.actor, action: 'client.assignment.ended', target: id, detail: saved.id });
    return ok(saved, { requestId: ctx.requestId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The assignment could not be ended.';
    return fail(message.includes('not found') ? 'NOT_FOUND' : message.includes('changed') ? 'CONFLICT' : message.includes('disabled') || message.includes('acknowledgement') ? 'FORBIDDEN' : 'VALIDATION_ERROR', message, { requestId: ctx.requestId });
  }
}
