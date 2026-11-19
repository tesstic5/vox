import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { audit } from '@/lib/server/audit';
import {
  PERMISSIONS,
  createCustomRole,
  ensureSystemRoles,
  isPermission,
  permissionShadowEvents,
  rolesFor,
  type LegacyRole,
  type RecordScope,
  type ScopeArea,
} from '@/lib/server/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function sessionOnly(ctx: { auth: string; requestId: string }) {
  return ctx.auth === 'session' ? null : fail('FORBIDDEN', 'Role management requires a signed-in person.', { requestId: ctx.requestId });
}

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = sessionOnly(ctx) ?? requirePermission(ctx, 'roles.read');
  if (denied) return denied;
  ensureSystemRoles(ctx.orgId);
  const shadow = permissionShadowEvents(ctx.orgId, { unresolvedOnly: true });
  return ok(
    {
      object: 'list',
      data: rolesFor(ctx.orgId),
      permissions: PERMISSIONS,
      shadow: {
        disagreements: shadow.length,
        latestAt: shadow.map((row) => String(row.at ?? '')).sort().pop(),
        note: 'Disagreements are migration evidence, not an authorisation bypass.',
      },
    },
    { requestId: ctx.requestId },
  );
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = sessionOnly(ctx) ?? requirePermission(ctx, 'roles.manage');
  if (denied) return denied;
  if (!ctx.user) return fail('FORBIDDEN', 'A user identity is required.', { requestId: ctx.requestId });
  const body = await readJson<{
    name?: string;
    description?: string;
    permissions?: string[];
    scopes?: Partial<Record<ScopeArea, RecordScope>>;
    legacyBaseRole?: LegacyRole;
  }>(req);
  if (body instanceof NextResponse) return body;
  const legacyBaseRole = body.legacyBaseRole;
  if (!legacyBaseRole || legacyBaseRole === 'owner' || !['admin', 'developer', 'receptionist', 'practitioner', 'viewer'].includes(legacyBaseRole)) {
    return fail('VALIDATION_ERROR', '`legacyBaseRole` must be one of: admin, developer, receptionist, practitioner, viewer.', {
      param: 'legacyBaseRole', requestId: ctx.requestId,
    });
  }
  const invalid = (body.permissions ?? []).find((permission) => !isPermission(permission));
  if (invalid) return fail('VALIDATION_ERROR', `Unknown permission: ${invalid}.`, { param: 'permissions', requestId: ctx.requestId });
  try {
    const role = createCustomRole({
      orgId: ctx.orgId,
      name: String(body.name ?? ''),
      description: body.description,
      permissions: (body.permissions ?? []).filter(isPermission),
      scopes: body.scopes,
      legacyBaseRole: legacyBaseRole as Exclude<LegacyRole, 'owner'>,
      actor: ctx.user,
    });
    audit({ orgId: ctx.orgId, actor: ctx.user.email, action: 'role.created', target: role.id, detail: role.name });
    return ok(role, { requestId: ctx.requestId, status: 201 });
  } catch (error) {
    return fail('VALIDATION_ERROR', error instanceof Error ? error.message : 'Could not create the role.', { requestId: ctx.requestId });
  }
}
