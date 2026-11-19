/** Exact, reviewable patient identity matching. No fuzzy or silent merge. */

import crypto from 'node:crypto';
import { commitBatch, find, list, nowIso, withEntityLock, type Doc } from './db';

export type ContactKind = 'phone' | 'email';
export type ContactLabel = 'mobile' | 'home' | 'work' | 'guardian' | 'other';

export type PatientContactPointDoc = Doc & {
  orgId: string;
  patientId: string;
  kind: ContactKind;
  label: ContactLabel;
  value: string;
  normalizedValue: string;
  primary: boolean;
  verified: boolean;
  verifiedAt?: string;
  source: 'legacy' | 'staff' | 'patient' | 'import' | 'integration';
  validFrom: string;
  endedAt?: string;
  shared?: boolean;
  sharedReason?: string;
  revision: number;
};

export type IdentityConflictDoc = Doc & {
  orgId: string;
  kind: ContactKind;
  normalizedValue: string;
  candidatePatientIds: string[];
  status: 'open' | 'resolved' | 'shared' | 'dismissed';
  source: string;
  selectedPatientId?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolutionNote?: string;
  revision: number;
};

export type ClientMergeEventDoc = Doc & {
  orgId: string;
  conflictId: string;
  survivorPatientId: string;
  sourcePatientId: string;
  fieldDecisions: Record<string, 'survivor' | 'source' | 'combined'>;
  rehomed: Record<string, number>;
  actor: string;
  occurredAt: string;
  revision: number;
};

type LegacyPatient = Doc & {
  orgId?: string;
  number?: string;
  email?: string;
  archivedAt?: string;
  revision?: number;
};

export function normalizeContact(kind: ContactKind, value: string): string {
  if (kind === 'email') return String(value ?? '').trim().toLowerCase();
  const raw = String(value ?? '').trim();
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  // Preserve a supplied international prefix. Historic local numbers remain
  // exact local values rather than guessing a country and linking the wrong file.
  return raw.startsWith('+') ? `+${digits}` : digits;
}

function deterministicContactId(orgId: string, patientId: string, kind: ContactKind, normalized: string) {
  return `pcp_${crypto.createHash('sha256').update(`${orgId}:${patientId}:${kind}:${normalized}`).digest('hex').slice(0, 40)}`;
}

function conflictId(orgId: string, kind: ContactKind, normalized: string) {
  return `icf_${crypto.createHash('sha256').update(`${orgId}:${kind}:${normalized}`).digest('hex').slice(0, 40)}`;
}

export function legacyContactDrafts(input: {
  orgId: string;
  patientId: string;
  number?: string;
  email?: string;
  source?: PatientContactPointDoc['source'];
  at?: string;
}): PatientContactPointDoc[] {
  const at = input.at ?? nowIso();
  const values: Array<{ kind: ContactKind; value: string; label: ContactLabel }> = [
    { kind: 'phone', value: String(input.number ?? ''), label: 'mobile' },
    { kind: 'email', value: String(input.email ?? ''), label: 'other' },
  ];
  return values.flatMap(({ kind, value, label }) => {
    const normalizedValue = normalizeContact(kind, value);
    if (!normalizedValue) return [];
    return [{
      id: deterministicContactId(input.orgId, input.patientId, kind, normalizedValue),
      orgId: input.orgId,
      patientId: input.patientId,
      kind,
      label,
      value: value.trim(),
      normalizedValue,
      primary: true,
      verified: false,
      source: input.source ?? 'legacy',
      validFrom: at,
      createdAt: at,
      revision: 0,
    } as PatientContactPointDoc];
  });
}

