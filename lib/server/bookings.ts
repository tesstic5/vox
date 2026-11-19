/**
 * Native appointment records shared by every Voxera scheduling channel.
 * `externalId` is a workspace-scoped reference/idempotency key; the appointment
 * itself lives in Voxera's diary and is never a remote mirror.
 */

import { find, get, insert, list, newId, nowIso, update, withEntityLock, type Doc } from './db';
import { audit } from './audit';
import { ensureClientForBooking, noteAppointmentForClient } from './clients';
import { freeRoomFor, roomNameOf } from './rooms';
import { deliverWebhook } from './webhooks';
import { commitBookingFunding, type FundingAllocation } from './funding';

export const BOOKING_STATUSES = ['pending', 'confirmed', 'arrived', 'completed', 'cancelled', 'no_show'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const BOOKING_OUTCOMES = ['confirmed', 'rescheduled', 'cancelled', 'declined', 'no_answer', 'voicemail', 'failed'] as const;
export type BookingOutcome = (typeof BOOKING_OUTCOMES)[number];

export type BookingDoc = Doc & {
  orgId: string;
  /** Workspace-scoped reference/idempotency key supplied by the creating channel. */
  externalId: string;
  customer: { name: string; number: string; email?: string };
  service: string;
  startsAt: string;
  durationMinutes: number;
  timezone?: string;
  status: BookingStatus;
  /** Diary links are optional until a practitioner, service or site is assigned. */
  providerId?: string;
  serviceId?: string;
  locationId?: string;
  roomId?: string;
  /** Where the booking came from: the client's API, the dashboard, a call, or the public page. */
  source: 'client_api' | 'dashboard' | 'call' | 'seed' | 'online' | 'waitlist';
  notes?: string;
  /** Calls that touched this booking, newest last. */
  callIds?: string[];
  outcome?: BookingOutcome;
  outcomeNote?: string;
  outcomeAt?: string;
  /** Reminder bookkeeping, so a campaign never rings twice for the same booking. */
  attempts: { at: string; callId?: string; outcome: BookingOutcome; detail?: string }[];
  /** What last changed it, for the sync's benefit. */
  revision: number;
  /** The client this appointment belongs to. Resolved from the number on write. */
  clientId?: string;
  /** Explicit case/coverage/funding links. Existing appointments remain unassigned. */
  caseId?: string;
  encounterId?: string;
  coverageId?: string;
  authorisationId?: string;
  fundingPeriodId?: string;
  serviceRuleId?: string;
  fundingAllocation?: FundingAllocation;
  fundingSequence?: number;
  fundingWarning?: string;
  /** Repeat series membership, when this appointment was created as one of several. */
  seriesId?: string;
  seriesIndex?: number;
  /**
   * The class session this booking is a *seat* in (A8).
   *
   * A seat is an ordinary booking on purpose — that is what keeps reminders, the
   * manage link, money and the client's timeline working on it without knowing
   * what a class is. The one difference is that a seat is not itself a busy block:
   * its *session* is, or eight people sharing a room would clash with each other.
   */
  sessionId?: string;
  /**
   * The class pack holding (or having settled) this seat, when one does.
   * `held` = the place is reserved against the pack but not yet spent;
   * `spent` = attendance (or a late cancel / no-show) settled it;
   * `released` = the hold came off and the place went back to the pack.
   */
  packId?: string;
  packState?: 'held' | 'spent' | 'released';
  /** The invoice a spent place was settled on. */
  packInvoiceId?: string;
  /** Last accepted write time, used by incremental API reads. */
  syncedAt?: string;
  value?: number;
  metadata?: Record<string, string>;
  history?: { at: string; event: string; detail?: string }[];
};

export type BookingInput = {
  externalId: string;
  customer: { name: string; number: string; email?: string };
  service?: string;
  startsAt: string;
  durationMinutes?: number;
  timezone?: string;
  status?: BookingStatus;
  notes?: string;
  value?: number;
  metadata?: Record<string, string>;
  providerId?: string;
  serviceId?: string;
  locationId?: string;
  roomId?: string;
  /** The client this belongs to — resolved from the number on write. */
  clientId?: string;
  /** Staff-selected case/funding references; never inferred from history. */
  caseId?: string;
  coverageId?: string;
  authorisationId?: string;
  fundingOverrideReason?: string;
  fundingOverrideBy?: string;
  /** Repeat series membership. */
  seriesId?: string;
  seriesIndex?: number;
  /** The class session this is a seat in, when it is one. */
  sessionId?: string;
};

export const OPEN_STATUSES: BookingStatus[] = ['pending', 'confirmed'];

export class BookingFundingError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'VALIDATION_ERROR' | 'CONFLICT' | 'LIMIT_EXCEEDED' | 'MISSING_FUNDING',
    readonly detail?: { missing?: string[]; breaches?: string[] },
  ) {
    super(message);
    this.name = 'BookingFundingError';
  }
}

