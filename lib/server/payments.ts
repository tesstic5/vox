/**
 * Payment links — how money is asked for, and how it arrives.
 *
 * The rule that shapes this file: **a practice with no payment provider must
 * still be able to take a card payment in the demo, and a practice with a Stripe
 * key must use Stripe.** So there are two drivers behind one door:
 *
 *   - **`stripe`**, when a secret key is configured (deployment env or the
 *     workspace's own connected account). A Checkout Session is created and its
 *     URL is the link. The money is real; the webhook is verified before it is
 *     believed.
 *   - **`sandbox`**, when nothing is configured. The link points at this
 *     deployment's own `/pay/<token>` page, where a test payment completes the
 *     link and writes the *same* payment row through the *same* module — marked
 *     `sandbox` so nobody can mistake it for money that moved. That is what makes
 *     the phase gate honest: "works with no keys" is a real flow, not a stub that
 *     always says yes.
 *
 * A link is a claim on one invoice for a fixed amount. Completing it is
 * idempotent: the provider reference (or the token) is the key, so a webhook
 * retry cannot take the money twice.
 */

import { get, insert, list, newId, nowIso, update, type Doc } from './db';
import { audit } from './audit';
import { recordAccess } from './access-log';
import { clientById } from './clients';
import {
  balanceMinorOf,
  formatMoney,
  invoiceById,
  moneySettingsFor,
  recordPayment,
  toMinor,
  type InvoiceDoc,
  type PaymentDoc,
} from './money';
import { createCheckoutSession, getCheckoutSession, verifySignature, type StripeSession } from './providers/stripe';

export type PaymentLinkStatus = 'open' | 'paid' | 'cancelled' | 'expired';

export type PaymentLinkDoc = Doc & {
  orgId: string;
  token: string;
  invoiceId: string;
  clientId: string;
  amountMinor: number;
  currency: string;
  provider: 'stripe' | 'sandbox';
  providerRef?: string;
  url: string;
  description: string;
  status: PaymentLinkStatus;
  createdAt: string;
  expiresAt: string;
  sentAt?: string;
  sentVia?: 'sms' | 'email' | 'manual';
  paidAt?: string;
  paymentId?: string;
  createdBy: string;
  createdByName?: string;
  note?: string;
};

const LINK_DAYS = 14;

/* ---------------------------------------------------------------- credentials */

export type PaymentProviderInfo = {
  driver: 'stripe' | 'sandbox';
  /** Why this driver — surfaced in the dashboard so nobody wonders. */
  reason: string;
  accountId?: string;
  mode?: 'live' | 'test';
};

/**
 * Which driver this workspace's links use.
 *
 * Order: the workspace's own connected Stripe account, then the deployment's key,
 * then the sandbox. A connected account always wins — it is the practice's money.
 */
export function paymentProviderFor(orgId: string): PaymentProviderInfo {
  const connected = list<Doc & { orgId?: string; provider?: string; accountId?: string; mode?: string; active?: boolean }>('paymentProviders', (p) => p.orgId === orgId && p.active !== false)[0];
  if (connected && connected.provider === 'stripe') {
    return { driver: 'stripe', reason: 'the practice connected its own Stripe account', accountId: connected.accountId, mode: (connected.mode as 'live' | 'test') ?? 'live' };
  }
  if (connected && connected.provider === 'sandbox') {
    return { driver: 'sandbox', reason: 'this workspace is set to sandbox payments' };
  }
  const key = process.env.STRIPE_SECRET_KEY;
  if (key) {
    return { driver: 'stripe', reason: 'the deployment has a Stripe key', mode: key.startsWith('sk_live') ? 'live' : 'test' };
  }
  return { driver: 'sandbox', reason: 'no payment provider is configured — links take sandbox payments' };
}

/** The secret for the driver, if it needs one. Undefined means sandbox. */
function secretFor(orgId: string): string | undefined {
  const connected = list<Doc & { orgId?: string; provider?: string; secret?: string }>('paymentProviders', (p) => p.orgId === orgId && p.provider === 'stripe' && p.active !== false)[0];
  return connected?.secret ?? process.env.STRIPE_SECRET_KEY;
}

export function stripeWebhookSecret(): string | undefined {
  return process.env.STRIPE_WEBHOOK_SECRET;
}

/* ---------------------------------------------------------------------- links */

export function linkById(orgId: string, id: string): PaymentLinkDoc | undefined {
  const row = get<PaymentLinkDoc>('paymentLinks', id);
  return row && row.orgId === orgId ? row : undefined;
}

export function linkByToken(token: string): PaymentLinkDoc | undefined {
  const wanted = String(token ?? '').trim();
  if (!wanted) return undefined;
  return list<PaymentLinkDoc>('paymentLinks', (l) => l.token === wanted)[0];
}

