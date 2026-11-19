'use client';

/**
 * Reports.
 *
 * The P7 gate is a sentence, and this page is the single screen it names: who
 * earns what, what it costs us, who does not turn up. Seven tabs, one window —
 * every figure on the screen covers the same `from → to`, resolved by the server
 * in the practice's own timezone, so two tabs can never quietly disagree about
 * what "the last 90 days" meant.
 *
 * Amounts arrive in integer minor units and are formatted here with the
 * workspace's currency; nothing on this page re-derives a number the API did not
 * send, and every rate is shown beside the counts it was computed from.
 */

import * as React from 'react';
import Link from 'next/link';
import { ApiError, request } from '@/lib/server-sync';
import { cn } from '@/lib/utils';
import { Button, EmptyState, Pill, Tabs, useToast } from '@/components/ui';
import { DataTable, StatCard } from '@/components/dash/bits';
import { PageHeader } from '@/components/dash/Shell';

/* ------------------------------------------------------------------ types */

type Money = number;

type RevenueRow = {
  id: string;
  name: string;
  appointments: number;
  attended: number;
  invoicedMinor: Money;
  collectedMinor: Money;
  outstandingMinor: Money;
  averageMinor: Money;
};

type RevenueReport = {
  range: Range;
  currency: string;
  billedMinor: Money;
  collectedMinor: Money;
  creditMinor: Money;
  outstandingMinor: Money;
  collectionRatePct: number;
  invoices: number;
  byProvider: RevenueRow[];
  byService: RevenueRow[];
  byDay: { date: string; invoicedMinor: Money }[];
};

type UtilisationReport = {
  range: Range;
  capacityMinutes: number;
  bookedMinutes: number;
  attendedMinutes: number;
  cancelledMinutes: number;
  utilisationPct: number;
  attendedPct: number;
  rows: {
    providerId: string;
    name: string;
    capacityMinutes: number;
    bookedMinutes: number;
    attendedMinutes: number;
    cancelledMinutes: number;
    utilisationPct: number;
    attendedPct: number;
    appointments: number;
    emptyDays: number;
  }[];
};

type AttendanceReport = {
  range: Range;
  attended: number;
  noShows: number;
  cancelled: number;
  noShowRatePct: number;
  cancellationRatePct: number;
  previousRatePct: number | null;
  byProvider: { providerId: string; name: string; booked: number; noShows: number; rate: number; attended: number }[];
  byService: { serviceId: string; name: string; booked: number; noShows: number; rate: number; attended: number }[];
  byWeekday: { key: string; attended: number; noShows: number; cancelled: number; rate: number }[];
  byHour: { key: string; attended: number; noShows: number; cancelled: number; rate: number }[];
};

type CostsReport = {
  range: Range;
  currency: string;
  expensesMinor: Money;
  callSpendMinor: Money;
  totalMinor: Money;
  costPerCallMinor: Money;
  costPerBookingMinor: Money;
  expenses: number;
  calls: number;
  callMinutes: number;
  byCategory: { key: string; label: string; amountMinor: Money }[];
  callSpendBreakdown: { key: string; label: string; amountMinor: Money }[];
  collectedMinor: Money;
  marginMinor: Money;
  netMinor: Money;
};

type AttributionReport = {
  range: Range;
  currency: string;
  bookings: number;
  bySource: { key: string; label: string; bookings: number; attended: number; noShows: number; cancelled: number; billedMinor: Money }[];
  calls: { total: number; handled: number; transferred: number; failed: number; inProgress: number; producedBooking: number; minutes: number; answerRatePct: number };
  assistantSharePct: number;
};

type RecallRow = {
  clientId: string;
  name: string;
  number: string;
  lastSeenAt?: string;
  lastSeenDays: number;
  overdueDays: number;
  visits: number;
  consentSms: boolean;
  consentEmail: boolean;
  /** Consent on file for a text or an email. */
  withConsent: boolean;
  /** What the sender would do with them — the same rule the button runs on. */
  reachable: boolean;
  /** Why they cannot be reached, when they cannot. */
  blockedReason?: string;
  intervalDays: number;
  intervalSource: 'service' | 'practice' | 'rule';
  serviceName?: string;
  lastRecallAt?: string;
  recallDueAt?: string;
  queued: boolean;
};

type RecallReport = {
  range: Range;
  intervalDays: number;
  due: number;
  reachable: number;
  optedOut: number;
  /** What the sender would refuse, and why — per row, not guessed from consent. */
  blocked: number;
  services: { id: string; name: string; recallDays: number | null }[];
  rows: RecallRow[];
};

type Range = { from: string; to: string; label: string; days: number; timezone: string };

