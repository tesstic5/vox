import { NextResponse, type NextRequest } from 'next/server';
import { ok, requireAuth } from '@/lib/server/api';
import { costs as compute, windowFrom } from '@/lib/server/analytics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /v1/analytics/costs — computed from the same call and usage records the
 * dashboard renders, so an API response and a dashboard screenshot agree.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  const w = windowFrom(url);
  const assistantId = url.searchParams.get('assistantId');
  return ok(compute(ctx.orgId, w, { assistantId }), {
    requestId: ctx.requestId,
  });
}
