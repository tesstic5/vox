import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { closeStore, insert, nowIso, type Doc } from '../lib/server/db';
import { clientById, createClient } from '../lib/server/clients';
import {
  clientRelationshipsFor,
  createContact,
  createCustomFieldDefinition,
  customFieldDefinitionsFor,
  customFieldValuesFor,
} from '../lib/server/intake-admin';

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
  const child = spawn(process.execPath, ['node_modules/.bin/tsx', 'scripts/intake-admin-race-worker.ts', ...args], {
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
  const barrier = `/tmp/voxera-intake-race-${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
  const workers = [startWorker([action, 'A', barrier, ...args]), startWorker([action, 'B', barrier, ...args])];
  const ready = [`${barrier}.A.ready`, `${barrier}.B.ready`];
  await waitFor(ready);
  fs.writeFileSync(`${barrier}.go`, 'go');
  try { return await Promise.all(workers); }
  finally { for (const file of [...ready, `${barrier}.go`]) fs.rmSync(file, { force: true }); }
}

async function main() {
  if (!['sqlite', 'postgres'].includes(process.env.VOXERA_STORE ?? '')) throw new Error('set VOXERA_STORE to sqlite or postgres');
  if (!process.env.VOXERA_DATA_DIR) throw new Error('set an isolated VOXERA_DATA_DIR');
  const orgId = 'org_intake_race';
  const actor = 'race-setup@voxera.test';
  insert<Doc>('orgs', { id: orgId, name: 'Intake race test', createdAt: nowIso() });
  const patient = createClient(orgId, { name: 'Race Patient', number: '+447700940001', email: 'race-patient@example.test' }, actor, { source: 'intake-race-check' });
  const contact = createContact({ orgId, name: 'Race Guardian', phone: '+447700940002', actor });
  const valueDefinition = createCustomFieldDefinition({ orgId, targetType: 'client', key: 'race_value', label: 'Race value', valueType: 'text', actor });

  const relationshipResults = await race('relationship', [orgId, patient.id, contact.id, 'guardian']);
  check('two processes produce one active relationship winner', relationshipResults.filter((row) => row.ok === true).length === 1 && relationshipResults.filter((row) => row.ok === false).length === 1, relationshipResults);
  check('relationship uniqueness leaves exactly one active row', clientRelationshipsFor(orgId, patient.id).filter((row) => row.contactId === contact.id && row.relationshipType === 'guardian').length === 1);

  const definitionResults = await race('definition', [orgId, 'concurrent_key']);
  check('two processes produce one custom-field-key winner', definitionResults.filter((row) => row.ok === true).length === 1 && definitionResults.filter((row) => row.ok === false).length === 1, definitionResults);
  check('custom-field-key uniqueness leaves exactly one definition', customFieldDefinitionsFor(orgId, 'client', true).filter((row) => row.key === 'concurrent_key').length === 1);

  const valueResults = await race('value', [orgId, valueDefinition.id, patient.id, 'concurrent value']);
  check('two processes produce one first-value winner', valueResults.filter((row) => row.ok === true).length === 1 && valueResults.filter((row) => row.ok === false).length === 1, valueResults);
  const values = customFieldValuesFor(orgId, 'client', patient.id).filter((row) => row.definitionId === valueDefinition.id);
  check('custom-field target uniqueness leaves exactly one typed value', values.length === 1 && values[0]?.value === 'concurrent value', values);

  const addressResults = await race('address', [orgId, patient.id, String(patient.revision), '10 Race Road']);
  check('two processes produce one structured-address review winner', addressResults.filter((row) => row.ok === true).length === 1 && addressResults.filter((row) => row.ok === false).length === 1, addressResults);
  const reviewedPatient = clientById(orgId, patient.id);
  check('address race preserves one complete reviewed value', reviewedPatient?.structuredAddress?.reviewStatus === 'reviewed' && reviewedPatient.address?.includes('Race City'), reviewedPatient);

  closeStore();
  console.log(`intake-admin-race-check: ${checks}/${checks} checks passed (${process.env.VOXERA_STORE})`);
}

void main().catch((error) => {
  console.error(error);
  try { closeStore(); } catch { /* ignore */ }
  process.exit(1);
});
