/**
 * Minimal Stripe Checkout API stub used by the provider acceptance gate.
 *
 *   npx tsx scripts/stripe-stub.ts
 *   STRIPE_API_BASE=http://127.0.0.1:4030 STRIPE_SECRET_KEY=sk_test_stub ...
 *
 * It deliberately models only what Voxera uses: creating and reading Checkout
 * Sessions. Test-only control endpoints expose state and move a session from
 * unpaid to paid; the acceptance gate still has to sign and post Stripe's
 * webhook itself, so settlement is exercised through the real ingress route.
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.STRIPE_STUB_PORT ?? 4030);
const SECRET = process.env.STRIPE_STUB_KEY ?? 'sk_test_stub';

type Session = {
  id: string;
  object: 'checkout.session';
  url: string;
  amount_total: number;
  currency: string;
  payment_status: 'unpaid' | 'paid';
  status: 'open' | 'complete' | 'expired';
  client_reference_id: string;
  metadata: Record<string, string>;
  payment_intent: string;
  success_url: string;
  cancel_url: string;
  mode: string;
};

const sessions = new Map<string, Session>();
const requests: Array<{ method: string; path: string; authorization: string; form?: Record<string, string> }> = [];
let sequence = 0;
let failCreates = 0;

function json(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function stripeError(res: import('node:http').ServerResponse, status: number, message: string, code: string) {
  json(res, status, { error: { type: 'invalid_request_error', message, code } });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const chunks: Buffer[] = [];
  req.on('data', (chunk) => chunks.push(chunk as Buffer));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');

    if (url.pathname === '/__reset') {
      sessions.clear();
      requests.length = 0;
      sequence = 0;
      failCreates = 0;
      return json(res, 200, { reset: true });
    }
    if (url.pathname === '/__state') {
      return json(res, 200, { sessions: [...sessions.values()], requests, failCreates });
    }
    if (url.pathname === '/__control' && req.method === 'POST') {
      let control: { failCreates?: number; sessionId?: string; paymentStatus?: 'paid' | 'unpaid'; status?: Session['status'] };
      try {
        control = JSON.parse(body || '{}') as typeof control;
      } catch {
        return json(res, 400, { error: 'invalid JSON' });
      }
      if (control.failCreates !== undefined) failCreates = Math.max(0, Math.floor(Number(control.failCreates) || 0));
      if (control.sessionId) {
        const session = sessions.get(control.sessionId);
        if (!session) return json(res, 404, { error: 'session not found' });
        if (control.paymentStatus) session.payment_status = control.paymentStatus;
        if (control.status) session.status = control.status;
      }
      return json(res, 200, { failCreates, session: control.sessionId ? sessions.get(control.sessionId) : undefined });
    }

    const authorization = String(req.headers.authorization ?? '');
    if (authorization !== `Bearer ${SECRET}`) {
      return stripeError(res, 401, 'Invalid API Key provided', 'api_key_invalid');
    }

    if (url.pathname === '/v1/checkout/sessions' && req.method === 'POST') {
      const form = Object.fromEntries(new URLSearchParams(body));
      requests.push({ method: 'POST', path: url.pathname, authorization, form });
      if (failCreates > 0) {
        failCreates -= 1;
        return stripeError(res, 503, 'Injected checkout-session failure', 'api_connection_error');
      }
      const amount = Number(form['line_items[0][price_data][unit_amount]']);
      const currency = String(form['line_items[0][price_data][currency]'] ?? '').toLowerCase();
      if (!Number.isInteger(amount) || amount <= 0) return stripeError(res, 400, 'Invalid integer: unit_amount', 'parameter_invalid_integer');
      if (!currency) return stripeError(res, 400, 'Missing required param: currency', 'parameter_missing');
      const id = `cs_test_stub_${String(++sequence).padStart(6, '0')}`;
      const metadata = Object.fromEntries(
        Object.entries(form)
          .filter(([key]) => /^metadata\[[^\]]+\]$/.test(key))
          .map(([key, value]) => [key.slice(9, -1), value])
      );
      const session: Session = {
        id,
        object: 'checkout.session',
        url: `http://127.0.0.1:${PORT}/checkout/${id}`,
        amount_total: amount,
        currency,
        payment_status: 'unpaid',
        status: 'open',
        client_reference_id: String(form.client_reference_id ?? ''),
        metadata,
        payment_intent: `pi_test_stub_${String(sequence).padStart(6, '0')}`,
        success_url: String(form.success_url ?? ''),
        cancel_url: String(form.cancel_url ?? ''),
        mode: String(form.mode ?? ''),
      };
      sessions.set(id, session);
      return json(res, 200, session);
    }

    const match = url.pathname.match(/^\/v1\/checkout\/sessions\/([^/]+)$/);
    if (match && req.method === 'GET') {
      requests.push({ method: 'GET', path: url.pathname, authorization });
      const session = sessions.get(decodeURIComponent(match[1]));
      if (!session) return stripeError(res, 404, 'No such checkout.session', 'resource_missing');
      return json(res, 200, session);
    }

    return stripeError(res, 404, `No stub route for ${req.method} ${url.pathname}`, 'resource_missing');
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`stripe stub listening on http://127.0.0.1:${PORT} (key ${SECRET})`);
});
