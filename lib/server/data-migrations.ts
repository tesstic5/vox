/** Checksummed, idempotent and resumable Phase 1 data migrations. */

import crypto from 'node:crypto';
import { commitBatch, find, list, listAllByOrg, nowIso, type Doc } from './db';
import { ensureSystemRoles, reconcileSystemRoleTemplates } from './permissions';
import { migrateLegacyContactPoints } from './patient-identity';
import { clearMigratedLegacyPatientAlertBodies, migrateLegacyPatientAlerts } from './patient-alerts';
import { backfillDocumentLinks, migrateLegacyFileMetadata } from './clinical-documents';
import { ensurePhase1FeatureFlags } from './feature-flags';
import type { PrivacyProfileDoc } from './privacy-governance';
import { structuredAddressFromLegacy } from '../addresses';

export type DataMigrationStateDoc = Doc & {
  orgId: string;
  migrationId: string;
  checksum: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  attempts: number;
  startedAt: string;
  completedAt?: string;
  lastError?: string;
  result?: unknown;
  revision: number;
};

type Definition = {
  id: string;
  version: number;
  description: string;
  /** Immutable algorithm manifest included in the stored checksum. */
  integrity: string;
  run(orgId: string): unknown;
};

function backfillMutableRecordVersions(orgId: string) {
  const collections = ['clients', 'bookings', 'notes', 'invoices', 'payments', 'classSessions', 'waitEntries', 'waitOffers'] as const;
  const counts: Record<string, number> = {};
  for (const collection of collections) {
    const rows = list<Doc & { orgId?: string; schemaVersion?: number; revision?: number }>(
      collection,
      (row) => row.orgId === orgId && (row.schemaVersion !== 1 || !Number.isSafeInteger(Number(row.revision))),
    );
    let changed = 0;
    for (let offset = 0; offset < rows.length; offset += 400) {
      const chunk = rows.slice(offset, offset + 400);
      const committed = commitBatch({ upserts: chunk.map((row) => ({
        collection,
        doc: { ...row, schemaVersion: 1 },
        expectedRevision: Number(row.revision ?? 0),
        expectedOrgId: orgId,
      })) });
      changed += committed.upserts.length;
    }
    counts[collection] = changed;
  }
  return counts;
}

function backfillPhase3WorkflowVersions(orgId: string) {
  const collections = [
    'formTemplates', 'formAssignments', 'formResponses', 'clientUpdateSuggestions',
    'referrals', 'referralRiskFlags', 'letterTemplates', 'letters',
  ] as const;
  const counts: Record<string, number> = {};
  for (const collection of collections) {
    const rows = list<Doc & { orgId?: string; schemaVersion?: number; revision?: number }>(
      collection,
      (row) => row.orgId === orgId && (row.schemaVersion !== 1 || !Number.isSafeInteger(Number(row.revision))),
    );
    let changed = 0;
    for (let offset = 0; offset < rows.length; offset += 400) {
      const chunk = rows.slice(offset, offset + 400);
      changed += commitBatch({ upserts: chunk.map((row) => ({
        collection, doc: { ...row, schemaVersion: 1 }, expectedRevision: Number(row.revision ?? 0), expectedOrgId: orgId,
      })) }).upserts.length;
    }
    counts[collection] = changed;
  }
  return counts;
}

function backfillIntakeAdministrationVersions(orgId: string) {
  const collections = ['contacts', 'clientRelationships', 'customFieldDefinitions', 'customFieldValues'] as const;
  const counts: Record<string, number> = {};
  for (const collection of collections) {
    const rows = list<Doc & { orgId?: string; schemaVersion?: number; revision?: number }>(
      collection,
      (row) => row.orgId === orgId && (row.schemaVersion !== 1 || !Number.isSafeInteger(Number(row.revision))),
    );
    let changed = 0;
    for (let offset = 0; offset < rows.length; offset += 400) {
      const chunk = rows.slice(offset, offset + 400);
      changed += commitBatch({ upserts: chunk.map((row) => ({
        collection, doc: { ...row, schemaVersion: 1 }, expectedRevision: Number(row.revision ?? 0), expectedOrgId: orgId,
      })) }).upserts.length;
    }
    counts[collection] = changed;
  }
  return counts;
}

