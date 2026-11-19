'use client';

/**
 * Staff board.
 *
 * One card per site for today: who is on the rota and who is on right now, which
 * rooms are taken and which are free, what still needs a decision (unconfirmed
 * visits, people arrived and waiting, no-shows, the wait list), and the notes
 * the team leaves each other.
 *
 * Nothing here is client-facing. The board is the wall in the staff room, not a
 * record: a note posted here never appears on a client's timeline, and clinical
 * content does not belong on it.
 */

import * as React from 'react';
import { ApiError, request } from '@/lib/server-sync';
import { cn } from '@/lib/utils';
import { Button, EmptyState, Modal, Pill, useToast } from '@/components/ui';
import { StatCard } from '@/components/dash/bits';
import { PageHeader } from '@/components/dash/Shell';

type BoardAppointment = {
  id: string;
  startsAt: string;
  local: string;
  endsLocal: string;
  status: string;
  customer: string;
  service?: string;
  providerName?: string;
  roomName?: string;
  why?: string;
};

type BoardClass = {
  id: string;
  local: string;
  endsLocal: string;
  status: string;
  service: string;
  providerName?: string;
  roomName?: string;
  capacity: number;
  seats: number;
  seatsLeft: number;
  arrived: number;
};

type BoardSite = {
  id: string;
  name: string;
  timezone: string;
  today: string;
  nowLocal: string;
  open: boolean;
  classes: BoardClass[];
  rooms: { id: string; name: string; inUse: boolean; inUseBy?: string; until?: string; freeFrom?: string }[];
  onDuty: { providerId: string; name: string; role?: string; from: string; to: string; onNow: boolean; appointments: number; nextLocal?: string }[];
  offToday: { providerId: string; name: string; reason: string }[];
  counts: { appointments: number; confirmed: number; unconfirmed: number; arrived: number; completed: number; noShows: number; cancelled: number };
  needsAttention: BoardAppointment[];
  nextUp: BoardAppointment[];
};

type BoardNote = {
  id: string;
  locationId?: string;
  title: string;
  body: string;
  pinned?: boolean;
  author: string;
  authorName?: string;
  createdAt: string;
};

type Payload = { date: string; sites: BoardSite[]; notes: BoardNote[] };
type Site = { id: string; name: string };

const STATUS_TONE: Record<string, 'default' | 'brand' | 'warn' | 'danger' | 'info'> = {
  confirmed: 'brand',
  pending: 'warn',
  arrived: 'info',
  completed: 'default',
  no_show: 'danger',
  cancelled: 'default',
};

