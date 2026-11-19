/** Administrative/clinical alert separation. Clinical text never enters phone-assistant context. */

import crypto from 'node:crypto';
import { commitBatch, find, list, newId, nowIso, type Doc } from './db';
import { recordAccess } from './access-log';

export type PatientAlertClassification = 'administrative' | 'clinical';
export type PatientAlertSeverity = 'info' | 'warning' | 'critical';

export type PatientAlertDoc = Doc & {
  orgId: string;
  patientId: string;
  classification: PatientAlertClassification;
  label: string;
  detail?: string;
  severity: PatientAlertSeverity;
  visibility: 'staff' | 'clinical-team';
  active: boolean;
  source: 'legacy' | 'staff' | 'integration';
  createdBy?: string;
  endedAt?: string;
  endedBy?: string;
  revision: number;
};

type LegacyAlert = { id?: string; label?: string; detail?: string; severity?: PatientAlertSeverity; createdAt?: string };
type LegacyPatient = Doc & {
  orgId?: string;
  alerts?: LegacyAlert[];
  legacyAlertsMigration?: { migratedCount: number; sourceClearedAt: string };
};

function legacyAlertId(orgId: string, patientId: string, alert: LegacyAlert, index: number) {
  return `pal_${crypto.createHash('sha256').update(`${orgId}:${patientId}:${alert.id ?? index}:${alert.label ?? ''}`).digest('hex').slice(0, 40)}`;
}

/** Existing `client.alerts` were documented as medical flags, so migrate them restricted. */
export function migrateLegacyPatientAlerts(orgId: string, patientId?: string) {
  const patients = list<LegacyPatient>('clients', (patient) => patient.orgId === orgId && (!patientId || patient.id === patientId));
  let inserted = 0;
  for (const patient of patients) {
    for (const [index, alert] of (patient.alerts ?? []).entries()) {
      const id = legacyAlertId(orgId, patient.id, alert, index);
      if (find<PatientAlertDoc>('patientAlerts', (row) => row.id === id)) continue;
      const draft = {
        id,
        orgId,
        patientId: patient.id,
        classification: 'clinical',
        label: String(alert.label ?? 'Legacy clinical alert').trim().slice(0, 160),
        detail: alert.detail?.trim().slice(0, 2_000),
        severity: ['info', 'warning', 'critical'].includes(String(alert.severity)) ? alert.severity : 'warning',
        visibility: 'clinical-team',
        active: true,
        source: 'legacy',
        createdAt: alert.createdAt ?? patient.createdAt ?? nowIso(),
      } as PatientAlertDoc;
      try {
        commitBatch({ upserts: [{ collection: 'patientAlerts', doc: draft, expectedRevision: null, expectedOrgId: orgId }] });
        inserted += 1;
      } catch (error) {
        if (!(error instanceof Error) || error.name !== 'CommitConflictError') throw error;
      }
    }
  }
  return { patients: patients.length, inserted };
}

/**
 * Remove copied health text from the old embedded field only after every
 * deterministic destination row is present. This is a separate, resumable
 * migration so an already-applied copy migration is never rewritten in place.
 */
export function clearMigratedLegacyPatientAlertBodies(orgId: string) {
  const patients = list<LegacyPatient>(
    'clients',
    (patient) => patient.orgId === orgId && Array.isArray(patient.alerts) && patient.alerts.length > 0,
  );
  let clearedPatients = 0;
  let clearedAlerts = 0;
  for (const patient of patients) {
    const alerts = patient.alerts ?? [];
    const missing = alerts.filter((alert, index) => {
      const id = legacyAlertId(orgId, patient.id, alert, index);
      return !find<PatientAlertDoc>('patientAlerts', (row) => row.id === id && row.orgId === orgId && row.patientId === patient.id);
    });
    if (missing.length) {
      throw new Error(`cannot clear ${patient.id}: ${missing.length} legacy alert destination row(s) are missing`);
    }
    commitBatch({
      upserts: [{
        collection: 'clients',
        doc: {
          ...patient,
          alerts: [],
          legacyAlertsMigration: { migratedCount: alerts.length, sourceClearedAt: nowIso() },
        },
        expectedRevision: Number(patient.revision ?? 0),
        expectedOrgId: orgId,
      }],
    });
    clearedPatients += 1;
    clearedAlerts += alerts.length;
  }
  return { clearedPatients, clearedAlerts };
}

