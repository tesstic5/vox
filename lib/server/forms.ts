import crypto from 'node:crypto';
import { CommitConflictError, commitBatch, find, findByPath, get, list, newId, nowIso, type Doc } from './db';
import { clientById, normaliseNumber, splitName, type ClientDoc } from './clients';
import { validateFormAnswers, validateFormSchema, type FormAnswers, type FormSchema } from '../forms-schema';
import { documentById } from './clinical-documents';
import {
  customFieldDefinitionByKey,
  customFieldValueForTarget,
  customFieldValueWrite,
  sanitiseCustomFieldValue,
} from './intake-admin';
import { automationEventWrites } from './automations/events';
import { cleanLegacyAddress, structuredAddressFromLegacy } from '../addresses';

export type FormTemplateState = 'draft' | 'published' | 'archived';

export type FormTemplateDoc = Doc & {
  orgId: string;
  name: string;
  category: 'intake' | 'screening' | 'consent' | 'outcome' | 'administrative' | 'referral';
  state: FormTemplateState;
  currentVersion: number;
  publishedVersion?: number;
  createdBy: string;
  updatedBy: string;
  revision: number;
};

export type FormTemplateVersionDoc = Doc & {
  orgId: string;
  templateId: string;
  version: number;
  schema: FormSchema;
  schemaHash: string;
  author: string;
  createdAt: string;
  revision: number;
};

export type FormAssignmentDoc = Doc & {
  orgId: string;
  templateId: string;
  templateVersion: number;
  clientId?: string;
  bookingId?: string;
  referralId?: string;
  relatedContactId?: string;
  tokenHash: string;
  expiresAt: string;
  status: 'created' | 'sent' | 'viewed' | 'in_progress' | 'submitted' | 'revoked' | 'expired';
  reminderPolicy?: { enabled: boolean; afterHours: number; max: number };
  messageId?: string;
  createdBy: string;
  sentAt?: string;
  viewedAt?: string;
  submittedAt?: string;
  revokedAt?: string;
  revision: number;
};

export type FormResponseDoc = Doc & {
  orgId: string;
  assignmentId: string;
  templateId: string;
  templateVersion: number;
  clientId?: string;
  referralId?: string;
  status: 'in_progress' | 'submitted' | 'reviewed';
  currentVersion: number;
  submittedAt?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewNote?: string;
  respondent: { relationship: 'self' | 'guardian' | 'proxy' | 'referrer'; name?: string };
  revision: number;
};

export type FormResponseVersionDoc = Doc & {
  orgId: string;
  responseId: string;
  version: number;
  answers: FormAnswers;
  answersHash: string;
  status: 'saved' | 'submitted';
  respondent: FormResponseDoc['respondent'];
  submittedIpHash?: string;
  createdAt: string;
  revision: number;
};

export type ClientUpdateSuggestionDoc = Doc & {
  orgId: string;
  clientId: string;
  responseId: string;
  fieldKey: string;
  target: string;
  oldValue?: string;
  proposedValue: string;
  customFieldDefinitionId?: string;
  proposedTypedValue?: unknown;
  targetRevision?: number;
  status: 'pending' | 'accepted' | 'rejected';
  reviewedAt?: string;
  reviewedBy?: string;
  reviewNote?: string;
  revision: number;
};

