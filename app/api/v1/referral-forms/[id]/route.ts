import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { formTemplateVersion } from '@/lib/server/forms';
import {
  referralFormById,
  updateReferralForm,
  type ReferralFieldMapping,
  type ReferralFormDoc,
  type ReferralRoutingPolicy,
} from '@/lib/server/referral-forms';
import { CommitConflictError } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const actor = (ctx: Exclude<Awaited<ReturnType<typeof requireAuth>>, NextResponse>) => ctx.user?.email ?? ctx.key?.id ?? 'api';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['referrals:read', 'forms:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'referrals.read');
  if (denied) return denied;
  const { id } = await params;
  const form = referralFormById(ctx.orgId, id);
  if (!form) return fail('NOT_FOUND', 'Referral form not found.', { requestId: ctx.requestId });
  return ok({ form: { ...form, publicPath: `/refer/${form.slug}` }, version: formTemplateVersion(ctx.orgId, form.templateId, form.templateVersion) }, { requestId: ctx.requestId });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['referrals:write', 'forms:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const referralDenied = requirePermission(ctx, 'referrals.write');
  if (referralDenied) return referralDenied;
  const formsDenied = requirePermission(ctx, 'forms.manage');
  if (formsDenied) return formsDenied;
  const body = await readJson<{
    expectedRevision?: number;
    patch?: Partial<Pick<ReferralFormDoc, 'name' | 'templateId' | 'mapping' | 'routing' | 'privacyNotice' | 'emergencyNotice' | 'completionMessage' | 'active'>>;
  }>(req, 128 * 1024);
  if (body instanceof NextResponse) return body;
  if (!Number.isInteger(body.expectedRevision)) return fail('VALIDATION_ERROR', '`expectedRevision` is required.', { requestId: ctx.requestId });
  const patch = body.patch ?? {};
  const unsupported = Object.keys(patch).find((key) => !['name', 'templateId', 'mapping', 'routing', 'privacyNotice', 'emergencyNotice', 'completionMessage', 'active'].includes(key));
  if (unsupported) return fail('VALIDATION_ERROR', `Referral-form property \`${unsupported}\` is immutable or unsupported.`, { param: `patch.${unsupported}`, requestId: ctx.requestId });
  const { id } = await params;
  try {
    const row = updateReferralForm({
      orgId: ctx.orgId, id, expectedRevision: body.expectedRevision!, actor: actor(ctx),
      patch: patch as Partial<Pick<ReferralFormDoc, 'name' | 'templateId' | 'mapping' | 'routing' | 'privacyNotice' | 'emergencyNotice' | 'completionMessage' | 'active'>> & { mapping?: ReferralFieldMapping; routing?: ReferralRoutingPolicy },
    });
    return ok({ ...row, publicPath: `/refer/${row.slug}` }, { requestId: ctx.requestId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not update the referral form.';
    const storageConflict = error instanceof CommitConflictError || /duplicate key|unique constraint|revision changed|SQLITE_CONSTRAINT/i.test(message);
    return fail(message.includes('not found') ? 'NOT_FOUND' : storageConflict || message.includes('changed') ? 'CONFLICT' : 'VALIDATION_ERROR', storageConflict ? 'This referral form changed while it was being saved. Reload it and try again.' : message, { requestId: ctx.requestId });
  }
}
