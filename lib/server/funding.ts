import crypto from 'node:crypto';
import { audit } from './audit';
import { caseById, type CaseDoc } from './cases';
import { coverageById } from './coverage';
import {
  CommitConflictError,
  commitBatch,
  find,
  get,
  list,
  newId,
  nowIso,
  withEntityLock,
  type BatchUpsert,
  type Doc,
} from './db';
import { locationById, providerById, serviceById } from './practice';

export type FundingVector = {
  appointments: number;
  minutes: number;
  budgetMinor: number;
};

export type FundingPeriodDoc = Doc & {
  orgId: string;
  caseId: string;
  patientId: string;
  startsOn: string;
  endsOn: string;
  allowed: FundingVector;
  rolloverPolicy: 'none' | 'staff_entered';
  rollover: FundingVector;
  committed: FundingVector;
  used: FundingVector;
  createdBy: string;
  updatedBy: string;
  revision: number;
};

export type CaseServiceRuleDoc = Doc & {
  orgId: string;
  caseId: string;
  patientId: string;
  serviceId?: string;
  providerId?: string;
  locationId?: string;
  startsOn: string;
  endsOn?: string;
  unit: 'appointment' | 'hour';
  fundedPriceMinor: number;
  taxRateBps: number;
  claimCode?: string;
  claimCodeSource?: string;
  requiresAuthorisation: boolean;
  noShowPolicy: 'consume' | 'release';
  lateCancelPolicy: 'consume' | 'release';
  lateCancellationHours: number;
  active: boolean;
  createdBy: string;
  updatedBy: string;
  revision: number;
};

export type AuthorisationDoc = Doc & {
  orgId: string;
  caseId: string;
  patientId: string;
  coverageId?: string;
  externalReference: string;
  serviceIds: string[];
  startsOn: string;
  endsOn: string;
  authorised: FundingVector;
  committed: FundingVector;
  used: FundingVector;
  evidenceDocumentId?: string;
  evidenceDocumentVersionId?: string;
  status: 'draft' | 'active' | 'exhausted' | 'expired' | 'revoked';
  createdBy: string;
  updatedBy: string;
  revision: number;
};

export type FundingAllocation = {
  state: 'committed' | 'used';
  caseId: string;
  periodId: string;
  serviceRuleId: string;
  authorisationId?: string;
  coverageId?: string;
  trackingMode: CaseDoc['trackingMode'];
  noShowPolicy: 'consume' | 'release';
  lateCancelPolicy: 'consume' | 'release';
  lateCancellationHours: number;
  appointments: number;
  minutes: number;
  budgetMinor: number;
  currency: 'GBP';
  allocatedAt: string;
  settledAt?: string;
};

export type FundingBooking = Doc & {
  orgId: string;
  clientId?: string;
  caseId?: string;
  coverageId?: string;
  authorisationId?: string;
  fundingPeriodId?: string;
  serviceRuleId?: string;
  fundingAllocation?: FundingAllocation;
  fundingSequence?: number;
  fundingWarning?: string;
  startsAt: string;
  timezone?: string;
  durationMinutes: number;
  status: string;
  providerId?: string;
  serviceId?: string;
  locationId?: string;
  revision: number;
};

export type FundingEventDoc = Doc & {
  orgId: string;
  bookingId: string;
  patientId: string;
  caseId: string;
  periodId?: string;
  serviceRuleId?: string;
  authorisationId?: string;
  sequence: number;
  type: 'commit' | 'spend' | 'reverse' | 'reallocate' | 'override';
  previousAllocation?: FundingAllocation;
  allocation?: FundingAllocation;
  periodDeltas: Array<{ periodId: string; committed: FundingVector; used: FundingVector }>;
  authorisationDeltas: Array<{ authorisationId: string; committed: FundingVector; used: FundingVector }>;
  breaches: string[];
  override?: { by: string; reason: string };
  actorId: string;
  reason: string;
  occurredAt: string;
  revision: number;
};

export type FundingWrite<T> =
  | { ok: true; value: T; event?: FundingEventDoc; warnings?: string[] }
  | { ok: false; code: 'NOT_FOUND' | 'VALIDATION_ERROR' | 'CONFLICT' | 'LIMIT_EXCEEDED' | 'MISSING_FUNDING'; error: string; missing?: string[]; breaches?: string[] };

const ZERO = (): FundingVector => ({ appointments: 0, minutes: 0, budgetMinor: 0 });
const add = (a: FundingVector, b: FundingVector): FundingVector => ({
  appointments: a.appointments + b.appointments,
  minutes: a.minutes + b.minutes,
  budgetMinor: a.budgetMinor + b.budgetMinor,
});
const negate = (a: FundingVector): FundingVector => ({ appointments: -a.appointments, minutes: -a.minutes, budgetMinor: -a.budgetMinor });
const sameVector = (a: FundingVector, b: FundingVector) => a.appointments === b.appointments && a.minutes === b.minutes && a.budgetMinor === b.budgetMinor;
const vectorFromAllocation = (allocation: FundingAllocation): FundingVector => ({
  appointments: allocation.appointments,
  minutes: allocation.minutes,
  budgetMinor: allocation.budgetMinor,
});
const validVector = (vector: FundingVector) => Object.values(vector).every((value) => Number.isSafeInteger(value) && value >= 0);

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
const whole = (value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : undefined;
};
const dateOverlap = (aStart: string, aEnd: string | undefined, bStart: string, bEnd: string | undefined) =>
  aStart <= (bEnd ?? '9999-12-31') && bStart <= (aEnd ?? '9999-12-31');

function inputVector(input: Partial<FundingVector> | undefined, required = false): { value?: FundingVector; error?: string } {
  const source = input ?? {};
  const appointments = whole(source.appointments ?? 0);
  const minutes = whole(source.minutes ?? 0);
  const budgetMinor = whole(source.budgetMinor ?? 0);
  if (appointments === undefined || minutes === undefined || budgetMinor === undefined) return { error: 'Funding amounts must be non-negative whole numbers.' };
  const value = { appointments, minutes, budgetMinor };
  if (required && appointments + minutes + budgetMinor === 0) return { error: 'At least one funding allowance must be greater than zero.' };
  return { value };
}

function bookingDate(booking: FundingBooking): string | undefined {
  const instant = new Date(booking.startsAt);
  if (!Number.isFinite(instant.getTime())) return undefined;
  if (booking.timezone) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: booking.timezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(instant);
      const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
      return `${value.year}-${value.month}-${value.day}`;
    } catch {
      return undefined;
    }
  }
  return instant.toISOString().slice(0, 10);
}

