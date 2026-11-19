import { audit } from './audit';
import {
  CommitConflictError,
  commitBatch,
  find,
  get,
  list,
  newId,
  nowIso,
  type Doc,
} from './db';
import { clientById } from './clients';
import { locationById, providerById } from './practice';

export const CASE_STATUSES = ['draft', 'active', 'paused', 'closed'] as const;
export const CASE_TRACKING_MODES = ['appointments', 'hours', 'budget'] as const;
export const CASE_LIMIT_POLICIES = ['warn', 'block'] as const;
export const CASE_ENFORCEMENT_MODES = ['shadow', 'enforced'] as const;

export type CaseStatus = (typeof CASE_STATUSES)[number];
export type CaseTrackingMode = (typeof CASE_TRACKING_MODES)[number];
export type CaseLimitPolicy = (typeof CASE_LIMIT_POLICIES)[number];
export type CaseEnforcementMode = (typeof CASE_ENFORCEMENT_MODES)[number];

export type CaseDoc = Doc & {
  orgId: string;
  patientId: string;
  name: string;
  number: string;
  type: 'private' | 'insurance' | 'employer' | 'other';
  status: CaseStatus;
  primaryProviderId?: string;
  payerId?: string;
  coverageId?: string;
  referralId?: string;
  startsOn: string;
  endsOn?: string;
  trackingMode: CaseTrackingMode;
  limitAppointments?: number;
  limitMinutes?: number;
  limitBudgetMinor?: number;
  currency: 'GBP';
  limitPolicy: CaseLimitPolicy;
  enforcementMode: CaseEnforcementMode;
  warningThresholdPct: number;
  closedAt?: string;
  closedBy?: string;
  createdBy: string;
  updatedBy: string;
  revision: number;
};

export type CaseAssignmentDoc = Doc & {
  orgId: string;
  caseId: string;
  patientId: string;
  providerId?: string;
  userId?: string;
  locationId?: string;
  role: 'primary' | 'supporting' | 'administrative';
  startsOn: string;
  endsOn?: string;
  createdBy: string;
  endedBy?: string;
  revision: number;
};

export type CaseWrite<T> =
  | { ok: true; value: T }
  | { ok: false; code: 'NOT_FOUND' | 'VALIDATION_ERROR' | 'CONFLICT'; error: string };

const safeId = (value: unknown) => /^[A-Za-z][A-Za-z0-9_-]{0,119}$/.test(String(value ?? ''));
const plainText = (value: unknown, max: number) => {
  const text = String(value ?? '').trim();
  return text && text.length <= max && !/[<>\u0000-\u001f]/.test(text) ? text : undefined;
};
const isoDate = (value: unknown) => {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text ? text : undefined;
};
const nonNegativeInt = (value: unknown) => {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : Number.NaN;
};

export function caseById(orgId: string, id: string): CaseDoc | undefined {
  const row = get<CaseDoc>('cases', id);
  return row && row.orgId === orgId ? row : undefined;
}

export function casesFor(orgId: string, options: { patientId?: string; status?: CaseStatus; includeClosed?: boolean } = {}) {
  return list<CaseDoc>('cases', (row) =>
    row.orgId === orgId &&
    (!options.patientId || row.patientId === options.patientId) &&
    (!options.status || row.status === options.status) &&
    (options.includeClosed !== false || row.status !== 'closed'),
  ).sort((a, b) => b.startsOn.localeCompare(a.startsOn) || a.number.localeCompare(b.number));
}

export function caseAssignmentsFor(orgId: string, caseId: string, activeOn?: string) {
  const on = activeOn ? isoDate(activeOn) : undefined;
  return list<CaseAssignmentDoc>('caseAssignments', (row) =>
    row.orgId === orgId && row.caseId === caseId &&
    (!on || (row.startsOn <= on && (!row.endsOn || row.endsOn >= on))),
  ).sort((a, b) => a.role.localeCompare(b.role) || a.startsOn.localeCompare(b.startsOn));
}

export function assignedUserIdsForCase(orgId: string, caseId: string, activeOn = nowIso().slice(0, 10)) {
  return caseAssignmentsFor(orgId, caseId, activeOn).map((row) => row.userId).filter((id): id is string => Boolean(id));
}

