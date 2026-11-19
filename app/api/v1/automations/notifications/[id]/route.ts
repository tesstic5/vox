import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { automationNotificationById, updateAutomationNotification } from '@/lib/server/automations/runner';
import { CommitConflictError } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const actor = (ctx: Exclude<Awaited<ReturnType<typeof requireAuth>>, NextResponse>) => ctx.user?.email ?? ctx.key?.id ?? 'api';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['automations:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'automations.read');
  if (denied) return denied;
  const notification = automationNotificationById(ctx.orgId, id);
  if (!notification) return fail('NOT_FOUND', 'Automation notification not found.', { requestId: ctx.requestId });
  return ok(notification, { requestId: ctx.requestId, headers: { 'cache-control': 'no-store' } });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['automations:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'automations.manage');
  if (denied) return denied;
  const body = await readJson<{ action?: 'read' | 'dismiss'; expectedRevision?: number }>(req, 8 * 1024);
  if (body instanceof NextResponse) return body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('VALIDATION_ERROR', 'Automation notification body must be an object.', { param: 'body', requestId: ctx.requestId });
  const unsupported = Object.keys(body).find((key) => !['action', 'expectedRevision'].includes(key));
  if (unsupported) return fail('VALIDATION_ERROR', `Automation notification property ${unsupported} is not supported.`, { param: unsupported, requestId: ctx.requestId });
  if (!['read', 'dismiss'].includes(String(body.action ?? ''))) return fail('VALIDATION_ERROR', 'Automation notification action must be read or dismiss.', { param: 'action', requestId: ctx.requestId });
  if (!Number.isSafeInteger(body.expectedRevision)) return fail('VALIDATION_ERROR', 'expectedRevision is required.', { param: 'expectedRevision', requestId: ctx.requestId });
  try {
    return ok(updateAutomationNotification({
      orgId: ctx.orgId,
      id,
      action: body.action!,
      expectedRevision: body.expectedRevision!,
      actor: actor(ctx),
    }), { requestId: ctx.requestId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Automation notification could not be updated.';
    const conflict = error instanceof CommitConflictError || /changed after/i.test(message);
    return fail(conflict ? 'CONFLICT' : /not found/i.test(message) ? 'NOT_FOUND' : 'VALIDATION_ERROR', message, { requestId: ctx.requestId });
  }
}
