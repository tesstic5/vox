import { NextResponse, type NextRequest } from 'next/server';
import { externalPublicOrigin, fail, ok, readJson, requireAuth, requireVerifiedEmail } from '@/lib/server/api';
import { createCall } from '@/lib/server/calls';
import { audit } from '@/lib/server/audit';
import { list, update, type Doc } from '@/lib/server/db';
import { MANAGED_CARRIER_ID, dialerFor } from '@/lib/server/managed';
import { placeCall } from '@/lib/server/providers/twilio';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Submits an outbound call through the carrier linked to the selected workspace
 * number. Preflight refuses the request before creating a call record when the
 * number, carrier, assistant, or production callback origin is unavailable.
 * Carrier acceptance is recorded separately from later ringing/answer webhooks.
 */
export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['calls:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const unverified = requireVerifiedEmail(ctx);
  if (unverified) return unverified;
  const body = await readJson<{ assistantId?: string; to?: string; numberId?: string; customerName?: string }>(req);
  if (body instanceof NextResponse) return body;

  const to = String(body.to ?? '').replace(/[^\d+]/g, '');
  if (!/^\+\d{7,15}$/.test(to)) {
    return fail('VALIDATION_ERROR', 'Send `to` in E.164 format, e.g. +14155550123.', { param: 'to', requestId: ctx.requestId });
  }
  type OutboundNumber = Doc & { number?: string; assistantId?: string | null; carrierId?: string; status?: string };
  const candidates = list<OutboundNumber>('numbers', (n) =>
    n.orgId === ctx.orgId &&
    n.status !== 'released' &&
    typeof n.carrierId === 'string' &&
    /^\+[1-9]\d{7,14}$/.test(String(n.number ?? ''))
  );
  const requestedAssistant = String(body.assistantId ?? '');
  const number = body.numberId
    ? candidates.find((entry) => entry.id === body.numberId)
    : candidates.find((entry) => requestedAssistant && entry.assistantId === requestedAssistant) ?? candidates[0];
  if (!number) {
    return fail('CONFLICT', 'No active carrier-backed workspace number is available as caller ID.', { param: 'numberId', requestId: ctx.requestId });
  }

  const assistantId = String(body.assistantId ?? number.assistantId ?? '');
  if (!assistantId) return fail('VALIDATION_ERROR', 'No assistant to speak — assign one to the number or pass `assistantId`.', { param: 'assistantId', requestId: ctx.requestId });
  const carrier = dialerFor(ctx.orgId, number.carrierId);
  if (!carrier) {
    return fail('CONFLICT', 'The selected number has no connected carrier account, so no call was created.', { param: 'numberId', requestId: ctx.requestId });
  }
  const origin = externalPublicOrigin(req);
  if (!origin) {
    return fail('CONFLICT', 'A valid HTTPS VOXERA_PUBLIC_URL is required before a production carrier call can be placed.', { requestId: ctx.requestId });
  }

  const { call, error } = createCall({
    orgId: ctx.orgId,
    assistantId,
    type: 'outbound',
    from: String(number.number),
    to,
    numberId: String(number.id),
    customer: { name: String(body.customerName ?? 'Outbound contact').trim().slice(0, 160), number: to },
    source: 'api',
  });
  if (error || !call) return fail('VALIDATION_ERROR', error ?? 'Could not create the call.', { requestId: ctx.requestId });

  const dialled = await placeCall(carrier, {
    to,
    from: String(number.number),
    voiceUrl: `${origin}/api/telephony/twilio/voice`,
    statusCallback: `${origin}/api/telephony/twilio/status`,
    machineDetection: true,
    // Recording requires a separate, explicit consent-aware policy. An old
    // number flag is not evidence that this recipient consented to this call.
    record: false,
  });

  if (!dialled.ok) {
    audit({ orgId: ctx.orgId, actor: 'api', action: 'call.dial_failed', target: call.id, detail: dialled.error.slice(0, 200) });
    const failed = update<Doc>('calls', call.id, {
      status: 'failed',
      endedReason: 'error',
      telephony: { provider: carrier.provider, carrierCallId: '', direction: 'outbound', error: dialled.error.slice(0, 200) },
    });
    return ok({ ...(failed ?? call), dialled: false, reason: 'carrier_error', detail: dialled.error }, { requestId: ctx.requestId, status: 201 });
  }

  // Link the carrier's call SID to our record so signed webhooks can find it.
  const { rememberCarrierCall } = await import('@/lib/server/telephony');
  rememberCarrierCall(dialled.data.sid, call.id, ctx.orgId);
  const accepted = update<Doc>('calls', call.id, {
    telephony: { provider: carrier.provider, carrierCallId: dialled.data.sid, providerAcceptedAt: new Date().toISOString(), direction: 'outbound' },
  });

  audit({ orgId: ctx.orgId, actor: 'api', action: 'call.submitted_to_carrier', target: call.id, detail: `${to} via ${carrier.provider} ${dialled.data.sid}` });
  return ok(
    {
      ...(accepted ?? call),
      dialled: true,
      providerAccepted: true,
      // Which account accepted the request: a deployment-managed carrier or
      // the workspace's own connected account.
      via: carrier.id === MANAGED_CARRIER_ID ? 'managed' : 'workspace',
      carrier: { provider: carrier.provider, sid: dialled.data.sid, status: dialled.data.status },
    },
    { requestId: ctx.requestId, status: 201 }
  );
}
