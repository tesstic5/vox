import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireConfigRole } from '@/lib/server/api';
import { deleteLocation, isValidTimezone, locationById, locationsFor, updateLocation } from '@/lib/server/practice';
import { validateLocationInput } from '@/lib/server/practice-input';
import { termsForOrg } from '@/lib/server/practice';
import { removeRoomsForLocation } from '@/lib/server/rooms';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const row = locationById(ctx.orgId, id);
  if (!row) return fail('NOT_FOUND', `No location with id ${id}.`, { requestId: ctx.requestId });
  return ok(row, { requestId: ctx.requestId });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const { id } = await params;
  const body = await readJson<unknown>(req);
  if (body instanceof NextResponse) return body;
  const checked = validateLocationInput(body, 'update');
  if ('error' in checked) return fail('VALIDATION_ERROR', checked.error, { param: checked.param, requestId: ctx.requestId });
  const patch = checked.value;
  if (patch.timezone && !isValidTimezone(patch.timezone)) {
    return fail('VALIDATION_ERROR', `\`${patch.timezone}\` is not a recognised IANA timezone.`, { param: 'timezone', requestId: ctx.requestId });
  }
  if (patch.name && locationsFor(ctx.orgId, { includeInactive: true }).some((location) => location.id !== id && location.name.toLowerCase() === patch.name!.toLowerCase())) {
    return fail('CONFLICT', `A location called ${patch.name} already exists.`, { param: 'name', requestId: ctx.requestId });
  }
  const row = updateLocation(ctx.orgId, id, patch, ctx.auth === 'key' ? `key:${ctx.key?.id}` : 'dashboard');
  if (!row) return fail('NOT_FOUND', `No location with id ${id}.`, { requestId: ctx.requestId });
  return ok(row, { requestId: ctx.requestId });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const { id } = await params;
  const terms = termsForOrg(ctx.orgId);
  const result = deleteLocation(ctx.orgId, id, ctx.auth === 'key' ? `key:${ctx.key?.id}` : 'dashboard');
  if (!result.deleted) {
    if (result.error === 'not_found') return fail('NOT_FOUND', `No location with id ${id}.`, { requestId: ctx.requestId });
    return fail('CONFLICT', `That ${terms.location.one} still has ${result.upcoming} upcoming ${terms.appointment.many}.`, {
      param: 'id',
      detail: `Upcoming ${terms.appointment.many}: ${result.upcoming ?? 0}.`,
      requestId: ctx.requestId,
    });
  }
  // A never-used site's rooms can go with it. If history points at the site,
  // deleteLocation retired both site and rooms instead, preserving their labels.
  const rooms = result.retained
    ? 0
    : removeRoomsForLocation(ctx.orgId, id, ctx.auth === 'key' ? `key:${ctx.key?.id}` : 'dashboard');
  return ok({ id, deleted: true, retained: result.retained ?? false, historicalReferences: result.references ?? 0, rooms }, { requestId: ctx.requestId });
}
