/**
 * Rooms — the resource an appointment actually occupies.
 *
 * Until now a room was a name inside a location (`LocationDoc.rooms`), and the
 * dashboard derived its id from the name it was given:
 * `room_${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`. Renaming "Bay Room"
 * to "Bay 1" therefore *changed the id*, and every appointment already booked
 * into it pointed at a room that no longer existed — the diary could not say
 * where the patient was meant to be, and the clash check stopped seeing the
 * room, so two appointments could be double-booked into the same four walls.
 *
 * A room is now a record with an id of its own. The name is a label; renaming
 * one is a rename, not a rebuild.
 *
 * Design rules:
 *
 *   1. **One writer.** Every room write goes through this module and then
 *      rewrites the location's `rooms` mirror, so the availability engine (which
 *      reads the mirror on the hot path) can never disagree with the record.
 *   2. **Nothing is hard-deleted while it is still in use.** A room with
 *      appointments still to come cannot be deleted; retire it with
 *      `active: false` and history stays readable.
 *   3. **The existing inline rooms migrate themselves.** The first read turns
 *      whatever the location already carried into records with the *same ids*,
 *      so no appointment loses its room.
 */

import { count, insert, list, newId, remove, update, type Doc } from './db';
import { audit } from './audit';
import { locationById, type LocationDoc, type Room } from './practice';

export type RoomDoc = Doc & {
  orgId: string;
  locationId: string;
  name: string;
  notes?: string;
  active: boolean;
};

/* ------------------------------------------------------------------ reading */

/**
 * Bring any inline rooms on the location into the collection.
 *
 * Runs on read and is idempotent: a room already recorded is left exactly as it
 * is, and a location with nothing inline does nothing at all. Ids are carried
 * over verbatim, which is the whole point — the appointments in that room were
 * pointing at those ids.
 */
export function ensureRooms(orgId: string): number {
  let migrated = 0;
  for (const location of list<LocationDoc>('locations', (l) => l.orgId === orgId)) {
    // Once per site, ever. See `LocationDoc.roomsMigratedAt`: a repeated diff
    // against the mirror is what resurrected a room that had just been deleted.
    if (location.roomsMigratedAt) continue;
    const inline = Array.isArray(location.rooms) ? location.rooms : [];
    const known = new Set(list<RoomDoc>('rooms', (r) => r.orgId === orgId && r.locationId === location.id).map((r) => r.id));
    for (const room of inline) {
      if (!room?.id || known.has(room.id)) continue;
      insert<RoomDoc>('rooms', {
        id: room.id,
        orgId,
        locationId: location.id,
        name: room.name,
        active: true,
      } as RoomDoc);
      migrated += 1;
    }
    update<LocationDoc>('locations', location.id, { roomsMigratedAt: new Date().toISOString() });
    mirrorRooms(orgId, location.id);
  }
  return migrated;
}

export function roomsFor(orgId: string, opts?: { locationId?: string; includeInactive?: boolean }): RoomDoc[] {
  ensureRooms(orgId);
  return list<RoomDoc>(
    'rooms',
    (r) =>
      r.orgId === orgId &&
      (!opts?.locationId || r.locationId === opts.locationId) &&
      (opts?.includeInactive || r.active !== false)
  );
}

export function roomById(orgId: string, id: string): RoomDoc | undefined {
  if (!id) return undefined;
  return list<RoomDoc>('rooms', (r) => r.orgId === orgId && r.id === id)[0];
}

/** What to call a room on a screen, when all you hold is its id. */
export function roomNameOf(orgId: string, roomId: string | undefined): string | undefined {
  if (!roomId) return undefined;
  return roomById(orgId, roomId)?.name;
}

/**
 * Rewrite the location's `rooms` mirror from the records.
 *
 * The availability engine reads `location.rooms` while composing slots; that is
 * the hot path and it stays as it is. This is what keeps it true. Retired rooms
 * drop out of the mirror — a room nobody may use must not be offered — while
 * appointments that already hold it keep their id and their history.
 */
export function mirrorRooms(orgId: string, locationId: string): Room[] {
  const location = locationById(orgId, locationId);
  if (!location) return [];
  const mirror: Room[] = roomsFor(orgId, { locationId }).map((r) => ({ id: r.id, name: r.name }));
  update<LocationDoc>('locations', locationId, { rooms: mirror });
  return mirror;
}

/** How many appointments still to come are in this room (or any room at a site). */
export function upcomingInRoom(orgId: string, roomId: string): number {
  return count(
    'bookings',
    (b) =>
      (b as { orgId?: string }).orgId === orgId &&
      (b as { roomId?: string }).roomId === roomId &&
      (b as { status?: string }).status !== 'cancelled' &&
      new Date(String((b as { startsAt?: string }).startsAt)) >= new Date()
  );
}