export function fundingPeriodById(orgId: string, id: string) {
  const row = get<FundingPeriodDoc>('fundingPeriods', id);
  return row && row.orgId === orgId ? row : undefined;
}

export function fundingPeriodsForCase(orgId: string, caseId: string) {
  return list<FundingPeriodDoc>('fundingPeriods', (row) => row.orgId === orgId && row.caseId === caseId)
    .sort((a, b) => a.startsOn.localeCompare(b.startsOn) || a.id.localeCompare(b.id));
}

export function serviceRuleById(orgId: string, id: string) {
  const row = get<CaseServiceRuleDoc>('caseServiceRules', id);
  return row && row.orgId === orgId ? row : undefined;
}

export function serviceRulesForCase(orgId: string, caseId: string, includeInactive = false) {
  return list<CaseServiceRuleDoc>('caseServiceRules', (row) => row.orgId === orgId && row.caseId === caseId && (includeInactive || row.active))
    .sort((a, b) => a.startsOn.localeCompare(b.startsOn) || a.id.localeCompare(b.id));
}

export function authorisationById(orgId: string, id: string) {
  const row = get<AuthorisationDoc>('authorisations', id);
  return row && row.orgId === orgId ? row : undefined;
}

export function authorisationsForCase(orgId: string, caseId: string, includeInactive = true) {
  return list<AuthorisationDoc>('authorisations', (row) => row.orgId === orgId && row.caseId === caseId && (includeInactive || row.status === 'active'))
    .sort((a, b) => a.endsOn.localeCompare(b.endsOn) || a.id.localeCompare(b.id));
}

export function fundingEventsForBooking(orgId: string, bookingId: string) {
  return list<FundingEventDoc>('fundingEvents', (row) => row.orgId === orgId && row.bookingId === bookingId)
    .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
}

export function createFundingPeriod(input: {
  orgId: string;
  caseId: string;
  startsOn: string;
  endsOn: string;
  allowed: FundingVector;
  rolloverPolicy?: FundingPeriodDoc['rolloverPolicy'];
  rollover?: FundingVector;
  actorId: string;
}): FundingWrite<FundingPeriodDoc> {
  return withEntityLock('case-funding', `${input.orgId}:${input.caseId}`, () => {
    const caseRow = caseById(input.orgId, input.caseId);
    if (!caseRow) return { ok: false, code: 'NOT_FOUND', error: 'That case does not exist.' };
    if (caseRow.status === 'closed') return { ok: false, code: 'CONFLICT', error: 'A closed case cannot receive a funding period.' };
    const startsOn = isoDate(input.startsOn);
    const endsOn = isoDate(input.endsOn);
    if (!startsOn || !endsOn || endsOn < startsOn) return { ok: false, code: 'VALIDATION_ERROR', error: 'Funding-period dates must be a valid inclusive ISO-date range.' };
    if (startsOn < caseRow.startsOn || (caseRow.endsOn && endsOn > caseRow.endsOn)) return { ok: false, code: 'VALIDATION_ERROR', error: 'A funding period must stay within the case dates.' };
    const allowed = inputVector(input.allowed, true);
    const rollover = inputVector(input.rollover);
    if (!allowed.value || !rollover.value) return { ok: false, code: 'VALIDATION_ERROR', error: allowed.error ?? rollover.error ?? 'Funding amounts are invalid.' };
    const rolloverPolicy = input.rolloverPolicy ?? 'none';
    if (!['none', 'staff_entered'].includes(rolloverPolicy)) return { ok: false, code: 'VALIDATION_ERROR', error: 'Rollover policy must be none or staff_entered.' };
    if (rolloverPolicy === 'none' && !sameVector(rollover.value, ZERO())) return { ok: false, code: 'VALIDATION_ERROR', error: 'Rollover amounts require the staff_entered rollover policy.' };
    const overlap = fundingPeriodsForCase(input.orgId, caseRow.id).find((period) => dateOverlap(period.startsOn, period.endsOn, startsOn, endsOn));
    if (overlap) return { ok: false, code: 'CONFLICT', error: 'Funding periods for one case cannot overlap.' };
    const draft: FundingPeriodDoc = {
      id: newId('fnp_'), orgId: input.orgId, caseId: caseRow.id, patientId: caseRow.patientId,
      startsOn, endsOn, allowed: allowed.value, rolloverPolicy, rollover: rollover.value,
      committed: ZERO(), used: ZERO(), createdBy: input.actorId, updatedBy: input.actorId, revision: 0,
    };
    const saved = commitBatch({ upserts: [{ collection: 'fundingPeriods', doc: draft, expectedRevision: null, expectedOrgId: input.orgId }] }).upserts[0] as FundingPeriodDoc;
    audit({ orgId: input.orgId, actor: input.actorId, action: 'funding.period_created', target: saved.id, detail: `${caseRow.number}; ${startsOn}–${endsOn}` });
    return { ok: true, value: saved };
  });
}

