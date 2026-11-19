import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { customFieldDefinitionById, updateCustomFieldDefinition, type CustomFieldDefinitionDoc } from '@/lib/server/intake-admin';
import { CommitConflictError } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const actor = (ctx: Exclude<Awaited<ReturnType<typeof requireAuth>>, NextResponse>) => ctx.user?.email ?? ctx.key?.id ?? 'api';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['forms:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'forms.read');
  if (denied) return denied;
  const { id } = await params;
  const row = customFieldDefinitionById(ctx.orgId, id);
  return row ? ok(row, { requestId: ctx.requestId }) : fail('NOT_FOUND', 'Custom-field definition not found.', { requestId: ctx.requestId });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['forms:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'forms.manage');
  if (denied) return denied;
  const body = await readJson<{ expectedRevision?: number; patch?: Partial<CustomFieldDefinitionDoc> }>(req);
  if (body instanceof NextResponse) return body;
  if (!Number.isInteger(body.expectedRevision)) return fail('VALIDATION_ERROR', '`expectedRevision` is required.', { requestId: ctx.requestId });
  const patch = body.patch ?? {};
  const unsupported = Object.keys(patch).find((key) => !['label', 'options', 'sensitivity', 'required', 'active', 'order'].includes(key));
  if (unsupported) return fail('VALIDATION_ERROR', `Custom-field property \`${unsupported}\` is immutable or unsupported.`, { param: `patch.${unsupported}`, requestId: ctx.requestId });
  try {
    return ok(updateCustomFieldDefinition({ orgId: ctx.orgId, id: (await params).id, expectedRevision: body.expectedRevision!, actor: actor(ctx), patch }), { requestId: ctx.requestId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not update the custom field.';
    const storageConflict = error instanceof CommitConflictError || /duplicate key|unique constraint|revision changed|SQLITE_CONSTRAINT/i.test(message);
    return fail(message.includes('not found') ? 'NOT_FOUND' : storageConflict || message.includes('changed') ? 'CONFLICT' : 'VALIDATION_ERROR', storageConflict ? 'This custom-field definition changed while it was being saved. Reload it and try again.' : message, { requestId: ctx.requestId });
  }
}
