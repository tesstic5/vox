'use client';

import * as React from 'react';
import { useStore } from '@/lib/store';
import { fmtDate } from '@/lib/utils';
import { Ago } from '@/components/dash/Ago';
import { Icons } from '@/components/icons';
import { Button, EmptyState, useToast } from '@/components/ui';
import { PageHeader } from '@/components/dash/Shell';

const csvCell = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;

export default function AuditPage() {
  const store = useStore();
  const toast = useToast();
  const [query, setQuery] = React.useState('');
  const [actor, setActor] = React.useState('all');

  const rows = store.audit.map((entry) => ({
    id: String(entry.id),
    at: String(entry.at),
    actor: String(entry.actor || 'unknown'),
    action: String(entry.action || 'unknown'),
    target: String(entry.target || ''),
    detail: String(entry.detail || ''),
  }));
  const actors = Array.from(new Set(rows.map((row) => row.actor))).sort();
  const visible = rows.filter((row) => {
    if (actor !== 'all' && row.actor !== actor) return false;
    const text = query.trim().toLowerCase();
    return !text || `${row.action} ${row.target} ${row.detail} ${row.actor}`.toLowerCase().includes(text);
  });

  const exportCsv = () => {
    const lines = [
      ['event_id', 'timestamp', 'actor', 'action', 'target', 'detail'].map(csvCell).join(','),
      ...visible.map((row) => [row.id, row.at, row.actor, row.action, row.target, row.detail].map(csvCell).join(',')),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `voxera-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    toast(`Exported ${visible.length} audit event${visible.length === 1 ? '' : 's'}.`);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit log"
        desc="Server-recorded workspace actions with their timestamp, actor, target and detail. The screen shows only fields the audit store actually records."
        breadcrumb={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Audit log' }]}
        actions={<Button variant="brand" size="sm" onClick={exportCsv} disabled={!visible.length}><Icons.download size={14} /> Export visible CSV</Button>}
      />

      <div className="panel p-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="relative flex min-w-[240px] flex-1 items-center sm:max-w-md">
            <Icons.search size={14} className="pointer-events-none absolute left-3 text-slateink-400" />
            <input className="field w-full pl-9" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search action, target, detail or actor…" aria-label="Search audit events" />
          </label>
          <select className="field h-10 w-full sm:w-[230px]" value={actor} onChange={(event) => setActor(event.target.value)} aria-label="Filter audit events by actor">
            <option value="all">All actors</option>
            {actors.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <span className="font-mono text-[10.5px] text-slateink-400">{visible.length} of {rows.length} loaded</span>
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState icon="terminal" title={rows.length ? 'No events match' : 'No audit events loaded'} desc={rows.length ? 'Clear or change the filters.' : 'The server has not returned an audit event for this workspace.'} />
      ) : (
        <div className="panel overflow-hidden">
          <div className="hidden grid-cols-[150px_minmax(180px,0.9fr)_minmax(150px,0.8fr)_minmax(140px,0.8fr)_minmax(220px,1.4fr)] gap-3 border-b border-slate-900/[0.04] px-4 py-2.5 font-mono text-[9.5px] uppercase tracking-wide text-slateink-400 lg:grid">
            <span>When</span><span>Action</span><span>Target</span><span>Actor</span><span>Detail</span>
          </div>
          {visible.slice(0, 250).map((row) => (
            <div key={row.id} className="grid grid-cols-1 gap-2 border-b border-slate-900/[0.035] px-4 py-3 last:border-0 lg:grid-cols-[150px_minmax(180px,0.9fr)_minmax(150px,0.8fr)_minmax(140px,0.8fr)_minmax(220px,1.4fr)] lg:gap-3">
              <span className="font-mono text-[10.5px] text-slateink-400" title={fmtDate(row.at)}><Ago at={row.at} /></span>
              <span className="break-words font-mono text-[11.5px] text-slate-900">{row.action}</span>
              <span className="break-all text-[11.5px] text-slateink-300">{row.target || '—'}</span>
              <span className="break-words text-[11.5px] text-slateink-300">{row.actor}</span>
              <span className="break-words text-[11.5px] leading-relaxed text-slateink-400">{row.detail || '—'}</span>
            </div>
          ))}
        </div>
      )}

      {visible.length > 250 && <p className="text-center text-[11.5px] text-slateink-400">Showing the first 250 loaded matches. Export includes all {visible.length}.</p>}
      <div className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.055] p-4 text-[12.5px] leading-relaxed text-amber-900">
        This is an application audit trail, not a cryptographically immutable external ledger. Source IP, export-delivery status and retention length are not displayed because these audit rows do not carry those facts.
      </div>
    </div>
  );
}