export function updateFundingPeriod(input: {
  orgId: string;
  id: string;
  expectedRevision: number;
  startsOn: string;
  endsOn: string;
  allowed: FundingVector;
  rolloverPolicy: FundingPeriodDoc['rolloverPolicy'];
  rollover: FundingVector;
  actorId: string;
}): FundingWrite<FundingPeriodDoc> {
  const initial = fundingPeriodById(input.orgId, input.id);
  if (!initial) return { ok: false, code: 'NOT_FOUND', error: 'That funding period does not exist.' };
  return withEntityLock('case-funding', `${input.orgId}:${initial.caseId}`, () => {
    const existing = fundingPeriodById(input.orgId, input.id);
    if (!existing) return { ok: false, code: 'NOT_FOUND', error: 'That funding period does not exist.' };
    const caseRow = caseById(input.orgId, existing.caseId);
    if (!caseRow) return { ok: false, code: 'NOT_FOUND', error: 'The funding period case no longer exists.' };
    const startsOn = isoDate(input.startsOn);
    const endsOn = isoDate(input.endsOn);
    const allowed = inputVector(input.allowed, true);
    const rollover = inputVector(input.rollover);
    if (!startsOn || !endsOn || endsOn < startsOn || !allowed.value || !rollover.value) return { ok: false, code: 'VALIDATION_ERROR', error: allowed.error ?? rollover.error ?? 'Funding-period dates or amounts are invalid.' };
    if (startsOn < caseRow.startsOn || (caseRow.endsOn && endsOn > caseRow.endsOn)) return { ok: false, code: 'VALIDATION_ERROR', error: 'A funding period must stay within the case dates.' };
    if (!['none', 'staff_entered'].includes(input.rolloverPolicy)) return { ok: false, code: 'VALIDATION_ERROR', error: 'Rollover policy must be none or staff_entered.' };
    if (input.rolloverPolicy === 'none' && !sameVector(rollover.value, ZERO())) return { ok: false, code: 'VALIDATION_ERROR', error: 'Rollover amounts require the staff_entered rollover policy.' };
    const capacity = add(allowed.value, rollover.value);
    const consumed = add(existing.committed, existing.used);
    if (capacity.appointments < consumed.appointments || capacity.minutes < consumed.minutes || capacity.budgetMinor < consumed.budgetMinor) return { ok: false, code: 'CONFLICT', error: 'Funding allowance cannot be reduced below already committed and used amounts.' };
    const overlap = fundingPeriodsForCase(input.orgId, existing.caseId).find((period) => period.id !== existing.id && dateOverlap(period.startsOn, period.endsOn, startsOn, endsOn));
    if (overlap) return { ok: false, code: 'CONFLICT', error: 'Funding periods for one case cannot overlap.' };
    try {
      const saved = commitBatch({ upserts: [{ collection: 'fundingPeriods', doc: { ...existing, startsOn, endsOn, allowed: allowed.value, rolloverPolicy: input.rolloverPolicy, rollover: rollover.value, updatedBy: input.actorId }, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId }] }).upserts[0] as FundingPeriodDoc;
      audit({ orgId: input.orgId, actor: input.actorId, action: 'funding.period_updated', target: saved.id, detail: `${startsOn}–${endsOn}` });
      return { ok: true, value: saved };
    } catch (error) {
      if (error instanceof CommitConflictError) return { ok: false, code: 'CONFLICT', error: 'That funding period changed. Reload before saving.' };
      throw error;
    }
  });
}

function validateRule(input: {
  orgId: string; caseId: string; serviceId?: string; providerId?: string; locationId?: string;
  startsOn: string; endsOn?: string; unit: CaseServiceRuleDoc['unit']; fundedPriceMinor: number; taxRateBps?: number;
  claimCode?: string; claimCodeSource?: string; requiresAuthorisation?: boolean;
  noShowPolicy: CaseServiceRuleDoc['noShowPolicy']; lateCancelPolicy: CaseServiceRuleDoc['lateCancelPolicy']; lateCancellationHours: number; active?: boolean;
}) {
  const startsOn = isoDate(input.startsOn);
  const endsOn = input.endsOn ? isoDate(input.endsOn) : undefined;
  const fundedPriceMinor = whole(input.fundedPriceMinor);
  const taxRateBps = whole(input.taxRateBps ?? 0, 0, 100_000);
  const lateCancellationHours = whole(input.lateCancellationHours, 0, 8_760);
  const claimCode = input.claimCode ? plainText(input.claimCode, 80) : undefined;
  const claimCodeSource = input.claimCodeSource ? plainText(input.claimCodeSource, 160) : undefined;
  if (!startsOn || (input.endsOn && !endsOn) || (endsOn && endsOn < startsOn)) return { error: 'Service-rule dates must be a valid inclusive range.' } as const;
  if (!['appointment', 'hour'].includes(input.unit)) return { error: 'A service-rule unit must be appointment or hour.' } as const;
  if (fundedPriceMinor === undefined || taxRateBps === undefined || lateCancellationHours === undefined) return { error: 'Service-rule price, tax and cancellation window must be non-negative whole numbers.' } as const;
  if (!['consume', 'release'].includes(input.noShowPolicy) || !['consume', 'release'].includes(input.lateCancelPolicy)) return { error: 'No-show and late-cancel policy must explicitly be consume or release.' } as const;
  if ((input.claimCode && !claimCode) || (input.claimCodeSource && !claimCodeSource)) return { error: 'Claim-code references must be plain text.' } as const;
  if (claimCode && !claimCodeSource) return { error: 'A staff-entered claim code must retain its source.' } as const;
  if (input.serviceId && !serviceById(input.orgId, input.serviceId)) return { error: 'The selected service does not exist.' } as const;
  if (input.providerId && !providerById(input.orgId, input.providerId)) return { error: 'The selected practitioner does not exist.' } as const;
  if (input.locationId && !locationById(input.orgId, input.locationId)) return { error: 'The selected location does not exist.' } as const;
  return { value: { startsOn, endsOn, unit: input.unit, fundedPriceMinor, taxRateBps, claimCode, claimCodeSource, requiresAuthorisation: Boolean(input.requiresAuthorisation), noShowPolicy: input.noShowPolicy, lateCancelPolicy: input.lateCancelPolicy, lateCancellationHours, active: input.active !== false } } as const;
}

export function createServiceRule(input: {
  orgId: string; caseId: string; serviceId?: string; providerId?: string; locationId?: string;
  startsOn: string; endsOn?: string; unit: CaseServiceRuleDoc['unit']; fundedPriceMinor: number; taxRateBps?: number;
  claimCode?: string; claimCodeSource?: string; requiresAuthorisation?: boolean;
  noShowPolicy: CaseServiceRuleDoc['noShowPolicy']; lateCancelPolicy: CaseServiceRuleDoc['lateCancelPolicy']; lateCancellationHours: number;
  active?: boolean; actorId: string;
}): FundingWrite<CaseServiceRuleDoc> {
  return withEntityLock('case-funding', `${input.orgId}:${input.caseId}`, () => {
    const caseRow = caseById(input.orgId, input.caseId);
    if (!caseRow) return { ok: false, code: 'NOT_FOUND', error: 'That case does not exist.' };
    if (caseRow.status === 'closed') return { ok: false, code: 'CONFLICT', error: 'A closed case cannot receive a service rule.' };
    const shape = validateRule(input);
    if (!shape.value) return { ok: false, code: 'VALIDATION_ERROR', error: shape.error };
    const overlap = serviceRulesForCase(input.orgId, input.caseId, true).find((row) =>
      row.serviceId === input.serviceId && row.providerId === input.providerId && row.locationId === input.locationId &&
      dateOverlap(row.startsOn, row.endsOn, shape.value.startsOn, shape.value.endsOn),
    );
    if (overlap) return { ok: false, code: 'CONFLICT', error: 'An identical case service-rule scope already overlaps those dates.' };
    const draft: CaseServiceRuleDoc = {
      id: newId('csr_'), orgId: input.orgId, caseId: caseRow.id, patientId: caseRow.patientId,
      serviceId: input.serviceId || undefined, providerId: input.providerId || undefined, locationId: input.locationId || undefined,
      ...shape.value, createdBy: input.actorId, updatedBy: input.actorId, revision: 0,
    };
    const saved = commitBatch({ upserts: [{ collection: 'caseServiceRules', doc: draft, expectedRevision: null, expectedOrgId: input.orgId }] }).upserts[0] as CaseServiceRuleDoc;
    audit({ orgId: input.orgId, actor: input.actorId, action: 'funding.service_rule_created', target: saved.id, detail: `${caseRow.number}; ${saved.unit}; ${saved.fundedPriceMinor}` });
    return { ok: true, value: saved };
  });
}

