import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { createLetterTemplate, letterTemplatesFor, type LetterTemplateDoc } from '@/lib/server/letters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const actor = (ctx: Exclude<Awaited<ReturnType<typeof requireAuth>>, NextResponse>) => ctx.user?.email ?? ctx.key?.id ?? 'api';

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['letters:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'letters.read');
  if (denied) return denied;
  const data = letterTemplatesFor(ctx.orgId, new URL(req.url).searchParams.get('includeArchived') === '1');
  return ok({ object: 'list', data, total: data.length }, { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['letters:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'letters.write');
  if (denied) return denied;
  const body = await readJson<{ name?: string; category?: LetterTemplateDoc['category']; subject?: string; body?: string; footer?: string; requiresApproval?: boolean }>(req, 256 * 1024);
  if (body instanceof NextResponse) return body;
  try {
    return ok(createLetterTemplate({ orgId: ctx.orgId, name: String(body.name ?? ''), category: body.category, subject: String(body.subject ?? ''), body: String(body.body ?? ''), footer: body.footer, requiresApproval: body.requiresApproval, actor: actor(ctx) }), { requestId: ctx.requestId, status: 201 });
  } catch (error) {
    return fail('VALIDATION_ERROR', error instanceof Error ? error.message : 'Could not create the letter template.', { requestId: ctx.requestId });
  }
}
