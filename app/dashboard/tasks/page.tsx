'use client';

import * as React from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/dash/Shell';
import { Button, Pill } from '@/components/ui';
import { Icons } from '@/components/icons';

type TaskState = 'open' | 'in_progress' | 'completed' | 'cancelled';
type Task = {
  id: string; title: string; description?: string; type: string; priority: 'low' | 'normal' | 'high' | 'urgent';
  state: TaskState; visibility: 'administrative' | 'clinical'; resourceType: string; resourceId: string;
  assigneeId?: string; dueAt?: string; completedAt?: string; createdBy: string; revision: number;
};
type Member = { id: string; name?: string; email?: string; active?: boolean };

const headers = { 'content-type': 'application/json', 'x-voxera-synthetic-data': '1' };
const blank = { title: '', description: '', type: 'general', priority: 'normal', visibility: 'administrative', resourceType: 'workspace', resourceId: '', assigneeId: '', dueAt: '' };

function taskTone(value: string): 'default' | 'brand' | 'warn' | 'danger' {
  if (value === 'completed') return 'brand';
  if (value === 'urgent' || value === 'in_progress') return 'warn';
  if (value === 'cancelled') return 'danger';
  return 'default';
}

function resourceHref(task: Task) {
  if (task.resourceType === 'client') return `/dashboard/clients/${task.resourceId}`;
  if (task.resourceType === 'referral') return '/dashboard/referrals';
  if (task.resourceType === 'letter') return '/dashboard/letters';
  if (task.resourceType === 'form_assignment' || task.resourceType === 'form_response') return '/dashboard/forms';
  return undefined;
}