function backfillStructuredAddresses(orgId: string) {
  const counts = { clients: 0, contacts: 0, referrals: 0 };
  const clientRows = list<Doc & { orgId?: string; address?: string; structuredAddress?: unknown }>(
    'clients',
    (row) => row.orgId === orgId && !row.structuredAddress && Boolean(String(row.address ?? '').trim()),
  );
  const contactRows = list<Doc & { orgId?: string; address?: string; structuredAddress?: unknown }>(
    'contacts',
    (row) => row.orgId === orgId && !row.structuredAddress && Boolean(String(row.address ?? '').trim()),
  );
  const referralRows = list<Doc & { orgId?: string; patient?: { address?: string; structuredAddress?: unknown } }>(
    'referrals',
    (row) => row.orgId === orgId && !row.patient?.structuredAddress && Boolean(String(row.patient?.address ?? '').trim()),
  );

  const apply = (collection: string, rows: Doc[], transform: (row: Doc) => Doc) => {
    let changed = 0;
    for (let offset = 0; offset < rows.length; offset += 400) {
      const chunk = rows.slice(offset, offset + 400);
      changed += commitBatch({ upserts: chunk.map((row) => ({
        collection,
        doc: transform(row),
        expectedRevision: Number(row.revision ?? 0),
        expectedOrgId: orgId,
      })) }).upserts.length;
    }
    return changed;
  };

  counts.clients = apply('clients', clientRows, (row) => ({
    ...row,
    structuredAddress: structuredAddressFromLegacy(row.address),
  }));
  counts.contacts = apply('contacts', contactRows, (row) => ({
    ...row,
    structuredAddress: structuredAddressFromLegacy(row.address),
  }));
  counts.referrals = apply('referrals', referralRows, (row) => ({
    ...row,
    patient: {
      ...((row.patient && typeof row.patient === 'object' ? row.patient : {}) as Record<string, unknown>),
      structuredAddress: structuredAddressFromLegacy((row.patient as { address?: string } | undefined)?.address),
    },
  }));
  return counts;
}

function classifyExistingCalls(orgId: string) {
  const rows = listAllByOrg<Doc & { orgId?: string; contentClassification?: string }>('calls', orgId).filter((row) => row.contentClassification !== 'restricted');
  let changed = 0;
  for (let offset = 0; offset < rows.length; offset += 400) {
    const chunk = rows.slice(offset, offset + 400);
    changed += commitBatch({ upserts: chunk.map((row) => ({
      collection: 'calls',
      doc: { ...row, contentClassification: 'restricted', transcriptRetentionStatus: 'controller_review_required', schemaVersion: 1 },
      expectedRevision: Number(row.revision ?? 0), expectedOrgId: orgId,
    })) }).upserts.length;
  }
  return { calls: changed };
}

function initialisePrivacyCutover(orgId: string) {
  const existing = find<PrivacyProfileDoc>('privacyProfiles', (row) => row.orgId === orgId);
  if (existing?.auditCompleteFromAt) return { profileId: existing.id, auditCompleteFromAt: existing.auditCompleteFromAt, changed: false };
  const at = nowIso();
  const row = {
    ...(existing ?? {}),
    id: existing?.id ?? `privacy_${orgId}`,
    orgId,
    controllerName: existing?.controllerName ?? '',
    controllerAddress: existing?.controllerAddress ?? '',
    controllerContactEmail: existing?.controllerContactEmail ?? '',
    privacyNoticeVersion: existing?.privacyNoticeVersion ?? '',
    privacyNoticeUrl: existing?.privacyNoticeUrl ?? '',
    dpiaReference: existing?.dpiaReference ?? '',
    dpiaStatus: existing?.dpiaStatus ?? 'not_started',
    breakGlassEnabled: existing?.breakGlassEnabled ?? false,
    breakGlassMaxMinutes: existing?.breakGlassMaxMinutes ?? 60,
    breakGlassNotify: existing?.breakGlassNotify ?? [],
    auditCompleteFromAt: at,
    updatedBy: existing?.updatedBy ?? 'phase1-data-migration',
    createdAt: existing?.createdAt ?? at,
  } as PrivacyProfileDoc;
  const saved = commitBatch({ upserts: [{
    collection: 'privacyProfiles', doc: row, expectedRevision: existing ? Number(existing.revision ?? 0) : null, expectedOrgId: orgId,
  }] }).upserts[0] as PrivacyProfileDoc;
  return { profileId: saved.id, auditCompleteFromAt: saved.auditCompleteFromAt, changed: true };
}