/** Honest compatibility migration: contact metadata only; verification is never invented. */
export function migrateLegacyContactPoints(orgId: string, options: { patientId?: string; limit?: number } = {}) {
  const markerId = `idm_${crypto.createHash('sha256').update(orgId).digest('hex').slice(0, 32)}`;
  if (!options.patientId) {
    const marker = find<Doc & { orgId?: string; completedAt?: string }>('identityMigrationMarkers', (row) => row.id === markerId && row.orgId === orgId);
    if (marker?.completedAt) return { patients: 0, inserted: 0, existing: 0, conflicts: 0, alreadyComplete: true };
  }
  const patients = list<LegacyPatient>(
    'clients',
    (patient) => patient.orgId === orgId && (!options.patientId || patient.id === options.patientId),
  ).slice(0, Math.max(1, Math.min(10_000, options.limit ?? 10_000)));
  let inserted = 0;
  let existing = 0;
  for (const patient of patients) {
    for (const draft of legacyContactDrafts({
      orgId,
      patientId: patient.id,
      number: patient.number,
      email: patient.email,
      source: 'legacy',
      at: String(patient.createdAt ?? nowIso()),
    })) {
      const alreadyRepresented = find<PatientContactPointDoc>(
        'patientContactPoints',
        (row) => row.orgId === orgId && row.patientId === patient.id && !row.endedAt &&
          (row.id === draft.id || (row.kind === draft.kind && row.normalizedValue === draft.normalizedValue)),
      );
      if (alreadyRepresented) {
        existing += 1;
        continue;
      }
      const hasPrimary = find<PatientContactPointDoc>(
        'patientContactPoints',
        (row) => row.orgId === orgId && row.patientId === patient.id && row.kind === draft.kind && row.primary && !row.endedAt,
      );
      const compatibleDraft = hasPrimary ? { ...draft, primary: false } : draft;
      try {
        commitBatch({ upserts: [{ collection: 'patientContactPoints', doc: compatibleDraft, expectedRevision: null, expectedOrgId: orgId }] });
        inserted += 1;
      } catch (error) {
        if (error instanceof Error && error.name === 'CommitConflictError') existing += 1;
        else throw error;
      }
    }
  }
  const conflicts = createExactConflicts(orgId);
  if (!options.patientId) {
    try {
      commitBatch({
        upserts: [{
          collection: 'identityMigrationMarkers',
          doc: { id: markerId, orgId, version: 1, completedAt: nowIso(), patients: patients.length, inserted } as Doc,
          expectedRevision: null,
          expectedOrgId: orgId,
        }],
      });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'CommitConflictError') throw error;
    }
  }
  return { patients: patients.length, inserted, existing, conflicts, alreadyComplete: false };
}

export function contactPointsFor(orgId: string, patientId: string, options: { includeEnded?: boolean } = {}): PatientContactPointDoc[] {
  migrateLegacyContactPoints(orgId, { patientId });
  return list<PatientContactPointDoc>(
    'patientContactPoints',
    (point) => point.orgId === orgId && point.patientId === patientId && (options.includeEnded || !point.endedAt),
  ).sort((a, b) => Number(b.primary) - Number(a.primary) || a.kind.localeCompare(b.kind) || a.createdAt!.localeCompare(b.createdAt!));
}

function candidatesFor(orgId: string, kind: ContactKind, normalizedValue: string): string[] {
  return [...new Set(
    list<PatientContactPointDoc>(
      'patientContactPoints',
      (point) => point.orgId === orgId && point.kind === kind && point.normalizedValue === normalizedValue && !point.endedAt,
    ).map((point) => point.patientId),
  )].sort();
}

