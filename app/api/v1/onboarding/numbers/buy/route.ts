import { NextResponse, type NextRequest } from 'next/server';
import { externalPublicOrigin, fail, ok, readJson, requireAuth, requireConfigRole, requireVerifiedEmail } from '@/lib/server/api';
import { onboardingBuyNumber, onboardingState } from '@/lib/server/onboarding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /v1/onboarding/numbers/buy — buy the number and point it at the agent.
 *
 * One call, because a number that exists without an assistant behind it is worse
 * than no number: it rings and says nothing useful.
 */
export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session') return fail('FORBIDDEN', 'Onboarding number purchase requires a signed-in workspace administrator.', { requestId: ctx.requestId });
  const denied = requireConfigRole(ctx) ?? requireVerifiedEmail(ctx);
  if (denied) return denied;
  const body = await readJson<{ number?: string; assistantId?: string; label?: string; country?: string }>(req);
  if (body instanceof NextResponse) return body;
  if (!body.number) return fail('VALIDATION_ERROR', 'Send the `number` to buy.', { param: 'number', requestId: ctx.requestId });
  const origin = externalPublicOrigin(req);
  if (!origin) {
    return fail('CONFLICT', 'A valid HTTPS VOXERA_PUBLIC_URL is required before a production carrier can be programmed.', { requestId: ctx.requestId });
  }

  const result = await onboardingBuyNumber({
    orgId: ctx.orgId,
    number: body.number,
    assistantId: body.assistantId,
    label: body.label,
    country: body.country,
    origin,
  });

  if (!result.ok) {
    return fail(result.code === 'NO_CARRIER' ? 'CONFLICT' : 'VALIDATION_ERROR', result.error, { requestId: ctx.requestId });
  }

  return ok(
    {
      number: result.number,
      boughtOn: result.mode,
      reused: result.reused,
      note: result.reused
        ? 'That number was already in the workspace — nothing was bought twice.'
        : 'The carrier accepted the purchase and webhook configuration. Test inbound and outbound routing before relying on it.',
      onboarding: onboardingState(ctx.orgId),
    },
    { requestId: ctx.requestId, status: result.reused ? 200 : 201 }
  );
}
