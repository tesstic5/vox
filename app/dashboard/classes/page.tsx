'use client';

/**
 * Classes (A8).
 *
 * The one Cliniko scheduling idea this product did not have: several people in
 * one appointment. The page is deliberately shaped like a **roster**, not like a
 * diary — a class is made once, its place in the day is drawn on the calendar,
 * and what the desk comes here for is who is in it.
 *
 * Three rules the screen keeps, because breaking any of them is how a class turns
 * into a double-booking:
 *
 *   - Seats are **counted**, never assumed: the count comes from the sessions the
 *     server just sent, and every write answers with the session as it now stands.
 *   - A session is created through the **clash engine** like any appointment, so
 *     the desk is told "Dana is already with somebody at 6pm" instead of finding
 *     out on the night.
 *   - Cancelling a session is not a delete: it releases every seat and queues a
 *     message to each person holding one.
 *
 * Times everywhere are the **site's own clock**, straight off the payload — the
 * page never converts an instant itself.
 */

import * as React from 'react';
import { ApiError, request } from '@/lib/server-sync';
import { Button, EmptyState, Modal, Pill, useToast } from '@/components/ui';
import { StatCard } from '@/components/dash/bits';
import { PageHeader } from '@/components/dash/Shell';

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
  waiting?: number;
  status: 'scheduled' | 'cancelled';
  notes?: string;
  local: { date: string; start: string; end: string; timezone: string; spoken: string };
};

type ClassOption = { id: string; name: string; capacity: number; durationMinutes: number; price: number };
type Site = { id: string; name: string; timezone: string };
type Instructor = { id: string; name: string; locationIds: string[]; serviceIds: string[] };
type Room = { id: string; name: string; locationId: string };

type Payload = {
  sessions: Session[];
  classes: ClassOption[];
  sites: Site[];
  instructors: Instructor[];
  rooms: Room[];
  range: { from: string; to: string };
  totals: { sessions: number; seats: number; seatsLeft: number; capacity: number };
};

type Attendance = {
  capacity: number;
  seats: number;
  confirmed: number;
  arrived: number;
  completed: number;
  noShow: number;
  free: number;
  attended: number;
};

type Roster = {
  session: Session;
  roster: { bookingId: string; clientId?: string; name: string; number: string; status: string; reference: string; packId?: string; packState?: string }[];
  attendance: Attendance;
  /** The queue for a place: positions, and who already has an offer standing. */
  waitList?: {
    count: number;
    waiting: { id: string; position: number; name: string; number: string; status: string; joinedAt: string; offeredUntil?: string }[];
    openOffers: number;
    seatsLeft: number;
  };
};

/**
 * The register's own vocabulary, in the order a desk uses it.
 *
 * The statuses are the ordinary booking ones — a seat *is* a booking — so this is
 * a label for each and the next step somebody would take from it, not a second
 * state machine. "Undo" exists because the most common register mistake is a
 * mis-tap, and a mis-tap must be fixable at the door.
 */
