'use client';

/**
 * Messaging.
 *
 * Five questions, five tabs, and no tab that merely looks busy:
 *
 *   - **Queue** — what is about to go, what went, and what was refused. Anybody
 *     can see why a message did not reach a patient, which is the question a
 *     reception desk actually asks.
 *   - **Templates** — the words, in this practice's vocabulary, with merge fields
 *     and a preview filled from a real appointment in this workspace.
 *   - **Rules** — when to remind, on which channels, how late is too late, what
 *     happens when somebody does not turn up, and the hours during which any of it
 *     may happen.
 *   - **Reports** — the outreach tally and the no-show rate, with the previous
 *     period beside it so a change is visible rather than asserted.
 *   - **Scheduler** — each job, its cadence, when it last ran, what it said, and a
 *     button to run it now. This is where "why did nobody get a reminder?" is
 *     answered.
 */

import * as React from 'react';
import Link from 'next/link';
import { ApiError, request } from '@/lib/server-sync';
import { cn, fmtDate } from '@/lib/utils';
import { Ago } from '@/components/dash/Ago';
import { Icons } from '@/components/icons';
import { Button, EmptyState, Modal, Pill, Tabs, Toggle, useToast } from '@/components/ui';
import { DataTable, StatCard } from '@/components/dash/bits';
import { PageHeader } from '@/components/dash/Shell';

/* ------------------------------------------------------------------- types */

type MessageRow = {
  id: string;
  clientId?: string;
  bookingId?: string;
  channel: 'sms' | 'email';
  to: string;
  body: string;
  subject?: string;
  status: 'pending' | 'sent' | 'failed' | 'blocked' | 'cancelled';
  sendAt: string;
  sentAt?: string;
  attempts: number;
  provider?: string;
  reason?: string;
  source: string;
  kind?: string;
};

/**
 * A client's reply that a person still has to answer — a change request, or a
 * question the keywords could not resolve. The desk's to-do list, not a log.
 */
type ReplyRow = {
  id: string;
  at: string;
  clientName: string;
  clientNumber?: string;
  detail: string;
  request?: string;
  appointment?: string;
};

type TemplateRow = {
  id: string;
  kind: string;
  channel: 'sms' | 'email';
  name: string;
  subject: string | null;
  body: string;
  enabled: boolean;
  seeded: boolean;
  editedAt: string | null;
  updatedAt: string;
};

type Rules = {
  reminder: { enabled: boolean; leadMinutes: number; skipInsideMinutes: number; queueAheadMinutes: number; channels: ('sms' | 'email')[] };
  noShowFollowUp: { enabled: boolean; withinHours: number; channel: 'sms' | 'email' };
  followUpAfterVisit: { enabled: boolean; delayMinutes: number };
  recall: { enabled: boolean; afterDays: number; channels: ('sms' | 'email')[]; cooldownDays: number; maxPerDay: number };
  /** Days relative to the due date: -3 is before it falls due. */
  overdue: { enabled: boolean; offsetsDays: number[]; channels: ('sms' | 'email')[] };
};

type Settings = {
  quietHours: { start: number; end: number; timezone?: string };
  channels: { sms: boolean; email: boolean };
  maxAttempts: number;
};

type Job = {
  name: string;
  label: string;
  description: string;
  everyMinutes: number;
  global: boolean;
  enabled: boolean;
  runs: number;
  failures: number;
  lastRunAt: string | null;
  lastResult: { at: string; ok: boolean; detail: string } | null;
  nextRunAt: string;
  dueNow: boolean;
};

type NoShowReport = {
  from: string;
  to: string;
  considered: number;
  attended: number;
  noShows: number;
  cancelled: number;
  noShowRateLabel: string;
  previousRateLabel: string | null;
  byProvider: { providerId: string; name: string; booked: number; noShows: number; rate: number }[];
  byService: { serviceId: string; name: string; booked: number; noShows: number; rate: number }[];
  byWeekday: { weekday: string; booked: number; noShows: number; rate: number }[];
  outreach: { followUpsSent: number; remindersSent: number; confirmationsSent: number; blocked: number; failed: number };
  rows: { id: string; clientName: string; startsAt: string; providerName: string; serviceName: string; reference: string }[];
  unsettled: { count: number; rows: { id: string; clientName: string; startsAt: string; providerName: string; serviceName: string; reference: string; status: string }[] };
};

type Summary = {
  windowDays: number;
  total: number;
  byKind: Record<string, number>;
  byChannel: Record<string, number>;
  byOutcome: Record<string, number>;
  reached: number;
  blocked: number;
  failed: number;
  recent: { id: string; channel: string; kind: string; outcome: string; to: string; at: string; detail?: string; actor: string }[];
};

const STATUS_TONE: Record<MessageRow['status'], 'brand' | 'warn' | 'danger' | 'default'> = {
  pending: 'warn',
  sent: 'brand',
  failed: 'danger',
  blocked: 'danger',
  cancelled: 'default',
};

const KINDS = ['confirmation', 'reminder', 'followup', 'no_show', 'winback', 'recall', 'waitlist_offer', 'receipt', 'refund', 'overdue'];

function kindLabel(kind: string) {
  return (
    {
      confirmation: 'Confirmation',
      reminder: 'Reminder',
      followup: 'After the visit',
      no_show: 'Missed appointment',
      winback: 'We miss you',
      recall: 'Due for a check-up',
      waitlist_offer: 'Freed slot',
      receipt: 'Receipt',
      refund: 'Refund sent',
      overdue: 'Invoice still open',
      payment_link: 'Payment link',
      manual: 'Manual',
      unknown: 'Other',
    } as Record<string, string>
  )[kind] ?? kind;
}

function hourLabel(hour: number) {
  const h = ((hour % 24) + 24) % 24;
  return `${String(h).padStart(2, '0')}:00`;
}

/* -------------------------------------------------------------------- page */

