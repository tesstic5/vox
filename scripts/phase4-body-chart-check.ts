import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { commitBatch, get, list, nowIso, type Doc } from '../lib/server/db';
import { createClient } from '../lib/server/clients';
import { persistGeneratedDocument, archiveDocument } from '../lib/server/clinical-documents';
import { createNoteTemplate } from '../lib/server/clinical/templates';
import {
  bodyChartAnnotationConflicts,
  bodyChartAnnotationVersions,
  bodyChartClientExportManifest,
  bodyChartOverlaySvg,
  createBodyChartAnnotation,
  createBodyChartTemplate,
  normaliseBodyChartMarks,
  resolveBodyChartAnnotationConflict,
  updateBodyChartAnnotation,
  verifyBodyChartAnnotationVersion,
  type BodyChartAnnotationDoc,
  type BodyChartAnnotationVersionDoc,
} from '../lib/server/clinical/body-charts';
import {
  amendNote,
  createNote,
  finaliseNote,
  incompleteSections,
  noteById,
  updateNote,
  verifyClinicalNoteVersion,
  type ClinicalNoteVersionDoc,
} from '../lib/server/notes';
import { buildWorkspaceExport } from '../lib/server/workspace-export';

const orgId = 'org_phase4_body_chart';
const actor = 'user_body_chart_clinician';
let assertions = 0;
const check = (condition: unknown, message: string) => { assert.ok(condition, message); assertions += 1; };
const throws = (work: () => unknown, pattern: RegExp, message: string) => { assert.throws(work, pattern, message); assertions += 1; };

