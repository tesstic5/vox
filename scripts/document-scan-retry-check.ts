import { closeStore, commitBatch, get, insert, list } from '../lib/server/db';
import { completeDocumentUpload, createDocumentUploadToken, downloadDocumentVersion, latestScanEvent } from '../lib/server/clinical-documents';
import { runDueDomainJobs, type DomainJobDoc } from '../lib/server/domain-jobs';

let checks = 0;
function check(label: string, condition: unknown, detail?: unknown) {
  checks += 1;
  if (!condition) throw new Error(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  console.log(`PASS ${label}`);
}
async function throws(label: string, work: () => Promise<unknown>, includes: string) {
  let message = '';
  try { await work(); } catch (error) { message = error instanceof Error ? error.message : String(error); }
  check(label, message.includes(includes), message);
}

async function main() {
  const orgId = 'org_scan_retry';
  insert('orgs', { id: orgId, name: 'Scan retry', createdAt: new Date().toISOString() });
  insert('clients', { id: 'scan_patient', orgId, name: 'Synthetic Patient', number: '+441234000000', consents: {}, createdAt: new Date().toISOString() });

  process.env.VOXERA_MALWARE_SCAN_COMMAND = '/bin/sh';
  process.env.VOXERA_MALWARE_SCAN_ARGS_JSON = '["-c","echo scanner-temporary-error >&2; exit 2","{file}"]';
  const capability = createDocumentUploadToken({ orgId, ownerType: 'patient', ownerId: 'scan_patient', title: 'Retry fixture', actor: 'test' });
  const upload = await completeDocumentUpload({ token: capability.token, bytes: Buffer.from('synthetic retry fixture'), mimeType: 'text/plain', originalName: 'retry.txt', actor: 'test' });
  const initial = list<DomainJobDoc>('domainJobs', (job) => job.orgId === orgId && job.payload.versionId === upload.version.id)[0]!;
  commitBatch({ upserts: [{ collection: 'domainJobs', doc: { ...initial, maxAttempts: 2 }, expectedRevision: Number(initial.revision), expectedOrgId: orgId }] });

  const first = await runDueDomainJobs(orgId, { workerId: 'scan-test-1', limit: 1 });
  const retried = get<DomainJobDoc>('domainJobs', initial.id)!;
  check('scanner execution error schedules durable retry', first.retried === 1 && retried.status === 'retry' && retried.attempts === 1 && String(retried.lastError).includes('scanner exited 2'), retried);
  check('error scan evidence is append-only and visible', latestScanEvent(orgId, upload.version.id)?.status === 'error');
  await throws('errored version remains quarantined between attempts', () => downloadDocumentVersion(orgId, upload.document.id), 'quarantined');

  const due = commitBatch({ upserts: [{ collection: 'domainJobs', doc: { ...retried, runAt: new Date(0).toISOString() }, expectedRevision: Number(retried.revision), expectedOrgId: orgId }] }).upserts[0] as DomainJobDoc;
  const second = await runDueDomainJobs(orgId, { workerId: 'scan-test-2', limit: 1 });
  const failed = get<DomainJobDoc>('domainJobs', due.id)!;
  check('scanner retry exhausts into failed state', second.failed === 1 && failed.status === 'failed' && failed.attempts === 2, failed);
  check('each retry appends separate immutable scan evidence', list('documentScanEvents', (row) => row.orgId === orgId && row.versionId === upload.version.id).length === 2);
  await throws('failed scanner never releases document bytes', () => downloadDocumentVersion(orgId, upload.document.id), 'quarantined');

  closeStore();
  console.log(`\nDocument scanner retry safety: ${checks}/${checks} checks passed`);
}

void main().catch((error) => {
  console.error(error);
  try { closeStore(); } catch { /* ignore */ }
  process.exit(1);
});
