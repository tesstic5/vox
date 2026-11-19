import { commitBatch, list, newId, nowIso, type Doc } from './db';

export type OutboxEventDoc = Doc & {
  orgId: string;
  topic: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  availableAt: string;
  deliveredAt?: string;
  lastError?: string;
  revision: number;
};

/** Build an outbox row for inclusion in the same `commitBatch` as domain state. */
export function outboxDraft(input: {
  orgId: string;
  topic: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  availableAt?: string;
}): OutboxEventDoc {
  const at = nowIso();
  return {
    id: newId('out_'),
    orgId: input.orgId,
    topic: input.topic,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    payload: input.payload,
    status: 'pending',
    attempts: 0,
    availableAt: input.availableAt ?? at,
    createdAt: at,
    revision: 0,
  } as OutboxEventDoc;
}

export function pendingOutboxEvents(orgId: string, limit = 50, now = Date.now()): OutboxEventDoc[] {
  return list<OutboxEventDoc>(
    'domainOutbox',
    (event) => event.orgId === orgId && event.status === 'pending' && Date.parse(event.availableAt) <= now,
  )
    .sort((a, b) => a.availableAt.localeCompare(b.availableAt))
    .slice(0, Math.max(1, Math.min(500, limit)));
}

export function markOutboxDelivered(event: OutboxEventDoc): OutboxEventDoc {
  return commitBatch({
    upserts: [
      {
        collection: 'domainOutbox',
        doc: { ...event, status: 'delivered', attempts: event.attempts + 1, deliveredAt: nowIso(), lastError: undefined },
        expectedRevision: Number(event.revision ?? 0),
        expectedOrgId: event.orgId,
      },
    ],
  }).upserts[0] as OutboxEventDoc;
}

export function markOutboxFailed(event: OutboxEventDoc, error: unknown): OutboxEventDoc {
  return commitBatch({
    upserts: [
      {
        collection: 'domainOutbox',
        doc: {
          ...event,
          status: 'pending',
          attempts: event.attempts + 1,
          availableAt: new Date(Date.now() + Math.min(60, 2 ** Math.min(event.attempts, 6)) * 60_000).toISOString(),
          lastError: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
        },
        expectedRevision: Number(event.revision ?? 0),
        expectedOrgId: event.orgId,
      },
    ],
  }).upserts[0] as OutboxEventDoc;
}