function validateCaseLinks(input: {
  orgId: string;
  patientId: string;
  primaryProviderId?: string;
  payerId?: string;
  coverageId?: string;
  referralId?: string;
}): string | undefined {
  const client = clientById(input.orgId, input.patientId);
  if (!client || client.archivedAt) return 'The case patient does not exist or is archived.';
  if (input.primaryProviderId && !providerById(input.orgId, input.primaryProviderId)) return 'The primary practitioner does not exist in this workspace.';
  if (input.payerId) {
    const payer = find<Doc & { orgId?: string; archivedAt?: string }>('payers', (row) => row.id === input.payerId && row.orgId === input.orgId);
    if (!payer || payer.archivedAt) return 'The selected payer does not exist or is archived.';
  }
  if (input.coverageId) {
    const coverage = find<Doc & { orgId?: string; patientId?: string; payerId?: string; status?: string }>(
      'clientCoverages',
      (row) => row.id === input.coverageId && row.orgId === input.orgId,
    );
    if (!coverage || coverage.patientId !== input.patientId) return 'The selected coverage does not belong to this patient.';
    if (input.payerId && coverage.payerId !== input.payerId) return 'The selected coverage belongs to a different payer.';
  }
  if (input.referralId) {
    const referral = find<Doc & { orgId?: string; patientId?: string; clientId?: string }>(
      'referrals',
      (row) => row.id === input.referralId && row.orgId === input.orgId,
    );
    if (!referral) return 'The selected referral does not exist in this workspace.';
    const owner = referral.patientId ?? referral.clientId;
    if (owner && owner !== input.patientId) return 'The selected referral belongs to a different patient.';
  }
  return undefined;
}

type NormalisedCaseShape = {
  name: string;
  number: string;
  type: CaseDoc['type'];
  status: CaseStatus;
  startsOn: string;
  endsOn?: string;
  trackingMode: CaseTrackingMode;
  limitAppointments?: number;
  limitMinutes?: number;
  limitBudgetMinor?: number;
  limitPolicy: CaseLimitPolicy;
  enforcementMode: CaseEnforcementMode;
  warningThresholdPct: number;
  revision: number;
};

