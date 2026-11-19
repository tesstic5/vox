import { NextResponse, type NextRequest } from 'next/server';
import { clientIp, fail, ok, rateHeaders, rateLimit, readJson, requestId } from '@/lib/server/api';
import { activePublicReferralDraft, createPublicReferralDraft, publicReferralForm, savePublicReferralDraft, submitPublicReferral } from '@/lib/server/referral-forms';
import { requireClinicalWriteMode } from '@/lib/server/clinical-readiness';
import { clinicalProfileFor } from '@/lib/server/privacy-governance';
import { CommitConflictError, findByPath, type Doc } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const privacyHeaders = {
  'cache-control': 'no-store, private',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow, noarchive',
  'x-content-type-options': 'nosniff',
};

export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const rid = requestId();
  const { slug } = await params;
  const limit = rateLimit(`public-referral-view:${clientIp(req)}`, 120, 60 * 60_000);
  if (!limit.allowed) return fail('RATE_LIMITED', 'Too many requests. Try again later.', { requestId: rid, headers: { ...privacyHeaders, ...rateHeaders(limit), 'retry-after': String(Math.ceil((limit.resetAt - Date.now()) / 1000)) } });
  const loaded = publicReferralForm(slug);
  if (!loaded) return fail('NOT_FOUND', 'This referral form is unavailable.', { requestId: rid, headers: { ...privacyHeaders, ...rateHeaders(limit) } });
  const operatingMode = clinicalProfileFor(loaded.form.orgId).operatingMode;
  if (operatingMode === 'disabled') return fail('NOT_FOUND', 'This referral form is unavailable.', { requestId: rid, headers: { ...privacyHeaders, ...rateHeaders(limit) } });
  const org = findByPath<Doc & { name?: string }>('orgs', 'id', loaded.form.orgId);
  const schema = {
    ...loaded.version.schema,
    fields: loaded.version.schema.fields.map((field) => ({ ...field, updateTarget: undefined })),
    emergencyNotice: loaded.form.emergencyNotice,
    completionMessage: loaded.form.completionMessage,
  };
  return ok({
    practice: { name: org?.name ?? 'The practice' },
    operatingMode,
    form: { id: loaded.form.id, name: loaded.form.name, privacyNotice: loaded.form.privacyNotice, emergencyNotice: loaded.form.emergencyNotice, completionMessage: loaded.form.completionMessage },
    schema,
  }, { requestId: rid, headers: { ...privacyHeaders, ...rateHeaders(limit) } });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const rid = requestId();
  const { slug } = await params;
  const ip = clientIp(req);
  const limit = rateLimit(`public-referral-write:${ip}`, 240, 60 * 60_000);
  if (!limit.allowed) return fail('RATE_LIMITED', 'Too many referral attempts. Try again later.', { requestId: rid, headers: { ...privacyHeaders, ...rateHeaders(limit), 'retry-after': String(Math.ceil((limit.resetAt - Date.now()) / 1000)) } });
  const loaded = publicReferralForm(slug);
  if (!loaded || clinicalProfileFor(loaded.form.orgId).operatingMode === 'disabled') return fail('NOT_FOUND', 'This referral form is unavailable.', { requestId: rid, headers: { ...privacyHeaders, ...rateHeaders(limit) } });
  const body = await readJson<{ action?: 'start' | 'resume' | 'save' | 'submit'; draftToken?: string; answers?: unknown }>(req, 512 * 1024);
  if (body instanceof NextResponse) return body;
  try {
    if (body.action === 'start') {
      const issuance = rateLimit(`public-referral-start:${ip}`, 20, 60 * 60_000);
      if (!issuance.allowed) return fail('RATE_LIMITED', 'Too many referral drafts. Try again later.', { requestId: rid, headers: { ...privacyHeaders, ...rateHeaders(issuance), 'retry-after': String(Math.ceil((issuance.resetAt - Date.now()) / 1000)) } });
      const created = createPublicReferralDraft({ slug });
      return ok({ status: 'draft', draftToken: created.token, expiresAt: created.submission.expiresAt }, { requestId: rid, status: 201, headers: { ...privacyHeaders, ...rateHeaders(limit) } });
    }
    if (!body.draftToken || !['resume', 'save', 'submit'].includes(String(body.action))) {
      return fail('VALIDATION_ERROR', '`action` and `draftToken` are required.', { requestId: rid, headers: { ...privacyHeaders, ...rateHeaders(limit) } });
    }
    if (body.action === 'resume') {
      const resumed = activePublicReferralDraft({ slug, token: body.draftToken });
      if (!resumed) return fail('NOT_FOUND', 'This referral draft is unavailable.', { requestId: rid, headers: { ...privacyHeaders, ...rateHeaders(limit) } });
      return ok({ status: resumed.submission.status, expiresAt: resumed.submission.expiresAt, answers: resumed.submission.status === 'draft' ? resumed.submission.answers ?? {} : undefined }, { requestId: rid, headers: { ...privacyHeaders, ...rateHeaders(limit) } });
    }
    requireClinicalWriteMode(loaded.form.orgId, req.headers.get('x-voxera-synthetic-data') === '1');
    if (body.action === 'save') {
      const saved = await savePublicReferralDraft({ slug, token: body.draftToken, answers: body.answers ?? {} });
      return ok({ status: saved.status, expiresAt: saved.expiresAt, savedAt: saved.updatedAt }, { requestId: rid, headers: { ...privacyHeaders, ...rateHeaders(limit) } });
    }
    const submissions = rateLimit(`public-referral-submit:${ip}`, 30, 60 * 60_000);
    if (!submissions.allowed) return fail('RATE_LIMITED', 'Too many referral submissions. Try again later.', { requestId: rid, headers: { ...privacyHeaders, ...rateHeaders(submissions), 'retry-after': String(Math.ceil((submissions.resetAt - Date.now()) / 1000)) } });
    const result = await submitPublicReferral({ slug, token: body.draftToken, answers: body.answers, ip });
    return ok({ status: 'received', reference: result.referral.id.slice(-8), completionMessage: result.completionMessage }, { requestId: rid, status: 201, headers: { ...privacyHeaders, ...rateHeaders(limit) } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The referral could not be submitted.';
    const storageConflict = error instanceof CommitConflictError || /duplicate key|unique constraint|revision changed|SQLITE_CONSTRAINT/i.test(message);
    const conflict = storageConflict || /already submitted|expired|changed/i.test(message);
    const forbidden = /disabled|prohibited|synthetic-test mode|live mode/i.test(message);
    return fail(
      forbidden ? 'FORBIDDEN' : message.includes('not found') ? 'NOT_FOUND' : conflict ? 'CONFLICT' : 'VALIDATION_ERROR',
      storageConflict ? 'This referral changed while it was being submitted. Reload the form before trying again.' : message,
      { requestId: rid, headers: { ...privacyHeaders, ...rateHeaders(limit) } },
    );
  }
}
