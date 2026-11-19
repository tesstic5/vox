'use client';

import * as React from 'react';
import Link from 'next/link';
import { useStore } from '@/lib/store';
import { cn, fmtDuration, pinnedNow } from '@/lib/utils';
import { Ago } from '@/components/dash/Ago';
import { Icons } from '@/components/icons';
import { AreaChart, Button, LinkButton, Progress, Sparkline } from '@/components/ui';
import { CallRow, DataTable, StatCard, StatusDot } from '@/components/dash/bits';
import { request } from '@/lib/server-sync';
import { PageHeader } from '@/components/dash/Shell';
import { buildAnalytics, deltaPct, type AnalyticsReport } from '@/lib/analytics';

/**
 * The setup card reads the real thing.
 *
 * These four steps are computed from the workspace's own collections by the API,
 * so a card that says "done" means the assistant, number, call or webhook exists —
 * it cannot be ticked by clicking around.
 */
type SetupStep = { id: string; title: string; detail: string; done: boolean };
/** The practice's own checklist — see `lib/server/practice-setup.ts`. */
type PracticeStep = { id: string; title: string; why: string; done: boolean; href: string; action: string; detail?: string };
type PracticeSetup = { steps: PracticeStep[]; done: number; total: number; percent: number; complete: boolean; empty: boolean };

