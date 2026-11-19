/** Fail-closed clinical operating-mode gate. This is readiness evidence, not a compliance certificate. */

import { listAllByOrg, nowIso, storeDriver, type Doc } from './db';
import {
  clinicalProfileFor,
  externalAttestationsFor,
  processingActivitiesFor,
  privacyProfileFor,
  processorsFor,
  recoveryEvidenceFor,
  retentionPoliciesFor,
  saveClinicalProfile,
  type ClinicalProfileDoc,
  type ExternalAttestationType,
} from './privacy-governance';
import { configuredBlobBackend, documentMasterKeyConfigured, malwareScannerConfigured, s3BlobConfigurationComplete } from './document-config';
import type { UserDoc } from './auth';
import { permissionDecision, permissionShadowEvents } from './permissions';
import { dataMigrationStates } from './data-migrations';

export type ReadinessStatus = 'pass' | 'fail' | 'warning';
export type ReadinessCheck = {
  id: string;
  category: 'storage' | 'security' | 'privacy' | 'clinical' | 'operations' | 'external_review';
  label: string;
  status: ReadinessStatus;
  requiredForLive: boolean;
  detail: string;
  evidence?: string;
};

type ScannerEvidenceDoc = Doc & {
  status?: 'clean' | 'infected' | 'error' | 'unavailable';
  scanner?: string;
  checkedAt?: string;
  evidenceHash?: string;
};

export type ClinicalReadiness = {
  orgId: string;
  evaluatedAt: string;
  profile: ClinicalProfileDoc;
  readyForLive: boolean;
  failedRequired: string[];
  warnings: string[];
  checks: ReadinessCheck[];
  statement: string;
};

function validIndependentReview(orgId: string, type: ExternalAttestationType, now: number) {
  return externalAttestationsFor(orgId).find((row) =>
    row.type === type && row.independent && row.outcome !== 'not_approved' && row.actionsOpen === 0 &&
    Date.parse(row.reviewedAt) <= now && Date.parse(row.expiresAt) > now &&
    Boolean(row.reviewerName && row.reviewerOrganisation && row.reportReference),
  );
}

