import crypto from 'node:crypto';
import { commitBatch, get, list, newId, nowIso, withEntityLock, withEntityLockAsync, type Doc } from './db';
import { clientById } from './clients';
import { bookingById } from './bookings';
import { referralById } from './referrals';
import { providerById, serviceById, locationById } from './practice';
import { queueMessage, type MessageDoc } from './messages';
import { renderTextPdf } from './simple-pdf';
import { downloadDocumentVersion, persistGeneratedDocument } from './clinical-documents';
import { automationEventWrites } from './automations/events';
import { formatStructuredAddress } from '../addresses';

export type LetterTemplateDoc = Doc & {
  orgId: string;
  name: string;
  category: 'clinical' | 'referral' | 'administrative' | 'finance';
  state: 'draft' | 'published' | 'archived';
  currentVersion: number;
  publishedVersion?: number;
  requiresApproval: boolean;
  revision: number;
};

export type LetterTemplateVersionDoc = Doc & {
  orgId: string;
  templateId: string;
  version: number;
  subjectTemplate: string;
  bodyTemplate: string;
  footerTemplate?: string;
  templateHash: string;
  author: string;
  revision: number;
};

export type LetterSnapshot = {
  generatedAt: string;
  practice: { name: string; email?: string; phone?: string; address?: string };
  patient?: { id: string; name: string; firstName?: string; lastName?: string; email?: string; phone?: string; dateOfBirth?: string; address?: string };
  referral?: { id: string; reason: string; status: string; receivedAt: string; referrerName?: string; referrerOrganisation?: string };
  appointment?: { id: string; startsAt: string; service: string; practitioner?: string; location?: string; status: string };
  author: { name: string; email?: string };
  recipient: { name: string; email?: string; address?: string };
  custom: Record<string, string>;
};

export type LetterDoc = Doc & {
  orgId: string;
  templateId: string;
  templateVersion: number;
  clientId?: string;
  referralId?: string;
  bookingId?: string;
  status: 'draft' | 'awaiting_approval' | 'approved' | 'finalised' | 'queued' | 'sent' | 'failed' | 'cancelled' | 'corrected';
  currentVersion: number;
  requiresApproval: boolean;
  snapshot: LetterSnapshot;
  approvedBy?: string;
  approvedAt?: string;
  finalisedBy?: string;
  finalisedAt?: string;
  artifactHash?: string;
  artifactDocumentId?: string;
  artifactVersionId?: string;
  messageId?: string;
  /** Correction chain: final evidence is never edited in place. */
  correctsLetterId?: string;
  correctedByLetterId?: string;
  correctionReason?: string;
  correctedAt?: string;
  correctedBy?: string;
  revision: number;
};

export type LetterVersionDoc = Doc & {
  orgId: string;
  letterId: string;
  version: number;
  subject: string;
  body: string;
  footer?: string;
  contentHash: string;
  author: string;
  revision: number;
};

const TOKEN = /{{\s*([a-z][a-z0-9_.]{1,100})\s*}}/gi;
const ALLOWED_TOKENS = new Set([
  'practice.name', 'practice.email', 'practice.phone', 'practice.address',
  'patient.id', 'patient.name', 'patient.firstName', 'patient.lastName', 'patient.email', 'patient.phone', 'patient.dateOfBirth', 'patient.address',
  'referral.id', 'referral.reason', 'referral.status', 'referral.receivedAt', 'referral.referrerName', 'referral.referrerOrganisation',
  'appointment.id', 'appointment.startsAt', 'appointment.service', 'appointment.practitioner', 'appointment.location', 'appointment.status',
  'author.name', 'author.email', 'recipient.name', 'recipient.email', 'recipient.address', 'generatedAt',
]);

