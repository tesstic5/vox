import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireWriteRole } from '@/lib/server/api';
import {
  scheduleVisit,
  setVisitStatus,
  updateVisit,
  visitById,
  type VisitStatus,
} from '@/lib/server/field-service';
import { providerById } from '@/lib/server/practice';
import { fieldActor, fieldFailure, practitionerVisitDenied } from '@/lib/server/field-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUSES: VisitStatus[] = ['unassigned', 'scheduled', 'en_route', 'on_site', 'completed', 'cancelled'];

function assignedDenied(ctx: Exclude<Awaited<ReturnType<typeof requireAuth>>, NextResponse>, providerId?: string) {
  const provider = providerId ? providerById(ctx.orgId, providerId) : undefined;
  return practitionerVisitDenied(ctx, provider?.userId);
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['field:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const visit = visitById(ctx.orgId, id);
  if (!visit) return fail('NOT_FOUND', 'No such visit in this workspace.', { requestId: ctx.requestId });
  const assigned = assignedDenied(ctx, visit.providerId);
  if (assigned) return assigned;
  return ok(visit, { requestId: ctx.requestId });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['field:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireWriteRole(ctx);
  if (denied) return denied;
  const { id } = await params;
  const visit = visitById(ctx.orgId, id);
  if (!visit) return fail('NOT_FOUND', 'No such visit in this workspace.', { requestId: ctx.requestId });
  const assigned = assignedDenied(ctx, visit.providerId);
  if (assigned) return assigned;
  const body = await readJson<{ instructions?: string; workPerformed?: string; completionNote?: string }>(req);
  if (body instanceof NextResponse) return body;
  const result = updateVisit({ orgId: ctx.orgId, id, ...body, actor: fieldActor(ctx) });
  const failed = fieldFailure(result, ctx.requestId);
  return failed ?? ok(result.ok ? result.value : {}, { requestId: ctx.requestId });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['field:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireWriteRole(ctx);
  if (denied) return denied;
  const { id } = await params;
  const visit = visitById(ctx.orgId, id);
  if (!visit) return fail('NOT_FOUND', 'No such visit in this workspace.', { requestId: ctx.requestId });
  const body = await readJson<{
    action?: string;
    startsAt?: string;
    providerId?: string;
    locationId?: string;
    serviceId?: string;
    durationMinutes?: number;
    travelBufferMinutes?: number;
    status?: VisitStatus;
    note?: string;
  }>(req);
  if (body instanceof NextResponse) return body;
  const actor = fieldActor(ctx);

  if (body.action === 'schedule') {
    // A practitioner may move only an already-assigned own visit. They cannot
    // claim an unassigned visit or assign it to a different technician.
    if (ctx.auth === 'session' && ctx.user?.role === 'practitioner' && !visit.providerId) {
      return fail('FORBIDDEN', 'An unassigned visit must be assigned by a coordinator.', { requestId: ctx.requestId });
    }
    const assigned = assignedDenied(ctx, visit.providerId);
    if (assigned) return assigned;
    if (!body.startsAt || !body.providerId || !body.locationId) {
      return fail('VALIDATION_ERROR', 'Scheduling requires `startsAt`, `providerId` and `locationId`.', { requestId: ctx.requestId });
    }
    if (ctx.auth === 'session' && ctx.user?.role === 'practitioner' && visit.providerId && body.providerId !== visit.providerId) {
      return fail('FORBIDDEN', 'A practitioner cannot reassign a visit to somebody else.', { requestId: ctx.requestId });
    }
    const result = scheduleVisit({
      orgId: ctx.orgId,
      id,
      startsAt: body.startsAt,
      providerId: body.providerId,
      locationId: body.locationId,
      serviceId: body.serviceId,
      durationMinutes: body.durationMinutes,
      travelBufferMinutes: body.travelBufferMinutes,
      actor,
    });
    const failed = fieldFailure(result, ctx.requestId);
    return failed ?? ok(result.ok ? result.value : {}, { requestId: ctx.requestId });
  }

  const assigned = assignedDenied(ctx, visit.providerId);
  if (assigned) return assigned;

  if (body.action === 'reopen') {
    if (!['completed', 'cancelled'].includes(visit.status)) return fail('CONFLICT', 'Only a completed or cancelled visit needs reopening.', { requestId: ctx.requestId });
    const target: VisitStatus = visit.bookingId ? 'scheduled' : 'unassigned';
    const result = setVisitStatus({ orgId: ctx.orgId, id, status: target, note: body.note, actor, reopen: true });
    const failed = fieldFailure(result, ctx.requestId);
    return failed ?? ok(result.ok ? result.value : {}, { requestId: ctx.requestId });
  }

  if (body.action === 'status' && body.status && STATUSES.includes(body.status)) {
    const result = setVisitStatus({ orgId: ctx.orgId, id, status: body.status, note: body.note, actor });
    const failed = fieldFailure(result, ctx.requestId);
    return failed ?? ok(result.ok ? result.value : {}, { requestId: ctx.requestId });
  }

  return fail('VALIDATION_ERROR', '`action` must be schedule, status or reopen.', { param: 'action', requestId: ctx.requestId });
}
