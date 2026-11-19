import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  commitBatch, get, insert, list, nowIso, type Doc,
} from '../lib/server/db';
import { runPhase1DataMigrations, dataMigrationStates } from '../lib/server/data-migrations';
import { validateFormSchema } from '../lib/forms-schema';
import {
  createFormAssignment, createFormTemplate, formResponseVersion, formResponsesFor,
  reviewUpdateSuggestion, savePublicForm, setFormTemplateState, updateSuggestionsFor,
} from '../lib/server/forms';
import { createClient, clientById, updateClient } from '../lib/server/clients';
import {
  addReferralRiskFlag, convertReferralToClient, createReferral, queueReferralNotification,
  referralEventsFor, referralNotificationsFor, transitionReferral,
} from '../lib/server/referrals';
import {
  createLetter, createLetterCorrection, createLetterTemplate, letterById, letterPdf,
  letterVersion, queueLetterEmail, reviseLetter, setLetterTemplateState, transitionLetter,
} from '../lib/server/letters';
import { deliverDueMessages, setMessageTransport, type MessageDoc } from '../lib/server/messages';
import { blobStore } from '../lib/server/blob-store';
import { PERMISSIONS, systemRoleId, type RoleDoc } from '../lib/server/permissions';
import type { AutomationEventDoc } from '../lib/server/automations/events';
import { runDueDomainJobs, type DomainJobDoc } from '../lib/server/domain-jobs';

process.env.VOXERA_DOCUMENT_MASTER_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

