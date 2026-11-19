import crypto from 'node:crypto';
import { CommitConflictError, commitBatch, get, list, newId, nowIso, withEntityLock, type Doc } from './db';
import { clientById, createClient, normaliseNumber, type ClientDoc } from './clients';
import { automationEventWrites } from './automations/events';
import { domainJobDraft, type DomainJobDoc } from './domain-jobs';
import { messageById, queueMessage, type MessageDoc } from './messages';
import {
  cleanLegacyAddress,
  formatStructuredAddress,
  reviewStructuredAddress,
  structuredAddressFromLegacy,
  type StructuredAddress,
  type StructuredAddressInput,
} from '../addresses';

export type ReferralStatus = 'received' | 'triaged' | 'needs_information' | 'accepted' | 'waitlisted' | 'rejected' | 'duplicate' | 'withdrawn' | 'converted';
export type ReferralPriority = 'routine' | 'soon' | 'urgent';

export type ReferralContact = {
  name: string;
  email?: string;
  phone?: string;
  organisation?: string;
  role?: string;
};

export type ReferralDoc = Doc & {
  orgId: string;
  source: 'manual' | 'secure_form' | 'email' | 'import' | 'api';
  externalReference?: string;
  referralFormId?: string;
  referralFormSubmissionId?: string;
  status: ReferralStatus;
  priority: ReferralPriority;
  serviceId?: string;
  locationId?: string;
  practitionerId?: string;
  teamId?: string;
  patient: {
    name: string;
    dateOfBirth?: string;
    email?: string;
    phone?: string;
    /** Compatibility display string retained beside reviewed components. */
    address?: string;
    structuredAddress?: StructuredAddress;
  };
  referrer?: ReferralContact;
  reason: string;
  notes?: string;
  consentConfirmed?: boolean;
  documentIds: string[];
  duplicateOfReferralId?: string;
  convertedClientId?: string;
  receivedAt: string;
  triagedAt?: string;
  decidedAt?: string;
  convertedAt?: string;
  ownerId?: string;
  revision: number;
};

export type ReferralEventDoc = Doc & {
  orgId: string;
  referralId: string;
  from?: ReferralStatus;
  to: ReferralStatus;
  actor: string;
  note?: string;
  reasonCode?: string;
  at: string;
  revision: number;
};

export type ReferralRiskFlagDoc = Doc & {
  orgId: string;
  referralId: string;
  label: string;
  severity: 'information' | 'warning' | 'critical';
  detail?: string;
  status: 'open' | 'resolved';
  createdBy: string;
  resolvedBy?: string;
  resolvedAt?: string;
  revision: number;
};

export type ReferralNotificationDoc = Doc & {
  orgId: string;
  referralId: string;
  referralRevision: number;
  statusSnapshot: ReferralStatus;
  channel: 'email';
  to: string;
  subject: string;
  body: string;
  contentHash: string;
  state: 'queued' | 'pending' | 'sent' | 'failed' | 'blocked' | 'cancelled';
  messageId?: string;
  requestedBy: string;
  requestedAt: string;
  processedAt?: string;
  revision: number;
};

const REFERRAL_SOURCES = new Set<ReferralDoc['source']>(['manual', 'secure_form', 'email', 'import', 'api']);
const REFERRAL_PRIORITIES = new Set<ReferralPriority>(['routine', 'soon', 'urgent']);

const TRANSITIONS: Record<ReferralStatus, ReferralStatus[]> = {
  received: ['triaged', 'needs_information', 'accepted', 'rejected', 'duplicate', 'withdrawn'],
  triaged: ['needs_information', 'accepted', 'waitlisted', 'rejected', 'duplicate', 'withdrawn'],
  needs_information: ['triaged', 'accepted', 'rejected', 'withdrawn'],
  accepted: ['waitlisted', 'converted', 'withdrawn'],
  waitlisted: ['accepted', 'converted', 'withdrawn'],
  rejected: [], duplicate: [], withdrawn: [], converted: [],
};

function auditDoc(orgId: string, actor: string, action: string, target: string, detail: string): Doc {
  return { id: newId('aud_'), orgId, actor, action, kind: 'referral', target, detail, at: nowIso() };
}