function fundedBookingOrThrow(result: ReturnType<typeof commitBookingFunding>): BookingDoc {
  if (!result.ok) throw new BookingFundingError(result.error, result.code, { missing: result.missing, breaches: result.breaches });
  return result.value as BookingDoc;
}

/* -------------------------------------------------------------------- store */

export function bookingsFor(orgId: string, filter?: (b: BookingDoc) => boolean) {
  return list<BookingDoc>('bookings', (b) => b.orgId === orgId && (!filter || filter(b)));
}

export function bookingById(orgId: string, id: string) {
  const doc = get<BookingDoc>('bookings', id);
  return doc && doc.orgId === orgId ? doc : undefined;
}

export function bookingByExternalId(orgId: string, externalId: string) {
  return bookingsFor(orgId, (b) => b.externalId === externalId)[0];
}

/** Creates or updates one native appointment by its workspace-scoped reference. */
export function upsertBooking(input: BookingInput & { orgId: string; source?: BookingDoc['source'] }): { booking: BookingDoc; created: boolean; changed: boolean } {
  if (!input.clientId) return upsertBookingUnlocked(input);
  return withEntityLock('patient-link', `${input.orgId}:${input.clientId}`, () => {
    const patient = find<Doc & { orgId?: string; mergedIntoClientId?: string }>('clients', (row) => row.id === input.clientId && row.orgId === input.orgId);
    const canonical = patient?.mergedIntoClientId;
    return upsertBookingUnlocked(canonical ? { ...input, clientId: canonical } : input);
  });
}

