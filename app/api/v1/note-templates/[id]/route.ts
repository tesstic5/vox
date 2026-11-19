import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, requireAuth, requirePermission } from '@/lib/server/api';
import { noteTemplateByIdV2, noteTemplateVersions } from '@/lib/server/clinical/templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['clinical:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'clinical.read');
  if (denied) return denied;
  const { id } = await params;
  const template = noteTemplateByIdV2(ctx.orgId, id);
  if (!template) return fail('NOT_FOUND', `No clinical note template with id ${id}.`, { requestId: ctx.requestId });
  return ok({ template, versions: noteTemplateVersions(ctx.orgId, id) }, { requestId: ctx.requestId });
}
