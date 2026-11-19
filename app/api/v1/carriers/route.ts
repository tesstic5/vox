import { NextResponse, type NextRequest } from 'next/server';
import { externalPublicOrigin, fail, ok, readJson, requireAuth, requireConfigRole } from '@/lib/server/api';
import { carrierFor, carriersFor, createCarrier, deleteCarrier, maskSid, publicCarrier, type CarrierDoc } from '@/lib/server/carriers';
import { ownedNumbers, verifyAccount } from '@/lib/server/providers/twilio';
import { get, list, update, type Doc } from '@/lib/server/db';
import { audit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /v1/carriers — connected carrier accounts, credentials masked. */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session') return fail('FORBIDDEN', 'Carrier settings require a signed-in workspace administrator.', { requestId: ctx.requestId });
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const carriers = carriersFor(ctx.orgId).map(publicCarrier);
  return ok(
    {
      object: 'list',
      data: carriers,
      total: carriers.length,
      has_more: false,
      webhookBase: externalPublicOrigin(req) ?? '',
      hint: carriers.length ? undefined : 'Connect a carrier to buy numbers and place outbound calls.',
    },
    { requestId: ctx.requestId }
  );
}

/**
 * POST /v1/carriers — connect a carrier account.
 *
 * Credentials are stored encrypted and immediately verified against the
 * carrier, so a typo is caught here rather than the first time a call fails.
 */
export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session') return fail('FORBIDDEN', 'Carrier settings require a signed-in workspace administrator.', { requestId: ctx.requestId });
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const body = await readJson<{ provider?: string; accountSid?: string; authToken?: string; label?: string }>(req);
  if (body instanceof NextResponse) return body;

  const provider = (body.provider ?? 'twilio') as CarrierDoc['provider'];
  if (provider !== 'twilio') {
    return fail('VALIDATION_ERROR', 'Only the Twilio adapter is implemented in this deployment.', { param: 'provider', requestId: ctx.requestId });
  }
  const accountSid = String(body.accountSid ?? '').trim();
  const authToken = String(body.authToken ?? '').trim();
  if (provider === 'twilio' && !/^AC[0-9a-f]{32}$/i.test(accountSid)) {
    return fail('VALIDATION_ERROR', 'A Twilio account SID starts with AC and is 34 characters long.', { param: 'accountSid', requestId: ctx.requestId });
  }
  if (!authToken) return fail('VALIDATION_ERROR', 'An auth token is required.', { param: 'authToken', requestId: ctx.requestId });

  const origin = externalPublicOrigin(req) ?? '';
  const carrier: CarrierDoc = createCarrier({
    orgId: ctx.orgId,
    provider,
    label: String(body.label ?? `${provider} account`),
    accountSid,
    authToken,
    webhookBase: origin,
  });

  // Verify immediately, and refuse to keep credentials the carrier rejects: a
  // stored-but-broken account is worse than none, because outbound calls then
  // fail one at a time instead of at connect time.
  const check = await verifyAccount(carrier);
  if (!check.ok) {
    deleteCarrier(ctx.orgId, carrier.id);
    audit({ orgId: ctx.orgId, actor: 'dashboard', action: 'carrier.rejected', detail: `${provider} ${maskSid(accountSid)} — ${check.error}` });
    return fail('VALIDATION_ERROR', `The carrier rejected these credentials: ${check.error}`, {
      param: 'authToken',
      requestId: ctx.requestId,
    });
  }

  update<CarrierDoc>('carriers', carrier.id, {
    verified: true,
    verifiedAt: new Date().toISOString(),
    verifiedAccountName: check.data.name,
    balance: check.data.balance,
    capabilities: ['voice', 'sms', 'status-callback'],
  });

  const fresh: CarrierDoc = carrierFor(ctx.orgId, provider) ?? carrier;

  // Recover rows stranded by an interrupted/older disconnect only when these
  // freshly verified credentials prove the same carrier account still owns the
  // exact SID + E.164 pair. This restores signature verification and gives the
  // owner a safe release/detach path without trusting stale local metadata.
  let relinkedNumbers = 0;
  const inventory = await ownedNumbers(fresh);
  if (inventory.ok) {
    const owned = new Set(inventory.data.map((row) => `${row.sid}:${row.phone_number}`));
    const orphans = list<Doc & { carrierId?: string; carrierSid?: string; number?: string; provider?: string; status?: string }>(
      'numbers',
      (row) =>
        row.orgId === ctx.orgId &&
        row.provider === provider &&
        Boolean(row.carrierSid && row.number) &&
        row.status !== 'released' &&
        (!row.carrierId || !get<CarrierDoc>('carriers', row.carrierId))
    );
    for (const row of orphans) {
      if (!owned.has(`${row.carrierSid}:${row.number}`)) continue;
      update('numbers', row.id, { carrierId: fresh.id, status: 'active', relinkedAt: new Date().toISOString() });
      relinkedNumbers += 1;
      audit({ orgId: ctx.orgId, actor: 'dashboard', action: 'number.carrier_relinked', target: row.id, detail: String(row.number ?? '') });
    }
  }

  return ok(
    {
      ...publicCarrier(fresh),
      verification: { ok: true, accountName: check.data.name, status: check.data.status, balance: check.data.balance },
      relinkedNumbers,
    },
    { requestId: ctx.requestId, status: 201 }
  );
}

/** Legacy query-form disconnect; it enforces the same detach-first rule as /{id}. */
export async function DELETE(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session') return fail('FORBIDDEN', 'Carrier settings require a signed-in workspace administrator.', { requestId: ctx.requestId });
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const id = new URL(req.url).searchParams.get('id') ?? '';
  const carrier = get<CarrierDoc>('carriers', id);
  if (!carrier || carrier.orgId !== ctx.orgId) return fail('NOT_FOUND', `No carrier with id ${id}.`, { requestId: ctx.requestId });
  const linked = list<Doc>('numbers', (row) => row.orgId === ctx.orgId && row.carrierId === id);
  if (linked.length) {
    return fail('CONFLICT', `This carrier still has ${linked.length} workspace number(s). Release or detach them before disconnecting.`, {
      param: 'id',
      detail: linked.slice(0, 10).map((row) => String(row.number ?? row.id)).join(', '),
      requestId: ctx.requestId,
    });
  }
  const doc = deleteCarrier(ctx.orgId, id);
  if (!doc) return fail('NOT_FOUND', `No carrier with id ${id}.`, { requestId: ctx.requestId });
  return ok({ id, disconnected: true, numbersKept: 0 }, { requestId: ctx.requestId });
}
