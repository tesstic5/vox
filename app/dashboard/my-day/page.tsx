'use client';

/**
 * My day.
 *
 * The page a practitioner opens on their phone between clients. It answers, in
 * the order they ask it:
 *
 *   1. **What is next, and how long have I got?** — the next appointment, with a
 *      countdown, the client's number as a tap-to-call, and any medical flag the
 *      record carries.
 *   2. **Who is here?** — arrived and waiting, what has been done, what is left.
 *   3. **What is free?** — the gaps in the rota, and whether each one is actually
 *      bookable today or too short / too soon to promise.
 *   4. **One tap to move things on** — arrive, complete, no-show, cancel are the
 *      transitions the diary allows from where each appointment stands.
 *
 * Nothing here is invented: the appointment list, the transitions and the free
 * time all come from the workspace's own diary. A login with no practitioner
 * record linked is told so plainly and offered the one action that fixes it.
 */

import * as React from 'react';
import { ApiError, request } from '@/lib/server-sync';
import { cn } from '@/lib/utils';
import { Icons } from '@/components/icons';
import { Button, EmptyState, Pill, useToast } from '@/components/ui';
import { StatCard } from '@/components/dash/bits';
import { PageHeader } from '@/components/dash/Shell';

type DayAlert = { label: string; detail?: string; severity: string };

type DayAppointment = {
  id: string;
  startsAt: string;
  local: string;
  endsLocal: string;
  durationMinutes: number;
  status: string;
  canMoveTo: string[];
  clientId?: string;
  client: string;
  phone?: string;
  email?: string;
  service?: string;
  roomId?: string;
  roomName?: string;
  siteId: string;
  siteName: string;
  timezone: string;
  source?: string;
  note?: string;
  value?: number;
  alerts: DayAlert[];
};

type DayGap = {
  startsAt: string;
  endsAt: string;
  minutes: number;
  local: string;
  endsLocal: string;
  inMinutes: number;
  bookable: boolean;
  bookableFrom?: string;
  bookableFromLocal?: string;
  bookableMinutes: number;
  reason?: 'too_soon' | 'too_short' | 'too_far_ahead';
  shortByMinutes?: number;
  now: boolean;
  past: boolean;
};

type DayConflict = { kind: string; appointmentId: string; detail: string };

type DayRow = {
  date: string;
  weekday: number;
  siteId: string;
  siteName: string;
  timezone: string;
  hoursFrom?: string;
  hours?: { from: string; to: string };
  breaks: { from: string; to: string; label?: string }[];
  working: boolean;
  nowLocal: string;
  isToday: boolean;
  appointments: DayAppointment[];
  counts: {
    appointments: number;
    confirmed: number;
    pending: number;
    arrived: number;
    completed: number;
    noShows: number;
    cancelled: number;
    remaining: number;
    waitingNow: number;
  };
  next?: DayAppointment;
  nextInMinutes?: number;
  free: { now?: DayGap; next?: DayGap; gaps: DayGap[]; freeMinutes: number; bookableMinutes: number; pastMinutes: number };
  conflicts: DayConflict[];
  bookedMinutes: number;
  bookedValue?: number;
  alerts: DayAlert[];
};

type Payload = {
  linked: boolean;
  provider: { id: string; name: string; title?: string; colour?: string; email?: string } | null;
  link: {
    userId?: string;
    userEmail?: string;
    userRole?: string;
    candidates: { id: string; name: string; title?: string; email?: string; taken?: boolean }[];
    canLink: boolean;
  } | null;
  requested?: { providerId?: string; allowed: boolean; reason?: string };
  sites: { id: string; name: string; timezone: string }[];
  viewer: { role?: string; keyed: boolean; canPickPractitioner: boolean };
  practitioners: { id: string; name: string; title?: string; active: boolean; linked: boolean }[];
  rows: DayRow[];
  totals: {
    days: number;
    workingDays: number;
    appointments: number;
    bookedMinutes: number;
    freeMinutes: number;
    bookableFreeMinutes: number;
    waitingNow: number;
    alerts: number;
    conflicts: number;
  };
  week: { date: string; weekday: number; working: boolean; appointments: number; hours?: { from: string; to: string } }[];
  hints: { minNoticeMinutes: number; maxAdvanceDays: number; slotStepMinutes: number; shortestServiceMinutes?: number; transitions: Record<string, string[]> };
  actor?: { label: string; name?: string };
};

