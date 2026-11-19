import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { referralById, updateReferralStructuredAddress } from '@/lib/server/referrals';
import { requireClinicalWriteMode } from '@/lib/server/clinical-readiness';
import { CommitConflictError } from '@/lib/server/db';
import type { StructuredAddressInput } from '@/lib/addresses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const actor = (ctx: Exclude<Awaited<ReturnType<typeof requireAuth>>, NextResponse>) => ctx.user?.email ?? ctx.key?.id ?? 'api';

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['referrals:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'referrals.write');
  if (denied) return denied;
  const { id } = await params;
  if (!referralById(ctx.orgId, id)) return fail('NOT_FOUND', 'Referral not found.', { requestId: ctx.requestId });
  try { requireClinicalWriteMode(ctx.orgId, req.headers.get('x-voxera-synthetic-data') === '1'); }
  catch (error) { return fail('FORBIDDEN', error instanceof Error ? error.message : 'Referral writes are disabled.', { requestId: ctx.requestId }); }
  const body = await readJson<{ expectedRevision?: number; address?: StructuredAddressInput }>(req);
  if (body instanceof NextResponse) return body;
  if (!Number.isInteger(body.expectedRevision)) return fail('VALIDATION_ERROR', '`expectedRevision` is required.', { param: 'expectedRevision', requestId: ctx.requestId });
  if (!body.address) return fail('VALIDATION_ERROR', '`address` is required.', { param: 'address', requestId: ctx.requestId });
  try {
    return ok(updateReferralStructuredAddress({
      orgId: ctx.orgId,
      id,
      address: body.address,
      expectedRevision: body.expectedRevision!,
      actor: actor(ctx),
    }), { requestId: ctx.requestId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not review the address.';
    const conflict = error instanceof CommitConflictError || /changed|revision|constraint/i.test(message);
    return fail(message.includes('not found') ? 'NOT_FOUND' : conflict || message.includes('cannot be amended') ? 'CONFLICT' : 'VALIDATION_ERROR', conflict ? 'This referral changed while the address was being saved. Reload it and try again.' : message, { requestId: ctx.requestId });
  }
}
