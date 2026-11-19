import { NextResponse, type NextRequest } from 'next/server';
import { externalPublicOrigin, fail, ok, readJson, requireAuth, requireConfigRole, requireVerifiedEmail } from '@/lib/server/api';
import { get, insert, list, newId, nowIso, type Doc } from '@/lib/server/db';
import { searchNumbers, ownedNumbers, configureNumber } from '@/lib/server/providers/twilio';
import type { CarrierDoc } from '@/lib/server/carriers';
import { audit } from '@/lib/server/audit';
import { numberClaimConflict, releaseNumberReservation, reserveNumberClaim } from '@/lib/server/number-ownership';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET  /v1/carriers/{id}/numbers — search the carrier's inventory.
 * POST /v1/carriers/{id}/numbers — adopt a number you already own.
 *
 * Adopting re-points the carrier's voice webhooks at this deployment, replacing
 * the previous inbound routing. The number stays on the customer's account, but
 * this operation does change how new calls and messages are delivered.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session') return fail('FORBIDDEN', 'Carrier inventory requires a signed-in workspace administrator.', { requestId: ctx.requestId });
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const carrier = get<CarrierDoc>('carriers', id);
  if (!carrier || carrier.orgId !== ctx.orgId) return fail('NOT_FOUND', `No carrier with id ${id}.`, { requestId: ctx.requestId });

  const url = new URL(req.url);
  const mode = url.searchParams.get('mode') ?? 'available';
  if (!['available', 'owned'].includes(mode)) {
    return fail('VALIDATION_ERROR', '`mode` must be available or owned.', { param: 'mode', requestId: ctx.requestId });
  }
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 10) || 10, 1), 30);

  if (mode === 'owned') {
    const owned = await ownedNumbers(carrier);
    if (!owned.ok) return fail('INTERNAL_ERROR', owned.error, { requestId: ctx.requestId });
    return ok(
      {
        mode: 'owned',
        data: owned.data.map((n) => ({
          sid: n.sid,
          number: n.phone_number,
          label: n.friendly_name,
          locality: n.locality,
          voiceUrl: n.voice_url,
          statusCallback: n.status_callback,
          // Only a live carrier-backed SID/number claim counts as adopted. Demo
          // or quarantined legacy rows with the same display number do not.
          adopted: list<Doc>('numbers', (d) =>
            d.orgId === ctx.orgId &&
            d.number === n.phone_number &&
            d.carrierSid === n.sid &&
            d.status !== 'released'
          ).length > 0,
        })),
      },
      { requestId: ctx.requestId }
    );
  }

  const available = await searchNumbers(carrier, {
    country: url.searchParams.get('country') ?? 'US',
    areaCode: url.searchParams.get('areaCode') ?? undefined,
    contains: url.searchParams.get('contains') ?? undefined,
    limit,
  });
  if (!available.ok) return fail('INTERNAL_ERROR', available.error, { requestId: ctx.requestId });
  return ok(
    {
      mode: 'available',
      data: available.data.map((n) => ({
        number: n.phone_number,
        locality: n.locality,
        region: n.region,
        country: n.iso_country,
        voice: Boolean(n.capabilities?.voice),
        monthlyCost: n.monthly_cost ?? null,
      })),
    },
    { requestId: ctx.requestId }
  );
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session') return fail('FORBIDDEN', 'Adopting a number requires a signed-in workspace administrator.', { requestId: ctx.requestId });
  const denied = requireConfigRole(ctx) ?? requireVerifiedEmail(ctx);
  if (denied) return denied;
  const carrier = get<CarrierDoc>('carriers', id);
  if (!carrier || carrier.orgId !== ctx.orgId) return fail('NOT_FOUND', `No carrier with id ${id}.`, { requestId: ctx.requestId });

  const body = await readJson<{ number?: string; sid?: string; label?: string; assistantId?: string }>(req);
  if (body instanceof NextResponse) return body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail('VALIDATION_ERROR', 'Request body must be an object.', { param: 'body', requestId: ctx.requestId });
  }
  const unknown = Object.keys(body).find((key) => !['number', 'sid', 'label', 'assistantId'].includes(key));
  if (unknown) return fail('VALIDATION_ERROR', `\`${unknown}\` is not supported.`, { param: unknown, requestId: ctx.requestId });
  const number = String(body.number ?? '').replace(/[^\d+]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(number)) {
    return fail('VALIDATION_ERROR', 'Send the `number` in E.164 format.', { param: 'number', requestId: ctx.requestId });
  }
  if (numberClaimConflict(number, ctx.orgId)) {
    return fail('CONFLICT', 'That phone number is already claimed by a workspace on this deployment.', { param: 'number', requestId: ctx.requestId });
  }
  if (body.assistantId && !list<Doc>('assistants', (assistant) => assistant.orgId === ctx.orgId && assistant.id === body.assistantId).length) {
    return fail('VALIDATION_ERROR', `No assistant with id ${body.assistantId} in this workspace.`, { param: 'assistantId', requestId: ctx.requestId });
  }
  const owned = await ownedNumbers(carrier);
  if (!owned.ok) return fail('VALIDATION_ERROR', `The carrier could not confirm ownership: ${owned.error}`, { requestId: ctx.requestId });
  const carrierNumber = owned.data.find((entry) => entry.sid === body.sid && entry.phone_number === number);
  if (!carrierNumber) {
    return fail('VALIDATION_ERROR', 'That SID and number are not a matching number on this carrier account.', { param: 'sid', requestId: ctx.requestId });
  }

  const origin = externalPublicOrigin(req);
  if (!origin) {
    return fail('CONFLICT', 'A valid HTTPS VOXERA_PUBLIC_URL is required before a production carrier can be programmed.', { requestId: ctx.requestId });
  }
  const reserved = reserveNumberClaim({ number, orgId: ctx.orgId, carrierId: carrier.id, operation: 'adopt' });
  if (!reserved.ok) {
    return fail('CONFLICT', 'That phone number is already claimed or is being claimed by a workspace on this deployment.', {
      param: 'number',
      requestId: ctx.requestId,
    });
  }
  const reservation = reserved.reservation;
  const wiring = await configureNumber(carrier, carrierNumber.sid, {
    voiceUrl: `${origin}/api/telephony/twilio/voice`,
    statusCallback: `${origin}/api/telephony/twilio/status`,
    smsUrl: `${origin}/api/telephony/twilio/inbound-message`,
  });
  if (!wiring.ok) {
    releaseNumberReservation(reservation);
    return fail('VALIDATION_ERROR', `The carrier refused to re-point the number: ${wiring.error}`, { requestId: ctx.requestId });
  }

  const previousCarrierConfig = {
    voiceUrl: carrierNumber.voice_url ?? '',
    statusCallback: carrierNumber.status_callback ?? '',
    smsUrl: carrierNumber.sms_url ?? '',
  };
  const restorePreviousWiring = () => configureNumber(carrier, carrierNumber.sid, previousCarrierConfig);
  const quotedMonthly = Number(carrierNumber.monthly_cost);
  const hasMonthlyQuote = Number.isFinite(quotedMonthly) && quotedMonthly >= 0;
  let record: Doc;
  try {
    record = insert<Doc>('numbers', {
      id: newId('num_'),
      orgId: ctx.orgId,
      number,
      label: String(body.label ?? carrierNumber.friendly_name ?? 'Adopted number').trim().slice(0, 120),
      provider: carrier.provider,
      carrierId: carrier.id,
      carrierSid: carrierNumber.sid,
      assistantId: body.assistantId ?? null,
      country: carrierNumber.iso_country || undefined,
      status: 'active',
      imported: true,
      previousCarrierConfig,
      ...(hasMonthlyQuote ? { monthlyCost: quotedMonthly, monthlyCostSource: 'carrier_response' } : {}),
      inboundCalls30d: 0,
      webhooks: { voiceUrl: `${origin}/api/telephony/twilio/voice`, statusCallback: `${origin}/api/telephony/twilio/status` },
      createdAt: nowIso(),
    } as Doc);
  } catch (error) {
    const rollback = await restorePreviousWiring();
    releaseNumberReservation(reservation);
    audit({
      orgId: ctx.orgId,
      actor: 'dashboard',
      action: 'number.adoption_persistence_failed',
      detail: `${number} (${carrierNumber.sid}) — ${error instanceof Error ? error.message.slice(0, 160) : 'local write failed'}; wiring rollback ${rollback.ok ? 'succeeded' : `failed: ${rollback.error}`}`,
    });
    return fail('INTERNAL_ERROR', rollback.ok
      ? 'The local record could not be saved, so the number\'s previous carrier routing was restored.'
      : 'The local record could not be saved and the previous carrier routing could not be restored. Reconcile this number in the carrier console.', {
      requestId: ctx.requestId,
    });
  }

  releaseNumberReservation(reservation);
  audit({ orgId: ctx.orgId, actor: 'dashboard', action: 'number.adopted', target: String(record.id), detail: `${number} via ${carrier.provider}` });
  return ok({ number: record, wiring: { voiceUrl: `${origin}/api/telephony/twilio/voice`, statusCallback: `${origin}/api/telephony/twilio/status` } }, { requestId: ctx.requestId, status: 201 });
}
