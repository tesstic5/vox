import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { evaluateClinicalReadiness, setClinicalOperatingMode } from '@/lib/server/clinical-readiness';
import { audit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['privacy:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'privacy.read');
  if (denied) return denied;
  return ok(evaluateClinicalReadiness(ctx.orgId), { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['privacy:write'] });
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session' || !ctx.user) return fail('FORBIDDEN', 'Clinical mode changes require a signed-in person.', { requestId: ctx.requestId });
  const denied = requirePermission(ctx, 'privacy.manage');
  if (denied) return denied;
  const body = await readJson<{ mode?: 'disabled' | 'synthetic_test' | 'live'; confirmation?: string }>(req);
  if (body instanceof NextResponse) return body;
  if (!body.mode || !['disabled', 'synthetic_test', 'live'].includes(body.mode)) {
    return fail('VALIDATION_ERROR', '`mode` must be disabled, synthetic_test or live.', { param: 'mode', requestId: ctx.requestId });
  }
  try {
    const result = setClinicalOperatingMode({ orgId: ctx.orgId, mode: body.mode, actor: ctx.user, confirmation: body.confirmation });
    audit({ orgId: ctx.orgId, actor: ctx.user.email, action: 'clinical.mode_changed', target: result.profile.id, detail: body.mode });
    return ok(result, { requestId: ctx.requestId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not change clinical mode.';
    return fail(message.includes('blocked') ? 'CONFLICT' : 'FORBIDDEN', message, { requestId: ctx.requestId });
  }
}