function hash(value: string | Buffer) { return crypto.createHash('sha256').update(value).digest('hex'); }
function auditDoc(orgId: string, actor: string, action: string, target: string, detail: string): Doc {
  return { id: newId('aud_'), orgId, actor, action, kind: 'letter', target, detail, at: nowIso() };
}
function validateTemplateText(subject: string, body: string, footer?: string) {
  if (!subject.trim() || subject.length > 300) throw new Error('letter subject must be 1 to 300 characters');
  if (!body.trim() || body.length > 100_000) throw new Error('letter body must be 1 to 100,000 characters');
  const all = `${subject}\n${body}\n${footer ?? ''}`;
  for (const match of all.matchAll(TOKEN)) {
    const key = match[1];
    if (!ALLOWED_TOKENS.has(key) && !key.startsWith('custom.')) throw new Error(`unsupported letter token ${key}`);
  }
}
function valueAt(snapshot: LetterSnapshot, key: string): string {
  if (key.startsWith('custom.')) return snapshot.custom[key.slice(7)] ?? '';
  let value: unknown = snapshot;
  for (const part of key.split('.')) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined;
  return value === undefined || value === null ? '' : String(value);
}
function render(template: string, snapshot: LetterSnapshot) {
  return template.replace(TOKEN, (_whole, key: string) => valueAt(snapshot, key));
}
function templateFor(orgId: string, id: string) {
  const row = get<LetterTemplateDoc>('letterTemplates', id);
  return row?.orgId === orgId ? row : undefined;
}
function templateVersionFor(orgId: string, id: string, version?: number) {
  const template = templateFor(orgId, id);
  if (!template) return undefined;
  const wanted = version ?? template.publishedVersion ?? template.currentVersion;
  return list<LetterTemplateVersionDoc>('letterTemplateVersions', (row) => row.orgId === orgId && row.templateId === id && row.version === wanted)[0];
}

export function letterTemplatesFor(orgId: string, includeArchived = false) {
  return list<LetterTemplateDoc>('letterTemplates', (row) => row.orgId === orgId && (includeArchived || row.state !== 'archived')).sort((a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)));
}
export function letterTemplateById(orgId: string, id: string) { return templateFor(orgId, id); }
export function letterTemplateVersion(orgId: string, id: string, version?: number) { return templateVersionFor(orgId, id, version); }

export function createLetterTemplate(input: { orgId: string; name: string; category?: LetterTemplateDoc['category']; subject: string; body: string; footer?: string; requiresApproval?: boolean; actor: string }) {
  validateTemplateText(input.subject, input.body, input.footer);
  const name = input.name.trim();
  if (name.length < 2 || name.length > 160) throw new Error('template name must be 2 to 160 characters');
  const id = newId('ltrt_');
  const at = nowIso();
  const template: LetterTemplateDoc = { id, orgId: input.orgId, name, category: input.category ?? 'clinical', state: 'draft', currentVersion: 1, requiresApproval: input.requiresApproval !== false, revision: 0, createdAt: at, updatedAt: at };
  const version: LetterTemplateVersionDoc = { id: `${id}_v1`, orgId: input.orgId, templateId: id, version: 1, subjectTemplate: input.subject, bodyTemplate: input.body, footerTemplate: input.footer, templateHash: hash(`${input.subject}\0${input.body}\0${input.footer ?? ''}`), author: input.actor, revision: 0, createdAt: at };
  const rows = commitBatch({ upserts: [
    { collection: 'letterTemplates', doc: template, expectedRevision: null, expectedOrgId: input.orgId },
    { collection: 'letterTemplateVersions', doc: version, expectedRevision: null, expectedOrgId: input.orgId },
    { collection: 'audit', doc: auditDoc(input.orgId, input.actor, 'letter.template_created', id, template.category), expectedRevision: null, expectedOrgId: input.orgId },
  ] }).upserts;
  return { template: rows.find((row) => row.id === id) as LetterTemplateDoc, version: rows.find((row) => row.id === version.id) as LetterTemplateVersionDoc };
}

