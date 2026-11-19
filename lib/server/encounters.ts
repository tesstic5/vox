import { audit } from './audit';
import { bookingById, type BookingDoc } from './bookings';
import { caseById } from './cases';
import { CommitConflictError, commitBatch, get, list, newId, nowIso, type Doc } from './db';

export type EncounterDoc = Doc & {
  orgId: string;
  patientId: string;
  bookingId: string;
  caseId?: string;
  sessionId?: string;
  providerId?: string;
  startsAt: string;
  endedAt?: string;
  status: 'open' | 'finished' | 'cancelled';
  createdBy: string;
  updatedBy: string;
  revision: number;
};

export type EncounterWrite<T> =
  | { ok: true; value: T; booking?: BookingDoc; created?: boolean }
  | { ok: false; code: 'NOT_FOUND' | 'VALIDATION_ERROR' | 'CONFLICT'; error: string };

export function encounterById(orgId: string, id: string) {
  const row = get<EncounterDoc>('encounters', id);
  return row && row.orgId === orgId ? row : undefined;
}

export function encounterForBooking(orgId: string, bookingId: string) {
  return list<EncounterDoc>('encounters', (row) => row.orgId === orgId && row.bookingId === bookingId)[0];
}

export function encountersForPatient(orgId: string, patientId: string) {
  return list<EncounterDoc>('encounters', (row) => row.orgId === orgId && row.patientId === patientId)
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt) || a.id.localeCompare(b.id));
}

/**
 * Creates exactly one encounter for a booking and attaches its id to the booking
 * in the same optimistic transaction. A class seat remains an ordinary booking,
 * so every participant receives an independent encounter through this command.
 */
export function ensureEncounterForBooking(input: {
  orgId: string;
  bookingId: string;
  expectedBookingRevision: number;
  actorId: string;
}): EncounterWrite<EncounterDoc> {
  const booking = bookingById(input.orgId, input.bookingId);
  if (!booking) return { ok: false, code: 'NOT_FOUND', error: 'That booking does not exist.' };
  const existing = booking.encounterId ? encounterById(input.orgId, booking.encounterId) : encounterForBooking(input.orgId, booking.id);
  if (existing) return { ok: true, value: existing, booking, created: false };
  if (!booking.clientId) return { ok: false, code: 'VALIDATION_ERROR', error: 'An encounter requires a booking linked to a client.' };
  if (!['arrived', 'completed', 'no_show'].includes(booking.status)) return { ok: false, code: 'VALIDATION_ERROR', error: 'An encounter can be opened only after the booking is arrived, completed or marked no-show.' };
  if (booking.caseId) {
    const caseRow = caseById(input.orgId, booking.caseId);
    if (!caseRow || caseRow.patientId !== booking.clientId) return { ok: false, code: 'VALIDATION_ERROR', error: 'The booking case does not belong to the encounter patient.' };
  }
  const draft: EncounterDoc = {
    id: newId('enc_'), orgId: input.orgId, patientId: booking.clientId, bookingId: booking.id,
    caseId: booking.caseId, sessionId: booking.sessionId, providerId: booking.providerId,
    startsAt: booking.startsAt,
    ...(booking.status === 'completed' || booking.status === 'no_show' ? { endedAt: nowIso(), status: 'finished' as const } : { status: 'open' as const }),
    createdBy: input.actorId, updatedBy: input.actorId, revision: 0,
  };
  try {
    const result = commitBatch({ upserts: [
      { collection: 'encounters', doc: draft, expectedRevision: null, expectedOrgId: input.orgId },
      { collection: 'bookings', doc: { ...booking, encounterId: draft.id }, expectedRevision: input.expectedBookingRevision, expectedOrgId: input.orgId },
    ] });
    const saved = result.upserts[0] as EncounterDoc;
    const savedBooking = result.upserts[1] as BookingDoc;
    audit({ orgId: input.orgId, actor: input.actorId, action: 'encounter.created', target: saved.id, detail: `${saved.patientId}; booking ${saved.bookingId}` });
    return { ok: true, value: saved, booking: savedBooking, created: true };
  } catch (error) {
    if (error instanceof CommitConflictError) {
      const raced = encounterForBooking(input.orgId, booking.id);
      if (raced) return { ok: true, value: raced, booking: bookingById(input.orgId, booking.id), created: false };
      return { ok: false, code: 'CONFLICT', error: 'The booking changed while opening its encounter. Reload before retrying.' };
    }
    throw error;
  }
}

export function setEncounterStatus(input: {
  orgId: string;
  id: string;
  expectedRevision: number;
  status: 'finished' | 'cancelled';
  actorId: string;
}): EncounterWrite<EncounterDoc> {
  const existing = encounterById(input.orgId, input.id);
  if (!existing) return { ok: false, code: 'NOT_FOUND', error: 'That encounter does not exist.' };
  if (existing.status !== 'open') return { ok: false, code: 'CONFLICT', error: 'A finished or cancelled encounter is read-only.' };
  if (!['finished', 'cancelled'].includes(input.status)) return { ok: false, code: 'VALIDATION_ERROR', error: 'Encounter status must be finished or cancelled.' };
  try {
    const saved = commitBatch({ upserts: [{
      collection: 'encounters',
      doc: { ...existing, status: input.status, endedAt: nowIso(), updatedBy: input.actorId },
      expectedRevision: input.expectedRevision,
      expectedOrgId: input.orgId,
    }] }).upserts[0] as EncounterDoc;
    audit({ orgId: input.orgId, actor: input.actorId, action: `encounter.${input.status}`, target: saved.id, detail: saved.bookingId });
    return { ok: true, value: saved };
  } catch (error) {
    if (error instanceof CommitConflictError) return { ok: false, code: 'CONFLICT', error: 'That encounter changed. Reload before saving.' };
    throw error;
  }
}
