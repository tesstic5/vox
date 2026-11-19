import crypto from 'node:crypto';
import { CommitConflictError, commitBatch, get, list, newId, nowIso, type Doc } from './db';
import { domainJobDraft, type DomainJobDoc } from './domain-jobs';
import { memberById } from './team';
import { automationEventWrites } from './automations/events';

export const TASK_TYPES = ['general', 'follow_up', 'form_review', 'referral_review', 'letter_review', 'reminder'] as const;
export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const TASK_STATES = ['open', 'in_progress', 'completed', 'cancelled'] as const;
export const TASK_VISIBILITIES = ['administrative', 'clinical'] as const;
export const TASK_RESOURCE_TYPES = ['workspace', 'client', 'referral', 'form_assignment', 'form_response', 'letter'] as const;

export type TaskType = (typeof TASK_TYPES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type TaskState = (typeof TASK_STATES)[number];
export type TaskVisibility = (typeof TASK_VISIBILITIES)[number];
export type TaskResourceType = (typeof TASK_RESOURCE_TYPES)[number];

export type TaskDoc = Doc & {
  orgId: string;
  title: string;
  description?: string;
  type: TaskType;
  priority: TaskPriority;
  state: TaskState;
  visibility: TaskVisibility;
  resourceType: TaskResourceType;
  resourceId: string;
  patientId?: string;
  assigneeId?: string;
  dueAt?: string;
  completedAt?: string;
  completedBy?: string;
  cancelledAt?: string;
  cancelledBy?: string;
  automationDepth?: number;
  automationOriginRunId?: string;
  createdBy: string;
  updatedBy: string;
  revision: number;
};

const TRANSITIONS: Record<TaskState, TaskState[]> = {
  open: ['in_progress', 'completed', 'cancelled'],
  in_progress: ['open', 'completed', 'cancelled'],
  completed: ['open'],
  cancelled: ['open'],
};

function digest(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function auditDoc(orgId: string, actor: string, action: string, target: string, detail: string): Doc {
  return { id: newId('aud_'), orgId, actor, action, kind: 'task', target, detail, at: nowIso() };
}

function cleanEnum<T extends string>(value: unknown, allowed: readonly T[], label: string, fallback?: T): T {
  const candidate = String(value ?? fallback ?? '') as T;
  if (!allowed.includes(candidate)) throw new Error(`${label} is invalid`);
  return candidate;
}

function cleanDate(value: unknown, label: string) {
  if (value === undefined || value === null || value === '') return undefined;
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} must be a valid date and time`);
  if (date.getTime() > Date.now() + 5 * 366 * 24 * 60 * 60_000) throw new Error(`${label} cannot be more than five years ahead`);
  return date.toISOString();
}

function resource(orgId: string, type: TaskResourceType, rawId: unknown) {
  const resourceId = type === 'workspace' ? orgId : String(rawId ?? '').trim();
  if (!resourceId) throw new Error('task resource id is required');
  if (type === 'workspace') return { resourceId, patientId: undefined };
  const collection: Record<Exclude<TaskResourceType, 'workspace'>, string> = {
    client: 'clients', referral: 'referrals', form_assignment: 'formAssignments', form_response: 'formResponses', letter: 'letters',
  };
  const row = get<Doc>(collection[type], resourceId);
  if (!row || row.orgId !== orgId) throw new Error('task resource was not found in this workspace');
  const patientId = type === 'client' ? row.id : String(row.clientId ?? row.convertedClientId ?? '') || undefined;
  return { resourceId, patientId };
}

function dueJob(task: TaskDoc) {
  if (!task.dueAt || ['completed', 'cancelled'].includes(task.state)) return undefined;
  const id = `job_task_due_${digest(`${task.orgId}:${task.id}:${task.dueAt}`)}`;
  if (get<DomainJobDoc>('domainJobs', id)) return undefined;
  return domainJobDraft({
    id,
    orgId: task.orgId,
    type: 'task.due',
    payload: { taskId: task.id, dueAt: task.dueAt, depth: Number(task.automationDepth ?? 0) },
    dedupeKey: `task.due:${task.id}:${task.dueAt}`,
    maxAttempts: 4,
    runAt: task.dueAt,
  });
}

function validateAssignee(orgId: string, assigneeId: unknown) {
  const id = String(assigneeId ?? '').trim() || undefined;
  if (!id) return undefined;
  const member = memberById(orgId, id);
  if (!member || member.active === false) throw new Error('active task assignee not found');
  return id;
}

export function taskById(orgId: string, id: string) {
  const row = get<TaskDoc>('tasks', id);
  return row?.orgId === orgId ? row : undefined;
}

export function tasksFor(orgId: string, filter: {
  state?: TaskState; assigneeId?: string; resourceType?: TaskResourceType; resourceId?: string;
  visibility?: TaskVisibility; overdue?: boolean; q?: string;
} = {}) {
  const now = Date.now();
  const q = String(filter.q ?? '').trim().toLowerCase();
  return list<TaskDoc>('tasks', (row) => row.orgId === orgId
    && (!filter.state || row.state === filter.state)
    && (!filter.assigneeId || row.assigneeId === filter.assigneeId)
    && (!filter.resourceType || row.resourceType === filter.resourceType)
    && (!filter.resourceId || row.resourceId === filter.resourceId)
    && (!filter.visibility || row.visibility === filter.visibility)
    && (!filter.overdue || Boolean(row.dueAt && Date.parse(row.dueAt) < now && !['completed', 'cancelled'].includes(row.state)))
    && (!q || `${row.title} ${row.description ?? ''} ${row.resourceType} ${row.resourceId}`.toLowerCase().includes(q)))
    .sort((a, b) => {
      const terminalA = ['completed', 'cancelled'].includes(a.state) ? 1 : 0;
      const terminalB = ['completed', 'cancelled'].includes(b.state) ? 1 : 0;
      if (terminalA !== terminalB) return terminalA - terminalB;
      const dueA = a.dueAt ?? '9999'; const dueB = b.dueAt ?? '9999';
      return dueA.localeCompare(dueB) || String(b.createdAt).localeCompare(String(a.createdAt));
    });
}

export function createTask(input: {
  orgId: string; title: string; description?: string; type?: TaskType; priority?: TaskPriority;
  visibility?: TaskVisibility; resourceType?: TaskResourceType; resourceId?: string; assigneeId?: string;
  dueAt?: string; actor: string; id?: string; automationDepth?: number; automationOriginRunId?: string;
}) {
  const id = input.id ?? newId('tsk_');
  const existing = taskById(input.orgId, id);
  if (existing) {
    if (input.automationOriginRunId && existing.automationOriginRunId === input.automationOriginRunId) return existing;
    throw new Error('task id is already in use');
  }
  const title = input.title.trim();
  if (title.length < 2 || title.length > 180) throw new Error('task title must be 2 to 180 characters');
  const description = input.description?.trim().slice(0, 4_000) || undefined;
  const type = cleanEnum(input.type, TASK_TYPES, 'task type', 'general');
  const priority = cleanEnum(input.priority, TASK_PRIORITIES, 'task priority', 'normal');
  const visibility = cleanEnum(input.visibility, TASK_VISIBILITIES, 'task visibility', 'administrative');
  const resourceType = cleanEnum(input.resourceType, TASK_RESOURCE_TYPES, 'task resource type', 'workspace');
  const resolved = resource(input.orgId, resourceType, input.resourceId);
  const dueAt = cleanDate(input.dueAt, 'task due date');
  const at = nowIso();
  const task: TaskDoc = {
    id, orgId: input.orgId, title, description, type, priority, state: 'open', visibility,
    resourceType, resourceId: resolved.resourceId, patientId: resolved.patientId,
    assigneeId: validateAssignee(input.orgId, input.assigneeId), dueAt,
    automationDepth: Math.max(0, Math.min(100, Math.trunc(input.automationDepth ?? 0))) || undefined,
    automationOriginRunId: input.automationOriginRunId,
    createdBy: input.actor, updatedBy: input.actor, revision: 0, createdAt: at,
  };
  const job = dueJob(task);
  const committed = commitBatch({ upserts: [
    { collection: 'tasks', doc: task, expectedRevision: null, expectedOrgId: input.orgId },
    { collection: 'audit', doc: auditDoc(input.orgId, input.actor, 'task.created', id, `${type}:${resourceType}`), expectedRevision: null, expectedOrgId: input.orgId },
    ...(job ? [{ collection: 'domainJobs', doc: job as Doc, expectedRevision: null, expectedOrgId: input.orgId }] : []),
  ] });
  return committed.upserts.find((row) => row.id === id) as TaskDoc;
}

export function updateTask(input: {
  orgId: string; id: string; expectedRevision: number; actor: string;
  patch: Partial<Pick<TaskDoc, 'title' | 'description' | 'type' | 'priority' | 'visibility' | 'assigneeId' | 'dueAt'>>;
}) {
  const task = taskById(input.orgId, input.id);
  if (!task) throw new Error('task not found');
  if (Number(task.revision ?? 0) !== input.expectedRevision) throw new Error('task changed after it was loaded');
  if (['completed', 'cancelled'].includes(task.state)) throw new Error(`a ${task.state} task must be reopened before editing`);
  const title = input.patch.title === undefined ? task.title : input.patch.title.trim();
  if (title.length < 2 || title.length > 180) throw new Error('task title must be 2 to 180 characters');
  const next: TaskDoc = {
    ...task,
    title,
    description: input.patch.description === undefined ? task.description : input.patch.description?.trim().slice(0, 4_000) || undefined,
    type: input.patch.type === undefined ? task.type : cleanEnum(input.patch.type, TASK_TYPES, 'task type'),
    priority: input.patch.priority === undefined ? task.priority : cleanEnum(input.patch.priority, TASK_PRIORITIES, 'task priority'),
    visibility: input.patch.visibility === undefined ? task.visibility : cleanEnum(input.patch.visibility, TASK_VISIBILITIES, 'task visibility'),
    assigneeId: input.patch.assigneeId === undefined ? task.assigneeId : validateAssignee(input.orgId, input.patch.assigneeId),
    dueAt: input.patch.dueAt === undefined ? task.dueAt : cleanDate(input.patch.dueAt, 'task due date'),
    updatedBy: input.actor,
  };
  const job = dueJob(next);
  const rows = commitBatch({ upserts: [
    { collection: 'tasks', doc: next, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId },
    { collection: 'audit', doc: auditDoc(input.orgId, input.actor, 'task.updated', task.id, Object.keys(input.patch).join(', ')), expectedRevision: null, expectedOrgId: input.orgId },
    ...(job ? [{ collection: 'domainJobs', doc: job as Doc, expectedRevision: null, expectedOrgId: input.orgId }] : []),
  ] }).upserts;
  return rows.find((row) => row.id === task.id) as TaskDoc;
}

export function transitionTask(input: { orgId: string; id: string; to: TaskState; expectedRevision: number; actor: string }) {
  const task = taskById(input.orgId, input.id);
  if (!task) throw new Error('task not found');
  if (Number(task.revision ?? 0) !== input.expectedRevision) throw new Error('task changed after it was loaded');
  if (!TRANSITIONS[task.state].includes(input.to)) throw new Error(`task cannot move from ${task.state} to ${input.to}`);
  const at = nowIso();
  const next: TaskDoc = {
    ...task, state: input.to, updatedBy: input.actor,
    completedAt: input.to === 'completed' ? at : undefined,
    completedBy: input.to === 'completed' ? input.actor : undefined,
    cancelledAt: input.to === 'cancelled' ? at : undefined,
    cancelledBy: input.to === 'cancelled' ? input.actor : undefined,
  };
  const job = input.to === 'open' ? dueJob(next) : undefined;
  const rows = commitBatch({ upserts: [
    { collection: 'tasks', doc: next, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId },
    { collection: 'audit', doc: auditDoc(input.orgId, input.actor, `task.${input.to}`, task.id, `${task.state} → ${input.to}`), expectedRevision: null, expectedOrgId: input.orgId },
    ...(job ? [{ collection: 'domainJobs', doc: job as Doc, expectedRevision: null, expectedOrgId: input.orgId }] : []),
  ] }).upserts;
  return rows.find((row) => row.id === task.id) as TaskDoc;
}

export function runTaskDueJob(job: DomainJobDoc) {
  const taskId = String(job.payload.taskId ?? '');
  const dueAt = String(job.payload.dueAt ?? '');
  const task = taskById(job.orgId, taskId);
  if (!task || task.dueAt !== dueAt || ['completed', 'cancelled'].includes(task.state)) return;
  const writes = automationEventWrites({
    orgId: task.orgId,
    trigger: 'task.due',
    aggregateType: 'task',
    aggregateId: task.id,
    sourceEventId: `${task.id}:${dueAt}`,
    depth: Number(job.payload.depth ?? task.automationDepth ?? 0),
    occurredAt: dueAt,
    payload: { task: { type: task.type, priority: task.priority, visibility: task.visibility, assigneeId: task.assigneeId ?? '', resourceType: task.resourceType } },
  });
  try { commitBatch({ upserts: writes }); }
  catch (error) {
    if (!(error instanceof CommitConflictError)) throw error;
    const eventId = (writes[0].doc as Doc).id;
    if (!get<Doc>('automationEvents', eventId)) throw error;
  }
}
