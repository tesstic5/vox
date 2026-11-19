'use client';

/**
 * The practice — diary, people, services, sites and hours.
 *
 * This screen is the reason the AI tools can be trusted: it reads and writes the
 * *same* records (`/api/v1/providers`, `/v1/services`, `/v1/rota`,
 * `/v1/availability`) that `check_availability` books against. Nothing here is
 * optimistic and nothing is mirrored into localStorage — a practice can hand a
 * receptionist this screen and know the phone agent and the desk see one diary.
 *
 * Every label is rendered from the organisation's term pack, so a clinic reads
 * "patients" and "practitioners" where a services company reads "customers" and
 * "technicians" — one record shape, two vocabularies.
 */

import * as React from 'react';
import { ApiError, request } from '@/lib/server-sync';
import { cn, fmtDate } from '@/lib/utils';
import { Icons } from '@/components/icons';
import { Button, EmptyState, LinkButton, Modal, Pill, Tabs, Toggle, useToast } from '@/components/ui';
import { DataTable } from '@/components/dash/bits';
import { PageHeader } from '@/components/dash/Shell';
import type { TermPackId, Terms } from '@/lib/terms';

/* ------------------------------------------------------------------- types */

type Provider = {
  id: string;
  name: string;
  title?: string;
  email?: string;
  colour?: string;
  serviceIds: string[];
  locationIds: string[];
  active: boolean;
  assignableTo?: { id: string; name: string }[];
  worksAt?: { id: string; name: string }[];
};

type Service = {
  id: string;
  name: string;
  code?: string;
  description?: string;
  durationMinutes: number;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  slotStepMinutes?: number;
  /** Days before this service's clients are recalled; unset means the practice's window. */
  recallDays?: number;
  price?: number;
  colour?: string;
  active: boolean;
};

type Room = { id: string; name: string };
type Location = { id: string; name: string; address?: string; timezone: string; rooms: Room[]; active: boolean };

type Window = { weekday: number; start: string; end: string };
type Break = { start: string; end: string; label?: string };
type Rota = { id: string; providerId: string; locationId: string; windows: Window[]; breaks: Break[] };
type RotaChange = { id: string; providerId: string; date: string; kind: 'off' | 'extra'; windows?: Window[]; reason?: string };

type Slot = {
  startsAt: string;
  endsAt?: string;
  local: { date: string; start: string; end: string; timezone: string };
  providerId?: string;
  providerName?: string;
  serviceId?: string;
  serviceName?: string;
  locationId?: string;
  locationName?: string;
  roomId?: string;
  roomName?: string;
  taken?: boolean;
};

type Availability = {
  data: Slot[];
  timezone: string;
  service?: { id: string; name: string; durationMinutes: number } | null;
  scanned?: number;
  reason?: string;
  policy: { minNoticeMinutes: number; maxAdvanceDays: number; slotStepMinutes: number };
};

type Booking = {
  id: string;
  externalId: string;
  customer: { name: string; number: string; email?: string };
  service: string;
  startsAt: string;
  durationMinutes: number;
  status: 'pending' | 'confirmed' | 'cancelled' | 'completed' | 'no_show';
  providerId?: string;
  serviceId?: string;
  locationId?: string;
  value?: number;
  description?: string;
};

type Profile = { termPack: TermPackId; slotStepMinutes: number; minNoticeMinutes: number; maxAdvanceDays: number };

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const COLOURS = ['brand', 'violet', 'emerald', 'amber', 'rose', 'sky'] as const;

function colourClass(colour?: string) {
  const map: Record<string, string> = {
    brand: 'border-brand-500/40 bg-brand-500/10 text-brand-700',
    violet: 'border-violet-500/40 bg-violet-500/10 text-violet-800',
    emerald: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700',
    amber: 'border-amber-500/40 bg-amber-500/10 text-amber-800',
    rose: 'border-rose-500/40 bg-rose-500/10 text-rose-700',
    sky: 'border-sky-500/40 bg-sky-500/10 text-sky-800',
  };
  return map[colour ?? 'brand'] ?? map.brand;
}

