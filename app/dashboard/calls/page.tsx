'use client';

import * as React from 'react';
import { useStore } from '@/lib/store';
import { Icons } from '@/components/icons';
import { Button, EmptyState, LinkButton, useToast } from '@/components/ui';
import { CallRow, DataTable, Filters, StatCard } from '@/components/dash/bits';
import { PageHeader } from '@/components/dash/Shell';

const PAGE_SIZE = 25;

export default function CallsPage() {
  const store = useStore();
  const toast = useToast();
  const [query, setQuery] = React.useState('');
  const [active, setActive] = React.useState<Record<string, string>>({});
  const [page, setPage] = React.useState(0);

  const calls = store.calls;
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return calls.filter((c) => {
      if (q) {
        const hay = `${c.id} ${c.customer.name} ${c.customer.company ?? ''} ${c.analysis.intent} ${c.from} ${c.to}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (active.assistant && active.assistant !== 'All' && c.assistantName !== active.assistant) return false;
      if (active.type && active.type !== 'All' && c.type !== active.type.toLowerCase()) return false;
      if (active.outcome && active.outcome !== 'All') {
        const evaluation = c.analysis.successEvaluation;
        if (active.outcome === 'Resolved' && evaluation !== 'true') return false;
        if (active.outcome === 'Unresolved' && evaluation !== 'false') return false;
        if (active.outcome === 'Not evaluated' && evaluation !== 'not_evaluated') return false;
      }
      if (active.reason && active.reason !== 'All' && c.endedReason !== active.reason) return false;
      return true;
    });
  }, [calls, query, active]);

  const paged = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));

  const evaluated = filtered.filter(
    (c) => c.analysis.successEvaluation === 'true' || c.analysis.successEvaluation === 'false'
  );
  const resolved = evaluated.filter((c) => c.analysis.successEvaluation === 'true').length;
  const latencySamples = filtered.map((c) => c.metrics.latencyMs).filter((value) => value > 0);
  const avgLatency = latencySamples.length
    ? Math.round(latencySamples.reduce((sum, value) => sum + value, 0) / latencySamples.length)
    : null;
  const totalCost = filtered.reduce((s, c) => s + c.cost.total, 0);

  const exportCsv = () => {
    const cell = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const header = ['id', 'customer', 'assistant', 'type', 'intent', 'endedReason', 'durationSeconds', 'recordedCost', 'evaluation', 'score', 'startedAt'].map(cell).join(',');
    const rows = filtered.map((c) =>
      [c.id, c.customer.name, c.assistantName, c.type, c.analysis.intent, c.endedReason, c.durationSeconds, c.cost.total.toFixed(4), c.analysis.successEvaluation, c.analysis.successEvaluation === 'not_evaluated' ? '' : c.analysis.score, c.startedAt].map(cell).join(',')
    );
    const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'voxera-calls.csv';
    a.click();
    URL.revokeObjectURL(url);
    toast(`Exported ${filtered.length} calls.`);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Calls"
        desc="Stored calls with transcripts, observed runtime metrics, recorded cost components, and explicit evaluation state. Recordings appear only when a provider supplied one."
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={exportCsv}>
              <Icons.download size={13} /> Export CSV
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                store.refreshFromServer();
                toast('Refreshing calls from the server.');
              }}
            >
              <Icons.refresh size={13} /> Refresh
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Calls" value={String(filtered.length)} sub="in current view" icon="phone" />
        <StatCard
          label="Resolution"
          value={evaluated.length ? `${((resolved / evaluated.length) * 100).toFixed(1)}%` : '—'}
          sub={evaluated.length ? `${resolved} resolved · ${evaluated.length} evaluated` : 'no outcome evaluations recorded'}
          icon="check"
          tone="brand"
        />
        <StatCard label="Avg turn latency" value={avgLatency === null ? '—' : `${avgLatency}ms`} sub={latencySamples.length ? `mean of ${latencySamples.length} stored call average(s)` : 'no measured latency samples'} icon="bolt" />
        <StatCard label="Recorded cost" value={totalCost > 0 ? `$${totalCost.toFixed(2)}` : '—'} sub={totalCost > 0 && filtered.length ? `$${(totalCost / filtered.length).toFixed(3)} per call` : 'no provider or operator cost imported'} icon="dollar" />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-[240px] flex-1 items-center gap-2.5 rounded-xl border border-slate-900/[0.035] bg-ink-900/70 px-3.5 py-2.5 sm:max-w-sm">
          <Icons.search size={15} className="text-slateink-400" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
            placeholder="Search by caller, number, intent, or call id…"
            className="w-full bg-transparent text-[12.5px] text-slate-900 placeholder:text-slateink-400 focus:outline-none"
          />
        </div>
        <Filters
          filters={[
            { id: 'assistant', label: 'Assistants', options: ['All', ...Array.from(new Set(calls.map((c) => c.assistantName)))] },
            { id: 'type', label: 'Types', options: ['All', 'Inbound', 'Outbound', 'Web'] },
            { id: 'outcome', label: 'Outcomes', options: ['All', 'Resolved', 'Unresolved', 'Not evaluated'] },
            { id: 'reason', label: 'Reasons', options: ['All', 'customer-ended-call', 'assistant-ended-call', 'assistant-forwarded-call', 'silence-timeout', 'max-duration-exceeded', 'voicemail', 'customer-busy', 'error'] },
          ]}
          active={active}
          onChange={(id, v) => {
            setActive((s) => ({ ...s, [id]: v }));
            setPage(0);
          }}
        />
        {Object.values(active).some((v) => v && v !== 'All') && (
          <Button variant="quiet" size="sm" onClick={() => setActive({})}>
            <Icons.close size={12} /> Clear
          </Button>
        )}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon="phone"
          title="No calls match those filters"
          desc="Widen the date range, clear a filter, or place a test call to generate traffic."
          action={
            <LinkButton href="/dashboard/assistants" variant="brand" size="sm">
              Place a test call
            </LinkButton>
          }
        />
      ) : (
        <>
          <DataTable
            columns={[
              { key: 'id', label: 'Call' },
              { key: 'customer', label: 'Customer' },
              { key: 'assistant', label: 'Assistant' },
              { key: 'type', label: 'Type' },
              { key: 'intent', label: 'Intent' },
              { key: 'end', label: 'Ended reason' },
              { key: 'dur', label: 'Duration', align: 'right' },
              { key: 'cost', label: 'Cost', align: 'right' },
              { key: 'score', label: 'Score', align: 'right' },
              { key: 'when', label: 'When', align: 'right' },
            ]}
          >
            {paged.map((c) => (
              <CallRow key={c.id} call={c} />
            ))}
          </DataTable>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="font-mono text-[11px] text-slateink-400">
              Showing {page * PAGE_SIZE + 1}–{Math.min(filtered.length, (page + 1) * PAGE_SIZE)} of {filtered.length}
            </span>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                Previous
              </Button>
              <span className="font-mono text-[11px] text-slateink-400">
                {page + 1} / {pages}
              </span>
              <Button variant="ghost" size="sm" disabled={page >= pages - 1} onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}>
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