export function reviseLetterTemplate(input: { orgId: string; id: string; name?: string; subject: string; body: string; footer?: string; requiresApproval?: boolean; actor: string; expectedRevision: number }) {
  const template = templateFor(input.orgId, input.id);
  if (!template) throw new Error('letter template not found');
  if (template.revision !== input.expectedRevision) throw new Error('letter template changed after it was loaded');
  if (template.state === 'archived') throw new Error('archived templates cannot be revised');
  validateTemplateText(input.subject, input.body, input.footer);
  const number = template.currentVersion + 1;
  const version: LetterTemplateVersionDoc = { id: `${template.id}_v${number}`, orgId: input.orgId, templateId: template.id, version: number, subjectTemplate: input.subject, bodyTemplate: input.body, footerTemplate: input.footer, templateHash: hash(`${input.subject}\0${input.body}\0${input.footer ?? ''}`), author: input.actor, revision: 0, createdAt: nowIso() };
  const next: LetterTemplateDoc = { ...template, name: input.name?.trim().slice(0, 160) || template.name, currentVersion: number, state: 'draft', requiresApproval: input.requiresApproval ?? template.requiresApproval, updatedAt: nowIso() };
  const rows = commitBatch({ upserts: [
    { collection: 'letterTemplates', doc: next, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId },
    { collection: 'letterTemplateVersions', doc: version, expectedRevision: null, expectedOrgId: input.orgId },
    { collection: 'audit', doc: auditDoc(input.orgId, input.actor, 'letter.template_revised', template.id, `version ${number}`), expectedRevision: null, expectedOrgId: input.orgId },
  ] }).upserts;
  return { template: rows.find((row) => row.id === template.id) as LetterTemplateDoc, version: rows.find((row) => row.id === version.id) as LetterTemplateVersionDoc };
}

export function setLetterTemplateState(input: { orgId: string; id: string; state: LetterTemplateDoc['state']; actor: string; expectedRevision: number }) {
  const template = templateFor(input.orgId, input.id);
  if (!template) throw new Error('letter template not found');
  const next: LetterTemplateDoc = { ...template, state: input.state, publishedVersion: input.state === 'published' ? template.currentVersion : template.publishedVersion, updatedAt: nowIso() };
  return commitBatch({ upserts: [
    { collection: 'letterTemplates', doc: next, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId },
    { collection: 'audit', doc: auditDoc(input.orgId, input.actor, `letter.template_${input.state}`, template.id, `version ${template.currentVersion}`), expectedRevision: null, expectedOrgId: input.orgId },
  ] }).upserts.find((row) => row.id === template.id) as LetterTemplateDoc;
}

export function buildLetterSnapshot(input: { orgId: string; clientId?: string; referralId?: string; bookingId?: string; author: { name: string; email?: string }; recipient?: Partial<LetterSnapshot['recipient']>; custom?: Record<string, string> }): LetterSnapshot {
  const org = get<Doc & { name?: string; email?: string; phone?: string; address?: string }>('orgs', input.orgId);
  const client = input.clientId ? clientById(input.orgId, input.clientId) : undefined;
  if (input.clientId && !client) throw new Error('client not found');
  const referral = input.referralId ? referralById(input.orgId, input.referralId) : undefined;
  if (input.referralId && !referral) throw new Error('referral not found');
  const booking = input.bookingId ? bookingById(input.orgId, input.bookingId) : undefined;
  if (input.bookingId && !booking) throw new Error('booking not found');
  const practitioner = booking?.providerId ? providerById(input.orgId, booking.providerId) : undefined;
  const service = booking?.serviceId ? serviceById(input.orgId, booking.serviceId) : undefined;
  const location = booking?.locationId ? locationById(input.orgId, booking.locationId) : undefined;
  const recipient = {
    name: String(input.recipient?.name ?? client?.name ?? referral?.referrer?.name ?? '').trim(),
    email: String(input.recipient?.email ?? client?.email ?? referral?.referrer?.email ?? '').trim() || undefined,
    address: input.recipient?.address
      ? String(input.recipient.address).trim() || undefined
      : client
        ? formatStructuredAddress(client.structuredAddress, client.address)
        : referral
          ? formatStructuredAddress(referral.patient.structuredAddress, referral.patient.address)
          : undefined,
  };
  if (!recipient.name) throw new Error('recipient name is required');
  return {
    generatedAt: nowIso(),
    practice: { name: String(org?.name ?? 'Practice'), email: org?.email, phone: org?.phone, address: org?.address },
    patient: client ? {
      id: client.id, name: client.name, firstName: client.firstName, lastName: client.lastName,
      email: client.email, phone: client.number, dateOfBirth: client.dateOfBirth,
      address: formatStructuredAddress(client.structuredAddress, client.address),
    } : referral ? {
      id: '', name: referral.patient.name, email: referral.patient.email, phone: referral.patient.phone,
      dateOfBirth: referral.patient.dateOfBirth,
      address: formatStructuredAddress(referral.patient.structuredAddress, referral.patient.address),
    } : undefined,
    referral: referral ? { id: referral.id, reason: referral.reason, status: referral.status, receivedAt: referral.receivedAt, referrerName: referral.referrer?.name, referrerOrganisation: referral.referrer?.organisation } : undefined,
    appointment: booking ? { id: booking.id, startsAt: booking.startsAt, service: service?.name ?? booking.service, practitioner: practitioner?.name, location: location?.name, status: booking.status } : undefined,
    author: { name: input.author.name, email: input.author.email }, recipient,
    custom: Object.fromEntries(Object.entries(input.custom ?? {}).slice(0, 50).map(([key, value]) => [key.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 64), String(value).slice(0, 4_000)])),
  };
}

