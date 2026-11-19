import { commitBatch, list, newId, nowIso, type Doc } from './db';

export type ClinicalAccessAction =
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
  | 'message';

export type ClinicalAccessResource = 'patient' | 'clinical_note' | 'clinical_alert' | 'clinical_document' | 'appointment' | 'invoice' | 'case' | 'coverage' | 'care_plan' | 'encounter';

export type ClinicalAccessEventDoc = Doc & {
  orgId: string;
  resourceType: ClinicalAccessResource;
  resourceId: string;
  patientId?: string;
  action: ClinicalAccessAction;
  actorId: string;
  actorType: 'user' | 'api_key' | 'assistant' | 'integration' | 'system';
  actorLabel?: string;
  purpose: 'direct_care' | 'practice_administration' | 'patient_request' | 'security' | 'system_maintenance';
  requestId?: string;
  route?: string;
  occurredAt: string;
  ipHash?: string;
  revision: number;
};

function actorType(actor: string): ClinicalAccessEventDoc['actorType'] {
  if (actor.startsWith('api:')) return 'api_key';
  if (actor === 'agent') return 'assistant';
  if (actor === 'sync') return 'integration';
  if (['system', 'maintenance'].includes(actor)) return 'system';
  return 'user';
}

export function appendClinicalAccessEvent(input: {
  orgId: string;
  resourceType: ClinicalAccessResource;
  resourceId: string;
  patientId?: string;
  action: ClinicalAccessAction;
  actorId: string;
  actorLabel?: string;
  purpose?: ClinicalAccessEventDoc['purpose'];
  requestId?: string;
  route?: string;
  ipHash?: string;
}): ClinicalAccessEventDoc {
  const occurredAt = nowIso();
  const draft = {
    id: newId('cae_'),
    orgId: input.orgId,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    patientId: input.patientId,
    action: input.action,
    actorId: input.actorId,
    actorType: actorType(input.actorId),
    actorLabel: input.actorLabel,
    purpose: input.purpose ?? (input.resourceType === 'clinical_note' || input.resourceType === 'clinical_alert' ? 'direct_care' : 'practice_administration'),
    requestId: input.requestId,
    route: input.route,
    occurredAt,
    ipHash: input.ipHash,
    createdAt: occurredAt,
  } as ClinicalAccessEventDoc;
  return commitBatch({
    upserts: [{ collection: 'clinicalAccessEvents', doc: draft, expectedRevision: null, expectedOrgId: input.orgId }],
  }).upserts[0] as ClinicalAccessEventDoc;
}

export function clinicalAccessEventsFor(input: {
  orgId: string;
  resourceType?: ClinicalAccessResource;
  resourceId?: string;
  patientId?: string;
  actorId?: string;
  from?: string;
  to?: string;
  beforeAt?: string;
  beforeId?: string;
  limit?: number;
}): ClinicalAccessEventDoc[] {
  const limit = Math.max(1, Math.min(2_001, input.limit ?? 200));
  return matchingClinicalAccessEvents(input)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id))
    .slice(0, limit);
}

type ClinicalAccessFilter = Omit<Parameters<typeof clinicalAccessEventsFor>[0], 'limit'>;

function matchingClinicalAccessEvents(input: ClinicalAccessFilter): ClinicalAccessEventDoc[] {
  return list<ClinicalAccessEventDoc>(
    'clinicalAccessEvents',
    (event) =>
      event.orgId === input.orgId &&
      (!input.resourceType || event.resourceType === input.resourceType) &&
      (!input.resourceId || event.resourceId === input.resourceId) &&
      (!input.patientId || event.patientId === input.patientId || (event.resourceType === 'patient' && event.resourceId === input.patientId)) &&
      (!input.actorId || event.actorId === input.actorId) &&
      (!input.from || event.occurredAt >= input.from) &&
      (!input.to || event.occurredAt <= input.to) &&
      (!input.beforeAt || event.occurredAt < input.beforeAt ||
        (event.occurredAt === input.beforeAt && (!input.beforeId || event.id < input.beforeId))),
  );
}

export function clinicalAccessEventCount(input: ClinicalAccessFilter) {
  return matchingClinicalAccessEvents({ ...input, beforeAt: undefined, beforeId: undefined }).length;
}

export function clinicalAccessSummary(orgId: string, from?: string, to?: string) {
  // Aggregate the uncapped append-only collection. The API page limit must never
  // turn a busy workspace's summary into a false claim of complete history.
  const events = matchingClinicalAccessEvents({ orgId, from, to });
  const byAction: Record<string, number> = {};
  const byActorType: Record<string, number> = {};
  for (const event of events) {
    byAction[event.action] = (byAction[event.action] ?? 0) + 1;
    byActorType[event.actorType] = (byActorType[event.actorType] ?? 0) + 1;
  }
  return {
    events: events.length,
    byAction,
    byActorType,
    latestAt: events[0]?.occurredAt,
    completeHistory: true,
    note: 'This append-only stream is separate from the capped operational accessLog collection.',
  };
}
