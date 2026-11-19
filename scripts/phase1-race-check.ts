import { spawn } from 'node:child_process';
import { closeStore, get, insert, list, remove, update, type Doc } from '../lib/server/db';
import { contactPointsFor, identityConflictsFor } from '../lib/server/patient-identity';
import { createDocumentUploadToken, documentLinksFor, documentVersionsFor } from '../lib/server/clinical-documents';
import { enqueueDomainJob } from '../lib/server/domain-jobs';
import { saveRetentionPolicy } from '../lib/server/privacy-governance';

let checks = 0;
function check(label: string, condition: unknown, detail?: unknown) {
  checks += 1;
  if (!condition) throw new Error(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  console.log(`PASS ${label}`);
}
function throws(label: string, work: () => unknown, includes?: string) {
  let message = '';
  try { work(); } catch (error) { message = error instanceof Error ? error.message : String(error); }
  check(label, Boolean(message) && (!includes || message.includes(includes)), message);
}

function worker(args: string[]) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/.bin/tsx', 'scripts/phase1-race-worker.ts', ...args], {
      cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) return reject(new Error(`worker ${args.join(' ')} exited ${code}: ${stderr || stdout}`));
      const line = stdout.trim().split('\n').at(-1) ?? '{}';
      try { resolve(JSON.parse(line) as Record<string, unknown>); }
      catch { reject(new Error(`worker returned invalid JSON: ${stdout}`)); }
    });
  });
}