function validateDate(value: string | undefined) {
  if (!value) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const parsed = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : undefined;
  if (!match || !parsed || parsed.getUTCFullYear() !== Number(match[1]) || parsed.getUTCMonth() !== Number(match[2]) - 1 || parsed.getUTCDate() !== Number(match[3])) {
    throw new Error('date of birth must be a valid date');
  }
  if (parsed.getTime() > Date.now()) throw new Error('date of birth cannot be in the future');
  return value;
}

function cleanEmail(value: unknown) {
  const email = String(value ?? '').trim().toLowerCase();
  if (!email) return undefined;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error('email is invalid');
  return email;
}

function cleanPatient(
  input: Partial<ReferralDoc['patient']>,
  options: { existing?: ReferralDoc['patient']; legacyAddressChanged?: boolean } = {},
) {
  const name = String(input.name ?? '').trim();
  if (name.length < 2 || name.length > 160) throw new Error('patient name must be 2 to 160 characters');
  const phone = normaliseNumber(String(input.phone ?? '')) || undefined;
  if (phone && (phone.length < 7 || phone.length > 18)) throw new Error('phone number is invalid');
  const address = cleanLegacyAddress(input.address);
  return {
    name,
    dateOfBirth: validateDate(input.dateOfBirth),
    email: cleanEmail(input.email),
    phone,
    address,
    structuredAddress: options.legacyAddressChanged
      ? structuredAddressFromLegacy(address)
      : options.existing?.structuredAddress ?? structuredAddressFromLegacy(address),
  };
}

function referralFor(orgId: string, id: string) {
  const row = get<ReferralDoc>('referrals', id);
  return row?.orgId === orgId ? row : undefined;
}

export function referralById(orgId: string, id: string) {
  return referralFor(orgId, id);
}

export function referralsFor(orgId: string, options: { status?: ReferralStatus; ownerId?: string; priority?: ReferralPriority; q?: string } = {}) {
  const q = String(options.q ?? '').trim().toLowerCase();
  return list<ReferralDoc>('referrals', (row) => row.orgId === orgId && (!options.status || row.status === options.status) && (!options.ownerId || row.ownerId === options.ownerId) && (!options.priority || row.priority === options.priority) && (!q || `${row.patient.name} ${row.patient.email ?? ''} ${row.patient.phone ?? ''} ${row.referrer?.name ?? ''} ${row.externalReference ?? ''}`.toLowerCase().includes(q)))
    .sort((a, b) => a.priority === b.priority ? b.receivedAt.localeCompare(a.receivedAt) : ({ urgent: 0, soon: 1, routine: 2 }[a.priority] - { urgent: 0, soon: 1, routine: 2 }[b.priority]));
}

export function referralEventsFor(orgId: string, referralId: string) {
  return list<ReferralEventDoc>('referralEvents', (row) => row.orgId === orgId && row.referralId === referralId).sort((a, b) => a.at.localeCompare(b.at));
}

