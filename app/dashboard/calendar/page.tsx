'use client';

/**
 * The calendar — where a receptionist spends the day.
 *
 * Day, 3-day and work-week views; click a free slot to book, drag a block to
 * move it, drag its bottom edge to change the length, and click it for the
 * actions that matter (arrived, completed, no-show, cancel, repeat, ring).
 *
 * Every move goes through `POST /v1/bookings/{id}/move`, which runs the same
 * availability check a phone booking does — so dragging cannot create the
 * double-booking that the AI just refused. When the destination is taken the
 * block springs back and the reason is shown.
 *
 * Nothing here is optimistic: the server is asked, and the grid is redrawn from
 * what it answered.
 */

import * as React from 'react';
import { ApiError, request } from '@/lib/server-sync';
import { cn } from '@/lib/utils';
import { Icons } from '@/components/icons';
import { PREF_KEYS, readPref, writePref } from '@/lib/prefs';
import { Button, EmptyState, LinkButton, Modal, Pill, Tabs, useToast } from '@/components/ui';
import { PageHeader } from '@/components/dash/Shell';
import type { Terms } from '@/lib/terms';

/* ------------------------------------------------------------------- types */

type Appointment = {
  id: string;
  externalId: string;
  clientId?: string;
  customer: { name: string; number: string; email?: string };
  service: string;
  serviceId?: string;
  serviceName?: string;
  startsAt: string;
  durationMinutes: number;
  status: 'pending' | 'confirmed' | 'arrived' | 'completed' | 'cancelled' | 'no_show';
  providerId?: string;
  providerName?: string;
  locationId?: string;
  locationName?: string;
  roomName?: string;
  value?: number;
  clientName?: string;
  hasAlerts?: boolean;
  seriesId?: string;
  caseId?: string;
  coverageId?: string;
  authorisationId?: string;
  fundingAllocation?: { state: 'committed' | 'used'; appointments: number; minutes: number; budgetMinor: number; currency: 'GBP' };
  fundingWarning?: string;
  localStart: number;
  localEnd: number;
  notes?: string;
};

type Session = {
  id: string;
  serviceId: string;
  serviceName: string;
  providerId: string;
  providerName?: string;
  locationId: string;
  locationName?: string;
  roomId?: string;
  roomName?: string;
  startsAt: string;
  durationMinutes: number;
  capacity: number;
  seats: number;
  seatsLeft: number;
  status: 'scheduled' | 'cancelled';
  localStart: number;
  localEnd: number;
};

type DiaryResponse = {
  days: { date: string; appointments: Appointment[]; sessions?: Session[]; stats: { booked: number; cancelled: number; minutes: number; classes?: number; seats?: number } }[];
  timezone: string;
  providers: { id: string; name: string; colour: string }[];
  sites?: { id: string; name: string; timezone: string }[];
  ready?: boolean;
  range: { from: string; to: string; view: string; days: number };
  terms: Terms;
  policy: { minNoticeMinutes: number; maxAdvanceDays: number; slotStepMinutes: number; weekStart: number };
};

type WaitEntry = {
  id: string;
  name: string;
  number: string;
  from: string;
  to?: string;
  notes?: string;
  status: string;
  serviceId?: string;
  providerId?: string;
};

type Service = { id: string; name: string; durationMinutes: number; colour?: string };
type BookingCaseOption = {
  id: string; patientId: string; name: string; number: string; status: string; startsOn: string; endsOn?: string;
  trackingMode: 'appointments' | 'hours' | 'budget'; coverageId?: string; limitPolicy: 'warn' | 'block'; enforcementMode: 'shadow' | 'enforced';
};
type FundingPeriodPreview = { id: string; startsOn: string; endsOn: string; allowed: { appointments: number; minutes: number; budgetMinor: number }; rollover: { appointments: number; minutes: number; budgetMinor: number }; committed: { appointments: number; minutes: number; budgetMinor: number }; used: { appointments: number; minutes: number; budgetMinor: number } };
type FundingRulePreview = { id: string; serviceId?: string; providerId?: string; locationId?: string; startsOn: string; endsOn?: string; unit: 'appointment' | 'hour'; fundedPriceMinor: number; taxRateBps: number; requiresAuthorisation: boolean; noShowPolicy: 'consume' | 'release'; lateCancelPolicy: 'consume' | 'release'; lateCancellationHours: number; active: boolean };
type FundingAuthorisationPreview = { id: string; externalReference: string; status: string; startsOn: string; endsOn: string; serviceIds: string[] };

/**
 * What each state is called on screen.
 *
 * "no_show" is a database word, not a sentence a receptionist says, and the same
 * goes for "pending" — which is really "we have not confirmed this yet". The
 * buttons use the action's own language so nobody has to decode anything.
 */
const STATUS_WORDS: Record<string, { label: string; action: string; hint: string }> = {
  pending: { label: 'Not confirmed yet', action: 'Confirm', hint: 'Booked in, but the client has not had a confirmation back.' },
  confirmed: { label: 'Booked', action: 'Confirm', hint: 'Confirmed with the client.' },
  arrived: { label: 'Here now', action: 'Arrived', hint: 'The client is in the building.' },
  completed: { label: 'Seen', action: 'Completed', hint: 'The visit happened and is ready to be written up.' },
  cancelled: { label: 'Cancelled', action: 'Cancel', hint: 'Cancelled — the slot is free again.' },
  no_show: { label: 'Did not attend', action: 'Mark as no-show', hint: 'Nobody turned up.' },
};

const VIEWS = [
  { id: 'day', label: 'Day' },
  { id: '3day', label: '3 days' },
  { id: 'week', label: 'Work week' },
];

/** The grid: 07:00 to 20:00, one pixel per minute is too tall for a laptop. */
const DAY_START = 7 * 60;
const DAY_END = 20 * 60;
const PX_PER_MIN = 0.9;

const STATUS_TONE: Record<Appointment['status'], 'brand' | 'warn' | 'danger' | 'info' | 'default'> = {
  confirmed: 'brand',
  pending: 'warn',
  arrived: 'info',
  completed: 'default',
  cancelled: 'danger',
  no_show: 'danger',
};

const COLOUR_CLASS: Record<string, string> = {
  brand: 'border-brand-400/60 bg-brand-500/15',
  emerald: 'border-emerald-400/60 bg-emerald-500/15',
  violet: 'border-violet-400/60 bg-violet-500/15',
  amber: 'border-amber-400/60 bg-amber-500/15',
  sky: 'border-sky-400/60 bg-sky-500/15',
  rose: 'border-rose-400/60 bg-rose-500/15',
};

function isoToMinutes(iso: string, dateStr: string, timezone: string) {
  // The server already computes the local offset per day; recomputing it here
  // keeps the grid honest when the browser's own timezone differs.
  const at = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  void dateStr;
  return hour * 60 + minute;
}

