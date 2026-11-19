import { NextResponse, type NextRequest } from 'next/server';
import { applyStripeEvent, stripeWebhookSecret } from '@/lib/server/payments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Stripe's webhook: how money that was actually taken reaches the record.
 *
 * Three rules, and they are the difference between a payment integration and a
 * hole where payments should be:
 *
 *   1. **Verified before read.** The signature is checked against
 *      `STRIPE_WEBHOOK_SECRET` over the *raw* body, with a replay window. An
 *      unsigned or stale event is refused with 400 and nothing is applied — never
 *      trust a payload that merely claims to be Stripe.
 *   2. **No secret, no webhook.** With no webhook secret configured the endpoint
 *      refuses everything rather than accepting unverified events. (The sandbox
 *      flow does not need it: it never leaves this deployment.)
 *   3. **Idempotent.** The same session id arriving twice returns the first
 *      payment; it does not take the money again. Stripe retries, and a retry
 *      that double-charges a patient is the worst bug this file could have.
 *
 * It answers 200 to anything it has decided about, including events it has no use
 * for (Stripe would otherwise retry them forever), and 400 only when the event
 * itself cannot be trusted.
 */
export async function POST(req: NextRequest) {
  const secret = stripeWebhookSecret();
  if (!secret) {
    return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'Stripe webhooks are not configured for this deployment (set STRIPE_WEBHOOK_SECRET).' } }, { status: 400 });
  }
  const payload = await req.text();
  const header = req.headers.get('stripe-signature') ?? undefined;

  const { verifySignature } = await import('@/lib/server/providers/stripe');
  if (!verifySignature({ payload, header, secret })) {
    // Deliberately *not* written to the workspace audit trail: an unverified
    // payload cannot be attributed to a workspace, and inventing one would put a
    // stranger's noise in a practice's record. It is visible in the server log and
    // in Stripe's own dashboard, which is where a rejected event belongs.
    console.warn('[stripe] rejected a webhook whose signature did not verify');
    return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Signature verification failed.' } }, { status: 400 });
  }

  let event: { id?: string; type?: string; data?: { object?: Record<string, unknown> } };
  try {
    event = JSON.parse(payload) as typeof event;
  } catch {
    return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'Body was not JSON.' } }, { status: 400 });
  }

  const result = await applyStripeEvent(event as never);
  return NextResponse.json({ received: true, ...result }, { status: 200 });
}
