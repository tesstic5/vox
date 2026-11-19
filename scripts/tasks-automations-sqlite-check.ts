import assert from 'node:assert/strict';
import path from 'node:path';
import Database from 'better-sqlite3';

const supplied = process.env.VOXERA_DB_PATH?.trim();
if (!supplied) throw new Error('VOXERA_DB_PATH must point to a disposable SQLite task/automation fixture');
const databasePath = path.resolve(supplied);
const canonicalPath = path.resolve(process.cwd(), 'data/voxera-db.sqlite');
if (databasePath === canonicalPath) throw new Error('the direct SQLite gate refuses to use the canonical fixture');

const db = new Database(databasePath);
let checks = 0;
function check(condition: unknown, message: string, detail: string) {
  assert.ok(condition, `${message}: ${detail}`);
  checks += 1;
  console.log(`PASS  ${message} — ${detail}`);
}
function count(sql: string, ...params: unknown[]) {
  return Number((db.prepare(sql).get(...params) as { count: number }).count);
}
function rejected(work: () => unknown, pattern: RegExp, label: string) {
  let detail = '';
  try { work(); } catch (error) { detail = error instanceof Error ? error.message : String(error); }
  check(pattern.test(detail), label, detail || 'write unexpectedly succeeded');
}

try {
  check(
    count(`SELECT count(*) AS count FROM schema_migrations WHERE id = ? AND checksum = ?`,
      '20260920_010_tasks_and_constrained_automations',
      '9375d5f116d799eb0ab440c7e082a24d9e458b478b98f8d2923001526ae5c45f') === 1,
    'migration 20260920_010 has its exact SQLite checksum',
    '1',
  );
  const indexes = [
    'docs_task_queue', 'docs_task_resource', 'docs_automation_event_source',
    'docs_automation_event_trigger', 'docs_automation_rule_version',
    'docs_automation_rules_active', 'docs_automation_run_idempotency',
    'docs_automation_runs_rule', 'docs_automation_notifications',
  ];
  check(
    count(`SELECT count(*) AS count FROM sqlite_master WHERE type = 'index' AND name IN (${indexes.map(() => '?').join(',')})`, ...indexes) === 9,
    'all nine task/automation indexes exist',
    '9',
  );
  const triggers = ['docs_immutable_automation_evidence_update', 'docs_immutable_automation_evidence_delete'];
  check(
    count(`SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name IN (?, ?)`, ...triggers) === 2,
    'both immutable automation-evidence triggers exist',
    '2',
  );
  check(count(`SELECT count(*) AS count FROM docs WHERE collection = 'automationEvents'`) > 0, 'disposable store contains automation events', 'synthetic event evidence exists');
  check(count(`SELECT count(*) AS count FROM docs WHERE collection = 'automationRuleVersions'`) > 0, 'disposable store contains immutable rule versions', 'synthetic version evidence exists');
  check(count(`SELECT count(*) AS count FROM docs WHERE collection IN ('tasks', 'automationRuns')`) > 1, 'disposable store contains task and run rows', 'task/run evidence exists');

  const event = db.prepare(`SELECT seq, collection, id, body FROM docs WHERE collection = 'automationEvents' ORDER BY seq LIMIT 1`).get() as { seq: number; collection: string; id: string; body: string };
  const version = db.prepare(`SELECT seq, collection, id, body FROM docs WHERE collection = 'automationRuleVersions' ORDER BY seq LIMIT 1`).get() as { seq: number; collection: string; id: string; body: string };
  const run = db.prepare(`SELECT seq, collection, id, body FROM docs WHERE collection = 'automationRuns' ORDER BY seq LIMIT 1`).get() as { seq: number; collection: string; id: string; body: string };
  rejected(() => db.prepare('UPDATE docs SET body = body WHERE seq = ?').run(event.seq), /append-only automation evidence/i, 'direct automation-event update is rejected');
  rejected(() => db.prepare('DELETE FROM docs WHERE seq = ?').run(version.seq), /append-only automation evidence/i, 'direct rule-version delete is rejected');

  const duplicate = (row: { collection: string; body: string }, id: string) => {
    const body = { ...JSON.parse(row.body), id };
    db.prepare('INSERT INTO docs (collection, id, pos, body) VALUES (?, ?, 0, ?)').run(row.collection, id, JSON.stringify(body));
  };
  rejected(() => duplicate(event, 'duplicate_event_source_probe'), /docs_automation_event_source|unique constraint/i, 'event source uniqueness is database-enforced');
  rejected(() => duplicate(version, 'duplicate_rule_version_probe'), /docs_automation_rule_version|unique constraint/i, 'rule-version uniqueness is database-enforced');
  rejected(() => duplicate(run, 'duplicate_run_probe'), /docs_automation_run_idempotency|unique constraint/i, 'run idempotency is database-enforced');

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE voxera_maintenance_state SET allow_immutable_mutation = 1 WHERE id = 1').run();
    db.prepare('UPDATE docs SET body = body WHERE seq = ?').run(event.seq);
    db.exec('ROLLBACK');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  check(count('SELECT count(*) AS count FROM voxera_maintenance_state WHERE id = 1 AND allow_immutable_mutation = 0') === 1, 'transactional maintenance bypass remains available', 'update succeeded only inside a rolled-back maintenance window');

  console.log(`\ntasks-automations-sqlite-check: ${checks} assertions passed`);
} finally {
  db.close();
}
