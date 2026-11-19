import crypto from 'node:crypto';
import { commitBatch, get, list, newId, nowIso, type Doc } from '../db';
import { memberById } from '../team';
import { AUTOMATION_TRIGGERS, type AutomationEventDoc, type AutomationTrigger } from './events';
import { TASK_PRIORITIES, TASK_TYPES, type TaskPriority, type TaskType } from '../tasks';
export type { AutomationTrigger };

export type AutomationCondition =
  | { operator: 'equals' | 'notEquals' | 'contains'; path: string; value: string | number | boolean }
  | { operator: 'answered'; path: string }
  | { operator: 'all'; conditions: AutomationCondition[] }
  | { operator: 'any'; conditions: AutomationCondition[] };

export type AutomationAction =
  | { type: 'create_task'; title: string; taskType: TaskType; priority: TaskPriority; dueMinutes: number; assigneeId?: string }
  | { type: 'internal_notification'; title: string; message: string; severity: 'information' | 'warning' }
  | { type: 'assign_referral_owner'; ownerId: string };

export type AutomationRuleDoc = Doc & {
  orgId: string;
  name: string;
  trigger: AutomationTrigger;
  currentVersion: number;
  activeVersion?: number;
  active: boolean;
  archivedAt?: string;
  createdBy: string;
  updatedBy: string;
  revision: number;
};

export type AutomationRuleVersionDoc = Doc & {
  orgId: string;
  ruleId: string;
  version: number;
  trigger: AutomationTrigger;
  condition?: AutomationCondition;
  actions: AutomationAction[];
  author: string;
  revision: number;
};

export const TRIGGER_CATALOGUE: Record<AutomationTrigger, { label: string; paths: readonly string[] }> = {
  'referral.received': {
    label: 'Referral received',
    paths: ['event.aggregateType', 'event.aggregateId', 'referral.status', 'referral.priority', 'referral.source', 'referral.serviceId', 'referral.locationId', 'referral.practitionerId', 'referral.ownerId'],
  },
  'referral.status_changed': {
    label: 'Referral status changed',
    paths: ['event.aggregateType', 'event.aggregateId', 'referral.from', 'referral.status', 'referral.priority', 'referral.source', 'referral.serviceId', 'referral.locationId', 'referral.practitionerId', 'referral.ownerId'],
  },
  'form.response_submitted': {
    label: 'Form response submitted',
    paths: ['event.aggregateType', 'event.aggregateId', 'form.templateId', 'form.assignmentId', 'form.clientId', 'form.respondentRelationship'],
  },
  'letter.finalised': {
    label: 'Letter finalised',
    paths: ['event.aggregateType', 'event.aggregateId', 'letter.templateId', 'letter.clientId', 'letter.referralId', 'letter.category'],
  },
  'task.due': {
    label: 'Task became due',
    paths: ['event.aggregateType', 'event.aggregateId', 'task.type', 'task.priority', 'task.visibility', 'task.assigneeId', 'task.resourceType'],
  },
};

export const ACTION_CATALOGUE = [
  { type: 'create_task', label: 'Create an administrative task' },
  { type: 'internal_notification', label: 'Create an internal automation notice' },
  { type: 'assign_referral_owner', label: 'Assign an unowned referral' },
] as const;

