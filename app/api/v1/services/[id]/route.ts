import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireConfigRole } from '@/lib/server/api';
import { deleteService, serviceById, servicesFor, updateService } from '@/lib/server/practice';
import { validateServiceInput } from '@/lib/server/practice-input';
import { termsForOrg } from '@/lib/server/practice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const row = serviceById(ctx.orgId, id);
  if (!row) return fail('NOT_FOUND', `No service with id ${id}.`, { requestId: ctx.requestId });
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
  const checked = validateServiceInput(body, 'update');
  if ('error' in checked) return fail('VALIDATION_ERROR', checked.error, { param: checked.param, requestId: ctx.requestId });
  const patch = checked.value;
  if (patch.name && servicesFor(ctx.orgId, { includeInactive: true }).some((service) => service.id !== id && service.name.toLowerCase() === patch.name!.toLowerCase())) {
    return fail('CONFLICT', `A service called ${patch.name} already exists.`, { param: 'name', requestId: ctx.requestId });
  }
  const row = updateService(ctx.orgId, id, patch, ctx.auth === 'key' ? `key:${ctx.key?.id}` : 'dashboard');
  if (!row) return fail('NOT_FOUND', `No service with id ${id}.`, { requestId: ctx.requestId });
  return ok(row, { requestId: ctx.requestId });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const { id } = await params;
  const terms = termsForOrg(ctx.orgId);
  const result = deleteService(ctx.orgId, id, ctx.auth === 'key' ? `key:${ctx.key?.id}` : 'dashboard');
  if (!result.deleted) {
    if (result.error === 'not_found') return fail('NOT_FOUND', `No service with id ${id}.`, { requestId: ctx.requestId });
    // A class service is held by its *sessions*, not by appointments, so the
    // refusal says which — "1 upcoming appointment" for a Thursday class would
    // send the desk looking in the wrong place.
    const held = result.because === 'classes' ? 'class session(s)' : terms.appointment.many;
    return fail('CONFLICT', `That service is still on ${result.upcoming} upcoming ${held}. Set \`active: false\` to stop offering it instead.`, {
      param: 'id',
      detail: `Upcoming ${held}: ${result.upcoming ?? 0}.`,
      requestId: ctx.requestId,
    });
  }
  return ok({ id, deleted: true, retained: result.retained ?? false, historicalReferences: result.references ?? 0 }, { requestId: ctx.requestId });
}
