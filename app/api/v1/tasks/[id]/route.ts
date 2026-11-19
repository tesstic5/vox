import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { requireClinicalWriteMode } from '@/lib/server/clinical-readiness';
import { taskById, transitionTask, updateTask, type TaskDoc, type TaskState } from '@/lib/server/tasks';
import { CommitConflictError } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const actor = (ctx: Exclude<Awaited<ReturnType<typeof requireAuth>>, NextResponse>) => ctx.user?.email ?? ctx.key?.id ?? 'api';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['tasks:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'tasks.read');
  if (denied) return denied;
  const task = taskById(ctx.orgId, id);
  if (!task) return fail('NOT_FOUND', 'Task not found.', { requestId: ctx.requestId });
  if (task.visibility === 'clinical') {
    const clinicalDenied = requirePermission(ctx, 'clinical.read', { area: 'clinical', patientId: task.patientId });
    if (clinicalDenied) return clinicalDenied;
  }
  return ok(task, { requestId: ctx.requestId, headers: { 'cache-control': 'no-store' } });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['tasks:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'tasks.write');
  if (denied) return denied;
  const current = taskById(ctx.orgId, id);
  if (!current) return fail('NOT_FOUND', 'Task not found.', { requestId: ctx.requestId });
  const body = await readJson<{
    action?: 'update' | 'transition'; expectedRevision?: number; to?: TaskState;
    patch?: Partial<Pick<TaskDoc, 'title' | 'description' | 'type' | 'priority' | 'visibility' | 'assigneeId' | 'dueAt'>>;
  }>(req, 64 * 1024);
  if (body instanceof NextResponse) return body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('VALIDATION_ERROR', 'Task update body must be an object.', { param: 'body', requestId: ctx.requestId });
  const unsupported = Object.keys(body).find((key) => !['action', 'expectedRevision', 'to', 'patch'].includes(key));
  if (unsupported) return fail('VALIDATION_ERROR', `Task update property ${unsupported} is not supported.`, { param: unsupported, requestId: ctx.requestId });
  if (body.action !== 'update' && body.action !== 'transition') return fail('VALIDATION_ERROR', 'Task action must be update or transition.', { param: 'action', requestId: ctx.requestId });
  if (body.action === 'update') {
    if (!body.patch || typeof body.patch !== 'object' || Array.isArray(body.patch)) return fail('VALIDATION_ERROR', 'Task patch must be an object.', { param: 'patch', requestId: ctx.requestId });
    const unsupportedPatch = Object.keys(body.patch).find((key) => !['title', 'description', 'type', 'priority', 'visibility', 'assigneeId', 'dueAt'].includes(key));
    if (unsupportedPatch) return fail('VALIDATION_ERROR', `Task property ${unsupportedPatch} cannot be changed.`, { param: unsupportedPatch, requestId: ctx.requestId });
  }
  const clinical = current.visibility === 'clinical' || body.patch?.visibility === 'clinical';
  if (clinical) {
    const clinicalDenied = requirePermission(ctx, 'clinical.write', { area: 'clinical', patientId: current.patientId });
    if (clinicalDenied) return clinicalDenied;
  }
  if (!Number.isSafeInteger(body.expectedRevision)) return fail('VALIDATION_ERROR', 'expectedRevision is required.', { param: 'expectedRevision', requestId: ctx.requestId });
  try {
    if (current.resourceType !== 'workspace' || clinical) {
      requireClinicalWriteMode(ctx.orgId, req.headers.get('x-voxera-synthetic-data') === '1');
    }
    const task = body.action === 'transition'
      ? transitionTask({ orgId: ctx.orgId, id, to: String(body.to ?? '') as TaskState, expectedRevision: body.expectedRevision!, actor: actor(ctx) })
      : updateTask({ orgId: ctx.orgId, id, expectedRevision: body.expectedRevision!, actor: actor(ctx), patch: body.patch ?? {} });
    return ok(task, { requestId: ctx.requestId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Task could not be updated.';
    const conflict = error instanceof CommitConflictError || /changed after/i.test(message);
    return fail(conflict ? 'CONFLICT' : /disabled|prohibited/i.test(message) ? 'FORBIDDEN' : /not found/i.test(message) ? 'NOT_FOUND' : 'VALIDATION_ERROR', message, { requestId: ctx.requestId });
  }
}
