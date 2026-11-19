import crypto from 'node:crypto';
import { CommitConflictError, commitBatch, get, list, newId, nowIso, type Doc } from '../db';
import type { DeadLetterDoc, DomainJobDoc } from '../domain-jobs';
import { createTask } from '../tasks';
import { referralById, updateReferral } from '../referrals';
import {
  activeAutomationRules,
  automationRuleById,
  automationRuleVersion,
  evaluateAutomationCondition,
  TRIGGER_CATALOGUE,
  type AutomationAction,
  type AutomationRuleDoc,
  type AutomationRuleVersionDoc,
} from './catalogue';
import {
  AUTOMATION_AGGREGATE_FOR_TRIGGER,
  automationEventDraft,
  type AutomationEventDoc,
} from './events';

export type AutomationActionResult = {
  index: number;
  type: AutomationAction['type'];
  status: 'completed' | 'skipped';
  resourceId?: string;
  detail: string;
};

export type AutomationRunDoc = Doc & {
  orgId: string;
  ruleId: string;
  ruleVersion: number;
  eventId: string;
  trigger: string;
  idempotencyKey: string;
  state: 'running' | 'completed' | 'skipped' | 'failed' | 'dead_letter';
  attempts: number;
  leaseUntil?: string;
  actionResults: AutomationActionResult[];
  startedAt: string;
  lastAttemptAt?: string;
  completedAt?: string;
  lastError?: string;
  revision: number;
};

export type AutomationNotificationDoc = Doc & {
  orgId: string;
  ruleId: string;
  runId: string;
  title: string;
  message: string;
  severity: 'information' | 'warning';
  readAt?: string;
  readBy?: string;
  dismissedAt?: string;
  dismissedBy?: string;
  revision: number;
};

const MAX_LOOP_DEPTH = 4;
const TERMINAL = new Set<AutomationRunDoc['state']>(['completed', 'skipped', 'dead_letter']);

function digest(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function safeError(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[phone]')
    .slice(0, 1_000);
}

export function automationRunById(orgId: string, id: string) {
  const row = get<AutomationRunDoc>('automationRuns', id);
  return row?.orgId === orgId ? row : undefined;
}

export function automationRunsFor(orgId: string, filter: { ruleId?: string; state?: AutomationRunDoc['state']; limit?: number } = {}) {
  return list<AutomationRunDoc>('automationRuns', (row) => row.orgId === orgId && (!filter.ruleId || row.ruleId === filter.ruleId) && (!filter.state || row.state === filter.state))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, Math.max(1, Math.min(500, filter.limit ?? 100)));
}

export function automationNotificationById(orgId: string, id: string) {
  const row = get<AutomationNotificationDoc>('automationNotifications', id);
  return row?.orgId === orgId ? row : undefined;
}

export function automationNotificationsFor(orgId: string, limit = 100, includeDismissed = false) {
  return list<AutomationNotificationDoc>('automationNotifications', (row) => row.orgId === orgId && (includeDismissed || !row.dismissedAt))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.max(1, Math.min(500, limit)));
}

export function updateAutomationNotification(input: {
  orgId: string;
  id: string;
  expectedRevision: number;
  action: 'read' | 'dismiss';
  actor: string;
}) {
  const row = automationNotificationById(input.orgId, input.id);
  if (!row) throw new Error('automation notification not found');
  if (Number(row.revision ?? 0) !== input.expectedRevision) throw new Error('automation notification changed after it was loaded');
  if (row.dismissedAt) throw new Error('automation notification is already dismissed');
  const at = nowIso();
  const next: AutomationNotificationDoc = input.action === 'dismiss'
    ? {
        ...row,
        readAt: row.readAt ?? at,
        readBy: row.readBy ?? input.actor,
        dismissedAt: at,
        dismissedBy: input.actor,
      }
    : { ...row, readAt: row.readAt ?? at, readBy: row.readBy ?? input.actor };
  if (input.action === 'read' && row.readAt) return row;
  const committed = commitBatch({ upserts: [
    {
      collection: 'automationNotifications',
      doc: next,
      expectedRevision: input.expectedRevision,
      expectedOrgId: input.orgId,
    },
    {
      collection: 'audit',
      doc: {
        id: newId('aud_'),
        orgId: input.orgId,
        actor: input.actor,
        action: `automation.notification_${input.action === 'read' ? 'read' : 'dismissed'}`,
        kind: 'automation',
        target: row.id,
        detail: input.action === 'read' ? 'internal automation notice marked read' : 'internal automation notice dismissed',
        at,
      },
      expectedRevision: null,
      expectedOrgId: input.orgId,
    },
  ] }).upserts;
  return committed.find((candidate) => candidate.id === row.id) as AutomationNotificationDoc;
}

