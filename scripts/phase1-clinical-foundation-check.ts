import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  closeStore,
  commitBatch,
  dumpAll,
  get,
  insert,
  list,
  remove,
  replaceAll,
  storePath,
  update,
  type Doc,
} from '../lib/server/db';
import { SCHEMA_MIGRATIONS, schemaMigrationChecksum } from '../lib/server/schema-migrations';
import {
  createAccessGrant,
  createCaseloadAssignment,
  createCustomRole,
  permissionDecision,
  permissionShadowEvents,
  resolvePermissionShadowEvent,
  shadowPermissionDecision,
  type RoleDoc,
} from '../lib/server/permissions';
import type { UserDoc } from '../lib/server/auth';
import {
  addPatientContactPoint,
  identityConflictsFor,
  resolveExactIdentity,
} from '../lib/server/patient-identity';
import { addPatientAlert, patientAlertsFor } from '../lib/server/patient-alerts';
import { phoneAssistantPatientContext } from '../lib/server/phone-assistant-context';
import { appendClinicalAccessEvent, clinicalAccessEventsFor, clinicalAccessSummary } from '../lib/server/clinical-access';
import {
  archiveDocument,
  completeDocumentUpload,
  createDocumentLink,
  createDocumentUploadToken,
  documentLinksFor,
  documentsFor,
  documentVersionsFor,
  downloadDocumentVersion,
  latestScanEvent,
  resolveDocumentOwnerPatientId,
  runDocumentScanJob,
} from '../lib/server/clinical-documents';
import { blobStore } from '../lib/server/blob-store';
import { deadLettersFor, enqueueDomainJob, retryDeadLetter, runDueDomainJobs, type DomainJobDoc } from '../lib/server/domain-jobs';
import {
  createDeletionRequest,
  createLegalHold,
  createRetentionReviewManifest,
  privacyProfileFor,
  releaseLegalHold,
  saveCommunicationDataPolicy,
  savePrivacyProfile,
  saveRetentionPolicy,
  transitionDeletionRequest,
} from '../lib/server/privacy-governance';
import {
  evaluateClinicalReadiness,
  requireClinicalWriteMode,
  setClinicalOperatingMode,
} from '../lib/server/clinical-readiness';
import { dataMigrationStates, runPhase1DataMigrations } from '../lib/server/data-migrations';
import { SERVER_ONLY_COLLECTIONS, findPrivateData } from '../lib/privacy';
import { withDestructiveMaintenance } from '../lib/server/maintenance-replace';
import { clientSubjectAccessManifest } from '../lib/server/client-export';
import { featureFlagFor } from '../lib/server/feature-flags';

