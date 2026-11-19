import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import {
  addReferralRiskFlag, convertReferralToClient, referralById, referralDuplicateCandidates, referralEventsFor,
  queueReferralNotification, referralNotificationsFor, referralRiskFlagsFor, resolveReferralRiskFlag, transitionReferral, updateReferral,
  type ReferralDoc, type ReferralRiskFlagDoc, type ReferralStatus,
} from '@/lib/server/referrals';
import { requireClinicalWriteMode } from '@/lib/server/clinical-readiness';
import { referralFormSubmissionById, referralFormVersionForSubmission, referralSubmissionEvidenceState } from '@/lib/server/referral-forms';
import { documentById } from '@/lib/server/clinical-documents';
import { recordAccess } from '@/lib/server/access-log';
import { CommitConflictError } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const actor = (ctx: Exclude<Awaited<ReturnType<typeof requireAuth>>, NextResponse>) => ctx.user?.email ?? ctx.key?.id ?? 'api';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['referrals:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'referrals.read');
  if (denied) return denied;
  const { id } = await params;
  const referral = referralById(ctx.orgId, id);
  if (!referral) return fail('NOT_FOUND', 'Referral not found.', { requestId: ctx.requestId });
  if (referral.convertedClientId) recordAccess({ orgId: ctx.orgId, resource: 'client', resourceId: referral.convertedClientId, action: 'view', actor: actor(ctx), detail: `referral ${id}` });
  const submission = referral.referralFormSubmissionId ? referralFormSubmissionById(ctx.orgId, referral.referralFormSubmissionId) : undefined;
  const submissionVersion = submission ? referralFormVersionForSubmission(ctx.orgId, submission.id) : undefined;
  const attachments = referral.documentIds.flatMap((documentId) => {
    const document = documentById(ctx.orgId, documentId);
    return document ? [{
      id: document.id, title: document.title, category: document.category, status: document.status,
      currentScanStatus: document.currentScanStatus, currentVersionId: document.currentVersionId,
      downloadPath: document.currentScanStatus === 'clean' && document.currentVersionId ? `/api/v1/documents/${document.id}/download` : undefined,
    }] : [];
  });
  return ok({
    referral,
    events: referralEventsFor(ctx.orgId, id),
    riskFlags: referralRiskFlagsFor(ctx.orgId, id),
    notifications: referralNotificationsFor(ctx.orgId, id),
    duplicateCandidates: referralDuplicateCandidates(ctx.orgId, referral.patient, id),
    attachments,
    publicSubmission: submission ? {
      id: submission.id, referralFormId: submission.referralFormId, templateId: submission.templateId,
      templateVersion: submission.templateVersion, status: submission.status, answers: submission.answers,
      answersHash: submission.answersHash, submittedAt: submission.submittedAt,
      evidence: referralSubmissionEvidenceState(ctx.orgId, submission.id),
      schema: submissionVersion?.schema,
    } : undefined,
  }, { requestId: ctx.requestId, headers: { 'cache-control': 'no-store' } });
}

type PatchBody = {
  action?: 'update' | 'transition' | 'convert' | 'add_risk_flag' | 'resolve_risk_flag' | 'notify_referrer';
  expectedRevision?: number;
  to?: ReferralStatus;
  note?: string;
  reasonCode?: string;
  duplicateOfReferralId?: string;
  existingClientId?: string;
  riskFlagId?: string;
  label?: string;
  severity?: ReferralRiskFlagDoc['severity'];
  detail?: string;
  subject?: string;
  message?: string;
  patch?: Partial<ReferralDoc>;
};

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['referrals:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const body = await readJson<PatchBody>(req, 512 * 1024);
  if (body instanceof NextResponse) return body;
  const permission = body.action === 'transition' || body.action === 'convert' || body.action === 'add_risk_flag' || body.action === 'resolve_risk_flag' || body.action === 'notify_referrer' ? 'referrals.triage' : 'referrals.write';
  const denied = requirePermission(ctx, permission);
  if (denied) return denied;
  try { requireClinicalWriteMode(ctx.orgId, req.headers.get('x-voxera-synthetic-data') === '1'); }
  catch (error) { return fail('FORBIDDEN', error instanceof Error ? error.message : 'Clinical writes are disabled.', { requestId: ctx.requestId }); }
  if (body.action !== 'add_risk_flag' && !Number.isInteger(body.expectedRevision)) return fail('VALIDATION_ERROR', '`expectedRevision` is required.', { param: 'expectedRevision', requestId: ctx.requestId });
  try {
    let result: unknown;
    if (body.action === 'update') {
      result = updateReferral({ orgId: ctx.orgId, id, actor: actor(ctx), expectedRevision: body.expectedRevision!, patch: body.patch ?? {} });
    } else if (body.action === 'transition') {
      if (!body.to) throw new Error('target referral status is required');
      result = transitionReferral({ orgId: ctx.orgId, id, to: body.to, actor: actor(ctx), note: body.note, reasonCode: body.reasonCode, expectedRevision: body.expectedRevision!, duplicateOfReferralId: body.duplicateOfReferralId });
    } else if (body.action === 'convert') {
      result = convertReferralToClient({ orgId: ctx.orgId, id, actor: actor(ctx), expectedRevision: body.expectedRevision!, existingClientId: body.existingClientId });
    } else if (body.action === 'add_risk_flag') {
      result = addReferralRiskFlag({ orgId: ctx.orgId, referralId: id, label: String(body.label ?? ''), severity: body.severity, detail: body.detail, actor: actor(ctx) });
    } else if (body.action === 'resolve_risk_flag') {
      if (!body.riskFlagId) throw new Error('risk flag id is required');
      result = resolveReferralRiskFlag({ orgId: ctx.orgId, id: body.riskFlagId, actor: actor(ctx), expectedRevision: body.expectedRevision! });
    } else if (body.action === 'notify_referrer') {
      result = queueReferralNotification({
        orgId: ctx.orgId,
        referralId: id,
        expectedRevision: body.expectedRevision!,
        subject: String(body.subject ?? ''),
        body: String(body.message ?? ''),
        actor: actor(ctx),
      });
    } else {
      return fail('VALIDATION_ERROR', '`action` is invalid.', { param: 'action', requestId: ctx.requestId });
    }
    return ok(result, { requestId: ctx.requestId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not update the referral.';
    const storageConflict = error instanceof CommitConflictError || /duplicate key|unique constraint|SQLITE_CONSTRAINT/i.test(message);
    return fail(message.includes('not found') ? 'NOT_FOUND' : storageConflict || message.includes('changed') || message.includes('cannot') || message.includes('already') ? 'CONFLICT' : 'VALIDATION_ERROR', storageConflict ? 'This referral notification or decision changed while it was being saved. Reload the referral and try again.' : message, { requestId: ctx.requestId });
  }
}
