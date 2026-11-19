import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { closeStore, insert, list, nowIso, type Doc } from '../lib/server/db';
import { createClient } from '../lib/server/clients';
import {
  createLetter, createLetterTemplate, letterById, letterPdf, lettersFor,
  setLetterTemplateState, transitionLetter,
} from '../lib/server/letters';
import { createReferral, referralNotificationsFor, type ReferralNotificationDoc } from '../lib/server/referrals';
import type { DomainJobDoc } from '../lib/server/domain-jobs';
import { SCHEMA_MIGRATIONS, schemaMigrationChecksum } from '../lib/server/schema-migrations';

process.env.VOXERA_DOCUMENT_MASTER_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

let checks = 0;
function check(label: string, condition: unknown, detail?: unknown) {
  checks += 1;
  if (!condition) throw new Error(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  console.log(`PASS ${label}`);
}

type WorkerResult = Record<string, unknown>;
function startWorker(args: string[]) {
  let stdout = '';
  let stderr = '';
  const child = spawn(process.execPath, ['node_modules/.bin/tsx', 'scripts/phase3-evidence-race-worker.ts', ...args], {
    cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  return new Promise<WorkerResult>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) return reject(new Error(`worker ${args.join(' ')} exited ${code}: ${stderr || stdout}`));
      const line = stdout.trim().split('\n').at(-1) ?? '{}';
      try { resolve(JSON.parse(line) as WorkerResult); }
      catch { reject(new Error(`worker returned invalid JSON: ${stdout}`)); }
    });
  });
}

