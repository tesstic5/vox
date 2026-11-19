'use client';

/** Native appointments, desk actions and confirmation campaigns. */

import * as React from 'react';
import { ApiError, request } from '@/lib/server-sync';
import { cn, fmtDate, pinnedNow } from '@/lib/utils';
import { Ago } from '@/components/dash/Ago';
import { Icons } from '@/components/icons';
import { Button, EmptyState, LinkButton, Modal, Pill, Tabs, Toggle, useToast } from '@/components/ui';
import { DataTable, StatCard } from '@/components/dash/bits';
import { PageHeader } from '@/components/dash/Shell';
import { useStore } from '@/lib/store';

type Booking = {
  id: string;
  externalId: string;
  customer: { name: string; number: string; email?: string };
  service: string;
  startsAt: string;
  status: 'pending' | 'confirmed' | 'cancelled' | 'completed' | 'no_show';
  outcome?: string;
  outcomeNote?: string;
  outcomeAt?: string;
  attempts: { at: string; outcome: string; detail?: string }[];
  callIds?: string[];
  value?: number;
  timezone?: string;
  source?: string;
  description: string;
  metadata?: Record<string, string>;
  syncedAt?: string;
};

type Campaign = {
  id: string;
  name: string;
  kind: string;
  assistantId: string;
  numberId?: string;
  withinHours: number;
  maxPerRun: number;
  quietHours: { start: number; end: number; timezone?: string };
  pacingSeconds: number;
  status: 'active' | 'paused';
  instructions: string;
  stats: { runs: number; dialled: number; confirmed: number; rescheduled: number; cancelled: number; noAnswer: number; failed: number; texted?: number };
  channels?: { call: boolean; sms: boolean };
  dueNow?: number;
  inQuietHours?: boolean;
  lastRunAt?: string;
  lastRun?: { at: string; dialled: number; skipped: number; reasons: string[]; dryRun: boolean; deferred?: string };
};

type RunResult = {
  ok: boolean;
  reason?: string;
  deferred?: string;
  dryRun: boolean;
  dialled: number;
  skipped: number;
  texted?: number;
  calls: { externalId: string; to: string; carrierSid?: string; error?: string }[];
};

const STATUS_TONE: Record<Booking['status'], 'brand' | 'warn' | 'danger' | 'default'> = {
  pending: 'warn',
  confirmed: 'brand',
  cancelled: 'danger',
  completed: 'default',
  no_show: 'danger',
};