export default function MessagingPage() {
  const toast = useToast();
  const [tab, setTab] = React.useState<'queue' | 'replies' | 'templates' | 'rules' | 'reports' | 'scheduler'>('queue');
  const [replies, setReplies] = React.useState<ReplyRow[]>([]);
  const [needsAuth, setNeedsAuth] = React.useState(false);
  const [messages, setMessages] = React.useState<MessageRow[]>([]);
  const [stats, setStats] = React.useState<Record<string, number>>({});
  const [busy, setBusy] = React.useState('');
  const [composeOpen, setComposeOpen] = React.useState(false);
  const [filter, setFilter] = React.useState<'all' | MessageRow['status']>('all');

  const load = React.useCallback(async () => {
    try {
      const res = await request<{ data: MessageRow[]; stats: Record<string, number> }>('GET', '/api/v1/messages?limit=200');
      setMessages(res.data ?? []);
      setStats(res.stats ?? {});
      setNeedsAuth(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setNeedsAuth(true);
    }
    // A client who replied and is waiting for a person is worth a badge on the
    // tab — it is the one thing on this screen with somebody on the other end of it.
    try {
      const waiting = await request<{ replies: ReplyRow[] }>('GET', '/api/v1/messages/replies?limit=50');
      setReplies(waiting.replies ?? []);
    } catch {
      setReplies([]);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const act = async (label: string, run: () => Promise<unknown>, success: string) => {
    setBusy(label);
    try {
      await run();
      toast(success);
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'That did not work', 'error');
    } finally {
      setBusy('');
    }
  };

  const rows = filter === 'all' ? messages : messages.filter((m) => m.status === filter);
  const pending = stats.pending ?? 0;
  const sent = stats.sent ?? 0;
  const blocked = (stats.blocked ?? 0) + (stats.failed ?? 0);

  return (
    <>
      <PageHeader
        title="Messaging"
        desc="Texts and emails, the rules that send them, and the scheduler that decides when."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => void load()}>
              <Icons.refresh size={14} /> Refresh
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setComposeOpen(true)}>
              <Icons.send size={14} /> Compose
            </Button>
            <Button
              variant="brand"
              size="sm"
              disabled={busy === 'deliver'}
              onClick={() => act('deliver', () => request('POST', '/api/v1/messages', { action: 'deliver' }), 'Queue run.')}
            >
              {busy === 'deliver' ? 'Sending…' : 'Send what is due'}
            </Button>
          </div>
        }
      />

      {needsAuth && (
        <div className="mb-5 rounded-2xl border border-slate-900/[0.035] bg-ink-850/60 p-4 text-[13px] text-slateink-300">
          Sign in to see this workspace&rsquo;s messages.
        </div>
      )}

      <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Waiting to send" value={String(pending)} sub={pending ? 'Due messages go at the next tick.' : 'Nothing waiting.'} />
        <StatCard label="Sent" value={String(sent)} sub="Delivered by your carrier or relay." />
        <StatCard label="Refused or failed" value={String(blocked)} sub="No consent, or the carrier said no." />
        <StatCard label="Cancelled" value={String(stats.cancelled ?? 0)} sub="Reminders withdrawn with their appointment." />
      </div>

      <Tabs
        className="mb-5"
        active={tab}
        onChange={(id) => setTab(id as typeof tab)}
        tabs={[
          { id: 'queue', label: 'Queue', badge: String(pending || '') },
          { id: 'replies', label: 'Replies', badge: String(replies.length || '') },
          { id: 'templates', label: 'Templates' },
          { id: 'rules', label: 'Rules' },
          { id: 'reports', label: 'Reports' },
          { id: 'scheduler', label: 'Scheduler' },
        ]}
      />

      {tab === 'queue' && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {(['all', 'pending', 'sent', 'blocked', 'failed', 'cancelled'] as const).map((id) => (
              <button
                key={id}
                onClick={() => setFilter(id)}
                className={cn(
                  'rounded-full border px-3 py-1.5 text-[12px] capitalize transition-colors',
                  filter === id ? 'border-slate-900/[0.09] bg-white text-black' : 'border-slate-900/[0.035] text-slateink-300 hover:text-slate-900'
                )}
              >
                {id === 'all' ? `All ${messages.length}` : `${id} ${stats[id] ?? 0}`}
              </button>
            ))}
          </div>

          {rows.length === 0 ? (
            <EmptyState
              icon="send"
              title="Nothing in the queue"
              desc="Confirmations and reminders land here the moment a booking is made against the diary."
            />
          ) : (
            <DataTable
              columns={[
                { key: 'when', label: 'When' },
                { key: 'channel', label: 'Channel' },
                { key: 'kind', label: 'For' },
                { key: 'to', label: 'To' },
                { key: 'body', label: 'Body' },
                { key: 'status', label: 'Status' },
                { key: 'actions', label: '', align: 'right' },
              ]}
            >
              {rows.map((m) => (
                <tr key={m.id} className="border-b border-slate-900/[0.035] last:border-0 hover:bg-slate-900/[0.02]">
                  <td className="whitespace-nowrap px-4 py-3 align-top text-[12.5px] text-slateink-300">
                    <div>{m.status === 'sent' ? fmtDate(m.sentAt ?? m.sendAt) : fmtDate(m.sendAt)}</div>
                    <div className="font-mono text-[10.5px] text-slateink-500"><Ago at={m.status === 'sent' ? m.sentAt ?? m.sendAt : m.sendAt} /></div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 align-top">
                    <Pill tone={m.channel === 'sms' ? 'info' : 'default'}>{m.channel === 'sms' ? 'SMS' : 'Email'}</Pill>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 align-top text-[12.5px] text-slateink-300">{kindLabel(m.kind ?? 'unknown')}</td>
                  <td className="whitespace-nowrap px-4 py-3 align-top font-mono text-[12px] text-slateink-200">{m.to}</td>
                  <td className="max-w-[420px] px-4 py-3 align-top text-[12.5px] leading-snug text-slateink-200">
                    <div className="line-clamp-2">{m.subject ? `${m.subject} — ` : ''}{m.body}</div>
                    {m.reason && <div className="mt-1 text-[11.5px] text-rose-700">{m.reason}</div>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 align-top">
                    <Pill tone={STATUS_TONE[m.status]}>{m.status}</Pill>
                    {m.provider && <div className="mt-1 font-mono text-[10.5px] text-slateink-500">via {m.provider}</div>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 align-top text-right">
                    {m.status === 'pending' && (
                      <Button
                        variant="quiet"
                        size="sm"
                        disabled={busy === m.id}
                        onClick={() => act(m.id, () => request('DELETE', `/api/v1/messages?id=${encodeURIComponent(m.id)}`), 'Message cancelled.')}
                      >
                        Cancel
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </>
      )}

      {tab === 'replies' && <RepliesTab rows={replies} reload={load} />}
      {tab === 'templates' && <TemplatesTab />}
      {tab === 'rules' && <RulesTab />}
      {tab === 'reports' && <ReportsTab />}
      {tab === 'scheduler' && <SchedulerTab />}

      {composeOpen && (
        <ComposeModal
          onClose={() => setComposeOpen(false)}
          onSent={() => {
            setComposeOpen(false);
            void load();
          }}
        />
      )}
    </>
  );
}

/* ---------------------------------------------------------------- compose */

function ComposeModal({ onClose, onSent }: { onClose: () => void; onSent: () => void }) {
  const toast = useToast();
  const [form, setForm] = React.useState({ to: '', channel: 'sms', body: '', sendAt: '', force: false });
  const [saving, setSaving] = React.useState(false);

  const send = async () => {
    setSaving(true);
    try {
      await request('POST', '/api/v1/messages', {
        action: 'send',
        to: form.to,
        channel: form.channel,
        body: form.body,
        sendAt: form.sendAt || undefined,
        force: form.force || undefined,
      });
      toast('Queued — it goes at the next tick, or now if it is already due.');
      onSent();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not queue that', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Send a message"
      desc="Consent is checked before it goes. A message refused for consent is still recorded, with the reason."
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="brand" disabled={saving || !form.to || !form.body} onClick={() => void send()}>
            {saving ? 'Queueing…' : 'Queue message'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-slateink-300">To</span>
            <input
              className="input w-full"
              placeholder="+1 555 0100 or amara@example.com"
              value={form.to}
              onChange={(e) => setForm({ ...form, to: e.target.value })}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-slateink-300">Channel</span>
            <select className="input w-full" value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}>
              <option value="sms">SMS</option>
              <option value="email">Email</option>
            </select>
          </label>
        </div>
        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium text-slateink-300">Message</span>
          <textarea
            className="input min-h-[110px] w-full font-sans"
            placeholder="Short, specific, and signed by the practice."
            value={form.body}
            onChange={(e) => setForm({ ...form, body: e.target.value })}
          />
          {form.channel === 'sms' && (
            <span className="mt-1 block font-mono text-[10.5px] text-slateink-500">
              {form.body.length} characters · {Math.max(1, Math.ceil((form.body.length + 22) / 160))} segment(s) · the opt-out line is added for you
            </span>
          )}
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-slateink-300">Send at (optional)</span>
            <input
              type="datetime-local"
              className="input w-full"
              value={form.sendAt}
              onChange={(e) => setForm({ ...form, sendAt: e.target.value })}
            />
          </label>
          <div className="rounded-xl border border-slate-900/[0.045] bg-ink-850/50 px-3">
            <Toggle
              checked={form.force}
              onChange={(v) => setForm({ ...form, force: v })}
              label="Send even without consent"
              desc="For a message the person asked for. The reason is still recorded."
            />
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------- templates */

/**
 * What clients have texted back, and are waiting for a person.
 *
 * A change request that only exists in a log is a client who believes something
 * is arranged when nothing is. So this is a to-do list: who, what they said, which
 * appointment, and one button that says it is dealt with. Ticking it off keeps the
 * message in their thread — nothing is deleted — it just stops asking.
 */
function RepliesTab({ rows, reload }: { rows: ReplyRow[]; reload: () => Promise<void> }) {
  const toast = useToast();
  const [busy, setBusy] = React.useState('');

  const resolve = async (row: ReplyRow) => {
    setBusy(row.id);
    try {
      await request('POST', '/api/v1/messages/replies', { action: 'resolve', id: row.id });
      toast('Marked as dealt with.');
      await reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'That did not work', 'error');
    } finally {
      setBusy('');
    }
  };

  if (!rows.length) {
    return (
      <EmptyState
        icon="check"
        title="Nobody is waiting"
        desc="When a client replies to a reminder — to confirm, to change the time, or to ask something — it lands here with the appointment it is about."
      />
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-[12.5px] text-slateink-400">
        {rows.length} {rows.length === 1 ? 'reply is' : 'replies are'} waiting on a person. Confirming and cancelling are handled
        automatically; anything else needs somebody to look at the diary.
      </p>
      {rows.map((row) => (
        <div key={row.id} className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-medium text-slate-900">{row.clientName}</span>
                {row.clientNumber && <span className="font-mono text-[11.5px] text-slateink-400">{row.clientNumber}</span>}
                <Pill tone="warn"><Ago at={row.at} /></Pill>
              </div>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-slateink-200">
                &ldquo;{row.request ?? row.detail}&rdquo;
              </p>
              <p className="mt-1 text-[12px] text-slateink-400">
                {row.appointment ? `About ${row.appointment}` : 'No upcoming appointment on file'}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Link
                href="/dashboard/calendar"
                className="rounded-lg border border-slate-900/[0.06] px-3 py-1.5 text-[12.5px] text-slateink-200 transition hover:border-slate-900/[0.05] hover:text-slate-900"
              >
                Open the diary
              </Link>
              <Button variant="brand" size="sm" disabled={busy === row.id} onClick={() => void resolve(row)}>
                {busy === row.id ? 'Saving…' : 'Dealt with'}
              </Button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function TemplatesTab() {
  const toast = useToast();
  const [templates, setTemplates] = React.useState<TemplateRow[]>([]);
  const [mergeFields, setMergeFields] = React.useState<{ key: string; description: string; sample: string }[]>([]);
  const [sample, setSample] = React.useState<Record<string, string>>({});
  const [stats, setStats] = React.useState<{ active: number; retired: number; unwritten: string[]; seededNow?: number } | null>(null);
  const [optOut, setOptOut] = React.useState<{ sms: string; email: string } | null>(null);
  const [showRetired, setShowRetired] = React.useState(false);
  const [draft, setDraft] = React.useState<{ id?: string; kind: string; channel: 'sms' | 'email'; name: string; subject: string; body: string } | null>(null);
  const [preview, setPreview] = React.useState<{ preview: string; unknown: string[] } | null>(null);
  const [saving, setSaving] = React.useState(false);
  const bodyRef = React.useRef<HTMLTextAreaElement | null>(null);

  const load = React.useCallback(async () => {
    try {
      const res = await request<{
        templates: TemplateRow[];
        mergeFields: { key: string; description: string; sample: string }[];
        sample: Record<string, string>;
        stats: { active: number; retired: number; unwritten: string[]; seededNow?: number };
        optOut: { sms: string; email: string };
      }>('GET', `/api/v1/templates${showRetired ? '?include=retired' : ''}`);
      setTemplates(res.templates ?? []);
      setMergeFields(res.mergeFields ?? []);
      setSample(res.sample ?? {});
      setStats(res.stats ?? null);
      setOptOut(res.optOut ?? null);
      if (res.stats?.seededNow) toast(`Added ${res.stats.seededNow} starter template(s) for this workspace.`);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load templates', 'error');
    }
  }, [showRetired, toast]);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    if (!draft) {
      setPreview(null);
      return;
    }
    const timer = setTimeout(() => {
      void request<{ preview: string; unknown: string[] }>('POST', '/api/v1/templates', {
        action: 'preview',
        body: draft.body,
        channel: draft.channel,
      })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 250);
    return () => clearTimeout(timer);
  }, [draft]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const res = await request<{ warning?: string | null; smsSegments?: number | null }>('POST', '/api/v1/templates', {
        action: 'save',
        id: draft.id,
        kind: draft.kind,
        channel: draft.channel,
        name: draft.name,
        subject: draft.subject,
        body: draft.body,
      });
      toast(res.warning ?? (res.smsSegments ? `Saved — ${res.smsSegments} segment(s) when it goes out.` : 'Template saved.'), res.warning ? 'error' : undefined);
      setDraft(null);
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save that', 'error');
    } finally {
      setSaving(false);
    }
  };

  const act = async (id: string, action: 'retire' | 'restore' | 'reset', message: string) => {
    try {
      await request('POST', '/api/v1/templates', { action, id });
      toast(message);
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'That did not work', 'error');
    }
  };

  const insertField = (key: string) => {
    if (!draft) return;
    const el = bodyRef.current;
    if (!el) {
      setDraft({ ...draft, body: `${draft.body}{{${key}}}` });
      return;
    }
    const start = el.selectionStart ?? draft.body.length;
    const end = el.selectionEnd ?? draft.body.length;
    const next = `${draft.body.slice(0, start)}{{${key}}}${draft.body.slice(end)}`;
    setDraft({ ...draft, body: next });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + key.length + 4, start + key.length + 4);
    });
  };

  const grouped = KINDS.map((kind) => ({ kind, rows: templates.filter((t) => t.kind === kind) })).filter((g) => g.rows.length);
  const other = templates.filter((t) => !KINDS.includes(t.kind));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-4">
        <div className="text-[13px] text-slateink-300">
          <span className="font-medium text-slate-900">{stats?.active ?? 0}</span> active
          {stats?.retired ? <> · {stats.retired} retired</> : null}
          {stats?.unwritten?.length ? (
            <span className="text-amber-800"> · no wording yet for {stats.unwritten.map(kindLabel).join(', ')} (a plain sentence is used)</span>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-[12.5px] text-slateink-300">
            <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} /> Show retired
          </label>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              setDraft({ kind: 'reminder', channel: 'sms', name: 'New template', subject: '', body: 'Hi {{client_first_name}} — ' })
            }
          >
            <Icons.plus size={14} /> New template
          </Button>
        </div>
      </div>

      {optOut && (
        <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-4 text-[12.5px] leading-relaxed text-slateink-400">
          <span className="font-medium text-slateink-200">Opt-out is not editable.</span> {optOut.sms}
        </div>
      )}

      {templates.length === 0 && <EmptyState icon="book" title="No templates yet" desc="Reload the page and the starter set is added for you." />}

      {grouped.map((group) => (
        <div key={group.kind} className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40">
          <div className="border-b border-slate-900/[0.04] px-4 py-3">
            <div className="text-[13.5px] font-medium text-slate-900">{kindLabel(group.kind)}</div>
          </div>
          <div className="divide-y divide-slate-900/[0.03]">
            {group.rows.map((t) => (
              <div key={t.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Pill tone={t.channel === 'sms' ? 'info' : 'default'}>{t.channel === 'sms' ? 'SMS' : 'Email'}</Pill>
                    <span className="text-[13px] font-medium text-slate-900">{t.name}</span>
                    {!t.enabled && <Pill tone="default">retired</Pill>}
                    {t.seeded && !t.editedAt && <span className="font-mono text-[10.5px] text-slateink-500">house default</span>}
                    {t.editedAt && <span className="font-mono text-[10.5px] text-brand-700">edited</span>}
                  </div>
                  {t.subject && <div className="mt-1 text-[12.5px] text-slateink-300">Subject: {t.subject}</div>}
                  <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-[12.5px] leading-snug text-slateink-400">{t.body}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    size="sm"
                    variant="quiet"
                    onClick={() => setDraft({ id: t.id, kind: t.kind, channel: t.channel, name: t.name, subject: t.subject ?? '', body: t.body })}
                  >
                    Edit
                  </Button>
                  {t.enabled ? (
                    <Button size="sm" variant="quiet" onClick={() => act(t.id, 'retire', 'Template retired — kept in the list, no longer sent.')}>
                      Retire
                    </Button>
                  ) : (
                    <Button size="sm" variant="quiet" onClick={() => act(t.id, 'restore', 'Template restored.')}>
                      Restore
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {other.length > 0 && (
        <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-4 text-[12.5px] text-slateink-400">
          {other.length} template(s) this build does not recognise.
        </div>
      )}

      {draft && (
        <Modal
          open
          onClose={() => setDraft(null)}
          width="lg"
          title={draft.id ? 'Edit template' : 'New template'}
          desc="Merge fields are filled in when the message is sent. Unknown fields are left visible on purpose, so a typo is obvious before it reaches anybody."
          footer={
            <>
              {draft.id && (
                <Button
                  variant="quiet"
                  onClick={() => act(draft.id as string, 'reset', 'Reset to the house default. The old wording is still in the retired list.')}
                >
                  Reset to house default
                </Button>
              )}
              <Button variant="quiet" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button variant="brand" disabled={saving || !draft.body.trim()} onClick={() => void save()}>
                {saving ? 'Saving…' : 'Save template'}
              </Button>
            </>
          }
        >
          <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="block sm:col-span-1">
                  <span className="mb-1.5 block text-[12px] font-medium text-slateink-300">For</span>
                  <select className="input w-full" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
                    {KINDS.map((k) => (
                      <option key={k} value={k}>
                        {kindLabel(k)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block sm:col-span-1">
                  <span className="mb-1.5 block text-[12px] font-medium text-slateink-300">Channel</span>
                  <select
                    className="input w-full"
                    value={draft.channel}
                    onChange={(e) => setDraft({ ...draft, channel: e.target.value as 'sms' | 'email' })}
                  >
                    <option value="sms">SMS</option>
                    <option value="email">Email</option>
                  </select>
                </label>
                <label className="block sm:col-span-1">
                  <span className="mb-1.5 block text-[12px] font-medium text-slateink-300">Name</span>
                  <input className="input w-full" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                </label>
              </div>
              {draft.channel === 'email' && (
                <label className="block">
                  <span className="mb-1.5 block text-[12px] font-medium text-slateink-300">Subject</span>
                  <input className="input w-full" value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
                </label>
              )}
              <label className="block">
                <span className="mb-1.5 block text-[12px] font-medium text-slateink-300">Body</span>
                <textarea
                  ref={bodyRef}
                  className="input min-h-[190px] w-full font-sans"
                  value={draft.body}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                />
                <span className="mt-1 block font-mono text-[10.5px] text-slateink-500">
                  {draft.body.length} characters
                  {draft.channel === 'sms' && <> · {Math.max(1, Math.ceil((draft.body.length + 22) / 160))} segment(s)</>}
                </span>
              </label>
            </div>

            <div className="space-y-3">
              <div className="rounded-xl border border-slate-900/[0.045] bg-ink-900/50 p-3">
                <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-slateink-400">Merge fields</div>
                <div className="flex flex-wrap gap-1.5">
                  {mergeFields.map((f) => (
                    <button
                      key={f.key}
                      title={`${f.description} — e.g. ${f.sample}`}
                      onClick={() => insertField(f.key)}
                      className="rounded-full border border-slate-900/[0.035] px-2 py-1 font-mono text-[10.5px] text-slateink-300 transition-colors hover:border-brand-500/40 hover:text-slate-900"
                    >
                      {`{{${f.key}}}`}
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-slate-900/[0.045] bg-ink-900/50 p-3">
                <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-slateink-400">Preview</div>
                {preview?.unknown?.length ? (
                  <div className="mb-2 text-[11.5px] text-amber-800">
                    {preview.unknown.map((u) => `{{${u}}}`).join(', ')} {preview.unknown.length === 1 ? 'is not a field' : 'are not fields'} — it will be sent as written.
                  </div>
                ) : null}
                <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-slateink-200">
                  {preview?.preview || <span className="text-slateink-500">Start typing…</span>}
                </div>
              </div>

              <div className="rounded-xl border border-slate-900/[0.045] bg-ink-900/50 p-3 text-[12px] leading-relaxed text-slateink-400">
                Filled from this workspace: <span className="text-slateink-200">{sample.client_first_name}</span>,{' '}
                <span className="text-slateink-200">{sample.when}</span> with <span className="text-slateink-200">{sample.provider || '—'}</span> at{' '}
                <span className="text-slateink-200">{sample.location || '—'}</span>.
              </div>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ rules */

function RulesTab() {
  const toast = useToast();
  const [rules, setRules] = React.useState<Rules | null>(null);
  const [settings, setSettings] = React.useState<Settings | null>(null);
  const [timezone, setTimezone] = React.useState('UTC');
  const [saving, setSaving] = React.useState('');

  const load = React.useCallback(async () => {
    try {
      const res = await request<{ rules: Rules; settings: Settings; timezone: string }>('GET', '/api/v1/outreach?view=rules');
      setRules(res.rules);
      setSettings(res.settings);
      setTimezone(res.timezone);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load the rules', 'error');
    }
  }, [toast]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const save = async (what: 'save-rules' | 'save-settings') => {
    setSaving(what);
    try {
      if (what === 'save-rules') {
        const res = await request<{ rules: Rules; timezone: string }>('POST', '/api/v1/outreach', { action: 'save-rules', rules });
        setRules(res.rules);
        setTimezone(res.timezone);
      } else {
        const res = await request<{ settings: Settings }>('POST', '/api/v1/outreach', { action: 'save-settings', settings });
        setSettings(res.settings);
      }
      toast('Saved. The scheduler picks the change up on its next tick.');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save that', 'error');
    } finally {
      setSaving('');
    }
  };

  const toggleChannel = (channel: 'sms' | 'email') => {
    if (!rules) return;
    const has = rules.reminder.channels.includes(channel);
    const channels = has ? rules.reminder.channels.filter((c) => c !== channel) : [...rules.reminder.channels, channel];
    setRules({ ...rules, reminder: { ...rules.reminder, channels } });
  };

  if (!rules || !settings) return <div className="panel h-48 animate-pulse bg-ink-850/40" />;

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-5">
        <div className="mb-2 text-[14px] font-medium text-slate-900">Reminders</div>
        <Toggle
          checked={rules.reminder.enabled}
          onChange={(v) => setRules({ ...rules, reminder: { ...rules.reminder, enabled: v } })}
          label="Remind people before their appointment"
          desc="One reminder per appointment per channel. Cancel the appointment and the reminder goes with it."
        />
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-slateink-300">Send it this far ahead</span>
            <select
              className="input w-full"
              value={rules.reminder.leadMinutes}
              onChange={(e) => setRules({ ...rules, reminder: { ...rules.reminder, leadMinutes: Number(e.target.value) } })}
            >
              {[60, 120, 180, 720, 1440, 2880, 10080].map((m) => (
                <option key={m} value={m}>
                  {m < 60 ? `${m} minutes` : m < 1440 ? `${m / 60} hour${m / 60 > 1 ? 's' : ''}` : `${m / 1440} day${m / 1440 > 1 ? 's' : ''}`}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-slateink-300">Show it in the queue this far ahead</span>
            <select
              className="input w-full"
              value={rules.reminder.queueAheadMinutes}
              onChange={(e) => setRules({ ...rules, reminder: { ...rules.reminder, queueAheadMinutes: Number(e.target.value) } })}
            >
              {[0, 720, 1440, 2880, 10080].map((m) => (
                <option key={m} value={m}>
                  {m === 0 ? 'no earlier than it is due' : m < 1440 ? `${m / 60} hour${m / 60 > 1 ? 's' : ''}` : `${m / 1440} day${m / 1440 > 1 ? 's' : ''}`}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-slateink-300">Ignore appointments closer than</span>
            <select
              className="input w-full"
              value={rules.reminder.skipInsideMinutes}
              onChange={(e) => setRules({ ...rules, reminder: { ...rules.reminder, skipInsideMinutes: Number(e.target.value) } })}
            >
              {[15, 30, 60, 120, 240].map((m) => (
                <option key={m} value={m}>
                  {m} minutes
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-3">
          <span className="mb-1.5 block text-[12px] font-medium text-slateink-300">Channels</span>
          <div className="flex gap-2">
            {(['sms', 'email'] as const).map((c) => (
              <button
                key={c}
                onClick={() => toggleChannel(c)}
                className={cn(
                  'rounded-full border px-3 py-1.5 text-[12px] transition-colors',
                  rules.reminder.channels.includes(c)
                    ? 'border-brand-500/40 bg-brand-500/15 text-brand-700'
                    : 'border-slate-900/[0.035] text-slateink-400 hover:text-slate-900'
                )}
              >
                {c === 'sms' ? 'SMS' : 'Email'}
              </button>
            ))}
          </div>
          {rules.reminder.channels.length === 0 && <div className="mt-2 text-[12px] text-amber-800">No channel selected — reminders will not go.</div>}
        </div>
        <p className="mt-3 text-[12px] leading-relaxed text-slateink-500">
          The reminder joins the queue {rules.reminder.queueAheadMinutes ? `${rules.reminder.queueAheadMinutes / 60}h` : ''} ahead and leaves it at
          T-minus {rules.reminder.leadMinutes / 60}h — never before, never for an appointment that has already started, and re-timed if the
          appointment moves.
        </p>
      </div>

      <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-5">
        <div className="mb-2 text-[14px] font-medium text-slate-900">When somebody does not turn up</div>
        <Toggle
          checked={rules.noShowFollowUp.enabled}
          onChange={(v) => setRules({ ...rules, noShowFollowUp: { ...rules.noShowFollowUp, enabled: v } })}
          label="Text them the same day"
          desc="Only for a missed appointment — never for one the person cancelled themselves."
        />
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-slateink-300">Within this long after</span>
            <select
              className="input w-full"
              value={rules.noShowFollowUp.withinHours}
              onChange={(e) => setRules({ ...rules, noShowFollowUp: { ...rules.noShowFollowUp, withinHours: Number(e.target.value) } })}
            >
              {[4, 12, 24, 48, 72].map((h) => (
                <option key={h} value={h}>
                  {h} hours
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-slateink-300">Channel</span>
            <select
              className="input w-full"
              value={rules.noShowFollowUp.channel}
              onChange={(e) => setRules({ ...rules, noShowFollowUp: { ...rules.noShowFollowUp, channel: e.target.value as 'sms' | 'email' } })}
            >
              <option value="sms">SMS</option>
              <option value="email">Email</option>
            </select>
          </label>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-5">
        <div className="mb-2 text-[14px] font-medium text-slate-900">After a visit</div>
        <Toggle
          checked={rules.followUpAfterVisit.enabled}
          onChange={(v) => setRules({ ...rules, followUpAfterVisit: { ...rules.followUpAfterVisit, enabled: v } })}
          label="Thank people for coming in"
          desc="Off by default: it is a marketing decision, not an operational one."
        />
        <label className="mt-3 block">
          <span className="mb-1.5 block text-[12px] font-medium text-slateink-300">Delay after the appointment ends</span>
          <select
            className="input w-full"
            value={rules.followUpAfterVisit.delayMinutes}
            onChange={(e) => setRules({ ...rules, followUpAfterVisit: { ...rules.followUpAfterVisit, delayMinutes: Number(e.target.value) } })}
          >
            {[30, 60, 120, 240, 1440].map((m) => (
              <option key={m} value={m}>
                {m < 60 ? `${m} minutes` : `${m / 60} hour${m / 60 > 1 ? 's' : ''}`}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-5">
        <div className="mb-2 text-[14px] font-medium text-slate-900">Chasing an unpaid bill</div>
        <Toggle
          checked={rules.overdue.enabled}
          onChange={(v) => setRules({ ...rules, overdue: { ...rules.overdue, enabled: v } })}
          label="Ask for money that is still owed"
          desc="One message per step per invoice, ever. Paying the bill takes back anything unsent."
        />
        <label className="mt-3 block">
          <span className="mb-1.5 block text-[12px] font-medium text-slateink-300">Steps, in days from the due date</span>
          <input
            className="input w-full font-mono"
            value={rules.overdue.offsetsDays.join(', ')}
            onChange={(e) =>
              setRules({
                ...rules,
                overdue: {
                  ...rules.overdue,
                  // Text in, numbers out: a practice writes "-3, 0, 7, 21" and the
                  // server sorts, deduplicates and clamps it either way.
                  offsetsDays: e.target.value
                    .split(',')
                    .map((part) => Number(part.trim()))
                    .filter((n) => Number.isFinite(n)),
                },
              })
            }
            placeholder="-3, 0, 7, 21"
          />
        </label>
        <p className="mt-2 text-[12px] leading-relaxed text-slateink-500">
          <span className="font-mono">-3</span> is three days before the bill falls due, <span className="font-mono">0</span> is the day
          itself, <span className="font-mono">7</span> and <span className="font-mono">21</span> are after. A bill that has been sitting
          unpaid for a while gets the newest step only — never a week of texts at once.
        </p>
        <div className="mt-3">
          <span className="mb-1.5 block text-[12px] font-medium text-slateink-300">Channels</span>
          <div className="flex gap-2">
            {(['sms', 'email'] as const).map((c) => {
              const has = rules.overdue.channels.includes(c);
              return (
                <button
                  key={c}
                  onClick={() =>
                    setRules({
                      ...rules,
                      overdue: { ...rules.overdue, channels: has ? rules.overdue.channels.filter((x) => x !== c) : [...rules.overdue.channels, c] },
                    })
                  }
                  className={cn(
                    'rounded-full border px-3 py-1.5 text-[12px] transition-colors',
                    has ? 'border-brand-500/40 bg-brand-500/15 text-brand-700' : 'border-slate-900/[0.035] text-slateink-400 hover:text-slate-900'
                  )}
                >
                  {c === 'sms' ? 'SMS' : 'Email'}
                </button>
              );
            })}
          </div>
        </div>
        <p className="mt-3 text-[12px] leading-relaxed text-slateink-500">
          The receipt for a payment goes out on its own, the moment the money is recorded — that is not a rule you can switch off,
          and the invoice screen shows every message that was sent about a bill.
        </p>
      </div>

      <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-5">
        <div className="mb-2 text-[14px] font-medium text-slate-900">Bringing lapsed clients back</div>
        <Toggle
          checked={rules.recall.enabled}
          onChange={(v) => setRules({ ...rules, recall: { ...rules.recall, enabled: v } })}
          label="Recall clients who have not been seen in a while"
          desc="Once a day, and only for people who are past the window that applies to them."
        />
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-slateink-300">Last-resort window (days)</span>
            <input
              type="number"
              min={7}
              className="input w-full"
              value={rules.recall.afterDays}
              onChange={(e) => setRules({ ...rules, recall: { ...rules.recall, afterDays: Number(e.target.value) } })}
            />
            {/* The chain is three deep, and this is the last of it: a service's own
                interval wins, then the practice's. Say so, or the field reads as the
                one that decides. */}
            <span className="mt-1 block text-[11px] text-slateink-400">
              Only used when neither the service nor the practice&apos;s own window is set — Practice → Recall after is the one that normally applies.
            </span>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-slateink-300">Nobody twice inside (days)</span>
            <input
              type="number"
              min={0}
              className="input w-full"
              value={rules.recall.cooldownDays}
              onChange={(e) => setRules({ ...rules, recall: { ...rules.recall, cooldownDays: Number(e.target.value) } })}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-slateink-300">Most a day (0 = no ceiling)</span>
            <input
              type="number"
              min={0}
              className="input w-full"
              value={rules.recall.maxPerDay}
              onChange={(e) => setRules({ ...rules, recall: { ...rules.recall, maxPerDay: Number(e.target.value) } })}
            />
          </label>
        </div>
        <div className="mt-3">
          <span className="mb-1.5 block text-[12px] font-medium text-slateink-300">Channels</span>
          <div className="flex gap-2">
            {(['sms', 'email'] as const).map((c) => {
              const has = rules.recall.channels.includes(c);
              return (
                <button
                  key={c}
                  onClick={() =>
                    setRules({
                      ...rules,
                      recall: { ...rules.recall, channels: has ? rules.recall.channels.filter((x) => x !== c) : [...rules.recall.channels, c] },
                    })
                  }
                  className={cn(
                    'rounded-full border px-3 py-1.5 text-[12px] transition-colors',
                    has ? 'border-brand-500/40 bg-brand-500/15 text-brand-700' : 'border-slate-900/[0.035] text-slateink-400 hover:text-slate-900'
                  )}
                >
                  {c === 'sms' ? 'SMS' : 'Email'}
                </button>
              );
            })}
          </div>
        </div>
        <p className="mt-3 text-[12px] leading-relaxed text-slateink-500">
          That fallback is the oldest of three numbers and the last one used: a service&rsquo;s own interval wins, then the practice
          window set on the <span className="font-mono">Practice</span> screen, then this. Set it per service there — an annual visit and
          a six-month check-up should not be recalled on the same day. Nobody with an appointment already in the diary is ever recalled,
          and the list lives under <span className="font-mono">Reports → Recalls</span>, where it can also be sent by hand.
        </p>
      </div>

      <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-5">
        <div className="mb-2 text-[14px] font-medium text-slate-900">Quiet hours and channels</div>
        <p className="mb-3 text-[12.5px] leading-relaxed text-slateink-400">
          A reminder that comes due at 03:00 waits until the window opens, in the practice&rsquo;s own timezone (
          <span className="font-mono text-slateink-200">{timezone}</span>
          ). These hours hold back what the practice starts by itself — reminders, follow-ups, campaigns. A confirmation
          somebody just asked for goes out when they ask, whatever the hour.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-slateink-300">From</span>
            <select
              className="input w-full"
              value={settings.quietHours.start}
              onChange={(e) => setSettings({ ...settings, quietHours: { ...settings.quietHours, start: Number(e.target.value) } })}
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-slateink-300">Until</span>
            <select
              className="input w-full"
              value={settings.quietHours.end}
              onChange={(e) => setSettings({ ...settings, quietHours: { ...settings.quietHours, end: Number(e.target.value) } })}
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h + 1} value={h + 1}>
                  {hourLabel(h + 1)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-3 space-y-1">
          <Toggle
            checked={settings.channels.sms}
            onChange={(v) => setSettings({ ...settings, channels: { ...settings.channels, sms: v } })}
            label="Texts"
            desc="Refused rather than dropped when off — the queue records why."
          />
          <Toggle
            checked={settings.channels.email}
            onChange={(v) => setSettings({ ...settings, channels: { ...settings.channels, email: v } })}
            label="Email"
          />
        </div>
        <label className="mt-3 block">
          <span className="mb-1.5 block text-[12px] font-medium text-slateink-300">Give up after this many attempts</span>
          <select
            className="input w-full"
            value={settings.maxAttempts}
            onChange={(e) => setSettings({ ...settings, maxAttempts: Number(e.target.value) })}
          >
            {[1, 2, 3, 5].map((n) => (
              <option key={n} value={n}>
                {n} attempt{n > 1 ? 's' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-5 lg:col-span-2">
        <div className="mb-2 text-[14px] font-medium text-slate-900">What happens when somebody replies</div>
        <ul className="space-y-1.5 text-[12.5px] leading-relaxed text-slateink-400">
          <li>
            <span className="font-mono text-slateink-200">STOP</span> (or UNSUBSCRIBE, CANCEL, END, QUIT) withdraws
            texting consent for that person straight away — with the reply itself kept as the evidence — and refuses
            anything already queued for them. <span className="font-mono text-slateink-200">START</span> gives it back.
          </li>
          <li>
            Any other reply is recorded against the person and left alone. Answering questions is a job for the desk, not
            a robot, so nothing is auto-replied.
          </li>
        </ul>
      </div>

      <div className="flex flex-wrap items-center gap-2 lg:col-span-2">
        <Button variant="brand" disabled={saving === 'save-rules'} onClick={() => void save('save-rules')}>
          {saving === 'save-rules' ? 'Saving…' : 'Save rules'}
        </Button>
        <Button variant="ghost" disabled={saving === 'save-settings'} onClick={() => void save('save-settings')}>
          {saving === 'save-settings' ? 'Saving…' : 'Save quiet hours & channels'}
        </Button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- reports */

function ReportsTab() {
  const toast = useToast();
  const [days, setDays] = React.useState(30);
  const [report, setReport] = React.useState<NoShowReport | null>(null);
  const [summary, setSummary] = React.useState<Summary | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [settling, setSettling] = React.useState('');
  const [reload, setReload] = React.useState(0);

  /**
   * Marking attendance writes through the same door the calendar uses, so the
   * history, the access log and the follow-up rules all see it.
   */
  const settle = async (bookingId: string, status: 'completed' | 'no_show', message: string) => {
    setSettling(bookingId);
    try {
      await request('POST', `/api/v1/bookings/${encodeURIComponent(bookingId)}/status`, { status, note: `settled from messaging report` });
      toast(message);
      setReload((n) => n + 1);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not settle that', 'error');
    } finally {
      setSettling('');
    }
  };

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void request<{ report: NoShowReport; summary: Summary }>('GET', `/api/v1/outreach?view=report&days=${days}`)
      .then((res) => {
        if (cancelled) return;
        setReport(res.report);
        setSummary(res.summary);
      })
      .catch((err) => toast(err instanceof ApiError ? err.message : 'Could not load the report', 'error'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [days, toast, reload]);

  const trend = report && report.previousRateLabel ? `${report.noShowRateLabel} (was ${report.previousRateLabel})` : report?.noShowRateLabel ?? '—';

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        {[7, 30, 90, 365].map((d) => (
          <button
            key={d}
            onClick={() => setDays(d)}
            className={cn(
              'rounded-full border px-3 py-1.5 text-[12px] transition-colors',
              days === d ? 'border-slate-900/[0.09] bg-white text-black' : 'border-slate-900/[0.035] text-slateink-400 hover:text-slate-900'
            )}
          >
            {d === 365 ? '12 months' : `${d} days`}
          </button>
        ))}
      </div>

      {loading || !report ? (
        <div className="panel h-48 animate-pulse bg-ink-850/40" />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="No-show rate" value={trend} sub={`${report.noShows} missed of ${report.considered} that could have happened.`} />
            <StatCard label="Attended" value={String(report.attended)} sub={`${report.cancelled} cancelled ahead of time (not counted against anyone).`} />
            <StatCard label="Reminders sent" value={String(report.outreach.remindersSent)} sub={`${report.outreach.confirmationsSent} confirmations · ${report.outreach.followUpsSent} missed-appointment texts`} />
            <StatCard label="Refused or failed" value={String(report.outreach.blocked + report.outreach.failed)} sub="Blocked for consent, or the carrier would not take it." />
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-5">
              <div className="mb-3 text-[14px] font-medium text-slate-900">By practitioner</div>
              {report.byProvider.length === 0 ? (
                <p className="text-[12.5px] text-slateink-500">No settled appointments in this window.</p>
              ) : (
                <div className="space-y-2">
                  {report.byProvider.map((p) => (
                    <div key={p.providerId} className="flex items-center justify-between gap-3 text-[13px]">
                      <span className="min-w-0 truncate text-slateink-200">{p.name}</span>
                      <span className="shrink-0 font-mono text-[11.5px] text-slateink-400">
                        {p.noShows}/{p.booked} · {(p.rate * 100).toFixed(0)}%
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-5">
              <div className="mb-3 text-[14px] font-medium text-slate-900">By service</div>
              {report.byService.length === 0 ? (
                <p className="text-[12.5px] text-slateink-500">No settled appointments in this window.</p>
              ) : (
                <div className="space-y-2">
                  {report.byService.slice(0, 8).map((s) => (
                    <div key={s.serviceId} className="flex items-center justify-between gap-3 text-[13px]">
                      <span className="min-w-0 truncate text-slateink-200">{s.name}</span>
                      <span className="shrink-0 font-mono text-[11.5px] text-slateink-400">
                        {s.noShows}/{s.booked} · {(s.rate * 100).toFixed(0)}%
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-5 lg:col-span-2">
              <div className="mb-3 text-[14px] font-medium text-slate-900">By day of the week</div>
              <div className="grid gap-2 sm:grid-cols-7">
                {report.byWeekday.map((w) => (
                  <div key={w.weekday} className="rounded-xl border border-slate-900/[0.04] bg-ink-900/50 p-3">
                    <div className="text-[11.5px] text-slateink-400">{w.weekday.slice(0, 3)}</div>
                    <div className="mt-1 font-mono text-[15px] text-slate-900">{(w.rate * 100).toFixed(0)}%</div>
                    <div className="font-mono text-[10.5px] text-slateink-500">
                      {w.noShows}/{w.booked}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {report.unsettled.count > 0 && (
            <div className="rounded-2xl border border-amber-500/25 bg-amber-500/[0.05]">
              <div className="border-b border-amber-500/20 px-4 py-3">
                <div className="text-[14px] font-medium text-amber-800">
                  {report.unsettled.count} appointment{report.unsettled.count === 1 ? '' : 's'} nobody settled
                </div>
                <p className="mt-1 text-[12.5px] leading-snug text-amber-800">
                  The rate below only counts appointments that reached a verdict. Marking these attended or missed is what
                  keeps it honest — it takes two clicks, and it is the difference between a report and a guess.
                </p>
              </div>
              <div className="divide-y divide-amber-500/10">
                {report.unsettled.rows.map((u) => (
                  <div key={u.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] text-slate-900">{u.clientName}</div>
                      <div className="font-mono text-[11px] text-amber-800">
                        {fmtDate(u.startsAt)} · {u.providerName} · {u.serviceName} · {u.reference} · {u.status}
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button size="sm" variant="ghost" disabled={settling === u.id} onClick={() => void settle(u.id, 'completed', 'Marked attended.')}>
                        Attended
                      </Button>
                      <Button size="sm" variant="quiet" disabled={settling === u.id} onClick={() => void settle(u.id, 'no_show', 'Marked as missed.')}>
                        Missed
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-900/[0.04] px-4 py-3">
              <div className="text-[14px] font-medium text-slate-900">Settled appointments</div>
              <div className="font-mono text-[11px] text-slateink-500">
                {fmtDate(report.from)} → {fmtDate(report.to)}
              </div>
            </div>
            {report.rows.length === 0 ? (
              <div className="p-4 text-[12.5px] text-slateink-500">
                Nothing settled yet in this window. Mark appointments as completed or missed from the calendar and they appear here.
              </div>
            ) : (
              <DataTable columns={[{ key: 'when', label: 'When' }, { key: 'client', label: 'Client' }, { key: 'provider', label: 'With' }, { key: 'service', label: 'Service' }, { key: 'reference', label: 'Reference' }]}>
                {report.rows.map((r) => (
                  <tr key={r.id} className="border-b border-slate-900/[0.035] last:border-0">
                    <td className="whitespace-nowrap px-4 py-3 text-[12.5px] text-slateink-300">{fmtDate(r.startsAt)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-[13px] text-slate-900">{r.clientName}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-[12.5px] text-slateink-300">{r.providerName}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-[12.5px] text-slateink-300">{r.serviceName}</td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-[11.5px] text-slateink-400">{r.reference}</td>
                  </tr>
                ))}
              </DataTable>
            )}
          </div>

          {summary && (
            <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-5">
              <div className="mb-3 text-[14px] font-medium text-slate-900">
                Outreach in the last {summary.windowDays} days
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-slateink-400">By channel</div>
                  <div className="space-y-1 text-[12.5px] text-slateink-300">
                    {Object.entries(summary.byChannel).map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-3">
                        <span className="capitalize">{k}</span>
                        <span className="font-mono">{v}</span>
                      </div>
                    ))}
                    {summary.total === 0 && <span className="text-slateink-500">Nothing yet.</span>}
                  </div>
                </div>
                <div>
                  <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-slateink-400">By outcome</div>
                  <div className="space-y-1 text-[12.5px] text-slateink-300">
                    {Object.entries(summary.byOutcome).map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-3">
                        <span className="capitalize">{k.replace('_', ' ')}</span>
                        <span className="font-mono">{v}</span>
                      </div>
                    ))}
                    {summary.total === 0 && <span className="text-slateink-500">Nothing yet.</span>}
                  </div>
                </div>
                <div>
                  <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-slateink-400">By job</div>
                  <div className="space-y-1 text-[12.5px] text-slateink-300">
                    {Object.entries(summary.byKind).map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-3">
                        <span>{kindLabel(k)}</span>
                        <span className="font-mono">{v}</span>
                      </div>
                    ))}
                    {summary.total === 0 && <span className="text-slateink-500">Nothing yet.</span>}
                  </div>
                </div>
              </div>
              <div className="mt-4 text-[12.5px] text-slateink-400">
                <span className="font-medium text-slateink-200">{summary.reached}</span> of {summary.total} touches are confirmed as reaching somebody
                (calls answered, texts the carrier reported delivered) ·{' '}
                <span className="text-rose-700">{summary.blocked}</span> refused for consent ·{' '}
                <span className="text-rose-700">{summary.failed}</span> failed.
              </div>
              {summary.recent.length > 0 && (
                <div className="mt-4 divide-y divide-slate-900/[0.03]">
                  {summary.recent.map((r) => (
                    <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[12.5px]">
                      <span className="font-mono text-[11px] text-slateink-500"><Ago at={r.at} /></span>
                      <Pill tone={r.channel === 'call' ? 'default' : r.channel === 'sms' ? 'info' : 'default'}>
                        {r.channel === 'call' ? 'Call' : r.channel === 'sms' ? 'SMS' : 'Email'}
                      </Pill>
                      <span className="text-slateink-300">{kindLabel(r.kind)}</span>
                      <span className="capitalize text-slateink-200">{r.outcome.replace('_', ' ')}</span>
                      <span className="font-mono text-[11px] text-slateink-500">{r.to}</span>
                      {r.detail && <span className="min-w-0 flex-1 truncate text-slateink-500">{r.detail}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- scheduler */

function SchedulerTab() {
  const toast = useToast();
  const [jobs, setJobs] = React.useState<Job[]>([]);
  const [running, setRunning] = React.useState(true);
  const [rulesActive, setRulesActive] = React.useState<string[]>([]);
  const [timezone, setTimezone] = React.useState('UTC');
  const [serverTime, setServerTime] = React.useState('');
  const [busy, setBusy] = React.useState('');
  const [lastTick, setLastTick] = React.useState<string[] | null>(null);

  const load = React.useCallback(async () => {
    try {
      const res = await request<{ jobs: Job[]; running: boolean; rulesActive: string[]; timezone: string; serverTime: string }>(
        'GET',
        '/api/v1/scheduler'
      );
      setJobs(res.jobs ?? []);
      setRunning(res.running);
      setRulesActive(res.rulesActive ?? []);
      setTimezone(res.timezone);
      setServerTime(res.serverTime);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load the scheduler', 'error');
    }
  }, [toast]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const run = async (job?: string) => {
    setBusy(job ?? 'tick');
    try {
      if (job) {
        const res = await request<{ run: { ok: boolean; detail: string } }>('POST', '/api/v1/scheduler', { action: 'run', job, force: true });
        toast(`${job}: ${res.run.detail}`, res.run.ok ? undefined : 'error');
        setLastTick(null);
      } else {
        const res = await request<{ ran: number; summary: string[] }>('POST', '/api/v1/scheduler', { action: 'tick' });
        setLastTick(res.summary.length ? res.summary : ['Nothing was due.']);
        toast(res.ran ? `Ran ${res.ran} job(s).` : 'Nothing was due.');
      }
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'That did not work', 'error');
    } finally {
      setBusy('');
    }
  };

  const toggle = async (job: Job) => {
    setBusy(job.name);
    try {
      await request('POST', '/api/v1/scheduler', { action: 'toggle', job: job.name, enabled: !job.enabled });
      toast(job.enabled ? `${job.label} paused.` : `${job.label} will run again.`);
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not change that', 'error');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="space-y-5">
      {!running && (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/[0.06] p-4 text-[13px] text-amber-800">
          The in-process timer is switched off for this deployment (VOXERA_SCHEDULER=0). Point a cron at{' '}
          <span className="font-mono">POST /api/v1/scheduler</span> and the jobs below still run — they are idempotent.
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-4">
        <div className="text-[13px] text-slateink-300">
          <span className="font-medium text-slate-900">{jobs.filter((j) => j.enabled).length}</span> of {jobs.length} jobs enabled ·{' '}
          <span className="text-slateink-400">{rulesActive.length ? `rules active: ${rulesActive.join(', ')}` : 'no rules active'}</span>
          <div className="mt-1 font-mono text-[11px] text-slateink-500">
            server {serverTime ? fmtDate(serverTime) : '—'} · practice timezone {timezone}
          </div>
        </div>
        <Button variant="brand" size="sm" disabled={busy === 'tick'} onClick={() => void run()}>
          {busy === 'tick' ? 'Ticking…' : 'Run everything due'}
        </Button>
      </div>

      {lastTick && (
        <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-900/50 p-4 font-mono text-[11.5px] leading-relaxed text-slateink-300">
          {lastTick.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-slate-900/[0.045] bg-ink-850/40">
        {jobs.map((job) => (
          <div key={job.name} className="flex flex-wrap items-start gap-4 border-b border-slate-900/[0.035] px-4 py-4 last:border-0">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13.5px] font-medium text-slate-900">{job.label}</span>
                <Pill tone={job.enabled ? 'brand' : 'default'}>{job.enabled ? 'on' : 'paused'}</Pill>
                {job.global && <Pill tone="default">file-wide</Pill>}
                <span className="font-mono text-[10.5px] text-slateink-500">
                  every {job.everyMinutes < 60 ? `${job.everyMinutes} min` : `${job.everyMinutes / 60}h`}
                </span>
                {job.dueNow && job.enabled && <span className="font-mono text-[10.5px] text-amber-800">due now</span>}
              </div>
              <p className="mt-1 text-[12.5px] leading-snug text-slateink-400">{job.description}</p>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-slateink-500">
                <span>{job.runs} run{job.runs === 1 ? '' : 's'}{job.failures ? ` · ${job.failures} failure${job.failures === 1 ? '' : 's'}` : ''}</span>
                <span>last: {job.lastRunAt ? <Ago at={job.lastRunAt} /> : 'never'}</span>
                <span>next: <Ago at={job.nextRunAt} /></span>
              </div>
              {job.lastResult && (
                <div className={cn('mt-1 text-[12px]', job.lastResult.ok ? 'text-slateink-300' : 'text-rose-700')}>
                  {job.lastResult.ok ? '✓' : '✗'} {job.lastResult.detail}
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button size="sm" variant="ghost" disabled={busy === job.name} onClick={() => void run(job.name)} title="Runs whether or not it is due, and even while paused.">
                Run now
              </Button>
              <Button size="sm" variant="quiet" disabled={busy === job.name} onClick={() => void toggle(job)}>
                {job.enabled ? 'Pause' : 'Resume'}
              </Button>
            </div>
          </div>
        ))}
      </div>

      <p className="text-[12.5px] leading-relaxed text-slateink-500">
        Every job is idempotent: running one twice queues nothing extra. That is what makes it safe to point a cron at the
        tick endpoint as well as leaving the timer on.
      </p>
    </div>
  );
}