/* ------------------------------------------------------------------ writing */

export type RoomInput = { locationId?: string; name?: string; notes?: string; active?: boolean };

export function createRoom(
  orgId: string,
  input: RoomInput & { locationId: string; name: string },
  actor: string
): { room?: RoomDoc; error?: string; message?: string } {
  const location = locationById(orgId, input.locationId);
  if (!location) return { error: 'not_found', message: 'That location does not exist.' };
  const name = String(input.name ?? '').trim();
  if (!name) return { error: 'validation', message: '`name` is required.' };
  if (name.length > 60) return { error: 'validation', message: 'A room name is a label, not a sentence — keep it under 60 characters.' };
  const clash = roomsFor(orgId, { locationId: location.id, includeInactive: true }).find(
    (r) => r.name.trim().toLowerCase() === name.toLowerCase()
  );
  if (clash) return { error: 'duplicate', message: `${location.name} already has a room called "${clash.name}".` };

  ensureRooms(orgId);
  const room = insert<RoomDoc>('rooms', {
    id: newId('room_'),
    orgId,
    locationId: location.id,
    name,
    notes: input.notes?.trim() || undefined,
    active: input.active !== false,
  } as RoomDoc);
  mirrorRooms(orgId, location.id);
  audit({ orgId, actor, action: 'room.created', target: room.id, detail: `${room.name} · ${location.name}` });
  return { room };
}

export function updateRoom(
  orgId: string,
  id: string,
  patch: RoomInput,
  actor: string
): { room?: RoomDoc; error?: string; message?: string } {
  const room = roomById(orgId, id);
  if (!room) return { error: 'not_found', message: 'That room does not exist.' };
  if (patch.locationId && patch.locationId !== room.locationId) {
    return {
      error: 'unsupported',
      message: 'A room belongs to the site it is in — retiring it and adding one at the other site keeps the history honest.',
    };
  }
  const clean: Partial<RoomDoc> = {};
  if (patch.name !== undefined) {
    const name = String(patch.name).trim();
    if (!name) return { error: 'validation', message: '`name` cannot be empty.' };
    const clash = roomsFor(orgId, { locationId: room.locationId, includeInactive: true }).find(
      (r) => r.id !== room.id && r.name.trim().toLowerCase() === name.toLowerCase()
    );
    if (clash) return { error: 'duplicate', message: `That site already has a room called "${clash.name}".` };
    clean.name = name;
  }
  if (patch.notes !== undefined) clean.notes = String(patch.notes).trim() || undefined;
  if (patch.active !== undefined) clean.active = Boolean(patch.active);
  if (!Object.keys(clean).length) return { error: 'validation', message: 'Nothing to change.' };

  const row = update<RoomDoc>('rooms', id, clean);
  mirrorRooms(orgId, room.locationId);
  // The rename is the interesting part of the audit row: a room that changed
  // name is how a diary from last month stops matching this month's.
  audit({
    orgId,
    actor,
    action: clean.name && clean.name !== room.name ? 'room.renamed' : 'room.updated',
    target: id,
    detail: clean.name && clean.name !== room.name ? `${room.name} → ${clean.name}` : Object.keys(clean).join(', '),
  });
  return { room: row };
}

export function deleteRoom(orgId: string, id: string, actor: string): { deleted: boolean; error?: string; message?: string; upcoming?: number; retained?: boolean; references?: number } {
  const room = roomById(orgId, id);
  if (!room) return { deleted: false, error: 'not_found', message: 'That room does not exist.' };
  const upcoming = upcomingInRoom(orgId, id);
  if (upcoming > 0) {
    return {
      deleted: false,
      error: 'in_use',
      upcoming,
      message: `That room still has ${upcoming} appointment${upcoming === 1 ? '' : 's'} to come. Retire it instead and it will stop being offered.`,
    };
  }
  const references = count(
    'bookings',
    (row) => (row as { orgId?: string; roomId?: string }).orgId === orgId && (row as { roomId?: string }).roomId === id
  );
  if (references > 0) {
    update<RoomDoc>('rooms', id, { active: false });
    mirrorRooms(orgId, room.locationId);
    audit({ orgId, actor, action: 'room.retired', target: id, detail: `${room.name} · retained by ${references} historical appointment(s)` });
    return { deleted: true, retained: true, references };
  }
  remove('rooms', id);
  mirrorRooms(orgId, room.locationId);
  audit({ orgId, actor, action: 'room.deleted', target: id, detail: room.name });
  return { deleted: true };
}

