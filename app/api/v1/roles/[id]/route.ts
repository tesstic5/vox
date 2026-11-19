import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { audit } from '@/lib/server/audit';
import { commitBatch, find, list } from '@/lib/server/db';
import { isPermission, updateCustomRole, type RecordScope, type RoleDoc, type ScopeArea } from '@/lib/server/permissions';
import type { UserDoc } from '@/lib/server/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session' || !ctx.user) return fail('FORBIDDEN', 'Role management requires a signed-in person.', { requestId: ctx.requestId });
  const denied = requirePermission(ctx, 'roles.manage');
  if (denied) return denied;
  const role = find<RoleDoc>('roles', (row) => row.id === id && row.orgId === ctx.orgId);
  if (!role) return fail('NOT_FOUND', `No role with id ${id}.`, { requestId: ctx.requestId });
  const body = await readJson<{
    name?: string;
    description?: string;
    permissions?: string[];
    scopes?: Partial<Record<ScopeArea, RecordScope>>;
    expectedRevision?: number;
    archive?: boolean;
  }>(req);
  if (body instanceof NextResponse) return body;
  if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision !== Number(role.revision ?? 0)) {
    return fail('CONFLICT', 'The role changed after this screen loaded. Reload it before saving.', { param: 'expectedRevision', requestId: ctx.requestId });
  }
  if (body.archive) {
    if (role.system) return fail('CONFLICT', 'System role templates cannot be archived.', { requestId: ctx.requestId });
    const assigned = list<UserDoc>('users', (user) => user.orgId === ctx.orgId && user.roleId === role.id && user.active !== false);
    if (assigned.length) return fail('CONFLICT', `Move ${assigned.length} active member(s) off this role before archiving it.`, { requestId: ctx.requestId });
    try {
      const archived = commitBatch({
        upserts: [{ collection: 'roles', doc: { ...role, archivedAt: new Date().toISOString() }, expectedRevision: Number(role.revision), expectedOrgId: ctx.orgId }],
      }).upserts[0] as RoleDoc;
      audit({ orgId: ctx.orgId, actor: ctx.user.email, action: 'role.archived', target: role.id, detail: role.name });
      return ok(archived, { requestId: ctx.requestId });
    } catch (error) {
      return fail(error instanceof Error && error.name === 'CommitConflictError' ? 'CONFLICT' : 'INTERNAL_ERROR', error instanceof Error ? error.message : 'Could not archive the role.', { requestId: ctx.requestId });
    }
  }
  const invalid = body.permissions?.find((permission) => !isPermission(permission));
  if (invalid) return fail('VALIDATION_ERROR', `Unknown permission: ${invalid}.`, { param: 'permissions', requestId: ctx.requestId });
  try {
    const updated = updateCustomRole({
      role,
      name: body.name,
      description: body.description,
      permissions: body.permissions?.filter(isPermission),
      scopes: body.scopes,
      actor: ctx.user,
    });
    audit({ orgId: ctx.orgId, actor: ctx.user.email, action: 'role.updated', target: role.id, detail: role.name });
    return ok(updated, { requestId: ctx.requestId });
  } catch (error) {
    const code = error instanceof Error && error.name === 'CommitConflictError' ? 'CONFLICT' : 'VALIDATION_ERROR';
    return fail(code, error instanceof Error ? error.message : 'Could not update the role.', { requestId: ctx.requestId });
  }
}
