import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { contactById, updateContact, type ContactDoc } from '@/lib/server/intake-admin';
import { requireClinicalWriteMode } from '@/lib/server/clinical-readiness';
import { CommitConflictError } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const actor = (ctx: Exclude<Awaited<ReturnType<typeof requireAuth>>, NextResponse>) => ctx.user?.email ?? ctx.key?.id ?? 'api';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['clients:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'clients.read');
  if (denied) return denied;
  const { id } = await params;
  const row = contactById(ctx.orgId, id);
  return row ? ok(row, { requestId: ctx.requestId }) : fail('NOT_FOUND', 'Contact not found.', { requestId: ctx.requestId });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['clients:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'clients.write');
  if (denied) return denied;
  try { requireClinicalWriteMode(ctx.orgId, req.headers.get('x-voxera-synthetic-data') === '1'); }
  catch (error) { return fail('FORBIDDEN', error instanceof Error ? error.message : 'Contact writes are disabled.', { requestId: ctx.requestId }); }
  const body = await readJson<{ expectedRevision?: number; patch?: Partial<ContactDoc> }>(req);
  if (body instanceof NextResponse) return body;
  if (!Number.isInteger(body.expectedRevision)) return fail('VALIDATION_ERROR', '`expectedRevision` is required.', { requestId: ctx.requestId });
  const patch = body.patch ?? {};
  const unsupported = Object.keys(patch).find((key) => !['name', 'email', 'phone', 'address', 'referrer', 'payer', 'active', 'notes'].includes(key));
  if (unsupported) return fail('VALIDATION_ERROR', `Contact field \`${unsupported}\` cannot be changed here.`, { param: `patch.${unsupported}`, requestId: ctx.requestId });
  const { id } = await params;
  try {
    return ok(updateContact({ orgId: ctx.orgId, id, expectedRevision: body.expectedRevision!, actor: actor(ctx), patch }), { requestId: ctx.requestId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not update the contact.';
    const storageConflict = error instanceof CommitConflictError || /duplicate key|unique constraint|revision changed|SQLITE_CONSTRAINT/i.test(message);
    return fail(message.includes('not found') ? 'NOT_FOUND' : storageConflict || message.includes('changed') ? 'CONFLICT' : 'VALIDATION_ERROR', storageConflict ? 'This contact changed while it was being saved. Reload it and try again.' : message, { requestId: ctx.requestId });
  }
}
