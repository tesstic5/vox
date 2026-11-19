import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { closeStore, commitBatch, get, nowIso, type Doc } from '../lib/server/db';
import { createClient } from '../lib/server/clients';
import { clientSubjectAccessManifest } from '../lib/server/client-export';
import { downloadDocumentVersion, persistGeneratedDocument } from '../lib/server/clinical-documents';
import { createNoteTemplate } from '../lib/server/clinical/templates';
import {
  bodyChartAnnotationVersions,
  createBodyChartAnnotation,
  createBodyChartTemplate,
  verifyBodyChartAnnotationVersion,
  type BodyChartAnnotationDoc,
  type BodyChartAnnotationVersionDoc,
} from '../lib/server/clinical/body-charts';
import {
  createNote,
  finaliseNote,
  noteById,
  updateNote,
  verifyClinicalNoteVersion,
  type ClinicalNoteVersionDoc,
} from '../lib/server/notes';
import { buildWorkspaceExport } from '../lib/server/workspace-export';

const dataDir = path.resolve(process.env.VOXERA_DATA_DIR ?? '');
const blobRoot = path.resolve(process.env.VOXERA_BLOB_ROOT ?? path.join(dataDir, 'blobs'));
const mode = process.argv[2] ?? 'run';
let assertions = 0;
function check(condition: unknown, message: string) {
  assert.ok(condition, message);
  assertions += 1;
}
function sha256(bytes: Buffer | string) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
function fileHash(file: string) {
  return sha256(fs.readFileSync(file));
}
function treeDigest(root: string) {
  const files: string[] = [];
  const walk = (directory: string) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  };
  walk(root);
  const hash = crypto.createHash('sha256');
  for (const file of files.sort()) {
    hash.update(path.relative(root, file));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return { files: files.length, digest: hash.digest('hex') };
}

type Manifest = {
  orgId: string;
  clientId: string;
  noteId: string;
  annotationId: string;
  noteHash: string;
  chartHash: string;
  sourceDocumentId: string;
  sourceVersionId: string;
  sourceSha256: string;
};

async function verifyRestore(manifestPath: string) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
  const sqlite = new Database(path.join(dataDir, 'voxera-db.sqlite'), { readonly: true });
  try {
    check(String(sqlite.pragma('integrity_check', { simple: true })) === 'ok', 'restored SQLite store passes integrity_check');
    const ledged = sqlite.prepare("SELECT checksum FROM schema_migrations WHERE id = '20260920_013_phase4_body_chart_evidence'").get() as { checksum?: string } | undefined;
    check(ledged?.checksum === '7e5e986a711a124e5adc75c33f5875c61cebda97734398307ec6000d0b16030e', 'restored store retains exact migration 013 checksum');
  } finally {
    sqlite.close();
  }

  const note = noteById(manifest.orgId, manifest.noteId);
  check(note?.status === 'final' && note.signedHash === manifest.noteHash, 'restored note retains final status and exact signed hash');
  const noteVersion = get<ClinicalNoteVersionDoc>('clinicalNoteVersions', `${manifest.noteId}_signed_v1`);
  check(Boolean(noteVersion && verifyClinicalNoteVersion(noteVersion) && noteVersion.contentHash === manifest.noteHash), 'restored immutable note snapshot verifies');
  const annotation = get<BodyChartAnnotationDoc>('bodyChartAnnotations', manifest.annotationId);
  check(annotation?.status === 'final' && annotation.lastSnapshotHash === manifest.chartHash, 'restored current chart retains signed snapshot reference');
  const chartVersions = bodyChartAnnotationVersions(manifest.orgId, manifest.noteId);
  const chartVersion = chartVersions[0];
  check(chartVersions.length === 1 && chartVersion.contentHash === manifest.chartHash && verifyBodyChartAnnotationVersion(chartVersion), 'restored immutable chart snapshot verifies');
  check(noteVersion?.bodyCharts?.[0]?.contentHash === chartVersion.contentHash, 'restored note hash evidence references the exact restored chart hash');

  const source = await downloadDocumentVersion(manifest.orgId, manifest.sourceDocumentId, manifest.sourceVersionId);
  check(source.version.id === manifest.sourceVersionId && sha256(source.bytes) === manifest.sourceSha256, 'restored encrypted source object decrypts to exact original bytes');
  const clientExport = clientSubjectAccessManifest({
    orgId: manifest.orgId,
    patientId: manifest.clientId,
    includeClinical: true,
    includeDocuments: true,
    includeAccessHistory: true,
  });
  check(clientExport.bodyCharts?.versions.length === 1 && clientExport.bodyChartSourceDocuments?.documents.some((row) => row.id === manifest.sourceDocumentId), 'restored client export contains chart snapshot and source manifest');
  const workspaceExport = buildWorkspaceExport(manifest.orgId, 'restore-verifier');
  const exported = workspaceExport.collections.bodyChartAnnotationVersions as unknown as BodyChartAnnotationVersionDoc[];
  check(exported.length === 1 && exported[0].contentHash === manifest.chartHash && workspaceExport.clinicalDocuments.documents.some((row) => row.id === manifest.sourceDocumentId), 'restored workspace export preserves integrity hash and controlled document metadata');
  console.log(JSON.stringify({ ok: true, assertions }));
  closeStore();
}

