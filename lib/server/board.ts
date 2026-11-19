/**
 * The staff board: what today looks like, site by site, and the notes the team
 * leaves for each other.
 *
 * A clinic with two sites has a question no appointment list answers — *who is
 * where, in which room, and what still needs a decision before the doors open*.
 * The board is that answer, one card per site:
 *
 *   - who is on the rota today, and whether they are on duty **now**;
 *   - which rooms are in use, by whom, and which are free;
 *   - what needs attention: unconfirmed visits, people arrived and waiting,
 *     no-shows already logged, and clients on the wait list;
 *   - the internal notes the team writes to each other.
 *
 * The notes here are deliberately not clinical and not client-facing: a staff
 * board is for "the autoclave is being serviced on Thursday", not for anything
 * that belongs on a record. They are staff-only, audited, and never appear in a
 * client's timeline.
 */

import { insert, list, newId, nowIso, remove, update, type Doc } from './db';
import { audit } from './audit';
import { bookingsFor, type BookingDoc } from './bookings';
import { waitListFor, type WaitEntryDoc } from './diary';
import { classSessionsFor, summariseSession } from './classes';
import { dateStrIn } from './availability';
import { locationById, locationsFor, providersFor, rotaFor, rotaChangesFor, type LocationDoc, type RotaChangeDoc } from './practice';
import { roomsFor } from './rooms';

export type BoardNoteDoc = Doc & {
  orgId: string;
  /** A note can be pinned to one site, or left as a whole-workspace notice. */
  locationId?: string;
  title: string;
  body: string;
  /** `pinned` notes sit at the top of the board. */
  pinned?: boolean;
  author: string;
  authorName?: string;
  createdAt: string;
};

export type BoardAppointment = {
  id: string;
  startsAt: string;
  local: string;
  endsLocal: string;
  status: string;
  customer: string;
  service?: string;
  providerId?: string;
  providerName?: string;
  roomId?: string;
  roomName?: string;
  source?: string;
  phone?: string;
};

/**
 * A class on the board (A8).
 *
 * Shown as one line with its count, beside the rooms: what the front desk needs
 * at 6pm is "the evening class is in Studio 2 and eleven of twelve are here", not
 * eleven separate names in the arrivals list.
 */
export type BoardClass = {
  id: string;
  startsAt: string;
  local: string;
  endsLocal: string;
  status: string;
  service: string;
  providerName?: string;
  roomName?: string;
  capacity: number;
  seats: number;
  seatsLeft: number;
  /** Seats whose client has already checked in — the door's own number. */
  arrived: number;
};

export type BoardSite = {
  id: string;
  name: string;
  timezone: string;
  today: string;
  nowLocal: string;
  open: boolean;
  rooms: { id: string; name: string; inUse: boolean; inUseBy?: string; until?: string; freeFrom?: string }[];
  onDuty: {
    providerId: string;
    name: string;
    role?: string;
    from: string;
    to: string;
    onNow: boolean;
    appointments: number;
    nextLocal?: string;
  }[];
  offToday: { providerId: string; name: string; reason: string }[];
  counts: { appointments: number; confirmed: number; unconfirmed: number; arrived: number; completed: number; noShows: number; cancelled: number };
  needsAttention: BoardAppointment[];
  nextUp: BoardAppointment[];
  /** Today's classes at this site, earliest first. */
  classes: BoardClass[];
};

function clock(value: string, timezone: string) {
  const set = new Date(value);
  if (Number.isNaN(set.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone }).format(set);
}

function minutesFromClock(value: string) {
  const text = value.trim().toLowerCase();
  const suffix = text.includes('pm') ? 'pm' : text.includes('am') ? 'am' : '';
  const [h, m] = text.replace(/[ap]m/g, '').split(':');
  let hour = Number(h) || 0;
  const minute = Number(m) || 0;
  if (suffix === 'pm' && hour !== 12) hour += 12;
  if (suffix === 'am' && hour === 12) hour = 0;
  return hour * 60 + minute;
}

function localClock(timezone: string, at: Date) {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: false, timeZone: timezone }).format(at);
}

/** Whatever the rota says for this weekday, and any one-off change for the date. */
function hoursFor(orgId: string, providerId: string, locationId: string, date: string, weekday: number) {
  const changes = rotaChangesFor(orgId, { providerId, from: date, to: date });
  const change: RotaChangeDoc | undefined = changes[0];
  if (change?.kind === 'off') return { windows: [], note: change.reason || 'day off' };
  if (change?.kind === 'extra' && change.windows?.length) return { windows: change.windows, note: change.reason || 'extra hours' };
  const rota = rotaFor(orgId, providerId, locationId);
  const windows = (rota?.windows ?? []).filter((w) => w.weekday === weekday);
  return { windows, note: rota ? 'rota' : 'no rota' };
}

