/**
 * Stripe REST client — the small part of it a practice actually needs.
 *
 * Create a Checkout Session for an invoice; read it back; verify a webhook's
 * signature. Deliberately thin, and `STRIPE_API_BASE` is overridable so the whole
 * flow runs against a stub (which is how it is verified) and against the real
 * Stripe by simply not setting it — the same trick the carrier client uses.
 */

export const DEFAULT_STRIPE_BASE = 'https://api.stripe.com';

export function stripeBaseUrl() {
  return (process.env.STRIPE_API_BASE ?? DEFAULT_STRIPE_BASE).replace(/\/$/, '');
}

export type StripeResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string; code?: string };

async function request<T>(
  secretKey: string,
  method: 'GET' | 'POST',
  path: string,
  form?: Record<string, string>
): Promise<StripeResult<T>> {
  try {
    const res = await fetch(`${stripeBaseUrl()}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${secretKey}`,
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      const error = json.error as { message?: string; code?: string } | undefined;
      return { ok: false, status: res.status, error: error?.message ?? `Stripe returned ${res.status}`, code: error?.code };
    }
    return { ok: true, data: json as T };
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? `Stripe unreachable: ${error.message}` : 'Stripe unreachable' };
  }
}

export type StripeSession = {
  id: string;
  url?: string;
  amount_total?: number;
  currency?: string;
  payment_status?: string;
  client_reference_id?: string;
  metadata?: Record<string, string>;
  payment_intent?: string;
};

/** A hosted checkout page for one invoice. Stripe is sent minor units, like us. */
export async function createCheckoutSession(
  secretKey: string,
  input: {
    amountMinor: number;
    currency: string;
    description: string;
    reference: string;
    successUrl: string;
    cancelUrl: string;
    metadata?: Record<string, string>;
  }
): Promise<StripeResult<StripeSession>> {
  const form: Record<string, string> = {
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': input.currency.toLowerCase(),
    'line_items[0][price_data][unit_amount]': String(input.amountMinor),
    'line_items[0][price_data][product_data][name]': input.description.slice(0, 120),
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    client_reference_id: input.reference,
  };
  for (const [key, value] of Object.entries(input.metadata ?? {})) form[`metadata[${key}]`] = value;
  return request<StripeSession>(secretKey, 'POST', '/v1/checkout/sessions', form);
}

export async function getCheckoutSession(secretKey: string, id: string): Promise<StripeResult<StripeSession>> {
  return request<StripeSession>(secretKey, 'GET', `/v1/checkout/sessions/${id}`);
}

/**
 * Verifies a webhook signature the way Stripe specifies it: HMAC-SHA256 over
 * `timestamp.payload`, compared in constant time, with a replay window. Anything
 * that fails these returns false, and an unsigned event is never applied.
 */
export function verifySignature(input: { payload: string; header?: string; secret: string; toleranceSeconds?: number }): boolean {
  const header = String(input.header ?? '');
  const parts = Object.fromEntries(header.split(',').map((chunk) => chunk.split('=') as [string, string]));
  const timestamp = Number(parts.t ?? 0);
  const signature = parts.v1;
  if (!timestamp || !signature) return false;
  const tolerance = (input.toleranceSeconds ?? 300) * 1000;
  if (Math.abs(Date.now() - timestamp * 1000) > tolerance) return false;
  const crypto = require('node:crypto') as typeof import('node:crypto');
  const expected = crypto.createHmac('sha256', input.secret).update(`${timestamp}.${input.payload}`).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