function syncLetterDelivery(letter: LetterDoc): LetterDoc {
  if (!letter.messageId || !['queued', 'failed'].includes(letter.status)) return letter;
  const message = get<MessageDoc>('messages', letter.messageId);
  if (!message || message.orgId !== letter.orgId) return letter;
  const status = message.status === 'sent' ? 'sent' : ['failed', 'blocked', 'cancelled'].includes(message.status) ? 'failed' : letter.status;
  if (status === letter.status) return letter;
  try {
    return commitBatch({ upserts: [
      { collection: 'letters', doc: { ...letter, status, updatedAt: nowIso() }, expectedRevision: letter.revision, expectedOrgId: letter.orgId },
      { collection: 'audit', doc: auditDoc(letter.orgId, 'message-queue', `letter.${status}`, letter.id, `message ${message.id}: ${message.status}`), expectedRevision: null, expectedOrgId: letter.orgId },
    ] }).upserts.find((row) => row.id === letter.id) as LetterDoc;
  } catch {
    return (get<LetterDoc>('letters', letter.id) ?? letter);
  }
}

export function lettersFor(orgId: string, options: { status?: LetterDoc['status']; clientId?: string; referralId?: string } = {}) {
  return list<LetterDoc>('letters', (row) => row.orgId === orgId && (!options.clientId || row.clientId === options.clientId) && (!options.referralId || row.referralId === options.referralId))
    .map(syncLetterDelivery)
    .filter((row) => !options.status || row.status === options.status)
    .sort((a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)));
}
export function letterById(orgId: string, id: string) { const row = get<LetterDoc>('letters', id); return row?.orgId === orgId ? syncLetterDelivery(row) : undefined; }
export function letterVersion(orgId: string, letterId: string, version?: number) { const letter = letterById(orgId, letterId); if (!letter) return undefined; return list<LetterVersionDoc>('letterVersions', (row) => row.orgId === orgId && row.letterId === letterId && row.version === (version ?? letter.currentVersion))[0]; }

