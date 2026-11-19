import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, requireAuth, requirePermission } from '@/lib/server/api';
import { clientById } from '@/lib/server/clients';
import { accessLogFor, actorLabel, recordView } from '@/lib/server/access-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The audit trail for one record: who opened it, who changed it, and when. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['clients:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'clients.read', { area: 'clients', patientId: id });
  if (denied) return denied;
  if (!clientById(ctx.orgId, id)) return fail('NOT_FOUND', `No client with id ${id}.`, { requestId: ctx.requestId });
  const limit = Math.min(Number(new URL(req.url).searchParams.get('limit') ?? 50) || 50, 200);
  // Read first so this request's own evidence appears on the next audit read,
  // rather than changing the list while it is being assembled.
  const data = accessLogFor(ctx.orgId, 'client', id, limit);
  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  recordView({ orgId: ctx.orgId, resource: 'client', resourceId: id, actor, actorName });
  return ok({ object: 'list', data, resource: 'client', resourceId: id }, { requestId: ctx.requestId });
}