async function main() {
commitBatch({ upserts: [{
  collection: 'orgs',
  doc: { id: orgId, name: 'Synthetic body-chart practice', email: 'body-chart@example.test', accountType: 'physiotherapist', createdAt: nowIso() } as Doc,
  expectedRevision: null,
  expectedOrgId: orgId,
}] });
const client = createClient(orgId, { name: 'Synthetic Body Chart Patient', number: '+447700900771' }, actor, { source: 'phase4-body-chart-check' });

const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63606060f80f0001040100c9fe92ef0000000049454e44ae426082', 'hex');
const source = await persistGeneratedDocument({
  orgId, ownerType: 'workspace', ownerId: orgId, title: 'Anterior body chart', category: 'body_chart_test_source',
  originalName: 'anterior.png', mimeType: 'image/png', bytes: png, actor,
});
check(source.document.ownerType === 'workspace' && source.scan.status === 'clean', 'template source is workspace-owned and scanner-clean');

const patientSource = await persistGeneratedDocument({
  orgId, ownerType: 'patient', ownerId: client.id, patientId: client.id, title: 'Patient image', category: 'body_chart_patient_rejection',
  originalName: 'patient.png', mimeType: 'image/png', bytes: png, actor,
});
const rejectedPatientTemplate = createBodyChartTemplate({
  orgId, title: 'Unsafe patient source', sourceDocumentId: patientSource.document.id, sourceDocumentVersionId: patientSource.version.id, actorId: actor,
});
check(!rejectedPatientTemplate.ok && /workspace-owned/.test(rejectedPatientTemplate.error), 'a patient document cannot become a reusable body-chart template');

const templateResult = createBodyChartTemplate({
  orgId, title: 'Anterior body', sourceDocumentId: source.document.id, sourceDocumentVersionId: source.version.id,
  state: 'published', actorId: actor, actorName: 'Synthetic Clinician',
});
assert.equal(templateResult.ok, true);
if (!templateResult.ok) throw new Error('unexpected domain failure');
const chartTemplate = templateResult.value;
check(chartTemplate.coordinateSystem === 'normalised_0_1' && chartTemplate.sourceMimeType === 'image/png', 'published template pins image version and normalised coordinates');
throws(() => archiveDocument({ orgId, id: source.document.id, actor, expectedRevision: source.document.revision }), /pinned by 1 body-chart template/i, 'a pinned template source cannot be archived');

const noteTemplateResult = createNoteTemplate({
  orgId,
  name: 'Body-chart assessment',
  state: 'published',
  sections: [
    { id: 'assessment', label: 'Assessment', kind: 'long_text', required: true },
    { id: 'body_map', label: 'Body map', kind: 'body_chart', required: true },
  ],
  actorId: actor,
  actorName: 'Synthetic Clinician',
});
assert.equal(noteTemplateResult.ok, true);
if (!noteTemplateResult.ok) throw new Error('unexpected domain failure');
const opened = createNote({ orgId, clientId: client.id, templateId: noteTemplateResult.template.id, actor, actorName: 'Synthetic Clinician' });
assert.equal(opened.ok, true);
if (!opened.ok) throw new Error('unexpected domain failure');
check(opened.note.sections.find((row) => row.id === 'body_map')?.kind === 'body_chart', 'the frozen note schema retains its body-chart slot');

const textSections = opened.note.sections.map((row) => ({ ...row, body: row.id === 'assessment' ? 'Clinician-authored factual assessment.' : '' }));
const textSaved = updateNote({ orgId, id: opened.note.id, expectedRevision: opened.note.revision, patch: { sections: textSections }, actor, actorName: 'Synthetic Clinician' });
assert.equal(textSaved.ok, true);
if (!textSaved.ok) throw new Error('unexpected domain failure');
check(incompleteSections(textSaved.note).includes('Body map'), 'a required body-chart slot blocks signing until a chart is linked');
const missingChart = finaliseNote({ orgId, id: opened.note.id, expectedRevision: textSaved.note.revision, signerId: actor, signerName: 'Synthetic Clinician', actor });
check(!missingChart.ok && missingChart.code === 'INCOMPLETE', 'finalisation refuses an empty required chart slot');

const created = createBodyChartAnnotation({
  orgId, noteId: opened.note.id, templateId: chartTemplate.id, sectionId: 'body_map',
  expectedNoteRevision: textSaved.note.revision, marks: [], actorId: actor, actorName: 'Synthetic Clinician',
});
assert.equal(created.ok, true);
if (!created.ok) throw new Error('unexpected domain failure');
let annotation = created.value;
let note = noteById(orgId, opened.note.id)!;
check(note.revision === textSaved.note.revision + 1 && !incompleteSections(note).includes('Body map'), 'adding a chart atomically advances the parent note revision and fills its slot');

const unsafe = normaliseBodyChartMarks([{ id: 'label_unsafe', type: 'label', x: 0.5, y: 0.5, text: '<script>alert(1)</script>', color: '#dc2626' }]);
check(Boolean(unsafe.error), 'script-like label content is refused');
const marks = [
  { id: 'point_1', type: 'point', x: 0.125, y: 0.875, color: '#DC2626', size: 9 },
  { id: 'stroke_1', type: 'stroke', points: [{ x: 0, y: 0 }, { x: 0.25, y: 0.5 }, { x: 1, y: 1 }], color: '#2563eb', width: 4 },
  { id: 'label_1', type: 'label', x: 0.55, y: 0.45, text: 'Tender area & review', color: '#059669' },
] as const;
const saved = updateBodyChartAnnotation({
  orgId, id: annotation.id, expectedRevision: annotation.revision, expectedNoteRevision: note.revision,
  marks, actorId: actor, actorName: 'Synthetic Clinician',
});
assert.equal(saved.ok, true);
if (!saved.ok) throw new Error('unexpected domain failure');
annotation = saved.value;
note = noteById(orgId, opened.note.id)!;
check(annotation.marks[0].type === 'point' && annotation.marks[0].x === 0.125 && annotation.marks[1].type === 'stroke' && annotation.marks[1].points[2].x === 1, 'normalised point and stroke coordinates round-trip exactly');
check(annotation.marks[0].type === 'point' && annotation.marks[0].color === '#dc2626', 'safe colours are canonicalised');
const svg = bodyChartOverlaySvg(annotation);
check(svg.includes('Tender area &amp; review') && !svg.includes('<script') && !svg.includes('href='), 'overlay SVG escapes label text and contains no script or external content');

const losingMarks = [{ id: 'point_loser', type: 'point', x: 0.9, y: 0.1, color: '#111111', size: 8 }];
const stale = updateBodyChartAnnotation({
  orgId, id: annotation.id, expectedRevision: created.value.revision, expectedNoteRevision: created.value.revision,
  marks: losingMarks, actorId: 'user_other_clinician', actorName: 'Other Clinician',
});
check(!stale.ok && stale.code === 'CONFLICT' && Boolean(stale.conflictId), 'a stale annotation is refused instead of last-write-wins');
let conflicts = bodyChartAnnotationConflicts(orgId, opened.note.id);
check(conflicts.length === 1 && conflicts[0].marks[0].id === 'point_loser', 'the losing annotation set is preserved for explicit reconciliation');
const blockedByConflict = finaliseNote({ orgId, id: note.id, expectedRevision: note.revision, signerId: actor, signerName: 'Synthetic Clinician', actor });
check(!blockedByConflict.ok && blockedByConflict.code === 'CONFLICT', 'an unresolved body-chart conflict blocks finalisation');

const resolved = resolveBodyChartAnnotationConflict({
  orgId, annotationId: annotation.id, conflictId: conflicts[0].id, expectedRevision: annotation.revision,
  expectedNoteRevision: note.revision, resolution: 'keep_current', actorId: actor, actorName: 'Synthetic Clinician',
});
assert.equal(resolved.ok, true);
if (!resolved.ok) throw new Error('unexpected domain failure');
annotation = resolved.value;
note = noteById(orgId, opened.note.id)!;
conflicts = bodyChartAnnotationConflicts(orgId, opened.note.id);
check(conflicts.length === 0 && annotation.marks.some((row) => row.id === 'point_1'), 'explicit reconciliation keeps the selected current set and clears only that conflict');

const signed = finaliseNote({ orgId, id: note.id, expectedRevision: note.revision, signerId: actor, signerName: 'Synthetic Clinician', actor });
assert.equal(signed.ok, true);
if (!signed.ok) throw new Error('unexpected domain failure');
annotation = get<BodyChartAnnotationDoc>('bodyChartAnnotations', annotation.id)!;
const v1 = bodyChartAnnotationVersions(orgId, note.id)[0];
const noteV1 = get<ClinicalNoteVersionDoc>('clinicalNoteVersions', `${note.id}_signed_v1`)!;
check(annotation.status === 'final' && annotation.lastSnapshotHash === v1.contentHash && verifyBodyChartAnnotationVersion(v1), 'note signing atomically finalises a verified immutable chart snapshot');
check(noteV1.bodyCharts?.[0]?.contentHash === v1.contentHash && verifyClinicalNoteVersion(noteV1), 'signed note hash binds the exact chart snapshot hash');
throws(() => commitBatch({ upserts: [{ collection: 'bodyChartAnnotationVersions', doc: { ...v1, marks: [] }, expectedRevision: v1.revision, expectedOrgId: orgId }] }), /append-only/i, 'chart snapshots are append-only through the document API');

const amended = amendNote({ orgId, id: note.id, expectedRevision: signed.note.revision, reason: 'Clinician-authored chart clarification', actor, actorName: 'Synthetic Clinician' });
assert.equal(amended.ok, true);
if (!amended.ok) throw new Error('unexpected domain failure');
annotation = get<BodyChartAnnotationDoc>('bodyChartAnnotations', annotation.id)!;
check(amended.note.version === 2 && annotation.status === 'draft' && annotation.noteVersion === 2, 'amendment preserves v1 and opens the chart at note v2');
const v2Saved = updateBodyChartAnnotation({
  orgId, id: annotation.id, expectedRevision: annotation.revision, expectedNoteRevision: amended.note.revision,
  marks: [...annotation.marks, { id: 'point_v2', type: 'point', x: 0.4, y: 0.6, color: '#7c3aed', size: 8 }],
  actorId: actor, actorName: 'Synthetic Clinician',
});
assert.equal(v2Saved.ok, true);
if (!v2Saved.ok) throw new Error('unexpected domain failure');
note = noteById(orgId, note.id)!;
const resigned = finaliseNote({ orgId, id: note.id, expectedRevision: note.revision, signerId: actor, signerName: 'Synthetic Clinician', actor });
assert.equal(resigned.ok, true);
if (!resigned.ok) throw new Error('unexpected domain failure');
const chartHistory = bodyChartAnnotationVersions(orgId, note.id);
check(chartHistory.length === 2 && chartHistory[0].previousHash === chartHistory[1].contentHash && chartHistory.every(verifyBodyChartAnnotationVersion), 'amended chart snapshot chains to the previous verified SHA-256 hash');

const patientExport = bodyChartClientExportManifest(orgId, client.id);
check(patientExport.annotations.length === 1 && patientExport.versions.length === 2 && patientExport.sourceDocumentIds.includes(source.document.id), 'client export contains structured charts, signed versions and pinned source references');
const workspaceExport = buildWorkspaceExport(orgId, actor);
const exportedVersions = workspaceExport.collections.bodyChartAnnotationVersions as unknown as BodyChartAnnotationVersionDoc[];
check(exportedVersions.length === 2 && exportedVersions.every((row) => /^[a-f0-9]{64}$/.test(row.contentHash)), 'workspace export retains chart integrity hashes rather than redacting them');

const sqlitePath = `${process.env.VOXERA_DATA_DIR}/voxera-db.sqlite`;
const sqlite = new Database(sqlitePath);
const migration = sqlite.prepare("SELECT checksum FROM schema_migrations WHERE id = '20260920_013_phase4_body_chart_evidence'").get() as { checksum?: string } | undefined;
check(Boolean(migration?.checksum && /^[a-f0-9]{64}$/.test(migration.checksum)), 'SQLite migration 013 is checksummed and applied');
throws(() => sqlite.prepare("UPDATE docs SET body = json_set(body, '$.marks', json('[]')) WHERE collection = 'bodyChartAnnotations' AND id = ?").run(annotation.id), /final body-chart annotations are immutable/i, 'SQLite guard rejects direct final chart-content mutation');
throws(() => sqlite.prepare("DELETE FROM docs WHERE collection = 'bodyChartAnnotationVersions' AND id = ?").run(v1.id), /append-only/i, 'SQLite guard rejects direct chart-snapshot deletion');
throws(() => sqlite.prepare("UPDATE docs SET body = json_set(body, '$.sourceDocumentVersionId', 'tampered') WHERE collection = 'bodyChartTemplates' AND id = ?").run(chartTemplate.id), /published body-chart template source is immutable/i, 'SQLite guard rejects direct published-template source mutation');
sqlite.close();

console.log(`Phase 4 body-chart domain check passed: ${assertions} assertions`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
