'use client';

import Link from 'next/link';
import { useStore } from '@/lib/store';
import { Icons } from '@/components/icons';
import { EmptyState, LinkButton, Pill } from '@/components/ui';
import { PageHeader } from '@/components/dash/Shell';
import { StatCard } from '@/components/dash/bits';

function valueOrDash(value: number | undefined, format: (value: number) => string = String) {
  return value === undefined ? '—' : format(value);
}

export default function ObservabilityPage() {
  const store = useStore();
  const metrics = store.serverMetrics;
  const recent = store.calls.slice(0, 8);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Observability"
        desc="Server-computed call totals, cost and turn latency for this workspace. No synthetic provider health or generated time series are shown."
        breadcrumb={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Observability' }]}
        actions={
          <LinkButton href="/dashboard/observability/wallboard" variant="ghost" size="sm">
            <Icons.chart size={13} /> Wallboard
          </LinkButton>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label={`Calls (${metrics?.windowDays ?? 14}d)`} value={valueOrDash(metrics?.calls, (value) => value.toLocaleString())} sub={metrics ? `${metrics.ended ?? 0} ended · ${metrics.inProgress ?? 0} in progress` : 'waiting for server metrics'} icon="phone" tone="brand" />
        <StatCard label="Voice-to-voice p50" value={metrics?.latency.samples ? `${metrics.latency.p50}ms` : '—'} sub={metrics?.latency.samples ? `p90 ${metrics.latency.p90}ms · p99 ${metrics.latency.p99}ms · ${metrics.latency.samples} samples` : 'no measured turns in this window'} icon="bolt" />
        <StatCard label="Call minutes" value={valueOrDash(metrics?.minutes, (value) => value.toLocaleString(undefined, { maximumFractionDigits: 1 }))} sub="ended calls in the selected server window" icon="clock" />
        <StatCard label="Recorded call cost" value={metrics?.cost && metrics.cost > 0 ? `$${metrics.cost.toFixed(2)}` : '—'} sub={metrics?.cost && metrics.cost > 0 ? 'sum of imported cost fields on ended calls' : 'no provider or operator cost imported'} icon="dollar" />
      </div>

      {!metrics ? (
        <EmptyState icon="bolt" title="Metrics are not connected" desc="The dashboard has not received a metrics response for this signed-in workspace. Reload after the server connection is available." />
      ) : (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)] xl:items-start">
          <section className="panel p-5" aria-labelledby="quality-title">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 id="quality-title" className="text-[15px] font-semibold text-slate-900">Recorded outcomes</h2>
                <p className="mt-1.5 text-[12.5px] text-slateink-400">Computed only from stored calls in the current {metrics.windowDays}-day window.</p>
              </div>
              <Pill tone="brand">server source</Pill>
            </div>
            <dl className="mt-5 grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-slate-900/[0.05] p-4">
                <dt className="font-mono text-[10px] uppercase tracking-wide text-slateink-400">Containment</dt>
                <dd className="mt-2 text-[24px] font-semibold text-slate-900">{metrics.containmentSamples && metrics.containment !== null ? `${metrics.containment.toFixed(1)}%` : '—'}</dd>
                <p className="mt-1 text-[11.5px] text-slateink-400">{metrics.containmentSamples ? `${metrics.containmentSamples} call(s) with an explicit pass/fail evaluation.` : 'No explicit outcome evaluations recorded.'}</p>
              </div>
              <div className="rounded-xl border border-slate-900/[0.05] p-4">
                <dt className="font-mono text-[10px] uppercase tracking-wide text-slateink-400">Guardrail events</dt>
                <dd className="mt-2 text-[24px] font-semibold text-slate-900">{metrics.guardrailHits.toLocaleString()}</dd>
                <p className="mt-1 text-[11.5px] text-slateink-400">Guardrail rows attached to ended call records.</p>
              </div>
            </dl>

            <div className="mt-5">
              <h3 className="text-[13px] font-semibold text-slate-900">Calls by recorded intent</h3>
              {metrics.byIntent.length ? (
                <div className="mt-3 space-y-2">
                  {[...metrics.byIntent].sort((a, b) => b.count - a.count).map((row) => (
                    <div key={row.intent} className="flex items-center justify-between gap-4 rounded-xl border border-slate-900/[0.04] px-3.5 py-2.5">
                      <span className="text-[12.5px] text-slateink-300">{row.intent || 'unclassified'}</span>
                      <span className="font-mono text-[12px] text-slate-900">{row.count.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              ) : <p className="mt-3 text-[12.5px] text-slateink-400">No ended calls have a recorded intent in this window.</p>}
            </div>
          </section>

          <section className="panel p-5" aria-labelledby="recent-calls-title">
            <h2 id="recent-calls-title" className="text-[15px] font-semibold text-slate-900">Recent stored calls</h2>
            <p className="mt-1.5 text-[12px] text-slateink-400">Open a call for its stored transcript, runtime metrics and raw call record.</p>
            {recent.length ? (
              <div className="mt-4 divide-y divide-slate-900/[0.04]">
                {recent.map((call) => (
                  <Link key={call.id} href={`/dashboard/calls/${call.id}`} className="flex items-center gap-3 py-3 hover:text-brand-700">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[11.5px] text-brand-700">{call.id}</span>
                      <span className="mt-1 block truncate text-[11.5px] text-slateink-400">{call.assistantName} · {call.status.replaceAll('_', ' ')}</span>
                    </span>
                    <span className="shrink-0 text-right font-mono text-[11px] text-slateink-300">
                      {call.metrics.latencyMs > 0 ? `${call.metrics.latencyMs}ms` : 'no latency'}
                    </span>
                  </Link>
                ))}
              </div>
            ) : <p className="mt-4 text-[12.5px] text-slateink-400">No call records are available for this workspace.</p>}
          </section>
        </div>
      )}

      <div className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] p-4 text-[12.5px] leading-relaxed text-amber-900">
        Provider-specific uptime, regional burn rates and alert delivery are not inferred from call rows. Connect dedicated telemetry before using this screen for an operational SLA.
      </div>
    </div>
  );
}
