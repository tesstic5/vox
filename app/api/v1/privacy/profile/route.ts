import { NextResponse, type NextRequest } from 'next/server';
import { audit } from '@/lib/server/audit';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { privacyProfileFor, savePrivacyProfile, type PrivacyProfileDoc } from '@/lib/server/privacy-governance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function sessionOnly(ctx: Exclude<Awaited<ReturnType<typeof requireAuth>>, NextResponse>) {
  return ctx.auth === 'session' && ctx.user
    ? undefined
    : fail('FORBIDDEN', 'The controller profile is available only to a signed-in person.', { requestId: ctx.requestId });
}

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const sessionDenied = sessionOnly(ctx);
  if (sessionDenied) return sessionDenied;
  const denied = requirePermission(ctx, 'privacy.read');
  if (denied) return denied;
  return ok(privacyProfileFor(ctx.orgId), { requestId: ctx.requestId, headers: { 'cache-control': 'no-store' } });
}

export async function PUT(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const sessionDenied = sessionOnly(ctx);
  if (sessionDenied) return sessionDenied;
  const denied = requirePermission(ctx, 'privacy.manage');
  if (denied) return denied;
  const body = await readJson<Partial<PrivacyProfileDoc> & { expectedRevision?: number }>(req);
  if (body instanceof NextResponse) return body;
  if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0) {
    return fail('VALIDATION_ERROR', '`expectedRevision` is required.', { param: 'expectedRevision', requestId: ctx.requestId });
  }
  const existing = privacyProfileFor(ctx.orgId);
  if (Number(existing.revision ?? 0) !== body.expectedRevision) {
    return fail('CONFLICT', 'The controller profile changed after this screen loaded. Reload before saving.', { param: 'expectedRevision', requestId: ctx.requestId });
  }
  try {
    const saved = savePrivacyProfile({
      orgId: ctx.orgId,
      existing,
      expectedRevision: body.expectedRevision,
      controllerName: String(body.controllerName ?? ''),
      controllerAddress: String(body.controllerAddress ?? ''),
      controllerContactEmail: String(body.controllerContactEmail ?? ''),
      controllerContactPhone: body.controllerContactPhone ? String(body.controllerContactPhone) : undefined,
      dpoName: body.dpoName ? String(body.dpoName) : undefined,
      dpoEmail: body.dpoEmail ? String(body.dpoEmail) : undefined,
      privacyNoticeVersion: String(body.privacyNoticeVersion ?? ''),
      privacyNoticeUrl: String(body.privacyNoticeUrl ?? ''),
      dpiaReference: String(body.dpiaReference ?? ''),
      dpiaStatus: String(body.dpiaStatus ?? 'not_started') as PrivacyProfileDoc['dpiaStatus'],
      dpiaReviewedAt: body.dpiaReviewedAt ? String(body.dpiaReviewedAt) : undefined,
      dpiaReviewedBy: body.dpiaReviewedBy ? String(body.dpiaReviewedBy) : undefined,
      auditCompleteFromAt: body.auditCompleteFromAt ? String(body.auditCompleteFromAt) : undefined,
      breakGlassEnabled: body.breakGlassEnabled === true,
      breakGlassMaxMinutes: Number(body.breakGlassMaxMinutes ?? 60),
      breakGlassNotify: Array.isArray(body.breakGlassNotify) ? body.breakGlassNotify.map(String) : [],
      actor: ctx.user!.email,
    });
    audit({ orgId: ctx.orgId, actor: ctx.user!.email, action: 'privacy.profile.updated', target: saved.id });
    return ok(saved, { requestId: ctx.requestId, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The controller profile could not be saved.';
    return fail(error instanceof Error && error.name === 'CommitConflictError' ? 'CONFLICT' : 'VALIDATION_ERROR', message, { requestId: ctx.requestId });
  }
}
