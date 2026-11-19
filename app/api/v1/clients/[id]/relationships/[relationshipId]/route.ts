import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { updateClientRelationship, type ClientRelationshipDoc } from '@/lib/server/intake-admin';
import { requireClinicalWriteMode } from '@/lib/server/clinical-readiness';
import { CommitConflictError } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const actor = (ctx: Exclude<Awaited<ReturnType<typeof requireAuth>>, NextResponse>) => ctx.user?.email ?? ctx.key?.id ?? 'api';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; relationshipId: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['clients:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const { id, relationshipId } = await params;
  const denied = requirePermission(ctx, 'clients.write', { area: 'clients', patientId: id });
  if (denied) return denied;
  try { requireClinicalWriteMode(ctx.orgId, req.headers.get('x-voxera-synthetic-data') === '1'); }
  catch (error) { return fail('FORBIDDEN', error instanceof Error ? error.message : 'Relationship writes are disabled.', { requestId: ctx.requestId }); }
  const body = await readJson<{ expectedRevision?: number; patch?: Partial<ClientRelationshipDoc> }>(req);
  if (body instanceof NextResponse) return body;
  if (!Number.isInteger(body.expectedRevision)) return fail('VALIDATION_ERROR', '`expectedRevision` is required.', { requestId: ctx.requestId });
  const patch = body.patch ?? {};
  const unsupported = Object.keys(patch).find((key) => !['relationshipType', 'label', 'guardian', 'proxy', 'billing', 'emergency', 'referrer', 'verified', 'effectiveFrom', 'effectiveTo', 'notes', 'status'].includes(key));
  if (unsupported) return fail('VALIDATION_ERROR', `Relationship field \`${unsupported}\` cannot be changed here.`, { param: `patch.${unsupported}`, requestId: ctx.requestId });
  try {
    return ok(updateClientRelationship({ orgId: ctx.orgId, clientId: id, id: relationshipId, expectedRevision: body.expectedRevision!, actor: actor(ctx), patch }), { requestId: ctx.requestId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not update the relationship.';
    const storageConflict = error instanceof CommitConflictError || /duplicate key|unique constraint|revision changed|SQLITE_CONSTRAINT/i.test(message);
    return fail(message.includes('not found') ? 'NOT_FOUND' : storageConflict || message.includes('changed') ? 'CONFLICT' : 'VALIDATION_ERROR', storageConflict ? 'This relationship changed while it was being saved. Reload the patient record and try again.' : message, { requestId: ctx.requestId });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string; relationshipId: string }> }) {
  const url = new URL(req.url);
  const expectedRevision = Number(url.searchParams.get('expectedRevision'));
  if (!Number.isInteger(expectedRevision)) return fail('VALIDATION_ERROR', '`expectedRevision` is required.', { requestId: crypto.randomUUID() });
  const ctx = await requireAuth(req, { scopes: ['clients:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const { id, relationshipId } = await params;
  const denied = requirePermission(ctx, 'clients.write', { area: 'clients', patientId: id });
  if (denied) return denied;
  try { requireClinicalWriteMode(ctx.orgId, req.headers.get('x-voxera-synthetic-data') === '1'); }
  catch (error) { return fail('FORBIDDEN', error instanceof Error ? error.message : 'Relationship writes are disabled.', { requestId: ctx.requestId }); }
  try {
    const row = updateClientRelationship({ orgId: ctx.orgId, clientId: id, id: relationshipId, expectedRevision, actor: actor(ctx), patch: { status: 'ended', effectiveTo: new Date().toISOString().slice(0, 10) } });
    return ok(row, { requestId: ctx.requestId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not end the relationship.';
    const storageConflict = error instanceof CommitConflictError || /duplicate key|unique constraint|revision changed|SQLITE_CONSTRAINT/i.test(message);
    return fail(message.includes('not found') ? 'NOT_FOUND' : storageConflict || message.includes('changed') ? 'CONFLICT' : 'VALIDATION_ERROR', storageConflict ? 'This relationship changed while it was being ended. Reload the patient record and try again.' : message, { requestId: ctx.requestId });
  }
}
