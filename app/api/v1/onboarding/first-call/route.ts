import { NextResponse, type NextRequest } from 'next/server';
import { externalPublicOrigin, fail, ok, readJson, requireAuth, requireConfigRole, requireVerifiedEmail } from '@/lib/server/api';
import { onboardingFirstCall, onboardingState } from '@/lib/server/onboarding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /v1/onboarding/first-call — { mode: 'browser' | 'phone', to? }.
 *
 * Browser mode hands back a call id for the dashboard's live widget, so the first
 * conversation happens over a real microphone against the real runtime. Phone mode
 * dials the caller's own number — the only real way to hear what a customer will.
 */
export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session') return fail('FORBIDDEN', 'Onboarding calls require a signed-in workspace administrator.', { requestId: ctx.requestId });
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const body = await readJson<{ mode?: 'browser' | 'phone'; assistantId?: string; to?: string }>(req);
  if (body instanceof NextResponse) return body;
  const mode = body.mode === 'phone' ? 'phone' : 'browser';
  const origin = mode === 'phone' ? externalPublicOrigin(req) : undefined;
  if (mode === 'phone') {
    const blocked = requireVerifiedEmail(ctx);
    if (blocked) return blocked;
    if (!origin) return fail('CONFLICT', 'A valid HTTPS VOXERA_PUBLIC_URL is required before a production carrier call can be placed.', { requestId: ctx.requestId });
  }

  const result = await onboardingFirstCall({
    orgId: ctx.orgId,
    mode,
    assistantId: body.assistantId,
    to: body.to,
    origin,
  });

  if (!result.ok) {
    const status = result.code === 'NO_ASSISTANT' ? 409 : 400;
    return fail(status === 409 ? 'CONFLICT' : 'VALIDATION_ERROR', result.error, { requestId: ctx.requestId });
  }

  return ok(
    {
      call: result.call,
      dialled: result.dialled,
      mode: result.mode,
      carrierSid: 'carrierSid' in result ? result.carrierSid : undefined,
      note:
        result.mode === 'browser'
          ? 'Open the test call panel to exercise the configured browser-call runtime.'
          : 'The carrier accepted the outbound request. Answer only if the call reaches your phone, then verify both audio directions.',
      onboarding: onboardingState(ctx.orgId),
    },
    { requestId: ctx.requestId, status: 201 }
  );
}
