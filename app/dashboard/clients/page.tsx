'use client';

/**
 * Clients — the records the practice keeps.
 *
 * Server-first, deliberately. This screen holds no copy of the data in the
 * browser: everything is read from `/api/v1/clients` on load and every change
 * goes straight back. The rest of the dashboard may keep a cache for speed; a
 * client list, with medical flags and consent states on it, does not get to live
 * in browser storage (see `lib/privacy.ts` and PRACTICE.md §5 for why).
 *
 * The record view is the part that has to be right: identity, alerts, consents,
 * the appointment history (including cancellations), the calls that touched it,
 * and — because a records system is not one without it — who has opened it.
 * Looking at a record is itself logged, which is why the history is not empty
 * the first time you read it.
 */

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ApiError, request } from '@/lib/server-sync';
import { cn, fmtDate, pinnedNow } from '@/lib/utils';
import { Ago } from '@/components/dash/Ago';
import { Icons } from '@/components/icons';
import { Button, EmptyState, Modal, Pill, Tabs, useToast } from '@/components/ui';
import { DataTable, StatCard } from '@/components/dash/bits';
import { PageHeader } from '@/components/dash/Shell';
import type { Terms } from '@/lib/terms';

/* ------------------------------------------------------------------- types */

type Alert = { id: string; classification?: 'administrative' | 'clinical'; label: string; detail?: string; severity: 'info' | 'warning' | 'critical'; createdAt: string };
type ContactPoint = { id: string; kind: 'phone' | 'email'; label: string; value: string; primary: boolean; verified: boolean; shared?: boolean; createdAt: string };
type Consent = { granted: boolean; source?: string; at?: string; note?: string };

type Client = {
  id: string;
  name: string;
  firstName?: string;
  lastName?: string;
  number: string;
  email?: string;
  dateOfBirth?: string;
  address?: string;
  tags: string[];
  alerts: Alert[];
  consents: Record<'sms' | 'email' | 'recording', Consent>;
  note?: string;
  source?: string;
  status?: 'new' | 'regular' | 'at-risk' | 'lapsed' | 'active';
  appointmentCount?: number;
  lastAppointmentAt?: string;
  lastInteractionAt?: string;
  archivedAt?: string;
  retentionUntil?: string;
  createdAt: string;
  upcoming?: { id: string; startsAt: string; service: string; providerName?: string; status: string };
};

type Appointment = {
  id: string;
  startsAt: string;
  durationMinutes: number;
  service: string;
  serviceName?: string;
  status: string;
  providerName?: string;
  value?: number;
  seriesId?: string;
  caseId?: string;
  fundingAllocation?: { state: 'committed' | 'used'; appointments: number; minutes: number; budgetMinor: number; currency: 'GBP' };
  fundingWarning?: string;
};

type CallRef = { id: string; assistantName?: string; startedAt?: string; endedReason?: string; summary?: string };
type NoteRow = {
  id: string;
  bookingId?: string;
  title: string;
  status: 'draft' | 'final' | 'archived';
  version: number;
  revision: number;
  templateId?: string;
  templateVersionId?: string;
  templateVersion?: number;
  signedHash?: string;
  lastFinalisedVersion?: number;
  draftedBy: 'agent' | 'staff' | 'seed';
  authorName?: string;
  signerName?: string;
  signedAt?: string;
  amendedAt?: string;
  archivedAt?: string;
  retentionUntil?: string;
  templateName?: string;
  incomplete?: string[];
  /** The call this was written up from, when it came off one. */
  sourceCallId?: string;
  restricted?: boolean;
  createdAt: string;
  updatedAt: string;
};
type NoteSection = { id: string; label: string; body: string; kind?: 'short_text' | 'long_text' | 'number' | 'choice' | 'body_chart'; required?: boolean; hint?: string };
type NoteFull = NoteRow & {
  body: string;
  sections: NoteSection[];
  attachments?: { id: string; name: string; bytes: number; at: string; by: string }[];
};
type NoteTemplate = { id: string; name: string; serviceId?: string | null; serviceName?: string | null; sections: { id: string; label: string; prompt?: string; required?: boolean; kind?: NoteSection['kind'] }[] };
type BodyChartMark =
  | { id: string; type: 'point'; x: number; y: number; color: string; size: number }
  | { id: string; type: 'stroke'; points: { x: number; y: number }[]; color: string; width: number }
  | { id: string; type: 'label'; x: number; y: number; text: string; color: string };
type BodyChartTemplate = { id: string; title: string; state: 'draft' | 'published' | 'retired'; sourceMimeType: string };
type BodyChartAnnotation = {
  id: string; sectionId?: string; templateId: string; marks: BodyChartMark[]; status: 'draft' | 'final';
  noteVersion: number; revision: number; authorName?: string; lastEditedByName?: string; finalisedAt?: string; lastSnapshotHash?: string;
};
type BodyChartConflict = { id: string; annotationId: string; expectedRevision: number; marks: BodyChartMark[]; actorName?: string; occurredAt: string };
type BodyChartVersion = { id: string; annotationId: string; noteVersion: number; signedAt: string; signedByName?: string; contentHash: string; integrity: 'verified' | 'failed' };
type AccessEntry = { id: string; action: string; actor: string; actorName?: string; detail?: string; createdAt: string };
type ClientCase = { id: string; name: string; number: string; status: string; trackingMode: 'appointments' | 'hours' | 'budget'; startsOn: string; endsOn?: string; limitPolicy: string; enforcementMode: string };
type CoverageView = { id: string; payerId: string; holderRelationship: string; startsOn: string; endsOn?: string; verificationStatus: string; membershipMasked?: string; policyMasked?: string };
type CarePlanGoal = { id: string; goal: string; actions: string[]; status: string; reviewOn?: string; revision: number };
type CarePlan = { id: string; caseId?: string; title: string; status: string; reviewOn?: string; revision: number; goals: CarePlanGoal[] };

type Detail = Client & { appointments: Appointment[]; calls: CallRef[]; access: AccessEntry[]; notes: NoteRow[]; notesRestricted?: boolean; clinicalAlertsRestricted?: boolean; contactPoints?: ContactPoint[] };

const STATUS_TONE: Record<string, 'brand' | 'warn' | 'danger' | 'info' | 'default'> = {
  new: 'info',
  regular: 'brand',
  active: 'default',
  'at-risk': 'warn',
  lapsed: 'danger',
};

/* -------------------------------------------------------------------- page */