export default function DashboardOverview() {
  const store = useStore();
  const businessType = store.connection.org?.business?.type;
  const operationNoun = businessType === 'contractor' ? 'service operation' : businessType === 'dental' || businessType === 'physiotherapy' ? 'practice' : 'business';
  const [range, setRange] = React.useState('14d');

  const calls = store.calls;
  // Headline figures come from GET /api/v1/analytics, which aggregates over
  // every stored call; the local snapshot only carries the newest 100, so
  // counting client-side silently truncated. Without a session the same
  // math runs locally over what the browser holds.
  const days = range === '24h' ? 1 : range === '7d' ? 7 : range === '30d' ? 30 : 14;
  const now = pinnedNow();
  const localReport = React.useMemo(() => buildAnalytics(calls, now, days), [calls, now, days]);
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
  const totalCost = cur.totalCost;
  const platformCost = cur.platformCost;
  const contained = cur.resolved;
  const evaluated = cur.evaluated;
  const containmentRate = cur.containment;
  const prevContainmentRate = report.previous.containment;
  const lat = cur.latency;
  const prevP50 = report.previous.p50;
  const [setup, setSetup] = React.useState<{ steps: SetupStep[]; done: number; total: number; percent: number; complete: boolean } | null>(null);
  const [practice, setPractice] = React.useState<PracticeSetup | null>(null);
  const [practiceHidden, setPracticeHidden] = React.useState(false);
  React.useEffect(() => {
    let cancelled = false;
    request<{ steps: SetupStep[]; done: number; total: number; percent: number; complete: boolean; practice?: PracticeSetup }>('GET', '/api/v1/onboarding')
      .then((state) => {
        if (cancelled) return;
        setSetup(state);
        setPractice(state.practice ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const openSteps = setup ? setup.total - setup.done : 0;

  const daily = cur.series;

  const topIntents = cur.byIntent.slice(0, 6);

  const recent = calls.slice(0, 8);
  const recentAudit = [...store.audit]
    .sort((a, b) => Date.parse(String(b.at)) - Date.parse(String(a.at)))
    .slice(0, 6);
  const liveCall = calls.find((c) => c.status === 'in-progress');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        desc="Stored call volume, explicit evaluations, measured latency, recorded cost components, and server-derived setup records."
        actions={
          <>
            <div className="flex rounded-lg border border-slate-900/[0.035] bg-ink-900/70 p-0.5">
              {['24h', '7d', '14d', '30d'].map((r) => (
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
            <LinkButton href="/dashboard/assistants/new" variant="brand" size="sm">
              <Icons.plus size={14} /> New assistant
            </LinkButton>
          </>
        }
      />

      {cur.testCalls > 0 && (
        <div role="status" className="rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-4 py-3 text-[12.5px] text-amber-900">
          {cur.testCalls} stored call{cur.testCalls === 1 ? '' : 's'} in this window {cur.testCalls === 1 ? 'is' : 'are'} explicitly labelled as demo, simulation, public demo, or dashboard browser test—not carrier delivery.
        </div>
      )}

      {liveCall && (
        <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-brand-500/25 bg-gradient-to-r from-brand-500/[0.09] to-ink-850/60 px-5 py-4">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400 opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-brand-400" />
          </span>
          <div className="min-w-0">
            <div className="text-[13.5px] font-medium text-slate-900">
              Live call — {liveCall.customer.name} ({liveCall.customer.company})
            </div>
            <div className="mt-0.5 font-mono text-[10.5px] uppercase tracking-wider text-slateink-400">
              {liveCall.assistantName} · {liveCall.analysis.intent} · {fmtDuration(liveCall.durationSeconds)} elapsed
            </div>
          </div>
          <div className="ml-auto flex gap-2">
            <LinkButton href={`/dashboard/calls/${liveCall.id}`} variant="ghost" size="sm">
              Open live call
            </LinkButton>
          </div>
        </div>
      )}

      {/*
        The practice checklist comes first, because this is what a clinic has to
        do before anything on the rest of this screen means anything. Every step
        links straight to the screen that finishes it, and every tick is read
        from the workspace's own records — so it cannot be dismissed into a lie.
      */}
      {practice && !practice.complete && !practiceHidden && (
        <div className="panel border-emerald-500/25 p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-emerald-700">Your practice</span>
                <span className="font-mono text-[10.5px] text-slateink-400">
                  {practice.done} of {practice.total} done
                </span>
              </div>
              <h2 className="mt-2 text-[15px] font-semibold text-slate-900">
                {practice.empty ? 'Start here: your practice has nothing to book yet' : 'Finish setting up your practice'}
              </h2>
              <p className="mt-1.5 max-w-2xl text-[12.5px] leading-relaxed text-slateink-400">
                {practice.empty
                  ? 'Add the services you provide and the people who provide them so scheduling uses the same workspace records.'
                  : 'Each completed step is derived from saved locations, services, team members and availability records.'}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {practice.empty && (
                <LinkButton href="/dashboard/practice?tab=services" variant="brand" size="sm">
                  Set up my practice <Icons.arrowRight size={13} />
                </LinkButton>
              )}
              <Button variant="quiet" size="sm" onClick={() => setPracticeHidden(true)}>
                Hide
              </Button>
            </div>
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {practice.steps.map((step) => (
              <Link
                key={step.id}
                href={step.href}
                title={step.why}
                className={cn(
                  'group flex items-start gap-2.5 rounded-xl border px-3 py-2.5 transition-colors',
                  step.done ? 'border-slate-900/[0.04]' : 'border-emerald-500/25 bg-emerald-500/[0.05] hover:border-emerald-400/50'
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border',
                    step.done ? 'border-slate-900/[0.07] text-slateink-400' : 'border-emerald-400/50 text-emerald-700'
                  )}
                >
                  {step.done ? <Icons.check size={10} /> : <Icons.arrowRight size={10} />}
                </span>
                <span className="min-w-0">
                  <span className={cn('block text-[12.5px]', step.done ? 'text-slateink-400 line-through' : 'text-slate-900')}>{step.title}</span>
                  <span className="mt-0.5 block text-[10.5px] text-slateink-400">
                    {step.done ? step.detail ?? 'done' : step.why}
                  </span>
                  {!step.done && <span className="mt-1 block text-[10.5px] font-medium text-emerald-700 group-hover:underline">{step.action} →</span>}
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {setup && !setup.complete && (
        <div className="panel border-brand-500/25 p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-brand-700">Getting started</span>
                <span className="font-mono text-[10.5px] text-slateink-400">
                  {setup.done} of {setup.total} done
                </span>
              </div>
              <h2 className="mt-2 text-[15px] font-semibold text-slate-900">Get to a live call</h2>
              <p className="mt-1.5 max-w-2xl text-[12.5px] leading-relaxed text-slateink-400">
                The remaining steps explain why they matter before asking you to do them, in the order that avoids rework.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <LinkButton href="/dashboard/setup" variant="brand" size="sm">
                Set up my workspace <Icons.arrowRight size={13} />
              </LinkButton>
              <Button variant="quiet" size="sm" onClick={() => setSetup(null)}>
                Hide
              </Button>
            </div>
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {setup.steps.map((s) => {
              const done = s.done;
              return (
                <Link
                  key={s.id}
                  href="/dashboard/setup"
                  className={cn(
                    'flex items-start gap-2.5 rounded-xl border px-3 py-2.5 transition-colors',
                    done ? 'border-slate-900/[0.04] text-slateink-400' : 'border-brand-500/20 bg-brand-500/[0.04] hover:border-brand-500/40'
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border',
                      done ? 'border-slate-900/[0.07] text-slateink-400' : 'border-brand-400/40 text-brand-700'
                    )}
                  >
                    {done ? <Icons.check size={10} /> : <Icons.arrowRight size={10} />}
                  </span>
                  <span className="min-w-0">
                    <span className={cn('block text-[12.5px]', done ? 'line-through' : 'text-slate-900')}>{s.title}</span>
                    <span className="mt-0.5 block text-[10.5px] text-slateink-400">{s.detail}</span>
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Calls"
          value={cur.calls.toLocaleString()}
          delta={deltaPct(cur.calls, report.previous.calls) ?? undefined}
          sub={report.previous.calls ? 'vs previous period' : `last ${range} · no earlier period to compare`}
          icon="phone"
          spark={daily.filter((d) => d.calls > 0).map((d) => d.calls)}
        />
        <StatCard
          label="Containment"
          value={evaluated ? `${containmentRate.toFixed(1)}%` : '—'}
          delta={evaluated && report.previous.evaluated ? `${containmentRate - prevContainmentRate >= 0 ? '+' : ''}${(containmentRate - prevContainmentRate).toFixed(1)}pts` : undefined}
          sub={evaluated ? `${contained} resolved · ${evaluated} evaluated` : 'no outcome evaluations recorded'}
          icon="check"
          tone="brand"
          spark={daily.map((d) => d.contained)}
        />
        <StatCard
          label="Median latency"
          value={lat.p50 ? `${lat.p50}ms` : '—'}
          delta={lat.p50 && prevP50 ? `${lat.p50 - prevP50 >= 0 ? '+' : ''}${lat.p50 - prevP50}ms` : undefined}
          sub={lat.samples ? `stored turn latency · p90 ${lat.p90}ms · ${lat.samples} sample(s)` : 'no measured latency samples'}
          icon="bolt"
          spark={daily.map((d) => d.avgLatency)}
        />
        <StatCard
          label="Recorded cost"
          value={totalCost > 0 ? `$${totalCost.toFixed(2)}` : '—'}
          delta={totalCost > 0 ? deltaPct(totalCost, report.previous.totalCost) ?? undefined : undefined}
          sub={totalCost > 0 ? `$${platformCost.toFixed(2)} platform field · $${(totalCost - platformCost).toFixed(2)} other fields` : 'no provider or operator cost imported'}
          icon="dollar"
          spark={daily.map((d) => d.cost)}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/50 p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-[15px] font-semibold text-slate-900">Call volume & containment</h2>
              <p className="mt-1 text-[12px] text-slateink-400">Last {range === '24h' ? '24 hours' : `${days} days`}</p>
            </div>
            <div className="flex items-center gap-4 font-mono text-[10.5px] text-slateink-400">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-brand-400" /> calls
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-sky-400" /> contained
              </span>
            </div>
          </div>
          <AreaChart
            series={[
              { name: 'Calls', data: daily.map((d) => d.calls) },
              { name: 'Contained', data: daily.map((d) => d.contained) },
            ]}
            labels={daily.map((d) => d.label)}
            height={230}
            colors={['#2BE38B', '#6EA8FE']}
          />
        </div>

        <div className="space-y-4">
          <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/50 p-5">
            <h2 className="text-[15px] font-semibold text-slate-900">Top intents</h2>
            <p className="mt-1 text-[12px] text-slateink-400">Across all assistants</p>
            <div className="mt-4 space-y-3">
              {topIntents.map((t) => (
                <div key={t.label}>
                  <div className="mb-1.5 flex items-center justify-between text-[12px]">
                    <span className="capitalize text-slateink-300">{t.label}</span>
                    <span className="font-mono text-slate-900">{t.value}</span>
                  </div>
                  <Progress value={(t.value / (topIntents[0]?.value || 1)) * 100} />
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/50 p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-[15px] font-semibold text-slate-900">Recorded cost per resolved call</h2>
              <span className="font-mono text-[11px] text-brand-700">
                {totalCost > 0 && contained > 0 ? `$${(totalCost / contained).toFixed(3)}` : '—'}
              </span>
            </div>
            <div className="mt-4">
              <Sparkline data={daily.map((d) => (d.contained && d.cost > 0 ? d.cost / d.contained : 0))} height={44} color="#D2FD45" />
            </div>
            <div className="mt-4 space-y-2.5 border-t border-slate-900/[0.04] pt-4 text-[12px]">
              {totalCost > 0 ? ([
                ['Platform field', `$${platformCost.toFixed(2)}`],
                ['Speech-to-text field', `$${cur.segments.stt.toFixed(2)}`],
                ['Language-model field', `$${cur.segments.llm.toFixed(2)}`],
                ['Text-to-speech field', `$${cur.segments.tts.toFixed(2)}`],
                ['Telephony field', `$${cur.segments.telephony.toFixed(2)}`],
              ].map(([k, v]) => (
                <div key={k} className="flex items-center justify-between">
                  <span className="text-slateink-400">{k}</span>
                  <span className="font-mono text-slate-900">{v}</span>
                </div>
              ))) : (
                <p className="leading-relaxed text-slateink-400">No provider or operator cost was imported. Zero-valued fields are not a pricing claim.</p>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.75fr)]">
        <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[15px] font-semibold text-slate-900">Recent calls</h2>
            <Link href="/dashboard/calls" className="text-[12.5px] text-brand-700 hover:underline">
              View calls
            </Link>
          </div>
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
            {recent.map((c) => (
              <CallRow key={c.id} call={c} />
            ))}
          </DataTable>
        </div>

        <div className="space-y-4">
          <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/50 p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-[15px] font-semibold text-slate-900">Assistants</h2>
              <Link href="/dashboard/assistants" className="text-[12px] text-brand-700 hover:underline">
                Manage
              </Link>
            </div>
            <div className="mt-4 space-y-2.5">
              {store.assistants.slice(0, 5).map((a) => {
                const rowForA = cur.byAssistant.find((r) => r.name === a.name);
                const callsForA = rowForA ? { length: rowForA.calls } : { length: 0 };
                const rate = rowForA?.evaluated ? (rowForA.resolved / rowForA.evaluated) * 100 : null;
                return (
                  <Link
                    key={a.id}
                    href={`/dashboard/assistants/${a.id}`}
                    className="block rounded-xl border border-slate-900/[0.04] bg-ink-900/50 p-3.5 transition-colors hover:border-brand-500/30"
                  >
                    <div className="flex items-center gap-2.5">
                      <StatusDot status={a.status} />
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-slate-900">{a.name}</span>
                      <span className="font-mono text-[10.5px] text-slateink-400">{callsForA.length} calls</span>
                    </div>
                    <div className="mt-2.5 flex items-center gap-3">
                      <Progress value={rate ?? 0} className="flex-1" />
                      <span className="font-mono text-[10.5px] text-brand-700">{rate === null ? 'not evaluated' : `${rate.toFixed(0)}%`}</span>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/50 p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-[15px] font-semibold text-slate-900">Recent audit actions</h2>
              <Link href="/dashboard/audit" className="text-[12px] text-brand-700 hover:underline">Open audit log</Link>
            </div>
            <div className="mt-4 space-y-3">
              {recentAudit.length === 0 && (
                <p className="text-[12.5px] leading-relaxed text-slateink-400">No server-recorded workspace action is loaded.</p>
              )}
              {recentAudit.map((entry) => (
                <div key={entry.id} className="flex items-start gap-3">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-400/70" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] leading-snug text-slateink-200">{String(entry.action || 'workspace action')}</div>
                    <div className="mt-0.5 truncate text-[11px] text-slateink-400">{String(entry.detail || entry.target || entry.actor || 'Recorded by the server')}</div>
                    <div className="mt-0.5 font-mono text-[10px] text-slateink-400"><Ago at={String(entry.at)} /></div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-brand-500/20 bg-gradient-to-br from-brand-500/[0.08] to-ink-850/60 p-5">
            <h2 className="text-[14.5px] font-semibold text-slate-900">Quality score</h2>
            <div className="mt-3 flex items-end gap-3">
              <span className="text-[34px] font-semibold leading-none tracking-[-0.03em] text-slate-900">{cur.avgScore}</span>
              <span className="pb-1 font-mono text-[11px] text-slateink-400">/ 100 average</span>
            </div>
            <p className="mt-3 text-[12px] leading-relaxed text-slateink-300">
              Average of the analysis scores stored on {cur.ended} ended calls in this period. {cur.lowScoreCount} call records
              are below 60. The scoring method is determined by the call runtime, not inferred by this dashboard.
            </p>
            <LinkButton href="/dashboard/calls" variant="ghost" size="sm" className="mt-4 w-full">
              Open call records
            </LinkButton>
          </div>
        </div>
      </div>
    </div>
  );
}
