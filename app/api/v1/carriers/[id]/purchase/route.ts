import { NextResponse, type NextRequest } from 'next/server';
import { externalPublicOrigin, fail, ok, readJson, requireAuth, requireConfigRole, requireVerifiedEmail } from '@/lib/server/api';
import { get, insert, list, newId, nowIso, type Doc } from '@/lib/server/db';
import { buyNumber, releaseNumber } from '@/lib/server/providers/twilio';
import type { CarrierDoc } from '@/lib/server/carriers';
import { audit } from '@/lib/server/audit';
import { numberClaimConflict, releaseNumberReservation, reserveNumberClaim } from '@/lib/server/number-ownership';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /v1/carriers/{id}/purchase — buy a number and point it at the agent.
 *
 * The purchase and the webhook wiring happen in one carrier call, so a number
 * that lands in the workspace is already answering with the assigned assistant —
 * there is no window where the number exists but does nothing.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session') return fail('FORBIDDEN', 'Buying a number requires a signed-in workspace administrator.', { requestId: ctx.requestId });
  const denied = requireConfigRole(ctx) ?? requireVerifiedEmail(ctx);
  if (denied) return denied;
  const carrier = get<CarrierDoc>('carriers', id);
  if (!carrier || carrier.orgId !== ctx.orgId) return fail('NOT_FOUND', `No carrier with id ${id}.`, { requestId: ctx.requestId });
  if (!carrier.verified) {
    return fail('CONFLICT', 'Verify the carrier credentials before buying numbers.', { requestId: ctx.requestId });
  }

  const body = await readJson<{ number?: string; label?: string; assistantId?: string; country?: string }>(req);
  if (body instanceof NextResponse) return body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail('VALIDATION_ERROR', 'Request body must be an object.', { param: 'body', requestId: ctx.requestId });
  }
  const unknown = Object.keys(body).find((key) => !['number', 'label', 'assistantId', 'country'].includes(key));
  if (unknown) return fail('VALIDATION_ERROR', `\`${unknown}\` is not supported.`, { param: unknown, requestId: ctx.requestId });
  const number = String(body.number ?? '').replace(/[^\d+]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(number)) {
    return fail('VALIDATION_ERROR', 'Send the `number` to buy in E.164 format.', { param: 'number', requestId: ctx.requestId });
  }
  if (numberClaimConflict(number, ctx.orgId)) {
    return fail('CONFLICT', 'That phone number is already claimed by a workspace on this deployment.', { param: 'number', requestId: ctx.requestId });
  }
  if (body.assistantId && !list<Doc>('assistants', (assistant) => assistant.orgId === ctx.orgId && assistant.id === body.assistantId).length) {
    return fail('VALIDATION_ERROR', `No assistant with id ${body.assistantId} in this workspace.`, { param: 'assistantId', requestId: ctx.requestId });
  }

  const origin = externalPublicOrigin(req);
  if (!origin) {
    return fail('CONFLICT', 'A valid HTTPS VOXERA_PUBLIC_URL is required before a production carrier can be programmed.', { requestId: ctx.requestId });
  }
  const voiceUrl = `${origin}/api/telephony/twilio/voice`;
  const statusCallback = `${origin}/api/telephony/twilio/status`;
  // Replies come back here, so a STOP reaches the workspace that sent the text.
  const smsUrl = `${origin}/api/telephony/twilio/inbound-message`;

  const reserved = reserveNumberClaim({ number, orgId: ctx.orgId, carrierId: carrier.id, operation: 'purchase' });
  if (!reserved.ok) {
    return fail('CONFLICT', 'That phone number is already claimed or is being claimed by a workspace on this deployment.', {
      param: 'number',
      requestId: ctx.requestId,
    });
  }
  const reservation = reserved.reservation;
  const purchase = await buyNumber(carrier, {
    phoneNumber: number,
    label: body.label ?? 'Voxera line',
    voiceUrl,
    statusCallback,
    smsUrl,
  });
  if (!purchase.ok) {
    releaseNumberReservation(reservation);
    audit({ orgId: ctx.orgId, actor: 'dashboard', action: 'number.purchase_failed', detail: `${number} — ${purchase.error}` });
    return fail('VALIDATION_ERROR', `The carrier refused the purchase: ${purchase.error}`, { requestId: ctx.requestId });
  }

  const quotedMonthly = Number(purchase.data.monthly_cost);
  const hasMonthlyQuote = Number.isFinite(quotedMonthly) && quotedMonthly >= 0;
  let record: Doc;
  try {
    record = insert<Doc>('numbers', {
      id: newId('num_'),
      orgId: ctx.orgId,
      number,
      label: String(body.label ?? 'Voxera line').trim().slice(0, 120),
      provider: carrier.provider,
      carrierId: carrier.id,
      carrierSid: purchase.data.sid,
      assistantId: body.assistantId ?? null,
      status: 'active',
      ...(hasMonthlyQuote ? { monthlyCost: quotedMonthly, monthlyCostSource: 'carrier_response' } : {}),
      inboundCalls30d: 0,
      webhooks: { voiceUrl, statusCallback },
      carrierCost: purchase.data.monthly_cost ?? null,
      createdAt: nowIso(),
    } as Doc);
  } catch (error) {
    const rollback = await releaseNumber(carrier, purchase.data.sid);
    releaseNumberReservation(reservation);
    audit({
      orgId: ctx.orgId,
      actor: 'dashboard',
      action: 'number.purchase_persistence_failed',
      detail: `${number} (${purchase.data.sid}) — ${error instanceof Error ? error.message.slice(0, 160) : 'local write failed'}; carrier rollback ${rollback.ok ? 'succeeded' : `failed: ${rollback.error}`}`,
    });
    return fail('INTERNAL_ERROR', rollback.ok
      ? 'The local record could not be saved, so the carrier purchase was rolled back.'
      : 'The local record could not be saved and the carrier rollback failed. Reconcile this number in the carrier console.', {
      requestId: ctx.requestId,
    });
  }

  releaseNumberReservation(reservation);
  audit({ orgId: ctx.orgId, actor: 'dashboard', action: 'number.purchased', target: String(record.id), detail: `${number} (${purchase.data.sid})` });
  return ok(
    {
      number: record,
      carrier: { sid: purchase.data.sid, friendlyName: purchase.data.friendly_name, status: purchase.data.status },
      wiring: { voiceUrl, statusCallback },
      // A number with no assistant answers politely and hangs up — say so.
      warning: body.assistantId ? undefined : 'Assign an assistant to this number, or inbound calls will hear the fallback message.',
    },
    { requestId: ctx.requestId, status: 201 }
  );
}

/** GET reports what the carrier holds, so the dashboard can reconcile. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session') return fail('FORBIDDEN', 'Carrier settings require a signed-in workspace administrator.', { requestId: ctx.requestId });
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const carrier = get<CarrierDoc>('carriers', id);
  if (!carrier || carrier.orgId !== ctx.orgId) return fail('NOT_FOUND', `No carrier with id ${id}.`, { requestId: ctx.requestId });
  const local = list<Doc>('numbers', (n) => n.orgId === ctx.orgId && n.carrierId === carrier.id);
  return ok({ carrierId: carrier.id, local: local.map((n) => ({ id: n.id, number: n.number, carrierSid: n.carrierSid, webhooks: n.webhooks })) }, { requestId: ctx.requestId });
}