function hash(value: unknown) {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, canonical(nested)]));
    }
    return input;
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function tokenHash(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function auditDoc(orgId: string, actor: string, action: string, target: string, detail: string): Doc {
  return { id: newId('aud_'), orgId, actor, action, kind: 'intake', target, detail, at: nowIso() };
}

function assertUpdateMappings(orgId: string, schema: FormSchema) {
  const compatible: Record<string, string[]> = {
    text: ['text', 'single_choice'],
    long_text: ['long_text', 'text'],
    number: ['number'],
    date: ['date'],
    boolean: ['yes_no', 'acknowledgement'],
    single_choice: ['single_choice'],
    multiple_choice: ['multiple_choice'],
  };
  for (const field of schema.fields) {
    if (!field.updateTarget) continue;
    if (!field.updateTarget.startsWith('custom:')) {
      if (!['text', 'long_text'].includes(field.type)) throw new Error(`${field.label} must be a text field to update ${field.updateTarget}.`);
      continue;
    }
    const definition = customFieldDefinitionByKey(orgId, 'client', field.updateTarget.slice('custom:'.length));
    if (!definition?.active) throw new Error(`${field.label} maps to a custom field that does not exist or is inactive.`);
    if (!(compatible[definition.valueType] ?? []).includes(field.type)) {
      throw new Error(`${field.label} is not compatible with the ${definition.valueType.replaceAll('_', ' ')} custom field ${definition.label}.`);
    }
    if (definition.valueType === 'single_choice' || definition.valueType === 'multiple_choice') {
      const definitionValues = new Set((definition.options ?? []).map((option) => option.value));
      if ((field.options ?? []).some((option) => !definitionValues.has(option.value))) {
        throw new Error(`${field.label} contains a choice that is not configured for ${definition.label}.`);
      }
    }
  }
}

function templateFor(orgId: string, id: string) {
  const row = get<FormTemplateDoc>('formTemplates', id);
  return row?.orgId === orgId ? row : undefined;
}

export function formTemplatesFor(orgId: string, options: { includeArchived?: boolean } = {}) {
  return list<FormTemplateDoc>('formTemplates', (row) => row.orgId === orgId && (options.includeArchived || row.state !== 'archived'))
    .sort((a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)));
}

export function formTemplateById(orgId: string, id: string) {
  return templateFor(orgId, id);
}

export function formTemplateVersion(orgId: string, templateId: string, version?: number) {
  const template = templateFor(orgId, templateId);
  if (!template) return undefined;
  const wanted = version ?? template.publishedVersion ?? template.currentVersion;
  return find<FormTemplateVersionDoc>('formTemplateVersions', (row) => row.orgId === orgId && row.templateId === templateId && row.version === wanted);
}

export function createFormTemplate(input: {
  orgId: string;
  name: string;
  category?: FormTemplateDoc['category'];
  schema: unknown;
  actor: string;
}) {
  const schema = validateFormSchema(input.schema);
  assertUpdateMappings(input.orgId, schema);
  const name = String(input.name || schema.title).trim();
  if (name.length < 2 || name.length > 160) throw new Error('Template name must be 2 to 160 characters.');
  const id = newId('frm_');
  const at = nowIso();
  const template: FormTemplateDoc = {
    id, orgId: input.orgId, name, category: input.category ?? 'intake', state: 'draft',
    currentVersion: 1, createdBy: input.actor, updatedBy: input.actor, revision: 0, createdAt: at, updatedAt: at,
  };
  const version: FormTemplateVersionDoc = {
    id: `${id}_v1`, orgId: input.orgId, templateId: id, version: 1, schema,
    schemaHash: hash(schema), author: input.actor, revision: 0, createdAt: at,
  };
  const committed = commitBatch({ upserts: [
    { collection: 'formTemplates', doc: template, expectedRevision: null, expectedOrgId: input.orgId },
    { collection: 'formTemplateVersions', doc: version, expectedRevision: null, expectedOrgId: input.orgId },
    { collection: 'audit', doc: auditDoc(input.orgId, input.actor, 'form.template_created', id, `${template.category} template`), expectedRevision: null, expectedOrgId: input.orgId },
  ] });
  return {
    template: committed.upserts.find((row) => row.id === id) as FormTemplateDoc,
    version: committed.upserts.find((row) => row.id === version.id) as FormTemplateVersionDoc,
  };
}