export default function TasksPage() {
  const [rows, setRows] = React.useState<Task[]>([]);
  const [members, setMembers] = React.useState<Member[]>([]);
  const [selected, setSelected] = React.useState<Task>();
  const [filter, setFilter] = React.useState<TaskState | 'active' | 'all'>('active');
  const [query, setQuery] = React.useState('');
  const [overdue, setOverdue] = React.useState(false);
  const [showNew, setShowNew] = React.useState(false);
  const [draft, setDraft] = React.useState(blank);
  const [busy, setBusy] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');

  const api = React.useCallback(async (path: string, init?: RequestInit) => {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message ?? 'The request failed.');
    return body;
  }, []);

  const load = React.useCallback(async () => {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams();
      if (!['all', 'active'].includes(filter)) params.set('state', filter);
      if (query.trim()) params.set('q', query.trim());
      if (overdue) params.set('overdue', 'true');
      const [tasksBody, teamBody] = await Promise.all([
        api(`/api/v1/tasks?${params}`),
        api('/api/v1/team?view=members').catch(() => ({ members: [] })),
      ]);
      const data = (tasksBody.data ?? []) as Task[];
      setRows(filter === 'active' ? data.filter((row) => !['completed', 'cancelled'].includes(row.state)) : data);
      setMembers((teamBody.members ?? []).filter((member: Member) => member.active !== false));
      if (selected) setSelected(data.find((row) => row.id === selected.id));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Tasks could not be loaded.'); }
    finally { setLoading(false); }
  }, [api, filter, overdue, query, selected?.id]);

  React.useEffect(() => { const timer = setTimeout(() => void load(), 150); return () => clearTimeout(timer); }, [load]);

  const create = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const body = await api('/api/v1/tasks', {
        method: 'POST', headers,
        body: JSON.stringify({
          ...draft,
          resourceId: draft.resourceType === 'workspace' ? undefined : draft.resourceId.trim(),
          assigneeId: draft.assigneeId || undefined,
          dueAt: draft.dueAt ? new Date(draft.dueAt).toISOString() : undefined,
        }),
      });
      setDraft(blank); setShowNew(false); setNotice('Task added to the administrative queue.'); setSelected(body);
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Task could not be created.'); }
    finally { setBusy(false); }
  };

  const transition = async (to: TaskState) => {
    if (!selected) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const body = await api(`/api/v1/tasks/${selected.id}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ action: 'transition', to, expectedRevision: selected.revision }),
      });
      setSelected(body); setNotice(`Task moved to ${to.replace('_', ' ')}.`); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Task could not be updated.'); }
    finally { setBusy(false); }
  };

  const memberLabel = (id?: string) => {
    const member = members.find((candidate) => candidate.id === id);
    return member?.name || member?.email || id || 'Unassigned';
  };
  const now = Date.now();
  const transitions: Record<TaskState, TaskState[]> = {
    open: ['in_progress', 'completed', 'cancelled'], in_progress: ['open', 'completed', 'cancelled'], completed: ['open'], cancelled: ['open'],
  };

  return <div className="space-y-6">
    <PageHeader
      title="Administrative tasks"
      desc="Due work, ownership and resource links in one staff queue. Automations can add tasks, but they cannot make clinical or access-to-care decisions."
      actions={<div className="flex flex-wrap gap-2"><Link href="/dashboard/automations" className="btn-ghost btn-sm"><Icons.bolt size={13} /> Automations</Link><Button size="sm" onClick={() => setShowNew((value) => !value)}><Icons.plus size={13} /> New task</Button></div>}
    />
    <section className="rounded-2xl border border-brand-500/20 bg-brand-500/[0.045] px-4 py-3 text-[12px] leading-relaxed text-slateink-600">
      Tasks are administrative prompts, not emergency monitoring. Clinical visibility adds access controls; it does not turn a task into a signed clinical record.
    </section>
    {error && <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-[12px] text-red-700">{error}</div>}
    {notice && <div role="status" className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] px-4 py-3 text-[12px] text-emerald-800">{notice}</div>}

    {showNew && <section className="panel p-5">
      <div className="flex items-start justify-between gap-3"><div><h2 className="text-[15px] font-semibold">Add task</h2><p className="mt-1 text-[11.5px] text-slateink-400">Link a patient-facing task only by its existing Voxera resource ID.</p></div><button onClick={() => setShowNew(false)} aria-label="Close new task"><Icons.close size={15} /></button></div>
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <label className="text-[11px] font-medium text-slateink-500 md:col-span-2">Title<input value={draft.title} maxLength={180} onChange={(event) => setDraft((row) => ({ ...row, title: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]" /></label>
        <label className="text-[11px] font-medium text-slateink-500">Due date and time<input type="datetime-local" value={draft.dueAt} onChange={(event) => setDraft((row) => ({ ...row, dueAt: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]" /></label>
        <label className="text-[11px] font-medium text-slateink-500 md:col-span-3">Description<textarea value={draft.description} maxLength={4000} onChange={(event) => setDraft((row) => ({ ...row, description: event.target.value }))} className="mt-1.5 min-h-20 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]" /></label>
        <label className="text-[11px] font-medium text-slateink-500">Type<select value={draft.type} onChange={(event) => setDraft((row) => ({ ...row, type: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]"><option value="general">General</option><option value="follow_up">Follow-up</option><option value="form_review">Form review</option><option value="referral_review">Referral review</option><option value="letter_review">Letter review</option><option value="reminder">Reminder</option></select></label>
        <label className="text-[11px] font-medium text-slateink-500">Priority<select value={draft.priority} onChange={(event) => setDraft((row) => ({ ...row, priority: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]"><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label>
        <label className="text-[11px] font-medium text-slateink-500">Assignee<select value={draft.assigneeId} onChange={(event) => setDraft((row) => ({ ...row, assigneeId: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]"><option value="">Unassigned</option>{members.map((member) => <option key={member.id} value={member.id}>{member.name || member.email || member.id}</option>)}</select></label>
        <label className="text-[11px] font-medium text-slateink-500">Resource<select value={draft.resourceType} onChange={(event) => setDraft((row) => ({ ...row, resourceType: event.target.value, resourceId: '' }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]"><option value="workspace">Workspace</option><option value="client">Patient/client</option><option value="referral">Referral</option><option value="form_assignment">Form assignment</option><option value="form_response">Form response</option><option value="letter">Letter</option></select></label>
        <label className="text-[11px] font-medium text-slateink-500">Resource ID<input value={draft.resourceId} disabled={draft.resourceType === 'workspace'} onChange={(event) => setDraft((row) => ({ ...row, resourceId: event.target.value }))} placeholder={draft.resourceType === 'workspace' ? 'Current workspace' : 'Existing resource ID'} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 font-mono text-[11px] disabled:bg-slate-50" /></label>
        <label className="text-[11px] font-medium text-slateink-500">Visibility<select value={draft.visibility} onChange={(event) => setDraft((row) => ({ ...row, visibility: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]"><option value="administrative">Administrative</option><option value="clinical">Clinical-restricted</option></select></label>
      </div>
      <div className="mt-4 flex justify-end"><Button size="sm" disabled={busy || draft.title.trim().length < 2 || (draft.resourceType !== 'workspace' && !draft.resourceId.trim())} onClick={() => void create()}>{busy ? 'Saving…' : 'Add task'}</Button></div>
    </section>}

    <div className="grid gap-5 xl:grid-cols-[minmax(430px,0.95fr)_minmax(0,1.05fr)] xl:items-start">
      <section className="panel overflow-hidden">
        <div className="border-b border-slate-900/[0.05] p-4"><div className="grid gap-2 sm:grid-cols-[1fr_160px_auto]"><label className="text-[10.5px] font-medium text-slateink-400">Search<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, description or resource" className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]" /></label><label className="text-[10.5px] font-medium text-slateink-400">State<select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]"><option value="active">Active</option><option value="open">Open</option><option value="in_progress">In progress</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option><option value="all">All</option></select></label><label className="mt-5 flex items-center gap-2 text-[11px] text-slateink-500"><input type="checkbox" checked={overdue} onChange={(event) => setOverdue(event.target.checked)} /> Overdue</label></div></div>
        <div className="divide-y divide-slate-900/[0.05]">{rows.map((row) => {
          const isOverdue = Boolean(row.dueAt && Date.parse(row.dueAt) < now && !['completed', 'cancelled'].includes(row.state));
          return <button key={row.id} onClick={() => setSelected(row)} className={`flex w-full gap-3 px-5 py-4 text-left hover:bg-slate-900/[0.02] ${selected?.id === row.id ? 'bg-brand-500/[0.045]' : ''}`}><span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${isOverdue || row.priority === 'urgent' ? 'bg-red-500' : row.priority === 'high' ? 'bg-amber-400' : 'bg-slate-300'}`} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="truncate text-[13px] font-semibold">{row.title}</p><Pill tone={taskTone(row.state)}>{row.state.replace('_', ' ')}</Pill>{isOverdue && <Pill tone="danger">overdue</Pill>}</div><p className="mt-1 truncate text-[11px] text-slateink-400">{memberLabel(row.assigneeId)} · {row.resourceType.replace('_', ' ')}</p><p className="mt-1 font-mono text-[9.5px] text-slateink-300">{row.dueAt ? new Date(row.dueAt).toLocaleString('en-GB') : 'No due date'} · {row.id}</p></div><Icons.chevronRight size={14} /></button>;
        })}{!loading && !rows.length && <p className="px-5 py-14 text-center text-[12px] text-slateink-400">No tasks match this queue view.</p>}</div>
      </section>

      <section className="panel min-h-[390px] p-5 xl:sticky xl:top-6">{!selected ? <div className="grid min-h-[350px] place-items-center text-center"><div><span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-slate-900/[0.04]"><Icons.check size={20} /></span><h2 className="mt-4 text-[15px] font-semibold">Select a task</h2><p className="mt-2 max-w-sm text-[12px] leading-relaxed text-slateink-400">Review ownership, due evidence and the linked resource before updating its state.</p></div></div> : <div className="space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><h2 className="text-[18px] font-semibold">{selected.title}</h2><Pill tone={taskTone(selected.state)}>{selected.state.replace('_', ' ')}</Pill></div><p className="mt-1 font-mono text-[10px] text-slateink-400">{selected.id} · revision {selected.revision}</p></div><Pill tone={taskTone(selected.priority)}>{selected.priority}</Pill></div>
        {selected.description && <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-slate-700">{selected.description}</p>}
        <dl className="grid gap-3 sm:grid-cols-2"><div className="rounded-xl bg-slate-900/[0.025] p-3"><dt className="text-[10px] font-bold uppercase tracking-wider text-slateink-300">Assignee</dt><dd className="mt-2 text-[12px]">{memberLabel(selected.assigneeId)}</dd></div><div className="rounded-xl bg-slate-900/[0.025] p-3"><dt className="text-[10px] font-bold uppercase tracking-wider text-slateink-300">Due</dt><dd className="mt-2 text-[12px]">{selected.dueAt ? new Date(selected.dueAt).toLocaleString('en-GB') : 'No due date'}</dd></div><div className="rounded-xl bg-slate-900/[0.025] p-3"><dt className="text-[10px] font-bold uppercase tracking-wider text-slateink-300">Type / visibility</dt><dd className="mt-2 text-[12px]">{selected.type.replace('_', ' ')} · {selected.visibility}</dd></div><div className="rounded-xl bg-slate-900/[0.025] p-3"><dt className="text-[10px] font-bold uppercase tracking-wider text-slateink-300">Resource</dt><dd className="mt-2 break-all font-mono text-[10.5px]">{selected.resourceType}: {selected.resourceId}</dd>{resourceHref(selected) && <Link href={resourceHref(selected)!} className="mt-2 inline-flex text-[10.5px] font-medium text-brand-700">Open resource →</Link>}</div></dl>
        <div><h3 className="text-[11px] font-bold uppercase tracking-wider text-slateink-300">Update state</h3><div className="mt-2 flex flex-wrap gap-2">{transitions[selected.state].map((state) => <Button key={state} size="sm" variant={state === 'completed' ? 'primary' : 'ghost'} disabled={busy} onClick={() => void transition(state)}>{state.replace('_', ' ')}</Button>)}</div></div>
      </div>}</section>
    </div>
  </div>;
}
