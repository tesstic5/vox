import { NextResponse, type NextRequest } from 'next/server';
import { fail, readJson, requireAuth, requireConfigRole, requireVerifiedEmail } from '@/lib/server/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Raw credential import was retired because it only wrote a local row: it did
 * not verify ownership or change carrier webhooks. A number is now adopted only
 * through a connected, verified carrier account where the SID/number pair can
 * be checked before routing is changed.
 */
export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session') {
    return fail('FORBIDDEN', 'Adopting a number requires a signed-in workspace administrator.', { requestId: ctx.requestId });
  }
  const denied = requireConfigRole(ctx) ?? requireVerifiedEmail(ctx);
  if (denied) return denied;
  const body = await readJson<Record<string, unknown>>(req);
  if (body instanceof NextResponse) return body;
  return fail(
    'VALIDATION_ERROR',
    'Direct credential import is unavailable. Connect a verified Twilio account, then adopt an owned number through POST /api/v1/carriers/{carrierId}/numbers.',
    { param: 'carrierId', requestId: ctx.requestId }
  );
}