export function reviseFormTemplate(input: { orgId: string; id: string; schema: unknown; name?: string; category?: FormTemplateDoc['category']; actor: string; expectedRevision: number }) {
  const template = templateFor(input.orgId, input.id);
  if (!template) throw new Error('form template not found');
  if (template.revision !== input.expectedRevision) throw new Error('form template changed after it was loaded');
  if (template.state === 'archived') throw new Error('archived form templates cannot be revised');
  const schema = validateFormSchema(input.schema);
  assertUpdateMappings(input.orgId, schema);
  const versionNumber = template.currentVersion + 1;
  const version: FormTemplateVersionDoc = {
    id: `${template.id}_v${versionNumber}`, orgId: input.orgId, templateId: template.id,
    version: versionNumber, schema, schemaHash: hash(schema), author: input.actor, revision: 0, createdAt: nowIso(),
  };
  const next: FormTemplateDoc = {
    ...template,
    name: input.name ? String(input.name).trim().slice(0, 160) : template.name,
    category: input.category ?? template.category,
    state: 'draft', currentVersion: versionNumber, updatedBy: input.actor,
  };
  const committed = commitBatch({ upserts: [
    { collection: 'formTemplates', doc: next, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId },
    { collection: 'formTemplateVersions', doc: version, expectedRevision: null, expectedOrgId: input.orgId },
    { collection: 'audit', doc: auditDoc(input.orgId, input.actor, 'form.template_revised', template.id, `version ${versionNumber}`), expectedRevision: null, expectedOrgId: input.orgId },
  ] });
  return {
    template: committed.upserts.find((row) => row.id === template.id) as FormTemplateDoc,
    version: committed.upserts.find((row) => row.id === version.id) as FormTemplateVersionDoc,
  };
}

export function setFormTemplateState(input: { orgId: string; id: string; state: FormTemplateState; actor: string; expectedRevision: number }) {
  const template = templateFor(input.orgId, input.id);
  if (!template) throw new Error('form template not found');
  if (template.revision !== input.expectedRevision) throw new Error('form template changed after it was loaded');
  if (input.state === 'published' && !formTemplateVersion(input.orgId, template.id, template.currentVersion)) throw new Error('template version not found');
  const next: FormTemplateDoc = {
    ...template,
    state: input.state,
    publishedVersion: input.state === 'published' ? template.currentVersion : template.publishedVersion,
    updatedBy: input.actor,
  };
  return commitBatch({ upserts: [
    { collection: 'formTemplates', doc: next, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId },
    { collection: 'audit', doc: auditDoc(input.orgId, input.actor, `form.template_${input.state}`, template.id, `version ${template.currentVersion}`), expectedRevision: null, expectedOrgId: input.orgId },
  ] }).upserts.find((row) => row.id === template.id) as FormTemplateDoc;
}