function ensureConflict(orgId: string, kind: ContactKind, normalizedValue: string, candidatePatientIds: string[], source: string) {
  if (candidatePatientIds.length < 2) return undefined;
  const id = conflictId(orgId, kind, normalizedValue);
  const existing = find<IdentityConflictDoc>('identityConflicts', (row) => row.id === id && row.orgId === orgId);
  if (existing && existing.status === 'open' && JSON.stringify(existing.candidatePatientIds) === JSON.stringify(candidatePatientIds)) return existing;
  const draft = {
    ...(existing ?? {}),
    id,
    orgId,
    kind,
    normalizedValue,
    candidatePatientIds,
    status: 'open',
    source,
    selectedPatientId: undefined,
    resolvedAt: undefined,
    resolvedBy: undefined,
    createdAt: existing?.createdAt ?? nowIso(),
  } as IdentityConflictDoc;
  try {
    return commitBatch({
      upserts: [{
        collection: 'identityConflicts',
        doc: draft,
        expectedRevision: existing ? Number(existing.revision ?? 0) : null,
        expectedOrgId: orgId,
      }],
    }).upserts[0] as IdentityConflictDoc;
  } catch (error) {
    if (error instanceof Error && error.name === 'CommitConflictError') {
      return find<IdentityConflictDoc>('identityConflicts', (row) => row.id === id && row.orgId === orgId);
    }
    throw error;
  }
}

export function createExactConflicts(orgId: string): number {
  const groups = new Map<string, Set<string>>();
  for (const point of list<PatientContactPointDoc>('patientContactPoints', (row) => row.orgId === orgId && !row.endedAt)) {
    const key = `${point.kind}\u0000${point.normalizedValue}`;
    const ids = groups.get(key) ?? new Set<string>();
    ids.add(point.patientId);
    groups.set(key, ids);
  }
  let created = 0;
  for (const [key, ids] of groups) {
    if (ids.size < 2) continue;
    const [kind, normalized] = key.split('\u0000') as [ContactKind, string];
    if (ensureConflict(orgId, kind, normalized, [...ids].sort(), 'legacy-migration')) created += 1;
  }
  return created;
}

export type ExactIdentityResult =
  | { status: 'none'; kind: ContactKind; normalizedValue: string; candidatePatientIds: [] }
  | { status: 'unique'; kind: ContactKind; normalizedValue: string; patientId: string; candidatePatientIds: [string] }
  | { status: 'ambiguous'; kind: ContactKind; normalizedValue: string; candidatePatientIds: string[]; conflict: IdentityConflictDoc };

export function resolveExactIdentity(orgId: string, kind: ContactKind, value: string): ExactIdentityResult {
  const normalizedValue = normalizeContact(kind, value);
  if (!normalizedValue) return { status: 'none', kind, normalizedValue, candidatePatientIds: [] };
  migrateLegacyContactPoints(orgId);
  const candidatePatientIds = candidatesFor(orgId, kind, normalizedValue);
  if (!candidatePatientIds.length) return { status: 'none', kind, normalizedValue, candidatePatientIds: [] };
  if (candidatePatientIds.length === 1) {
    return { status: 'unique', kind, normalizedValue, patientId: candidatePatientIds[0], candidatePatientIds: [candidatePatientIds[0]] };
  }
  const conflict = ensureConflict(orgId, kind, normalizedValue, candidatePatientIds, 'exact-match')!;
  return { status: 'ambiguous', kind, normalizedValue, candidatePatientIds, conflict };
}

type AddPatientContactPointInput = {
  orgId: string;
  patientId: string;
  kind: ContactKind;
  label?: ContactLabel;
  value: string;
  primary?: boolean;
  verified?: boolean;
  source?: PatientContactPointDoc['source'];
  allowShared?: boolean;
  sharedReason?: string;
};

export function addPatientContactPoint(input: AddPatientContactPointInput): PatientContactPointDoc {
  const normalizedValue = normalizeContact(input.kind, input.value);
  if (!normalizedValue) throw new Error(`a valid ${input.kind} value is required`);
  return withEntityLock('patient-contact', `${input.orgId}:${input.kind}:${normalizedValue}`, () => addPatientContactPointLocked(input, normalizedValue));
}

