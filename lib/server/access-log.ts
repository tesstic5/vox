/**
 * Per-record access log.
 *
 * The records bar (see PRACTICE.md §5) asks a simple question of any client,
 * note or invoice: *who looked at this, and who changed it?* `audit` already
 * answers that for the workspace as a whole, but a whole-workspace log is the
 * wrong shape for the question — nobody scrolls 4,000 rows to find out whether
 * someone opened Mrs Patel's file.
 *
 * So reads and writes of a single record are logged against that record, and
 * the record shows its own history. Reads are logged too, deliberately: "who
 * has seen this" is the part a clinician actually needs.
 *
 * Entries are capped per record, oldest first, so a client with ten years of
 * appointments cannot grow an unbounded list.
 */

import { insert, listBy, remove, type Doc } from './db';
import { appendClinicalAccessEvent, type ClinicalAccessResource } from './clinical-access';

export type AccessResource = 'client' | 'note' | 'invoice' | 'appointment' | 'document' | 'alert' | 'case' | 'coverage' | 'care-plan' | 'encounter';
export type AccessAction =
  | 'view'
  | 'list'
  | 'create'
  | 'update'
  | 'archive'
  | 'restore'
  | 'consent'
  | 'merge'
  | 'export'
  | 'download'
  | 'delete'
  /** A message went to this person, or was refused for want of consent. */
  | 'message';

export type AccessEntry = Doc & {
  orgId: string;
  resource: AccessResource;
  resourceId: string;
  action: AccessAction;
  /** `dashboard`, `agent`, `api:key_…`, `sync`, or a user id. */
  actor: string;
  actorName?: string;
  /** One line a human can read: what changed, or what was looked at. */
  detail?: string;
  at: string;
};

/** Kept per record. Enough to answer "who has seen this" for a normal caseload. */
const PER_RECORD_CAP = 200;

export function recordAccess(input: {
  orgId: string;
  resource: AccessResource;
  resourceId: string;
  action: AccessAction;
  actor: string;
  actorName?: string;
  detail?: string;
  /** Internal: `recordView` already appended the uncapped event before dedupe. */
  clinicalAlreadyRecorded?: boolean;
}): AccessEntry {
  if (!input.clinicalAlreadyRecorded) {
    const resources: Record<AccessResource, ClinicalAccessResource> = {
      client: 'patient',
      note: 'clinical_note',
      invoice: 'invoice',
      appointment: 'appointment',
      document: 'clinical_document',
      alert: 'clinical_alert',
      case: 'case',
      coverage: 'coverage',
      'care-plan': 'care_plan',
      encounter: 'encounter',
    };
    appendClinicalAccessEvent({
      orgId: input.orgId,
      resourceType: resources[input.resource],
      resourceId: input.resourceId,
      patientId: ['client', 'coverage', 'care-plan', 'encounter'].includes(input.resource) ? input.resourceId : undefined,
      action: input.action,
      actorId: input.actor,
      actorLabel: input.actorName,
    });
  }
  const entry = insert<AccessEntry>('accessLog', {
    id: `ac_${Math.random().toString(36).slice(2, 12)}`,
    orgId: input.orgId,
    resource: input.resource,
    resourceId: input.resourceId,
    action: input.action,
    actor: input.actor,
    actorName: input.actorName,
    detail: input.detail,
    at: new Date().toISOString(),
  } as AccessEntry);

  const mine = listBy<AccessEntry>(
    'accessLog',
    { orgId: input.orgId, resource: input.resource, resourceId: input.resourceId },
    { limit: PER_RECORD_CAP + 1 }
  );
  if (mine.length > PER_RECORD_CAP) {
    for (const row of mine.slice(0, mine.length - PER_RECORD_CAP)) remove('accessLog', row.id);
  }
  return entry;
}

/** Newest first — the way a history tab reads. */
export function accessLogFor(orgId: string, resource: AccessResource, resourceId: string, limit = 50): AccessEntry[] {
  // SQL returns newest first already; the sort is kept so the JSON engine,
  // which serves the same rows from its cache, cannot disagree on order.
  return listBy<AccessEntry>('accessLog', { orgId, resource, resourceId }, { limit })
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}

/** Views are recorded at most once per actor per hour, so a refresh loop is not a log. */
export function recordView(input: { orgId: string; resource: AccessResource; resourceId: string; actor: string; actorName?: string }) {
  const resources: Record<AccessResource, ClinicalAccessResource> = {
    client: 'patient',
    note: 'clinical_note',
    invoice: 'invoice',
    appointment: 'appointment',
    document: 'clinical_document',
    alert: 'clinical_alert',
    case: 'case',
    coverage: 'coverage',
    'care-plan': 'care_plan',
    encounter: 'encounter',
  };
  // The operational list is deduplicated for readability; the clinical access
  // stream is not. Every read reaches the append-only collection first.
  appendClinicalAccessEvent({
    orgId: input.orgId,
    resourceType: resources[input.resource],
    resourceId: input.resourceId,
    patientId: ['client', 'coverage', 'care-plan', 'encounter'].includes(input.resource) ? input.resourceId : undefined,
    action: 'view',
    actorId: input.actor,
    actorLabel: input.actorName,
  });
  const recent = listBy<AccessEntry>(
    'accessLog',
    { orgId: input.orgId, resource: input.resource, resourceId: input.resourceId, actor: input.actor, action: 'view' },
    { limit: 50 }
  ).filter((row) => Date.now() - new Date(row.at).getTime() < 60 * 60 * 1000);
  if (recent.length) return undefined;
  return recordAccess({ ...input, action: 'view', clinicalAlreadyRecorded: true });
}

/** How an actor is described in the log, from the auth context. */
export function actorLabel(auth: 'session' | 'key' | 'agent' | 'sync', opts?: { email?: string; keyId?: string }): { actor: string; actorName?: string } {
  if (auth === 'key') return { actor: `api:${opts?.keyId ?? 'key'}`, actorName: 'API key' };
  if (auth === 'agent') return { actor: 'agent', actorName: 'AI receptionist' };
  if (auth === 'sync') return { actor: 'sync', actorName: 'Sync' };
  return { actor: opts?.email ?? 'dashboard', actorName: opts?.email };
}