function runIdentity(rule: AutomationRuleDoc, version: number, event: AutomationEventDoc) {
  const idempotencyKey = `${rule.id}:v${version}:${event.id}`;
  return { idempotencyKey, id: `arun_${digest(`${event.orgId}:${idempotencyKey}`)}` };
}

function claimRun(rule: AutomationRuleDoc, version: AutomationRuleVersionDoc, event: AutomationEventDoc): { run: AutomationRunDoc; claimed: boolean } {
  const identity = runIdentity(rule, version.version, event);
  const existing = automationRunById(event.orgId, identity.id);
  const now = Date.now();
  if (existing) {
    if (TERMINAL.has(existing.state)) return { run: existing, claimed: false };
    if (existing.state === 'running' && existing.leaseUntil && Date.parse(existing.leaseUntil) > now) return { run: existing, claimed: false };
    const next: AutomationRunDoc = {
      ...existing,
      state: 'running', attempts: existing.attempts + 1, leaseUntil: new Date(now + 5 * 60_000).toISOString(),
      lastError: undefined, lastAttemptAt: nowIso(),
    };
    try {
      const committed = commitBatch({ upserts: [{ collection: 'automationRuns', doc: next, expectedRevision: Number(existing.revision ?? 0), expectedOrgId: event.orgId }] }).upserts[0] as AutomationRunDoc;
      return { run: committed, claimed: true };
    } catch (error) {
      if (!(error instanceof CommitConflictError)) throw error;
      return { run: automationRunById(event.orgId, identity.id) ?? existing, claimed: false };
    }
  }
  const at = nowIso();
  const run: AutomationRunDoc = {
    id: identity.id, orgId: event.orgId, ruleId: rule.id, ruleVersion: version.version,
    eventId: event.id, trigger: event.trigger, idempotencyKey: identity.idempotencyKey,
    state: 'running', attempts: 1, leaseUntil: new Date(now + 5 * 60_000).toISOString(),
    actionResults: [], startedAt: at, lastAttemptAt: at, revision: 0, createdAt: at,
  };
  try {
    return { run: commitBatch({ upserts: [{ collection: 'automationRuns', doc: run, expectedRevision: null, expectedOrgId: event.orgId }] }).upserts[0] as AutomationRunDoc, claimed: true };
  } catch (error) {
    if (!(error instanceof CommitConflictError)) throw error;
    return { run: automationRunById(event.orgId, identity.id) ?? run, claimed: false };
  }
}

function finishRun(run: AutomationRunDoc, state: AutomationRunDoc['state'], actionResults: AutomationActionResult[], error?: string) {
  return commitBatch({ upserts: [{
    collection: 'automationRuns',
    doc: { ...run, state, actionResults, completedAt: nowIso(), leaseUntil: undefined, lastError: error },
    expectedRevision: Number(run.revision ?? 0), expectedOrgId: run.orgId,
  }] }).upserts[0] as AutomationRunDoc;
}

function actionResource(event: AutomationEventDoc) {
  if (event.aggregateType === 'referral') return { resourceType: 'referral' as const, resourceId: event.aggregateId };
  if (event.aggregateType === 'form_response') return { resourceType: 'form_response' as const, resourceId: event.aggregateId };
  if (event.aggregateType === 'letter') return { resourceType: 'letter' as const, resourceId: event.aggregateId };
  return { resourceType: 'workspace' as const, resourceId: event.orgId };
}

