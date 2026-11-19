import { NextRequest, NextResponse } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { permissionShadowEvents, resolvePermissionShadowEvent } from '@/lib/server/permissions';
import { audit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request, { scopes: ['roles:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'roles.read');
  if (denied) return denied;
  const unresolvedOnly = new URL(request.url).searchParams.get('includeResolved') !== 'true';
  const data = permissionShadowEvents(ctx.orgId, { unresolvedOnly });
  return ok({ object: 'list', data, meta: { unresolved: permissionShadowEvents(ctx.orgId, { unresolvedOnly: true }).length } }, { requestId: ctx.requestId });
}

export async function PATCH(request: NextRequest) {
  const ctx = await requireAuth(request, { scopes: ['roles:write'] });
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session' || !ctx.user) return fail('FORBIDDEN', 'Comparison review requires a signed-in person.', { requestId: ctx.requestId });
  const denied = requirePermission(ctx, 'roles.manage');
  if (denied) return denied;
  const body = await readJson<{ eventId?: string; resolution?: string }>(request);
  if (body instanceof NextResponse) return body;
  if (!body.eventId) return fail('VALIDATION_ERROR', '`eventId` is required.', { param: 'eventId', requestId: ctx.requestId });
  try {
    const event = resolvePermissionShadowEvent({
      orgId: ctx.orgId,
      eventId: body.eventId,
      actorId: ctx.user.id,
      resolution: body.resolution ?? '',
    });
    audit({ orgId: ctx.orgId, actor: ctx.user.email, action: 'roles.shadow.resolve', target: event.id, detail: `${event.permission}: ${event.resolution}` });
    return ok(event, { requestId: ctx.requestId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Permission comparison could not be resolved.';
    return fail(message.includes('not found') ? 'NOT_FOUND' : 'VALIDATION_ERROR', message, { requestId: ctx.requestId });
  }
}
