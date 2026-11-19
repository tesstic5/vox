import { NextResponse, type NextRequest } from 'next/server';
import { ok, requireAuth } from '@/lib/server/api';
import { analyticsFor } from '@/lib/server/calls';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /v1/analytics?days=30 — volume, containment, latency, cost and
 * per-assistant/intent aggregates for a window plus the equal-length
 * previous window, computed over every stored call. The calls list API
 * caps a page at 100 records, so dashboards counting locally were
 * silently truncating; this endpoint is the untruncated truth.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  const days = Math.min(Math.max(Number(url.searchParams.get('days') ?? 30) || 30, 1), 90);
  return ok(analyticsFor(ctx.orgId, days), { requestId: ctx.requestId });
}
