import crypto from 'node:crypto';
import { domainJobDraft } from '../domain-jobs';
import { nowIso, type Doc } from '../db';

export const AUTOMATION_TRIGGERS = [
  'referral.received',
  'referral.status_changed',
  'form.response_submitted',
  'letter.finalised',
  'task.due',
] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

export type AutomationEventDoc = Doc & {
  orgId: string;
  trigger: AutomationTrigger;
  aggregateType: 'referral' | 'form_response' | 'letter' | 'task';
  aggregateId: string;
  sourceEventId: string;
  payload: Record<string, unknown>;
  depth: number;
  occurredAt: string;
  revision: number;
};

const FORBIDDEN_PAYLOAD_KEYS = new Set([
  'answers', 'address', 'body', 'content', 'dateofbirth', 'email', 'name', 'notes', 'phone', 'reason', 'subject',
]);

export const AUTOMATION_AGGREGATE_FOR_TRIGGER: Record<AutomationTrigger, AutomationEventDoc['aggregateType']> = {
  'referral.received': 'referral',
  'referral.status_changed': 'referral',
  'form.response_submitted': 'form_response',
  'letter.finalised': 'letter',
  'task.due': 'task',
};

function digest(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function assertMinimisedPayload(value: unknown, depth = 0) {
  if (depth > 5) throw new Error('automation event payload is too deeply nested');
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    if (typeof value === 'string' && value.length > 240) throw new Error('automation event payload value is too long');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 20) throw new Error('automation event payload array is too large');
    for (const item of value) assertMinimisedPayload(item, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') throw new Error('automation event payload contains an unsupported value');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length > 30) throw new Error('automation event payload has too many properties');
  for (const key of keys) {
    const normalisedKey = key.toLowerCase();
    if (!/^[a-z][a-zA-Z0-9]{0,63}$/.test(key) || [...FORBIDDEN_PAYLOAD_KEYS].some((privateKey) => normalisedKey.includes(privateKey))) {
      throw new Error(`automation event payload property ${key} is not allowed`);
    }
    assertMinimisedPayload(record[key], depth + 1);
  }
}

type AutomationEventInput = {
  orgId: string;
  trigger: AutomationTrigger;
  aggregateType: AutomationEventDoc['aggregateType'];
  aggregateId: string;
  sourceEventId: string;
  payload: Record<string, unknown>;
  depth?: number;
  occurredAt?: string;
};

/** Build and validate an event without persisting it. Preview uses this same boundary. */
export function automationEventDraft(input: AutomationEventInput): AutomationEventDoc {
  if (!(AUTOMATION_TRIGGERS as readonly string[]).includes(input.trigger)) throw new Error('automation trigger is not allowed');
  if (!input.orgId || !input.aggregateId || !input.sourceEventId) throw new Error('automation event ownership is required');
  if (input.orgId.length > 240 || input.aggregateId.length > 240 || input.sourceEventId.length > 240) throw new Error('automation event ownership value is too long');
  if (input.aggregateType !== AUTOMATION_AGGREGATE_FOR_TRIGGER[input.trigger]) throw new Error('automation event aggregate does not match its trigger');
  assertMinimisedPayload(input.payload);
  if (JSON.stringify(input.payload).length > 16_384) throw new Error('automation event payload is too large');
  const occurredAt = input.occurredAt ?? nowIso();
  if (!Number.isFinite(Date.parse(occurredAt))) throw new Error('automation event time is invalid');
  return {
    id: `aevt_${digest(`${input.orgId}:${input.trigger}:${input.sourceEventId}`)}`,
    orgId: input.orgId,
    trigger: input.trigger,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    sourceEventId: input.sourceEventId,
    payload: input.payload,
    depth: Math.max(0, Math.min(100, Math.trunc(input.depth ?? 0))),
    occurredAt,
    createdAt: occurredAt,
    revision: 0,
  };
}

/**
 * Build an event and its durable runner job for inclusion in the same commit as
 * the originating domain transition. IDs are deterministic so retries converge.
 */
export function automationEventWrites(input: AutomationEventInput) {
  const event = automationEventDraft(input);
  const job = domainJobDraft({
    id: `job_auto_${digest(event.id)}`,
    orgId: input.orgId,
    type: 'automation.event',
    payload: { eventId: event.id },
    dedupeKey: `automation.event:${event.id}`,
    maxAttempts: 4,
    runAt: event.occurredAt,
  });
  return [
    { collection: 'automationEvents', doc: event as Doc, expectedRevision: null, expectedOrgId: input.orgId },
    { collection: 'domainJobs', doc: job as Doc, expectedRevision: null, expectedOrgId: input.orgId },
  ];
}