export function evaluateClinicalReadiness(orgId: string, now = Date.now()): ClinicalReadiness {
  const profile = clinicalProfileFor(orgId);
  const privacyProfile = privacyProfileFor(orgId);
  const controllerProfileReady = Boolean(
    privacyProfile.controllerName && privacyProfile.controllerAddress && privacyProfile.controllerContactEmail &&
    privacyProfile.privacyNoticeVersion && privacyProfile.privacyNoticeUrl && privacyProfile.dpiaReference &&
    privacyProfile.dpiaStatus === 'approved_by_controller' && privacyProfile.dpiaReviewedAt && privacyProfile.dpiaReviewedBy &&
    privacyProfile.auditCompleteFromAt
  );
  const activities = processingActivitiesFor(orgId).filter((row) => row.status === 'active');
  const healthActivity = activities.find((row) => row.article6Basis && row.article9Condition && row.dataCategories.some((value) => /health|clinical|treatment/i.test(value)));
  const processors = processorsFor(orgId).filter((row) => row.active && row.receivesHealthData);
  const processorsReady = processors.length > 0 && processors.every((row) => row.role !== 'unknown' && (row.dpaStatus === 'signed' || row.dpaStatus === 'not_applicable') && row.hostingRegions.length > 0);
  const requiredRecordClasses = ['patient_record', 'clinical_note', 'clinical_document', 'clinical_access_event'];
  const activeRetention = retentionPoliciesFor(orgId).filter((row) => row.status === 'active');
  const retentionMissing = requiredRecordClasses.filter((recordClass) => !activeRetention.some((row) => row.recordClass === recordClass));
  const recovery = recoveryEvidenceFor(orgId).find((row) => row.outcome === 'passed' && Date.parse(row.restoreTestedAt) > now - 365 * 86_400_000);
  const shadowDisagreements = permissionShadowEvents(orgId, { unresolvedOnly: true }).length;
  const migrationStates = dataMigrationStates(orgId);
  const pendingMigrations = migrationStates.filter((row) => row.status !== 'completed');
  const reviews = {
    security: validIndependentReview(orgId, 'security', now),
    privacy_legal: validIndependentReview(orgId, 'privacy_legal', now),
    clinical: validIndependentReview(orgId, 'clinical', now),
  };
  const backend = configuredBlobBackend();
  const production = process.env.NODE_ENV === 'production';
  const scannerCommand = process.env.VOXERA_MALWARE_SCAN_COMMAND?.trim() ?? '';
  const scannerTestBinary = /(^|[/\\])(true|false)(\.exe)?$/i.test(scannerCommand);
  const recentScannerEvidence = listAllByOrg<ScannerEvidenceDoc>('documentScanEvents', orgId).filter((row) =>
    row.scanner === scannerCommand && Boolean(row.evidenceHash) && Number.isFinite(Date.parse(row.checkedAt ?? '')) &&
    Date.parse(row.checkedAt ?? '') > now - 30 * 86_400_000,
  );
  const cleanScannerEvidence = recentScannerEvidence.find((row) => row.status === 'clean');
  const infectedScannerEvidence = recentScannerEvidence.find((row) => row.status === 'infected');
  const scannerReady = malwareScannerConfigured() && !scannerTestBinary && Boolean(cleanScannerEvidence && infectedScannerEvidence);

  const checks: ReadinessCheck[] = [
    {
      id: 'data-migrations', category: 'operations', label: 'Checksummed Phase 1 data migrations', requiredForLive: true,
      status: pendingMigrations.length === 0 ? 'pass' : 'fail',
      detail: pendingMigrations.length === 0 ? `${migrationStates.length} checksummed data migrations are complete.` : `${pendingMigrations.length} migration(s) are pending or failed; run or resume them before live mode.`,
    },
    {
      id: 'postgres', category: 'storage', label: 'PostgreSQL clinical store', requiredForLive: true,
      status: storeDriver() === 'postgres' ? 'pass' : 'fail',
      detail: storeDriver() === 'postgres' ? 'PostgreSQL is the active store.' : `${storeDriver()} is a development compatibility store; live clinical mode requires PostgreSQL.`,
    },
    {
      id: 'document-key', category: 'security', label: 'Document encryption master key', requiredForLive: true,
      status: documentMasterKeyConfigured() ? 'pass' : 'fail',
      detail: documentMasterKeyConfigured() ? 'A 32-byte document master key is configured (value not displayed).' : 'VOXERA_DOCUMENT_MASTER_KEY is missing or not exactly 32 bytes.',
    },
    {
      id: 'object-store', category: 'storage', label: 'Production object storage', requiredForLive: true,
      status: backend === 's3' && s3BlobConfigurationComplete() ? 'pass' : 'fail',
      detail: backend === 's3' && s3BlobConfigurationComplete() ? 'The S3-compatible encrypted blob adapter is configured.' : 'Filesystem blobs are development-only; configure the S3-compatible/R2 adapter and credentials.',
    },
    {
      id: 'malware-scanner', category: 'security', label: 'Malware scanner', requiredForLive: true,
      status: scannerReady ? 'pass' : 'fail',
      detail: scannerReady
        ? `The configured scanner has recent append-only clean and infected scan evidence (${cleanScannerEvidence?.checkedAt}; ${infectedScannerEvidence?.checkedAt}).`
        : !malwareScannerConfigured()
          ? 'No scanner command is configured, so all uploads remain quarantined.'
          : scannerTestBinary
            ? 'The configured command is a test binary, not a malware scanner. /bin/true and /bin/false can never satisfy live readiness.'
            : 'Run both clean-file and standard anti-malware test-file checks through the configured scanner. Live readiness requires append-only clean and infected evidence from the last 30 days.',
      evidence: scannerReady ? `${cleanScannerEvidence?.id},${infectedScannerEvidence?.id}` : undefined,
    },
    {
      id: 'controller-profile', category: 'privacy', label: 'Controller, notice and DPIA record', requiredForLive: true,
      status: controllerProfileReady ? 'pass' : 'fail',
      detail: controllerProfileReady
        ? `Controller record ${privacyProfile.controllerName} includes notice, controller-reviewed DPIA and the complete-audit cutover marker.`
        : 'Record controller identity/contact, the current privacy notice, a controller-reviewed DPIA and the audit-complete cutover instant.',
      evidence: controllerProfileReady ? privacyProfile.id : undefined,
    },
    {
      id: 'processing-activity', category: 'privacy', label: 'Health-data processing activity', requiredForLive: true,
      status: healthActivity ? 'pass' : 'fail',
      detail: healthActivity ? `Active controller record: ${healthActivity.name}.` : 'Record and activate the controller-selected purpose, Article 6 basis and Article 9 condition.',
      evidence: healthActivity?.id,
    },
    {
      id: 'processors', category: 'privacy', label: 'Processor and transfer register', requiredForLive: true,
      status: processorsReady ? 'pass' : 'fail',
      detail: processorsReady ? `${processors.length} health-data processor record(s) have role, region and DPA state.` : 'Every active health-data processor needs role, region and reviewed DPA state; at least one infrastructure processor is expected.',
    },
    {
      id: 'retention', category: 'privacy', label: 'Controller retention schedule', requiredForLive: true,
      status: retentionMissing.length === 0 ? 'pass' : 'fail',
      detail: retentionMissing.length === 0 ? 'Active policies cover patient records, notes, documents and clinical access events.' : `Missing active controller policy for: ${retentionMissing.join(', ')}.`,
    },
    {
      id: 'recovery', category: 'operations', label: 'Restore exercise evidence', requiredForLive: true,
      status: recovery ? 'pass' : 'fail',
      detail: recovery ? `Passed restore evidence dated ${recovery.restoreTestedAt}.` : 'No passed restore exercise from the last 365 days is recorded.',
      evidence: recovery?.id,
    },
    {
      id: 'rbac-shadow', category: 'security', label: 'Granular-role shadow comparison', requiredForLive: true,
      status: shadowDisagreements === 0 ? 'pass' : 'fail',
      detail: shadowDisagreements === 0 ? 'No stored granular-versus-legacy permission disagreement exists.' : `${shadowDisagreements} permission disagreement record(s) require review.`,
    },
    ...(['security', 'privacy_legal', 'clinical'] as ExternalAttestationType[]).map((type): ReadinessCheck => {
      const review = reviews[type];
      const label = type === 'privacy_legal' ? 'Independent UK privacy/legal review' : type === 'clinical' ? 'Independent allied-health clinical review' : 'Independent security review';
      return {
        id: `review-${type}`, category: 'external_review', label, requiredForLive: true,
        status: review ? 'pass' : 'fail',
        detail: review ? `Recorded from ${review.reviewerOrganisation}; expires ${review.expiresAt}.` : 'No current independent approval with closed actions is recorded.',
        evidence: review?.id,
      };
    }),
    {
      id: 'operator-live-switch', category: 'operations', label: 'Deployment clinical-data switch', requiredForLive: true,
      status: process.env.VOXERA_CLINICAL_DATA_APPROVED === '1' ? 'pass' : 'fail',
      detail: process.env.VOXERA_CLINICAL_DATA_APPROVED === '1' ? 'The operator explicitly enabled the final deployment switch.' : 'VOXERA_CLINICAL_DATA_APPROVED is not 1. This prevents accidental use of real patient data.',
    },
    {
      id: 'production-runtime', category: 'operations', label: 'Production runtime', requiredForLive: true,
      status: production ? 'pass' : 'fail',
      detail: production ? 'NODE_ENV is production.' : 'Clinical live mode cannot be activated from a development runtime.',
    },
  ];

  const failedRequired = checks.filter((check) => check.requiredForLive && check.status !== 'pass').map((check) => check.id);
  const warnings = checks.filter((check) => check.status === 'warning').map((check) => check.id);
  return {
    orgId,
    evaluatedAt: new Date(now).toISOString(),
    profile,
    readyForLive: failedRequired.length === 0,
    failedRequired,
    warnings,
    checks,
    statement: failedRequired.length === 0
      ? 'Implementation gates are satisfied by the recorded evidence. This status is not a statutory compliance certificate and does not replace continuing controller review.'
      : 'Clinical live mode is blocked. Synthetic/test configuration may continue, but real patient data remains prohibited.',
  };
}