function validateCaseShape(input: {
  name: unknown;
  number: unknown;
  type: unknown;
  status?: unknown;
  startsOn: unknown;
  endsOn?: unknown;
  trackingMode: unknown;
  limitAppointments?: unknown;
  limitMinutes?: unknown;
  limitBudgetMinor?: unknown;
  limitPolicy?: unknown;
  enforcementMode?: unknown;
  warningThresholdPct?: unknown;
}): { value?: NormalisedCaseShape; error?: string } {
  const name = plainText(input.name, 160);
  const number = plainText(input.number, 80);
  const type = String(input.type ?? '');
  const status = String(input.status ?? 'draft');
  const startsOn = isoDate(input.startsOn);
  const endsOn = input.endsOn ? isoDate(input.endsOn) : undefined;
  const trackingMode = String(input.trackingMode ?? '');
  const limitPolicy = String(input.limitPolicy ?? 'warn');
  const enforcementMode = String(input.enforcementMode ?? 'shadow');
  const warningThresholdPct = Number(input.warningThresholdPct ?? 80);
  const limitAppointments = nonNegativeInt(input.limitAppointments);
  const limitMinutes = nonNegativeInt(input.limitMinutes);
  const limitBudgetMinor = nonNegativeInt(input.limitBudgetMinor);
  if (!name) return { error: 'A case needs a plain-text name of at most 160 characters.' };
  if (!number) return { error: 'A case needs a staff-entered number of at most 80 characters.' };
  if (!['private', 'insurance', 'employer', 'other'].includes(type)) return { error: 'Case type must be private, insurance, employer or other.' };
  if (!CASE_STATUSES.includes(status as CaseStatus)) return { error: 'Case status must be draft, active, paused or closed.' };
  if (!startsOn || (input.endsOn && !endsOn)) return { error: 'Case dates must be real ISO dates (YYYY-MM-DD).' };
  if (endsOn && endsOn < startsOn) return { error: 'The case end date cannot be before its start date.' };
  if (!CASE_TRACKING_MODES.includes(trackingMode as CaseTrackingMode)) return { error: 'Tracking mode must be appointments, hours or budget.' };
  if (!CASE_LIMIT_POLICIES.includes(limitPolicy as CaseLimitPolicy)) return { error: 'Limit policy must warn or block.' };
  if (!CASE_ENFORCEMENT_MODES.includes(enforcementMode as CaseEnforcementMode)) return { error: 'Enforcement mode must be shadow or enforced.' };
  if (!Number.isFinite(warningThresholdPct) || warningThresholdPct < 1 || warningThresholdPct > 100) return { error: 'Warning threshold must be between 1 and 100 percent.' };
  if ([limitAppointments, limitMinutes, limitBudgetMinor].some((value) => Number.isNaN(value))) return { error: 'Case limits must be non-negative whole numbers.' };
  if (trackingMode === 'appointments' && (!limitAppointments || limitAppointments < 1)) return { error: 'Appointment tracking needs a positive appointment limit.' };
  if (trackingMode === 'hours' && (!limitMinutes || limitMinutes < 1)) return { error: 'Hour tracking needs a positive limit entered as whole minutes.' };
  if (trackingMode === 'budget' && (!limitBudgetMinor || limitBudgetMinor < 1)) return { error: 'Budget tracking needs a positive limit in minor currency units.' };
  return {
    value: {
      name,
      number,
      type: type as CaseDoc['type'],
      status: status as CaseStatus,
      startsOn,
      endsOn,
      trackingMode: trackingMode as CaseTrackingMode,
      limitAppointments,
      limitMinutes,
      limitBudgetMinor,
      limitPolicy: limitPolicy as CaseLimitPolicy,
      enforcementMode: enforcementMode as CaseEnforcementMode,
      warningThresholdPct,
      revision: 0,
    },
  };
}

export function createCase(input: {
  orgId: string;
  patientId: string;
  name: string;
  number: string;
  type: CaseDoc['type'];
  status?: CaseStatus;
  primaryProviderId?: string;
  payerId?: string;
  coverageId?: string;
  referralId?: string;
  startsOn: string;
  endsOn?: string;
  trackingMode: CaseTrackingMode;
  limitAppointments?: number;
  limitMinutes?: number;
  limitBudgetMinor?: number;
  limitPolicy?: CaseLimitPolicy;
  enforcementMode?: CaseEnforcementMode;
  warningThresholdPct?: number;
  actorId: string;
}): CaseWrite<CaseDoc> {
  if (!safeId(input.patientId)) return { ok: false, code: 'VALIDATION_ERROR', error: 'A valid patient id is required.' };
  const shape = validateCaseShape(input);
  if (!shape.value) return { ok: false, code: 'VALIDATION_ERROR', error: shape.error ?? 'The case is invalid.' };
  const linkError = validateCaseLinks(input);
  if (linkError) return { ok: false, code: 'VALIDATION_ERROR', error: linkError };
  if (find<CaseDoc>('cases', (row) => row.orgId === input.orgId && row.number.toLowerCase() === shape.value!.number.toLowerCase())) {
    return { ok: false, code: 'CONFLICT', error: 'That case number is already in use in this workspace.' };
  }
  const at = nowIso();
  const draft: CaseDoc = {
    id: newId('cas_'),
    orgId: input.orgId,
    patientId: input.patientId,
    ...shape.value,
    primaryProviderId: input.primaryProviderId || undefined,
    payerId: input.payerId || undefined,
    coverageId: input.coverageId || undefined,
    referralId: input.referralId || undefined,
    currency: 'GBP',
    createdBy: input.actorId,
    updatedBy: input.actorId,
    ...(shape.value.status === 'closed' ? { closedAt: at, closedBy: input.actorId } : {}),
  };
  try {
    const saved = commitBatch({ upserts: [{ collection: 'cases', doc: draft, expectedRevision: null, expectedOrgId: input.orgId }] }).upserts[0] as CaseDoc;
    audit({ orgId: input.orgId, actor: input.actorId, action: 'case.created', target: saved.id, detail: `${saved.number}; ${saved.trackingMode}; ${saved.status}` });
    return { ok: true, value: saved };
  } catch (error) {
    if (error instanceof CommitConflictError || /unique/i.test(error instanceof Error ? error.message : '')) return { ok: false, code: 'CONFLICT', error: 'That case number is already in use.' };
    throw error;
  }
}

