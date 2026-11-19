import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { identityConflictsFor, mergePatients, resolveIdentityConflict, type IdentityConflictDoc } from '@/lib/server/patient-identity';
import { audit } from '@/lib/server/audit';
import { actorLabel, recordAccess } from '@/lib/server/access-log';
import { shadowPermissionDecision } from '@/lib/server/permissions';
import { requireClinicalWriteMode } from '@/lib/server/clinical-readiness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['clients:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'clients.read');
  if (denied) return denied;
  const requested = new URL(req.url).searchParams.get('status') ?? 'open';
  const allowed = ['open', 'resolved', 'shared', 'dismissed', 'all'];
  if (!allowed.includes(requested)) return fail('VALIDATION_ERROR', `\`status\` must be one of: ${allowed.join(', ')}.`, { param: 'status', requestId: ctx.requestId });
  const candidates = identityConflictsFor(ctx.orgId, requested as IdentityConflictDoc['status'] | 'all');
  const data = ctx.auth === 'session' && ctx.user
    ? candidates.filter((conflict) => conflict.candidatePatientIds.every((patientId) =>
        shadowPermissionDecision(ctx.user!, 'clients.read', { area: 'clients', patientId }).allowed))
    : candidates;
  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  recordAccess({ orgId: ctx.orgId, resource: 'client', resourceId: '*', action: 'list', actor, actorName, detail: `${data.length} exact identity conflict(s)` });
  return ok({ object: 'list', data, total: data.length, note: 'Candidates are exact matches only. Voxera does not fuzzy-merge patient records.' }, { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['clients:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson<{
    conflictId?: string; action?: 'select' | 'shared' | 'dismiss' | 'merge'; selectedPatientId?: string;
    survivorPatientId?: string; sourcePatientId?: string; note?: string; fieldDecisions?: Record<string, 'survivor' | 'source'>;
  }>(req);
  if (body instanceof NextResponse) return body;
  const denied = requirePermission(ctx, body.action === 'merge' ? 'clients.merge' : 'clients.write');
  if (denied) return denied;
  if (!body.conflictId) return fail('VALIDATION_ERROR', '`conflictId` is required.', { param: 'conflictId', requestId: ctx.requestId });
  if (!body.action || !['select', 'shared', 'dismiss', 'merge'].includes(body.action)) return fail('VALIDATION_ERROR', '`action` must be select, shared, dismiss or merge.', { param: 'action', requestId: ctx.requestId });
  const existing = identityConflictsFor(ctx.orgId, 'all').find((conflict) => conflict.id === body.conflictId);
  if (!existing) return fail('NOT_FOUND', 'Identity conflict not found.', { requestId: ctx.requestId });
  if (ctx.auth === 'session' && ctx.user && existing.candidatePatientIds.some((patientId) =>
    !shadowPermissionDecision(ctx.user!, 'clients.write', { area: 'clients', patientId }).allowed)) {
    // Do not reveal which candidate is outside the actor's caseload.
    return fail('NOT_FOUND', 'Identity conflict not found.', { requestId: ctx.requestId });
  }
  try {
    if (body.action === 'merge') {
      requireClinicalWriteMode(ctx.orgId, req.headers.get('x-voxera-synthetic-data') === '1');
      const survivorPatientId = String(body.survivorPatientId ?? '');
      const sourcePatientId = String(body.sourcePatientId ?? '');
      if (!survivorPatientId || !sourcePatientId) {
        return fail('VALIDATION_ERROR', '`survivorPatientId` and `sourcePatientId` are required for a merge.', { requestId: ctx.requestId });
      }
      const merged = mergePatients({
        orgId: ctx.orgId,
        conflictId: body.conflictId,
        survivorPatientId,
        sourcePatientId,
        actor: ctx.user?.email ?? `api:${ctx.key?.id ?? 'key'}`,
        note: String(body.note ?? ''),
        fieldDecisions: body.fieldDecisions,
      });
      audit({ orgId: ctx.orgId, actor: ctx.user?.email ?? 'api', action: 'identity_conflict.merged', target: merged.event.id, detail: `${sourcePatientId} -> ${survivorPatientId}` });
      const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
      recordAccess({ orgId: ctx.orgId, resource: 'client', resourceId: survivorPatientId, action: 'merge', actor, actorName, detail: `human-approved exact-conflict merge ${merged.event.id}` });
      return ok(merged, { requestId: ctx.requestId });
    }
    const conflict = resolveIdentityConflict({
      orgId: ctx.orgId,
      conflictId: body.conflictId,
      action: body.action,
      selectedPatientId: body.selectedPatientId,
      actor: ctx.user?.email ?? `api:${ctx.key?.id ?? 'key'}`,
      note: body.note,
    });
    audit({ orgId: ctx.orgId, actor: ctx.user?.email ?? 'api', action: 'identity_conflict.reviewed', target: conflict.id, detail: `${body.action}${body.selectedPatientId ? ` ${body.selectedPatientId}` : ''}` });
    const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
    recordAccess({ orgId: ctx.orgId, resource: 'client', resourceId: body.selectedPatientId ?? '*', action: 'update', actor, actorName, detail: `identity conflict ${conflict.id} marked ${conflict.status}; no fuzzy merge` });
    return ok(conflict, { requestId: ctx.requestId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not resolve the conflict.';
    return fail(message.includes('not found') ? 'NOT_FOUND'
      : message.includes('revision') || message.includes('changed') ? 'CONFLICT'
        : message.includes('disabled') || message.includes('acknowledgement') || message.includes('prohibited') ? 'FORBIDDEN'
          : 'VALIDATION_ERROR', message, { requestId: ctx.requestId });
  }
}