const DEFINITIONS: readonly Definition[] = [
  {
    id: 'phase1.system_roles', version: 1,
    description: 'Insert immutable compatibility templates for every fixed role',
    integrity: 'ensure-system-roles:v1:fixed-role-template-upsert',
    run: (orgId) => ({ roles: ensureSystemRoles(orgId).length }),
  },
  {
    id: 'phase1.patient_contact_points', version: 1,
    description: 'Copy legacy primary phone/email values into typed contact points without inventing verification',
    integrity: 'legacy-contact-copy:v1:normalised-deterministic-unverified',
    run: (orgId) => migrateLegacyContactPoints(orgId),
  },
  {
    id: 'phase1.restricted_patient_alerts', version: 1,
    description: 'Copy documented legacy medical flags into the restricted clinical-alert collection',
    integrity: 'legacy-alert-copy:v1:deterministic-restricted-clinical',
    run: (orgId) => migrateLegacyPatientAlerts(orgId),
  },
  {
    id: 'phase1.legacy_file_metadata', version: 1,
    description: 'Represent legacy file rows as metadata-only clinical documents without claiming bytes',
    integrity: 'legacy-file-metadata:v1:no-byte-claim:unavailable',
    run: (orgId) => migrateLegacyFileMetadata(orgId, 'data-migration'),
  },
  {
    id: 'phase1.clear_embedded_alert_bodies', version: 1,
    description: 'Clear legacy embedded clinical-alert text only after every restricted destination row exists',
    integrity: 'legacy-alert-source-clear:v1:verify-every-deterministic-destination:cas',
    run: (orgId) => clearMigratedLegacyPatientAlertBodies(orgId),
  },
  {
    id: 'phase1.system_role_export_permissions', version: 1,
    description: 'Reconcile immutable compatibility templates with the explicit clinical export permission',
    integrity: 'system-role-reconcile:v1:code-owned-templates:clinical-export',
    run: (orgId) => reconcileSystemRoleTemplates(orgId),
  },
  {
    id: 'phase1.mutable_record_versions', version: 1,
    description: 'Backfill schemaVersion and revision through bounded atomic batches on high-risk mutable records',
    integrity: 'mutable-record-version-backfill:v1:bounded-400:cas-revision-zero-compatible',
    run: (orgId) => backfillMutableRecordVersions(orgId),
  },
  {
    id: 'phase1.communication_content_classification', version: 1,
    description: 'Classify existing call transcripts/audio metadata as restricted pending controller retention review',
    integrity: 'call-content-classification:v1:restricted:no-purge:controller-review-required',
    run: (orgId) => classifyExistingCalls(orgId),
  },
  {
    id: 'phase1.privacy_audit_cutover', version: 1,
    description: 'Record the instant from which the append-only clinical access stream is complete',
    integrity: 'clinical-audit-cutover:v1:technical-timestamp:no-legal-assertion',
    run: (orgId) => initialisePrivacyCutover(orgId),
  },
  {
    id: 'phase1.rollout_flags', version: 1,
    description: 'Create observe/off rollout records for granular permissions and documents',
    integrity: 'phase1-rollout-flags:v1:permissions-observe:documents-off',
    run: (orgId) => ({ flags: ensurePhase1FeatureFlags(orgId).length }),
  },
  {
    id: 'phase1.system_role_merge_permission', version: 1,
    description: 'Reconcile code-owned system templates with the explicit patient-merge permission',
    integrity: 'system-role-reconcile:v2:code-owned-templates:clients-merge',
    run: (orgId) => reconcileSystemRoleTemplates(orgId),
  },
  {
    id: 'phase1.document_owner_links', version: 1,
    description: 'Backfill typed canonical owner links for every existing clinical document record',
    integrity: 'document-links:v1:typed-owner-link:same-tenant:portal-false',
    run: (orgId) => backfillDocumentLinks(orgId),
  },
  {
    id: 'phase3.system_role_workflow_permissions', version: 1,
    description: 'Reconcile code-owned role templates with forms, referral and correspondence permissions',
    integrity: 'system-role-reconcile:v3:forms-referrals-letters:code-owned-templates',
    run: (orgId) => reconcileSystemRoleTemplates(orgId),
  },
  {
    id: 'phase3.workflow_record_versions', version: 1,
    description: 'Backfill schema and revision fields on native intake, referral and correspondence records',
    integrity: 'phase3-workflow-records:v1:bounded-400:cas:immutable-version-aware',
    run: (orgId) => backfillPhase3WorkflowVersions(orgId),
  },
  {
    id: 'phase3.intake_administration_record_versions', version: 1,
    description: 'Backfill schema and revision fields on contacts, patient relationships and typed custom-field records',
    integrity: 'phase3-intake-administration:v1:bounded-400:cas:no-invented-backfill',
    run: (orgId) => backfillIntakeAdministrationVersions(orgId),
  },
  {
    id: 'phase3.structured_addresses', version: 1,
    description: 'Copy legacy patient, contact and referral address strings into an explicit review queue without parsing or discarding them',
    integrity: 'phase3-structured-addresses:v1:copy-only:legacyText:needs-review:no-automatic-parse',
    run: (orgId) => backfillStructuredAddresses(orgId),
  },
  {
    id: 'phase3.system_role_task_automation_permissions', version: 1,
    description: 'Reconcile code-owned role templates with administrative task and constrained automation permissions',
    integrity: 'system-role-reconcile:v4:tasks-automations:code-owned-templates',
    run: (orgId) => reconcileSystemRoleTemplates(orgId),
  },
  {
    id: 'phase4.system_role_case_funding_permissions', version: 1,
    description: 'Reconcile code-owned role templates with case, sensitive coverage and funding-override permissions without assigning historical cases',
    integrity: 'system-role-reconcile:v5:cases-coverage-funding:no-historical-inference:code-owned-templates',
    run: (orgId) => reconcileSystemRoleTemplates(orgId),
  },
] as const;

