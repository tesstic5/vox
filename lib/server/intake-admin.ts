import { commitBatch, get, list, newId, nowIso, type Doc } from './db';
import { clientById } from './clients';
import { referralById } from './referrals';
import {
  cleanLegacyAddress,
  formatStructuredAddress,
  reviewStructuredAddress,
  structuredAddressFromLegacy,
  type StructuredAddress,
  type StructuredAddressInput,
} from '../addresses';

export type ContactDoc = Doc & {
  orgId: string;
  kind: 'person' | 'organisation';
  name: string;
  email?: string;
  phone?: string;
  /** Compatibility string for existing integrations and exports. */
  address?: string;
  structuredAddress?: StructuredAddress;
  referrer: boolean;
  payer: boolean;
  active: boolean;
  notes?: string;
  createdBy: string;
  updatedBy: string;
  revision: number;
};

export type ClientRelationshipType = 'parent' | 'guardian' | 'partner' | 'child' | 'carer' | 'support_worker' | 'employer' | 'referrer' | 'payer' | 'emergency_contact' | 'other';
export type ClientRelationshipDoc = Doc & {
  orgId: string;
  clientId: string;
  relatedClientId?: string;
  contactId?: string;
  relationshipType: ClientRelationshipType;
  label?: string;
  guardian: boolean;
  proxy: boolean;
  billing: boolean;
  emergency: boolean;
  referrer: boolean;
  verified: boolean;
  verifiedAt?: string;
  verifiedBy?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  status: 'active' | 'ended';
  notes?: string;
  createdBy: string;
  updatedBy: string;
  revision: number;
};

export type CustomFieldTarget = 'client' | 'referral' | 'contact';
export type CustomFieldValueType = 'text' | 'long_text' | 'number' | 'date' | 'boolean' | 'single_choice' | 'multiple_choice';
export type CustomFieldDefinitionDoc = Doc & {
  orgId: string;
  targetType: CustomFieldTarget;
  key: string;
  label: string;
  valueType: CustomFieldValueType;
  options?: Array<{ value: string; label: string }>;
  sensitivity: 'administrative' | 'sensitive' | 'clinical';
  required: boolean;
  active: boolean;
  order: number;
  createdBy: string;
  updatedBy: string;
  revision: number;
};
export type CustomFieldValueDoc = Doc & {
  orgId: string;
  definitionId: string;
  targetType: CustomFieldTarget;
  targetId: string;
  value: unknown;
  source: 'staff' | 'form' | 'referral' | 'import';
  verificationStatus: 'pending' | 'verified' | 'rejected';
  verifiedAt?: string;
  verifiedBy?: string;
  createdBy: string;
  updatedBy: string;
  revision: number;
};

const RELATIONSHIP_TYPES = new Set<ClientRelationshipType>(['parent', 'guardian', 'partner', 'child', 'carer', 'support_worker', 'employer', 'referrer', 'payer', 'emergency_contact', 'other']);
const TARGETS = new Set<CustomFieldTarget>(['client', 'referral', 'contact']);
const VALUE_TYPES = new Set<CustomFieldValueType>(['text', 'long_text', 'number', 'date', 'boolean', 'single_choice', 'multiple_choice']);
const SENSITIVITIES = new Set<CustomFieldDefinitionDoc['sensitivity']>(['administrative', 'sensitive', 'clinical']);
const RELATIONSHIP_STATUSES = new Set<ClientRelationshipDoc['status']>(['active', 'ended']);
const CUSTOM_FIELD_SOURCES = new Set<CustomFieldValueDoc['source']>(['staff', 'form', 'referral', 'import']);
const VERIFICATION_STATUSES = new Set<CustomFieldValueDoc['verificationStatus']>(['pending', 'verified', 'rejected']);

