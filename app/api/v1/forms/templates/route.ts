import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { createFormTemplate, formTemplatesFor, type FormTemplateDoc } from '@/lib/server/forms';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function actor(ctx: Awaited<ReturnType<typeof requireAuth>>) {
  if (ctx instanceof NextResponse) return 'unknown';
  return ctx.user?.email ?? ctx.key?.id ?? 'api';
}

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['forms:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'forms.read');
  if (denied) return denied;
  const includeArchived = new URL(req.url).searchParams.get('includeArchived') === '1';
  const data = formTemplatesFor(ctx.orgId, { includeArchived });
  return ok({ object: 'list', data, total: data.length }, { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['forms:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'forms.manage');
  if (denied) return denied;
  const body = await readJson<{ name?: string; category?: FormTemplateDoc['category']; schema?: unknown }>(req, 256 * 1024);
  if (body instanceof NextResponse) return body;
  try {
    const result = createFormTemplate({ orgId: ctx.orgId, name: String(body.name ?? ''), category: body.category, schema: body.schema, actor: actor(ctx) });
    return ok(result, { requestId: ctx.requestId, status: 201 });
  } catch (error) {
    return fail('VALIDATION_ERROR', error instanceof Error ? error.message : 'Could not create the form template.', { requestId: ctx.requestId });
  }
}
