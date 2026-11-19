import assert from 'node:assert/strict';
import { commitBatch, get, insert, list, nowIso, type Doc } from '../lib/server/db';
import { runPhase1DataMigrations, dataMigrationStates } from '../lib/server/data-migrations';
import { PERMISSIONS, systemRoleId, type RoleDoc } from '../lib/server/permissions';
import {
  createTask, taskById, tasksFor, transitionTask, updateTask, type TaskDoc,
} from '../lib/server/tasks';
import {
  automationCatalogue, automationRuleVersion, createAutomationRule, reviseAutomationRule, setAutomationRuleState,
} from '../lib/server/automations/catalogue';
import {
  automationNotificationsFor, automationRunsFor, previewAutomationRuleValues, runAutomationJob,
  updateAutomationNotification,
} from '../lib/server/automations/runner';
import {
  automationEventWrites, type AutomationEventDoc,
} from '../lib/server/automations/events';
import { createReferral } from '../lib/server/referrals';
import { runDueDomainJobs, type DeadLetterDoc, type DomainJobDoc } from '../lib/server/domain-jobs';
import { SCHEMA_MIGRATIONS } from '../lib/server/schema-migrations';

async function main() {
  const orgId = 'org_tasks_automations_check';
  const otherOrgId = 'org_tasks_automations_other';
  const actor = 'automation-check@voxera.test';
  const ownerId = 'user_automation_owner';
  let checks = 0;
  const check = (condition: unknown, message: string) => { assert.ok(condition, message); checks += 1; };
  const throws = (work: () => unknown, pattern: RegExp, message: string) => {
    assert.throws(work, pattern, message); checks += 1;
  };

  insert<Doc>('orgs', { id: orgId, name: 'Automation Test Practice', createdAt: nowIso() });
  insert<Doc>('orgs', { id: otherOrgId, name: 'Other Test Practice', createdAt: nowIso() });
  insert<Doc>('users', { id: ownerId, orgId, email: actor, name: 'Automation Owner', active: true, role: 'owner', createdAt: nowIso() });
  runPhase1DataMigrations(orgId);
  check(dataMigrationStates(orgId).every((row) => row.status === 'completed'), 'all checksummed data migrations should complete');
  check(['tasks.read', 'tasks.write', 'automations.read', 'automations.manage'].every((permission) => PERMISSIONS.includes(permission as never)), 'permission catalogue should include task and automation permissions');
  const reception = get<RoleDoc>('roles', systemRoleId(orgId, 'receptionist'));
  const admin = get<RoleDoc>('roles', systemRoleId(orgId, 'admin'));
  check(Boolean(reception?.permissions.includes('tasks.write') && !reception.permissions.includes('automations.manage')), 'reception should work tasks without managing automation rules');
  check(Boolean(admin?.permissions.includes('automations.manage')), 'administrator role should manage automations');
  check(SCHEMA_MIGRATIONS.some((row) => row.id === '20260920_010_tasks_and_constrained_automations'), 'task and automation schema migration should remain registered');

  const dueAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const task = createTask({ orgId, title: 'Review administrative queue', actor, dueAt, assigneeId: ownerId });
  check(task.state === 'open' && task.resourceType === 'workspace', 'workspace task should start open');
  check(list<DomainJobDoc>('domainJobs', (row) => row.orgId === orgId && row.type === 'task.due' && row.payload.taskId === task.id).length === 1, 'a due task should receive one durable due job');
  throws(() => updateTask({ orgId, id: task.id, expectedRevision: task.revision - 1, actor, patch: { title: 'Stale' } }), /changed after/i, 'stale task writes should fail');
  const edited = updateTask({ orgId, id: task.id, expectedRevision: task.revision, actor, patch: { priority: 'high' } });
  const completed = transitionTask({ orgId, id: edited.id, expectedRevision: edited.revision, actor, to: 'completed' });
  check(completed.completedBy === actor && completed.completedAt, 'task completion should preserve actor and timestamp evidence');
  throws(() => updateTask({ orgId, id: completed.id, expectedRevision: completed.revision, actor, patch: { title: 'No' } }), /reopened/i, 'terminal tasks should be immutable until reopened');
  const reopened = transitionTask({ orgId, id: completed.id, expectedRevision: completed.revision, actor, to: 'open' });
  check(reopened.state === 'open' && !reopened.completedAt, 'completed tasks should be explicitly reopenable');
  throws(() => createTask({ orgId, title: 'Invalid assignee', actor, assigneeId: 'missing' }), /assignee/i, 'task assignees must be active workspace members');
  const foreignClient = insert<Doc>('clients', { id: 'cli_foreign', orgId: otherOrgId, name: 'Foreign', createdAt: nowIso() });
  throws(() => createTask({ orgId, title: 'Cross tenant', actor, resourceType: 'client', resourceId: foreignClient.id }), /not found in this workspace/i, 'task resource links must not cross workspaces');
  check(tasksFor(orgId, { state: 'open' }).some((row) => row.id === task.id), 'task queues should filter by state');

  const catalogue = automationCatalogue();
  check(catalogue.triggers.length === 5 && catalogue.actions.length === 3, 'automation catalogue should expose only the bounded trigger/action set');
  throws(() => createAutomationRule({
    orgId, actor, name: 'Unsafe path', trigger: 'referral.received',
    condition: { operator: 'equals', path: 'referral.patientName', value: 'Private content' },
    actions: [{ type: 'internal_notification', title: 'Notice', message: 'Review', severity: 'information' }],
  }), /path .*not allowed/i, 'conditions must reject patient-content paths');
  throws(() => createAutomationRule({
    orgId, actor, name: 'Unsafe action', trigger: 'referral.received', actions: [{ type: 'javascript', code: 'return true' }],
  }), /not allowed/i, 'arbitrary actions must be rejected');
  throws(() => createAutomationRule({
    orgId, actor, name: 'Wrong aggregate', trigger: 'form.response_submitted', actions: [{ type: 'assign_referral_owner', ownerId }],
  }), /referral trigger/i, 'referral ownership actions must be restricted to referral triggers');
  throws(() => automationEventWrites({
    orgId, trigger: 'referral.received', aggregateType: 'referral', aggregateId: 'ref_bad', sourceEventId: 'source_bad',
    payload: { patientName: 'Disallowed' },
  }), /not allowed/i, 'automation metadata must reject likely patient content');
  const deterministicA = automationEventWrites({ orgId, trigger: 'task.due', aggregateType: 'task', aggregateId: 'tsk_deterministic', sourceEventId: 'due_1', payload: { task: { type: 'general' } } });
  const deterministicB = automationEventWrites({ orgId, trigger: 'task.due', aggregateType: 'task', aggregateId: 'tsk_deterministic', sourceEventId: 'due_1', payload: { task: { type: 'general' } } });
  check(deterministicA[0].doc.id === deterministicB[0].doc.id && deterministicA[1].doc.id === deterministicB[1].doc.id, 'source retries should converge on deterministic event and job IDs');
  throws(() => automationEventWrites({ orgId, trigger: 'task.due', aggregateType: 'referral', aggregateId: 'ref_bad_type', sourceEventId: 'bad_type', payload: {} }), /aggregate does not match/i, 'trigger and aggregate type must agree');

  const created = createAutomationRule({
    orgId, actor, name: 'Route soon referrals', trigger: 'referral.received',
    condition: { operator: 'all', conditions: [
      { operator: 'equals', path: 'referral.priority', value: 'soon' },
      { operator: 'equals', path: 'referral.status', value: 'received' },
    ] },
    actions: [
      { type: 'create_task', title: 'Review new referral', taskType: 'referral_review', priority: 'high', dueMinutes: 120, assigneeId: ownerId },
      { type: 'internal_notification', title: 'Referral received', message: 'A matching referral needs administrative review.', severity: 'information' },
      { type: 'assign_referral_owner', ownerId },
    ],
  });
  check(!created.rule.active && created.version.version === 1, 'new automation rules should start paused with an immutable first version');
  const active = setAutomationRuleState({ orgId, id: created.rule.id, expectedRevision: created.rule.revision, action: 'activate', actor });
  check(active.active && active.activeVersion === 1, 'activation should pin the current rule version');
  throws(() => reviseAutomationRule({ orgId, id: active.id, expectedRevision: active.revision, actor, trigger: 'task.due', actions: [{ type: 'internal_notification', title: 'Changed trigger', message: 'Unsafe while active', severity: 'information' }] }), /pause .*before changing/i, 'an active pinned rule must be paused before its trigger changes');
  const previewEvidenceBefore = {
    events: list<Doc>('automationEvents').length,
    runs: list<Doc>('automationRuns').length,
    tasks: list<Doc>('tasks').length,
    notices: list<Doc>('automationNotifications').length,
  };
  const matchingPreview = previewAutomationRuleValues({
    orgId, id: active.id, values: { 'referral.priority': 'soon', 'referral.status': 'received' },
  });
  check(matchingPreview.matched && matchingPreview.version === 1 && matchingPreview.persisted === false && matchingPreview.actions.length === 3, 'server preview should evaluate a matching sample without executing actions');
  check(!previewAutomationRuleValues({ orgId, id: active.id, values: { 'referral.priority': 'routine', 'referral.status': 'received' } }).matched, 'server preview should use the runner condition evaluator for nonmatching samples');
  throws(() => previewAutomationRuleValues({ orgId, id: active.id, values: { 'referral.patientName': 'Private content' } }), /path .*not allowed/i, 'preview should reject non-catalogue metadata paths');
  check(JSON.stringify(previewEvidenceBefore) === JSON.stringify({
    events: list<Doc>('automationEvents').length,
    runs: list<Doc>('automationRuns').length,
    tasks: list<Doc>('tasks').length,
    notices: list<Doc>('automationNotifications').length,
  }), 'preview should persist no event, run, task or notice evidence');

  const soon = createReferral({ orgId, actor, priority: 'soon', patient: { name: 'Synthetic Person' }, reason: 'Synthetic referral check' });
  const event = list<AutomationEventDoc>('automationEvents', (row) => row.orgId === orgId && row.aggregateId === soon.referral.id)[0];
  const eventJob = list<DomainJobDoc>('domainJobs', (row) => row.orgId === orgId && row.type === 'automation.event' && row.payload.eventId === event?.id)[0];
  check(Boolean(event && eventJob), 'referral receipt should atomically persist an automation event and durable job');
  const firstRun = await runDueDomainJobs(orgId, { workerId: 'automation-check-1', limit: 50, now: Date.now() + 1_000 });
  check(firstRun.completed >= 1, 'the durable runner should process the referral automation event');
  const autoTasks = tasksFor(orgId, { resourceType: 'referral', resourceId: soon.referral.id });
  check(autoTasks.length === 1 && autoTasks[0].automationOriginRunId, 'matching automation should create one idempotent resource-linked task');
  check(automationNotificationsFor(orgId).some((row) => row.title === 'Referral received'), 'matching automation should create an internal notice');
  check(get<Doc>('referrals', soon.referral.id)?.ownerId === ownerId, 'owner action should assign an unowned matching referral');
  const completedRun = automationRunsFor(orgId, { ruleId: active.id })[0];
  check(completedRun?.state === 'completed' && completedRun.actionResults.length === 3, 'automation run evidence should pin version and action outcomes');
  await runAutomationJob(eventJob);
  check(tasksFor(orgId, { resourceType: 'referral', resourceId: soon.referral.id }).length === 1, 'at-least-once event delivery must not duplicate action effects');
  const internalNotice = automationNotificationsFor(orgId).find((row) => row.title === 'Referral received');
  check(Boolean(internalNotice), 'created internal notice should be addressable for inbox state changes');
  const readNotice = updateAutomationNotification({ orgId, id: internalNotice!.id, expectedRevision: internalNotice!.revision, action: 'read', actor });
  check(Boolean(readNotice.readAt && readNotice.readBy === actor), 'marking an automation notice read should retain actor and time evidence');
  const dismissedNotice = updateAutomationNotification({ orgId, id: readNotice.id, expectedRevision: readNotice.revision, action: 'dismiss', actor });
  check(Boolean(dismissedNotice.dismissedAt && dismissedNotice.dismissedBy === actor && dismissedNotice.readAt), 'dismissal should preserve read state and add actor/time evidence');
  check(!automationNotificationsFor(orgId).some((row) => row.id === dismissedNotice.id) && automationNotificationsFor(orgId, 100, true).some((row) => row.id === dismissedNotice.id), 'dismissed notices should leave the active inbox while remaining durably readable');
  check(list<Doc>('audit', (row) => row.orgId === orgId && row.target === dismissedNotice.id && String(row.action).startsWith('automation.notification_')).length === 2, 'notice read and dismissal should both be auditable');

  const routine = createReferral({ orgId, actor, priority: 'routine', patient: { name: 'Synthetic Routine' }, reason: 'Synthetic no-match check' });
  await runDueDomainJobs(orgId, { workerId: 'automation-check-2', limit: 50, now: Date.now() + 1_000 });
  const skipped = automationRunsFor(orgId, { ruleId: active.id }).find((row) => row.eventId === list<AutomationEventDoc>('automationEvents', (candidate) => candidate.aggregateId === routine.referral.id)[0]?.id);
  check(skipped?.state === 'skipped', 'nonmatching deterministic conditions should leave skipped run evidence');

  const revised = reviseAutomationRule({
    orgId, id: active.id, expectedRevision: active.revision, actor, name: active.name, trigger: 'referral.received',
    condition: { operator: 'equals', path: 'referral.priority', value: 'soon' },
    actions: [{ type: 'internal_notification', title: 'Version two', message: 'Version two ran.', severity: 'warning' }],
  });
  check(revised.rule.currentVersion === 2 && revised.rule.activeVersion === 1 && revised.rule.active, 'editing an active rule should preserve the pinned live version until explicit activation');
  check(automationRuleVersion(orgId, revised.rule.id, 1)?.actions.length === 3, 'earlier rule versions should remain readable and unchanged');
  throws(() => commitBatch({ upserts: [{ collection: 'automationRuleVersions', doc: { ...created.version, actions: [] }, expectedRevision: created.version.revision, expectedOrgId: orgId }] }), /append-only/i, 'automation rule versions must be append-only');
  const v1Referral = createReferral({ orgId, actor, priority: 'soon', patient: { name: 'Synthetic V1' }, reason: 'Pinned version check' });
  await runDueDomainJobs(orgId, { workerId: 'automation-check-v1', limit: 50, now: Date.now() + 1_000 });
  check(tasksFor(orgId, { resourceType: 'referral', resourceId: v1Referral.referral.id }).length === 1, 'active rules should continue running their pinned version after draft revision');
  const activeV2 = setAutomationRuleState({ orgId, id: revised.rule.id, expectedRevision: revised.rule.revision, action: 'activate', actor });
  const v2Referral = createReferral({ orgId, actor, priority: 'soon', patient: { name: 'Synthetic V2' }, reason: 'Activated version check' });
  await runDueDomainJobs(orgId, { workerId: 'automation-check-v2', limit: 50, now: Date.now() + 1_000 });
  check(tasksFor(orgId, { resourceType: 'referral', resourceId: v2Referral.referral.id }).length === 0 && automationNotificationsFor(orgId).some((row) => row.title === 'Version two'), 'explicit reactivation should switch subsequent events to the new version');
  check(automationRunsFor(orgId, { ruleId: activeV2.id }).some((row) => row.ruleVersion === 2 && row.state === 'completed'), 'run evidence should identify the exact activated version');
  throws(() => commitBatch({ upserts: [{ collection: 'automationEvents', doc: { ...event, depth: 99 }, expectedRevision: event.revision, expectedOrgId: orgId }] }), /append-only/i, 'automation events must be append-only');

  const dueRuleCreated = createAutomationRule({
    orgId, actor, name: 'Due task notice', trigger: 'task.due',
    condition: { operator: 'equals', path: 'task.priority', value: 'urgent' },
    actions: [{ type: 'internal_notification', title: 'Urgent task due', message: 'An urgent administrative task is due.', severity: 'warning' }],
  });
  setAutomationRuleState({ orgId, id: dueRuleCreated.rule.id, expectedRevision: dueRuleCreated.rule.revision, action: 'activate', actor });
  const dueTask = createTask({ orgId, title: 'Urgent due test', priority: 'urgent', actor, dueAt: new Date(Date.now() - 60_000).toISOString() });
  await runDueDomainJobs(orgId, { workerId: 'task-due-check', limit: 100, now: Date.now() + 1_000 });
  check(list<AutomationEventDoc>('automationEvents', (row) => row.aggregateId === dueTask.id && row.trigger === 'task.due').length === 1, 'the due job should emit one transactional task.due event');
  await runDueDomainJobs(orgId, { workerId: 'task-due-automation-check', limit: 100, now: Date.now() + 1_000 });
  check(automationNotificationsFor(orgId).some((row) => row.title === 'Urgent task due'), 'task.due events should execute through the same constrained runner');

  const loopWrites = automationEventWrites({
    orgId, trigger: 'task.due', aggregateType: 'task', aggregateId: 'tsk_loop_test', sourceEventId: 'loop_depth_5', depth: 5,
    payload: { task: { type: 'general', priority: 'normal', visibility: 'administrative', assigneeId: '', resourceType: 'workspace' } },
  });
  commitBatch({ upserts: loopWrites });
  await runDueDomainJobs(orgId, { workerId: 'loop-depth-check', limit: 100, now: Date.now() + 1_000 });
  check(list<DeadLetterDoc>('deadLetters', (row) => row.orgId === orgId && row.sourceKind === 'automation.loop_depth').length === 1, 'events beyond the recursion bound should create dead-letter evidence without executing');

  const failureRuleCreated = createAutomationRule({
    orgId, actor, name: 'Missing form resource failure', trigger: 'form.response_submitted',
    actions: [{ type: 'create_task', title: 'Review submitted form', taskType: 'form_review', priority: 'normal', dueMinutes: 0 }],
  });
  setAutomationRuleState({ orgId, id: failureRuleCreated.rule.id, expectedRevision: failureRuleCreated.rule.revision, action: 'activate', actor });
  const failureWrites = automationEventWrites({
    orgId, trigger: 'form.response_submitted', aggregateType: 'form_response', aggregateId: 'missing_response', sourceEventId: 'missing_response_event',
    payload: { form: { templateId: 'missing', assignmentId: 'missing', clientId: '', respondentRelationship: '' } },
  });
  commitBatch({ upserts: failureWrites });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await runDueDomainJobs(orgId, { workerId: `failure-check-${attempt}`, limit: 100, now: Date.now() + 365 * 24 * 60 * 60_000 });
  }
  const failedJobId = failureWrites[1].doc.id;
  check(get<DomainJobDoc>('domainJobs', failedJobId)?.status === 'failed', 'automation jobs should exhaust their bounded retry budget');
  check(Boolean(get<DeadLetterDoc>('deadLetters', `dead_${failedJobId}`)), 'exhausted automation jobs should retain generic dead-letter evidence');
  const failedRuns = automationRunsFor(orgId, { ruleId: failureRuleCreated.rule.id });
  check(failedRuns.length === 1 && failedRuns[0].attempts === 4 && failedRuns[0].state === 'failed', 'event/rule idempotency should reuse one failed run across retries');

  check(list<Doc>('audit', (row) => row.orgId === orgId && row.action === 'automation.activate').length >= 3, 'rule activation should be auditable');
  check(taskById(orgId, task.id)?.revision === reopened.revision, 'task reads should return the latest committed revision');

  console.log(`tasks-automations-check: ${checks} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