export function formAssignmentsFor(orgId: string, filter: { clientId?: string; status?: FormAssignmentDoc['status']; templateId?: string } = {}) {
  return list<FormAssignmentDoc>('formAssignments', (row) => row.orgId === orgId && (!filter.clientId || row.clientId === filter.clientId) && (!filter.status || row.status === filter.status) && (!filter.templateId || row.templateId === filter.templateId))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function formAssignmentById(orgId: string, id: string) {
  const row = findByPath<FormAssignmentDoc>('formAssignments', 'id', id);
  return row?.orgId === orgId ? row : undefined;
}

export function createFormAssignment(input: {
  orgId: string;
  templateId: string;
  clientId?: string;
  bookingId?: string;
  referralId?: string;
  relatedContactId?: string;
  expiresAt?: string;
  reminderPolicy?: FormAssignmentDoc['reminderPolicy'];
  actor: string;
}) {
  const template = templateFor(input.orgId, input.templateId);
  if (!template || template.state !== 'published' || !template.publishedVersion) throw new Error('a published form template is required');
  if (input.clientId && !clientById(input.orgId, input.clientId)) throw new Error('client not found');
  const expiry = input.expiresAt ? Date.parse(input.expiresAt) : Date.now() + 14 * 86_400_000;
  if (!Number.isFinite(expiry) || expiry < Date.now() + 5 * 60_000 || expiry > Date.now() + 90 * 86_400_000) throw new Error('form link expiry must be between five minutes and 90 days');
  const token = crypto.randomBytes(32).toString('base64url');
  const id = newId('fas_');
  const assignment: FormAssignmentDoc = {
    id, orgId: input.orgId, templateId: template.id, templateVersion: template.publishedVersion,
    clientId: input.clientId, bookingId: input.bookingId, referralId: input.referralId, relatedContactId: input.relatedContactId,
    tokenHash: tokenHash(token), expiresAt: new Date(expiry).toISOString(), status: 'created',
    reminderPolicy: input.reminderPolicy, createdBy: input.actor, revision: 0, createdAt: nowIso(),
  };
  const committed = commitBatch({ upserts: [
    { collection: 'formAssignments', doc: assignment, expectedRevision: null, expectedOrgId: input.orgId },
    { collection: 'audit', doc: auditDoc(input.orgId, input.actor, 'form.assignment_created', id, `template ${template.id}`), expectedRevision: null, expectedOrgId: input.orgId },
  ] });
  return { assignment: committed.upserts.find((row) => row.id === id) as FormAssignmentDoc, token };
}

export function markFormAssignmentSent(input: { orgId: string; id: string; messageId: string; actor: string }) {
  const row = formAssignmentById(input.orgId, input.id);
  if (!row) throw new Error('form assignment not found');
  if (!['created', 'sent'].includes(row.status)) throw new Error(`a ${row.status} form assignment cannot be sent`);
  return commitBatch({ upserts: [{
    collection: 'formAssignments', doc: { ...row, status: 'sent', messageId: input.messageId, sentAt: nowIso() },
    expectedRevision: row.revision, expectedOrgId: input.orgId,
  }] }).upserts[0] as FormAssignmentDoc;
}

export function revokeFormAssignment(input: { orgId: string; id: string; actor: string; expectedRevision: number }) {
  const row = formAssignmentById(input.orgId, input.id);
  if (!row) throw new Error('form assignment not found');
  if (row.revision !== input.expectedRevision) throw new Error('form assignment changed after it was loaded');
  if (row.status === 'submitted') throw new Error('a submitted form assignment cannot be revoked');
  if (row.status === 'revoked') return row;
  return commitBatch({ upserts: [
    { collection: 'formAssignments', doc: { ...row, status: 'revoked', revokedAt: nowIso() }, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId },
    { collection: 'audit', doc: auditDoc(input.orgId, input.actor, 'form.assignment_revoked', row.id, `template ${row.templateId}`), expectedRevision: null, expectedOrgId: input.orgId },
  ] }).upserts.find((item) => item.id === row.id) as FormAssignmentDoc;
}

export function formAssignmentByToken(token: string) {
  const digest = tokenHash(String(token));
  return findByPath<FormAssignmentDoc>('formAssignments', 'tokenHash', digest);
}

export function publicFormForToken(token: string) {
  const assignment = formAssignmentByToken(token);
  if (!assignment) return undefined;
  if (Date.parse(assignment.expiresAt) <= Date.now() && !['submitted', 'revoked', 'expired'].includes(assignment.status)) {
    commitBatch({ upserts: [{ collection: 'formAssignments', doc: { ...assignment, status: 'expired' }, expectedRevision: assignment.revision, expectedOrgId: assignment.orgId }] });
    return { assignment: { ...assignment, status: 'expired' as const }, version: formTemplateVersion(assignment.orgId, assignment.templateId, assignment.templateVersion) };
  }
  const version = formTemplateVersion(assignment.orgId, assignment.templateId, assignment.templateVersion);
  if (!version) return undefined;
  if (!assignment.viewedAt && ['created', 'sent'].includes(assignment.status)) {
    try {
      const updated = commitBatch({ upserts: [{
        collection: 'formAssignments', doc: { ...assignment, status: 'viewed', viewedAt: nowIso() }, expectedRevision: assignment.revision, expectedOrgId: assignment.orgId,
      }] }).upserts[0] as FormAssignmentDoc;
      return { assignment: updated, version };
    } catch (error) {
      if (!(error instanceof CommitConflictError)) throw error;
      const winner = formAssignmentById(assignment.orgId, assignment.id);
      if (!winner) return undefined;
      return { assignment: winner, version };
    }
  }
  return { assignment, version };
}

export function formResponsesFor(orgId: string, filter: { clientId?: string; assignmentId?: string; status?: FormResponseDoc['status'] } = {}) {
  return list<FormResponseDoc>('formResponses', (row) => row.orgId === orgId && (!filter.clientId || row.clientId === filter.clientId) && (!filter.assignmentId || row.assignmentId === filter.assignmentId) && (!filter.status || row.status === filter.status))
    .sort((a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)));
}

export function formResponseForAssignment(orgId: string, assignmentId: string) {
  const row = findByPath<FormResponseDoc>('formResponses', 'assignmentId', assignmentId);
  return row?.orgId === orgId ? row : undefined;
}