export function updateCase(input: {
  orgId: string;
  id: string;
  expectedRevision: number;
  patch: Partial<Pick<CaseDoc,
    'name' | 'number' | 'type' | 'status' | 'primaryProviderId' | 'payerId' | 'coverageId' | 'referralId' |
    'startsOn' | 'endsOn' | 'trackingMode' | 'limitAppointments' | 'limitMinutes' | 'limitBudgetMinor' |
    'limitPolicy' | 'enforcementMode' | 'warningThresholdPct'>>;
  actorId: string;
}): CaseWrite<CaseDoc> {
  const existing = caseById(input.orgId, input.id);
  if (!existing) return { ok: false, code: 'NOT_FOUND', error: 'That case does not exist.' };
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) return { ok: false, code: 'VALIDATION_ERROR', error: 'Updating a case requires the exact revision reviewed.' };
  const merged = { ...existing, ...input.patch };
  const shape = validateCaseShape(merged);
  if (!shape.value) return { ok: false, code: 'VALIDATION_ERROR', error: shape.error ?? 'The case is invalid.' };
  const linkError = validateCaseLinks({
    orgId: input.orgId,
    patientId: existing.patientId,
    primaryProviderId: merged.primaryProviderId,
    payerId: merged.payerId,
    coverageId: merged.coverageId,
    referralId: merged.referralId,
  });
  if (linkError) return { ok: false, code: 'VALIDATION_ERROR', error: linkError };
  const duplicate = find<CaseDoc>('cases', (row) => row.orgId === input.orgId && row.id !== existing.id && row.number.toLowerCase() === shape.value!.number.toLowerCase());
  if (duplicate) return { ok: false, code: 'CONFLICT', error: 'That case number is already in use in this workspace.' };
  if (existing.status === 'closed' && merged.status !== 'closed') return { ok: false, code: 'CONFLICT', error: 'A closed case cannot be reopened. Create a new case so the original history remains intact.' };
  const at = nowIso();
  const next: CaseDoc = {
    ...existing,
    ...shape.value,
    primaryProviderId: merged.primaryProviderId || undefined,
    payerId: merged.payerId || undefined,
    coverageId: merged.coverageId || undefined,
    referralId: merged.referralId || undefined,
    updatedBy: input.actorId,
    ...(merged.status === 'closed' && existing.status !== 'closed' ? { closedAt: at, closedBy: input.actorId } : {}),
  };
  try {
    const saved = commitBatch({ upserts: [{ collection: 'cases', doc: next, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId }] }).upserts[0] as CaseDoc;
    audit({ orgId: input.orgId, actor: input.actorId, action: 'case.updated', target: saved.id, detail: `${existing.status} → ${saved.status}; revision ${saved.revision}` });
    return { ok: true, value: saved };
  } catch (error) {
    if (error instanceof CommitConflictError) return { ok: false, code: 'CONFLICT', error: 'That case changed. Reload before saving.' };
    if (/unique/i.test(error instanceof Error ? error.message : '')) return { ok: false, code: 'CONFLICT', error: 'That case number is already in use.' };
    throw error;
  }
}

function datesOverlap(aStart: string, aEnd: string | undefined, bStart: string, bEnd: string | undefined) {
  return aStart <= (bEnd ?? '9999-12-31') && bStart <= (aEnd ?? '9999-12-31');
}