export function referralRiskFlagsFor(orgId: string, referralId: string) {
  return list<ReferralRiskFlagDoc>('referralRiskFlags', (row) => row.orgId === orgId && row.referralId === referralId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function notificationState(message: MessageDoc): ReferralNotificationDoc['state'] {
  return message.status === 'pending' ? 'pending' : message.status;
}

function syncReferralNotification(row: ReferralNotificationDoc): ReferralNotificationDoc {
  if (!row.messageId || ['sent', 'blocked', 'cancelled'].includes(row.state)) return row;
  const message = messageById(row.orgId, row.messageId);
  if (!message) return row;
  const state = notificationState(message);
  if (state === row.state) return row;
  try {
    return commitBatch({ upserts: [{
      collection: 'referralNotifications',
      doc: { ...row, state, processedAt: ['pending', 'queued'].includes(state) ? row.processedAt : nowIso() },
      expectedRevision: row.revision,
      expectedOrgId: row.orgId,
    }] }).upserts[0] as ReferralNotificationDoc;
  } catch {
    return (get<ReferralNotificationDoc>('referralNotifications', row.id) ?? row);
  }
}

export function referralNotificationsFor(orgId: string, referralId: string) {
  return list<ReferralNotificationDoc>('referralNotifications', (row) => row.orgId === orgId && row.referralId === referralId)
    .map(syncReferralNotification)
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}

/** Queue a staff-authored, referrer-addressed update through a durable job. */
export function queueReferralNotification(input: {
  orgId: string;
  referralId: string;
  expectedRevision: number;
  subject: string;
  body: string;
  actor: string;
}) {
  const referral = referralFor(input.orgId, input.referralId);
  if (!referral) throw new Error('referral not found');
  if (referral.revision !== input.expectedRevision) throw new Error('referral changed after it was loaded');
  const to = cleanEmail(referral.referrer?.email);
  if (!to) throw new Error('the referral has no valid referrer email');
  const subject = String(input.subject ?? '').trim();
  const body = String(input.body ?? '').trim();
  if (subject.length < 2 || subject.length > 300) throw new Error('notification subject must be 2 to 300 characters');
  if (body.length < 10 || body.length > 10_000) throw new Error('notification body must be 10 to 10,000 characters');
  const digest = crypto.createHash('sha256').update(`${input.orgId}:${referral.id}:${referral.revision}`).digest('hex');
  const contentHash = crypto.createHash('sha256').update(`${to}\0${subject}\0${body}`).digest('hex');
  const id = `rfn_${digest.slice(0, 40)}`;
  const existing = get<ReferralNotificationDoc>('referralNotifications', id);
  if (existing?.orgId === input.orgId) {
    if (existing.contentHash !== contentHash) throw new Error('a different referrer notification already exists for this referral revision');
    return { notification: syncReferralNotification(existing), job: undefined };
  }
  const at = nowIso();
  const notification: ReferralNotificationDoc = {
    id, orgId: input.orgId, referralId: referral.id, referralRevision: referral.revision,
    statusSnapshot: referral.status, channel: 'email', to, subject, body, contentHash,
    state: 'queued', requestedBy: input.actor, requestedAt: at,
    revision: 0, createdAt: at,
  };
  const job = domainJobDraft({
    id: `job_rfn_${digest.slice(0, 36)}`,
    orgId: input.orgId,
    type: 'referral.notification',
    payload: { notificationId: id },
    dedupeKey: id,
    maxAttempts: 6,
  });
  let rows: Doc[];
  try {
    rows = commitBatch({ upserts: [
      { collection: 'referralNotifications', doc: notification, expectedRevision: null, expectedOrgId: input.orgId },
      { collection: 'domainJobs', doc: job, expectedRevision: null, expectedOrgId: input.orgId },
      { collection: 'audit', doc: auditDoc(input.orgId, input.actor, 'referral.notification_queued', id, `${referral.id}: ${referral.status}`), expectedRevision: null, expectedOrgId: input.orgId },
    ] }).upserts;
  } catch (error) {
    // Cross-process retries converge on the deterministic notification and job.
    const winner = get<ReferralNotificationDoc>('referralNotifications', id);
    if (!winner || winner.orgId !== input.orgId) throw error;
    if (winner.contentHash !== contentHash) throw new Error('a different referrer notification already exists for this referral revision');
    return { notification: syncReferralNotification(winner), job: get<DomainJobDoc>('domainJobs', job.id) };
  }
  return {
    notification: rows.find((row) => row.id === id) as ReferralNotificationDoc,
    job: rows.find((row) => row.id === job.id) as DomainJobDoc,
  };
}

export function runReferralNotificationJob(job: DomainJobDoc) {
  const notificationId = String(job.payload.notificationId ?? '');
  const notification = get<ReferralNotificationDoc>('referralNotifications', notificationId);
  if (!notification || notification.orgId !== job.orgId) throw new Error('referral notification not found');
  if (notification.messageId) return syncReferralNotification(notification);
  const messageId = `msg_rfn_${crypto.createHash('sha256').update(`${notification.orgId}:${notification.id}`).digest('hex').slice(0, 36)}`;
  const message = queueMessage({
    id: messageId,
    orgId: notification.orgId,
    channel: 'email',
    to: notification.to,
    subject: notification.subject,
    body: notification.body,
    source: 'referral-notification',
    kind: 'unknown',
    respectConsent: false,
    meta: {
      referralId: notification.referralId,
      referralNotificationId: notification.id,
      statusSnapshot: notification.statusSnapshot,
    },
  });
  return commitBatch({ upserts: [{
    collection: 'referralNotifications',
    doc: {
      ...notification,
      messageId: message.id,
      state: notificationState(message),
      processedAt: nowIso(),
    },
    expectedRevision: notification.revision,
    expectedOrgId: notification.orgId,
  }] }).upserts[0] as ReferralNotificationDoc;
}

export function referralDuplicateCandidates(orgId: string, patient: ReferralDoc['patient'], excludeId?: string) {
  const email = patient.email?.toLowerCase();
  const phone = normaliseNumber(patient.phone ?? '');
  const name = patient.name.trim().toLowerCase();
  const dob = patient.dateOfBirth;
  return list<ReferralDoc>('referrals', (row) => row.orgId === orgId && row.id !== excludeId && row.status !== 'duplicate').flatMap((row) => {
    let score = 0;
    const reasons: string[] = [];
    if (email && row.patient.email?.toLowerCase() === email) { score += 50; reasons.push('same email'); }
    if (phone && normaliseNumber(row.patient.phone ?? '') === phone) { score += 50; reasons.push('same phone'); }
    if (dob && row.patient.dateOfBirth === dob) { score += 25; reasons.push('same date of birth'); }
    if (name && row.patient.name.trim().toLowerCase() === name) { score += 25; reasons.push('same name'); }
    return score >= 50 ? [{ referral: row, score, reasons }] : [];
  }).sort((a, b) => b.score - a.score || b.referral.receivedAt.localeCompare(a.referral.receivedAt));
}

export type CreateReferralInput = {
  orgId: string;
  source?: ReferralDoc['source'];
  externalReference?: string;
  referralFormId?: string;
  referralFormSubmissionId?: string;
  priority?: ReferralPriority;
  serviceId?: string;
  locationId?: string;
  practitionerId?: string;
  teamId?: string;
  ownerId?: string;
  patient: Partial<ReferralDoc['patient']>;
  referrer?: ReferralContact;
  reason: string;
  notes?: string;
  consentConfirmed?: boolean;
  documentIds?: string[];
  actor: string;
};

export function referralCreateDraft(input: CreateReferralInput) {
  if (input.source !== undefined && !REFERRAL_SOURCES.has(input.source)) throw new Error('referral source is invalid');
  if (input.priority !== undefined && !REFERRAL_PRIORITIES.has(input.priority)) throw new Error('referral priority is invalid');
  const patient = cleanPatient(input.patient);
  const reason = String(input.reason ?? '').trim();
  if (reason.length < 2 || reason.length > 10_000) throw new Error('referral reason must be 2 to 10,000 characters');
  const id = newId('ref_');
  const at = nowIso();
  const referral: ReferralDoc = {
    id, orgId: input.orgId, source: input.source ?? 'manual', externalReference: input.externalReference?.trim().slice(0, 160),
    referralFormId: input.referralFormId, referralFormSubmissionId: input.referralFormSubmissionId,
    status: 'received', priority: input.priority ?? 'routine', serviceId: input.serviceId, locationId: input.locationId,
    practitionerId: input.practitionerId, teamId: input.teamId, ownerId: input.ownerId,
    patient, referrer: input.referrer ? {
      name: String(input.referrer.name ?? '').trim().slice(0, 160),
      email: cleanEmail(input.referrer.email), phone: normaliseNumber(input.referrer.phone ?? '') || undefined,
      organisation: input.referrer.organisation?.trim().slice(0, 240), role: input.referrer.role?.trim().slice(0, 120),
    } : undefined,
    reason, notes: input.notes?.trim().slice(0, 20_000), consentConfirmed: input.consentConfirmed,
    documentIds: [...new Set((input.documentIds ?? []).map(String))].slice(0, 50), receivedAt: at,
    revision: 0, createdAt: at,
  };
  const event: ReferralEventDoc = { id: newId('rev_'), orgId: input.orgId, referralId: id, to: 'received', actor: input.actor, note: 'Referral received', at, revision: 0, createdAt: at };
  const automationWrites = automationEventWrites({
    orgId: input.orgId, trigger: 'referral.received', aggregateType: 'referral', aggregateId: id,
    sourceEventId: event.id, occurredAt: at,
    payload: { referral: {
      status: referral.status, priority: referral.priority, source: referral.source,
      serviceId: referral.serviceId ?? '', locationId: referral.locationId ?? '',
      practitionerId: referral.practitionerId ?? '', ownerId: referral.ownerId ?? '',
    } },
  });
  return { referral, event, audit: auditDoc(input.orgId, input.actor, 'referral.created', id, `${referral.priority} referral`), automationWrites };
}

export function createReferral(input: CreateReferralInput) {
  const prepared = referralCreateDraft(input);
  const committed = commitBatch({ upserts: [
    { collection: 'referrals', doc: prepared.referral, expectedRevision: null, expectedOrgId: input.orgId },
    { collection: 'referralEvents', doc: prepared.event, expectedRevision: null, expectedOrgId: input.orgId },
    { collection: 'audit', doc: prepared.audit, expectedRevision: null, expectedOrgId: input.orgId },
    ...prepared.automationWrites,
  ] });
  return {
    referral: committed.upserts.find((row) => row.id === prepared.referral.id) as ReferralDoc,
    duplicateCandidates: referralDuplicateCandidates(input.orgId, prepared.referral.patient, prepared.referral.id),
  };
}

export function updateReferral(input: {
  orgId: string;
  id: string;
  actor: string;
  expectedRevision: number;
  patch: Partial<Pick<ReferralDoc, 'priority' | 'serviceId' | 'locationId' | 'practitionerId' | 'teamId' | 'ownerId' | 'reason' | 'notes' | 'consentConfirmed' | 'documentIds' | 'externalReference'>> & { patient?: Partial<ReferralDoc['patient']>; referrer?: ReferralContact };
}) {
  const referral = referralFor(input.orgId, input.id);
  if (!referral) throw new Error('referral not found');
  if (referral.revision !== input.expectedRevision) throw new Error('referral changed after it was loaded');
  if (['converted', 'duplicate'].includes(referral.status)) throw new Error(`a ${referral.status} referral cannot be amended`);
  const patch = input.patch;
  const reason = patch.reason === undefined ? referral.reason : String(patch.reason).trim();
  if (reason.length < 2 || reason.length > 10_000) throw new Error('referral reason must be 2 to 10,000 characters');
  const next: ReferralDoc = {
    ...referral,
    priority: patch.priority ?? referral.priority,
    serviceId: patch.serviceId === undefined ? referral.serviceId : patch.serviceId || undefined,
    locationId: patch.locationId === undefined ? referral.locationId : patch.locationId || undefined,
    practitionerId: patch.practitionerId === undefined ? referral.practitionerId : patch.practitionerId || undefined,
    teamId: patch.teamId === undefined ? referral.teamId : patch.teamId || undefined,
    ownerId: patch.ownerId === undefined ? referral.ownerId : patch.ownerId || undefined,
    reason,
    notes: patch.notes === undefined ? referral.notes : String(patch.notes).trim().slice(0, 20_000) || undefined,
    consentConfirmed: patch.consentConfirmed ?? referral.consentConfirmed,
    externalReference: patch.externalReference === undefined ? referral.externalReference : String(patch.externalReference).trim().slice(0, 160) || undefined,
    documentIds: patch.documentIds === undefined ? referral.documentIds : [...new Set(patch.documentIds.map(String))].slice(0, 50),
    patient: patch.patient ? cleanPatient(
      { ...referral.patient, ...patch.patient },
      {
        existing: referral.patient,
        legacyAddressChanged: Object.prototype.hasOwnProperty.call(patch.patient, 'address'),
      },
    ) : referral.patient,
    referrer: patch.referrer ? {
      name: String(patch.referrer.name ?? '').trim().slice(0, 160), email: cleanEmail(patch.referrer.email),
      phone: normaliseNumber(patch.referrer.phone ?? '') || undefined,
      organisation: patch.referrer.organisation?.trim().slice(0, 240), role: patch.referrer.role?.trim().slice(0, 120),
    } : referral.referrer,
  };
  return commitBatch({ upserts: [
    { collection: 'referrals', doc: next, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId },
    { collection: 'audit', doc: auditDoc(input.orgId, input.actor, 'referral.updated', referral.id, Object.keys(patch).join(', ')), expectedRevision: null, expectedOrgId: input.orgId },
  ] }).upserts.find((row) => row.id === referral.id) as ReferralDoc;
}

export function updateReferralStructuredAddress(input: {
  orgId: string;
  id: string;
  address: StructuredAddressInput;
  expectedRevision: number;
  actor: string;
}) {
  const referral = referralFor(input.orgId, input.id);
  if (!referral) throw new Error('referral not found');
  if (referral.revision !== input.expectedRevision) throw new Error('referral changed after it was loaded');
  if (['converted', 'duplicate'].includes(referral.status)) throw new Error(`a ${referral.status} referral cannot be amended`);
  const structuredAddress = reviewStructuredAddress(input.address, {
    actor: input.actor,
    existing: referral.patient.structuredAddress,
    legacyText: referral.patient.address,
  });
  const next: ReferralDoc = {
    ...referral,
    patient: {
      ...referral.patient,
      address: formatStructuredAddress(structuredAddress),
      structuredAddress,
    },
  };
  return commitBatch({ upserts: [
    { collection: 'referrals', doc: next, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId },
    { collection: 'audit', doc: auditDoc(input.orgId, input.actor, 'referral.address_reviewed', referral.id, 'structured patient address reviewed'), expectedRevision: null, expectedOrgId: input.orgId },
  ] }).upserts.find((row) => row.id === referral.id) as ReferralDoc;
}

export function transitionReferral(input: {
  orgId: string;
  id: string;
  to: ReferralStatus;
  actor: string;
  note?: string;
  reasonCode?: string;
  expectedRevision: number;
  duplicateOfReferralId?: string;
  convertedClientId?: string;
}) {
  const referral = referralFor(input.orgId, input.id);
  if (!referral) throw new Error('referral not found');
  if (referral.revision !== input.expectedRevision) throw new Error('referral changed after it was loaded');
  if (!TRANSITIONS[referral.status].includes(input.to)) throw new Error(`referral cannot move from ${referral.status} to ${input.to}`);
  if (['rejected', 'withdrawn', 'needs_information'].includes(input.to) && !String(input.note ?? '').trim()) throw new Error(`a note is required when a referral is ${input.to.replace('_', ' ')}`);
  if (input.to === 'duplicate' && (!input.duplicateOfReferralId || !referralFor(input.orgId, input.duplicateOfReferralId))) throw new Error('a valid duplicate referral is required');
  if (input.to === 'converted' && (!input.convertedClientId || !clientById(input.orgId, input.convertedClientId))) throw new Error('a valid client is required to convert a referral');
  const at = nowIso();
  const next: ReferralDoc = {
    ...referral, status: input.to, duplicateOfReferralId: input.to === 'duplicate' ? input.duplicateOfReferralId : referral.duplicateOfReferralId,
    convertedClientId: input.to === 'converted' ? input.convertedClientId : referral.convertedClientId,
    triagedAt: input.to === 'triaged' ? at : referral.triagedAt,
    decidedAt: ['accepted', 'rejected', 'waitlisted'].includes(input.to) ? at : referral.decidedAt,
    convertedAt: input.to === 'converted' ? at : referral.convertedAt,
  };
  const event: ReferralEventDoc = {
    id: newId('rev_'), orgId: input.orgId, referralId: referral.id, from: referral.status, to: input.to,
    actor: input.actor, note: input.note?.trim().slice(0, 4_000), reasonCode: input.reasonCode?.trim().slice(0, 120), at, revision: 0, createdAt: at,
  };
  const automationWrites = automationEventWrites({
    orgId: input.orgId, trigger: 'referral.status_changed', aggregateType: 'referral', aggregateId: referral.id,
    sourceEventId: event.id, occurredAt: at,
    payload: { referral: {
      from: referral.status, status: next.status, priority: next.priority, source: next.source,
      serviceId: next.serviceId ?? '', locationId: next.locationId ?? '',
      practitionerId: next.practitionerId ?? '', ownerId: next.ownerId ?? '',
    } },
  });
  const committed = commitBatch({ upserts: [
    { collection: 'referrals', doc: next, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId },
    { collection: 'referralEvents', doc: event, expectedRevision: null, expectedOrgId: input.orgId },
    { collection: 'audit', doc: auditDoc(input.orgId, input.actor, `referral.${input.to}`, referral.id, `${referral.status} → ${input.to}`), expectedRevision: null, expectedOrgId: input.orgId },
    ...automationWrites,
  ] });
  return committed.upserts.find((row) => row.id === referral.id) as ReferralDoc;
}

function referralDocumentPatientWrites(referral: ReferralDoc, patientId: string) {
  const writes: Array<{ collection: string; doc: Doc; expectedRevision: number; expectedOrgId: string }> = [];
  for (const documentId of referral.documentIds) {
    const document = get<Doc>('clinicalDocuments', documentId);
    const exactOwner = document?.orgId === referral.orgId && (
      (document.ownerType === 'referral' && document.ownerId === referral.id) ||
      (document.ownerType === 'referral_submission' && referral.referralFormSubmissionId && document.ownerId === referral.referralFormSubmissionId)
    );
    if (!document || !exactOwner) throw new Error(`referral attachment ${documentId} does not have exact referral ownership`);
    if (document.patientId && document.patientId !== patientId) throw new Error(`referral attachment ${documentId} is linked to another patient`);
    if (document.patientId !== patientId) {
      writes.push({
        collection: 'clinicalDocuments', doc: { ...document, patientId },
        expectedRevision: Number(document.revision ?? 0), expectedOrgId: referral.orgId,
      });
    }
    for (const link of list<Doc>('documentLinks', (row) => row.orgId === referral.orgId && row.documentId === documentId)) {
      if (link.patientId && link.patientId !== patientId) throw new Error(`referral attachment link ${link.id} belongs to another patient`);
      if (link.patientId !== patientId) {
        writes.push({
          collection: 'documentLinks', doc: { ...link, patientId },
          expectedRevision: Number(link.revision ?? 0), expectedOrgId: referral.orgId,
        });
      }
    }
  }
  return writes;
}

export function convertReferralToClient(input: { orgId: string; id: string; actor: string; expectedRevision: number; existingClientId?: string }) {
  return withEntityLock('referral-convert', `${input.orgId}:${input.id}`, () => {
    const referral = referralFor(input.orgId, input.id);
    if (!referral) throw new Error('referral not found');
    if (referral.status === 'converted' && referral.convertedClientId) {
      const converted = clientById(input.orgId, referral.convertedClientId);
      if (converted) {
        const repair = referralDocumentPatientWrites(referral, converted.id);
        if (repair.length) commitBatch({ upserts: repair });
        return { client: converted, referral };
      }
    }
    if (!['accepted', 'waitlisted'].includes(referral.status)) throw new Error('only an accepted or waitlisted referral can be converted');
    if (referral.revision !== input.expectedRevision) throw new Error('referral changed after it was loaded');
    let client: ClientDoc;
    if (input.existingClientId) {
      const existing = clientById(input.orgId, input.existingClientId);
      if (!existing) throw new Error('client not found');
      client = existing;
    } else {
      // Cross-process retries must converge before the referral transition. A
      // process-local lock alone cannot stop two containers from creating two
      // patients, so the referral owns one deterministic conversion id.
      const clientId = `cli_ref_${crypto.createHash('sha256').update(`${input.orgId}:${referral.id}`).digest('hex').slice(0, 32)}`;
      client = clientById(input.orgId, clientId) as ClientDoc;
      if (!client) {
        try {
          client = createClient(input.orgId, {
            name: referral.patient.name,
            number: referral.patient.phone ?? '', email: referral.patient.email,
            dateOfBirth: referral.patient.dateOfBirth, address: referral.patient.address,
            structuredAddress: referral.patient.structuredAddress,
            tags: ['referral'], note: referral.reason, source: 'referral',
          }, input.actor, { source: 'referral', id: clientId });
        } catch (error) {
          if (!(error instanceof CommitConflictError)) throw error;
          const winner = clientById(input.orgId, clientId);
          if (!winner) throw error;
          client = winner;
        }
      }
    }
    try {
      const at = nowIso();
      const convertedReferral: ReferralDoc = { ...referral, status: 'converted', convertedClientId: client.id, convertedAt: at };
      const event: ReferralEventDoc = {
        id: newId('rev_'), orgId: input.orgId, referralId: referral.id, from: referral.status, to: 'converted',
        actor: input.actor, note: `Converted to client ${client.id}`, at, revision: 0, createdAt: at,
      };
      const documentWrites = referralDocumentPatientWrites(referral, client.id);
      const automationWrites = automationEventWrites({
        orgId: input.orgId, trigger: 'referral.status_changed', aggregateType: 'referral', aggregateId: referral.id,
        sourceEventId: event.id, occurredAt: at,
        payload: { referral: {
          from: referral.status, status: 'converted', priority: referral.priority, source: referral.source,
          serviceId: referral.serviceId ?? '', locationId: referral.locationId ?? '',
          practitionerId: referral.practitionerId ?? '', ownerId: referral.ownerId ?? '',
        } },
      });
      const committed = commitBatch({ upserts: [
        { collection: 'referrals', doc: convertedReferral, expectedRevision: referral.revision, expectedOrgId: input.orgId },
        { collection: 'referralEvents', doc: event, expectedRevision: null, expectedOrgId: input.orgId },
        { collection: 'audit', doc: auditDoc(input.orgId, input.actor, 'referral.converted', referral.id, `${referral.status} → converted; ${documentWrites.filter((row) => row.collection === 'clinicalDocuments').length} attachment(s) linked`), expectedRevision: null, expectedOrgId: input.orgId },
        ...documentWrites,
        ...automationWrites,
      ] });
      return { client, referral: committed.upserts.find((row) => row.id === referral.id) as ReferralDoc };
    } catch (error) {
      if (error instanceof CommitConflictError) {
        const winner = referralFor(input.orgId, referral.id);
        if (winner?.status === 'converted' && winner.convertedClientId === client.id) return { client, referral: winner };
      }
      throw error;
    }
  });
}

export function addReferralRiskFlag(input: { orgId: string; referralId: string; label: string; severity?: ReferralRiskFlagDoc['severity']; detail?: string; actor: string }) {
  if (!referralFor(input.orgId, input.referralId)) throw new Error('referral not found');
  const label = input.label.trim();
  if (label.length < 2 || label.length > 160) throw new Error('risk flag label must be 2 to 160 characters');
  const flag: ReferralRiskFlagDoc = {
    id: newId('rrf_'), orgId: input.orgId, referralId: input.referralId, label, severity: input.severity ?? 'warning',
    detail: input.detail?.trim().slice(0, 4_000), status: 'open', createdBy: input.actor, revision: 0, createdAt: nowIso(),
  };
  return commitBatch({ upserts: [
    { collection: 'referralRiskFlags', doc: flag, expectedRevision: null, expectedOrgId: input.orgId },
    { collection: 'audit', doc: auditDoc(input.orgId, input.actor, 'referral.risk_flag_added', input.referralId, `${flag.severity}: ${flag.label}`), expectedRevision: null, expectedOrgId: input.orgId },
  ] }).upserts.find((row) => row.id === flag.id) as ReferralRiskFlagDoc;
}

export function resolveReferralRiskFlag(input: { orgId: string; id: string; actor: string; expectedRevision: number }) {
  const flag = get<ReferralRiskFlagDoc>('referralRiskFlags', input.id);
  if (!flag || flag.orgId !== input.orgId) throw new Error('risk flag not found');
  if (flag.status === 'resolved') return flag;
  return commitBatch({ upserts: [
    { collection: 'referralRiskFlags', doc: { ...flag, status: 'resolved', resolvedBy: input.actor, resolvedAt: nowIso() }, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId },
    { collection: 'audit', doc: auditDoc(input.orgId, input.actor, 'referral.risk_flag_resolved', flag.referralId, flag.label), expectedRevision: null, expectedOrgId: input.orgId },
  ] }).upserts.find((row) => row.id === flag.id) as ReferralRiskFlagDoc;
}

export function referralFingerprint(referral: Pick<ReferralDoc, 'patient' | 'receivedAt'>) {
  return crypto.createHash('sha256').update(`${referral.patient.name.toLowerCase()}|${referral.patient.dateOfBirth ?? ''}|${referral.patient.email ?? ''}|${referral.patient.phone ?? ''}|${referral.receivedAt}`).digest('hex');
}
