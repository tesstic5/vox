'use client';

import * as React from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/dash/Shell';
import { Button, Pill } from '@/components/ui';
import { Icons } from '@/components/icons';

type Trigger = 'referral.received' | 'referral.status_changed' | 'form.response_submitted' | 'letter.finalised' | 'task.due';
type Rule = { id: string; name: string; trigger: Trigger; currentVersion: number; activeVersion?: number; active: boolean; archivedAt?: string; revision: number };
type LeafOperator = 'equals' | 'notEquals' | 'contains' | 'answered';
type LeafCondition = { operator: LeafOperator; path: string; value?: string | number | boolean };
type GroupCondition = { operator: 'all' | 'any'; conditions: Condition[] };
type Condition = LeafCondition | GroupCondition;
type Action =
  | { type: 'create_task'; title: string; taskType: string; priority: string; dueMinutes: number; assigneeId?: string }
  | { type: 'internal_notification'; title: string; message: string; severity: string }
  | { type: 'assign_referral_owner'; ownerId: string };
type Version = { version: number; trigger: Trigger; condition?: Condition; actions: Action[]; author: string; createdAt?: string };
type Run = { id: string; ruleId: string; ruleVersion: number; eventId: string; trigger: Trigger; state: 'running' | 'completed' | 'skipped' | 'failed' | 'dead_letter'; attempts: number; actionResults: Array<{ type: string; status: string; detail: string }>; startedAt: string; completedAt?: string; lastError?: string };
type Notice = {
  id: string;
  title: string;
  message: string;
  severity: 'information' | 'warning';
  createdAt?: string;
  readAt?: string;
  dismissedAt?: string;
  revision: number;
};
type PreviewResult = { matched: boolean; version: number; trigger: Trigger; persisted: false; evaluatedPaths: string[]; actions: Array<{ type: Action['type']; effect: string }> };
type Member = { id: string; name?: string; email?: string; active?: boolean };
type Catalogue = { triggers: Array<{ id: Trigger; label: string; paths: string[] }>; actions: Array<{ type: Action['type']; label: string }>; limits: { conditionDepth: number; conditionNodes: number; actions: number; loopDepth: number }; prohibited: string[] };

type ActionDraft = { type: Action['type']; title: string; message: string; severity: 'information' | 'warning'; taskType: string; priority: string; dueMinutes: string; assigneeId: string; ownerId: string };
const actionBlank: ActionDraft = { type: 'create_task', title: '', message: '', severity: 'information', taskType: 'follow_up', priority: 'normal', dueMinutes: '0', assigneeId: '', ownerId: '' };
const triggerLabels: Record<Trigger, string> = {
  'referral.received': 'Referral received', 'referral.status_changed': 'Referral status changed',
  'form.response_submitted': 'Form response submitted', 'letter.finalised': 'Letter finalised', 'task.due': 'Task became due',
};

function runTone(state: Run['state']): 'default' | 'brand' | 'warn' | 'danger' {
  if (state === 'completed') return 'brand';
  if (state === 'running' || state === 'skipped') return 'warn';
  if (state === 'failed' || state === 'dead_letter') return 'danger';
  return 'default';
}

function isGroupCondition(condition: Condition): condition is GroupCondition {
  return condition.operator === 'all' || condition.operator === 'any';
}

function conditionLeaves(condition?: Condition): LeafCondition[] {
  if (!condition) return [];
  if (isGroupCondition(condition)) return condition.conditions.flatMap(conditionLeaves);
  return [condition];
}

function describeCondition(condition?: Condition): string {
  if (!condition) return 'always match';
  if (isGroupCondition(condition)) {
    return `${condition.operator}(${condition.conditions.map(describeCondition).join(', ')})`;
  }
  return `${condition.path} ${condition.operator}${condition.operator === 'answered' ? '' : ` ${String(condition.value ?? '')}`}`;
}

