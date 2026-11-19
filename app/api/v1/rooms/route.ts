import { NextResponse, type NextRequest } from 'next/server';
import { fail, listBody, ok, readJson, requireAuth, requireConfigRole } from '@/lib/server/api';
import { locationById } from '@/lib/server/practice';
import { createRoom, deleteRoom, roomsFor, updateRoom, type RoomDoc } from '@/lib/server/rooms';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Rooms, per site.
 *
 * A room is the resource an appointment occupies: the availability engine will
 * not offer an hour when every room at that site is taken, and the clash check
 * refuses to put two people in the same four walls. It is therefore a record,
 * not a label — renaming one keeps the id that every booked appointment points
 * at, and a room with appointments still to come cannot be deleted.
 *
 * Action-style POST, the house pattern: the whole lifecycle is one endpoint.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  const locationId = url.searchParams.get('locationId') ?? undefined;
  const includeInactive = url.searchParams.get('includeInactive') === 'true';
  if (locationId && !locationById(ctx.orgId, locationId)) {
    return fail('NOT_FOUND', `No location with id ${locationId}.`, { requestId: ctx.requestId });
  }
  const rows = roomsFor(ctx.orgId, { locationId, includeInactive });
  return ok(
    listBody(
      rows.map((row) => ({
        ...row,
        locationName: locationById(ctx.orgId, row.locationId)?.name,
      }))
    ),
    { requestId: ctx.requestId }
  );
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const body = await readJson<{ action?: string; id?: string } & Partial<RoomDoc>>(req);
  if (body instanceof NextResponse) return body;
  const actor = ctx.auth === 'key' ? `key:${ctx.key?.id}` : 'dashboard';
  const id = String(body.id ?? '');

  switch (body.action) {
    case 'create': {
      const locationId = String(body.locationId ?? '');
      if (!locationId) return fail('VALIDATION_ERROR', '`locationId` is required — a room is at a site.', { param: 'locationId', requestId: ctx.requestId });
      const result = createRoom(ctx.orgId, { locationId, name: String(body.name ?? ''), notes: body.notes }, actor);
      if (result.error) return fail(result.error === 'not_found' ? 'NOT_FOUND' : 'VALIDATION_ERROR', result.message ?? 'Could not add the room.', { requestId: ctx.requestId });
      return ok({ room: result.room }, { requestId: ctx.requestId, status: 201 });
    }

    case 'update': {
      if (!id) return fail('VALIDATION_ERROR', '`id` is required.', { param: 'id', requestId: ctx.requestId });
      const result = updateRoom(ctx.orgId, id, { name: body.name, notes: body.notes, active: body.active, locationId: body.locationId }, actor);
      if (result.error) {
        const code = result.error === 'not_found' ? 'NOT_FOUND' : result.error === 'unsupported' ? 'CONFLICT' : 'VALIDATION_ERROR';
        return fail(code, result.message ?? 'Could not update the room.', { requestId: ctx.requestId });
      }
      return ok({ room: result.room }, { requestId: ctx.requestId });
    }

    case 'delete': {
      if (!id) return fail('VALIDATION_ERROR', '`id` is required.', { param: 'id', requestId: ctx.requestId });
      const result = deleteRoom(ctx.orgId, id, actor);
      if (!result.deleted) {
        if (result.error === 'not_found') return fail('NOT_FOUND', result.message ?? 'No such room.', { requestId: ctx.requestId });
        // In use is a conflict with a way forward, not a validation slip.
        return fail('CONFLICT', result.message ?? 'That room is still in use.', {
          detail: `Upcoming appointments: ${result.upcoming ?? 0}.`,
          requestId: ctx.requestId,
        });
      }
      return ok({ id, deleted: true, retained: result.retained ?? false, historicalReferences: result.references ?? 0 }, { requestId: ctx.requestId });
    }

    default:
      return fail('VALIDATION_ERROR', '`action` must be one of: create, update, delete.', { param: 'action', requestId: ctx.requestId });
  }
}