export function patientAlertsFor(
  orgId: string,
  patientId: string,
  options: { includeClinical: boolean; includeEnded?: boolean } = { includeClinical: false },
): PatientAlertDoc[] {
  migrateLegacyPatientAlerts(orgId, patientId);
  return list<PatientAlertDoc>(
    'patientAlerts',
    (alert) =>
      alert.orgId === orgId && alert.patientId === patientId &&
      (options.includeClinical || alert.classification === 'administrative') &&
      (options.includeEnded || (alert.active && !alert.endedAt)),
  ).sort((a, b) => Number(b.severity === 'critical') - Number(a.severity === 'critical') || String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function addPatientAlert(input: {
  orgId: string;
  patientId: string;
  classification: PatientAlertClassification;
  label: string;
  detail?: string;
  severity?: PatientAlertSeverity;
  actor: string;
  actorName?: string;
}): PatientAlertDoc {
  const patient = find<Doc & { orgId?: string }>('clients', (row) => row.id === input.patientId && row.orgId === input.orgId);
  if (!patient) throw new Error('patient not found');
  const label = input.label.trim();
  if (!label || label.length > 160) throw new Error('alert label must contain 1 to 160 characters');
  if (input.detail && input.detail.length > 2_000) throw new Error('alert detail may contain at most 2,000 characters');
  const at = nowIso();
  const draft = {
    id: newId('pal_'),
    orgId: input.orgId,
    patientId: input.patientId,
    classification: input.classification,
    label,
    detail: input.detail?.trim() || undefined,
    severity: input.severity ?? 'warning',
    visibility: input.classification === 'clinical' ? 'clinical-team' : 'staff',
    active: true,
    source: 'staff',
    createdBy: input.actor,
    createdAt: at,
  } as PatientAlertDoc;
  const alert = commitBatch({
    upserts: [{ collection: 'patientAlerts', doc: draft, expectedRevision: null, expectedOrgId: input.orgId }],
  }).upserts[0] as PatientAlertDoc;
  recordAccess({
    orgId: input.orgId,
    resource: 'client',
    resourceId: input.patientId,
    action: 'update',
    actor: input.actor,
    actorName: input.actorName,
    detail: `${input.classification} alert added`,
  });
  return alert;
}

export function endPatientAlert(input: {
  orgId: string;
  patientId: string;
  alertId: string;
  actor: string;
  actorName?: string;
}): PatientAlertDoc {
  const alert = find<PatientAlertDoc>(
    'patientAlerts',
    (row) => row.id === input.alertId && row.orgId === input.orgId && row.patientId === input.patientId,
  );
  if (!alert) throw new Error('alert not found');
  if (alert.endedAt) return alert;
  const ended = commitBatch({
    upserts: [{
      collection: 'patientAlerts',
      doc: { ...alert, active: false, endedAt: nowIso(), endedBy: input.actor },
      expectedRevision: Number(alert.revision ?? 0),
      expectedOrgId: input.orgId,
    }],
  }).upserts[0] as PatientAlertDoc;
  recordAccess({
    orgId: input.orgId,
    resource: 'client',
    resourceId: input.patientId,
    action: 'update',
    actor: input.actor,
    actorName: input.actorName,
    detail: `${alert.classification} alert ended`,
  });
  return ended;
}

/** Safe shape for callers that do not hold clinical-alert permission. */
export function redactPatientAlerts(alerts: PatientAlertDoc[], includeClinical: boolean) {
  return alerts
    .filter((alert) => includeClinical || alert.classification === 'administrative')
    .map(({ id, classification, label, detail, severity, active, createdAt, endedAt }) => ({
      id, classification, label, detail, severity, active, createdAt, endedAt,
    }));
}
