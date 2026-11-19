import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import {
  automationRuleById, automationRuleVersion, reviseAutomationRule, setAutomationRuleState,
  type AutomationTrigger,
} from '@/lib/server/automations/catalogue';
import { automationRunsFor, previewAutomationRuleValues } from '@/lib/server/automations/runner';
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
  const rule = automationRuleById(ctx.orgId, id);
  if (!rule) return fail('NOT_FOUND', 'Automation rule not found.', { requestId: ctx.requestId });
  return ok({ rule, version: automationRuleVersion(ctx.orgId, id), runs: automationRunsFor(ctx.orgId, { ruleId: id, limit: 100 }) }, { requestId: ctx.requestId, headers: { 'cache-control': 'no-store' } });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['automations:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'automations.read');
  if (denied) return denied;
  const body = await readJson<{ values?: unknown }>(req, 32 * 1024);
  if (body instanceof NextResponse) return body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('VALIDATION_ERROR', 'Automation preview body must be an object.', { param: 'body', requestId: ctx.requestId });
  const unsupported = Object.keys(body).find((key) => key !== 'values');
  if (unsupported) return fail('VALIDATION_ERROR', `Automation preview property ${unsupported} is not supported.`, { param: unsupported, requestId: ctx.requestId });
  try {
    return ok(previewAutomationRuleValues({ orgId: ctx.orgId, id, values: body.values }), { requestId: ctx.requestId, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Automation rule could not be previewed.';
    return fail(/not found/i.test(message) ? 'NOT_FOUND' : 'VALIDATION_ERROR', message, { requestId: ctx.requestId });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['automations:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'automations.manage');
  if (denied) return denied;
  const body = await readJson<{
    action?: 'revise' | 'activate' | 'pause' | 'archive'; expectedRevision?: number;
    name?: string; trigger?: AutomationTrigger; condition?: unknown; actions?: unknown;
  }>(req, 96 * 1024);
  if (body instanceof NextResponse) return body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('VALIDATION_ERROR', 'Automation update body must be an object.', { param: 'body', requestId: ctx.requestId });
  const unsupported = Object.keys(body).find((key) => !['action', 'expectedRevision', 'name', 'trigger', 'condition', 'actions'].includes(key));
  if (unsupported) return fail('VALIDATION_ERROR', `Automation update property ${unsupported} is not supported.`, { param: unsupported, requestId: ctx.requestId });
  if (!['revise', 'activate', 'pause', 'archive'].includes(String(body.action ?? ''))) return fail('VALIDATION_ERROR', 'Automation action is invalid.', { param: 'action', requestId: ctx.requestId });
  if (!Number.isSafeInteger(body.expectedRevision)) return fail('VALIDATION_ERROR', 'expectedRevision is required.', { param: 'expectedRevision', requestId: ctx.requestId });
  try {
    const result = body.action === 'revise'
      ? reviseAutomationRule({ orgId: ctx.orgId, id, expectedRevision: body.expectedRevision!, name: body.name, trigger: String(body.trigger ?? '') as AutomationTrigger, condition: body.condition, actions: body.actions, actor: actor(ctx) })
      : setAutomationRuleState({ orgId: ctx.orgId, id, expectedRevision: body.expectedRevision!, action: body.action === 'activate' || body.action === 'archive' ? body.action : 'pause', actor: actor(ctx) });
    return ok(result, { requestId: ctx.requestId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Automation rule could not be updated.';
    const conflict = error instanceof CommitConflictError || /changed after/i.test(message);
    return fail(conflict ? 'CONFLICT' : /disabled|prohibited/i.test(message) ? 'FORBIDDEN' : /not found/i.test(message) ? 'NOT_FOUND' : 'VALIDATION_ERROR', message, { requestId: ctx.requestId });
  }
}
