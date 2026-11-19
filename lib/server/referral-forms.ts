import crypto from 'node:crypto';
import { CommitConflictError, commitBatch, findByPath, list, newId, nowIso, withEntityLockAsync, type Doc } from './db';
import { formTemplateById, formTemplateVersion, type FormTemplateVersionDoc } from './forms';
import { validateFormAnswers, type FormAnswers, type FormField, type FormSchema } from '../forms-schema';
import { completeDocumentUpload, createDocumentUploadToken, documentById } from './clinical-documents';
import { referralCreateDraft, referralDuplicateCandidates, type ReferralDoc, type ReferralPriority } from './referrals';
import { locationById, providerById, serviceById } from './practice';
import { memberById } from './team';

export type ReferralFieldMapping = {
  patientName: string;
  dateOfBirth?: string;
  email?: string;
  phone?: string;
  address?: string;
  reason: string;
  notes?: string;
  consent?: string;
  referrerName?: string;
  referrerEmail?: string;
  referrerPhone?: string;
  referrerOrganisation?: string;
  referrerRole?: string;
};

export type ReferralRoutingPolicy = {
  priority: ReferralPriority;
  serviceId?: string;
  locationId?: string;
  practitionerId?: string;
  ownerId?: string;
};

export type ReferralFormDoc = Doc & {
  orgId: string;
  name: string;
  slug: string;
  templateId: string;
  templateVersion: number;
  mapping: ReferralFieldMapping;
  routing: ReferralRoutingPolicy;
  privacyNotice: string;
  emergencyNotice: string;
  completionMessage: string;
  active: boolean;
  createdBy: string;
  updatedBy: string;
  revision: number;
};

export type ReferralFormSubmissionDoc = Doc & {
  orgId: string;
  referralFormId: string;
  referralFormRevision: number;
  templateId: string;
  templateVersion: number;
  mapping: ReferralFieldMapping;
  routing: ReferralRoutingPolicy;
  tokenHash: string;
  expiresAt: string;
  status: 'draft' | 'submitted' | 'expired';
  answers?: FormAnswers;
  answersHash?: string;
  schemaHash: string;
  documentIds: string[];
  referralId?: string;
  submittedAt?: string;
  submittedIpHash?: string;
  revision: number;
};

const PRIORITIES = new Set<ReferralPriority>(['routine', 'soon', 'urgent']);
const MAPPING_KEYS: Array<keyof ReferralFieldMapping> = [
  'patientName', 'dateOfBirth', 'email', 'phone', 'address', 'reason', 'notes', 'consent',
  'referrerName', 'referrerEmail', 'referrerPhone', 'referrerOrganisation', 'referrerRole',
];

function auditDoc(orgId: string, actor: string, action: string, target: string, detail: string): Doc {
  return { id: newId('aud_'), orgId, actor, action, kind: 'referral_form', target, detail, at: nowIso() };
}

function tokenHash(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function contentHash(value: unknown) {
  // PostgreSQL JSONB does not preserve object-key order. Hash canonical JSON so
  // identical pinned evidence verifies after either SQLite or PostgreSQL reads.
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function cleanNotice(value: unknown, label: string, min: number, max: number) {
  const text = String(value ?? '').trim();
  if (text.length < min || text.length > max) throw new Error(`${label} must be ${min} to ${max} characters`);
  return text;
}

function cleanSlug(value: unknown) {
  const slug = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,78}[a-z0-9]$/.test(slug) || slug.includes('--')) {
    throw new Error('public referral slug must be 4 to 80 lowercase letters, numbers or single hyphens');
  }
  return slug;
}