async function waitFor(files: string[], timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (!files.every((file) => fs.existsSync(file))) {
    if (Date.now() > until) throw new Error(`timed out waiting for worker barriers: ${files.join(', ')}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function race(action: string, args: string[]) {
  const barrier = `/tmp/voxera-phase3-evidence-race-${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
  const workers = [
    startWorker([action, 'A', barrier, ...args]),
    startWorker([action, 'B', barrier, ...args]),
  ];
  const ready = [`${barrier}.A.ready`, `${barrier}.B.ready`];
  await waitFor(ready);
  fs.writeFileSync(`${barrier}.go`, 'go');
  try { return await Promise.all(workers); }
  finally { for (const file of [...ready, `${barrier}.go`]) fs.rmSync(file, { force: true }); }
}

async function finalisedLetter(orgId: string, templateId: string, clientId: string, actor: string) {
  const created = createLetter({
    orgId, templateId, clientId,
    recipient: { name: 'Race Recipient', email: 'race.recipient@example.test' },
    actor: { name: 'Race Author', email: actor },
  });
  const awaiting = await transitionLetter({ orgId, id: created.letter.id, action: 'submit', actor, expectedRevision: created.letter.revision });
  const approved = await transitionLetter({ orgId, id: awaiting.id, action: 'approve', actor, expectedRevision: awaiting.revision });
  return transitionLetter({ orgId, id: approved.id, action: 'finalise', actor, expectedRevision: approved.revision });
}

async function main() {
  if (!['sqlite', 'postgres'].includes(process.env.VOXERA_STORE ?? '')) throw new Error('set VOXERA_STORE to sqlite or postgres');
  if (!process.env.VOXERA_DATA_DIR) throw new Error('set an isolated VOXERA_DATA_DIR');
  const orgId = 'org_phase3_evidence_race';
  const actor = 'race-setup@voxera.test';
  const evidenceMigration = SCHEMA_MIGRATIONS.find((row) => row.id === '20260920_011_phase3_corrections_and_referral_notifications');
  check('phase 3 evidence migration has fixed SQLite and PostgreSQL checksums', Boolean(evidenceMigration) && schemaMigrationChecksum(evidenceMigration!, 'sqlite') === 'f2e31ce0bf63f018f8463110cc24741b6692f18fcf06402952e65099552f703c' && schemaMigrationChecksum(evidenceMigration!, 'postgres') === '82bbdc1e4555e317282ba076aff71570cd9b727a3a1fc0e3caa7c4386f590f2d');
  insert<Doc>('orgs', { id: orgId, name: 'Phase 3 evidence race', createdAt: nowIso() });
  const client = createClient(orgId, { name: 'Race Patient', number: '+447700950001', email: 'race.patient@example.test' }, actor, { source: 'phase3-evidence-race' });
  const templateDraft = createLetterTemplate({
    orgId, actor, name: 'Race outcome', category: 'referral',
    subject: 'Outcome for {{patient.name}}', body: 'Dear {{recipient.name}}, this is the recorded outcome.',
    requiresApproval: true,
  });
  const template = setLetterTemplateState({ orgId, id: templateDraft.template.id, state: 'published', actor, expectedRevision: templateDraft.template.revision });
  const source = await finalisedLetter(orgId, template.id, client.id, actor);
  const sourceArtifact = await letterPdf(orgId, source.id);

  const correctionResults = await race('correction', [orgId, source.id, String(source.revision), 'Concurrent correction required for factual accuracy.']);
  check('two correction processes produce exactly one winner', correctionResults.filter((row) => row.ok === true).length === 1 && correctionResults.filter((row) => row.ok === false).length === 1, correctionResults);
  const correctionRows = lettersFor(orgId).filter((row) => row.correctsLetterId === source.id);
  const correctedSource = letterById(orgId, source.id);
  check('correction race leaves one linked draft and one source link', correctionRows.length === 1 && correctedSource?.correctedByLetterId === correctionRows[0]?.id && correctedSource.status === 'corrected', { correctionRows, correctedSource });
  const sourceAfter = await letterPdf(orgId, source.id);
  check('correction race preserves exact source artifact bytes and hash', Boolean(sourceAfter?.pdf.equals(sourceArtifact!.pdf) && sourceAfter.letter.artifactHash === source.artifactHash));

  const referral = createReferral({
    orgId, actor, patient: { name: 'Notification Race Patient' }, reason: 'Concurrent notification check',
    referrer: { name: 'Notification Referrer', email: 'notification.referrer@example.test' },
  }).referral;
  const sameResults = await race('notification-same', [orgId, referral.id, String(referral.revision), 'The referral update is ready for controlled delivery.']);
  check('identical cross-process notification retries converge successfully', sameResults.every((row) => row.ok === true) && sameResults[0]?.id === sameResults[1]?.id, sameResults);
  const sameRows = referralNotificationsFor(orgId, referral.id);
  check('identical notification race leaves one evidence row and one durable job', sameRows.length === 1 && list<DomainJobDoc>('domainJobs', (row) => row.orgId === orgId && row.payload.notificationId === sameRows[0]?.id).length === 1, sameRows);

  const competingReferral = createReferral({
    orgId, actor, patient: { name: 'Competing Notification Patient' }, reason: 'Competing notification check',
    referrer: { name: 'Competing Referrer', email: 'competing.referrer@example.test' },
  }).referral;
  const differentResults = await race('notification-different', [orgId, competingReferral.id, String(competingReferral.revision), 'This competing administrative update is long enough']);
  check('different concurrent notification content produces one winner and one conflict', differentResults.filter((row) => row.ok === true).length === 1 && differentResults.filter((row) => row.ok === false).length === 1, differentResults);
  check('different-content race preserves exactly one complete notification', list<ReferralNotificationDoc>('referralNotifications', (row) => row.orgId === orgId && row.referralId === competingReferral.id).length === 1);

  if (process.env.VOXERA_STORE === 'sqlite') {
    closeStore();
    const sqlite = new Database(path.join(process.env.VOXERA_DATA_DIR!, 'voxera-db.sqlite'));
    try {
      const indexes = new Set((sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((row) => row.name));
      check('phase 3 evidence migration installs correction and notification indexes', ['docs_letter_correction_source', 'docs_referral_notification_revision', 'docs_referral_notification_state'].every((name) => indexes.has(name)), [...indexes]);
      const triggers = new Set((sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>).map((row) => row.name));
      check('phase 3 evidence migration installs final-letter update and delete guards', ['docs_final_letter_evidence_update', 'docs_final_letter_evidence_delete'].every((name) => triggers.has(name)), [...triggers]);
      const migration = sqlite.prepare('SELECT checksum FROM schema_migrations WHERE id = ?').get('20260920_011_phase3_corrections_and_referral_notifications') as { checksum?: string } | undefined;
      check('phase 3 evidence migration is checksummed in the ledger', migration?.checksum?.length === 64, migration);
      let updateRejected = false;
      try {
        sqlite.prepare("UPDATE docs SET body = json_set(body, '$.artifactHash', ?) WHERE collection = 'letters' AND id = ?").run('0'.repeat(64), source.id);
      } catch (error) {
        updateRejected = /finalised letter evidence is immutable/i.test(error instanceof Error ? error.message : String(error));
      }
      check('direct final-letter artifact-hash mutation is database-rejected', updateRejected);
      let deleteRejected = false;
      try {
        sqlite.prepare("DELETE FROM docs WHERE collection = 'letters' AND id = ?").run(source.id);
      } catch (error) {
        deleteRejected = /finalised letter evidence is immutable/i.test(error instanceof Error ? error.message : String(error));
      }
      check('direct final-letter deletion is database-rejected', deleteRejected);
    } finally {
      sqlite.close();
    }
  } else {
    closeStore();
  }
  console.log(`phase3-evidence-race-check: ${checks}/${checks} checks passed (${process.env.VOXERA_STORE})`);
}

void main().catch((error) => {
  console.error(error);
  try { closeStore(); } catch { /* ignore */ }
  process.exit(1);
});
