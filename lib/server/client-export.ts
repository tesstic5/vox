/** Controlled, patient-scoped subject-access manifest. No encrypted-object internals. */

import { bookingsFor } from './bookings';
import { clientById } from './clients';
import { clinicalAccessEventsFor, type ClinicalAccessEventDoc } from './clinical-access';
import { bodyChartClientExportManifest } from './clinical/body-charts';
import { documentExportManifest } from './clinical-documents';
import { list, nowIso } from './db';
import { notesFor, noteSummary } from './notes';
import { assignmentsForPatient, explicitRecordGrantsFor } from './permissions';
import { contactPointsFor, identityConflictsFor } from './patient-identity';
import { patientAlertsFor } from './patient-alerts';
import { activeLegalHolds } from './privacy-governance';
import { caseAssignmentsFor, casesFor } from './cases';
import { coverageView, coveragesForPatient, payerById } from './coverage';
import { authorisationsForCase, fundingEventsForBooking, fundingPeriodsForCase, serviceRulesForCase } from './funding';
import { carePlansForPatient, goalsForCarePlan } from './care-plans';
import { encountersForPatient } from './encounters';

function completeAccessHistory(orgId: string, patientId: string) {
  const rows: ClinicalAccessEventDoc[] = [];
  let beforeAt: string | undefined;
  let beforeId: string | undefined;
  for (;;) {
    const page = clinicalAccessEventsFor({ orgId, patientId, beforeAt, beforeId, limit: 2_001 });
    rows.push(...page.slice(0, 2_000));
    if (page.length <= 2_000) break;
    const last = page[1_999]!;
    beforeAt = last.occurredAt;
    beforeId = last.id;
  }
  return rows;
}

export function clientSubjectAccessManifest(input: {
  orgId: string;
  patientId: string;
  includeClinical: boolean;
  includeDocuments: boolean;
  includeAccessHistory: boolean;
}) {
  const client = clientById(input.orgId, input.patientId);
  if (!client) throw new Error('patient not found');
  const alerts = patientAlertsFor(input.orgId, input.patientId, { includeClinical: input.includeClinical });
  const notes = input.includeClinical
    ? notesFor(input.orgId, { clientId: input.patientId, includeArchived: true }).map((row) => noteSummary(row, { includeBody: true }))
    : [];
  const conflicts = identityConflictsFor(input.orgId, 'all').filter((row) => row.candidatePatientIds.includes(input.patientId));
  const bodyCharts = input.includeClinical ? bodyChartClientExportManifest(input.orgId, input.patientId) : undefined;
  const bodyChartSourceDocuments = input.includeDocuments && bodyCharts?.sourceDocumentIds.length
    ? documentExportManifest(input.orgId, { documentIds: bodyCharts.sourceDocumentIds })
    : undefined;
  const appointments = bookingsFor(input.orgId, (row) => row.clientId === input.patientId);
  const caseRows = casesFor(input.orgId, { patientId: input.patientId, includeClosed: true });
  const caseEvidence = caseRows.map((caseRow) => ({
    case: caseRow,
    assignments: caseAssignmentsFor(input.orgId, caseRow.id),
    fundingPeriods: fundingPeriodsForCase(input.orgId, caseRow.id),
    serviceRules: serviceRulesForCase(input.orgId, caseRow.id, true),
    authorisations: authorisationsForCase(input.orgId, caseRow.id, true),
  }));
  const coverages = coveragesForPatient(input.orgId, input.patientId).map((row) => coverageView(row, true));
  const payerIds = new Set([
    ...caseRows.map((row) => row.payerId),
    ...coverages.map((row) => row.payerId),
  ].filter((id): id is string => Boolean(id)));
  const manifest = {
    object: 'client_subject_access_manifest',
    schemaVersion: 2,
    generatedAt: nowIso(),
    orgId: input.orgId,
    patientId: input.patientId,
    patient: client,
    contactPoints: contactPointsFor(input.orgId, input.patientId),
    alerts,
    appointments,
    cases: caseEvidence,
    coverages,
    payers: [...payerIds].map((id) => payerById(input.orgId, id)).filter(Boolean),
    fundingEvents: appointments.flatMap((row) => fundingEventsForBooking(input.orgId, row.id)),
    encounters: input.includeClinical ? encountersForPatient(input.orgId, input.patientId) : [],
    carePlans: input.includeClinical
      ? carePlansForPatient(input.orgId, input.patientId, true).map((plan) => ({ ...plan, goals: goalsForCarePlan(input.orgId, plan.id) }))
      : [],
    notes,
    bodyCharts,
    assignments: assignmentsForPatient(input.orgId, input.patientId, { includeEnded: true }),
    explicitRecordGrants: explicitRecordGrantsFor(input.orgId, input.patientId, { includeRevoked: true }),
    identityConflicts: conflicts,
    legalHolds: activeLegalHolds({ orgId: input.orgId, patientId: input.patientId }),
    clinicalAccessEvents: input.includeAccessHistory ? completeAccessHistory(input.orgId, input.patientId) : [],
    clinicalDocuments: input.includeDocuments ? documentExportManifest(input.orgId, { patientId: input.patientId }) : undefined,
    bodyChartSourceDocuments,
    boundaries: {
      clinicalContentIncluded: input.includeClinical,
      bodyChartEvidenceIncluded: input.includeClinical,
      caseAndFundingEvidenceIncluded: true,
      coverageIdentifiersIncluded: true,
      carePlanAndEncounterEvidenceIncluded: input.includeClinical,
      documentManifestIncluded: input.includeDocuments,
      bodyChartSourceManifestIncluded: Boolean(bodyChartSourceDocuments),
      documentBytesIncluded: false,
      encryptedObjectInternalsIncluded: false,
      completeClinicalAccessHistoryIncluded: input.includeAccessHistory,
      broadCallTranscriptsIncluded: false,
    },
    note: 'Body-chart coordinates, signed hashes, case funding events and coverage values are included. Patient documents, authorisation evidence bytes and pinned template-image bytes are downloaded separately through authorised, scanner-gated routes. Object keys, ciphertext metadata, sealed values and wrapped keys are excluded.',
  };
  // Defensive assertion: future additions must not smuggle encrypted internals.
  const text = JSON.stringify(manifest);
  for (const forbidden of ['objectKey', 'wrappedKey', 'dataAuthTag', 'ciphertextSha256', 'tokenHash', 'sensitiveSealed']) {
    if (text.includes(`\"${forbidden}\"`)) throw new Error(`subject-access manifest contains forbidden field ${forbidden}`);
  }
  return manifest;
}