function upsertBookingUnlocked(input: BookingInput & { orgId: string; source?: BookingDoc['source'] }): { booking: BookingDoc; created: boolean; changed: boolean } {
  const existing = bookingByExternalId(input.orgId, input.externalId);
  const now = nowIso();


  // Every appointment belongs to a client. If the caller did not pass one, it is
  // resolved from the number — which is how a phone booking and a receptionist's
  // booking end up on the same history instead of two.
  if (!input.clientId && input.customer?.number) {
    const actor =
      input.source === 'call'
        ? 'agent'
        : input.source === 'client_api' || input.source === 'seed'
          ? 'sync'
          : input.source === 'online'
            ? 'online-booking'
            : input.source === 'waitlist'
              ? 'waitlist'
              : 'dashboard';
    const client = ensureClientForBooking(input.orgId, input.customer, actor, {
      // A record's own `source` describes the door it came through, so the list
      // can say "booked online" rather than only "booked".
      source: input.source === 'online' ? 'online' : input.source === 'client_api' || input.source === 'seed' ? 'import' : 'booking',
    });
    input = { ...input, clientId: client.id };
  }
  const status = input.status ?? 'confirmed';

  if (!existing) {
    const draft = {
      id: newId('bkg_'),
      orgId: input.orgId,
      externalId: input.externalId,
      customer: input.customer,
      service: input.service ?? 'Appointment',
      startsAt: input.startsAt,
      durationMinutes: input.durationMinutes ?? 30,
      timezone: input.timezone,
      status,
      source: input.source ?? 'client_api',
      notes: input.notes,
      value: input.value,
      providerId: input.providerId,
      serviceId: input.serviceId,
      locationId: input.locationId,
      // The room the appointment occupies. Whoever books — the desk, the phone
      // agent, a stranger on the web page — the diary records where the person
      // is meant to be, so a room can be shown, protected and double-booked
      // never. An explicit room survives; otherwise take the one free at that
      // hour, exactly as the availability offer did.
      roomId:
        input.roomId ??
        freeRoomFor(input.orgId, {
          locationId: input.locationId,
          startsAt: input.startsAt,
          durationMinutes: input.durationMinutes,
          serviceId: input.serviceId,
        })?.id,
      clientId: input.clientId,
      caseId: input.caseId,
      coverageId: input.coverageId,
      authorisationId: input.authorisationId,
      seriesId: input.seriesId,
      seriesIndex: input.seriesIndex,
      sessionId: input.sessionId,
      metadata: input.metadata,
      attempts: [],
      revision: 1,
      syncedAt: now,
      history: [{ at: now, event: 'created', detail: `from ${input.source ?? 'client_api'}` }],
      createdAt: now,
    } as BookingDoc;
    const created = input.caseId
      ? fundedBookingOrThrow(commitBookingFunding({
          orgId: input.orgId,
          booking: draft,
          expectedRevision: null,
          actorId: input.fundingOverrideBy ?? input.source ?? 'sync',
          reason: 'booking created with case funding',
          override: input.fundingOverrideReason && input.fundingOverrideBy
            ? { by: input.fundingOverrideBy, reason: input.fundingOverrideReason }
            : undefined,
        }))
      : insert<BookingDoc>('bookings', draft);
    audit({ orgId: input.orgId, actor: 'sync', action: 'booking.created', target: created.id, detail: `${input.externalId} ${input.customer.name}` });
    if (created.clientId) noteAppointmentForClient(input.orgId, created.clientId, created.startsAt);
    return { booking: created, created: true, changed: true };
  }

  const moved = new Date(input.startsAt).getTime() !== new Date(existing.startsAt).getTime();
  const changed =
    moved ||
    existing.customer.number !== input.customer.number ||
    existing.customer.name !== input.customer.name ||
    existing.status !== status ||
    existing.service !== (input.service ?? existing.service) ||
    existing.durationMinutes !== (input.durationMinutes ?? existing.durationMinutes) ||
    existing.providerId !== (input.providerId ?? existing.providerId) ||
    existing.serviceId !== (input.serviceId ?? existing.serviceId) ||
    existing.locationId !== (input.locationId ?? existing.locationId) ||
    existing.caseId !== (input.caseId ?? existing.caseId) ||
    existing.coverageId !== (input.coverageId ?? existing.coverageId) ||
    existing.authorisationId !== (input.authorisationId ?? existing.authorisationId);

  const history = changed
    ? [
        ...(existing.history ?? []),
        {
          at: now,
          event: moved ? 'moved' : 'updated',
          detail: moved ? `${existing.startsAt} → ${input.startsAt}` : `status ${existing.status} → ${status}`,
        },
      ].slice(-40)
    : existing.history ?? [];

  const patch: Partial<BookingDoc> = {
    customer: input.customer,
    service: input.service ?? existing.service,
    startsAt: input.startsAt,
    durationMinutes: input.durationMinutes ?? existing.durationMinutes,
    timezone: input.timezone ?? existing.timezone,
    status,
    notes: input.notes ?? existing.notes,
    value: input.value ?? existing.value,
    // Diary links only move when the caller supplies one: a sync payload that
    // omits `providerId` must not wipe the provider the dashboard assigned.
    providerId: input.providerId ?? existing.providerId,
    serviceId: input.serviceId ?? existing.serviceId,
    locationId: input.locationId ?? existing.locationId,
    // A move can land in an hour where the old room is already taken, so the
    // room is re-checked against the new time (and kept when it still fits).
    roomId:
      input.roomId ??
      (existing.roomId && moved
        ? freeRoomFor(input.orgId, {
            locationId: input.locationId ?? existing.locationId,
            startsAt: input.startsAt,
            durationMinutes: input.durationMinutes ?? existing.durationMinutes,
            serviceId: input.serviceId ?? existing.serviceId,
            ignoreBookingId: existing.id,
          })?.id ?? existing.roomId
        : existing.roomId),
    clientId: input.clientId ?? existing.clientId,
    caseId: input.caseId ?? existing.caseId,
    coverageId: input.coverageId ?? existing.coverageId,
    authorisationId: input.authorisationId ?? existing.authorisationId,
    seriesId: input.seriesId ?? existing.seriesId,
    seriesIndex: input.seriesIndex ?? existing.seriesIndex,
    sessionId: input.sessionId ?? existing.sessionId,
    metadata: input.metadata ?? existing.metadata,
    syncedAt: now,
    revision: changed ? existing.revision + 1 : existing.revision,
    history,
  };
  const next = { ...existing, ...patch } as BookingDoc;
  const booking = next.caseId || existing.fundingAllocation
    ? fundedBookingOrThrow(commitBookingFunding({
        orgId: input.orgId,
        booking: next,
        expectedRevision: Number(existing.revision ?? 0),
        actorId: input.fundingOverrideBy ?? input.source ?? 'sync',
        reason: moved ? 'booking moved or funding references changed' : `booking status ${existing.status} → ${status}`,
        override: input.fundingOverrideReason && input.fundingOverrideBy
          ? { by: input.fundingOverrideBy, reason: input.fundingOverrideReason }
          : undefined,
      }))
    : update<BookingDoc>('bookings', existing.id, patch) as BookingDoc;

  return { booking, created: false, changed };
}

