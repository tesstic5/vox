import { NextResponse, type NextRequest } from 'next/server';
import { actorLabel, recordAccess } from '@/lib/server/access-log';
import { fail, listBody, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { bookingById } from '@/lib/server/bookings';
import { encounterById, encountersForPatient, ensureEncounterForBooking, setEncounterStatus } from '@/lib/server/encounters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['clinical:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const patientId = new URL(req.url).searchParams.get('patientId') ?? '';
  if (!patientId) return fail('VALIDATION_ERROR', 'patientId is required.', { param: 'patientId', requestId: ctx.requestId });
  const denied = requirePermission(ctx, 'clinical.read', { area: 'clinical', patientId });
  if (denied) return denied;
  const rows = encountersForPatient(ctx.orgId, patientId);
  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  recordAccess({ orgId: ctx.orgId, resource: 'encounter', resourceId: patientId, action: 'list', actor, actorName, detail: `${rows.length} encounter(s)` });
  return ok(listBody(rows), { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['clinical:write'] });
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session') return fail('FORBIDDEN', 'Encounter changes require an authenticated staff session.', { requestId: ctx.requestId });
  const body = await readJson<{ action?: 'open' | 'set_status'; bookingId?: string; id?: string; expectedRevision?: number; status?: 'finished' | 'cancelled' }>(req, 32 * 1024);
  if (body instanceof NextResponse) return body;
  const booking = body.action === 'set_status'
    ? (() => {
        const encounter = encounterById(ctx.orgId, String(body.id ?? ''));
        return encounter ? bookingById(ctx.orgId, encounter.bookingId) : undefined;
      })()
    : bookingById(ctx.orgId, String(body.bookingId ?? ''));
  if (!booking?.clientId) return fail('NOT_FOUND', 'The encounter booking does not exist or has no client.', { requestId: ctx.requestId });
  const denied = requirePermission(ctx, 'clinical.write', { area: 'clinical', patientId: booking.clientId });
  if (denied) return denied;
  const { actor } = actorLabel(ctx.auth, { email: ctx.user?.email });
  const result = body.action === 'set_status'
    ? setEncounterStatus({ orgId: ctx.orgId, id: String(body.id ?? ''), expectedRevision: Number(body.expectedRevision), status: body.status ?? 'finished', actorId: actor })
    : ensureEncounterForBooking({ orgId: ctx.orgId, bookingId: booking.id, expectedBookingRevision: Number(body.expectedRevision), actorId: actor });
  if (!result.ok) return fail(result.code === 'NOT_FOUND' ? 'NOT_FOUND' : result.code === 'CONFLICT' ? 'CONFLICT' : 'VALIDATION_ERROR', result.error, { requestId: ctx.requestId });
  return ok({ encounter: result.value, booking: result.booking, created: result.created }, { status: result.created ? 201 : 200, requestId: ctx.requestId });
}
