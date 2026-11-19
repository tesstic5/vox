import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireWriteRole } from '@/lib/server/api';
import { actorLabel } from '@/lib/server/access-log';
import { deskRequests, resolveDeskRequest } from '@/lib/server/inbound';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The replies waiting on a person.
 *
 * A client texts "can I come Thursday instead?" and until somebody reads it, the
 * practice has a promise outstanding. This is the queue that holds those, and the
 * only thing it can do is tick one off — the work itself happens on the diary.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const limit = Math.min(Number(new URL(req.url).searchParams.get('limit') ?? 25) || 25, 100);
  const rows = deskRequests(ctx.orgId, limit);
  return ok({ replies: rows, count: rows.length }, { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireWriteRole(ctx);
  if (denied) return denied;

  const body = await readJson<{ action?: string; id?: string; note?: string }>(req);
  if (body instanceof Response) return body;
  if (body.action !== 'resolve') return fail('VALIDATION_ERROR', '`action` must be `resolve`.', { param: 'action', requestId: ctx.requestId });
  if (!body.id) return fail('VALIDATION_ERROR', 'Send the request `id`.', { param: 'id', requestId: ctx.requestId });

  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  const result = resolveDeskRequest({
    orgId: ctx.orgId,
    id: String(body.id),
    actor,
    actorName,
    note: body.note ? String(body.note) : undefined,
  });
  if (!result.ok) return fail('NOT_FOUND', result.message, { requestId: ctx.requestId });
  return ok({ resolved: result.id, waiting: deskRequests(ctx.orgId, 100).length }, { requestId: ctx.requestId });
}