/**
 * Records what a call did to a booking.
 *
 * Phone and staff tools call this while recording an interaction. `revision`
 * increments so incremental API readers see the change.
 */
export function applyOutcome(input: {
  orgId: string;
  bookingId: string;
  outcome: BookingOutcome;
  callId?: string;
  note?: string;
  /** Set when the caller moved the booking during the call. */
  startsAt?: string;
  /**
   * The room the visit occupies after the move.
   *
   * A move is a change of *when*, and a room is only free *when* — so whoever
   * moves a booking has to hand back the room it re-picked for the new time.
   * Left absent, the appointment keeps the room it had, which is how two
   * patients end up in one room at the same hour.
   */
  roomId?: string;
  actor?: string;
}): BookingDoc | undefined {
  const booking = bookingById(input.orgId, input.bookingId);
  if (!booking) return undefined;
  const now = nowIso();

  const status: BookingStatus =
    input.outcome === 'confirmed'
      ? 'confirmed'
      : input.outcome === 'cancelled' || input.outcome === 'declined'
        ? 'cancelled'
        : booking.status;

  const roomChanged = input.roomId !== undefined && input.roomId !== booking.roomId;
  const movedRoom = roomChanged && input.roomId ? roomNameOf(booking.orgId, input.roomId) : undefined;
  const history = [
    ...(booking.history ?? []),
    {
      at: now,
      event: input.outcome,
      detail:
        [
          input.startsAt ? `moved to ${input.startsAt}` : undefined,
          roomChanged ? (movedRoom ? `room now ${movedRoom}` : 'room released') : undefined,
          input.note,
        ]
          .filter(Boolean)
          .join(' · ') || undefined,
    },
  ].slice(-40);

  const patch: Partial<BookingDoc> = {
    status,
    startsAt: input.startsAt ?? booking.startsAt,
    roomId: roomChanged ? input.roomId : booking.roomId,
    outcome: input.outcome,
    outcomeNote: input.note,
    outcomeAt: now,
    callIds: input.callId && !(booking.callIds ?? []).includes(input.callId) ? [...(booking.callIds ?? []), input.callId] : booking.callIds,
    attempts: [...booking.attempts, { at: now, callId: input.callId, outcome: input.outcome, detail: input.note }].slice(-20),
    revision: booking.revision + 1,
    history,
  };
  const updated = booking.caseId || booking.fundingAllocation
    ? fundedBookingOrThrow(commitBookingFunding({
        orgId: input.orgId,
        booking: { ...booking, ...patch } as BookingDoc,
        expectedRevision: Number(booking.revision ?? 0),
        actorId: input.actor ?? 'agent',
        reason: `booking outcome ${input.outcome}`,
      }))
    : update<BookingDoc>('bookings', booking.id, patch);

  if (updated) {
    // The client's system needs to hear about this — it is the whole point of
    // ringing on their behalf. Webhook first (so a subscriber hears immediately),
    // and the sync endpoint carries the same outcomes for pollers.
    void deliverWebhook({
      orgId: input.orgId,
      event: `booking.${input.outcome}`,
      payload: {
        type: `booking.${input.outcome}`,
        booking: {
          id: updated.id,
          externalId: updated.externalId,
          customer: updated.customer,
          service: updated.service,
          startsAt: updated.startsAt,
          status: updated.status,
          timezone: updated.timezone,
        },
        outcome: input.outcome,
        note: input.note,
        callId: input.callId,
        at: now,
      },
    });
    rollUpCampaign(updated, input.outcome, input.callId);
  }

  return updated;
}

/**
 * Keeps a campaign's numbers true.
 *
 * The outcome of a call is known here, and the campaign that queued it is
 * reachable through the call record, so the counters are updated where the
 * knowledge is rather than by a job that has to guess later.
 */