const STATUS_TONE: Record<string, 'default' | 'brand' | 'warn' | 'danger' | 'info'> = {
  confirmed: 'brand',
  pending: 'warn',
  arrived: 'info',
  completed: 'default',
  no_show: 'danger',
  cancelled: 'default',
};

const STATUS_WORD: Record<string, string> = {
  confirmed: 'confirmed',
  pending: 'not confirmed',
  arrived: 'arrived',
  completed: 'done',
  no_show: 'no-show',
  cancelled: 'cancelled',
};

/** The one action that usually comes next, so the thumb finds it first. */
const PRIMARY: Record<string, string> = { pending: 'confirmed', confirmed: 'arrived', arrived: 'completed', completed: '', cancelled: '', no_show: '' };

const ACTION_WORD: Record<string, string> = {
  confirmed: 'Confirm',
  arrived: 'Arrived',
  completed: 'Complete',
  no_show: 'No-show',
  cancelled: 'Cancel',
  pending: 'Back to pending',
};

const SEVERITY_TONE: Record<string, 'info' | 'warn' | 'danger'> = { info: 'info', warning: 'warn', critical: 'danger' };

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function prettyDate(date: string, weekday: number) {
  return `${WEEKDAYS[weekday] ?? ''} ${Number(date.slice(8, 10))} ${new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })}`;
}

function untilLabel(minutes?: number) {
  if (minutes === undefined) return '';
  if (minutes < 0) return `${Math.abs(minutes)} min ago`;
  if (minutes === 0) return 'now';
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `in ${hours} h ${rest} min` : `in ${hours} h`;
}