function digest(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function auditDoc(orgId: string, actor: string, action: string, target: string, detail: string): Doc {
  return { id: newId('aud_'), orgId, actor, action, kind: 'automation', target, detail, at: nowIso() };
}

function cleanName(value: unknown) {
  const name = String(value ?? '').trim();
  if (name.length < 2 || name.length > 140) throw new Error('automation rule name must be 2 to 140 characters');
  return name;
}

function cleanTrigger(value: unknown): AutomationTrigger {
  const trigger = String(value ?? '') as AutomationTrigger;
  if (!(AUTOMATION_TRIGGERS as readonly string[]).includes(trigger)) throw new Error('automation trigger is not allowed');
  return trigger;
}

function primitive(value: unknown): value is string | number | boolean {
  return ['string', 'number', 'boolean'].includes(typeof value) && (typeof value !== 'string' || value.length <= 240);
}

function cleanCondition(trigger: AutomationTrigger, input: unknown): AutomationCondition | undefined {
  if (input === undefined || input === null || input === '') return undefined;
  const seen = new WeakSet<object>();
  let nodes = 0;
  const walk = (value: unknown, depth: number): AutomationCondition => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('automation condition must be an object');
    if (seen.has(value as object)) throw new Error('automation condition cannot contain a cycle');
    seen.add(value as object);
    nodes += 1;
    if (nodes > 50 || depth > 6) throw new Error('automation condition is too complex');
    const row = value as Record<string, unknown>;
    const operator = String(row.operator ?? '');
    const allowedKeys = new Set(operator === 'all' || operator === 'any' ? ['operator', 'conditions'] : operator === 'answered' ? ['operator', 'path'] : ['operator', 'path', 'value']);
    const unsupported = Object.keys(row).find((key) => !allowedKeys.has(key));
    if (unsupported) throw new Error(`unsupported automation condition property ${unsupported}`);
    if (operator === 'all' || operator === 'any') {
      const children = row.conditions;
      if (!Array.isArray(children) || children.length < 1 || children.length > 10) throw new Error(`${operator} requires 1 to 10 conditions`);
      return { operator, conditions: children.map((child) => walk(child, depth + 1)) };
    }
    if (!['equals', 'notEquals', 'contains', 'answered'].includes(operator)) throw new Error('automation condition operator is not allowed');
    const path = String(row.path ?? '');
    if (!TRIGGER_CATALOGUE[trigger].paths.includes(path)) throw new Error(`condition path ${path || '(empty)'} is not allowed for ${trigger}`);
    if (operator === 'answered') return { operator, path };
    if (!primitive(row.value)) throw new Error(`${operator} condition value must be a short string, number or boolean`);
    return { operator: operator as 'equals' | 'notEquals' | 'contains', path, value: row.value };
  };
  return walk(input, 0);
}

function activeMember(orgId: string, value: unknown, label: string) {
  const id = String(value ?? '').trim();
  const member = id ? memberById(orgId, id) : undefined;
  if (!member || member.active === false) throw new Error(`active ${label} not found`);
  return id;
}

function cleanActions(orgId: string, trigger: AutomationTrigger, value: unknown): AutomationAction[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) throw new Error('automation rule requires 1 to 5 allowed actions');
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error(`automation action ${index + 1} must be an object`);
    const row = candidate as Record<string, unknown>;
    const type = String(row.type ?? '');
    if (type === 'create_task') {
      const allowed = new Set(['type', 'title', 'taskType', 'priority', 'dueMinutes', 'assigneeId']);
      const unsupported = Object.keys(row).find((key) => !allowed.has(key));
      if (unsupported) throw new Error(`unsupported create-task property ${unsupported}`);
      const title = String(row.title ?? '').trim();
      if (title.length < 2 || title.length > 180) throw new Error('automated task title must be 2 to 180 characters');
      const taskType = String(row.taskType ?? 'follow_up') as TaskType;
      if (!(TASK_TYPES as readonly string[]).includes(taskType)) throw new Error('automated task type is invalid');
      const priority = String(row.priority ?? 'normal') as TaskPriority;
      if (!(TASK_PRIORITIES as readonly string[]).includes(priority)) throw new Error('automated task priority is invalid');
      const dueMinutes = Number(row.dueMinutes ?? 0);
      if (!Number.isSafeInteger(dueMinutes) || dueMinutes < 0 || dueMinutes > 525_600) throw new Error('automated task due offset must be 0 to 525600 minutes');
      const assigneeId = row.assigneeId ? activeMember(orgId, row.assigneeId, 'task assignee') : undefined;
      return { type, title, taskType, priority, dueMinutes, assigneeId };
    }
    if (type === 'internal_notification') {
      const allowed = new Set(['type', 'title', 'message', 'severity']);
      const unsupported = Object.keys(row).find((key) => !allowed.has(key));
      if (unsupported) throw new Error(`unsupported internal-notification property ${unsupported}`);
      const title = String(row.title ?? '').trim();
      const message = String(row.message ?? '').trim();
      const severity = String(row.severity ?? 'information') as 'information' | 'warning';
      if (title.length < 2 || title.length > 160) throw new Error('notification title must be 2 to 160 characters');
      if (message.length < 2 || message.length > 500) throw new Error('notification message must be 2 to 500 characters');
      if (!['information', 'warning'].includes(severity)) throw new Error('notification severity is invalid');
      return { type, title, message, severity };
    }
    if (type === 'assign_referral_owner') {
      const allowed = new Set(['type', 'ownerId']);
      const unsupported = Object.keys(row).find((key) => !allowed.has(key));
      if (unsupported) throw new Error(`unsupported referral-owner property ${unsupported}`);
      if (!trigger.startsWith('referral.')) throw new Error('referral ownership can be automated only by a referral trigger');
      return { type, ownerId: activeMember(orgId, row.ownerId, 'referral owner') };
    }
    throw new Error(`automation action ${type || '(empty)'} is not allowed`);
  });
}