function executeAction(input: { action: AutomationAction; index: number; event: AutomationEventDoc; run: AutomationRunDoc }): AutomationActionResult {
  const { action, index, event, run } = input;
  if (action.type === 'create_task') {
    const id = `tsk_auto_${digest(`${run.id}:${index}`)}`;
    const dueAt = new Date(Date.parse(event.occurredAt) + action.dueMinutes * 60_000).toISOString();
    const task = createTask({
      orgId: event.orgId, id, title: action.title, type: action.taskType, priority: action.priority,
      visibility: 'administrative', ...actionResource(event), assigneeId: action.assigneeId,
      dueAt, actor: `automation:${run.ruleId}`, automationDepth: event.depth + 1, automationOriginRunId: run.id,
    });
    return { index, type: action.type, status: 'completed', resourceId: task.id, detail: 'administrative task created' };
  }
  if (action.type === 'internal_notification') {
    const id = `anot_${digest(`${run.id}:${index}`)}`;
    const existing = get<AutomationNotificationDoc>('automationNotifications', id);
    if (!existing) {
      const row: AutomationNotificationDoc = {
        id, orgId: event.orgId, ruleId: run.ruleId, runId: run.id,
        title: action.title, message: action.message, severity: action.severity,
        revision: 0, createdAt: nowIso(),
      };
      try { commitBatch({ upserts: [{ collection: 'automationNotifications', doc: row, expectedRevision: null, expectedOrgId: event.orgId }] }); }
      catch (error) { if (!(error instanceof CommitConflictError)) throw error; }
    }
    return { index, type: action.type, status: 'completed', resourceId: id, detail: 'internal notice created' };
  }
  const referral = event.aggregateType === 'referral' ? referralById(event.orgId, event.aggregateId) : undefined;
  if (!referral) throw new Error('automation referral was not found');
  if (referral.ownerId === action.ownerId) return { index, type: action.type, status: 'completed', resourceId: referral.id, detail: 'referral already has the configured owner' };
  if (referral.ownerId) return { index, type: action.type, status: 'skipped', resourceId: referral.id, detail: 'existing referral owner was preserved' };
  updateReferral({ orgId: event.orgId, id: referral.id, actor: `automation:${run.ruleId}`, expectedRevision: Number(referral.revision ?? 0), patch: { ownerId: action.ownerId } });
  return { index, type: action.type, status: 'completed', resourceId: referral.id, detail: 'unowned referral assigned' };
}

function recordLoopDeadLetter(job: DomainJobDoc, event: AutomationEventDoc) {
  const at = nowIso();
  const row: DeadLetterDoc = {
    id: `dead_${job.id}`, orgId: job.orgId, sourceType: 'job', sourceId: job.id,
    sourceKind: 'automation.loop_depth', redactedFailure: `automation event depth ${event.depth} exceeds limit ${MAX_LOOP_DEPTH}`,
    firstFailedAt: at, lastFailedAt: at, attempts: job.attempts, status: 'open', revision: 0, createdAt: at,
  };
  try {
    commitBatch({ upserts: [
      { collection: 'deadLetters', doc: row, expectedRevision: null, expectedOrgId: job.orgId },
      { collection: 'audit', doc: { id: newId('aud_'), orgId: job.orgId, actor: 'automation-runner', action: 'automation.loop_dead_lettered', kind: 'automation', target: event.id, detail: row.redactedFailure, at }, expectedRevision: null, expectedOrgId: job.orgId },
    ] });
  } catch (error) {
    if (!(error instanceof CommitConflictError) || !get<DeadLetterDoc>('deadLetters', row.id)) throw error;
  }
}

