import assert from 'node:assert/strict';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import {
  SCHEMA_MIGRATIONS,
  runSqliteSchemaMigrations,
  type SchemaMigration,
} from '../lib/server/schema-migrations';

const root = process.env.VOXERA_MIGRATION_ROLLBACK_DIR ?? '/tmp/voxera-phase4-migration-rollback';
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
const db = new Database(`${root}/rollback.sqlite`);
const row = <T extends Record<string, unknown>>(sql: string, ...params: unknown[]) => db.prepare(sql).get(...params) as T;
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE docs (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    collection TEXT NOT NULL,
    id TEXT NOT NULL,
    pos INTEGER NOT NULL,
    body TEXT NOT NULL,
    UNIQUE (collection, id)
  );
  CREATE INDEX docs_by_collection ON docs (collection, pos);
  CREATE INDEX docs_by_collection_age ON docs (collection, seq);
`);

const mutable = SCHEMA_MIGRATIONS as SchemaMigration[];
const bodyChartMigration = mutable.at(-1);
assert.equal(bodyChartMigration?.id, '20260920_013_phase4_body_chart_evidence', 'body-chart migration must remain the current migration');
mutable.pop();
const preChartApplied = runSqliteSchemaMigrations(db);
assert.equal(preChartApplied.length, SCHEMA_MIGRATIONS.length, 'all migrations before body charts should initialise the isolated store');

const failingBodyChartMigration: SchemaMigration = {
  ...bodyChartMigration!,
  sqlite: [
    ...bodyChartMigration!.sqlite,
    `INSERT INTO phase4_table_that_does_not_exist (id) VALUES ('body-chart-failure')`,
  ],
};
mutable.push(failingBodyChartMigration);
let bodyChartFailed = false;
try {
  runSqliteSchemaMigrations(db);
} catch (error) {
  bodyChartFailed = /phase4_table_that_does_not_exist/i.test(error instanceof Error ? error.message : String(error));
}
assert.equal(bodyChartFailed, true, 'an induced failure after migration 013 statements should fail the transaction');
assert.equal(row<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='docs_body_chart_annotations_note'").n, 0, 'migration 013 indexes must roll back with a later failing statement');
assert.equal(row<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name='docs_final_body_chart_update'").n, 0, 'migration 013 triggers must roll back with a later failing statement');
assert.equal(row<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migrations WHERE id = ?', bodyChartMigration!.id).n, 0, 'failed migration 013 must not be written to the ledger');

mutable.pop();
mutable.push(bodyChartMigration!);
const bodyChartApplied = runSqliteSchemaMigrations(db);
assert.deepEqual(bodyChartApplied, [bodyChartMigration!.id], 'real migration 013 should retry safely after rollback');
assert.equal(
  row<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE id = ?', bodyChartMigration!.id).checksum,
  '7e5e986a711a124e5adc75c33f5875c61cebda97734398307ec6000d0b16030e',
  'migration 013 SQLite checksum should be fixed and ledged',
);
const expectedIndexes = [
  'docs_body_chart_templates_state',
  'docs_body_chart_annotations_note',
  'docs_body_chart_annotation_version',
  'docs_body_chart_conflicts_note',
];
assert.equal(
  row<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name IN (${expectedIndexes.map(() => '?').join(',')})`, ...expectedIndexes).n,
  expectedIndexes.length,
  'migration 013 should install every body-chart index',
);
const expectedTriggers = [
  'docs_body_chart_versions_immutable_update',
  'docs_body_chart_versions_immutable_delete',
  'docs_body_chart_version_hash_insert',
  'docs_body_chart_final_evidence_insert',
  'docs_body_chart_final_evidence_update',
  'docs_final_body_chart_update',
  'docs_final_body_chart_delete',
  'docs_published_body_chart_template_update',
  'docs_published_body_chart_template_delete',
];
assert.equal(
  row<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN (${expectedTriggers.map(() => '?').join(',')})`, ...expectedTriggers).n,
  expectedTriggers.length,
  'migration 013 should install every body-chart evidence trigger',
);

const failing: SchemaMigration = {
  id: '20990101_999_induced_phase4_failure',
  description: 'Induced rollback probe; never part of a deployed ledger',
  postgres: [],
  sqlite: [
    `CREATE TABLE phase4_induced_rollback (id TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `INSERT INTO phase4_induced_rollback (id, value) VALUES ('probe', 'must roll back')`,
    `INSERT INTO phase4_table_that_does_not_exist (id) VALUES ('failure')`,
  ],
};
mutable.push(failing);
let failed = false;
try {
  runSqliteSchemaMigrations(db);
} catch (error) {
  failed = /phase4_table_that_does_not_exist/i.test(error instanceof Error ? error.message : String(error));
}
assert.equal(failed, true, 'the induced statement should fail inside the migration transaction');
assert.equal(row<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='phase4_induced_rollback'").n, 0, 'DDL and data before the failure must roll back');
assert.equal(row<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migrations WHERE id = ?', failing.id).n, 0, 'a failed migration must not be written to the ledger');
assert.equal(row<{ value: number }>('SELECT allow_immutable_mutation AS value FROM voxera_maintenance_state WHERE id = 1').value, 0, 'immutable-maintenance bypass must remain closed');

mutable.pop();
const retry: SchemaMigration = {
  ...failing,
  description: 'Successful retry after the induced rollback probe',
  sqlite: [
    `CREATE TABLE phase4_induced_rollback (id TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `INSERT INTO phase4_induced_rollback (id, value) VALUES ('probe', 'committed retry')`,
  ],
};
mutable.push(retry);
const retried = runSqliteSchemaMigrations(db);
assert.deepEqual(retried, [retry.id], 'the same migration id should be safely retryable after rollback');
assert.equal(row<{ value: string }>("SELECT value FROM phase4_induced_rollback WHERE id='probe'").value, 'committed retry');
assert.equal(row<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migrations WHERE id = ?', retry.id).n, 1, 'the successful retry should be ledged once');
mutable.pop();
db.close();

console.log('Phase 4 SQLite migration rollback check passed: 17/17');