export function updateServiceRule(input: {
  orgId: string; id: string; expectedRevision: number;
  patch: Partial<Pick<CaseServiceRuleDoc, 'serviceId' | 'providerId' | 'locationId' | 'startsOn' | 'endsOn' | 'unit' | 'fundedPriceMinor' | 'taxRateBps' | 'claimCode' | 'claimCodeSource' | 'requiresAuthorisation' | 'noShowPolicy' | 'lateCancelPolicy' | 'lateCancellationHours' | 'active'>>;
  actorId: string;
}): FundingWrite<CaseServiceRuleDoc> {
  const initial = serviceRuleById(input.orgId, input.id);
  if (!initial) return { ok: false, code: 'NOT_FOUND', error: 'That service rule does not exist.' };
  return withEntityLock('case-funding', `${input.orgId}:${initial.caseId}`, () => {
    const existing = serviceRuleById(input.orgId, input.id);
    if (!existing) return { ok: false, code: 'NOT_FOUND', error: 'That service rule does not exist.' };
    const merged = { ...existing, ...input.patch };
    const shape = validateRule(merged);
    if (!shape.value) return { ok: false, code: 'VALIDATION_ERROR', error: shape.error };
    const overlap = serviceRulesForCase(input.orgId, existing.caseId, true).find((row) => row.id !== existing.id && row.serviceId === merged.serviceId && row.providerId === merged.providerId && row.locationId === merged.locationId && dateOverlap(row.startsOn, row.endsOn, shape.value.startsOn, shape.value.endsOn));
    if (overlap) return { ok: false, code: 'CONFLICT', error: 'An identical case service-rule scope already overlaps those dates.' };
    try {
      const saved = commitBatch({ upserts: [{ collection: 'caseServiceRules', doc: { ...existing, serviceId: merged.serviceId || undefined, providerId: merged.providerId || undefined, locationId: merged.locationId || undefined, ...shape.value, updatedBy: input.actorId }, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId }] }).upserts[0] as CaseServiceRuleDoc;
      audit({ orgId: input.orgId, actor: input.actorId, action: 'funding.service_rule_updated', target: saved.id, detail: `active=${saved.active}` });
      return { ok: true, value: saved };
    } catch (error) {
      if (error instanceof CommitConflictError) return { ok: false, code: 'CONFLICT', error: 'That service rule changed. Reload before saving.' };
      throw error;
    }
  });
}

function validateEvidence(orgId: string, documentId?: string, versionId?: string) {
  if (!documentId && !versionId) return undefined;
  if (!documentId || !versionId) return 'Authorisation evidence needs both a document and immutable version.';
  const document = get<Doc & { orgId?: string; currentScanStatus?: string }>('clinicalDocuments', documentId);
  const version = get<Doc & { orgId?: string; documentId?: string }>('clinicalDocumentVersions', versionId);
  if (!document || document.orgId !== orgId || !version || version.orgId !== orgId || version.documentId !== documentId) return 'The authorisation evidence document/version does not exist in this workspace.';
  if (document.currentScanStatus !== 'clean') return 'Authorisation evidence must pass malware scanning.';
  return undefined;
}

function validateAuthorisation(input: {
  orgId: string; caseId: string; coverageId?: string; externalReference: string; serviceIds: string[];
  startsOn: string; endsOn: string; authorised: FundingVector; evidenceDocumentId?: string; evidenceDocumentVersionId?: string;
  status?: AuthorisationDoc['status'];
}) {
  const externalReference = plainText(input.externalReference, 160);
  const startsOn = isoDate(input.startsOn);
  const endsOn = isoDate(input.endsOn);
  const authorised = inputVector(input.authorised, true);
  const serviceIds = [...new Set((input.serviceIds ?? []).map(String).filter(Boolean))];
  const status = input.status ?? 'draft';
  if (!externalReference) return { error: 'An authorisation needs a staff-entered external reference.' } as const;
  if (!startsOn || !endsOn || endsOn < startsOn) return { error: 'Authorisation dates must be a valid inclusive range.' } as const;
  if (!authorised.value) return { error: authorised.error } as const;
  if (!['draft', 'active', 'exhausted', 'expired', 'revoked'].includes(status)) return { error: 'Authorisation status is invalid.' } as const;
  for (const serviceId of serviceIds) if (!serviceById(input.orgId, serviceId)) return { error: `Authorised service ${serviceId} does not exist.` } as const;
  const evidenceError = validateEvidence(input.orgId, input.evidenceDocumentId, input.evidenceDocumentVersionId);
  if (evidenceError) return { error: evidenceError } as const;
  return { value: { coverageId: input.coverageId || undefined, externalReference, serviceIds, startsOn, endsOn, authorised: authorised.value, evidenceDocumentId: input.evidenceDocumentId || undefined, evidenceDocumentVersionId: input.evidenceDocumentVersionId || undefined, status } } as const;
}

