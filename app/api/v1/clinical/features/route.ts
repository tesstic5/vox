import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { ensurePhase1FeatureFlags, featureFlagsFor, setFeatureFlag, type FeatureFlagState, type Phase1FeatureFlag } from '@/lib/server/feature-flags';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session') return fail('FORBIDDEN', 'Rollout controls require a signed-in person.', { requestId: ctx.requestId });
  const denied = requirePermission(ctx, 'roles.read');
  if (denied) return denied;
  ensurePhase1FeatureFlags(ctx.orgId);
  const data = featureFlagsFor(ctx.orgId);
  return ok({ object: 'list', data, total: data.length }, { requestId: ctx.requestId, headers: { 'cache-control': 'no-store' } });
}

export async function PUT(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session' || !ctx.user) return fail('FORBIDDEN', 'Rollout controls require a signed-in person.', { requestId: ctx.requestId });
  const denied = requirePermission(ctx, 'roles.manage');
  if (denied) return denied;
  const body = await readJson<{ key?: Phase1FeatureFlag; state?: FeatureFlagState; expectedRevision?: number }>(req);
  if (body instanceof NextResponse) return body;
  if (!Number.isSafeInteger(body.expectedRevision)) return fail('VALIDATION_ERROR', '`expectedRevision` is required.', { param: 'expectedRevision', requestId: ctx.requestId });
  try {
    const saved = setFeatureFlag({ orgId: ctx.orgId, key: String(body.key ?? '') as Phase1FeatureFlag, state: String(body.state ?? '') as FeatureFlagState, actor: ctx.user.email, expectedRevision: body.expectedRevision! });
    return ok(saved, { requestId: ctx.requestId, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The rollout flag could not be changed.';
    return fail(message.includes('changed') || (error instanceof Error && error.name === 'CommitConflictError') ? 'CONFLICT' : 'VALIDATION_ERROR', message, { requestId: ctx.requestId });
  }
}