function todayIn(timezone: string) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function clockToMinutes(value: string) {
  const [h, m] = value.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/* ------------------------------------------------------------------- page */

export default function PracticePage() {
  const toast = useToast();
  /**
   * The open tab, and the address bar.
   *
   * `?tab=` is read on load and written as you switch, so a link from the
   * dashboard's practice checklist ("Set hours") lands on the hours tab instead
   * of dumping somebody on the diary to find it themselves — and so a colleague
   * can be sent the screen you are looking at.
   */
  const [tab, setTab] = React.useState(() => {
    if (typeof window === 'undefined') return 'schedule';
    const wanted = new URLSearchParams(window.location.search).get('tab');
    return wanted && ['schedule', 'team', 'services', 'locations', 'hours', 'booking'].includes(wanted) ? wanted : 'schedule';
  });
  const chooseTab = (next: string) => {
    setTab(next);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('tab', next);
      window.history.replaceState(null, '', url.toString());
    }
  };
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [profile, setProfile] = React.useState<Profile>({ termPack: 'generic', slotStepMinutes: 15, minNoticeMinutes: 0, maxAdvanceDays: 60 });
  const [terms, setTerms] = React.useState<Terms | null>(null);
  const [providers, setProviders] = React.useState<Provider[]>([]);
  const [services, setServices] = React.useState<Service[]>([]);
  const [locations, setLocations] = React.useState<Location[]>([]);
  const [rota, setRota] = React.useState<Rota[]>([]);
  const [changes, setChanges] = React.useState<RotaChange[]>([]);
  const [bookings, setBookings] = React.useState<Booking[]>([]);
  const [availability, setAvailability] = React.useState<Availability | null>(null);

  const [date, setDate] = React.useState<string>('');
  const [providerFilter, setProviderFilter] = React.useState('');
  const [serviceFilter, setServiceFilter] = React.useState('');

  const load = React.useCallback(async () => {
    try {
      const [p, pv, sv, lc, rt, ch, bk] = await Promise.all([
        request<{ profile: Profile; terms: Terms }>('GET', '/api/v1/practice/profile'),
        request<{ data: Provider[] }>('GET', '/api/v1/providers?includeInactive=true'),
        request<{ data: Service[] }>('GET', '/api/v1/services?includeInactive=true'),
        request<{ data: Location[] }>('GET', '/api/v1/locations?includeInactive=true'),
        request<{ data: Rota[] }>('GET', '/api/v1/rota'),
        request<{ data: RotaChange[] }>('GET', '/api/v1/rota-changes'),
        request<{ data: Booking[] }>('GET', '/api/v1/bookings?limit=200'),
      ]);
      setProfile(p.profile);
      setTerms(p.terms);
      setProviders(pv.data);
      setServices(sv.data);
      setLocations(lc.data);
      setRota(rt.data);
      setChanges(ch.data);
      setBookings(bk.data);
      setDate((d) => d || todayIn(lc.data[0]?.timezone ?? 'UTC'));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the practice.');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAvailability = React.useCallback(async () => {
    if (!date) return;
    const params = new URLSearchParams({ from: date, days: '1', limit: '60', includeTaken: 'true' });
    if (providerFilter) params.set('providerId', providerFilter);
    if (serviceFilter) params.set('serviceId', serviceFilter);
    try {
      setAvailability(await request<Availability>('GET', `/api/v1/availability?${params.toString()}`));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Availability failed', 'error');
    }
  }, [date, providerFilter, serviceFilter, toast]);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    void loadAvailability();
  }, [loadAvailability]);

  const open = React.useMemo(() => (availability?.data ?? []).filter((s) => !s.taken), [availability]);
  const takenSlots = React.useMemo(() => (availability?.data ?? []).filter((s) => s.taken), [availability]);
  const dayBookings = React.useMemo(
    () => bookings.filter((b) => todayIn(availability?.timezone ?? 'UTC') && b.startsAt.slice(0, 10) === date && b.status !== 'cancelled'),
    [bookings, date, availability]
  );

  const termsLabel = terms ?? {
    client: { one: 'client', many: 'clients', One: 'Client', Many: 'Clients' },
    provider: { one: 'team member', many: 'team members', One: 'Team member', Many: 'Team members' },
    service: { one: 'service', many: 'services', One: 'Service', Many: 'Services' },
    appointment: { one: 'appointment', many: 'appointments', One: 'Appointment', Many: 'Appointments' },
    note: { one: 'note', many: 'notes', One: 'Note', Many: 'Notes' },
    location: { one: 'location', many: 'locations', One: 'Location', Many: 'Locations' },
  };

  if (loading) {
    return (
      <>
        <PageHeader title="Practice" desc="Loading the diary…" />
        <div className="panel h-64 animate-pulse bg-ink-850/40" />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Practice setup"
        desc="Everything the diary needs to be real: what you do, who does it, where, and when you are open. The AI books against exactly these."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => void load().then(loadAvailability)}>
              <Icons.refresh size={14} /> Refresh
            </Button>
          </div>
        }
      />

      {error && (
        <div className="mb-5 flex items-start gap-3 rounded-2xl border border-rose-500/30 bg-rose-500/[0.07] p-4 text-[13px] text-rose-700">
          <Icons.alert size={16} className="mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">{error}</div>
            <button className="mt-1 underline decoration-dotted" onClick={() => void load()}>
              Try again
            </button>
          </div>
        </div>
      )}

      <Tabs
        className="mb-5"
        active={tab}
        onChange={chooseTab}
        tabs={[
          { id: 'schedule', label: 'Diary', badge: String(dayBookings.length || '') },
          { id: 'team', label: termsLabel.provider.Many },
          { id: 'services', label: termsLabel.service.Many },
          { id: 'locations', label: termsLabel.location.Many },
          { id: 'hours', label: 'Hours & rules' },
          { id: 'booking', label: 'Online booking' },
        ]}
      />

      {tab === 'schedule' && (
        <ScheduleTab
          terms={termsLabel}
          date={date}
          setDate={setDate}
          providerFilter={providerFilter}
          setProviderFilter={setProviderFilter}
          serviceFilter={serviceFilter}
          setServiceFilter={setServiceFilter}
          providers={providers}
          services={services}
          open={open}
          taken={takenSlots}
          availability={availability}
          bookings={dayBookings}
          onBooked={() => void load().then(loadAvailability)}
        />
      )}
      {tab === 'team' && (
        <TeamTab terms={termsLabel} providers={providers} services={services} locations={locations} onChange={() => void load()} />
      )}
      {tab === 'services' && <ServicesTab terms={termsLabel} services={services} onChange={() => void load()} />}
      {tab === 'locations' && <LocationsTab terms={termsLabel} locations={locations} onChange={() => void load()} />}
      {tab === 'booking' && <BookingTab terms={termsLabel} />}
      {tab === 'hours' && (
        <HoursTab
          terms={termsLabel}
          profile={profile}
          providers={providers}
          locations={locations}
          rota={rota}
          changes={changes}
          onSaved={() => void load()}
        />
      )}
    </>
  );
}

/* --------------------------------------------------------------- schedule */