export function createAuthorisation(input: {
  orgId: string; caseId: string; coverageId?: string; externalReference: string; serviceIds: string[];
  startsOn: string; endsOn: string; authorised: FundingVector; evidenceDocumentId?: string; evidenceDocumentVersionId?: string;
  status?: AuthorisationDoc['status']; actorId: string;
}): FundingWrite<AuthorisationDoc> {
  return withEntityLock('case-funding', `${input.orgId}:${input.caseId}`, () => {
    const caseRow = caseById(input.orgId, input.caseId);
    if (!caseRow) return { ok: false, code: 'NOT_FOUND', error: 'That case does not exist.' };
    const shape = validateAuthorisation(input);
    if (!shape.value) return { ok: false, code: 'VALIDATION_ERROR', error: shape.error ?? 'The authorisation is invalid.' };
    if (shape.value.coverageId) {
      const coverage = coverageById(input.orgId, shape.value.coverageId);
      if (!coverage || coverage.patientId !== caseRow.patientId) return { ok: false, code: 'VALIDATION_ERROR', error: 'The authorisation coverage does not belong to this case patient.' };
      if (caseRow.coverageId && coverage.id !== caseRow.coverageId) return { ok: false, code: 'VALIDATION_ERROR', error: 'The authorisation coverage does not match the case coverage.' };
    }
    if (find<AuthorisationDoc>('authorisations', (row) => row.orgId === input.orgId && row.caseId === input.caseId && row.externalReference.toLowerCase() === shape.value!.externalReference.toLowerCase())) return { ok: false, code: 'CONFLICT', error: 'That authorisation reference already exists on this case.' };
    const draft: AuthorisationDoc = {
      id: newId('aut_'), orgId: input.orgId, caseId: caseRow.id, patientId: caseRow.patientId,
      ...shape.value, committed: ZERO(), used: ZERO(), createdBy: input.actorId, updatedBy: input.actorId, revision: 0,
    };
    const saved = commitBatch({ upserts: [{ collection: 'authorisations', doc: draft, expectedRevision: null, expectedOrgId: input.orgId }] }).upserts[0] as AuthorisationDoc;
    audit({ orgId: input.orgId, actor: input.actorId, action: 'funding.authorisation_created', target: saved.id, detail: `${saved.externalReference}; ${saved.status}` });
    return { ok: true, value: saved };
  });
}

export function updateAuthorisation(input: {
  orgId: string; id: string; expectedRevision: number;
  patch: Partial<Pick<AuthorisationDoc, 'coverageId' | 'externalReference' | 'serviceIds' | 'startsOn' | 'endsOn' | 'authorised' | 'evidenceDocumentId' | 'evidenceDocumentVersionId' | 'status'>>;
  actorId: string;
}): FundingWrite<AuthorisationDoc> {
  const initial = authorisationById(input.orgId, input.id);
  if (!initial) return { ok: false, code: 'NOT_FOUND', error: 'That authorisation does not exist.' };
  return withEntityLock('case-funding', `${input.orgId}:${initial.caseId}`, () => {
    const existing = authorisationById(input.orgId, input.id);
    if (!existing) return { ok: false, code: 'NOT_FOUND', error: 'That authorisation does not exist.' };
    const shape = validateAuthorisation({ ...existing, ...input.patch });
    if (!shape.value) return { ok: false, code: 'VALIDATION_ERROR', error: shape.error ?? 'The authorisation is invalid.' };
    const consumed = add(existing.committed, existing.used);
    if (shape.value.authorised.appointments < consumed.appointments || shape.value.authorised.minutes < consumed.minutes || shape.value.authorised.budgetMinor < consumed.budgetMinor) return { ok: false, code: 'CONFLICT', error: 'Authorised amounts cannot be reduced below already committed and used amounts.' };
    const duplicate = find<AuthorisationDoc>('authorisations', (row) => row.orgId === input.orgId && row.caseId === existing.caseId && row.id !== existing.id && row.externalReference.toLowerCase() === shape.value!.externalReference.toLowerCase());
    if (duplicate) return { ok: false, code: 'CONFLICT', error: 'That authorisation reference already exists on this case.' };
    try {
      const saved = commitBatch({ upserts: [{ collection: 'authorisations', doc: { ...existing, ...shape.value, updatedBy: input.actorId }, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId }] }).upserts[0] as AuthorisationDoc;
      audit({ orgId: input.orgId, actor: input.actorId, action: 'funding.authorisation_updated', target: saved.id, detail: `${existing.status} → ${saved.status}` });
      return { ok: true, value: saved };
    } catch (error) {
      if (error instanceof CommitConflictError) return { ok: false, code: 'CONFLICT', error: 'That authorisation changed. Reload before saving.' };
      throw error;
    }
  });
}

function ruleForBooking(orgId: string, caseId: string, booking: FundingBooking, on: string): { rule?: CaseServiceRuleDoc; error?: string } {
  const matches = serviceRulesForCase(orgId, caseId).filter((rule) =>
    rule.startsOn <= on && (!rule.endsOn || rule.endsOn >= on) &&
    (!rule.serviceId || rule.serviceId === booking.serviceId) &&
    (!rule.providerId || rule.providerId === booking.providerId) &&
    (!rule.locationId || rule.locationId === booking.locationId),
  ).map((rule) => ({ rule, specificity: Number(Boolean(rule.serviceId)) + Number(Boolean(rule.providerId)) + Number(Boolean(rule.locationId)) }))
    .sort((a, b) => b.specificity - a.specificity || a.rule.id.localeCompare(b.rule.id));
  if (!matches.length) return { error: 'No active case service rule matches this booking service, practitioner, location and date.' };
  if (matches.length > 1 && matches[0]!.specificity === matches[1]!.specificity) return { error: 'More than one equally specific case service rule matches this booking. Resolve the rules before allocating funding.' };
  return { rule: matches[0]!.rule };
}

function allocationVector(rule: CaseServiceRuleDoc, booking: FundingBooking): FundingVector | undefined {
  const minutes = whole(booking.durationMinutes, 1, 24 * 60);
  if (minutes === undefined) return undefined;
  const net = rule.unit === 'appointment'
    ? rule.fundedPriceMinor
    : Math.round((rule.fundedPriceMinor * minutes) / 60);
  const budgetMinor = net + Math.round((net * rule.taxRateBps) / 10_000);
  return { appointments: 1, minutes, budgetMinor };
}

function targetState(
  booking: FundingBooking,
  policy: Pick<CaseServiceRuleDoc, 'noShowPolicy' | 'lateCancelPolicy' | 'lateCancellationHours'> | Pick<FundingAllocation, 'noShowPolicy' | 'lateCancelPolicy' | 'lateCancellationHours'>,
  disposition: 'normal' | 'release',
  now: number,
): 'committed' | 'used' | undefined {
  if (disposition === 'release') return undefined;
  if (['pending', 'confirmed', 'arrived'].includes(booking.status)) return 'committed';
  if (booking.status === 'completed') return 'used';
  if (booking.status === 'no_show') return policy.noShowPolicy === 'consume' ? 'used' : undefined;
  if (booking.status === 'cancelled') {
    const start = Date.parse(booking.startsAt);
    const late = Number.isFinite(start) && start - now <= policy.lateCancellationHours * 3_600_000;
    return late && policy.lateCancelPolicy === 'consume' ? 'used' : undefined;
  }
  return undefined;
}

