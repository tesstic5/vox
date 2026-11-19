/**
 * One-way data repairs.
 *
 * The client layer arrived after the booking layer, so a workspace that existed
 * before it has appointments with names and numbers and no client records.
 * These functions walk the old shape once and make it match the new one — and
 * every one of them is safe to run twice, because the second pass finds the
 * work already done.
 */

import { clientsFor, ensureClientForBooking, setConsent, updateClient, type ClientDoc } from './clients';
import { addPatientAlert, patientAlertsFor } from './patient-alerts';
import { bookingsFor } from './bookings';
import { update, type Doc } from './db';

/**
 * Give every appointment a client.
 *
 * Runs in date order, so the first appointment a person ever had is the one
 * that creates the record and the counters ("seen twice", "last contact") are
 * built up rather than guessed.
 */
export function backfillClientsFromBookings(orgId: string, opts?: { withDemoRecords?: boolean }): { created: number; linked: number } {
  const rows = bookingsFor(orgId).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  let created = 0;
  let linked = 0;

  for (const booking of rows) {
    const linkedId = (booking as { clientId?: string }).clientId;
    if (linkedId && clientsFor(orgId, { includeArchived: true }).some((c) => c.id === linkedId)) continue;

    const before = clientsFor(orgId, { includeArchived: true }).length;
    const client = ensureClientForBooking(orgId, booking.customer, 'sync', { source: 'import' });
    if (clientsFor(orgId, { includeArchived: true }).length > before) created += 1;

    updateClient(
      orgId,
      client.id,
      {
        appointmentCount: (client.appointmentCount ?? 0) + 1,
        lastAppointmentAt:
          !client.lastAppointmentAt || booking.startsAt > client.lastAppointmentAt ? booking.startsAt : client.lastAppointmentAt,
        lastInteractionAt: client.lastInteractionAt ?? booking.startsAt,
        source: client.source === 'staff' ? 'import' : client.source,
      } as Partial<ClientDoc>,
      'sync'
    );
    update<Doc>('bookings', booking.id, { clientId: client.id } as never);
    linked += 1;
  }

  if (opts?.withDemoRecords) seedDemoRecords(orgId);
  return { created, linked };
}

/**
 * The demo workspace carries three worked examples — two alerts and one
 * withdrawn consent — because a records feature nobody has seen working is a
 * feature nobody configures. Provenance is explicit: every one of these is
 * written with `seed` as the actor, in both the audit log and the record's own
 * access history.
 */
function seedDemoRecords(orgId: string) {
  const demo = clientsFor(orgId).slice(0, 3);
  if (demo[0] && patientAlertsFor(orgId, demo[0].id, { includeClinical: true, includeEnded: true }).length === 0) {
    addPatientAlert({ orgId, patientId: demo[0].id, classification: 'clinical', label: 'Anticoagulant therapy', detail: 'Avoid ibuprofen-based advice.', severity: 'critical', actor: 'seed' });
    addPatientAlert({ orgId, patientId: demo[0].id, classification: 'administrative', label: 'Arrives with a carer', severity: 'info', actor: 'seed' });
  }
  if (demo[1] && patientAlertsFor(orgId, demo[1].id, { includeClinical: true, includeEnded: true }).length === 0) {
    addPatientAlert({ orgId, patientId: demo[1].id, classification: 'administrative', label: 'Needs an interpreter (Spanish)', severity: 'warning', actor: 'seed' });
    setConsent(orgId, demo[1].id, 'sms', false, { source: 'caller', note: 'Asked us to ring, not text', actor: 'seed' });
  }
  if (demo[2] && patientAlertsFor(orgId, demo[2].id, { includeClinical: true, includeEnded: true }).length === 0) {
    addPatientAlert({ orgId, patientId: demo[2].id, classification: 'clinical', label: 'Severe nut allergy', severity: 'critical', actor: 'seed' });
  }
}
