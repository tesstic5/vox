import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, requireAuth, requireConfigRole } from '@/lib/server/api';
import { removeRotaChange } from '@/lib/server/practice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const { id } = await params;
  if (!removeRotaChange(ctx.orgId, id, ctx.auth === 'key' ? `key:${ctx.key?.id}` : 'dashboard')) {
    return fail('NOT_FOUND', `No rota change with id ${id}.`, { requestId: ctx.requestId });
  }
  return ok({ id, deleted: true }, { requestId: ctx.requestId });
}