function breachMessages(prefix: string, consumed: FundingVector, limit: FundingVector) {
  const messages: string[] = [];
  if (limit.appointments > 0 && consumed.appointments > limit.appointments) messages.push(`${prefix} appointment allowance would be exceeded (${consumed.appointments}/${limit.appointments}).`);
  if (limit.minutes > 0 && consumed.minutes > limit.minutes) messages.push(`${prefix} minute allowance would be exceeded (${consumed.minutes}/${limit.minutes}).`);
  if (limit.budgetMinor > 0 && consumed.budgetMinor > limit.budgetMinor) messages.push(`${prefix} budget would be exceeded (${consumed.budgetMinor}/${limit.budgetMinor} minor units).`);
  return messages;
}

function warningMessages(prefix: string, consumed: FundingVector, limit: FundingVector, threshold: number) {
  const messages: string[] = [];
  const at = (used: number, allowed: number) => allowed > 0 && used * 100 >= allowed * threshold;
  if (at(consumed.appointments, limit.appointments)) messages.push(`${prefix} appointments are at ${Math.floor(consumed.appointments * 100 / limit.appointments)}%.`);
  if (at(consumed.minutes, limit.minutes)) messages.push(`${prefix} minutes are at ${Math.floor(consumed.minutes * 100 / limit.minutes)}%.`);
  if (at(consumed.budgetMinor, limit.budgetMinor)) messages.push(`${prefix} budget is at ${Math.floor(consumed.budgetMinor * 100 / limit.budgetMinor)}%.`);
  return messages;
}

function caseLimit(caseRow: CaseDoc): FundingVector {
  return {
    appointments: caseRow.limitAppointments ?? 0,
    minutes: caseRow.limitMinutes ?? 0,
    budgetMinor: caseRow.limitBudgetMinor ?? 0,
  };
}

function eventId(orgId: string, bookingId: string, sequence: number) {
  return `fne_${crypto.createHash('sha256').update(`${orgId}:${bookingId}:${sequence}`).digest('hex').slice(0, 36)}`;
}

function allocationsEqual(a: FundingAllocation | undefined, b: FundingAllocation | undefined) {
  if (!a || !b) return a === b;
  return a.state === b.state && a.caseId === b.caseId && a.periodId === b.periodId && a.serviceRuleId === b.serviceRuleId && a.authorisationId === b.authorisationId && a.coverageId === b.coverageId &&
    a.noShowPolicy === b.noShowPolicy && a.lateCancelPolicy === b.lateCancelPolicy && a.lateCancellationHours === b.lateCancellationHours &&
    sameVector(vectorFromAllocation(a), vectorFromAllocation(b));
}

function fundingInputsUnchanged(current: FundingBooking | undefined, next: FundingBooking) {
  if (!current) return false;
  return current.caseId === next.caseId && current.coverageId === next.coverageId && current.authorisationId === next.authorisationId &&
    current.startsAt === next.startsAt && current.timezone === next.timezone && current.durationMinutes === next.durationMinutes &&
    current.providerId === next.providerId && current.serviceId === next.serviceId && current.locationId === next.locationId;
}

/**
 * The sole booking/funding write command. It serialises every booking on a case,
 * then commits the booking, period snapshots, authorisation snapshots and one
 * immutable event in a single store transaction. Callers may pass a brand-new
 * booking with `expectedRevision: null` or a full next booking with the exact
 * revision they reviewed.
 */
export function commitBookingFunding(input: {
  orgId: string;
  booking: FundingBooking;
  expectedRevision: number | null;
  actorId: string;
  reason: string;
  disposition?: 'normal' | 'release';
  override?: { by: string; reason: string };
  now?: number;
}): FundingWrite<FundingBooking> {
  const lockCaseId = input.booking.caseId ?? input.booking.fundingAllocation?.caseId;
  if (!lockCaseId) {
    try {
      const saved = commitBatch({ upserts: [{ collection: 'bookings', doc: input.booking, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId }] }).upserts[0] as FundingBooking;
      return { ok: true, value: saved };
    } catch (error) {
      if (error instanceof CommitConflictError) return { ok: false, code: 'CONFLICT', error: 'That booking changed. Reload before saving.' };
      throw error;
    }
  }
  return withEntityLock('case-funding', `${input.orgId}:${lockCaseId}`, () => commitBookingFundingLocked(input));
}