export function createLetter(input: { orgId: string; templateId: string; clientId?: string; referralId?: string; bookingId?: string; recipient?: Partial<LetterSnapshot['recipient']>; custom?: Record<string, string>; actor: { name: string; email?: string } }) {
  const template = templateFor(input.orgId, input.templateId);
  if (!template || template.state !== 'published' || !template.publishedVersion) throw new Error('a published letter template is required');
  const version = templateVersionFor(input.orgId, template.id, template.publishedVersion);
  if (!version) throw new Error('letter template version not found');
  const snapshot = buildLetterSnapshot({ ...input, author: input.actor });
  const id = newId('ltr_');
  const at = nowIso();
  const rendered: LetterVersionDoc = {
    id: `${id}_v1`, orgId: input.orgId, letterId: id, version: 1,
    subject: render(version.subjectTemplate, snapshot), body: render(version.bodyTemplate, snapshot), footer: version.footerTemplate ? render(version.footerTemplate, snapshot) : undefined,
    contentHash: '', author: input.actor.email ?? input.actor.name, revision: 0, createdAt: at,
  };
  rendered.contentHash = hash(`${rendered.subject}\0${rendered.body}\0${rendered.footer ?? ''}`);
  const letter: LetterDoc = { id, orgId: input.orgId, templateId: template.id, templateVersion: version.version, clientId: input.clientId, referralId: input.referralId, bookingId: input.bookingId, status: 'draft', currentVersion: 1, requiresApproval: template.requiresApproval, snapshot, revision: 0, createdAt: at, updatedAt: at };
  const rows = commitBatch({ upserts: [
    { collection: 'letters', doc: letter, expectedRevision: null, expectedOrgId: input.orgId },
    { collection: 'letterVersions', doc: rendered, expectedRevision: null, expectedOrgId: input.orgId },
    { collection: 'audit', doc: auditDoc(input.orgId, input.actor.email ?? input.actor.name, 'letter.created', id, `template ${template.id} version ${version.version}`), expectedRevision: null, expectedOrgId: input.orgId },
  ] }).upserts;
  return { letter: rows.find((row) => row.id === id) as LetterDoc, version: rows.find((row) => row.id === rendered.id) as LetterVersionDoc };
}

export function reviseLetter(input: { orgId: string; id: string; subject: string; body: string; footer?: string; actor: string; expectedRevision: number }) {
  const letter = letterById(input.orgId, input.id);
  if (!letter) throw new Error('letter not found');
  if (!['draft', 'awaiting_approval'].includes(letter.status)) throw new Error('only a draft letter can be revised');
  if (letter.revision !== input.expectedRevision) throw new Error('letter changed after it was loaded');
  if (!input.subject.trim() || !input.body.trim()) throw new Error('letter subject and body are required');
  const number = letter.currentVersion + 1;
  const version: LetterVersionDoc = { id: `${letter.id}_v${number}`, orgId: input.orgId, letterId: letter.id, version: number, subject: input.subject.slice(0, 300), body: input.body.slice(0, 100_000), footer: input.footer?.slice(0, 10_000), contentHash: hash(`${input.subject}\0${input.body}\0${input.footer ?? ''}`), author: input.actor, revision: 0, createdAt: nowIso() };
  const next: LetterDoc = { ...letter, currentVersion: number, status: 'draft', approvedAt: undefined, approvedBy: undefined, updatedAt: nowIso() };
  const rows = commitBatch({ upserts: [
    { collection: 'letters', doc: next, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId },
    { collection: 'letterVersions', doc: version, expectedRevision: null, expectedOrgId: input.orgId },
    { collection: 'audit', doc: auditDoc(input.orgId, input.actor, 'letter.revised', letter.id, `version ${number}`), expectedRevision: null, expectedOrgId: input.orgId },
  ] }).upserts;
  return { letter: rows.find((row) => row.id === letter.id) as LetterDoc, version: rows.find((row) => row.id === version.id) as LetterVersionDoc };
}

