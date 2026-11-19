import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, requireAuth } from '@/lib/server/api';
import { isPlatformOperator } from '@/lib/server/operator';
import { adminOverview } from '@/lib/server/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /v1/admin/overview — the operator console's one read: every workspace
 * with its usage, platform totals, queue health and store size. Session-only
 * and operator-only; an API key can never see across workspaces.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session' || !isPlatformOperator(ctx.user)) {
    return fail('FORBIDDEN', 'The operator console is for the platform operator. Ask an admin to add your email to VOXERA_OPERATOR_EMAILS.', {
      requestId: ctx.requestId,
    });
  }
  return ok(adminOverview(), { requestId: ctx.requestId });
}