export function formResponseVersion(orgId: string, responseId: string, version?: number) {
  const response = get<FormResponseDoc>('formResponses', responseId);
  if (!response || response.orgId !== orgId) return undefined;
  return find<FormResponseVersionDoc>('formResponseVersions', (row) => row.orgId === orgId && row.responseId === responseId && row.version === (version ?? response.currentVersion));
}

function suggestionDisplayValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function sameSuggestionValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function suggestionsForResponse(orgId: string, response: FormResponseDoc, schema: FormSchema, answers: FormAnswers): ClientUpdateSuggestionDoc[] {
  if (!response.clientId) return [];
  const client = clientById(orgId, response.clientId);
  if (!client) return [];
  const current: Record<string, unknown> = { name: client.name, email: client.email, phone: client.number, address: client.address };
  return schema.fields.flatMap((field): ClientUpdateSuggestionDoc[] => {
    if (!field.updateTarget || answers[field.key] === undefined) return [];
    const target = field.updateTarget;
    if (target.startsWith('custom:')) {
      const definition = customFieldDefinitionByKey(orgId, 'client', target.slice('custom:'.length));
      if (!definition?.active) throw new Error(`The mapped custom field for ${field.label} is no longer available. Contact the practice.`);
      const proposedTypedValue = sanitiseCustomFieldValue(definition, answers[field.key]);
      const existing = customFieldValueForTarget(orgId, definition.id, 'client', client.id);
      if ((!existing && proposedTypedValue === null) || sameSuggestionValue(existing?.value, proposedTypedValue)) return [];
      return [{
        id: newId('cus_'), orgId, clientId: client.id, responseId: response.id,
        fieldKey: field.key, target, customFieldDefinitionId: definition.id,
        oldValue: suggestionDisplayValue(existing?.value) || undefined,
        proposedValue: suggestionDisplayValue(proposedTypedValue), proposedTypedValue,
        targetRevision: existing?.revision,
        status: 'pending' as const, revision: 0, createdAt: nowIso(),
      }];
    }
    const proposedValue = String(answers[field.key] ?? '').trim();
    const oldValue = String(current[target] ?? '').trim();
    if (!proposedValue || proposedValue === oldValue) return [];
    return [{
      id: newId('cus_'), orgId, clientId: client.id, responseId: response.id,
      fieldKey: field.key, target, oldValue: oldValue || undefined, proposedValue,
      targetRevision: Number(client.revision ?? 0),
      status: 'pending' as const, revision: 0, createdAt: nowIso(),
    }];
  });
}