function contextFor(event: AutomationEventDoc) {
  return { ...event.payload, event: { trigger: event.trigger, aggregateType: event.aggregateType, aggregateId: event.aggregateId } } as Record<string, unknown>;
}

function pathValue(context: Record<string, unknown>, path: string) {
  let value: unknown = context;
  for (const part of path.split('.')) {
    if (['__proto__', 'prototype', 'constructor'].includes(part) || !value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

export function evaluateAutomationCondition(condition: AutomationCondition | undefined, event: AutomationEventDoc): boolean {
  if (!condition) return true;
  if (condition.operator === 'all' || condition.operator === 'any') {
    return condition.operator === 'all'
      ? condition.conditions.every((child) => evaluateAutomationCondition(child, event))
      : condition.conditions.some((child) => evaluateAutomationCondition(child, event));
  }
  const value = pathValue(contextFor(event), condition.path);
  if (condition.operator === 'answered') return value !== undefined && value !== null && value !== '' && (!Array.isArray(value) || value.length > 0);
  if (condition.operator === 'equals') return value === condition.value;
  if (condition.operator === 'notEquals') return value !== condition.value;
  if (condition.operator === 'contains') return typeof value === 'string' ? value.includes(String(condition.value)) : Array.isArray(value) ? value.includes(condition.value) : false;
  return false;
}

export function automationRuleById(orgId: string, id: string) {
  const row = get<AutomationRuleDoc>('automationRules', id);
  return row?.orgId === orgId ? row : undefined;
}

export function automationRuleVersion(orgId: string, ruleId: string, version?: number) {
  const rule = automationRuleById(orgId, ruleId);
  if (!rule) return undefined;
  const wanted = version ?? rule.currentVersion;
  return list<AutomationRuleVersionDoc>('automationRuleVersions', (row) => row.orgId === orgId && row.ruleId === ruleId && row.version === wanted)[0];
}

export function automationRulesFor(orgId: string, includeArchived = false) {
  return list<AutomationRuleDoc>('automationRules', (row) => row.orgId === orgId && (includeArchived || !row.archivedAt))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function activeAutomationRules(orgId: string, trigger: AutomationTrigger) {
  return automationRulesFor(orgId).filter((rule) => rule.active && rule.activeVersion && rule.trigger === trigger);
}

export function createAutomationRule(input: {
  orgId: string; name: string; trigger: AutomationTrigger; condition?: unknown; actions: unknown; actor: string;
}) {
  const id = newId('auto_');
  const trigger = cleanTrigger(input.trigger);
  const at = nowIso();
  const rule: AutomationRuleDoc = {
    id, orgId: input.orgId, name: cleanName(input.name), trigger, currentVersion: 1,
    active: false, createdBy: input.actor, updatedBy: input.actor, revision: 0, createdAt: at,
  };
  const version: AutomationRuleVersionDoc = {
    id: `arv_${digest(`${id}:1`)}`, orgId: input.orgId, ruleId: id, version: 1, trigger,
    condition: cleanCondition(trigger, input.condition), actions: cleanActions(input.orgId, trigger, input.actions),
    author: input.actor, revision: 0, createdAt: at,
  };
  const rows = commitBatch({ upserts: [
    { collection: 'automationRules', doc: rule, expectedRevision: null, expectedOrgId: input.orgId },
    { collection: 'automationRuleVersions', doc: version, expectedRevision: null, expectedOrgId: input.orgId },
    { collection: 'audit', doc: auditDoc(input.orgId, input.actor, 'automation.created', id, trigger), expectedRevision: null, expectedOrgId: input.orgId },
  ] }).upserts;
  return { rule: rows.find((row) => row.id === id) as AutomationRuleDoc, version: rows.find((row) => row.id === version.id) as AutomationRuleVersionDoc };
}

export function reviseAutomationRule(input: {
  orgId: string; id: string; expectedRevision: number; name?: string; trigger: AutomationTrigger;
  condition?: unknown; actions: unknown; actor: string;
}) {
  const rule = automationRuleById(input.orgId, input.id);
  if (!rule) throw new Error('automation rule not found');
  if (rule.archivedAt) throw new Error('archived automation rules cannot be revised');
  if (Number(rule.revision ?? 0) !== input.expectedRevision) throw new Error('automation rule changed after it was loaded');
  const trigger = cleanTrigger(input.trigger);
  if (rule.active && trigger !== rule.trigger) throw new Error('pause the automation rule before changing its trigger');
  const number = rule.currentVersion + 1;
  const version: AutomationRuleVersionDoc = {
    id: `arv_${digest(`${rule.id}:${number}`)}`, orgId: input.orgId, ruleId: rule.id, version: number, trigger,
    condition: cleanCondition(trigger, input.condition), actions: cleanActions(input.orgId, trigger, input.actions),
    author: input.actor, revision: 0, createdAt: nowIso(),
  };
  const next: AutomationRuleDoc = { ...rule, name: input.name === undefined ? rule.name : cleanName(input.name), trigger, currentVersion: number, updatedBy: input.actor };
  const rows = commitBatch({ upserts: [
    { collection: 'automationRules', doc: next, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId },
    { collection: 'automationRuleVersions', doc: version, expectedRevision: null, expectedOrgId: input.orgId },
    { collection: 'audit', doc: auditDoc(input.orgId, input.actor, 'automation.revised', rule.id, `version ${number}; active version ${rule.activeVersion ?? 'none'}`), expectedRevision: null, expectedOrgId: input.orgId },
  ] }).upserts;
  return { rule: rows.find((row) => row.id === rule.id) as AutomationRuleDoc, version: rows.find((row) => row.id === version.id) as AutomationRuleVersionDoc };
}

export function setAutomationRuleState(input: { orgId: string; id: string; expectedRevision: number; action: 'activate' | 'pause' | 'archive'; actor: string }) {
  const rule = automationRuleById(input.orgId, input.id);
  if (!rule) throw new Error('automation rule not found');
  if (Number(rule.revision ?? 0) !== input.expectedRevision) throw new Error('automation rule changed after it was loaded');
  if (rule.archivedAt) throw new Error('automation rule is archived');
  if (input.action === 'activate' && !automationRuleVersion(input.orgId, rule.id, rule.currentVersion)) throw new Error('current automation rule version not found');
  const at = nowIso();
  const next: AutomationRuleDoc = {
    ...rule,
    active: input.action === 'activate',
    activeVersion: input.action === 'activate' ? rule.currentVersion : rule.activeVersion,
    archivedAt: input.action === 'archive' ? at : undefined,
    updatedBy: input.actor,
  };
  return commitBatch({ upserts: [
    { collection: 'automationRules', doc: next, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId },
    { collection: 'audit', doc: auditDoc(input.orgId, input.actor, `automation.${input.action}`, rule.id, input.action === 'activate' ? `version ${rule.currentVersion}` : input.action), expectedRevision: null, expectedOrgId: input.orgId },
  ] }).upserts.find((row) => row.id === rule.id) as AutomationRuleDoc;
}

export function automationCatalogue() {
  return {
    triggers: AUTOMATION_TRIGGERS.map((id) => ({ id, ...TRIGGER_CATALOGUE[id] })),
    actions: ACTION_CATALOGUE,
    conditionOperators: ['equals', 'notEquals', 'contains', 'answered', 'all', 'any'],
    limits: { conditionDepth: 6, conditionNodes: 50, actions: 5, loopDepth: 4 },
    prohibited: ['arbitrary code', 'sign clinical note', 'submit claim', 'refund payment', 'deny care', 'infer urgency'],
  };
}
