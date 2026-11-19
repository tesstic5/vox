import { NextRequest, NextResponse } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { dataMigrationStates, runPhase1DataMigrations } from '@/lib/server/data-migrations';
import { audit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CONFIRMATION = 'RUN PHASE 1 DATA MIGRATIONS';

export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request, { scopes: ['clinical:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'clinical.read');
  if (denied) return denied;
  const migrations = dataMigrationStates(ctx.orgId);
  return ok({
    object: 'list',
    data: migrations,
    meta: { completed: migrations.filter((row) => row.status === 'completed').length, total: migrations.length },
  }, { requestId: ctx.requestId });
}

export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, { scopes: ['clinical:write'] });
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session' || !ctx.user) return fail('FORBIDDEN', 'Data migrations require a signed-in person.', { requestId: ctx.requestId });
  const denied = requirePermission(ctx, 'clinical.write');
  if (denied) return denied;
  const body = await readJson<{ confirmation?: string }>(request);
  if (body instanceof NextResponse) return body;
  if (body.confirmation !== CONFIRMATION) {
    return fail('VALIDATION_ERROR', `confirmation must equal ${CONFIRMATION}`, { param: 'confirmation', requestId: ctx.requestId });
  }
  try {
    const result = runPhase1DataMigrations(ctx.orgId);
    audit({ orgId: ctx.orgId, actor: ctx.user.email, action: 'clinical.data_migrations.run', detail: `${result.completed}/${result.total} complete` });
    return ok(result, { requestId: ctx.requestId });
  } catch (error) {
    return fail('CONFLICT', error instanceof Error ? error.message : 'Data migrations could not be completed.', { requestId: ctx.requestId });
  }
}