async function main() {
  const orgId = 'org_race';
  insert('orgs', { id: orgId, name: 'Race test', createdAt: new Date().toISOString() });
  insert('clients', { id: 'race_patient_a', orgId, name: 'Race A', number: '+441000000001', consents: {}, createdAt: new Date().toISOString() });
  insert('clients', { id: 'race_patient_b', orgId, name: 'Race B', number: '+441000000002', consents: {}, createdAt: new Date().toISOString() });
  insert('raceCounters', { id: 'counter', orgId, value: 0 });

  const contactResults = await Promise.all([
    worker(['contact', orgId, 'race_patient_a', 'shared-race@example.test']),
    worker(['contact', orgId, 'race_patient_b', 'shared-race@example.test']),
  ]);
  const active = list<Doc & { orgId?: string; patientId?: string; kind?: string; normalizedValue?: string; endedAt?: string }>(
    'patientContactPoints',
    (row) => row.orgId === orgId && row.kind === 'email' && row.normalizedValue === 'shared-race@example.test' && !row.endedAt,
  );
  check('cross-process exact-contact race links only one patient', active.length === 1, { contactResults, active });
  check('losing cross-process contact receives review conflict', contactResults.filter((row) => row.ok === false).length === 1 && String(contactResults.find((row) => row.ok === false)?.message).includes('another patient'), contactResults);

  const counterResults = await Promise.all(Array.from({ length: 6 }, () => worker(['increment', orgId, 'counter', '40'])));
  check('all atomic increment workers completed', counterResults.every((row) => row.ok === true), counterResults);
  check('revision retries lose no cross-process increments', Number(get<Doc>('raceCounters', 'counter')?.value) === 240, get('raceCounters', 'counter'));

  insert('roles', {
    id: 'race_role', orgId, key: 'custom:race', name: 'Race role', permissions: ['workspace.read'],
    scopes: { clients: 'none' }, system: false, legacyBaseRole: 'viewer', createdAt: new Date().toISOString(),
  });
  const roleResults = await Promise.all([
    worker(['role-update', orgId, 'race_role', 'A', '250']),
    worker(['role-update', orgId, 'race_role', 'B', '250']),
  ]);
  check('simultaneous role edits allow one revision winner and reject one stale writer', roleResults.filter((row) => row.ok === true).length === 1 && roleResults.filter((row) => row.conflict === true).length === 1, roleResults);

  for (let index = 0; index < 12; index += 1) enqueueDomainJob({ orgId, type: 'race.claim-only', payload: { index }, id: `race_job_${index}` });
  const claims = await Promise.all([
    worker(['claim-job', orgId, 'worker-A']),
    worker(['claim-job', orgId, 'worker-B']),
  ]);
  const claimedIds = claims.flatMap((row) => Array.isArray(row.ids) ? row.ids.map(String) : []);
  check('two job workers never own the same durable attempt', claimedIds.length === 12 && new Set(claimedIds).size === 12, claims);

  const capability = createDocumentUploadToken({ orgId, ownerType: 'patient', ownerId: 'race_patient_b', title: 'Race upload', actor: 'test' });
  const uploads = await Promise.all([
    worker(['upload', capability.token, 'A']),
    worker(['upload', capability.token, 'B']),
    worker(['upload', capability.token, 'C']),
  ]);
  const documentId = String(uploads[0]?.documentId ?? '');
  const versions = documentVersionsFor(orgId, documentId);
  check('single-use upload capability is race-idempotent across processes', uploads.every((row) => row.versionId === uploads[0]?.versionId) && versions.length === 1, { uploads, versions });
  check('racing payload cannot replace the winning immutable bytes', new Set(uploads.map((row) => row.versionId)).size === 1 && versions[0]?.version === 1);

  const conflict = identityConflictsFor(orgId, 'open').find((row) => row.candidatePatientIds.includes('race_patient_a') && row.candidatePatientIds.includes('race_patient_b'));
  if (!conflict) throw new Error('exact-contact race did not leave its review conflict');
  const mergeBooking = await Promise.all([
    worker(['merge', orgId, conflict.id, 'race_patient_a', 'race_patient_b']),
    worker(['booking', orgId, 'race_patient_b', 'concurrent']),
  ]);
  const bookingId = String(mergeBooking.find((row) => row.bookingId)?.bookingId ?? '');
  check('merge versus booking creation leaves the appointment on the canonical survivor', mergeBooking.every((row) => row.ok === true) && get<Doc>('bookings', bookingId)?.clientId === 'race_patient_a', { mergeBooking, booking: get('bookings', bookingId) });
  const mergeEvidence = list<Doc>('clientMergeEvents', (row) => row.sourcePatientId === 'race_patient_b');
  check('manual merge leaves an archived redirect and immutable merge evidence', get<Doc>('clients', 'race_patient_b')?.mergedIntoClientId === 'race_patient_a' && mergeEvidence.length === 1);
  const mergedDocument = get<Doc>('clinicalDocuments', documentId);
  check('patient merge rehomes document ownership and typed links together', mergedDocument?.patientId === 'race_patient_a' && mergedDocument?.ownerId === 'race_patient_a' && documentLinksFor(orgId, documentId).every((link) => link.patientId === 'race_patient_a' && (link.resourceType !== 'patient' || link.resourceId === 'race_patient_a')));
  throws('application rejects merge-evidence mutation', () => update('clientMergeEvents', mergeEvidence[0]!.id, { actor: 'changed' }), 'append-only');
  throws('application rejects merge-evidence deletion', () => remove('clientMergeEvents', mergeEvidence[0]!.id), 'append-only');

  insert('clients', { id: 'race_retention_patient', orgId, name: 'Retention race', number: '+441000000009', archivedAt: '2020-01-01T00:00:00.000Z', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' });
  saveRetentionPolicy({
    orgId, name: 'Race retention review', recordClass: 'patient_record', trigger: 'last_activity', durationDays: 365,
    disposition: 'review', rationale: 'Synthetic race test', status: 'active', actor: 'race-test',
    activationConfirmation: 'ACTIVATE CONTROLLER RETENTION POLICY',
  });
  const holdPreview = await Promise.all([
    worker(['hold', orgId, 'race_retention_patient']),
    worker(['retention-preview', orgId]),
  ]);
  check('legal-hold versus retention race can only create evidence, never delete the record', holdPreview.every((row) => row.ok === true) && Boolean(get('clients', 'race_retention_patient')) && list<Doc>('retentionReviewManifests', (row) => row.orgId === orgId).length === 1, holdPreview);

  // Make sure ordinary migrated contacts remain readable after all foreign writes.
  check('foreign-write cache invalidation preserves patient contacts', contactPointsFor(orgId, 'race_patient_a', { includeEnded: true }).length > 0);

  closeStore();
  console.log(`\nPhase 1 race safety: ${checks}/${checks} checks passed`);
}

void main().catch((error) => {
  console.error(error);
  try { closeStore(); } catch { /* ignore */ }
  process.exit(1);
});
