import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { requireClinicalWriteMode } from '@/lib/server/clinical-readiness';
import {
  createTask, tasksFor,
  TASK_PRIORITIES, TASK_RESOURCE_TYPES, TASK_STATES, TASK_TYPES, TASK_VISIBILITIES,
  type TaskPriority, type TaskResourceType, type TaskState, type TaskType, type TaskVisibility,
} from '@/lib/server/tasks';
import { CommitConflictError } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const actor = (ctx: Exclude<Awaited<ReturnType<typeof requireAuth>>, NextResponse>) => ctx.user?.email ?? ctx.key?.id ?? 'api';

function oneOf<T extends string>(value: string | null, allowed: readonly T[]) {
  return value && (allowed as readonly string[]).includes(value) ? value as T : undefined;
}

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['tasks:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'tasks.read');
  if (denied) return denied;
  const url = new URL(req.url);
  const data = tasksFor(ctx.orgId, {
    state: oneOf(url.searchParams.get('state'), TASK_STATES),
    assigneeId: url.searchParams.get('assigneeId') ?? undefined,
    resourceType: oneOf(url.searchParams.get('resourceType'), TASK_RESOURCE_TYPES),
    resourceId: url.searchParams.get('resourceId') ?? undefined,
    visibility: oneOf(url.searchParams.get('visibility'), TASK_VISIBILITIES),
    overdue: url.searchParams.get('overdue') === 'true',
    q: url.searchParams.get('q') ?? undefined,
  }).filter((task) => task.visibility !== 'clinical' || !requirePermission(ctx, 'clinical.read', { area: 'clinical', patientId: task.patientId }));
  return ok({ object: 'list', data, total: data.length }, { requestId: ctx.requestId, headers: { 'cache-control': 'no-store' } });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['tasks:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'tasks.write');
  if (denied) return denied;
  const body = await readJson<{
    title?: string; description?: string; type?: TaskType; priority?: TaskPriority; visibility?: TaskVisibility;
    resourceType?: TaskResourceType; resourceId?: string; assigneeId?: string; dueAt?: string;
  }>(req, 64 * 1024);
  if (body instanceof NextResponse) return body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('VALIDATION_ERROR', 'Task body must be an object.', { param: 'body', requestId: ctx.requestId });
  const unsupported = Object.keys(body).find((key) => !['title', 'description', 'type', 'priority', 'visibility', 'resourceType', 'resourceId', 'assigneeId', 'dueAt'].includes(key));
  if (unsupported) return fail('VALIDATION_ERROR', `Task property ${unsupported} cannot be changed.`, { param: unsupported, requestId: ctx.requestId });
  if (body.visibility === 'clinical') {
    const clinicalDenied = requirePermission(ctx, 'clinical.write', { area: 'clinical' });
    if (clinicalDenied) return clinicalDenied;
  }
  try {
    if ((body.resourceType && body.resourceType !== 'workspace') || body.visibility === 'clinical') {
      requireClinicalWriteMode(ctx.orgId, req.headers.get('x-voxera-synthetic-data') === '1');
    }
    const task = createTask({
      orgId: ctx.orgId, title: String(body.title ?? ''), description: body.description,
      type: body.type, priority: body.priority, visibility: body.visibility,
      resourceType: body.resourceType, resourceId: body.resourceId,
      assigneeId: body.assigneeId, dueAt: body.dueAt, actor: actor(ctx),
    });
    return ok(task, { requestId: ctx.requestId, status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Task could not be created.';
    const conflict = error instanceof CommitConflictError || /already in use|changed after/i.test(message);
    return fail(conflict ? 'CONFLICT' : /disabled|prohibited/i.test(message) ? 'FORBIDDEN' : 'VALIDATION_ERROR', message, { requestId: ctx.requestId });
  }
}
