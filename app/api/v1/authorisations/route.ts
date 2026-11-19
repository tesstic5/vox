import { NextResponse, type NextRequest } from 'next/server';
import { actorLabel } from '@/lib/server/access-log';
import { fail, listBody, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { assignedUserIdsForCase, caseById } from '@/lib/server/cases';
import { authorisationById, authorisationsForCase, createAuthorisation, updateAuthorisation, type AuthorisationDoc, type FundingVector } from '@/lib/server/funding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['cases:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const caseId = new URL(req.url).searchParams.get('caseId') ?? '';
  const row = caseById(ctx.orgId, caseId);
  if (!row) return fail('NOT_FOUND', 'A valid caseId is required.', { requestId: ctx.requestId });
  const denied = requirePermission(ctx, 'cases.read', { area: 'cases', patientId: row.patientId, assignedUserIds: assignedUserIdsForCase(ctx.orgId, row.id) });
  if (denied) return denied;
  return ok(listBody(authorisationsForCase(ctx.orgId, caseId)), { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['cases:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson<{
    action?: 'create' | 'update'; id?: string; caseId?: string; expectedRevision?: number; coverageId?: string;
    externalReference?: string; serviceIds?: string[]; startsOn?: string; endsOn?: string; authorised?: FundingVector;
    evidenceDocumentId?: string; evidenceDocumentVersionId?: string; status?: AuthorisationDoc['status'];
  }>(req, 64 * 1024);
  if (body instanceof NextResponse) return body;
  const existing = body.action === 'update' ? authorisationById(ctx.orgId, String(body.id ?? '')) : undefined;
  const caseId = existing?.caseId ?? String(body.caseId ?? '');
  const row = caseById(ctx.orgId, caseId);
  if (!row) return fail('NOT_FOUND', 'That case does not exist.', { requestId: ctx.requestId });
  const denied = requirePermission(ctx, 'cases.write', { area: 'cases', patientId: row.patientId, assignedUserIds: assignedUserIdsForCase(ctx.orgId, row.id) });
  if (denied) return denied;
  const { actor } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  const result = body.action === 'update'
    ? updateAuthorisation({
        orgId: ctx.orgId, id: String(body.id ?? ''), expectedRevision: Number(body.expectedRevision),
        patch: {
          ...(body.coverageId !== undefined ? { coverageId: body.coverageId } : {}),
          ...(body.externalReference !== undefined ? { externalReference: body.externalReference } : {}),
          ...(body.serviceIds !== undefined ? { serviceIds: body.serviceIds } : {}),
          ...(body.startsOn !== undefined ? { startsOn: body.startsOn } : {}),
          ...(body.endsOn !== undefined ? { endsOn: body.endsOn } : {}),
          ...(body.authorised !== undefined ? { authorised: body.authorised } : {}),
          ...(body.evidenceDocumentId !== undefined ? { evidenceDocumentId: body.evidenceDocumentId } : {}),
          ...(body.evidenceDocumentVersionId !== undefined ? { evidenceDocumentVersionId: body.evidenceDocumentVersionId } : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
        }, actorId: actor,
      })
    : createAuthorisation({
        orgId: ctx.orgId, caseId, coverageId: body.coverageId,
        externalReference: String(body.externalReference ?? ''), serviceIds: body.serviceIds ?? [],
        startsOn: String(body.startsOn ?? ''), endsOn: String(body.endsOn ?? ''),
        authorised: body.authorised ?? { appointments: 0, minutes: 0, budgetMinor: 0 },
        evidenceDocumentId: body.evidenceDocumentId, evidenceDocumentVersionId: body.evidenceDocumentVersionId,
        status: body.status, actorId: actor,
      });
  if (!result.ok) return fail(result.code === 'NOT_FOUND' ? 'NOT_FOUND' : result.code === 'CONFLICT' ? 'CONFLICT' : 'VALIDATION_ERROR', result.error, { requestId: ctx.requestId });
  return ok({ authorisation: result.value }, { status: body.action === 'update' ? 200 : 201, requestId: ctx.requestId });
}
