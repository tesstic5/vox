import { NextResponse, type NextRequest } from 'next/server';
import { ok, requireAuth } from '@/lib/server/api';
import { metricsFor } from '@/lib/server/calls';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /v1/metrics — aggregates computed from stored calls, never seeded. */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  const days = Math.min(Number(url.searchParams.get('days') ?? 7) || 7, 90);
  return ok(metricsFor(ctx.orgId, days), { requestId: ctx.requestId });
}