export function assignCase(input: {
  orgId: string;
  caseId: string;
  providerId?: string;
  userId?: string;
  locationId?: string;
  role: CaseAssignmentDoc['role'];
  startsOn: string;
  endsOn?: string;
  actorId: string;
}): CaseWrite<CaseAssignmentDoc> {
  const caseRow = caseById(input.orgId, input.caseId);
  if (!caseRow) return { ok: false, code: 'NOT_FOUND', error: 'That case does not exist.' };
  if (caseRow.status === 'closed') return { ok: false, code: 'CONFLICT', error: 'A closed case cannot receive new assignments.' };
  const startsOn = isoDate(input.startsOn);
  const endsOn = input.endsOn ? isoDate(input.endsOn) : undefined;
  if (!startsOn || (input.endsOn && !endsOn) || (endsOn && endsOn < startsOn)) return { ok: false, code: 'VALIDATION_ERROR', error: 'Assignment dates must be a valid inclusive range.' };
  if (!input.providerId && !input.userId && !input.locationId) return { ok: false, code: 'VALIDATION_ERROR', error: 'An assignment needs a practitioner, user or location.' };
  if (!['primary', 'supporting', 'administrative'].includes(input.role)) return { ok: false, code: 'VALIDATION_ERROR', error: 'Assignment role must be primary, supporting or administrative.' };
  if (input.providerId && !providerById(input.orgId, input.providerId)) return { ok: false, code: 'VALIDATION_ERROR', error: 'The assigned practitioner does not exist.' };
  if (input.userId && !find<Doc & { orgId?: string }>('users', (row) => row.id === input.userId && row.orgId === input.orgId)) return { ok: false, code: 'VALIDATION_ERROR', error: 'The assigned user does not exist.' };
  if (input.locationId && !locationById(input.orgId, input.locationId)) return { ok: false, code: 'VALIDATION_ERROR', error: 'The assigned location does not exist.' };
  const overlapping = caseAssignmentsFor(input.orgId, input.caseId).find((row) =>
    row.providerId === input.providerId && row.userId === input.userId && row.locationId === input.locationId &&
    datesOverlap(row.startsOn, row.endsOn, startsOn, endsOn),
  );
  if (overlapping) return { ok: false, code: 'CONFLICT', error: 'That case assignment already overlaps this date range.' };
  const draft: CaseAssignmentDoc = {
    id: newId('csa_'),
    orgId: input.orgId,
    caseId: caseRow.id,
    patientId: caseRow.patientId,
    providerId: input.providerId || undefined,
    userId: input.userId || undefined,
    locationId: input.locationId || undefined,
    role: input.role,
    startsOn,
    endsOn,
    createdBy: input.actorId,
    revision: 0,
  };
  const saved = commitBatch({ upserts: [{ collection: 'caseAssignments', doc: draft, expectedRevision: null, expectedOrgId: input.orgId }] }).upserts[0] as CaseAssignmentDoc;
  audit({ orgId: input.orgId, actor: input.actorId, action: 'case.assignment_created', target: saved.id, detail: `${caseRow.number}; ${saved.role}` });
  return { ok: true, value: saved };
}

export function endCaseAssignment(input: { orgId: string; id: string; expectedRevision: number; endsOn: string; actorId: string }): CaseWrite<CaseAssignmentDoc> {
  const existing = get<CaseAssignmentDoc>('caseAssignments', input.id);
  if (!existing || existing.orgId !== input.orgId) return { ok: false, code: 'NOT_FOUND', error: 'That case assignment does not exist.' };
  const endsOn = isoDate(input.endsOn);
  if (!endsOn || endsOn < existing.startsOn) return { ok: false, code: 'VALIDATION_ERROR', error: 'The assignment end date must be on or after its start date.' };
  try {
    const saved = commitBatch({ upserts: [{
      collection: 'caseAssignments',
      doc: { ...existing, endsOn, endedBy: input.actorId },
      expectedRevision: input.expectedRevision,
      expectedOrgId: input.orgId,
    }] }).upserts[0] as CaseAssignmentDoc;
    audit({ orgId: input.orgId, actor: input.actorId, action: 'case.assignment_ended', target: saved.id, detail: endsOn });
    return { ok: true, value: saved };
  } catch (error) {
    if (error instanceof CommitConflictError) return { ok: false, code: 'CONFLICT', error: 'That assignment changed. Reload before ending it.' };
    throw error;
  }
}