function checksum(definition: Definition) {
  return crypto.createHash('sha256').update(JSON.stringify({
    id: definition.id,
    version: definition.version,
    description: definition.description,
    integrity: definition.integrity,
  })).digest('hex');
}

function stateId(orgId: string, migrationId: string) {
  return `dmig_${crypto.createHash('sha256').update(`${orgId}:${migrationId}`).digest('hex').slice(0, 40)}`;
}

export function dataMigrationStates(orgId: string): DataMigrationStateDoc[] {
  return DEFINITIONS.map((definition) => {
    const existing = find<DataMigrationStateDoc>('dataMigrations', (row) => row.orgId === orgId && row.migrationId === definition.id);
    return existing ?? {
      id: stateId(orgId, definition.id), orgId, migrationId: definition.id, checksum: checksum(definition),
      description: definition.description, status: 'pending', attempts: 0, startedAt: '', revision: 0,
    } as DataMigrationStateDoc;
  });
}

export function runPhase1DataMigrations(orgId: string) {
  const outcomes: DataMigrationStateDoc[] = [];
  for (const definition of DEFINITIONS) {
    const expectedChecksum = checksum(definition);
    let state = find<DataMigrationStateDoc>('dataMigrations', (row) => row.orgId === orgId && row.migrationId === definition.id);
    if (state?.checksum && state.checksum !== expectedChecksum) {
      throw new Error(`data migration ${definition.id} checksum mismatch; applied=${state.checksum} code=${expectedChecksum}`);
    }
    if (state?.status === 'completed') {
      outcomes.push(state);
      continue;
    }
    const at = nowIso();
    const running = {
      ...(state ?? {}),
      id: state?.id ?? stateId(orgId, definition.id), orgId, migrationId: definition.id,
      checksum: expectedChecksum, description: definition.description, status: 'running',
      attempts: (state?.attempts ?? 0) + 1, startedAt: state?.startedAt || at,
      lastError: undefined,
    } as DataMigrationStateDoc;
    state = commitBatch({
      upserts: [{ collection: 'dataMigrations', doc: running, expectedRevision: state ? Number(state.revision ?? 0) : null, expectedOrgId: orgId }],
    }).upserts[0] as DataMigrationStateDoc;
    try {
      const result = definition.run(orgId);
      state = commitBatch({
        upserts: [{
          collection: 'dataMigrations', doc: { ...state, status: 'completed', completedAt: nowIso(), result, lastError: undefined },
          expectedRevision: Number(state.revision ?? 0), expectedOrgId: orgId,
        }],
      }).upserts[0] as DataMigrationStateDoc;
      outcomes.push(state);
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
      state = commitBatch({
        upserts: [{
          collection: 'dataMigrations', doc: { ...state, status: 'failed', lastError: message },
          expectedRevision: Number(state.revision ?? 0), expectedOrgId: orgId,
        }],
      }).upserts[0] as DataMigrationStateDoc;
      outcomes.push(state);
      throw error;
    }
  }
  return { completed: outcomes.filter((row) => row.status === 'completed').length, total: DEFINITIONS.length, migrations: outcomes };
}
