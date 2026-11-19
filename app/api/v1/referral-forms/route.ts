import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import {
  createReferralForm,
  referralFormsFor,
  type ReferralFieldMapping,
  type ReferralRoutingPolicy,
} from '@/lib/server/referral-forms';
import { CommitConflictError } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const actor = (ctx: Exclude<Awaited<ReturnType<typeof requireAuth>>, NextResponse>) => ctx.user?.email ?? ctx.key?.id ?? 'api';

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['referrals:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'referrals.read');
  if (denied) return denied;
  const includeInactive = new URL(req.url).searchParams.get('includeInactive') !== 'false';
  const data = referralFormsFor(ctx.orgId, includeInactive).map((row) => ({ ...row, publicPath: `/refer/${row.slug}` }));
  return ok({ object: 'list', data, total: data.length }, { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['referrals:write', 'forms:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const referralDenied = requirePermission(ctx, 'referrals.write');
  if (referralDenied) return referralDenied;
  const formsDenied = requirePermission(ctx, 'forms.manage');
  if (formsDenied) return formsDenied;
  const body = await readJson<{
    name?: string; slug?: string; templateId?: string; mapping?: Partial<ReferralFieldMapping>;
    routing?: Partial<ReferralRoutingPolicy>; privacyNotice?: string; emergencyNotice?: string;
    completionMessage?: string; active?: boolean;
  }>(req, 128 * 1024);
  if (body instanceof NextResponse) return body;
  try {
    const row = createReferralForm({
      orgId: ctx.orgId, name: String(body.name ?? ''), slug: String(body.slug ?? ''),
      templateId: String(body.templateId ?? ''), mapping: body.mapping ?? {}, routing: body.routing,
      privacyNotice: String(body.privacyNotice ?? ''), emergencyNotice: String(body.emergencyNotice ?? ''),
      completionMessage: body.completionMessage, active: body.active, actor: actor(ctx),
    });
    return ok({ ...row, publicPath: `/refer/${row.slug}` }, { requestId: ctx.requestId, status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not create the public referral form.';
    const conflict = error instanceof CommitConflictError || /duplicate key|unique constraint|SQLITE_CONSTRAINT|already in use/i.test(message);
    return fail(conflict ? 'CONFLICT' : 'VALIDATION_ERROR', conflict ? 'That public referral address is already in use.' : message, { requestId: ctx.requestId });
  }
}