function cleanRouting(orgId: string, input: Partial<ReferralRoutingPolicy> | undefined): ReferralRoutingPolicy {
  const allowed = new Set(['priority', 'serviceId', 'locationId', 'practitionerId', 'ownerId']);
  const unsupported = Object.keys(input ?? {}).find((key) => !allowed.has(key));
  if (unsupported) throw new Error(`unsupported referral routing property ${unsupported}`);
  const priority = input?.priority ?? 'routine';
  if (!PRIORITIES.has(priority)) throw new Error('referral routing priority is invalid');
  const routing: ReferralRoutingPolicy = {
    priority,
    serviceId: input?.serviceId || undefined,
    locationId: input?.locationId || undefined,
    practitionerId: input?.practitionerId || undefined,
    ownerId: input?.ownerId || undefined,
  };
  const service = routing.serviceId ? serviceById(orgId, routing.serviceId) : undefined;
  const location = routing.locationId ? locationById(orgId, routing.locationId) : undefined;
  const practitioner = routing.practitionerId ? providerById(orgId, routing.practitionerId) : undefined;
  const owner = routing.ownerId ? memberById(orgId, routing.ownerId) : undefined;
  if (routing.serviceId && (!service || service.active === false)) throw new Error('active routing service not found');
  if (routing.locationId && (!location || location.active === false)) throw new Error('active routing location not found');
  if (routing.practitionerId && (!practitioner || practitioner.active === false)) throw new Error('active routing practitioner not found');
  if (routing.ownerId && (!owner || owner.active === false)) throw new Error('active routing owner not found');
  if (practitioner && service && !practitioner.serviceIds.includes(service.id)) throw new Error('routing practitioner does not provide the selected service');
  if (practitioner && location && !practitioner.locationIds.includes(location.id)) throw new Error('routing practitioner does not work at the selected location');
  return routing;
}

function fieldFor(schema: FormSchema, key: unknown, label: string, allowed: FormField['type'][], requiredMapping = false) {
  const value = String(key ?? '').trim();
  if (!value) {
    if (requiredMapping) throw new Error(`${label} mapping is required`);
    return undefined;
  }
  const field = schema.fields.find((item) => item.key === value);
  if (!field) throw new Error(`${label} maps to a field that does not exist`);
  if (!allowed.includes(field.type)) throw new Error(`${label} is not compatible with a ${field.type.replaceAll('_', ' ')} field`);
  return field;
}

function cleanMapping(schema: FormSchema, input: Partial<ReferralFieldMapping> | undefined): ReferralFieldMapping {
  const allowed = new Set<string>(MAPPING_KEYS);
  const unsupported = Object.keys(input ?? {}).find((key) => !allowed.has(key));
  if (unsupported) throw new Error(`unsupported referral field mapping ${unsupported}`);
  const mapping = Object.fromEntries(MAPPING_KEYS.map((key) => [key, String(input?.[key] ?? '').trim() || undefined])) as unknown as ReferralFieldMapping;
  const patientName = fieldFor(schema, mapping.patientName, 'Patient name', ['text'], true)!;
  const reason = fieldFor(schema, mapping.reason, 'Referral reason', ['text', 'long_text'], true)!;
  if (!patientName.required || !reason.required) throw new Error('patient name and referral reason fields must be required in the published template');
  fieldFor(schema, mapping.dateOfBirth, 'Date of birth', ['date']);
  fieldFor(schema, mapping.email, 'Patient email', ['text']);
  fieldFor(schema, mapping.phone, 'Patient phone', ['text']);
  fieldFor(schema, mapping.address, 'Patient address', ['text', 'long_text']);
  fieldFor(schema, mapping.notes, 'Referral notes', ['text', 'long_text']);
  const consent = fieldFor(schema, mapping.consent, 'Consent', ['yes_no', 'acknowledgement']);
  if (consent && !consent.required) throw new Error('the mapped consent field must be required in the published template');
  fieldFor(schema, mapping.referrerName, 'Referrer name', ['text']);
  fieldFor(schema, mapping.referrerEmail, 'Referrer email', ['text']);
  fieldFor(schema, mapping.referrerPhone, 'Referrer phone', ['text']);
  fieldFor(schema, mapping.referrerOrganisation, 'Referrer organisation', ['text']);
  fieldFor(schema, mapping.referrerRole, 'Referrer role', ['text']);
  if (!mapping.referrerName && [mapping.referrerEmail, mapping.referrerPhone, mapping.referrerOrganisation, mapping.referrerRole].some(Boolean)) {
    throw new Error('referrer name must be mapped when other referrer details are mapped');
  }
  const used = Object.values(mapping).filter(Boolean);
  if (new Set(used).size !== used.length) throw new Error('each referral field may be mapped only once');
  return mapping;
}