type Overview = {
  range: Range;
  currency: string;
  generatedAt: string;
  earned: { billedMinor: Money; collectedMinor: Money; outstandingMinor: Money; collectionRatePct: number; invoices: number; topProvider: { name: string; invoicedMinor: Money } | null; topService: { name: string; invoicedMinor: Money; visits: number } | null };
  costs: { totalMinor: Money; practiceMinor: Money; callsMinor: Money; marginMinor: Money; netMinor: Money; callMinutes: number };
  attendance: { attended: number; noShows: number; cancelled: number; noShowRatePct: number; previousRatePct: number | null; worstWeekday: { key: string; noShows: number; rate: number } | null };
  diary: { capacityHours: number; bookedHours: number; attendedHours: number; utilisationPct: number; attendedPct: number; emptyDays: number };
  acquisition: { bookings: number; bySource: AttributionReport['bySource']; assistantSharePct: number; calls: AttributionReport['calls'] };
  recalls: {
    due: number;
    reachable: number;
    intervalDays: number;
    services: { id: string; name: string; recallDays: number | null }[];
  };
  sections: {
    revenue?: RevenueReport;
    utilisation?: UtilisationReport;
    attendance?: AttendanceReport;
    costs?: CostsReport;
    attribution?: AttributionReport;
    recalls?: RecallReport;
  };
};

/* ----------------------------------------------------------------- helpers */

const money = (minor: number, currency: string) => {
  const units = currency === 'JPY' ? 0 : 2;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: units }).format((minor ?? 0) / 10 ** units);
  } catch {
    return `${currency} ${((minor ?? 0) / 10 ** units).toFixed(units)}`;
  }
};

const hours = (minutes: number) => `${Math.round((minutes / 60) * 10) / 10}h`;

/** What each tab is for, in one sentence, shown above the numbers. */
const TAB_HINT: Record<string, string> = {
  overview: 'The headline: what came in, what it cost, who turned up, and how full the diary was.',
  revenue: 'Who earns what — every practitioner and every service, with what they brought in and what is still owed.',
  utilisation: 'How much of each person’s working day was actually sold, and how much was left empty.',
  attendance: 'Who does not turn up, by practitioner, weekday and time of day — the list worth a reminder call ahead of.',
  attribution: 'Where bookings come from: the phone, your own booking page, the front desk, or the system you already run.',
  recalls: 'Clients who have not been seen inside their own recall window — the window their last service sets — and the one button that texts them.',
  costs: 'What the practice spends, including what the AI receptionist costs per call.',
};

const PRESETS = [
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
  { id: 'month', label: 'This month' },
  { id: 'last-month', label: 'Last month' },
  { id: 'year', label: 'This year' },
];

const rate = (value: number | null | undefined) => (value === null || value === undefined ? '—' : `${value}%`);

/* ----------------------------------------------------------------- recalls */

type RecallLoopState = {
  enabled: boolean;
  channels: string[];
  cooldownDays: number;
  maxPerDay: number;
  practiceIntervalDays: number;
  sentToday: number;
};

type RecallRunSummary = {
  queued: number;
  blocked: { name: string; reason: string }[];
  skipped: { name: string; reason: string }[];
  remaining: number;
  /** Sent by hand past a cooldown the daily job would have respected. */
  overrodeCooldown?: number;
};

/**
 * The recall list, with the thing the list has always been missing: a send.
 *
 * The window is per client — the service they were last seen for decides it, with
 * the practice's own window as the fallback — so the table says *why* each person
 * is on it ("Check-up · 30 days") instead of making the desk remember. Anybody who
 * cannot be contacted says so on their own row: a refusal is information, not an
 * error, and the alternative is a desk that wonders why nothing went out.
 */
