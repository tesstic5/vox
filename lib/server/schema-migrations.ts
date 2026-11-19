import crypto from 'node:crypto';

export type SchemaMigration = {
  id: string;
  description: string;
  postgres: readonly string[];
  sqlite: readonly string[];
};

/**
 * Ordered, immutable database migrations for the shared document tables.
 *
 * The application payload remains JSON/JSONB, but indexes and append-only guards
 * belong in the database: an API check is not enough protection against a race,
 * a maintenance script, or a second container running older code.
 */
export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    id: '20260920_001_clinical_foundation_indexes',
    description: 'Indexes for roles, identity, clinical access, documents, durable jobs and idempotency',
    postgres: [
      `CREATE UNIQUE INDEX IF NOT EXISTS voxera_docs_role_key
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'key'))
         WHERE collection = 'roles' AND COALESCE(body ->> 'archivedAt', '') = ''`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_contact_patient
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'patientId'), seq DESC)
         WHERE collection = 'patientContactPoints'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_contact_exact
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'kind'), (body ->> 'normalizedValue'))
         WHERE collection = 'patientContactPoints' AND COALESCE(body ->> 'endedAt', '') = ''`,
      `CREATE UNIQUE INDEX IF NOT EXISTS voxera_docs_primary_contact
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'patientId'), (body ->> 'kind'))
         WHERE collection = 'patientContactPoints'
           AND body ->> 'primary' = 'true'
           AND COALESCE(body ->> 'endedAt', '') = ''`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_identity_conflict_state
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'status'), seq DESC)
         WHERE collection = 'identityConflicts'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_clinical_access_resource
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'resourceType'), (body ->> 'resourceId'), (body ->> 'occurredAt') DESC)
         WHERE collection = 'clinicalAccessEvents'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_patient_alerts
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'patientId'), (body ->> 'classification'), seq DESC)
         WHERE collection = 'patientAlerts'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_documents_owner
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'ownerType'), (body ->> 'ownerId'), seq DESC)
         WHERE collection = 'clinicalDocuments'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_document_versions
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'documentId'), ((body ->> 'version')::int) DESC)
         WHERE collection = 'clinicalDocumentVersions'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS voxera_docs_upload_token_hash
         ON voxera_docs ((body ->> 'tokenHash'))
         WHERE collection = 'documentUploadTokens'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_domain_jobs_due
         ON voxera_docs ((body ->> 'status'), (body ->> 'runAt'), seq)
         WHERE collection = 'domainJobs'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS voxera_docs_idempotency_key
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'namespace'), (body ->> 'keyHash'))
         WHERE collection = 'idempotencyReceipts'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_legal_holds_scope
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'scopeType'), (body ->> 'scopeId'), seq DESC)
         WHERE collection = 'legalHolds' AND COALESCE(body ->> 'releasedAt', '') = ''`,
    ],
    sqlite: [
      `CREATE UNIQUE INDEX IF NOT EXISTS docs_role_key
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.key'))
         WHERE collection = 'roles' AND COALESCE(json_extract(body, '$.archivedAt'), '') = ''`,
      `CREATE INDEX IF NOT EXISTS docs_contact_patient
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.patientId'), seq DESC)
         WHERE collection = 'patientContactPoints'`,
      `CREATE INDEX IF NOT EXISTS docs_contact_exact
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.kind'), json_extract(body, '$.normalizedValue'))
         WHERE collection = 'patientContactPoints' AND COALESCE(json_extract(body, '$.endedAt'), '') = ''`,
      `CREATE UNIQUE INDEX IF NOT EXISTS docs_primary_contact
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.patientId'), json_extract(body, '$.kind'))
         WHERE collection = 'patientContactPoints'
           AND json_extract(body, '$.primary') = 1
           AND COALESCE(json_extract(body, '$.endedAt'), '') = ''`,
      `CREATE INDEX IF NOT EXISTS docs_identity_conflict_state
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.status'), seq DESC)
         WHERE collection = 'identityConflicts'`,
      `CREATE INDEX IF NOT EXISTS docs_clinical_access_resource
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.resourceType'), json_extract(body, '$.resourceId'), json_extract(body, '$.occurredAt') DESC)
         WHERE collection = 'clinicalAccessEvents'`,
      `CREATE INDEX IF NOT EXISTS docs_patient_alerts
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.patientId'), json_extract(body, '$.classification'), seq DESC)
         WHERE collection = 'patientAlerts'`,
      `CREATE INDEX IF NOT EXISTS docs_documents_owner
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.ownerType'), json_extract(body, '$.ownerId'), seq DESC)
         WHERE collection = 'clinicalDocuments'`,
      `CREATE INDEX IF NOT EXISTS docs_document_versions
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.documentId'), CAST(json_extract(body, '$.version') AS INTEGER) DESC)
         WHERE collection = 'clinicalDocumentVersions'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS docs_upload_token_hash
         ON docs (json_extract(body, '$.tokenHash'))
         WHERE collection = 'documentUploadTokens'`,
      `CREATE INDEX IF NOT EXISTS docs_domain_jobs_due
         ON docs (json_extract(body, '$.status'), json_extract(body, '$.runAt'), seq)
         WHERE collection = 'domainJobs'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS docs_idempotency_key
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.namespace'), json_extract(body, '$.keyHash'))
         WHERE collection = 'idempotencyReceipts'`,
      `CREATE INDEX IF NOT EXISTS docs_legal_holds_scope
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.scopeType'), json_extract(body, '$.scopeId'), seq DESC)
         WHERE collection = 'legalHolds' AND COALESCE(json_extract(body, '$.releasedAt'), '') = ''`,
    ],
  },
  {
    id: '20260920_002_append_only_guards',
    description: 'Database guards for clinical access events and immutable document versions',
    postgres: [
      `CREATE OR REPLACE FUNCTION voxera_reject_immutable_document_change()
       RETURNS trigger AS $$
       BEGIN
         IF OLD.collection IN ('clinicalAccessEvents', 'clinicalDocumentVersions', 'documentScanEvents') THEN
           RAISE EXCEPTION 'collection % is append-only', OLD.collection USING ERRCODE = '55000';
         END IF;
         RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
       END;
       $$ LANGUAGE plpgsql`,
      `DROP TRIGGER IF EXISTS voxera_immutable_docs_update ON voxera_docs`,
      `CREATE TRIGGER voxera_immutable_docs_update
         BEFORE UPDATE ON voxera_docs
         FOR EACH ROW EXECUTE FUNCTION voxera_reject_immutable_document_change()`,
      `DROP TRIGGER IF EXISTS voxera_immutable_docs_delete ON voxera_docs`,
      `CREATE TRIGGER voxera_immutable_docs_delete
         BEFORE DELETE ON voxera_docs
         FOR EACH ROW EXECUTE FUNCTION voxera_reject_immutable_document_change()`,
    ],
    sqlite: [
      `DROP TRIGGER IF EXISTS docs_immutable_update`,
      `CREATE TRIGGER docs_immutable_update
         BEFORE UPDATE ON docs
         WHEN OLD.collection IN ('clinicalAccessEvents', 'clinicalDocumentVersions', 'documentScanEvents')
         BEGIN
           SELECT RAISE(ABORT, 'collection is append-only');
         END`,
      `DROP TRIGGER IF EXISTS docs_immutable_delete`,
      `CREATE TRIGGER docs_immutable_delete
         BEFORE DELETE ON docs
         WHEN OLD.collection IN ('clinicalAccessEvents', 'clinicalDocumentVersions', 'documentScanEvents')
         BEGIN
           SELECT RAISE(ABORT, 'collection is append-only');
         END`,
    ],
  },
  {
    id: '20260920_003_capability_gated_immutable_maintenance',
    description: 'Keep append-only guards active except inside an explicit transaction-local maintenance window',
    postgres: [
      `CREATE OR REPLACE FUNCTION voxera_reject_immutable_document_change()
       RETURNS trigger AS $$
       BEGIN
         IF OLD.collection IN ('clinicalAccessEvents', 'clinicalDocumentVersions', 'documentScanEvents')
            AND COALESCE(current_setting('voxera.allow_immutable_maintenance', true), 'off') <> 'on' THEN
           RAISE EXCEPTION 'collection % is append-only', OLD.collection USING ERRCODE = '55000';
         END IF;
         RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
       END;
       $$ LANGUAGE plpgsql`,
    ],
    sqlite: [
      `CREATE TABLE IF NOT EXISTS voxera_maintenance_state (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         allow_immutable_mutation INTEGER NOT NULL DEFAULT 0 CHECK (allow_immutable_mutation IN (0, 1))
       )`,
      `INSERT OR IGNORE INTO voxera_maintenance_state (id, allow_immutable_mutation) VALUES (1, 0)`,
      `DROP TRIGGER IF EXISTS docs_immutable_update`,
      `CREATE TRIGGER docs_immutable_update
         BEFORE UPDATE ON docs
         WHEN OLD.collection IN ('clinicalAccessEvents', 'clinicalDocumentVersions', 'documentScanEvents')
          AND COALESCE((SELECT allow_immutable_mutation FROM voxera_maintenance_state WHERE id = 1), 0) = 0
         BEGIN
           SELECT RAISE(ABORT, 'collection is append-only');
         END`,
      `DROP TRIGGER IF EXISTS docs_immutable_delete`,
      `CREATE TRIGGER docs_immutable_delete
         BEFORE DELETE ON docs
         WHEN OLD.collection IN ('clinicalAccessEvents', 'clinicalDocumentVersions', 'documentScanEvents')
          AND COALESCE((SELECT allow_immutable_mutation FROM voxera_maintenance_state WHERE id = 1), 0) = 0
         BEGIN
           SELECT RAISE(ABORT, 'collection is append-only');
         END`,
    ],
  },
  {
    id: '20260920_004_clinical_foundation_claim_and_governance_indexes',
    description: 'Tenant-led indexes and uniqueness for assignments, emergency grants, governance, alerts, versions, jobs and outbox',
    postgres: [
      `CREATE INDEX IF NOT EXISTS voxera_docs_caseload_active
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'patientId'), (body ->> 'userId'), (body ->> 'endsAt'))
         WHERE collection = 'caseloadAssignments'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_record_grant_active
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'userId'), (body ->> 'patientId'), (body ->> 'area'), (body ->> 'expiresAt'))
         WHERE collection = 'recordGrants' AND COALESCE(body ->> 'revokedAt', '') = ''`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_access_grant_expiry
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'userId'), (body ->> 'resourceId'), (body ->> 'expiresAt'))
         WHERE collection = 'accessGrants' AND COALESCE(body ->> 'revokedAt', '') = ''`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_processing_review
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'status'), (body ->> 'approvedAt'))
         WHERE collection = 'processingActivities'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_processor_review
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'active'), (body ->> 'subprocessorListReviewedAt'))
         WHERE collection = 'processorRecords'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_alert_visibility
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'patientId'), (body ->> 'active'), (body ->> 'visibility'))
         WHERE collection = 'patientAlerts'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS voxera_docs_document_version_number
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'documentId'), ((body ->> 'version')::int))
         WHERE collection = 'clinicalDocumentVersions'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_upload_expiry
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'status'), (body ->> 'expiresAt'))
         WHERE collection = 'documentUploadTokens'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_domain_jobs_claim
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'status'), (body ->> 'runAt'), (body ->> 'leaseUntil'))
         WHERE collection = 'domainJobs'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_outbox_claim
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'status'), (body ->> 'availableAt'))
         WHERE collection = 'domainOutbox'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS voxera_docs_feature_flag_key
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'key'))
         WHERE collection = 'featureFlags'`,
    ],
    sqlite: [
      `CREATE INDEX IF NOT EXISTS docs_caseload_active
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.patientId'), json_extract(body, '$.userId'), json_extract(body, '$.endsAt'))
         WHERE collection = 'caseloadAssignments'`,
      `CREATE INDEX IF NOT EXISTS docs_record_grant_active
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.userId'), json_extract(body, '$.patientId'), json_extract(body, '$.area'), json_extract(body, '$.expiresAt'))
         WHERE collection = 'recordGrants' AND COALESCE(json_extract(body, '$.revokedAt'), '') = ''`,
      `CREATE INDEX IF NOT EXISTS docs_access_grant_expiry
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.userId'), json_extract(body, '$.resourceId'), json_extract(body, '$.expiresAt'))
         WHERE collection = 'accessGrants' AND COALESCE(json_extract(body, '$.revokedAt'), '') = ''`,
      `CREATE INDEX IF NOT EXISTS docs_processing_review
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.status'), json_extract(body, '$.approvedAt'))
         WHERE collection = 'processingActivities'`,
      `CREATE INDEX IF NOT EXISTS docs_processor_review
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.active'), json_extract(body, '$.subprocessorListReviewedAt'))
         WHERE collection = 'processorRecords'`,
      `CREATE INDEX IF NOT EXISTS docs_alert_visibility
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.patientId'), json_extract(body, '$.active'), json_extract(body, '$.visibility'))
         WHERE collection = 'patientAlerts'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS docs_document_version_number
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.documentId'), CAST(json_extract(body, '$.version') AS INTEGER))
         WHERE collection = 'clinicalDocumentVersions'`,
      `CREATE INDEX IF NOT EXISTS docs_upload_expiry
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.status'), json_extract(body, '$.expiresAt'))
         WHERE collection = 'documentUploadTokens'`,
      `CREATE INDEX IF NOT EXISTS docs_domain_jobs_claim
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.status'), json_extract(body, '$.runAt'), json_extract(body, '$.leaseUntil'))
         WHERE collection = 'domainJobs'`,
      `CREATE INDEX IF NOT EXISTS docs_outbox_claim
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.status'), json_extract(body, '$.availableAt'))
         WHERE collection = 'domainOutbox'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS docs_feature_flag_key
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.key'))
         WHERE collection = 'featureFlags'`,
    ],
  },
  {
    id: '20260920_005_append_only_patient_merge_evidence',
    description: 'Protect immutable patient merge evidence and index survivor/source history',
    postgres: [
      `CREATE OR REPLACE FUNCTION voxera_reject_immutable_document_change()
       RETURNS trigger AS $$
       BEGIN
         IF OLD.collection IN ('clinicalAccessEvents', 'clinicalDocumentVersions', 'documentScanEvents', 'clientMergeEvents')
            AND COALESCE(current_setting('voxera.allow_immutable_maintenance', true), 'off') <> 'on' THEN
           RAISE EXCEPTION 'collection % is append-only', OLD.collection USING ERRCODE = '55000';
         END IF;
         RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
       END;
       $$ LANGUAGE plpgsql`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_client_merge_history
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'survivorPatientId'), (body ->> 'sourcePatientId'), (body ->> 'occurredAt') DESC)
         WHERE collection = 'clientMergeEvents'`,
    ],
    sqlite: [
      `DROP TRIGGER IF EXISTS docs_immutable_update`,
      `CREATE TRIGGER docs_immutable_update
         BEFORE UPDATE ON docs
         WHEN OLD.collection IN ('clinicalAccessEvents', 'clinicalDocumentVersions', 'documentScanEvents', 'clientMergeEvents')
          AND COALESCE((SELECT allow_immutable_mutation FROM voxera_maintenance_state WHERE id = 1), 0) = 0
         BEGIN
           SELECT RAISE(ABORT, 'collection is append-only');
         END`,
      `DROP TRIGGER IF EXISTS docs_immutable_delete`,
      `CREATE TRIGGER docs_immutable_delete
         BEFORE DELETE ON docs
         WHEN OLD.collection IN ('clinicalAccessEvents', 'clinicalDocumentVersions', 'documentScanEvents', 'clientMergeEvents')
          AND COALESCE((SELECT allow_immutable_mutation FROM voxera_maintenance_state WHERE id = 1), 0) = 0
         BEGIN
           SELECT RAISE(ABORT, 'collection is append-only');
         END`,
      `CREATE INDEX IF NOT EXISTS docs_client_merge_history
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.survivorPatientId'), json_extract(body, '$.sourcePatientId'), json_extract(body, '$.occurredAt') DESC)
         WHERE collection = 'clientMergeEvents'`,
    ],
  },
  {
    id: '20260920_006_document_links',
    description: 'Tenant-leading uniqueness and reverse lookup for typed multi-record document links',
    postgres: [
      `CREATE UNIQUE INDEX IF NOT EXISTS voxera_docs_document_link_unique
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'documentId'), (body ->> 'resourceType'), (body ->> 'resourceId'), (body ->> 'relationship'))
         WHERE collection = 'documentLinks'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_document_link_target
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'resourceType'), (body ->> 'resourceId'), (body ->> 'documentId'))
         WHERE collection = 'documentLinks'`,
    ],
    sqlite: [
      `CREATE UNIQUE INDEX IF NOT EXISTS docs_document_link_unique
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.documentId'), json_extract(body, '$.resourceType'), json_extract(body, '$.resourceId'), json_extract(body, '$.relationship'))
         WHERE collection = 'documentLinks'`,
      `CREATE INDEX IF NOT EXISTS docs_document_link_target
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.resourceType'), json_extract(body, '$.resourceId'), json_extract(body, '$.documentId'))
         WHERE collection = 'documentLinks'`,
    ],
  },
  {
    id: '20260920_007_native_intake_referral_correspondence',
    description: 'Indexes, uniqueness and append-only evidence guards for forms, referrals and correspondence',
    postgres: [
      `CREATE INDEX IF NOT EXISTS voxera_docs_form_template_state
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'state'), seq DESC)
         WHERE collection = 'formTemplates'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS voxera_docs_form_template_version
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'templateId'), ((body ->> 'version')::int))
         WHERE collection = 'formTemplateVersions'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS voxera_docs_form_assignment_token
         ON voxera_docs ((body ->> 'tokenHash'))
         WHERE collection = 'formAssignments'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_form_assignment_queue
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'status'), (body ->> 'clientId'), seq DESC)
         WHERE collection = 'formAssignments'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS voxera_docs_form_response_assignment
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'assignmentId'))
         WHERE collection = 'formResponses'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS voxera_docs_form_response_version
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'responseId'), ((body ->> 'version')::int))
         WHERE collection = 'formResponseVersions'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_referral_queue
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'status'), (body ->> 'priority'), (body ->> 'receivedAt') DESC)
         WHERE collection = 'referrals'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_referral_events
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'referralId'), (body ->> 'at'))
         WHERE collection = 'referralEvents'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS voxera_docs_letter_template_version
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'templateId'), ((body ->> 'version')::int))
         WHERE collection = 'letterTemplateVersions'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_letter_queue
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'status'), (body ->> 'clientId'), seq DESC)
         WHERE collection = 'letters'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS voxera_docs_letter_version
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'letterId'), ((body ->> 'version')::int))
         WHERE collection = 'letterVersions'`,
      `CREATE OR REPLACE FUNCTION voxera_reject_immutable_document_change()
       RETURNS trigger AS $$
       BEGIN
         IF OLD.collection IN ('clinicalAccessEvents', 'clinicalDocumentVersions', 'documentScanEvents', 'clientMergeEvents', 'formTemplateVersions', 'formResponseVersions', 'referralEvents', 'letterTemplateVersions', 'letterVersions')
            AND COALESCE(current_setting('voxera.allow_immutable_maintenance', true), 'off') <> 'on' THEN
           RAISE EXCEPTION 'collection % is append-only', OLD.collection USING ERRCODE = '55000';
         END IF;
         RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
       END;
       $$ LANGUAGE plpgsql`,
    ],
    sqlite: [
      `CREATE INDEX IF NOT EXISTS docs_form_template_state
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.state'), seq DESC)
         WHERE collection = 'formTemplates'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS docs_form_template_version
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.templateId'), CAST(json_extract(body, '$.version') AS INTEGER))
         WHERE collection = 'formTemplateVersions'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS docs_form_assignment_token
         ON docs (json_extract(body, '$.tokenHash'))
         WHERE collection = 'formAssignments'`,
      `CREATE INDEX IF NOT EXISTS docs_form_assignment_queue
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.status'), json_extract(body, '$.clientId'), seq DESC)
         WHERE collection = 'formAssignments'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS docs_form_response_assignment
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.assignmentId'))
         WHERE collection = 'formResponses'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS docs_form_response_version
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.responseId'), CAST(json_extract(body, '$.version') AS INTEGER))
         WHERE collection = 'formResponseVersions'`,
      `CREATE INDEX IF NOT EXISTS docs_referral_queue
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.status'), json_extract(body, '$.priority'), json_extract(body, '$.receivedAt') DESC)
         WHERE collection = 'referrals'`,
      `CREATE INDEX IF NOT EXISTS docs_referral_events
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.referralId'), json_extract(body, '$.at'))
         WHERE collection = 'referralEvents'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS docs_letter_template_version
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.templateId'), CAST(json_extract(body, '$.version') AS INTEGER))
         WHERE collection = 'letterTemplateVersions'`,
      `CREATE INDEX IF NOT EXISTS docs_letter_queue
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.status'), json_extract(body, '$.clientId'), seq DESC)
         WHERE collection = 'letters'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS docs_letter_version
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.letterId'), CAST(json_extract(body, '$.version') AS INTEGER))
         WHERE collection = 'letterVersions'`,
      `DROP TRIGGER IF EXISTS docs_immutable_update`,
      `CREATE TRIGGER docs_immutable_update
         BEFORE UPDATE ON docs
         WHEN OLD.collection IN ('clinicalAccessEvents', 'clinicalDocumentVersions', 'documentScanEvents', 'clientMergeEvents', 'formTemplateVersions', 'formResponseVersions', 'referralEvents', 'letterTemplateVersions', 'letterVersions')
          AND COALESCE((SELECT allow_immutable_mutation FROM voxera_maintenance_state WHERE id = 1), 0) = 0
         BEGIN
           SELECT RAISE(ABORT, 'collection is append-only');
         END`,
      `DROP TRIGGER IF EXISTS docs_immutable_delete`,
      `CREATE TRIGGER docs_immutable_delete
         BEFORE DELETE ON docs
         WHEN OLD.collection IN ('clinicalAccessEvents', 'clinicalDocumentVersions', 'documentScanEvents', 'clientMergeEvents', 'formTemplateVersions', 'formResponseVersions', 'referralEvents', 'letterTemplateVersions', 'letterVersions')
          AND COALESCE((SELECT allow_immutable_mutation FROM voxera_maintenance_state WHERE id = 1), 0) = 0
         BEGIN
           SELECT RAISE(ABORT, 'collection is append-only');
         END`,
    ],
  },
  {
    id: '20260920_008_intake_administration',
    description: 'Tenant indexes and race-safe uniqueness for contacts, patient relationships and typed custom fields',
    postgres: [
      `CREATE INDEX IF NOT EXISTS voxera_docs_contacts_lookup
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'active'), lower(body ->> 'name'))
         WHERE collection = 'contacts'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_contacts_flags
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'referrer'), (body ->> 'payer'), seq DESC)
         WHERE collection = 'contacts'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_client_relationships
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'clientId'), (body ->> 'status'), seq DESC)
         WHERE collection = 'clientRelationships'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS voxera_docs_active_client_relationship
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'clientId'), (body ->> 'relationshipType'), COALESCE(body ->> 'relatedClientId', ''), COALESCE(body ->> 'contactId', ''))
         WHERE collection = 'clientRelationships' AND body ->> 'status' = 'active'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS voxera_docs_custom_field_key
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'targetType'), (body ->> 'key'))
         WHERE collection = 'customFieldDefinitions'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_custom_field_definitions
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'targetType'), (body ->> 'active'), ((body ->> 'order')::int))
         WHERE collection = 'customFieldDefinitions'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS voxera_docs_custom_field_value_target
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'definitionId'), (body ->> 'targetType'), (body ->> 'targetId'))
         WHERE collection = 'customFieldValues'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_custom_field_values
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'targetType'), (body ->> 'targetId'), (body ->> 'verificationStatus'))
         WHERE collection = 'customFieldValues'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_update_suggestions
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'status'), (body ->> 'clientId'), seq DESC)
         WHERE collection = 'clientUpdateSuggestions'`,
    ],
    sqlite: [
      `CREATE INDEX IF NOT EXISTS docs_contacts_lookup
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.active'), lower(json_extract(body, '$.name')))
         WHERE collection = 'contacts'`,
      `CREATE INDEX IF NOT EXISTS docs_contacts_flags
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.referrer'), json_extract(body, '$.payer'), seq DESC)
         WHERE collection = 'contacts'`,
      `CREATE INDEX IF NOT EXISTS docs_client_relationships
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.clientId'), json_extract(body, '$.status'), seq DESC)
         WHERE collection = 'clientRelationships'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS docs_active_client_relationship
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.clientId'), json_extract(body, '$.relationshipType'), COALESCE(json_extract(body, '$.relatedClientId'), ''), COALESCE(json_extract(body, '$.contactId'), ''))
         WHERE collection = 'clientRelationships' AND json_extract(body, '$.status') = 'active'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS docs_custom_field_key
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.targetType'), json_extract(body, '$.key'))
         WHERE collection = 'customFieldDefinitions'`,
      `CREATE INDEX IF NOT EXISTS docs_custom_field_definitions
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.targetType'), json_extract(body, '$.active'), CAST(json_extract(body, '$.order') AS INTEGER))
         WHERE collection = 'customFieldDefinitions'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS docs_custom_field_value_target
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.definitionId'), json_extract(body, '$.targetType'), json_extract(body, '$.targetId'))
         WHERE collection = 'customFieldValues'`,
      `CREATE INDEX IF NOT EXISTS docs_custom_field_values
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.targetType'), json_extract(body, '$.targetId'), json_extract(body, '$.verificationStatus'))
         WHERE collection = 'customFieldValues'`,
      `CREATE INDEX IF NOT EXISTS docs_update_suggestions
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.status'), json_extract(body, '$.clientId'), seq DESC)
         WHERE collection = 'clientUpdateSuggestions'`,
    ],
  },
  {
    id: '20260920_009_public_referral_forms',
    description: 'Global public referral addresses, opaque draft tokens, submission provenance and referral-form queues',
    postgres: [
      `CREATE UNIQUE INDEX IF NOT EXISTS voxera_docs_referral_form_slug
         ON voxera_docs ((body ->> 'slug'))
         WHERE collection = 'referralForms'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS voxera_docs_referral_submission_token
         ON voxera_docs ((body ->> 'tokenHash'))
         WHERE collection = 'referralFormSubmissions'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS voxera_docs_referral_submission_referral
         ON voxera_docs ((body ->> 'referralFormSubmissionId'))
         WHERE collection = 'referrals' AND COALESCE(body ->> 'referralFormSubmissionId', '') <> ''`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_referral_form_state
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'active'), seq DESC)
         WHERE collection = 'referralForms'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_referral_submission_queue
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'referralFormId'), (body ->> 'status'), (body ->> 'createdAt') DESC)
         WHERE collection = 'referralFormSubmissions'`,
      `CREATE OR REPLACE FUNCTION voxera_reject_submitted_referral_evidence_change()
       RETURNS trigger AS $$
       BEGIN
         IF OLD.collection = 'referralFormSubmissions' AND OLD.body ->> 'status' = 'submitted' THEN
           RAISE EXCEPTION 'submitted referral evidence is immutable' USING ERRCODE = '55000';
         END IF;
         RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
       END;
       $$ LANGUAGE plpgsql`,
      `DROP TRIGGER IF EXISTS voxera_submitted_referral_evidence_update ON voxera_docs`,
      `CREATE TRIGGER voxera_submitted_referral_evidence_update
         BEFORE UPDATE ON voxera_docs
         FOR EACH ROW EXECUTE FUNCTION voxera_reject_submitted_referral_evidence_change()`,
      `DROP TRIGGER IF EXISTS voxera_submitted_referral_evidence_delete ON voxera_docs`,
      `CREATE TRIGGER voxera_submitted_referral_evidence_delete
         BEFORE DELETE ON voxera_docs
         FOR EACH ROW EXECUTE FUNCTION voxera_reject_submitted_referral_evidence_change()`,
    ],
    sqlite: [
      `CREATE UNIQUE INDEX IF NOT EXISTS docs_referral_form_slug
         ON docs (json_extract(body, '$.slug'))
         WHERE collection = 'referralForms'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS docs_referral_submission_token
         ON docs (json_extract(body, '$.tokenHash'))
         WHERE collection = 'referralFormSubmissions'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS docs_referral_submission_referral
         ON docs (json_extract(body, '$.referralFormSubmissionId'))
         WHERE collection = 'referrals' AND COALESCE(json_extract(body, '$.referralFormSubmissionId'), '') <> ''`,
      `CREATE INDEX IF NOT EXISTS docs_referral_form_state
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.active'), seq DESC)
         WHERE collection = 'referralForms'`,
      `CREATE INDEX IF NOT EXISTS docs_referral_submission_queue
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.referralFormId'), json_extract(body, '$.status'), json_extract(body, '$.createdAt') DESC)
         WHERE collection = 'referralFormSubmissions'`,
      `DROP TRIGGER IF EXISTS docs_submitted_referral_evidence_update`,
      `CREATE TRIGGER docs_submitted_referral_evidence_update
         BEFORE UPDATE ON docs
         WHEN OLD.collection = 'referralFormSubmissions'
          AND json_extract(OLD.body, '$.status') = 'submitted'
         BEGIN
           SELECT RAISE(ABORT, 'submitted referral evidence is immutable');
         END`,
      `DROP TRIGGER IF EXISTS docs_submitted_referral_evidence_delete`,
      `CREATE TRIGGER docs_submitted_referral_evidence_delete
         BEFORE DELETE ON docs
         WHEN OLD.collection = 'referralFormSubmissions'
          AND json_extract(OLD.body, '$.status') = 'submitted'
         BEGIN
           SELECT RAISE(ABORT, 'submitted referral evidence is immutable');
         END`,
    ],
  },
  {
    id: '20260920_010_tasks_and_constrained_automations',
    description: 'Administrative task queues, immutable automation evidence, version uniqueness and idempotent runs',
    postgres: [
      `CREATE INDEX IF NOT EXISTS voxera_docs_task_queue
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'state'), (body ->> 'assigneeId'), (body ->> 'dueAt'), seq DESC)
         WHERE collection = 'tasks'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_task_resource
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'resourceType'), (body ->> 'resourceId'), (body ->> 'state'), seq DESC)
         WHERE collection = 'tasks'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS voxera_docs_automation_event_source
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'trigger'), (body ->> 'sourceEventId'))
         WHERE collection = 'automationEvents'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_automation_event_trigger
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'trigger'), (body ->> 'occurredAt') DESC)
         WHERE collection = 'automationEvents'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS voxera_docs_automation_rule_version
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'ruleId'), ((body ->> 'version')::int))
         WHERE collection = 'automationRuleVersions'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_automation_rules_active
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'trigger'), (body ->> 'active'), seq DESC)
         WHERE collection = 'automationRules' AND COALESCE(body ->> 'archivedAt', '') = ''`,
      `CREATE UNIQUE INDEX IF NOT EXISTS voxera_docs_automation_run_idempotency
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'idempotencyKey'))
         WHERE collection = 'automationRuns'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_automation_runs_rule
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'ruleId'), (body ->> 'state'), (body ->> 'startedAt') DESC)
         WHERE collection = 'automationRuns'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_automation_notifications
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'readAt'), seq DESC)
         WHERE collection = 'automationNotifications'`,
      `CREATE OR REPLACE FUNCTION voxera_reject_immutable_automation_evidence_change()
       RETURNS trigger AS $$
       BEGIN
         IF OLD.collection IN ('automationEvents', 'automationRuleVersions')
            AND COALESCE(current_setting('voxera.allow_immutable_maintenance', true), 'off') <> 'on' THEN
           RAISE EXCEPTION 'collection % is append-only automation evidence', OLD.collection USING ERRCODE = '55000';
         END IF;
         RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
       END;
       $$ LANGUAGE plpgsql`,
      `DROP TRIGGER IF EXISTS voxera_immutable_automation_evidence_update ON voxera_docs`,
      `CREATE TRIGGER voxera_immutable_automation_evidence_update
         BEFORE UPDATE ON voxera_docs
         FOR EACH ROW EXECUTE FUNCTION voxera_reject_immutable_automation_evidence_change()`,
      `DROP TRIGGER IF EXISTS voxera_immutable_automation_evidence_delete ON voxera_docs`,
      `CREATE TRIGGER voxera_immutable_automation_evidence_delete
         BEFORE DELETE ON voxera_docs
         FOR EACH ROW EXECUTE FUNCTION voxera_reject_immutable_automation_evidence_change()`,
    ],
    sqlite: [
      `CREATE INDEX IF NOT EXISTS docs_task_queue
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.state'), json_extract(body, '$.assigneeId'), json_extract(body, '$.dueAt'), seq DESC)
         WHERE collection = 'tasks'`,
      `CREATE INDEX IF NOT EXISTS docs_task_resource
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.resourceType'), json_extract(body, '$.resourceId'), json_extract(body, '$.state'), seq DESC)
         WHERE collection = 'tasks'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS docs_automation_event_source
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.trigger'), json_extract(body, '$.sourceEventId'))
         WHERE collection = 'automationEvents'`,
      `CREATE INDEX IF NOT EXISTS docs_automation_event_trigger
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.trigger'), json_extract(body, '$.occurredAt') DESC)
         WHERE collection = 'automationEvents'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS docs_automation_rule_version
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.ruleId'), CAST(json_extract(body, '$.version') AS INTEGER))
         WHERE collection = 'automationRuleVersions'`,
      `CREATE INDEX IF NOT EXISTS docs_automation_rules_active
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.trigger'), json_extract(body, '$.active'), seq DESC)
         WHERE collection = 'automationRules' AND COALESCE(json_extract(body, '$.archivedAt'), '') = ''`,
      `CREATE UNIQUE INDEX IF NOT EXISTS docs_automation_run_idempotency
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.idempotencyKey'))
         WHERE collection = 'automationRuns'`,
      `CREATE INDEX IF NOT EXISTS docs_automation_runs_rule
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.ruleId'), json_extract(body, '$.state'), json_extract(body, '$.startedAt') DESC)
         WHERE collection = 'automationRuns'`,
      `CREATE INDEX IF NOT EXISTS docs_automation_notifications
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.readAt'), seq DESC)
         WHERE collection = 'automationNotifications'`,
      `DROP TRIGGER IF EXISTS docs_immutable_automation_evidence_update`,
      `CREATE TRIGGER docs_immutable_automation_evidence_update
         BEFORE UPDATE ON docs
         WHEN OLD.collection IN ('automationEvents', 'automationRuleVersions')
          AND COALESCE((SELECT allow_immutable_mutation FROM voxera_maintenance_state WHERE id = 1), 0) = 0
         BEGIN
           SELECT RAISE(ABORT, 'append-only automation evidence');
         END`,
      `DROP TRIGGER IF EXISTS docs_immutable_automation_evidence_delete`,
      `CREATE TRIGGER docs_immutable_automation_evidence_delete
         BEFORE DELETE ON docs
         WHEN OLD.collection IN ('automationEvents', 'automationRuleVersions')
          AND COALESCE((SELECT allow_immutable_mutation FROM voxera_maintenance_state WHERE id = 1), 0) = 0
         BEGIN
           SELECT RAISE(ABORT, 'append-only automation evidence');
         END`,
    ],
  },
  {
    id: '20260920_011_phase3_corrections_and_referral_notifications',
    description: 'Unique linked letter corrections and durable referral-notification lookup evidence',
    postgres: [
      `CREATE UNIQUE INDEX IF NOT EXISTS voxera_docs_letter_correction_source
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'correctsLetterId'))
         WHERE collection = 'letters' AND COALESCE(body ->> 'correctsLetterId', '') <> ''`,
      `CREATE UNIQUE INDEX IF NOT EXISTS voxera_docs_referral_notification_revision
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'referralId'), ((body ->> 'referralRevision')::int))
         WHERE collection = 'referralNotifications'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_referral_notification_state
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'referralId'), (body ->> 'state'), (body ->> 'requestedAt') DESC)
         WHERE collection = 'referralNotifications'`,
      `CREATE OR REPLACE FUNCTION voxera_guard_final_letter_evidence()
       RETURNS trigger AS $$
       BEGIN
         IF OLD.collection = 'letters'
            AND COALESCE(OLD.body ->> 'artifactHash', '') <> ''
            AND COALESCE(current_setting('voxera.allow_immutable_maintenance', true), 'off') <> 'on' THEN
           IF TG_OP = 'DELETE' THEN
             RAISE EXCEPTION 'finalised letter evidence is immutable' USING ERRCODE = '55000';
           ELSIF (OLD.body -> 'snapshot') IS DISTINCT FROM (NEW.body -> 'snapshot')
              OR ROW(
                OLD.body ->> 'orgId', OLD.body ->> 'templateId', OLD.body ->> 'templateVersion',
                OLD.body ->> 'clientId', OLD.body ->> 'referralId', OLD.body ->> 'bookingId',
                OLD.body ->> 'currentVersion', OLD.body ->> 'requiresApproval',
                OLD.body ->> 'approvedBy', OLD.body ->> 'approvedAt',
                OLD.body ->> 'finalisedBy', OLD.body ->> 'finalisedAt',
                OLD.body ->> 'artifactHash', OLD.body ->> 'artifactDocumentId', OLD.body ->> 'artifactVersionId',
                OLD.body ->> 'correctsLetterId', OLD.body ->> 'correctionReason', OLD.body ->> 'createdAt'
              ) IS DISTINCT FROM ROW(
                NEW.body ->> 'orgId', NEW.body ->> 'templateId', NEW.body ->> 'templateVersion',
                NEW.body ->> 'clientId', NEW.body ->> 'referralId', NEW.body ->> 'bookingId',
                NEW.body ->> 'currentVersion', NEW.body ->> 'requiresApproval',
                NEW.body ->> 'approvedBy', NEW.body ->> 'approvedAt',
                NEW.body ->> 'finalisedBy', NEW.body ->> 'finalisedAt',
                NEW.body ->> 'artifactHash', NEW.body ->> 'artifactDocumentId', NEW.body ->> 'artifactVersionId',
                NEW.body ->> 'correctsLetterId', NEW.body ->> 'correctionReason', NEW.body ->> 'createdAt'
              ) THEN
             RAISE EXCEPTION 'finalised letter evidence is immutable' USING ERRCODE = '55000';
           END IF;
         END IF;
         RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
       END;
       $$ LANGUAGE plpgsql`,
      `DROP TRIGGER IF EXISTS voxera_final_letter_evidence_guard ON voxera_docs`,
      `CREATE TRIGGER voxera_final_letter_evidence_guard
         BEFORE UPDATE OR DELETE ON voxera_docs
         FOR EACH ROW EXECUTE FUNCTION voxera_guard_final_letter_evidence()`,
    ],
    sqlite: [
      `CREATE UNIQUE INDEX IF NOT EXISTS docs_letter_correction_source
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.correctsLetterId'))
         WHERE collection = 'letters' AND COALESCE(json_extract(body, '$.correctsLetterId'), '') <> ''`,
      `CREATE UNIQUE INDEX IF NOT EXISTS docs_referral_notification_revision
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.referralId'), CAST(json_extract(body, '$.referralRevision') AS INTEGER))
         WHERE collection = 'referralNotifications'`,
      `CREATE INDEX IF NOT EXISTS docs_referral_notification_state
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.referralId'), json_extract(body, '$.state'), json_extract(body, '$.requestedAt') DESC)
         WHERE collection = 'referralNotifications'`,
      `DROP TRIGGER IF EXISTS docs_final_letter_evidence_update`,
      `CREATE TRIGGER docs_final_letter_evidence_update
         BEFORE UPDATE ON docs
         WHEN OLD.collection = 'letters'
          AND COALESCE(json_extract(OLD.body, '$.artifactHash'), '') <> ''
          AND COALESCE((SELECT allow_immutable_mutation FROM voxera_maintenance_state WHERE id = 1), 0) = 0
          AND (
            json_extract(OLD.body, '$.snapshot') IS NOT json_extract(NEW.body, '$.snapshot')
            OR json_extract(OLD.body, '$.orgId') IS NOT json_extract(NEW.body, '$.orgId')
            OR json_extract(OLD.body, '$.templateId') IS NOT json_extract(NEW.body, '$.templateId')
            OR json_extract(OLD.body, '$.templateVersion') IS NOT json_extract(NEW.body, '$.templateVersion')
            OR json_extract(OLD.body, '$.clientId') IS NOT json_extract(NEW.body, '$.clientId')
            OR json_extract(OLD.body, '$.referralId') IS NOT json_extract(NEW.body, '$.referralId')
            OR json_extract(OLD.body, '$.bookingId') IS NOT json_extract(NEW.body, '$.bookingId')
            OR json_extract(OLD.body, '$.currentVersion') IS NOT json_extract(NEW.body, '$.currentVersion')
            OR json_extract(OLD.body, '$.requiresApproval') IS NOT json_extract(NEW.body, '$.requiresApproval')
            OR json_extract(OLD.body, '$.approvedBy') IS NOT json_extract(NEW.body, '$.approvedBy')
            OR json_extract(OLD.body, '$.approvedAt') IS NOT json_extract(NEW.body, '$.approvedAt')
            OR json_extract(OLD.body, '$.finalisedBy') IS NOT json_extract(NEW.body, '$.finalisedBy')
            OR json_extract(OLD.body, '$.finalisedAt') IS NOT json_extract(NEW.body, '$.finalisedAt')
            OR json_extract(OLD.body, '$.artifactHash') IS NOT json_extract(NEW.body, '$.artifactHash')
            OR json_extract(OLD.body, '$.artifactDocumentId') IS NOT json_extract(NEW.body, '$.artifactDocumentId')
            OR json_extract(OLD.body, '$.artifactVersionId') IS NOT json_extract(NEW.body, '$.artifactVersionId')
            OR json_extract(OLD.body, '$.correctsLetterId') IS NOT json_extract(NEW.body, '$.correctsLetterId')
            OR json_extract(OLD.body, '$.correctionReason') IS NOT json_extract(NEW.body, '$.correctionReason')
            OR json_extract(OLD.body, '$.createdAt') IS NOT json_extract(NEW.body, '$.createdAt')
          )
         BEGIN
           SELECT RAISE(ABORT, 'finalised letter evidence is immutable');
         END`,
      `DROP TRIGGER IF EXISTS docs_final_letter_evidence_delete`,
      `CREATE TRIGGER docs_final_letter_evidence_delete
         BEFORE DELETE ON docs
         WHEN OLD.collection = 'letters'
          AND COALESCE(json_extract(OLD.body, '$.artifactHash'), '') <> ''
          AND COALESCE((SELECT allow_immutable_mutation FROM voxera_maintenance_state WHERE id = 1), 0) = 0
         BEGIN
           SELECT RAISE(ABORT, 'finalised letter evidence is immutable');
         END`,
    ],
  },
  {
    id: '20260920_012_phase4_versioned_clinical_notes',
    description: 'Immutable clinical-template versions, signed note snapshots, optimistic indexes and final-note database guards',
    postgres: [
      `INSERT INTO voxera_docs (collection, id, body)
       SELECT
         'noteTemplateVersions',
         body ->> 'id' || '_v1',
         jsonb_strip_nulls(jsonb_build_object(
           'id', body ->> 'id' || '_v1',
           'orgId', body ->> 'orgId',
           'templateId', body ->> 'id',
           'version', 1,
           'name', COALESCE(body ->> 'name', 'Clinical note template'),
           'serviceId', body ->> 'serviceId',
           'sections', COALESCE(body -> 'sections', '[]'::jsonb),
           'state', CASE WHEN COALESCE(body ->> 'active', 'true') = 'false' THEN 'retired' ELSE 'published' END,
           'changeReason', 'Imported from the legacy clinical template record',
           'provenance', 'legacy_migration',
           'createdAt', COALESCE(body ->> 'createdAt', now()::text),
           'updatedAt', COALESCE(body ->> 'createdAt', now()::text),
           'revision', 1
         ))
       FROM voxera_docs
       WHERE collection = 'noteTemplates'
       ON CONFLICT (collection, id) DO NOTHING`,
      `UPDATE voxera_docs
       SET body = body || jsonb_build_object(
         'state', CASE WHEN COALESCE(body ->> 'active', 'true') = 'false' THEN 'retired' ELSE COALESCE(body ->> 'state', 'published') END,
         'currentVersion', COALESCE((body ->> 'currentVersion')::int, 1),
         'currentVersionId', COALESCE(body ->> 'currentVersionId', body ->> 'id' || '_v1'),
         'revision', COALESCE((body ->> 'revision')::int, 1)
       )
       WHERE collection = 'noteTemplates'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS voxera_docs_note_template_version
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'templateId'), ((body ->> 'version')::int))
         WHERE collection = 'noteTemplateVersions'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_clinical_notes_client
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'clientId'), (body ->> 'status'), seq DESC)
         WHERE collection = 'notes'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS voxera_docs_clinical_note_version
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'noteId'), ((body ->> 'version')::int))
         WHERE collection = 'clinicalNoteVersions'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_clinical_note_conflict
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'noteId'), (body ->> 'occurredAt') DESC)
         WHERE collection = 'clinicalNoteDraftConflicts'`,
      `CREATE OR REPLACE FUNCTION voxera_reject_clinical_version_change()
       RETURNS trigger AS $$
       BEGIN
         IF OLD.collection IN ('noteTemplateVersions', 'clinicalNoteVersions')
            AND COALESCE(current_setting('voxera.allow_immutable_maintenance', true), 'off') <> 'on' THEN
           RAISE EXCEPTION 'collection % is append-only', OLD.collection USING ERRCODE = '55000';
         END IF;
         RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
       END;
       $$ LANGUAGE plpgsql`,
      `DROP TRIGGER IF EXISTS voxera_clinical_versions_immutable ON voxera_docs`,
      `CREATE TRIGGER voxera_clinical_versions_immutable
         BEFORE UPDATE OR DELETE ON voxera_docs
         FOR EACH ROW EXECUTE FUNCTION voxera_reject_clinical_version_change()`,
      `CREATE OR REPLACE FUNCTION voxera_guard_final_clinical_note()
       RETURNS trigger AS $$
       BEGIN
         IF OLD.collection = 'notes'
            AND OLD.body ->> 'status' = 'final'
            AND COALESCE(current_setting('voxera.allow_immutable_maintenance', true), 'off') <> 'on' THEN
           IF TG_OP = 'DELETE' THEN
             RAISE EXCEPTION 'final clinical-note content and signature are immutable' USING ERRCODE = '55000';
           ELSIF ROW(
             OLD.body -> 'sections', OLD.body ->> 'body', OLD.body ->> 'title', OLD.body ->> 'clientId',
             OLD.body ->> 'templateId', OLD.body ->> 'templateVersionId', OLD.body ->> 'templateVersion',
             OLD.body ->> 'signerId', OLD.body ->> 'signerName', OLD.body ->> 'signedAt',
             OLD.body ->> 'signedHash', OLD.body ->> 'lastFinalisedVersion', OLD.body -> 'versions'
           ) IS DISTINCT FROM ROW(
             NEW.body -> 'sections', NEW.body ->> 'body', NEW.body ->> 'title', NEW.body ->> 'clientId',
             NEW.body ->> 'templateId', NEW.body ->> 'templateVersionId', NEW.body ->> 'templateVersion',
             NEW.body ->> 'signerId', NEW.body ->> 'signerName', NEW.body ->> 'signedAt',
             NEW.body ->> 'signedHash', NEW.body ->> 'lastFinalisedVersion', NEW.body -> 'versions'
           ) THEN
             RAISE EXCEPTION 'final clinical-note content and signature are immutable' USING ERRCODE = '55000';
           END IF;
         END IF;
         RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
       END;
       $$ LANGUAGE plpgsql`,
      `DROP TRIGGER IF EXISTS voxera_final_clinical_note_guard ON voxera_docs`,
      `CREATE TRIGGER voxera_final_clinical_note_guard
         BEFORE UPDATE OR DELETE ON voxera_docs
         FOR EACH ROW EXECUTE FUNCTION voxera_guard_final_clinical_note()`,
    ],
    sqlite: [
      `INSERT OR IGNORE INTO docs (collection, id, pos, body)
       SELECT
         'noteTemplateVersions',
         json_extract(body, '$.id') || '_v1',
         0,
         json_object(
           'id', json_extract(body, '$.id') || '_v1',
           'orgId', json_extract(body, '$.orgId'),
           'templateId', json_extract(body, '$.id'),
           'version', 1,
           'name', COALESCE(json_extract(body, '$.name'), 'Clinical note template'),
           'serviceId', json_extract(body, '$.serviceId'),
           'sections', json(COALESCE(json_extract(body, '$.sections'), '[]')),
           'state', CASE WHEN COALESCE(json_extract(body, '$.active'), 1) = 0 THEN 'retired' ELSE 'published' END,
           'changeReason', 'Imported from the legacy clinical template record',
           'provenance', 'legacy_migration',
           'createdAt', COALESCE(json_extract(body, '$.createdAt'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
           'updatedAt', COALESCE(json_extract(body, '$.createdAt'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
           'revision', 1
         )
       FROM docs
       WHERE collection = 'noteTemplates'`,
      `UPDATE docs
       SET body = json_set(
         body,
         '$.state', CASE WHEN COALESCE(json_extract(body, '$.active'), 1) = 0 THEN 'retired' ELSE COALESCE(json_extract(body, '$.state'), 'published') END,
         '$.currentVersion', COALESCE(json_extract(body, '$.currentVersion'), 1),
         '$.currentVersionId', COALESCE(json_extract(body, '$.currentVersionId'), json_extract(body, '$.id') || '_v1'),
         '$.revision', COALESCE(json_extract(body, '$.revision'), 1)
       )
       WHERE collection = 'noteTemplates'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS docs_note_template_version
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.templateId'), CAST(json_extract(body, '$.version') AS INTEGER))
         WHERE collection = 'noteTemplateVersions'`,
      `CREATE INDEX IF NOT EXISTS docs_clinical_notes_client
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.clientId'), json_extract(body, '$.status'), seq DESC)
         WHERE collection = 'notes'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS docs_clinical_note_version
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.noteId'), CAST(json_extract(body, '$.version') AS INTEGER))
         WHERE collection = 'clinicalNoteVersions'`,
      `CREATE INDEX IF NOT EXISTS docs_clinical_note_conflict
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.noteId'), json_extract(body, '$.occurredAt') DESC)
         WHERE collection = 'clinicalNoteDraftConflicts'`,
      `DROP TRIGGER IF EXISTS docs_clinical_versions_immutable_update`,
      `CREATE TRIGGER docs_clinical_versions_immutable_update
         BEFORE UPDATE ON docs
         WHEN OLD.collection IN ('noteTemplateVersions', 'clinicalNoteVersions')
          AND COALESCE((SELECT allow_immutable_mutation FROM voxera_maintenance_state WHERE id = 1), 0) = 0
         BEGIN
           SELECT RAISE(ABORT, 'collection is append-only');
         END`,
      `DROP TRIGGER IF EXISTS docs_clinical_versions_immutable_delete`,
      `CREATE TRIGGER docs_clinical_versions_immutable_delete
         BEFORE DELETE ON docs
         WHEN OLD.collection IN ('noteTemplateVersions', 'clinicalNoteVersions')
          AND COALESCE((SELECT allow_immutable_mutation FROM voxera_maintenance_state WHERE id = 1), 0) = 0
         BEGIN
           SELECT RAISE(ABORT, 'collection is append-only');
         END`,
      `DROP TRIGGER IF EXISTS docs_final_clinical_note_update`,
      `CREATE TRIGGER docs_final_clinical_note_update
         BEFORE UPDATE ON docs
         WHEN OLD.collection = 'notes'
          AND json_extract(OLD.body, '$.status') = 'final'
          AND COALESCE((SELECT allow_immutable_mutation FROM voxera_maintenance_state WHERE id = 1), 0) = 0
          AND (
            json_extract(OLD.body, '$.sections') IS NOT json_extract(NEW.body, '$.sections')
            OR json_extract(OLD.body, '$.body') IS NOT json_extract(NEW.body, '$.body')
            OR json_extract(OLD.body, '$.title') IS NOT json_extract(NEW.body, '$.title')
            OR json_extract(OLD.body, '$.clientId') IS NOT json_extract(NEW.body, '$.clientId')
            OR json_extract(OLD.body, '$.templateId') IS NOT json_extract(NEW.body, '$.templateId')
            OR json_extract(OLD.body, '$.templateVersionId') IS NOT json_extract(NEW.body, '$.templateVersionId')
            OR json_extract(OLD.body, '$.templateVersion') IS NOT json_extract(NEW.body, '$.templateVersion')
            OR json_extract(OLD.body, '$.signerId') IS NOT json_extract(NEW.body, '$.signerId')
            OR json_extract(OLD.body, '$.signerName') IS NOT json_extract(NEW.body, '$.signerName')
            OR json_extract(OLD.body, '$.signedAt') IS NOT json_extract(NEW.body, '$.signedAt')
            OR json_extract(OLD.body, '$.signedHash') IS NOT json_extract(NEW.body, '$.signedHash')
            OR json_extract(OLD.body, '$.lastFinalisedVersion') IS NOT json_extract(NEW.body, '$.lastFinalisedVersion')
            OR json_extract(OLD.body, '$.versions') IS NOT json_extract(NEW.body, '$.versions')
          )
         BEGIN
           SELECT RAISE(ABORT, 'final clinical-note content and signature are immutable');
         END`,
      `DROP TRIGGER IF EXISTS docs_final_clinical_note_delete`,
      `CREATE TRIGGER docs_final_clinical_note_delete
         BEFORE DELETE ON docs
         WHEN OLD.collection = 'notes'
          AND json_extract(OLD.body, '$.status') = 'final'
          AND COALESCE((SELECT allow_immutable_mutation FROM voxera_maintenance_state WHERE id = 1), 0) = 0
         BEGIN
           SELECT RAISE(ABORT, 'final clinical-note content and signature are immutable');
         END`,
    ],
  },
  {
    id: '20260920_013_phase4_body_chart_evidence',
    description: 'Normalised body-chart annotations, signed snapshots and storage-level immutability guards',
    postgres: [
      `CREATE INDEX IF NOT EXISTS voxera_docs_body_chart_templates_state
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'state'), seq DESC)
         WHERE collection = 'bodyChartTemplates'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_body_chart_annotations_note
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'noteId'), (body ->> 'status'), seq DESC)
         WHERE collection = 'bodyChartAnnotations'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS voxera_docs_body_chart_annotation_version
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'annotationId'), ((body ->> 'noteVersion')::int))
         WHERE collection = 'bodyChartAnnotationVersions'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_body_chart_conflicts_note
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'noteId'), (body ->> 'occurredAt') DESC)
         WHERE collection = 'bodyChartAnnotationConflicts'`,
      `CREATE OR REPLACE FUNCTION voxera_reject_body_chart_version_change()
       RETURNS trigger AS $$
       BEGIN
         IF OLD.collection = 'bodyChartAnnotationVersions'
            AND COALESCE(current_setting('voxera.allow_immutable_maintenance', true), 'off') <> 'on' THEN
           RAISE EXCEPTION 'body-chart annotation versions are append-only' USING ERRCODE = '55000';
         END IF;
         RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
       END;
       $$ LANGUAGE plpgsql`,
      `DROP TRIGGER IF EXISTS voxera_body_chart_versions_immutable ON voxera_docs`,
      `CREATE TRIGGER voxera_body_chart_versions_immutable
         BEFORE UPDATE OR DELETE ON voxera_docs
         FOR EACH ROW EXECUTE FUNCTION voxera_reject_body_chart_version_change()`,
      `CREATE OR REPLACE FUNCTION voxera_validate_body_chart_evidence()
       RETURNS trigger AS $$
       BEGIN
         IF NEW.collection = 'bodyChartAnnotationVersions'
            AND COALESCE(NEW.body ->> 'contentHash', '') !~ '^[a-f0-9]{64}$' THEN
           RAISE EXCEPTION 'body-chart annotation version needs a SHA-256 content hash' USING ERRCODE = '23514';
         END IF;
         IF NEW.collection = 'bodyChartAnnotations' AND NEW.body ->> 'status' = 'final'
            AND (COALESCE(NEW.body ->> 'finalisedAt', '') = ''
              OR COALESCE(NEW.body ->> 'finalisedBy', '') = ''
              OR COALESCE(NEW.body ->> 'lastSnapshotHash', '') !~ '^[a-f0-9]{64}$') THEN
           RAISE EXCEPTION 'final body-chart annotation needs signed snapshot evidence' USING ERRCODE = '23514';
         END IF;
         RETURN NEW;
       END;
       $$ LANGUAGE plpgsql`,
      `DROP TRIGGER IF EXISTS voxera_body_chart_evidence_valid ON voxera_docs`,
      `CREATE TRIGGER voxera_body_chart_evidence_valid
         BEFORE INSERT OR UPDATE ON voxera_docs
         FOR EACH ROW EXECUTE FUNCTION voxera_validate_body_chart_evidence()`,
      `CREATE OR REPLACE FUNCTION voxera_guard_final_body_chart()
       RETURNS trigger AS $$
       BEGIN
         IF OLD.collection = 'bodyChartAnnotations' AND OLD.body ->> 'status' = 'final'
            AND COALESCE(current_setting('voxera.allow_immutable_maintenance', true), 'off') <> 'on' THEN
           IF TG_OP = 'DELETE' THEN
             RAISE EXCEPTION 'final body-chart annotations are immutable' USING ERRCODE = '55000';
           ELSIF ROW(
             OLD.body ->> 'orgId', OLD.body ->> 'noteId', OLD.body ->> 'clientId', OLD.body ->> 'sectionId',
             OLD.body ->> 'templateId', OLD.body ->> 'sourceDocumentId', OLD.body ->> 'sourceDocumentVersionId',
             OLD.body ->> 'coordinateSystem', OLD.body -> 'marks', OLD.body ->> 'authorId', OLD.body ->> 'createdAt',
             OLD.body ->> 'finalisedAt', OLD.body ->> 'finalisedBy', OLD.body ->> 'lastSnapshotHash'
           ) IS DISTINCT FROM ROW(
             NEW.body ->> 'orgId', NEW.body ->> 'noteId', NEW.body ->> 'clientId', NEW.body ->> 'sectionId',
             NEW.body ->> 'templateId', NEW.body ->> 'sourceDocumentId', NEW.body ->> 'sourceDocumentVersionId',
             NEW.body ->> 'coordinateSystem', NEW.body -> 'marks', NEW.body ->> 'authorId', NEW.body ->> 'createdAt',
             NEW.body ->> 'finalisedAt', NEW.body ->> 'finalisedBy', NEW.body ->> 'lastSnapshotHash'
           ) THEN
             RAISE EXCEPTION 'final body-chart annotations are immutable' USING ERRCODE = '55000';
           END IF;
         END IF;
         IF OLD.collection = 'bodyChartTemplates' AND OLD.body ->> 'state' = 'published'
            AND COALESCE(current_setting('voxera.allow_immutable_maintenance', true), 'off') <> 'on' THEN
           IF TG_OP = 'DELETE' THEN
             RAISE EXCEPTION 'published body-chart templates cannot be deleted' USING ERRCODE = '55000';
           ELSIF ROW(OLD.body ->> 'title', OLD.body ->> 'sourceDocumentId', OLD.body ->> 'sourceDocumentVersionId', OLD.body ->> 'sourceMimeType', OLD.body ->> 'coordinateSystem')
                IS DISTINCT FROM
                ROW(NEW.body ->> 'title', NEW.body ->> 'sourceDocumentId', NEW.body ->> 'sourceDocumentVersionId', NEW.body ->> 'sourceMimeType', NEW.body ->> 'coordinateSystem') THEN
             RAISE EXCEPTION 'published body-chart template source is immutable' USING ERRCODE = '55000';
           END IF;
         END IF;
         RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
       END;
       $$ LANGUAGE plpgsql`,
      `DROP TRIGGER IF EXISTS voxera_final_body_chart_guard ON voxera_docs`,
      `CREATE TRIGGER voxera_final_body_chart_guard
         BEFORE UPDATE OR DELETE ON voxera_docs
         FOR EACH ROW EXECUTE FUNCTION voxera_guard_final_body_chart()`,
    ],
    sqlite: [
      `CREATE INDEX IF NOT EXISTS docs_body_chart_templates_state
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.state'), seq DESC)
         WHERE collection = 'bodyChartTemplates'`,
      `CREATE INDEX IF NOT EXISTS docs_body_chart_annotations_note
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.noteId'), json_extract(body, '$.status'), seq DESC)
         WHERE collection = 'bodyChartAnnotations'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS docs_body_chart_annotation_version
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.annotationId'), CAST(json_extract(body, '$.noteVersion') AS INTEGER))
         WHERE collection = 'bodyChartAnnotationVersions'`,
      `CREATE INDEX IF NOT EXISTS docs_body_chart_conflicts_note
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.noteId'), json_extract(body, '$.occurredAt') DESC)
         WHERE collection = 'bodyChartAnnotationConflicts'`,
      `DROP TRIGGER IF EXISTS docs_body_chart_versions_immutable_update`,
      `CREATE TRIGGER docs_body_chart_versions_immutable_update
         BEFORE UPDATE ON docs
         WHEN OLD.collection = 'bodyChartAnnotationVersions'
          AND COALESCE((SELECT allow_immutable_mutation FROM voxera_maintenance_state WHERE id = 1), 0) = 0
         BEGIN
           SELECT RAISE(ABORT, 'body-chart annotation versions are append-only');
         END`,
      `DROP TRIGGER IF EXISTS docs_body_chart_versions_immutable_delete`,
      `CREATE TRIGGER docs_body_chart_versions_immutable_delete
         BEFORE DELETE ON docs
         WHEN OLD.collection = 'bodyChartAnnotationVersions'
          AND COALESCE((SELECT allow_immutable_mutation FROM voxera_maintenance_state WHERE id = 1), 0) = 0
         BEGIN
           SELECT RAISE(ABORT, 'body-chart annotation versions are append-only');
         END`,
      `DROP TRIGGER IF EXISTS docs_body_chart_version_hash_insert`,
      `CREATE TRIGGER docs_body_chart_version_hash_insert
         BEFORE INSERT ON docs
         WHEN NEW.collection = 'bodyChartAnnotationVersions'
          AND (length(COALESCE(json_extract(NEW.body, '$.contentHash'), '')) <> 64
            OR json_extract(NEW.body, '$.contentHash') GLOB '*[^a-f0-9]*')
         BEGIN
           SELECT RAISE(ABORT, 'body-chart annotation version needs a SHA-256 content hash');
         END`,
      `DROP TRIGGER IF EXISTS docs_body_chart_final_evidence_insert`,
      `CREATE TRIGGER docs_body_chart_final_evidence_insert
         BEFORE INSERT ON docs
         WHEN NEW.collection = 'bodyChartAnnotations' AND json_extract(NEW.body, '$.status') = 'final'
          AND (COALESCE(json_extract(NEW.body, '$.finalisedAt'), '') = ''
            OR COALESCE(json_extract(NEW.body, '$.finalisedBy'), '') = ''
            OR length(COALESCE(json_extract(NEW.body, '$.lastSnapshotHash'), '')) <> 64
            OR json_extract(NEW.body, '$.lastSnapshotHash') GLOB '*[^a-f0-9]*')
         BEGIN
           SELECT RAISE(ABORT, 'final body-chart annotation needs signed snapshot evidence');
         END`,
      `DROP TRIGGER IF EXISTS docs_body_chart_final_evidence_update`,
      `CREATE TRIGGER docs_body_chart_final_evidence_update
         BEFORE UPDATE ON docs
         WHEN NEW.collection = 'bodyChartAnnotations' AND json_extract(NEW.body, '$.status') = 'final'
          AND (COALESCE(json_extract(NEW.body, '$.finalisedAt'), '') = ''
            OR COALESCE(json_extract(NEW.body, '$.finalisedBy'), '') = ''
            OR length(COALESCE(json_extract(NEW.body, '$.lastSnapshotHash'), '')) <> 64
            OR json_extract(NEW.body, '$.lastSnapshotHash') GLOB '*[^a-f0-9]*')
         BEGIN
           SELECT RAISE(ABORT, 'final body-chart annotation needs signed snapshot evidence');
         END`,
      `DROP TRIGGER IF EXISTS docs_final_body_chart_update`,
      `CREATE TRIGGER docs_final_body_chart_update
         BEFORE UPDATE ON docs
         WHEN OLD.collection = 'bodyChartAnnotations'
          AND json_extract(OLD.body, '$.status') = 'final'
          AND COALESCE((SELECT allow_immutable_mutation FROM voxera_maintenance_state WHERE id = 1), 0) = 0
          AND (
            json_extract(OLD.body, '$.orgId') IS NOT json_extract(NEW.body, '$.orgId')
            OR json_extract(OLD.body, '$.noteId') IS NOT json_extract(NEW.body, '$.noteId')
            OR json_extract(OLD.body, '$.clientId') IS NOT json_extract(NEW.body, '$.clientId')
            OR json_extract(OLD.body, '$.sectionId') IS NOT json_extract(NEW.body, '$.sectionId')
            OR json_extract(OLD.body, '$.templateId') IS NOT json_extract(NEW.body, '$.templateId')
            OR json_extract(OLD.body, '$.sourceDocumentId') IS NOT json_extract(NEW.body, '$.sourceDocumentId')
            OR json_extract(OLD.body, '$.sourceDocumentVersionId') IS NOT json_extract(NEW.body, '$.sourceDocumentVersionId')
            OR json_extract(OLD.body, '$.coordinateSystem') IS NOT json_extract(NEW.body, '$.coordinateSystem')
            OR json_extract(OLD.body, '$.marks') IS NOT json_extract(NEW.body, '$.marks')
            OR json_extract(OLD.body, '$.authorId') IS NOT json_extract(NEW.body, '$.authorId')
            OR json_extract(OLD.body, '$.createdAt') IS NOT json_extract(NEW.body, '$.createdAt')
            OR json_extract(OLD.body, '$.finalisedAt') IS NOT json_extract(NEW.body, '$.finalisedAt')
            OR json_extract(OLD.body, '$.finalisedBy') IS NOT json_extract(NEW.body, '$.finalisedBy')
            OR json_extract(OLD.body, '$.lastSnapshotHash') IS NOT json_extract(NEW.body, '$.lastSnapshotHash')
          )
         BEGIN
           SELECT RAISE(ABORT, 'final body-chart annotations are immutable');
         END`,
      `DROP TRIGGER IF EXISTS docs_final_body_chart_delete`,
      `CREATE TRIGGER docs_final_body_chart_delete
         BEFORE DELETE ON docs
         WHEN OLD.collection = 'bodyChartAnnotations'
          AND json_extract(OLD.body, '$.status') = 'final'
          AND COALESCE((SELECT allow_immutable_mutation FROM voxera_maintenance_state WHERE id = 1), 0) = 0
         BEGIN
           SELECT RAISE(ABORT, 'final body-chart annotations are immutable');
         END`,
      `DROP TRIGGER IF EXISTS docs_published_body_chart_template_update`,
      `CREATE TRIGGER docs_published_body_chart_template_update
         BEFORE UPDATE ON docs
         WHEN OLD.collection = 'bodyChartTemplates'
          AND json_extract(OLD.body, '$.state') = 'published'
          AND COALESCE((SELECT allow_immutable_mutation FROM voxera_maintenance_state WHERE id = 1), 0) = 0
          AND (
            json_extract(OLD.body, '$.title') IS NOT json_extract(NEW.body, '$.title')
            OR json_extract(OLD.body, '$.sourceDocumentId') IS NOT json_extract(NEW.body, '$.sourceDocumentId')
            OR json_extract(OLD.body, '$.sourceDocumentVersionId') IS NOT json_extract(NEW.body, '$.sourceDocumentVersionId')
            OR json_extract(OLD.body, '$.sourceMimeType') IS NOT json_extract(NEW.body, '$.sourceMimeType')
            OR json_extract(OLD.body, '$.coordinateSystem') IS NOT json_extract(NEW.body, '$.coordinateSystem')
          )
         BEGIN
           SELECT RAISE(ABORT, 'published body-chart template source is immutable');
         END`,
      `DROP TRIGGER IF EXISTS docs_published_body_chart_template_delete`,
      `CREATE TRIGGER docs_published_body_chart_template_delete
         BEFORE DELETE ON docs
         WHEN OLD.collection = 'bodyChartTemplates'
          AND json_extract(OLD.body, '$.state') = 'published'
          AND COALESCE((SELECT allow_immutable_mutation FROM voxera_maintenance_state WHERE id = 1), 0) = 0
         BEGIN
           SELECT RAISE(ABORT, 'published body-chart templates cannot be deleted');
         END`,
    ],
  },
  {
    id: '20260920_014_phase4_cases_funding',
    description: 'Native case, coverage and funding indexes with immutable allocation-event evidence',
    postgres: [
      `CREATE UNIQUE INDEX IF NOT EXISTS voxera_docs_case_number
         ON voxera_docs ((body ->> 'orgId'), lower(body ->> 'number'))
         WHERE collection = 'cases'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_cases_patient_status
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'patientId'), (body ->> 'status'), seq DESC)
         WHERE collection = 'cases'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_case_assignments_case
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'caseId'), (body ->> 'userId'), (body ->> 'endsOn'))
         WHERE collection = 'caseAssignments'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_funding_periods_case_date
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'caseId'), (body ->> 'startsOn'), (body ->> 'endsOn'))
         WHERE collection = 'fundingPeriods'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_case_service_rules_match
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'caseId'), (body ->> 'serviceId'), (body ->> 'providerId'), (body ->> 'locationId'))
         WHERE collection = 'caseServiceRules' AND body ->> 'active' = 'true'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS voxera_docs_authorisation_reference
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'caseId'), lower(body ->> 'externalReference'))
         WHERE collection = 'authorisations'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_authorisations_expiry
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'status'), (body ->> 'endsOn'), seq DESC)
         WHERE collection = 'authorisations'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_coverages_patient
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'patientId'), (body ->> 'verificationStatus'), (body ->> 'endsOn'))
         WHERE collection = 'clientCoverages'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_payers_name
         ON voxera_docs ((body ->> 'orgId'), lower(body ->> 'name'))
         WHERE collection = 'payers'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS voxera_docs_encounter_booking
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'bookingId'))
         WHERE collection = 'encounters'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_encounters_patient
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'patientId'), (body ->> 'startsAt') DESC)
         WHERE collection = 'encounters'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_care_plans_patient
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'patientId'), (body ->> 'status'), seq DESC)
         WHERE collection = 'carePlans'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_care_plan_goals_plan
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'carePlanId'), (body ->> 'status'), seq)
         WHERE collection = 'carePlanGoals'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS voxera_docs_funding_event_sequence
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'bookingId'), ((body ->> 'sequence')::int))
         WHERE collection = 'fundingEvents'`,
      `CREATE INDEX IF NOT EXISTS voxera_docs_funding_events_case
         ON voxera_docs ((body ->> 'orgId'), (body ->> 'caseId'), (body ->> 'occurredAt') DESC)
         WHERE collection = 'fundingEvents'`,
      `CREATE OR REPLACE FUNCTION voxera_reject_funding_event_change()
       RETURNS trigger AS $$
       BEGIN
         IF OLD.collection = 'fundingEvents'
            AND COALESCE(current_setting('voxera.allow_immutable_maintenance', true), 'off') <> 'on' THEN
           RAISE EXCEPTION 'funding events are append-only' USING ERRCODE = '55000';
         END IF;
         RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
       END;
       $$ LANGUAGE plpgsql`,
      `DROP TRIGGER IF EXISTS voxera_funding_events_immutable ON voxera_docs`,
      `CREATE TRIGGER voxera_funding_events_immutable
         BEFORE UPDATE OR DELETE ON voxera_docs
         FOR EACH ROW EXECUTE FUNCTION voxera_reject_funding_event_change()`,
      `CREATE OR REPLACE FUNCTION voxera_validate_funding_snapshots()
       RETURNS trigger AS $$
       DECLARE
         field_name text;
         metric_name text;
         metric_value text;
       BEGIN
         IF NEW.collection IN ('fundingPeriods', 'authorisations') THEN
           FOREACH field_name IN ARRAY ARRAY['committed', 'used'] LOOP
             FOREACH metric_name IN ARRAY ARRAY['appointments', 'minutes', 'budgetMinor'] LOOP
               metric_value := NEW.body -> field_name ->> metric_name;
               IF metric_value IS NULL OR metric_value !~ '^[0-9]+$' THEN
                 RAISE EXCEPTION 'funding snapshots need non-negative whole-number metrics' USING ERRCODE = '23514';
               END IF;
             END LOOP;
           END LOOP;
         END IF;
         IF NEW.collection = 'fundingEvents'
            AND (COALESCE(NEW.body ->> 'bookingId', '') = ''
              OR COALESCE(NEW.body ->> 'caseId', '') = ''
              OR COALESCE((NEW.body ->> 'sequence')::int, 0) < 1) THEN
           RAISE EXCEPTION 'funding event evidence is incomplete' USING ERRCODE = '23514';
         END IF;
         RETURN NEW;
       END;
       $$ LANGUAGE plpgsql`,
      `DROP TRIGGER IF EXISTS voxera_funding_snapshots_valid ON voxera_docs`,
      `CREATE TRIGGER voxera_funding_snapshots_valid
         BEFORE INSERT OR UPDATE ON voxera_docs
         FOR EACH ROW EXECUTE FUNCTION voxera_validate_funding_snapshots()`,
    ],
    sqlite: [
      `CREATE UNIQUE INDEX IF NOT EXISTS docs_case_number
         ON docs (json_extract(body, '$.orgId'), lower(json_extract(body, '$.number')))
         WHERE collection = 'cases'`,
      `CREATE INDEX IF NOT EXISTS docs_cases_patient_status
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.patientId'), json_extract(body, '$.status'), seq DESC)
         WHERE collection = 'cases'`,
      `CREATE INDEX IF NOT EXISTS docs_case_assignments_case
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.caseId'), json_extract(body, '$.userId'), json_extract(body, '$.endsOn'))
         WHERE collection = 'caseAssignments'`,
      `CREATE INDEX IF NOT EXISTS docs_funding_periods_case_date
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.caseId'), json_extract(body, '$.startsOn'), json_extract(body, '$.endsOn'))
         WHERE collection = 'fundingPeriods'`,
      `CREATE INDEX IF NOT EXISTS docs_case_service_rules_match
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.caseId'), json_extract(body, '$.serviceId'), json_extract(body, '$.providerId'), json_extract(body, '$.locationId'))
         WHERE collection = 'caseServiceRules' AND json_extract(body, '$.active') = 1`,
      `CREATE UNIQUE INDEX IF NOT EXISTS docs_authorisation_reference
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.caseId'), lower(json_extract(body, '$.externalReference')))
         WHERE collection = 'authorisations'`,
      `CREATE INDEX IF NOT EXISTS docs_authorisations_expiry
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.status'), json_extract(body, '$.endsOn'), seq DESC)
         WHERE collection = 'authorisations'`,
      `CREATE INDEX IF NOT EXISTS docs_coverages_patient
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.patientId'), json_extract(body, '$.verificationStatus'), json_extract(body, '$.endsOn'))
         WHERE collection = 'clientCoverages'`,
      `CREATE INDEX IF NOT EXISTS docs_payers_name
         ON docs (json_extract(body, '$.orgId'), lower(json_extract(body, '$.name')))
         WHERE collection = 'payers'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS docs_encounter_booking
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.bookingId'))
         WHERE collection = 'encounters'`,
      `CREATE INDEX IF NOT EXISTS docs_encounters_patient
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.patientId'), json_extract(body, '$.startsAt') DESC)
         WHERE collection = 'encounters'`,
      `CREATE INDEX IF NOT EXISTS docs_care_plans_patient
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.patientId'), json_extract(body, '$.status'), seq DESC)
         WHERE collection = 'carePlans'`,
      `CREATE INDEX IF NOT EXISTS docs_care_plan_goals_plan
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.carePlanId'), json_extract(body, '$.status'), seq)
         WHERE collection = 'carePlanGoals'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS docs_funding_event_sequence
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.bookingId'), CAST(json_extract(body, '$.sequence') AS INTEGER))
         WHERE collection = 'fundingEvents'`,
      `CREATE INDEX IF NOT EXISTS docs_funding_events_case
         ON docs (json_extract(body, '$.orgId'), json_extract(body, '$.caseId'), json_extract(body, '$.occurredAt') DESC)
         WHERE collection = 'fundingEvents'`,
      `DROP TRIGGER IF EXISTS docs_funding_events_immutable_update`,
      `CREATE TRIGGER docs_funding_events_immutable_update
         BEFORE UPDATE ON docs
         WHEN OLD.collection = 'fundingEvents'
          AND COALESCE((SELECT allow_immutable_mutation FROM voxera_maintenance_state WHERE id = 1), 0) = 0
         BEGIN
           SELECT RAISE(ABORT, 'funding events are append-only');
         END`,
      `DROP TRIGGER IF EXISTS docs_funding_events_immutable_delete`,
      `CREATE TRIGGER docs_funding_events_immutable_delete
         BEFORE DELETE ON docs
         WHEN OLD.collection = 'fundingEvents'
          AND COALESCE((SELECT allow_immutable_mutation FROM voxera_maintenance_state WHERE id = 1), 0) = 0
         BEGIN
           SELECT RAISE(ABORT, 'funding events are append-only');
         END`,
      `DROP TRIGGER IF EXISTS docs_funding_period_snapshot_insert`,
      `CREATE TRIGGER docs_funding_period_snapshot_insert
         BEFORE INSERT ON docs
         WHEN NEW.collection IN ('fundingPeriods', 'authorisations') AND (
           CAST(json_extract(NEW.body, '$.committed.appointments') AS INTEGER) < 0 OR
           CAST(json_extract(NEW.body, '$.committed.minutes') AS INTEGER) < 0 OR
           CAST(json_extract(NEW.body, '$.committed.budgetMinor') AS INTEGER) < 0 OR
           CAST(json_extract(NEW.body, '$.used.appointments') AS INTEGER) < 0 OR
           CAST(json_extract(NEW.body, '$.used.minutes') AS INTEGER) < 0 OR
           CAST(json_extract(NEW.body, '$.used.budgetMinor') AS INTEGER) < 0)
         BEGIN
           SELECT RAISE(ABORT, 'funding snapshots cannot be negative');
         END`,
      `DROP TRIGGER IF EXISTS docs_funding_period_snapshot_update`,
      `CREATE TRIGGER docs_funding_period_snapshot_update
         BEFORE UPDATE ON docs
         WHEN NEW.collection IN ('fundingPeriods', 'authorisations') AND (
           CAST(json_extract(NEW.body, '$.committed.appointments') AS INTEGER) < 0 OR
           CAST(json_extract(NEW.body, '$.committed.minutes') AS INTEGER) < 0 OR
           CAST(json_extract(NEW.body, '$.committed.budgetMinor') AS INTEGER) < 0 OR
           CAST(json_extract(NEW.body, '$.used.appointments') AS INTEGER) < 0 OR
           CAST(json_extract(NEW.body, '$.used.minutes') AS INTEGER) < 0 OR
           CAST(json_extract(NEW.body, '$.used.budgetMinor') AS INTEGER) < 0)
         BEGIN
           SELECT RAISE(ABORT, 'funding snapshots cannot be negative');
         END`,
      `DROP TRIGGER IF EXISTS docs_funding_event_evidence_insert`,
      `CREATE TRIGGER docs_funding_event_evidence_insert
         BEFORE INSERT ON docs
         WHEN NEW.collection = 'fundingEvents' AND (
           COALESCE(json_extract(NEW.body, '$.bookingId'), '') = '' OR
           COALESCE(json_extract(NEW.body, '$.caseId'), '') = '' OR
           CAST(COALESCE(json_extract(NEW.body, '$.sequence'), 0) AS INTEGER) < 1)
         BEGIN
           SELECT RAISE(ABORT, 'funding event evidence is incomplete');
         END`,
    ],
  },
] as const;