function rollUpCampaign(booking: BookingDoc, outcome: BookingOutcome, callId?: string) {
  if (!callId) return;
  const call = get<Doc & { campaignId?: string }>('calls', callId);
  const campaignId = call?.campaignId;
  if (!campaignId) return;
  const campaign = get<Doc & { stats?: Record<string, number> }>('bookingCampaigns', campaignId);
  if (!campaign) return;
  const key = outcome === 'no_answer' || outcome === 'voicemail' ? 'noAnswer' : outcome;
  const stats = { ...(campaign.stats ?? {}) } as Record<string, number>;
  stats[key] = (stats[key] ?? 0) + 1;
  update('bookingCampaigns', campaignId, { stats });
}

/* ------------------------------------------------------------------ queries */

function hoursUntil(iso: string) {
  return (new Date(iso).getTime() - Date.now()) / 3_600_000;
}

export type DueOptions = {
  /** Only bookings starting within this many hours. Default 24. */
  withinHours?: number;
  /** Only bookings already confirmed (the usual case) or pending too. */
  statuses?: BookingStatus[];
  /** Skip bookings already attempted for this outcome in the window. */
  skipAttempted?: boolean;
  limit?: number;
};

/**
 * Bookings due for a confirmation call.
 *
 * The rule is deliberately explainable: inside the window, still open, and not
 * already called since the booking was last changed — so a client re-running a
 * campaign cannot ring the same customer twice.
 */
export function dueBookings(orgId: string, options: DueOptions = {}) {
  const withinHours = options.withinHours ?? 24;
  const statuses = options.statuses ?? ['confirmed', 'pending'];
  const now = Date.now();

  const due = bookingsFor(
    orgId,
    (b) =>
      statuses.includes(b.status) &&
      new Date(b.startsAt).getTime() > now &&
      hoursUntil(b.startsAt) <= withinHours &&
      (!options.skipAttempted || !calledSinceChange(b))
  );
  due.sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  return typeof options.limit === 'number' ? due.slice(0, options.limit) : due;
}

/** True when the last attempt happened after the client's last edit. */
export function calledSinceChange(booking: BookingDoc) {
  const last = booking.attempts[booking.attempts.length - 1];
  if (!last) return false;
  if (!booking.syncedAt) return true;
  return new Date(last.at).getTime() >= new Date(booking.syncedAt).getTime();
}

export function bookingStats(orgId: string) {
  const all = bookingsFor(orgId);
  const now = Date.now();
  const upcoming = all.filter((b) => OPEN_STATUSES.includes(b.status) && new Date(b.startsAt).getTime() > now);
  const called = all.filter((b) => b.attempts.length > 0);
  const byOutcome = (outcome: BookingOutcome) => all.filter((b) => b.outcome === outcome).length;

  return {
    total: all.length,
    upcoming: upcoming.length,
    next24h: dueBookings(orgId, { withinHours: 24 }).length,
    called: called.length,
    confirmed: byOutcome('confirmed'),
    rescheduled: byOutcome('rescheduled'),
    cancelled: byOutcome('cancelled'),
    noAnswer: byOutcome('no_answer') + byOutcome('voicemail'),
    /** What the calls achieved — the number a client actually asks for. */
    contactedRate: all.length ? Number(((called.length / all.length) * 100).toFixed(1)) : 0,
    confirmedRate: called.length ? Number(((byOutcome('confirmed') / called.length) * 100).toFixed(1)) : 0,
    savings: called.filter((b) => b.status === 'confirmed').reduce((sum, b) => sum + (b.value ?? 0), 0),
  };
}

/** One-line description of a booking, for a prompt or a dashboard cell. */
/**
 * The one line about an appointment that gets spoken to a caller, written to a
 * text message and read by the front desk.
 *
 * `siteName` is optional and only worth passing when the practice runs more than
 * one site: "Thursday at 10" is a complete answer in a single-room clinic and a
 * wrong answer in a two-site one. Callers pass it when they need it, so the
 * single-site wording stays exactly as it was.
 */
export function describeBooking(booking: BookingDoc, siteName?: string) {
  const when = new Date(booking.startsAt);
  const day = when.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: booking.timezone ?? 'UTC' });
  const time = when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: booking.timezone ?? 'UTC' });
  return `${booking.service} on ${day} at ${time}${siteName ? ` at ${siteName}` : ''}`;
}