async function main() {
const orgId = 'org_phase3_check';
const actor = 'phase3-check@voxera.test';
let checks = 0;
const check = (condition: unknown, message: string) => { assert.ok(condition, message); checks += 1; };
const throws = (work: () => unknown, pattern: RegExp, message: string) => {
  assert.throws(work, pattern, message); checks += 1;
};

insert<Doc>('orgs', { id: orgId, name: 'Phase 3 Test Practice', email: 'practice@example.test', createdAt: nowIso() });
runPhase1DataMigrations(orgId);
check(dataMigrationStates(orgId).every((row) => row.status === 'completed'), 'all checksummed data migrations should complete');
const practitionerRole = get<RoleDoc>('roles', systemRoleId(orgId, 'practitioner'));
check(Boolean(practitionerRole?.permissions.includes('forms.review') && practitionerRole.permissions.includes('referrals.triage') && practitionerRole.permissions.includes('letters.approve')), 'system role migration should include workflow permissions');
check(PERMISSIONS.includes('letters.send'), 'permission catalogue should include controlled correspondence delivery');

throws(() => validateFormSchema({ version: 1, title: 'Cycle', fields: [
  { id: 'field_a', key: 'field_a', label: 'A', type: 'text', condition: { op: 'answered', field: 'field_b' } },
  { id: 'field_b', key: 'field_b', label: 'B', type: 'text', condition: { op: 'answered', field: 'field_a' } },
] }), /cycle/i, 'cyclic conditional fields must be rejected');

const client = createClient(orgId, { name: 'Alex Example', number: '+447700900001', email: 'alex@example.test', dateOfBirth: '1990-04-14' }, actor, { source: 'phase3-check' });
const formCreated = createFormTemplate({
  orgId, actor, name: 'Initial assessment', category: 'intake',
  schema: {
    version: 1, title: 'Initial assessment', fields: [
      { id: 'preferred_name', key: 'preferred_name', label: 'Preferred name', type: 'text', required: true, sensitivity: 'administrative', updateTarget: 'name' },
      { id: 'pain', key: 'pain', label: 'Are you in pain?', type: 'yes_no', required: true, sensitivity: 'clinical' },
      { id: 'pain_detail', key: 'pain_detail', label: 'Describe the pain', type: 'long_text', required: true, sensitivity: 'clinical', condition: { op: 'equals', field: 'pain', value: true } },
      { id: 'consent', key: 'consent', label: 'I confirm this is accurate', type: 'acknowledgement', required: true, sensitivity: 'clinical' },
    ],
  },
});
const publishedForm = setFormTemplateState({ orgId, id: formCreated.template.id, state: 'published', actor, expectedRevision: formCreated.template.revision });
const assignment = createFormAssignment({ orgId, templateId: publishedForm.id, clientId: client.id, actor });
check(!JSON.stringify(assignment.assignment).includes(assignment.token), 'form token must be stored only as a hash');
throws(() => savePublicForm({ token: assignment.token, answers: { preferred_name: 'Alex E', pain: false, pain_detail: 'hidden answer', consent: true }, submit: true }), /Hidden field/, 'hidden answers must be rejected');
const savedDraft = savePublicForm({ token: assignment.token, answers: { preferred_name: 'Alex E' }, submit: false });
check(savedDraft.response.status === 'in_progress', 'partial responses should save as in progress');
const submitted = savePublicForm({ token: assignment.token, answers: { preferred_name: 'Alex E', pain: false, consent: true }, submit: true, respondent: { relationship: 'self' }, ip: '192.0.2.1' });
check(submitted.response.status === 'submitted' && submitted.version.status === 'submitted', 'a valid response should submit atomically');
check(formResponseVersion(orgId, submitted.response.id)?.answersHash.length === 64, 'response versions should carry an integrity hash');
check(clientById(orgId, client.id)?.name === 'Alex Example', 'submitted demographics must not overwrite the patient automatically');
const suggestion = updateSuggestionsFor(orgId, { status: 'pending', clientId: client.id })[0];
check(Boolean(suggestion && suggestion.proposedValue === 'Alex E'), 'demographic changes should become review suggestions');
reviewUpdateSuggestion({ orgId, id: suggestion.id, accept: true, actor, expectedRevision: suggestion.revision });
check(clientById(orgId, client.id)?.name === 'Alex E', 'accepted demographic suggestion should update the patient');
throws(() => savePublicForm({ token: assignment.token, answers: { preferred_name: 'Again', pain: false, consent: true }, submit: true }), /already submitted/, 'a submitted form cannot be submitted twice');
check(formResponsesFor(orgId, { assignmentId: assignment.assignment.id }).length === 1, 'an assignment must have one response aggregate');

const firstReferral = createReferral({ orgId, actor, patient: { name: 'Jamie Referral', email: 'jamie@example.test', dateOfBirth: '1988-02-10' }, referrer: { name: 'Case Manager', email: 'case.manager@example.test', organisation: 'Example Referrals' }, reason: 'Persistent shoulder pain', priority: 'soon' });
const duplicateReferral = createReferral({ orgId, actor, patient: { name: 'Jamie Referral', email: 'jamie@example.test', dateOfBirth: '1988-02-10' }, reason: 'Second incoming referral' });
check(duplicateReferral.duplicateCandidates.some((candidate) => candidate.referral.id === firstReferral.referral.id), 'duplicate referral candidates should be surfaced, never auto-merged');
throws(() => transitionReferral({ orgId, id: firstReferral.referral.id, to: 'converted', actor, expectedRevision: firstReferral.referral.revision }), /cannot move/, 'invalid referral transitions must fail');
const triaged = transitionReferral({ orgId, id: firstReferral.referral.id, to: 'triaged', actor, expectedRevision: firstReferral.referral.revision, note: 'Desk check complete' });
const flag = addReferralRiskFlag({ orgId, referralId: triaged.id, label: 'Manual clinician review', severity: 'warning', actor });
check(flag.status === 'open', 'risk flags should be explicit restricted records');
const accepted = transitionReferral({ orgId, id: triaged.id, to: 'accepted', actor, expectedRevision: triaged.revision, note: 'Within service criteria' });
const queuedNotification = queueReferralNotification({
  orgId, referralId: accepted.id, expectedRevision: accepted.revision, actor,
  subject: 'Referral accepted', body: 'The referral has been accepted for administrative booking follow-up.',
});
check(queuedNotification.notification.state === 'queued' && queuedNotification.job?.type === 'referral.notification', 'referrer updates should start as durable domain jobs');
const notificationRetry = queueReferralNotification({
  orgId, referralId: accepted.id, expectedRevision: accepted.revision, actor,
  subject: 'Referral accepted', body: 'The referral has been accepted for administrative booking follow-up.',
});
check(notificationRetry.notification.id === queuedNotification.notification.id, 'identical referrer-notification retries should converge on one evidence record');
throws(() => queueReferralNotification({
  orgId, referralId: accepted.id, expectedRevision: accepted.revision, actor,
  subject: 'Different update', body: 'This competing update must not replace the evidence already queued.',
}), /different referrer notification already exists/i, 'different content cannot replace a notification for the same referral revision');
throws(() => queueReferralNotification({
  orgId, referralId: accepted.id, expectedRevision: accepted.revision - 1, actor,
  subject: 'Stale update', body: 'A stale referral snapshot must not be sent to the referrer.',
}), /changed after/i, 'stale referral notification requests must fail');
throws(() => queueReferralNotification({
  orgId, referralId: duplicateReferral.referral.id, expectedRevision: duplicateReferral.referral.revision, actor,
  subject: 'No destination', body: 'This referral has no controlled referrer destination.',
}), /no valid referrer email/i, 'notifications require the referral’s recorded referrer email');
const jobSweep = await runDueDomainJobs(orgId, { workerId: 'phase3-notification-worker', limit: 100, now: Date.now() + 1_000 });
check(jobSweep.completed > 0 && get<DomainJobDoc>('domainJobs', queuedNotification.job!.id)?.status === 'completed', 'the standard domain-job runner should materialise referral notifications');
const notificationMessage = list<MessageDoc>('messages', (row) => row.orgId === orgId && row.meta?.referralNotificationId === queuedNotification.notification.id);
check(notificationMessage.length === 1 && ['pending', 'blocked'].includes(notificationMessage[0]!.status), 'one controlled message should be linked to notification evidence');
setMessageTransport(async (message) => ({ ok: true, provider: 'phase3-test', providerMessageId: `test_${message.id}` }));
try {
  await deliverDueMessages({ orgId, now: Date.now() + 48 * 60 * 60_000, limit: 100 });
} finally {
  setMessageTransport(undefined);
}
check(referralNotificationsFor(orgId, accepted.id)[0]?.state === 'sent', 'referral notification evidence should reconcile to provider-accepted delivery');
const converted = convertReferralToClient({ orgId, id: accepted.id, actor, expectedRevision: accepted.revision });
const retryConversion = convertReferralToClient({ orgId, id: accepted.id, actor, expectedRevision: accepted.revision });
check(converted.client.id === retryConversion.client.id && retryConversion.referral.status === 'converted', 'referral conversion retry should resolve to the same patient');
check(referralEventsFor(orgId, accepted.id).map((event) => event.to).join(',') === 'received,triaged,accepted,converted', 'referral decision history should be complete and ordered');

const letterTemplate = createLetterTemplate({ orgId, actor, name: 'Referral outcome', category: 'referral', subject: 'Outcome for {{patient.name}}', body: 'Dear {{recipient.name}},\n\nThis concerns {{patient.name}}.\n\n{{author.name}}', footer: '{{practice.name}}', requiresApproval: true });
const publishedLetterTemplate = setLetterTemplateState({ orgId, id: letterTemplate.template.id, state: 'published', actor, expectedRevision: letterTemplate.template.revision });
const letterCreated = createLetter({ orgId, templateId: publishedLetterTemplate.id, clientId: client.id, recipient: { name: 'Alex Example', email: 'alex@example.test' }, actor: { name: 'Dr Test', email: actor } });
updateClient(orgId, client.id, { name: 'Changed Later' }, actor);
check(letterCreated.version.body.includes('Alex E') && !letterCreated.version.body.includes('Changed Later'), 'letter merge data should be frozen at composition time');
const awaiting = await transitionLetter({ orgId, id: letterCreated.letter.id, action: 'submit', actor, expectedRevision: letterCreated.letter.revision });
const approved = await transitionLetter({ orgId, id: awaiting.id, action: 'approve', actor: 'approver@voxera.test', expectedRevision: awaiting.revision });
const finalised = await transitionLetter({ orgId, id: approved.id, action: 'finalise', actor: 'approver@voxera.test', expectedRevision: approved.revision });
const artifact = await letterPdf(orgId, finalised.id);
check(Boolean(artifact?.pdf.subarray(0, 5).toString('ascii') === '%PDF-'), 'finalised letters should render as a valid PDF');
check(finalised.artifactHash === crypto.createHash('sha256').update(artifact!.pdf).digest('hex'), 'stored letter artifact hash should match the generated PDF');
check(Boolean(artifact?.persisted && finalised.artifactDocumentId && finalised.artifactVersionId), 'finalised letters should reference an encrypted persisted artifact');
check(artifact?.artifact?.version.plaintextSha256 === finalised.artifactHash && artifact?.artifact?.scan.status === 'clean', 'persisted letter bytes should be hash-verified and marked as trusted generated evidence');
const persistedVersion = artifact!.artifact!.version;
const store = blobStore();
const originalCiphertext = await store.get(persistedVersion.objectKey);
const tamperedCiphertext = Buffer.from(originalCiphertext);
tamperedCiphertext[Math.max(0, Math.floor(tamperedCiphertext.length / 2))] ^= 0x01;
await store.put(persistedVersion.objectKey, tamperedCiphertext);
await assert.rejects(() => letterPdf(orgId, finalised.id), /encrypted object integrity|authenticate|integrity check/i, 'tampered generated-artifact ciphertext must be refused');
checks += 1;
await store.put(persistedVersion.objectKey, originalCiphertext);
const restoredArtifact = await letterPdf(orgId, finalised.id);
check(restoredArtifact?.pdf.subarray(0, 5).toString('ascii') === '%PDF-', 'restoring the exact encrypted object should restore verified retrieval');

const correctionSourceCreated = createLetter({ orgId, templateId: publishedLetterTemplate.id, clientId: client.id, recipient: { name: 'Correction Recipient', email: 'correction@example.test' }, actor: { name: 'Dr Test', email: actor } });
const correctionSourceAwaiting = await transitionLetter({ orgId, id: correctionSourceCreated.letter.id, action: 'submit', actor, expectedRevision: correctionSourceCreated.letter.revision });
const correctionSourceApproved = await transitionLetter({ orgId, id: correctionSourceAwaiting.id, action: 'approve', actor: 'approver@voxera.test', expectedRevision: correctionSourceAwaiting.revision });
const correctionSourceFinalised = await transitionLetter({ orgId, id: correctionSourceApproved.id, action: 'finalise', actor: 'approver@voxera.test', expectedRevision: correctionSourceApproved.revision });
const sourceVersionBefore = letterVersion(orgId, correctionSourceFinalised.id)!;
const sourceArtifactBefore = await letterPdf(orgId, correctionSourceFinalised.id);
const correction = createLetterCorrection({
  orgId, id: correctionSourceFinalised.id, expectedRevision: correctionSourceFinalised.revision,
  actor: 'approver@voxera.test', reason: 'The outcome wording needs a factual administrative correction.',
});
check(correction.corrected.status === 'corrected' && correction.corrected.correctedByLetterId === correction.letter.id && correction.letter.correctsLetterId === correctionSourceFinalised.id, 'a correction should link a new draft while marking the source as superseded');
check(correction.version.contentHash === sourceVersionBefore.contentHash && correction.version.body === sourceVersionBefore.body, 'the correction draft should begin from an exact copy of the finalised content');
const sourceArtifactAfter = await letterPdf(orgId, correctionSourceFinalised.id);
check(Boolean(sourceArtifactAfter?.persisted && sourceArtifactAfter.letter.artifactHash === correctionSourceFinalised.artifactHash && sourceArtifactAfter.pdf.equals(sourceArtifactBefore!.pdf)), 'correcting must preserve and keep serving the exact original artifact');
throws(() => createLetterCorrection({
  orgId, id: correctionSourceFinalised.id, expectedRevision: correction.corrected.revision,
  actor: 'approver@voxera.test', reason: 'A second competing correction must not be created.',
}), /already has a correction/i, 'a final evidence record can have only one direct correction');
const revisedCorrection = reviseLetter({
  orgId, id: correction.letter.id, expectedRevision: correction.letter.revision, actor,
  subject: correction.version.subject, body: `${correction.version.body}\n\nCorrection: administrative wording updated.`, footer: correction.version.footer,
});
const correctionAwaiting = await transitionLetter({ orgId, id: revisedCorrection.letter.id, action: 'submit', actor, expectedRevision: revisedCorrection.letter.revision });
const correctionApproved = await transitionLetter({ orgId, id: correctionAwaiting.id, action: 'approve', actor: 'approver@voxera.test', expectedRevision: correctionAwaiting.revision });
const correctionFinalised = await transitionLetter({ orgId, id: correctionApproved.id, action: 'finalise', actor: 'approver@voxera.test', expectedRevision: correctionApproved.revision });
const correctionArtifact = await letterPdf(orgId, correctionFinalised.id);
check(Boolean(correctionArtifact?.persisted && correctionFinalised.artifactHash && correctionFinalised.artifactHash !== correctionSourceFinalised.artifactHash), 'a finalised correction should create its own immutable superseding artifact');
check(letterById(orgId, correctionSourceFinalised.id)?.artifactHash === correctionSourceFinalised.artifactHash && letterVersion(orgId, correctionSourceFinalised.id)?.contentHash === sourceVersionBefore.contentHash, 'source letter content and evidence hashes must remain unchanged after the correction is finalised');
const finalEvidenceEnvelope = get<Doc>('letters', correctionSourceFinalised.id)!;
throws(() => commitBatch({ upserts: [{ collection: 'letters', doc: { ...finalEvidenceEnvelope, artifactHash: '0'.repeat(64) }, expectedRevision: Number(finalEvidenceEnvelope.revision ?? 0), expectedOrgId: orgId }] }), /finalised letter evidence is immutable/i, 'database trigger must reject changes to a finalised letter evidence envelope');

const immutableVersion = get<Doc>('letterVersions', `${letterCreated.letter.id}_v1`)!;
throws(() => commitBatch({ upserts: [{ collection: 'letterVersions', doc: { ...immutableVersion, body: 'tampered' }, expectedRevision: Number(immutableVersion.revision ?? 0), expectedOrgId: orgId }] }), /append-only/i, 'database trigger must reject immutable letter-version changes');
const queued = queueLetterEmail({ orgId, id: finalised.id, actor, expectedRevision: finalised.revision });
check(['pending', 'blocked'].includes(queued.message.status), 'letter delivery should enter the controlled message path');
throws(() => queueLetterEmail({ orgId, id: finalised.id, actor, expectedRevision: finalised.revision }), /changed after|only a finalised/, 'stale delivery retries must not enqueue a second message');
check(list<MessageDoc>('messages', (row) => row.orgId === orgId && row.meta?.letterId === finalised.id).length === 1, 'a letter should have exactly one queued message after a stale retry');

const auditActions = list<Doc>('audit', (row) => row.orgId === orgId).map((row) => String(row.action));
for (const action of ['form.response_submitted', 'referral.notification_queued', 'referral.converted', 'letter.correction_created', 'letter.finalise', 'letter.queued']) {
  check(auditActions.includes(action), `audit evidence should include ${action}`);
}
const automationEvents = list<AutomationEventDoc>('automationEvents', (row) => row.orgId === orgId);
check(automationEvents.filter((row) => row.trigger === 'form.response_submitted' && row.aggregateId === submitted.response.id).length === 1, 'submitted form commit should include one minimised automation event');
check(automationEvents.some((row) => row.trigger === 'referral.received' && row.aggregateId === firstReferral.referral.id), 'referral receipt commit should include its automation event');
check(automationEvents.some((row) => row.trigger === 'referral.status_changed' && row.aggregateId === converted.referral.id), 'referral decision commits should include status-change automation events');
check(automationEvents.filter((row) => row.trigger === 'letter.finalised' && row.aggregateId === finalised.id).length === 1, 'finalised letter commit should include one automation event');
check(automationEvents.every((event) => list<DomainJobDoc>('domainJobs', (job) => job.orgId === orgId && job.type === 'automation.event' && job.payload.eventId === event.id).length === 1), 'every source event should have one durable automation job');

console.log(`phase3-workflow-check: ${checks} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
