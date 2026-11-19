import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, requireAuth, requireConfigRole } from '@/lib/server/api';
import { listPage, type Doc } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type AuditRow = Doc & {
  orgId: string;
  action?: string;
  actor?: string;
  target?: string;
  detail?: string;
  at?: string;
};

/** Workspace audit rows are a dashboard record, not a generic collection. */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session') {
    return fail('FORBIDDEN', 'Audit history requires a signed-in workspace account.', { requestId: ctx.requestId });
  }
  const denied = requireConfigRole(ctx);
  if (denied) return denied;

  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 500) || 500, 1), 2_000);
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0);
  const page = listPage<AuditRow>('audit', ctx.orgId, { limit, offset });
  const data = [...page.docs].sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
  return ok({ object: 'list', data, total: page.total, limit, offset, has_more: offset + data.length < page.total }, { requestId: ctx.requestId });
}