let checks = 0;
function check(label: string, condition: unknown, detail?: unknown) {
  checks += 1;
  if (!condition) throw new Error(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  console.log(`PASS ${label}`);
}

async function throws(label: string, work: () => unknown | Promise<unknown>, includes?: string) {
  let message = '';
  try { await work(); } catch (error) { message = error instanceof Error ? error.message : String(error); }
  check(label, Boolean(message) && (!includes || message.includes(includes)), message);
}

function user(input: Partial<UserDoc> & Pick<UserDoc, 'id' | 'orgId' | 'role'>): UserDoc {
  return {
    email: `${input.id}@example.test`, name: input.id, passwordHash: 'not-a-real-password',
    emailVerified: true, twoFactorEnabled: false, createdAt: new Date().toISOString(),
    ...input,
  } as UserDoc;
}

async function main() {
  check('focused check uses isolated SQLite', process.env.VOXERA_STORE === 'sqlite' && storePath().includes(String(process.env.VOXERA_DATA_DIR)));
  const orgId = 'org_phase1';
  insert('orgs', { id: orgId, name: 'Phase 1 test', createdAt: new Date().toISOString() });

  // Checksummed schema migrations are applied before any domain write.
  const raw = new Database(storePath());
  const applied = raw.prepare('SELECT id, checksum FROM schema_migrations ORDER BY id').all() as Array<{ id: string; checksum: string }>;
  check('every SQLite schema migration is recorded', applied.length === SCHEMA_MIGRATIONS.length, applied);
  check('stored schema checksums match code', applied.every((row, index) => row.id === SCHEMA_MIGRATIONS[index]?.id && row.checksum === schemaMigrationChecksum(SCHEMA_MIGRATIONS[index]!, 'sqlite')));

  // Atomic batches and revision preconditions.
  const a = insert<Doc>('atomicProbe', { id: 'a', orgId, value: 1 });
  const b = insert<Doc>('atomicProbe', { id: 'b', orgId, value: 1 });
  const committed = commitBatch({ upserts: [
    { collection: 'atomicProbe', doc: { ...a, value: 2 }, expectedRevision: Number(a.revision ?? 0), expectedOrgId: orgId },
    { collection: 'atomicProbe', doc: { ...b, value: 2 }, expectedRevision: Number(b.revision ?? 0), expectedOrgId: orgId },
  ] });
  check('multi-document commit changes both rows atomically', committed.upserts.length === 2 && get<Doc>('atomicProbe', 'a')?.value === 2 && get<Doc>('atomicProbe', 'b')?.value === 2);
  await throws('stale batch revision is rejected', () => commitBatch({ upserts: [
    { collection: 'atomicProbe', doc: { ...a, value: 99 }, expectedRevision: Number(a.revision ?? 0), expectedOrgId: orgId },
    { collection: 'atomicProbe', doc: { ...b, value: 99 }, expectedRevision: Number(b.revision ?? 0), expectedOrgId: orgId },
  ] }), 'revision');
  check('failed batch leaves every row unchanged', get<Doc>('atomicProbe', 'a')?.value === 2 && get<Doc>('atomicProbe', 'b')?.value === 2);

  // Granular roles, record scope and reviewable shadow comparison.
  const owner = user({ id: 'owner', orgId, role: 'owner' });
  const clinicianBase = user({ id: 'clinician', orgId, role: 'practitioner' });
  insert('users', owner);
  insert('users', clinicianBase);
  const role = createCustomRole({
    orgId, name: 'Caseload clinician', legacyBaseRole: 'practitioner', actor: owner,
    permissions: ['workspace.read', 'clients.read', 'clinical.read', 'clinical.alerts.read', 'clinical.documents.read'],
    scopes: { clients: 'caseload', clinical: 'caseload', documents: 'caseload' },
  });
  const clinician = { ...clinicianBase, roleId: role.id } as UserDoc;
  insert('clients', { id: 'patient_a', orgId, name: 'Alpha Patient', number: '+441111111111', email: 'alpha@example.test', alerts: [{ id: 'legacy-med', label: 'Restricted legacy clinical flag', severity: 'critical', createdAt: new Date().toISOString() }], consents: { sms: { granted: true }, email: { granted: true }, recording: { granted: false } }, createdAt: new Date().toISOString() });
  insert('clients', { id: 'patient_b', orgId, name: 'Beta Patient', number: '+442222222222', consents: { sms: { granted: false }, email: { granted: false }, recording: { granted: false } }, createdAt: new Date().toISOString() });
  insert('caseloadAssignments', { id: 'case_a', orgId, patientId: 'patient_a', userId: clinician.id, createdAt: new Date().toISOString() });
  check('caseload role permits assigned patient', permissionDecision(clinician, 'clinical.read', { area: 'clinical', patientId: 'patient_a' }).allowed);
  check('caseload role denies unassigned patient', !permissionDecision(clinician, 'clinical.read', { area: 'clinical', patientId: 'patient_b' }).allowed);
  shadowPermissionDecision(clinician, 'clinical.read', { area: 'clinical', patientId: 'patient_b' });
  shadowPermissionDecision(clinician, 'clinical.read', { area: 'clinical', patientId: 'patient_a' });
  const shadows = permissionShadowEvents(orgId, { unresolvedOnly: true });
  check('shadowing stores only the fixed/granular disagreement', shadows.length === 1 && shadows[0]?.permission === 'clinical.read', shadows);
  resolvePermissionShadowEvent({ orgId, eventId: shadows[0]!.id, actorId: owner.id, resolution: 'Caseload restriction is intentional and reviewed.' });
  check('reviewed shadow disagreement no longer blocks readiness', permissionShadowEvents(orgId, { unresolvedOnly: true }).length === 0);
  const emergency = createAccessGrant({
    orgId, userId: clinician.id, patientId: 'patient_b', reason: 'Synthetic urgent continuity-of-care review', minutes: 15,
    maxMinutes: 60, actorId: owner.id, approvedBy: owner.id, notifiedRecipients: ['security@example.test'],
  });
  const emergencyDecision = permissionDecision(clinician, 'clinical.read', { area: 'clinical', patientId: 'patient_b' });
  check('time-limited break-glass widens record scope without adding a permission', emergencyDecision.allowed && emergencyDecision.source === 'break-glass');
  check('break-glass creation atomically queues a security notification', list<Doc>('domainOutbox', (row) => row.orgId === orgId && row.aggregateId === emergency.id).length === 1);
  const assignment = createCaseloadAssignment({ orgId, patientId: 'patient_b', userId: owner.id, kind: 'administrative', actorId: owner.id });
  check('typed caseload assignment validates and stores same-workspace references', assignment.patientId === 'patient_b' && assignment.userId === owner.id && assignment.kind === 'administrative');

  // Exact identity only, explicit ambiguity, and no fuzzy merge.
  addPatientContactPoint({ orgId, patientId: 'patient_a', kind: 'email', value: 'alpha@example.test', primary: true, source: 'staff' });
  check('exact contact resolves one patient', resolveExactIdentity(orgId, 'email', ' ALPHA@example.test ').status === 'unique');
  check('near contact does not fuzzy-match', resolveExactIdentity(orgId, 'email', 'alphaa@example.test').status === 'none');
  await throws('duplicate exact contact requires review', () => addPatientContactPoint({ orgId, patientId: 'patient_b', kind: 'email', value: 'alpha@example.test', source: 'staff' }), 'another patient');
  check('identity conflict records candidates for human review', identityConflictsFor(orgId).some((row) => row.kind === 'email' && row.candidatePatientIds.length === 2));

  // Alert classification and minimum phone context.
  addPatientAlert({ orgId, patientId: 'patient_a', classification: 'administrative', label: 'Use side entrance', detail: 'Administrative detail must not be spoken by the assistant', actor: owner.id });
  const deskAlerts = patientAlertsFor(orgId, 'patient_a', { includeClinical: false });
  const clinicalAlerts = patientAlertsFor(orgId, 'patient_a', { includeClinical: true });
  check('desk alert view excludes migrated clinical alert', deskAlerts.length === 1 && deskAlerts.every((row) => row.classification === 'administrative'));
  check('clinical alert view includes restricted legacy alert', clinicalAlerts.some((row) => row.classification === 'clinical' && row.label.includes('Restricted')));
  const phoneContext = phoneAssistantPatientContext(orgId, '+441111111111');
  const contextText = JSON.stringify(phoneContext);
  check('phone context is exact but never claims identity confirmation', phoneContext.match === 'exact_unique' && phoneContext.identityConfirmed === false);
  check('phone context emits only a boolean handoff, never alert/note/health text', !/Restricted|side entrance|alert|note|dateOfBirth|address/i.test(contextText), phoneContext);
  const shared = addPatientContactPoint({ orgId, patientId: 'patient_b', kind: 'phone', value: '+441111111111', allowShared: true, sharedReason: 'Shared household phone', source: 'staff' });
  check('shared contact must be explicit and reasoned', shared.shared === true && shared.sharedReason === 'Shared household phone');
  const ambiguousContext = phoneAssistantPatientContext(orgId, '+441111111111');
  check('ambiguous phone exposes no candidate identity or cross-patient context', ambiguousContext.match === 'review_required' && !('patient' in ambiguousContext));

  // Append-only clinical access at application and database layers.
  const access = appendClinicalAccessEvent({ orgId, resourceType: 'patient', resourceId: 'patient_a', patientId: 'patient_a', action: 'view', actorId: owner.id });
  appendClinicalAccessEvent({ orgId, resourceType: 'patient', resourceId: 'patient_a', patientId: 'patient_a', action: 'view', actorId: owner.id });
  check('clinical access does not deduplicate repeated reads', clinicalAccessEventsFor({ orgId, resourceId: 'patient_a' }).filter((row) => row.action === 'view').length >= 2);
  await throws('application rejects clinical access update', () => update('clinicalAccessEvents', access.id, { action: 'delete' }));
  await throws('application rejects clinical access delete', () => remove('clinicalAccessEvents', access.id));
  await throws('SQLite trigger rejects out-of-band clinical access update', () => raw.prepare("UPDATE docs SET body = json_set(body, '$.action', 'delete') WHERE collection = 'clinicalAccessEvents' AND id = ?").run(access.id), 'append-only');
  await throws('SQLite trigger rejects out-of-band clinical access delete', () => raw.prepare("DELETE FROM docs WHERE collection = 'clinicalAccessEvents' AND id = ?").run(access.id), 'append-only');
  const bulkAt = new Date().toISOString();
  const bulkAccess = Array.from({ length: 2_005 }, (_, index) => ({
    collection: 'clinicalAccessEvents',
    doc: {
      id: `cae_bulk_${String(index).padStart(4, '0')}`, orgId, resourceType: 'patient', resourceId: 'patient_a', patientId: 'patient_a',
      action: 'view', actorId: 'bulk-audit-check', actorType: 'system', purpose: 'security', occurredAt: bulkAt, createdAt: bulkAt,
    } as Doc,
    expectedRevision: null,
    expectedOrgId: orgId,
  }));
  for (let start = 0; start < bulkAccess.length; start += 500) {
    commitBatch({ upserts: bulkAccess.slice(start, start + 500) });
  }
  check('clinical access summary is uncapped beyond one API page', clinicalAccessSummary(orgId).events >= 2_007, clinicalAccessSummary(orgId).events);

  // Checksummed data migrations resume and do not rerun completed work.
  insert('files', { id: 'legacy_file', orgId, clientId: 'patient_a', name: 'Legacy referral.pdf', bytes: 1234, createdAt: new Date().toISOString() });
  insert('calls', { id: 'legacy_call', orgId, transcript: [{ role: 'user', text: 'synthetic restricted content' }], createdAt: new Date().toISOString() });
  const migrationRun = runPhase1DataMigrations(orgId);
  check('all Phase 1 data migrations complete', migrationRun.completed === migrationRun.total && migrationRun.total >= 6, migrationRun);
  const adminTemplate = list<RoleDoc>('roles', (row) => row.orgId === orgId && row.key === 'system:admin')[0];
  check('system-role migrations carry explicit clinical export and patient-merge permissions', adminTemplate?.permissions.includes('clinical.export') && adminTemplate.permissions.includes('clients.merge'), adminTemplate?.permissions);
  const migratedPatient = get<Doc & { alerts?: unknown[]; legacyAlertsMigration?: { migratedCount?: number } }>('clients', 'patient_a');
  check('legacy clinical-alert bodies are removed from the embedded client field after verified copy', migratedPatient?.alerts?.length === 0 && migratedPatient.legacyAlertsMigration?.migratedCount === 1, migratedPatient?.legacyAlertsMigration);
  check('clearing legacy source text preserves the restricted destination alert', patientAlertsFor(orgId, 'patient_a', { includeClinical: true }).some((row) => row.source === 'legacy' && row.label.includes('Restricted')));
  const legacyDocument = documentsFor(orgId, { includeArchived: true }).find((row) => row.legacySource?.id === 'legacy_file');
  check('legacy file migration remains metadata-only and invents no byte version', legacyDocument?.status === 'metadata_only' && legacyDocument.versionCount === 0 && !legacyDocument.currentVersionId && documentVersionsFor(orgId, legacyDocument.id).length === 0, legacyDocument);
  check('mutable-record migration backfills schema version through revisioned writes', Number(get<Doc>('clients', 'patient_a')?.schemaVersion) === 1 && Number(get<Doc>('clients', 'patient_a')?.revision) >= 1);
  check('legacy call content is classified restricted without deleting it', get<Doc>('calls', 'legacy_call')?.contentClassification === 'restricted' && Array.isArray(get<Doc>('calls', 'legacy_call')?.transcript));
  check('technical audit cutover is recorded without inventing controller details', Boolean(privacyProfileFor(orgId).auditCompleteFromAt) && privacyProfileFor(orgId).controllerName === '');
  check('Phase 1 rollout flags begin in observe/off states', featureFlagFor(orgId, 'permissions_v2')?.state === 'observe' && featureFlagFor(orgId, 'documents_v1')?.state === 'off');
  const attempts = dataMigrationStates(orgId).map((row) => row.attempts);
  runPhase1DataMigrations(orgId);
  check('completed data migrations are resumable/idempotent', dataMigrationStates(orgId).every((row, index) => row.status === 'completed' && row.attempts === attempts[index]));
  const intactMigration = dataMigrationStates(orgId)[0]!;
  update('dataMigrations', intactMigration.id, { checksum: 'tampered-checksum' });
  await throws('data migration checksum drift fails closed', () => runPhase1DataMigrations(orgId), 'checksum mismatch');
  update('dataMigrations', intactMigration.id, { checksum: intactMigration.checksum });

  const controller = savePrivacyProfile({
    orgId, existing: privacyProfileFor(orgId), expectedRevision: Number(privacyProfileFor(orgId).revision ?? 0),
    controllerName: 'Synthetic Allied Health Ltd', controllerAddress: '1 Test Street, London',
    controllerContactEmail: 'privacy@example.test', privacyNoticeVersion: 'synthetic-v1',
    privacyNoticeUrl: 'https://example.test/privacy', dpiaReference: 'DPIA-SYNTHETIC-1',
    dpiaStatus: 'approved_by_controller', dpiaReviewedAt: '2026-09-20', dpiaReviewedBy: 'Synthetic Controller',
    auditCompleteFromAt: privacyProfileFor(orgId).auditCompleteFromAt,
    breakGlassEnabled: true, breakGlassMaxMinutes: 60, breakGlassNotify: ['security@example.test'], actor: owner.id,
  });
  check('controller profile preserves notice, DPIA and break-glass decisions as revisioned evidence', controller.controllerName.includes('Synthetic') && controller.dpiaStatus === 'approved_by_controller' && controller.breakGlassEnabled);
  const communicationPolicy = saveCommunicationDataPolicy({
    orgId, channel: 'phone', recordingPurpose: 'Synthetic quality review', transcriptPurpose: 'Synthetic appointment administration',
    noticeVersion: 'synthetic-call-notice-v1', contentRetentionDays: 30, metadataRetentionDays: 365,
    allowedRoles: ['owner', 'practitioner'], assistantExposure: 'minimum_context', status: 'active', actor: owner.id,
  });
  check('controller communication policy locks assistant exposure to minimum context', communicationPolicy.assistantExposure === 'minimum_context' && communicationPolicy.status === 'active');

  // Fail-closed operating mode.
  await throws('disabled clinical mode rejects a write', () => requireClinicalWriteMode(orgId, true), 'disabled');
  setClinicalOperatingMode({ orgId, mode: 'synthetic_test', actor: owner });
  await throws('synthetic mode requires per-request acknowledgement', () => requireClinicalWriteMode(orgId, false), 'acknowledgement');
  check('synthetic acknowledgement permits test write path', Boolean(requireClinicalWriteMode(orgId, true)));
  const readiness = evaluateClinicalReadiness(orgId);
  check('live mode remains blocked without production, a real scanner and independent evidence', !readiness.readyForLive && readiness.failedRequired.includes('postgres') && readiness.failedRequired.includes('malware-scanner') && readiness.failedRequired.includes('review-security'), readiness.failedRequired);
  await throws('live activation fails closed despite exact confirmation', () => setClinicalOperatingMode({ orgId, mode: 'live', actor: owner, confirmation: 'ENABLE LIVE UK CLINICAL DATA' }), 'blocked');

  // Encrypted immutable versions, token replay/race safety and quarantine.
  insert('bookings', { id: 'booking_patient_a', orgId, clientId: 'patient_a', createdAt: new Date().toISOString() });
  insert('invoices', { id: 'invoice_patient_a', orgId, clientId: 'patient_a', createdAt: new Date().toISOString() });
  check('document owner resolution derives the patient instead of trusting input', resolveDocumentOwnerPatientId(orgId, 'appointment', 'booking_patient_a') === 'patient_a');
  check('invoice document ownership derives its canonical patient', resolveDocumentOwnerPatientId(orgId, 'invoice', 'invoice_patient_a') === 'patient_a');
  await throws('document owner resolution rejects a forged patient link', () => resolveDocumentOwnerPatientId(orgId, 'appointment', 'booking_patient_a', 'patient_b'), 'does not match');
  await throws('HTML and SVG MIME types cannot receive an upload capability', () => createDocumentUploadToken({
    orgId, ownerType: 'patient', ownerId: 'patient_a', title: 'Unsafe inline type', allowedMimeTypes: ['text/html', 'image/svg+xml'], actor: owner.id,
  }), 'supported MIME');
  const tinyCapability = createDocumentUploadToken({ orgId, ownerType: 'patient', ownerId: 'patient_a', title: 'Bounded synthetic upload', maxBytes: 8, actor: owner.id });
  await throws('actual upload bytes enforce the token size even without a trusted header', () => completeDocumentUpload({
    token: tinyCapability.token, bytes: Buffer.from('more than eight bytes'), mimeType: 'text/plain', originalName: 'oversized.txt', actor: owner.id,
  }), '1 to 8 bytes');
  const capability = createDocumentUploadToken({ orgId, ownerType: 'patient', ownerId: 'patient_a', title: 'Synthetic referral', category: 'referral', actor: owner.id });
  const plaintext = Buffer.from('synthetic clinical document payload — not a real patient');
  const [firstUpload, replayUpload] = await Promise.all([
    completeDocumentUpload({ token: capability.token, bytes: Buffer.from(plaintext), mimeType: 'text/plain', originalName: '../../referral.txt', actor: owner.id }),
    completeDocumentUpload({ token: capability.token, bytes: Buffer.from(plaintext), mimeType: 'text/plain', originalName: '../../referral.txt', actor: owner.id }),
  ]);
  check('concurrent token replay resolves to one immutable version', firstUpload.version.id === replayUpload.version.id && documentVersionsFor(orgId, firstUpload.document.id).length === 1);
  check('new document atomically creates its typed canonical owner link', documentLinksFor(orgId, firstUpload.document.id).some((link) => link.relationship === 'owner' && link.resourceType === 'patient' && link.resourceId === 'patient_a'));
  const linkedDocument = createDocumentLink({
    orgId, documentId: firstUpload.document.id, resourceType: 'patient', resourceId: 'patient_a',
    relationship: 'evidence', actor: owner.id, expectedDocumentRevision: firstUpload.document.revision,
  });
  check('document can hold multiple typed links with revisioned link count', linkedDocument.document.linkCount === 2 && documentLinksFor(orgId, firstUpload.document.id).length === 2);
  await throws('document link cannot point at another patient', () => createDocumentLink({
    orgId, documentId: firstUpload.document.id, resourceType: 'patient', resourceId: 'patient_b',
    relationship: 'related', actor: owner.id, expectedDocumentRevision: linkedDocument.document.revision,
  }), 'different patient');
  await throws('Phase 1 link cannot enable portal visibility', () => createDocumentLink({
    orgId, documentId: firstUpload.document.id, resourceType: 'patient', resourceId: 'patient_a',
    relationship: 'related', visibleInPortal: true, actor: owner.id, expectedDocumentRevision: linkedDocument.document.revision,
  }), 'portal visibility');
  check('filename is stripped to a safe base name', firstUpload.version.originalName === 'referral.txt');
  const ciphertext = await blobStore().get(firstUpload.version.objectKey);
  check('blob contains ciphertext rather than plaintext', !ciphertext.includes(plaintext) && firstUpload.version.ciphertextSha256 !== firstUpload.version.plaintextSha256);
  await throws('unscanned document remains quarantined', () => downloadDocumentVersion(orgId, firstUpload.document.id), 'quarantined');
  const scanJob = {
    id: 'job_scan_clean', orgId, type: 'clinical-document.scan', payload: { documentId: firstUpload.document.id, versionId: firstUpload.version.id },
    status: 'running', runAt: new Date().toISOString(), attempts: 1, maxAttempts: 3, revision: 0, createdAt: new Date().toISOString(),
  } as DomainJobDoc;
  await runDocumentScanJob(scanJob);
  check('configured scanner marks version clean', latestScanEvent(orgId, firstUpload.version.id)?.status === 'clean');
  const download = await downloadDocumentVersion(orgId, firstUpload.document.id);
  check('clean controlled download decrypts exact bytes', download.bytes.equals(plaintext));
  const subjectAccess = clientSubjectAccessManifest({ orgId, patientId: 'patient_a', includeClinical: true, includeDocuments: true, includeAccessHistory: true });
  const subjectText = JSON.stringify(subjectAccess);
  check('patient-scoped export includes the uncapped access stream and controlled document manifest', subjectAccess.clinicalAccessEvents.length >= 2_007 && subjectAccess.clinicalDocuments?.documents.some((row) => row.id === firstUpload.document.id));
  check('patient-scoped export excludes encrypted-object and upload-capability internals', !/objectKey|wrappedKey|dataAuthTag|ciphertextSha256|tokenHash/.test(subjectText));
  await throws('application rejects document-version mutation', () => update('clinicalDocumentVersions', firstUpload.version.id, { originalName: 'changed.txt' }));
  await throws('SQLite trigger rejects out-of-band version mutation', () => raw.prepare("UPDATE docs SET body = json_set(body, '$.originalName', 'changed.txt') WHERE collection = 'clinicalDocumentVersions' AND id = ?").run(firstUpload.version.id), 'append-only');

  process.env.VOXERA_MALWARE_SCAN_COMMAND = '/bin/false';
  process.env.VOXERA_MALWARE_SCAN_ARGS_JSON = '["{file}"]';
  const infectedToken = createDocumentUploadToken({ orgId, ownerType: 'patient', ownerId: 'patient_b', title: 'Synthetic infected fixture', actor: owner.id });
  const infected = await completeDocumentUpload({ token: infectedToken.token, bytes: Buffer.from('synthetic EICAR-like fixture'), mimeType: 'text/plain', originalName: 'fixture.txt', actor: owner.id });
  await runDocumentScanJob({ ...scanJob, id: 'job_scan_infected', payload: { documentId: infected.document.id, versionId: infected.version.id }, attempts: 1 });
  check('scanner exit 1 records infected evidence', latestScanEvent(orgId, infected.version.id)?.status === 'infected');
  await throws('infected version never downloads', () => downloadDocumentVersion(orgId, infected.document.id), 'quarantined');
  process.env.VOXERA_MALWARE_SCAN_COMMAND = '/bin/true';

  // Legal hold wins over preview/archive/deletion progression.
  const oldAt = '2020-01-01T00:00:00.000Z';
  insert('clients', { id: 'patient_retention', orgId, name: 'Synthetic retention candidate', number: '+449999999999', consents: {}, archivedAt: oldAt, createdAt: oldAt, updatedAt: oldAt });
  const retentionPolicy = saveRetentionPolicy({
    orgId, name: 'Synthetic patient review', recordClass: 'patient_record', trigger: 'last_activity', durationDays: 365,
    disposition: 'review', rationale: 'Synthetic test policy only', status: 'active', actor: owner.id,
    activationConfirmation: 'ACTIVATE CONTROLLER RETENTION POLICY',
  });
  const retentionHold = createLegalHold({ orgId, scopeType: 'patient', scopeId: 'patient_retention', reason: 'Synthetic retention race hold', actor: owner.id });
  const retentionPreview = createRetentionReviewManifest({ orgId, actor: owner.id, asOf: '2026-09-20T00:00:00.000Z' });
  const heldCandidate = retentionPreview.candidates.find((row) => row.resourceId === 'patient_retention');
  check('retention jobs produce review-only manifests and mark legal holds', retentionPolicy.status === 'active' && heldCandidate?.held === true && heldCandidate.holdIds.includes(retentionHold.id) && /No record was deleted/.test(retentionPreview.statement));
  const missingHandler = enqueueDomainJob({ orgId, type: 'synthetic.missing-handler', payload: {}, maxAttempts: 1 });
  const jobResult = await runDueDomainJobs(orgId, { workerId: 'focused-worker', limit: 10 });
  const openDeadLetter = deadLettersFor(orgId).find((row) => row.sourceId === missingHandler.id);
  check('exhausted domain jobs create a redacted dead letter atomically', jobResult.failed >= 1 && Boolean(openDeadLetter) && openDeadLetter?.status === 'open');
  if (!openDeadLetter) throw new Error('missing synthetic dead letter');
  const retried = retryDeadLetter({
    orgId, id: openDeadLetter.id, expectedRevision: openDeadLetter.revision,
    actor: owner.id, reason: 'Synthetic operator corrected dependency',
  });
  check('operator retry atomically resolves evidence and re-queues the source job', retried.deadLetter.status === 'resolved' && retried.job.status === 'queued' && retried.job.attempts === 0);
  await throws('stale dead-letter retry is revision-rejected', () => retryDeadLetter({
    orgId, id: openDeadLetter.id, expectedRevision: openDeadLetter.revision,
    actor: owner.id, reason: 'Synthetic stale retry must not win',
  }), 'already resolved');
  const hold = createLegalHold({ orgId, scopeType: 'patient', scopeId: 'patient_a', reason: 'Synthetic litigation hold', actor: owner.id });
  await throws('active patient hold blocks document archive', () => archiveDocument({ orgId, id: firstUpload.document.id, actor: owner.id }), 'legal hold');
  const deletion = createDeletionRequest({ orgId, patientId: 'patient_a', requesterType: 'patient', requesterReference: 'synthetic request', scope: 'patient record', actor: owner.id });
  const review = transitionDeletionRequest({ orgId, id: deletion.id, to: 'review', actor: owner.id });
  const blocked = transitionDeletionRequest({ orgId, id: review.id, to: 'approved', actor: owner.id });
  check('hold forces deletion request to blocked rather than approved', blocked.status === 'blocked' && blocked.blockedByHoldIds?.includes(hold.id));
  releaseLegalHold({ orgId, id: hold.id, actor: owner.id, reason: 'Synthetic test release' });
  const reviewedAgain = transitionDeletionRequest({ orgId, id: blocked.id, to: 'review', actor: owner.id });
  const approved = transitionDeletionRequest({ orgId, id: reviewedAgain.id, to: 'approved', actor: owner.id });
  check('released hold permits reviewed approval progression', approved.status === 'approved');

  // Generic/browser boundaries are explicit and include the real collection names.
  const requiredPrivate = ['clinicalAccessEvents', 'patientContactPoints', 'patientAlerts', 'clinicalDocuments', 'documentLinks', 'clinicalDocumentVersions', 'documentScanEvents', 'clientMergeEvents', 'privacyProfiles', 'processorRecords', 'communicationDataPolicies', 'accessGrants', 'domainJobs', 'deadLetters', 'calls', 'recoveryEvidence'];
  check('browser persistence deny-list covers Phase 1 collections', requiredPrivate.every((name) => (SERVER_ONLY_COLLECTIONS as readonly string[]).includes(name)));
  check('recursive browser guard catches nested clinical content', findPrivateData({ recent: { clinicalDocuments: [{ id: 'x' }] } }).length > 0);
  const collectionRoute = fs.readFileSync(path.join(process.cwd(), 'app/api/v1/collections/[name]/route.ts'), 'utf8');
  const bootstrapRoute = fs.readFileSync(path.join(process.cwd(), 'app/api/bootstrap/route.ts'), 'utf8');
  const searchRoute = fs.readFileSync(path.join(process.cwd(), 'app/api/search/route.ts'), 'utf8');
  const workspaceExport = fs.readFileSync(path.join(process.cwd(), 'lib/server/workspace-export.ts'), 'utf8');
  const callsRuntime = fs.readFileSync(path.join(process.cwd(), 'lib/server/calls.ts'), 'utf8');
  const adminRuntime = fs.readFileSync(path.join(process.cwd(), 'lib/server/admin.ts'), 'utf8');
  check('generic collection bridge is notifications-only', /MIRROR_WRITABLE = new Set\(\['notifications'\]\)/.test(collectionRoute));
  check('bootstrap does not return generic database statistics', !bootstrapRoute.includes('dbStats') && !bootstrapRoute.includes('collections:'));
  check('generic search is build-time documentation/page index only', searchRoute.includes('buildSearchIndex') && !/clients|notes|clinicalDocuments/.test(searchRoute));
  check('generic workspace export excludes raw encrypted-document internals', ['clinicalDocuments', 'documentLinks', 'clinicalDocumentVersions', 'documentScanEvents', 'documentUploadTokens'].every((name) => workspaceExport.includes(`'${name}'`)) && workspaceExport.includes('documentExportManifest'));
  check('call analytics use tenant-paged reads instead of broad transcript hydration', callsRuntime.includes("listAllByOrg<CallDoc>('calls', orgId)") && !callsRuntime.includes("list<CallDoc>('calls')"));
  check('platform aggregates project call metrics without loading transcripts', adminRuntime.includes("projectFields('calls', ['orgId', 'durationSeconds', 'cost.total', 'startedAt'])"));

  const syntheticMergeEvent = commitBatch({ upserts: [{
    collection: 'clientMergeEvents', expectedRevision: null, expectedOrgId: orgId,
    doc: {
      id: 'merge_event_trigger_fixture', orgId, conflictId: 'synthetic_conflict',
      survivorPatientId: 'patient_a', sourcePatientId: 'synthetic_source', actor: owner.id,
      occurredAt: new Date().toISOString(), evidence: { exactSignals: [{ kind: 'email', normalizedValue: 'merge-trigger@example.test' }] },
    },
  }] }).upserts[0];
  await throws('application rejects patient-merge evidence update', () => update('clientMergeEvents', syntheticMergeEvent.id, { actor: 'changed' }), 'append-only');
  await throws('application rejects patient-merge evidence delete', () => remove('clientMergeEvents', syntheticMergeEvent.id), 'append-only');
  await throws('SQLite trigger rejects out-of-band patient-merge evidence update', () => raw.prepare("UPDATE docs SET body = json_set(body, '$.actor', 'changed') WHERE collection = 'clientMergeEvents' AND id = ?").run(syntheticMergeEvent.id), 'append-only');
  await throws('SQLite trigger rejects out-of-band patient-merge evidence delete', () => raw.prepare("DELETE FROM docs WHERE collection = 'clientMergeEvents' AND id = ?").run(syntheticMergeEvent.id), 'append-only');

  // Intentional full-store maintenance is possible without weakening runtime
  // immutability, but only inside the private, non-production capability window.
  const fullStore = dumpAll();
  await throws('whole-store replacement is refused without a private capability', () => replaceAll(fullStore), 'maintenance capability');
  withDestructiveMaintenance('focused check of capability-gated replacement', (capability) => replaceAll(fullStore, capability));
  check('capability-gated replacement preserves immutable clinical rows', Boolean(get('clinicalAccessEvents', access.id)) && documentVersionsFor(orgId, firstUpload.document.id).length === 1);
  await throws('append-only trigger is active again after maintenance commits', () => raw.prepare("DELETE FROM docs WHERE collection = 'clinicalAccessEvents' AND id = ?").run(access.id), 'append-only');

  raw.close();
  closeStore();
  console.log(`\nPhase 1 clinical foundation: ${checks}/${checks} focused checks passed`);
}

void main().catch((error) => {
  console.error(error);
  try { closeStore(); } catch { /* ignore */ }
  process.exit(1);
});