function commitBookingFundingLocked(input: {
  orgId: string; booking: FundingBooking; expectedRevision: number | null; actorId: string; reason: string;
  disposition?: 'normal' | 'release'; override?: { by: string; reason: string }; now?: number;
}): FundingWrite<FundingBooking> {
  const current = input.expectedRevision === null ? undefined : get<FundingBooking>('bookings', input.booking.id);
  if (input.expectedRevision !== null && (!current || current.orgId !== input.orgId)) return { ok: false, code: 'NOT_FOUND', error: 'That booking does not exist.' };
  if (current && Number(current.revision ?? 0) !== input.expectedRevision) return { ok: false, code: 'CONFLICT', error: 'That booking changed. Reload before saving.' };
  const previous = current?.fundingAllocation;
  const caseId = input.booking.caseId;
  if (!caseId) {
    if (previous) return { ok: false, code: 'CONFLICT', error: 'Release the current funding allocation atomically before removing its case reference.' };
    return commitFundingMutation(input, current, undefined, undefined, [], []);
  }
  if (previous && previous.caseId !== caseId) {
    return { ok: false, code: 'CONFLICT', error: 'Release the existing allocation before moving this booking to another case.' };
  }
  const caseRow = caseById(input.orgId, caseId);
  if (!caseRow) return { ok: false, code: 'MISSING_FUNDING', error: 'The selected case does not exist.', missing: ['case'] };
  if (!input.booking.clientId || input.booking.clientId !== caseRow.patientId) return { ok: false, code: 'VALIDATION_ERROR', error: 'The booking client and case patient must match.' };
  const stableExisting = Boolean(previous && fundingInputsUnchanged(current, input.booking));
  let target: FundingAllocation | undefined;
  if (stableExisting && previous) {
    const state = targetState(input.booking, previous, input.disposition ?? 'normal', input.now ?? Date.now());
    target = state ? {
      ...previous,
      state,
      settledAt: state === 'used' ? (previous.settledAt ?? nowIso()) : undefined,
    } : undefined;
  } else {
    if (caseRow.status !== 'active') return { ok: false, code: 'MISSING_FUNDING', error: `Case ${caseRow.number} is ${caseRow.status}; only an active case can accept a new or changed allocation.`, missing: ['active case'] };
    const on = bookingDate(input.booking);
    if (!on) return { ok: false, code: 'VALIDATION_ERROR', error: 'The booking needs a valid start time and timezone.' };
    if (on < caseRow.startsOn || (caseRow.endsOn && on > caseRow.endsOn)) return { ok: false, code: 'MISSING_FUNDING', error: 'The booking date is outside the case dates.', missing: ['case date coverage'] };
    if (input.booking.coverageId) {
      const coverage = coverageById(input.orgId, input.booking.coverageId);
      if (!coverage || coverage.patientId !== caseRow.patientId) return { ok: false, code: 'VALIDATION_ERROR', error: 'The selected coverage does not belong to this case patient.' };
      if (caseRow.coverageId && coverage.id !== caseRow.coverageId) return { ok: false, code: 'VALIDATION_ERROR', error: 'The selected coverage does not match the case coverage.' };
      if (coverage.startsOn > on || (coverage.endsOn && coverage.endsOn < on) || coverage.verificationStatus !== 'verified') return { ok: false, code: 'MISSING_FUNDING', error: 'The selected coverage is not verified and active on the booking date.', missing: ['verified active coverage'] };
    } else if (caseRow.coverageId) {
      return { ok: false, code: 'MISSING_FUNDING', error: 'This case requires its selected coverage on the booking.', missing: ['coverageId'] };
    }
    const ruleResult = ruleForBooking(input.orgId, caseId, input.booking, on);
    if (!ruleResult.rule) return { ok: false, code: 'MISSING_FUNDING', error: ruleResult.error ?? 'No matching service rule exists.', missing: ['case service rule'] };
    const rule = ruleResult.rule;
    const state = targetState(input.booking, rule, input.disposition ?? 'normal', input.now ?? Date.now());
    if (state) {
      const period = fundingPeriodsForCase(input.orgId, caseId).find((row) => row.startsOn <= on && row.endsOn >= on);
      if (!period) return { ok: false, code: 'MISSING_FUNDING', error: 'No funding period covers the booking date.', missing: ['funding period'] };
      const vector = allocationVector(rule, input.booking);
      if (!vector) return { ok: false, code: 'VALIDATION_ERROR', error: 'The booking duration cannot be converted into funding units.' };
      let authorisation: AuthorisationDoc | undefined;
      if (rule.requiresAuthorisation) {
        if (!input.booking.authorisationId) return { ok: false, code: 'MISSING_FUNDING', error: 'This service rule requires an explicitly selected authorisation.', missing: ['authorisationId'] };
        authorisation = authorisationById(input.orgId, input.booking.authorisationId);
        if (!authorisation || authorisation.caseId !== caseId || authorisation.status !== 'active') return { ok: false, code: 'MISSING_FUNDING', error: 'The selected authorisation is not active for this case.', missing: ['active authorisation'] };
        if (authorisation.startsOn > on || authorisation.endsOn < on) return { ok: false, code: 'MISSING_FUNDING', error: 'The selected authorisation does not cover the booking date.', missing: ['authorisation date coverage'] };
        if (authorisation.serviceIds.length && (!input.booking.serviceId || !authorisation.serviceIds.includes(input.booking.serviceId))) return { ok: false, code: 'MISSING_FUNDING', error: 'The selected authorisation does not include this booking service.', missing: ['authorised service'] };
        if (authorisation.coverageId && authorisation.coverageId !== input.booking.coverageId) return { ok: false, code: 'MISSING_FUNDING', error: 'The selected authorisation belongs to a different coverage.', missing: ['matching coverage'] };
      } else if (input.booking.authorisationId) {
        authorisation = authorisationById(input.orgId, input.booking.authorisationId);
        if (!authorisation || authorisation.caseId !== caseId || authorisation.status !== 'active') return { ok: false, code: 'VALIDATION_ERROR', error: 'The selected optional authorisation is not active for this case.' };
      }
      target = {
        state, caseId, periodId: period.id, serviceRuleId: rule.id,
        authorisationId: authorisation?.id,
        coverageId: input.booking.coverageId,
        trackingMode: caseRow.trackingMode,
        noShowPolicy: rule.noShowPolicy,
        lateCancelPolicy: rule.lateCancelPolicy,
        lateCancellationHours: rule.lateCancellationHours,
        ...vector, currency: 'GBP',
        allocatedAt: previous?.allocatedAt ?? nowIso(),
        ...(state === 'used' ? { settledAt: nowIso() } : {}),
      };
    }
  }
  if (previous?.state === 'used' && target && (previous.caseId !== target.caseId || previous.periodId !== target.periodId || !sameVector(vectorFromAllocation(previous), vectorFromAllocation(target))) && !input.override) {
    return { ok: false, code: 'CONFLICT', error: 'Reallocating used funding requires an authorised override and immutable reason.' };
  }
  if (input.override && !plainText(input.override.reason, 500)) return { ok: false, code: 'VALIDATION_ERROR', error: 'A funding override requires a plain-text reason of at most 500 characters.' };

  const periodDeltas = new Map<string, { committed: FundingVector; used: FundingVector }>();
  const authDeltas = new Map<string, { committed: FundingVector; used: FundingVector }>();
  const applyDelta = (map: Map<string, { committed: FundingVector; used: FundingVector }>, id: string, stateName: FundingAllocation['state'], vector: FundingVector) => {
    const entry = map.get(id) ?? { committed: ZERO(), used: ZERO() };
    entry[stateName] = add(entry[stateName], vector);
    map.set(id, entry);
  };
  if (previous) {
    applyDelta(periodDeltas, previous.periodId, previous.state, negate(vectorFromAllocation(previous)));
    if (previous.authorisationId) applyDelta(authDeltas, previous.authorisationId, previous.state, negate(vectorFromAllocation(previous)));
  }
  if (target) {
    applyDelta(periodDeltas, target.periodId, target.state, vectorFromAllocation(target));
    if (target.authorisationId) applyDelta(authDeltas, target.authorisationId, target.state, vectorFromAllocation(target));
  }
  if (allocationsEqual(previous, target)) {
    periodDeltas.clear();
    authDeltas.clear();
  }

  const nextPeriods = new Map<string, FundingPeriodDoc>();
  const nextAuthorisations = new Map<string, AuthorisationDoc>();
  const breaches: string[] = [];
  const warnings: string[] = [];
  for (const [id, delta] of periodDeltas) {
    const row = fundingPeriodById(input.orgId, id);
    if (!row || row.caseId !== caseId) return { ok: false, code: 'CONFLICT', error: 'A referenced funding period is missing or belongs to another case.' };
    const next = { ...row, committed: add(row.committed, delta.committed), used: add(row.used, delta.used), updatedBy: input.actorId };
    if (!validVector(next.committed) || !validVector(next.used)) return { ok: false, code: 'CONFLICT', error: 'Funding snapshots would become negative; reconcile the immutable event trail before retrying.' };
    const consumed = add(next.committed, next.used);
    const capacity = add(next.allowed, next.rollover);
    breaches.push(...breachMessages(`Funding period ${next.startsOn}–${next.endsOn}`, consumed, capacity));
    warnings.push(...warningMessages(`Funding period ${next.startsOn}–${next.endsOn}`, consumed, capacity, caseRow.warningThresholdPct));
    nextPeriods.set(id, next);
  }
  for (const [id, delta] of authDeltas) {
    const row = authorisationById(input.orgId, id);
    if (!row) return { ok: false, code: 'CONFLICT', error: 'A referenced authorisation is missing.' };
    const next = { ...row, committed: add(row.committed, delta.committed), used: add(row.used, delta.used), updatedBy: input.actorId };
    if (!validVector(next.committed) || !validVector(next.used)) return { ok: false, code: 'CONFLICT', error: 'Authorisation snapshots would become negative; reconcile the immutable event trail before retrying.' };
    const consumed = add(next.committed, next.used);
    breaches.push(...breachMessages(`Authorisation ${next.externalReference}`, consumed, next.authorised));
    warnings.push(...warningMessages(`Authorisation ${next.externalReference}`, consumed, next.authorised, caseRow.warningThresholdPct));
    nextAuthorisations.set(id, next);
  }
  const allPeriods = fundingPeriodsForCase(input.orgId, caseId).map((row) => nextPeriods.get(row.id) ?? row);
  const caseConsumed = allPeriods.reduce((sum, row) => add(sum, add(row.committed, row.used)), ZERO());
  breaches.push(...breachMessages(`Case ${caseRow.number}`, caseConsumed, caseLimit(caseRow)));
  warnings.push(...warningMessages(`Case ${caseRow.number}`, caseConsumed, caseLimit(caseRow), caseRow.warningThresholdPct));
  const uniqueBreaches = [...new Set(breaches)];
  const uniqueWarnings = [...new Set(warnings)];
  if (uniqueBreaches.length && caseRow.limitPolicy === 'block' && caseRow.enforcementMode === 'enforced' && !input.override) {
    return { ok: false, code: 'LIMIT_EXCEEDED', error: uniqueBreaches.join(' '), breaches: uniqueBreaches };
  }
  return commitFundingMutation(input, current, target, caseRow, [...nextPeriods.values()], [...nextAuthorisations.values()], uniqueBreaches, uniqueWarnings, periodDeltas, authDeltas);
}