function RecallsTab({ report, onRefresh, onExport }: { report: RecallReport; onRefresh: () => void; onExport: () => void }) {
  const toast = useToast();
  const [loop, setLoop] = React.useState<RecallLoopState | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const state = await request<{ state: RecallLoopState }>('GET', '/api/v1/recalls');
        if (alive) setLoop(state.state);
      } catch {
        // The list is still useful without the loop's own numbers; stay quiet.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function sendAll() {
    setBusy('all');
    try {
      const result = await request<{ run: RecallRunSummary }>('POST', '/api/v1/recalls', { action: 'send-all' });
      const { queued, blocked, skipped, remaining, overrodeCooldown } = result.run;
      toast(
        queued
          ? `${queued} recall${queued === 1 ? '' : 's'} queued${blocked.length ? ` · ${blocked.length} could not be contacted` : ''}${overrodeCooldown ? ` · ${overrodeCooldown} sent by hand past their cooldown` : ''}${remaining ? ` · ${remaining} left for the next batch` : ''}`
          : `Nothing to send${blocked.length ? ` — ${blocked.length} cannot be contacted` : ''}${skipped.length ? ` · ${skipped[0].name}: ${skipped[0].reason}` : ''}.`,
        queued ? 'success' : 'info'
      );
      if (skipped.length) toast(`${skipped.length} left alone (${skipped[0].name}: ${skipped[0].reason})`, 'info');
      onRefresh();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'Could not send', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function sendOne(row: RecallRow) {
    setBusy(row.clientId);
    try {
      const result = await request<{ run: RecallRunSummary }>('POST', '/api/v1/recalls', { action: 'send', clientIds: [row.clientId] });
      // The engine decides, the screen reports: a queued row is queued, a refusal
      // reads out the reason the rules gave.
      // The engine decides, the screen reports: a queued row is queued, and a
      // refusal reads out the reason the rules gave — "already booked Friday" is
      // more use to a receptionist than "could not send".
      toast(
        result.run.queued > 0
          ? `Queued a recall to ${row.name} — it goes out on the next delivery tick.`
          : result.run.blocked[0]?.reason ?? result.run.skipped[0]?.reason ?? `${row.name} could not be recalled.`,
        result.run.queued > 0 ? 'success' : 'error'
      );
      onRefresh();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'Could not send', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function toggleLoop(next: boolean) {
    setBusy('loop');
    try {
      const saved = await request<{ rules: { enabled: boolean } }>('POST', '/api/v1/recalls', { action: 'save', enabled: next });
      setLoop((prev) => (prev ? { ...prev, enabled: saved.rules.enabled } : prev));
      toast(saved.rules.enabled ? 'The daily recall loop is on — it runs once a day.' : 'The daily recall loop is off.', 'success');
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'Could not save', 'error');
    } finally {
      setBusy(null);
    }
  }

  // `row.reachable` is the sender's own verdict, which is what the button runs on.
  // Reading the consent flags instead hid the button from everybody who had never
  // been asked — the people the sender would have texted quite happily — and told
  // the desk they had no consent when the truth was that nothing was recorded.
  const toSend = report.rows.filter((row) => row.reachable && !row.queued).length;

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Overdue a visit" value={String(report.due)} sub="measured per client, not per practice" icon="users" />
        <StatCard
          label="Consent on file"
          value={String(report.reachable)}
          sub="an explicit yes — nothing recorded still counts as yes"
          icon="send"
        />
        <StatCard
          label="Would be refused"
          value={String(report.blocked)}
          sub="no way to reach them on this rule's channels"
          icon="shield"
          tone={report.blocked ? 'brand' : 'default'}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-900/[0.04] bg-slate-900/[0.02] px-4 py-3">
        <div className="text-[12.5px] text-slateink-300">
          <div className="font-medium text-slate-900">Recalls that act</div>
          <div className="mt-0.5 text-[12px] text-slateink-400">
            Send them now: each message carries your booking link, and a reply comes back to the desk.
            {loop
              ? ` The daily loop is ${loop.enabled ? 'on' : 'off'} — ${loop.sentToday} sent today, nobody twice inside ${loop.cooldownDays} days, at most ${loop.maxPerDay || 'no'} a day.`
              : ''}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {loop && (
            <Button size="sm" variant="ghost" disabled={busy === 'loop'} onClick={() => void toggleLoop(!loop.enabled)}>
              {loop.enabled ? 'Turn the daily loop off' : 'Turn the daily loop on'}
            </Button>
          )}
          <Button size="sm" disabled={busy === 'all' || toSend === 0} onClick={() => void sendAll()}>
            {busy === 'all' ? 'Sending…' : `Send recalls (${toSend})`}
          </Button>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <h3 className="text-[13px] font-medium text-slate-900">Most overdue first</h3>
        <Button size="sm" variant="ghost" onClick={onExport}>
          Recalls CSV
        </Button>
      </div>

      {report.rows.length ? (
        <DataTable
          columns={[
            { key: 'client', label: 'Client' },
            { key: 'last', label: 'Last seen' },
            { key: 'window', label: 'Window' },
            { key: 'overdue', label: 'Overdue', align: 'right' },
            { key: 'recall', label: 'Last recall' },
            { key: 'consent', label: 'Contact' },
            { key: 'act', label: '', align: 'right' },
          ]}
        >
          {report.rows.map((row) => (
            <tr key={row.clientId} className="border-b border-slate-900/[0.04] last:border-0">
              <td className="px-4 py-3 text-[12.5px] text-slate-900">
                {row.name}
                <div className="font-mono text-[11px] text-slateink-400">{row.number}</div>
              </td>
              <td className="px-4 py-3 font-mono text-[12px] text-slateink-300">
                {row.lastSeenAt?.slice(0, 10) ?? '—'}
                <div className="text-[11px] text-slateink-400">{row.lastSeenDays} days ago</div>
              </td>
              <td className="px-4 py-3 text-[12px] text-slateink-300">
                {row.intervalDays} days
                <div className="text-[11px] text-slateink-400">
                  {row.intervalSource === 'service' ? row.serviceName ?? 'their service' : row.intervalSource === 'practice' ? 'practice window' : 'rule fallback'}
                </div>
              </td>
              <td className="px-4 py-3 text-right font-mono text-[12px] text-amber-800">{row.overdueDays}d</td>
              <td className="px-4 py-3 text-[11.5px] text-slateink-300">
                {row.queued ? <Pill tone="brand">queued</Pill> : row.lastRecallAt ? row.lastRecallAt.slice(0, 10) : <span className="text-slateink-400">never</span>}
              </td>
              <td className="px-4 py-3">
                <div className="flex gap-1.5">
                  <Pill tone={row.consentSms ? 'brand' : 'default'}>sms</Pill>
                  <Pill tone={row.consentEmail ? 'brand' : 'default'}>email</Pill>
                </div>
              </td>
              <td className="px-4 py-3 text-right">
                {row.reachable ? (
                  <Button size="sm" variant="ghost" disabled={busy === row.clientId || row.queued} onClick={() => void sendOne(row)}>
                    {busy === row.clientId ? '…' : row.queued ? 'Sent' : 'Recall'}
                  </Button>
                ) : (
                  <span className="text-[11px] text-slateink-400" title={row.blockedReason ?? ''}>
                    {row.blockedReason ?? 'cannot be reached'}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </DataTable>
      ) : (
        <EmptyState
          icon="users"
          title="Nobody is overdue"
          desc="Every client with a visit on file has been seen inside the window their own service sets."
        />
      )}

      {report.services.length > 0 && (
        <div className="rounded-xl border border-slate-900/[0.04] bg-slate-900/[0.02] px-4 py-3 text-[12px] text-slateink-400">
          <span className="text-slateink-200">Windows in use: </span>
          {report.services.map((service) => `${service.name} — ${service.recallDays ? `${service.recallDays} days` : 'the practice window'}`).join(' · ')}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------- page */

export default function ReportsPage() {
  const toast = useToast();
  const [tab, setTab] = React.useState<'overview' | 'revenue' | 'utilisation' | 'attendance' | 'attribution' | 'recalls' | 'costs'>('overview');
  const [preset, setPreset] = React.useState('90d');
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  const [data, setData] = React.useState<Overview | null>(null);
  const [loading, setLoading] = React.useState(true);

  const query = React.useMemo(() => {
    const params = new URLSearchParams();
    if (from && to) {
      params.set('from', from);
      params.set('to', to);
    } else {
      params.set('preset', preset);
    }
    return params.toString();
  }, [preset, from, to]);

  const fail = (error: unknown) => toast(error instanceof ApiError ? error.message : 'Something went wrong', 'error');

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      setData(await request<Overview>('GET', `/api/v1/reports?view=overview&${query}`));
    } catch (error) {
      fail(error);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, toast]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const currency = data?.currency ?? 'USD';
  const sections = data?.sections ?? {};

  const exportCsv = React.useCallback(
    async (kind: string) => {
      try {
        const res = await fetch(`/api/v1/reports?view=export&kind=${kind}&${query}`, { credentials: 'include' });
        if (!res.ok) throw new Error(`Export failed (${res.status})`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = res.headers.get('content-disposition')?.match(/filename="(.+)"/)?.[1] ?? `${kind}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        toast(`${kind} exported`, 'success');
      } catch (error) {
        fail(error);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, toast]
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        desc="Who earns what, what it costs us, who does not turn up — one window, every figure from the same rows."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {PRESETS.map((p) => (
              <Button
                key={p.id}
                size="sm"
                variant={!from && preset === p.id ? 'brand' : 'ghost'}
                onClick={() => {
                  setFrom('');
                  setTo('');
                  setPreset(p.id);
                }}
              >
                {p.label}
              </Button>
            ))}
            <input
              type="date"
              aria-label="Report start date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="rounded-lg border border-slate-900/[0.05] bg-ink-900 px-2 py-1.5 font-mono text-[11px] text-slate-900"
            />
            <input
              type="date"
              aria-label="Report end date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="rounded-lg border border-slate-900/[0.05] bg-ink-900 px-2 py-1.5 font-mono text-[11px] text-slate-900"
            />
            <Button size="sm" variant="ghost" onClick={() => void exportCsv(tab === 'overview' ? 'revenue' : tab)}>
              Export CSV
            </Button>
          </div>
        }
      />

      {data && (
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-slateink-400">
          <Pill tone="info">
            {data.range.from} → {data.range.to}
          </Pill>
          <span>
            {data.range.days} day(s) · {data.range.timezone} · generated {data.generatedAt.slice(0, 16).replace('T', ' ')}
          </span>
        </div>
      )}

      {/*
        One line under the tabs saying what the open tab answers, in the words a
        practice owner would use: the tabs were named well, but they assumed you
        already knew which one held "who does not turn up".
      */}
      <p className="mb-3 text-[12.5px] text-slateink-400">{TAB_HINT[tab]}</p>
      <p className="mb-4 rounded-xl border border-brand-500/20 bg-brand-500/[0.05] px-3.5 py-2.5 text-[12.5px] text-slateink-300">
        On the move? The assistant can read these figures out. Ring the practice line from a mobile on the{' '}
        <Link href="/dashboard/team" className="text-brand-700 underline decoration-brand-500/40 underline-offset-2 hover:text-brand-700">
          team&rsquo;s list
        </Link>{' '}
        and ask &ldquo;how did we do last month?&rdquo; — no screen needed.
      </p>

      <Tabs
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'revenue', label: 'Revenue' },
          { id: 'utilisation', label: 'Diary' },
          { id: 'attendance', label: 'Attendance' },
          { id: 'attribution', label: 'Where from' },
          { id: 'recalls', label: 'Recalls' },
          { id: 'costs', label: 'Costs' },
        ]}
        active={tab}
        onChange={(next) => setTab(next as typeof tab)}
      />

      {loading && !data && <div className="text-[13px] text-slateink-400">Working out the numbers…</div>}

      {data && tab === 'overview' && (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Collected" value={money(data.earned.collectedMinor, currency)} sub={`${rate(data.earned.collectionRatePct)} of ${money(data.earned.billedMinor, currency)} billed`} icon="dollar" />
            <StatCard
              label="Still owed"
              value={money(data.earned.outstandingMinor, currency)}
              sub={data.earned.invoices ? `${data.earned.invoices} invoice(s) in the window` : 'nothing billed in this window'}
              icon="trend"
            />
            <StatCard
              label="Cost of running it"
              value={money(data.costs.totalMinor, currency)}
              sub={`${money(data.costs.practiceMinor, currency)} bought · ${money(data.costs.callsMinor, currency)} on calls`}
              icon="chart"
            />
            <StatCard
              label="No-shows"
              value={rate(data.attendance.noShowRatePct)}
              sub={`${data.attendance.noShows} of ${data.attendance.attended + data.attendance.noShows} kept-or-missed${data.attendance.previousRatePct !== null ? ` · was ${data.attendance.previousRatePct}%` : ''}`}
              icon="calendar"
              tone={data.attendance.noShowRatePct > 10 ? 'brand' : 'default'}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-5">
              <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-slateink-400">Who earns</div>
              <div className="mt-3 space-y-2 text-[13px] text-slateink-200">
                {data.earned.topProvider ? (
                  <div>
                    <span className="text-slate-900">{data.earned.topProvider.name}</span> billed {money(data.earned.topProvider.invoicedMinor, currency)} in the window.
                  </div>
                ) : (
                  <div>No practitioner revenue in this window.</div>
                )}
                {data.earned.topService && (
                  <div>
                    <span className="text-slate-900">{data.earned.topService.name}</span> is the busiest service — {data.earned.topService.visits} visit(s),{' '}
                    {money(data.earned.topService.invoicedMinor, currency)} billed.
                  </div>
                )}
                <div className="pt-1 text-slateink-400">
                  Margin after everything: <span className={cn('font-mono', data.costs.marginMinor >= 0 ? 'text-emerald-700' : 'text-amber-800')}>{money(data.costs.marginMinor, currency)}</span>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-5">
              <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-slateink-400">The diary</div>
              <div className="mt-3 space-y-2 text-[13px] text-slateink-200">
                <div>
                  <span className="text-slate-900">{data.diary.utilisationPct}%</span> of {data.diary.capacityHours}h of rota was booked; {data.diary.attendedHours}h of it was actually seen.
                </div>
                <div className="text-slateink-400">{data.diary.emptyDays} day(s) with hours on the rota and nobody in them.</div>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-5">
              <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-slateink-400">Where from</div>
              <div className="mt-3 space-y-2 text-[13px] text-slateink-200">
                <div>
                  <span className="text-slate-900">{data.acquisition.bookings}</span> appointment(s) booked;{' '}
                  <span className="text-slate-900">{rate(data.acquisition.assistantSharePct)}</span> of them came in over the phone.
                </div>
                <div className="text-slateink-400">
                  The assistant handled {data.acquisition.calls.handled} of {data.acquisition.calls.total} call(s) on its own ({rate(data.acquisition.calls.answerRatePct)}), and {data.acquisition.calls.producedBooking} led to a booking.
                </div>
                <div className="pt-1 text-slateink-400">
                  {data.recalls.due} client(s) are past their recall window. <span className="text-slateink-300">Recalls</span> has the list — and a button that texts them.
                </div>
              </div>
            </div>
          </div>

          {data.sections.revenue && <RevenueTrend report={data.sections.revenue} currency={currency} />}
        </div>
      )}

      {data && tab === 'revenue' && sections.revenue && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="text-[13px] text-slateink-400">
              Billed {money(sections.revenue.billedMinor, currency)} · collected {money(sections.revenue.collectedMinor, currency)} · owed{' '}
              {money(sections.revenue.outstandingMinor, currency)} · {sections.revenue.invoices} invoice(s)
            </div>
            <Button size="sm" variant="ghost" onClick={() => void exportCsv('revenue')}>
              Revenue CSV
            </Button>
          </div>

          <div>
            <h3 className="mb-2 text-[13px] font-medium text-slate-900">By practitioner</h3>
            <DataTable
              columns={[
                { key: 'name', label: 'Practitioner' },
                { key: 'visits', label: 'Seen', align: 'right' },
                { key: 'invoiced', label: 'Billed', align: 'right' },
                { key: 'collected', label: 'Collected', align: 'right' },
                { key: 'outstanding', label: 'Owed', align: 'right' },
                { key: 'average', label: 'Average / visit', align: 'right' },
              ]}
            >
              {sections.revenue.byProvider.map((row) => (
                <tr key={row.id} className="border-b border-slate-900/[0.04] last:border-0">
                  <td className="px-4 py-3 text-[12.5px] text-slate-900">{row.name}</td>
                  <td className="px-4 py-3 text-right font-mono text-[12px] text-slateink-200">{row.attended}</td>
                  <td className="px-4 py-3 text-right font-mono text-[12px] text-slate-900">{money(row.invoicedMinor, currency)}</td>
                  <td className="px-4 py-3 text-right font-mono text-[12px] text-emerald-700">{money(row.collectedMinor, currency)}</td>
                  <td className="px-4 py-3 text-right font-mono text-[12px] text-amber-800">{money(row.outstandingMinor, currency)}</td>
                  <td className="px-4 py-3 text-right font-mono text-[12px] text-slateink-200">{money(row.averageMinor, currency)}</td>
                </tr>
              ))}
              {!sections.revenue.byProvider.length && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-[12.5px] text-slateink-400">
                    Nothing billed in this window.
                  </td>
                </tr>
              )}
            </DataTable>
          </div>

          <div>
            <h3 className="mb-2 text-[13px] font-medium text-slate-900">By service</h3>
            <DataTable
              columns={[
                { key: 'name', label: 'Service' },
                { key: 'visits', label: 'Seen', align: 'right' },
                { key: 'invoiced', label: 'Billed', align: 'right' },
                { key: 'collected', label: 'Collected', align: 'right' },
                { key: 'outstanding', label: 'Owed', align: 'right' },
                { key: 'average', label: 'Average / visit', align: 'right' },
              ]}
            >
              {sections.revenue.byService.map((row) => (
                <tr key={row.id} className="border-b border-slate-900/[0.04] last:border-0">
                  <td className="px-4 py-3 text-[12.5px] text-slate-900">{row.name}</td>
                  <td className="px-4 py-3 text-right font-mono text-[12px] text-slateink-200">{row.attended}</td>
                  <td className="px-4 py-3 text-right font-mono text-[12px] text-slate-900">{money(row.invoicedMinor, currency)}</td>
                  <td className="px-4 py-3 text-right font-mono text-[12px] text-emerald-700">{money(row.collectedMinor, currency)}</td>
                  <td className="px-4 py-3 text-right font-mono text-[12px] text-amber-800">{money(row.outstandingMinor, currency)}</td>
                  <td className="px-4 py-3 text-right font-mono text-[12px] text-slateink-200">{money(row.averageMinor, currency)}</td>
                </tr>
              ))}
              {!sections.revenue.byService.length && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-[12.5px] text-slateink-400">
                    No service revenue in this window.
                  </td>
                </tr>
              )}
            </DataTable>
          </div>
        </div>
      )}

      {data && tab === 'utilisation' && sections.utilisation && (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Rota hours" value={`${sections.utilisation.capacityMinutes / 60}h`} sub={`${data.range.days} day(s), after days off`} icon="clock" />
            <StatCard label="Booked" value={`${sections.utilisation.bookedMinutes / 60}h`} sub={`${rate(sections.utilisation.utilisationPct)} of the rota`} icon="calendar" />
            <StatCard label="Seen" value={`${sections.utilisation.attendedMinutes / 60}h`} sub={`${rate(sections.utilisation.attendedPct)} of the rota actually delivered`} icon="check" />
            <StatCard label="Cancelled" value={`${sections.utilisation.cancelledMinutes / 60}h`} sub="time given back before the visit" icon="close" />
          </div>
          <DataTable
            columns={[
              { key: 'name', label: 'Practitioner' },
              { key: 'capacity', label: 'Rota', align: 'right' },
              { key: 'booked', label: 'Booked', align: 'right' },
              { key: 'attended', label: 'Seen', align: 'right' },
              { key: 'utilisation', label: 'Utilisation', align: 'right' },
              { key: 'appointments', label: 'Appointments', align: 'right' },
              { key: 'empty', label: 'Empty days', align: 'right' },
            ]}
          >
            {sections.utilisation.rows.map((row) => (
              <tr key={row.providerId} className="border-b border-slate-900/[0.04] last:border-0">
                <td className="px-4 py-3 text-[12.5px] text-slate-900">{row.name}</td>
                <td className="px-4 py-3 text-right font-mono text-[12px] text-slateink-200">{hours(row.capacityMinutes)}</td>
                <td className="px-4 py-3 text-right font-mono text-[12px] text-slateink-200">{hours(row.bookedMinutes)}</td>
                <td className="px-4 py-3 text-right font-mono text-[12px] text-slateink-200">{hours(row.attendedMinutes)}</td>
                <td className="px-4 py-3 text-right font-mono text-[12px] text-slate-900">{rate(row.utilisationPct)}</td>
                <td className="px-4 py-3 text-right font-mono text-[12px] text-slateink-200">{row.appointments}</td>
                <td className="px-4 py-3 text-right font-mono text-[12px] text-slateink-400">{row.emptyDays}</td>
              </tr>
            ))}
            {!sections.utilisation.rows.length && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-[12.5px] text-slateink-400">
                  No rota in this window — nothing to measure.
                </td>
              </tr>
            )}
          </DataTable>
        </div>
      )}

      {data && tab === 'attendance' && sections.attendance && (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Kept" value={String(sections.attendance.attended)} sub="appointments completed" icon="check" />
            <StatCard label="No-shows" value={String(sections.attendance.noShows)} sub={`${rate(sections.attendance.noShowRatePct)} of kept-or-missed`} icon="alert" tone={sections.attendance.noShows ? 'brand' : 'default'} />
            <StatCard label="Cancelled" value={String(sections.attendance.cancelled)} sub={`${rate(sections.attendance.cancellationRatePct)} of settled`} icon="close" />
            <StatCard label="Was" value={rate(sections.attendance.previousRatePct)} sub="the same span before this one" icon="trend" />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="mb-2 text-[13px] font-medium text-slate-900">By weekday</h3>
              <DataTable
                columns={[
                  { key: 'day', label: 'Day' },
                  { key: 'attended', label: 'Kept', align: 'right' },
                  { key: 'noShows', label: 'Missed', align: 'right' },
                  { key: 'rate', label: 'Rate', align: 'right' },
                ]}
              >
                {sections.attendance.byWeekday.map((row) => (
                  <tr key={row.key} className="border-b border-slate-900/[0.04] last:border-0">
                    <td className="px-4 py-3 text-[12.5px] text-slate-900">{row.key}</td>
                    <td className="px-4 py-3 text-right font-mono text-[12px] text-slateink-200">{row.attended}</td>
                    <td className="px-4 py-3 text-right font-mono text-[12px] text-amber-800">{row.noShows}</td>
                    <td className="px-4 py-3 text-right font-mono text-[12px] text-slateink-200">{rate(row.rate)}</td>
                  </tr>
                ))}
              </DataTable>
            </div>
            <div>
              <h3 className="mb-2 text-[13px] font-medium text-slate-900">By hour</h3>
              <DataTable
                columns={[
                  { key: 'hour', label: 'Slot' },
                  { key: 'attended', label: 'Kept', align: 'right' },
                  { key: 'noShows', label: 'Missed', align: 'right' },
                  { key: 'rate', label: 'Rate', align: 'right' },
                ]}
              >
                {sections.attendance.byHour.map((row) => (
                  <tr key={row.key} className="border-b border-slate-900/[0.04] last:border-0">
                    <td className="px-4 py-3 font-mono text-[12px] text-slate-900">{row.key}</td>
                    <td className="px-4 py-3 text-right font-mono text-[12px] text-slateink-200">{row.attended}</td>
                    <td className="px-4 py-3 text-right font-mono text-[12px] text-amber-800">{row.noShows}</td>
                    <td className="px-4 py-3 text-right font-mono text-[12px] text-slateink-200">{rate(row.rate)}</td>
                  </tr>
                ))}
              </DataTable>
            </div>
          </div>

          <div>
            <h3 className="mb-2 text-[13px] font-medium text-slate-900">By practitioner</h3>
            <DataTable
              columns={[
                { key: 'name', label: 'Practitioner' },
                { key: 'attended', label: 'Kept', align: 'right' },
                { key: 'noShows', label: 'Missed', align: 'right' },
                { key: 'rate', label: 'Rate', align: 'right' },
              ]}
            >
              {sections.attendance.byProvider.map((row) => (
                <tr key={row.providerId} className="border-b border-slate-900/[0.04] last:border-0">
                  <td className="px-4 py-3 text-[12.5px] text-slate-900">{row.name}</td>
                  <td className="px-4 py-3 text-right font-mono text-[12px] text-slateink-200">{row.attended}</td>
                  <td className="px-4 py-3 text-right font-mono text-[12px] text-amber-800">{row.noShows}</td>
                  <td className="px-4 py-3 text-right font-mono text-[12px] text-slateink-200">{rate(row.rate)}</td>
                </tr>
              ))}
            </DataTable>
          </div>
        </div>
      )}

      {data && tab === 'attribution' && sections.attribution && (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Booked" value={String(sections.attribution.bookings)} sub="appointments in the window" icon="calendar" />
            <StatCard label="Over the phone" value={rate(sections.attribution.assistantSharePct)} sub="share of the diary the calls produced" icon="phone" />
            <StatCard label="Handled unattended" value={`${sections.attribution.calls.handled}/${sections.attribution.calls.total}`} sub={`${rate(sections.attribution.calls.answerRatePct)} answered without a transfer`} icon="headphones" />
            <StatCard label="Transferred" value={String(sections.attribution.calls.transferred)} sub={`${sections.attribution.calls.failed} failed · ${sections.attribution.calls.minutes} call minutes`} icon="phoneForwarded" />
          </div>

          <DataTable
            columns={[
              { key: 'source', label: 'Source' },
              { key: 'bookings', label: 'Booked', align: 'right' },
              { key: 'attended', label: 'Seen', align: 'right' },
              { key: 'noShows', label: 'Missed', align: 'right' },
              { key: 'cancelled', label: 'Cancelled', align: 'right' },
              { key: 'billed', label: 'Billed', align: 'right' },
            ]}
          >
            {sections.attribution.bySource.map((row) => (
              <tr key={row.key} className="border-b border-slate-900/[0.04] last:border-0">
                <td className="px-4 py-3 text-[12.5px] text-slate-900">{row.label}</td>
                <td className="px-4 py-3 text-right font-mono text-[12px] text-slateink-200">{row.bookings}</td>
                <td className="px-4 py-3 text-right font-mono text-[12px] text-emerald-700">{row.attended}</td>
                <td className="px-4 py-3 text-right font-mono text-[12px] text-amber-800">{row.noShows}</td>
                <td className="px-4 py-3 text-right font-mono text-[12px] text-slateink-400">{row.cancelled}</td>
                <td className="px-4 py-3 text-right font-mono text-[12px] text-slate-900">{money(row.billedMinor, currency)}</td>
              </tr>
            ))}
            {!sections.attribution.bySource.length && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-[12.5px] text-slateink-400">
                  Nothing was booked in this window.
                </td>
              </tr>
            )}
          </DataTable>

          <div className="text-[12.5px] text-slateink-400">
            A booking counts once, against the source it arrived from. Calls are counted from the call records themselves — the assistant gets credit for a booking only when
            the booking names the call.
          </div>
        </div>
      )}

      {data && tab === 'recalls' && sections.recalls && (
        <RecallsTab report={sections.recalls} onRefresh={() => void load()} onExport={() => void exportCsv('recalls')} />
      )}

      {data && tab === 'costs' && sections.costs && (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Practice costs" value={money(sections.costs.expensesMinor, currency)} sub={`${sections.costs.expenses} expense row(s)`} icon="briefcase" />
            <StatCard label="Call spend" value={money(sections.costs.callSpendMinor, currency)} sub={`${sections.costs.calls} call(s) · ${sections.costs.callMinutes} minute(s)`} icon="phone" />
            <StatCard label="Margin" value={money(sections.costs.marginMinor, currency)} sub={`collected ${money(sections.costs.collectedMinor, currency)} less total cost`} icon="trend" tone={sections.costs.marginMinor >= 0 ? 'default' : 'brand'} />
            <StatCard label="Cost per call" value={money(sections.costs.costPerCallMinor, currency)} sub={`${money(sections.costs.costPerBookingMinor, currency)} per visit seen`} icon="chart" />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="mb-2 text-[13px] font-medium text-slate-900">What the practice bought</h3>
              <DataTable
                columns={[
                  { key: 'category', label: 'Category' },
                  { key: 'amount', label: 'Amount', align: 'right' },
                ]}
              >
                {sections.costs.byCategory.map((row) => (
                  <tr key={row.key} className="border-b border-slate-900/[0.04] last:border-0">
                    <td className="px-4 py-3 text-[12.5px] text-slate-900 capitalize">{row.label}</td>
                    <td className="px-4 py-3 text-right font-mono text-[12px] text-slateink-200">{money(row.amountMinor, currency)}</td>
                  </tr>
                ))}
                {!sections.costs.byCategory.length && (
                  <tr>
                    <td colSpan={2} className="px-4 py-6 text-center text-[12.5px] text-slateink-400">
                      No expenses recorded in this window.
                    </td>
                  </tr>
                )}
              </DataTable>
            </div>
            <div>
              <h3 className="mb-2 text-[13px] font-medium text-slate-900">What the phones cost</h3>
              <DataTable
                columns={[
                  { key: 'line', label: 'Line' },
                  { key: 'amount', label: 'Amount', align: 'right' },
                ]}
              >
                {sections.costs.callSpendBreakdown.map((row) => (
                  <tr key={row.key} className="border-b border-slate-900/[0.04] last:border-0">
                    <td className="px-4 py-3 text-[12.5px] text-slate-900">{row.label}</td>
                    <td className="px-4 py-3 text-right font-mono text-[12px] text-slateink-200">{money(row.amountMinor, currency)}</td>
                  </tr>
                ))}
              </DataTable>
              <div className="mt-2 text-[12px] text-slateink-400">Metered from the call records themselves, at the rates the workspace is on.</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** A small daily billing trend — enough to see a month's shape without a chart library. */
function RevenueTrend({ report, currency }: { report: RevenueReport; currency: string }) {
  const days = report.byDay;
  const peak = Math.max(1, ...days.map((d) => d.invoicedMinor));
  if (!days.length) return null;
  return (
    <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-5">
      <div className="flex items-center justify-between">
        <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-slateink-400">Billed per day</div>
        <div className="text-[12px] text-slateink-400">peak {money(peak, currency)}</div>
      </div>
      <div className="mt-4 flex h-16 items-end gap-[2px]">
        {days.map((day) => (
          <div
            key={day.date}
            title={`${day.date} · ${money(day.invoicedMinor, currency)}`}
            className={cn('flex-1 rounded-sm', day.invoicedMinor ? 'bg-emerald-400/70' : 'bg-slate-900/[0.06]')}
            style={{ height: `${Math.max(2, Math.round((day.invoicedMinor / peak) * 100))}%` }}
          />
        ))}
      </div>
      <div className="mt-2 flex justify-between font-mono text-[10px] text-slateink-400">
        <span>{days[0]?.date}</span>
        <span>{days[days.length - 1]?.date}</span>
      </div>
    </div>
  );
}