function addPatientContactPointLocked(input: AddPatientContactPointInput, normalizedValue: string): PatientContactPointDoc {
  const patient = find<LegacyPatient>('clients', (row) => row.id === input.patientId && row.orgId === input.orgId);
  if (!patient) throw new Error('patient not found');
  migrateLegacyContactPoints(input.orgId, { patientId: input.patientId });
  const samePatient = list<PatientContactPointDoc>(
    'patientContactPoints',
    (point) => point.orgId === input.orgId && point.patientId === input.patientId && point.kind === input.kind && point.normalizedValue === normalizedValue && !point.endedAt,
  )[0];
  if (samePatient) return samePatient;
  const otherPatients = candidatesFor(input.orgId, input.kind, normalizedValue).filter((id) => id !== input.patientId);
  if (otherPatients.length && !input.allowShared) {
    ensureConflict(input.orgId, input.kind, normalizedValue, [...otherPatients, input.patientId].sort(), 'contact-add');
    throw new Error('that exact contact value is already linked to another patient; review the identity conflict or mark it as a shared contact');
  }
  if (input.allowShared && !String(input.sharedReason ?? '').trim()) throw new Error('a reason is required for a shared contact');
  const at = nowIso();
  const draft = {
    id: deterministicContactId(input.orgId, input.patientId, input.kind, normalizedValue),
    orgId: input.orgId,
    patientId: input.patientId,
    kind: input.kind,
    label: input.label ?? (input.kind === 'phone' ? 'mobile' : 'other'),
    value: input.value.trim(),
    normalizedValue,
    primary: input.primary !== false,
    verified: Boolean(input.verified),
    verifiedAt: input.verified ? at : undefined,
    source: input.source ?? 'staff',
    validFrom: at,
    shared: Boolean(input.allowShared),
    sharedReason: input.allowShared ? input.sharedReason!.trim().slice(0, 500) : undefined,
    createdAt: at,
  } as PatientContactPointDoc;

  const upserts: Array<{ collection: string; doc: Doc; expectedRevision?: number | null; expectedOrgId: string }> = [];
  if (draft.primary) {
    for (const point of list<PatientContactPointDoc>(
      'patientContactPoints',
      (row) => row.orgId === input.orgId && row.patientId === input.patientId && row.kind === input.kind && row.primary && !row.endedAt,
    )) {
      upserts.push({
        collection: 'patientContactPoints',
        doc: { ...point, primary: false },
        expectedRevision: Number(point.revision ?? 0),
        expectedOrgId: input.orgId,
      });
    }
  }
  upserts.push({ collection: 'patientContactPoints', doc: draft, expectedRevision: null, expectedOrgId: input.orgId });
  if (draft.primary) {
    upserts.push({
      collection: 'clients',
      doc: { ...patient, [input.kind === 'phone' ? 'number' : 'email']: input.kind === 'phone' ? normalizedValue : draft.value },
      expectedRevision: Number(patient.revision ?? 0),
      expectedOrgId: input.orgId,
    });
  }
  const committed = commitBatch({ upserts });
  if (otherPatients.length) ensureConflict(input.orgId, input.kind, normalizedValue, [...otherPatients, input.patientId].sort(), 'shared-contact');
  return committed.upserts.find((row) => row.id === draft.id) as PatientContactPointDoc;
}

export function endPatientContactPoint(input: { orgId: string; patientId: string; contactPointId: string }): PatientContactPointDoc {
  const initial = find<PatientContactPointDoc>(
    'patientContactPoints',
    (row) => row.id === input.contactPointId && row.orgId === input.orgId && row.patientId === input.patientId,
  );
  if (!initial) throw new Error('contact point not found');
  return withEntityLock('patient-contact', `${input.orgId}:${initial.kind}:${initial.normalizedValue}`, () => {
    const point = find<PatientContactPointDoc>(
      'patientContactPoints',
      (row) => row.id === input.contactPointId && row.orgId === input.orgId && row.patientId === input.patientId,
    );
    if (!point) throw new Error('contact point not found');
    if (point.endedAt) return point;
    return commitBatch({
      upserts: [{
        collection: 'patientContactPoints',
        doc: { ...point, endedAt: nowIso(), primary: false },
        expectedRevision: Number(point.revision ?? 0),
        expectedOrgId: input.orgId,
      }],
    }).upserts[0] as PatientContactPointDoc;
  });
}

