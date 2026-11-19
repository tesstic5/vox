import { NextResponse, type NextRequest } from 'next/server';
import { audit } from '@/lib/server/audit';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { appendClinicalAccessEvent } from '@/lib/server/clinical-access';
import { privacyProfileFor } from '@/lib/server/privacy-governance';
import { accessGrantsFor, createAccessGrant, permissionDecision, revokeAccessGrant } from '@/lib/server/permissions';
import { find } from '@/lib/server/db';
import type { UserDoc } from '@/lib/server/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session' || !ctx.user) return fail('FORBIDDEN', 'Emergency-access evidence requires a signed-in person.', { requestId: ctx.requestId });
  const denied = requirePermission(ctx, 'audit.read');
  if (denied) return denied;
  const url = new URL(req.url);
  const data = accessGrantsFor(ctx.orgId, {
    userId: url.searchParams.get('userId') ?? undefined,
    patientId: url.searchParams.get('patientId') ?? undefined,
    activeOnly: url.searchParams.get('activeOnly') === 'true',
  });
  return ok({ object: 'list', data, total: data.length }, { requestId: ctx.requestId, headers: { 'cache-control': 'no-store' } });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session' || !ctx.user) return fail('FORBIDDEN', 'Emergency access can be created only by a signed-in person.', { requestId: ctx.requestId });
  const denied = requirePermission(ctx, 'audit.read');
  if (denied) return denied;
  const body = await readJson<{ userId?: string; patientId?: string; reason?: string; minutes?: number }>(req);
  if (body instanceof NextResponse) return body;
  const policy = privacyProfileFor(ctx.orgId);
  if (!policy.breakGlassEnabled) return fail('FORBIDDEN', 'The controller has not enabled a break-glass policy.', { requestId: ctx.requestId });
  const target = find<UserDoc>('users', (row) => row.id === body.userId && row.orgId === ctx.orgId);
  if (!target) return fail('NOT_FOUND', 'Target user not found in this workspace.', { requestId: ctx.requestId });
  if (!permissionDecision(target, 'clinical.read').allowed) {
    return fail('FORBIDDEN', 'The target user must already hold clinical.read; break-glass widens record scope, not permissions.', { requestId: ctx.requestId });
  }
  try {
    const grant = createAccessGrant({
      orgId: ctx.orgId,
      userId: target.id,
      patientId: String(body.patientId ?? ''),
      reason: String(body.reason ?? ''),
      minutes: Number(body.minutes ?? policy.breakGlassMaxMinutes),
      maxMinutes: policy.breakGlassMaxMinutes,
      actorId: ctx.user.id,
      approvedBy: ctx.user.id,
      notifiedRecipients: policy.breakGlassNotify,
    });
    appendClinicalAccessEvent({
      orgId: ctx.orgId, resourceType: 'patient', resourceId: grant.resourceId, patientId: grant.resourceId,
      action: 'create', actorId: ctx.user.id, actorLabel: ctx.user.email, purpose: 'security', requestId: ctx.requestId,
      route: '/api/v1/access-grants',
    });
    audit({ orgId: ctx.orgId, actor: ctx.user.email, action: 'security.break_glass.created', target: grant.id, detail: `user=${grant.userId};expires=${grant.expiresAt}` });
    return ok(grant, { status: 201, requestId: ctx.requestId, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Emergency access could not be created.';
    return fail(message.includes('not found') ? 'NOT_FOUND' : 'VALIDATION_ERROR', message, { requestId: ctx.requestId });
  }
}

export async function DELETE(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session' || !ctx.user) return fail('FORBIDDEN', 'Emergency access can be revoked only by a signed-in person.', { requestId: ctx.requestId });
  const denied = requirePermission(ctx, 'audit.read');
  if (denied) return denied;
  const body = await readJson<{ id?: string; expectedRevision?: number; reason?: string }>(req);
  if (body instanceof NextResponse) return body;
  if (!Number.isSafeInteger(body.expectedRevision)) return fail('VALIDATION_ERROR', '`expectedRevision` is required.', { param: 'expectedRevision', requestId: ctx.requestId });
  try {
    const grant = revokeAccessGrant({ orgId: ctx.orgId, id: String(body.id ?? ''), actorId: ctx.user.id, reason: String(body.reason ?? ''), expectedRevision: body.expectedRevision! });
    appendClinicalAccessEvent({
      orgId: ctx.orgId, resourceType: 'patient', resourceId: grant.resourceId, patientId: grant.resourceId,
      action: 'update', actorId: ctx.user.id, actorLabel: ctx.user.email, purpose: 'security', requestId: ctx.requestId,
      route: '/api/v1/access-grants',
    });
    audit({ orgId: ctx.orgId, actor: ctx.user.email, action: 'security.break_glass.revoked', target: grant.id });
    return ok(grant, { requestId: ctx.requestId, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Emergency access could not be revoked.';
    return fail(message.includes('not found') ? 'NOT_FOUND' : message.includes('changed') ? 'CONFLICT' : 'VALIDATION_ERROR', message, { requestId: ctx.requestId });
  }
}
