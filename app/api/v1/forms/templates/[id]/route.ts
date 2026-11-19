import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { formTemplateById, formTemplateVersion, reviseFormTemplate, setFormTemplateState, type FormTemplateDoc } from '@/lib/server/forms';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const actor = (ctx: Exclude<Awaited<ReturnType<typeof requireAuth>>, NextResponse>) => ctx.user?.email ?? ctx.key?.id ?? 'api';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['forms:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'forms.read');
  if (denied) return denied;
  const { id } = await params;
  const template = formTemplateById(ctx.orgId, id);
  if (!template) return fail('NOT_FOUND', 'Form template not found.', { requestId: ctx.requestId });
  const version = formTemplateVersion(ctx.orgId, id);
  return ok({ template, version }, { requestId: ctx.requestId });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['forms:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'forms.manage');
  if (denied) return denied;
  const { id } = await params;
  const body = await readJson<{ action?: 'revise' | 'publish' | 'draft' | 'archive'; expectedRevision?: number; name?: string; category?: FormTemplateDoc['category']; schema?: unknown }>(req, 256 * 1024);
  if (body instanceof NextResponse) return body;
  if (!Number.isInteger(body.expectedRevision)) return fail('VALIDATION_ERROR', '`expectedRevision` is required.', { param: 'expectedRevision', requestId: ctx.requestId });
  if (!body.action || !['revise', 'publish', 'draft', 'archive'].includes(body.action)) return fail('VALIDATION_ERROR', '`action` is invalid.', { param: 'action', requestId: ctx.requestId });
  try {
    const result = body.action === 'revise'
      ? reviseFormTemplate({ orgId: ctx.orgId, id, schema: body.schema, name: body.name, category: body.category, actor: actor(ctx), expectedRevision: body.expectedRevision! })
      : setFormTemplateState({ orgId: ctx.orgId, id, state: body.action === 'publish' ? 'published' : body.action === 'archive' ? 'archived' : 'draft', actor: actor(ctx), expectedRevision: body.expectedRevision! });
    return ok(result, { requestId: ctx.requestId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not update the form template.';
    return fail(message.includes('changed after') ? 'CONFLICT' : message.includes('not found') ? 'NOT_FOUND' : 'VALIDATION_ERROR', message, { requestId: ctx.requestId });
  }
}
