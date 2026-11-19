/** Controller-owned privacy, retention, hold and deletion records. No guessed legal settings. */

import { commitBatch, find, list, newId, nowIso, withEntityLock, type Doc } from './db';

export type ProcessingActivityDoc = Doc & {
  orgId: string;
  name: string;
  purpose: string;
  article6Basis: string;
  article9Condition?: string;
  dataSubjects: string[];
  dataCategories: string[];
  recipients: string[];
  internationalTransfers: boolean;
  transferSafeguards?: string;
  retentionPolicyIds: string[];
  owner: string;
  status: 'draft' | 'active' | 'retired';
  approvedAt?: string;
  approvedBy?: string;
  revision: number;
};

export type ProcessorRecordDoc = Doc & {
  orgId: string;
  name: string;
  service: string;
  purpose: string;
  role: 'processor' | 'subprocessor' | 'independent_controller' | 'unknown';
  hostingRegions: string[];
  receivesHealthData: boolean;
  dpaStatus: 'not_reviewed' | 'reviewing' | 'signed' | 'not_applicable';
  dpaReference?: string;
  transferMechanism?: string;
  subprocessorListReviewedAt?: string;
  active: boolean;
  owner: string;
  revision: number;
};

export type RetentionPolicyDoc = Doc & {
  orgId: string;
  name: string;
  recordClass: string;
  trigger: 'created_at' | 'last_activity' | 'episode_closed' | 'contract_ended' | 'request_completed';
  durationDays: number;
  disposition: 'review' | 'delete' | 'anonymise';
  rationale: string;
  status: 'draft' | 'active' | 'retired';
  approvedAt?: string;
  approvedBy?: string;
  revision: number;
};

export type LegalHoldDoc = Doc & {
  orgId: string;
  scopeType: 'workspace' | 'patient' | 'resource' | 'record_class';
  scopeId: string;
  recordClass?: string;
  reason: string;
  createdBy: string;
  releasedAt?: string;
  releasedBy?: string;
  releaseReason?: string;
  revision: number;
};

export type RetentionReviewManifestDoc = Doc & {
  orgId: string;
  asOf: string;
  policyIds: string[];
  candidates: Array<{
    recordClass: string;
    collection: string;
    resourceId: string;
    patientId?: string;
    triggerAt: string;
    disposition: RetentionPolicyDoc['disposition'];
    held: boolean;
    holdIds: string[];
  }>;
  truncated: boolean;
  generatedBy: string;
  statement: string;
  revision: number;
};

export type DeletionRequestDoc = Doc & {
  orgId: string;
  patientId?: string;
  requesterType: 'patient' | 'controller' | 'staff' | 'other';
  requesterReference: string;
  scope: string;
  status: 'intake' | 'review' | 'approved' | 'executing' | 'blocked' | 'completed' | 'rejected';
  dueAt?: string;
  assignedTo?: string;
  legalBasisDecision?: string;
  blockedByHoldIds?: string[];
  history: Array<{ at: string; actor: string; from?: string; to: string; note?: string }>;
  completedAt?: string;
  revision: number;
};

export type ExternalAttestationType = 'security' | 'privacy_legal' | 'clinical';
export type ExternalAttestationDoc = Doc & {
  orgId: string;
  type: ExternalAttestationType;
  reviewerName: string;
  reviewerOrganisation: string;
  independent: boolean;
  scope: string;
  outcome: 'approved' | 'approved_with_actions' | 'not_approved';
  reportReference: string;
  reportSha256?: string;
  reviewedAt: string;
  expiresAt: string;
  actionsOpen: number;
  recordedBy: string;
  revision: number;
};

export type RecoveryEvidenceDoc = Doc & {
  orgId: string;
  backupReference: string;
  restoreTestedAt: string;
  testedBy: string;
  recoveryPointMinutes?: number;
  recoveryTimeMinutes?: number;
  outcome: 'passed' | 'failed';
  evidenceReference: string;
  revision: number;
};

export type ClinicalProfileDoc = Doc & {
  orgId: string;
  market: 'UK';
  customerType: 'private_allied_health';
  operatingMode: 'disabled' | 'synthetic_test' | 'live';
  profileVersion: 1;
  liveActivatedAt?: string;
  liveActivatedBy?: string;
  revision: number;
};

/**
 * Controller-entered accountability record. These fields record what the
 * controller decided and reviewed; they are evidence inputs, never a Voxera
 * assertion that the decision is legally sufficient.
 */