export default function ClientsPage() {
  const toast = useToast();
  const router = useRouter();
  const [query, setQuery] = React.useState('');
  const [tagFilter, setTagFilter] = React.useState('');
  const [alertsOnly, setAlertsOnly] = React.useState(false);
  const [includeArchived, setIncludeArchived] = React.useState(false);
  const [rows, setRows] = React.useState<Client[]>([]);
  const [stats, setStats] = React.useState<Record<string, number>>({});
  const [terms, setTerms] = React.useState<Terms | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<Detail | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [importing, setImporting] = React.useState(false);

  /**
   * Leaving with the list.
   *
   * Straight from the API as a file download rather than a copy of the rows on
   * screen: the export is the records, not this view of them, so a filter left
   * on the page cannot quietly shorten what a bookkeeper receives.
   */
  async function exportCsv() {
    try {
      const res = await fetch('/api/v1/clients?view=export', { credentials: 'include' });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = res.headers.get('content-disposition')?.match(/filename="(.+)"/)?.[1] ?? 'clients.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast(`${res.headers.get('x-client-rows') ?? ''} ${table.client.many} exported`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Export failed', 'error');
    }
  }

  const load = React.useCallback(async () => {
    try {
      const params = new URLSearchParams({ includeUpcoming: 'true' });
      if (query.trim()) params.set('q', query.trim());
      if (tagFilter) params.set('tag', tagFilter);
      if (alertsOnly) params.set('alertsOnly', 'true');
      if (includeArchived) params.set('includeArchived', 'true');
      const body = await request<{ data: Client[]; stats: Record<string, number>; terms: Terms }>('GET', `/api/v1/clients?${params.toString()}`);
      setRows(body.data);
      setStats(body.stats ?? {});
      setTerms(body.terms ?? null);
      setLoading(false);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load clients', 'error');
      setLoading(false);
    }
  }, [query, tagFilter, alertsOnly, includeArchived, toast]);

  React.useEffect(() => {
    const timer = setTimeout(() => void load(), query ? 200 : 0);
    return () => clearTimeout(timer);
  }, [load, query]);

  // A link from the calendar can open a record directly.
  React.useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get('client');
    if (wanted) setOpenId(wanted);
  }, []);

  React.useEffect(() => {
    if (!openId) {
      setDetail(null);
      return;
    }
    void request<Detail>('GET', `/api/v1/clients/${openId}`)
      .then(setDetail)
      .catch((err) => toast(err instanceof ApiError ? err.message : 'Could not open the record', 'error'));
  }, [openId, toast]);

  const table = terms ?? {
    client: { one: 'client', many: 'clients', One: 'Client', Many: 'Clients' },
    provider: { one: 'team member', many: 'team members', One: 'Team member', Many: 'Team members' },
    service: { one: 'service', many: 'services', One: 'Service', Many: 'Services' },
    appointment: { one: 'appointment', many: 'appointments', One: 'Appointment', Many: 'Appointments' },
    note: { one: 'note', many: 'notes', One: 'Note', Many: 'Notes' },
    location: { one: 'location', many: 'locations', One: 'Location', Many: 'Locations' },
  };

  const allTags = React.useMemo(() => [...new Set(rows.flatMap((r) => r.tags ?? []))].sort(), [rows]);

  return (
    <>
      <PageHeader
        title={table.client.Many}
        desc={`Every ${table.client.one} the practice knows, with their history, alerts and consent — read from the server on every visit, never cached in this browser.`}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="quiet" size="sm" onClick={() => void exportCsv()}>
              Export CSV
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setImporting(true)}>
              Import a list
            </Button>
            <Button variant="brand" size="sm" onClick={() => setCreating(true)}>
              <Icons.plus size={14} /> New {table.client.one}
            </Button>
          </div>
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label={table.client.Many} value={String(stats.total ?? rows.length)} />
        <StatCard label="New (30 days)" value={String(stats.newThisMonth ?? 0)} />
        <StatCard label="Seen twice or more" value={String(stats.regulars ?? 0)} />
        <StatCard label="With alerts" value={String(stats.withAlerts ?? 0)} />
        <StatCard label="Opted out of SMS" value={String(stats.optedOut ?? 0)} />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[240px] flex-1">
          <Icons.search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slateink-500" />
          <input
            className="field h-9 w-full pl-9 text-[12.5px]"
            placeholder="Search a name, number, email or tag"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search clients"
          />
        </div>
        {allTags.length > 0 && (
          <select className="field h-9 w-[160px] py-1 text-[12.5px]" value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} aria-label="Filter by tag">
            <option value="">Any tag</option>
            {allTags.map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </select>
        )}
        <Button variant={alertsOnly ? 'brand' : 'ghost'} size="sm" onClick={() => setAlertsOnly((v) => !v)}>
          <Icons.alert size={14} /> Alerts only
        </Button>
        <Button variant={includeArchived ? 'brand' : 'ghost'} size="sm" onClick={() => setIncludeArchived((v) => !v)}>
          Archived
        </Button>
      </div>

      {loading && rows.length === 0 ? (
        <div className="panel h-64 animate-pulse bg-ink-850/40" />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="users"
          title={`No ${table.client.many} match`}
          desc={query ? 'Try a different name, number or tag.' : `Add someone, or let a call create the record for you.`}
          action={
            <Button variant="brand" size="sm" onClick={() => setCreating(true)}>
              New {table.client.one}
            </Button>
          }
        />
      ) : (
        <DataTable
          columns={[
            { key: 'name', label: table.client.One },
            { key: 'flags', label: 'Flags' },
            { key: 'contact', label: 'Contact' },
            { key: 'history', label: 'History' },
            { key: 'next', label: 'Next' },
            { key: 'act', label: '', align: 'right' },
          ]}
        >
          {rows.map((client) => (
            <tr key={client.id} className={cn('cursor-pointer hover:bg-slate-900/[0.02]', client.archivedAt && 'opacity-60')} onClick={() => router.push(`/dashboard/clients/${encodeURIComponent(client.id)}`)}>
              <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <Link href={`/dashboard/clients/${encodeURIComponent(client.id)}`} onClick={(event) => event.stopPropagation()} className="text-[13px] text-slate-900 hover:text-brand-700 hover:underline">{client.name}</Link>
                  {client.status && <Pill tone={STATUS_TONE[client.status] ?? 'default'}>{client.status}</Pill>}
                  {client.archivedAt && <Pill tone="danger">archived</Pill>}
                </div>
                {(client.tags ?? []).length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {client.tags.slice(0, 4).map((tag) => (
                      <span key={tag} className="rounded border border-slate-900/[0.035] px-1.5 py-0.5 text-[10.5px] text-slateink-400">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </td>
              <td className="px-4 py-3">
                <div className="flex flex-wrap gap-1.5">
                  {client.alerts.map((alert) => (
                    <span
                      key={alert.id}
                      className={cn(
                        'rounded px-1.5 py-0.5 text-[10.5px]',
                        alert.severity === 'critical' ? 'bg-rose-500/15 text-rose-700' : alert.severity === 'warning' ? 'bg-amber-400/15 text-amber-800' : 'bg-sky-400/15 text-sky-900'
                      )}
                    >
                      {alert.label}
                    </span>
                  ))}
                  {client.alerts.length === 0 && <span className="text-[11.5px] text-slateink-500">—</span>}
                  {client.consents?.sms && !client.consents.sms.granted && <span className="rounded bg-slate-900/[0.06] px-1.5 py-0.5 text-[10.5px] text-slateink-300">no SMS</span>}
                </div>
              </td>
              <td className="px-4 py-3 font-mono text-[11.5px] text-slateink-300">
                {client.number}
                {client.email && <div className="text-slateink-500">{client.email}</div>}
              </td>
              <td className="px-4 py-3 text-[12px] text-slateink-300">
                {client.appointmentCount ?? 0} {table.appointment.many}
                {client.lastInteractionAt && <div className="text-[11.5px] text-slateink-500">last contact <Ago at={client.lastInteractionAt} /></div>}
              </td>
              <td className="px-4 py-3 text-[12px] text-slateink-300">
                {client.upcoming ? (
                  <span>
                    {fmtDate(client.upcoming.startsAt)} <span className="text-slateink-500">{client.upcoming.service}</span>
                  </span>
                ) : (
                  <span className="text-slateink-500">nothing booked</span>
                )}
              </td>
              <td className="px-4 py-3 text-right">
                <Link href={`/dashboard/clients/${encodeURIComponent(client.id)}`} className="btn-quiet btn-sm" onClick={(event) => event.stopPropagation()}>
                  Open
                </Link>
              </td>
            </tr>
          ))}
        </DataTable>
      )}

      {detail && (
        <ClientRecord
          detail={detail}
          terms={table}
          onClose={() => {
            setOpenId(null);
            void load();
          }}
          onChanged={() => {
            void request<Detail>('GET', `/api/v1/clients/${detail.id}`).then(setDetail).catch(() => undefined);
            void load();
          }}
        />
      )}

      <NewClientModal
        open={creating}
        onClose={() => setCreating(false)}
        term={table.client.one}
        onCreated={(id) => {
          setCreating(false);
          void load();
          router.push(`/dashboard/clients/${encodeURIComponent(id)}`);
        }}
      />

      <ImportClientsModal
        open={importing}
        onClose={() => setImporting(false)}
        term={table.client}
        onImported={() => {
          setImporting(false);
          void load();
        }}
      />
    </>
  );
}

/**
 * Bringing a client list in from somewhere else.
 *
 * The first pass is always a dry run, and it is not a formality: it says how
 * many rows would be added, how many are already here (matched on the phone
 * number, normalised), and which lines could not be read — by line number, so
 * the problem can be fixed in the file rather than guessed at.
 */
function ImportClientsModal({
  open,
  onClose,
  term,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  term: { one: string; many: string };
  onImported: () => void;
}) {
  const toast = useToast();
  const [csv, setCsv] = React.useState('');
  const [report, setReport] = React.useState<
    | null
    | {
        dryRun: boolean;
        total: number;
        added: number;
        existing: number;
        invalid: { line: number; reason: string }[];
        recognised: string[];
        ignoredColumns: string[];
        preview: { line: number; name: string; number: string; action: string }[];
      }
  >(null);
  const [busy, setBusy] = React.useState(false);

  async function check(dryRun: boolean) {
    if (!csv.trim()) {
      toast('Paste the file contents first.', 'error');
      return;
    }
    setBusy(true);
    try {
      const body = await request<{ report: typeof report }>('POST', '/api/v1/clients', { action: 'import', csv, dryRun });
      setReport(body.report);
      if (!dryRun) {
        toast(`${body.report?.added ?? 0} ${term.many} imported`, 'success');
        setCsv('');
        onImported();
      }
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not read that file', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Import ${term.many}`}
      width="640px"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button variant="quiet" size="sm" disabled={busy} onClick={() => void check(true)}>
            {busy ? 'Reading…' : 'Check the file'}
          </Button>
          <Button variant="brand" size="sm" disabled={busy || !report || report.added === 0} onClick={() => void check(false)}>
            Import {report?.added ?? 0} {term.many}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-[12.5px] text-slateink-300">
          A CSV with a name column and a phone column. Other headings it understands: email, date of birth, address, tags, notes. The phone number is how it
          tells two people apart, so nothing is imported twice — the check pass shows you exactly what it would do before it does anything.
        </p>
        <textarea
          rows={7}
          className="field font-mono text-[12px]"
          placeholder={'Name,Phone,Email\nAlex Morgan,+14155550123,alex@example.com'}
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
        />
        {report && (
          <div className="rounded-xl border border-slate-900/[0.035] bg-ink-900/50 p-3">
            <div className="mb-2 flex flex-wrap gap-3 text-[12px]">
              <span className="text-brand-700">{report.added} to add</span>
              <span className="text-slateink-300">{report.existing} already here</span>
              {report.invalid.length > 0 && <span className="text-rose-700">{report.invalid.length} skipped</span>}
              <span className="text-slateink-500">
                columns: {report.recognised.join(', ') || 'none'}
                {report.ignoredColumns.length ? ` · ignored: ${report.ignoredColumns.join(', ')}` : ''}
              </span>
            </div>
            {report.preview.length > 0 && (
              <div className="max-h-40 overflow-auto">
                <table className="w-full text-left text-[11.5px]">
                  <tbody>
                    {report.preview.map((row) => (
                      <tr key={row.line} className="border-b border-slate-900/[0.035] last:border-0">
                        <td className="py-1 pr-3 font-mono text-slateink-500">line {row.line}</td>
                        <td className="py-1 pr-3 text-slate-900">{row.name}</td>
                        <td className="py-1 pr-3 font-mono text-slateink-400">{row.number}</td>
                        <td className="py-1 text-slateink-300">{row.action === 'add' ? 'add' : 'already here'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {report.invalid.map((row) => (
              <p key={`${row.line}-${row.reason}`} className="mt-1 text-[11.5px] text-rose-700">
                line {row.line}: {row.reason}
              </p>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------- record view */

function ClientRecord({
  detail,
  terms,
  onClose,
  onChanged,
}: {
  detail: Detail;
  terms: Terms;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [tab, setTab] = React.useState('record');
  const [alertForm, setAlertForm] = React.useState({ label: '', detail: '', severity: 'warning', classification: 'clinical' });
  const [contactForm, setContactForm] = React.useState({ kind: 'phone', label: 'mobile', value: '' });
  const [noteDraft, setNoteDraft] = React.useState(detail.note ?? '');
  const [busy, setBusy] = React.useState(false);

  const cutoff = pinnedNow();
  const upcoming = detail.appointments.filter((a) => a.status !== 'cancelled' && new Date(a.startsAt).getTime() > cutoff);
  const past = detail.appointments.filter((a) => new Date(a.startsAt).getTime() <= cutoff || a.status === 'cancelled');

  async function call(method: string, path: string, body?: unknown, message?: string, headers?: Record<string, string>) {
    setBusy(true);
    try {
      await request(method, path, body, { headers });
      if (message) toast(message);
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'That did not save', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-3xl"
      title={detail.name}
      desc={`${detail.number}${detail.email ? ` · ${detail.email}` : ''} · ${detail.appointments.length} ${terms.appointment.many}${detail.archivedAt ? ' · archived' : ''}`}
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <Pill tone={detail.archivedAt ? 'danger' : 'brand'}>{detail.archivedAt ? 'archived' : 'active'}</Pill>
            {detail.lastInteractionAt && <span className="text-[11.5px] text-slateink-400">last contact <Ago at={detail.lastInteractionAt} /></span>}
          </span>
          <span className="flex gap-2">
            {detail.archivedAt ? (
              <Button variant="brand" size="sm" disabled={busy} onClick={() => void call('PATCH', `/api/v1/clients/${detail.id}`, { restore: true }, 'Record restored.')}>
                Restore
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  const reason = window.prompt('Why is this record being archived? (kept in the history)');
                  if (reason === null) return;
                  void call('DELETE', `/api/v1/clients/${detail.id}`, { reason }, 'Archived. History is preserved; automatic purge runs only when an operator retention policy is configured.');
                }}
              >
                Archive
              </Button>
            )}
          </span>
        </div>
      }
    >
      <Tabs
        className="mb-4"
        size="sm"
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'record', label: 'Record' },
          { id: 'notes', label: terms.note.Many, badge: String((detail.notes ?? []).length) },
          { id: 'cases', label: 'Cases' },
          { id: 'care-plan', label: 'Care plan' },
          { id: 'history', label: 'History', badge: String(detail.appointments.length) },
          { id: 'calls', label: 'Calls', badge: String(detail.calls.length) },
          { id: 'access', label: 'Access log', badge: String(detail.access.length) },
        ]}
      />

      {tab === 'record' && (
        <div className="space-y-5">
          {detail.clinicalAlertsRestricted ? (
            <div className="rounded-xl border border-slate-900/[0.05] bg-slate-900/[0.025] px-3.5 py-3 text-[11.5px] text-slateink-500">
              Clinical alerts are restricted for this role. Administrative alerts remain visible; alert content is never sent to the phone assistant.
            </div>
          ) : null}
          {detail.alerts.length > 0 && (
            <div className="space-y-2">
              {detail.alerts.map((alert) => (
                <div
                  key={alert.id}
                  className={cn(
                    'flex items-start gap-3 rounded-xl border p-3',
                    alert.severity === 'critical' ? 'border-rose-500/30 bg-rose-500/[0.07]' : alert.severity === 'warning' ? 'border-amber-500/30 bg-amber-500/[0.06]' : 'border-sky-500/25 bg-sky-500/[0.05]'
                  )}
                >
                  <Icons.alert size={15} className="mt-0.5 shrink-0 text-current opacity-80" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-[13px] text-slate-900">
                      {alert.label}
                      <span className="rounded-md bg-slate-900/[0.05] px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-wide text-slateink-500">{alert.classification ?? 'clinical'}</span>
                    </div>
                    {alert.detail && <div className="text-[12px] text-slateink-300">{alert.detail}</div>}
                    <div className="mt-0.5 font-mono text-[10.5px] uppercase tracking-[0.12em] text-slateink-500">
                      {alert.severity} · added <Ago at={alert.createdAt} />
                    </div>
                  </div>
                  <button
                    className="text-slateink-400 hover:text-rose-700"
                    aria-label={`Remove ${alert.label}`}
                    disabled={busy}
                    onClick={() => void call('DELETE', `/api/v1/clients/${detail.id}/alerts?alertId=${alert.id}`, undefined, 'Alert removed.', alert.classification !== 'administrative' ? { 'x-voxera-synthetic-data': '1' } : undefined)}
                  >
                    <Icons.close size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-slate-900/[0.04] bg-ink-900/40 p-4">
              <h4 className="h4 mb-3">Details</h4>
              <dl className="space-y-2 text-[12.5px]">
                {([
                  ['Date of birth', detail.dateOfBirth ? fmtDate(detail.dateOfBirth) : '—'],
                  ['Address', detail.address ?? '—'],
                  ['How they arrived', detail.source ?? '—'],
                  ['First seen', fmtDate(detail.createdAt)],
                  ['Appointments', String(detail.appointmentCount ?? detail.appointments.length)],
                  ['Last contact', detail.lastInteractionAt ? <Ago at={detail.lastInteractionAt} /> : '—'],
                ] as [string, React.ReactNode][]).map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-3">
                    <dt className="text-slateink-400">{label}</dt>
                    <dd className="text-right text-slate-900">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>

            <div className="rounded-xl border border-slate-900/[0.04] bg-ink-900/40 p-4">
              <h4 className="h4 mb-3">Consent</h4>
              <div className="space-y-2">
                {(['sms', 'email', 'recording'] as const).map((channel) => {
                  const state = detail.consents?.[channel];
                  return (
                    <div key={channel} className="flex items-center justify-between gap-3 text-[12.5px]">
                      <div>
                        <div className="text-slate-900">{channel === 'recording' ? 'Call recording' : channel.toUpperCase()}</div>
                        <div className="text-[11.5px] text-slateink-500">
                          {state?.granted ? `granted · ${state.source ?? 'unknown source'}` : state?.note ?? 'not granted'}
                        </div>
                      </div>
                      <Button
                        variant={state?.granted ? 'ghost' : 'brand'}
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void call(
                            'POST',
                            `/api/v1/clients/${detail.id}/consents`,
                            { channel, granted: !state?.granted, source: 'staff' },
                            `${channel.toUpperCase()} ${state?.granted ? 'withdrawn' : 'granted'}.`
                          )
                        }
                      >
                        {state?.granted ? 'Withdraw' : 'Grant'}
                      </Button>
                    </div>
                  );
                })}
              </div>
              <p className="mt-3 text-[11.5px] text-slateink-500">
                Withdrawal is enforced, not recorded and ignored: the AI will not text a client who has said no, and it says so out loud instead of pretending.
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-slate-900/[0.04] bg-ink-900/40 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="h4">Contact points</h4>
              <span className="text-[10.5px] text-slateink-400">Exact matches only · no fuzzy merge</span>
            </div>
            <div className="mt-3 space-y-2">
              {(detail.contactPoints ?? []).map((point) => (
                <div key={point.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-900/[0.04] px-3 py-2 text-[12px]">
                  <span className="font-mono text-[9px] uppercase tracking-wide text-slateink-400">{point.label} {point.kind}</span>
                  <span className="min-w-0 flex-1 break-all text-slate-900">{point.value}</span>
                  {point.primary ? <Pill tone="brand">primary</Pill> : null}
                  {point.verified ? <Pill tone="info">verified</Pill> : null}
                  {point.shared ? <Pill tone="warn">shared</Pill> : null}
                </div>
              ))}
              {(detail.contactPoints ?? []).length === 0 ? <p className="text-[11.5px] text-slateink-400">No migrated contact points.</p> : null}
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-[100px_110px_1fr_auto]">
              <select className="field text-[12px]" value={contactForm.kind} onChange={(e) => setContactForm({ ...contactForm, kind: e.target.value })} aria-label="Contact type"><option value="phone">phone</option><option value="email">email</option></select>
              <select className="field text-[12px]" value={contactForm.label} onChange={(e) => setContactForm({ ...contactForm, label: e.target.value })} aria-label="Contact label"><option value="mobile">mobile</option><option value="home">home</option><option value="work">work</option><option value="guardian">guardian</option><option value="other">other</option></select>
              <input className="field text-[12px]" placeholder="New phone or email" value={contactForm.value} onChange={(e) => setContactForm({ ...contactForm, value: e.target.value })} />
              <Button variant="ghost" size="sm" disabled={busy || !contactForm.value.trim()} onClick={() => void call('POST', `/api/v1/clients/${detail.id}/contacts`, { ...contactForm, primary: true }, 'Contact point added.', { 'x-voxera-synthetic-data': '1' }).then(() => setContactForm({ kind: 'phone', label: 'mobile', value: '' }))}>Add</Button>
            </div>
          </div>

          <div>
            <div className="label">Administrative note</div>
            <textarea
              className="field text-[13px]"
              rows={3}
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="Preferences, access needs, anything the desk should know before they arrive."
            />
            <div className="mt-2 flex justify-end">
              <Button variant="brand" size="sm" disabled={busy || noteDraft === (detail.note ?? '')} onClick={() => void call('PATCH', `/api/v1/clients/${detail.id}`, { note: noteDraft }, 'Note saved.')}>
                Save note
              </Button>
            </div>
          </div>

          <div className="rounded-xl border border-dashed border-slate-900/[0.04] p-4">
            <h4 className="h4 mb-3">Add an alert</h4>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[130px_1fr_1fr_120px_auto]">
              <select className="field text-[13px]" value={alertForm.classification} onChange={(e) => setAlertForm({ ...alertForm, classification: e.target.value })} aria-label="Alert classification"><option value="clinical">clinical</option><option value="administrative">administrative</option></select>
              <input className="field text-[13px]" placeholder={alertForm.classification === 'clinical' ? 'Anticoagulant therapy' : 'Interpreter required'} value={alertForm.label} onChange={(e) => setAlertForm({ ...alertForm, label: e.target.value })} aria-label="Alert label" />
              <input className="field text-[13px]" placeholder="Detail (optional)" value={alertForm.detail} onChange={(e) => setAlertForm({ ...alertForm, detail: e.target.value })} aria-label="Alert detail" />
              <select className="field text-[13px]" value={alertForm.severity} onChange={(e) => setAlertForm({ ...alertForm, severity: e.target.value })} aria-label="Alert severity">
                <option value="info">info</option>
                <option value="warning">warning</option>
                <option value="critical">critical</option>
              </select>
              <Button
                variant="brand"
                size="sm"
                disabled={busy || !alertForm.label.trim()}
                onClick={() =>
                  void call('POST', `/api/v1/clients/${detail.id}/alerts`, alertForm, 'Alert added — it now shows on authorised staff views.', alertForm.classification === 'clinical' ? { 'x-voxera-synthetic-data': '1' } : undefined).then(() =>
                    setAlertForm({ label: '', detail: '', severity: 'warning', classification: 'clinical' })
                  )
                }
              >
                Add
              </Button>
            </div>
          </div>
        </div>
      )}

      {tab === 'notes' && (
        <NotesTab detail={detail} terms={terms} onChanged={onChanged} onBusy={setBusy} busy={busy} />
      )}

      {tab === 'cases' && <ClientCasesTab detail={detail} />}

      {tab === 'care-plan' && <CarePlanTab detail={detail} />}

      {tab === 'history' && (
        <div className="space-y-4">
          <ClientPacks clientId={detail.id} />
          <section>
            <h4 className="h4 mb-2">Coming up</h4>
            {upcoming.length === 0 ? (
              <p className="text-[12.5px] text-slateink-500">Nothing booked.</p>
            ) : (
              <ul className="space-y-2">
                {upcoming.map((appointment) => (
                  <AppointmentRow key={appointment.id} appointment={appointment} terms={terms} />
                ))}
              </ul>
            )}
          </section>
          <section>
            <h4 className="h4 mb-2">Past</h4>
            {past.length === 0 ? (
              <p className="text-[12.5px] text-slateink-500">No history yet.</p>
            ) : (
              <ul className="space-y-2">
                {past.map((appointment) => (
                  <AppointmentRow key={appointment.id} appointment={appointment} terms={terms} past />
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {tab === 'calls' && (
        <div className="space-y-2">
          {detail.calls.length === 0 ? (
            <p className="text-[12.5px] text-slateink-500">No calls yet. A call about an appointment shows up here.</p>
          ) : (
            detail.calls.map((call) => (
              <a key={call.id} href={`/dashboard/calls?call=${call.id}`} className="block rounded-xl border border-slate-900/[0.04] bg-ink-900/40 p-3 hover:border-slate-900/[0.09]">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[12.5px] text-slate-900">{call.assistantName ?? 'Call'}</span>
                  <span className="font-mono text-[11px] text-slateink-400">{call.startedAt ? fmtDate(call.startedAt) : ''}</span>
                </div>
                {call.summary && <p className="mt-1 text-[12px] text-slateink-300">{call.summary}</p>}
              </a>
            ))
          )}
        </div>
      )}

      {tab === 'access' && (
        <>
          <p className="mb-3 text-[12.5px] text-slateink-400">
            Every read and write against this record. Reads are logged on purpose — "who has seen this" is the question a records system exists to answer.
          </p>
          <ul className="space-y-1.5">
            {detail.access.map((entry) => (
              <li key={entry.id} className="flex items-start gap-3 rounded-lg border border-slate-900/[0.035] bg-ink-900/30 px-3 py-2">
                <span className="mt-0.5 rounded bg-slate-900/[0.06] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-slateink-300">{entry.action}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] text-slate-900">{entry.actorName ?? entry.actor}</div>
                  {entry.detail && <div className="text-[11.5px] text-slateink-400">{entry.detail}</div>}
                </div>
                <span className="whitespace-nowrap font-mono text-[10.5px] text-slateink-500"><Ago at={entry.createdAt} /></span>
              </li>
            ))}
            {detail.access.length === 0 && <li className="text-[12.5px] text-slateink-500">Nothing logged yet.</li>}
          </ul>
        </>
      )}
    </Modal>
  );
}

function AppointmentRow({ appointment, terms, past }: { appointment: Appointment; terms: Terms; past?: boolean }) {
  return (
    <li className={cn('flex items-center gap-3 rounded-xl border border-slate-900/[0.04] bg-ink-900/40 px-3 py-2', past && 'opacity-80')}>
      <span className="font-mono text-[11.5px] text-brand-700">{fmtDate(appointment.startsAt)}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] text-slate-900">
          {appointment.serviceName ?? appointment.service}
          {appointment.providerName ? ` · ${appointment.providerName}` : ''}
        </div>
        {appointment.seriesId && <div className="text-[11px] text-slateink-500">part of a repeat series</div>}
      </div>
      {appointment.value ? <span className="font-mono text-[11.5px] text-slateink-300">${(appointment.value / 100).toFixed(2)}</span> : null}
      <Pill tone={appointment.status === 'cancelled' ? 'danger' : appointment.status === 'completed' ? 'default' : 'brand'}>{appointment.status}</Pill>
      <span className="sr-only">{terms.appointment.one}</span>
    </li>
  );
}


/* ------------------------------------------------ cases / care-plan tabs */

function ClientCasesTab({ detail }: { detail: Detail }) {
  const [cases, setCases] = React.useState<ClientCase[]>([]);
  const [coverages, setCoverages] = React.useState<CoverageView[]>([]);
  const [payers, setPayers] = React.useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let live = true;
    void Promise.all([
      request<{ data: ClientCase[] }>('GET', `/api/v1/cases?patientId=${encodeURIComponent(detail.id)}&includeClosed=true`),
      request<{ data: CoverageView[] }>('GET', `/api/v1/clients/${detail.id}/coverages`),
      request<{ data: Array<{ id: string; name: string }> }>('GET', '/api/v1/payers'),
    ]).then(([caseBody, coverageBody, payerBody]) => {
      if (!live) return;
      setCases(caseBody.data ?? []);
      setCoverages(coverageBody.data ?? []);
      setPayers(payerBody.data ?? []);
    }).catch((reason) => { if (live) setError(reason instanceof ApiError ? reason.message : 'Case records could not be loaded.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [detail.id]);

  const allocationFor = (caseId: string) => detail.appointments.filter((appointment) => appointment.caseId === caseId && appointment.fundingAllocation);
  const payerName = (id: string) => payers.find((payer) => payer.id === id)?.name ?? 'Payer';
  if (loading) return (
    <div className="space-y-3 py-2" aria-label="Loading cases">
      <div className="h-16 animate-pulse rounded-xl bg-slate-900/[0.04]" />
      <div className="h-16 animate-pulse rounded-xl bg-slate-900/[0.04]" />
    </div>
  );
  if (error) return <div role="alert" className="rounded-xl border border-red-500/20 bg-red-50 p-3 text-[12px] text-red-800">{error}</div>;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h4 className="h4">Administrative case status</h4><p className="mt-1 text-[11.5px] text-slateink-400">Funding links are explicit. Existing appointments are never assigned by migration.</p></div>
        <Link href="/dashboard/cases" className="text-[11.5px] font-medium text-brand-700 hover:underline">Open cases workspace</Link>
      </div>
      <div className="space-y-2">
        {cases.map((caseRow) => {
          const allocations = allocationFor(caseRow.id);
          const committed = allocations.filter((row) => row.fundingAllocation?.state === 'committed').length;
          const used = allocations.filter((row) => row.fundingAllocation?.state === 'used').length;
          return (
            <article key={caseRow.id} className="rounded-xl border border-slate-900/[0.05] bg-ink-900/30 p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0"><p className="font-medium text-slate-900">{caseRow.name}</p><p className="mt-1 text-[11px] text-slateink-400">{caseRow.number} · {caseRow.startsOn}{caseRow.endsOn ? ` to ${caseRow.endsOn}` : ''}</p></div>
                <div className="flex gap-1.5"><Pill tone={caseRow.status === 'active' ? 'brand' : 'default'}>{caseRow.status}</Pill><Pill tone={caseRow.enforcementMode === 'enforced' ? 'warn' : 'default'}>{caseRow.enforcementMode}</Pill></div>
              </div>
              <p className="mt-2 text-[11px] text-slateink-400">{caseRow.trackingMode} tracking · {committed} linked appointment(s) committed · {used} used</p>
            </article>
          );
        })}
        {!cases.length ? <p className="rounded-xl border border-dashed border-slate-900/[0.08] p-5 text-center text-[12px] text-slateink-400">No case has been entered for this client.</p> : null}
      </div>
      <section>
        <h4 className="h4">Payer coverage</h4>
        <p className="mt-1 text-[11px] text-slateink-400">Identifiers stay masked on this view. Revealing them requires the separate sensitive-coverage permission.</p>
        <div className="mt-3 space-y-2">
          {coverages.map((coverage) => (
            <div key={coverage.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-900/[0.05] p-3 text-[11.5px]">
              <div><p className="font-medium text-slate-900">{payerName(coverage.payerId)}</p><p className="mt-1 text-slateink-400">{coverage.holderRelationship} · {coverage.membershipMasked ?? coverage.policyMasked ?? 'identifier not entered'} · {coverage.startsOn}{coverage.endsOn ? ` to ${coverage.endsOn}` : ''}</p></div>
              <Pill tone={coverage.verificationStatus === 'verified' ? 'brand' : 'warn'}>{coverage.verificationStatus}</Pill>
            </div>
          ))}
          {!coverages.length ? <p className="text-[12px] text-slateink-400">No payer coverage entered.</p> : null}
        </div>
      </section>
    </div>
  );
}

function CarePlanTab({ detail }: { detail: Detail }) {
  const toast = useToast();
  const [plans, setPlans] = React.useState<CarePlan[]>([]);
  const [cases, setCases] = React.useState<ClientCase[]>([]);
  const [title, setTitle] = React.useState('');
  const [reviewOn, setReviewOn] = React.useState('');
  const [caseId, setCaseId] = React.useState('');
  const [goalPlanId, setGoalPlanId] = React.useState('');
  const [goal, setGoal] = React.useState('');
  const [action, setAction] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    const [planBody, caseBody] = await Promise.all([
      request<{ data: CarePlan[] }>('GET', `/api/v1/care-plans?patientId=${encodeURIComponent(detail.id)}&includeClosed=true`),
      request<{ data: ClientCase[] }>('GET', `/api/v1/cases?patientId=${encodeURIComponent(detail.id)}&includeClosed=true`),
    ]);
    setPlans(planBody.data ?? []);
    setCases(caseBody.data ?? []);
  }, [detail.id]);

  React.useEffect(() => {
    void load().catch((reason) => setError(reason instanceof ApiError ? reason.message : 'Care plans are restricted for this role.'));
  }, [load]);

  const createPlan = async () => {
    setBusy(true); setError('');
    try {
      await request('POST', '/api/v1/care-plans', { action: 'create', patientId: detail.id, caseId: caseId || undefined, title, reviewOn: reviewOn || undefined, planStatus: 'draft' });
      setTitle(''); setReviewOn('');
      await load();
      toast('Clinician-authored care plan created.');
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'The care plan could not be saved.');
    } finally { setBusy(false); }
  };

  const createGoal = async () => {
    setBusy(true); setError('');
    try {
      await request('POST', '/api/v1/care-plans', { action: 'create_goal', carePlanId: goalPlanId, goal, actions: action.trim() ? [action.trim()] : [], goalStatus: 'planned' });
      setGoal(''); setAction('');
      await load();
      toast('Clinician-authored goal added.');
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'The goal could not be saved.');
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-sky-500/20 bg-sky-50/60 p-3 text-[11.5px] leading-relaxed text-sky-900">Care-plan text is entered by an authorised clinician. Voxera does not generate diagnoses, treatment recommendations, prescriptions or billing codes.</div>
      {error ? <div role="alert" className="rounded-xl border border-red-500/20 bg-red-50 p-3 text-[12px] text-red-800">{error}</div> : null}
      <div className="space-y-3">
        {plans.map((plan) => (
          <article key={plan.id} className="rounded-xl border border-slate-900/[0.05] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><h4 className="font-medium text-slate-900">{plan.title}</h4><p className="mt-1 text-[11px] text-slateink-400">{plan.caseId ? cases.find((row) => row.id === plan.caseId)?.name ?? 'Linked case' : 'No case linked'}{plan.reviewOn ? ` · review ${plan.reviewOn}` : ''}</p></div>
              <Pill tone={plan.status === 'active' ? 'brand' : 'default'}>{plan.status}</Pill>
            </div>
            <div className="mt-3 space-y-2">
              {plan.goals.map((row) => (
                <div key={row.id} className="rounded-lg bg-slate-900/[0.03] p-3">
                  <div className="flex flex-wrap justify-between gap-2"><p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[12px] text-slate-800">{row.goal}</p><Pill tone={row.status === 'achieved' ? 'brand' : 'default'}>{row.status}</Pill></div>
                  {row.actions.length ? <ul className="mt-2 list-disc space-y-1 pl-4 text-[11.5px] text-slateink-400">{row.actions.map((text, index) => <li key={`${row.id}-${index}`} className="whitespace-pre-wrap break-words">{text}</li>)}</ul> : null}
                </div>
              ))}
              {!plan.goals.length ? <p className="text-[11.5px] text-slateink-400">No goals entered.</p> : null}
            </div>
          </article>
        ))}
        {!plans.length && !error ? <p className="rounded-xl border border-dashed border-slate-900/[0.08] p-5 text-center text-[12px] text-slateink-400">No care plan has been authored.</p> : null}
      </div>
      <section className="rounded-xl border border-slate-900/[0.05] p-4">
        <h4 className="h4">New clinician-authored plan</h4>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <input className="field text-[12px]" placeholder="Plan title" value={title} onChange={(event) => setTitle(event.target.value)} />
          <select className="field text-[12px]" value={caseId} onChange={(event) => setCaseId(event.target.value)}><option value="">No case link</option>{cases.filter((row) => row.status !== 'closed').map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select>
          <label className="text-[10.5px] text-slateink-400">Review date<input type="date" className="field mt-1 text-[12px]" value={reviewOn} onChange={(event) => setReviewOn(event.target.value)} /></label>
        </div>
        <div className="mt-3"><Button size="sm" disabled={busy || !title.trim()} onClick={() => void createPlan()}>{busy ? 'Saving…' : 'Create draft plan'}</Button></div>
      </section>
      {plans.some((plan) => plan.status !== 'closed') ? (
        <section className="rounded-xl border border-slate-900/[0.05] p-4">
          <h4 className="h4">Add a clinician-authored goal</h4>
          <div className="mt-3 space-y-2">
            <select className="field text-[12px]" value={goalPlanId} onChange={(event) => setGoalPlanId(event.target.value)}><option value="">Choose care plan</option>{plans.filter((plan) => plan.status !== 'closed').map((plan) => <option key={plan.id} value={plan.id}>{plan.title}</option>)}</select>
            <textarea className="field text-[12px]" rows={3} placeholder="Goal, in the clinician's own words" value={goal} onChange={(event) => setGoal(event.target.value)} />
            <textarea className="field text-[12px]" rows={2} placeholder="Action (optional; clinician-authored)" value={action} onChange={(event) => setAction(event.target.value)} />
          </div>
          <div className="mt-3"><Button size="sm" disabled={busy || !goalPlanId || !goal.trim()} onClick={() => void createGoal()}>{busy ? 'Saving…' : 'Add goal'}</Button></div>
        </section>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------- notes */

/**
 * The notes tab — the record's clinical half.
 *
 * Three shapes in one place, deliberately: the desk sees that a note exists and
 * whether it is signed (and is told plainly that the content is not theirs to
 * read); a practitioner reads, writes and signs; and nobody may quietly rewrite
 * something that is signed — amending it is a button with a reason box, not a
 * text field.
 */
function NotesTab({
  detail,
  terms,
  onChanged,
  busy,
  onBusy,
}: {
  detail: Detail;
  terms: Terms;
  onChanged: () => void;
  busy: boolean;
  onBusy: (v: boolean) => void;
}) {
  const toast = useToast();
  const [openNote, setOpenNote] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [includeArchived, setIncludeArchived] = React.useState(false);

  const notes = (detail.notes ?? []).filter((n) => includeArchived || n.status !== 'archived');
  const restricted = Boolean(detail.notesRestricted);

  async function act(id: string, action: string, body: Record<string, unknown> = {}, message?: string) {
    onBusy(true);
    try {
      await request('POST', '/api/v1/notes', { action, id, ...body });
      if (message) toast(message);
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'That did not save', 'error');
    } finally {
      onBusy(false);
    }
  }

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-xl text-[12.5px] leading-relaxed text-slateink-400">
          {restricted
            ? `Your role can see that a ${terms.note.one} exists and whether it is signed — not what it says. That is the rule, not a permission you can grant yourself.`
            : `What the practice wrote down. A signed ${terms.note.one} is never edited: amending it keeps the signed version and opens the next one.`}
        </p>
        <span className="flex gap-2">
          <Button variant={includeArchived ? 'brand' : 'ghost'} size="sm" onClick={() => setIncludeArchived((v) => !v)}>
            Archived
          </Button>
          {!restricted && (
            <Button variant="brand" size="sm" disabled={busy} onClick={() => setCreating(true)}>
              <Icons.plus size={14} /> New {terms.note.one}
            </Button>
          )}
        </span>
      </div>

      {notes.length === 0 ? (
        <EmptyState
          icon="book"
          title={`No ${terms.note.many} yet`}
          desc={restricted ? 'When a practitioner writes one up, it will appear here as a row — without its contents.' : 'Write one up after a visit, or let the agent draft it from the call and sign it off.'}
        />
      ) : (
        <ul className="space-y-2">
          {notes.map((note) => {
            const unsigned = note.status === 'draft';
            return (
              <li key={note.id} className="rounded-xl border border-slate-900/[0.04] bg-ink-900/40 px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] text-slate-900">{note.title}</span>
                  <Pill tone={note.status === 'final' ? 'brand' : note.status === 'archived' ? 'default' : unsigned && note.draftedBy === 'agent' ? 'warn' : 'info'}>
                    {note.status === 'final' ? `signed v${note.version}` : note.status}
                  </Pill>
                  {note.draftedBy === 'agent' && unsigned && <Pill tone="warn">agent draft — needs a signature</Pill>}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-slateink-400">
                  <span>{note.templateName ?? terms.note.one}</span>
                  <span>{note.authorName ? `written by ${note.authorName}` : 'no author recorded'}</span>
                  {note.sourceCallId && <span className="text-slateink-300">written up from a call</span>}
                  {note.signerName && <span className="text-brand-700">signed by {note.signerName}</span>}
                  {note.incomplete && note.incomplete.length > 0 && (
                    <span className="text-amber-800">missing: {note.incomplete.join(', ')}</span>
                  )}
                  <span className="font-mono text-[10.5px] text-slateink-500">updated <Ago at={note.updatedAt} /></span>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      if (restricted) {
                        toast('This note is clinical content. Your role cannot open it.', 'error');
                        return;
                      }
                      setOpenNote(note.id);
                    }}
                  >
                    {restricted ? 'Restricted' : 'Open'}
                  </Button>
                  {!restricted && unsigned && (
                    <Button
                      variant="brand"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm('Sign this exact revision? Finalised clinical text cannot be edited; later changes require an amendment.')) return;
                        void act(note.id, 'finalise', { expectedRevision: note.revision }, 'Signed. The immutable version is kept.');
                      }}
                    >
                      Sign
                    </Button>
                  )}
                  {!restricted && note.status === 'final' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        const reason = window.prompt('Why is this note being amended? (kept in the history)');
                        if (reason === null) return;
                        void act(note.id, 'amend', { reason, expectedRevision: note.revision }, 'Amended — the signed version is kept and a new one is open.');
                      }}
                    >
                      Amend
                    </Button>
                  )}
                  {!restricted && note.status === 'archived' ? (
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act(note.id, 'restore', {}, 'Restored.')}>
                      Restore
                    </Button>
                  ) : null}
                  {!restricted && note.status !== 'archived' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        const reason = window.prompt('Why is this note being archived?');
                        if (reason === null) return;
                        void act(note.id, 'archive', { reason }, 'Archived. Automatic purge is disabled unless the operator configured a retention policy.');
                      }}
                    >
                      Archive
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {creating && (
        <NoteEditorModal
          clientId={detail.id}
          onClose={() => setCreating(false)}
          onChanged={onChanged}
          terms={terms}
        />
      )}
      {openNote && (
        <NoteEditorModal
          noteId={openNote}
          clientId={detail.id}
          onClose={() => setOpenNote(null)}
          onChanged={onChanged}
          terms={terms}
        />
      )}
    </>
  );
}

/**
 * The editor.
 *
 * Creating asks which template (the practice's own wording, per service);
 * opening shows the note with its missing sections named, its signature state,
 * its attachments and its trail. Saving a draft is free; signing is only allowed
 * once nothing required is blank — which is why the button says *why* it is
 * disabled rather than just being grey.
 */
function NoteEditorModal({
  noteId,
  clientId,
  onClose,
  onChanged,
  terms,
}: {
  noteId?: string;
  clientId: string;
  onClose: () => void;
  onChanged: () => void;
  terms: Terms;
}) {
  const toast = useToast();
  const [loading, setLoading] = React.useState(true);
  const [note, setNote] = React.useState<NoteFull | null>(null);
  const [templates, setTemplates] = React.useState<NoteTemplate[]>([]);
  const [templateId, setTemplateId] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [sections, setSections] = React.useState<NoteSection[]>([]);
  const [trail, setTrail] = React.useState<{ action: string; actor: string; detail?: string; at?: string }[]>([]);
  const [versions, setVersions] = React.useState<{
    version: number;
    reason: string;
    byName?: string;
    at: string;
    templateVersion?: number;
    contentHash?: string;
    previousHash?: string;
    integrity?: 'verified' | 'failed' | 'legacy_unhashed';
  }[]>([]);
  const [conflicts, setConflicts] = React.useState<{
    id: string;
    actorName?: string;
    expectedRevision: number;
    sections: NoteFull['sections'];
    body: string;
    occurredAt: string;
  }[]>([]);
  const [chartTemplates, setChartTemplates] = React.useState<BodyChartTemplate[]>([]);
  const [bodyCharts, setBodyCharts] = React.useState<BodyChartAnnotation[]>([]);
  const [bodyChartConflicts, setBodyChartConflicts] = React.useState<BodyChartConflict[]>([]);
  const [bodyChartVersions, setBodyChartVersions] = React.useState<BodyChartVersion[]>([]);
  const [chartsLoading, setChartsLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [attachName, setAttachName] = React.useState('');
  const [attachBytes, setAttachBytes] = React.useState('120000');

  const loadBodyCharts = React.useCallback(async (id: string) => {
    setChartsLoading(true);
    try {
      const [templateBody, chartBody] = await Promise.all([
        request<{ data: BodyChartTemplate[] }>('GET', '/api/v1/body-chart-templates'),
        request<{ data: BodyChartAnnotation[]; conflicts: BodyChartConflict[]; versions: BodyChartVersion[] }>('GET', `/api/v1/notes/${id}/body-charts`),
      ]);
      setChartTemplates((templateBody.data ?? []).filter((row) => row.state === 'published'));
      setBodyCharts(chartBody.data ?? []);
      setBodyChartConflicts(chartBody.conflicts ?? []);
      setBodyChartVersions(chartBody.versions ?? []);
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'Body charts could not be loaded.', 'error');
    } finally {
      setChartsLoading(false);
    }
  }, [toast]);

  React.useEffect(() => {
    void (async () => {
      try {
        if (noteId) {
          const body = await request<{ note: NoteFull; versions: typeof versions; conflicts: typeof conflicts; audit: typeof trail }>('GET', `/api/v1/notes/${noteId}`);
          setNote(body.note);
          setTitle(body.note.title);
          setSections(body.note.sections ?? []);
          setVersions(body.versions ?? []);
          setConflicts(body.conflicts ?? []);
          setTrail(body.audit ?? []);
          await loadBodyCharts(noteId);
        } else {
          const body = await request<{ templates: NoteTemplate[]; vocabulary?: { note?: string } }>('GET', '/api/v1/notes?view=templates');
          setTemplates(body.templates ?? []);
          const first = body.templates?.[0];
          if (first) {
            setTemplateId(first.id);
            setSections(first.sections.map((s) => ({ id: s.id, label: s.label, body: '', kind: s.kind, required: s.required, hint: s.prompt })));
          }
        }
      } catch (err) {
        toast(err instanceof ApiError ? err.message : 'Could not open the note', 'error');
        onClose();
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  function pickTemplate(id: string) {
    setTemplateId(id);
    const t = templates.find((x) => x.id === id);
    if (t) setSections(t.sections.map((s) => ({ id: s.id, label: s.label, body: '', kind: s.kind, required: s.required, hint: s.prompt })));
  }

  const filledChartSections = new Set(bodyCharts.filter((chart) => !note || chart.noteVersion === note.version).map((chart) => chart.sectionId).filter(Boolean));
  const missing = sections.filter((section) => section.required && (section.kind === 'body_chart' ? !filledChartSections.has(section.id) : !section.body.trim())).map((section) => section.label);
  const editable = !note || note.status === 'draft';

  async function save() {
    setBusy(true);
    try {
      if (note) {
        const body = await request<{ note: NoteFull }>('POST', '/api/v1/notes', { action: 'update', id: note.id, expectedRevision: note.revision, title, sections });
        setNote(body.note);
        toast('Draft saved.');
      } else {
        const body = await request<{ note: NoteFull }>('POST', '/api/v1/notes', {
          action: 'create',
          clientId,
          title: title || undefined,
          templateId: templateId || undefined,
          sections,
        });
        setNote(body.note);
        setTitle(body.note.title);
        setSections(body.note.sections ?? []);
        await loadBodyCharts(body.note.id);
        toast('Draft opened.');
      }
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'That did not save', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function finalise() {
    if (!note) return;
    if (!window.confirm('Sign this exact revision? The finalised text and SHA-256 evidence cannot be edited. A later correction must be an explicit amendment.')) return;
    setBusy(true);
    try {
      const body = await request<{ note: NoteFull; versions: typeof versions }>('POST', '/api/v1/notes', {
        action: 'finalise',
        id: note.id,
        expectedRevision: note.revision,
      });
      setNote(body.note);
      setSections(body.note.sections ?? []);
      setVersions(body.versions ?? []);
      await loadBodyCharts(note.id);
      toast('Signed. This immutable version, including body-chart evidence, is now the record.');
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not sign it', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function resolveConflict(conflictId: string, resolution: 'keep_current' | 'use_conflict') {
    if (!note) return;
    setBusy(true);
    try {
      const body = await request<{ note: NoteFull; conflicts: typeof conflicts }>('POST', '/api/v1/notes', {
        action: 'resolve_conflict',
        id: note.id,
        conflictId,
        resolution,
        expectedRevision: note.revision,
      });
      setNote(body.note);
      setTitle(body.note.title);
      setSections(body.note.sections ?? []);
      setConflicts(body.conflicts ?? []);
      toast('Concurrent clinical text reconciled explicitly.');
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'The conflict could not be reconciled.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function attach() {
    if (!note) return;
    setBusy(true);
    try {
      const body = await request<{ note: NoteFull }>('POST', '/api/v1/notes', {
        action: 'attach',
        id: note.id,
        name: attachName,
        bytes: Number(attachBytes),
      });
      setNote(body.note);
      setAttachName('');
      toast('Attachment recorded.');
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not record that', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-3xl"
      title={note ? note.title : `New ${terms.note.one}`}
      desc={
        note
          ? `${note.templateName ?? terms.note.one} · v${note.version} · ${note.status}${note.signerName ? ` · signed by ${note.signerName}` : ''}`
          : `Filed against this ${terms.client.one}, signed by a person, kept for the record.`
      }
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <span className="text-[11.5px] text-slateink-400">
            {!editable
              ? 'Signed. Amend it to change anything — the signed version stays.'
              : missing.length
                ? `Missing: ${missing.join(', ')}`
                : 'Complete — ready to sign.'}
          </span>
          <span className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
            {editable && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void save()}>
                {note ? 'Save draft' : 'Open draft'}
              </Button>
            )}
            {note && note.status === 'draft' && (
              <Button variant="brand" size="sm" disabled={busy || missing.length > 0 || conflicts.length > 0 || bodyChartConflicts.length > 0} onClick={() => void finalise()} title={conflicts.length || bodyChartConflicts.length ? 'Reconcile all concurrent clinical text and annotations first' : missing.length ? `Still blank: ${missing.join(', ')}` : 'Sign this exact note and body-chart revision'}>
                Sign &amp; finalise
              </Button>
            )}
          </span>
        </div>
      }
    >
      {loading ? (
        <div className="h-40 animate-pulse rounded-xl bg-ink-850/40" />
      ) : (
        <div className="space-y-4">
          {!note && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="label">Template</span>
                <select className="field text-[12.5px]" value={templateId} onChange={(e) => pickTemplate(e.target.value)}>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {t.serviceName ? ` — ${t.serviceName}` : ' (general)'}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="label">Title</span>
                <input className="field text-[12.5px]" placeholder="Leave blank for today&rsquo;s date" value={title} onChange={(e) => setTitle(e.target.value)} />
              </label>
            </div>
          )}

          <div className="space-y-3">
            {sections.map((section, index) => (
              <div key={section.id}>
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <span className="text-[12.5px] font-medium text-slate-900">
                    {section.label}
                    {section.required && <span className="ml-1 text-amber-800">*</span>}
                  </span>
                  {section.hint && <span className="text-[11px] text-slateink-500">{section.hint}</span>}
                </div>
                {section.kind === 'body_chart' ? (
                  <BodyChartSlot
                    note={note}
                    section={section}
                    templates={chartTemplates}
                    annotations={bodyCharts.filter((chart) => chart.sectionId === section.id)}
                    conflicts={bodyChartConflicts.filter((conflict) => bodyCharts.some((chart) => chart.id === conflict.annotationId && chart.sectionId === section.id))}
                    versions={bodyChartVersions.filter((version) => bodyCharts.some((chart) => chart.id === version.annotationId && chart.sectionId === section.id))}
                    editable={editable}
                    loading={chartsLoading}
                    onNoteRevision={(revision) => setNote((current) => current ? { ...current, revision } : current)}
                    onReload={() => note ? loadBodyCharts(note.id) : Promise.resolve()}
                  />
                ) : (
                  <textarea
                    className="field min-h-[64px] w-full text-[12.5px] leading-relaxed"
                    value={section.body}
                    readOnly={!editable}
                    onChange={(e) => setSections((prev) => prev.map((s, i) => (i === index ? { ...s, body: e.target.value } : s)))}
                  />
                )}
              </div>
            ))}
          </div>

          {note && conflicts.length > 0 ? (
            <section className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-3" aria-labelledby="draft-conflicts-title">
              <h3 id="draft-conflicts-title" className="text-[12.5px] font-semibold text-amber-950">Concurrent clinical text needs reconciliation</h3>
              <p className="mt-1 text-[11.5px] leading-relaxed text-amber-900">Nothing was auto-merged or overwritten. Compare the current draft with each preserved draft and choose explicitly.</p>
              <div className="mt-3 space-y-2">
                {conflicts.map((conflict) => (
                  <div key={conflict.id} className="rounded-lg border border-amber-900/10 bg-white/50 p-2.5">
                    <p className="text-[11px] text-amber-900">Preserved from {conflict.actorName ?? 'another clinician'} at revision {conflict.expectedRevision}</p>
                    <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-[11px] text-slateink-400">{conflict.body}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void resolveConflict(conflict.id, 'keep_current')}>Keep current draft</Button>
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void resolveConflict(conflict.id, 'use_conflict')}>Use preserved draft</Button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {note?.status === 'final' && note.signedHash ? (
            <section className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.05] p-3" aria-labelledby="signed-evidence-title">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id="signed-evidence-title" className="text-[12.5px] font-semibold text-emerald-900">Signed evidence</h3>
                <Pill tone="brand">verified snapshot</Pill>
              </div>
              <p className="mt-2 text-[11.5px] leading-relaxed text-emerald-900">
                {note.signerName ?? 'Recorded staff member'} · {note.signedAt ? new Date(note.signedAt).toLocaleString() : 'time unavailable'} · template v{note.templateVersion ?? 'legacy'} · note v{note.version} · revision {note.revision}
              </p>
              <p className="mt-2 break-all font-mono text-[10px] text-emerald-800">SHA-256 {note.signedHash}</p>
            </section>
          ) : null}

          {note && (
            <>
              <div className="rounded-xl border border-slate-900/[0.04] bg-ink-900/40 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[12.5px] font-medium text-slate-900">Attachments</span>
                  <span className="text-[11px] text-slateink-500">Recorded against the note; the bytes live wherever the practice stores them.</span>
                </div>
                <ul className="mb-2 space-y-1">
                  {(note.attachments ?? []).map((a) => (
                    <li key={a.id} className="flex items-center gap-2 text-[12px] text-slateink-300">
                      <Icons.book size={13} className="text-slateink-500" />
                      <span className="flex-1 truncate">{a.name}</span>
                      <span className="font-mono text-[10.5px] text-slateink-500">{Math.round(a.bytes / 1024)} KB</span>
                    </li>
                  ))}
                  {(note.attachments ?? []).length === 0 && <li className="text-[12px] text-slateink-500">Nothing attached.</li>}
                </ul>
                {editable && (
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="min-w-[180px] flex-1">
                      <span className="label">File name</span>
                      <input className="field text-[12px]" placeholder="x-ray-2026-10.jpg" value={attachName} onChange={(e) => setAttachName(e.target.value)} />
                    </label>
                    <label className="w-[120px]">
                      <span className="label">Size (bytes)</span>
                      <input className="field font-mono text-[12px]" value={attachBytes} onChange={(e) => setAttachBytes(e.target.value)} />
                    </label>
                    <Button variant="ghost" size="sm" disabled={busy || !attachName.trim()} onClick={() => void attach()}>
                      Attach
                    </Button>
                  </div>
                )}
              </div>

              <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                <div className="min-w-0 rounded-xl border border-slate-900/[0.04] bg-ink-900/40 p-3">
                  <div className="mb-2 text-[12.5px] font-medium text-slate-900">Versions</div>
                  <ul className="space-y-1.5">
                    {versions.map((v) => (
                      <li key={v.version} className="min-w-0 break-words text-[11.5px] text-slateink-300">
                        <span className="font-mono text-brand-700">v{v.version}</span> {v.reason}
                        {v.byName ? ` · ${v.byName}` : ''} <span className="text-slateink-500"><Ago at={v.at} /></span>
                        {v.integrity ? <span className={v.integrity === 'verified' ? 'ml-1 text-emerald-700' : v.integrity === 'failed' ? 'ml-1 text-red-700' : 'ml-1 text-amber-700'}>· {v.integrity.replace('_', ' ')}</span> : null}
                        {v.contentHash ? <span className="mt-0.5 block truncate font-mono text-[9.5px] text-slateink-500">{v.contentHash}</span> : null}
                      </li>
                    ))}
                    {versions.length === 0 && <li className="text-[11.5px] text-slateink-500">Not signed yet, so there is nothing frozen.</li>}
                  </ul>
                </div>
                <div className="min-w-0 rounded-xl border border-slate-900/[0.04] bg-ink-900/40 p-3">
                  <div className="mb-2 text-[12.5px] font-medium text-slate-900">Trail</div>
                  <ul className="max-h-40 space-y-1.5 overflow-y-auto">
                    {trail.slice(0, 12).map((entry, i) => (
                      <li key={i} className="min-w-0 break-words text-[11.5px] text-slateink-300">
                        <span className="font-mono text-[10.5px] uppercase tracking-wide text-slateink-500">{entry.action}</span>{' '}
                        {entry.detail || entry.actor}
                      </li>
                    ))}
                    {trail.length === 0 && <li className="text-[11.5px] text-slateink-500">Nothing logged yet.</li>}
                  </ul>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

/* ----------------------------------------------------------- body charts */

function BodyChartSlot({
  note,
  section,
  templates,
  annotations,
  conflicts,
  versions,
  editable,
  loading,
  onNoteRevision,
  onReload,
}: {
  note: NoteFull | null;
  section: NoteSection;
  templates: BodyChartTemplate[];
  annotations: BodyChartAnnotation[];
  conflicts: BodyChartConflict[];
  versions: BodyChartVersion[];
  editable: boolean;
  loading: boolean;
  onNoteRevision: (revision: number) => void;
  onReload: () => Promise<void>;
}) {
  const toast = useToast();
  const [templateId, setTemplateId] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!templateId && templates[0]) setTemplateId(templates[0].id);
  }, [templateId, templates]);

  async function createChart() {
    if (!note || !templateId) return;
    setBusy(true);
    try {
      const body = await request<{ annotation: BodyChartAnnotation; noteRevision: number }>('POST', `/api/v1/notes/${note.id}/body-charts`, {
        action: 'create',
        templateId,
        sectionId: section.id,
        expectedNoteRevision: note.revision,
        marks: [],
      });
      onNoteRevision(body.noteRevision);
      await onReload();
      toast('Body chart added. Its source-image version is now pinned to this annotation.');
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'The body chart could not be added.', 'error');
      await onReload();
    } finally {
      setBusy(false);
    }
  }

  async function resolve(conflict: BodyChartConflict, resolution: 'keep_current' | 'use_conflict') {
    if (!note) return;
    const annotation = annotations.find((row) => row.id === conflict.annotationId);
    if (!annotation) return;
    setBusy(true);
    try {
      const body = await request<{ annotation: BodyChartAnnotation; noteRevision: number }>('POST', `/api/v1/notes/${note.id}/body-charts`, {
        action: 'resolve_conflict',
        annotationId: annotation.id,
        conflictId: conflict.id,
        expectedRevision: annotation.revision,
        expectedNoteRevision: note.revision,
        resolution,
      });
      onNoteRevision(body.noteRevision);
      await onReload();
      toast('Concurrent body-chart annotations reconciled explicitly.');
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'The body-chart conflict could not be reconciled.', 'error');
      await onReload();
    } finally {
      setBusy(false);
    }
  }

  if (!note) {
    return <div className="rounded-xl border border-dashed border-slate-900/10 bg-ink-900/30 p-4 text-[11.5px] text-slateink-500">Open the draft first, then add an image-backed body chart. No annotation is stored in an unsaved browser draft.</div>;
  }
  if (loading) return <div className="h-40 animate-pulse rounded-xl bg-ink-850/40" aria-label="Loading body charts" />;

  return (
    <div className="space-y-3 rounded-xl border border-slate-900/[0.06] bg-ink-900/25 p-3" data-body-chart-slot={section.id}>
      <div className="flex flex-wrap items-end gap-2">
        {editable ? (
          <>
            <label className="min-w-[200px] flex-1"><span className="label">Body-chart template</span><select className="field w-full text-[12px]" value={templateId} onChange={(event) => setTemplateId(event.target.value)} disabled={busy || !templates.length}>
              {templates.map((template) => <option key={template.id} value={template.id}>{template.title}</option>)}
            </select></label>
            <Button variant="ghost" size="sm" disabled={busy || !templateId} onClick={() => void createChart()}><Icons.plus size={13} /> Add chart</Button>
          </>
        ) : <p className="text-[11.5px] text-slateink-500">Signed charts are read-only. Amend the note to open the next version.</p>}
      </div>
      {editable && templates.length === 0 ? <p className="text-[11.5px] text-amber-800">No published body-chart template exists. A clinical administrator must publish a scanner-clean, workspace-owned PNG or JPEG template first.</p> : null}
      {annotations.map((annotation) => (
        <BodyChartCanvas
          key={`${annotation.id}:${annotation.revision}`}
          noteId={note.id}
          noteRevision={note.revision}
          annotation={annotation}
          template={templates.find((row) => row.id === annotation.templateId)}
          editable={editable && annotation.status === 'draft'}
          onNoteRevision={onNoteRevision}
          onReload={onReload}
        />
      ))}
      {annotations.length === 0 ? <p className="text-[11.5px] text-slateink-500">No chart has been added to this slot.</p> : null}

      {conflicts.length ? (
        <section className="rounded-xl border border-amber-500/25 bg-amber-500/[0.07] p-3" aria-label="Body-chart conflicts">
          <h4 className="text-[12px] font-semibold text-amber-950">Concurrent annotations need reconciliation</h4>
          <p className="mt-1 text-[11px] leading-relaxed text-amber-900">The current set and every losing set were preserved. Nothing is merged or selected automatically.</p>
          <div className="mt-2 space-y-2">{conflicts.map((conflict) => (
            <div key={conflict.id} className="rounded-lg border border-amber-900/10 bg-white/50 p-2.5">
              <p className="text-[11px] text-amber-900">{conflict.marks.length} preserved mark(s) from {conflict.actorName ?? 'another clinician'} · expected chart revision {conflict.expectedRevision}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void resolve(conflict, 'keep_current')}>Keep current set</Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void resolve(conflict, 'use_conflict')}>Use preserved set</Button>
              </div>
            </div>
          ))}</div>
        </section>
      ) : null}

      {versions.length ? (
        <details className="rounded-xl border border-slate-900/[0.05] bg-white/40 p-3">
          <summary className="cursor-pointer text-[11.5px] font-medium text-slate-900">Immutable body-chart history · {versions.length} snapshot{versions.length === 1 ? '' : 's'}</summary>
          <ul className="mt-2 space-y-2">{versions.map((version) => (
            <li key={version.id} className="text-[10.5px] text-slateink-400">
              <div className="flex flex-wrap items-center gap-2"><Pill tone={version.integrity === 'verified' ? 'brand' : 'danger'}>{version.integrity}</Pill><span>note v{version.noteVersion} · {new Date(version.signedAt).toLocaleString()} · {version.signedByName ?? 'recorded signer'}</span></div>
              <p className="mt-1 break-all font-mono text-[9.5px]">SHA-256 {version.contentHash}</p>
              <div className="mt-1 flex gap-3"><a className="text-brand-700 hover:underline" href={`/api/v1/notes/${note.id}/body-charts?versionId=${encodeURIComponent(version.id)}&format=json`}>Structured export</a><a className="text-brand-700 hover:underline" href={`/api/v1/notes/${note.id}/body-charts?versionId=${encodeURIComponent(version.id)}&format=svg`}>Overlay SVG</a></div>
            </li>
          ))}</ul>
        </details>
      ) : null}
    </div>
  );
}

function BodyChartCanvas({
  noteId,
  noteRevision,
  annotation,
  template,
  editable,
  onNoteRevision,
  onReload,
}: {
  noteId: string;
  noteRevision: number;
  annotation: BodyChartAnnotation;
  template?: BodyChartTemplate;
  editable: boolean;
  onNoteRevision: (revision: number) => void;
  onReload: () => Promise<void>;
}) {
  const toast = useToast();
  const [marks, setMarks] = React.useState<BodyChartMark[]>(annotation.marks);
  const [tool, setTool] = React.useState<'point' | 'stroke' | 'label'>('point');
  const [label, setLabel] = React.useState('');
  const [color, setColor] = React.useState('#dc2626');
  const [drawingId, setDrawingId] = React.useState<string | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    setMarks(annotation.marks);
    setDirty(false);
  }, [annotation.marks, annotation.revision]);

  function point(event: React.PointerEvent<SVGSVGElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - box.left) / Math.max(1, box.width))),
      y: Math.max(0, Math.min(1, (event.clientY - box.top) / Math.max(1, box.height))),
    };
  }

  function id(prefix: string) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function pointerDown(event: React.PointerEvent<SVGSVGElement>) {
    if (!editable) return;
    const at = point(event);
    if (tool === 'point') {
      setMarks((current) => [...current, { id: id('point'), type: 'point', ...at, color, size: 9 }]);
      setDirty(true);
      return;
    }
    if (tool === 'label') {
      const text = label.trim();
      if (!text) {
        toast('Enter the label text first.', 'error');
        return;
      }
      setMarks((current) => [...current, { id: id('label'), type: 'label', ...at, text: text.slice(0, 160), color }]);
      setDirty(true);
      return;
    }
    const strokeId = id('stroke');
    setMarks((current) => [...current, { id: strokeId, type: 'stroke', points: [at, at], color, width: 4 }]);
    setDrawingId(strokeId);
    setDirty(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function pointerMove(event: React.PointerEvent<SVGSVGElement>) {
    if (!drawingId) return;
    const at = point(event);
    setMarks((current) => current.map((mark) => {
      if (mark.id !== drawingId || mark.type !== 'stroke') return mark;
      const last = mark.points.at(-1)!;
      if (Math.hypot(last.x - at.x, last.y - at.y) < 0.002) return mark;
      return { ...mark, points: [...mark.points, at].slice(0, 2_000) };
    }));
  }

  function pointerUp(event: React.PointerEvent<SVGSVGElement>) {
    setDrawingId(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  async function save() {
    setSaving(true);
    try {
      const body = await request<{ annotation: BodyChartAnnotation; noteRevision: number }>('POST', `/api/v1/notes/${noteId}/body-charts`, {
        action: 'update', annotationId: annotation.id, expectedRevision: annotation.revision,
        expectedNoteRevision: noteRevision, marks,
      });
      onNoteRevision(body.noteRevision);
      await onReload();
      toast('Body-chart draft saved at a new aggregate revision.');
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'The body-chart draft could not be saved.', 'error');
      await onReload();
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className="rounded-xl border border-slate-900/[0.06] bg-white/60 p-3" data-body-chart-id={annotation.id}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div><h4 className="text-[12.5px] font-medium text-slate-900">{template?.title ?? 'Pinned body-chart template'}</h4><p className="text-[10.5px] text-slateink-500">{annotation.marks.length} mark(s) · chart revision {annotation.revision} · note v{annotation.noteVersion}</p></div>
        <Pill tone={annotation.status === 'final' ? 'brand' : 'warn'}>{annotation.status}</Pill>
      </div>
      {editable ? (
        <div className="mb-2 flex flex-wrap items-end gap-2" role="toolbar" aria-label="Body-chart annotation tools">
          <label><span className="label">Tool</span><select className="field text-[12px]" value={tool} onChange={(event) => setTool(event.target.value as typeof tool)}><option value="point">Point</option><option value="stroke">Freehand</option><option value="label">Label</option></select></label>
          <label><span className="label">Colour</span><input type="color" className="h-9 w-12 rounded-lg border border-slate-900/10 bg-white p-1" value={color} onChange={(event) => setColor(event.target.value)} /></label>
          {tool === 'label' ? <label className="min-w-[180px] flex-1"><span className="label">Label text</span><input className="field w-full text-[12px]" maxLength={160} value={label} onChange={(event) => setLabel(event.target.value)} /></label> : null}
          <Button variant="ghost" size="sm" disabled={!marks.length} onClick={() => { setMarks((current) => current.slice(0, -1)); setDirty(true); }}>Undo</Button>
          <Button variant="ghost" size="sm" disabled={!marks.length} onClick={() => { if (window.confirm('Clear every unsaved mark from this chart?')) { setMarks([]); setDirty(true); } }}>Clear</Button>
        </div>
      ) : null}
      <div className="relative overflow-hidden rounded-lg border border-slate-900/10 bg-white">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/api/v1/body-chart-templates/${annotation.templateId}/source`} alt="Body-chart template for clinician annotation" className="block h-auto w-full select-none" draggable={false} />
        <svg
          className={`absolute inset-0 h-full w-full ${editable ? 'cursor-crosshair' : ''}`}
          viewBox="0 0 1000 1000"
          preserveAspectRatio="none"
          role="application"
          aria-label={editable ? 'Body chart. Choose a tool, then point or draw on the image.' : 'Read-only signed body-chart annotations.'}
          tabIndex={0}
          style={{ touchAction: 'none' }}
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
          onPointerCancel={pointerUp}
        >
          {marks.map((mark) => mark.type === 'point' ? (
            <circle key={mark.id} cx={mark.x * 1000} cy={mark.y * 1000} r={mark.size} fill={mark.color} />
          ) : mark.type === 'stroke' ? (
            <polyline key={mark.id} points={mark.points.map((item) => `${item.x * 1000},${item.y * 1000}`).join(' ')} fill="none" stroke={mark.color} strokeWidth={mark.width} strokeLinecap="round" strokeLinejoin="round" />
          ) : (
            <text key={mark.id} x={mark.x * 1000} y={mark.y * 1000} fill={mark.color} fontFamily="sans-serif" fontSize="24">{mark.text}</text>
          ))}
        </svg>
      </div>
      <p className="mt-2 text-[10.5px] leading-relaxed text-slateink-500">Coordinates are stored from 0 to 1 against this exact image version. The overlay contains clinician-authored marks only; it does not generate findings or recommendations.</p>
      {marks.length ? <ul className="mt-2 flex max-h-24 flex-wrap gap-1.5 overflow-y-auto" aria-label="Body-chart marks">{marks.map((mark, index) => <li key={mark.id} className="flex items-center gap-1 rounded-md border border-slate-900/[0.06] px-2 py-1 text-[10px] text-slateink-400"><span>{index + 1}. {mark.type}{mark.type === 'label' ? `: ${mark.text}` : ''}</span>{editable ? <button type="button" className="text-red-700 hover:underline" onClick={() => { setMarks((current) => current.filter((row) => row.id !== mark.id)); setDirty(true); }} aria-label={`Remove ${mark.type} mark ${index + 1}`}>remove</button> : null}</li>)}</ul> : null}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-3 text-[10.5px]"><a className="text-brand-700 hover:underline" href={`/api/v1/notes/${noteId}/body-charts?annotationId=${encodeURIComponent(annotation.id)}&format=json`}>Structured export</a><a className="text-brand-700 hover:underline" href={`/api/v1/notes/${noteId}/body-charts?annotationId=${encodeURIComponent(annotation.id)}&format=svg`}>Overlay SVG</a></div>
        {editable ? <Button variant="brand" size="sm" disabled={saving || !dirty} onClick={() => void save()}>{saving ? 'Saving…' : 'Save chart'}</Button> : annotation.lastSnapshotHash ? <span className="max-w-xs truncate font-mono text-[9.5px] text-emerald-800" title={annotation.lastSnapshotHash}>SHA-256 {annotation.lastSnapshotHash}</span> : null}
      </div>
    </article>
  );
}

/* ---------------------------------------------------------------- new client */

function NewClientModal({
  open,
  onClose,
  term,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  term: string;
  onCreated: (id: string) => void;
}) {
  const toast = useToast();
  const [form, setForm] = React.useState({ name: '', number: '', email: '', dateOfBirth: '', address: '', tags: '' });
  const [saving, setSaving] = React.useState(false);

  async function submit() {
    if (!form.name.trim() || !form.number.trim()) {
      toast('A name and a number, please.', 'error');
      return;
    }
    setSaving(true);
    try {
      const client = await request<Client>('POST', '/api/v1/clients', {
        name: form.name,
        number: form.number,
        email: form.email || undefined,
        dateOfBirth: form.dateOfBirth || undefined,
        address: form.address || undefined,
        tags: form.tags ? form.tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
      });
      toast(`${client.name} added.`);
      setForm({ name: '', number: '', email: '', dateOfBirth: '', address: '', tags: '' });
      onCreated(client.id);
    } catch (err) {
      // A duplicate number is the interesting failure: offer the existing record.
      toast(err instanceof ApiError ? err.message : 'Could not save', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`New ${term}`}
      desc="The number is how the practice finds them again — a call from it lands on this record."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="brand" size="sm" disabled={saving} onClick={() => void submit()}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="c-name">
              Name
            </label>
            <input id="c-name" className="field text-[13px]" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="c-number">
              Phone
            </label>
            <input id="c-number" className="field font-mono text-[12.5px]" placeholder="+14155550123" value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="c-email">
              Email
            </label>
            <input id="c-email" className="field text-[13px]" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="c-dob">
              Date of birth
            </label>
            <input id="c-dob" type="date" className="field text-[13px]" value={form.dateOfBirth} onChange={(e) => setForm({ ...form, dateOfBirth: e.target.value })} />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="c-address">
            Address
          </label>
          <input id="c-address" className="field text-[13px]" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
        </div>
        <div>
          <label className="label" htmlFor="c-tags">
            Tags (comma separated)
          </label>
          <input id="c-tags" className="field text-[13px]" placeholder="vip, insurance, wheelchair access" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------ class packs */

type ClientPackRow = {
  id: string;
  name: string;
  serviceName: string;
  placesTotal: number;
  held: number;
  spent: number;
  placesLeft: number;
  status: string;
  expiresAt?: string;
  currency: string;
};
type PackProductRow = { id: string; name: string; places: number; priceMinor: number; active: boolean };

/**
 * The packs this client holds, and selling the next one. A pack is bought
 * here because a pack belongs to a person; spending happens on the class
 * register, where the attendance it pays for is marked.
 */
function ClientPacks({ clientId }: { clientId: string }) {
  const toast = useToast();
  const [packs, setPacks] = React.useState<ClientPackRow[] | null>(null);
  const [products, setProducts] = React.useState<PackProductRow[]>([]);
  const [clients, setClients] = React.useState<{ id: string; name: string }[]>([]);
  const [buy, setBuy] = React.useState({ productId: '', method: 'card' });
  const [desk, setDesk] = React.useState<{ packId: string; action: 'extend' | 'transfer'; months: string; reason: string; toClientId: string } | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const payload = await request<{ packs: ClientPackRow[]; products: PackProductRow[] }>('GET', `/api/v1/packs?clientId=${clientId}`);
      setPacks(payload.packs);
      setProducts(payload.products.filter((p) => p.active));
    } catch {
      setPacks([]);
    }
  }, [clientId]);
  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => {
    void request<{ data?: { id: string; name: string }[] }>('GET', '/api/v1/clients?limit=200')
      .then((r) => setClients((r.data ?? []).filter((c) => c.id !== clientId)))
      .catch(() => undefined);
  }, [clientId]);

  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await fn();
      toast(done);
      setDesk(null);
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'That did not go through.', 'error');
    } finally {
      setBusy(false);
    }
  }

  const field = 'field text-[13px]';

  return (
    <section>
      <h4 className="h4 mb-2">Class packs</h4>
      {packs === null ? (
        <p className="text-[12.5px] text-slateink-500">Reading packs…</p>
      ) : packs.length === 0 ? (
        <p className="text-[12.5px] text-slateink-500">No packs. Selling one below holds the places against it as they book.</p>
      ) : (
        <ul className="space-y-2">
          {packs.map((pack) => (
            <li key={pack.id} className="rounded-xl border border-slate-900/[0.04] bg-ink-900/40 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[13px] text-slate-900">
                  {pack.name} <span className="text-slateink-400">· {pack.serviceName}</span>
                </span>
                <Pill tone={pack.status === 'active' ? 'brand' : 'default'}>{pack.status}</Pill>
              </div>
              <p className="mt-1 text-[12px] text-slateink-300">
                {pack.placesLeft} of {pack.placesTotal} places left · {pack.spent} spent{pack.held ? ` · ${pack.held} held for booked classes` : ''}
                {pack.expiresAt ? ` · valid until ${pack.expiresAt.slice(0, 10)}` : ' · no expiry'}
              </p>
              {pack.status !== 'refunded' && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <button type="button" disabled={busy} className="rounded-lg border border-slate-900/[0.06] px-2.5 py-1 text-[12px] text-slateink-200 hover:text-slate-900 disabled:opacity-50" onClick={() => setDesk({ packId: pack.id, action: 'extend', months: '3', reason: '', toClientId: '' })}>
                    Extend
                  </button>
                  <button type="button" disabled={busy} className="rounded-lg border border-slate-900/[0.06] px-2.5 py-1 text-[12px] text-slateink-200 hover:text-slate-900 disabled:opacity-50" onClick={() => setDesk({ packId: pack.id, action: 'transfer', months: '', reason: '', toClientId: clients[0]?.id ?? '' })}>
                    Transfer
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className="rounded-lg border border-slate-900/[0.06] px-2.5 py-1 text-[12px] text-slateink-200 hover:border-red-400/40 hover:text-slate-900 disabled:opacity-50"
                    onClick={() => void act(() => request('POST', `/api/v1/client-packs/${pack.id}`, { action: 'refund-unused' }), 'Unspent places refunded.')}
                  >
                    Refund unspent
                  </button>
                </div>
              )}
              {desk?.packId === pack.id && (
                <div className="mt-2 grid gap-2 rounded-lg border border-slate-900/[0.035] p-2.5 sm:grid-cols-[110px_1fr_auto]">
                  {desk.action === 'extend' ? (
                    <input className={field} type="number" min={1} max={24} value={desk.months} onChange={(e) => setDesk({ ...desk, months: e.target.value })} aria-label="Months to extend" />
                  ) : (
                    <select className={field} value={desk.toClientId} onChange={(e) => setDesk({ ...desk, toClientId: e.target.value })} aria-label="Transfer to">
                      {clients.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  )}
                  <input className={field} placeholder="Reason (kept on the record)" value={desk.reason} onChange={(e) => setDesk({ ...desk, reason: e.target.value })} aria-label="Reason" />
                  <Button
                    variant="brand"
                    size="sm"
                    disabled={busy || desk.reason.trim().length < 3 || (desk.action === 'transfer' && !desk.toClientId)}
                    onClick={() =>
                      void act(
                        () =>
                          desk.action === 'extend'
                            ? request('POST', `/api/v1/client-packs/${pack.id}`, { action: 'extend', months: Number(desk.months), reason: desk.reason })
                            : request('POST', `/api/v1/client-packs/${pack.id}`, { action: 'transfer', toClientId: desk.toClientId, reason: desk.reason }),
                        desk.action === 'extend' ? 'Pack extended.' : 'Pack transferred.'
                      )
                    }
                  >
                    {desk.action === 'extend' ? 'Extend pack' : 'Transfer pack'}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {products.length > 0 && (
        <div className="mt-2 grid gap-2 rounded-xl border border-dashed border-slate-900/[0.04] p-3 sm:grid-cols-[1fr_130px_auto]">
          <select className={field} value={buy.productId} onChange={(e) => setBuy({ ...buy, productId: e.target.value })} aria-label="Pack to sell">
            <option value="">Sell a pack…</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — {p.places} places, {(p.priceMinor / 100).toFixed(2)}
              </option>
            ))}
          </select>
          <select className={field} value={buy.method} onChange={(e) => setBuy({ ...buy, method: e.target.value })} aria-label="Payment method">
            <option value="card">Card</option>
            <option value="cash">Cash</option>
            <option value="bank_transfer">Bank transfer</option>
            <option value="other">Other</option>
          </select>
          <Button
            variant="brand"
            size="sm"
            disabled={busy || !buy.productId}
            onClick={() => void act(() => request('POST', `/api/v1/packs/${buy.productId}`, { action: 'purchase', clientId, method: buy.method }), 'Pack sold — places are held as they book.')}
          >
            Sell pack
          </Button>
        </div>
      )}
    </section>
  );
}
