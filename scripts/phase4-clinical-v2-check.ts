import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { commitBatch, get, list, nowIso, type Doc } from '../lib/server/db';
import { createClient } from '../lib/server/clients';
import {
  amendNote,
  createNote,
  finaliseNote,
  noteDraftConflicts,
  resolveNoteDraftConflict,
  seedNoteTemplatesForOrg,
  updateNote,
  verifyClinicalNoteVersion,
  versionHistory,
  type ClinicalNoteVersionDoc,
} from '../lib/server/notes';
import {
  noteTemplateByIdV2,
  noteTemplateVersions,
  noteTemplatesV2,
  reviseNoteTemplate,
} from '../lib/server/clinical/templates';

const orgId = 'org_phase4_clinical_v2';
const actor = 'user_phase4_clinician';
let assertions = 0;
const check = (condition: unknown, message: string) => { assert.ok(condition, message); assertions += 1; };
const throws = (work: () => unknown, pattern: RegExp, message: string) => { assert.throws(work, pattern, message); assertions += 1; };

commitBatch({ upserts: [{
  collection: 'orgs',
  doc: { id: orgId, name: 'Phase 4 synthetic allied-health practice', email: 'phase4@example.test', accountType: 'physiotherapist', createdAt: nowIso() } as Doc,
  expectedRevision: null,
  expectedOrgId: orgId,
}] });
const client = createClient(orgId, { name: 'Synthetic Patient', number: '+447700900444', email: 'synthetic.patient@example.test' }, actor, { source: 'phase4-check' });

const seeded = seedNoteTemplatesForOrg(orgId);
check(seeded.seeded >= 1, 'a versioned general note template is seeded');
const template = noteTemplatesV2(orgId)[0];
check(Boolean(template && template.currentVersion === 1 && template.revision >= 1), 'template envelope starts at version 1 with an optimistic revision');
const version1 = noteTemplateVersions(orgId, template.id)[0];
check(version1.version === 1 && version1.sections.length > 0 && version1.provenance === 'seed', 'template version 1 is a complete immutable schema');

const opened = createNote({ orgId, clientId: client.id, templateId: template.id, actor, actorName: 'Synthetic Clinician' });
assert.equal(opened.ok, true);
if (!opened.ok) throw new Error('unexpected domain failure');
check(opened.note.templateVersion === 1 && opened.note.templateVersionId === version1.id && opened.note.revision === 1, 'new note binds to exact immutable template version 1');

const revised = reviseNoteTemplate({
  orgId,
  templateId: template.id,
  expectedRevision: template.revision,
  name: `${template.name} revised`,
  sections: [...template.sections, { id: 'review', label: 'Review', prompt: 'Clinician-authored review', kind: 'long_text', required: false }],
  changeReason: 'Add an explicit review section',
  actorId: actor,
  actorName: 'Synthetic Clinician',
});
assert.equal(revised.ok, true);
if (!revised.ok) throw new Error('unexpected domain failure');
check(revised.template.currentVersion === 2 && noteTemplateVersions(orgId, template.id).length === 2, 'revising creates version 2 and retains version 1');
check(opened.note.templateVersion === 1 && !opened.note.sections.some((section) => section.id === 'review'), 'an existing draft is not rewritten when its template advances');
check(noteTemplateVersions(orgId, template.id).find((version) => version.version === 1)?.sections.length === version1.sections.length, 'template version 1 section meaning remains unchanged');

const firstSections = opened.note.sections.map((section) => ({ ...section, body: `First draft text for ${section.label}` }));
const firstSave = updateNote({ orgId, id: opened.note.id, expectedRevision: opened.note.revision, patch: { sections: firstSections }, actor, actorName: 'Clinician A' });
assert.equal(firstSave.ok, true);
if (!firstSave.ok) throw new Error('unexpected domain failure');
check(firstSave.note.revision === 2, 'draft save advances the note revision');

const staleSections = opened.note.sections.map((section) => ({ ...section, body: `Concurrent draft text for ${section.label}` }));
const staleSave = updateNote({ orgId, id: opened.note.id, expectedRevision: opened.note.revision, patch: { sections: staleSections }, actor: 'user_phase4_other', actorName: 'Clinician B' });
check(!staleSave.ok && staleSave.code === 'CONFLICT' && Boolean(staleSave.conflictId), 'stale clinical text is refused instead of last-write-wins');
const conflicts = noteDraftConflicts(orgId, opened.note.id);
check(conflicts.length === 1 && conflicts[0].sections[0].body.startsWith('Concurrent draft'), 'the losing concurrent draft is preserved for reconciliation');

const resolved = resolveNoteDraftConflict({
  orgId,
  noteId: opened.note.id,
  conflictId: conflicts[0].id,
  resolution: 'keep_current',
  expectedRevision: firstSave.note.revision,
  actor,
  actorName: 'Synthetic Clinician',
});
assert.equal(resolved.ok, true);
if (!resolved.ok) throw new Error('unexpected domain failure');
check(noteDraftConflicts(orgId, opened.note.id).length === 0 && resolved.note.body.includes('First draft'), 'a clinician explicitly keeps one draft and clears the conflict');

