import { NextResponse, type NextRequest } from 'next/server';
import { ok, requireAuth } from '@/lib/server/api';
import { onboardingNumberSearch } from '@/lib/server/onboarding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /v1/onboarding/numbers?areaCode=415 — what can be bought right now.
 *
 * Reads live inventory from whichever account this workspace buys on: its own
 * carrier if it connected one, otherwise the deployment's managed account.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  const areaCode = url.searchParams.get('areaCode') ?? undefined;
  const country = url.searchParams.get('country') ?? 'US';
  return ok(await onboardingNumberSearch({ orgId: ctx.orgId, areaCode, country }), { requestId: ctx.requestId });
}
