'use client';

import * as React from 'react';
import { cn, fmtDate } from '@/lib/utils';
import { Button, EmptyState, Pill, useToast } from '@/components/ui';
import { PageHeader } from '@/components/dash/Shell';
import { StatCard } from '@/components/dash/bits';

type LeadStatus = 'new' | 'contacted' | 'demo' | 'won' | 'lost';
type Lead = {
  id: string;
  name: string;
  email: string;
  company: string;
  role?: string;
  goal?: string;
  volume?: string;
  requirements?: string[];
  timeline?: string;
  phone?: string;
  notes?: string;
  status: LeadStatus;
  assignee?: string;
  source: string;
  createdAt?: string;
  log?: { at: string; by: string; text: string }[];
};

const STATUSES: { id: LeadStatus; label: string; tone: 'default' | 'brand' | 'warn' | 'danger' | 'info' }[] = [
  { id: 'new', label: 'New', tone: 'info' },
  { id: 'contacted', label: 'Contacted', tone: 'default' },
  { id: 'demo', label: 'Demo', tone: 'warn' },
  { id: 'won', label: 'Won', tone: 'brand' },
  { id: 'lost', label: 'Lost', tone: 'danger' },
];

export default function LeadsPage() {
  const toast = useToast();
  const [leads, setLeads] = React.useState<Lead[]>([]);
  const [stats, setStats] = React.useState<Record<string, number>>({});
  const [filter, setFilter] = React.useState<'all' | LeadStatus>('all');
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [forbidden, setForbidden] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    const res = await fetch('/api/v1/leads', { credentials: 'include' });
    if (res.status === 403) {
      setForbidden(true);
      setLoading(false);
      return;
    }
    if (res.ok) {
      const data = (await res.json()) as { data: Lead[]; stats: Record<string, number> };
      setLeads(data.data);
      setStats(data.stats);
      setSelectedId((cur) => cur ?? data.data[0]?.id ?? null);
    }
    setLoading(false);
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const selected = leads.find((l) => l.id === selectedId) ?? null;
  const shown = filter === 'all' ? leads : leads.filter((l) => l.status === filter);

  const patch = async (patchBody: Record<string, string>) => {
    if (!selected || busy) return;
    setBusy(true);
    const res = await fetch(`/api/v1/leads/${selected.id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patchBody),
    });
    setBusy(false);
    if (!res.ok) {
      toast('That change did not save. Try again.', 'error');
      return;
    }
    const updated = (await res.json()) as Lead;
    setLeads((rows) => rows.map((r) => (r.id === updated.id ? updated : r)));
    setStats((s) => {
      const next = { ...s };
      if (patchBody.status) {
        next[selected.status] = Math.max(0, (next[selected.status] ?? 1) - 1);
        next[patchBody.status] = (next[patchBody.status] ?? 0) + 1;
      }
      return next;
    });
    if (patchBody.note) setNote('');
  };

  if (forbidden) {
    return (
      <div className="space-y-6">
        <PageHeader title="Leads" desc="Enquiries from the sales form, and the pipeline they move through." />
        <EmptyState
          title="This inbox is not yours to work"
          desc="Sales leads go to the team that answers the form. If that is you, ask an administrator to add your email to VOXERA_OPERATOR_EMAILS."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Leads" desc="Enquiries from the sales form, and the pipeline they move through. Nothing here is auto-emailed or auto-dialled — a person works these." />

      <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Total" value={String(stats.total ?? leads.length)} icon="users" />
        {STATUSES.map((s) => (
          <StatCard key={s.id} label={s.label} value={String(stats[s.id] ?? 0)} icon="trend" />
        ))}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {(['all', ...STATUSES.map((s) => s.id)] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              'rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors',
              filter === f ? 'border-brand-500/40 bg-brand-500/10 text-brand-700' : 'border-slate-900/[0.035] text-slateink-400 hover:text-slate-900'
            )}
          >
            {f === 'all' ? 'All' : STATUSES.find((s) => s.id === f)?.label} ({f === 'all' ? leads.length : (stats[f] ?? 0)})
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-[13px] text-slateink-400">Loading leads…</p>
      ) : shown.length === 0 ? (
        <EmptyState
          title={filter === 'all' ? 'No leads yet' : `No ${filter} leads`}
          desc="When somebody submits the Contact sales form, their enquiry lands here as a lead — name, company, what they want, and when they want it."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <div className="overflow-hidden rounded-2xl border border-slate-900/[0.035]">
            {shown.map((lead) => (
              <button
                key={lead.id}
                onClick={() => setSelectedId(lead.id)}
                className={cn(
                  'block w-full border-b border-slate-900/[0.04] px-4 py-3 text-left transition-colors last:border-0',
                  selectedId === lead.id ? 'bg-brand-500/[0.07]' : 'hover:bg-slate-900/[0.03]'
                )}
              >
                <span className="flex items-center justify-between gap-3">
                  <span className="truncate text-[13.5px] font-medium text-slate-900">{lead.company}</span>
                  <Pill tone={STATUSES.find((s) => s.id === lead.status)?.tone}>{STATUSES.find((s) => s.id === lead.status)?.label}</Pill>
                </span>
                <span className="mt-0.5 block truncate text-[12px] text-slateink-400">
                  {lead.name} · {lead.email}
                </span>
                <span className="mt-0.5 block text-[11.5px] text-slateink-400">
                  {lead.goal ?? 'No use case given'} · {lead.createdAt ? fmtDate(lead.createdAt) : ''}
                  {lead.assignee ? ` · ${lead.assignee}` : ''}
                </span>
              </button>
            ))}
          </div>

          {selected && (
            <div className="rounded-2xl border border-slate-900/[0.035] bg-ink-850/50 p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-[16px] font-semibold text-slate-900">{selected.company}</h2>
                  <p className="mt-0.5 text-[12.5px] text-slateink-400">
                    {selected.name}
                    {selected.role ? ` · ${selected.role}` : ''} ·{' '}
                    <a className="text-brand-700 hover:text-brand-700" href={`mailto:${selected.email}`}>
                      {selected.email}
                    </a>
                    {selected.phone ? ` · ${selected.phone}` : ''}
                  </p>
                </div>
                <Pill tone={STATUSES.find((s) => s.id === selected.status)?.tone}>{STATUSES.find((s) => s.id === selected.status)?.label}</Pill>
              </div>

              <dl className="mt-4 grid gap-3 text-[12.5px] sm:grid-cols-2">
                {[
                  ['Use case', selected.goal],
                  ['Volume', selected.volume],
                  ['Timeline', selected.timeline],
                  ['Requirements', selected.requirements?.join(', ')],
                  ['Source', selected.source],
                  ['Received', selected.createdAt ? fmtDate(selected.createdAt) : undefined],
                ]
                  .filter(([, v]) => v)
                  .map(([k, v]) => (
                    <div key={k}>
                      <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-slateink-400">{k}</dt>
                      <dd className="mt-0.5 text-slateink-200">{v}</dd>
                    </div>
                  ))}
              </dl>
              {selected.notes && <p className="mt-4 rounded-xl bg-slate-900/[0.03] p-3 text-[12.5px] leading-relaxed text-slateink-300">{selected.notes}</p>}

              <div className="mt-5">
                <div className="label">Move to</div>
                <div className="flex flex-wrap gap-1.5">
                  {STATUSES.map((s) => (
                    <button
                      key={s.id}
                      disabled={busy || selected.status === s.id}
                      onClick={() => void patch({ status: s.id })}
                      className={cn(
                        'rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40',
                        selected.status === s.id ? 'border-brand-500/40 bg-brand-500/10 text-brand-700' : 'border-slate-900/[0.035] text-slateink-300 hover:text-slate-900'
                      )}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-4">
                <div className="label">Assigned to</div>
                <input
                  className="field"
                  placeholder="teammate@company.com"
                  defaultValue={selected.assignee ?? ''}
                  key={selected.id + (selected.assignee ?? '')}
                  onBlur={(e) => {
                    if (e.target.value !== (selected.assignee ?? '')) void patch({ assignee: e.target.value });
                  }}
                />
              </div>

              <div className="mt-4">
                <div className="label">Add a note</div>
                <textarea className="field min-h-[72px] resize-y" placeholder="Called Tuesday — wants a pilot on the support line…" value={note} onChange={(e) => setNote(e.target.value)} />
                <Button size="sm" className="mt-2" disabled={busy || !note.trim()} onClick={() => void patch({ note })}>
                  Add note
                </Button>
              </div>

              {!!selected.log?.length && (
                <div className="mt-5 border-t border-slate-900/[0.04] pt-4">
                  <div className="label">History</div>
                  <ul className="mt-2 space-y-2">
                    {[...selected.log].reverse().map((entry, i) => (
                      <li key={i} className="text-[12px] leading-relaxed text-slateink-400">
                        <span className="text-slateink-400">{fmtDate(entry.at)} · {entry.by}</span>
                        <span className="block text-slateink-300">{entry.text}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
