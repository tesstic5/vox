/**
 * Practice resources: providers, services, locations, rotas and time off.
 *
 * These are what turn a booking from a timestamp into a real appointment. Until
 * this existed, "can you do Thursday?" was answered by subtracting the
 * appointments already on file from a fixed list of times — the practice's own
 * working hours, its services and its people were nowhere in the system.
 *
 * Design rules:
 *
 *   1. **Nothing is hard-deleted while it is still in use.** A practitioner with
 *      appointments in the future cannot be deleted; the API refuses and says
 *      why. `active: false` is how you retire something without rewriting
 *      history.
 *   2. **The rota is the schedule; time off is an exception.** One-off changes
 *      never rewrite the weekly rota, so a holiday never silently becomes
 *      "this person does not work Mondays".
 *   3. **Every write is audited**, because who changed the rota is exactly the
 *      kind of question that gets asked a month later.
 */

import { count, get, insert, list, newId, nowIso, remove, update, type Doc } from './db';
import { audit } from './audit';
import { termsFor, TERM_PACK_IDS, type TermPackId, type Terms } from '../terms';

/* --------------------------------------------------------------- documents */

export type ProviderDoc = Doc & {
  orgId: string;
  name: string;
  /** "Senior physiotherapist", "Lead technician" — free text, shown next to the name. */
  title?: string;
  email?: string;
  phone?: string;
  /** Hex-ish colour token used by the diary, e.g. `brand`, `emerald`, `violet`. */
  colour: string;
  /**
   * The login this practitioner record belongs to, when one is attached. `null`
   * means nobody is linked yet — the diary still holds their appointments, but
   * no login can open "my day" for them (team screen, day view).
   */
  userId?: string | null;
  /** Empty means "does everything"; otherwise this provider only offers these. */
  serviceIds: string[];
  locationIds: string[];
  active: boolean;
};

export type ServiceDoc = Doc & {
  orgId: string;
  name: string;
  code?: string;
  description?: string;
  durationMinutes: number;
  /** Time kept clear either side of the appointment so visits do not collide. */
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  price: number;
  taxRatePct?: number;
  colour: string;
  /** How often a start time is offered, in minutes. Falls back to the practice default. */
  slotStepMinutes?: number;
  /**
   * How many people one appointment of this service may hold.
   *
   * Unset or 1 is a one-to-one service, which is most of them. 2 or more makes it
   * a **class** (A8): the desk schedules sessions of it, each seats that many, and
   * the public page offers seats rather than times. Creating a class session on a
   * service that had no capacity sets it here, so the catalogue cannot end up
   * claiming "one at a time" while the diary holds eight.
   */
  capacity?: number;
  /**
   * How often somebody who had *this* should come back, in days.
   *
   * Unset means "the practice's own window" (`PracticeProfile.recallDays`), which
   * is the right answer for the majority of services. It exists because a single
   * number for the whole practice is wrong the moment a clinic sells an annual
   * service and a six-month check-up: recalling both at 180 days either chases the
   * annual client six months early or forgets the check-up for six months.
   */
  recallDays?: number;
  active: boolean;
};

export type Room = { id: string; name: string };

export type LocationDoc = Doc & {
  orgId: string;
  name: string;
  address?: string;
  /** Authoritative timezone for this site — rotas and slots are read in it. */
  timezone: string;
  /** Rooms on offer here: a mirror of the `rooms` records, kept by `lib/server/rooms.ts`. */
  rooms: Room[];
  /**
   * When this site's inline rooms were turned into records.
   *
   * The migration is one-way and happens once. Diffing "inline rooms the
   * collection does not know about" on every read instead is how a *deleted*
   * room came back a moment later: the mirror had not caught up yet, so the
   * diff read the deletion as a room still waiting to be migrated.
   */
  roomsMigratedAt?: string;
  active: boolean;
};

export type RotaWindow = { weekday: number; start: string; end: string };
export type RotaBreak = { start: string; end: string; label?: string };

export type RotaDoc = Doc & {
  orgId: string;
  providerId: string;
  locationId: string;
  windows: RotaWindow[];
  breaks: RotaBreak[];
};

export type RotaChangeDoc = Doc & {
  orgId: string;
  providerId: string;
  /** Local calendar date at the location, `YYYY-MM-DD`. */
  date: string;
  kind: 'off' | 'extra';
  /** For `extra`: the hours worked that day. For `off`: unused. */
  windows?: RotaWindow[];
  reason?: string;
};

