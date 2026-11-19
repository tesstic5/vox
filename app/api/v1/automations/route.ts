import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { automationCatalogue, automationRulesFor, createAutomationRule, type AutomationTrigger } from '@/lib/server/automations/catalogue';
import { automationNotificationsFor, automationRunsFor } from '@/lib/server/automations/runner';
import { CommitConflictError } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const actor = (ctx: Exclude<Awaited<ReturnType<typeof requireAuth>>, NextResponse>) => ctx.user?.email ?? ctx.key?.id ?? 'api';

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['automations:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'automations.read');
  if (denied) return denied;
  const url = new URL(req.url);
  const rules = automationRulesFor(ctx.orgId, url.searchParams.get('archived') === 'true');
  const allNotifications = automationNotificationsFor(ctx.orgId, 500, true);
  const notifications = allNotifications.filter((row) => !row.dismissedAt).slice(0, 50);
  return ok({
    object: 'automation_config',
    rules,
    runs: automationRunsFor(ctx.orgId, { limit: 100 }),
    notifications,
    notificationSummary: {
      unread: allNotifications.filter((row) => !row.readAt && !row.dismissedAt).length,
      active: allNotifications.filter((row) => !row.dismissedAt).length,
      dismissed: allNotifications.filter((row) => Boolean(row.dismissedAt)).length,
    },
    catalogue: automationCatalogue(),
  }, { requestId: ctx.requestId, headers: { 'cache-control': 'no-store' } });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['automations:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'automations.manage');
  if (denied) return denied;
  const body = await readJson<{ name?: string; trigger?: AutomationTrigger; condition?: unknown; actions?: unknown }>(req, 96 * 1024);
  if (body instanceof NextResponse) return body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('VALIDATION_ERROR', 'Automation body must be an object.', { param: 'body', requestId: ctx.requestId });
  const unsupported = Object.keys(body).find((key) => !['name', 'trigger', 'condition', 'actions'].includes(key));
  if (unsupported) return fail('VALIDATION_ERROR', `Automation property ${unsupported} is not supported.`, { param: unsupported, requestId: ctx.requestId });
  try {
    return ok(createAutomationRule({ orgId: ctx.orgId, name: String(body.name ?? ''), trigger: String(body.trigger ?? '') as AutomationTrigger, condition: body.condition, actions: body.actions, actor: actor(ctx) }), { requestId: ctx.requestId, status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Automation could not be created.';
    return fail(error instanceof CommitConflictError ? 'CONFLICT' : /disabled|prohibited/i.test(message) ? 'FORBIDDEN' : 'VALIDATION_ERROR', message, { requestId: ctx.requestId });
  }
}
