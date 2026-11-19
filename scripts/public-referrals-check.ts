import assert from 'node:assert/strict';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  closeStore, commitBatch, insert, list, nowIso, type Doc,
} from '../lib/server/db';
import { createFormTemplate, reviseFormTemplate, setFormTemplateState } from '../lib/server/forms';
import {
  activePublicReferralDraft,
  completePublicReferralUpload,
  createPublicReferralDraft,
  createReferralForm,
  publicReferralForm,
  referralFormById,
  referralFormSubmissionById,
  referralSubmissionEvidenceState,
  savePublicReferralDraft,
  submitPublicReferral,
  updateReferralForm,
} from '../lib/server/referral-forms';
import { convertReferralToClient, referralById, transitionReferral } from '../lib/server/referrals';
import { documentById } from '../lib/server/clinical-documents';

process.env.VOXERA_DOCUMENT_MASTER_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

async function main() {
  assert.equal(process.env.VOXERA_STORE, 'sqlite', 'run with VOXERA_STORE=sqlite');
  assert.ok(process.env.VOXERA_DATA_DIR, 'run with an isolated VOXERA_DATA_DIR');
  let checks = 0;
  const check = (condition: unknown, label: string) => { assert.ok(condition, label); checks += 1; };
  const throws = (work: () => unknown, pattern: RegExp, label: string) => { assert.throws(work, pattern, label); checks += 1; };
  const rejects = async (work: () => Promise<unknown>, pattern: RegExp, label: string) => { await assert.rejects(work, pattern, label); checks += 1; };

  const orgA = 'org_public_referral_a';
  const orgB = 'org_public_referral_b';
  const actor = 'referral-admin@voxera.test';
  insert<Doc>('orgs', { id: orgA, name: 'Synthetic Referral Practice A', createdAt: nowIso() });
  insert<Doc>('orgs', { id: orgB, name: 'Synthetic Referral Practice B', createdAt: nowIso() });

  const schema = {
    version: 1 as const,
    title: 'Synthetic allied-health referral',
    description: 'Synthetic evidence only.',
    fields: [
      { id: 'patient_name', key: 'patient_name', label: 'Patient name', type: 'text' as const, required: true },
      { id: 'date_of_birth', key: 'date_of_birth', label: 'Date of birth', type: 'date' as const, required: true },
      { id: 'patient_email', key: 'patient_email', label: 'Patient email', type: 'text' as const },
      { id: 'referral_reason', key: 'referral_reason', label: 'Reason for referral', type: 'long_text' as const, required: true },
      { id: 'claimed_urgency', key: 'claimed_urgency', label: 'Requested speed', type: 'single_choice' as const, options: [{ value: 'urgent', label: 'Urgent' }, { value: 'routine', label: 'Routine' }] },
      { id: 'referrer_name', key: 'referrer_name', label: 'Referrer name', type: 'text' as const },
      { id: 'referrer_org', key: 'referrer_org', label: 'Referrer organisation', type: 'text' as const },
      { id: 'consent', key: 'consent', label: 'I confirm permission to send this referral', type: 'acknowledgement' as const, required: true },
      { id: 'evidence', key: 'evidence', label: 'Supporting evidence', type: 'file' as const },
    ],
  };
  const created = createFormTemplate({ orgId: orgA, actor, name: schema.title, category: 'referral', schema });
  const published = setFormTemplateState({ orgId: orgA, id: created.template.id, state: 'published', actor, expectedRevision: created.template.revision });
  throws(() => createReferralForm({
    orgId: orgA, actor, name: 'Bad slug', slug: '../bad', templateId: published.id,
    mapping: { patientName: 'patient_name', reason: 'referral_reason' },
    privacyNotice: 'This is a sufficiently long privacy notice.', emergencyNotice: 'This is a sufficiently long emergency notice.',
  }), /slug/i, 'unsafe public slugs should be refused');
  throws(() => createReferralForm({
    orgId: orgA, actor, name: 'Unknown route', slug: 'unknown-route', templateId: published.id,
    mapping: { patientName: 'patient_name', reason: 'referral_reason' }, routing: { priority: 'routine', teamId: 'voice-squad' } as never,
    privacyNotice: 'This is a sufficiently long privacy notice.', emergencyNotice: 'This is a sufficiently long emergency notice.',
  }), /unsupported referral routing/i, 'voice-agent squads or unknown routing properties must not be accepted as clinical routing');
  throws(() => createReferralForm({
    orgId: orgA, actor, name: 'Unknown mapping', slug: 'unknown-mapping', templateId: published.id,
    mapping: { patientName: 'patient_name', reason: 'referral_reason', invented: 'patient_email' } as never,
    privacyNotice: 'This is a sufficiently long privacy notice.', emergencyNotice: 'This is a sufficiently long emergency notice.',
  }), /unsupported referral field mapping/i, 'unknown field mappings should fail closed');

  const form = createReferralForm({
    orgId: orgA, actor, name: 'Website referral', slug: 'synthetic-physio-referral', templateId: published.id,
    mapping: {
      patientName: 'patient_name', dateOfBirth: 'date_of_birth', email: 'patient_email', reason: 'referral_reason',
      consent: 'consent', referrerName: 'referrer_name', referrerOrganisation: 'referrer_org',
    },
    routing: { priority: 'routine' },
    privacyNotice: 'Synthetic information is used only to verify the referral workflow and is never real patient data.',
    emergencyNotice: 'This form is not monitored continuously and must not be used for urgent or emergency concerns.',
    completionMessage: 'The synthetic referral has been received for administrative review.', active: true,
  });
  check(publicReferralForm(form.slug)?.version.version === 1, 'an active public form should resolve its pinned published schema');
  check(!Object.prototype.hasOwnProperty.call(form, 'token'), 'referral configuration must not contain a bearer token');
  throws(() => createReferralForm({
    orgId: orgB, actor, name: 'Cross-tenant collision', slug: form.slug, templateId: 'irrelevant', mapping: {},
    privacyNotice: 'This is a sufficiently long privacy notice.', emergencyNotice: 'This is a sufficiently long emergency notice.',
  }), /already in use/i, 'public slugs should be globally unique before tenant template lookup');

  const draft = createPublicReferralDraft({ slug: form.slug });
  check(draft.token.startsWith('rrd_') && !JSON.stringify(draft.submission).includes(draft.token), 'opaque draft tokens should be returned once and stored only as a hash');
  check(Date.parse(draft.submission.expiresAt) > Date.now() + 23 * 60 * 60_000, 'public referral drafts should expire after roughly 24 hours');
  const partial = await savePublicReferralDraft({ slug: form.slug, token: draft.token, answers: { patient_name: 'Synthetic Person' } });
  check(partial.status === 'draft' && partial.answers?.patient_name === 'Synthetic Person', 'partial public referral answers should save against the opaque draft');
  await rejects(() => savePublicReferralDraft({ slug: form.slug, token: draft.token, answers: { patient_name: 'Synthetic Person', unknown: 'injected' } }), /Unknown form answer/i, 'answer injection should be rejected');
  await rejects(() => submitPublicReferral({ slug: form.slug, token: draft.token, answers: {
    patient_name: 'Synthetic Person', date_of_birth: '2026-02-30', referral_reason: 'Synthetic reason', consent: true,
  } }), /valid date/i, 'rolled-over calendar dates should be rejected before referral creation');
  await rejects(() => submitPublicReferral({ slug: form.slug, token: draft.token, answers: {
    patient_name: 'Synthetic Person', date_of_birth: '1990-02-20', referral_reason: 'Synthetic reason', consent: false,
  } }), /acknowledged|consent/i, 'mapped consent must be positively acknowledged');

  const pdf = Buffer.from('%PDF-1.4\n% synthetic public referral evidence\n%%EOF\n');
  const uploaded = await completePublicReferralUpload({ slug: form.slug, token: draft.token, fieldKey: 'evidence', bytes: pdf, mimeType: 'application/pdf', originalName: 'synthetic-evidence.pdf' });
  check(uploaded.submission.documentIds.length === 1 && uploaded.submission.documentIds[0] === uploaded.document.id, 'completed uploads should be registered atomically on the draft');
  const document = documentById(orgA, uploaded.document.id);
  check(document?.ownerType === 'referral_submission' && document.ownerId === draft.submission.id && !document.patientId, 'pre-patient attachments should have exact submission ownership and no invented patient link');

  const other = createPublicReferralDraft({ slug: form.slug });
  await rejects(() => savePublicReferralDraft({ slug: form.slug, token: other.token, answers: { evidence: [uploaded.document.id] } }), /do not match/i, 'one draft must not adopt another draft’s document reference');
  await rejects(() => submitPublicReferral({ slug: form.slug, token: draft.token, answers: {
    patient_name: 'Synthetic Person', date_of_birth: '1990-02-20', referral_reason: 'Synthetic reason', consent: true,
  } }), /do not match/i, 'submission must not silently omit a registered attachment');

  const answers = {
    patient_name: 'Synthetic Person', date_of_birth: '1990-02-20', patient_email: 'PERSON@EXAMPLE.TEST',
    referral_reason: '<script>not executable</script> Persistent synthetic shoulder pain', claimed_urgency: 'urgent',
    referrer_name: 'Synthetic Referrer', referrer_org: 'Synthetic Clinic', consent: true, evidence: [uploaded.document.id],
  };
  const saved = await savePublicReferralDraft({ slug: form.slug, token: draft.token, answers });
  check(saved.answers?.referral_reason === answers.referral_reason, 'draft evidence should preserve entered text without rendering or executing it server-side');
  const submitted = await submitPublicReferral({ slug: form.slug, token: draft.token, answers, ip: '192.0.2.40' });
  check(submitted.referral.source === 'secure_form' && submitted.referral.referralFormId === form.id && submitted.referral.referralFormSubmissionId === draft.submission.id, 'submitted referrals should retain public-form provenance');
  check(submitted.referral.patient.email === 'person@example.test' && submitted.referral.referrer?.organisation === 'Synthetic Clinic', 'mapped patient and referrer fields should be normalised into the referral');
  check(submitted.referral.priority === 'routine', 'an untrusted urgency answer must not override configured queue priority');
  check(submitted.referral.documentIds[0] === uploaded.document.id && submitted.submission.answersHash?.length === 64, 'submitted evidence should pin attachment ids and an answer integrity hash');
  check(referralSubmissionEvidenceState(orgA, submitted.submission.id).verified, 'submitted answer and schema hashes should verify on read');
  check(referralById(orgA, submitted.referral.id)?.status === 'received', 'a public submission should create one received referral for staff review');
  await rejects(() => submitPublicReferral({ slug: form.slug, token: draft.token, answers }), /already submitted/i, 'double submit should fail without creating another referral');
  check(list<Doc>('referrals', (row) => row.referralFormSubmissionId === draft.submission.id).length === 1, 'one public draft should own exactly one referral aggregate');
  throws(() => commitBatch({ upserts: [{ collection: 'referralFormSubmissions', doc: { ...submitted.submission, answers: { tampered: true } }, expectedRevision: submitted.submission.revision, expectedOrgId: orgA }] }), /immutable submitted evidence/i, 'submitted referral answers should be immutable at the storage boundary');
  const accepted = transitionReferral({ orgId: orgA, id: submitted.referral.id, to: 'accepted', actor, expectedRevision: submitted.referral.revision, note: 'Synthetic administrative acceptance' });
  const converted = convertReferralToClient({ orgId: orgA, id: accepted.id, actor, expectedRevision: accepted.revision });
  const linkedDocument = documentById(orgA, uploaded.document.id);
  check(converted.referral.status === 'converted' && linkedDocument?.patientId === converted.client.id, 'patient conversion should atomically link pre-patient referral attachments to the resulting patient');
  check(list<Doc>('documentLinks', (row) => row.documentId === uploaded.document.id).every((row) => row.patientId === converted.client.id), 'all referral attachment links should gain the converted patient id');

  const revised = reviseFormTemplate({ orgId: orgA, id: published.id, actor, expectedRevision: published.revision, schema: { ...schema, description: 'A revised schema.' } });
  const republished = setFormTemplateState({ orgId: orgA, id: revised.template.id, state: 'published', actor, expectedRevision: revised.template.revision });
  check(publicReferralForm(form.slug)?.version.version === 1 && republished.publishedVersion === 2, 'publishing a later template version must not silently move an existing public address');
  const repinned = updateReferralForm({ orgId: orgA, id: form.id, expectedRevision: referralFormById(orgA, form.id)!.revision, actor, patch: { templateId: form.templateId } });
  check(repinned.templateVersion === 2, 'an explicit referral-form update should repin the newly published version');
  throws(() => updateReferralForm({ orgId: orgA, id: form.id, expectedRevision: repinned.revision - 1, actor, patch: { active: false } }), /changed after/i, 'stale administration writes should fail');
  const disabled = updateReferralForm({ orgId: orgA, id: form.id, expectedRevision: repinned.revision, actor, patch: { active: false } });
  check(!publicReferralForm(form.slug) && !activePublicReferralDraft({ slug: form.slug, token: other.token }), 'disabling a public address should stop issuance and draft resume without deleting submitted evidence');
  check(referralFormSubmissionById(orgA, submitted.submission.id)?.status === 'submitted' && referralById(orgA, submitted.referral.id)?.status === 'converted', 'disable rollback should preserve submitted referral evidence');

  const forcedSlug: Doc = { ...disabled, id: 'rff_forced_slug', revision: 0 };
  throws(() => commitBatch({ upserts: [{ collection: 'referralForms', doc: forcedSlug, expectedRevision: null, expectedOrgId: orgA }] }), /constraint|unique/i, 'database uniqueness should close concurrent public-slug creation');
  const forcedToken: Doc = { ...submitted.submission, id: 'rfs_forced_token', referralId: undefined, revision: 0 };
  throws(() => commitBatch({ upserts: [{ collection: 'referralFormSubmissions', doc: forcedToken, expectedRevision: null, expectedOrgId: orgA }] }), /constraint|unique/i, 'database uniqueness should close opaque-token collisions');
  const forcedReferral: Doc = { ...submitted.referral, id: 'ref_forced_submission', revision: 0 };
  throws(() => commitBatch({ upserts: [{ collection: 'referrals', doc: forcedReferral, expectedRevision: null, expectedOrgId: orgA }] }), /constraint|unique/i, 'database uniqueness should enforce one referral per public submission');

  const db = new Database(path.join(process.env.VOXERA_DATA_DIR!, 'voxera-db.sqlite'));
  const persistedSubmission = db.prepare("SELECT body FROM docs WHERE collection = 'referralFormSubmissions' AND id = ?").get(submitted.submission.id) as { body: string };
  assert.throws(() => db.prepare("UPDATE docs SET body = ? WHERE collection = 'referralFormSubmissions' AND id = ?").run(persistedSubmission.body, submitted.submission.id), /immutable/i, 'database trigger should reject direct submitted-evidence updates');
  checks += 1;
  const indexes = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((row) => row.name));
  for (const name of ['docs_referral_form_slug', 'docs_referral_submission_token', 'docs_referral_submission_referral', 'docs_referral_form_state', 'docs_referral_submission_queue']) {
    check(indexes.has(name), `schema migration should create ${name}`);
  }
  const migration = db.prepare("SELECT checksum FROM schema_migrations WHERE id = '20260920_009_public_referral_forms'").get() as { checksum?: string } | undefined;
  check(migration?.checksum?.length === 64, 'public referral schema migration should be checksummed and applied');
  db.close();

  closeStore();
  console.log(`public-referrals-check: ${checks} assertions passed`);
}

void main().catch((error) => {
  console.error(error);
  try { closeStore(); } catch { /* ignore */ }
  process.exitCode = 1;
});
