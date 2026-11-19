import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth } from '@/lib/server/api';
import { isPlatformOperator } from '@/lib/server/operator';
import { setOrgSuspended } from '@/lib/server/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /v1/admin/orgs — { action: 'suspend' | 'reactivate', orgId }.
 * Suspending refuses the workspace's API access (see `requireAuth`) until
 * reactivated. The operator's own workspace cannot be suspended from here:
 * locking yourself out of the console that would undo it is a foot-gun,
 * and a deliberate one stays an API call, not a button.
 */
export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session' || !isPlatformOperator(ctx.user)) {
    return fail('FORBIDDEN', 'The operator console is for the platform operator. Ask an admin to add your email to VOXERA_OPERATOR_EMAILS.', {
      requestId: ctx.requestId,
    });
  }
  const body = await readJson<{ action?: string; orgId?: string }>(req);
  if (body instanceof NextResponse) return body;
  const orgId = String(body.orgId ?? '');
  if (!orgId) return fail('VALIDATION_ERROR', 'orgId is required.', { requestId: ctx.requestId, param: 'orgId' });
  if (orgId === ctx.orgId && body.action === 'suspend') {
    return fail('VALIDATION_ERROR', 'You cannot suspend your own workspace from the operator console.', { requestId: ctx.requestId, param: 'orgId' });
  }
  if (body.action !== 'suspend' && body.action !== 'reactivate') {
    return fail('VALIDATION_ERROR', 'action must be "suspend" or "reactivate".', { requestId: ctx.requestId, param: 'action' });
  }
  const org = setOrgSuspended(orgId, body.action === 'suspend', { userId: ctx.userId, email: ctx.user?.email ?? 'operator' });
  if (!org) return fail('NOT_FOUND', 'No such workspace.', { requestId: ctx.requestId, param: 'orgId' });
  return ok({ id: org.id, suspended: Boolean(org.suspended) }, { requestId: ctx.requestId });
}
