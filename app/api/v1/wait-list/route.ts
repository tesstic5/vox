import { NextResponse, type NextRequest } from 'next/server';
import { fail, listBody, ok, readJson, requireAuth, requireWriteRole } from '@/lib/server/api';
import { addWaitEntry, purgeWaitList, waitListFor } from '@/lib/server/diary';
import { classSessionById } from '@/lib/server/classes';
import { classQueueFor, joinClassWaitList } from '@/lib/server/class-waitlist';
import { actorLabel } from '@/lib/server/access-log';
import { providerById, serviceById } from '@/lib/server/practice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The wait list: people who wanted a slot that did not exist yet.
 *
 * Cancellations look through it automatically (see `setAppointmentStatus`), so a
 * freed appointment comes back with the names it suits — the receptionist does
 * not have to remember who was waiting.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  const statusParam = url.searchParams.get('status');
  const rows = waitListFor(ctx.orgId, {
    includeCancelled: url.searchParams.get('includeClosed') === 'true',
    status: statusParam ? [statusParam as never] : undefined,
  });
  return ok(listBody(rows, { stats: { waiting: rows.filter((r) => r.status === 'waiting').length } }), { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireWriteRole(ctx);
  if (denied) return denied;
  const body = await readJson<{ name?: string; number?: string; email?: string; serviceId?: string; providerId?: string; locationId?: string; from?: string; to?: string; notes?: string; clientId?: string; sessionId?: string }>(req);
  if (body instanceof NextResponse) return body;

  /**
   * A class entry names a session, not a window, and goes through the class queue
   * so the order and the offer rules have one home. `from` is derived from the
   * class rather than typed, which is the point: the person is waiting for *that*
   * class, and a hand-typed window cannot describe it.
   */
  if (body.sessionId) {
    const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
    const session = classSessionById(ctx.orgId, String(body.sessionId));
    if (!session) return fail('NOT_FOUND', `No class session with id ${body.sessionId}.`, { param: 'sessionId', requestId: ctx.requestId });
    const joined = joinClassWaitList({
      orgId: ctx.orgId,
      session,
      clientId: body.clientId ? String(body.clientId) : undefined,
      name: body.name ? String(body.name) : undefined,
      number: body.number ? String(body.number) : undefined,
      email: body.email ? String(body.email) : undefined,
      source: 'dashboard',
      actor,
      actorName,
    });
    if (!joined.ok) return fail(joined.code as Parameters<typeof fail>[0], joined.message, { param: joined.param, requestId: ctx.requestId });
    return ok({ ...joined.entry, position: joined.position, already: joined.already, waitList: classQueueFor(ctx.orgId, session) }, { requestId: ctx.requestId, status: joined.already ? 200 : 201 });
  }

  const name = String(body.name ?? '').trim();
  const number = String(body.number ?? '').replace(/[^\d+]/g, '');
  if (!name) return fail('VALIDATION_ERROR', '`name` is required.', { param: 'name', requestId: ctx.requestId });
  if (!number) return fail('VALIDATION_ERROR', '`number` is required.', { param: 'number', requestId: ctx.requestId });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.from ?? ''))) return fail('VALIDATION_ERROR', '`from` must be `YYYY-MM-DD`.', { param: 'from', requestId: ctx.requestId });
  if (body.providerId && !providerById(ctx.orgId, body.providerId)) return fail('NOT_FOUND', `No provider with id ${body.providerId}.`, { param: 'providerId', requestId: ctx.requestId });
  if (body.serviceId && !serviceById(ctx.orgId, body.serviceId)) return fail('NOT_FOUND', `No service with id ${body.serviceId}.`, { param: 'serviceId', requestId: ctx.requestId });

  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  const entry = addWaitEntry(ctx.orgId, { ...body, name, number } as never, actor, actorName);
  return ok(entry, { requestId: ctx.requestId, status: 201 });
}

/** Housekeeping: entries whose window has passed stop pretending to be waiting. */
export async function DELETE(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireWriteRole(ctx);
  if (denied) return denied;
  const expired = purgeWaitList(ctx.orgId, ctx.auth === 'key' ? `api:${ctx.key?.id}` : 'dashboard');
  return ok({ expired }, { requestId: ctx.requestId });
}
