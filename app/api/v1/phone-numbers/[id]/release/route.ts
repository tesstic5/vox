import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireConfigRole } from '@/lib/server/api';
import { get, remove, update, type Doc } from '@/lib/server/db';
import { configureNumber, ownedNumbers, releaseNumber as releaseAtCarrier } from '@/lib/server/providers/twilio';
import type { CarrierDoc } from '@/lib/server/carriers';
import { audit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /v1/phone-numbers/{id}/release — give a number up properly.
 *
 * There are two different things a customer might mean, so they are two
 * different calls: detaching restores the pre-adoption routing (or clears this
 * deployment's callbacks for a purchased line) while ownership stays at the
 * carrier; releasing asks the carrier to give up the number.
 *
 * Releasing at the carrier is attempted first: if the carrier refuses, nothing
 * local is deleted, so the workspace never ends up believing it has released a
 * number it is still paying for.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['numbers:write'] });
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session') return fail('FORBIDDEN', 'Releasing a number requires a signed-in workspace administrator.', { requestId: ctx.requestId });
  const denied = requireConfigRole(ctx);
  if (denied) return denied;

  const number = get<Doc & {
    orgId: string;
    number?: string;
    carrierId?: string;
    carrierSid?: string;
    label?: string;
    imported?: boolean;
    previousCarrierConfig?: { voiceUrl?: string; statusCallback?: string; smsUrl?: string };
  }>('numbers', id);
  if (!number || number.orgId !== ctx.orgId) return fail('NOT_FOUND', `No number with id ${id}.`, { requestId: ctx.requestId });

  const body = await readJson<{ atCarrier?: boolean; force?: boolean }>(req);
  if (body instanceof NextResponse) return body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail('VALIDATION_ERROR', 'Request body must be an object.', { param: 'body', requestId: ctx.requestId });
  }
  const unknown = Object.keys(body).find((key) => !['atCarrier', 'force'].includes(key));
  if (unknown) return fail('VALIDATION_ERROR', `\`${unknown}\` is not accepted.`, { param: unknown, requestId: ctx.requestId });
  if (body.force) {
    return fail('VALIDATION_ERROR', 'Forced local removal is not available for carrier-backed numbers. Reconcile the carrier link first.', {
      param: 'force',
      requestId: ctx.requestId,
    });
  }
  const atCarrier = body.atCarrier !== false;

  let carrierResult: { attempted: boolean; released: boolean; detached?: boolean; restoredPrevious?: boolean; reconciledMissing?: boolean; error?: string } = { attempted: false, released: false };
  const carrier = number.carrierId ? get<CarrierDoc>('carriers', number.carrierId) : undefined;

  if (number.carrierId || number.carrierSid) {
    if (!number.carrierSid || !carrier || carrier.orgId !== ctx.orgId) {
      return fail('CONFLICT', atCarrier
        ? 'The carrier release cannot be verified. Reconnect the carrier before releasing this number.'
        : 'The carrier routing cannot be detached safely. Reconnect the carrier first.', {
        param: 'atCarrier',
        detail: 'carrier_link_unavailable',
        requestId: ctx.requestId,
      });
    }

    if (atCarrier) {
      const res = await releaseAtCarrier(carrier, number.carrierSid);
      carrierResult = res.ok
        ? { attempted: true, released: true }
        : { attempted: true, released: false, error: res.error };
      if (!res.ok) {
        // A provider-side deletion or a previous half-finished release returns a
        // missing-resource error. Confirm against the owned inventory before
        // removing the stale local claim; never infer success from the error.
        const owned = await ownedNumbers(carrier);
        const stillOwned = owned.ok && owned.data.some((row) =>
          row.sid === number.carrierSid || row.phone_number === number.number
        );
        if (owned.ok && !stillOwned) {
          carrierResult = { attempted: true, released: true, reconciledMissing: true };
          audit({ orgId: ctx.orgId, actor: 'dashboard', action: 'number.release_reconciled', target: id, detail: `${number.number} was already absent at the carrier` });
        } else {
          audit({ orgId: ctx.orgId, actor: 'dashboard', action: 'number.release_failed', target: id, detail: `${number.number} — ${res.error}` });
          return fail('VALIDATION_ERROR', `The carrier would not release this number: ${res.error}`, {
            param: 'atCarrier',
            detail: 'release_at_carrier_failed',
            requestId: ctx.requestId,
          });
        }
      }
    } else {
      // An adopted number remembers the routing it had before Voxera. A bought
      // number has no previous route, so detaching clears our callbacks while
      // leaving ownership and billing at the carrier explicit.
      const previous = number.previousCarrierConfig;
      const detached = await configureNumber(carrier, number.carrierSid, {
        voiceUrl: previous?.voiceUrl ?? '',
        statusCallback: previous?.statusCallback ?? '',
        smsUrl: previous?.smsUrl ?? '',
      });
      if (!detached.ok) {
        audit({ orgId: ctx.orgId, actor: 'dashboard', action: 'number.detach_failed', target: id, detail: `${number.number} — ${detached.error}` });
        return fail('VALIDATION_ERROR', `The carrier would not detach this deployment's routing: ${detached.error}`, {
          param: 'atCarrier',
          detail: 'detach_at_carrier_failed',
          requestId: ctx.requestId,
        });
      }
      carrierResult = { attempted: true, released: false, detached: true, restoredPrevious: Boolean(previous) };
    }
  }

  try {
    remove('numbers', id);
  } catch (error) {
    // The carrier action already happened. Keep a reconciliation marker rather
    // than pretending the local record vanished.
    update('numbers', id, {
      status: carrierResult.released ? 'released_at_carrier' : 'detached_at_carrier',
      reconciliationRequired: true,
      reconciliationError: error instanceof Error ? error.message.slice(0, 200) : 'local removal failed',
    });
    audit({ orgId: ctx.orgId, actor: 'dashboard', action: 'number.local_removal_failed', target: id, detail: String(number.number ?? '') });
    return fail('INTERNAL_ERROR', 'The carrier action succeeded but the local record could not be removed. Reconciliation is required.', {
      requestId: ctx.requestId,
    });
  }
  audit({
    orgId: ctx.orgId,
    actor: 'dashboard',
    action: 'number.released',
    target: id,
    detail: `${number.number}${carrierResult.released ? ' released at carrier' : ' detached only'}`,
  });

  return ok(
    {
      id,
      number: number.number,
      releasedAtCarrier: carrierResult.released,
      carrier: carrierResult.attempted ? carrierResult : undefined,
      note: carrierResult.reconciledMissing
        ? 'The number was already absent from the carrier account, so the stale local claim was removed.'
        : carrierResult.released
          ? 'The carrier reported that the number was released. Confirm final rental charges in the carrier account.'
        : carrierResult.restoredPrevious
          ? 'Detached from this workspace and restored to its previous carrier routing. The number remains on your carrier account.'
          : carrierResult.detached
            ? 'Detached from this deployment. The number and any ongoing rental remain on your carrier account.'
            : 'The local sandbox record was removed.',
    },
    { requestId: ctx.requestId }
  );
}