export function linksFor(orgId: string, opts: { invoiceId?: string; clientId?: string; status?: PaymentLinkStatus } = {}): PaymentLinkDoc[] {
  return list<PaymentLinkDoc>('paymentLinks', (l) => {
    if (l.orgId !== orgId) return false;
    if (opts.invoiceId && l.invoiceId !== opts.invoiceId) return false;
    if (opts.clientId && l.clientId !== opts.clientId) return false;
    if (opts.status && l.status !== opts.status) return false;
    return true;
  }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export type LinkWrite = { ok: true; link: PaymentLinkDoc } | { ok: false; code: 'NOT_FOUND' | 'VALIDATION_ERROR' | 'CONFLICT'; error: string; detail?: string };

/**
 * Asks for money against an invoice.
 *
 * The amount defaults to what is outstanding and may be *less* (a part payment or
 * a deposit) — never more, because a link that can take more than is owed is how
 * a practice ends up refunding its own mistake.
 */
export async function createPaymentLink(input: {
  orgId: string;
  invoiceId: string;
  amount?: number | string;
  amountMinor?: number;
  origin: string;
  actor: string;
  actorName?: string;
  note?: string;
}): Promise<LinkWrite> {
  const invoice = invoiceById(input.orgId, input.invoiceId);
  if (!invoice) return { ok: false, code: 'NOT_FOUND', error: `No invoice with id ${input.invoiceId}.` };
  if (invoice.status === 'void' || invoice.status === 'draft') {
    return {
      ok: false,
      code: 'CONFLICT',
      error: invoice.status === 'draft' ? `${invoice.id} is still a draft — issue it before asking for money.` : 'That invoice is void; there is nothing to collect.',
      detail: invoice.status,
    };
  }
  const open = balanceMinorOf(invoice);
  if (open <= 0) return { ok: false, code: 'CONFLICT', error: `${invoice.number} is settled — there is nothing left to collect.`, detail: 'settled' };
  const amountMinor = input.amountMinor !== undefined ? Math.round(Number(input.amountMinor)) : input.amount !== undefined ? toMinor(input.amount, invoice.currency) : open;
  if (amountMinor <= 0) return { ok: false, code: 'VALIDATION_ERROR', error: 'A payment link is for a positive amount.' };
  if (amountMinor > open) {
    return { ok: false, code: 'VALIDATION_ERROR', error: `${formatMoney(open, invoice.currency)} is what ${invoice.number} still owes; a link cannot ask for more.`, detail: String(open) };
  }

  const client = clientById(input.orgId, invoice.clientId);
  const provider = paymentProviderFor(input.orgId);
  const token = newId('plink_').replace('plink_', '') + newId('').slice(1, 9);
  const expiresAt = new Date(Date.now() + LINK_DAYS * 86_400_000).toISOString();
  const origin = input.origin.replace(/\/$/, '');
  const description = `${invoice.number} — ${client?.name ?? 'payment'}`;
  let url = `${origin}/pay/${token}`;
  let providerRef: string | undefined;

  if (provider.driver === 'stripe') {
    const secret = secretFor(input.orgId);
    if (!secret) return { ok: false, code: 'VALIDATION_ERROR', error: 'This workspace is set to Stripe but no secret key is configured.' };
    const session = await createCheckoutSession(secret, {
      amountMinor,
      currency: invoice.currency,
      description,
      reference: token,
      successUrl: `${origin}/pay/${token}?paid=1`,
      cancelUrl: `${origin}/pay/${token}?cancelled=1`,
      metadata: { invoiceId: invoice.id, orgId: input.orgId, token },
    });
    if (!session.ok) {
      audit({ orgId: input.orgId, actor: input.actor, action: 'payment_link.failed', target: invoice.id, detail: session.error });
      return { ok: false, code: 'VALIDATION_ERROR', error: `Stripe refused the checkout session: ${session.error}` };
    }
    providerRef = session.data.id;
    url = session.data.url ?? url;
  }

  const link = insert<PaymentLinkDoc>('paymentLinks', {
    id: newId('plink_'),
    orgId: input.orgId,
    token,
    invoiceId: invoice.id,
    clientId: invoice.clientId,
    amountMinor,
    currency: invoice.currency,
    provider: provider.driver,
    providerRef,
    url,
    description,
    status: 'open',
    createdAt: nowIso(),
    expiresAt,
    createdBy: input.actor,
    createdByName: input.actorName,
    note: input.note,
  } as PaymentLinkDoc);

  audit({
    orgId: input.orgId,
    actor: input.actor,
    action: 'payment_link.created',
    target: invoice.id,
    detail: `${formatMoney(amountMinor, invoice.currency)} via ${provider.driver}${provider.driver === 'sandbox' ? ' (no keys configured)' : ''}`,
  });
  recordAccess({ orgId: input.orgId, resource: 'invoice', resourceId: invoice.id, action: 'update', actor: input.actor, actorName: input.actorName, detail: `payment link for ${formatMoney(amountMinor, invoice.currency)} (${provider.driver})` });
  return { ok: true, link };
}

/** Marks a link as sent, so the invoice history can say how it reached the patient. */
export function markLinkSent(orgId: string, id: string, via: PaymentLinkDoc['sentVia']): PaymentLinkDoc | undefined {
  const link = linkById(orgId, id);
  if (!link) return undefined;
  return update<PaymentLinkDoc>('paymentLinks', id, { sentAt: nowIso(), sentVia: via });
}

export function cancelLink(input: { orgId: string; id: string; actor: string; reason?: string }): LinkWrite {
  const link = linkById(input.orgId, input.id);
  if (!link) return { ok: false, code: 'NOT_FOUND', error: `No payment link with id ${input.id}.` };
  if (link.status === 'paid') return { ok: false, code: 'CONFLICT', error: 'That link has been paid — refund the payment instead.' };
  const next = update<PaymentLinkDoc>('paymentLinks', input.id, { status: 'cancelled' });
  if (!next) return { ok: false, code: 'NOT_FOUND', error: `No payment link with id ${input.id}.` };
  audit({ orgId: input.orgId, actor: input.actor, action: 'payment_link.cancelled', target: link.invoiceId, detail: input.reason ?? 'cancelled' });
  return { ok: true, link: next };
}

/* ------------------------------------------------------------------ the money */

/**
 * Settles a link.
 *
 * Everything — the sandbox page, the Stripe webhook, a support person marking a
 * bank transfer as arrived — goes through here, so there is exactly one place
 * that decides a link has been paid, and exactly one payment row per link.
 */
export function settleLink(input: {
  token?: string;
  providerRef?: string;
  amountMinor?: number;
  method?: string;
  providerPaymentId?: string;
  actor: string;
  actorName?: string;
  source?: PaymentDoc['source'];
}): { ok: true; link: PaymentLinkDoc; payment: PaymentDoc } | { ok: false; code: 'NOT_FOUND' | 'CONFLICT' | 'VALIDATION_ERROR'; error: string } {
  const link = input.token ? linkByToken(input.token) : list<PaymentLinkDoc>('paymentLinks', (l) => l.providerRef === input.providerRef)[0];
  if (!link) return { ok: false, code: 'NOT_FOUND', error: 'No payment link matches that token or provider reference.' };
  if (link.status === 'paid' && link.paymentId) {
    const existing = get<PaymentDoc>('payments', String(link.paymentId));
    if (existing) return { ok: true, link, payment: existing };
  }
  if (link.status === 'cancelled') return { ok: false, code: 'CONFLICT', error: 'That payment link was cancelled.' };
  if (link.status === 'expired') return { ok: false, code: 'CONFLICT', error: 'That payment link has expired.' };
  if (new Date(link.expiresAt).getTime() < Date.now()) return { ok: false, code: 'CONFLICT', error: 'That payment link has expired.' };

  const invoice = invoiceById(link.orgId, link.invoiceId);
  if (!invoice) return { ok: false, code: 'NOT_FOUND', error: 'The invoice this link was for is gone.' };
  const open = balanceMinorOf(invoice);
  const amountMinor = Math.min(input.amountMinor ?? link.amountMinor, open > 0 ? open : link.amountMinor);
  if (amountMinor <= 0) return { ok: false, code: 'CONFLICT', error: 'There is nothing left outstanding on that invoice.' };

  const recorded = recordPayment({
    orgId: link.orgId,
    clientId: link.clientId,
    invoiceId: link.invoiceId,
    kind: 'payment',
    method: input.method ?? 'card',
    amountMinor,
    reference: link.description,
    providerRef: input.providerPaymentId ?? link.providerRef ?? link.token,
    source: input.source ?? (link.provider === 'sandbox' ? 'desk' : 'webhook'),
    actor: input.actor,
    actorName: input.actorName,
  } as never);
  if (!recorded.ok) return { ok: false, code: 'VALIDATION_ERROR', error: recorded.error };

  const next = update<PaymentLinkDoc>('paymentLinks', link.id, {
    status: 'paid',
    paidAt: nowIso(),
    paymentId: recorded.value.id,
  });
  audit({
    orgId: link.orgId,
    actor: input.actor,
    action: 'payment_link.paid',
    target: link.invoiceId,
    detail: `${formatMoney(amountMinor, link.currency)} via ${link.provider}${link.provider === 'sandbox' ? ' (sandbox — no money moved)' : ''}`,
  });
  return { ok: true, link: next ?? link, payment: recorded.value };
}

/* -------------------------------------------------------------- stripe events */

export type StripeEvent = {
  id?: string;
  type?: string;
  data?: { object?: StripeSession & { payment_status?: string; metadata?: Record<string, string>; id?: string; amount_total?: number } };
};

/**
 * Applies a Stripe webhook.
 *
 * Verified before it is read (see the route), and idempotent after: the session
 * id is matched to the link, and a link already paid returns its existing
 * payment rather than taking the money a second time. `checkout.session.completed`
 * with `payment_status: unpaid` (an async method still clearing) is *not* settled
 * — the link stays open, and the later event settles it.
 */
export async function applyStripeEvent(event: StripeEvent): Promise<{ applied: boolean; reason: string; paymentId?: string }> {
  const session = event.data?.object;
  const type = String(event.type ?? '');
  if (!session) return { applied: false, reason: 'event carried no object' };
  const link =
    list<PaymentLinkDoc>('paymentLinks', (l) => l.providerRef === session.id)[0] ??
    (session.client_reference_id ? linkByToken(String(session.client_reference_id)) : undefined);
  if (!link) return { applied: false, reason: 'no payment link for that session' };

  if (type === 'checkout.session.expired') {
    if (link.status === 'open') update<PaymentLinkDoc>('paymentLinks', link.id, { status: 'expired' });
    return { applied: true, reason: 'link expired' };
  }
  if (type !== 'checkout.session.completed' && type !== 'payment_intent.succeeded') {
    return { applied: false, reason: `nothing to do for ${type}` };
  }
  if (session.payment_status && session.payment_status !== 'paid') {
    return { applied: false, reason: `payment not cleared yet (${session.payment_status})` };
  }

  // A session completed event carries no line items; read it back for the true amount.
  let amountMinor = link.amountMinor;
  const secret = secretFor(link.orgId);
  if (secret && session.id) {
    const fresh = await getCheckoutSession(secret, session.id);
    if (fresh.ok && typeof fresh.data.amount_total === 'number') amountMinor = fresh.data.amount_total;
  }

  const settled = settleLink({
    token: link.token,
    amountMinor,
    method: 'card',
    providerPaymentId: typeof session.payment_intent === 'string' ? session.payment_intent : session.id,
    actor: 'stripe',
    actorName: 'Stripe',
    source: 'webhook',
  });
  if (!settled.ok) return { applied: false, reason: settled.error };
  return { applied: true, reason: 'settled', paymentId: settled.payment.id };
}

/* -------------------------------------------------------------------- sweeps */

/** Expires links that ran out of time. Idempotent; called from maintenance. */
export function expireLinks(now = Date.now()): number {
  const stale = list<PaymentLinkDoc>('paymentLinks', (l) => l.status === 'open' && new Date(l.expiresAt).getTime() < now);
  for (const link of stale) {
    update<PaymentLinkDoc>('paymentLinks', link.id, { status: 'expired' });
    audit({ orgId: link.orgId, actor: 'system', action: 'payment_link.expired', target: link.invoiceId, detail: link.description });
  }
  return stale.length;
}

/** The minimal facts a public payment page may show — and nothing else. */
export type PublicLinkView = {
  token: string;
  status: PaymentLinkStatus;
  amountMinor: number;
  currency: string;
  amountFormatted: string;
  description: string;
  practiceName: string;
  expiresAt: string;
  provider: 'stripe' | 'sandbox';
  paidAt?: string;
  /** True when the page can take a test payment (no provider configured). */
  sandbox: boolean;
};

export function publicLinkView(token: string): PublicLinkView | undefined {
  const link = linkByToken(token);
  if (!link) return undefined;
  const org = get<Doc & { name?: string }>('orgs', link.orgId);
  return {
    token: link.token,
    status: link.status,
    amountMinor: link.amountMinor,
    currency: link.currency,
    amountFormatted: formatMoney(link.amountMinor, link.currency),
    description: link.description,
    practiceName: org?.name ?? 'the practice',
    expiresAt: link.expiresAt,
    provider: link.provider,
    paidAt: link.paidAt,
    sandbox: link.provider === 'sandbox',
  };
}

/** Totals for the dashboard's money screen. */
export function linkStats(orgId: string) {
  const links = linksFor(orgId);
  return {
    open: links.filter((l) => l.status === 'open').length,
    paid: links.filter((l) => l.status === 'paid').length,
    expired: links.filter((l) => l.status === 'expired').length,
    openValueMinor: links.filter((l) => l.status === 'open').reduce((s, l) => s + l.amountMinor, 0),
    sent: links.filter((l) => l.sentAt).length,
    currency: moneySettingsFor(orgId).currency,
  };
}