function clock(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function prettyLabel(clockText: string) {
  const [h, m] = clockText.split(':').map(Number);
  const suffix = h >= 12 ? 'pm' : 'am';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${hour12}:${String(m).padStart(2, '0')}${suffix}` : `${hour12}${suffix}`;
}

/**
 * What a block says about a client when privacy mode is on.
 *
 * Initials, not a blank: the desk still needs to tell two appointments apart,
 * and an empty box makes the grid useless rather than private.
 */
function maskedName(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '—';
  if (words.length === 1) return `${words[0].slice(0, 1).toUpperCase()}·`;
  return `${words[0][0].toUpperCase()}${words[words.length - 1][0].toUpperCase()}`;
}

function viewDays(view: string) {
  return view === 'day' ? 1 : view === '3day' ? 3 : 7;
}

function addDays(dateStr: string, n: number) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function weekdayName(dateStr: string) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
}

/* -------------------------------------------------------------------- page */

export default function CalendarPage() {
  const toast = useToast();
  const [view, setView] = React.useState('3day');
  const [anchor, setAnchor] = React.useState<string>('');
  const [providerFilter, setProviderFilter] = React.useState('');
  const [locationFilter, setLocationFilter] = React.useState('');
  const [data, setData] = React.useState<DiaryResponse | null>(null);
  const [waitList, setWaitList] = React.useState<WaitEntry[]>([]);
  const [services, setServices] = React.useState<Service[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [selected, setSelected] = React.useState<Appointment | null>(null);
  const [creating, setCreating] = React.useState<{ date: string; minutes: number; providerId?: string } | null>(null);
  const [repeatOpen, setRepeatOpen] = React.useState(false);
  const [dragging, setDragging] = React.useState<{ id: string; offsetY: number } | null>(null);
  // Drag events can run from dragstart through dragover/drop before React has
  // committed the state update. Keep the active payload in a ref as the wire
  // truth; state remains only for the visual highlight.
  const draggingRef = React.useRef<{ id: string; offsetY: number } | null>(null);
  const updateDragging = React.useCallback((next: { id: string; offsetY: number } | null) => {
    draggingRef.current = next;
    setDragging(next);
  }, []);
  // Privacy mode is a preference, not a record: a screen the waiting room can
  // see should not show who is coming in. The choice remembers itself.
  const [privacy, setPrivacy] = React.useState(() => readPref(PREF_KEYS.calendarPrivacy) === 'on');
  const [busy, setBusy] = React.useState(false);

  /**
   * The appointments in this view, as a file.
   *
   * The range comes from the days on screen rather than from the anchor, so what
   * downloads is what the person is looking at — a work week exports a work week.
   */
  async function exportCsv() {
    const from = days[0]?.date ?? anchor;
    const to = days[days.length - 1]?.date ?? from;
    try {
      const params = new URLSearchParams({ view: 'export', from, to });
      if (locationFilter) params.set('locationId', locationFilter);
      const res = await fetch(`/api/v1/bookings?${params.toString()}`, { credentials: 'include' });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = res.headers.get('content-disposition')?.match(/filename="(.+)"/)?.[1] ?? 'appointments.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast(`${res.headers.get('x-appointment-rows') ?? ''} ${terms.appointment.many} exported`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Export failed', 'error');
    }
  }

  const load = React.useCallback(async () => {
    try {
      const params = new URLSearchParams({ view });
      if (anchor) params.set('from', anchor);
      if (providerFilter) params.set('providerId', providerFilter);
      if (locationFilter) params.set('locationId', locationFilter);
      const [diary, wait, serviceList] = await Promise.all([
        request<DiaryResponse>('GET', `/api/v1/diary?${params.toString()}`),
        request<{ data: WaitEntry[] }>('GET', '/api/v1/wait-list'),
        request<{ data: Service[] }>('GET', '/api/v1/services'),
      ]);
      setData(diary);
      setWaitList(wait.data);
      setServices(serviceList.data);
      setAnchor((current) => current || diary.range.from);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load the diary', 'error');
    } finally {
      setLoading(false);
    }
  }, [view, anchor, providerFilter, locationFilter, toast]);

  React.useEffect(() => {
    void load();
  }, [load]);

  /**
   * Where a drop lands, in the diary's own minutes.
   *
   * The clock matters more than the arithmetic. Every number here is in the same
   * minutes the block was *drawn* in (`PX_PER_MIN` against the row's `localStart`,
   * on the practice's timezone), so a block picked up at 2pm and dropped an inch
   * lower is at 3pm — not at 10am, which is what happens when the drop maths
   * quietly uses UTC while the blocks are drawn in New York (defect D1).
   *
   * It hangs off the *column* rather than the block on purpose: a drop between the
   * blocks — which is where a person actually drops something — used to land on
   * nothing at all, because only the block had a handler.
   */
  function dropMinutes(e: React.DragEvent): number | null {
    const active = draggingRef.current;
    if (!active) return null;
    const column = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const raw = (e.clientY - column.top - active.offsetY) / PX_PER_MIN + DAY_START;
    const step = Math.max(5, data?.policy.slotStepMinutes || 15);
    const snapped = Math.min(DAY_END - step, Math.max(DAY_START, Math.round(raw / step) * step));
    const from = data?.days.find((d) => d.appointments.some((a) => a.id === active.id));
    const appointment = from?.appointments.find((a) => a.id === active.id);
    // Dropped exactly where it was picked up: nothing to say, nothing to send.
    if (appointment && from?.date === (e.currentTarget as HTMLElement).dataset.date && appointment.localStart === snapped) return null;
    return snapped;
  }

  /** Move the appointment being dragged to a day and a minute on the grid. */
  async function moveDragged(date: string, minutes: number, active = draggingRef.current) {
    if (!active) return;
    const from = data?.days.find((d) => d.appointments.some((a) => a.id === active.id));
    const appointment = from?.appointments.find((a) => a.id === active.id);
    if (!appointment) return;
    await moveTo(appointment, date, minutes);
  }

  async function moveTo(appointment: Appointment, date: string, minutes: number, opts?: { durationMinutes?: number; force?: boolean }) {
    // Build the destination instant from the grid, in the diary's own timezone.
    const timezone = data?.timezone ?? 'UTC';
    const [y, m, d] = date.split('-').map(Number);
    const hour = Math.floor(minutes / 60);
    const minute = minutes % 60;
    // Local wall clock → instant, without the browser's timezone guessing.
    const naive = Date.UTC(y, m - 1, d, hour, minute);
    const probe = new Date(naive);
    const offsetFormatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'shortOffset' });
    const offsetText = offsetFormatter.formatToParts(probe).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
    const match = /GMT([+-]\d+)(?::(\d+))?/.exec(offsetText);
    const offsetMinutes = match ? Number(match[1]) * 60 + Number(match[2] ?? 0) * (Number(match[1]) < 0 ? -1 : 1) : 0;
    const startsAt = new Date(naive - offsetMinutes * 60_000).toISOString();

    setBusy(true);
    try {
      await request('POST', `/api/v1/bookings/${appointment.id}/move`, {
        startsAt,
        durationMinutes: opts?.durationMinutes ?? appointment.durationMinutes,
        force: opts?.force,
      });
      toast(`Moved to ${prettyLabel(clock(minutes))}.`);
      await load();
      setSelected(null);
    } catch (err) {
      // A refusal is the point of the engine: say exactly why, and put the block
      // back where it was by simply re-reading the diary.
      toast(err instanceof ApiError ? err.message : 'Move refused', 'error');
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(appointment: Appointment, status: Appointment['status']) {
    setBusy(true);
    try {
      const result = await request<{
        booking: Appointment;
        waitListMatches?: WaitEntry[];
        offers?: { offered: number; names: string[]; skipped: number };
      }>('POST', `/api/v1/bookings/${appointment.id}/status`, { status });
      toast(`${appointment.customer.name} → ${status}.`);
      // The freed time is offered the moment it frees, not left as a name on a
      // toast: each person whose window it falls inside gets their own link.
      if (result.offers?.names.length) {
        toast(
          `Offered the freed time to ${result.offers.names.map((n) => (privacy ? maskedName(n) : n)).join(', ')} — first to take it gets it.`,
          'info'
        );
      } else if (result.waitListMatches?.length) {
        toast(
          `${result.waitListMatches.length} waiting ${result.waitListMatches.length === 1 ? 'client wants' : 'clients want'} that slot: ${result.waitListMatches
            .map((w) => (privacy ? maskedName(w.name) : w.name))
            .join(', ')}`,
          'info'
        );
      }
      setSelected(null);
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Update refused', 'error');
    } finally {
      setBusy(false);
    }
  }

  const days = data?.days ?? [];
  // With more than one site in the diary, every block has to say which building
  // it is in — the room alone would send somebody to the wrong town.
  const sites = data?.sites ?? [];
  const showSite = sites.length > 1;
  const terms: Terms =
    data?.terms ?? {
      client: { one: 'client', many: 'clients', One: 'Client', Many: 'Clients' },
      provider: { one: 'team member', many: 'team members', One: 'Team member', Many: 'Team members' },
      service: { one: 'service', many: 'services', One: 'Service', Many: 'Services' },
      appointment: { one: 'appointment', many: 'appointments', One: 'Appointment', Many: 'Appointments' },
      note: { one: 'note', many: 'notes', One: 'Note', Many: 'Notes' },
      location: { one: 'location', many: 'locations', One: 'Location', Many: 'Locations' },
    };

  const gridHeight = (DAY_END - DAY_START) * PX_PER_MIN;
  const hourMarks = Array.from({ length: (DAY_END - DAY_START) / 60 + 1 }, (_, i) => DAY_START + i * 60);

  return (
    <>
      <PageHeader
        title="Calendar"
        desc={`The diary, live. Drag to move, pull the bottom edge to extend, click to act. ${data?.timezone ?? ''}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAnchor(addDays(anchor || new Date().toISOString().slice(0, 10), -viewDays(view)))}
              aria-label="Previous"
            >
              <Icons.chevronDown size={14} className="rotate-90" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setAnchor('');
                void load();
              }}
            >
              Today
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAnchor(addDays(anchor || new Date().toISOString().slice(0, 10), viewDays(view)))}
              aria-label="Next"
            >
              <Icons.chevronRight size={14} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={privacy}
              title={privacy ? 'Show client names' : 'Hide client names on the grid'}
              onClick={() => {
                const next = !privacy;
                setPrivacy(next);
                writePref(PREF_KEYS.calendarPrivacy, next ? 'on' : 'off');
              }}
            >
              <Icons.eye size={14} className={privacy ? 'opacity-40' : ''} />
              {privacy ? 'Private' : 'Names'}
            </Button>
            <Button
              variant="quiet"
              size="sm"
              title="Download the appointments in this view as a spreadsheet"
              onClick={() => void exportCsv()}
            >
              Export
            </Button>
            <Button variant="brand" size="sm" onClick={() => setCreating({ date: days[0]?.date ?? anchor, minutes: 9 * 60 })}>
              <Icons.plus size={14} /> New {terms.appointment.one}
            </Button>
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Tabs active={view} onChange={setView} tabs={VIEWS} size="sm" />
        <select className="field h-9 w-[180px] py-1 text-[12.5px]" value={providerFilter} onChange={(e) => setProviderFilter(e.target.value)} aria-label="Filter by provider">
          <option value="">Everyone</option>
          {(data?.providers ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {/* Which building — only worth asking when there is more than one. */}
        {showSite && (
          <select className="field h-9 w-[210px] py-1 text-[12.5px]" value={locationFilter} onChange={(e) => setLocationFilter(e.target.value)} aria-label="Filter by site">
            <option value="">All sites</option>
            {sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </select>
        )}
        <div className="ml-auto flex items-center gap-3 text-[12px] text-slateink-400">
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm border border-brand-400/60 bg-brand-500/20" /> booked
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm border border-slate-900/[0.09] bg-slate-900/[0.06]" /> free
          </span>
          <span>{days.reduce((sum, d) => sum + d.stats.booked, 0)} on this view</span>
        </div>
      </div>

      {loading && !data ? (
        <div className="panel h-[600px] animate-pulse bg-ink-850/40" />
      ) : days.length === 0 ? (
        <EmptyState icon="calendar" title="Nothing to draw" desc="No days came back for this range." />
      ) : data?.ready === false ? (
        <EmptyState
          icon="calendar"
          title="Your diary has nothing to book into yet"
          desc="Add what you do and somebody to do it, and this grid fills up with their working day — the AI and the booking page use exactly the same hours."
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <LinkButton href="/dashboard/practice?tab=services" variant="brand" size="sm">
                Add a service
              </LinkButton>
              <LinkButton href="/dashboard/practice?tab=team" variant="quiet" size="sm">
                Add a practitioner
              </LinkButton>
            </div>
          }
        />
      ) : (
        <div className="panel overflow-hidden">
          <div className="flex border-b border-slate-900/[0.045] bg-ink-900/50">
            <div className="w-16 shrink-0" />
            {days.map((day) => (
              <div key={day.date} className="flex-1 border-l border-slate-900/[0.035] px-3 py-2.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[12.5px] text-slate-900">
                    {weekdayName(day.date)} <span className="text-slateink-400">{day.date.slice(8)}</span>
                  </span>
                  <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-slateink-500">
                    {day.stats.booked} booked · {Math.round(day.stats.minutes / 60)}h
                  </span>
                </div>
              </div>
            ))}
          </div>

          <div className="relative flex max-h-[70vh] overflow-auto">
            <div className="relative w-16 shrink-0" style={{ height: gridHeight }}>
              {hourMarks.map((mark) => (
                <div key={mark} className="absolute right-2 -translate-y-1/2 font-mono text-[10.5px] text-slateink-500" style={{ top: (mark - DAY_START) * PX_PER_MIN }}>
                  {clock(mark)}
                </div>
              ))}
            </div>

            {days.map((day) => (
              <div
                key={day.date}
                className={cn(
                  'relative flex-1 border-l border-slate-900/[0.035] transition-colors',
                  dragging && 'bg-brand-500/[0.04] ring-1 ring-inset ring-brand-500/25'
                )}
                style={{ height: gridHeight }}
                data-date={day.date}
                onDragOver={(e) => {
                  if (draggingRef.current) e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const active = draggingRef.current;
                  const minutes = dropMinutes(e);
                  updateDragging(null);
                  if (minutes === null || !active) return;
                  void moveDragged(day.date, minutes, active);
                }}
              >
                {hourMarks.map((mark) => (
                  <div key={mark} className="absolute left-0 right-0 border-t border-slate-900/[0.04]" style={{ top: (mark - DAY_START) * PX_PER_MIN }} />
                ))}

                {/* Click an empty half-hour to book there. */}
                {Array.from({ length: (DAY_END - DAY_START) / 30 }, (_, i) => DAY_START + i * 30).map((minutes) => (
                  <button
                    key={minutes}
                    className="absolute left-0 right-0 opacity-0 hover:bg-slate-900/[0.03] hover:opacity-100"
                    style={{ top: (minutes - DAY_START) * PX_PER_MIN, height: 30 * PX_PER_MIN }}
                    onClick={() => setCreating({ date: day.date, minutes })}
                    aria-label={`New appointment ${day.date} ${clock(minutes)}`}
                  />
                ))}

                {day.appointments.map((appointment) => {
                  const start = Math.max(appointment.localStart, DAY_START);
                  const end = Math.min(appointment.localEnd, DAY_END);
                  if (end <= DAY_START || start >= DAY_END) return null;
                  const provider = data?.providers.find((p) => p.id === appointment.providerId);
                  const cancelled = appointment.status === 'cancelled';
                  return (
                    <div
                      key={appointment.id}
                      draggable={!cancelled}
                      onDragStart={(e) => {
                        const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        updateDragging({ id: appointment.id, offsetY: e.clientY - box.top });
                      }}
                      onDragEnd={() => updateDragging(null)}
                      // The column owns the drop (see below) — the block only has to
                      // keep the browser from refusing a drop that lands on itself.
                      onDragOver={(e) => {
                        if (draggingRef.current) e.preventDefault();
                      }}
                      onClick={() => setSelected(appointment)}
                      className={cn(
                        'group absolute left-1 right-1 cursor-pointer overflow-hidden rounded-lg border px-2 py-1.5 text-left transition-shadow hover:shadow-lg',
                        COLOUR_CLASS[provider?.colour ?? 'brand'] ?? COLOUR_CLASS.brand,
                        // A cancelled ghost is context, not a control: left
                        // interactive it sits on top of any live block drawn
                        // in the same slot and swallows its drag and clicks.
                        // Keep cancelled records legible: whole-card opacity made
                        // every child fail WCAG contrast. The strike-through and
                        // disabled interaction already communicate cancellation.
                        cancelled && 'pointer-events-none line-through',
                        busy && 'pointer-events-none'
                      )}
                      style={{ top: (start - DAY_START) * PX_PER_MIN, height: Math.max(22, (end - start) * PX_PER_MIN) }}
                      title={privacy ? `${appointment.serviceName ?? appointment.service}` : `${appointment.customer.name} · ${appointment.serviceName ?? appointment.service}`}
                    >
                      <div className="flex items-center gap-1">
                        <span className="font-mono text-[10.5px] text-slate-900/80">{prettyLabel(clock(appointment.localStart))}</span>
                        {appointment.hasAlerts && (
                          <span className="rounded bg-amber-400/20 px-1 text-[9.5px] uppercase tracking-wider text-amber-800" title="This client has an alert on file">
                            alert
                          </span>
                        )}
                        {appointment.caseId && (
                          <span className="rounded bg-brand-500/15 px-1 text-[9.5px] uppercase tracking-wider text-brand-800" title="Case-funded appointment">
                            case
                          </span>
                        )}
                        {appointment.seriesId && (
                          <Icons.refresh size={10} className="text-slate-900/70" />
                        )}
                      </div>
                      <div className="truncate text-[12px] font-medium text-slate-900">
                        {privacy ? <span title="Client name hidden by privacy mode">{maskedName(appointment.customer.name)}</span> : appointment.customer.name}
                      </div>
                      <div className="truncate text-[10.5px] text-slate-900/75">
                        {appointment.serviceName ?? appointment.service}
                        {appointment.providerName ? ` · ${appointment.providerName}` : ''}
                      </div>
                      {/* Where to walk: the room, and the site when the diary is
                          showing more than one. A name is no use without a door. */}
                      {(appointment.roomName || showSite) && (
                        <div className="truncate text-[10px] text-slate-900/70">
                          {[showSite ? appointment.locationName : undefined, appointment.roomName].filter(Boolean).join(' · ')}
                        </div>
                      )}
                      {/* Pull the bottom edge to change the length. */}
                      {!cancelled && (
                        <span
                          className="absolute bottom-0 left-0 right-0 h-1.5 cursor-ns-resize bg-slate-900/10 opacity-0 group-hover:opacity-100"
                          onClick={(e) => e.stopPropagation()}
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            // The block is `draggable`, and a press-and-move anywhere
                            // inside a draggable element starts a *drag* — including a
                            // press on this handle, which would move the appointment
                            // instead of lengthening it. Cancelling the default action
                            // is what lets the browser hand the gesture to this handler.
                            e.preventDefault();
                            const handle = e.currentTarget;
                            const box = (handle.parentElement as HTMLElement).getBoundingClientRect();
                            const startY = e.clientY;
                            const durationFor = (clientY: number) => {
                              const delta = Math.round(((clientY - startY) / PX_PER_MIN) / 5) * 5;
                              return Math.max(5, appointment.durationMinutes + delta);
                            };
                            const move = (ev: MouseEvent) => {
                              const delta = durationFor(ev.clientY) - appointment.durationMinutes;
                              handle.style.transform = `translateY(${delta * PX_PER_MIN}px)`;
                            };
                            const up = (ev: MouseEvent) => {
                              window.removeEventListener('mousemove', move);
                              window.removeEventListener('mouseup', up);
                              const durationMinutes = durationFor(ev.clientY);
                              void box;
                              if (durationMinutes !== appointment.durationMinutes) {
                                void moveTo(appointment, day.date, appointment.localStart, { durationMinutes });
                              }
                            };
                            window.addEventListener('mousemove', move);
                            window.addEventListener('mouseup', up);
                          }}
                          title="Drag to change the length"
                        />
                      )}
                    </div>
                  );
                })}

                {/*
                  Classes (A8). One block per session, whatever the roster — the
                  seats are people *in* it, not eight appointments in the same room.
                  Not draggable: a class belongs to everyone in it, so moving it is
                  a decision the desk makes on the classes page, not a slip of the
                  mouse here. It still blocks the room and the instructor against
                  everything else.
                */}
                {(day.sessions ?? []).map((session) => {
                  const start = Math.max(session.localStart, DAY_START);
                  const end = Math.min(session.localEnd, DAY_END);
                  if (end <= DAY_START || start >= DAY_END) return null;
                  const full = session.seatsLeft <= 0;
                  return (
                    <a
                      key={session.id}
                      href={`/dashboard/classes?session=${session.id}`}
                      className={cn(
                        'absolute left-1 right-1 overflow-hidden rounded-lg border border-dashed px-2 py-1.5 text-left transition hover:shadow-lg',
                        session.status === 'cancelled'
                          ? 'border-slate-900/[0.12] bg-slate-900/[0.05] line-through'
                          : full
                            ? 'border-amber-300/40 bg-amber-400/[0.10]'
                            : 'border-brand-300/40 bg-brand-500/[0.10]'
                      )}
                      style={{ top: (start - DAY_START) * PX_PER_MIN, height: Math.max(22, (end - start) * PX_PER_MIN) }}
                      title={`${session.serviceName} · ${session.seats} of ${session.capacity} places taken${session.providerName ? ` · ${session.providerName}` : ''}`}
                    >
                      <div className="flex items-center gap-1">
                        <span className="font-mono text-[10.5px] text-slate-900/80">{prettyLabel(clock(session.localStart))}</span>
                        <span className="rounded border border-slate-900/20 bg-ink-900 px-1 text-[9.5px] uppercase tracking-wider text-slate-900">class</span>
                        <span className={cn('font-mono text-[10px]', full ? 'text-amber-800' : 'text-slate-900/90')}>
                          {session.seats}/{session.capacity}
                        </span>
                      </div>
                      <div className="truncate text-[12px] font-medium text-slate-900">{session.serviceName}</div>
                      <div className="truncate text-[10.5px] text-slate-900/75">
                        {[session.providerName, showSite ? session.locationName : undefined, session.roomName].filter(Boolean).join(' · ') || 'no instructor set'}
                      </div>
                    </a>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------- wait list */}
      <div className="panel mt-6 p-5">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="h4">Wait list</h3>
            <p className="mt-0.5 text-[12.5px] text-slateink-400">
              People who wanted a slot that did not exist. A cancellation looks through this list automatically.
            </p>
          </div>
          <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-slateink-400">{waitList.length} waiting</span>
        </div>
        {waitList.length === 0 ? (
          <p className="text-[12.5px] text-slateink-500">Nobody is waiting.</p>
        ) : (
          <ul className="grid gap-2 md:grid-cols-2">
            {waitList.map((entry) => (
              <li key={entry.id} className="flex items-center gap-3 rounded-xl border border-slate-900/[0.04] bg-ink-900/40 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] text-slate-900">{privacy ? maskedName(entry.name) : entry.name}</div>
                  <div className="truncate font-mono text-[11px] text-slateink-400">
                    {entry.from}
                    {entry.to ? ` → ${entry.to}` : ''} {entry.number}
                  </div>
                </div>
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() => setCreating({ date: entry.from, minutes: 9 * 60 })}
                >
                  Book in
                </Button>
                <button
                  className="text-slateink-500 hover:text-rose-700"
                  onClick={() =>
                    void request('DELETE', `/api/v1/wait-list/${entry.id}`)
                      .then(() => {
                        toast('Removed from the wait list.');
                        return load();
                      })
                      .catch((e) => toast(e instanceof ApiError ? e.message : 'Failed', 'error'))
                  }
                  aria-label={privacy ? 'Remove this waiting client' : `Remove ${entry.name}`}
                >
                  <Icons.close size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <AppointmentSheet
        appointment={selected}
        data={data}
        busy={busy}
        onClose={() => setSelected(null)}
        onStatus={(status) => selected && void setStatus(selected, status)}
        onMove={(date, minutes) => selected && void moveTo(selected, date, minutes)}
        onRepeat={() => setRepeatOpen(true)}
      />

      <NewAppointmentModal
        open={!!creating}
        onClose={() => setCreating(null)}
        when={creating}
        services={services}
        providers={data?.providers ?? []}
        timezone={data?.timezone ?? 'UTC'}
        term={terms.appointment.one}
        onCreated={() => {
          setCreating(null);
          void load();
        }}
        onRepeat={() => setRepeatOpen(true)}
      />

      <RepeatModal
        open={repeatOpen}
        onClose={() => setRepeatOpen(false)}
        appointment={selected}
        term={terms.appointment.one}
        onDone={() => {
          setRepeatOpen(false);
          setSelected(null);
          void load();
        }}
      />
    </>
  );
}

/* --------------------------------------------------------- appointment sheet */

function AppointmentSheet({
  appointment,
  data,
  busy,
  onClose,
  onStatus,
  onMove,
  onRepeat,
}: {
  appointment: Appointment | null;
  data: DiaryResponse | null;
  busy: boolean;
  onClose: () => void;
  onStatus: (status: Appointment['status']) => void;
  onMove: (date: string, minutes: number) => void;
  onRepeat: () => void;
}) {
  if (!appointment) return null;
  const nativeNext: Appointment['status'][] = appointment.status === 'confirmed' ? ['arrived', 'completed', 'no_show', 'cancelled'] : appointment.status === 'arrived' ? ['completed'] : appointment.status === 'pending' ? ['confirmed', 'cancelled'] : ['confirmed'];
  const nextStatuses = nativeNext;

  return (
    <Modal
      open
      onClose={onClose}
      title={`${appointment.customer.name} · ${prettyLabel(clock(appointment.localStart))}`}
      desc={`${appointment.serviceName ?? appointment.service} · ${appointment.durationMinutes} min${appointment.providerName ? ` with ${appointment.providerName}` : ''}${appointment.roomName ? ` · ${appointment.roomName}` : ''}`}
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <Pill tone={STATUS_TONE[appointment.status]}>{STATUS_WORDS[appointment.status]?.label ?? appointment.status}</Pill>
            <span className="text-[11.5px] text-slateink-400">{STATUS_WORDS[appointment.status]?.hint}</span>
            {appointment.seriesId && <Pill tone="default">repeat series</Pill>}
            {appointment.hasAlerts && <Pill tone="warn">alert on file</Pill>}
          </span>
          <span className="flex flex-wrap gap-2">
            {nextStatuses.map((status) => (
              <Button key={status} variant={status === 'cancelled' ? 'ghost' : 'brand'} size="sm" disabled={busy} onClick={() => onStatus(status)}>
                {STATUS_WORDS[status]?.action ?? status.charAt(0).toUpperCase() + status.slice(1)}
              </Button>
            ))}
          </span>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-slate-900/[0.04] bg-ink-900/40 p-3">
            <div className="label">Client</div>
            <div className="text-[13px] text-slate-900">{appointment.clientName ?? appointment.customer.name}</div>
            <div className="font-mono text-[11.5px] text-slateink-400">{appointment.customer.number}</div>
            {appointment.clientId && (
              <a className="mt-1 inline-block text-[12px] text-brand-700 hover:underline" href={`/dashboard/clients?client=${appointment.clientId}`}>
                Open the record
              </a>
            )}
          </div>
          <div className="rounded-xl border border-slate-900/[0.04] bg-ink-900/40 p-3">
            <div className="label">When</div>
            <div className="font-mono text-[12.5px] text-slate-900">
              {prettyLabel(clock(appointment.localStart))} – {prettyLabel(clock(appointment.localEnd))}
              {appointment.providerName ? ` · ${appointment.providerName}` : ''}
            </div>
            {appointment.value ? <div className="mt-1 text-[12px] text-slateink-400">${(appointment.value / 100).toFixed(2)}</div> : null}
          </div>
        </div>

        {appointment.caseId ? (
          <div className="rounded-xl border border-brand-500/15 bg-brand-50/60 p-3 text-[11.5px] text-brand-900">
            <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">Case-funded appointment</span><Pill tone={appointment.fundingAllocation?.state === 'used' ? 'default' : 'brand'}>{appointment.fundingAllocation?.state ?? 'not allocated'}</Pill></div>
            {appointment.fundingAllocation ? <p className="mt-1">Effect: {appointment.fundingAllocation.appointments} appointment · {appointment.fundingAllocation.minutes} minutes · £{(appointment.fundingAllocation.budgetMinor / 100).toFixed(2)}</p> : null}
            {appointment.fundingWarning ? <p className="mt-1 text-amber-800">{appointment.fundingWarning}</p> : null}
          </div>
        ) : null}

        {appointment.notes && <p className="rounded-xl border border-slate-900/[0.04] bg-ink-900/40 p-3 text-[12.5px] text-slateink-300">{appointment.notes}</p>}

        <div>
          <div className="label">Move</div>
          <div className="flex flex-wrap gap-2">
            {[30, 60, 120].map((minutes) => (
              <Button key={minutes} variant="ghost" size="sm" disabled={busy} onClick={() => onMove(currentDate(appointment), appointment.localStart + minutes)}>
                +{minutes}m later
              </Button>
            ))}
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => onMove(addDays(currentDate(appointment), 1), appointment.localStart)}>
              Tomorrow
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => onMove(addDays(currentDate(appointment), 7), appointment.localStart)}>
              Next week
            </Button>
          </div>
          <p className="mt-2 text-[12px] text-slateink-500">
            Moving past closing time, into a break, or onto another appointment is refused by the engine — the block stays put and tells you why.
            {data ? ` Diary clock: ${data.timezone}.` : ''}
          </p>
        </div>

        <div className="flex flex-wrap gap-2 border-t border-slate-900/[0.04] pt-4">
          <Button variant="ghost" size="sm" disabled={busy} onClick={onRepeat}>
            <Icons.refresh size={14} /> Repeat this appointment
          </Button>
          <a className="btn-ghost btn-sm" href={`/dashboard/calls?number=${encodeURIComponent(appointment.customer.number)}`}>
            <Icons.phone size={14} /> Call history
          </a>
        </div>
      </div>
    </Modal>
  );
}

function currentDate(appointment: Appointment) {
  return new Date(appointment.startsAt).toISOString().slice(0, 10);
}

/* -------------------------------------------------------------- new booking */

function NewAppointmentModal({
  open,
  onClose,
  when,
  services,
  providers,
  timezone,
  term,
  onCreated,
  onRepeat,
}: {
  open: boolean;
  onClose: () => void;
  when: { date: string; minutes: number; providerId?: string } | null;
  services: Service[];
  providers: { id: string; name: string }[];
  timezone: string;
  term: string;
  onCreated: () => void;
  onRepeat: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = React.useState({ name: '', number: '', email: '', serviceId: '', providerId: '', durationMinutes: 30, notes: '', caseId: '', coverageId: '', authorisationId: '' });
  const [caseOptions, setCaseOptions] = React.useState<BookingCaseOption[]>([]);
  const [caseDetail, setCaseDetail] = React.useState<{ fundingPeriods: FundingPeriodPreview[]; serviceRules: FundingRulePreview[]; authorisations: FundingAuthorisationPreview[] } | null>(null);
  const [matchedClientId, setMatchedClientId] = React.useState('');
  const [caseLookup, setCaseLookup] = React.useState<'idle' | 'loading' | 'none' | 'matched'>('idle');
  const [saving, setSaving] = React.useState(false);
  const [conflict, setConflict] = React.useState<{ message: string; alternatives: string[] } | null>(null);

  React.useEffect(() => {
    if (open) {
      setForm((f) => ({ ...f, serviceId: f.serviceId || services[0]?.id || '', providerId: f.providerId || when?.providerId || '', durationMinutes: services[0]?.durationMinutes ?? 30, caseId: '', coverageId: '', authorisationId: '' }));
      setCaseOptions([]);
      setCaseDetail(null);
      setMatchedClientId('');
      setCaseLookup('idle');
      setConflict(null);
    }
  }, [open, services, when]);

  React.useEffect(() => {
    if (!open || form.number.replace(/\D/g, '').length < 7) {
      setCaseOptions([]); setMatchedClientId(''); setCaseLookup('idle');
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      setCaseLookup('loading');
      void request<{ data: Array<{ id: string; name: string; number: string }> }>('GET', `/api/v1/clients?q=${encodeURIComponent(form.number)}&limit=10`)
        .then(async (body) => {
          if (!live) return;
          const normal = (value: string) => value.replace(/[^\d+]/g, '');
          const exact = (body.data ?? []).filter((client) => normal(client.number) === normal(form.number));
          if (exact.length !== 1) {
            setCaseOptions([]); setMatchedClientId(''); setCaseLookup('none');
            return;
          }
          const client = exact[0]!;
          setMatchedClientId(client.id);
          if (!form.name.trim()) setForm((current) => ({ ...current, name: client.name }));
          const casesBody = await request<{ data: BookingCaseOption[] }>('GET', `/api/v1/cases?patientId=${encodeURIComponent(client.id)}`);
          if (!live) return;
          const active = (casesBody.data ?? []).filter((row) => row.status === 'active' && row.startsOn <= (when?.date ?? '') && (!row.endsOn || row.endsOn >= (when?.date ?? '')));
          setCaseOptions(active);
          setCaseLookup(active.length ? 'matched' : 'none');
        })
        .catch(() => { if (live) { setCaseOptions([]); setMatchedClientId(''); setCaseLookup('none'); } });
    }, 350);
    return () => { live = false; window.clearTimeout(timer); };
  }, [open, form.number, form.name, when?.date]);

  React.useEffect(() => {
    if (!open || !form.caseId) { setCaseDetail(null); return; }
    let live = true;
    void request<{ fundingPeriods: FundingPeriodPreview[]; serviceRules: FundingRulePreview[]; authorisations: FundingAuthorisationPreview[] }>('GET', `/api/v1/cases/${encodeURIComponent(form.caseId)}`)
      .then((body) => { if (live) setCaseDetail(body); })
      .catch(() => { if (live) setCaseDetail(null); });
    return () => { live = false; };
  }, [open, form.caseId]);

  if (!open || !when) return null;
  const slot = when;
  const selectedCase = caseOptions.find((row) => row.id === form.caseId);
  const fundingPeriod = caseDetail?.fundingPeriods.find((row) => row.startsOn <= slot.date && row.endsOn >= slot.date);
  const matchingRules = (caseDetail?.serviceRules ?? []).filter((row) => row.active && row.startsOn <= slot.date && (!row.endsOn || row.endsOn >= slot.date) && (!row.serviceId || row.serviceId === form.serviceId) && (!row.providerId || row.providerId === form.providerId) && !row.locationId)
    .map((row) => ({ row, specificity: Number(Boolean(row.serviceId)) + Number(Boolean(row.providerId)) }))
    .sort((a, b) => b.specificity - a.specificity || a.row.id.localeCompare(b.row.id));
  const fundingRule = matchingRules.length && (matchingRules.length === 1 || matchingRules[0]!.specificity > matchingRules[1]!.specificity) ? matchingRules[0]!.row : undefined;
  const fundingNetMinor = fundingRule ? (fundingRule.unit === 'appointment' ? fundingRule.fundedPriceMinor : Math.round(fundingRule.fundedPriceMinor * form.durationMinutes / 60)) : 0;
  const fundingBudgetMinor = fundingRule ? fundingNetMinor + Math.round(fundingNetMinor * fundingRule.taxRateBps / 10_000) : 0;
  const fundingEffect = selectedCase ? {
    appointments: 1,
    minutes: form.durationMinutes,
    budgetMinor: fundingBudgetMinor,
  } : undefined;
  const fundingMissing = selectedCase
    ? !fundingPeriod ? 'No funding period covers this date.'
      : !fundingRule ? (matchingRules.length > 1 ? 'More than one equally specific service rule matches.' : 'No service rule matches this service and practitioner.')
        : fundingRule.requiresAuthorisation && !form.authorisationId ? 'This service requires an explicit authorisation.'
          : undefined
    : undefined;
  const fundingMetric = selectedCase?.trackingMode === 'hours' ? 'minutes' : selectedCase?.trackingMode === 'budget' ? 'budgetMinor' : 'appointments';
  const fundingBefore = fundingPeriod ? fundingPeriod.committed[fundingMetric] + fundingPeriod.used[fundingMetric] : 0;
  const fundingCapacity = fundingPeriod ? fundingPeriod.allowed[fundingMetric] + fundingPeriod.rollover[fundingMetric] : 0;
  const fundingDelta = fundingEffect ? fundingEffect[fundingMetric] : 0;
  const fundingUnits = (value: number) => selectedCase?.trackingMode === 'budget' ? `£${(value / 100).toFixed(2)}` : selectedCase?.trackingMode === 'hours' ? `${(value / 60).toFixed(value % 60 ? 1 : 0)} h` : `${value} appointment${value === 1 ? '' : 's'}`;

  async function submit() {
    if (!form.name.trim() || !form.number.trim()) {
      toast('A name and a number — it is what the confirmation uses.', 'error');
      return;
    }
    if (form.caseId && fundingMissing) {
      toast(fundingMissing, 'error');
      return;
    }
    setSaving(true);
    setConflict(null);
    try {
      const [y, m, d] = slot.date.split('-').map(Number);
      const hour = Math.floor(slot.minutes / 60);
      const minute = slot.minutes % 60;
      const offsetText = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'shortOffset' })
        .formatToParts(new Date(Date.UTC(y, m - 1, d, hour, minute)))
        .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
      const match = /GMT([+-]\d+)(?::(\d+))?/.exec(offsetText);
      const offsetMinutes = match ? Number(match[1]) * 60 + Number(match[2] ?? 0) * (Number(match[1]) < 0 ? -1 : 1) : 0;
      const startsAt = new Date(Date.UTC(y, m - 1, d, hour, minute) - offsetMinutes * 60_000).toISOString();

      await request('POST', '/api/v1/bookings', {
        externalId: `dash-${Date.now().toString(36)}`,
        customer: { name: form.name, number: form.number, email: form.email || undefined },
        startsAt,
        serviceId: form.serviceId || undefined,
        providerId: form.providerId || undefined,
        durationMinutes: form.durationMinutes,
        notes: form.notes || undefined,
        caseId: form.caseId || undefined,
        coverageId: form.coverageId || undefined,
        authorisationId: form.authorisationId || undefined,
      });
      toast(`${form.name} booked for ${prettyLabel(clock(slot.minutes))}.`);
      onCreated();
    } catch (err) {
      // 409 is the interesting case: the slot went while the form was open.
      if (err instanceof ApiError && err.status === 409) {
        const alternatives = await request<{ data: { local: { date: string; start: string } }[] }>(
          'GET',
          `/api/v1/availability?from=${slot.date}&days=3&limit=3${form.serviceId ? `&serviceId=${form.serviceId}` : ''}${form.providerId ? `&providerId=${form.providerId}` : ''}`
        ).catch(() => ({ data: [] }));
        setConflict({ message: err.message, alternatives: alternatives.data.map((s) => `${s.local.date} ${s.local.start}`) });
      } else {
        toast(err instanceof ApiError ? err.message : 'Booking failed', 'error');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`New ${term}`}
      desc={`${slot.date} at ${prettyLabel(clock(slot.minutes))} · ${timezone}`}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="brand" size="sm" disabled={saving} onClick={() => void submit()}>
            {saving ? 'Booking…' : 'Book it'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {conflict && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.07] p-3 text-[12.5px] text-amber-800">
            <div className="font-medium">That slot went while you were typing.</div>
            <p className="mt-1">{conflict.message}</p>
            {conflict.alternatives.length > 0 && <p className="mt-1">Free soon: {conflict.alternatives.join(', ')}</p>}
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="n-name">
              Name
            </label>
            <input id="n-name" className="field text-[13px]" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="n-number">
              Phone
            </label>
            <input id="n-number" className="field font-mono text-[12.5px]" placeholder="+14155550123" value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="n-email">
            Email (optional)
          </label>
          <input id="n-email" className="field text-[13px]" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor="n-service">
              Service
            </label>
            <select
              id="n-service"
              className="field text-[13px]"
              value={form.serviceId}
              onChange={(e) => {
                const service = services.find((s) => s.id === e.target.value);
                setForm({ ...form, serviceId: e.target.value, durationMinutes: service?.durationMinutes ?? form.durationMinutes });
              }}
            >
              <option value="">No service</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.durationMinutes}m
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="n-provider">
              With
            </label>
            <select id="n-provider" className="field text-[13px]" value={form.providerId} onChange={(e) => setForm({ ...form, providerId: e.target.value })}>
              <option value="">Anyone free</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="n-duration">
              Minutes
            </label>
            <input
              id="n-duration"
              type="number"
              min={5}
              step={5}
              className="field text-[13px]"
              value={form.durationMinutes}
              onChange={(e) => setForm({ ...form, durationMinutes: Number(e.target.value) })}
            />
          </div>
        </div>
        <div className="rounded-xl border border-slate-900/[0.05] bg-slate-900/[0.02] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><label className="label mb-0" htmlFor="n-case">Case & funding</label><span className="text-[10.5px] text-slateink-400">{caseLookup === 'loading' ? 'Checking exact client match…' : matchedClientId ? 'Exact client match' : 'Enter an existing client number to load cases'}</span></div>
          <select
            id="n-case"
            className="field mt-2 text-[12.5px]"
            value={form.caseId}
            onChange={(event) => {
              const picked = caseOptions.find((row) => row.id === event.target.value);
              setForm({ ...form, caseId: event.target.value, coverageId: picked?.coverageId ?? '', authorisationId: '' });
            }}
          >
            <option value="">No case — do not allocate funding</option>
            {caseOptions.map((row) => <option key={row.id} value={row.id}>{row.name} · {row.number} · {row.trackingMode}</option>)}
          </select>
          {caseLookup === 'none' && form.number.replace(/\D/g, '').length >= 7 ? <p className="mt-2 text-[11px] text-slateink-400">No single exact client match with an active case on this date. Voxera will not guess.</p> : null}
          {selectedCase && fundingRule?.requiresAuthorisation ? (
            <div className="mt-3"><label className="label" htmlFor="n-authorisation">Authorisation</label><select id="n-authorisation" className="field text-[12.5px]" value={form.authorisationId} onChange={(event) => setForm({ ...form, authorisationId: event.target.value })}><option value="">Select an active authorisation</option>{(caseDetail?.authorisations ?? []).filter((row) => row.status === 'active' && row.startsOn <= slot.date && row.endsOn >= slot.date && (!row.serviceIds.length || row.serviceIds.includes(form.serviceId))).map((row) => <option key={row.id} value={row.id}>{row.externalReference} · ends {row.endsOn}</option>)}</select></div>
          ) : null}
          {selectedCase ? (
            <div className={`mt-3 rounded-lg border p-3 text-[11.5px] ${fundingMissing ? 'border-amber-400/30 bg-amber-50 text-amber-900' : 'border-emerald-400/25 bg-emerald-50 text-emerald-900'}`}>
              {fundingMissing ? <p className="font-medium">Blocked: {fundingMissing}</p> : <><p className="font-medium">Deterministic effect before save</p><p className="mt-1">Commit {fundingEffect?.appointments} appointment · {fundingEffect?.minutes} minutes · £{((fundingEffect?.budgetMinor ?? 0) / 100).toFixed(2)}.</p><p className="mt-1">Tracked balance becomes {fundingUnits(fundingBefore + fundingDelta)} of {fundingUnits(fundingCapacity)} for this period. Policy: {selectedCase.limitPolicy}/{selectedCase.enforcementMode}.</p><p className="mt-1">No-show: {fundingRule?.noShowPolicy}; late cancellation within {fundingRule?.lateCancellationHours}h: {fundingRule?.lateCancelPolicy}.</p></>}
            </div>
          ) : null}
        </div>
        <div>
          <label className="label" htmlFor="n-notes">
            Notes
          </label>
          <textarea id="n-notes" rows={2} className="field text-[13px]" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </div>
        <div className="flex items-center justify-between border-t border-slate-900/[0.04] pt-3">
          <span className="text-[12px] text-slateink-400">Need this repeated?</span>
          <Button variant="ghost" size="sm" onClick={onRepeat} disabled={!form.name || !form.number}>
            <Icons.refresh size={14} /> Create repeating series
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ repeats */

function RepeatModal({
  open,
  onClose,
  appointment,
  term,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  appointment: Appointment | null;
  term: string;
  onDone: () => void;
}) {
  const toast = useToast();
  const [every, setEvery] = React.useState<'week' | 'fortnight' | 'month' | 'day'>('week');
  const [count, setCount] = React.useState(6);
  const [saving, setSaving] = React.useState(false);

  if (!open) return null;

  async function submit() {
    if (!appointment) return;
    setSaving(true);
    try {
      const result = await request<{ seriesId: string; booked: unknown[]; skipped: { startsAt: string; reason: string }[] }>('POST', '/api/v1/series', {
        customer: { name: appointment.customer.name, number: appointment.customer.number, email: appointment.customer.email },
        startsAt: appointment.startsAt,
        durationMinutes: appointment.durationMinutes,
        serviceId: appointment.serviceId,
        providerId: appointment.providerId,
        locationId: appointment.locationId,
        repeat: { every, count },
      });
      toast(`${result.booked.length} ${term}s created.${result.skipped.length ? ` ${result.skipped.length} skipped — check the days around holidays.` : ''}`);
      if (result.skipped.length) {
        toast(`Skipped: ${result.skipped.slice(0, 3).map((s) => s.startsAt.slice(0, 10)).join(', ')}`, 'info');
      }
      onDone();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not create the series', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Repeat appointment"
      desc={appointment ? `${appointment.customer.name} · ${appointment.serviceName ?? appointment.service}` : undefined}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="brand" size="sm" disabled={saving} onClick={() => void submit()}>
            {saving ? 'Creating…' : 'Create the series'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="r-every">
              Repeats
            </label>
            <select id="r-every" className="field text-[13px]" value={every} onChange={(e) => setEvery(e.target.value as never)}>
              <option value="day">Every day</option>
              <option value="week">Every week</option>
              <option value="fortnight">Every fortnight</option>
              <option value="month">Every month</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="r-count">
              How many in total
            </label>
            <input id="r-count" type="number" min={2} max={52} className="field text-[13px]" value={count} onChange={(e) => setCount(Number(e.target.value))} />
          </div>
        </div>
        <p className="text-[12.5px] text-slateink-400">
          Each occurrence is checked against the diary as it is created. Anything that lands on a holiday, a break, or another appointment is skipped and reported — never silently dropped and never double-booked.
        </p>
      </div>
    </Modal>
  );
}
