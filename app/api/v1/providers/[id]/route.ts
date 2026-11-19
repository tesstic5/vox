import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireConfigRole } from '@/lib/server/api';
import { deleteProvider, locationsFor, providerById, servicesFor, updateProvider } from '@/lib/server/practice';
import { validateProviderInput } from '@/lib/server/practice-input';
import { termsForOrg } from '@/lib/server/practice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const row = providerById(ctx.orgId, id);
  if (!row) return fail('NOT_FOUND', `No provider with id ${id}.`, { requestId: ctx.requestId });
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
  const checked = validateProviderInput(body, 'update');
  if ('error' in checked) return fail('VALIDATION_ERROR', checked.error, { param: checked.param, requestId: ctx.requestId });
  const patch = checked.value;
  if (patch.serviceIds) {
    const known = new Set(servicesFor(ctx.orgId).map((service) => service.id));
    const bad = patch.serviceIds.find((serviceId) => !known.has(serviceId));
    if (bad) return fail('VALIDATION_ERROR', `No active service with id ${bad} in this workspace.`, { param: 'serviceIds', requestId: ctx.requestId });
  }
  if (patch.locationIds) {
    const known = new Set(locationsFor(ctx.orgId).map((location) => location.id));
    const bad = patch.locationIds.find((locationId) => !known.has(locationId));
    if (bad) return fail('VALIDATION_ERROR', `No active location with id ${bad} in this workspace.`, { param: 'locationIds', requestId: ctx.requestId });
  }
  const row = updateProvider(ctx.orgId, id, patch, ctx.auth === 'key' ? `key:${ctx.key?.id}` : 'dashboard');
  if (!row) return fail('NOT_FOUND', `No provider with id ${id}.`, { requestId: ctx.requestId });
  return ok(row, { requestId: ctx.requestId });
}

/**
 * DELETE refuses while appointments are still coming.
 *
 * The alternative — deleting anyway — leaves real appointments with nobody to
 * attend them, which is a worse lie than an error message. The count is in the
 * response so the caller can act on it.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const { id } = await params;
  const terms = termsForOrg(ctx.orgId);
  const result = deleteProvider(ctx.orgId, id, ctx.auth === 'key' ? `key:${ctx.key?.id}` : 'dashboard');
  if (!result.deleted) {
    if (result.error === 'not_found') return fail('NOT_FOUND', `No provider with id ${id}.`, { requestId: ctx.requestId });
    return fail('CONFLICT', `That ${terms.provider.one} still has ${result.upcoming} upcoming ${terms.appointment.many}. Set \`active: false\` to retire them instead, or move the bookings first.`, {
      param: 'id',
      detail: `Upcoming ${terms.appointment.many}: ${result.upcoming ?? 0}.`,
      requestId: ctx.requestId,
    });
  }
  return ok({ id, deleted: true, retained: result.retained ?? false, historicalReferences: result.references ?? 0 }, { requestId: ctx.requestId });
}