export default function BookingsPage() {
  const store = useStore();
  const toast = useToast();
  const [bookings, setBookings] = React.useState<Booking[]>([]);
  const [campaigns, setCampaigns] = React.useState<Campaign[]>([]);
  const [stats, setStats] = React.useState<Record<string, number>>({});
  const [tab, setTab] = React.useState<'upcoming' | 'called' | 'all' | 'campaigns' | 'api'>('upcoming');
  const [busy, setBusy] = React.useState('');
  const [runPreview, setRunPreview] = React.useState<{ campaign: Campaign; result: RunResult } | null>(null);
  const [editing, setEditing] = React.useState<Campaign | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [needsAuth, setNeedsAuth] = React.useState(false);

  const [draft, setDraft] = React.useState({
    name: 'Tomorrow’s appointments',
    kind: 'confirm',
    assistantId: '',
    withinHours: 24,
    maxPerRun: 5,
    quietStart: 9,
    quietEnd: 19,
    timezone: 'America/Los_Angeles',
    channelsCall: true,
    channelsSms: false,
    instructions: 'You are calling {{customer}} about their {{appointment}}. Confirm they are still coming; if not, offer to move it or cancel it. Be brief.',
  });

  const load = React.useCallback(async () => {
    try {
      const [b, c] = await Promise.all([
        request<{ data: Booking[]; stats: Record<string, number> }>('GET', '/api/v1/bookings?limit=200&sort=-startsAt'),
        request<{ data: Campaign[] }>('GET', '/api/v1/booking-campaigns'),
      ]);
      setBookings(b.data ?? []);
      setStats((b.stats ?? {}) as Record<string, number>);
      setCampaigns(c.data ?? []);
      setNeedsAuth(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setNeedsAuth(true);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Which side of "now" an appointment falls on decides what the table shows, so
  // "now" has to be the same instant on the server and in the first render.
  const now = pinnedNow();
  const upcoming = bookings.filter((b) => (b.status === 'confirmed' || b.status === 'pending') && new Date(b.startsAt).getTime() > now);
  const called = bookings.filter((b) => b.attempts.length > 0);
  const assistants = store.assistants ?? [];

  const run = async (campaign: Campaign, dryRun: boolean) => {
    setBusy(`${campaign.id}:${dryRun ? 'dry' : 'live'}`);
    try {
      const result = await request<RunResult>('POST', `/api/v1/booking-campaigns/${campaign.id}/run`, { dryRun });
      setRunPreview({ campaign, result });
      if (!dryRun) {
        const parts = [
          result.dialled ? `dialled ${result.dialled} call(s)` : null,
          result.texted ? `queued ${result.texted} text(s)` : null,
        ].filter(Boolean);
        toast(parts.length ? `Run complete — ${parts.join(', ')}.` : result.reason ?? 'Nothing to do.');
      }
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Run failed', 'error');
    } finally {
      setBusy('');
    }
  };

  const toggle = async (campaign: Campaign) => {
    setBusy(`${campaign.id}:toggle`);
    try {
      await request('PATCH', `/api/v1/booking-campaigns/${campaign.id}`, { status: campaign.status === 'active' ? 'paused' : 'active' });
      toast(campaign.status === 'active' ? 'Campaign paused — nothing will dial.' : 'Campaign active.');
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Update failed', 'error');
    } finally {
      setBusy('');
    }
  };

  const saveCampaign = async () => {
    setBusy('save');
    try {
      const payload = {
        name: draft.name,
        kind: draft.kind,
        assistantId: draft.assistantId || assistants[0]?.id,
        withinHours: Number(draft.withinHours),
        maxPerRun: Number(draft.maxPerRun),
        quietHours: { start: Number(draft.quietStart), end: Number(draft.quietEnd), timezone: draft.timezone },
        instructions: draft.instructions,
        channels: { call: draft.channelsCall, sms: draft.channelsSms },
        status: 'paused',
      };
      if (editing) await request('PATCH', `/api/v1/booking-campaigns/${editing.id}`, payload);
      else await request('POST', '/api/v1/booking-campaigns', payload);
      toast(editing ? 'Campaign updated.' : 'Campaign created paused — run a dry run to see who it would call.');
      setEditing(null);
      setCreating(false);
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save', 'error');
    } finally {
      setBusy('');
    }
  };

  const outcomeLabel = (b: Booking) => {
    if (!b.outcome) return '—';
    const map: Record<string, string> = {
      confirmed: 'Confirmed',
      rescheduled: 'Moved',
      cancelled: 'Cancelled',
      declined: 'Declined',
      no_answer: 'No answer',
      voicemail: 'Voicemail',
      failed: 'Failed',
    };
    return map[b.outcome] ?? b.outcome;
  };

  if (needsAuth) {
    return (
      <>
        <PageHeader title="Bookings" desc="The appointments your agent calls about." />
        <EmptyState
          icon="lock"
          title="Sign in to see bookings"
          desc="Bookings belong to your workspace. Sign in to load the appointments on file and the campaigns that call about them."
          action={<LinkButton href="/login?next=/dashboard/bookings" variant="brand">Sign in</LinkButton>}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Bookings"
        desc="Native appointments, confirmation calls and recorded outcomes in one diary."
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => void load()}>
              <Icons.refresh size={13} /> Refresh
            </Button>
            <Button variant="brand" size="sm" onClick={() => { setCreating(true); setDraft((d) => ({ ...d, assistantId: assistants[0]?.id ?? d.assistantId })); }}>
              <Icons.plus size={13} /> New campaign
            </Button>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Upcoming" value={String(upcoming.length)} sub={`${stats.next24h ?? 0} inside 24 hours`} />
        <StatCard label="Calls made" value={String(stats.called ?? called.length)} sub={`${stats.contactedRate ?? 0}% of bookings called`} />
        <StatCard label="Confirmed by call" value={String(stats.confirmed ?? 0)} sub={`${stats.confirmedRate ?? 0}% of calls that connected`} tone="brand" />
        <StatCard
          label="Moved / cancelled"
          value={`${stats.rescheduled ?? 0} / ${stats.cancelled ?? 0}`}
          sub={`${stats.noAnswer ?? 0} no-answer`}
        />
      </div>

      <div className="mt-4 rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 px-5 py-4">
        <div className="flex items-start gap-3">
          <Icons.server size={16} className="mt-0.5 shrink-0 text-brand-700" />
          <p className="text-[12.5px] leading-relaxed text-slateink-300">
            <span className="text-slate-900">Voxera’s native diary is the single scheduling record.</span>{' '}
            Staff, phone, public booking, manage links and wait-list claims use the same conflict-checked path. Controlled API imports add native appointments; <code className="rounded bg-ink-900/80 px-1.5 py-0.5 font-mono text-[11.5px] text-brand-700">booking.*</code> webhooks report outcomes. See the <button className="text-brand-700" onClick={() => setTab('api')}>API tab</button>.
          </p>
        </div>
      </div>

      {/* ---------------------------------------------------- today's desk */}
      <TodayAtTheDesk
        onOpenCalendar={() => undefined}
        onChanged={() => void load()}
      />

      <div className="mt-5">
        <Tabs
          tabs={[
            { id: 'upcoming', label: `Upcoming (${upcoming.length})` },
            { id: 'called', label: `Called (${called.length})` },
            { id: 'campaigns', label: `Campaigns (${campaigns.length})` },
            { id: 'api', label: 'API' },
            { id: 'all', label: `All (${bookings.length})` },
          ]}
          active={tab}
          onChange={(id) => setTab(id as typeof tab)}
        />
      </div>

      {(tab === 'upcoming' || tab === 'all' || tab === 'called') && (
        <div className="mt-4">
          {tab === 'upcoming' && upcoming.length === 0 ? (
            <EmptyState
              icon="calendar"
              title="No upcoming appointments"
              desc="Create an appointment in the calendar or import one through the API; it will appear here for confirmation workflows."
            />
          ) : (
            <DataTable
              columns={[
                { key: 'when', label: 'Appointment' },
                { key: 'customer', label: 'Customer' },
                { key: 'source', label: 'Record' },
                { key: 'status', label: 'Status' },
                { key: 'outcome', label: 'Last call' },
                { key: 'value', label: 'Value', align: 'right' },
              ]}
            >
              {(tab === 'called' ? called : tab === 'upcoming' ? upcoming : bookings).map((b) => (
                <tr key={b.id} className="transition-colors hover:bg-slate-900/[0.02]">
                  <td className="px-4 py-3">
                    <div className="text-[13px] text-slate-900">
                      {fmtDate(b.startsAt, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </div>
                    <div className="text-[11.5px] text-slateink-400">
                      {b.service} · {b.timezone ?? 'UTC'}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-[13px] text-slate-900">{b.customer.name}</div>
                    <div className="font-mono text-[11px] text-slateink-400">{b.customer.number}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-mono text-[11.5px] text-slateink-300">{b.externalId}</div>
                    <div className="text-[11px] text-slateink-400">
                      {b.source ?? (b.metadata?.system ? `from ${b.metadata.system}` : 'client api')}
                      {b.syncedAt ? <> · synced <Ago at={b.syncedAt} /></> : ''}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Pill tone={STATUS_TONE[b.status]}>{b.status.replace('_', ' ')}</Pill>
                    {b.metadata?.removedFromSource === 'true' && (
                      <div className="mt-1 text-[10.5px] text-amber-800">not in last sync — not being called</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {b.outcome ? (
                      <div>
                        <span className={cn('text-[12.5px]', b.outcome === 'confirmed' ? 'text-brand-700' : b.outcome === 'cancelled' ? 'text-rose-700' : 'text-slateink-200')}>
                          {outcomeLabel(b)}
                        </span>
                        {b.outcomeAt && <div className="text-[11px] text-slateink-400"><Ago at={b.outcomeAt} /></div>}
                        {b.outcomeNote && <div className="max-w-[220px] truncate text-[11px] text-slateink-400">{b.outcomeNote}</div>}
                      </div>
                    ) : (
                      <span className="text-[12.5px] text-slateink-400">{b.attempts.length ? `${b.attempts.length} attempt(s)` : 'not called'}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right text-[12.5px] text-slateink-200">{b.value ? `$${b.value}` : '—'}</td>
                </tr>
              ))}
            </DataTable>
          )}
        </div>
      )}

      {tab === 'campaigns' && (
        <div className="mt-4 space-y-3">
          {campaigns.length === 0 && (
            <EmptyState
              icon="phone"
              title="No campaigns yet"
              desc="A campaign dials the appointments inside a window — confirm they are coming, and write back what they said."
              action={<Button variant="brand" size="sm" onClick={() => setCreating(true)}>Create a campaign</Button>}
            />
          )}

          {campaigns.map((c) => (
            <div key={c.id} className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[14.5px] font-semibold text-slate-900">{c.name}</h3>
                    <Pill tone={c.status === 'active' ? 'brand' : 'default'}>{c.status}</Pill>
                    <Pill>{c.kind}</Pill>
                    {c.inQuietHours === false && <Pill tone="warn">outside calling hours</Pill>}
                  </div>
                  <p className="mt-1.5 max-w-3xl text-[12.5px] leading-relaxed text-slateink-400">{c.instructions}</p>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-slateink-400">
                    <span>window: next {c.withinHours}h</span>
                    <span>max {c.maxPerRun}/run</span>
                    <span>
                      hours {c.quietHours.start}:00–{c.quietHours.end}:00 {c.quietHours.timezone ?? 'UTC'}
                    </span>
                    <span>{c.dueNow ?? 0} due now</span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={() => void run(c, true)} disabled={busy.startsWith(`${c.id}:`)}>
                    {busy === `${c.id}:dry` ? 'Checking…' : 'Dry run'}
                  </Button>
                  <Button variant="brand" size="sm" onClick={() => void run(c, false)} disabled={busy.startsWith(`${c.id}:`) || c.status !== 'active'}>
                    {busy === `${c.id}:live` ? 'Dialling…' : `Call ${c.dueNow ?? 0} now`}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void toggle(c)} disabled={busy === `${c.id}:toggle`}>
                    {c.status === 'active' ? 'Pause' : 'Activate'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEditing(c);
                      setDraft({
                        name: c.name,
                        kind: c.kind,
                        assistantId: c.assistantId,
                        withinHours: c.withinHours,
                        maxPerRun: c.maxPerRun,
                        quietStart: c.quietHours.start,
                        quietEnd: c.quietHours.end,
                        timezone: c.quietHours.timezone ?? 'UTC',
                        instructions: c.instructions,
                        channelsCall: c.channels?.call !== false,
                        channelsSms: c.channels?.sms === true,
                      });
                    }}
                  >
                    Edit
                  </Button>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-3 gap-3 border-t border-slate-900/[0.04] pt-4 sm:grid-cols-6">
                {[
                  ['Runs', c.stats.runs],
                  ['Dialled', c.stats.dialled],
                  ['Texted', c.stats.texted ?? 0],
                  ['Confirmed', c.stats.confirmed],
                  ['Moved', c.stats.rescheduled],
                  ['No answer', c.stats.noAnswer],
                ].map(([label, value]) => (
                  <div key={String(label)}>
                    <div className="font-mono text-[15px] text-slate-900">{value}</div>
                    <div className="text-[11px] text-slateink-400">{label}</div>
                  </div>
                ))}
              </div>

              {c.lastRun && (
                <div className="mt-3 rounded-xl border border-slate-900/[0.04] bg-ink-900/40 px-3.5 py-2.5">
                  <div className="font-mono text-[11px] text-slateink-400">
                    last run <Ago at={c.lastRun.at} /> · {c.lastRun.dryRun ? 'dry run' : `${c.lastRun.dialled} dialled`}
                  </div>
                  {c.lastRun.reasons.length > 0 && <div className="mt-1 text-[12px] text-slateink-300">{c.lastRun.reasons.join(' · ')}</div>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === 'api' && (
        <div className="mt-4 space-y-4">
          <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-5">
            <h3 className="h4">Import appointments into Voxera</h3>
            <p className="mt-1 text-[12.5px] leading-relaxed text-slateink-400">
              Voxera remains the scheduling record. Import appointments by stable reference — <code className="font-mono text-brand-700">mode: &quot;full&quot;</code> marks
              anything you left out as removed from source and stops calling it. Nothing is deleted on your side or ours by a sync.
            </p>
            <pre className="mt-3 overflow-x-auto rounded-xl border border-slate-900/[0.04] bg-ink-900/60 p-4 font-mono text-[11.5px] leading-relaxed text-slateink-200">
{`curl -X POST https://api.voxera.ai/v1/bookings/sync \\
  -H "authorization: Bearer $VOXERA_API_KEY" \\
  -H "content-type: application/json" \\
  -d '{
    "mode": "full",
    "bookings": [{
      "externalId": "NW-BK-4100",
      "customer": { "name": "Amara Osei", "number": "+14155550177" },
      "service": "Checkup",
      "startsAt": "2026-09-26T14:00:00Z",
      "durationMinutes": 30,
      "timezone": "America/Los_Angeles"
    }]
  }'`}
            </pre>
            <p className="mt-3 text-[12.5px] text-slateink-400">
              The response reports created / updated / removed and carries back every outcome learned on a call since you last asked
              (<code className="font-mono text-brand-700">?since=</code>).
            </p>
          </div>

          <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-5">
            <h3 className="h4">Hear about outcomes as they happen</h3>
            <p className="mt-1 text-[12.5px] text-slateink-400">Subscribe a URL to these events and every outcome is delivered, signed, with retries.</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {['booking.confirmed', 'booking.rescheduled', 'booking.cancelled', 'booking.no_answer'].map((event) => (
                <div key={event} className="rounded-xl border border-slate-900/[0.04] bg-ink-900/40 px-3.5 py-2.5 font-mono text-[11.5px] text-brand-700">{event}</div>
              ))}
            </div>
            <pre className="mt-3 overflow-x-auto rounded-xl border border-slate-900/[0.04] bg-ink-900/60 p-4 font-mono text-[11.5px] leading-relaxed text-slateink-200">
{`{
  "type": "booking.rescheduled",
  "booking": { "externalId": "NW-BK-4102", "startsAt": "2026-09-27T15:00:00Z", "status": "confirmed" },
  "outcome": "rescheduled",
  "note": "caller asked for a later slot",
  "callId": "call_9f2c41ab",
  "at": "2026-09-25T18:04:12.008Z"
}`}
            </pre>
            <div className="mt-3 flex flex-wrap gap-2">
              <LinkButton href="/dashboard/webhooks" variant="ghost" size="sm">Manage webhooks</LinkButton>
              <LinkButton href="/dashboard/api-keys" variant="ghost" size="sm">API keys</LinkButton>
              <LinkButton href="/docs" variant="ghost" size="sm">Docs</LinkButton>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-5">
            <h3 className="h4">Run campaigns from your automation</h3>
            <p className="mt-1 text-[12.5px] leading-relaxed text-slateink-400">
              A run is one tick: it dials whoever is due, respects calling hours, and never rings the same booking twice for the same change.
              Dry runs are the default, so pointing a cron at it cannot ring strangers by accident.
            </p>
            <pre className="mt-3 overflow-x-auto rounded-xl border border-slate-900/[0.04] bg-ink-900/60 p-4 font-mono text-[11.5px] leading-relaxed text-slateink-200">
{`# every 30 minutes, dial for real
curl -X POST https://api.voxera.ai/v1/booking-campaigns/bcmp_1234/run \\
  -H "authorization: Bearer $VOXERA_API_KEY" \\
  -d '{ "dryRun": false }'`}
            </pre>
          </div>
        </div>
      )}

      <Modal
        open={Boolean(runPreview)}
        onClose={() => setRunPreview(null)}
        title={runPreview ? `${runPreview.result.dryRun ? 'Dry run' : 'Run'} — ${runPreview.campaign.name}` : ''}
      >
        {runPreview && (
          <div className="space-y-4">
            <div
              className={cn(
                'rounded-xl border px-4 py-3 text-[12.5px]',
                runPreview.result.dialled > 0 ? 'border-brand-500/25 bg-brand-500/[0.06] text-brand-800' : 'border-slate-900/[0.035] bg-ink-900/50 text-slateink-300'
              )}
            >
              {runPreview.result.reason ?? (runPreview.result.dialled ? `${runPreview.result.dialled} call(s) placed.` : 'Nothing to dial.')}
            </div>
            {runPreview.result.calls.length > 0 ? (
              <div className="space-y-2">
                {runPreview.result.calls.map((c) => (
                  <div key={c.externalId + c.to} className="flex items-center justify-between gap-3 rounded-xl border border-slate-900/[0.04] bg-ink-900/40 px-3.5 py-2.5">
                    <div className="min-w-0">
                      <div className="font-mono text-[11.5px] text-slateink-300">{c.externalId} → {c.to}</div>
                      {c.carrierSid && <div className="font-mono text-[10.5px] text-slateink-400">{c.carrierSid}</div>}
                      {c.error && <div className="text-[11px] text-amber-800">{c.error}</div>}
                    </div>
                    <Pill tone={c.error ? 'warn' : runPreview.result.dryRun ? 'default' : 'brand'}>
                      {c.error ? 'failed' : runPreview.result.dryRun ? 'would call' : 'dialled'}
                    </Pill>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[12.5px] text-slateink-400">
                Every booking inside the window has already been called for its current version, or nothing falls inside it. Widen the window or
                let a booking change and it becomes callable again.
              </p>
            )}
            {runPreview.result.dryRun && runPreview.result.calls.length > 0 && (
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setRunPreview(null)}>Close</Button>
                <Button
                  variant="brand"
                  size="sm"
                  onClick={() => {
                    const campaign = runPreview.campaign;
                    setRunPreview(null);
                    void run(campaign, false);
                  }}
                >
                  Dial these for real
                </Button>
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal open={creating || Boolean(editing)} onClose={() => { setCreating(false); setEditing(null); }} title={editing ? 'Edit campaign' : 'New campaign'}>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-[12px] text-slateink-400">Name</span>
              <input className="field" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12px] text-slateink-400">Assistant</span>
              <select className="field" value={draft.assistantId} onChange={(e) => setDraft((d) => ({ ...d, assistantId: e.target.value }))}>
                {assistants.map((a) => (
                  <option key={a.id} value={a.id} className="bg-ink-900">
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12px] text-slateink-400">Call bookings starting within (hours)</span>
              <input type="number" min={1} max={336} className="field" value={draft.withinHours} onChange={(e) => setDraft((d) => ({ ...d, withinHours: Number(e.target.value) }))} />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12px] text-slateink-400">Most calls per run</span>
              <input type="number" min={1} max={50} className="field" value={draft.maxPerRun} onChange={(e) => setDraft((d) => ({ ...d, maxPerRun: Number(e.target.value) }))} />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12px] text-slateink-400">Calling hours start</span>
              <input type="number" min={0} max={23} className="field" value={draft.quietStart} onChange={(e) => setDraft((d) => ({ ...d, quietStart: Number(e.target.value) }))} />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12px] text-slateink-400">Calling hours end</span>
              <input type="number" min={0} max={24} className="field" value={draft.quietEnd} onChange={(e) => setDraft((d) => ({ ...d, quietEnd: Number(e.target.value) }))} />
            </label>
            <div className="sm:col-span-2 rounded-xl border border-slate-900/[0.045] bg-ink-850/50 px-3 py-1">
              <Toggle
                checked={draft.channelsCall}
                onChange={(v) => setDraft((d) => ({ ...d, channelsCall: v }))}
                label="Call them"
                desc="Rings each due booking with the assistant below. Needs a carrier connected."
              />
              <Toggle
                checked={draft.channelsSms}
                onChange={(v) => setDraft((d) => ({ ...d, channelsSms: v }))}
                label="Text them as well"
                desc="Queues the matching template — confirmation, reminder, win-back — through the message queue, consent permitting."
              />
              {!draft.channelsCall && !draft.channelsSms && (
                <p className="pb-2 text-[11.5px] text-amber-800">Neither channel is on: this campaign will only record what it would have done.</p>
              )}
            </div>
            <label className="block sm:col-span-2">
              <span className="mb-1.5 block text-[12px] text-slateink-400">Timezone for those hours</span>
              <input className="field font-mono text-[12px]" value={draft.timezone} onChange={(e) => setDraft((d) => ({ ...d, timezone: e.target.value }))} />
            </label>
            <label className="block sm:col-span-2">
              <span className="mb-1.5 block text-[12px] text-slateink-400">What the agent should say and do</span>
              <textarea
                className="field h-24 resize-none"
                value={draft.instructions}
                onChange={(e) => setDraft((d) => ({ ...d, instructions: e.target.value }))}
              />
              <span className="mt-1 block text-[11px] text-slateink-400">
                {'{{customer}}'} and {'{{appointment}}'} are filled per booking. The assistant&apos;s tools do the rest — move, cancel, text a confirmation.
              </span>
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setCreating(false); setEditing(null); }}>Cancel</Button>
            <Button variant="brand" size="sm" onClick={() => void saveCampaign()} disabled={busy === 'save'}>
              {busy === 'save' ? 'Saving…' : editing ? 'Save changes' : 'Create campaign'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}


/**
 * Today at the desk.
 *
 * The three verbs a receptionist actually uses — arrived, done, no-show — plus
 * the wait list, which is the answer to "we had a cancellation, who can take
 * it?". It reads the diary API rather than the campaign list, so it is the same
 * data the calendar and the phone agent see.
 */
function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function TodayAtTheDesk({ onChanged }: { onOpenCalendar: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [rows, setRows] = React.useState<
    { id: string; clientId?: string; customer: { name: string; number: string }; service: string; startsAt: string; status: string; providerName?: string; hasAlerts?: boolean; durationMinutes: number; localStart: number }[]
  >([]);
  const [waiting, setWaiting] = React.useState<{ id: string; name: string; from: string; to?: string }[]>([]);
  const [offers, setOffers] = React.useState<
    { id: string; name: string; spoken: string; expiresWords: string; status: string; channel: string; messageId?: string; kind?: 'slot' | 'class'; className?: string; slotFingerprint?: string }[]
  >([]);
  const [busy, setBusy] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const diary = await request<{ days: { date: string; appointments: { id: string; clientId?: string; customer: { name: string; number: string }; service: string; serviceName?: string; startsAt: string; status: string; providerName?: string; hasAlerts?: boolean; durationMinutes: number; localStart: number }[] }[] }>(
        'GET',
        '/api/v1/diary?view=day'
      );
      setRows((diary.days[0]?.appointments ?? []).map((a) => ({ ...a, service: a.serviceName ?? a.service })));
      const wait = await request<{ data: { id: string; name: string; from: string; to?: string }[] }>('GET', '/api/v1/wait-list');
      setWaiting(wait.data);
      const board = await request<{ data: typeof offers }>('GET', '/api/v1/wait-list/offers');
      setOffers(board.data ?? []);
    } catch {
      /* the desk card is an extra: a failure here must not break the page */
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function offer(entryId: string) {
    setBusy(entryId);
    try {
      const result = await request<{ offered: number; picked?: string; names: string[] }>('POST', '/api/v1/wait-list/offers', { entryId });
      toast(
        result.offered && result.picked
          ? `Offered ${result.picked} to ${result.names.join(', ')} — first to take it gets it.`
          : 'Nothing was offered — they may already have one out.'
      );
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Refused', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function takeBack(offerId: string) {
    setBusy(offerId);
    try {
      const result = await request<{ message?: string }>('DELETE', `/api/v1/wait-list/offers?id=${offerId}`);
      toast(result.message ?? 'Taken back.');
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Refused', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function act(id: string, status: string) {
    setBusy(id);
    try {
      const result = await request<{
        booking: { customer: { name: string } };
        waitListMatches?: { name: string }[];
        offers?: { offered: number; names: string[]; skipped: number };
      }>('POST', `/api/v1/bookings/${id}/status`, { status });
      toast(`${status}.`);
      // A cancellation now *does* something: the freed time is texted to the
      // people waiting for it, with their own link. The desk is told who got one
      // rather than being left to remember who was waiting.
      if (result.offers?.names.length) {
        toast(
          `Offered the freed ${result.offers.names.length === 1 ? 'time' : 'times'} to ${result.offers.names.join(', ')}${
            result.offers.skipped ? ` (+${result.offers.skipped} further down the list)` : ''
          } — first to take it gets it.`,
          'info'
        );
      } else if (result.waitListMatches?.length) {
        toast(`${result.waitListMatches.length} waiting client(s) want that slot — offer it from the wait list below.`, 'info');
      }
      await load();
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Refused', 'error');
    } finally {
      setBusy(null);
    }
  }

  const open = rows.filter((r) => r.status !== 'cancelled');

  return (
    <div className="mt-5 panel p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="h4">Today at the desk</h3>
          <p className="mt-0.5 text-[12.5px] text-slateink-400">
            {open.length} appointment(s) today{waiting.length ? ` · ${waiting.length} waiting for a slot` : ''}. Status changes here are the same record the calendar and the phone agent use.
          </p>
        </div>
        <LinkButton href="/dashboard/calendar" variant="ghost" size="sm">
          <Icons.calendar size={13} /> Open the calendar
        </LinkButton>
      </div>

      {open.length === 0 ? (
        <p className="text-[12.5px] text-slateink-500">Nothing on the diary today.</p>
      ) : (
        <ul className="space-y-2">
          {open.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-900/[0.04] bg-ink-900/40 px-3 py-2">
              <span className="font-mono text-[12px] text-brand-700">{fmtTime(row.startsAt)}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] text-slate-900">{row.customer.name}</span>
                  {row.hasAlerts && <Pill tone="warn">alert</Pill>}
                </div>
                <div className="truncate text-[11.5px] text-slateink-400">
                  {row.service}
                  {row.providerName ? ` · ${row.providerName}` : ''} · {row.durationMinutes}m
                </div>
              </div>
              <Pill tone={row.status === 'completed' ? 'default' : row.status === 'arrived' ? 'info' : 'brand'}>{row.status}</Pill>
              <span className="flex flex-wrap gap-1.5">
                {['arrived', 'completed', 'no_show'].map((status) => (
                  <Button key={status} variant="quiet" size="sm" disabled={busy === row.id || row.status === status} onClick={() => void act(row.id, status)}>
                    {status === 'no_show' ? 'No show' : status}
                  </Button>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}

      {waiting.length > 0 && (
        <div className="mt-4 border-t border-slate-900/[0.04] pt-4">
          <div className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-slateink-400">Waiting for a slot</div>
          <ul className="space-y-1.5">
            {waiting.slice(0, 8).map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-3 rounded-lg border border-slate-900/[0.04] px-2.5 py-1.5">
                <span className="text-[12.5px] text-slateink-200">
                  {entry.name} <span className="text-slateink-400">· from {entry.from}{entry.to ? ` to ${entry.to}` : ''}</span>
                </span>
                <Button
                  size="sm"
                  variant="quiet"
                  disabled={busy === entry.id}
                  onClick={() => void offer(entry.id)}
                  title="Offer them the next opening that fits their window"
                >
                  Offer the next opening
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {offers.length > 0 && (
        <div className="mt-4 border-t border-slate-900/[0.04] pt-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-slateink-400">Offers out right now</span>
            <span className="text-[11.5px] text-slateink-400">first to take it gets it · one place, one person</span>
          </div>
          <ul className="space-y-1.5">
            {offers.slice(0, 8).map((offer) => (
              <li key={offer.id} className="flex items-center justify-between gap-3 rounded-lg border border-slate-900/[0.04] px-2.5 py-1.5">
                <span className="text-[12.5px] text-slateink-200">
                  {offer.name}{' '}
                  <span className="text-slateink-400">
                    · {offer.kind === 'class' ? `a place in ${offer.className ?? 'a class'} — ${offer.spoken}` : offer.spoken} · until {offer.expiresWords}
                  </span>
                  {offer.kind !== 'class' && offer.slotFingerprint ? <span className="ml-2"><Pill tone="info" title="The exact native slot is revalidated before claim.">revalidated on claim</Pill></span> : null}
                </span>
                <Button
                  size="sm"
                  variant="quiet"
                  disabled={busy === offer.id}
                  onClick={() => void takeBack(offer.id)}
                  title="Take the offer back — the slot is yours again and they stay on the list"
                >
                  Take it back
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