function auditDoc(orgId: string, actor: string, action: string, target: string, detail: string): Doc {
  return { id: newId('aud_'), orgId, actor, action, kind: 'intake_admin', target, detail, at: nowIso() };
}
function assertOptionalBoolean(value: unknown, label: string) {
  if (value !== undefined && typeof value !== 'boolean') throw new Error(`${label} must be true or false`);
}
function cleanEmail(value: unknown) {
  const email = String(value ?? '').trim().toLowerCase();
  if (!email) return undefined;
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('email is invalid');
  return email;
}
function cleanPhone(value: unknown) {
  const phone = String(value ?? '').replace(/[^\d+]/g, '');
  if (!phone) return undefined;
  if (!/^\+?[1-9]\d{6,17}$/.test(phone)) throw new Error('phone number is invalid');
  return phone.startsWith('+') ? phone : `+${phone}`;
}
function cleanDate(value: unknown, label: string) {
  const date = String(value ?? '').trim();
  if (!date) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`${label} must be a calendar date`);
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (parsed.getUTCFullYear() !== Number(match[1]) || parsed.getUTCMonth() !== Number(match[2]) - 1 || parsed.getUTCDate() !== Number(match[3])) {
    throw new Error(`${label} must be a calendar date`);
  }
  return date;
}

export function contactsFor(orgId: string, options: { q?: string; active?: boolean; referrer?: boolean; payer?: boolean } = {}) {
  const q = String(options.q ?? '').trim().toLowerCase();
  return list<ContactDoc>('contacts', (row) => row.orgId === orgId &&
    (options.active === undefined || row.active === options.active) &&
    (options.referrer === undefined || row.referrer === options.referrer) &&
    (options.payer === undefined || row.payer === options.payer) &&
    (!q || `${row.name} ${row.email ?? ''} ${row.phone ?? ''}`.toLowerCase().includes(q)))
    .sort((a, b) => a.name.localeCompare(b.name));
}
export function contactById(orgId: string, id: string) {
  const row = get<ContactDoc>('contacts', id);
  return row?.orgId === orgId ? row : undefined;
}
export function createContact(input: {
  orgId: string; kind?: ContactDoc['kind']; name: string; email?: string; phone?: string; address?: string;
  referrer?: boolean; payer?: boolean; notes?: string; actor: string;
}) {
  if (input.kind !== undefined && !['person', 'organisation'].includes(input.kind)) throw new Error('contact kind is invalid');
  assertOptionalBoolean(input.referrer, 'referrer');
  assertOptionalBoolean(input.payer, 'payer');
  const name = String(input.name ?? '').trim();
  if (name.length < 2 || name.length > 180) throw new Error('contact name must be 2 to 180 characters');
  const address = cleanLegacyAddress(input.address);
  const at = nowIso();
  const contact: ContactDoc = {
    id: newId('con_'), orgId: input.orgId, kind: input.kind ?? 'person', name,
    email: cleanEmail(input.email), phone: cleanPhone(input.phone), address, structuredAddress: structuredAddressFromLegacy(address),
    referrer: Boolean(input.referrer), payer: Boolean(input.payer), active: true,
    notes: input.notes === undefined ? undefined : String(input.notes).trim().slice(0, 5_000) || undefined, createdBy: input.actor, updatedBy: input.actor,
    revision: 0, createdAt: at, updatedAt: at,
  };
  return commitBatch({ upserts: [
    { collection: 'contacts', doc: contact, expectedRevision: null, expectedOrgId: input.orgId },
    { collection: 'audit', doc: auditDoc(input.orgId, input.actor, 'contact.created', contact.id, `${contact.kind}: ${contact.name}`), expectedRevision: null, expectedOrgId: input.orgId },
  ] }).upserts.find((row) => row.id === contact.id) as ContactDoc;
}
export function updateContact(input: {
  orgId: string; id: string; expectedRevision: number; actor: string;
  patch: Partial<Pick<ContactDoc, 'name' | 'email' | 'phone' | 'address' | 'referrer' | 'payer' | 'active' | 'notes'>>;
}) {
  const row = contactById(input.orgId, input.id);
  if (!row) throw new Error('contact not found');
  if (row.revision !== input.expectedRevision) throw new Error('contact changed after it was loaded');
  assertOptionalBoolean(input.patch.referrer, 'referrer');
  assertOptionalBoolean(input.patch.payer, 'payer');
  assertOptionalBoolean(input.patch.active, 'active');
  const name = input.patch.name === undefined ? row.name : String(input.patch.name).trim();
  if (name.length < 2 || name.length > 180) throw new Error('contact name must be 2 to 180 characters');
  const hasLegacyAddressPatch = Object.prototype.hasOwnProperty.call(input.patch, 'address');
  const address = hasLegacyAddressPatch ? cleanLegacyAddress(input.patch.address) : row.address;
  const next: ContactDoc = {
    ...row, name,
    email: input.patch.email === undefined ? row.email : cleanEmail(input.patch.email),
    phone: input.patch.phone === undefined ? row.phone : cleanPhone(input.patch.phone),
    address,
    structuredAddress: hasLegacyAddressPatch ? structuredAddressFromLegacy(address) : row.structuredAddress,
    referrer: input.patch.referrer ?? row.referrer, payer: input.patch.payer ?? row.payer, active: input.patch.active ?? row.active,
    notes: input.patch.notes === undefined ? row.notes : String(input.patch.notes).trim().slice(0, 5_000) || undefined,
    updatedBy: input.actor, updatedAt: nowIso(),
  };
  return commitBatch({ upserts: [
    { collection: 'contacts', doc: next, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId },
    { collection: 'audit', doc: auditDoc(input.orgId, input.actor, 'contact.updated', row.id, row.name), expectedRevision: null, expectedOrgId: input.orgId },
  ] }).upserts.find((item) => item.id === row.id) as ContactDoc;
}

