import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, requireAuth, requireConfigRole } from '@/lib/server/api';
import { deleteCarrier, publicCarrier, type CarrierDoc } from '@/lib/server/carriers';
import { get, list, type Doc } from '@/lib/server/db';
import { ownedNumbers } from '@/lib/server/providers/twilio';
import { readiness } from '@/lib/server/media/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /v1/carriers/{id} — one carrier, plus what the workspace has on it. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session') return fail('FORBIDDEN', 'Carrier settings require a signed-in workspace administrator.', { requestId: ctx.requestId });
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const carrier = get<CarrierDoc>('carriers', id);
  if (!carrier || carrier.orgId !== ctx.orgId) return fail('NOT_FOUND', `No carrier with id ${id}.`, { requestId: ctx.requestId });

  const numbers = list<Doc & { number?: string; assistantId?: string; carrierSid?: string }>(
    'numbers',
    (n) => n.orgId === ctx.orgId && n.carrierId === carrier.id
  );

  return ok(
    {
      carrier: publicCarrier(carrier),
      numbers: numbers.map((n) => ({ id: n.id, number: n.number, carrierSid: n.carrierSid, assistantId: n.assistantId })),
      media: await readiness(),
    },
    { requestId: ctx.requestId }
  );
}

/**
 * DELETE /v1/carriers/{id} — forget the credentials.
 *
 * Active numbers deliberately block credential removal. Disconnecting first
 * would strand routing and signature verification while the carrier keeps
 * billing. Release or safely detach each number, then disconnect.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session') return fail('FORBIDDEN', 'Carrier settings require a signed-in workspace administrator.', { requestId: ctx.requestId });
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const carrier = get<CarrierDoc>('carriers', id);
  if (!carrier || carrier.orgId !== ctx.orgId) return fail('NOT_FOUND', `No carrier with id ${id}.`, { requestId: ctx.requestId });
  const linked = list<Doc>('numbers', (n) => n.orgId === ctx.orgId && n.carrierId === id);
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

/** POST /v1/carriers/{id} — reconcile against what the carrier actually holds. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session') return fail('FORBIDDEN', 'Carrier settings require a signed-in workspace administrator.', { requestId: ctx.requestId });
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const carrier = get<CarrierDoc>('carriers', id);
  if (!carrier || carrier.orgId !== ctx.orgId) return fail('NOT_FOUND', `No carrier with id ${id}.`, { requestId: ctx.requestId });

  const owned = await ownedNumbers(carrier);
  if (!owned.ok) return fail('INTERNAL_ERROR', owned.error, { requestId: ctx.requestId });

  const local = new Set(
    list<Doc & { number?: string }>('numbers', (n) => n.orgId === ctx.orgId && n.carrierId === carrier.id).map((n) => n.number)
  );
  const atCarrier = new Set(owned.data.map((n) => n.phone_number));

  return ok(
    {
      atCarrier: owned.data.length,
      inWorkspace: local.size,
      // Ours but not theirs: a number was released outside Voxera.
      missingAtCarrier: [...local].filter((n) => !atCarrier.has(String(n))),
      // Theirs but not ours: bought elsewhere, still adoptable.
      notAdopted: [...atCarrier].filter((n) => !local.has(n)),
    },
    { requestId: ctx.requestId }
  );
}