async function run() {
  if (!process.env.VOXERA_DATA_DIR || !process.env.VOXERA_BLOB_ROOT) throw new Error('set isolated VOXERA_DATA_DIR and VOXERA_BLOB_ROOT');
  if (!process.env.VOXERA_DOCUMENT_MASTER_KEY) throw new Error('set VOXERA_DOCUMENT_MASTER_KEY');
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const orgId = 'org_phase4_body_restore';
  const actor = 'restore-clinician@voxera.test';
  commitBatch({ upserts: [{
    collection: 'orgs',
    doc: { id: orgId, name: 'Synthetic restore practice', accountType: 'physiotherapist', createdAt: nowIso() } as Doc,
    expectedRevision: null,
    expectedOrgId: orgId,
  }] });
  const client = createClient(orgId, { name: 'Synthetic Restore Patient', number: '+447700900994' }, actor, { source: 'phase4-body-chart-restore-check' });
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63606060f80f0001040100c9fe92ef0000000049454e44ae426082', 'hex');
  const source = await persistGeneratedDocument({
    orgId, ownerType: 'workspace', ownerId: orgId, title: 'Restore body source', category: 'body_chart_restore_source',
    originalName: 'restore.png', mimeType: 'image/png', bytes: png, actor,
  });
  const chartTemplate = createBodyChartTemplate({
    orgId, title: 'Restore body chart', sourceDocumentId: source.document.id, sourceDocumentVersionId: source.version.id,
    state: 'published', actorId: actor, actorName: 'Restore Clinician',
  });
  assert.equal(chartTemplate.ok, true);
  if (!chartTemplate.ok) throw new Error('unexpected body-chart template failure');
  const noteTemplate = createNoteTemplate({
    orgId, name: 'Restore clinical record', state: 'published', actorId: actor, actorName: 'Restore Clinician',
    sections: [
      { id: 'record', label: 'Clinical record', kind: 'long_text', required: true },
      { id: 'body_map', label: 'Body map', kind: 'body_chart', required: true },
    ],
  });
  assert.equal(noteTemplate.ok, true);
  if (!noteTemplate.ok) throw new Error('unexpected note-template failure');
  const opened = createNote({ orgId, clientId: client.id, templateId: noteTemplate.template.id, title: 'Restore evidence note', actor, actorName: 'Restore Clinician' });
  assert.equal(opened.ok, true);
  if (!opened.ok) throw new Error('unexpected note-create failure');
  const text = updateNote({
    orgId, id: opened.note.id, expectedRevision: opened.note.revision, actor, actorName: 'Restore Clinician',
    patch: { sections: opened.note.sections.map((row) => ({ ...row, body: row.id === 'record' ? 'Synthetic clinician-authored restore evidence.' : '' })) },
  });
  assert.equal(text.ok, true);
  if (!text.ok) throw new Error('unexpected note-update failure');
  const madeChart = createBodyChartAnnotation({
    orgId, noteId: opened.note.id, templateId: chartTemplate.value.id, sectionId: 'body_map', expectedNoteRevision: text.note.revision,
    marks: [
      { id: 'restore_point', type: 'point', x: .25, y: .75, color: '#dc2626', size: 9 },
      { id: 'restore_label', type: 'label', x: .4, y: .6, color: '#059669', text: 'Clinician restore mark' },
    ],
    actorId: actor, actorName: 'Restore Clinician',
  });
  assert.equal(madeChart.ok, true);
  if (!madeChart.ok) throw new Error('unexpected chart-create failure');
  const latest = noteById(orgId, opened.note.id)!;
  const signed = finaliseNote({ orgId, id: latest.id, expectedRevision: latest.revision, signerId: actor, signerName: 'Restore Clinician', actor });
  assert.equal(signed.ok, true);
  if (!signed.ok) throw new Error('unexpected note-finalise failure');
  const chartVersion = bodyChartAnnotationVersions(orgId, opened.note.id)[0];
  const manifest: Manifest = {
    orgId,
    clientId: client.id,
    noteId: opened.note.id,
    annotationId: madeChart.value.id,
    noteHash: signed.note.signedHash!,
    chartHash: chartVersion.contentHash,
    sourceDocumentId: source.document.id,
    sourceVersionId: source.version.id,
    sourceSha256: sha256(png),
  };
  closeStore();

  const snapshotDir = `${dataDir}-recovery-point`;
  const restoredDir = `${dataDir}-restored`;
  fs.rmSync(snapshotDir, { recursive: true, force: true });
  fs.rmSync(restoredDir, { recursive: true, force: true });
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.copyFileSync(path.join(dataDir, 'voxera-db.sqlite'), path.join(snapshotDir, 'voxera-db.sqlite'));
  fs.cpSync(blobRoot, path.join(snapshotDir, 'blobs'), { recursive: true, force: true });
  const manifestPath = path.join(snapshotDir, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const sourceTree = treeDigest(blobRoot);
  const snapshotTree = treeDigest(path.join(snapshotDir, 'blobs'));
  check(sourceTree.files > 0 && sourceTree.digest === snapshotTree.digest, 'recovery point contains every encrypted chart-source object byte');
  check(fileHash(path.join(dataDir, 'voxera-db.sqlite')) === fileHash(path.join(snapshotDir, 'voxera-db.sqlite')), 'recovery point database matches the closed source database');

  fs.mkdirSync(restoredDir, { recursive: true });
  fs.copyFileSync(path.join(snapshotDir, 'voxera-db.sqlite'), path.join(restoredDir, 'voxera-db.sqlite'));
  fs.cpSync(path.join(snapshotDir, 'blobs'), path.join(restoredDir, 'blobs'), { recursive: true, force: true });
  check(fileHash(path.join(snapshotDir, 'voxera-db.sqlite')) === fileHash(path.join(restoredDir, 'voxera-db.sqlite')) && treeDigest(path.join(restoredDir, 'blobs')).digest === snapshotTree.digest, 'database and encrypted objects restore as one recovery point');

  const child = spawnSync(process.execPath, ['node_modules/.bin/tsx', 'scripts/phase4-body-chart-restore-check.ts', 'verify', manifestPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      VOXERA_STORE: 'sqlite',
      VOXERA_DATA_DIR: restoredDir,
      VOXERA_BLOB_ROOT: path.join(restoredDir, 'blobs'),
    },
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (child.status !== 0) throw new Error(`restore verifier failed (${child.status}): ${child.stderr || child.stdout}`);
  const line = child.stdout.trim().split('\n').at(-1) ?? '{}';
  const result = JSON.parse(line) as { ok?: boolean; assertions?: number };
  check(result.ok === true && result.assertions === 10, 'fresh-process restore verification passes all note, chart, document and export checks');
  console.log(`Phase 4 body-chart coordinated restore check passed: ${assertions + Number(result.assertions ?? 0)}/${assertions + Number(result.assertions ?? 0)}`);
}

if (mode === 'verify') {
  verifyRestore(String(process.argv[3] ?? '')).catch((error) => {
    console.error(error);
    try { closeStore(); } catch { /* ignore */ }
    process.exitCode = 1;
  });
} else {
  run().catch((error) => {
    console.error(error);
    try { closeStore(); } catch { /* ignore */ }
    process.exitCode = 1;
  });
}
