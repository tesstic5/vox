import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, requireAuth } from '@/lib/server/api';
import { growthReport } from '@/lib/server/growth';
import { canWorkLeads } from '@/lib/server/leads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/growth — the signup-to-value funnel, platform-wide.
 *
 * Like the leads inbox, this is the platform's view of itself, not a
 * workspace's view of its practice, so it carries the same operator
 * gate and refuses API keys.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session' || !canWorkLeads(ctx.user)) {
    return fail('FORBIDDEN', 'Growth is for the team that runs the platform.', { requestId: ctx.requestId });
  }
  return ok(growthReport(), { requestId: ctx.requestId });
}