export default function BoardPage() {
  const toast = useToast();
  const [data, setData] = React.useState<Payload | null>(null);
  const [sites, setSites] = React.useState<Site[]>([]);
  const [site, setSite] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [composing, setComposing] = React.useState(false);
  const [form, setForm] = React.useState({ title: '', body: '', locationId: '', pinned: false });

  const fail = (error: unknown) => toast(error instanceof ApiError ? error.message : 'Something went wrong', 'error');

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const query = site ? `&locationId=${site}` : '';
      const [board, locations] = await Promise.all([
        request<Payload>('GET', `/api/v1/board?view=today${query}`),
        request<{ data: Site[] }>('GET', '/api/v1/locations'),
      ]);
      setData(board);
      setSites(locations.data ?? []);
    } catch (error) {
      fail(error);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site, toast]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function post() {
    if (!form.title.trim() || !form.body.trim()) {
      toast('A title and a line of text, please.', 'error');
      return;
    }
    try {
      await request('POST', '/api/v1/board', { action: 'note:create', ...form, locationId: form.locationId || undefined });
      toast('Posted to the board');
      setComposing(false);
      setForm({ title: '', body: '', locationId: '', pinned: false });
      await load();
    } catch (error) {
      fail(error);
    }
  }

  async function removeNote(id: string) {
    try {
      await request('POST', '/api/v1/board', { action: 'note:delete', id });
      toast('Note taken down');
      await load();
    } catch (error) {
      fail(error);
    }
  }

  const sitesShown = data?.sites ?? [];
  const notes = data?.notes ?? [];
  const attention = sitesShown.reduce((sum, s) => sum + s.needsAttention.length, 0);

  return (
    <>
      <PageHeader
        title="Staff board"
        desc="Today, site by site: who is on, which rooms are free, what needs a decision — and the notes the team leaves each other."
        breadcrumb={[{ label: 'Practice' }, { label: 'Board' }]}
        actions={
          <div className="flex items-center gap-2">
            <select className="field w-[190px] text-[12.5px]" value={site} onChange={(e) => setSite(e.target.value)}>
              <option value="">All sites</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <Button variant="brand" size="sm" onClick={() => setComposing(true)}>
              Post a note
            </Button>
          </div>
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Visits today" value={String(sitesShown.reduce((sum, s) => sum + s.counts.appointments, 0))} sub={data?.date ?? ''} />
        <StatCard label="On duty now" value={String(sitesShown.reduce((sum, s) => sum + s.onDuty.filter((p) => p.onNow).length, 0))} sub={`${sitesShown.reduce((sum, s) => sum + s.onDuty.length, 0)} on today's rota`} />
        <StatCard label="Needs a decision" value={String(attention)} sub="unconfirmed · waiting · no-shows" />
        <StatCard
          label="Rooms free now"
          value={String(sitesShown.reduce((sum, s) => sum + s.rooms.filter((r) => !r.inUse).length, 0))}
          sub={`of ${sitesShown.reduce((sum, s) => sum + s.rooms.length, 0)} across the sites`}
        />
      </div>

      {loading && !data ? (
        <p className="py-10 text-center text-[13px] text-slateink-400">Reading the board…</p>
      ) : sitesShown.length === 0 ? (
        <EmptyState icon="calendar" title="No sites to show" desc="Add a location and its rota, and today's board appears here." />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {sitesShown.map((row) => (
            <div key={row.id} className="panel p-5">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <h3 className="h4">{row.name}</h3>
                  <div className="mt-0.5 text-[11.5px] text-slateink-400">
                    {row.today} · {row.nowLocal} local
                  </div>
                </div>
                <Pill tone={row.open ? 'brand' : 'warn'}>{row.open ? 'open today' : 'nobody rostered'}</Pill>
              </div>

              <div className="mb-4 grid grid-cols-3 gap-2 text-center">
                {[
                  { label: 'on now', value: row.onDuty.filter((p) => p.onNow).length },
                  { label: 'confirmed', value: row.counts.confirmed },
                  { label: 'to decide', value: row.needsAttention.length },
                ].map((box) => (
                  <div key={box.label} className="rounded-xl border border-slate-900/[0.04] bg-ink-900/40 py-2">
                    <div className="text-[17px] font-semibold text-slate-900">{box.value}</div>
                    <div className="text-[10.5px] uppercase tracking-[0.12em] text-slateink-500">{box.label}</div>
                  </div>
                ))}
              </div>

              <div className="mb-4">
                <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-slateink-500">On duty</div>
                {row.onDuty.length === 0 ? (
                  <p className="text-[12.5px] text-slateink-400">Nobody is rostered at this site today.</p>
                ) : (
                  <div className="space-y-1.5">
                    {row.onDuty.map((person) => (
                      <div key={person.providerId} className="flex items-center justify-between gap-3 text-[12.5px]">
                        <span className="flex items-center gap-2">
                          <span className={cn('h-1.5 w-1.5 rounded-full', person.onNow ? 'bg-brand-400' : 'bg-slateink-600')} />
                          <span className="text-slate-900">{person.name}</span>
                          <span className="text-slateink-400">
                            {person.from}–{person.to}
                          </span>
                        </span>
                        <span className="text-slateink-400">
                          {person.appointments} visit{person.appointments === 1 ? '' : 's'}
                          {person.nextLocal ? ` · next ${person.nextLocal}` : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {row.offToday.length > 0 && (
                  <p className="mt-2 text-[11.5px] text-slateink-400">
                    Off today: {row.offToday.map((p) => `${p.name} (${p.reason})`).join(', ')}
                  </p>
                )}
              </div>

              <div className="mb-4">
                <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-slateink-500">Rooms</div>
                {row.rooms.length === 0 ? (
                  <p className="text-[12.5px] text-slateink-400">This site has no rooms, so appointments are booked on the practitioner's time alone.</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {row.rooms.map((room) => (
                      <span
                        key={room.id}
                        className={cn(
                          'rounded-lg border px-2 py-1 text-[11.5px]',
                          room.inUse ? 'border-warn-500/30 bg-warn-500/5 text-amber-800' : 'border-slate-900/[0.035] text-slateink-300'
                        )}
                        title={room.inUseBy ? `In use: ${room.inUseBy} until ${room.until}` : `Free — ${room.freeFrom}`}
                      >
                        {room.name}
                        <span className="ml-1.5 text-slateink-500">{room.inUseBy ? `· ${room.until}` : room.freeFrom ? `· ${room.freeFrom}` : ''}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {row.classes.length > 0 && (
                <div className="mb-4">
                  <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-slateink-500">Classes today</div>
                  <div className="space-y-1.5">
                    {row.classes.map((session) => (
                      <div key={session.id} className="flex items-center justify-between gap-3 text-[12.5px]">
                        <span className="text-slate-900">
                          {session.local}
                          <span className="text-slateink-400"> · {session.service}</span>
                          {session.roomName ? <span className="text-slateink-500"> · {session.roomName}</span> : null}
                        </span>
                        <span className="text-slateink-300">
                          {session.seats}/{session.capacity} booked
                          {session.arrived ? ` · ${session.arrived} here` : ''}
                          {session.seatsLeft === 0 ? ' · full' : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="mb-4">
                <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-slateink-500">Needs a decision</div>
                {row.needsAttention.length === 0 ? (
                  <p className="text-[12.5px] text-slateink-400">Nothing outstanding — every visit is confirmed and nobody is waiting.</p>
                ) : (
                  <div className="space-y-1.5">
                    {row.needsAttention.map((item) => (
                      <div key={`${item.id}-${item.why}`} className="flex items-center justify-between gap-3 text-[12.5px]">
                        <span className="text-slate-900">
                          {item.local} · {item.customer}
                          {item.service ? <span className="text-slateink-400"> · {item.service}</span> : null}
                        </span>
                        <span className="text-slateink-300">{item.why}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {row.nextUp.length > 0 && (
                <div>
                  <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-slateink-500">Coming up</div>
                  <div className="space-y-1.5">
                    {row.nextUp.map((item) => (
                      <div key={item.id} className="flex items-center justify-between gap-3 text-[12.5px]">
                        <span>
                          <span className="font-mono text-[12px] text-slateink-300">{item.local}</span>{' '}
                          <span className="text-slate-900">{item.customer}</span>
                          {item.providerName ? <span className="text-slateink-400"> with {item.providerName}</span> : null}
                          {item.roomName ? <span className="text-slateink-400"> · {item.roomName}</span> : null}
                        </span>
                        <Pill tone={STATUS_TONE[item.status] ?? 'default'}>{item.status}</Pill>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="mt-6 panel p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="h4">Notes for the team</h3>
          <span className="text-[11.5px] text-slateink-400">{notes.length} on the board</span>
        </div>
        {notes.length === 0 ? (
          <p className="text-[13px] text-slateink-400">
            Nothing pinned. This is where the team leaves each other a line — a delivery, a room out of action, a locum arriving. Staff-only: it never
            appears on a client's record.
          </p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {notes.map((note) => (
              <div key={note.id} className={cn('rounded-2xl border p-4', note.pinned ? 'border-brand-500/30 bg-brand-500/[0.04]' : 'border-slate-900/[0.045] bg-ink-850/40')}>
                <div className="mb-1 flex items-start justify-between gap-2">
                  <h4 className="text-[13.5px] font-medium text-slate-900">{note.title}</h4>
                  {note.pinned && <Pill tone="brand">pinned</Pill>}
                </div>
                <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-slateink-200">{note.body}</p>
                <div className="mt-3 flex items-center justify-between text-[11px] text-slateink-500">
                  <span>
                    {note.authorName ?? note.author} ·{' '}
                    {sites.find((s) => s.id === note.locationId)?.name ?? 'every site'} · {new Date(note.createdAt).toLocaleDateString()}
                  </span>
                  <button className="transition hover:text-rose-700" onClick={() => void removeNote(note.id)}>
                    Take down
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal
        open={composing}
        onClose={() => setComposing(false)}
        title="Post a note for the team"
        width="520px"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setComposing(false)}>
              Cancel
            </Button>
            <Button variant="brand" size="sm" onClick={() => void post()}>
              Post it
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="label" htmlFor="n-title">
              Title
            </label>
            <input id="n-title" className="field text-[13px]" placeholder="Autoclave being serviced Thursday" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="n-body">
              Note
            </label>
            <textarea id="n-body" rows={4} className="field text-[13px]" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="n-site">
                For
              </label>
              <select id="n-site" className="field text-[13px]" value={form.locationId} onChange={(e) => setForm({ ...form, locationId: e.target.value })}>
                <option value="">Every site</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <label className="mt-6 flex items-center gap-2 text-[12.5px] text-slateink-200">
              <input type="checkbox" checked={form.pinned} onChange={(e) => setForm({ ...form, pinned: e.target.checked })} />
              Pin to the top
            </label>
          </div>
          <p className="text-[11.5px] text-slateink-400">
            The board is staff-only and audited. Anything clinical belongs on the client's record, not here.
          </p>
        </div>
      </Modal>
    </>
  );
}