export function setClinicalOperatingMode(input: {
  orgId: string;
  mode: ClinicalProfileDoc['operatingMode'];
  actor: UserDoc;
  confirmation?: string;
}): { profile: ClinicalProfileDoc; readiness: ClinicalReadiness } {
  const current = clinicalProfileFor(input.orgId);
  if (input.mode === 'live') {
    if (!permissionDecision(input.actor, 'clinical.live.activate').allowed) throw new Error('only an owner with clinical.live.activate can enable live clinical mode');
    if (input.confirmation !== 'ENABLE LIVE UK CLINICAL DATA') throw new Error('confirmation must exactly equal ENABLE LIVE UK CLINICAL DATA');
    const readiness = evaluateClinicalReadiness(input.orgId);
    if (!readiness.readyForLive) throw new Error(`live clinical mode is blocked by: ${readiness.failedRequired.join(', ')}`);
  }
  const at = nowIso();
  const profile = saveClinicalProfile({
    ...current,
    operatingMode: input.mode,
    liveActivatedAt: input.mode === 'live' ? at : current.liveActivatedAt,
    liveActivatedBy: input.mode === 'live' ? input.actor.id : current.liveActivatedBy,
  });
  return { profile, readiness: evaluateClinicalReadiness(input.orgId) };
}

export function requireClinicalWriteMode(orgId: string, syntheticAcknowledged: boolean) {
  const profile = clinicalProfileFor(orgId);
  if (profile.operatingMode === 'live') return requireClinicalLive(orgId);
  if (profile.operatingMode === 'synthetic_test' && syntheticAcknowledged) return evaluateClinicalReadiness(orgId);
  if (profile.operatingMode === 'synthetic_test') {
    throw new Error('synthetic-test mode requires the X-Voxera-Synthetic-Data: 1 acknowledgement; real patient data is prohibited');
  }
  throw new Error('clinical mode is disabled; enable synthetic-test setup or satisfy every live-mode gate');
}

export function requireClinicalLive(orgId: string) {
  const readiness = evaluateClinicalReadiness(orgId);
  if (readiness.profile.operatingMode !== 'live' || !readiness.readyForLive) {
    throw new Error(`clinical live mode is not ready: ${readiness.failedRequired.join(', ') || 'mode is not live'}`);
  }
  return readiness;
}