/** Site is going away: take its rooms with it (the site's own guard runs first). */
export function removeRoomsForLocation(orgId: string, locationId: string, actor: string): number {
  const rooms = list<RoomDoc>('rooms', (r) => r.orgId === orgId && r.locationId === locationId);
  rooms.forEach((r) => remove('rooms', r.id));
  if (rooms.length) audit({ orgId, actor, action: 'room.deleted', target: locationId, detail: `${rooms.length} room(s) with the location` });
  return rooms.length;
}

/* ------------------------------------------------------- assigning a room */

/**
 * The room this appointment should occupy.
 *
 * The availability engine already offers a room with every slot it suggests —
 * and until now that room was thrown away at the door: appointments were stored
 * with no room at all, so the diary could not say where anybody was, "is Bay
 * Room free at four" had no answer, and the room half of the clash check could
 * never fire. Whoever books, the room is recorded.
 *
 * Reads the bookings collection directly rather than importing the bookings
 * module, so this stays a leaf: the bookings module imports *this* one.
 */
export function freeRoomFor(
  orgId: string,
  input: { locationId?: string; startsAt: string; durationMinutes?: number; serviceId?: string; ignoreBookingId?: string }
): Room | undefined {
  if (!input.locationId) return undefined;
  const rooms = roomsFor(orgId, { locationId: input.locationId });
  if (!rooms.length) return undefined;

  const start = new Date(input.startsAt).getTime();
  if (!Number.isFinite(start)) return undefined;

  type ServiceRow = { id: string; durationMinutes?: number; bufferBeforeMinutes?: number; bufferAfterMinutes?: number };
  const buffers = (serviceId?: string): { before: number; after: number } => {
    const service = serviceId ? list<ServiceRow>('services', (s) => s.id === serviceId)[0] : undefined;
    return { before: (service?.bufferBeforeMinutes ?? 0) * 60_000, after: (service?.bufferAfterMinutes ?? 0) * 60_000 };
  };

  const mine = buffers(input.serviceId);
  /**
   * How long the appointment really occupies the room.
   *
   * A service's own length wins over the caller's figure, because that is the
   * block every other part of the engine uses (`blockFor` in `availability.ts`,
   * which sizes slots, checks hours and refuses clashes). Being the odd one out
   * here is not harmless: a move asks this function to *choose* a room and then
   * asks `isFree` to approve it, so a room judged on a shorter block is a room
   * picked and then refused — the diary offering a time it will not take.
   */
  const service = input.serviceId ? list<ServiceRow>('services', (s) => s.id === input.serviceId)[0] : undefined;
  const length = Number(service?.durationMinutes ?? input.durationMinutes ?? 30) || 30;
  const from = start - mine.before;
  const to = start + length * 60_000 + mine.after;

  type BookingRow = { id: string; orgId?: string; roomId?: string; startsAt?: string; durationMinutes?: number; status?: string; serviceId?: string };
  const booked = list<BookingRow>('bookings', (b) => b.orgId === orgId && Boolean(b.roomId));

  const taken = new Set<string>();
  for (const booking of booked) {
    if (booking.id === input.ignoreBookingId) continue;
    if (booking.status === 'cancelled') continue;
    const at = new Date(String(booking.startsAt ?? 0)).getTime();
    if (!Number.isFinite(at)) continue;
    const theirs = buffers(booking.serviceId);
    const bFrom = at - theirs.before;
    const bTo = at + (Number(booking.durationMinutes ?? 30) || 30) * 60_000 + theirs.after;
    if (from < bTo && to > bFrom && booking.roomId) taken.add(booking.roomId);
  }

  /**
   * …and a class holds its room too (A8).
   *
   * A session is not a booking, so without this the room the yoga class is in
   * would be handed to the next private appointment at the same hour — the desk
   * would put somebody in a room with eleven people already in it.
   */
  type SessionRow = { id: string; orgId?: string; roomId?: string; startsAt?: string; durationMinutes?: number; status?: string };
  for (const session of list<SessionRow>('classSessions', (s2) => s2.orgId === orgId && Boolean(s2.roomId))) {
    if (session.status === 'cancelled') continue;
    const at = new Date(String(session.startsAt ?? 0)).getTime();
    if (!Number.isFinite(at)) continue;
    const sTo = at + (Number(session.durationMinutes ?? 60) || 60) * 60_000;
    if (from < sTo && to > at && session.roomId) taken.add(session.roomId);
  }

  const room = rooms.find((r) => !taken.has(r.id));
  return room ? { id: room.id, name: room.name } : undefined;
}
