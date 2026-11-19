import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { letterTemplateById, letterTemplateVersion, reviseLetterTemplate, setLetterTemplateState } from '@/lib/server/letters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const actor = (ctx: Exclude<Awaited<ReturnType<typeof requireAuth>>, NextResponse>) => ctx.user?.email ?? ctx.key?.id ?? 'api';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['letters:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'letters.read');
  if (denied) return denied;
  const { id } = await params;
  const template = letterTemplateById(ctx.orgId, id);
  if (!template) return fail('NOT_FOUND', 'Letter template not found.', { requestId: ctx.requestId });
  return ok({ template, version: letterTemplateVersion(ctx.orgId, id) }, { requestId: ctx.requestId });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['letters:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const body = await readJson<{ action?: 'revise' | 'publish' | 'draft' | 'archive'; expectedRevision?: number; name?: string; subject?: string; body?: string; footer?: string; requiresApproval?: boolean }>(req, 256 * 1024);
  if (body instanceof NextResponse) return body;
  const denied = requirePermission(ctx, body.action === 'publish' ? 'letters.approve' : 'letters.write');
  if (denied) return denied;
  if (!Number.isInteger(body.expectedRevision)) return fail('VALIDATION_ERROR', '`expectedRevision` is required.', { requestId: ctx.requestId });
  if (!body.action) return fail('VALIDATION_ERROR', '`action` is required.', { requestId: ctx.requestId });
  try {
    const result = body.action === 'revise'
      ? reviseLetterTemplate({ orgId: ctx.orgId, id, name: body.name, subject: String(body.subject ?? ''), body: String(body.body ?? ''), footer: body.footer, requiresApproval: body.requiresApproval, actor: actor(ctx), expectedRevision: body.expectedRevision! })
      : setLetterTemplateState({ orgId: ctx.orgId, id, state: body.action === 'publish' ? 'published' : body.action === 'archive' ? 'archived' : 'draft', actor: actor(ctx), expectedRevision: body.expectedRevision! });
    return ok(result, { requestId: ctx.requestId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not update the letter template.';
    return fail(message.includes('not found') ? 'NOT_FOUND' : message.includes('changed') ? 'CONFLICT' : 'VALIDATION_ERROR', message, { requestId: ctx.requestId });
  }
}