export function savePublicForm(input: {
  token: string;
  answers: unknown;
  submit: boolean;
  respondent?: FormResponseDoc['respondent'];
  ip?: string;
}) {
  const loaded = publicFormForToken(input.token);
  if (!loaded) throw new Error('form link not found');
  const { assignment, version } = loaded;
  if (!version) throw new Error('form template version not found');
  if (assignment.status === 'submitted') throw new Error('this form was already submitted');
  if (assignment.status === 'revoked') throw new Error('this form link was revoked');
  if (assignment.status === 'expired' || Date.parse(assignment.expiresAt) <= Date.now()) throw new Error('this form link has expired');
  const answers = validateFormAnswers(version.schema, input.answers, { partial: !input.submit });
  const existing = formResponseForAssignment(assignment.orgId, assignment.id);
  if (existing?.status === 'submitted') throw new Error('this form was already submitted');
  const responseId = existing?.id ?? newId('frs_');
  for (const field of version.schema.fields.filter((item) => item.type === 'file')) {
    for (const documentId of (answers[field.key] as string[] | undefined) ?? []) {
      const document = documentById(assignment.orgId, documentId);
      if (!document || document.ownerType !== 'form_response' || document.ownerId !== responseId || document.category !== 'form_attachment' || document.patientId !== assignment.clientId) {
        throw new Error(`${field.label} contains a document that was not uploaded for this form response.`);
      }
    }
  }
  const nextVersion = (existing?.currentVersion ?? 0) + 1;
  const at = nowIso();
  const respondent = input.respondent ?? existing?.respondent ?? { relationship: 'self' };
  const response: FormResponseDoc = {
    ...(existing ?? {}), id: responseId, orgId: assignment.orgId, assignmentId: assignment.id,
    templateId: assignment.templateId, templateVersion: assignment.templateVersion,
    clientId: assignment.clientId, referralId: assignment.referralId,
    status: input.submit ? 'submitted' : 'in_progress', currentVersion: nextVersion,
    submittedAt: input.submit ? at : undefined, respondent, revision: existing?.revision ?? 0,
    createdAt: existing?.createdAt ?? at,
  } as FormResponseDoc;
  const responseVersion: FormResponseVersionDoc = {
    id: `${responseId}_v${nextVersion}`, orgId: assignment.orgId, responseId, version: nextVersion,
    answers, answersHash: hash(answers), status: input.submit ? 'submitted' : 'saved', respondent,
    submittedIpHash: input.submit && input.ip ? tokenHash(input.ip) : undefined,
    createdAt: at, revision: 0,
  };
  const nextAssignment: FormAssignmentDoc = {
    ...assignment, status: input.submit ? 'submitted' : 'in_progress', submittedAt: input.submit ? at : undefined,
  };
  const suggestions = input.submit ? suggestionsForResponse(assignment.orgId, response, version.schema, answers) : [];
  const automationWrites = input.submit ? automationEventWrites({
    orgId: assignment.orgId, trigger: 'form.response_submitted', aggregateType: 'form_response', aggregateId: responseId,
    sourceEventId: responseVersion.id, occurredAt: at,
    payload: { form: {
      templateId: assignment.templateId, assignmentId: assignment.id, clientId: assignment.clientId ?? '',
      respondentRelationship: respondent.relationship ?? '',
    } },
  }) : [];
  const committed = commitBatch({ upserts: [
    { collection: 'formResponses', doc: response, expectedRevision: existing ? existing.revision : null, expectedOrgId: assignment.orgId },
    { collection: 'formResponseVersions', doc: responseVersion, expectedRevision: null, expectedOrgId: assignment.orgId },
    { collection: 'formAssignments', doc: nextAssignment, expectedRevision: assignment.revision, expectedOrgId: assignment.orgId },
    ...suggestions.map((row) => ({ collection: 'clientUpdateSuggestions', doc: row as Doc, expectedRevision: null, expectedOrgId: assignment.orgId })),
    { collection: 'audit', doc: auditDoc(assignment.orgId, 'public-form', input.submit ? 'form.response_submitted' : 'form.response_saved', responseId, `template ${assignment.templateId} version ${assignment.templateVersion}`), expectedRevision: null, expectedOrgId: assignment.orgId },
    ...automationWrites,
  ] });
  return {
    assignment: committed.upserts.find((row) => row.id === assignment.id) as FormAssignmentDoc,
    response: committed.upserts.find((row) => row.id === responseId) as FormResponseDoc,
    version: committed.upserts.find((row) => row.id === responseVersion.id) as FormResponseVersionDoc,
    suggestions: committed.upserts.filter((row) => suggestions.some((suggestion) => suggestion.id === row.id)) as ClientUpdateSuggestionDoc[],
  };
}

export function reviewFormResponse(input: { orgId: string; id: string; actor: string; note?: string; expectedRevision: number }) {
  const response = get<FormResponseDoc>('formResponses', input.id);
  if (!response || response.orgId !== input.orgId) throw new Error('form response not found');
  if (response.status !== 'submitted') throw new Error('only a submitted response can be reviewed');
  return commitBatch({ upserts: [
    { collection: 'formResponses', doc: { ...response, status: 'reviewed', reviewedAt: nowIso(), reviewedBy: input.actor, reviewNote: input.note?.slice(0, 2_000) }, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId },
    { collection: 'audit', doc: auditDoc(input.orgId, input.actor, 'form.response_reviewed', response.id, 'staff review complete'), expectedRevision: null, expectedOrgId: input.orgId },
  ] }).upserts.find((row) => row.id === response.id) as FormResponseDoc;
}

export function updateSuggestionsFor(orgId: string, options: { status?: ClientUpdateSuggestionDoc['status']; clientId?: string } = {}) {
  return list<ClientUpdateSuggestionDoc>('clientUpdateSuggestions', (row) => row.orgId === orgId && (!options.status || row.status === options.status) && (!options.clientId || row.clientId === options.clientId));
}