export function identityConflictsFor(orgId: string, status: IdentityConflictDoc['status'] | 'all' = 'open') {
  return list<IdentityConflictDoc>('identityConflicts', (conflict) => conflict.orgId === orgId && (status === 'all' || conflict.status === status))
    .sort((a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)));
}

export function resolveIdentityConflict(input: {
  orgId: string;
  conflictId: string;
  action: 'select' | 'shared' | 'dismiss';
  selectedPatientId?: string;
  actor: string;
  note?: string;
}): IdentityConflictDoc {
  const conflict = find<IdentityConflictDoc>('identityConflicts', (row) => row.id === input.conflictId && row.orgId === input.orgId);
  if (!conflict) throw new Error('identity conflict not found');
  if (input.action === 'select' && !input.selectedPatientId) throw new Error('selectedPatientId is required');
  if (input.selectedPatientId && !conflict.candidatePatientIds.includes(input.selectedPatientId)) throw new Error('selected patient is not a conflict candidate');
  // Selection records a human decision. It does not merge or delete either
  // patient; a later, dedicated merge workflow must re-home every linked record.
  return commitBatch({
    upserts: [{
      collection: 'identityConflicts',
      doc: {
        ...conflict,
        status: input.action === 'select' ? 'resolved' : input.action === 'dismiss' ? 'dismissed' : 'shared',
        selectedPatientId: input.action === 'select' ? input.selectedPatientId : undefined,
        resolvedAt: nowIso(),
        resolvedBy: input.actor,
        resolutionNote: input.note?.trim().slice(0, 1_000),
      },
      expectedRevision: Number(conflict.revision ?? 0),
      expectedOrgId: input.orgId,
    }],
  }).upserts[0] as IdentityConflictDoc;
}

/**
 * Human-approved exact-conflict merge. Every mutable link and the archived
 * redirect commit atomically; immutable historical evidence keeps its original
 * patient ID and remains reachable through the source redirect.
 */
