import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { formResponseVersion, formResponsesFor, reviewFormResponse, updateSuggestionsFor } from '@/lib/server/forms';
import { requireClinicalWriteMode } from '@/lib/server/clinical-readiness';
import { recordAccess } from '@/lib/server/access-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const actor = (ctx: Exclude<Awaited<ReturnType<typeof requireAuth>>, NextResponse>) => ctx.user?.email ?? ctx.key?.id ?? 'api';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['forms:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'forms.review');
  if (denied) return denied;
  const { id } = await params;
  const response = formResponsesFor(ctx.orgId).find((row) => row.id === id);
  if (!response) return fail('NOT_FOUND', 'Form response not found.', { requestId: ctx.requestId });
  if (response.clientId) {
    const scoped = requirePermission(ctx, 'clinical.read', { area: 'clinical', patientId: response.clientId });
    if (scoped) return scoped;
    recordAccess({ orgId: ctx.orgId, resource: 'client', resourceId: response.clientId, action: 'view', actor: actor(ctx), detail: `form response ${id}` });
  }
  return ok({ response, version: formResponseVersion(ctx.orgId, id), suggestions: updateSuggestionsFor(ctx.orgId).filter((row) => row.responseId === id) }, { requestId: ctx.requestId });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['forms:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'forms.review');
  if (denied) return denied;
  try { requireClinicalWriteMode(ctx.orgId, req.headers.get('x-voxera-synthetic-data') === '1'); }
  catch (error) { return fail('FORBIDDEN', error instanceof Error ? error.message : 'Clinical writes are disabled.', { requestId: ctx.requestId }); }
  const { id } = await params;
  const body = await readJson<{ expectedRevision?: number; note?: string }>(req, 16 * 1024);
  if (body instanceof NextResponse) return body;
  if (!Number.isInteger(body.expectedRevision)) return fail('VALIDATION_ERROR', '`expectedRevision` is required.', { param: 'expectedRevision', requestId: ctx.requestId });
  try {
    return ok(reviewFormResponse({ orgId: ctx.orgId, id, actor: actor(ctx), note: body.note, expectedRevision: body.expectedRevision! }), { requestId: ctx.requestId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not review the form response.';
    return fail(message.includes('not found') ? 'NOT_FOUND' : message.includes('changed') ? 'CONFLICT' : 'VALIDATION_ERROR', message, { requestId: ctx.requestId });
  }
}