export type PracticeProfile = {
  termPack: TermPackId;
  /** Default slot granularity when a service does not set its own. */
  slotStepMinutes: number;
  /** How much notice a booking needs. */
  minNoticeMinutes: number;
  /** How far ahead the diary may be booked. */
  maxAdvanceDays: number;
  /**
   * How long a client may go unseen before the practice wants them recalled —
   * the "recalls" half of the reports screen (P7). Six months is the ordinary
   * answer for allied health; a practice that wants annual recalls sets 365.
   */
  recallDays: number;
  /** 0 = Sunday. Only affects display. */
  weekStart: number;
};

export const DEFAULT_PRACTICE_PROFILE: PracticeProfile = {
  termPack: 'generic',
  slotStepMinutes: 15,
  minNoticeMinutes: 60,
  maxAdvanceDays: 90,
  recallDays: 180,
  weekStart: 1,
};

const COLOURS = ['brand', 'emerald', 'violet', 'amber', 'sky', 'rose', 'teal', 'indigo'];

/* ----------------------------------------------------------------- profile */

export function practiceProfile(orgId: string): PracticeProfile {
  const row = get<Doc & { practice?: Partial<PracticeProfile> }>('orgs', orgId);
  const stored = row?.practice ?? {};
  return {
    ...DEFAULT_PRACTICE_PROFILE,
    ...stored,
    termPack: TERM_PACK_IDS.includes(stored.termPack as TermPackId)
      ? (stored.termPack as TermPackId)
      : DEFAULT_PRACTICE_PROFILE.termPack,
  };
}

export function setPracticeProfile(orgId: string, patch: Partial<PracticeProfile>, actor: string): PracticeProfile {
  const next: PracticeProfile = { ...practiceProfile(orgId), ...patch };
  update<Doc>('orgs', orgId, { practice: next } as never);
  audit({ orgId, actor, action: 'practice.profile_updated', detail: Object.keys(patch).join(', ') });
  return next;
}

export function termsForOrg(orgId: string): Terms {
  return termsFor(practiceProfile(orgId).termPack);
}