export function boardFor(orgId: string, opts?: { locationId?: string; date?: string }): { date: string; sites: BoardSite[] } {
  const sites = (opts?.locationId ? [locationById(orgId, opts.locationId)].filter(Boolean) : locationsFor(orgId)) as LocationDoc[];
  const providers = providersFor(orgId);
  const now = new Date();
  const reportDate = opts?.date;
  const allBookings = bookingsFor(orgId, () => true);

  const built = sites.map((site) => {
    const today = reportDate ?? dateStrIn(site.timezone, now.getTime());
    const dayBookings = allBookings
      // Seats belong to their class: counting them here would say a twelve-person
      // class is twelve visits and put each of them in the arrivals list.
      .filter((b) => !(b as { sessionId?: string }).sessionId)
      .filter((b) => b.locationId === site.id && dateStrIn(site.timezone, new Date(String(b.startsAt)).getTime()) === today)
      .sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)));

    const daySessions = classSessionsFor(orgId, (session) => {
      if (session.locationId !== site.id) return false;
      if (session.status === 'cancelled') return false;
      return dateStrIn(site.timezone, new Date(String(session.startsAt)).getTime()) === today;
    })
      .map((session) => {
        const summary = summariseSession(orgId, session);
        const seats = bookingsFor(orgId, (b) => b.sessionId === session.id && b.status !== 'cancelled');
        return {
          id: session.id,
          startsAt: summary.startsAt,
          local: summary.local.start,
          endsLocal: summary.local.end,
          status: summary.status,
          service: summary.serviceName,
          providerName: summary.providerName,
          roomName: summary.roomName,
          capacity: summary.capacity,
          seats: summary.seats,
          seatsLeft: summary.seatsLeft,
          arrived: seats.filter((b) => b.status === 'arrived').length,
        };
      })
      .sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)));
    const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
    const nowMinutes = minutesFromClock(localClock(site.timezone, now));
    const rooms = roomsFor(orgId, { locationId: site.id });

    const decorate = (booking: BookingDoc): BoardAppointment => {
      const room = rooms.find((r) => r.id === booking.roomId) ?? rooms.find((r) => r.id === (booking as { roomId?: string }).roomId);
      const provider = providers.find((p) => p.id === booking.providerId);
      const startsAt = String(booking.startsAt);
      const endsAt = new Date(new Date(startsAt).getTime() + (Number(booking.durationMinutes ?? 30) || 30) * 60_000).toISOString();
      return {
        id: booking.id,
        startsAt,
        local: clock(startsAt, site.timezone),
        endsLocal: clock(endsAt, site.timezone),
        status: String(booking.status),
        customer: String(booking.customer?.name ?? 'Client'),
        service: String(booking.service ?? '') || undefined,
        providerId: booking.providerId,
        providerName: provider?.name,
        roomId: booking.roomId,
        roomName: room?.name,
        source: String((booking as { source?: string }).source ?? '') || undefined,
        phone: String(booking.customer?.number ?? '') || undefined,
      };
    };

    const live = dayBookings.filter((b) => b.status !== 'cancelled');
    const atNow = (booking: BookingDoc) => {
      const start = new Date(String(booking.startsAt)).getTime();
      const end = start + (Number(booking.durationMinutes ?? 30) || 30) * 60_000;
      return start <= now.getTime() && now.getTime() < end;
    };

    const roomRows = rooms.map((room) => {
      const occupant = live.find((b) => b.roomId === room.id && atNow(b));
      const next = live
        .filter((b) => b.roomId === room.id && new Date(String(b.startsAt)).getTime() > now.getTime())
        .sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)))[0];
      return {
        id: room.id,
        name: room.name,
        // Always stated, never implied by a missing field: the desk reads this to
        // decide where to put somebody.
        inUse: Boolean(occupant),
        inUseBy: occupant ? decorate(occupant).customer : undefined,
        until: occupant ? decorate(occupant).endsLocal : undefined,
        freeFrom: !occupant && next ? decorate(next).local : !occupant ? 'free now' : undefined,
      };
    });

    const onDuty = providers
      .filter((p) => p.active !== false)
      .map((p) => {
        const { windows, note } = hoursFor(orgId, p.id, site.id, today, weekday);
        const window = windows.find((w) => nowMinutes >= minutesFromClock(w.start as unknown as string) && nowMinutes < minutesFromClock(w.end as unknown as string));
        const theirs = live.filter((b) => b.providerId === p.id);
        return {
          providerId: p.id,
          name: p.name,
          role: note,
          from: windows[0]?.start ?? '',
          to: windows[0]?.end ?? '',
          onNow: Boolean(window),
          appointments: theirs.length,
          nextLocal: theirs.find((b) => new Date(String(b.startsAt)).getTime() >= now.getTime())
            ? clock(String(theirs.find((b) => new Date(String(b.startsAt)).getTime() >= now.getTime())!.startsAt), site.timezone)
            : undefined,
          windows,
        };
      })
      .filter((p) => (p.windows as unknown[]).length > 0)
      .map(({ windows, ...rest }) => rest)
      .sort((a, b) => Number(b.onNow) - Number(a.onNow) || a.name.localeCompare(b.name));

    const offToday = providers
      .filter((p) => p.active !== false)
      .map((p) => ({ p, change: rotaChangesFor(orgId, { providerId: p.id, from: today, to: today })[0] as RotaChangeDoc | undefined }))
      .filter((row) => row.change?.kind === 'off')
      .map((row) => ({ providerId: row.p.id, name: row.p.name, reason: String(row.change?.reason ?? 'day off') }));

    const unconfirmed = live.filter((b) => b.status === 'pending');
    const arrived = live.filter((b) => b.status === 'arrived');
    const noShows = dayBookings.filter((b) => b.status === 'no_show');
    const waiting = waitListFor(orgId, { status: ['waiting'] }).filter((w: WaitEntryDoc) => !w.locationId || w.locationId === site.id);

    const attention = [
      ...unconfirmed.map((b) => ({ ...decorate(b), why: 'not confirmed yet' })),
      ...arrived.map((b) => ({ ...decorate(b), why: 'arrived and waiting' })),
      ...noShows.map((b) => ({ ...decorate(b), why: 'did not turn up' })),
    ];

    const siteRow: BoardSite = {
      id: site.id,
      name: site.name,
      timezone: site.timezone,
      today,
      nowLocal: localClock(site.timezone, now),
      open: onDuty.length > 0,
      rooms: roomRows,
      onDuty,
      offToday,
      counts: {
        appointments: dayBookings.length,
        confirmed: live.filter((b) => b.status === 'confirmed').length,
        unconfirmed: unconfirmed.length,
        arrived: arrived.length,
        completed: dayBookings.filter((b) => b.status === 'completed').length,
        noShows: noShows.length,
        cancelled: dayBookings.filter((b) => b.status === 'cancelled').length,
      },
      classes: daySessions,
      needsAttention: attention.slice(0, 8) as BoardAppointment[],
      nextUp: live
        .filter((b) => new Date(String(b.startsAt)).getTime() >= now.getTime())
        .slice(0, 6)
        .map(decorate),
    };
    void waiting;
    return siteRow;
  });

  return { date: built[0]?.today ?? dateStrIn('UTC', now.getTime()), sites: built };
}

