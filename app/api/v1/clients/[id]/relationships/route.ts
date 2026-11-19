import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { clientById } from '@/lib/server/clients';
import { clientRelationshipsFor, contactById, createClientRelationship, type ClientRelationshipDoc, type ClientRelationshipType } from '@/lib/server/intake-admin';
import { requireClinicalWriteMode } from '@/lib/server/clinical-readiness';
import { CommitConflictError } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const actor = (ctx: Exclude<Awaited<ReturnType<typeof requireAuth>>, NextResponse>) => ctx.user?.email ?? ctx.key?.id ?? 'api';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['clients:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const denied = requirePermission(ctx, 'clients.read', { area: 'clients', patientId: id });
  if (denied) return denied;
  if (!clientById(ctx.orgId, id)) return fail('NOT_FOUND', 'Patient not found.', { requestId: ctx.requestId });
  const data = clientRelationshipsFor(ctx.orgId, id, new URL(req.url).searchParams.get('includeEnded') === 'true').map((row) => ({
    ...row,
    relatedClient: row.relatedClientId ? clientById(ctx.orgId, row.relatedClientId) : undefined,
    contact: row.contactId ? contactById(ctx.orgId, row.contactId) : undefined,
  }));
  return ok({ object: 'list', data, total: data.length }, { requestId: ctx.requestId });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['clients:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const denied = requirePermission(ctx, 'clients.write', { area: 'clients', patientId: id });
  if (denied) return denied;
  try { requireClinicalWriteMode(ctx.orgId, req.headers.get('x-voxera-synthetic-data') === '1'); }
  catch (error) { return fail('FORBIDDEN', error instanceof Error ? error.message : 'Relationship writes are disabled.', { requestId: ctx.requestId }); }
  const body = await readJson<Partial<ClientRelationshipDoc> & { relationshipType?: ClientRelationshipType }>(req);
  if (body instanceof NextResponse) return body;
  if (!body.relationshipType) return fail('VALIDATION_ERROR', '`relationshipType` is required.', { requestId: ctx.requestId });
  try {
    const row = createClientRelationship({
      orgId: ctx.orgId, clientId: id, relatedClientId: body.relatedClientId, contactId: body.contactId,
      relationshipType: body.relationshipType, label: body.label, guardian: body.guardian, proxy: body.proxy,
      billing: body.billing, emergency: body.emergency, referrer: body.referrer, verified: body.verified,
      effectiveFrom: body.effectiveFrom, effectiveTo: body.effectiveTo, notes: body.notes, actor: actor(ctx),
    });
    return ok(row, { requestId: ctx.requestId, status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not create the relationship.';
    const storageConflict = error instanceof CommitConflictError || /duplicate key|unique constraint|SQLITE_CONSTRAINT/i.test(message);
    const conflict = storageConflict || message.includes('already');
    return fail(message.includes('not found') ? 'NOT_FOUND' : conflict ? 'CONFLICT' : 'VALIDATION_ERROR', storageConflict ? 'That active relationship already exists or changed. Reload the patient record and try again.' : message, { requestId: ctx.requestId });
  }
}