export default function MyDayPage() {
  const toast = useToast();
  const [data, setData] = React.useState<Payload | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [date, setDate] = React.useState('');
  const [days, setDays] = React.useState(1);
  const [site, setSite] = React.useState('');
  const [whoseDay, setWhoseDay] = React.useState('');
  const [busy, setBusy] = React.useState('');

  const fail = (error: unknown) => toast(error instanceof ApiError ? error.message : 'Something went wrong', 'error');

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const query = [
        date ? `date=${date}` : '',
        `days=${days}`,
        site ? `locationId=${site}` : '',
        whoseDay ? `providerId=${whoseDay}` : '',
      ]
        .filter(Boolean)
        .join('&');
      const payload = await request<Payload>('GET', `/api/v1/day?${query}`);
      setData(payload);
      if (!date && payload.rows[0]) setDate(payload.rows[0].date);
    } catch (error) {
      fail(error);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, days, site, whoseDay, toast]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function move(appointment: DayAppointment, status: string) {
    setBusy(`${appointment.id}:${status}`);
    try {
      await request('POST', `/api/v1/bookings/${appointment.id}/status`, { status });
      toast(`${appointment.client} → ${STATUS_WORD[status] ?? status}`);
      await load();
    } catch (error) {
      fail(error);
    } finally {
      setBusy('');
    }
  }

  async function link(providerId: string) {
    setBusy(`link:${providerId}`);
    try {
      await request('POST', '/api/v1/day', { action: 'provider:link', providerId });
      toast('Linked — your diary is below.');
      await load();
    } catch (error) {
      fail(error);
    } finally {
      setBusy('');
    }
  }

  async function unlink() {
    setBusy('unlink');
    try {
      await request('POST', '/api/v1/day', { action: 'provider:unlink' });
      toast('Unlinked');
      await load();
    } catch (error) {
      fail(error);
    } finally {
      setBusy('');
    }
  }

  const rows = data?.rows ?? [];
  const first = rows[0];
  const flags = rows.flatMap((r) => r.alerts);

  /* --------------------------------------------------- no link: the honest end */
  if (data && !data.linked) {
    return (
      <>
        <PageHeader
          title="My day"
          desc="Your own diary: what is next, who has arrived, what is free — and one tap to move an appointment on."
          breadcrumb={[{ label: 'Practice' }, { label: 'My day' }]}
          actions={
            <Button variant="ghost" size="sm" onClick={() => void load()}>
              Refresh
            </Button>
          }
        />
        <div className="panel mx-auto max-w-2xl p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 text-amber-800">
              <Icons.alert size={15} />
            </span>
            <div>
              <h3 className="h4">No practitioner record is linked to this login</h3>
              <p className="mt-1.5 text-[13px] leading-relaxed text-slateink-300">
                {data.link?.userEmail ? <span className="text-slate-900">{data.link.userEmail}</span> : 'This login'} can sign in and read the practice, but the diary
                does not know which practitioner it is — so there is no day to show. Pick the record that is you, and this page becomes your diary.
              </p>
              <p className="mt-2 text-[12.5px] leading-relaxed text-slateink-400">
                {data.link?.candidates.length
                  ? 'Linking yourself is allowed for any signed-in user. If the record is already held by another login, ask an owner or admin — a diary never changes hands silently.'
                  : 'There are no practitioner records in this workspace yet. Create one under Practice setup → Practitioners, then come back.'}
              </p>
            </div>
          </div>

          {data.link?.candidates.length ? (
            <div className="mt-5 space-y-2">
              {data.link.candidates.map((candidate) => (
                <div
                  key={candidate.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-900/[0.04] bg-ink-900/40 px-3.5 py-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-[13.5px] text-slate-900">
                      {candidate.name}
                      {candidate.taken && <Pill tone="warn">linked to another login</Pill>}
                    </div>
                    <div className="mt-0.5 truncate text-[11.5px] text-slateink-400">
                      {[candidate.title, candidate.email].filter(Boolean).join(' · ') || 'no title or email on the record'}
                    </div>
                  </div>
                  <Button
                    variant={candidate.taken ? 'ghost' : 'brand'}
                    size="sm"
                    disabled={Boolean(candidate.taken) || busy === `link:${candidate.id}` || !data.link?.canLink}
                    onClick={() => void link(candidate.id)}
                  >
                    {busy === `link:${candidate.id}` ? 'Linking…' : 'This is me'}
                  </Button>
                </div>
              ))}
            </div>
          ) : null}

          {!data.link?.canLink && (
            <p className="mt-4 text-[12.5px] text-amber-800">
              Linking is a signed-in action — an API key has no person behind it. Sign in and try again.
            </p>
          )}

          <div className="mt-5 flex flex-wrap gap-3 border-t border-slate-900/[0.04] pt-4 text-[12.5px] text-slateink-400">
            <a className="underline decoration-white/20 hover:text-slate-900" href="/dashboard/team">
              Team &amp; roles
            </a>
            <a className="underline decoration-white/20 hover:text-slate-900" href="/dashboard/practice">
              Practice setup
            </a>
            <a className="underline decoration-white/20 hover:text-slate-900" href="/dashboard/board">
              Staff board
            </a>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="My day"
        desc="Your own diary, in the order you will live it: what is next, who has arrived, what is free, and one tap to move an appointment on."
        breadcrumb={[{ label: 'Practice' }, { label: 'My day' }]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {data?.viewer.canPickPractitioner && data.practitioners.length > 1 ? (
              <select className="field w-[180px] text-[12.5px]" value={whoseDay} onChange={(e) => setWhoseDay(e.target.value)} title="Owners and admins can read a colleague's day">
                <option value="">{data.provider ? `${data.provider.name} (me)` : 'My day'}</option>
                {data.practitioners
                  .filter((p) => p.id !== data.provider?.id)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.active ? '' : ' (inactive)'}
                    </option>
                  ))}
              </select>
            ) : null}
            <select className="field w-[150px] text-[12.5px]" value={site} onChange={(e) => setSite(e.target.value)}>
              <option value="">All my sites</option>
              {(data?.sites ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <select className="field w-[130px] text-[12.5px]" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={1}>Today only</option>
              <option value={3}>Next 3 days</option>
              <option value={7}>Next 7 days</option>
            </select>
            <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
              {loading ? 'Reading…' : 'Refresh'}
            </Button>
          </div>
        }
      />

      {loading && !data ? (
        <p className="py-10 text-center text-[13px] text-slateink-400">Reading your diary…</p>
      ) : !data?.provider ? (
        <EmptyState icon="calendar" title="Nothing to show" desc="This workspace has no practitioner to read a day for." />
      ) : (
        <div className="space-y-4">
          {/* Who this day belongs to, and the way out of it. */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-900/[0.04] bg-ink-900/40 px-4 py-3">
            <div className="flex items-center gap-3">
              <span className={cn('flex h-9 w-9 items-center justify-center rounded-full border border-brand-500/30 bg-brand-500/10 text-[12px] font-semibold text-brand-700')}>
                {data.provider.name
                  .split(/\s+/)
                  .slice(0, 2)
                  .map((p) => p[0]?.toUpperCase())
                  .join('')}
              </span>
              <div>
                <div className="text-[13.5px] text-slate-900">
                  {data.provider.name}
                  {data.provider.title ? <span className="text-slateink-400"> · {data.provider.title}</span> : null}
                </div>
                <div className="text-[11.5px] text-slateink-400">
                  {data.week.length ? `${data.totals.appointments} appointment${data.totals.appointments === 1 ? '' : 's'} across ${data.totals.workingDays} working day${data.totals.workingDays === 1 ? '' : 's'}` : 'nothing on the rota in this window'}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {data.week.length > 1 && (
                <div className="hidden flex-wrap gap-1 sm:flex">
                  {data.week.map((w) => (
                    <button
                      key={w.date}
                      onClick={() => setDate(w.date)}
                      className={cn(
                        'rounded-lg border px-2 py-1 font-mono text-[10.5px] transition',
                        w.date === date
                          ? 'border-brand-500/40 bg-brand-500/10 text-brand-700'
                          : w.working
                            ? 'border-slate-900/[0.035] bg-slate-900/[0.02] text-slateink-300 hover:text-slate-900'
                            : 'border-slate-900/[0.035] text-slateink-500'
                      )}
                      title={`${prettyDate(w.date, w.weekday)} · ${w.working ? `${w.appointments} booked` : 'not on the rota'}`}
                    >
                      {WEEKDAYS[w.weekday]?.slice(0, 3)} {Number(w.date.slice(8, 10))}
                      {w.working ? ` · ${w.appointments}` : ''}
                    </button>
                  ))}
                </div>
              )}
              <button className="text-[11.5px] text-slateink-400 underline decoration-white/20 hover:text-slate-900" onClick={() => void unlink()} disabled={busy === 'unlink'}>
                not me
              </button>
            </div>
          </div>

          {/* The numbers, before the list. */}
          {first && (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard
                label={first.next ? 'Next up' : 'Nothing left today'}
                value={first.next ? first.next.local : '—'}
                sub={first.next ? `${first.next.client} · ${untilLabel(first.nextInMinutes)}` : `${first.counts.completed} seen`}
              />
              <StatCard label="Still to see" value={String(first.counts.remaining)} sub={`${first.counts.completed} done · ${first.counts.noShows} no-show`} />
              <StatCard label="Arrived now" value={String(first.counts.waitingNow)} sub={first.counts.waitingNow ? 'in the waiting room' : 'nobody waiting'} />
              <StatCard
                label="Free today"
                value={`${first.free.freeMinutes} min`}
                sub={`${first.free.bookableMinutes} min bookable at ${data.hints.minNoticeMinutes} min notice`}
              />
            </div>
          )}

          {/* Flags first: the reason to look at this screen before the client sits down. */}
          {flags.length > 0 && (
            <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.06] p-4">
              <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-amber-800">
                <Icons.alert size={13} /> {flags.length} medical flag{flags.length === 1 ? '' : 's'} on today's clients
              </div>
              <ul className="space-y-1 text-[12.5px] text-amber-800">
                {rows.map((row) =>
                  row.appointments
                    .filter((a) => a.alerts.length)
                    .map((a) => (
                      <li key={a.id}>
                        <span className="text-slate-900">{a.local}</span> · {a.client} — {a.alerts.map((f) => f.label).join(', ')}
                      </li>
                    ))
                )}
              </ul>
              <p className="mt-2 text-[11.5px] text-amber-800">Reading a flag is a record access: each one is written to the client's access log.</p>
            </div>
          )}

          {rows.length === 0 ? (
            <EmptyState icon="calendar" title="No days in this window" desc="Pick another date or widen the range." />
          ) : (
            rows.map((row) => (
              <div key={`${row.date}-${row.siteId}`} className="panel p-4 sm:p-5">
                <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="h4">{prettyDate(row.date, row.weekday)}</h3>
                    <div className="mt-0.5 text-[11.5px] text-slateink-400">
                      {row.siteName}
                      {row.hours ? ` · ${row.hours.from}–${row.hours.to}` : ''}
                      {row.hoursFrom ? ` · ${row.hoursFrom}` : ''}
                      {row.isToday ? ` · ${row.nowLocal} local now` : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {row.breaks.length > 0 && (
                      <Pill title="Time the rota keeps clear">break {row.breaks.map((b) => `${b.from}–${b.to}`).join(', ')}</Pill>
                    )}
                    <Pill tone={!row.working ? 'default' : row.counts.remaining ? 'brand' : 'info'}>
                      {!row.working ? 'not on the rota' : `${row.counts.remaining} left of ${row.counts.appointments}`}
                    </Pill>
                  </div>
                </div>

                {!row.working ? (
                  <p className="rounded-xl border border-slate-900/[0.035] bg-ink-900/40 px-3.5 py-3 text-[12.5px] text-slateink-400">
                    Nothing rostered here {row.hoursFrom ? `(${row.hoursFrom})` : ''}.{' '}
                    {row.appointments.length
                      ? `${row.appointments.length} appointment${row.appointments.length === 1 ? '' : 's'} still sit here though — worth a look.`
                      : 'Enjoy it.'}
                  </p>
                ) : null}

                {row.conflicts.length > 0 && (
                  <div className="mb-3 rounded-xl border border-red-500/25 bg-red-500/[0.06] p-3.5">
                    <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-red-700">Needs fixing</div>
                    <ul className="space-y-1 text-[12.5px] text-red-800">
                      {row.conflicts.map((c, i) => (
                        <li key={`${c.kind}-${c.appointmentId}-${i}`}>{c.detail}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* The timeline: appointments and the gaps between them, in order. */}
                <ol className="space-y-2">
                  {timeline(row).map((item) =>
                    item.kind === 'gap' ? (
                      <li key={`gap-${item.gap.startsAt}`}>
                        <div
                          className={cn(
                            'flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed px-3.5 py-2.5 text-[12px]',
                            item.gap.past
                              ? 'border-slate-900/[0.04] text-slateink-600'
                              : item.gap.bookable
                                ? 'border-slate-900/[0.04] bg-slate-900/[0.015] text-slateink-300'
                                : 'border-slate-900/[0.04] text-slateink-500'
                          )}
                        >
                          <span className="font-mono text-[11px]">
                            {item.gap.local}–{item.gap.endsLocal}
                          </span>
                          <span>
                            {/* The whole stretch, not just the sellable part: the
                                sub-line beside it says what of it can be booked. */}
                            {item.gap.past ? 'was free' : 'free'}
                            {item.gap.now ? ' now' : ''} · {item.gap.minutes} min
                          </span>
                          <span>
                            {item.gap.past
                              ? 'gone by'
                              : item.gap.bookable
                                ? item.gap.bookableFrom && item.gap.bookableFrom !== item.gap.startsAt
                                  ? `bookable from ${item.gap.bookableFromLocal} · ${item.gap.bookableMinutes} min`
                                  : `bookable · ${item.gap.bookableMinutes} min`
                                : gapReason(item.gap, data.hints)}
                          </span>
                        </div>
                      </li>
                    ) : (
                      <li key={item.appointment.id}>
                        <AppointmentCard appointment={item.appointment} busy={busy} onMove={move} />
                      </li>
                    )
                  )}
                </ol>

                {row.appointments.length === 0 && row.working ? (
                  <p className="mt-3 text-[12.5px] text-slateink-400">
                    A clear day: {row.free.freeMinutes} minutes free still to come, {row.free.bookableMinutes} of them bookable at {data.hints.minNoticeMinutes} minutes' notice
                    {data.hints.shortestServiceMinutes ? `, and anything shorter than ${data.hints.shortestServiceMinutes} minutes cannot take a booking` : ''}.
                  </p>
                ) : null}
              </div>
            ))
          )}

          <div className="px-1 pb-3 text-[11.5px] leading-relaxed text-slateink-500">
            <p>
              Free time is your rota, minus the appointments, minus the rota's breaks. “Bookable” also respects the practice's {data?.hints.minNoticeMinutes}-minute notice
              window{data?.hints.shortestServiceMinutes ? ` and the shortest service on offer (${data.hints.shortestServiceMinutes} min)` : ''} — free and bookable are not the
              same answer.
            </p>
            <p className="mt-1.5">
              Moving an appointment on writes to the same diary the desk and the staff board read, and cancelling offers the slot to whoever is on the wait list. Anything you
              tap here appears there immediately.
            </p>
            <p className="mt-1.5">
              The same view is one API call: <code className="font-mono text-slateink-400">GET /api/v1/day?days=3</code> — an owner may add{' '}
              <code className="font-mono text-slateink-400">providerId=</code> to read a colleague&apos;s day.
            </p>
          </div>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ pieces */

function timeline(row: DayRow): ({ kind: 'appointment'; appointment: DayAppointment } | { kind: 'gap'; gap: DayGap })[] {
  const items: ({ kind: 'appointment'; appointment: DayAppointment } | { kind: 'gap'; gap: DayGap })[] = [
    ...row.appointments.map((appointment) => ({ kind: 'appointment' as const, appointment })),
    ...row.free.gaps.map((gap) => ({ kind: 'gap' as const, gap })),
  ];
  return items.sort((a, b) => {
    const at = a.kind === 'appointment' ? a.appointment.startsAt : a.gap.startsAt;
    const bt = b.kind === 'appointment' ? b.appointment.startsAt : b.gap.startsAt;
    return at.localeCompare(bt);
  });
}

function gapReason(gap: DayGap, hints: Payload['hints']) {
  if (gap.reason === 'too_soon') {
    // The notice window runs past the end of the free stretch, not past its start.
    return gap.past
      ? 'gone by'
      : `too soon — the ${hints.minNoticeMinutes}-minute notice runs ${gap.shortByMinutes ?? 0} min past the end of it`;
  }
  if (gap.reason === 'too_short') return `too short — ${gap.shortByMinutes ?? 0} min shy of the shortest service${hints.shortestServiceMinutes ? ` (${hints.shortestServiceMinutes} min)` : ''}`;
  if (gap.reason === 'too_far_ahead') return `beyond the ${hints.maxAdvanceDays}-day booking window`;
  return 'not bookable';
}

function AppointmentCard({
  appointment,
  busy,
  onMove,
}: {
  appointment: DayAppointment;
  busy: string;
  onMove: (appointment: DayAppointment, status: string) => void;
}) {
  const primary = PRIMARY[appointment.status];
  const others = appointment.canMoveTo.filter((s) => s !== primary);
  return (
    <div
      className={cn(
        'rounded-xl border px-3.5 py-3',
        appointment.status === 'cancelled'
          ? 'border-slate-900/[0.035] bg-transparent opacity-60'
          : appointment.status === 'arrived'
            ? 'border-sky-400/25 bg-sky-400/[0.05]'
            : appointment.status === 'no_show'
              ? 'border-red-500/20 bg-red-500/[0.04]'
              : 'border-slate-900/[0.045] bg-ink-900/40'
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[12px] text-slate-900">
              {appointment.local}–{appointment.endsLocal}
            </span>
            <Pill tone={STATUS_TONE[appointment.status] ?? 'default'}>{STATUS_WORD[appointment.status] ?? appointment.status}</Pill>
            {appointment.roomName ? <span className="text-[11.5px] text-slateink-400">{appointment.roomName}</span> : <span className="text-[11.5px] text-amber-800">no room</span>}
            {appointment.source === 'online' || appointment.source === 'waitlist' || appointment.source === 'call' ? (
              <span className="text-[11px] text-slateink-500">came in {appointment.source === 'call' ? 'by phone' : appointment.source === 'online' ? 'online' : 'from the wait list'}</span>
            ) : null}
          </div>
          <div className="mt-1 text-[13.5px] text-slate-900">
            {appointment.client}
            {appointment.service ? <span className="text-slateink-400"> · {appointment.service}</span> : null}
            {appointment.durationMinutes ? <span className="text-slateink-500"> · {appointment.durationMinutes} min</span> : null}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-3 text-[11.5px] text-slateink-400">
            {appointment.phone ? (
              <a className="hover:text-slate-900" href={`tel:${appointment.phone}`}>
                {appointment.phone}
              </a>
            ) : null}
            {appointment.clientId ? (
              <a className="underline decoration-white/20 hover:text-slate-900" href={`/dashboard/clients?client=${appointment.clientId}`}>
                record
              </a>
            ) : null}
            {appointment.note ? <span className="italic">{appointment.note}</span> : null}
          </div>
          {appointment.alerts.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {appointment.alerts.map((alert, i) => (
                <Pill key={`${alert.label}-${i}`} tone={SEVERITY_TONE[alert.severity] ?? 'warn'} title={alert.detail}>
                  {alert.label}
                </Pill>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {primary && (
            <Button variant="brand" size="sm" disabled={busy.startsWith(appointment.id)} onClick={() => onMove(appointment, primary)}>
              {busy === `${appointment.id}:${primary}` ? '…' : ACTION_WORD[primary] ?? primary}
            </Button>
          )}
          {others.map((status) => (
            <Button
              key={status}
              variant={status === 'cancelled' || status === 'no_show' ? 'quiet' : 'ghost'}
              size="sm"
              disabled={busy.startsWith(appointment.id)}
              onClick={() => onMove(appointment, status)}
            >
              {busy === `${appointment.id}:${status}` ? '…' : ACTION_WORD[status] ?? status}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