const REGISTER_STEPS: Record<string, { next: 'arrived' | 'completed' | null; undo: boolean; label: string }> = {
  pending: { next: 'arrived', undo: false, label: 'Arrived' },
  confirmed: { next: 'arrived', undo: false, label: 'Arrived' },
  arrived: { next: 'completed', undo: false, label: 'Done' },
  completed: { next: null, undo: true, label: 'Done' },
  no_show: { next: null, undo: true, label: 'No-show' },
};

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A date label built from the payload's own `YYYY-MM-DD`, never from a parsed instant. */
function dayLabel(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  const weekday = DAY_NAMES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${weekday} ${d} ${MONTH_NAMES[m - 1]}`;
}

function Seats({ session }: { session: Session }) {
  const full = session.seatsLeft <= 0;
  return (
    <span className="inline-flex items-center gap-2" title={`${session.seats} of ${session.capacity} places taken`}>
      <span className="inline-flex h-1.5 w-24 overflow-hidden rounded-full bg-slate-900/10">
        <span
          className={full ? 'bg-amber-400/80' : 'bg-brand-400/80'}
          style={{ width: `${Math.min(100, (session.seats / Math.max(1, session.capacity)) * 100)}%` }}
        />
      </span>
      <span className={`font-mono text-[12px] ${full ? 'text-amber-800' : 'text-slateink-200'}`}>
        {session.seats}/{session.capacity}
      </span>
    </span>
  );
}

export default function ClassesPage() {
  const toast = useToast();
  const [data, setData] = React.useState<Payload | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [roster, setRoster] = React.useState<Roster | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const payload = await request<Payload>('GET', '/api/v1/classes');
      setData(payload);
      setError(null);
      return payload;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not read the class list.');
      return null;
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);


  const openRoster = React.useCallback(async (id: string) => {
    setOpenId(id);
    setRoster(null);
    try {
      setRoster(await request<Roster>('GET', `/api/v1/classes/${id}`));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not open that class.');
      setOpenId(null);
    }
  }, [toast]);


  /**
   * `?session=<id>` opens that roster.
   *
   * The diary's class blocks link here, so a click on the grid lands on the
   * roster rather than on a list somebody then has to search. Read from
   * `location` rather than `useSearchParams` so the page needs no Suspense
   * boundary to prerender.
   */
  const opened = React.useRef(false);
  React.useEffect(() => {
    if (opened.current) return;
    const wanted = new URLSearchParams(window.location.search).get('session');
    if (!wanted) return;
    opened.current = true;
    void openRoster(wanted);
  }, [openRoster]);

  const act = React.useCallback(
    async (id: string, body: Record<string, unknown>, done: string) => {
      setBusy(true);
      try {
        await request('POST', `/api/v1/classes/${id}`, body);
        toast(done);
        await openRoster(id);
        await load();
      } catch (err) {
        toast(err instanceof ApiError ? err.message : 'That did not go through.');
      } finally {
        setBusy(false);
      }
    },
    [load, openRoster, toast]
  );

  /**
   * Take somebody out of the line.
   *
   * The entry is the same row the slot wait-list uses, so removing it is the same
   * endpoint — one wait list, two kinds of entry, and the desk does not have to
   * know which is which to take a name off it.
   */
  const unwait = React.useCallback(
    async (id: string, entryId: string) => {
      setBusy(true);
      try {
        await request('DELETE', `/api/v1/wait-list/${entryId}`);
        toast('Out of the line.');
        await openRoster(id);
        await load();
      } catch (err) {
        toast(err instanceof ApiError ? err.message : 'That did not go through.');
      } finally {
        setBusy(false);
      }
    },
    [load, openRoster, toast]
  );

  const sessions = data?.sessions ?? [];
  const upcoming = sessions.filter((s) => s.status === 'scheduled');
  const seatsBooked = upcoming.reduce((sum, s) => sum + s.seats, 0);
  const seatsLeft = upcoming.reduce((sum, s) => sum + s.seatsLeft, 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Classes"
        desc="Group appointments: one slot, several places. Each place is a normal booking, so reminders, receipts and the client's own link work on it."
        actions={
          <Button onClick={() => setCreating(true)} disabled={!data || data.classes.length === 0}>
            New class session
          </Button>
        }
      />

      {data && data.classes.length === 0 ? (
        <p className="rounded-2xl border border-slate-900/[0.035] bg-slate-900/[0.02] px-4 py-3 text-[13px] text-slateink-300">
          No service is set up as a class yet. Give a service a capacity of 2 or more in{' '}
          <span className="text-slate-900">Practice → Services</span>, and it can be scheduled here as a group.
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Coming up" value={String(upcoming.length)} sub="scheduled sessions" />
        <StatCard label="Places taken" value={String(seatsBooked)} sub="across those sessions" />
        <StatCard label="Places free" value={String(seatsLeft)} sub="still to sell" />
        <StatCard label="Class services" value={String(data?.classes.length ?? 0)} sub={data?.classes.map((c) => c.name).slice(0, 2).join(' · ') || '—'} />
      </div>

      {error ? (
        <p className="rounded-xl border border-red-400/25 bg-red-400/[0.06] px-4 py-3 text-[13px] text-red-700">{error}</p>
      ) : null}

      {!data && !error ? <p className="text-[13px] text-slateink-400">Reading the class list…</p> : null}

      {data && sessions.length === 0 ? (
        <EmptyState
          title="No classes in the next fortnight"
          desc="Make a session and it appears here, on the diary and on the public booking page with its seats left."
        />
      ) : null}

      {data && sessions.length > 0 ? (
        <div className="overflow-hidden rounded-2xl border border-slate-900/[0.035]">
          {sessions.map((session) => {
            const cancelled = session.status === 'cancelled';
            return (
              <button
                key={session.id}
                type="button"
                onClick={() => void openRoster(session.id)}
                className="flex w-full items-center gap-4 border-b border-slate-900/[0.035] px-4 py-3 text-left transition last:border-b-0 hover:bg-slate-900/[0.03]"
              >
                <span className="w-32 shrink-0">
                  <span className="block font-mono text-[13px] text-slate-900">{session.local.start}</span>
                  <span className="block text-[11.5px] text-slateink-400">{dayLabel(session.local.date)}</span>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className={`truncate text-[14px] ${cancelled ? 'text-slateink-500 line-through' : 'text-slate-900'}`}>{session.serviceName}</span>
                    {cancelled ? <Pill tone="danger">cancelled</Pill> : session.seatsLeft <= 0 ? <Pill tone="warn">full</Pill> : null}
                    {!cancelled && session.waiting ? <Pill tone="brand">{session.waiting} waiting</Pill> : null}
                  </span>
                  <span className="mt-0.5 block truncate text-[12px] text-slateink-400">
                    {[session.providerName, session.locationName, session.roomName].filter(Boolean).join(' · ') || 'no instructor or site set'} · {session.durationMinutes} min
                  </span>
                </span>
                <span className="shrink-0">
                  <Seats session={session} />
                </span>
                <span className="hidden shrink-0 sm:block">
                  <Pill tone={session.seats > 0 ? 'brand' : 'default'}>{session.seats > 0 ? 'roster' : 'nobody yet'}</Pill>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      {creating && data ? (
        <CreateSession
          data={data}
          onClose={() => setCreating(false)}
          onDone={async (message) => {
            setCreating(false);
            toast(message);
            await load();
          }}
        />
      ) : null}

      {data && data.classes.length > 0 ? <PacksPanel classes={data.classes} /> : null}

      {openId ? (
        <RosterModal
          id={openId}
          roster={roster}
          busy={busy}
          onClose={() => {
            setOpenId(null);
            setRoster(null);
          }}
          onAdd={(body) => void act(openId, { action: 'add-seat', ...body }, 'Place added.')}
          onRemove={(bookingId) => void act(openId, { action: 'remove-seat', bookingId }, 'Place given back.')}
          onMark={(bookingId, status) => void act(openId, { action: 'mark-seat', bookingId, status }, status === 'arrived' ? 'Marked here.' : status === 'completed' ? 'Marked done.' : status === 'no_show' ? 'Marked as a no-show.' : 'Back to booked.')}
          onEveryone={() => void act(openId, { action: 'everyone-arrived' }, "Everyone's here.")}
          onWait={(body) => void act(openId, { action: 'add-waiter', ...body }, 'Added to the line.')}
          onUnwait={(entryId) => void unwait(openId, entryId)}
          onCancelSession={async (reason) => {
            setBusy(true);
            try {
              const result = await request<{ cancelledSeats: number }>('POST', '/api/v1/classes', { action: 'cancel', sessionId: openId, reason });
              toast(result.cancelledSeats ? `Session cancelled — ${result.cancelledSeats} place(s) released and the people told.` : 'Session cancelled.');
              setOpenId(null);
              setRoster(null);
              await load();
            } catch (err) {
              toast(err instanceof ApiError ? err.message : 'That did not go through.');
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ class packs */

type PackProduct = { id: string; serviceId: string; name: string; places: number; priceMinor: number; expiryMonths?: number; active: boolean };
type PacksPayload = {
  products: PackProduct[];
  liability: { packs: number; placesOutstanding: number; valueHeldMinor: number; currency: string };
};

function money(minor: number, currency: string) {
  return `${currency} ${(minor / 100).toFixed(2)}`;
}

/**
 * Pack products and the liability line. Selling happens on the client's
 * record (that is whose pack it is); this is where a pack is priced, and
 * where the desk can see how much class money the practice is holding for
 * places nobody has taken yet.
 */
function PacksPanel({ classes }: { classes: ClassOption[] }) {
  const toast = useToast();
  const [packs, setPacks] = React.useState<PacksPayload | null>(null);
  const [form, setForm] = React.useState({ serviceId: classes[0]?.id ?? '', name: '', places: '10', price: '', expiryMonths: '6' });
  const [busy, setBusy] = React.useState(false);

  const loadPacks = React.useCallback(async () => {
    try {
      setPacks(await request<PacksPayload>('GET', '/api/v1/packs'));
    } catch {
      setPacks(null);
    }
  }, []);
  React.useEffect(() => { void loadPacks(); }, [loadPacks]);

  const create = async () => {
    setBusy(true);
    try {
      await request('POST', '/api/v1/packs', {
        serviceId: form.serviceId,
        name: form.name,
        places: Number(form.places),
        priceMinor: Math.round(Number(form.price) * 100),
        expiryMonths: Number(form.expiryMonths) || undefined,
      });
      toast('Pack product created. Sell it from a client record.');
      setForm((f) => ({ ...f, name: '', price: '' }));
      await loadPacks();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not create that pack.');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (product: PackProduct) => {
    setBusy(true);
    try {
      await request('PATCH', `/api/v1/packs/${product.id}`, { active: !product.active });
      await loadPacks();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'That did not go through.');
    } finally {
      setBusy(false);
    }
  };

  const field = 'w-full rounded-lg border border-slate-900/[0.06] bg-slate-900/[0.04] px-3 py-2 text-[13.5px] text-slate-900 outline-none focus:border-brand-500/50';
  const label = 'mb-1 block text-[12px] text-slateink-300';

  return (
    <section className="rounded-2xl border border-slate-900/[0.035] bg-slate-900/[0.02] p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-medium text-slate-900">Class packs</h2>
        {packs ? (
          <p className="text-[12.5px] text-slateink-300">
            Holding <span className="text-slate-900">{money(packs.liability.valueHeldMinor, packs.liability.currency)}</span> for{' '}
            {packs.liability.placesOutstanding} undelivered place(s) across {packs.liability.packs} pack(s)
          </p>
        ) : null}
      </div>
      <p className="mt-1 text-[12.5px] text-slateink-400">
        A pack is places paid for up front and spent as the client comes — a place is spent on attendance, burned by a late cancel or
        no-show, and given back by an early one. Sell one from the client&apos;s record.
      </p>

      {packs && packs.products.length > 0 ? (
        <div className="mt-3 overflow-hidden rounded-xl border border-slate-900/[0.035]">
          {packs.products.map((p) => (
            <div key={p.id} className="flex items-center gap-3 border-b border-slate-900/[0.035] px-3.5 py-2.5 last:border-b-0">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] text-slate-900">{p.name}</span>
                <span className="block text-[12px] text-slateink-400">
                  {classes.find((c) => c.id === p.serviceId)?.name ?? 'class'} · {p.places} places · {p.expiryMonths ? `valid ${p.expiryMonths} months` : 'no expiry'}
                </span>
              </span>
              <span className="font-mono text-[13px] text-slate-900">{money(p.priceMinor, packs.liability.currency)}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void toggle(p)}
                className="rounded-lg border border-slate-900/[0.06] px-2.5 py-1 text-[12px] text-slateink-200 transition hover:text-slate-900 disabled:opacity-50"
              >
                {p.active ? 'Stop selling' : 'Sell again'}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-[13px] text-slateink-400">No packs yet — price the first one:</p>
      )}

      <div className="mt-3 grid gap-3 sm:grid-cols-5">
        <label className="block">
          <span className={label}>Class</span>
          <select className={field} value={form.serviceId} onChange={(e) => setForm((f) => ({ ...f, serviceId: e.target.value }))}>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={label}>Pack name</span>
          <input className={field} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="10-class pass" />
        </label>
        <label className="block">
          <span className={label}>Places</span>
          <input className={field} type="number" min={2} max={200} value={form.places} onChange={(e) => setForm((f) => ({ ...f, places: e.target.value }))} />
        </label>
        <label className="block">
          <span className={label}>Price</span>
          <input className={field} type="number" min={0} step="0.01" value={form.price} onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))} placeholder="200.00" />
        </label>
        <label className="block">
          <span className={label}>Valid (months, 0 = forever)</span>
          <input className={field} type="number" min={0} max={60} value={form.expiryMonths} onChange={(e) => setForm((f) => ({ ...f, expiryMonths: e.target.value }))} />
        </label>
      </div>
      <div className="mt-3">
        <Button onClick={() => void create()} disabled={busy || !form.name || !form.price}>
          Create pack product
        </Button>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ new session */

function CreateSession({ data, onClose, onDone }: { data: Payload; onClose: () => void; onDone: (message: string) => void }) {
  const first = data.classes[0];
  const [serviceId, setServiceId] = React.useState(first?.id ?? '');
  const [providerId, setProviderId] = React.useState('');
  const [locationId, setLocationId] = React.useState(data.sites[0]?.id ?? '');
  const [roomId, setRoomId] = React.useState('');
  const [date, setDate] = React.useState(data.range.from);
  const [time, setTime] = React.useState('18:00');
  const [duration, setDuration] = React.useState(String(first?.durationMinutes ?? 60));
  const [capacity, setCapacity] = React.useState(String(first?.capacity ?? 8));
  const [repeatWeeks, setRepeatWeeks] = React.useState('1');
  const [notes, setNotes] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const chosen = data.classes.find((c) => c.id === serviceId);
  // Only the people who run this class *and* work at this site — the server refuses
  // the rest anyway, and a list that cannot be picked from is not a list.
  const instructors = data.instructors.filter(
    (p) => (!locationId || !p.locationIds.length || p.locationIds.includes(locationId)) && (!serviceId || !p.serviceIds.length || p.serviceIds.includes(serviceId))
  );
  const rooms = data.rooms.filter((r) => !locationId || r.locationId === locationId);

  React.useEffect(() => {
    if (!instructors.some((p) => p.id === providerId)) setProviderId(instructors[0]?.id ?? '');
  }, [instructors, providerId]);
  React.useEffect(() => {
    if (chosen) {
      setDuration(String(chosen.durationMinutes));
      setCapacity(String(chosen.capacity));
    }
  }, [chosen]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await request<{ created: number }>('POST', '/api/v1/classes', {
        action: 'create',
        serviceId,
        providerId,
        locationId,
        roomId: roomId || undefined,
        date,
        time,
        durationMinutes: Number(duration),
        capacity: Number(capacity),
        repeatWeeks: Number(repeatWeeks),
        notes: notes || undefined,
      });
      onDone(result.created > 1 ? `${result.created} sessions added.` : 'Session added.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add that session.');
    } finally {
      setBusy(false);
    }
  };

  const field = 'w-full rounded-lg border border-slate-900/[0.06] bg-slate-900/[0.04] px-3 py-2 text-[13.5px] text-slate-900 outline-none focus:border-brand-500/50';
  const label = 'mb-1 block text-[12px] text-slateink-300';

  return (
    <Modal open onClose={onClose} title="New class session">
      <div className="space-y-3">
        <div>
          <label className={label}>Class</label>
          <select className={field} value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
            {data.classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.capacity} places
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={label}>Instructor</label>
            <select className={field} value={providerId} onChange={(e) => setProviderId(e.target.value)}>
              {instructors.length === 0 ? <option value="">Nobody runs this here</option> : null}
              {instructors.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={label}>Site</label>
            <select className={field} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              {data.sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={label}>Room</label>
            <select className={field} value={roomId} onChange={(e) => setRoomId(e.target.value)}>
              <option value="">Whichever is free</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={label}>Places</label>
            <input className={field} value={capacity} inputMode="numeric" onChange={(e) => setCapacity(e.target.value.replace(/\D/g, ''))} />
          </div>
          <div>
            <label className={label}>Date</label>
            <input type="date" className={field} value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label className={label}>Start (site's own clock)</label>
            <input type="time" className={field} value={time} onChange={(e) => setTime(e.target.value)} />
          </div>
          <div>
            <label className={label}>Minutes</label>
            <input className={field} value={duration} inputMode="numeric" onChange={(e) => setDuration(e.target.value.replace(/\D/g, ''))} />
          </div>
          <div>
            <label className={label}>Repeat weekly</label>
            <select className={field} value={repeatWeeks} onChange={(e) => setRepeatWeeks(e.target.value)}>
              {['1', '2', '4', '8', '12'].map((n) => (
                <option key={n} value={n}>
                  {n === '1' ? 'Just this once' : `${n} weeks`}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className={label}>Notes for the desk</label>
          <input className={field} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Mats provided, arrive 5 minutes early" />
        </div>
        {error ? <p className="rounded-lg border border-red-400/25 bg-red-400/[0.06] px-3 py-2 text-[12.5px] text-red-700">{error}</p> : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !serviceId || !providerId || !locationId}>
            {busy ? 'Adding…' : Number(repeatWeeks) > 1 ? 'Add the run' : 'Add it'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------- roster */

function RosterModal({
  id,
  roster,
  busy,
  onClose,
  onAdd,
  onRemove,
  onMark,
  onEveryone,
  onWait,
  onUnwait,
  onCancelSession,
}: {
  id: string;
  roster: Roster | null;
  busy: boolean;
  onClose: () => void;
  onAdd: (body: Record<string, unknown>) => void;
  onRemove: (bookingId: string) => void;
  onMark: (bookingId: string, status: string) => void;
  onEveryone: () => void;
  onWait: (body: Record<string, unknown>) => void;
  onUnwait: (entryId: string) => void;
  onCancelSession: (reason: string) => void;
}) {
  const [name, setName] = React.useState('');
  const [number, setNumber] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [matches, setMatches] = React.useState<{ id: string; name: string; number?: string }[]>([]);
  const [confirming, setConfirming] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [waiterName, setWaiterName] = React.useState('');
  const [waiterNumber, setWaiterNumber] = React.useState('');

  React.useEffect(() => {
    const q = search.trim();
    if (q.length < 2) {
      setMatches([]);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const found = await request<{ data: { id: string; name: string; number?: string }[] }>('GET', `/api/v1/clients?search=${encodeURIComponent(q)}&limit=6`);
        if (alive) setMatches(found.data ?? []);
      } catch {
        if (alive) setMatches([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [search]);

  const session = roster?.session;

  return (
    <Modal open onClose={onClose} title={session ? `${session.serviceName} — ${session.local.spoken}` : 'Class roster'}>
      {!roster ? (
        <p className="py-6 text-center text-[13px] text-slateink-400">Reading the roster…</p>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12.5px] text-slateink-300">
            <span>{[session?.providerName, session?.locationName, session?.roomName].filter(Boolean).join(' · ')}</span>
            <span className="font-mono">
              {session?.local.start}–{session?.local.end}
            </span>
            <Seats session={session!} />
            {roster.attendance ? (
              <span className="text-slateink-200">
                {roster.attendance.attended} of {roster.attendance.seats} here
                {roster.attendance.completed ? ` · ${roster.attendance.completed} done` : ''}
                {roster.attendance.noShow ? ` · ${roster.attendance.noShow} no-show` : ''}
              </span>
            ) : null}
            {session?.notes ? <span className="text-slateink-400">{session.notes}</span> : null}
          </div>

          {roster.attendance && roster.attendance.confirmed > 0 && session?.status !== 'cancelled' ? (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-900/[0.035] bg-slate-900/[0.02] px-3.5 py-2.5">
              <span className="text-[12.5px] text-slateink-300">
                {roster.attendance.confirmed} still to arrive — or mark the room in one go.
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={onEveryone}
                className="rounded-lg border border-brand-400/40 bg-brand-400/10 px-2.5 py-1 text-[12px] text-brand-800 transition hover:bg-brand-400/15 disabled:opacity-50"
              >
                Everyone&apos;s here
              </button>
            </div>
          ) : null}

          {roster.roster.length === 0 ? (
            <p className="rounded-xl border border-slate-900/[0.035] bg-slate-900/[0.02] px-3.5 py-2.5 text-[13px] text-slateink-300">
              Nobody yet — {session?.capacity} places to fill.
            </p>
          ) : (
            <div className="overflow-hidden rounded-xl border border-slate-900/[0.035]">
              {roster.roster.map((seat) => (
                <div key={seat.bookingId} className="flex items-center gap-3 border-b border-slate-900/[0.035] px-3.5 py-2.5 last:border-b-0">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] text-slate-900">{seat.name}</span>
                    <span className="block truncate font-mono text-[11.5px] text-slateink-400">
                      {seat.number} · {seat.reference}
                    </span>
                  </span>
                  {seat.packId ? (
                    <Pill tone={seat.packState === 'spent' ? 'brand' : 'warn'}>{seat.packState === 'spent' ? 'pack · spent' : 'on pack'}</Pill>
                  ) : null}
                  <Pill tone={seat.status === 'arrived' || seat.status === 'completed' ? 'brand' : seat.status === 'no_show' ? 'default' : 'default'}>
                    {seat.status === 'no_show' ? 'no-show' : seat.status}
                  </Pill>
                  {session?.status !== 'cancelled' ? (
                    <span className="flex items-center gap-1.5">
                      {REGISTER_STEPS[seat.status]?.next ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onMark(seat.bookingId, REGISTER_STEPS[seat.status].next!)}
                          className="rounded-lg border border-slate-900/[0.06] px-2.5 py-1 text-[12px] text-slate-900 transition hover:border-brand-400/40 disabled:opacity-50"
                        >
                          {REGISTER_STEPS[seat.status].label}
                        </button>
                      ) : null}
                      {REGISTER_STEPS[seat.status]?.undo ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onMark(seat.bookingId, 'confirmed')}
                          className="rounded-lg border border-slate-900/[0.06] px-2.5 py-1 text-[12px] text-slateink-200 transition hover:text-slate-900 disabled:opacity-50"
                          title="Undo — put the place back to booked"
                        >
                          Undo
                        </button>
                      ) : null}
                      {['pending', 'confirmed', 'arrived'].includes(seat.status) ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onMark(seat.bookingId, 'no_show')}
                          className="rounded-lg border border-slate-900/[0.06] px-2.5 py-1 text-[12px] text-slateink-400 transition hover:border-amber-400/40 hover:text-slate-900 disabled:opacity-50"
                          title="Did not come"
                        >
                          No-show
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onRemove(seat.bookingId)}
                        className="rounded-lg border border-slate-900/[0.06] px-2.5 py-1 text-[12px] text-slateink-200 transition hover:border-red-400/40 hover:text-slate-900 disabled:opacity-50"
                      >
                        Give place back
                      </button>
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          )}

          {/* The line for a place. Only a full class has one, because a queue
              beside an empty seat is a queue nobody should join. */}
          <div className="rounded-xl border border-slate-900/[0.035] bg-slate-900/[0.02] p-3.5">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[13px] font-medium text-slate-900">
                Waiting for a place
                {roster.waitList?.count ? (
                  <span className="ml-2 font-mono text-[11.5px] text-brand-700">{roster.waitList.count} in line</span>
                ) : null}
              </div>
              {roster.waitList?.openOffers ? (
                <span className="text-[11.5px] text-slateink-400">
                  {roster.waitList.openOffers} offer{roster.waitList.openOffers === 1 ? '' : 's'} out
                </span>
              ) : null}
            </div>
            {roster.waitList?.count ? (
              <div className="mt-2 overflow-hidden rounded-lg border border-slate-900/[0.04]">
                {roster.waitList.waiting.map((waiter) => (
                  <div key={waiter.id} className="flex items-center gap-3 border-b border-slate-900/[0.035] px-3 py-2 last:border-b-0">
                    <span className="w-5 shrink-0 text-center font-mono text-[11px] text-slateink-400">{waiter.position}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-slate-900">{waiter.name}</span>
                      <span className="block truncate font-mono text-[11px] text-slateink-400">{waiter.number}</span>
                    </span>
                    {waiter.status === 'offered' ? (
                      <Pill tone="brand">
                        {waiter.offeredUntil ? `offered · until ${new Date(waiter.offeredUntil).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : 'offered'}
                      </Pill>
                    ) : null}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onUnwait(waiter.id)}
                      className="rounded-lg border border-slate-900/[0.06] px-2 py-0.5 text-[11.5px] text-slateink-300 transition hover:text-slate-900 disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-1.5 text-[12.5px] text-slateink-400">
                Nobody in line. A line only opens when the class is full — until then the place is bookable.
              </p>
            )}
            {session && session.seatsLeft <= 0 && session.status !== 'cancelled' ? (
              <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <input
                  className="w-full rounded-lg border border-slate-900/[0.06] bg-slate-900/[0.04] px-3 py-2 text-[13px] text-slate-900 outline-none focus:border-brand-500/50"
                  placeholder="Name, to ring when a place frees"
                  value={waiterName}
                  onChange={(e) => setWaiterName(e.target.value)}
                />
                <input
                  className="w-full rounded-lg border border-slate-900/[0.06] bg-slate-900/[0.04] px-3 py-2 text-[13px] text-slate-900 outline-none focus:border-brand-500/50"
                  placeholder="Mobile number"
                  value={waiterNumber}
                  onChange={(e) => setWaiterNumber(e.target.value)}
                />
                <Button
                  variant="quiet"
                  disabled={busy || waiterName.trim().length < 2 || waiterNumber.replace(/\D/g, '').length < 7}
                  onClick={() => {
                    onWait({ name: waiterName.trim(), number: waiterNumber.trim() });
                    setWaiterName('');
                    setWaiterNumber('');
                  }}
                >
                  Add to the line
                </Button>
              </div>
            ) : null}
          </div>

          <div className="rounded-xl border border-slate-900/[0.035] bg-slate-900/[0.02] p-3.5">
            <div className="text-[13px] font-medium text-slate-900">Add somebody</div>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <input
                className="w-full rounded-lg border border-slate-900/[0.06] bg-slate-900/[0.04] px-3 py-2 text-[13px] text-slate-900 outline-none focus:border-brand-500/50"
                placeholder="Search a client…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  className="w-full rounded-lg border border-slate-900/[0.06] bg-slate-900/[0.04] px-3 py-2 text-[13px] text-slate-900 outline-none focus:border-brand-500/50"
                  placeholder="or name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <input
                  className="w-full rounded-lg border border-slate-900/[0.06] bg-slate-900/[0.04] px-3 py-2 text-[13px] text-slate-900 outline-none focus:border-brand-500/50"
                  placeholder="number"
                  value={number}
                  onChange={(e) => setNumber(e.target.value)}
                />
              </div>
            </div>
            {matches.length ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {matches.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    disabled={busy || (session ? session.seatsLeft <= 0 : true)}
                    onClick={() => onAdd({ clientId: m.id })}
                    className="rounded-lg border border-slate-900/[0.06] bg-slate-900/[0.04] px-2.5 py-1 text-[12px] text-slate-900 transition hover:border-brand-500/40 disabled:opacity-50"
                  >
                    {m.name}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-[12px] text-slateink-400">
                {session && session.seatsLeft <= 0 ? 'No places left — give one back first.' : session ? `${session.seatsLeft} place(s) left.` : ''}
              </span>
              <Button
                variant="quiet"
                disabled={busy || !name.trim() || !number.trim() || (session ? session.seatsLeft <= 0 : true)}
                onClick={() => {
                  onAdd({ name: name.trim(), number: number.trim() });
                  setName('');
                  setNumber('');
                }}
              >
                Add a new client
              </Button>
            </div>
          </div>

          {confirming ? (
            <div className="rounded-xl border border-red-400/25 bg-red-400/[0.06] p-3.5">
              <div className="text-[13px] font-medium text-red-800">Cancel the whole session?</div>
              <p className="mt-1 text-[12.5px] text-red-700">
                Every place is released and each person is texted that it is off. This cannot be undone — make a new session instead.
              </p>
              <input
                className="mt-2 w-full rounded-lg border border-slate-900/[0.06] bg-slate-900/[0.04] px-3 py-2 text-[13px] text-slate-900 outline-none focus:border-red-400/50"
                placeholder="Reason for the clients (optional)"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <div className="mt-2 flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
                  Keep it
                </Button>
                <Button variant="danger" disabled={busy} onClick={() => onCancelSession(reason.trim())}>
                  {busy ? 'Cancelling…' : 'Cancel the session'}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex justify-end">
              <Button variant="ghost" onClick={() => setConfirming(true)} disabled={busy || session?.status === 'cancelled'}>
                Cancel the whole session…
              </Button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
