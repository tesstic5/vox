import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireApiKeyScopes, requireAuth, requirePermission } from '@/lib/server/api';
import { reviewUpdateSuggestion, updateSuggestionById } from '@/lib/server/forms';
import { requireClinicalWriteMode } from '@/lib/server/clinical-readiness';
import { customFieldDefinitionById } from '@/lib/server/intake-admin';
import { CommitConflictError } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const actor = (ctx: Exclude<Awaited<ReturnType<typeof requireAuth>>, NextResponse>) => ctx.user?.email ?? ctx.key?.id ?? 'api';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['forms:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'forms.review');
  if (denied) return denied;
  try { requireClinicalWriteMode(ctx.orgId, req.headers.get('x-voxera-synthetic-data') === '1'); }
  catch (error) { return fail('FORBIDDEN', error instanceof Error ? error.message : 'Clinical writes are disabled.', { requestId: ctx.requestId }); }
  const { id } = await params;
  const body = await readJson<{ accept?: boolean; note?: string; expectedRevision?: number }>(req, 16 * 1024);
  if (body instanceof NextResponse) return body;
  if (typeof body.accept !== 'boolean' || !Number.isInteger(body.expectedRevision)) return fail('VALIDATION_ERROR', '`accept` and `expectedRevision` are required.', { requestId: ctx.requestId });
  const suggestion = updateSuggestionById(ctx.orgId, id);
  if (!suggestion) return fail('NOT_FOUND', 'Update suggestion not found.', { requestId: ctx.requestId });
  if (body.accept && suggestion.customFieldDefinitionId) {
    const definition = customFieldDefinitionById(ctx.orgId, suggestion.customFieldDefinitionId);
    if (definition?.sensitivity !== 'administrative') {
      const scopeDenied = requireApiKeyScopes(ctx, ['clinical:write']);
      if (scopeDenied) return scopeDenied;
      const clinicalDenied = requirePermission(ctx, 'clinical.write', { area: 'clinical', patientId: suggestion.clientId });
      if (clinicalDenied) return clinicalDenied;
    }
  }
  try {
    return ok(reviewUpdateSuggestion({ orgId: ctx.orgId, id, accept: body.accept, note: body.note, actor: actor(ctx), expectedRevision: body.expectedRevision! }), { requestId: ctx.requestId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not review the client update.';
    const storageConflict = error instanceof CommitConflictError || /duplicate key|unique constraint|revision changed|SQLITE_CONSTRAINT/i.test(message);
    const conflict = storageConflict || message.includes('already') || message.includes('changed');
    return fail(message.includes('not found') ? 'NOT_FOUND' : conflict ? 'CONFLICT' : 'VALIDATION_ERROR', storageConflict ? 'This update suggestion or its target changed. Reload the response before deciding again.' : message, { requestId: ctx.requestId });
  }
}