export function createLetterCorrection(input: {
  orgId: string;
  id: string;
  reason: string;
  actor: string;
  expectedRevision: number;
}) {
  return withEntityLock('letter-correction', `${input.orgId}:${input.id}`, () => {
    const source = letterById(input.orgId, input.id);
    if (!source) throw new Error('letter not found');
    if (source.revision !== input.expectedRevision) throw new Error('letter changed after it was loaded');
    if (source.correctedByLetterId) throw new Error('this letter already has a correction');
    if (!['finalised', 'sent', 'failed'].includes(source.status)) throw new Error('only a finalised or sent letter can be corrected');
    const sourceVersion = letterVersion(input.orgId, source.id);
    if (!sourceVersion) throw new Error('letter version not found');
    const reason = String(input.reason ?? '').trim();
    if (reason.length < 10 || reason.length > 2_000) throw new Error('correction reason must be 10 to 2,000 characters');
    const id = `ltr_corr_${crypto.createHash('sha256').update(`${input.orgId}:${source.id}`).digest('hex').slice(0, 32)}`;
    const at = nowIso();
    const version: LetterVersionDoc = {
      id: `${id}_v1`, orgId: input.orgId, letterId: id, version: 1,
      subject: sourceVersion.subject, body: sourceVersion.body, footer: sourceVersion.footer,
      contentHash: sourceVersion.contentHash, author: input.actor, revision: 0, createdAt: at,
    };
    const correction: LetterDoc = {
      id, orgId: input.orgId, templateId: source.templateId, templateVersion: source.templateVersion,
      clientId: source.clientId, referralId: source.referralId, bookingId: source.bookingId,
      status: 'draft', currentVersion: 1, requiresApproval: source.requiresApproval,
      snapshot: source.snapshot, correctsLetterId: source.id, correctionReason: reason,
      revision: 0, createdAt: at, updatedAt: at,
    };
    const correctedSource: LetterDoc = {
      ...source, status: 'corrected', correctedByLetterId: id,
      correctedAt: at, correctedBy: input.actor, updatedAt: at,
    };
    const rows = commitBatch({ upserts: [
      { collection: 'letters', doc: correctedSource, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId },
      { collection: 'letters', doc: correction, expectedRevision: null, expectedOrgId: input.orgId },
      { collection: 'letterVersions', doc: version, expectedRevision: null, expectedOrgId: input.orgId },
      { collection: 'audit', doc: auditDoc(input.orgId, input.actor, 'letter.correction_created', id, `corrects ${source.id}`), expectedRevision: null, expectedOrgId: input.orgId },
    ] }).upserts;
    return {
      corrected: rows.find((row) => row.id === source.id) as LetterDoc,
      letter: rows.find((row) => row.id === id) as LetterDoc,
      version: rows.find((row) => row.id === version.id) as LetterVersionDoc,
    };
  });
}

export async function transitionLetter(input: { orgId: string; id: string; action: 'submit' | 'approve' | 'finalise' | 'cancel'; actor: string; expectedRevision: number }) {
  return withEntityLockAsync('letter-transition', `${input.orgId}:${input.id}`, async () => {
    const letter = letterById(input.orgId, input.id);
    if (!letter) throw new Error('letter not found');
    if (letter.revision !== input.expectedRevision) throw new Error('letter changed after it was loaded');
    const at = nowIso();
    let next: LetterDoc;
    if (input.action === 'submit') {
      if (letter.status !== 'draft') throw new Error('only a draft can be submitted');
      next = { ...letter, status: letter.requiresApproval ? 'awaiting_approval' : 'approved', approvedAt: letter.requiresApproval ? undefined : at, approvedBy: letter.requiresApproval ? undefined : input.actor };
    } else if (input.action === 'approve') {
      if (letter.status !== 'awaiting_approval') throw new Error('letter is not awaiting approval');
      next = { ...letter, status: 'approved', approvedAt: at, approvedBy: input.actor };
    } else if (input.action === 'finalise') {
      if (!['approved', 'draft'].includes(letter.status) || (letter.requiresApproval && letter.status !== 'approved')) throw new Error('letter must be approved before finalising');
      const version = letterVersion(input.orgId, letter.id);
      if (!version) throw new Error('letter version not found');
      const artifact = renderTextPdf({ title: version.subject, body: version.body, footer: version.footer });
      const persisted = await persistGeneratedDocument({
        orgId: input.orgId,
        ownerType: 'letter',
        ownerId: letter.id,
        patientId: letter.clientId,
        title: version.subject,
        category: 'letter_artifact',
        originalName: `letter-${letter.id}.pdf`,
        mimeType: 'application/pdf',
        bytes: artifact,
        actor: input.actor,
      });
      next = {
        ...letter,
        status: 'finalised',
        finalisedAt: at,
        finalisedBy: input.actor,
        artifactHash: hash(artifact),
        artifactDocumentId: persisted.document.id,
        artifactVersionId: persisted.version.id,
      };
    } else {
      if (!['draft', 'awaiting_approval', 'approved'].includes(letter.status)) throw new Error('letter cannot be cancelled after finalisation');
      next = { ...letter, status: 'cancelled' };
    }
    const automationWrites = input.action === 'finalise' ? automationEventWrites({
      orgId: input.orgId, trigger: 'letter.finalised', aggregateType: 'letter', aggregateId: letter.id,
      sourceEventId: next.artifactVersionId ?? `${letter.id}:v${letter.currentVersion}`, occurredAt: at,
      payload: { letter: {
        templateId: letter.templateId, clientId: letter.clientId ?? '', referralId: letter.referralId ?? '',
        category: templateFor(input.orgId, letter.templateId)?.category ?? 'administrative',
      } },
    }) : [];
    return commitBatch({ upserts: [
      { collection: 'letters', doc: { ...next, updatedAt: at }, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId },
      { collection: 'audit', doc: auditDoc(input.orgId, input.actor, `letter.${input.action}`, letter.id, `version ${letter.currentVersion}`), expectedRevision: null, expectedOrgId: input.orgId },
      ...automationWrites,
    ] }).upserts.find((row) => row.id === letter.id) as LetterDoc;
  });
}