export type PrivacyProfileDoc = Doc & {
  orgId: string;
  controllerName: string;
  controllerAddress: string;
  controllerContactEmail: string;
  controllerContactPhone?: string;
  dpoName?: string;
  dpoEmail?: string;
  privacyNoticeVersion: string;
  privacyNoticeUrl: string;
  dpiaReference: string;
  dpiaStatus: 'not_started' | 'draft' | 'review_required' | 'approved_by_controller';
  dpiaReviewedAt?: string;
  dpiaReviewedBy?: string;
  /** Cutover marker; history before this instant is explicitly legacy/capped. */
  auditCompleteFromAt?: string;
  breakGlassEnabled: boolean;
  breakGlassMaxMinutes: number;
  breakGlassNotify: string[];
  updatedBy: string;
  revision: number;
};

export type CommunicationDataPolicyDoc = Doc & {
  orgId: string;
  channel: 'phone' | 'sms' | 'email' | 'web';
  recordingPurpose: string;
  transcriptPurpose: string;
  noticeVersion: string;
  contentRetentionDays: number;
  metadataRetentionDays: number;
  allowedRoles: string[];
  assistantExposure: 'minimum_context' | 'none';
  status: 'draft' | 'active' | 'retired';
  approvedAt?: string;
  approvedBy?: string;
  revision: number;
};

function cleanList(values: unknown, max = 50): string[] {
  return Array.isArray(values)
    ? [...new Set(values.map((value) => String(value).trim()).filter(Boolean))].slice(0, max)
    : [];
}

export function privacyProfileFor(orgId: string): PrivacyProfileDoc {
  return find<PrivacyProfileDoc>('privacyProfiles', (row) => row.orgId === orgId) ?? {
    id: `privacy_${orgId}`,
    orgId,
    controllerName: '',
    controllerAddress: '',
    controllerContactEmail: '',
    privacyNoticeVersion: '',
    privacyNoticeUrl: '',
    dpiaReference: '',
    dpiaStatus: 'not_started',
    breakGlassEnabled: false,
    breakGlassMaxMinutes: 60,
    breakGlassNotify: [],
    updatedBy: '',
    revision: 0,
    createdAt: nowIso(),
  } as PrivacyProfileDoc;
}

