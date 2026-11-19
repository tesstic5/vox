import { NextResponse, type NextRequest } from 'next/server';
import { ok, requireAuth } from '@/lib/server/api';
import { list, type Doc } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /v1/phone-numbers — the documented name for the numbers resource.
 * `/v1/numbers` is the same collection and stays supported for the dashboard.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['numbers:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const items = list<Doc>('numbers', (n) => n.orgId === ctx.orgId);
  return ok({ object: 'list', data: items, total: items.length, has_more: false }, { requestId: ctx.requestId });
}
