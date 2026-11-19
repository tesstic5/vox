import {
  closeStore,
  commitBatch,
  flushNow,
  findByPath,
  get,
  insert,
  list,
  listAllByOrg,
  projectFields,
  remove,
  resetDb,
  storeDriver,
  update,
  type Doc,
} from '../lib/server/db';
import { pgQuery } from '../lib/server/postgres';
import { SCHEMA_MIGRATIONS, schemaMigrationChecksum } from '../lib/server/schema-migrations';
import { appendClinicalAccessEvent } from '../lib/server/clinical-access';
import { runPhase1DataMigrations } from '../lib/server/data-migrations';
import { evaluateClinicalReadiness } from '../lib/server/clinical-readiness';
import { systemRoleTemplate } from '../lib/server/permissions';
import { withDestructiveMaintenance } from '../lib/server/maintenance-replace';

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

function main() {
  check('clinical check is using PostgreSQL', storeDriver() === 'postgres');
  const database = new URL(process.env.DATABASE_URL ?? '');
  if (!database.pathname.includes('test') && process.env.VOXERA_ALLOW_POSTGRES_TEST_RESET !== '1') {
    throw new Error('refusing destructive PostgreSQL clinical check: use a database whose name contains "test"');
  }
  throws('PostgreSQL reset is refused without the private maintenance capability', () => resetDb(), 'maintenance capability');
  withDestructiveMaintenance('reset throwaway PostgreSQL clinical target', (capability) => resetDb(capability));
  list('orgs'); // open the store and run checksummed migrations
  const applied = pgQuery<{ id: string; checksum: string }>('SELECT id, checksum FROM voxera_schema_migrations ORDER BY id');
  check('all PostgreSQL schema migrations are recorded', applied.length === SCHEMA_MIGRATIONS.length, applied);
  check('PostgreSQL migration checksums match code', applied.every((row, index) => row.id === SCHEMA_MIGRATIONS[index]?.id && row.checksum === schemaMigrationChecksum(SCHEMA_MIGRATIONS[index]!, 'postgres')));

  const orgId = 'org_pg_clinical';
  insert('orgs', { id: orgId, name: 'PostgreSQL clinical test', createdAt: new Date().toISOString() });
  insert('clients', { id: 'pg_patient', orgId, name: 'Synthetic PG patient', number: '+441111000999', alerts: [], consents: {}, createdAt: new Date().toISOString() });
  const access = appendClinicalAccessEvent({ orgId, resourceType: 'patient', resourceId: 'pg_patient', patientId: 'pg_patient', action: 'view', actorId: 'pg-test' });
  throws('application blocks PostgreSQL append-only update', () => update('clinicalAccessEvents', access.id, { action: 'delete' }), 'append-only');
  throws('application blocks PostgreSQL append-only delete', () => remove('clinicalAccessEvents', access.id), 'append-only');
  throws('PostgreSQL trigger blocks direct append-only JSONB update', () => pgQuery("UPDATE voxera_docs SET body = jsonb_set(body, '{action}', '\"delete\"'::jsonb) WHERE collection = 'clinicalAccessEvents' AND id = $1", [access.id]), 'append-only');
  throws('PostgreSQL trigger blocks direct append-only row delete', () => pgQuery("DELETE FROM voxera_docs WHERE collection = 'clinicalAccessEvents' AND id = $1", [access.id]), 'append-only');

  const a = insert<Doc>('pgAtomic', { id: 'a', orgId, value: 0 });
  const b = insert<Doc>('pgAtomic', { id: 'b', orgId, value: 0 });
  commitBatch({ upserts: [
    { collection: 'pgAtomic', doc: { ...a, value: 1 }, expectedRevision: Number(a.revision ?? 0), expectedOrgId: orgId },
    { collection: 'pgAtomic', doc: { ...b, value: 1 }, expectedRevision: Number(b.revision ?? 0), expectedOrgId: orgId },
  ] });
  throws('PostgreSQL stale multi-row mutation conflicts', () => commitBatch({ upserts: [
    { collection: 'pgAtomic', doc: { ...a, value: 2 }, expectedRevision: Number(a.revision ?? 0), expectedOrgId: orgId },
    { collection: 'pgAtomic', doc: { ...b, value: 2 }, expectedRevision: Number(b.revision ?? 0), expectedOrgId: orgId },
  ] }), 'revision');
  check('PostgreSQL conflict rolls back whole batch', get<Doc>('pgAtomic', 'a')?.value === 1 && get<Doc>('pgAtomic', 'b')?.value === 1);

  const desiredAdminRole = systemRoleTemplate(orgId, 'admin');
  const roleBeforeMigration = insert('roles', {
    ...desiredAdminRole,
    permissions: desiredAdminRole.permissions.filter((permission) => permission !== 'clients.merge'),
  });
  const migration = runPhase1DataMigrations(orgId);
  check('checksummed data migrations complete on PostgreSQL', migration.completed === migration.total);
  const reconciledRole = get<Doc>('roles', desiredAdminRole.id);
  check('system-role reconciliation adds the separately governed merge permission', (reconciledRole?.permissions as string[] | undefined)?.includes('clients.merge'));
  check('system-role reconciliation and version backfill advance ordinary record revisions', Number(reconciledRole?.revision) > Number((roleBeforeMigration as Doc).revision), { before: (roleBeforeMigration as Doc).revision, after: reconciledRole?.revision });

  const mergeEvent = insert('clientMergeEvents', {
    id: 'pg_merge_event', orgId, survivorPatientId: 'pg_patient', sourcePatientId: 'pg_source',
    conflictId: 'pg_conflict', actor: 'pg-test', approvedAt: new Date().toISOString(),
    evidence: { exactSignals: [{ kind: 'email', normalizedValue: 'synthetic@example.test' }] },
  });
  flushNow();
  throws('application blocks PostgreSQL merge-evidence update', () => update('clientMergeEvents', mergeEvent.id, { actor: 'changed' }), 'append-only');
  throws('application blocks PostgreSQL merge-evidence delete', () => remove('clientMergeEvents', mergeEvent.id), 'append-only');
  const maintenanceSetting = pgQuery<{ setting: string }>("SELECT COALESCE(NULLIF(current_setting('voxera.allow_immutable_maintenance', true), ''), 'off') AS setting")[0]?.setting;
  check('PostgreSQL immutable-maintenance bypass is closed after migrations', maintenanceSetting === 'off', maintenanceSetting);
  throws('PostgreSQL trigger blocks direct merge-evidence update', () => pgQuery("UPDATE voxera_docs SET body = jsonb_set(body, '{actor}', '\"changed\"'::jsonb) WHERE collection = 'clientMergeEvents' AND id = $1", [mergeEvent.id]), 'append-only');
  throws('PostgreSQL trigger blocks direct merge-evidence delete', () => pgQuery("DELETE FROM voxera_docs WHERE collection = 'clientMergeEvents' AND id = $1", [mergeEvent.id]), 'append-only');

  const readiness = evaluateClinicalReadiness(orgId);
  const postgres = readiness.checks.find((row) => row.id === 'postgres');
  check('readiness recognises PostgreSQL but remains fail-closed on other gates', postgres?.status === 'pass' && !readiness.readyForLive && readiness.failedRequired.includes('review-security'), readiness.failedRequired);
  const indexes = pgQuery<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE tablename = 'voxera_docs'").map((row) => row.indexname);
  check('tenant-leading clinical indexes exist in PostgreSQL', ['voxera_docs_contact_exact', 'voxera_docs_clinical_access_resource', 'voxera_docs_documents_owner', 'voxera_docs_legal_holds_scope', 'voxera_docs_document_link_target'].every((name) => indexes.includes(name)), indexes);

  insert('calls', {
    id: 'pg_scoped_call', orgId, startedAt: new Date().toISOString(), durationSeconds: 60,
    cost: { total: 1.25 }, telephony: { callSid: 'CApgscoped' }, transcript: [{ role: 'user', text: 'restricted marker' }],
  });
  insert('calls', {
    id: 'pg_other_call', orgId: 'org_other', startedAt: new Date().toISOString(), durationSeconds: 120,
    cost: { total: 2.5 }, telephony: { callSid: 'CAother' }, transcript: [{ role: 'user', text: 'other tenant marker' }],
  });
  flushNow();
  check('PostgreSQL tenant-paged call reads exclude other workspaces', listAllByOrg<Doc>('calls', orgId).map((row) => row.id).join(',') === 'pg_scoped_call');
  check('PostgreSQL JSON-path lookup finds a carrier call without collection hydration', findByPath<Doc>('calls', 'telephony.callSid', 'CApgscoped')?.id === 'pg_scoped_call');
  const projectedCalls = projectFields('calls', ['orgId', 'durationSeconds', 'cost.total', 'startedAt']);
  check('PostgreSQL operational projection omits restricted transcripts', projectedCalls.length === 2 && projectedCalls.every((row) => !('transcript' in row) && Object.keys(row).sort().join(',') === ['cost.total', 'durationSeconds', 'orgId', 'startedAt'].sort().join(',')), projectedCalls);

  withDestructiveMaintenance('clean throwaway PostgreSQL clinical target', (capability) => resetDb(capability));
  closeStore();
  console.log(`\nPostgreSQL clinical foundation: ${checks}/${checks} checks passed`);
}

try { main(); } catch (error) {
  console.error(error);
  try { closeStore(); } catch { /* ignore */ }
  process.exit(1);
}
