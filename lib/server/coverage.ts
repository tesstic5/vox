import { audit } from './audit';
import { clientById } from './clients';
import { CommitConflictError, commitBatch, find, get, list, newId, nowIso, type Doc } from './db';
import { openSecret, sealSecret, type Sealed } from './secrets';

export type PayerDoc = Doc & {
  orgId: string;
  type: 'individual' | 'organisation' | 'insurer';
  name: string;
  invoiceEmail?: string;
  invoicePhone?: string;
  billingAddress?: string;
  identifier?: string;
  createdBy: string;
  updatedBy: string;
  archivedAt?: string;
  archivedBy?: string;
  revision: number;
};

export type CoverageSensitive = {
  membershipNumber?: string;
  policyNumber?: string;
};

export type ClientCoverageDoc = Doc & {
  orgId: string;
  patientId: string;
  payerId: string;
  holderRelationship: 'self' | 'parent' | 'partner' | 'guardian' | 'other';
  startsOn: string;
  endsOn?: string;
  verificationStatus: 'unverified' | 'pending' | 'verified' | 'rejected' | 'expired';
  verifiedAt?: string;
  verifiedBy?: string;
  verificationNote?: string;
  membershipMasked?: string;
  policyMasked?: string;
  sensitiveSealed?: Sealed;
  createdBy: string;
  updatedBy: string;
  revision: number;
};

export type CoverageView = Omit<ClientCoverageDoc, 'sensitiveSealed'> & {
  sensitive?: CoverageSensitive;
};

export type CoverageWrite<T> =
  | { ok: true; value: T }
  | { ok: false; code: 'NOT_FOUND' | 'VALIDATION_ERROR' | 'CONFLICT'; error: string };

const plainText = (value: unknown, max: number) => {
  const text = String(value ?? '').trim();
  return text && text.length <= max && !/[<>\u0000-\u001f]/.test(text) ? text : undefined;
};
const optionalText = (value: unknown, max: number) => {
  if (value === undefined || value === null || value === '') return undefined;
  return plainText(value, max);
};
const email = (value: unknown) => {
  const text = String(value ?? '').trim().toLowerCase();
  return !text ? undefined : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) && text.length <= 254 ? text : null;
};
const isoDate = (value: unknown) => {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text ? text : undefined;
};

function masked(value: string | undefined) {
  if (!value) return undefined;
  return value.length <= 4 ? '••••' : `••••${value.slice(-4)}`;
}

function normaliseSensitive(value: CoverageSensitive | undefined | null): { value?: CoverageSensitive; error?: string } {
  if (value === undefined || value === null) return { value: undefined };
  const membershipNumber = optionalText(value.membershipNumber, 160);
  const policyNumber = optionalText(value.policyNumber, 160);
  if ((value.membershipNumber && !membershipNumber) || (value.policyNumber && !policyNumber)) {
    return { error: 'Membership and policy values must be plain text of at most 160 characters.' };
  }
  if (!membershipNumber && !policyNumber) return { value: undefined };
  return { value: { membershipNumber, policyNumber } };
}

function decodeSensitive(row: ClientCoverageDoc): CoverageSensitive | undefined {
  if (!row.sensitiveSealed) return undefined;
  const opened = openSecret(row.sensitiveSealed);
  if (!opened) return undefined;
  try {
    const parsed = JSON.parse(opened) as CoverageSensitive;
    return normaliseSensitive(parsed).value;
  } catch {
    return undefined;
  }
}

export function coverageView(row: ClientCoverageDoc, revealSensitive = false): CoverageView {
  const { sensitiveSealed: _sealed, ...safe } = row;
  return { ...safe, ...(revealSensitive ? { sensitive: decodeSensitive(row) } : {}) };
}

export function payerById(orgId: string, id: string): PayerDoc | undefined {
  const row = get<PayerDoc>('payers', id);
  return row && row.orgId === orgId ? row : undefined;
}