const incomplete = createNote({ orgId, clientId: client.id, templateId: template.id, actor, actorName: 'Synthetic Clinician' });
assert.equal(incomplete.ok, true);
if (!incomplete.ok) throw new Error('unexpected domain failure');
const blocked = finaliseNote({ orgId, id: incomplete.note.id, expectedRevision: incomplete.note.revision, signerId: actor, signerName: 'Synthetic Clinician', actor });
check(!blocked.ok && blocked.code === 'INCOMPLETE', 'required blank sections block finalisation');

const signed = finaliseNote({ orgId, id: resolved.note.id, expectedRevision: resolved.note.revision, signerId: actor, signerName: 'Synthetic Clinician', actor });
assert.equal(signed.ok, true);
if (!signed.ok) throw new Error('unexpected domain failure');
check(signed.note.status === 'final' && signed.note.signedHash?.length === 64 && signed.note.lastFinalisedVersion === 1, 'finalisation records signer, version and SHA-256 evidence');
const snapshots = list<ClinicalNoteVersionDoc>('clinicalNoteVersions', (row) => row.orgId === orgId && row.noteId === signed.note.id);
check(snapshots.length === 1 && verifyClinicalNoteVersion(snapshots[0]), 'signed content is stored as a verified append-only snapshot');
check(versionHistory(orgId, signed.note.id)[0].integrity === 'verified', 'version history verifies the signed snapshot before presenting it');

const rejectedEdit = updateNote({ orgId, id: signed.note.id, expectedRevision: signed.note.revision, patch: { sections: staleSections }, actor, actorName: 'Synthetic Clinician' });
check(!rejectedEdit.ok && rejectedEdit.code === 'FINALISED', 'a final note cannot be edited through the domain');
throws(() => commitBatch({ upserts: [{ collection: 'clinicalNoteVersions', doc: { ...snapshots[0], body: 'tampered' }, expectedRevision: snapshots[0].revision, expectedOrgId: orgId }] }), /append-only/i, 'signed snapshot cannot be changed through the document API');
throws(() => commitBatch({ upserts: [{ collection: 'noteTemplateVersions', doc: { ...version1, name: 'tampered' }, expectedRevision: version1.revision, expectedOrgId: orgId }] }), /append-only/i, 'template version cannot be changed through the document API');

const amended = amendNote({ orgId, id: signed.note.id, expectedRevision: signed.note.revision, reason: 'Correct wording after clinician review', actor, actorName: 'Synthetic Clinician' });
assert.equal(amended.ok, true);
if (!amended.ok) throw new Error('unexpected domain failure');
check(amended.note.status === 'draft' && amended.note.version === 2 && versionHistory(orgId, signed.note.id)[0].contentHash === signed.note.signedHash, 'amendment opens version 2 while preserving version 1 evidence');
const v2Sections = amended.note.sections.map((section) => ({ ...section, body: `Amended clinician text for ${section.label}` }));
const v2Saved = updateNote({ orgId, id: amended.note.id, expectedRevision: amended.note.revision, patch: { sections: v2Sections }, actor, actorName: 'Synthetic Clinician' });
assert.equal(v2Saved.ok, true);
if (!v2Saved.ok) throw new Error('unexpected domain failure');
const resigned = finaliseNote({ orgId, id: v2Saved.note.id, expectedRevision: v2Saved.note.revision, signerId: actor, signerName: 'Synthetic Clinician', actor });
assert.equal(resigned.ok, true);
if (!resigned.ok) throw new Error('unexpected domain failure');
const history = versionHistory(orgId, resigned.note.id);
check(history.length === 2 && history[0].version === 2 && history[1].version === 1, 're-finalising leaves both signed versions in newest-first history');
check(history[0].previousHash === history[1].contentHash && history.every((version) => version.integrity === 'verified'), 'amended signature chains to the previous verified hash');

const sqlitePath = `${process.env.VOXERA_DATA_DIR}/voxera-db.sqlite`;
const sqlite = new Database(sqlitePath);
throws(
  () => sqlite.prepare("UPDATE docs SET body = json_set(body, '$.body', ?) WHERE collection = 'notes' AND id = ?").run('direct SQL tamper', resigned.note.id),
  /final clinical-note content and signature are immutable/i,
  'SQLite guard rejects direct final-note content mutation',
);
throws(
  () => sqlite.prepare("DELETE FROM docs WHERE collection = 'clinicalNoteVersions' AND id = ?").run(snapshots[0].id),
  /append-only/i,
  'SQLite guard rejects direct signed-snapshot deletion',
);
throws(
  () => sqlite.prepare("UPDATE docs SET body = json_set(body, '$.name', 'direct SQL tamper') WHERE collection = 'noteTemplateVersions' AND id = ?").run(version1.id),
  /append-only/i,
  'SQLite guard rejects direct template-version mutation',
);
sqlite.close();

const currentTemplate = noteTemplateByIdV2(orgId, template.id);
check(currentTemplate?.currentVersion === 2 && get<ClinicalNoteVersionDoc>('clinicalNoteVersions', `${signed.note.id}_signed_v1`)?.contentHash === signed.note.signedHash, 'template and signed-note evidence remain readable after direct-SQL attempts');

console.log(`Phase 4 clinical v2 domain check passed: ${assertions} assertions`);