export async function letterPdf(orgId: string, id: string) {
  const letter = letterById(orgId, id);
  if (!letter || !['finalised', 'queued', 'sent', 'failed', 'corrected'].includes(letter.status)) return undefined;
  const version = letterVersion(orgId, id);
  if (!version) return undefined;
  if (letter.artifactDocumentId && letter.artifactVersionId) {
    const artifact = await downloadDocumentVersion(orgId, letter.artifactDocumentId, letter.artifactVersionId);
    const actualHash = hash(artifact.bytes);
    if (actualHash !== letter.artifactHash || artifact.version.plaintextSha256 !== letter.artifactHash) {
      artifact.bytes.fill(0);
      throw new Error('the persisted letter artifact failed its integrity check');
    }
    return { letter, version, pdf: artifact.bytes, artifact: { document: artifact.document, version: artifact.version, scan: artifact.scan }, persisted: true as const };
  }

  // Compatibility for letters finalised before encrypted artifact persistence was
  // introduced. New finalisations always take the persisted branch above.
  const pdf = renderTextPdf({ title: version.subject, body: version.body, footer: version.footer });
  if (letter.artifactHash && hash(pdf) !== letter.artifactHash) throw new Error('the legacy letter artifact no longer matches its finalised hash');
  return { letter, version, pdf, artifact: undefined, persisted: false as const };
}

export function queueLetterEmail(input: { orgId: string; id: string; to?: string; actor: string; expectedRevision: number }): { letter: LetterDoc; message: MessageDoc } {
  return withEntityLock('letter-delivery', `${input.orgId}:${input.id}`, () => {
    const letter = letterById(input.orgId, input.id);
    if (!letter) throw new Error('letter not found');
    if (letter.revision !== input.expectedRevision) throw new Error('letter changed after it was loaded');
    if (letter.status !== 'finalised') throw new Error('only a finalised letter can be queued');
    const version = letterVersion(input.orgId, letter.id);
    if (!version) throw new Error('letter version not found');
    const to = String(input.to ?? letter.snapshot.recipient.email ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error('recipient email is invalid');
    const message = queueMessage({ orgId: input.orgId, clientId: letter.clientId, channel: 'email', to, subject: version.subject, body: version.body, source: 'letter', kind: 'manual', meta: { letterId: letter.id, artifactHash: letter.artifactHash ?? '', artifactDocumentId: letter.artifactDocumentId ?? '', artifactVersionId: letter.artifactVersionId ?? '', finalisedAt: letter.finalisedAt ?? '' } });
    const saved = commitBatch({ upserts: [
      { collection: 'letters', doc: { ...letter, status: message.status === 'blocked' ? 'failed' : 'queued', messageId: message.id, updatedAt: nowIso() }, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId },
      { collection: 'audit', doc: auditDoc(input.orgId, input.actor, 'letter.queued', letter.id, `email ${to}`), expectedRevision: null, expectedOrgId: input.orgId },
    ] }).upserts.find((row) => row.id === letter.id) as LetterDoc;
    return { letter: saved, message };
  });
}
