import { NextResponse, type NextRequest } from 'next/server';
import { actorLabel, recordAccess } from '@/lib/server/access-log';
import { fail, listBody, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { clientById } from '@/lib/server/clients';
import {
  coverageById,
  coveragesForPatient,
  coverageView,
  createCoverage,
  updateCoverage,
  type ClientCoverageDoc,
  type CoverageSensitive,
} from '@/lib/server/coverage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const ctx = await requireAuth(req, { scopes: ['cases:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const patientId = (await params).id;
  if (!clientById(ctx.orgId, patientId)) return fail('NOT_FOUND', 'That client does not exist.', { requestId: ctx.requestId });
  const denied = requirePermission(ctx, 'cases.read', { area: 'cases', patientId });
  if (denied) return denied;
  const reveal = new URL(req.url).searchParams.get('include') === 'sensitive';
  if (reveal) {
    if (ctx.auth !== 'session') return fail('FORBIDDEN', 'Coverage identifiers can be revealed only in an authenticated staff session.', { requestId: ctx.requestId });
    const sensitiveDenied = requirePermission(ctx, 'coverage.sensitive.read', { area: 'cases', patientId });
    if (sensitiveDenied) return sensitiveDenied;
  }
  const rows = coveragesForPatient(ctx.orgId, patientId).map((row) => coverageView(row, reveal));
  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  recordAccess({ orgId: ctx.orgId, resource: 'coverage', resourceId: patientId, action: 'view', actor, actorName, detail: reveal ? 'sensitive identifiers revealed' : 'masked identifiers' });
  return ok(listBody(rows), { requestId: ctx.requestId });
}

export async function POST(req: NextRequest, { params }: Params) {
  const ctx = await requireAuth(req, { scopes: ['cases:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const patientId = (await params).id;
  if (!clientById(ctx.orgId, patientId)) return fail('NOT_FOUND', 'That client does not exist.', { requestId: ctx.requestId });
  const denied = requirePermission(ctx, 'cases.write', { area: 'cases', patientId });
  if (denied) return denied;
  const body = await readJson<{
    action?: 'create' | 'update'; id?: string; expectedRevision?: number; payerId?: string;
    holderRelationship?: ClientCoverageDoc['holderRelationship']; startsOn?: string; endsOn?: string;
    verificationStatus?: ClientCoverageDoc['verificationStatus']; verificationNote?: string;
    sensitive?: CoverageSensitive | null;
  }>(req, 32 * 1024);
  if (body instanceof NextResponse) return body;
  if (body.sensitive !== undefined) {
    if (ctx.auth !== 'session') return fail('FORBIDDEN', 'Coverage identifiers can be changed only in an authenticated staff session.', { requestId: ctx.requestId });
    const sensitiveDenied = requirePermission(ctx, 'coverage.sensitive.write', { area: 'cases', patientId });
    if (sensitiveDenied) return sensitiveDenied;
  }
  const { actor } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  if (body.action === 'update') {
    const existing = coverageById(ctx.orgId, String(body.id ?? ''));
    if (!existing || existing.patientId !== patientId) return fail('NOT_FOUND', 'That coverage does not belong to this client.', { requestId: ctx.requestId });
    const result = updateCoverage({
      orgId: ctx.orgId, id: existing.id, expectedRevision: Number(body.expectedRevision),
      patch: {
        ...(body.payerId !== undefined ? { payerId: body.payerId } : {}),
        ...(body.holderRelationship !== undefined ? { holderRelationship: body.holderRelationship } : {}),
        ...(body.startsOn !== undefined ? { startsOn: body.startsOn } : {}),
        ...(body.endsOn !== undefined ? { endsOn: body.endsOn } : {}),
        ...(body.verificationStatus !== undefined ? { verificationStatus: body.verificationStatus } : {}),
        ...(body.verificationNote !== undefined ? { verificationNote: body.verificationNote } : {}),
      },
      sensitive: body.sensitive,
      actorId: actor,
    });
    if (!result.ok) return fail(result.code === 'NOT_FOUND' ? 'NOT_FOUND' : result.code === 'CONFLICT' ? 'CONFLICT' : 'VALIDATION_ERROR', result.error, { requestId: ctx.requestId });
    return ok({ coverage: coverageView(result.value, false) }, { requestId: ctx.requestId });
  }
  const result = createCoverage({
    orgId: ctx.orgId, patientId, payerId: String(body.payerId ?? ''),
    holderRelationship: body.holderRelationship as ClientCoverageDoc['holderRelationship'], startsOn: String(body.startsOn ?? ''), endsOn: body.endsOn,
    verificationStatus: body.verificationStatus, verificationNote: body.verificationNote,
    sensitive: body.sensitive ?? undefined, actorId: actor,
  });
  if (!result.ok) return fail(result.code === 'CONFLICT' ? 'CONFLICT' : 'VALIDATION_ERROR', result.error, { requestId: ctx.requestId });
  return ok({ coverage: coverageView(result.value, false) }, { status: 201, requestId: ctx.requestId });
}
