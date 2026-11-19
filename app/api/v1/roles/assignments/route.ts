import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { audit } from '@/lib/server/audit';
import { find } from '@/lib/server/db';
import { assignCustomRole, type RoleDoc } from '@/lib/server/permissions';
import type { UserDoc } from '@/lib/server/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session' || !ctx.user) return fail('FORBIDDEN', 'Role assignment requires a signed-in person.', { requestId: ctx.requestId });
  const denied = requirePermission(ctx, 'roles.manage');
  if (denied) return denied;
  const body = await readJson<{ userId?: string; roleId?: string | null }>(req);
  if (body instanceof NextResponse) return body;
  const user = find<UserDoc>('users', (row) => row.id === body.userId && row.orgId === ctx.orgId);
  if (!user) return fail('NOT_FOUND', 'No such active workspace member.', { param: 'userId', requestId: ctx.requestId });
  const role: RoleDoc | null = body.roleId
    ? find<RoleDoc>('roles', (row) => row.id === body.roleId && row.orgId === ctx.orgId && !row.archivedAt) ?? null
    : null;
  if (body.roleId && !role) return fail('NOT_FOUND', 'No such active custom role.', { param: 'roleId', requestId: ctx.requestId });
  try {
    const updated = assignCustomRole({ orgId: ctx.orgId, user, role, actor: ctx.user });
    audit({
      orgId: ctx.orgId,
      actor: ctx.user.email,
      action: role ? 'role.assigned' : 'role.custom_assignment_removed',
      target: user.id,
      detail: role ? role.name : `legacy ${updated.role}`,
    });
    return ok({ user: { id: updated.id, name: updated.name, email: updated.email, role: updated.role, roleId: updated.roleId } }, { requestId: ctx.requestId });
  } catch (error) {
    const code = error instanceof Error && error.name === 'CommitConflictError' ? 'CONFLICT' : 'VALIDATION_ERROR';
    return fail(code, error instanceof Error ? error.message : 'Could not assign the role.', { requestId: ctx.requestId });
  }
}