function ScheduleTab({
  terms,
  date,
  setDate,
  providerFilter,
  setProviderFilter,
  serviceFilter,
  setServiceFilter,
  providers,
  services,
  open,
  taken,
  availability,
  bookings,
  onBooked,
}: {
  terms: Terms;
  date: string;
  setDate: (d: string) => void;
  providerFilter: string;
  setProviderFilter: (v: string) => void;
  serviceFilter: string;
  setServiceFilter: (v: string) => void;
  providers: Provider[];
  services: Service[];
  open: Slot[];
  taken: Slot[];
  availability: Availability | null;
  bookings: Booking[];
  onBooked: () => void;
}) {
  const toast = useToast();
  const [booking, setBooking] = React.useState<Slot | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [form, setForm] = React.useState({ name: '', number: '', email: '', notes: '' });

  const byProvider = React.useMemo(() => {
    const map = new Map<string, { name: string; slots: Slot[] }>();
    for (const slot of open) {
      const key = slot.providerId ?? 'unassigned';
      const entry = map.get(key) ?? { name: slot.providerName ?? 'Unassigned', slots: [] };
      entry.slots.push(slot);
      map.set(key, entry);
    }
    return [...map.entries()];
  }, [open]);

  async function submit() {
    if (!booking) return;
    if (!form.name.trim() || !form.number.trim()) {
      toast('A name and a number, please — those are what the confirmation uses.', 'error');
      return;
    }
    setSaving(true);
    try {
      await request('POST', '/api/v1/bookings', {
        externalId: `dash-${Date.now().toString(36)}`,
        customer: { name: form.name, number: form.number, email: form.email || undefined },
        startsAt: booking.startsAt,
        serviceId: booking.serviceId,
        providerId: booking.providerId,
        locationId: booking.locationId,
        roomId: booking.roomId,
        notes: form.notes || undefined,
        status: 'confirmed',
      });
      toast(`Booked ${form.name} at ${booking.local.start} — the slot is gone from every view.`);
      setBooking(null);
      setForm({ name: '', number: '', email: '', notes: '' });
      onBooked();
    } catch (err) {
      // The 409 here is the point of the whole engine: two views, one answer.
      toast(err instanceof ApiError ? err.message : 'Booking failed', 'error');
      onBooked();
    } finally {
      setSaving(false);
    }
  }

  const tz = availability?.timezone ?? 'UTC';

  return (
    <>
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <div className="min-w-[150px]">
          <label className="label" htmlFor="p-date">
            Day ({tz})
          </label>
          <input id="p-date" type="date" className="field text-[13px]" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="min-w-[180px]">
          <label className="label" htmlFor="p-provider">
            {terms.provider.One}
          </label>
          <select id="p-provider" className="field text-[13px]" value={providerFilter} onChange={(e) => setProviderFilter(e.target.value)}>
            <option value="">Everyone</option>
            {providers.filter((p) => p.active).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-[200px]">
          <label className="label" htmlFor="p-service">
            {terms.service.One}
          </label>
          <select id="p-service" className="field text-[13px]" value={serviceFilter} onChange={(e) => setServiceFilter(e.target.value)}>
            <option value="">Any {terms.service.one}</option>
            {services.filter((s) => s.active).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.durationMinutes}m
              </option>
            ))}
          </select>
        </div>
        <div className="ml-auto flex items-center gap-2 text-[12px] text-slateink-400">
          <Pill tone="brand">{open.length} open</Pill>
          <Pill tone="info">{taken.length} taken</Pill>
          {availability?.service && <Pill tone="default">{availability.service.name}</Pill>}
        </div>
      </div>

      {availability?.reason && open.length === 0 && (
        <div className="mb-5 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-3 text-[12.5px] text-amber-800">{availability.reason}</div>
      )}

      <div className="grid gap-5 lg:grid-cols-[1.35fr_1fr]">
        <div className="panel p-5">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="h4">Open {terms.appointment.many}</h3>
            <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-slateink-400">
              {fmtDate(date)}
            </span>
          </div>
          {open.length === 0 ? (
            <EmptyState
              icon="calendar"
              title={`Nothing free on ${fmtDate(date)}`}
              desc={`Working hours, holidays and buffers are all applied — the same answer the phone agent gives.`}
            />
          ) : (
            <div className="space-y-5">
              {byProvider.map(([id, group]) => (
                <div key={id}>
                  <div className="mb-2 flex items-center gap-2 text-[12.5px] text-slateink-300">
                    <Icons.users size={13} /> {group.name}
                    <span className="text-slateink-500">· {group.slots.length} free</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {group.slots.map((slot) => (
                      <button
                        key={slot.startsAt + (slot.roomId ?? '')}
                        onClick={() => setBooking(slot)}
                        className={cn(
                          'rounded-xl border px-3 py-2 text-left text-[12.5px] transition-colors hover:border-slate-900/[0.05]',
                          colourClass(services.find((s) => s.id === slot.serviceId)?.colour)
                        )}
                        title={`${slot.local.start}–${slot.local.end}${slot.roomName ? ` · ${slot.roomName}` : ''}`}
                      >
                        <span className="block font-medium">{slot.local.start}</span>
                        <span className="block text-[11px] opacity-80">{slot.serviceName ?? terms.service.One}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="panel p-5">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="h4">On the diary</h3>
            <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-slateink-400">{bookings.length} booked</span>
          </div>
          {bookings.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-slateink-400">
              No {terms.appointment.many} on {fmtDate(date)}.
            </p>
          ) : (
            <ul className="space-y-2">
              {bookings
                .slice()
                .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
                .map((b) => (
                  <li key={b.id} className="flex items-start gap-3 rounded-xl border border-slate-900/[0.04] bg-ink-900/40 p-3">
                    <span className="mt-0.5 font-mono text-[11.5px] text-brand-700">
                      {new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(b.startsAt))}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] text-slate-900">{b.customer.name}</div>
                      <div className="truncate text-[11.5px] text-slateink-400">
                        {b.service}
                        {b.providerId ? ` · ${providers.find((p) => p.id === b.providerId)?.name ?? ''}` : ''}
                      </div>
                    </div>
                    <Pill tone={b.status === 'confirmed' ? 'brand' : b.status === 'cancelled' ? 'danger' : 'default'}>{b.status}</Pill>
                  </li>
                ))}
            </ul>
          )}

          {taken.length > 0 && (
            <div className="mt-5 border-t border-slate-900/[0.04] pt-4">
              <div className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-slateink-400">Slots the engine says are taken</div>
              <div className="flex flex-wrap gap-1.5">
                {taken.map((slot) => (
                  <span key={slot.startsAt} className="rounded-lg border border-slate-900/[0.035] px-2 py-1 text-[11.5px] text-slateink-400 line-through">
                    {slot.local.start}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <Modal
        open={!!booking}
        onClose={() => setBooking(null)}
        title={booking ? `Book ${booking.local.start} on ${fmtDate(booking.local.date)}` : 'Book'}
        desc={booking ? `${booking.providerName ?? 'Unassigned'}${booking.roomName ? ` · ${booking.roomName}` : ''}${booking.serviceName ? ` · ${booking.serviceName}` : ''}` : undefined}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setBooking(null)}>
              Cancel
            </Button>
            <Button variant="brand" size="sm" disabled={saving} onClick={() => void submit()}>
              {saving ? 'Booking…' : `Book the ${terms.appointment.one}`}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="pb-name">
                {terms.client.One} name
              </label>
              <input id="pb-name" className="field text-[13px]" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="pb-number">
                Phone
              </label>
              <input id="pb-number" className="field text-[13px]" placeholder="+14155550123" value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} />
            </div>
          </div>
          <div>
            <label className="label" htmlFor="pb-email">
              Email (optional)
            </label>
            <input id="pb-email" className="field text-[13px]" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="pb-notes">
              Notes
            </label>
            <textarea id="pb-notes" rows={2} className="field text-[13px]" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
          <p className="text-[12px] text-slateink-400">
            The engine re-checks the slot on write. If someone took it in the meantime you get a conflict, not a double booking.
          </p>
        </div>
      </Modal>
    </>
  );
}

/* ------------------------------------------------------------------- team */

function TeamTab({
  terms,
  providers,
  services,
  locations,
  onChange,
}: {
  terms: Terms;
  providers: Provider[];
  services: Service[];
  locations: Location[];
  onChange: () => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = React.useState<Provider | 'new' | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [form, setForm] = React.useState({
    name: '',
    title: '',
    email: '',
    colour: 'brand',
    serviceIds: [] as string[],
    locationIds: [] as string[],
    active: true,
  });

  function start(p: Provider | 'new') {
    if (p === 'new') {
      setForm({ name: '', title: '', email: '', colour: 'brand', serviceIds: services.map((s) => s.id), locationIds: locations.filter((l) => l.active).map((l) => l.id), active: true });
    } else {
      setForm({
        name: p.name,
        title: p.title ?? '',
        email: p.email ?? '',
        colour: p.colour ?? 'brand',
        serviceIds: p.serviceIds,
        locationIds: p.locationIds,
        active: p.active,
      });
    }
    setEditing(p);
  }

  async function save() {
    if (!form.name.trim()) {
      toast(`A ${terms.provider.one} needs a name.`, 'error');
      return;
    }
    setSaving(true);
    try {
      if (editing === 'new') await request('POST', '/api/v1/providers', form);
      else if (editing) await request('PATCH', `/api/v1/providers/${editing.id}`, form);
      toast(editing === 'new' ? `${form.name} added.` : 'Saved.');
      setEditing(null);
      onChange();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function remove(p: Provider) {
    try {
      await request('DELETE', `/api/v1/providers/${p.id}`);
      toast(`${p.name} removed.`);
      onChange();
    } catch (err) {
      // A 409 with a count is the useful answer here, not a deleted diary.
      toast(err instanceof ApiError ? err.message : 'Delete failed', 'error');
    }
  }

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-[13px] text-slateink-400">
          Who can be booked, what they do, and where they work. The agent only offers times for someone whose hours make it possible.
        </p>
        <Button variant="brand" size="sm" onClick={() => start('new')}>
          <Icons.plus size={14} /> New {terms.provider.one}
        </Button>
      </div>

      {providers.length === 0 ? (
        <EmptyState icon="users" title={`No ${terms.provider.many} yet`} desc="Add someone and their working hours, and the diary starts taking bookings." action={<Button variant="brand" size="sm" onClick={() => start('new')}>Add the first {terms.provider.one}</Button>} />
      ) : (
        <DataTable columns={[{ key: 'name', label: terms.provider.One }, { key: 'does', label: 'Does' }, { key: 'works', label: 'Works at' }, { key: 'state', label: 'State' }, { key: 'act', label: '', align: 'right' }]}>
          {providers.map((p) => (
            <tr key={p.id} className="hover:bg-slate-900/[0.02]">
              <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className={cn('h-2.5 w-2.5 rounded-full bg-current', colourClass(p.colour))} />
                  <div>
                    <div className="text-[13px] text-slate-900">{p.name}</div>
                    {p.title && <div className="text-[11.5px] text-slateink-400">{p.title}</div>}
                  </div>
                </div>
              </td>
              <td className="px-4 py-3">
                <div className="flex flex-wrap gap-1.5">
                  {(p.assignableTo ?? []).map((s) => (
                    <span key={s.id} className="rounded-lg border border-slate-900/[0.035] px-2 py-0.5 text-[11.5px] text-slateink-300">
                      {s.name}
                    </span>
                  ))}
                  {(p.assignableTo ?? []).length === 0 && <span className="text-[11.5px] text-slateink-500">anything</span>}
                </div>
              </td>
              <td className="px-4 py-3 text-[12.5px] text-slateink-300">{(p.worksAt ?? []).map((l) => l.name).join(', ') || '—'}</td>
              <td className="px-4 py-3">
                <Pill tone={p.active ? 'brand' : 'default'}>{p.active ? 'active' : 'retired'}</Pill>
              </td>
              <td className="px-4 py-3 text-right">
                <div className="flex items-center justify-end gap-2">
                  <Button variant="quiet" size="sm" onClick={() => start(p)}>
                    Edit
                  </Button>
                  {p.active ? (
                    <Button variant="quiet" size="sm" onClick={() => void request('PATCH', `/api/v1/providers/${p.id}`, { active: false }).then(onChange).catch((e) => toast(e instanceof ApiError ? e.message : 'Failed', 'error'))}>
                      Retire
                    </Button>
                  ) : (
                    <Button variant="quiet" size="sm" onClick={() => void request('PATCH', `/api/v1/providers/${p.id}`, { active: true }).then(onChange).catch((e) => toast(e instanceof ApiError ? e.message : 'Failed', 'error'))}>
                      Reactivate
                    </Button>
                  )}
                  <Button variant="quiet" size="sm" onClick={() => void remove(p)}>
                    Delete
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </DataTable>
      )}

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? `New ${terms.provider.one}` : 'Edit'}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button variant="brand" size="sm" disabled={saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="t-name">
                Name
              </label>
              <input id="t-name" className="field text-[13px]" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="t-title">
                Title
              </label>
              <input id="t-title" className="field text-[13px]" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </div>
          </div>
          <div>
            <label className="label" htmlFor="t-email">
              Email
            </label>
            <input id="t-email" className="field text-[13px]" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div>
            <span className="label">Diary colour</span>
            <div className="flex gap-2">
              {COLOURS.map((c) => (
                <button
                  key={c}
                  onClick={() => setForm({ ...form, colour: c })}
                  className={cn('h-7 w-7 rounded-lg border', colourClass(c), form.colour === c && 'ring-2 ring-slate-900/60')}
                  aria-label={c}
                />
              ))}
            </div>
          </div>
          <div>
            <span className="label">{terms.service.Many} they can take</span>
            <div className="flex flex-wrap gap-2">
              {services.map((s) => {
                const on = form.serviceIds.includes(s.id);
                return (
                  <button
                    key={s.id}
                    onClick={() => setForm({ ...form, serviceIds: on ? form.serviceIds.filter((id) => id !== s.id) : [...form.serviceIds, s.id] })}
                    className={cn('rounded-lg border px-2.5 py-1 text-[12px]', on ? 'border-brand-500/50 bg-brand-500/10 text-brand-700' : 'border-slate-900/[0.04] text-slateink-300')}
                  >
                    {s.name}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <span className="label">{terms.location.Many}</span>
            <div className="flex flex-wrap gap-2">
              {locations.map((l) => {
                const on = form.locationIds.includes(l.id);
                return (
                  <button
                    key={l.id}
                    onClick={() => setForm({ ...form, locationIds: on ? form.locationIds.filter((id) => id !== l.id) : [...form.locationIds, l.id] })}
                    className={cn('rounded-lg border px-2.5 py-1 text-[12px]', on ? 'border-brand-500/50 bg-brand-500/10 text-brand-700' : 'border-slate-900/[0.04] text-slateink-300')}
                  >
                    {l.name}
                  </button>
                );
              })}
            </div>
          </div>
          <Toggle checked={form.active} onChange={(v) => setForm({ ...form, active: v })} label="Bookable" />
        </div>
      </Modal>
    </>
  );
}

/* --------------------------------------------------------------- services */

function ServicesTab({ terms, services, onChange }: { terms: Terms; services: Service[]; onChange: () => void }) {
  const toast = useToast();
  const [editing, setEditing] = React.useState<Service | 'new' | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [form, setForm] = React.useState({
    name: '',
    code: '',
    description: '',
    durationMinutes: 30,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    slotStepMinutes: 0,
    recallDays: 0,
    price: 0,
    colour: 'brand',
    active: true,
  });

  function start(s: Service | 'new') {
    if (s === 'new') {
      setForm({ name: '', code: '', description: '', durationMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, slotStepMinutes: 0, recallDays: 0, price: 0, colour: 'brand', active: true });
    } else {
      setForm({
        name: s.name,
        code: s.code ?? '',
        description: s.description ?? '',
        durationMinutes: s.durationMinutes,
        bufferBeforeMinutes: s.bufferBeforeMinutes ?? 0,
        bufferAfterMinutes: s.bufferAfterMinutes ?? 0,
        slotStepMinutes: s.slotStepMinutes ?? 0,
        recallDays: s.recallDays ?? 0,
        price: s.price ?? 0,
        colour: s.colour ?? 'brand',
        active: s.active,
      });
    }
    setEditing(s);
  }

  async function save() {
    if (!form.name.trim()) {
      toast(`A ${terms.service.one} needs a name.`, 'error');
      return;
    }
    if (Number(form.durationMinutes) <= 0) {
      toast('Duration must be more than zero.', 'error');
      return;
    }
    setSaving(true);
    try {
      const body = { ...form, code: form.code || undefined, description: form.description || undefined };
      if (editing === 'new') await request('POST', '/api/v1/services', body);
      else if (editing) await request('PATCH', `/api/v1/services/${editing.id}`, body);
      toast('Saved.');
      setEditing(null);
      onChange();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-[13px] text-slateink-400">
          Duration and buffers are what the availability engine reads — a 90-minute visit with a 15-minute changeover cannot be offered back-to-back.
        </p>
        <Button variant="brand" size="sm" onClick={() => start('new')}>
          <Icons.plus size={14} /> New {terms.service.one}
        </Button>
      </div>

      <DataTable columns={[{ key: 'n', label: terms.service.One }, { key: 'd', label: 'Duration' }, { key: 'b', label: 'Buffers' }, { key: 'p', label: 'Price', align: 'right' }, { key: 's', label: 'State' }, { key: 'a', label: '', align: 'right' }]}>
        {services.map((s) => (
          <tr key={s.id} className="hover:bg-slate-900/[0.02]">
            <td className="px-4 py-3">
              <div className="flex items-center gap-2">
                <span className={cn('h-2.5 w-2.5 rounded-full', colourClass(s.colour).split(' ').slice(1).join(' '))} />
                <div>
                  <div className="text-[13px] text-slate-900">{s.name}</div>
                  {s.description && <div className="text-[11.5px] text-slateink-400">{s.description}</div>}
                </div>
              </div>
            </td>
            <td className="px-4 py-3 font-mono text-[12px] text-slateink-300">
              {s.durationMinutes}m{s.slotStepMinutes ? ` · ${s.slotStepMinutes}m grid` : ''}{s.recallDays ? ` · recall ${s.recallDays}d` : ''}
            </td>
            <td className="px-4 py-3 font-mono text-[12px] text-slateink-300">
              {s.bufferBeforeMinutes ?? 0}m before · {s.bufferAfterMinutes ?? 0}m after
            </td>
            <td className="px-4 py-3 text-right font-mono text-[12px] text-slateink-300">{s.price ? `$${(s.price / 100).toFixed(2)}` : '—'}</td>
            <td className="px-4 py-3">
              <Pill tone={s.active ? 'brand' : 'default'}>{s.active ? 'offered' : 'hidden'}</Pill>
            </td>
            <td className="px-4 py-3 text-right">
              <div className="flex items-center justify-end gap-2">
                <Button variant="quiet" size="sm" onClick={() => start(s)}>
                  Edit
                </Button>
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() =>
                    void request('DELETE', `/api/v1/services/${s.id}`)
                      .then(() => {
                        toast('Removed.');
                        onChange();
                      })
                      .catch((e) => toast(e instanceof ApiError ? e.message : 'Delete failed', 'error'))
                  }
                >
                  Delete
                </Button>
              </div>
            </td>
          </tr>
        ))}
      </DataTable>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? `New ${terms.service.one}` : 'Edit'}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button variant="brand" size="sm" disabled={saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="s-name">
                Name
              </label>
              <input id="s-name" className="field text-[13px]" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="s-code">
                Code
              </label>
              <input id="s-code" className="field text-[13px]" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
            </div>
          </div>
          <div>
            <label className="label" htmlFor="s-desc">
              Description
            </label>
            <input id="s-desc" className="field text-[13px]" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="label" htmlFor="s-dur">
                Minutes
              </label>
              <input id="s-dur" type="number" min={5} step={5} className="field text-[13px]" value={form.durationMinutes} onChange={(e) => setForm({ ...form, durationMinutes: Number(e.target.value) })} />
            </div>
            <div>
              <label className="label" htmlFor="s-before">
                Buffer before
              </label>
              <input id="s-before" type="number" min={0} step={5} className="field text-[13px]" value={form.bufferBeforeMinutes} onChange={(e) => setForm({ ...form, bufferBeforeMinutes: Number(e.target.value) })} />
            </div>
            <div>
              <label className="label" htmlFor="s-after">
                Buffer after
              </label>
              <input id="s-after" type="number" min={0} step={5} className="field text-[13px]" value={form.bufferAfterMinutes} onChange={(e) => setForm({ ...form, bufferAfterMinutes: Number(e.target.value) })} />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="label" htmlFor="s-step">
                Grid (0 = shared)
              </label>
              <input id="s-step" type="number" min={0} step={5} className="field text-[13px]" value={form.slotStepMinutes} onChange={(e) => setForm({ ...form, slotStepMinutes: Number(e.target.value) })} />
            </div>
            <div>
              <label className="label" htmlFor="s-recall">
                Recall after (days, 0 = practice window)
              </label>
              <input id="s-recall" type="number" min={0} step={30} className="field text-[13px]" value={form.recallDays} onChange={(e) => setForm({ ...form, recallDays: Number(e.target.value) })} />
            </div>
            <div>
              <label className="label" htmlFor="s-price">
                Price (cents)
              </label>
              <input id="s-price" type="number" min={0} step={500} className="field text-[13px]" value={form.price} onChange={(e) => setForm({ ...form, price: Number(e.target.value) })} />
            </div>
            <div>
              <label className="label" htmlFor="s-colour">
                Colour
              </label>
              <select id="s-colour" className="field text-[13px]" value={form.colour} onChange={(e) => setForm({ ...form, colour: e.target.value })}>
                {COLOURS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <Toggle checked={form.active} onChange={(v) => setForm({ ...form, active: v })} label="Offered to callers" />
        </div>
      </Modal>
    </>
  );
}

/* -------------------------------------------------------------- locations */

function LocationsTab({ terms, locations, onChange }: { terms: Terms; locations: Location[]; onChange: () => void }) {
  const toast = useToast();
  const [editing, setEditing] = React.useState<Location | 'new' | null>(null);
  const [saving, setSaving] = React.useState(false);
  type RoomDraft = { id?: string; name: string; active?: boolean; was?: string; wasActive?: boolean };
  const [form, setForm] = React.useState({ name: '', address: '', timezone: 'America/Los_Angeles', rooms: [] as RoomDraft[] });
  const editingRef = React.useRef<Location | 'new' | null>(null);

  function start(l: Location | 'new') {
    if (l === 'new') {
      setForm({ name: '', address: '', timezone: 'America/Los_Angeles', rooms: [] });
      setEditing(l);
      editingRef.current = l;
      return;
    }
    // The site list carries the rooms on offer; the editor wants the retired
    // ones too, because a retired room is exactly what someone comes here to
    // bring back. Rooms are records with a stable id, so a rename here is a
    // rename server-side and the appointments in that room keep their room.
    setForm({ name: l.name, address: l.address ?? '', timezone: l.timezone, rooms: l.rooms.map((r) => ({ id: r.id, name: r.name, active: true, was: r.name, wasActive: true })) });
    setEditing(l);
    editingRef.current = l;
    void (async () => {
      try {
        const all = await request<{ data: { id: string; name: string; active: boolean }[] }>('GET', `/api/v1/rooms?locationId=${l.id}&includeInactive=true`);
        if (editingRef.current !== l) return;
        setForm((current) => ({
          ...current,
          rooms: (all.data ?? []).map((r) => ({ id: r.id, name: r.name, active: r.active, was: r.name, wasActive: r.active })),
        }));
      } catch {
        /* the mirror already gave us the live rooms; stay with those */
      }
    });
  }

  async function save() {
    if (!form.name.trim()) {
      toast(`A ${terms.location.one} needs a name.`, 'error');
      return;
    }
    setSaving(true);
    try {
      const body = { name: form.name, address: form.address || undefined, timezone: form.timezone };
      const rooms = form.rooms.map((r) => ({ ...r, name: r.name.trim() })).filter((r) => r.name);
      let locationId = editing !== 'new' && editing ? editing.id : '';
      if (editing === 'new') {
        const created = await request<{ id: string }>('POST', '/api/v1/locations', body);
        locationId = created.id;
      } else if (editing) {
        await request('PATCH', `/api/v1/locations/${editing.id}`, body);
      }

      // Rooms next, through their own door. Each write is a real change of
      // record (a rename, a retirement, a new room), so the audit trail names
      // which one happened instead of "location updated".
      const kept: string[] = [];
      for (const room of rooms) {
        if (!room.id) {
          await request('POST', '/api/v1/rooms', { action: 'create', locationId, name: room.name });
          continue;
        }
        kept.push(room.id);
        const patch: Record<string, unknown> = { action: 'update', id: room.id };
        if (room.was !== undefined && room.was !== room.name) patch.name = room.name;
        if (room.wasActive !== undefined && room.wasActive !== room.active) patch.active = room.active;
        if (Object.keys(patch).length > 2) await request('POST', '/api/v1/rooms', patch);
      }
      if (editing !== 'new' && editing) {
        const removed = editing.rooms.filter((r) => !kept.includes(r.id) && !rooms.some((draft) => draft.id === r.id));
        for (const room of removed) {
          try {
            await request('POST', '/api/v1/rooms', { action: 'delete', id: room.id });
          } catch (err) {
            // A room still holding appointments is not deleted, and the reason is
            // worth reading: it says to retire it instead.
            toast(err instanceof ApiError ? err.message : `Could not remove ${room.name}.`, 'error');
          }
        }
      }
      toast('Saved.');
      setEditing(null);
      onChange();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-[13px] text-slateink-400">
          Each {terms.location.one} carries its own clock. Working hours are read in that timezone, so a site in New York opens at 9am New York — not 9am wherever the server is.
        </p>
        <Button variant="brand" size="sm" onClick={() => start('new')}>
          <Icons.plus size={14} /> New {terms.location.one}
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {locations.map((l) => (
          <div key={l.id} className={cn('panel p-5', !l.active && 'opacity-60')}>
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h3 className="h4">{l.name}</h3>
                <div className="mt-0.5 font-mono text-[11px] text-slateink-400">{l.timezone}</div>
              </div>
              <div className="flex items-center gap-2">
                <Pill tone={l.active ? 'brand' : 'default'}>{l.active ? 'open' : 'closed'}</Pill>
                <Button variant="quiet" size="sm" onClick={() => start(l)}>
                  Edit
                </Button>
              </div>
            </div>
            {l.address && <p className="mb-3 text-[12.5px] text-slateink-300">{l.address}</p>}
            {l.rooms.length > 0 && (
              <div>
                <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-slateink-500">Rooms</div>
                <div className="flex flex-wrap gap-1.5">
                  {l.rooms.map((r) => (
                    <span key={r.id} className="rounded-lg border border-slate-900/[0.035] px-2 py-0.5 text-[11.5px] text-slateink-300">
                      {r.name}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? `New ${terms.location.one}` : 'Edit'}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button variant="brand" size="sm" disabled={saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="label" htmlFor="l-name">
              Name
            </label>
            <input id="l-name" className="field text-[13px]" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="l-addr">
              Address
            </label>
            <input id="l-addr" className="field text-[13px]" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="l-tz">
              Timezone (IANA)
            </label>
            <input id="l-tz" className="field font-mono text-[12.5px]" placeholder="America/New_York" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
          </div>
          <div>
            <span className="label">Rooms</span>
            <p className="mb-2 text-[11.5px] text-slateink-400">
              A room is what an appointment occupies: nobody is offered an hour when every room is taken, and two
              appointments will not be put in the same one. Renaming a room keeps its appointments where they are —
              removing one that still has appointments is refused, so retire it instead.
            </p>
            <div className="space-y-2">
              {form.rooms.map((r, i) => (
                <div key={r.id ?? `new-${i}`} className="flex items-center gap-2">
                  <input
                    className="field text-[13px]"
                    value={r.name}
                    onChange={(e) =>
                      setForm({ ...form, rooms: form.rooms.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })
                    }
                  />
                  {r.active === false ? (
                    <Button variant="ghost" size="sm" onClick={() => setForm({ ...form, rooms: form.rooms.map((x, j) => (j === i ? { ...x, active: true } : x)) })}>
                      Retired — bring back
                    </Button>
                  ) : (
                    r.id && (
                      <Button variant="quiet" size="sm" onClick={() => setForm({ ...form, rooms: form.rooms.map((x, j) => (j === i ? { ...x, active: false } : x)) })}>
                        Retire
                      </Button>
                    )
                  )}
                  <Button variant="quiet" size="sm" onClick={() => setForm({ ...form, rooms: form.rooms.filter((_, j) => j !== i) })}>
                    Remove
                  </Button>
                </div>
              ))}
              <Button variant="ghost" size="sm" onClick={() => setForm({ ...form, rooms: [...form.rooms, { name: '', active: true }] })}>
                <Icons.plus size={14} /> Add room
              </Button>
            </div>
          </div>
        </div>
      </Modal>
    </>
  );
}

/* ------------------------------------------------------------------ hours */

function HoursTab({
  terms,
  profile,
  providers,
  locations,
  rota,
  changes,
  onSaved,
}: {
  terms: Terms;
  profile: Profile;
  providers: Provider[];
  locations: Location[];
  rota: Rota[];
  changes: RotaChange[];
  onSaved: () => void;
}) {
  const toast = useToast();
  const [providerId, setProviderId] = React.useState('');
  const [locationId, setLocationId] = React.useState('');
  const [windows, setWindows] = React.useState<Window[]>([]);
  const [breaks, setBreaks] = React.useState<Break[]>([]);
  const [saving, setSaving] = React.useState(false);
  const [policy, setPolicy] = React.useState(profile);
  const [changeForm, setChangeForm] = React.useState({ date: '', kind: 'off', reason: '', start: '09:00', end: '17:00' });

  const active = providers.filter((p) => p.active);

  React.useEffect(() => {
    if (!providerId && active.length) setProviderId(active[0].id);
  }, [active, providerId]);
  React.useEffect(() => {
    const allowed = locations.filter((l) => l.active && (!providerId || (active.find((p) => p.id === providerId)?.locationIds ?? []).includes(l.id)));
    if (!locationId || !allowed.some((l) => l.id === locationId)) setLocationId(allowed[0]?.id ?? '');
  }, [providerId, locations, active, locationId]);

  React.useEffect(() => {
    const match = rota.find((r) => r.providerId === providerId && r.locationId === locationId);
    setWindows(match?.windows ?? []);
    setBreaks(match?.breaks ?? []);
  }, [rota, providerId, locationId]);

  React.useEffect(() => setPolicy(profile), [profile]);

  function toggleDay(weekday: number, on: boolean) {
    setWindows((w) => (on ? [...w, { weekday, start: '09:00', end: '17:00' }] : w.filter((x) => x.weekday !== weekday)));
  }

  async function saveRota() {
    if (!providerId || !locationId) return;
    setSaving(true);
    try {
      const ordered = windows.slice().sort((a, b) => a.weekday - b.weekday);
      for (const w of ordered) {
        if (clockToMinutes(w.end) <= clockToMinutes(w.start)) throw new Error(`${DAYS[w.weekday]} ends before it starts.`);
      }
      await request('PUT', '/api/v1/rota', { providerId, locationId, windows: ordered, breaks });
      toast('Hours saved — availability changed immediately.');
      onSaved();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function addChange() {
    if (!providerId || !changeForm.date) {
      toast('Pick a date for the change.', 'error');
      return;
    }
    try {
      await request('POST', '/api/v1/rota-changes', {
        providerId,
        date: changeForm.date,
        kind: changeForm.kind,
        reason: changeForm.reason || undefined,
        windows: changeForm.kind === 'extra' ? [{ weekday: 0, start: changeForm.start, end: changeForm.end }] : undefined,
      });
      toast(changeForm.kind === 'off' ? 'Marked as not working.' : 'Extra hours added.');
      setChangeForm({ ...changeForm, date: '', reason: '' });
      onSaved();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed', 'error');
    }
  }

  async function savePolicy() {
    try {
      await request('PATCH', '/api/v1/practice/profile', policy);
      toast('Booking rules saved.');
      onSaved();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Save failed', 'error');
    }
  }

  return (
    <div className="space-y-5">
      <div className="panel p-5">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[190px]">
              <label className="label" htmlFor="h-provider">
                {terms.provider.One}
              </label>
              <select id="h-provider" className="field text-[13px]" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
                {active.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="min-w-[200px]">
              <label className="label" htmlFor="h-location">
                {terms.location.One}
              </label>
              <select id="h-location" className="field text-[13px]" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                {locations
                  .filter((l) => l.active && (!providerId || (active.find((p) => p.id === providerId)?.locationIds ?? []).includes(l.id)))
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
              </select>
            </div>
          </div>
          <Button variant="brand" size="sm" disabled={saving} onClick={() => void saveRota()}>
            {saving ? 'Saving…' : 'Save hours'}
          </Button>
        </div>

        <div className="space-y-2">
          {DAYS.map((label, weekday) => {
            const w = windows.find((x) => x.weekday === weekday);
            return (
              <div key={weekday} className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-900/[0.04] bg-ink-900/40 px-3 py-2">
                <label className="flex w-32 items-center gap-2 text-[13px] text-slateink-200">
                  <input type="checkbox" checked={!!w} onChange={(e) => toggleDay(weekday, e.target.checked)} className="accent-brand-400" />
                  {label}
                </label>
                {w ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="time"
                      className="field h-8 w-[110px] py-0 font-mono text-[12px]"
                      value={w.start}
                      onChange={(e) => setWindows((list) => list.map((x) => (x.weekday === weekday ? { ...x, start: e.target.value } : x)))}
                    />
                    <span className="text-slateink-500">–</span>
                    <input
                      type="time"
                      className="field h-8 w-[110px] py-0 font-mono text-[12px]"
                      value={w.end}
                      onChange={(e) => setWindows((list) => list.map((x) => (x.weekday === weekday ? { ...x, end: e.target.value } : x)))}
                    />
                  </div>
                ) : (
                  <span className="text-[12px] text-slateink-500">Not working</span>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-5 border-t border-slate-900/[0.04] pt-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="label mb-0">Breaks (recurring, every working day)</span>
            <Button variant="ghost" size="sm" onClick={() => setBreaks([...breaks, { start: '12:00', end: '13:00', label: 'Lunch' }])}>
              <Icons.plus size={14} /> Add break
            </Button>
          </div>
          {breaks.length === 0 ? (
            <p className="text-[12.5px] text-slateink-500">No breaks — the day is bookable end to end.</p>
          ) : (
            <div className="space-y-2">
              {breaks.map((b, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <input
                    type="time"
                    className="field h-8 w-[110px] py-0 font-mono text-[12px]"
                    value={b.start}
                    onChange={(e) => setBreaks(breaks.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))}
                  />
                  <span className="text-slateink-500">–</span>
                  <input
                    type="time"
                    className="field h-8 w-[110px] py-0 font-mono text-[12px]"
                    value={b.end}
                    onChange={(e) => setBreaks(breaks.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))}
                  />
                  <input
                    className="field h-8 w-[160px] py-0 text-[12.5px]"
                    placeholder="Label"
                    value={b.label ?? ''}
                    onChange={(e) => setBreaks(breaks.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                  />
                  <Button variant="quiet" size="sm" onClick={() => setBreaks(breaks.filter((_, j) => j !== i))}>
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="panel p-5">
        <h3 className="h4 mb-1">One-off changes</h3>
        <p className="mb-4 text-[12.5px] text-slateink-400">
          Holidays and extra days. These never rewrite the weekly rota, so one Friday off does not change what Friday means.
        </p>
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div>
            <label className="label" htmlFor="c-date">
              Date
            </label>
            <input id="c-date" type="date" className="field text-[13px]" value={changeForm.date} onChange={(e) => setChangeForm({ ...changeForm, date: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="c-kind">
              Kind
            </label>
            <select id="c-kind" className="field text-[13px]" value={changeForm.kind} onChange={(e) => setChangeForm({ ...changeForm, kind: e.target.value })}>
              <option value="off">Not working</option>
              <option value="extra">Extra hours</option>
            </select>
          </div>
          {changeForm.kind === 'extra' && (
            <>
              <div>
                <label className="label" htmlFor="c-start">
                  From
                </label>
                <input id="c-start" type="time" className="field h-9 py-0 font-mono text-[12px]" value={changeForm.start} onChange={(e) => setChangeForm({ ...changeForm, start: e.target.value })} />
              </div>
              <div>
                <label className="label" htmlFor="c-end">
                  To
                </label>
                <input id="c-end" type="time" className="field h-9 py-0 font-mono text-[12px]" value={changeForm.end} onChange={(e) => setChangeForm({ ...changeForm, end: e.target.value })} />
              </div>
            </>
          )}
          <div className="min-w-[180px] flex-1">
            <label className="label" htmlFor="c-reason">
              Reason
            </label>
            <input id="c-reason" className="field text-[13px]" placeholder="Public holiday" value={changeForm.reason} onChange={(e) => setChangeForm({ ...changeForm, reason: e.target.value })} />
          </div>
          <Button variant="brand" size="sm" onClick={() => void addChange()}>
            Add
          </Button>
        </div>

        {changes.length === 0 ? (
          <p className="text-[12.5px] text-slateink-500">No upcoming changes.</p>
        ) : (
          <ul className="space-y-1.5">
            {changes
              .filter((c) => c.providerId === providerId)
              .map((c) => (
                <li key={c.id} className="flex items-center gap-3 rounded-xl border border-slate-900/[0.04] bg-ink-900/40 px-3 py-2 text-[12.5px]">
                  <Pill tone={c.kind === 'off' ? 'danger' : 'brand'}>{c.kind}</Pill>
                  <span className="font-mono text-slateink-200">{c.date}</span>
                  {c.windows && c.windows[0] && (
                    <span className="font-mono text-slateink-400">
                      {c.windows[0].start}–{c.windows[0].end}
                    </span>
                  )}
                  {c.reason && <span className="text-slateink-400">{c.reason}</span>}
                  <button
                    className="ml-auto text-slateink-400 hover:text-rose-700"
                    onClick={() =>
                      void request('DELETE', `/api/v1/rota-changes/${c.id}`)
                        .then(onSaved)
                        .catch((e) => toast(e instanceof ApiError ? e.message : 'Failed', 'error'))
                    }
                  >
                    Remove
                  </button>
                </li>
              ))}
            {changes.filter((c) => c.providerId === providerId).length === 0 && (
              <li className="text-[12.5px] text-slateink-500">No upcoming changes for this {terms.provider.one}.</li>
            )}
          </ul>
        )}
      </div>

      <div className="panel p-5">
        <h3 className="h4 mb-1">Booking rules &amp; vocabulary</h3>
        <p className="mb-4 text-[12.5px] text-slateink-400">
          The term pack renames the interface everywhere — dashboard, booking page, confirmations. The records never change shape.
        </p>
        <div className="grid gap-4 sm:grid-cols-4">
          <div>
            <label className="label" htmlFor="r-pack">
              Term pack
            </label>
            <select id="r-pack" className="field text-[13px]" value={policy.termPack} onChange={(e) => setPolicy({ ...policy, termPack: e.target.value as TermPackId })}>
              <option value="clinical">clinical — patients, practitioners</option>
              <option value="service">service — customers, technicians</option>
              <option value="generic">generic — clients, team members</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="r-step">
              Slot grid (min)
            </label>
            <input id="r-step" type="number" min={5} step={5} className="field text-[13px]" value={policy.slotStepMinutes} onChange={(e) => setPolicy({ ...policy, slotStepMinutes: Number(e.target.value) })} />
          </div>
          <div>
            <label className="label" htmlFor="r-notice">
              Minimum notice (min)
            </label>
            <input id="r-notice" type="number" min={0} step={15} className="field text-[13px]" value={policy.minNoticeMinutes} onChange={(e) => setPolicy({ ...policy, minNoticeMinutes: Number(e.target.value) })} />
          </div>
          <div>
            <label className="label" htmlFor="r-advance">
              Book up to (days)
            </label>
            <input id="r-advance" type="number" min={1} step={1} className="field text-[13px]" value={policy.maxAdvanceDays} onChange={(e) => setPolicy({ ...policy, maxAdvanceDays: Number(e.target.value) })} />
          </div>
        </div>
        <div className="mt-4 flex items-center justify-between">
          <p className="text-[12px] text-slateink-500">
            Reading as: {terms.client.Many} · {terms.provider.Many} · {terms.appointment.Many} · {terms.note.Many} · {terms.location.Many}
          </p>
          <Button variant="brand" size="sm" onClick={() => void savePolicy()}>
            Save rules
          </Button>
        </div>
      </div>
    </div>
  );
}


/**
 * The online booking tab.
 *
 * A booking page nobody can find is a feature that does not exist, so this shows
 * the one link to hand out, proves it works ("open it" and "check it"), and puts
 * the two switches that matter next to it: is the page open, and how many times
 * may one number book.
 */
function BookingTab({ terms }: { terms: Terms }) {
  const toast = useToast();
  const [state, setState] = React.useState<{
    slug?: string;
    enabled?: boolean;
    showProviders?: boolean;
    maxPerNumber?: number;
    windowDays?: number;
    link?: string;
    messages?: { pending: number; sent: number; blocked: number; failed: number };
    samples?: { channel: string; status: string; to: string; body: string; at: string }[];
  } | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const result = await request<{
        slug: string;
        booking: { enabled: boolean; showProviders: boolean; maxPerNumber: number; windowDays: number };
        link: string;
        messages: { pending: number; sent: number; blocked: number; failed: number };
        samples: { channel: string; status: string; to: string; body: string; at: string }[];
      }>('GET', '/api/v1/booking-page');
      setState({
        slug: result.slug,
        enabled: result.booking.enabled,
        showProviders: result.booking.showProviders,
        maxPerNumber: result.booking.maxPerNumber,
        windowDays: result.booking.windowDays,
        link: result.link,
        messages: result.messages,
        samples: result.samples,
      });
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load the booking settings', 'error');
    }
  }, [toast]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function patch(next: Record<string, unknown>) {
    setBusy(true);
    try {
      await request('PATCH', '/api/v1/booking-page', next);
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'That did not save', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function sendQueue() {
    setBusy(true);
    try {
      const result = await request<{ sent: number; blocked: number; failed: number; stillPending: number }>('POST', '/api/v1/messages', {
        action: 'deliver',
      });
      toast(`${result.sent} sent, ${result.blocked} blocked, ${result.stillPending} still waiting.`);
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not run the queue', 'error');
    } finally {
      setBusy(false);
    }
  }

  if (!state) return <div className="text-[13px] text-slateink-400">Loading…</div>;
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const link = `${origin}/book/${state.slug}`;

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="panel p-5">
        <h3 className="h4">Your booking page</h3>
        <p className="mt-1 text-[12.5px] text-slateink-400">
          Give this link out, put it on the website, add it to the Google profile. It books straight into the diary the
          phone agent answers from — there is no separate calendar to reconcile.
        </p>
        <div className="mt-4 flex items-center gap-2 rounded-xl border border-slate-900/[0.035] bg-ink-900/60 px-3 py-2">
          <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-brand-700">{link}</code>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void navigator.clipboard?.writeText(link);
              toast('Link copied.');
            }}
          >
            Copy
          </Button>
          <LinkButton href={`/book/${state.slug}`} variant="ghost" size="sm">
            Open
          </LinkButton>
        </div>

        <div className="mt-5 space-y-1 border-t border-slate-900/[0.04] pt-4">
          <Toggle
            label="Take bookings online"
            desc="Off means the page says to call instead. Existing appointments are not affected."
            checked={Boolean(state.enabled)}
            onChange={(next) => void patch({ enabled: next })}
          />
          <Toggle
            label={`Let people choose a ${terms.provider.one}`}
            desc="Off shows the first free time and picks quietly, which is what most practices want."
            checked={Boolean(state.showProviders)}
            onChange={(next) => void patch({ showProviders: next })}
          />
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="max-per-number">
              Bookings per number
            </label>
            <input
              id="max-per-number"
              type="number"
              min={1}
              max={50}
              className="field mt-1.5 text-[13px]"
              defaultValue={state.maxPerNumber}
              onBlur={(e) => void patch({ maxPerNumber: Number(e.target.value) })}
            />
          </div>
          <div>
            <label className="label" htmlFor="window-days">
              Over how many days
            </label>
            <input
              id="window-days"
              type="number"
              min={1}
              max={365}
              className="field mt-1.5 text-[13px]"
              defaultValue={state.windowDays}
              onBlur={(e) => void patch({ windowDays: Number(e.target.value) })}
            />
          </div>
        </div>
        <p className="mt-2 text-[11.5px] text-slateink-500">
          A cap is what stops one person filling the diary from a script. Each address is limited too, per ten minutes.
        </p>
      </div>

      <div className="panel p-5">
        <h3 className="h4">Messages</h3>
        <p className="mt-1 text-[12.5px] text-slateink-400">
          Confirmations and reminders. A message only goes if the person agreed to that channel — withdrawn consent beats a
          queued reminder, every time.
        </p>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(
            [
              ['Waiting', state.messages?.pending ?? 0, 'default'],
              ['Sent', state.messages?.sent ?? 0, 'brand'],
              ['Blocked', state.messages?.blocked ?? 0, 'warn'],
              ['Failed', state.messages?.failed ?? 0, 'danger'],
            ] as const
          ).map(([label, value, tone]) => (
            <div key={label} className="rounded-xl border border-slate-900/[0.045] bg-ink-900/50 px-3 py-2.5">
              <div className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-slateink-400">{label}</div>
              <div className={`mt-1 text-[18px] ${tone === 'danger' && value ? 'text-rose-700' : tone === 'warn' && value ? 'text-amber-800' : 'text-slate-900'}`}>
                {value}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void sendQueue()}>
            <Icons.refresh size={13} /> Run the queue now
          </Button>
          <span className="text-[11.5px] text-slateink-500">The queue also runs on its own timer every fifteen minutes.</span>
        </div>

        <div className="mt-4 border-t border-slate-900/[0.04] pt-3">
          <div className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-slateink-400">Latest</div>
          {(state.samples ?? []).length === 0 ? (
            <p className="mt-2 text-[12.5px] text-slateink-500">Nothing sent yet. Book through the page and it will show here.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {(state.samples ?? []).slice(0, 5).map((message, index) => (
                <li key={index} className="rounded-xl border border-slate-900/[0.04] bg-ink-900/40 px-3 py-2">
                  <div className="flex items-center gap-2 text-[11.5px]">
                    <Pill tone={message.status === 'sent' ? 'brand' : message.status === 'blocked' ? 'warn' : 'default'}>{message.status}</Pill>
                    <span className="font-mono text-slateink-400">{message.channel}</span>
                    <span className="text-slateink-400">{message.to}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[12px] text-slateink-300">{message.body}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