/* ------------------------------------------------------------------- notes */

export function notesFor(orgId: string, opts?: { locationId?: string; includeWorkspace?: boolean }): BoardNoteDoc[] {
  return list<BoardNoteDoc>('boardNotes', (n) => {
    if (n.orgId !== orgId) return false;
    if (!opts?.locationId) return true;
    if (!n.locationId) return opts.includeWorkspace !== false;
    return n.locationId === opts.locationId;
  }).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function createNote(
  orgId: string,
  input: { title: string; body: string; locationId?: string; pinned?: boolean; author: string; authorName?: string }
): { note?: BoardNoteDoc; error?: string; message?: string } {
  const title = String(input.title ?? '').trim();
  const body = String(input.body ?? '').trim();
  if (!title) return { error: 'validation', message: 'Give the note a title — it is the line the team reads first.' };
  if (!body) return { error: 'validation', message: 'An empty note helps nobody.' };
  if (input.locationId && !locationById(orgId, input.locationId)) {
    return { error: 'not_found', message: 'That site does not exist.' };
  }
  const note = insert<BoardNoteDoc>('boardNotes', {
    id: newId('bnote_'),
    orgId,
    locationId: input.locationId || undefined,
    title,
    body,
    pinned: Boolean(input.pinned),
    author: input.author,
    authorName: input.authorName,
    createdAt: nowIso(),
  } as BoardNoteDoc);
  audit({ orgId, actor: input.author, action: 'board.note_created', target: note.id, detail: `${note.pinned ? 'pinned · ' : ''}${title}` });
  return { note };
}

export function updateNote(
  orgId: string,
  id: string,
  patch: { title?: string; body?: string; pinned?: boolean },
  actor: string
): { note?: BoardNoteDoc; error?: string; message?: string } {
  const note = list<BoardNoteDoc>('boardNotes', (n) => n.orgId === orgId && n.id === id)[0];
  if (!note) return { error: 'not_found', message: 'That note does not exist.' };
  const clean: Partial<BoardNoteDoc> = {};
  if (patch.title !== undefined) {
    const title = String(patch.title).trim();
    if (!title) return { error: 'validation', message: 'A note needs a title.' };
    clean.title = title;
  }
  if (patch.body !== undefined) {
    const body = String(patch.body).trim();
    if (!body) return { error: 'validation', message: 'A note needs something in it.' };
    clean.body = body;
  }
  if (patch.pinned !== undefined) clean.pinned = Boolean(patch.pinned);
  const row = update<BoardNoteDoc>('boardNotes', id, clean);
  audit({ orgId, actor, action: 'board.note_updated', target: id, detail: Object.keys(clean).join(', ') });
  return { note: row };
}

export function deleteNote(orgId: string, id: string, actor: string): boolean {
  const note = list<BoardNoteDoc>('boardNotes', (n) => n.orgId === orgId && n.id === id)[0];
  if (!note) return false;
  remove('boardNotes', id);
  audit({ orgId, actor, action: 'board.note_deleted', target: id, detail: note.title });
  return true;
}

export function boardNoteCount(orgId: string): number {
  return list<BoardNoteDoc>('boardNotes', (n) => n.orgId === orgId).length;
}