export function schemaMigrationChecksum(migration: SchemaMigration, engine: 'postgres' | 'sqlite'): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ id: migration.id, description: migration.description, statements: migration[engine] }))
    .digest('hex');
}

type PgRunner = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: Array<string | number | boolean | null>): T[];
  transaction<T>(work: () => T): T;
};

export function runPostgresSchemaMigrations(runner: PgRunner): string[] {
  runner.query(`CREATE TABLE IF NOT EXISTS voxera_schema_migrations (
    id TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    description TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const applied: string[] = [];
  for (const migration of SCHEMA_MIGRATIONS) {
    const checksum = schemaMigrationChecksum(migration, 'postgres');
    const row = runner.query<{ checksum: string }>('SELECT checksum FROM voxera_schema_migrations WHERE id = $1', [migration.id])[0];
    if (row) {
      if (row.checksum !== checksum) throw new Error(`schema migration ${migration.id} checksum mismatch; applied=${row.checksum} code=${checksum}`);
      continue;
    }
    runner.transaction(() => {
      for (const statement of migration.postgres) runner.query(statement);
      runner.query(
        'INSERT INTO voxera_schema_migrations (id, checksum, description) VALUES ($1, $2, $3)',
        [migration.id, checksum, migration.description],
      );
    });
    applied.push(migration.id);
  }
  return applied;
}

type SqliteTransaction<T> = (() => T) & { immediate(): T };
type SqliteRunner = {
  exec(sql: string): unknown;
  prepare(sql: string): { get(...args: unknown[]): unknown; run(...args: unknown[]): unknown };
  transaction<T>(fn: () => T): SqliteTransaction<T>;
};

export function runSqliteSchemaMigrations(db: SqliteRunner): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    description TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied: string[] = [];
  for (const migration of SCHEMA_MIGRATIONS) {
    const checksum = schemaMigrationChecksum(migration, 'sqlite');
    // BEGIN IMMEDIATE serialises the read-before-DDL decision across processes.
    // Without it, two fresh containers can both observe a missing migration;
    // the loser then crashes on the migration-ledger primary key after the
    // winner commits. Recheck the ledger only after taking the write lock.
    const appliedNow = db.transaction(() => {
      const row = db.prepare('SELECT checksum FROM schema_migrations WHERE id = ?').get(migration.id) as { checksum?: string } | undefined;
      if (row) {
        if (row.checksum !== checksum) throw new Error(`schema migration ${migration.id} checksum mismatch; applied=${row.checksum} code=${checksum}`);
        return false;
      }
      for (const statement of migration.sqlite) db.exec(statement);
      db.prepare('INSERT INTO schema_migrations (id, checksum, description, applied_at) VALUES (?, ?, ?, ?)')
        .run(migration.id, checksum, migration.description, new Date().toISOString());
      return true;
    }).immediate();
    if (appliedNow) applied.push(migration.id);
  }
  return applied;
}
