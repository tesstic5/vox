'use client';

import * as React from 'react';
import { useStore } from '@/lib/store';
import { cn, pinnedNow } from '@/lib/utils';
import { Icons } from '@/components/icons';
import { AreaChart, BarChart, Button, Donut, Progress, useToast } from '@/components/ui';
import { PageHeader } from '@/components/dash/Shell';
import { buildAnalytics, deltaPct, inWindow, type AnalyticsReport } from '@/lib/analytics';
import { request } from '@/lib/server-sync';
import { StatCard } from '@/components/dash/bits';

export default function AnalyticsPage() {
  const store = useStore();
  const toast = useToast();
  const [range, setRange] = React.useState('30d');
  const [metric, setMetric] = React.useState<'calls' | 'cost' | 'latency'>('calls');

  const allCalls = store.calls;
  // Headline figures come from GET /api/v1/analytics, which aggregates over
  // every stored call; the local snapshot only carries the newest 100, so
  // counting client-side silently truncated. Without a session the same
  // math runs locally over what the browser holds.
  const days = range === '7d' ? 7 : range === '90d' ? 90 : 30;
  const now = pinnedNow();
  const calls = React.useMemo(() => inWindow(allCalls, now, days), [allCalls, now, days]);
  const localReport = React.useMemo(() => buildAnalytics(allCalls, now, days), [allCalls, now, days]);
  const [serverReport, setServerReport] = React.useState<AnalyticsReport | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    request<AnalyticsReport>('GET', `/api/v1/analytics?days=${days}`)
      .then((r) => { if (!cancelled) setServerReport(r); })
      .catch(() => { if (!cancelled) setServerReport(null); });
    return () => { cancelled = true; };
  }, [days]);
  const report = serverReport && serverReport.days === days ? serverReport : localReport;
  const cur = report.current;
  const lat = cur.latency;
  const prevLat = { p50: report.previous.p50 };
  const totalCost = cur.totalCost;
  const prevCost = report.previous.totalCost;
  const platform = cur.segments.platform;
  const provider = totalCost - platform;
  const resolved = cur.resolved;
  const evaluated = cur.evaluated;
  const containment = cur.containment;
  const prevContainment = report.previous.containment;
  const totalMinutes = cur.minutes;
  const peak = cur.peakConcurrency;
  const under500 = cur.under500Pct;
  const byDay = cur.series;

  const intents = cur.byIntent;
  const byAssistant = cur.byAssistant;
  const costSegments = [
    { label: 'Platform', value: cur.segments.platform, color: '#2BE38B' },
    { label: 'Speech-to-text', value: cur.segments.stt, color: '#6EA8FE' },
    { label: 'Language model', value: cur.segments.llm, color: '#D2FD45' },
    { label: 'Text-to-speech', value: cur.segments.tts, color: '#F59E0B' },
    { label: 'Telephony', value: cur.segments.telephony, color: '#A78BFA' },
  ];

  // A real export: the rows this page is already showing, as a CSV the
  // browser downloads. (This used to toast "check your email for the
  // PDF" and generate nothing.)
  const exportReport = () => {
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [
      ['Analytics export', `last ${range}`, new Date().toISOString()].map(esc).join(','),
      [],
      ['Summary'].map(esc).join(','),
      ['calls', 'test calls', 'recorded total cost', 'recorded platform component', 'recorded non-platform components', 'evaluated', 'resolved', 'containment %'].map(esc).join(','),
      [cur.calls, cur.testCalls, totalCost.toFixed(2), platform.toFixed(2), provider.toFixed(2), evaluated, resolved, evaluated ? containment.toFixed(1) : 'not evaluated'].map(esc).join(','),
      [],
      ['By assistant', 'calls', 'recorded cost', 'evaluated', 'resolved'].map(esc).join(','),
      ...byAssistant.map((r) => [r.name, r.calls, r.cost.toFixed(2), r.evaluated, r.resolved].map(esc).join(',')),
      [],
      ['By intent', 'calls'].map(esc).join(','),
      ...intents.map((i) => [i.label, i.value].map(esc).join(',')),
      [],
      ['By day', 'calls', 'cost', 'avg latency ms'].map(esc).join(','),
      ...byDay.map((d) => [d.label, d.calls, d.cost, d.avgLatency].map(esc).join(',')),
      [],
      ['Calls', 'started', 'assistant', 'intent', 'duration s', 'cost', 'resolved'].map(esc).join(','),
      ...calls.map((c) =>
        [c.id, c.startedAt, c.assistantName, c.analysis.intent, c.durationSeconds ?? '', c.cost.total.toFixed(2), c.analysis.successEvaluation === 'true' ? 'yes' : c.analysis.successEvaluation === 'false' ? 'no' : 'not evaluated'].map(esc).join(',')
      ),
    ];
    const blob = new Blob([lines.join(String.fromCharCode(10))], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `voxera-analytics-${range}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast(`Analytics exported — ${cur.calls} calls, last ${range}.`, 'success');
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Analytics"
        desc="Stored volume, measured latency, recorded cost components, and explicit evaluations — without inferring provider invoices."
        actions={
          <>
            <div className="flex rounded-lg border border-slate-900/[0.035] bg-ink-900/70 p-0.5">
              {['7d', '30d', '90d'].map((r) => (
                <button
                  key={r}
                  onClick={() => setRange(r)}
                  className={cn(
                    'rounded-md px-3 py-1.5 font-mono text-[11px] transition-colors',
                    range === r ? 'bg-white text-black' : 'text-slateink-400 hover:text-slate-900'
                  )}
                >
                  {r}
                </button>
              ))}
            </div>
            <Button variant="ghost" size="sm" onClick={exportReport}>
              <Icons.download size={13} /> Export report
            </Button>
          </>
        }
      />

      {cur.testCalls > 0 && (
        <div role="status" className="rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-4 py-3 text-[12.5px] text-amber-900">
          This window includes {cur.testCalls} explicitly labelled demo, simulation, public-demo, or dashboard browser-test call{cur.testCalls === 1 ? '' : 's'}. They are stored records, not carrier-delivered calls.
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Calls" value={cur.calls.toLocaleString()} delta={deltaPct(cur.calls, report.previous.calls) ?? undefined} sub={report.previous.calls ? `last ${range} · vs previous ${range}` : `last ${range} · no earlier period`} icon="phone" />
        <StatCard
          label="Containment"
          value={evaluated ? `${containment.toFixed(1)}%` : '—'}
          delta={evaluated && report.previous.evaluated ? `${containment - prevContainment >= 0 ? '+' : ''}${(containment - prevContainment).toFixed(1)}pts` : undefined}
          sub={evaluated ? `${resolved} resolved · ${evaluated} evaluated` : 'no outcome evaluations recorded'}
          icon="check"
          tone="brand"
        />
        <StatCard
          label="Median latency"
          value={lat.p50 ? `${lat.p50}ms` : '—'}
          delta={lat.p50 && prevLat.p50 ? `${lat.p50 - prevLat.p50 >= 0 ? '+' : ''}${lat.p50 - prevLat.p50}ms` : undefined}
          sub={lat.samples ? `p90 ${lat.p90}ms · p99 ${lat.p99}ms · ${lat.samples} calls` : 'no calls with latency yet'}
          icon="bolt"
        />
        <StatCard
          label="Recorded cost / call"
          value={calls.length && totalCost > 0 ? `$${(totalCost / calls.length).toFixed(3)}` : '—'}
          delta={totalCost > 0 ? deltaPct(totalCost, prevCost) ?? undefined : undefined}
          sub={totalCost > 0 && totalMinutes > 0 ? `$${(totalCost / totalMinutes).toFixed(4)} per stored minute · ${Math.round(totalMinutes).toLocaleString()} min` : 'no provider or operator cost imported'}
          icon="dollar"
        />
      </div>

      <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/50 p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[15px] font-semibold text-slate-900">Trend</h2>
          <div className="flex gap-1.5">
            {([
              ['calls', 'Volume'],
              ['cost', 'Recorded cost'],
              ['latency', 'Latency'],
            ] as const).map(([k, l]) => (
              <button
                key={k}
                onClick={() => setMetric(k)}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-[11.5px] transition-colors',
                  metric === k ? 'bg-slate-900/[0.08] text-slate-900' : 'text-slateink-400 hover:text-slate-900'
                )}
              >
                {l}
              </button>
            ))}
          </div>
        </div>
        <AreaChart
          series={
            metric === 'calls'
              ? [{ name: 'Calls', data: byDay.map((d) => d.calls) }]
              : metric === 'cost'
                ? [{ name: 'Spend', data: byDay.map((d) => d.cost) }]
                : [{ name: 'Latency', data: byDay.map((d) => d.avgLatency) }]
          }
          labels={byDay.map((d) => d.label)}
          height={260}
          colors={metric === 'latency' ? ['#D2FD45'] : ['#2BE38B']}
          valueFormat={metric === 'cost' ? (v) => `$${v.toFixed(2)}` : metric === 'latency' ? (v) => `${Math.round(v)}ms` : undefined}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/50 p-5">
          <h2 className="text-[15px] font-semibold text-slate-900">Top intents</h2>
          <p className="mt-1 text-[12px] text-slateink-400">Extracted per call by the analysis pipeline.</p>
          <div className="mt-5">
            <BarChart data={intents} horizontal height={220} />
          </div>
        </div>

        <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/50 p-5">
          <h2 className="text-[15px] font-semibold text-slate-900">Recorded cost components</h2>
          <p className="mt-1 text-[12px] text-slateink-400">Components recorded on stored calls; reconcile them against provider invoices.</p>
          <div className="mt-6 flex flex-wrap items-center gap-8">
            <Donut
              segments={costSegments}
              center={
                <div>
                  <div className="text-[18px] font-semibold text-slate-900">${totalCost.toFixed(2)}</div>
                  <div className="font-mono text-[9.5px] uppercase tracking-wider text-slateink-400">total</div>
                </div>
              }
            />
            <div className="min-w-[180px] flex-1 space-y-2.5">
              {costSegments.map((s) => (
                <div key={s.label} className="flex items-center gap-2.5">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} />
                  <span className="text-[12px] text-slateink-300">{s.label}</span>
                  <span className="ml-auto font-mono text-[11.5px] text-slate-900">${s.value.toFixed(3)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/50 p-5">
        <h2 className="text-[15px] font-semibold text-slate-900">By assistant</h2>
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left">
            <thead>
              <tr className="border-b border-slate-900/[0.045]">
                {['Assistant', 'Calls', 'Containment', 'Spend', 'Cost / call', 'Share of volume'].map((h) => (
                  <th key={h} className="px-3 py-3 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-slateink-400">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-900/[0.03]">
              {byAssistant.map((row) => (
                <tr key={row.name}>
                  <td className="px-3 py-3 text-[12.5px] text-slate-900">{row.name}</td>
                  <td className="px-3 py-3 font-mono text-[11.5px] text-slateink-300">{row.calls}</td>
                  <td className="px-3 py-3 font-mono text-[11.5px] text-brand-700">
                    {row.evaluated ? `${((row.resolved / row.evaluated) * 100).toFixed(1)}%` : '—'}
                  </td>
                  <td className="px-3 py-3 font-mono text-[11.5px] text-slateink-300">${row.cost.toFixed(2)}</td>
                  <td className="px-3 py-3 font-mono text-[11.5px] text-slateink-300">${(row.cost / row.calls).toFixed(3)}</td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-3">
                      <Progress value={cur.calls ? (row.calls / cur.calls) * 100 : 0} className="w-[120px]" />
                      <span className="font-mono text-[10.5px] text-slateink-400">
                        {cur.calls ? ((row.calls / cur.calls) * 100).toFixed(0) : '0'}%
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/50 p-5 lg:col-span-2">
          <h2 className="text-[15px] font-semibold text-slate-900">Usage in period</h2>
          <p className="mt-1 text-[12px] text-slateink-400">
            Measured from this workspace&apos;s stored call records for the last {range}. No plan allowance or provider invoice is inferred.
          </p>
          <dl className="mt-5 grid gap-3 sm:grid-cols-3">
            {[
              ['Stored call minutes', Math.round(totalMinutes).toLocaleString(), `within the selected ${range}`],
              ['Observed peak concurrency', peak.toLocaleString(), 'derived from stored call intervals'],
              ['Phone number records', store.numbers.length.toLocaleString(), 'carrier-backed and sandbox records are labelled separately'],
            ].map(([label, value, hint]) => (
              <div key={label} className="rounded-xl border border-slate-900/[0.04] bg-ink-900/40 p-4">
                <dt className="text-[11.5px] text-slateink-400">{label}</dt>
                <dd className="mt-2 font-mono text-[19px] text-slate-900">{value}</dd>
                <p className="mt-1 text-[10.5px] leading-snug text-slateink-400">{hint}</p>
              </div>
            ))}
          </dl>
        </div>

        <div className="rounded-2xl border border-brand-500/20 bg-gradient-to-br from-brand-500/[0.08] to-ink-850/60 p-5">
          <h2 className="text-[14.5px] font-semibold text-slate-900">Latency budget</h2>
          <div className="mt-5 space-y-3.5">
            {[
              ['Median (p50)', lat.p50],
              ['p90', lat.p90],
              ['p99', lat.p99],
              [`Calls under 500ms`, null],
            ].map(([k, v]) => (
              <div key={String(k)} className="flex items-center justify-between">
                <span className="text-[12px] text-slateink-300">{String(k)}</span>
                <span className="font-mono text-[12px] text-slate-900">{v === null ? `${under500.toFixed(0)}%` : lat.samples ? `${String(v)}ms` : '—'}</span>
              </div>
            ))}
          </div>
          <div className="mt-5 border-t border-slate-900/[0.035] pt-4">
            <div className="flex items-center justify-between">
              <span className="text-[12.5px] font-medium text-slate-900">Voice to voice</span>
              <span className="font-mono text-[13px] text-brand-700">{lat.p50 ? `${lat.p50}ms` : '—'}</span>
            </div>
            <p className="mt-2 text-[11.5px] leading-relaxed text-slateink-400">
              500ms is a display reference, not a promised service level or a universal perception threshold.{' '}
              {lat.p50 ? (lat.p50 < 500 ? `The observed median is ${500 - lat.p50}ms below that reference.` : `The observed median is ${lat.p50 - 500}ms above that reference.`) : 'No latency recorded in this period yet.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