/* ------------------------------------------------------------- validation */

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function clockToMinutes(value: string): number | null {
  const m = CLOCK.exec(String(value ?? '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function normalizeWindows(input: unknown): { windows?: RotaWindow[]; error?: string } {
  if (input === undefined) return { windows: [] };
  if (!Array.isArray(input)) return { error: '`windows` must be an array of { weekday, start, end }.' };
  const out: RotaWindow[] = [];
  for (const raw of input) {
    const w = raw as Partial<RotaWindow>;
    const weekday = Number(w.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      return { error: 'Each window needs `weekday` from 0 (Sunday) to 6 (Saturday).' };
    }
    const start = clockToMinutes(String(w.start ?? ''));
    const end = clockToMinutes(String(w.end ?? ''));
    if (start === null || end === null) return { error: 'Each window needs `start` and `end` as 24-hour `HH:MM`.' };
    if (end <= start) return { error: `Window ${w.start}–${w.end} ends before it starts.` };
    out.push({ weekday, start: String(w.start), end: String(w.end) });
  }
  return { windows: out };
}

/* -------------------------------------------------------------- providers */

export function providersFor(orgId: string, opts?: { includeInactive?: boolean }): ProviderDoc[] {
  const all = list<ProviderDoc>('providers', (p) => p.orgId === orgId);
  return (opts?.includeInactive ? all : all.filter((p) => p.active !== false)).sort((a, b) => a.name.localeCompare(b.name));
}

export function providerById(orgId: string, id: string): ProviderDoc | undefined {
  const row = get<ProviderDoc>('providers', id);
  return row && row.orgId === orgId ? row : undefined;
}

export function createProvider(
  orgId: string,
  input: Partial<ProviderDoc> & { name: string },
  actor: string
): ProviderDoc {
  const existing = providersFor(orgId, { includeInactive: true });
  const row = insert<ProviderDoc>('providers', {
    id: newId('prv_'),
    orgId,
    name: input.name.trim(),
    title: input.title?.trim() || undefined,
    email: input.email?.trim() || undefined,
    phone: input.phone?.trim() || undefined,
    colour: input.colour || COLOURS[existing.length % COLOURS.length],
    serviceIds: Array.isArray(input.serviceIds) ? input.serviceIds.map(String) : [],
    locationIds: Array.isArray(input.locationIds) ? input.locationIds.map(String) : [],
    active: input.active !== false,
  } as ProviderDoc);
  audit({ orgId, actor, action: 'provider.created', target: row.id, detail: row.name });
  return row;
}

export function updateProvider(orgId: string, id: string, patch: Partial<ProviderDoc>, actor: string): ProviderDoc | undefined {
  const before = providerById(orgId, id);
  if (!before) return undefined;
  const clean: Partial<ProviderDoc> = {};
  for (const key of ['name', 'title', 'email', 'phone', 'colour', 'serviceIds', 'locationIds', 'active'] as const) {
    if (key in patch) clean[key] = patch[key] as never;
  }
  const row = update<ProviderDoc>('providers', id, clean);
  audit({ orgId, actor, action: 'provider.updated', target: id, detail: Object.keys(clean).join(', ') });
  return row;
}

/**
 * Deletes a provider only when nothing depends on them. A provider with future
 * appointments is refused with the count, because deleting one would leave
 * appointments with no one to attend them — and those are exactly the records a
 * practice cannot afford to lose.
 */
export function deleteProvider(orgId: string, id: string, actor: string): { deleted: boolean; error?: string; upcoming?: number; retained?: boolean; references?: number } {
  const provider = providerById(orgId, id);
  if (!provider) return { deleted: false, error: 'not_found' };
  const upcoming = count(
    'bookings',
    (b) =>
      (b as { orgId?: string; providerId?: string; startsAt?: string; status?: string }).orgId === orgId &&
      (b as { providerId?: string }).providerId === id &&
      (b as { status?: string }).status !== 'cancelled' &&
      new Date(String((b as { startsAt?: string }).startsAt)) >= new Date()
  );
  if (upcoming > 0) return { deleted: false, error: 'in_use', upcoming };
  list<RotaDoc>('rota', (r) => r.orgId === orgId && r.providerId === id).forEach((r) => remove('rota', r.id));
  list<RotaChangeDoc>('rotaChanges', (c) => c.orgId === orgId && c.providerId === id).forEach((c) => remove('rotaChanges', c.id));

  // Past and cancelled work is still a record. Keep the provider label behind
  // those ids, but retire it from every active picker. Hard deletion is reserved
  // for setup rows that have never been referenced.
  const references =
    count('bookings', (row) => (row as { orgId?: string; providerId?: string }).orgId === orgId && (row as { providerId?: string }).providerId === id) +
    count('classSessions', (row) => (row as { orgId?: string; providerId?: string }).orgId === orgId && (row as { providerId?: string }).providerId === id) +
    count('notes', (row) => (row as { orgId?: string; providerId?: string }).orgId === orgId && (row as { providerId?: string }).providerId === id) +
    count('expenses', (row) => (row as { orgId?: string; providerId?: string }).orgId === orgId && (row as { providerId?: string }).providerId === id) +
    count('invoices', (row) =>
      (row as { orgId?: string }).orgId === orgId &&
      Array.isArray((row as unknown as { lines?: { providerId?: string }[] }).lines) &&
      ((row as unknown as { lines?: { providerId?: string }[] }).lines ?? []).some((line) => line.providerId === id)
    );
  if (references > 0) {
    update<ProviderDoc>('providers', id, { active: false });
    audit({ orgId, actor, action: 'provider.retired', target: id, detail: `${provider.name} · retained by ${references} historical record(s)` });
    return { deleted: true, retained: true, references };
  }

  remove('providers', id);
  audit({ orgId, actor, action: 'provider.deleted', target: id, detail: provider.name });
  return { deleted: true };
}

/* --------------------------------------------------------------- services */

export function servicesFor(orgId: string, opts?: { includeInactive?: boolean }): ServiceDoc[] {
  const all = list<ServiceDoc>('services', (s) => s.orgId === orgId);
  return (opts?.includeInactive ? all : all.filter((s) => s.active !== false)).sort((a, b) => a.name.localeCompare(b.name));
}

export function serviceById(orgId: string, id: string): ServiceDoc | undefined {
  const row = get<ServiceDoc>('services', id);
  return row && row.orgId === orgId ? row : undefined;
}

/** Find by id first, then by name — so a model that says "the 30 minute consult" still lands. */
export function serviceByNameOrId(orgId: string, value: string): ServiceDoc | undefined {
  const needle = String(value ?? '').trim().toLowerCase();
  if (!needle) return undefined;
  const all = servicesFor(orgId, { includeInactive: true });
  return (
    all.find((s) => s.id === value) ??
    all.find((s) => s.name.toLowerCase() === needle) ??
    all.find((s) => s.name.toLowerCase().includes(needle) || needle.includes(s.name.toLowerCase()))
  );
}

/** A service's own recall interval, or `undefined` for "the practice's window". */
function recallDaysOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const days = Math.round(Number(value));
  if (!Number.isFinite(days) || days < 1) return undefined;
  return Math.min(days, 3650);
}

export function createService(orgId: string, input: Partial<ServiceDoc> & { name: string }, actor: string): ServiceDoc {
  const existing = servicesFor(orgId, { includeInactive: true });
  const duration = Number(input.durationMinutes ?? 30);
  const row = insert<ServiceDoc>('services', {
    id: newId('svc_'),
    orgId,
    name: input.name.trim(),
    code: input.code?.trim() || undefined,
    description: input.description?.trim() || undefined,
    durationMinutes: Number.isFinite(duration) && duration > 0 ? duration : 30,
    bufferBeforeMinutes: Math.max(0, Number(input.bufferBeforeMinutes ?? 0) || 0),
    bufferAfterMinutes: Math.max(0, Number(input.bufferAfterMinutes ?? 0) || 0),
    price: Number(input.price ?? 0) || 0,
    taxRatePct: input.taxRatePct === undefined ? undefined : Number(input.taxRatePct) || 0,
    colour: input.colour || COLOURS[(existing.length + 3) % COLOURS.length],
    slotStepMinutes: input.slotStepMinutes ? Number(input.slotStepMinutes) : undefined,
    capacity: input.capacity === undefined ? undefined : Number(input.capacity),
    recallDays: recallDaysOrUndefined(input.recallDays),
    active: input.active !== false,
  } as ServiceDoc);
  audit({ orgId, actor, action: 'service.created', target: row.id, detail: `${row.name} · ${row.durationMinutes}m` });
  return row;
}

export function updateService(orgId: string, id: string, patch: Partial<ServiceDoc>, actor: string): ServiceDoc | undefined {
  if (!serviceById(orgId, id)) return undefined;
  const clean: Partial<ServiceDoc> = {};
  for (const key of ['name', 'code', 'description', 'durationMinutes', 'bufferBeforeMinutes', 'bufferAfterMinutes', 'price', 'taxRatePct', 'colour', 'slotStepMinutes', 'capacity', 'recallDays', 'active'] as const) {
    if (key in patch) clean[key] = patch[key] as never;
  }
  if (clean.durationMinutes !== undefined && !(Number(clean.durationMinutes) > 0)) delete clean.durationMinutes;
  // `null` means "inherit the practice window" and is a deliberate value, not an
  // absence: a service that had its own interval and should go back to the
  // practice's needs a way to say so.
  if ('recallDays' in patch && !(Number(patch.recallDays) > 0)) clean.recallDays = undefined;
  const row = update<ServiceDoc>('services', id, clean);
  audit({ orgId, actor, action: 'service.updated', target: id, detail: Object.keys(clean).join(', ') });
  return row;
}

/**
 * The recall interval for somebody whose last visit was this service.
 *
 * One function, so the list the desk reads and the messages the scheduler sends
 * can never disagree about *why* a person is on it. Order: the service's own
 * interval, then the practice's, then the outreach rule's — the rule's number is
 * the oldest of the three and stays as the last fallback, so a workspace that set
 * it years ago is not silently re-timed.
 */
/**
 * The window a client is judged by: their last service, else the practice, else
 * the workspace's own last-resort number.
 *
 * The fallback is *passed in* rather than imported. `messages.ts` imports this
 * file, and the rules live behind it — so the caller that already has the rules
 * (`recalls.ts`, `reports.ts`) hands the number over rather than this becoming a
 * cycle. It used to be a hardcoded 180, which made `rules.recall.afterDays` — a
 * field on the messaging screen, clamped on save and reported back as
 * `ruleFallbackDays` — a control that changed nothing.
 */
export function recallIntervalDays(orgId: string, serviceId?: string, ruleFallbackDays = 180): { days: number; source: 'service' | 'practice' | 'rule' } {
  const service = serviceId ? serviceById(orgId, serviceId) : undefined;
  if (service?.recallDays && service.recallDays > 0) return { days: Math.round(service.recallDays), source: 'service' };
  const profile = practiceProfile(orgId);
  if (profile.recallDays && profile.recallDays > 0) return { days: Math.round(profile.recallDays), source: 'practice' };
  const last = Math.round(Number(ruleFallbackDays));
  return { days: Number.isFinite(last) && last > 0 ? last : 180, source: 'rule' };
}

export function deleteService(orgId: string, id: string, actor: string): { deleted: boolean; error?: string; upcoming?: number; because?: 'appointments' | 'classes'; retained?: boolean; references?: number } {
  const service = serviceById(orgId, id);
  if (!service) return { deleted: false, error: 'not_found' };
  const upcoming = count(
    'bookings',
    (b) =>
      (b as { orgId?: string; serviceId?: string; startsAt?: string; status?: string }).orgId === orgId &&
      (b as { serviceId?: string }).serviceId === id &&
      (b as { status?: string }).status !== 'cancelled' &&
      new Date(String((b as { startsAt?: string }).startsAt)) >= new Date()
  );
  if (upcoming > 0) return { deleted: false, error: 'in_use', upcoming, because: 'appointments' };
  /**
   * A **class** with sessions still to come counts as in use too (A8).
   *
   * Without this the service could be deleted while a session of it stood on the
   * diary, leaving a block nobody can name and no screen can cancel — the class
   * equivalent of an appointment with nobody attached.
   */
  const upcomingSessions = count(
    'classSessions',
    (session) =>
      (session as { orgId?: string; serviceId?: string; startsAt?: string; status?: string }).orgId === orgId &&
      (session as { serviceId?: string }).serviceId === id &&
      (session as { status?: string }).status !== 'cancelled' &&
      new Date(String((session as { startsAt?: string }).startsAt)) >= new Date()
  );
  if (upcomingSessions > 0) return { deleted: false, error: 'in_use', upcoming: upcomingSessions, because: 'classes' };

  const references =
    count('bookings', (row) => (row as { orgId?: string; serviceId?: string }).orgId === orgId && (row as { serviceId?: string }).serviceId === id) +
    count('classSessions', (row) => (row as { orgId?: string; serviceId?: string }).orgId === orgId && (row as { serviceId?: string }).serviceId === id) +
    count('notes', (row) => (row as { orgId?: string; serviceId?: string }).orgId === orgId && (row as { serviceId?: string }).serviceId === id) +
    count('noteTemplates', (row) => (row as { orgId?: string; serviceId?: string }).orgId === orgId && (row as { serviceId?: string }).serviceId === id) +
    count('packProducts', (row) => (row as { orgId?: string; serviceId?: string }).orgId === orgId && (row as { serviceId?: string }).serviceId === id) +
    count('clientPacks', (row) => (row as { orgId?: string; serviceId?: string }).orgId === orgId && (row as { serviceId?: string }).serviceId === id) +
    count('invoices', (row) =>
      (row as { orgId?: string }).orgId === orgId &&
      Array.isArray((row as unknown as { lines?: { serviceId?: string }[] }).lines) &&
      ((row as unknown as { lines?: { serviceId?: string }[] }).lines ?? []).some((line) => line.serviceId === id)
    );

  // Providers reference services by id; drop the active offering whether the
  // service can be hard-deleted or must remain as a historical label.
  providersFor(orgId, { includeInactive: true })
    .filter((p) => p.serviceIds.includes(id))
    .forEach((p) => update<ProviderDoc>('providers', p.id, { serviceIds: p.serviceIds.filter((s) => s !== id) }));
  if (references > 0) {
    update<ServiceDoc>('services', id, { active: false });
    audit({ orgId, actor, action: 'service.retired', target: id, detail: `${service.name} · retained by ${references} historical record(s)` });
    return { deleted: true, retained: true, references };
  }

  remove('services', id);
  audit({ orgId, actor, action: 'service.deleted', target: id, detail: service.name });
  return { deleted: true };
}

/* -------------------------------------------------------------- locations */

export function locationsFor(orgId: string, opts?: { includeInactive?: boolean }): LocationDoc[] {
  const all = list<LocationDoc>('locations', (l) => l.orgId === orgId);
  return (opts?.includeInactive ? all : all.filter((l) => l.active !== false)).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The clock the practice keeps.
 *
 * A workspace with one site is unambiguous. A workspace with several needs a
 * rule, and the rule is *the first site by name* — the same one reports use
 * (`/api/v1/reports`), so a diary window and a revenue window can never be a day
 * apart because two modules picked different sites. Written once, here, because
 * the alternative is a `?? 'UTC'` in each caller, and that is how a New York
 * practice ends up drawing its grid four hours out.
 */
export function practiceTimezone(orgId: string, site?: LocationDoc): string {
  return site?.timezone ?? locationsFor(orgId)[0]?.timezone ?? 'UTC';
}

export function locationById(orgId: string, id: string): LocationDoc | undefined {
  const row = get<LocationDoc>('locations', id);
  return row && row.orgId === orgId ? row : undefined;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function createLocation(
  orgId: string,
  input: Partial<LocationDoc> & { name: string },
  actor: string
): LocationDoc {
  const timezone = String(input.timezone ?? '').trim() || 'UTC';
  const rooms: Room[] = Array.isArray(input.rooms)
    ? input.rooms
        .map((r) => (typeof r === 'string' ? { id: newId('room_'), name: r } : { id: String((r as Room).id ?? newId('room_')), name: String((r as Room).name ?? 'Room') }))
        .filter((r) => r.name.trim().length > 0)
    : [];
  const row = insert<LocationDoc>('locations', {
    id: newId('loc_'),
    orgId,
    name: input.name.trim(),
    address: input.address?.trim() || undefined,
    timezone,
    rooms,
    active: input.active !== false,
  } as LocationDoc);
  audit({ orgId, actor, action: 'location.created', target: row.id, detail: `${row.name} · ${timezone}` });
  return row;
}

export function updateLocation(orgId: string, id: string, patch: Partial<LocationDoc>, actor: string): LocationDoc | undefined {
  if (!locationById(orgId, id)) return undefined;
  const clean: Partial<LocationDoc> = {};
  // `rooms` is deliberately not patchable here. A room is a record with an id
  // that appointments point at (see `lib/server/rooms.ts`); writing the mirror
  // by hand from two doors is how a rename used to orphan a booked room.
  for (const key of ['name', 'address', 'timezone', 'active'] as const) {
    if (key in patch) clean[key] = patch[key] as never;
  }
  const row = update<LocationDoc>('locations', id, clean);
  audit({ orgId, actor, action: 'location.updated', target: id, detail: Object.keys(clean).join(', ') });
  return row;
}

export function deleteLocation(orgId: string, id: string, actor: string): { deleted: boolean; error?: string; upcoming?: number; retained?: boolean; references?: number } {
  const location = locationById(orgId, id);
  if (!location) return { deleted: false, error: 'not_found' };
  const upcoming = count(
    'bookings',
    (b) =>
      (b as { orgId?: string; locationId?: string; startsAt?: string; status?: string }).orgId === orgId &&
      (b as { locationId?: string }).locationId === id &&
      (b as { status?: string }).status !== 'cancelled' &&
      new Date(String((b as { startsAt?: string }).startsAt)) >= new Date()
  );
  if (upcoming > 0) return { deleted: false, error: 'in_use', upcoming };
  list<RotaDoc>('rota', (r) => r.orgId === orgId && r.locationId === id).forEach((r) => remove('rota', r.id));
  list<RotaChangeDoc>('rotaChanges', (row) => row.orgId === orgId && row.locationId === id).forEach((row) => remove('rotaChanges', row.id));

  const roomIds = new Set(list<Doc & { orgId?: string; locationId?: string }>('rooms', (room) => room.orgId === orgId && room.locationId === id).map((room) => room.id));
  const references =
    count('bookings', (row) =>
      (row as { orgId?: string }).orgId === orgId &&
      ((row as { locationId?: string }).locationId === id || roomIds.has(String((row as { roomId?: string }).roomId ?? '')))
    ) +
    count('classSessions', (row) => (row as { orgId?: string; locationId?: string }).orgId === orgId && (row as { locationId?: string }).locationId === id);

  // A retired site and its rooms disappear from availability, while names and
  // ids stay resolvable on old appointments/classes. Unused setup rows may still
  // be hard-deleted so test/setup mistakes do not accumulate forever.
  providersFor(orgId, { includeInactive: true })
    .filter((provider) => provider.locationIds.includes(id))
    .forEach((provider) => update<ProviderDoc>('providers', provider.id, { locationIds: provider.locationIds.filter((locationId) => locationId !== id) }));
  if (references > 0) {
    list<Doc & { active?: boolean }>('rooms', (room) => roomIds.has(room.id)).forEach((room) => update('rooms', room.id, { active: false }));
    update<LocationDoc>('locations', id, { active: false, rooms: [] });
    audit({ orgId, actor, action: 'location.retired', target: id, detail: `${location.name} · retained by ${references} historical record(s)` });
    return { deleted: true, retained: true, references };
  }

  remove('locations', id);
  audit({ orgId, actor, action: 'location.deleted', target: id, detail: location.name });
  return { deleted: true };
}

/* ------------------------------------------------------------------- rota */

export function rotaFor(orgId: string, providerId: string, locationId: string): RotaDoc | undefined {
  return list<RotaDoc>('rota', (r) => r.orgId === orgId && r.providerId === providerId && r.locationId === locationId)[0];
}

export function rotaForOrg(orgId: string): RotaDoc[] {
  return list<RotaDoc>('rota', (r) => r.orgId === orgId);
}

export function setRota(
  orgId: string,
  input: { providerId: string; locationId: string; windows: RotaWindow[]; breaks?: RotaBreak[] },
  actor: string
): RotaDoc | undefined {
  if (!providerById(orgId, input.providerId) || !locationById(orgId, input.locationId)) return undefined;
  const existing = rotaFor(orgId, input.providerId, input.locationId);
  const breaks = (input.breaks ?? [])
    .map((b) => ({ start: String(b.start), end: String(b.end), label: b.label }))
    .filter((b) => clockToMinutes(b.start) !== null && clockToMinutes(b.end) !== null);
  const row = existing
    ? update<RotaDoc>('rota', existing.id, { windows: input.windows, breaks })
    : insert<RotaDoc>('rota', {
        id: newId('rot_'),
        orgId,
        providerId: input.providerId,
        locationId: input.locationId,
        windows: input.windows,
        breaks,
      } as RotaDoc);
  audit({
    orgId,
    actor,
    action: existing ? 'rota.updated' : 'rota.created',
    target: row?.id ?? '',
    detail: `${input.providerId} @ ${input.locationId} · ${input.windows.length} window(s)`,
  });
  return row;
}

export function rotaChangesFor(orgId: string, opts?: { providerId?: string; from?: string; to?: string }): RotaChangeDoc[] {
  return list<RotaChangeDoc>(
    'rotaChanges',
    (c) =>
      c.orgId === orgId &&
      (!opts?.providerId || c.providerId === opts.providerId) &&
      (!opts?.from || c.date >= opts.from) &&
      (!opts?.to || c.date <= opts.to)
  ).sort((a, b) => a.date.localeCompare(b.date));
}

export function addRotaChange(
  orgId: string,
  input: { providerId: string; date: string; kind: 'off' | 'extra'; windows?: RotaWindow[]; reason?: string },
  actor: string
): RotaChangeDoc | undefined {
  if (!providerById(orgId, input.providerId)) return undefined;
  // One change per provider per date: two rows for the same day would be a
  // question with two answers, and the diary would have to guess.
  const existing = list<RotaChangeDoc>('rotaChanges', (c) => c.orgId === orgId && c.providerId === input.providerId && c.date === input.date)[0];
  const row = existing
    ? update<RotaChangeDoc>('rotaChanges', existing.id, { kind: input.kind, windows: input.windows, reason: input.reason })
    : insert<RotaChangeDoc>('rotaChanges', {
        id: newId('rch_'),
        orgId,
        providerId: input.providerId,
        date: input.date,
        kind: input.kind,
        windows: input.windows,
        reason: input.reason,
      } as RotaChangeDoc);
  audit({ orgId, actor, action: `rota.${input.kind}_day`, target: row?.id ?? '', detail: `${input.providerId} ${input.date}${input.reason ? ` · ${input.reason}` : ''}` });
  return row;
}

export function removeRotaChange(orgId: string, id: string, actor: string): boolean {
  const row = get<RotaChangeDoc>('rotaChanges', id);
  if (!row || row.orgId !== orgId) return false;
  remove('rotaChanges', id);
  audit({ orgId, actor, action: 'rota.change_removed', target: id, detail: `${row.providerId} ${row.date}` });
  return true;
}

/* ------------------------------------------------------------------- seed */

/**
 * Practice data for a new (or never-seeded) organisation.
 *
 * Idempotent per collection: an org that already has providers keeps them. What
 * it creates is a small but *real* practice — two sites in different timezones,
 * four services with different durations and buffers, three providers with
 * different specialisms — because an availability engine demoed against empty
 * data proves nothing.
 */
export function seedPractice(orgId: string): { seeded: boolean; reason?: string } {
  // Three guards, because the demo's services were seeded twice before the first
  // two existed: a workspace that has been seeded once says so on its own record.
  // Without the flag, deleting the last practitioner would invite a second set of
  // services and a booking page with two names for one job.
  if (get<Doc & { practice?: { seededAt?: string } }>('orgs', orgId)?.practice?.seededAt) {
    return { seeded: false, reason: 'already_seeded' };
  }
  if (count('providers', (p) => (p as { orgId?: string }).orgId === orgId) > 0) {
    return { seeded: false, reason: 'providers_exist' };
  }
  if (count('services', (s) => (s as { orgId?: string }).orgId === orgId) > 0) {
    return { seeded: false, reason: 'services_exist' };
  }

  const hq = createLocation(
    orgId,
    {
      name: 'Northwind HQ — San Francisco',
      address: '480 Bryant Street, San Francisco, CA',
      timezone: 'America/Los_Angeles',
      rooms: [
        { id: newId('room_'), name: 'Bay Room' },
        { id: newId('room_'), name: 'Mission Room' },
      ],
    } as never,
    'seed'
  );
  const east = createLocation(
    orgId,
    { name: 'Northwind East — New York', timezone: 'America/New_York', rooms: [{ id: newId('room_'), name: 'Hudson Room' }] } as never,
    'seed'
  );

  const consult = createService(orgId, { name: 'Support consultation', durationMinutes: 30, price: 95, colour: 'brand', description: 'A first conversation about the problem.' } as never, 'seed');
  const install = createService(orgId, { name: 'Installation visit', durationMinutes: 90, bufferBeforeMinutes: 15, bufferAfterMinutes: 15, price: 180, colour: 'violet' } as never, 'seed');
  const service = createService(orgId, { name: 'Annual service', durationMinutes: 60, bufferAfterMinutes: 10, price: 140, colour: 'emerald' } as never, 'seed');
  const quick = createService(orgId, { name: 'Quick check', durationMinutes: 15, price: 45, colour: 'amber', slotStepMinutes: 15 } as never, 'seed');

  const dana = createProvider(
    orgId,
    { name: 'Dana Whitfield', title: 'Senior consultant', colour: 'brand', serviceIds: [consult.id, install.id, service.id], locationIds: [hq.id] } as never,
    'seed'
  );
  const marcus = createProvider(
    orgId,
    { name: 'Marcus Ito', title: 'Field engineer', colour: 'violet', serviceIds: [install.id, service.id, quick.id], locationIds: [hq.id, east.id] } as never,
    'seed'
  );
  const priya = createProvider(
    orgId,
    { name: 'Priya Raman', title: 'Account engineer', colour: 'emerald', serviceIds: [consult.id, quick.id], locationIds: [east.id] } as never,
    'seed'
  );

  const weekdays = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' }));
  const lunch = [{ start: '12:00', end: '13:00', label: 'Lunch' }];
  setRota(orgId, { providerId: dana.id, locationId: hq.id, windows: weekdays, breaks: lunch }, 'seed');
  setRota(orgId, { providerId: marcus.id, locationId: hq.id, windows: weekdays, breaks: lunch }, 'seed');
  // The New York site runs later days, in its own timezone.
  setRota(
    orgId,
    { providerId: marcus.id, locationId: east.id, windows: [2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '08:00', end: '16:00' })), breaks: lunch },
    'seed'
  );
  setRota(orgId, { providerId: priya.id, locationId: east.id, windows: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '10:00', end: '18:00' })), breaks: lunch }, 'seed');

  setPracticeProfile(orgId, { termPack: 'service', slotStepMinutes: 15, minNoticeMinutes: 120, maxAdvanceDays: 60 }, 'seed');
  // The flag is written last, and only for the workspace that was just seeded.
  const row = get<Doc & { practice?: Record<string, unknown> }>('orgs', orgId);
  if (row) update<Doc>('orgs', orgId, { practice: { ...(row.practice ?? {}), seededAt: nowIso() } } as never);
  return { seeded: true };
}