export function payersFor(orgId: string, includeArchived = false) {
  return list<PayerDoc>('payers', (row) => row.orgId === orgId && (includeArchived || !row.archivedAt))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function coverageById(orgId: string, id: string): ClientCoverageDoc | undefined {
  const row = get<ClientCoverageDoc>('clientCoverages', id);
  return row && row.orgId === orgId ? row : undefined;
}

export function coveragesForPatient(orgId: string, patientId: string, includeExpired = true) {
  return list<ClientCoverageDoc>('clientCoverages', (row) =>
    row.orgId === orgId && row.patientId === patientId && (includeExpired || row.verificationStatus !== 'expired'),
  ).sort((a, b) => b.startsOn.localeCompare(a.startsOn) || a.id.localeCompare(b.id));
}

function payerShape(input: Partial<PayerDoc>) {
  const type = String(input.type ?? '');
  const name = plainText(input.name, 160);
  const invoiceEmail = email(input.invoiceEmail);
  const invoicePhone = optionalText(input.invoicePhone, 60);
  const billingAddress = optionalText(input.billingAddress, 500);
  const identifier = optionalText(input.identifier, 120);
  if (!['individual', 'organisation', 'insurer'].includes(type)) return { error: 'Payer type must be individual, organisation or insurer.' } as const;
  if (!name) return { error: 'A payer needs a plain-text name of at most 160 characters.' } as const;
  if (invoiceEmail === null) return { error: 'The payer invoice email is invalid.' } as const;
  if ((input.invoicePhone && !invoicePhone) || (input.billingAddress && !billingAddress) || (input.identifier && !identifier)) {
    return { error: 'Payer contact and identifier fields contain invalid text.' } as const;
  }
  return { value: { type: type as PayerDoc['type'], name, invoiceEmail, invoicePhone, billingAddress, identifier } } as const;
}

export function createPayer(input: {
  orgId: string;
  type: PayerDoc['type'];
  name: string;
  invoiceEmail?: string;
  invoicePhone?: string;
  billingAddress?: string;
  identifier?: string;
  actorId: string;
}): CoverageWrite<PayerDoc> {
  const shape = payerShape(input);
  if (!shape.value) return { ok: false, code: 'VALIDATION_ERROR', error: shape.error };
  const duplicate = find<PayerDoc>('payers', (row) => row.orgId === input.orgId && !row.archivedAt && row.name.toLowerCase() === shape.value.name.toLowerCase());
  if (duplicate) return { ok: false, code: 'CONFLICT', error: 'An active payer with that name already exists.' };
  const draft: PayerDoc = {
    id: newId('pay_'), orgId: input.orgId, ...shape.value,
    createdBy: input.actorId, updatedBy: input.actorId, revision: 0,
  };
  const saved = commitBatch({ upserts: [{ collection: 'payers', doc: draft, expectedRevision: null, expectedOrgId: input.orgId }] }).upserts[0] as PayerDoc;
  audit({ orgId: input.orgId, actor: input.actorId, action: 'payer.created', target: saved.id, detail: `${saved.type}; ${saved.name}` });
  return { ok: true, value: saved };
}

export function updatePayer(input: {
  orgId: string;
  id: string;
  expectedRevision: number;
  patch: Partial<Pick<PayerDoc, 'type' | 'name' | 'invoiceEmail' | 'invoicePhone' | 'billingAddress' | 'identifier'>>;
  actorId: string;
}): CoverageWrite<PayerDoc> {
  const existing = payerById(input.orgId, input.id);
  if (!existing) return { ok: false, code: 'NOT_FOUND', error: 'That payer does not exist.' };
  if (existing.archivedAt) return { ok: false, code: 'CONFLICT', error: 'An archived payer cannot be edited.' };
  const shape = payerShape({ ...existing, ...input.patch });
  if (!shape.value) return { ok: false, code: 'VALIDATION_ERROR', error: shape.error };
  const duplicate = find<PayerDoc>('payers', (row) => row.orgId === input.orgId && row.id !== existing.id && !row.archivedAt && row.name.toLowerCase() === shape.value.name.toLowerCase());
  if (duplicate) return { ok: false, code: 'CONFLICT', error: 'An active payer with that name already exists.' };
  try {
    const saved = commitBatch({ upserts: [{ collection: 'payers', doc: { ...existing, ...shape.value, updatedBy: input.actorId }, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId }] }).upserts[0] as PayerDoc;
    audit({ orgId: input.orgId, actor: input.actorId, action: 'payer.updated', target: saved.id, detail: saved.name });
    return { ok: true, value: saved };
  } catch (error) {
    if (error instanceof CommitConflictError) return { ok: false, code: 'CONFLICT', error: 'That payer changed. Reload before saving.' };
    throw error;
  }
}

export function archivePayer(input: { orgId: string; id: string; expectedRevision: number; actorId: string }): CoverageWrite<PayerDoc> {
  const existing = payerById(input.orgId, input.id);
  if (!existing) return { ok: false, code: 'NOT_FOUND', error: 'That payer does not exist.' };
  if (existing.archivedAt) return { ok: true, value: existing };
  if (find<ClientCoverageDoc>('clientCoverages', (row) => row.orgId === input.orgId && row.payerId === existing.id && row.verificationStatus !== 'expired')) {
    return { ok: false, code: 'CONFLICT', error: 'Expire active client coverages before archiving this payer.' };
  }
  try {
    const saved = commitBatch({ upserts: [{ collection: 'payers', doc: { ...existing, archivedAt: nowIso(), archivedBy: input.actorId, updatedBy: input.actorId }, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId }] }).upserts[0] as PayerDoc;
    audit({ orgId: input.orgId, actor: input.actorId, action: 'payer.archived', target: saved.id, detail: saved.name });
    return { ok: true, value: saved };
  } catch (error) {
    if (error instanceof CommitConflictError) return { ok: false, code: 'CONFLICT', error: 'That payer changed. Reload before archiving.' };
    throw error;
  }
}

function coverageShape(input: {
  holderRelationship: unknown;
  startsOn: unknown;
  endsOn?: unknown;
  verificationStatus?: unknown;
  verificationNote?: unknown;
}) {
  const holderRelationship = String(input.holderRelationship ?? '');
  const startsOn = isoDate(input.startsOn);
  const endsOn = input.endsOn ? isoDate(input.endsOn) : undefined;
  const verificationStatus = String(input.verificationStatus ?? 'unverified');
  const verificationNote = optionalText(input.verificationNote, 500);
  if (!['self', 'parent', 'partner', 'guardian', 'other'].includes(holderRelationship)) return { error: 'Holder relationship is invalid.' } as const;
  if (!startsOn || (input.endsOn && !endsOn) || (endsOn && endsOn < startsOn)) return { error: 'Coverage dates must be a valid inclusive ISO-date range.' } as const;
  if (!['unverified', 'pending', 'verified', 'rejected', 'expired'].includes(verificationStatus)) return { error: 'Coverage verification status is invalid.' } as const;
  if (input.verificationNote && !verificationNote) return { error: 'Verification note must be plain text of at most 500 characters.' } as const;
  return { value: { holderRelationship: holderRelationship as ClientCoverageDoc['holderRelationship'], startsOn, endsOn, verificationStatus: verificationStatus as ClientCoverageDoc['verificationStatus'], verificationNote } } as const;
}

export function createCoverage(input: {
  orgId: string;
  patientId: string;
  payerId: string;
  holderRelationship: ClientCoverageDoc['holderRelationship'];
  startsOn: string;
  endsOn?: string;
  verificationStatus?: ClientCoverageDoc['verificationStatus'];
  verificationNote?: string;
  sensitive?: CoverageSensitive;
  actorId: string;
}): CoverageWrite<ClientCoverageDoc> {
  const client = clientById(input.orgId, input.patientId);
  if (!client || client.archivedAt) return { ok: false, code: 'VALIDATION_ERROR', error: 'The coverage patient does not exist or is archived.' };
  const payer = payerById(input.orgId, input.payerId);
  if (!payer || payer.archivedAt) return { ok: false, code: 'VALIDATION_ERROR', error: 'The selected payer does not exist or is archived.' };
  const shape = coverageShape(input);
  if (!shape.value) return { ok: false, code: 'VALIDATION_ERROR', error: shape.error };
  const sensitive = normaliseSensitive(input.sensitive);
  if (sensitive.error) return { ok: false, code: 'VALIDATION_ERROR', error: sensitive.error };
  const at = nowIso();
  const draft: ClientCoverageDoc = {
    id: newId('cov_'), orgId: input.orgId, patientId: input.patientId, payerId: input.payerId,
    ...shape.value,
    membershipMasked: masked(sensitive.value?.membershipNumber),
    policyMasked: masked(sensitive.value?.policyNumber),
    sensitiveSealed: sensitive.value ? sealSecret(JSON.stringify(sensitive.value)) : undefined,
    ...(shape.value.verificationStatus === 'verified' ? { verifiedAt: at, verifiedBy: input.actorId } : {}),
    createdBy: input.actorId, updatedBy: input.actorId, revision: 0,
  };
  const saved = commitBatch({ upserts: [{ collection: 'clientCoverages', doc: draft, expectedRevision: null, expectedOrgId: input.orgId }] }).upserts[0] as ClientCoverageDoc;
  audit({ orgId: input.orgId, actor: input.actorId, action: 'coverage.created', target: saved.id, detail: `${saved.patientId}; ${saved.payerId}; ${saved.verificationStatus}` });
  return { ok: true, value: saved };
}

export function updateCoverage(input: {
  orgId: string;
  id: string;
  expectedRevision: number;
  patch: Partial<Pick<ClientCoverageDoc, 'payerId' | 'holderRelationship' | 'startsOn' | 'endsOn' | 'verificationStatus' | 'verificationNote'>>;
  sensitive?: CoverageSensitive | null;
  actorId: string;
}): CoverageWrite<ClientCoverageDoc> {
  const existing = coverageById(input.orgId, input.id);
  if (!existing) return { ok: false, code: 'NOT_FOUND', error: 'That coverage does not exist.' };
  const merged = { ...existing, ...input.patch };
  const payer = payerById(input.orgId, merged.payerId);
  if (!payer || payer.archivedAt) return { ok: false, code: 'VALIDATION_ERROR', error: 'The selected payer does not exist or is archived.' };
  const shape = coverageShape(merged);
  if (!shape.value) return { ok: false, code: 'VALIDATION_ERROR', error: shape.error };
  const sensitive = input.sensitive === undefined ? { value: decodeSensitive(existing) } : normaliseSensitive(input.sensitive);
  if (sensitive.error) return { ok: false, code: 'VALIDATION_ERROR', error: sensitive.error };
  const wasVerified = existing.verificationStatus === 'verified';
  const isVerified = shape.value.verificationStatus === 'verified';
  const next: ClientCoverageDoc = {
    ...existing,
    payerId: merged.payerId,
    ...shape.value,
    membershipMasked: masked(sensitive.value?.membershipNumber),
    policyMasked: masked(sensitive.value?.policyNumber),
    sensitiveSealed: sensitive.value ? sealSecret(JSON.stringify(sensitive.value)) : undefined,
    verifiedAt: isVerified ? (wasVerified ? existing.verifiedAt : nowIso()) : undefined,
    verifiedBy: isVerified ? (wasVerified ? existing.verifiedBy : input.actorId) : undefined,
    updatedBy: input.actorId,
  };
  try {
    const saved = commitBatch({ upserts: [{ collection: 'clientCoverages', doc: next, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId }] }).upserts[0] as ClientCoverageDoc;
    audit({ orgId: input.orgId, actor: input.actorId, action: 'coverage.updated', target: saved.id, detail: `${existing.verificationStatus} → ${saved.verificationStatus}` });
    return { ok: true, value: saved };
  } catch (error) {
    if (error instanceof CommitConflictError) return { ok: false, code: 'CONFLICT', error: 'That coverage changed. Reload before saving.' };
    throw error;
  }
}