export function updateContactStructuredAddress(input: {
  orgId: string;
  id: string;
  address: StructuredAddressInput;
  expectedRevision: number;
  actor: string;
}) {
  const row = contactById(input.orgId, input.id);
  if (!row) throw new Error('contact not found');
  if (row.revision !== input.expectedRevision) throw new Error('contact changed after it was loaded');
  const structuredAddress = reviewStructuredAddress(input.address, {
    actor: input.actor,
    existing: row.structuredAddress,
    legacyText: row.address,
  });
  const next: ContactDoc = {
    ...row,
    address: formatStructuredAddress(structuredAddress),
    structuredAddress,
    updatedBy: input.actor,
    updatedAt: nowIso(),
  };
  return commitBatch({ upserts: [
    { collection: 'contacts', doc: next, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId },
    { collection: 'audit', doc: auditDoc(input.orgId, input.actor, 'contact.address_reviewed', row.id, 'structured postal address reviewed'), expectedRevision: null, expectedOrgId: input.orgId },
  ] }).upserts.find((item) => item.id === row.id) as ContactDoc;
}

export function clientRelationshipsFor(orgId: string, clientId: string, includeEnded = false) {
  return list<ClientRelationshipDoc>('clientRelationships', (row) => row.orgId === orgId && row.clientId === clientId && (includeEnded || row.status === 'active'))
    .sort((a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)));
}
export function clientRelationshipById(orgId: string, clientId: string, id: string) {
  return clientRelationshipsFor(orgId, clientId, true).find((row) => row.id === id);
}
function validateRelationshipTarget(orgId: string, clientId: string, relatedClientId?: string, contactId?: string) {
  if (Boolean(relatedClientId) === Boolean(contactId)) throw new Error('choose exactly one related patient or contact');
  if (!clientById(orgId, clientId)) throw new Error('patient not found');
  if (relatedClientId) {
    if (relatedClientId === clientId) throw new Error('a patient cannot be related to themselves');
    if (!clientById(orgId, relatedClientId)) throw new Error('related patient not found');
  }
  if (contactId && !contactById(orgId, contactId)) throw new Error('contact not found');
}
export function createClientRelationship(input: {
  orgId: string; clientId: string; relatedClientId?: string; contactId?: string; relationshipType: ClientRelationshipType;
  label?: string; guardian?: boolean; proxy?: boolean; billing?: boolean; emergency?: boolean; referrer?: boolean;
  verified?: boolean; effectiveFrom?: string; effectiveTo?: string; notes?: string; actor: string;
}) {
  validateRelationshipTarget(input.orgId, input.clientId, input.relatedClientId, input.contactId);
  if (!RELATIONSHIP_TYPES.has(input.relationshipType)) throw new Error('relationship type is invalid');
  for (const [label, value] of Object.entries({ guardian: input.guardian, proxy: input.proxy, billing: input.billing, emergency: input.emergency, referrer: input.referrer, verified: input.verified })) {
    assertOptionalBoolean(value, label);
  }
  const effectiveFrom = cleanDate(input.effectiveFrom, 'effective from');
  const effectiveTo = cleanDate(input.effectiveTo, 'effective to');
  if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) throw new Error('effective to cannot be before effective from');
  const duplicate = clientRelationshipsFor(input.orgId, input.clientId).find((row) => row.relationshipType === input.relationshipType && row.relatedClientId === input.relatedClientId && row.contactId === input.contactId);
  if (duplicate) throw new Error('that active relationship already exists');
  const at = nowIso();
  const row: ClientRelationshipDoc = {
    id: newId('rel_'), orgId: input.orgId, clientId: input.clientId, relatedClientId: input.relatedClientId, contactId: input.contactId,
    relationshipType: input.relationshipType, label: input.label === undefined ? undefined : String(input.label).trim().slice(0, 120) || undefined,
    guardian: Boolean(input.guardian), proxy: Boolean(input.proxy), billing: Boolean(input.billing), emergency: Boolean(input.emergency), referrer: Boolean(input.referrer),
    verified: Boolean(input.verified), verifiedAt: input.verified ? at : undefined, verifiedBy: input.verified ? input.actor : undefined,
    effectiveFrom, effectiveTo, status: 'active', notes: input.notes === undefined ? undefined : String(input.notes).trim().slice(0, 5_000) || undefined,
    createdBy: input.actor, updatedBy: input.actor, revision: 0, createdAt: at, updatedAt: at,
  };
  return commitBatch({ upserts: [
    { collection: 'clientRelationships', doc: row, expectedRevision: null, expectedOrgId: input.orgId },
    { collection: 'audit', doc: auditDoc(input.orgId, input.actor, 'client.relationship_created', row.id, `${row.clientId}: ${row.relationshipType}`), expectedRevision: null, expectedOrgId: input.orgId },
  ] }).upserts.find((item) => item.id === row.id) as ClientRelationshipDoc;
}
export function updateClientRelationship(input: {
  orgId: string; clientId: string; id: string; expectedRevision: number; actor: string;
  patch: Partial<Pick<ClientRelationshipDoc, 'relationshipType' | 'label' | 'guardian' | 'proxy' | 'billing' | 'emergency' | 'referrer' | 'verified' | 'effectiveFrom' | 'effectiveTo' | 'notes' | 'status'>>;
}) {
  const row = clientRelationshipById(input.orgId, input.clientId, input.id);
  if (!row) throw new Error('relationship not found');
  if (row.revision !== input.expectedRevision) throw new Error('relationship changed after it was loaded');
  for (const [label, value] of Object.entries({ guardian: input.patch.guardian, proxy: input.patch.proxy, billing: input.patch.billing, emergency: input.patch.emergency, referrer: input.patch.referrer, verified: input.patch.verified })) {
    assertOptionalBoolean(value, label);
  }
  const relationshipType = input.patch.relationshipType ?? row.relationshipType;
  if (!RELATIONSHIP_TYPES.has(relationshipType)) throw new Error('relationship type is invalid');
  const effectiveFrom = input.patch.effectiveFrom === undefined ? row.effectiveFrom : cleanDate(input.patch.effectiveFrom, 'effective from');
  const effectiveTo = input.patch.effectiveTo === undefined ? row.effectiveTo : cleanDate(input.patch.effectiveTo, 'effective to');
  if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) throw new Error('effective to cannot be before effective from');
  const verified = input.patch.verified ?? row.verified;
  const status = input.patch.status ?? row.status;
  if (!RELATIONSHIP_STATUSES.has(status)) throw new Error('relationship status is invalid');
  const next: ClientRelationshipDoc = {
    ...row, relationshipType, label: input.patch.label === undefined ? row.label : String(input.patch.label).trim().slice(0, 120) || undefined,
    guardian: input.patch.guardian ?? row.guardian, proxy: input.patch.proxy ?? row.proxy, billing: input.patch.billing ?? row.billing,
    emergency: input.patch.emergency ?? row.emergency, referrer: input.patch.referrer ?? row.referrer,
    verified, verifiedAt: verified ? row.verifiedAt ?? nowIso() : undefined, verifiedBy: verified ? row.verifiedBy ?? input.actor : undefined,
    effectiveFrom, effectiveTo, status, notes: input.patch.notes === undefined ? row.notes : String(input.patch.notes).trim().slice(0, 5_000) || undefined,
    updatedBy: input.actor, updatedAt: nowIso(),
  };
  return commitBatch({ upserts: [
    { collection: 'clientRelationships', doc: next, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId },
    { collection: 'audit', doc: auditDoc(input.orgId, input.actor, status === 'ended' ? 'client.relationship_ended' : 'client.relationship_updated', row.id, `${row.clientId}: ${relationshipType}`), expectedRevision: null, expectedOrgId: input.orgId },
  ] }).upserts.find((item) => item.id === row.id) as ClientRelationshipDoc;
}

