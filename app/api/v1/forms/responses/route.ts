import { NextResponse, type NextRequest } from 'next/server';
import { ok, requireAuth, requirePermission } from '@/lib/server/api';
import { formResponsesFor, type FormResponseDoc } from '@/lib/server/forms';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['forms:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'forms.review');
  if (denied) return denied;
  const query = new URL(req.url).searchParams;
  const data = formResponsesFor(ctx.orgId, {
    clientId: query.get('clientId') || undefined,
    assignmentId: query.get('assignmentId') || undefined,
    status: (query.get('status') || undefined) as FormResponseDoc['status'] | undefined,
  });
  return ok({ object: 'list', data, total: data.length }, { requestId: ctx.requestId });
}
