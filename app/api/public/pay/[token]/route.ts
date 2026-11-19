import { NextResponse, type NextRequest } from 'next/server';
import { clientIp, fail, ok, readJson } from '@/lib/server/api';
import { rateLimit } from '@/lib/server/ratelimit';
import { publicLinkView, settleLink } from '@/lib/server/payments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The public payment page's API.
 *
 * Unauthenticated by design — this is the page a patient opens from a text — so
 * it returns the *smallest* possible truth: what the link is for, how much, for
 * which practice, and whether it is still open. It never returns the client's
 * name, their other invoices, the practice's other records, or anything about the
 * invoice beyond the amount.
 *
 * `POST` is the sandbox door: when a workspace has no payment provider connected
 * (which is how it runs out of the box), the page takes a test payment here. The
 * row it writes is marked `sandbox` in the audit trail and in the link's own
 * record, so nobody can mistake it for money that moved. When Stripe *is*
 * connected, the link points at Stripe and this endpoint refuses to settle
 * anything — the webhook does that.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const limit = rateLimit(`pay:view:${clientIp(req)}`, 60);
  if (!limit.allowed) {
    return fail('RATE_LIMITED', 'Too many requests — try again in a minute.', { headers: { 'retry-after': '60' } });
  }
  const view = publicLinkView(token);
  if (!view) return fail('NOT_FOUND', 'That payment link does not exist.', {});
  return ok({ link: view }, {});
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const limit = rateLimit(`pay:settle:${clientIp(req)}`, 20);
  if (!limit.allowed) {
    return fail('RATE_LIMITED', 'Too many attempts — try again in a minute.', { headers: { 'retry-after': '60' } });
  }
  const body = await readJson<{ action?: string; card?: string }>(req);
  if (body instanceof NextResponse) return body;

  const view = publicLinkView(token);
  if (!view) return fail('NOT_FOUND', 'That payment link does not exist.', {});
  if (!view.sandbox) {
    return fail('VALIDATION_ERROR', 'This practice takes payments through its provider — finish the payment on the page you were sent.', {});
  }
  if (view.status === 'paid') {
    return ok({ alreadyPaid: true, link: view }, {});
  }
  if (view.status !== 'open') {
    return fail('CONFLICT', view.status === 'expired' ? 'This payment link has expired. Ask the practice for a new one.' : 'This payment link was cancelled.', {});
  }

  const settled = settleLink({
    token,
    method: 'card',
    actor: 'payment-page',
    actorName: 'Payment page (sandbox)',
    source: 'online',
  });
  if (!settled.ok) return fail(settled.code === 'NOT_FOUND' ? 'NOT_FOUND' : settled.code === 'CONFLICT' ? 'CONFLICT' : 'VALIDATION_ERROR', settled.error, {});
  return ok({ paid: true, link: publicLinkView(token), paymentId: settled.payment.id, sandbox: true }, {});
}