export async function runAutomationJob(job: DomainJobDoc) {
  const eventId = String(job.payload.eventId ?? '');
  const event = get<AutomationEventDoc>('automationEvents', eventId);
  if (!event || event.orgId !== job.orgId) throw new Error('automation event not found');
  if (event.depth > MAX_LOOP_DEPTH) {
    recordLoopDeadLetter(job, event);
    return;
  }
  const rules = activeAutomationRules(event.orgId, event.trigger);
  for (const rule of rules) {
    const version = automationRuleVersion(event.orgId, rule.id, rule.activeVersion);
    if (!version || version.trigger !== event.trigger) continue;
    const claimed = claimRun(rule, version, event);
    if (!claimed.claimed) continue;
    const results: AutomationActionResult[] = [];
    try {
      if (!evaluateAutomationCondition(version.condition, event)) {
        finishRun(claimed.run, 'skipped', [], undefined);
        continue;
      }
      for (let index = 0; index < version.actions.length; index += 1) {
        results.push(executeAction({ action: version.actions[index], index, event, run: claimed.run }));
      }
      finishRun(claimed.run, 'completed', results, undefined);
    } catch (error) {
      const detail = safeError(error);
      try { finishRun(claimed.run, 'failed', results, detail); } catch { /* the job retry will re-read the run */ }
      throw error;
    }
  }
}

export function previewAutomationRule(input: { orgId: string; id: string; event: AutomationEventDoc }) {
  const rule = automationRuleById(input.orgId, input.id);
  if (!rule) throw new Error('automation rule not found');
  const version = automationRuleVersion(input.orgId, rule.id);
  if (!version) throw new Error('automation rule version not found');
  if (version.trigger !== input.event.trigger) throw new Error('preview event does not match the rule trigger');
  return {
    matched: evaluateAutomationCondition(version.condition, input.event),
    version: version.version,
    trigger: version.trigger,
    persisted: false,
    actions: version.actions.map((action) => ({
      type: action.type,
      effect: action.type === 'create_task'
        ? 'create one administrative task'
        : action.type === 'internal_notification'
          ? 'create one internal notice'
          : 'assign only when the referral is unowned',
    })),
  };
}

/**
 * Evaluate a rule against allowlisted sample metadata. Nothing is persisted and
 * action functions are never called; the same event validator and condition
 * evaluator used by the runner still define the result.
 */
export function previewAutomationRuleValues(input: { orgId: string; id: string; values?: unknown }) {
  const rule = automationRuleById(input.orgId, input.id);
  if (!rule) throw new Error('automation rule not found');
  const version = automationRuleVersion(input.orgId, rule.id);
  if (!version) throw new Error('automation rule version not found');
  const raw = input.values ?? {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('automation preview values must be an object');
  const values = raw as Record<string, unknown>;
  const entries = Object.entries(values);
  if (entries.length > 30) throw new Error('automation preview contains too many values');
  const allowed = new Set<string>(TRIGGER_CATALOGUE[version.trigger].paths);
  const payload: Record<string, unknown> = {};
  let aggregateId = 'preview_aggregate';
  for (const [path, value] of entries) {
    if (!allowed.has(path)) throw new Error(`preview path ${path || '(empty)'} is not allowed for ${version.trigger}`);
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw new Error(`preview value for ${path} must be a string, number, boolean or null`);
    if (typeof value === 'string' && value.length > 240) throw new Error(`preview value for ${path} is too long`);
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`preview value for ${path} must be finite`);
    if (path === 'event.aggregateType') {
      if (value !== AUTOMATION_AGGREGATE_FOR_TRIGGER[version.trigger]) throw new Error('preview aggregate type must match the rule trigger');
      continue;
    }
    if (path === 'event.aggregateId') {
      if (typeof value !== 'string' || !value.trim()) throw new Error('preview aggregate ID must be a non-empty string');
      aggregateId = value.trim();
      continue;
    }
    const parts = path.split('.');
    let cursor = payload;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index];
      const child = cursor[part];
      if (!child || typeof child !== 'object' || Array.isArray(child)) cursor[part] = {};
      cursor = cursor[part] as Record<string, unknown>;
    }
    cursor[parts.at(-1)!] = value;
  }
  const event = automationEventDraft({
    orgId: input.orgId,
    trigger: version.trigger,
    aggregateType: AUTOMATION_AGGREGATE_FOR_TRIGGER[version.trigger],
    aggregateId,
    sourceEventId: `preview:${rule.id}:v${version.version}`,
    payload,
  });
  return { ...previewAutomationRule({ orgId: input.orgId, id: rule.id, event }), evaluatedPaths: entries.map(([path]) => path).sort() };
}