export function savePrivacyProfile(input: {
  orgId: string;
  existing?: PrivacyProfileDoc;
  expectedRevision: number;
  controllerName: string;
  controllerAddress: string;
  controllerContactEmail: string;
  controllerContactPhone?: string;
  dpoName?: string;
  dpoEmail?: string;
  privacyNoticeVersion: string;
  privacyNoticeUrl: string;
  dpiaReference: string;
  dpiaStatus: PrivacyProfileDoc['dpiaStatus'];
  dpiaReviewedAt?: string;
  dpiaReviewedBy?: string;
  auditCompleteFromAt?: string;
  breakGlassEnabled?: boolean;
  breakGlassMaxMinutes?: number;
  breakGlassNotify?: string[];
  actor: string;
}): PrivacyProfileDoc {
  const existing = input.existing ?? privacyProfileFor(input.orgId);
  const email = input.controllerContactEmail.trim().toLowerCase();
  const noticeUrl = input.privacyNoticeUrl.trim();
  const dpiaStatus = input.dpiaStatus;
  if (!input.controllerName.trim() || !input.controllerAddress.trim() || !email || !input.privacyNoticeVersion.trim() || !noticeUrl || !input.dpiaReference.trim()) {
    throw new Error('controller identity/address/contact, privacy notice version/URL and DPIA reference are required');
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('controllerContactEmail must be a valid email address');
  let parsedNotice: URL;
  try { parsedNotice = new URL(noticeUrl); } catch { throw new Error('privacyNoticeUrl must be an absolute HTTPS URL'); }
  if (parsedNotice.protocol !== 'https:') throw new Error('privacyNoticeUrl must use HTTPS');
  if (input.dpoEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.dpoEmail.trim())) throw new Error('dpoEmail must be a valid email address');
  if (dpiaStatus === 'approved_by_controller' && (!input.dpiaReviewedAt || !input.dpiaReviewedBy?.trim())) {
    throw new Error('controller-approved DPIA status requires reviewed date and reviewer');
  }
  const maxMinutes = Math.floor(Number(input.breakGlassMaxMinutes ?? existing.breakGlassMaxMinutes ?? 60));
  if (!Number.isSafeInteger(maxMinutes) || maxMinutes < 5 || maxMinutes > 240) throw new Error('breakGlassMaxMinutes must be from 5 to 240 minutes');
  const at = nowIso();
  const row = {
    ...existing,
    id: existing.id || `privacy_${input.orgId}`,
    orgId: input.orgId,
    controllerName: input.controllerName.trim().slice(0, 200),
    controllerAddress: input.controllerAddress.trim().slice(0, 1_000),
    controllerContactEmail: email,
    controllerContactPhone: input.controllerContactPhone?.trim().slice(0, 80) || undefined,
    dpoName: input.dpoName?.trim().slice(0, 200) || undefined,
    dpoEmail: input.dpoEmail?.trim().toLowerCase() || undefined,
    privacyNoticeVersion: input.privacyNoticeVersion.trim().slice(0, 120),
    privacyNoticeUrl: noticeUrl,
    dpiaReference: input.dpiaReference.trim().slice(0, 500),
    dpiaStatus,
    dpiaReviewedAt: input.dpiaReviewedAt || undefined,
    dpiaReviewedBy: input.dpiaReviewedBy?.trim().slice(0, 200) || undefined,
    auditCompleteFromAt: input.auditCompleteFromAt || existing.auditCompleteFromAt,
    breakGlassEnabled: input.breakGlassEnabled === true,
    breakGlassMaxMinutes: maxMinutes,
    breakGlassNotify: cleanList(input.breakGlassNotify ?? [], 20).map((value) => value.toLowerCase()),
    updatedBy: input.actor,
    createdAt: existing.createdAt ?? at,
  } as PrivacyProfileDoc;
  return commitBatch({
    upserts: [{
      collection: 'privacyProfiles', doc: row,
      expectedRevision: input.expectedRevision === 0 && !find<PrivacyProfileDoc>('privacyProfiles', (item) => item.orgId === input.orgId) ? null : input.expectedRevision,
      expectedOrgId: input.orgId,
    }],
  }).upserts[0] as PrivacyProfileDoc;
}

export function communicationDataPoliciesFor(orgId: string) {
  return list<CommunicationDataPolicyDoc>('communicationDataPolicies', (row) => row.orgId === orgId)
    .sort((a, b) => a.channel.localeCompare(b.channel) || String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)));
}

export function saveCommunicationDataPolicy(input: {
  orgId: string;
  existing?: CommunicationDataPolicyDoc;
  channel: CommunicationDataPolicyDoc['channel'];
  recordingPurpose: string;
  transcriptPurpose: string;
  noticeVersion: string;
  contentRetentionDays: number;
  metadataRetentionDays: number;
  allowedRoles: string[];
  assistantExposure?: CommunicationDataPolicyDoc['assistantExposure'];
  status?: CommunicationDataPolicyDoc['status'];
  actor: string;
}): CommunicationDataPolicyDoc {
  if (!['phone', 'sms', 'email', 'web'].includes(input.channel)) throw new Error('channel is invalid');
  if (!input.recordingPurpose.trim() || !input.transcriptPurpose.trim() || !input.noticeVersion.trim()) throw new Error('recording purpose, transcript purpose and notice version are required');
  for (const [name, value] of [['contentRetentionDays', input.contentRetentionDays], ['metadataRetentionDays', input.metadataRetentionDays]] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 36_500) throw new Error(`${name} must be a whole number from 1 to 36,500`);
  }
  const status = input.status ?? input.existing?.status ?? 'draft';
  const at = nowIso();
  const row = {
    ...(input.existing ?? {}),
    id: input.existing?.id ?? newId('comm_policy_'),
    orgId: input.orgId,
    channel: input.channel,
    recordingPurpose: input.recordingPurpose.trim().slice(0, 2_000),
    transcriptPurpose: input.transcriptPurpose.trim().slice(0, 2_000),
    noticeVersion: input.noticeVersion.trim().slice(0, 120),
    contentRetentionDays: input.contentRetentionDays,
    metadataRetentionDays: input.metadataRetentionDays,
    allowedRoles: cleanList(input.allowedRoles, 20),
    assistantExposure: input.assistantExposure ?? 'minimum_context',
    status,
    approvedAt: status === 'active' ? input.existing?.approvedAt ?? at : input.existing?.approvedAt,
    approvedBy: status === 'active' ? input.existing?.approvedBy ?? input.actor : input.existing?.approvedBy,
    createdAt: input.existing?.createdAt ?? at,
  } as CommunicationDataPolicyDoc;
  return commitBatch({
    upserts: [{ collection: 'communicationDataPolicies', doc: row, expectedRevision: input.existing ? Number(input.existing.revision ?? 0) : null, expectedOrgId: input.orgId }],
  }).upserts[0] as CommunicationDataPolicyDoc;
}