function aggregateType(trigger: Trigger) {
  if (trigger.startsWith('referral.')) return 'referral';
  if (trigger === 'form.response_submitted') return 'form_response';
  if (trigger === 'letter.finalised') return 'letter';
  return 'task';
}

export default function AutomationsPage() {
  const [rules, setRules] = React.useState<Rule[]>([]);
  const [runs, setRuns] = React.useState<Run[]>([]);
  const [notices, setNotices] = React.useState<Notice[]>([]);
  const [catalogue, setCatalogue] = React.useState<Catalogue>();
  const [members, setMembers] = React.useState<Member[]>([]);
  const [selected, setSelected] = React.useState<{ rule: Rule; version: Version; runs: Run[] }>();
  const [showEditor, setShowEditor] = React.useState(false);
  const [editing, setEditing] = React.useState<{ id: string; revision: number }>();
  const [name, setName] = React.useState('');
  const [trigger, setTrigger] = React.useState<Trigger>('referral.received');
  const [conditionPath, setConditionPath] = React.useState('');
  const [conditionOperator, setConditionOperator] = React.useState<LeafOperator>('equals');
  const [conditionValue, setConditionValue] = React.useState('');
  const [actions, setActions] = React.useState<Action[]>([]);
  const [actionDraft, setActionDraft] = React.useState<ActionDraft>(actionBlank);
  const [busy, setBusy] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const [previewValues, setPreviewValues] = React.useState<Record<string, string>>({});
  const [previewResult, setPreviewResult] = React.useState<PreviewResult>();

  const api = React.useCallback(async (path: string, init?: RequestInit) => {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message ?? 'The request failed.');
    return body;
  }, []);

  const load = React.useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [body, team] = await Promise.all([
        api('/api/v1/automations'), api('/api/v1/team?view=members').catch(() => ({ members: [] })),
      ]);
      setRules(body.rules ?? []); setRuns(body.runs ?? []); setNotices(body.notifications ?? []); setCatalogue(body.catalogue);
      setMembers((team.members ?? []).filter((member: Member) => member.active !== false));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Automations could not be loaded.'); }
    finally { setLoading(false); }
  }, [api]);
  React.useEffect(() => { void load(); }, [load]);

  const open = async (rule: Rule) => {
    setBusy(true); setError(''); setPreviewResult(undefined);
    try {
      const body = await api(`/api/v1/automations/${rule.id}`);
      setSelected(body);
      const samples: Record<string, string> = {};
      for (const leaf of conditionLeaves(body.version?.condition)) {
        samples[leaf.path] = leaf.path === 'event.aggregateType'
          ? aggregateType(body.version.trigger)
          : leaf.path === 'event.aggregateId'
            ? 'preview_aggregate'
            : leaf.operator === 'answered'
              ? ''
              : String(leaf.value ?? '');
      }
      setPreviewValues(samples);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Automation rule could not be opened.'); }
    finally { setBusy(false); }
  };

  const resetEditor = () => {
    setEditing(undefined); setName(''); setTrigger('referral.received'); setConditionPath(''); setConditionOperator('equals'); setConditionValue(''); setActions([]); setActionDraft(actionBlank);
  };
  const startNew = () => { resetEditor(); setShowEditor(true); };
  const startRevision = () => {
    if (!selected) return;
    const condition = selected.version.condition;
    if (condition && isGroupCondition(condition)) {
      setError('Compound all/any conditions remain readable and previewable here, but must be revised through the versioned API.');
      return;
    }
    setEditing({ id: selected.rule.id, revision: selected.rule.revision }); setName(selected.rule.name); setTrigger(selected.version.trigger);
    setConditionPath(condition?.path ?? ''); setConditionOperator(condition?.operator ?? 'equals'); setConditionValue(condition?.value === undefined ? '' : String(condition.value));
    setActions(selected.version.actions); setActionDraft(actionBlank); setShowEditor(true);
  };

  const addAction = () => {
    setError('');
    if (actions.length >= 5) { setError('A rule can contain at most five actions.'); return; }
    if (actionDraft.type === 'create_task') {
      if (actionDraft.title.trim().length < 2) { setError('Enter a task title.'); return; }
      setActions((current) => [...current, { type: 'create_task', title: actionDraft.title.trim(), taskType: actionDraft.taskType, priority: actionDraft.priority, dueMinutes: Number(actionDraft.dueMinutes || 0), assigneeId: actionDraft.assigneeId || undefined }]);
    } else if (actionDraft.type === 'internal_notification') {
      if (actionDraft.title.trim().length < 2 || actionDraft.message.trim().length < 2) { setError('Enter a notification title and message.'); return; }
      setActions((current) => [...current, { type: 'internal_notification', title: actionDraft.title.trim(), message: actionDraft.message.trim(), severity: actionDraft.severity }]);
    } else {
      if (!actionDraft.ownerId) { setError('Choose a referral owner.'); return; }
      setActions((current) => [...current, { type: 'assign_referral_owner', ownerId: actionDraft.ownerId }]);
    }
    setActionDraft(actionBlank);
  };

  const save = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const condition = conditionPath ? { operator: conditionOperator, path: conditionPath, ...(conditionOperator === 'answered' ? {} : { value: conditionValue }) } : undefined;
      const body = editing
        ? await api(`/api/v1/automations/${editing.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'revise', expectedRevision: editing.revision, name, trigger, condition, actions }) })
        : await api('/api/v1/automations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, trigger, condition, actions }) });
      const rule = body.rule ?? body;
      setNotice(editing ? 'A new immutable rule version was saved. Activate it explicitly when it is ready.' : 'Automation rule created in paused state.');
      setShowEditor(false); resetEditor(); await load(); if (rule?.id) await open(rule);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Automation rule could not be saved.'); }
    finally { setBusy(false); }
  };

  const changeState = async (rule: Rule, action: 'activate' | 'pause' | 'archive') => {
    setBusy(true); setError(''); setNotice('');
    try {
      const body = await api(`/api/v1/automations/${rule.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, expectedRevision: rule.revision }) });
      setNotice(action === 'activate' ? `Version ${body.currentVersion} is active for new events.` : action === 'pause' ? 'Rule paused; existing run evidence is unchanged.' : 'Rule archived.');
      setSelected(undefined); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Automation state could not be changed.'); }
    finally { setBusy(false); }
  };

  const runPreview = async () => {
    if (!selected) return;
    setBusy(true); setError(''); setPreviewResult(undefined);
    try {
      const values: Record<string, string | number | boolean | null> = {};
      for (const leaf of conditionLeaves(selected.version.condition)) {
        const raw = previewValues[leaf.path] ?? '';
        if (leaf.path === 'event.aggregateType') {
          values[leaf.path] = aggregateType(selected.version.trigger);
        } else if (leaf.path === 'event.aggregateId') {
          values[leaf.path] = raw || 'preview_aggregate';
        } else if (leaf.operator === 'answered') {
          values[leaf.path] = raw === '' ? null : raw;
        } else if (typeof leaf.value === 'number') {
          const parsed = Number(raw);
          if (!Number.isFinite(parsed)) throw new Error(`${leaf.path} requires a finite sample number.`);
          values[leaf.path] = parsed;
        } else if (typeof leaf.value === 'boolean') {
          values[leaf.path] = raw === 'true';
        } else {
          values[leaf.path] = raw;
        }
      }
      setPreviewResult(await api(`/api/v1/automations/${selected.rule.id}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values }),
      }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Automation preview could not be evaluated.'); }
    finally { setBusy(false); }
  };

  const updateNotice = async (item: Notice, action: 'read' | 'dismiss') => {
    setBusy(true); setError(''); setNotice('');
    try {
      await api(`/api/v1/automations/notifications/${item.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, expectedRevision: item.revision }),
      });
      setNotice(action === 'read' ? 'Automation notice marked read.' : 'Automation notice dismissed. Its audit evidence is retained.');
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Automation notice could not be updated.'); }
    finally { setBusy(false); }
  };

  const paths = catalogue?.triggers.find((row) => row.id === trigger)?.paths ?? [];
  const previewLeaves = selected ? conditionLeaves(selected.version.condition) : [];
  const previewFields = [...new Map(previewLeaves.map((leaf) => [leaf.path, leaf])).values()];
  const actionDescription = (action: Action) => action.type === 'create_task'
    ? `Create “${action.title}” after ${action.dueMinutes} minute(s)`
    : action.type === 'internal_notification' ? `Notify: ${action.title}` : `Assign an unowned referral to ${action.ownerId}`;

  return <div className="space-y-6">
    <PageHeader
      title="Administrative automations"
      desc="Versioned trigger, condition and action rules executed by the durable job runner. The catalogue is allowlisted; arbitrary code is never accepted."
      actions={<div className="flex flex-wrap gap-2"><Link href="/dashboard/tasks" className="btn-ghost btn-sm"><Icons.check size={13} /> Task queue</Link><Button size="sm" onClick={startNew}><Icons.plus size={13} /> New rule</Button></div>}
    />
    <section className="rounded-2xl border border-amber-400/30 bg-amber-400/[0.065] px-4 py-3 text-[12px] leading-relaxed text-amber-950">
      Automations may create administrative tasks, create internal notices or assign an unowned referral. They cannot diagnose or triage, sign clinical notes, submit claims, refund money or deny access to care.
    </section>
    {error && <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-[12px] text-red-700">{error}</div>}
    {notice && <div role="status" className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] px-4 py-3 text-[12px] text-emerald-800">{notice}</div>}

    {showEditor && <section className="panel p-5">
      <div className="flex items-start justify-between gap-3"><div><h2 className="text-[15px] font-semibold">{editing ? 'Save a new rule version' : 'Create paused rule'}</h2><p className="mt-1 text-[11.5px] text-slateink-400">One optional deterministic condition and up to five allowlisted actions. Rules never run until activated.</p></div><button onClick={() => { setShowEditor(false); resetEditor(); }} aria-label="Close rule editor"><Icons.close size={15} /></button></div>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <label className="text-[11px] font-medium text-slateink-500">Rule name<input value={name} maxLength={140} onChange={(event) => setName(event.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]" /></label>
        <label className="text-[11px] font-medium text-slateink-500">Trigger<select value={trigger} onChange={(event) => { setTrigger(event.target.value as Trigger); setConditionPath(''); if (!event.target.value.startsWith('referral.') && actionDraft.type === 'assign_referral_owner') setActionDraft(actionBlank); }} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]">{(catalogue?.triggers ?? Object.entries(triggerLabels).map(([id, label]) => ({ id, label, paths: [] }))).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      </div>
      <div className="mt-4 rounded-xl border border-slate-900/[0.07] p-4"><h3 className="text-[11px] font-bold uppercase tracking-wider text-slateink-300">Optional condition</h3><div className="mt-3 grid gap-3 md:grid-cols-3"><label className="text-[11px] font-medium text-slateink-500">Allowed field<select value={conditionPath} onChange={(event) => setConditionPath(event.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[11px]"><option value="">Always match</option>{paths.map((path) => <option key={path} value={path}>{path}</option>)}</select></label><label className="text-[11px] font-medium text-slateink-500">Operator<select value={conditionOperator} disabled={!conditionPath} onChange={(event) => setConditionOperator(event.target.value as LeafOperator)} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[11px] disabled:bg-slate-50"><option value="equals">Equals</option><option value="notEquals">Does not equal</option><option value="contains">Contains</option><option value="answered">Has a value</option></select></label><label className="text-[11px] font-medium text-slateink-500">Value<input value={conditionValue} disabled={!conditionPath || conditionOperator === 'answered'} onChange={(event) => setConditionValue(event.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[11px] disabled:bg-slate-50" /></label></div></div>
      <div className="mt-4 rounded-xl border border-slate-900/[0.07] p-4"><div className="flex items-center justify-between gap-2"><h3 className="text-[11px] font-bold uppercase tracking-wider text-slateink-300">Actions</h3><span className="text-[10px] text-slateink-400">{actions.length}/5</span></div>{actions.length > 0 && <ol className="mt-3 space-y-2">{actions.map((action, index) => <li key={`${action.type}-${index}`} className="flex items-center gap-3 rounded-lg bg-slate-900/[0.025] px-3 py-2"><span className="grid h-6 w-6 place-items-center rounded-full bg-brand-500/10 text-[10px] font-bold text-brand-700">{index + 1}</span><span className="min-w-0 flex-1 truncate text-[11.5px]">{actionDescription(action)}</span><button onClick={() => setActions((current) => current.filter((_, candidate) => candidate !== index))} aria-label={`Remove action ${index + 1}`}><Icons.close size={12} /></button></li>)}</ol>}
        <div className="mt-3 grid gap-3 md:grid-cols-3"><label className="text-[11px] font-medium text-slateink-500">Action<select value={actionDraft.type} onChange={(event) => setActionDraft({ ...actionBlank, type: event.target.value as Action['type'] })} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[11px]"><option value="create_task">Create administrative task</option><option value="internal_notification">Create internal notice</option>{trigger.startsWith('referral.') && <option value="assign_referral_owner">Assign unowned referral</option>}</select></label>
          {actionDraft.type === 'create_task' && <><label className="text-[11px] font-medium text-slateink-500 md:col-span-2">Task title<input value={actionDraft.title} maxLength={180} onChange={(event) => setActionDraft((row) => ({ ...row, title: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[11px]" /></label><label className="text-[11px] font-medium text-slateink-500">Task type<select value={actionDraft.taskType} onChange={(event) => setActionDraft((row) => ({ ...row, taskType: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[11px]"><option value="general">General</option><option value="follow_up">Follow-up</option><option value="form_review">Form review</option><option value="referral_review">Referral review</option><option value="letter_review">Letter review</option><option value="reminder">Reminder</option></select></label><label className="text-[11px] font-medium text-slateink-500">Priority<select value={actionDraft.priority} onChange={(event) => setActionDraft((row) => ({ ...row, priority: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[11px]"><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label><label className="text-[11px] font-medium text-slateink-500">Due offset (minutes)<input type="number" min="0" max="525600" value={actionDraft.dueMinutes} onChange={(event) => setActionDraft((row) => ({ ...row, dueMinutes: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[11px]" /></label><label className="text-[11px] font-medium text-slateink-500">Assignee<select value={actionDraft.assigneeId} onChange={(event) => setActionDraft((row) => ({ ...row, assigneeId: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[11px]"><option value="">Unassigned</option>{members.map((member) => <option key={member.id} value={member.id}>{member.name || member.email || member.id}</option>)}</select></label></>}
          {actionDraft.type === 'internal_notification' && <><label className="text-[11px] font-medium text-slateink-500 md:col-span-2">Notice title<input value={actionDraft.title} maxLength={160} onChange={(event) => setActionDraft((row) => ({ ...row, title: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[11px]" /></label><label className="text-[11px] font-medium text-slateink-500 md:col-span-2">Message<input value={actionDraft.message} maxLength={500} onChange={(event) => setActionDraft((row) => ({ ...row, message: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[11px]" /></label><label className="text-[11px] font-medium text-slateink-500">Severity<select value={actionDraft.severity} onChange={(event) => setActionDraft((row) => ({ ...row, severity: event.target.value as ActionDraft['severity'] }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[11px]"><option value="information">Information</option><option value="warning">Warning</option></select></label></>}
          {actionDraft.type === 'assign_referral_owner' && <label className="text-[11px] font-medium text-slateink-500 md:col-span-2">Owner<select value={actionDraft.ownerId} onChange={(event) => setActionDraft((row) => ({ ...row, ownerId: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[11px]"><option value="">Choose active team member</option>{members.map((member) => <option key={member.id} value={member.id}>{member.name || member.email || member.id}</option>)}</select></label>}
        </div><Button variant="ghost" size="sm" className="mt-3" disabled={actions.length >= 5} onClick={addAction}><Icons.plus size={12} /> Add action</Button>
      </div>
      <div className="mt-4 flex justify-end"><Button size="sm" disabled={busy || name.trim().length < 2 || actions.length < 1} onClick={() => void save()}>{busy ? 'Saving…' : editing ? 'Save new version' : 'Create paused rule'}</Button></div>
    </section>}

    <div className="grid gap-5 xl:grid-cols-[minmax(390px,0.85fr)_minmax(0,1.15fr)] xl:items-start">
      <section className="panel overflow-hidden"><div className="border-b border-slate-900/[0.05] px-5 py-4"><h2 className="text-[13px] font-semibold">Rules</h2><p className="mt-1 text-[10.5px] text-slateink-400">Activation pins one immutable version for new events.</p></div><div className="divide-y divide-slate-900/[0.05]">{rules.map((rule) => <button key={rule.id} onClick={() => void open(rule)} className={`flex w-full gap-3 px-5 py-4 text-left hover:bg-slate-900/[0.02] ${selected?.rule.id === rule.id ? 'bg-brand-500/[0.045]' : ''}`}><span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${rule.active ? 'bg-emerald-500' : 'bg-slate-300'}`} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="truncate text-[13px] font-semibold">{rule.name}</p><Pill tone={rule.active ? 'brand' : 'default'}>{rule.active ? `active v${rule.activeVersion}` : 'paused'}</Pill></div><p className="mt-1 text-[11px] text-slateink-400">{triggerLabels[rule.trigger]} · latest v{rule.currentVersion}</p><p className="mt-1 font-mono text-[9.5px] text-slateink-300">{rule.id}</p></div><Icons.chevronRight size={14} /></button>)}{!loading && !rules.length && <p className="px-5 py-14 text-center text-[12px] text-slateink-400">No automation rules have been configured.</p>}</div></section>
      <section className="panel min-h-[370px] p-5 xl:sticky xl:top-6">{!selected ? <div className="grid min-h-[330px] place-items-center text-center"><div><span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-slate-900/[0.04]"><Icons.bolt size={20} /></span><h2 className="mt-4 text-[15px] font-semibold">Select a rule</h2><p className="mt-2 max-w-sm text-[12px] leading-relaxed text-slateink-400">Inspect its pinned version, allowlisted actions and durable run evidence.</p></div></div> : <div className="space-y-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><h2 className="text-[18px] font-semibold">{selected.rule.name}</h2><Pill tone={selected.rule.active ? 'brand' : 'default'}>{selected.rule.active ? `active v${selected.rule.activeVersion}` : 'paused'}</Pill></div><p className="mt-1 font-mono text-[10px] text-slateink-400">{selected.rule.id} · latest v{selected.rule.currentVersion}</p></div><div className="flex flex-wrap gap-2"><Button variant="ghost" size="sm" disabled={busy} onClick={startRevision}>New version</Button>{selected.rule.active ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => void changeState(selected.rule, 'pause')}>Pause</Button> : <Button size="sm" disabled={busy} onClick={() => void changeState(selected.rule, 'activate')}>Activate v{selected.rule.currentVersion}</Button>}<Button variant="ghost" size="sm" disabled={busy} onClick={() => void changeState(selected.rule, 'archive')}>Archive</Button></div></div>
        <dl className="grid gap-3 sm:grid-cols-2"><div className="rounded-xl bg-slate-900/[0.025] p-3"><dt className="text-[10px] font-bold uppercase tracking-wider text-slateink-300">Trigger</dt><dd className="mt-2 text-[12px]">{triggerLabels[selected.version.trigger]}</dd></div><div className="rounded-xl bg-slate-900/[0.025] p-3"><dt className="text-[10px] font-bold uppercase tracking-wider text-slateink-300">Condition</dt><dd className="mt-2 break-words font-mono text-[10.5px]">{describeCondition(selected.version.condition)}</dd></div></dl>
        <div className="rounded-xl border border-slate-900/[0.07] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-[11px] font-bold uppercase tracking-wider text-slateink-300">Non-executing preview</h3><p className="mt-1 text-[10.5px] leading-relaxed text-slateink-400">Evaluate allowlisted sample metadata with the server runner. No event, run, task, notice or assignment is persisted.</p></div><Button variant="ghost" size="sm" disabled={busy} onClick={() => void runPreview()}>Preview v{selected.version.version}</Button></div>
          {previewFields.length > 0 ? <div className="mt-3 grid gap-3 sm:grid-cols-2">{previewFields.map((leaf) => <label key={leaf.path} className="min-w-0 text-[10.5px] font-medium text-slateink-500">Sample {leaf.path}{leaf.path === 'event.aggregateType' || typeof leaf.value === 'boolean' ? <select aria-label={`Sample ${leaf.path}`} value={previewValues[leaf.path] ?? (leaf.path === 'event.aggregateType' ? aggregateType(selected.version.trigger) : 'false')} disabled={leaf.path === 'event.aggregateType'} onChange={(event) => setPreviewValues((current) => ({ ...current, [leaf.path]: event.target.value }))} className="mt-1.5 w-full min-w-0 rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[11px] disabled:bg-slate-50">{leaf.path === 'event.aggregateType' ? <option value={aggregateType(selected.version.trigger)}>{aggregateType(selected.version.trigger)}</option> : <><option value="true">true</option><option value="false">false</option></>}</select> : <input aria-label={`Sample ${leaf.path}`} type={typeof leaf.value === 'number' ? 'number' : 'text'} value={previewValues[leaf.path] ?? ''} onChange={(event) => setPreviewValues((current) => ({ ...current, [leaf.path]: event.target.value }))} className="mt-1.5 w-full min-w-0 rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[11px]" />}</label>)}</div> : <p className="mt-3 rounded-lg bg-slate-900/[0.025] px-3 py-2 text-[10.5px] text-slateink-400">This version has no condition, so every event with the selected trigger matches.</p>}
          {previewResult && <div role="status" className={`mt-3 rounded-lg border px-3 py-2.5 text-[11px] ${previewResult.matched ? 'border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-800' : 'border-amber-500/20 bg-amber-500/[0.06] text-amber-900'}`}><p className="font-semibold">{previewResult.matched ? `Preview matched version ${previewResult.version}.` : `Preview did not match version ${previewResult.version}.`}</p><p className="mt-1 opacity-80">No records were written. {previewResult.matched ? previewResult.actions.map((action) => action.effect).join(' · ') : 'Actions would be skipped.'}</p></div>}
        </div>
        <div><h3 className="text-[11px] font-bold uppercase tracking-wider text-slateink-300">Version {selected.version.version} actions</h3><ol className="mt-2 space-y-2">{selected.version.actions.map((action, index) => <li key={`${action.type}-${index}`} className="flex gap-3 rounded-xl border border-slate-900/[0.07] p-3"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand-500/10 text-[10px] font-bold text-brand-700">{index + 1}</span><div><p className="text-[11.5px] font-medium">{action.type.replaceAll('_', ' ')}</p><p className="mt-1 text-[10.5px] text-slateink-400">{actionDescription(action)}</p></div></li>)}</ol></div>
        <div><h3 className="text-[11px] font-bold uppercase tracking-wider text-slateink-300">Recent runs</h3><div className="mt-2 space-y-2">{selected.runs.slice(0, 8).map((run) => <div key={run.id} className="rounded-xl border border-slate-900/[0.07] p-3"><div className="flex items-center justify-between gap-2"><div className="flex items-center gap-2"><Pill tone={runTone(run.state)}>{run.state.replace('_', ' ')}</Pill><span className="font-mono text-[9.5px] text-slateink-400">v{run.ruleVersion} · attempt {run.attempts}</span></div><span className="text-[9.5px] text-slateink-400">{new Date(run.startedAt).toLocaleString('en-GB')}</span></div>{run.actionResults.length > 0 && <p className="mt-2 text-[10.5px] text-slateink-500">{run.actionResults.map((result) => result.detail).join(' · ')}</p>}{run.lastError && <p className="mt-2 text-[10.5px] text-red-700">{run.lastError}</p>}</div>)}{!selected.runs.length && <p className="rounded-xl bg-slate-900/[0.025] px-3 py-4 text-[11px] text-slateink-400">No event has produced a run for this rule yet.</p>}</div></div>
      </div>}</section>
    </div>

    <div className="grid min-w-0 gap-5 lg:grid-cols-2"><section className="panel min-w-0 p-5"><h2 className="text-[13px] font-semibold">Latest run evidence</h2><div className="mt-3 space-y-2">{runs.slice(0, 6).map((run) => <div key={run.id} className="flex items-center gap-3 rounded-xl bg-slate-900/[0.025] px-3 py-2.5"><Pill tone={runTone(run.state)}>{run.state.replace('_', ' ')}</Pill><div className="min-w-0 flex-1"><p className="truncate text-[11px] font-medium">{triggerLabels[run.trigger]} · version {run.ruleVersion}</p><p className="mt-0.5 truncate font-mono text-[9px] text-slateink-400">{run.eventId}</p></div><span className="text-[9.5px] text-slateink-400">{new Date(run.startedAt).toLocaleString('en-GB')}</span></div>)}{!runs.length && <p className="py-6 text-center text-[11px] text-slateink-400">No run evidence yet.</p>}</div></section><section className="panel min-w-0 p-5">
      <div className="flex items-center justify-between gap-3"><div><h2 className="text-[13px] font-semibold">Internal automation notices</h2><p className="mt-1 text-[10.5px] text-slateink-400">{notices.filter((item) => !item.readAt).length} unread · dismissal retains audit evidence</p></div></div>
      <div className="mt-3 space-y-2">{notices.slice(0, 6).map((item) => <div key={item.id} className={`rounded-xl border p-3 ${item.readAt ? 'border-slate-900/[0.07]' : 'border-brand-500/20 bg-brand-500/[0.035]'}`}><div className="flex flex-wrap items-center gap-2"><span aria-hidden="true" className={`h-2 w-2 rounded-full ${item.readAt ? 'bg-slate-300' : 'bg-brand-500'}`} /><Pill tone={item.severity === 'warning' ? 'warn' : 'default'}>{item.severity}</Pill><p className="min-w-0 flex-1 text-[11.5px] font-medium">{item.title}</p>{item.createdAt && <span className="text-[9.5px] text-slateink-400">{new Date(item.createdAt).toLocaleString('en-GB')}</span>}</div><p className="mt-2 text-[10.5px] text-slateink-500">{item.message}</p><div className="mt-2 flex flex-wrap gap-3">{!item.readAt && <button type="button" disabled={busy} onClick={() => void updateNotice(item, 'read')} className="text-[10.5px] font-medium text-brand-700 disabled:opacity-50">Mark read</button>}<button type="button" disabled={busy} onClick={() => void updateNotice(item, 'dismiss')} className="text-[10.5px] font-medium text-slateink-400 hover:text-slate-900 disabled:opacity-50">Dismiss</button></div></div>)}{!notices.length && <p className="py-6 text-center text-[11px] text-slateink-400">No active internal automation notices.</p>}</div>
    </section></div>
  </div>;
}
