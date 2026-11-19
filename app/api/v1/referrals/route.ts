import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { createReferral, referralsFor, type ReferralDoc, type ReferralPriority, type ReferralStatus } from '@/lib/server/referrals';
import { requireClinicalWriteMode } from '@/lib/server/clinical-readiness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const actor = (ctx: Exclude<Awaited<ReturnType<typeof requireAuth>>, NextResponse>) => ctx.user?.email ?? ctx.key?.id ?? 'api';

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['referrals:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'referrals.read');
  if (denied) return denied;
  const query = new URL(req.url).searchParams;
  const data = referralsFor(ctx.orgId, {
    status: (query.get('status') || undefined) as ReferralStatus | undefined,
    priority: (query.get('priority') || undefined) as ReferralPriority | undefined,
    ownerId: query.get('ownerId') || undefined,
    q: query.get('q') || undefined,
  });
  return ok({ object: 'list', data, total: data.length }, { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['referrals:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'referrals.write');
  if (denied) return denied;
  try { requireClinicalWriteMode(ctx.orgId, req.headers.get('x-voxera-synthetic-data') === '1'); }
  catch (error) { return fail('FORBIDDEN', error instanceof Error ? error.message : 'Clinical writes are disabled.', { requestId: ctx.requestId }); }
  const body = await readJson<Partial<ReferralDoc> & { patient?: Partial<ReferralDoc['patient']> }>(req, 512 * 1024);
  if (body instanceof NextResponse) return body;
  try {
    const result = createReferral({
      orgId: ctx.orgId, source: body.source, externalReference: body.externalReference, priority: body.priority,
      serviceId: body.serviceId, locationId: body.locationId, practitionerId: body.practitionerId, teamId: body.teamId,
      ownerId: body.ownerId, patient: body.patient ?? {}, referrer: body.referrer, reason: String(body.reason ?? ''),
      notes: body.notes, consentConfirmed: body.consentConfirmed, documentIds: body.documentIds, actor: actor(ctx),
    });
    return ok(result, { requestId: ctx.requestId, status: 201 });
  } catch (error) {
    return fail('VALIDATION_ERROR', error instanceof Error ? error.message : 'Could not create the referral.', { requestId: ctx.requestId });
  }
}
