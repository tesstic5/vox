import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, requireAuth, requireConfigRole } from '@/lib/server/api';
import { get, update } from '@/lib/server/db';
import { verifyAccount, recentCalls } from '@/lib/server/providers/twilio';
import type { CarrierDoc } from '@/lib/server/carriers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /v1/carriers/{id}/verify — re-check the credentials on demand. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session') return fail('FORBIDDEN', 'Carrier verification requires a signed-in workspace administrator.', { requestId: ctx.requestId });
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const carrier = get<CarrierDoc>('carriers', id);
  if (!carrier || carrier.orgId !== ctx.orgId) return fail('NOT_FOUND', `No carrier with id ${id}.`, { requestId: ctx.requestId });

  const check = await verifyAccount(carrier);
  if (!check.ok) {
    update<CarrierDoc>('carriers', id, { verified: false, lastError: check.error });
    return ok({ verified: false, error: check.error, status: check.status }, { requestId: ctx.requestId });
  }

  const calls = await recentCalls(carrier, 5);
  update<CarrierDoc>('carriers', id, {
    verified: true,
    verifiedAt: new Date().toISOString(),
    verifiedAccountName: check.data.name,
    balance: check.data.balance,
    lastError: undefined,
  });

  return ok(
    {
      verified: true,
      account: { name: check.data.name, sid: check.data.sid, status: check.data.status, type: check.data.type },
      balance: check.data.balance,
      recentCalls: calls.ok ? calls.data.map((c) => ({ sid: c.sid, status: c.status, to: c.to, at: c.start_time })) : [],
    },
    { requestId: ctx.requestId }
  );
}