export function updateSuggestionById(orgId: string, id: string) {
  const row = get<ClientUpdateSuggestionDoc>('clientUpdateSuggestions', id);
  return row?.orgId === orgId ? row : undefined;
}

export function reviewUpdateSuggestion(input: { orgId: string; id: string; accept: boolean; actor: string; note?: string; expectedRevision: number }) {
  const suggestion = get<ClientUpdateSuggestionDoc>('clientUpdateSuggestions', input.id);
  if (!suggestion || suggestion.orgId !== input.orgId) throw new Error('update suggestion not found');
  if (suggestion.status !== 'pending') throw new Error('update suggestion was already reviewed');
  if (suggestion.revision !== input.expectedRevision) throw new Error('update suggestion changed after it was loaded');
  const client = clientById(input.orgId, suggestion.clientId);
  if (!client) throw new Error('client not found');
  const reviewed: ClientUpdateSuggestionDoc = {
    ...suggestion, status: input.accept ? 'accepted' : 'rejected', reviewedAt: nowIso(), reviewedBy: input.actor, reviewNote: input.note?.slice(0, 1_000),
  };
  const upserts: Array<{ collection: string; doc: Doc; expectedRevision: number | null; expectedOrgId: string }> = [
    { collection: 'clientUpdateSuggestions', doc: reviewed, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId },
    { collection: 'audit', doc: auditDoc(input.orgId, input.actor, `client.update_suggestion_${input.accept ? 'accepted' : 'rejected'}`, suggestion.id, suggestion.target), expectedRevision: null, expectedOrgId: input.orgId },
  ];
  let customValueId: string | undefined;
  if (input.accept && suggestion.target.startsWith('custom:')) {
    const definition = customFieldDefinitionByKey(input.orgId, 'client', suggestion.target.slice('custom:'.length));
    if (!definition || definition.id !== suggestion.customFieldDefinitionId || !definition.active) throw new Error('mapped custom-field definition is no longer active');
    const current = customFieldValueForTarget(input.orgId, definition.id, 'client', client.id);
    if ((current?.revision) !== suggestion.targetRevision) throw new Error('custom-field value changed after this suggestion was created');
    const prepared = customFieldValueWrite({
      orgId: input.orgId, definition, targetType: 'client', targetId: client.id,
      value: suggestion.proposedTypedValue, source: 'form', verificationStatus: 'verified', actor: input.actor,
    });
    customValueId = prepared.row.id;
    upserts.push(
      { collection: 'customFieldValues', doc: prepared.row, expectedRevision: current ? current.revision : null, expectedOrgId: input.orgId },
      { collection: 'audit', doc: auditDoc(input.orgId, input.actor, 'custom_field.form_suggestion_applied', prepared.row.id, `${definition.targetType}.${definition.key}`), expectedRevision: null, expectedOrgId: input.orgId },
    );
  } else if (input.accept) {
    if (!['name', 'email', 'phone', 'address'].includes(suggestion.target)) throw new Error('update suggestion target is invalid');
    if (suggestion.targetRevision !== undefined && Number(client.revision ?? 0) !== suggestion.targetRevision) {
      throw new Error('patient record changed after this suggestion was created');
    }
    const patch: Partial<ClientDoc> = {};
    if (suggestion.target === 'name') Object.assign(patch, { name: suggestion.proposedValue, ...splitName(suggestion.proposedValue) });
    if (suggestion.target === 'email') patch.email = suggestion.proposedValue.toLowerCase();
    if (suggestion.target === 'phone') patch.number = normaliseNumber(suggestion.proposedValue);
    if (suggestion.target === 'address') {
      patch.address = cleanLegacyAddress(suggestion.proposedValue);
      patch.structuredAddress = structuredAddressFromLegacy(patch.address);
    }
    upserts.push({ collection: 'clients', doc: { ...client, ...patch }, expectedRevision: Number(client.revision ?? 0), expectedOrgId: input.orgId });
  }
  const committed = commitBatch({ upserts });
  return {
    suggestion: committed.upserts.find((row) => row.id === suggestion.id) as ClientUpdateSuggestionDoc,
    client: committed.upserts.find((row) => row.id === client.id) as ClientDoc | undefined,
    customFieldValue: customValueId ? committed.upserts.find((row) => row.id === customValueId) : undefined,
  };
}
