import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { formAssignmentById, revokeFormAssignment } from '@/lib/server/forms';
import { requireClinicalWriteMode } from '@/lib/server/clinical-readiness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const actor = (ctx: Exclude<Awaited<ReturnType<typeof requireAuth>>, NextResponse>) => ctx.user?.email ?? ctx.key?.id ?? 'api';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['forms:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'forms.read');
  if (denied) return denied;
  const { id } = await params;
  const row = formAssignmentById(ctx.orgId, id);
  if (!row) return fail('NOT_FOUND', 'Form assignment not found.', { requestId: ctx.requestId });
  const { tokenHash: _tokenHash, ...assignment } = row;
  return ok(assignment, { requestId: ctx.requestId });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['forms:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'forms.assign');
  if (denied) return denied;
  try { requireClinicalWriteMode(ctx.orgId, req.headers.get('x-voxera-synthetic-data') === '1'); }
  catch (error) { return fail('FORBIDDEN', error instanceof Error ? error.message : 'Clinical writes are disabled.', { requestId: ctx.requestId }); }
  const body = await readJson<{ action?: 'revoke'; expectedRevision?: number }>(req, 16 * 1024);
  if (body instanceof NextResponse) return body;
  if (body.action !== 'revoke' || !Number.isInteger(body.expectedRevision)) return fail('VALIDATION_ERROR', '`action: revoke` and `expectedRevision` are required.', { requestId: ctx.requestId });
  const { id } = await params;
  try {
    const row = revokeFormAssignment({ orgId: ctx.orgId, id, actor: actor(ctx), expectedRevision: body.expectedRevision! });
    const { tokenHash: _tokenHash, ...assignment } = row;
    return ok(assignment, { requestId: ctx.requestId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not revoke the form assignment.';
    return fail(message.includes('not found') ? 'NOT_FOUND' : message.includes('changed') || message.includes('cannot') ? 'CONFLICT' : 'VALIDATION_ERROR', message, { requestId: ctx.requestId });
  }
}