export function customFieldDefinitionsFor(orgId: string, targetType?: CustomFieldTarget, includeInactive = false) {
  return list<CustomFieldDefinitionDoc>('customFieldDefinitions', (row) => row.orgId === orgId && (!targetType || row.targetType === targetType) && (includeInactive || row.active))
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}
export function customFieldDefinitionById(orgId: string, id: string) {
  const row = get<CustomFieldDefinitionDoc>('customFieldDefinitions', id);
  return row?.orgId === orgId ? row : undefined;
}
export function customFieldDefinitionByKey(orgId: string, targetType: CustomFieldTarget, key: string) {
  return customFieldDefinitionsFor(orgId, targetType, true).find((row) => row.key === key);
}
function cleanOptions(valueType: CustomFieldValueType, options?: Array<{ value?: string; label?: string }>) {
  if (!['single_choice', 'multiple_choice'].includes(valueType)) return undefined;
  if (!Array.isArray(options)) throw new Error('choice fields need an options list');
  const clean = options.map((option) => {
    if (!option || typeof option !== 'object' || Array.isArray(option)) throw new Error('custom-field choices must be objects');
    return { value: String(option.value ?? '').trim().slice(0, 80), label: String(option.label ?? '').trim().slice(0, 120) };
  }).filter((option) => option.value && option.label);
  if (clean.length < 1 || clean.length > 100 || new Set(clean.map((option) => option.value)).size !== clean.length) throw new Error('choice fields need 1 to 100 unique options');
  return clean;
}
export function createCustomFieldDefinition(input: {
  orgId: string; targetType: CustomFieldTarget; key: string; label: string; valueType: CustomFieldValueType;
  options?: Array<{ value?: string; label?: string }>; sensitivity?: CustomFieldDefinitionDoc['sensitivity']; required?: boolean; order?: number; actor: string;
}) {
  if (!TARGETS.has(input.targetType)) throw new Error('custom-field target is invalid');
  if (!VALUE_TYPES.has(input.valueType)) throw new Error('custom-field value type is invalid');
  if (input.sensitivity !== undefined && !SENSITIVITIES.has(input.sensitivity)) throw new Error('custom-field sensitivity is invalid');
  assertOptionalBoolean(input.required, 'required');
  if (input.order !== undefined && !Number.isFinite(input.order)) throw new Error('custom-field order must be a number');
  const key = String(input.key ?? '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(key)) throw new Error('custom-field key must be 2 to 64 lowercase letters, numbers or underscores');
  if (customFieldDefinitionByKey(input.orgId, input.targetType, key)) throw new Error('that custom-field key already exists');
  const label = String(input.label ?? '').trim();
  if (label.length < 2 || label.length > 160) throw new Error('custom-field label must be 2 to 160 characters');
  const at = nowIso();
  const row: CustomFieldDefinitionDoc = {
    id: newId('cfd_'), orgId: input.orgId, targetType: input.targetType, key, label, valueType: input.valueType,
    options: cleanOptions(input.valueType, input.options), sensitivity: input.sensitivity ?? 'administrative', required: Boolean(input.required), active: true,
    order: Number.isFinite(input.order) ? Math.max(0, Math.min(10_000, Math.floor(input.order!))) : customFieldDefinitionsFor(input.orgId, input.targetType, true).length * 10,
    createdBy: input.actor, updatedBy: input.actor, revision: 0, createdAt: at, updatedAt: at,
  };
  return commitBatch({ upserts: [
    { collection: 'customFieldDefinitions', doc: row, expectedRevision: null, expectedOrgId: input.orgId },
    { collection: 'audit', doc: auditDoc(input.orgId, input.actor, 'custom_field.created', row.id, `${row.targetType}.${row.key}`), expectedRevision: null, expectedOrgId: input.orgId },
  ] }).upserts.find((item) => item.id === row.id) as CustomFieldDefinitionDoc;
}
export function updateCustomFieldDefinition(input: {
  orgId: string; id: string; expectedRevision: number; actor: string;
  patch: Partial<Pick<CustomFieldDefinitionDoc, 'label' | 'options' | 'sensitivity' | 'required' | 'active' | 'order'>>;
}) {
  const row = customFieldDefinitionById(input.orgId, input.id);
  if (!row) throw new Error('custom-field definition not found');
  if (row.revision !== input.expectedRevision) throw new Error('custom-field definition changed after it was loaded');
  if (input.patch.sensitivity !== undefined && !SENSITIVITIES.has(input.patch.sensitivity)) throw new Error('custom-field sensitivity is invalid');
  assertOptionalBoolean(input.patch.required, 'required');
  assertOptionalBoolean(input.patch.active, 'active');
  if (input.patch.order !== undefined && !Number.isFinite(input.patch.order)) throw new Error('custom-field order must be a number');
  const label = input.patch.label === undefined ? row.label : String(input.patch.label).trim();
  if (label.length < 2 || label.length > 160) throw new Error('custom-field label must be 2 to 160 characters');
  const next: CustomFieldDefinitionDoc = {
    ...row, label, options: input.patch.options === undefined ? row.options : cleanOptions(row.valueType, input.patch.options),
    sensitivity: input.patch.sensitivity ?? row.sensitivity, required: input.patch.required ?? row.required, active: input.patch.active ?? row.active,
    order: input.patch.order === undefined ? row.order : Math.max(0, Math.min(10_000, Math.floor(input.patch.order))),
    updatedBy: input.actor, updatedAt: nowIso(),
  };
  return commitBatch({ upserts: [
    { collection: 'customFieldDefinitions', doc: next, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId },
    { collection: 'audit', doc: auditDoc(input.orgId, input.actor, 'custom_field.updated', row.id, `${row.targetType}.${row.key}`), expectedRevision: null, expectedOrgId: input.orgId },
  ] }).upserts.find((item) => item.id === row.id) as CustomFieldDefinitionDoc;
}

function assertTarget(orgId: string, targetType: CustomFieldTarget, targetId: string) {
  if (targetType === 'client' && !clientById(orgId, targetId)) throw new Error('patient not found');
  if (targetType === 'referral' && !referralById(orgId, targetId)) throw new Error('referral not found');
  if (targetType === 'contact' && !contactById(orgId, targetId)) throw new Error('contact not found');
}
export function sanitiseCustomFieldValue(definition: CustomFieldDefinitionDoc, value: unknown): unknown {
  if (value === undefined || value === null || value === '') {
    if (definition.required) throw new Error(`${definition.label} is required`);
    return null;
  }
  if (definition.valueType === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${definition.label} must be yes or no`);
    return value;
  }
  if (definition.valueType === 'number') {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number) || Math.abs(number) > 1e12) throw new Error(`${definition.label} must be a number`);
    return number;
  }
  if (definition.valueType === 'date') return cleanDate(value, definition.label) ?? null;
  if (definition.valueType === 'single_choice') {
    const selected = String(value);
    if (!definition.options?.some((option) => option.value === selected)) throw new Error(`${definition.label} contains an invalid choice`);
    return selected;
  }
  if (definition.valueType === 'multiple_choice') {
    if (!Array.isArray(value) || value.length > 50) throw new Error(`${definition.label} must be a list of choices`);
    const selected = [...new Set(value.map(String))];
    if (selected.some((item) => !definition.options?.some((option) => option.value === item))) throw new Error(`${definition.label} contains an invalid choice`);
    return selected;
  }
  const text = String(value).trim();
  const max = definition.valueType === 'long_text' ? 20_000 : 1_000;
  if (text.length > max) throw new Error(`${definition.label} is too long`);
  if (!text && definition.required) throw new Error(`${definition.label} is required`);
  return text || null;
}
export function customFieldValuesFor(orgId: string, targetType: CustomFieldTarget, targetId: string) {
  return list<CustomFieldValueDoc>('customFieldValues', (row) => row.orgId === orgId && row.targetType === targetType && row.targetId === targetId);
}
export function customFieldValueForTarget(orgId: string, definitionId: string, targetType: CustomFieldTarget, targetId: string) {
  return customFieldValuesFor(orgId, targetType, targetId).find((row) => row.definitionId === definitionId);
}
export function customFieldValueWrite(input: {
  orgId: string; definition: CustomFieldDefinitionDoc; targetType: CustomFieldTarget; targetId: string; value: unknown;
  source: CustomFieldValueDoc['source']; verificationStatus?: CustomFieldValueDoc['verificationStatus']; actor: string;
}) {
  if (input.definition.orgId !== input.orgId || input.definition.targetType !== input.targetType || !input.definition.active) throw new Error('custom-field definition is not active for this target');
  if (!CUSTOM_FIELD_SOURCES.has(input.source)) throw new Error('custom-field source is invalid');
  if (input.verificationStatus !== undefined && !VERIFICATION_STATUSES.has(input.verificationStatus)) throw new Error('custom-field verification status is invalid');
  assertTarget(input.orgId, input.targetType, input.targetId);
  const value = sanitiseCustomFieldValue(input.definition, input.value);
  const existing = customFieldValueForTarget(input.orgId, input.definition.id, input.targetType, input.targetId);
  const at = nowIso();
  const row: CustomFieldValueDoc = {
    ...(existing ?? {}), id: existing?.id ?? newId('cfv_'), orgId: input.orgId, definitionId: input.definition.id,
    targetType: input.targetType, targetId: input.targetId, value, source: input.source,
    verificationStatus: input.verificationStatus ?? (input.source === 'staff' ? 'verified' : 'pending'),
    verifiedAt: input.verificationStatus === 'verified' || (input.source === 'staff' && input.verificationStatus !== 'pending') ? at : undefined,
    verifiedBy: input.verificationStatus === 'verified' || (input.source === 'staff' && input.verificationStatus !== 'pending') ? input.actor : undefined,
    createdBy: existing?.createdBy ?? input.actor, updatedBy: input.actor, revision: existing?.revision ?? 0,
    createdAt: existing?.createdAt ?? at, updatedAt: at,
  } as CustomFieldValueDoc;
  return { row, existing };
}
export function setCustomFieldValue(input: {
  orgId: string; definitionId: string; targetType: CustomFieldTarget; targetId: string; value: unknown;
  source?: CustomFieldValueDoc['source']; verificationStatus?: CustomFieldValueDoc['verificationStatus']; actor: string; expectedRevision?: number | null;
}) {
  const definition = customFieldDefinitionById(input.orgId, input.definitionId);
  if (!definition) throw new Error('custom-field definition not found');
  const { row, existing } = customFieldValueWrite({ ...input, definition, source: input.source ?? 'staff' });
  if (existing && input.expectedRevision === undefined) throw new Error('expected revision is required for an existing custom-field value');
  if (existing && (!Number.isInteger(input.expectedRevision) || existing.revision !== input.expectedRevision)) throw new Error('custom-field value changed after it was loaded');
  if (!existing && input.expectedRevision !== undefined && input.expectedRevision !== null) throw new Error('custom-field value changed after it was loaded');
  const committed = commitBatch({ upserts: [
    { collection: 'customFieldValues', doc: row, expectedRevision: existing ? existing.revision : null, expectedOrgId: input.orgId },
    { collection: 'audit', doc: auditDoc(input.orgId, input.actor, 'custom_field.value_set', row.id, `${definition.targetType}.${definition.key}: ${row.targetId}`), expectedRevision: null, expectedOrgId: input.orgId },
  ] }).upserts.find((item) => item.id === row.id) as CustomFieldValueDoc;
  return committed;
}
