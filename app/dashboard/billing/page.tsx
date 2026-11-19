'use client';

import * as React from 'react';
import Link from 'next/link';
import { request } from '@/lib/server-sync';
import { Icons } from '@/components/icons';
import { BarChart, Button, EmptyState, LinkButton, Progress, Pill } from '@/components/ui';
import { PageHeader } from '@/components/dash/Shell';
import { StatCard } from '@/components/dash/bits';

interface UsageReport {
  window_days: number;
  calls: number;
  usage_events: number;
  minutes: number;
  cost: {
    platform_usd: number;
    stt_usd: number;
    tts_usd: number;
    llm_usd: number;
    telephony_usd: number;
    total_usd: number;
  };
  daily: Array<{ date: string; calls: number; minutes: number; cost: number }>;
}

const usd = (value: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);

export default function BillingPage() {
  const [days, setDays] = React.useState<30 | 90>(30);
  const [usage, setUsage] = React.useState<UsageReport | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    request<UsageReport>('GET', `/api/v1/usage?days=${days}`)
      .then((report) => { if (!cancelled) setUsage(report); })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : 'Usage could not be loaded.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [days]);

  const downloadCsv = () => {
    if (!usage) return;
    const rows = [['date', 'calls', 'minutes', 'recorded_cost_usd'], ...usage.daily.map((row) => [row.date, String(row.calls), String(row.minutes), String(row.cost)])];
    const blob = new Blob([rows.map((row) => row.join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `voxera-usage-${usage.window_days}d.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const costRows = usage ? [
    { label: 'Platform', value: usage.cost.platform_usd, color: '#2BE38B', note: 'recorded on call rows' },
    { label: 'Speech to text', value: usage.cost.stt_usd, color: '#6EA8FE', note: 'recorded provider cost' },
    { label: 'Text to speech', value: usage.cost.tts_usd, color: '#C77DFF', note: 'recorded provider cost' },
    { label: 'Language model', value: usage.cost.llm_usd, color: '#F2A65A', note: 'recorded provider cost' },
    { label: 'Telephony', value: usage.cost.telephony_usd, color: '#FB7185', note: 'recorded carrier cost' },
  ] : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Billing & usage"
        desc="Metered usage read from this workspace's ended call records. This page does not assume a payment card, budget or external-provider invoice."
        breadcrumb={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Billing' }]}
        actions={
          <>
            <LinkButton href="/pricing" variant="ghost" size="sm"><Icons.dollar size={13} /> Published rates</LinkButton>
            <Button variant="brand" size="sm" disabled={!usage} onClick={downloadCsv}><Icons.download size={14} /> Export usage CSV</Button>
          </>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2" role="group" aria-label="Usage window">
          {([30, 90] as const).map((value) => (
            <button key={value} onClick={() => setDays(value)} aria-pressed={days === value} className={days === value ? 'btn-brand btn-sm' : 'btn-ghost btn-sm'}>
              {value} days
            </button>
          ))}
        </div>
        {usage ? <Pill tone="brand">server usage · {usage.window_days}d</Pill> : null}
      </div>

      {error ? <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-[12.5px] text-red-700">{error}</div> : null}
      {loading ? <div className="panel p-6"><div className="h-4 w-52 animate-pulse rounded bg-slate-900/[0.06]" /></div> : null}

      {!loading && !usage ? <EmptyState icon="dollar" title="Usage is unavailable" desc="No server usage report was returned for this workspace." /> : null}

      {usage ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Recorded cost" value={usd(usage.cost.total_usd)} sub={`${usage.window_days}-day server window`} icon="dollar" tone="brand" />
            <StatCard label="Ended calls" value={usage.calls.toLocaleString()} sub="included in this report" icon="phone" />
            <StatCard label="Call minutes" value={usage.minutes.toLocaleString(undefined, { maximumFractionDigits: 2 })} sub="sum of ended-call duration" icon="clock" />
            <StatCard label="Usage events" value={usage.usage_events.toLocaleString()} sub="separately recorded metering events" icon="bolt" />
          </div>

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)] xl:items-start">
            <section className="panel p-5" aria-labelledby="cost-breakdown-title">
              <h2 id="cost-breakdown-title" className="text-[15px] font-semibold text-slate-900">Recorded cost breakdown</h2>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-slateink-400">These amounts are fields on stored call records. They are not proof that an external provider settled or invoiced the same amount.</p>
              <div className="mt-5 space-y-4">
                {costRows.map((row) => (
                  <div key={row.label}>
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px]">
                      <span className="flex items-center gap-2 text-slate-900"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: row.color }} />{row.label}</span>
                      <span className="font-mono text-slateink-300">{usd(row.value)} · {row.note}</span>
                    </div>
                    <div className="mt-2"><Progress value={usage.cost.total_usd > 0 ? (row.value / usage.cost.total_usd) * 100 : 0} color={row.color} /></div>
                  </div>
                ))}
              </div>
            </section>

            <section className="panel p-5" aria-labelledby="daily-usage-title">
              <h2 id="daily-usage-title" className="text-[15px] font-semibold text-slate-900">Daily recorded cost</h2>
              <p className="mt-1.5 text-[12px] text-slateink-400">One bar per day in the selected server window.</p>
              <div className="mt-5">
                <BarChart data={usage.daily.map((row) => ({ label: row.date, value: row.cost }))} color="#2BE38B" height={180} />
              </div>
              {!usage.daily.some((row) => row.calls > 0) ? <p className="mt-3 text-[12px] text-slateink-400">No ended calls were recorded in this window.</p> : null}
            </section>
          </div>

          <section className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] p-5" aria-labelledby="settlement-title">
            <h2 id="settlement-title" className="text-[14px] font-semibold text-amber-900">Payment and settlement</h2>
            <p className="mt-2 max-w-4xl text-[12.5px] leading-relaxed text-amber-900">
              No payment card or provider settlement state is exposed by the current billing API. Configure external providers in <Link href="/dashboard/providers" className="font-medium underline">Providers</Link> and reconcile their invoices independently before treating these recorded costs as settled charges.
            </p>
          </section>
        </>
      ) : null}
    </div>
  );
}
