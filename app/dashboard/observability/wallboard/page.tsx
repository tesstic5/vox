'use client';

import * as React from 'react';
import Link from 'next/link';
import { useStore } from '@/lib/store';
import { Icons } from '@/components/icons';
import { Pill } from '@/components/ui';

export default function WallboardPage() {
  const store = useStore();
  const metrics = store.serverMetrics;
  const org = store.connection.org;
  const recent = store.calls.slice(0, 8);
  const [secondsUntilRefresh, setSecondsUntilRefresh] = React.useState(30);

  React.useEffect(() => {
    const timer = window.setInterval(() => {
      setSecondsUntilRefresh((current) => {
        if (current <= 1) {
          store.refreshFromServer();
          return 30;
        }
        return current - 1;
      });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [store.refreshFromServer]);

  const panels = [
    { label: `Calls (${metrics?.windowDays ?? 14}d)`, value: metrics ? String(metrics.calls ?? 0) : '—', sub: metrics ? `${metrics.ended ?? 0} ended` : 'waiting for server' },
    { label: 'Calls in progress', value: metrics ? String(metrics.inProgress ?? 0) : '—', sub: 'stored call status' },
    { label: 'Stored call-latency p50', value: metrics?.latency.samples ? `${metrics.latency.p50}ms` : '—', sub: metrics?.latency.samples ? `p90 ${metrics.latency.p90}ms` : 'no measured turns' },
    { label: 'Containment', value: metrics?.containmentSamples && metrics.containment !== null ? `${metrics.containment.toFixed(1)}%` : '—', sub: metrics?.containmentSamples ? `${metrics.containmentSamples} explicit evaluation(s)` : 'no outcome evaluations recorded' },
    { label: 'Call minutes', value: metrics ? metrics.minutes.toLocaleString(undefined, { maximumFractionDigits: 1 }) : '—', sub: 'ended calls in window' },
    { label: 'Recorded cost', value: metrics ? `$${metrics.cost.toFixed(2)}` : '—', sub: 'sum on ended calls' },
  ];

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex shrink-0 items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-brand-700">
            <span className={`h-2 w-2 rounded-full ${store.connection.status === 'live' ? 'bg-brand-400' : 'bg-amber-400'}`} /> {store.connection.status}
          </span>
          <span className="truncate font-mono text-[11px] uppercase tracking-[0.18em] text-slateink-400">
            {org ? `${org.name} · ${org.id}` : 'Workspace unavailable'} · wallboard
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[11px] text-slateink-400">refresh in {secondsUntilRefresh}s</span>
          <Link href="/dashboard/observability" className="btn-ghost btn-sm">
            <Icons.arrowRight size={13} /> Exit wallboard
          </Link>
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {panels.map((panel) => (
          <section key={panel.label} className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/60 p-6">
            <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-slateink-400">{panel.label}</h2>
            <div className="mt-3 text-[40px] font-semibold leading-none tracking-[-0.04em] text-slate-900 tabular">{panel.value}</div>
            <p className="mt-3 text-[13px] text-slateink-400">{panel.sub}</p>
          </section>
        ))}
      </div>

      <section className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/60 p-6" aria-labelledby="wallboard-recent-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="wallboard-recent-title" className="font-mono text-[11px] uppercase tracking-[0.18em] text-slateink-400">Recent stored calls</h2>
            <p className="mt-1.5 text-[12px] text-slateink-400">No names, phone numbers or transcript text are displayed.</p>
          </div>
          <Pill tone={metrics ? 'brand' : 'warn'}>{metrics ? 'server metrics' : 'metrics unavailable'}</Pill>
        </div>
        {recent.length ? (
          <div className="mt-5 grid gap-3 md:grid-cols-2">
            {recent.map((call) => (
              <div key={call.id} className="flex items-center gap-3 rounded-xl border border-slate-900/[0.04] px-4 py-3">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${call.status === 'in-progress' ? 'bg-brand-400' : 'bg-slate-900/25'}`} />
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-slateink-200">{call.id}</span>
                <span className="shrink-0 font-mono text-[11.5px] text-slateink-300">{call.durationSeconds}s</span>
              </div>
            ))}
          </div>
        ) : <p className="mt-5 text-[13px] text-slateink-400">No call records are available for this workspace.</p>}
      </section>

      <p className="text-center font-mono text-[10.5px] uppercase tracking-[0.18em] text-slateink-400">
        Values refresh from workspace APIs every 30 seconds; this screen does not animate or estimate missing telemetry.
      </p>
    </div>
  );
}
