import { commitBatch, get, closeStore, type Doc } from '../lib/server/db';
import { addPatientContactPoint, mergePatients } from '../lib/server/patient-identity';
import { completeDocumentUpload } from '../lib/server/clinical-documents';
import { upsertBooking } from '../lib/server/bookings';
import { claimDueDomainJobs } from '../lib/server/domain-jobs';
import { createLegalHold, createRetentionReviewManifest } from '../lib/server/privacy-governance';

async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (action === 'contact') {
    const [orgId, patientId, value] = args;
    try {
      const point = addPatientContactPoint({ orgId, patientId, kind: 'email', value, source: 'integration' });
      console.log(JSON.stringify({ ok: true, patientId: point.patientId, id: point.id }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }
  if (action === 'increment') {
    const [orgId, id, rawCount] = args;
    const count = Number(rawCount);
    let conflicts = 0;
    for (let index = 0; index < count; index += 1) {
      for (;;) {
        const row = get<Doc>('raceCounters', id);
        if (!row || row.orgId !== orgId) throw new Error('counter not found');
        try {
          commitBatch({ upserts: [{
            collection: 'raceCounters', doc: { ...row, value: Number(row.value ?? 0) + 1 },
            expectedRevision: Number(row.revision ?? 0), expectedOrgId: orgId,
          }] });
          break;
        } catch (error) {
          if (!(error instanceof Error) || error.name !== 'CommitConflictError') throw error;
          conflicts += 1;
        }
      }
    }
    console.log(JSON.stringify({ ok: true, conflicts }));
    return;
  }
  if (action === 'upload') {
    const [token, marker] = args;
    const result = await completeDocumentUpload({
      token,
      bytes: Buffer.from(`same synthetic race payload ${marker}`),
      mimeType: 'text/plain',
      originalName: 'race.txt',
      actor: `worker-${marker}`,
    });
    console.log(JSON.stringify({ ok: true, documentId: result.document.id, versionId: result.version.id, version: result.version.version }));
    return;
  }
  if (action === 'booking') {
    const [orgId, clientId, marker] = args;
    const result = upsertBooking({
      orgId, externalId: `merge-race-${marker}`, clientId,
      customer: { name: 'Synthetic merge race', number: '+440000000001' },
      service: 'Synthetic test', startsAt: '2027-01-01T10:00:00.000Z', source: 'client_api',
    });
    console.log(JSON.stringify({ ok: true, bookingId: result.booking.id, clientId: result.booking.clientId }));
    return;
  }
  if (action === 'merge') {
    const [orgId, conflictId, survivorPatientId, sourcePatientId] = args;
    const result = mergePatients({
      orgId, conflictId, survivorPatientId, sourcePatientId, actor: 'race-worker',
      note: 'Synthetic merge versus booking race approval',
    });
    console.log(JSON.stringify({ ok: true, eventId: result.event.id, survivorPatientId: result.event.survivorPatientId }));
    return;
  }
  if (action === 'role-update') {
    const [orgId, roleId, marker, rawDelay] = args;
    const role = get<Doc>('roles', roleId);
    const delay = Number(rawDelay ?? 0);
    if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    if (!role || role.orgId !== orgId) throw new Error('role not found');
    try {
      const saved = commitBatch({ upserts: [{
        collection: 'roles', doc: { ...role, description: `race-${marker}` },
        expectedRevision: Number(role.revision ?? 0), expectedOrgId: orgId,
      }] }).upserts[0];
      console.log(JSON.stringify({ ok: true, revision: saved.revision, marker }));
    } catch (error) {
      if (error instanceof Error && error.name === 'CommitConflictError') console.log(JSON.stringify({ ok: false, conflict: true, marker }));
      else throw error;
    }
    return;
  }
  if (action === 'claim-job') {
    const [orgId, workerId] = args;
    const claimed = claimDueDomainJobs(orgId, workerId, 10);
    console.log(JSON.stringify({ ok: true, workerId, ids: claimed.map((job) => job.id) }));
    return;
  }
  if (action === 'hold') {
    const [orgId, patientId] = args;
    const hold = createLegalHold({ orgId, scopeType: 'patient', scopeId: patientId, reason: 'Synthetic concurrent retention hold', actor: 'race-worker' });
    console.log(JSON.stringify({ ok: true, holdId: hold.id }));
    return;
  }
  if (action === 'retention-preview') {
    const [orgId] = args;
    const preview = createRetentionReviewManifest({ orgId, actor: 'race-worker', asOf: '2027-01-01T00:00:00.000Z' });
    console.log(JSON.stringify({ ok: true, previewId: preview.id, candidates: preview.candidates }));
    return;
  }
  throw new Error(`unknown action ${action}`);
}

void main().then(() => closeStore()).catch((error) => {
  console.error(error);
  try { closeStore(); } catch { /* ignore */ }
  process.exit(1);
});