function commitFundingMutation(
  input: { orgId: string; booking: FundingBooking; expectedRevision: number | null; actorId: string; reason: string; override?: { by: string; reason: string } },
  current: FundingBooking | undefined,
  target: FundingAllocation | undefined,
  caseRow: CaseDoc | undefined,
  periods: FundingPeriodDoc[],
  authorisations: AuthorisationDoc[],
  breaches: string[] = [],
  warnings: string[] = [],
  periodDeltas = new Map<string, { committed: FundingVector; used: FundingVector }>(),
  authDeltas = new Map<string, { committed: FundingVector; used: FundingVector }>(),
): FundingWrite<FundingBooking> {
  const previous = current?.fundingAllocation;
  const changed = !allocationsEqual(previous, target);
  const sequence = Number(current?.fundingSequence ?? 0) + (changed ? 1 : 0);
  const booking: FundingBooking = {
    ...input.booking,
    fundingAllocation: target,
    fundingPeriodId: target?.periodId,
    serviceRuleId: target?.serviceRuleId,
    authorisationId: target?.authorisationId ?? input.booking.authorisationId,
    fundingSequence: sequence,
    fundingWarning: warnings.length || breaches.length ? [...breaches, ...warnings].join(' ') : undefined,
  };
  const upserts: BatchUpsert[] = [{ collection: 'bookings', doc: booking, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId }];
  for (const period of periods) upserts.push({ collection: 'fundingPeriods', doc: period, expectedRevision: Number(period.revision ?? 0), expectedOrgId: input.orgId });
  for (const authorisation of authorisations) upserts.push({ collection: 'authorisations', doc: authorisation, expectedRevision: Number(authorisation.revision ?? 0), expectedOrgId: input.orgId });
  let eventDraft: FundingEventDoc | undefined;
  if (changed && caseRow) {
    const type: FundingEventDoc['type'] = input.override
      ? 'override'
      : !previous && target?.state === 'committed' ? 'commit'
        : !previous && target?.state === 'used' ? 'spend'
          : previous && !target ? 'reverse'
            : previous?.state === 'committed' && target?.state === 'used' ? 'spend'
              : previous?.state === 'used' && target?.state === 'committed' ? 'reverse'
                : 'reallocate';
    eventDraft = {
      id: eventId(input.orgId, booking.id, sequence), orgId: input.orgId, bookingId: booking.id,
      patientId: caseRow.patientId, caseId: caseRow.id, periodId: target?.periodId ?? previous?.periodId,
      serviceRuleId: target?.serviceRuleId ?? previous?.serviceRuleId,
      authorisationId: target?.authorisationId ?? previous?.authorisationId,
      sequence, type, previousAllocation: previous, allocation: target,
      periodDeltas: [...periodDeltas].map(([periodId, delta]) => ({ periodId, ...delta })),
      authorisationDeltas: [...authDeltas].map(([authorisationId, delta]) => ({ authorisationId, ...delta })),
      breaches, override: input.override, actorId: input.actorId,
      reason: plainText(input.reason, 500) ?? 'booking funding lifecycle', occurredAt: nowIso(), revision: 0,
    };
    upserts.push({ collection: 'fundingEvents', doc: eventDraft, expectedRevision: null, expectedOrgId: input.orgId });
  }
  try {
    const result = commitBatch({ upserts });
    const saved = result.upserts[0] as FundingBooking;
    const event = eventDraft ? result.upserts[result.upserts.length - 1] as FundingEventDoc : undefined;
    if (event) audit({ orgId: input.orgId, actor: input.actorId, action: `funding.${event.type}`, target: booking.id, detail: `${caseRow?.number ?? event.caseId}; event ${event.id}; ${input.reason}` });
    return { ok: true, value: saved, event, warnings: [...breaches, ...warnings] };
  } catch (error) {
    if (error instanceof CommitConflictError) return { ok: false, code: 'CONFLICT', error: 'The booking or funding balance changed. Reload before retrying.' };
    throw error;
  }
}