export function processingActivitiesFor(orgId: string) {
  return list<ProcessingActivityDoc>('processingActivities', (row) => row.orgId === orgId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function saveProcessingActivity(input: {
  orgId: string;
  existing?: ProcessingActivityDoc;
  name: string;
  purpose: string;
  article6Basis: string;
  article9Condition?: string;
  dataSubjects: string[];
  dataCategories: string[];
  recipients: string[];
  internationalTransfers: boolean;
  transferSafeguards?: string;
  retentionPolicyIds?: string[];
  owner: string;
  status?: ProcessingActivityDoc['status'];
  actor: string;
}): ProcessingActivityDoc {
  const name = input.name.trim();
  const purpose = input.purpose.trim();
  const article6Basis = input.article6Basis.trim();
  if (!name || !purpose || !article6Basis) throw new Error('name, purpose and an Article 6 basis are required');
  const healthData = input.dataCategories.some((category) => /health|clinical|treatment|diagnos/i.test(category));
  if (healthData && !input.article9Condition?.trim()) throw new Error('an Article 9 condition is required when the activity includes health/clinical data');
  if (input.internationalTransfers && !input.transferSafeguards?.trim()) throw new Error('transfer safeguards are required when international transfers are marked yes');
  const status = input.status ?? input.existing?.status ?? 'draft';
  const at = nowIso();
  const row = {
    ...(input.existing ?? {}),
    id: input.existing?.id ?? newId('ropa_'),
    orgId: input.orgId,
    name: name.slice(0, 160),
    purpose: purpose.slice(0, 2_000),
    article6Basis: article6Basis.slice(0, 500),
    article9Condition: input.article9Condition?.trim().slice(0, 500) || undefined,
    dataSubjects: cleanList(input.dataSubjects),
    dataCategories: cleanList(input.dataCategories),
    recipients: cleanList(input.recipients),
    internationalTransfers: input.internationalTransfers,
    transferSafeguards: input.transferSafeguards?.trim().slice(0, 2_000) || undefined,
    retentionPolicyIds: cleanList(input.retentionPolicyIds ?? []),
    owner: input.owner.trim().slice(0, 160),
    status,
    approvedAt: status === 'active' ? input.existing?.approvedAt ?? at : input.existing?.approvedAt,
    approvedBy: status === 'active' ? input.existing?.approvedBy ?? input.actor : input.existing?.approvedBy,
    createdAt: input.existing?.createdAt ?? at,
  } as ProcessingActivityDoc;
  return commitBatch({
    upserts: [{
      collection: 'processingActivities', doc: row,
      expectedRevision: input.existing ? Number(input.existing.revision ?? 0) : null,
      expectedOrgId: input.orgId,
    }],
  }).upserts[0] as ProcessingActivityDoc;
}

export function processorsFor(orgId: string) {
  return list<ProcessorRecordDoc>('processorRecords', (row) => row.orgId === orgId).sort((a, b) => a.name.localeCompare(b.name));
}

export function saveProcessorRecord(input: {
  orgId: string;
  existing?: ProcessorRecordDoc;
  name: string;
  service: string;
  purpose: string;
  role: ProcessorRecordDoc['role'];
  hostingRegions?: string[];
  receivesHealthData: boolean;
  dpaStatus: ProcessorRecordDoc['dpaStatus'];
  dpaReference?: string;
  transferMechanism?: string;
  subprocessorListReviewedAt?: string;
  active?: boolean;
  owner: string;
}): ProcessorRecordDoc {
  if (!input.name.trim() || !input.service.trim() || !input.purpose.trim() || !input.owner.trim()) throw new Error('name, service, purpose and owner are required');
  if (input.dpaStatus === 'signed' && !input.dpaReference?.trim()) throw new Error('a DPA reference is required when DPA status is signed');
  const at = nowIso();
  const row = {
    ...(input.existing ?? {}),
    id: input.existing?.id ?? newId('proc_'),
    orgId: input.orgId,
    name: input.name.trim().slice(0, 160),
    service: input.service.trim().slice(0, 160),
    purpose: input.purpose.trim().slice(0, 2_000),
    role: input.role,
    hostingRegions: cleanList(input.hostingRegions ?? []),
    receivesHealthData: input.receivesHealthData,
    dpaStatus: input.dpaStatus,
    dpaReference: input.dpaReference?.trim().slice(0, 500) || undefined,
    transferMechanism: input.transferMechanism?.trim().slice(0, 1_000) || undefined,
    subprocessorListReviewedAt: input.subprocessorListReviewedAt,
    active: input.active !== false,
    owner: input.owner.trim().slice(0, 160),
    createdAt: input.existing?.createdAt ?? at,
  } as ProcessorRecordDoc;
  return commitBatch({
    upserts: [{ collection: 'processorRecords', doc: row, expectedRevision: input.existing ? Number(input.existing.revision ?? 0) : null, expectedOrgId: input.orgId }],
  }).upserts[0] as ProcessorRecordDoc;
}

export function retentionPoliciesFor(orgId: string) {
  return list<RetentionPolicyDoc>('retentionPolicies', (row) => row.orgId === orgId).sort((a, b) => a.recordClass.localeCompare(b.recordClass));
}

export function saveRetentionPolicy(input: {
  orgId: string;
  existing?: RetentionPolicyDoc;
  name: string;
  recordClass: string;
  trigger: RetentionPolicyDoc['trigger'];
  durationDays: number;
  disposition: RetentionPolicyDoc['disposition'];
  rationale: string;
  status?: RetentionPolicyDoc['status'];
  actor: string;
  activationConfirmation?: string;
}): RetentionPolicyDoc {
  if (!input.name.trim() || !input.recordClass.trim() || !input.rationale.trim()) throw new Error('name, record class and rationale are required');
  if (!Number.isSafeInteger(input.durationDays) || input.durationDays < 1 || input.durationDays > 36_500) throw new Error('durationDays must be a whole number from 1 to 36,500');
  const status = input.status ?? input.existing?.status ?? 'draft';
  if (status === 'active' && input.existing?.status !== 'active' && input.activationConfirmation !== 'ACTIVATE CONTROLLER RETENTION POLICY') {
    throw new Error('activationConfirmation must exactly equal ACTIVATE CONTROLLER RETENTION POLICY');
  }
  const at = nowIso();
  const row = {
    ...(input.existing ?? {}),
    id: input.existing?.id ?? newId('ret_'),
    orgId: input.orgId,
    name: input.name.trim().slice(0, 160),
    recordClass: input.recordClass.trim().slice(0, 160),
    trigger: input.trigger,
    durationDays: input.durationDays,
    disposition: input.disposition,
    rationale: input.rationale.trim().slice(0, 2_000),
    status,
    approvedAt: status === 'active' ? input.existing?.approvedAt ?? at : input.existing?.approvedAt,
    approvedBy: status === 'active' ? input.existing?.approvedBy ?? input.actor : input.existing?.approvedBy,
    createdAt: input.existing?.createdAt ?? at,
  } as RetentionPolicyDoc;
  return commitBatch({
    upserts: [{ collection: 'retentionPolicies', doc: row, expectedRevision: input.existing ? Number(input.existing.revision ?? 0) : null, expectedOrgId: input.orgId }],
  }).upserts[0] as RetentionPolicyDoc;
}

export function legalHoldsFor(orgId: string, options: { activeOnly?: boolean } = {}) {
  return list<LegalHoldDoc>('legalHolds', (row) => row.orgId === orgId && (!options.activeOnly || !row.releasedAt))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function createLegalHold(input: {
  orgId: string;
  scopeType: LegalHoldDoc['scopeType'];
  scopeId: string;
  recordClass?: string;
  reason: string;
  actor: string;
}): LegalHoldDoc {
  if (!input.scopeId.trim() || input.reason.trim().length < 5) throw new Error('scopeId and a meaningful reason are required');
  return withEntityLock('privacy-governance', input.orgId, () => {
    const row = {
      id: newId('hold_'), orgId: input.orgId, scopeType: input.scopeType, scopeId: input.scopeId.trim(),
      recordClass: input.recordClass?.trim() || undefined, reason: input.reason.trim().slice(0, 2_000),
      createdBy: input.actor, createdAt: nowIso(),
    } as LegalHoldDoc;
    return commitBatch({ upserts: [{ collection: 'legalHolds', doc: row, expectedRevision: null, expectedOrgId: input.orgId }] }).upserts[0] as LegalHoldDoc;
  });
}

export function releaseLegalHold(input: { orgId: string; id: string; actor: string; reason: string }): LegalHoldDoc {
  if (input.reason.trim().length < 5) throw new Error('a release reason is required');
  return withEntityLock('privacy-governance', input.orgId, () => {
    const hold = find<LegalHoldDoc>('legalHolds', (row) => row.id === input.id && row.orgId === input.orgId);
    if (!hold) throw new Error('legal hold not found');
    if (hold.releasedAt) return hold;
    return commitBatch({
      upserts: [{ collection: 'legalHolds', doc: { ...hold, releasedAt: nowIso(), releasedBy: input.actor, releaseReason: input.reason.trim().slice(0, 2_000) }, expectedRevision: Number(hold.revision ?? 0), expectedOrgId: input.orgId }],
    }).upserts[0] as LegalHoldDoc;
  });
}

export function activeLegalHolds(input: { orgId: string; patientId?: string; resourceId?: string; recordClass?: string }) {
  return legalHoldsFor(input.orgId, { activeOnly: true }).filter((hold) => {
    if (hold.scopeType === 'workspace') return hold.scopeId === input.orgId || hold.scopeId === '*';
    if (hold.scopeType === 'patient') return Boolean(input.patientId && hold.scopeId === input.patientId);
    if (hold.scopeType === 'resource') return Boolean(input.resourceId && hold.scopeId === input.resourceId);
    return Boolean(input.recordClass && (hold.scopeId === input.recordClass || hold.recordClass === input.recordClass));
  });
}

export function retentionReviewManifestsFor(orgId: string) {
  return list<RetentionReviewManifestDoc>('retentionReviewManifests', (row) => row.orgId === orgId)
    .sort((a, b) => b.asOf.localeCompare(a.asOf));
}

export function createRetentionReviewManifest(input: { orgId: string; actor: string; asOf?: string; limit?: number }) {
  return withEntityLock('privacy-governance', input.orgId, () => {
    const asOf = input.asOf ?? nowIso();
    const asOfMs = Date.parse(asOf);
    if (!Number.isFinite(asOfMs)) throw new Error('retention preview asOf is invalid');
    const policies = retentionPoliciesFor(input.orgId).filter((row) => row.status === 'active');
    const definitions: Record<string, { collection: string; dateFields: string[] }> = {
      patient_record: { collection: 'clients', dateFields: ['archivedAt', 'lastInteractionAt', 'updatedAt', 'createdAt'] },
      clinical_note: { collection: 'notes', dateFields: ['archivedAt', 'signedAt', 'updatedAt', 'createdAt'] },
      clinical_document: { collection: 'clinicalDocuments', dateFields: ['archivedAt', 'updatedAt', 'createdAt'] },
      clinical_access_event: { collection: 'clinicalAccessEvents', dateFields: ['occurredAt', 'createdAt'] },
    };
    const cap = Math.max(1, Math.min(50_000, Math.floor(input.limit ?? 10_000)));
    const candidates: RetentionReviewManifestDoc['candidates'] = [];
    let truncated = false;
    for (const policy of policies) {
      const definition = definitions[policy.recordClass];
      if (!definition) continue;
      const cutoff = asOfMs - policy.durationDays * 86_400_000;
      const rows = list<Doc & { orgId?: string; patientId?: string; clientId?: string }>(definition.collection, (row) => row.orgId === input.orgId);
      for (const row of rows) {
        const triggerAt = definition.dateFields.map((field) => String(row[field] ?? '')).find((value) => Number.isFinite(Date.parse(value)));
        if (!triggerAt || Date.parse(triggerAt) > cutoff) continue;
        const patientId = row.patientId ?? row.clientId ?? (policy.recordClass === 'patient_record' ? row.id : undefined);
        const holds = activeLegalHolds({ orgId: input.orgId, patientId, resourceId: row.id, recordClass: policy.recordClass });
        candidates.push({
          recordClass: policy.recordClass, collection: definition.collection, resourceId: row.id, patientId,
          triggerAt, disposition: policy.disposition, held: holds.length > 0, holdIds: holds.map((hold) => hold.id),
        });
        if (candidates.length >= cap) { truncated = true; break; }
      }
      if (truncated) break;
    }
    const at = nowIso();
    const row = {
      id: newId('retention_preview_'), orgId: input.orgId, asOf,
      policyIds: policies.map((policy) => policy.id), candidates, truncated, generatedBy: input.actor,
      statement: 'Review manifest only. No record was deleted or anonymised; active legal holds are marked and always block disposition.',
      createdAt: at,
    } as RetentionReviewManifestDoc;
    return commitBatch({ upserts: [{ collection: 'retentionReviewManifests', doc: row, expectedRevision: null, expectedOrgId: input.orgId }] }).upserts[0] as RetentionReviewManifestDoc;
  });
}

export function deletionRequestsFor(orgId: string) {
  return list<DeletionRequestDoc>('deletionRequests', (row) => row.orgId === orgId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function createDeletionRequest(input: {
  orgId: string;
  patientId?: string;
  requesterType: DeletionRequestDoc['requesterType'];
  requesterReference: string;
  scope: string;
  dueAt?: string;
  actor: string;
}): DeletionRequestDoc {
  if (!input.requesterReference.trim() || !input.scope.trim()) throw new Error('requester reference and scope are required');
  const at = nowIso();
  const row = {
    id: newId('delreq_'), orgId: input.orgId, patientId: input.patientId,
    requesterType: input.requesterType, requesterReference: input.requesterReference.trim().slice(0, 500),
    scope: input.scope.trim().slice(0, 2_000), status: 'intake', dueAt: input.dueAt,
    history: [{ at, actor: input.actor, to: 'intake', note: 'request recorded' }], createdAt: at,
  } as DeletionRequestDoc;
  return commitBatch({ upserts: [{ collection: 'deletionRequests', doc: row, expectedRevision: null, expectedOrgId: input.orgId }] }).upserts[0] as DeletionRequestDoc;
}

const DELETION_TRANSITIONS: Record<DeletionRequestDoc['status'], DeletionRequestDoc['status'][]> = {
  intake: ['review', 'rejected'], review: ['approved', 'blocked', 'rejected'], approved: ['executing', 'blocked'],
  executing: ['completed', 'blocked'], blocked: ['review', 'approved', 'rejected'], completed: [], rejected: [],
};

export function transitionDeletionRequest(input: {
  orgId: string;
  id: string;
  to: DeletionRequestDoc['status'];
  actor: string;
  note?: string;
  assignedTo?: string;
  legalBasisDecision?: string;
}): DeletionRequestDoc {
  return withEntityLock('privacy-governance', input.orgId, () => {
    const request = find<DeletionRequestDoc>('deletionRequests', (row) => row.id === input.id && row.orgId === input.orgId);
    if (!request) throw new Error('deletion request not found');
    if (!DELETION_TRANSITIONS[request.status].includes(input.to)) throw new Error(`deletion request cannot move from ${request.status} to ${input.to}`);
    const holds = activeLegalHolds({ orgId: input.orgId, patientId: request.patientId, resourceId: request.id });
  let to = input.to;
  if (['approved', 'executing', 'completed'].includes(to) && holds.length) to = 'blocked';
  const at = nowIso();
  return commitBatch({
    upserts: [{
      collection: 'deletionRequests',
      doc: {
        ...request, status: to, assignedTo: input.assignedTo ?? request.assignedTo,
        legalBasisDecision: input.legalBasisDecision ?? request.legalBasisDecision,
        blockedByHoldIds: to === 'blocked' ? holds.map((hold) => hold.id) : undefined,
        completedAt: to === 'completed' ? at : request.completedAt,
        history: [...request.history, { at, actor: input.actor, from: request.status, to, note: input.note?.trim().slice(0, 1_000) }],
      },
      expectedRevision: Number(request.revision ?? 0), expectedOrgId: input.orgId,
    }],
    }).upserts[0] as DeletionRequestDoc;
  });
}

export function externalAttestationsFor(orgId: string) {
  return list<ExternalAttestationDoc>('externalAttestations', (row) => row.orgId === orgId).sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt));
}

export function recordExternalAttestation(input: {
  orgId: string;
  type: ExternalAttestationType;
  reviewerName: string;
  reviewerOrganisation: string;
  independent: boolean;
  scope: string;
  outcome: ExternalAttestationDoc['outcome'];
  reportReference: string;
  reportSha256?: string;
  reviewedAt: string;
  expiresAt: string;
  actionsOpen?: number;
  actor: string;
}): ExternalAttestationDoc {
  if (!input.reviewerName.trim() || !input.reviewerOrganisation.trim() || !input.scope.trim() || !input.reportReference.trim()) {
    throw new Error('reviewer, organisation, scope and report reference are required');
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(input.reviewedAt) || !/^\d{4}-\d{2}-\d{2}/.test(input.expiresAt) || Date.parse(input.expiresAt) <= Date.parse(input.reviewedAt)) {
    throw new Error('reviewedAt and a later expiresAt are required');
  }
  if (input.reportSha256 && !/^[a-f0-9]{64}$/i.test(input.reportSha256)) throw new Error('reportSha256 must contain 64 hexadecimal characters');
  const row = {
    id: newId('review_'), orgId: input.orgId, type: input.type,
    reviewerName: input.reviewerName.trim().slice(0, 160), reviewerOrganisation: input.reviewerOrganisation.trim().slice(0, 200),
    independent: input.independent, scope: input.scope.trim().slice(0, 2_000), outcome: input.outcome,
    reportReference: input.reportReference.trim().slice(0, 500), reportSha256: input.reportSha256?.toLowerCase(),
    reviewedAt: input.reviewedAt, expiresAt: input.expiresAt,
    actionsOpen: Math.max(0, Math.min(10_000, Math.floor(input.actionsOpen ?? 0))), recordedBy: input.actor, createdAt: nowIso(),
  } as ExternalAttestationDoc;
  return commitBatch({ upserts: [{ collection: 'externalAttestations', doc: row, expectedRevision: null, expectedOrgId: input.orgId }] }).upserts[0] as ExternalAttestationDoc;
}

export function recoveryEvidenceFor(orgId: string) {
  return list<RecoveryEvidenceDoc>('recoveryEvidence', (row) => row.orgId === orgId).sort((a, b) => b.restoreTestedAt.localeCompare(a.restoreTestedAt));
}

export function recordRecoveryEvidence(input: {
  orgId: string;
  backupReference: string;
  restoreTestedAt: string;
  testedBy: string;
  recoveryPointMinutes?: number;
  recoveryTimeMinutes?: number;
  outcome: RecoveryEvidenceDoc['outcome'];
  evidenceReference: string;
}): RecoveryEvidenceDoc {
  if (!input.backupReference.trim() || !input.testedBy.trim() || !input.evidenceReference.trim() || !Number.isFinite(Date.parse(input.restoreTestedAt))) {
    throw new Error('backup reference, restore date, tester and evidence reference are required');
  }
  const row = {
    id: newId('recovery_'), orgId: input.orgId, backupReference: input.backupReference.trim().slice(0, 500),
    restoreTestedAt: input.restoreTestedAt, testedBy: input.testedBy.trim().slice(0, 160),
    recoveryPointMinutes: input.recoveryPointMinutes, recoveryTimeMinutes: input.recoveryTimeMinutes,
    outcome: input.outcome, evidenceReference: input.evidenceReference.trim().slice(0, 500), createdAt: nowIso(),
  } as RecoveryEvidenceDoc;
  return commitBatch({ upserts: [{ collection: 'recoveryEvidence', doc: row, expectedRevision: null, expectedOrgId: input.orgId }] }).upserts[0] as RecoveryEvidenceDoc;
}

export function clinicalProfileFor(orgId: string): ClinicalProfileDoc {
  return find<ClinicalProfileDoc>('clinicalProfiles', (row) => row.orgId === orgId) ?? {
    id: `clinical_${orgId}`,
    orgId,
    market: 'UK',
    customerType: 'private_allied_health',
    operatingMode: 'disabled',
    profileVersion: 1,
    revision: 0,
  } as ClinicalProfileDoc;
}

export function saveClinicalProfile(profile: ClinicalProfileDoc): ClinicalProfileDoc {
  const exists = find<ClinicalProfileDoc>('clinicalProfiles', (row) => row.id === profile.id && row.orgId === profile.orgId);
  return commitBatch({
    upserts: [{ collection: 'clinicalProfiles', doc: profile, expectedRevision: exists ? Number(exists.revision ?? 0) : null, expectedOrgId: profile.orgId }],
  }).upserts[0] as ClinicalProfileDoc;
}