function publishedReferralTemplate(orgId: string, templateId: string, version?: number) {
  const template = formTemplateById(orgId, templateId);
  if (!template || template.category !== 'referral' || template.state !== 'published' || !template.publishedVersion) {
    throw new Error('a published referral form template is required');
  }
  const pinnedVersion = version ?? template.publishedVersion;
  const templateVersion = formTemplateVersion(orgId, template.id, pinnedVersion);
  if (!templateVersion) throw new Error('published referral form template version not found');
  return { template, version: templateVersion };
}

export function referralFormsFor(orgId: string, includeInactive = true) {
  return list<ReferralFormDoc>('referralForms', (row) => row.orgId === orgId && (includeInactive || row.active))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function referralFormById(orgId: string, id: string) {
  const row = findByPath<ReferralFormDoc>('referralForms', 'id', id);
  return row?.orgId === orgId ? row : undefined;
}

export function referralFormBySlug(slug: string) {
  let normalised: string;
  try { normalised = cleanSlug(slug); } catch { return undefined; }
  return findByPath<ReferralFormDoc>('referralForms', 'slug', normalised);
}

export function createReferralForm(input: {
  orgId: string;
  name: string;
  slug: string;
  templateId: string;
  mapping: Partial<ReferralFieldMapping>;
  routing?: Partial<ReferralRoutingPolicy>;
  privacyNotice: string;
  emergencyNotice: string;
  completionMessage?: string;
  active?: boolean;
  actor: string;
}) {
  const name = String(input.name ?? '').trim();
  if (name.length < 2 || name.length > 160) throw new Error('referral form name must be 2 to 160 characters');
  if (input.active !== undefined && typeof input.active !== 'boolean') throw new Error('active must be true or false');
  const slug = cleanSlug(input.slug);
  if (findByPath<ReferralFormDoc>('referralForms', 'slug', slug)) throw new Error('that public referral slug is already in use');
  const published = publishedReferralTemplate(input.orgId, input.templateId);
  const mapping = cleanMapping(published.version.schema, input.mapping);
  const routing = cleanRouting(input.orgId, input.routing);
  const at = nowIso();
  const row: ReferralFormDoc = {
    id: newId('rff_'), orgId: input.orgId, name, slug, templateId: published.template.id,
    templateVersion: published.version.version, mapping, routing,
    privacyNotice: cleanNotice(input.privacyNotice, 'privacy notice', 20, 4_000),
    emergencyNotice: cleanNotice(input.emergencyNotice, 'emergency notice', 20, 2_000),
    completionMessage: cleanNotice(input.completionMessage ?? 'Thank you. The practice has received this referral for administrative review.', 'completion message', 10, 1_000),
    active: Boolean(input.active), createdBy: input.actor, updatedBy: input.actor, revision: 0, createdAt: at, updatedAt: at,
  };
  return commitBatch({ upserts: [
    { collection: 'referralForms', doc: row, expectedRevision: null, expectedOrgId: input.orgId },
    { collection: 'audit', doc: auditDoc(input.orgId, input.actor, 'referral_form.created', row.id, row.slug), expectedRevision: null, expectedOrgId: input.orgId },
  ] }).upserts.find((item) => item.id === row.id) as ReferralFormDoc;
}

export function updateReferralForm(input: {
  orgId: string;
  id: string;
  expectedRevision: number;
  actor: string;
  patch: Partial<Pick<ReferralFormDoc, 'name' | 'templateId' | 'mapping' | 'routing' | 'privacyNotice' | 'emergencyNotice' | 'completionMessage' | 'active'>>;
}) {
  const row = referralFormById(input.orgId, input.id);
  if (!row) throw new Error('referral form not found');
  if (row.revision !== input.expectedRevision) throw new Error('referral form changed after it was loaded');
  if (input.patch.active !== undefined && typeof input.patch.active !== 'boolean') throw new Error('active must be true or false');
  const published = input.patch.templateId
    ? publishedReferralTemplate(input.orgId, input.patch.templateId)
    : (() => {
        const template = formTemplateById(input.orgId, row.templateId);
        const version = formTemplateVersion(input.orgId, row.templateId, row.templateVersion);
        if (!template || template.category !== 'referral' || !version) throw new Error('configured referral template version not found');
        return { template, version };
      })();
  const nextActive = input.patch.active ?? row.active;
  if (nextActive && published.template.state !== 'published') throw new Error('a referral form can be active only while its template is published');
  const mapping = cleanMapping(published.version.schema, input.patch.mapping ?? row.mapping);
  const name = input.patch.name === undefined ? row.name : String(input.patch.name).trim();
  if (name.length < 2 || name.length > 160) throw new Error('referral form name must be 2 to 160 characters');
  const next: ReferralFormDoc = {
    ...row, name, templateId: published.template.id, templateVersion: published.version.version, mapping,
    routing: input.patch.routing === undefined ? row.routing : cleanRouting(input.orgId, input.patch.routing),
    privacyNotice: input.patch.privacyNotice === undefined ? row.privacyNotice : cleanNotice(input.patch.privacyNotice, 'privacy notice', 20, 4_000),
    emergencyNotice: input.patch.emergencyNotice === undefined ? row.emergencyNotice : cleanNotice(input.patch.emergencyNotice, 'emergency notice', 20, 2_000),
    completionMessage: input.patch.completionMessage === undefined ? row.completionMessage : cleanNotice(input.patch.completionMessage, 'completion message', 10, 1_000),
    active: nextActive, updatedBy: input.actor, updatedAt: nowIso(),
  };
  return commitBatch({ upserts: [
    { collection: 'referralForms', doc: next, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId },
    { collection: 'audit', doc: auditDoc(input.orgId, input.actor, next.active ? 'referral_form.updated' : 'referral_form.disabled', row.id, row.slug), expectedRevision: null, expectedOrgId: input.orgId },
  ] }).upserts.find((item) => item.id === row.id) as ReferralFormDoc;
}

function publicConfiguration(slug: string) {
  const form = referralFormBySlug(slug);
  if (!form || !form.active) return undefined;
  const template = formTemplateById(form.orgId, form.templateId);
  const version = formTemplateVersion(form.orgId, form.templateId, form.templateVersion);
  if (!template || template.state !== 'published' || template.category !== 'referral' || !version) return undefined;
  return { form, version };
}

export function publicReferralForm(slug: string) {
  return publicConfiguration(slug);
}

export function referralFormSubmissionByToken(form: ReferralFormDoc, token: string) {
  const row = findByPath<ReferralFormSubmissionDoc>('referralFormSubmissions', 'tokenHash', tokenHash(String(token)));
  return row?.orgId === form.orgId && row.referralFormId === form.id ? row : undefined;
}

export function createPublicReferralDraft(input: { slug: string }) {
  const loaded = publicConfiguration(input.slug);
  if (!loaded) throw new Error('public referral form not found');
  const token = `rrd_${crypto.randomBytes(32).toString('base64url')}`;
  const at = nowIso();
  const draft: ReferralFormSubmissionDoc = {
    id: newId('rfs_'), orgId: loaded.form.orgId, referralFormId: loaded.form.id,
    referralFormRevision: loaded.form.revision, templateId: loaded.form.templateId, templateVersion: loaded.form.templateVersion,
    mapping: loaded.form.mapping, routing: loaded.form.routing, tokenHash: tokenHash(token),
    expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(), status: 'draft',
    schemaHash: contentHash(loaded.version.schema), documentIds: [], revision: 0, createdAt: at,
  };
  const row = commitBatch({ upserts: [{ collection: 'referralFormSubmissions', doc: draft, expectedRevision: null, expectedOrgId: loaded.form.orgId }] }).upserts[0] as ReferralFormSubmissionDoc;
  return { token, submission: row, form: loaded.form, version: loaded.version };
}

export function activePublicReferralDraft(input: { slug: string; token: string }) {
  const loaded = publicConfiguration(input.slug);
  if (!loaded) return undefined;
  const submission = referralFormSubmissionByToken(loaded.form, input.token);
  if (!submission) return undefined;
  if (submission.status === 'draft' && Date.parse(submission.expiresAt) <= Date.now()) {
    try {
      const expired = commitBatch({ upserts: [{ collection: 'referralFormSubmissions', doc: { ...submission, status: 'expired' }, expectedRevision: submission.revision, expectedOrgId: submission.orgId }] }).upserts[0] as ReferralFormSubmissionDoc;
      return { ...loaded, submission: expired };
    } catch (error) {
      if (!(error instanceof CommitConflictError)) throw error;
      const winner = referralFormSubmissionByToken(loaded.form, input.token);
      return winner ? { ...loaded, submission: winner } : undefined;
    }
  }
  return { ...loaded, submission };
}

function answerText(answers: FormAnswers, key: string | undefined) {
  return key ? String(answers[key] ?? '').trim() || undefined : undefined;
}

function answerDocumentIds(schema: FormSchema, answers: FormAnswers) {
  const documentIds = schema.fields
    .filter((field) => field.type === 'file')
    .flatMap((field) => Array.isArray(answers[field.key]) ? (answers[field.key] as unknown[]).map(String) : []);
  if (documentIds.length > 50 || new Set(documentIds).size !== documentIds.length) throw new Error('referral attachments are invalid');
  return documentIds;
}

function assertReferralDocuments(form: ReferralFormDoc, submission: ReferralFormSubmissionDoc, documentIds: string[], exact: boolean) {
  const registered = [...new Set(submission.documentIds)];
  if (documentIds.some((documentId) => !registered.includes(documentId)) || (exact && registered.length !== documentIds.length)) {
    throw new Error('referral attachments do not match the files secured for this draft');
  }
  for (const documentId of documentIds) {
    const document = documentById(form.orgId, documentId);
    if (!document || document.ownerType !== 'referral_submission' || document.ownerId !== submission.id || document.category !== 'referral_attachment' || document.patientId) {
      throw new Error('a referral attachment does not belong to this draft');
    }
  }
}

export async function savePublicReferralDraft(input: { slug: string; token: string; answers: unknown }) {
  const initial = activePublicReferralDraft({ slug: input.slug, token: input.token });
  if (!initial) throw new Error('public referral draft not found');
  return withEntityLockAsync('public-referral-draft', initial.submission.id, async () => {
    const loaded = activePublicReferralDraft({ slug: input.slug, token: input.token });
    if (!loaded) throw new Error('public referral draft not found');
    if (loaded.submission.status !== 'draft' || Date.parse(loaded.submission.expiresAt) <= Date.now()) {
      throw new Error(`this referral draft is ${loaded.submission.status}`);
    }
    const version = formTemplateVersion(loaded.form.orgId, loaded.submission.templateId, loaded.submission.templateVersion);
    if (!version || contentHash(version.schema) !== loaded.submission.schemaHash) throw new Error('referral form evidence no longer matches its published schema');
    const answers = validateFormAnswers(version.schema, input.answers, { partial: true });
    assertReferralDocuments(loaded.form, loaded.submission, answerDocumentIds(version.schema, answers), false);
    return commitBatch({ upserts: [{
      collection: 'referralFormSubmissions',
      doc: { ...loaded.submission, answers },
      expectedRevision: loaded.submission.revision,
      expectedOrgId: loaded.submission.orgId,
    }] }).upserts[0] as ReferralFormSubmissionDoc;
  });
}

/**
 * Completes and registers one public attachment while holding the same
 * cross-process lock as final submission. A submit therefore cannot overtake an
 * in-flight encrypted upload and an upload cannot create new evidence after the
 * referral has been accepted.
 */
export async function completePublicReferralUpload(input: {
  slug: string;
  token: string;
  fieldKey: string;
  bytes: Buffer;
  mimeType: string;
  originalName: string;
}) {
  const initial = activePublicReferralDraft({ slug: input.slug, token: input.token });
  if (!initial) throw new Error('public referral draft not found');
  return withEntityLockAsync('public-referral-draft', initial.submission.id, async () => {
    const loaded = activePublicReferralDraft({ slug: input.slug, token: input.token });
    if (!loaded) throw new Error('public referral draft not found');
    if (loaded.submission.status !== 'draft' || Date.parse(loaded.submission.expiresAt) <= Date.now()) {
      throw new Error(`this referral draft is ${loaded.submission.status}`);
    }
    const field = loaded.version.schema.fields.find((item) => item.key === input.fieldKey && item.type === 'file');
    if (!field) throw new Error('the upload field is invalid');
    if (loaded.submission.documentIds.length >= 50) throw new Error('this referral already has the maximum number of attachments');
    const capability = createDocumentUploadToken({
      orgId: loaded.form.orgId,
      ownerType: 'referral_submission',
      ownerId: loaded.submission.id,
      title: `${field.label} — ${input.originalName}`,
      category: 'referral_attachment',
      allowedMimeTypes: [input.mimeType],
      maxBytes: 10 * 1024 * 1024,
      actor: 'public-referral',
    });
    const completed = await completeDocumentUpload({
      token: capability.token,
      bytes: input.bytes,
      mimeType: input.mimeType,
      originalName: input.originalName,
      actor: 'public-referral',
    });
    const current = referralFormSubmissionByToken(loaded.form, input.token);
    if (!current || current.status !== 'draft') throw new Error('this referral draft changed while the attachment was being secured');
    const documentIds = [...new Set([...current.documentIds, completed.document.id])];
    const submission = commitBatch({ upserts: [{
      collection: 'referralFormSubmissions',
      doc: { ...current, documentIds },
      expectedRevision: current.revision,
      expectedOrgId: current.orgId,
    }] }).upserts[0] as ReferralFormSubmissionDoc;
    return { ...completed, submission };
  });
}

function submitPublicReferralLocked(input: { slug: string; token: string; answers: unknown; ip?: string }) {
  const loaded = activePublicReferralDraft({ slug: input.slug, token: input.token });
  if (!loaded) throw new Error('public referral draft not found');
  const { form, submission } = loaded;
  if (submission.status === 'submitted') throw new Error('this referral was already submitted');
  if (submission.status !== 'draft' || Date.parse(submission.expiresAt) <= Date.now()) throw new Error('this referral draft has expired');
  const version = formTemplateVersion(form.orgId, submission.templateId, submission.templateVersion);
  if (!version || contentHash(version.schema) !== submission.schemaHash) throw new Error('referral form evidence no longer matches its published schema');
  const answers = validateFormAnswers(version.schema, input.answers);
  if (submission.mapping.consent && answers[submission.mapping.consent] !== true) throw new Error('the required consent acknowledgement must be confirmed');
  const documentIds = answerDocumentIds(version.schema, answers);
  assertReferralDocuments(form, submission, documentIds, true);
  const referrerName = answerText(answers, submission.mapping.referrerName);
  const prepared = referralCreateDraft({
    orgId: form.orgId, source: 'secure_form', externalReference: submission.id,
    referralFormId: form.id, referralFormSubmissionId: submission.id,
    priority: submission.routing.priority, serviceId: submission.routing.serviceId, locationId: submission.routing.locationId,
    practitionerId: submission.routing.practitionerId, ownerId: submission.routing.ownerId,
    patient: {
      name: answerText(answers, submission.mapping.patientName),
      dateOfBirth: answerText(answers, submission.mapping.dateOfBirth), email: answerText(answers, submission.mapping.email),
      phone: answerText(answers, submission.mapping.phone), address: answerText(answers, submission.mapping.address),
    },
    referrer: referrerName ? {
      name: referrerName, email: answerText(answers, submission.mapping.referrerEmail),
      phone: answerText(answers, submission.mapping.referrerPhone), organisation: answerText(answers, submission.mapping.referrerOrganisation),
      role: answerText(answers, submission.mapping.referrerRole),
    } : undefined,
    reason: answerText(answers, submission.mapping.reason) ?? '', notes: answerText(answers, submission.mapping.notes),
    consentConfirmed: submission.mapping.consent ? true : undefined, documentIds, actor: 'public-referral',
  });
  const at = nowIso();
  const finalSubmission: ReferralFormSubmissionDoc = {
    ...submission, status: 'submitted', answers, answersHash: contentHash(answers), documentIds,
    referralId: prepared.referral.id, submittedAt: at,
    submittedIpHash: input.ip && (process.env.VOXERA_IP_HASH_KEY || process.env.VOXERA_DOCUMENT_MASTER_KEY)
      ? crypto.createHmac('sha256', process.env.VOXERA_IP_HASH_KEY || process.env.VOXERA_DOCUMENT_MASTER_KEY!).update(`${form.id}:${input.ip}`).digest('hex')
      : undefined,
  };
  const committed = commitBatch({ upserts: [
    { collection: 'referralFormSubmissions', doc: finalSubmission, expectedRevision: submission.revision, expectedOrgId: form.orgId },
    { collection: 'referrals', doc: prepared.referral, expectedRevision: null, expectedOrgId: form.orgId },
    { collection: 'referralEvents', doc: prepared.event, expectedRevision: null, expectedOrgId: form.orgId },
    { collection: 'audit', doc: prepared.audit, expectedRevision: null, expectedOrgId: form.orgId },
    { collection: 'audit', doc: auditDoc(form.orgId, 'public-referral', 'referral_form.submitted', submission.id, `form ${form.id} version ${submission.templateVersion}`), expectedRevision: null, expectedOrgId: form.orgId },
    ...prepared.automationWrites,
  ] });
  const referral = committed.upserts.find((row) => row.id === prepared.referral.id) as ReferralDoc;
  return {
    referral,
    submission: committed.upserts.find((row) => row.id === submission.id) as ReferralFormSubmissionDoc,
    duplicateCandidates: referralDuplicateCandidates(form.orgId, referral.patient, referral.id),
    completionMessage: form.completionMessage,
  };
}

export async function submitPublicReferral(input: { slug: string; token: string; answers: unknown; ip?: string }) {
  const initial = activePublicReferralDraft({ slug: input.slug, token: input.token });
  if (!initial) throw new Error('public referral draft not found');
  return withEntityLockAsync('public-referral-draft', initial.submission.id, async () => submitPublicReferralLocked(input));
}

export function referralFormSubmissionById(orgId: string, id: string) {
  const row = findByPath<ReferralFormSubmissionDoc>('referralFormSubmissions', 'id', id);
  return row?.orgId === orgId ? row : undefined;
}

export function referralFormVersionForSubmission(orgId: string, submissionId: string): FormTemplateVersionDoc | undefined {
  const submission = referralFormSubmissionById(orgId, submissionId);
  return submission ? formTemplateVersion(orgId, submission.templateId, submission.templateVersion) : undefined;
}

export function referralSubmissionEvidenceState(orgId: string, submissionId: string) {
  const submission = referralFormSubmissionById(orgId, submissionId);
  const version = submission ? referralFormVersionForSubmission(orgId, submission.id) : undefined;
  const answerEvidence = Boolean(submission?.status === 'submitted' && submission.answers && submission.answersHash && contentHash(submission.answers) === submission.answersHash);
  const schemaEvidence = Boolean(submission && version && contentHash(version.schema) === submission.schemaHash);
  return { verified: answerEvidence && schemaEvidence, answerEvidence, schemaEvidence };
}