export function mergePatients(input: {
  orgId: string;
  conflictId: string;
  survivorPatientId: string;
  sourcePatientId: string;
  actor: string;
  note: string;
  fieldDecisions?: Record<string, 'survivor' | 'source'>;
}) {
  if (input.survivorPatientId === input.sourcePatientId) throw new Error('survivor and source patients must differ');
  if (input.note.trim().length < 10) throw new Error('a meaningful merge reason is required');
  const keys = [input.survivorPatientId, input.sourcePatientId].sort();
  return withEntityLock('patient-link', `${input.orgId}:${keys[0]}`, () =>
    withEntityLock('patient-link', `${input.orgId}:${keys[1]}`, () => {
      const conflict = find<IdentityConflictDoc>('identityConflicts', (row) => row.id === input.conflictId && row.orgId === input.orgId);
      if (!conflict || !['open', 'shared'].includes(conflict.status)) throw new Error('open identity conflict not found');
      if (!conflict.candidatePatientIds.includes(input.survivorPatientId) || !conflict.candidatePatientIds.includes(input.sourcePatientId)) {
        throw new Error('both patients must be candidates in the exact-match conflict');
      }
      const survivor = find<Doc & { orgId?: string; mergedIntoClientId?: string; tags?: string[] }>('clients', (row) => row.id === input.survivorPatientId && row.orgId === input.orgId);
      const source = find<Doc & { orgId?: string; mergedIntoClientId?: string; tags?: string[] }>('clients', (row) => row.id === input.sourcePatientId && row.orgId === input.orgId);
      if (!survivor || !source) throw new Error('merge patient not found');
      if (survivor.mergedIntoClientId || source.mergedIntoClientId) throw new Error('a merge candidate is already an archived redirect');

      const decisions: Record<string, 'survivor' | 'source' | 'combined'> = {};
      const merged = { ...survivor } as Doc & { tags?: string[] };
      for (const field of ['name', 'firstName', 'lastName', 'number', 'email', 'dateOfBirth', 'address', 'note'] as const) {
        const requested = input.fieldDecisions?.[field] ?? (survivor[field] ? 'survivor' : 'source');
        decisions[field] = requested;
        if (requested === 'source' && source[field] !== undefined && source[field] !== '') merged[field] = source[field];
      }
      merged.tags = [...new Set([...(survivor.tags ?? []), ...(source.tags ?? [])])];
      decisions.tags = 'combined';

      const linkedCollections = [
        ['bookings', ['clientId']], ['notes', ['clientId', 'patientId']], ['invoices', ['clientId']], ['payments', ['clientId']],
        ['patientAlerts', ['patientId']], ['clinicalDocuments', ['patientId']], ['caseloadAssignments', ['patientId']],
        ['recordGrants', ['patientId']], ['deletionRequests', ['patientId']],
      ] as const;
      const rehomed: Record<string, number> = {};
      const upserts: Array<{ collection: string; doc: Doc; expectedRevision: number | null; expectedOrgId: string }> = [];
      const deletes: Array<{ collection: string; id: string; expectedRevision: number; expectedOrgId: string }> = [];
      const allDocumentLinks = list<Doc & {
        orgId?: string; documentId?: string; patientId?: string; resourceType?: string; resourceId?: string; relationship?: string;
      }>('documentLinks', (row) => row.orgId === input.orgId);
      const sourceDocumentLinks = allDocumentLinks.filter((row) =>
        row.patientId === input.sourcePatientId || (row.resourceType === 'patient' && row.resourceId === input.sourcePatientId),
      );
      const duplicateLinksByDocument = new Map<string, number>();
      for (const row of sourceDocumentLinks) {
        const next = {
          ...row,
          patientId: row.patientId === input.sourcePatientId ? input.survivorPatientId : row.patientId,
          resourceId: row.resourceType === 'patient' && row.resourceId === input.sourcePatientId ? input.survivorPatientId : row.resourceId,
        };
        const duplicate = allDocumentLinks.find((candidate) =>
          candidate.id !== row.id && candidate.documentId === next.documentId && candidate.resourceType === next.resourceType &&
          candidate.resourceId === next.resourceId && candidate.relationship === next.relationship,
        );
        if (duplicate) {
          deletes.push({ collection: 'documentLinks', id: row.id, expectedRevision: Number(row.revision ?? 0), expectedOrgId: input.orgId });
          if (row.documentId) duplicateLinksByDocument.set(row.documentId, (duplicateLinksByDocument.get(row.documentId) ?? 0) + 1);
        } else {
          upserts.push({ collection: 'documentLinks', doc: next, expectedRevision: Number(row.revision ?? 0), expectedOrgId: input.orgId });
        }
      }
      rehomed.documentLinks = sourceDocumentLinks.length;
      for (const [collection, fields] of linkedCollections) {
        const rows = list<Doc & { orgId?: string }>(collection, (row) => row.orgId === input.orgId && fields.some((field) => row[field] === input.sourcePatientId));
        rehomed[collection] = rows.length;
        for (const row of rows) {
          const next = { ...row };
          for (const field of fields) if (next[field] === input.sourcePatientId) next[field] = input.survivorPatientId;
          if (collection === 'clinicalDocuments') {
            if (next.ownerType === 'patient' && next.ownerId === input.sourcePatientId) next.ownerId = input.survivorPatientId;
            const removedLinks = duplicateLinksByDocument.get(row.id) ?? 0;
            if (removedLinks) next.linkCount = Math.max(1, Number(next.linkCount ?? 1) - removedLinks);
          }
          upserts.push({ collection, doc: next, expectedRevision: Number(row.revision ?? 0), expectedOrgId: input.orgId });
        }
      }

      const survivorContacts = contactPointsFor(input.orgId, input.survivorPatientId, { includeEnded: true });
      const sourceContacts = contactPointsFor(input.orgId, input.sourcePatientId, { includeEnded: true });
      for (const point of sourceContacts) {
        const duplicate = survivorContacts.find((row) => !row.endedAt && !point.endedAt && row.kind === point.kind && row.normalizedValue === point.normalizedValue);
        const hasPrimary = survivorContacts.some((row) => !row.endedAt && row.kind === point.kind && row.primary);
        upserts.push({
          collection: 'patientContactPoints',
          doc: duplicate
            ? { ...point, primary: false, endedAt: point.endedAt ?? nowIso() }
            : { ...point, patientId: input.survivorPatientId, primary: point.endedAt ? false : point.primary && !hasPrimary },
          expectedRevision: Number(point.revision ?? 0), expectedOrgId: input.orgId,
        });
      }
      rehomed.patientContactPoints = sourceContacts.filter((row) => !survivorContacts.some((candidate) => !candidate.endedAt && !row.endedAt && candidate.kind === row.kind && candidate.normalizedValue === row.normalizedValue)).length;

      const relatedConflicts = identityConflictsFor(input.orgId, 'all').filter((row) => row.id !== conflict.id && row.candidatePatientIds.includes(input.sourcePatientId));
      for (const row of relatedConflicts) {
        upserts.push({
          collection: 'identityConflicts',
          doc: { ...row, candidatePatientIds: [...new Set(row.candidatePatientIds.map((id) => id === input.sourcePatientId ? input.survivorPatientId : id))].sort() },
          expectedRevision: Number(row.revision ?? 0), expectedOrgId: input.orgId,
        });
      }
      rehomed.identityConflicts = relatedConflicts.length;

      const at = nowIso();
      const event = {
        id: `merge_${crypto.randomBytes(18).toString('hex')}`, orgId: input.orgId, conflictId: conflict.id,
        survivorPatientId: input.survivorPatientId, sourcePatientId: input.sourcePatientId,
        fieldDecisions: decisions, rehomed, actor: input.actor, occurredAt: at, createdAt: at,
      } as ClientMergeEventDoc;
      upserts.push(
        { collection: 'clients', doc: merged, expectedRevision: Number(survivor.revision ?? 0), expectedOrgId: input.orgId },
        {
          collection: 'clients',
          doc: {
            ...source, archivedAt: at, archivedBy: input.actor, mergedIntoClientId: input.survivorPatientId,
            identityRedirect: true, mergeReason: input.note.trim().slice(0, 1_000), alerts: [],
          },
          expectedRevision: Number(source.revision ?? 0), expectedOrgId: input.orgId,
        },
        {
          collection: 'identityConflicts',
          doc: { ...conflict, status: 'resolved', selectedPatientId: input.survivorPatientId, resolvedAt: at, resolvedBy: input.actor, resolutionNote: input.note.trim().slice(0, 1_000) },
          expectedRevision: Number(conflict.revision ?? 0), expectedOrgId: input.orgId,
        },
        { collection: 'clientMergeEvents', doc: event, expectedRevision: null, expectedOrgId: input.orgId },
      );
      if (upserts.length + deletes.length > 500) throw new Error(`merge requires ${upserts.length + deletes.length} atomic writes, above the 500-record safety limit; review and reduce linked records before retrying`);
      const result = commitBatch({ upserts, deletes });
      return {
        survivor: result.upserts.find((row) => row.id === input.survivorPatientId)!,
        source: result.upserts.find((row) => row.id === input.sourcePatientId)!,
        conflict: result.upserts.find((row) => row.id === conflict.id) as IdentityConflictDoc,
        event: result.upserts.find((row) => row.id === event.id) as ClientMergeEventDoc,
      };
    }),
  );
}
