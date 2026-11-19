/** Durable, revision-claimed jobs for clinical/document workflows. */

import { commitBatch, get, listAllByOrg, newId, nowIso, type Doc } from './db';

export type DomainJobStatus = 'queued' | 'running' | 'retry' | 'completed' | 'failed' | 'cancelled';

export type DomainJobDoc = Doc & {
  orgId: string;
  type: string;
  payload: Record<string, unknown>;
  status: DomainJobStatus;
  runAt: string;
  attempts: number;
  maxAttempts: number;
  leaseOwner?: string;
  leaseUntil?: string;
  lastError?: string;
  completedAt?: string;
  dedupeKey?: string;
  revision: number;
};

export type DeadLetterDoc = Doc & {
  orgId: string;
  sourceType: 'job' | 'outbox';
  sourceId: string;
  sourceKind: string;
  redactedFailure: string;
  firstFailedAt: string;
  lastFailedAt: string;
  attempts: number;
  status: 'open' | 'resolved';
  resolvedAt?: string;
  resolvedBy?: string;
  resolution?: string;
  revision: number;
};

export type DomainJobHandler = (job: DomainJobDoc) => Promise<void> | void;
const handlers = new Map<string, DomainJobHandler>();

export function registerDomainJobHandler(type: string, handler: DomainJobHandler) {
  if (!type.trim()) throw new Error('job type is required');
  handlers.set(type, handler);
  return () => handlers.delete(type);
}

export function domainJobDraft(input: {
  orgId: string;
  type: string;
  payload: Record<string, unknown>;
  runAt?: string;
  maxAttempts?: number;
  dedupeKey?: string;
  id?: string;
}): DomainJobDoc {
  if (!input.orgId || !input.type) throw new Error('orgId and job type are required');
  const at = nowIso();
  return {
    id: input.id ?? newId('job_'),
    orgId: input.orgId,
    type: input.type,
    payload: input.payload,
    status: 'queued',
    runAt: input.runAt ?? at,
    attempts: 0,
    maxAttempts: Math.max(1, Math.min(25, input.maxAttempts ?? 8)),
    dedupeKey: input.dedupeKey,
    createdAt: at,
    revision: 0,
  } as DomainJobDoc;
}

export function enqueueDomainJob(input: {
  orgId: string;
  type: string;
  payload: Record<string, unknown>;
  runAt?: string;
  maxAttempts?: number;
  dedupeKey?: string;
  id?: string;
}): DomainJobDoc {
  if (!input.orgId || !input.type) throw new Error('orgId and job type are required');
  if (input.dedupeKey) {
    const existing = listAllByOrg<DomainJobDoc>('domainJobs', input.orgId).find(
      (job) =>
        job.type === input.type &&
        job.dedupeKey === input.dedupeKey &&
        !['failed', 'cancelled'].includes(job.status),
    );
    if (existing) return existing;
  }
  const draft = domainJobDraft(input);
  return commitBatch({ upserts: [{ collection: 'domainJobs', doc: draft, expectedRevision: null, expectedOrgId: input.orgId }] })
    .upserts[0] as DomainJobDoc;
}

function claimOne(job: DomainJobDoc, workerId: string, now: number): DomainJobDoc | undefined {
  const leaseExpired = !job.leaseUntil || Date.parse(job.leaseUntil) <= now;
  if (job.status === 'running' && !leaseExpired) return undefined;
  if (!['queued', 'retry', 'running'].includes(job.status)) return undefined;
  if (Date.parse(job.runAt) > now) return undefined;
  const next = {
    ...job,
    status: 'running',
    attempts: job.attempts + 1,
    leaseOwner: workerId,
    leaseUntil: new Date(now + 5 * 60_000).toISOString(),
    lastError: undefined,
  } as DomainJobDoc;
  try {
    return commitBatch({
      upserts: [{ collection: 'domainJobs', doc: next, expectedRevision: Number(job.revision ?? 0), expectedOrgId: job.orgId }],
    }).upserts[0] as DomainJobDoc;
  } catch (error) {
    if (error instanceof Error && error.name === 'CommitConflictError') return undefined;
    throw error;
  }
}

export function claimDueDomainJobs(orgId: string, workerId: string, limit = 10, now = Date.now()): DomainJobDoc[] {
  const candidates = listAllByOrg<DomainJobDoc>('domainJobs', orgId)
    .filter((job) =>
      ['queued', 'retry', 'running'].includes(job.status) &&
      Date.parse(job.runAt) <= now &&
      (job.status !== 'running' || !job.leaseUntil || Date.parse(job.leaseUntil) <= now),
    )
    .sort((a, b) => a.runAt.localeCompare(b.runAt) || String(a.createdAt).localeCompare(String(b.createdAt)))
    .slice(0, Math.max(1, Math.min(50, limit)) * 3);
  const claimed: DomainJobDoc[] = [];
  for (const candidate of candidates) {
    const job = claimOne(candidate, workerId, now);
    if (job) claimed.push(job);
    if (claimed.length >= limit) break;
  }
  return claimed;
}

async function resolveHandler(type: string): Promise<DomainJobHandler | undefined> {
  const registered = handlers.get(type);
  if (registered) return registered;
  // Built-ins are loaded lazily so the document service does not enter the
  // scheduler's module graph until a scan/migration job is actually due.
  if (type === 'clinical-document.scan' || type === 'clinical-document.legacy-migrate') {
    const module = await import('./clinical-documents');
    return type === 'clinical-document.scan' ? module.runDocumentScanJob : module.runLegacyDocumentMigrationJob;
  }
  if (type === 'retention.preview') {
    const module = await import('./privacy-governance');
    return (job) => {
      module.createRetentionReviewManifest({
        orgId: job.orgId,
        actor: String(job.payload.actor ?? 'retention-worker'),
        asOf: job.payload.asOf ? String(job.payload.asOf) : undefined,
        limit: job.payload.limit === undefined ? undefined : Number(job.payload.limit),
      });
    };
  }
  if (type === 'automation.event') {
    const module = await import('./automations/runner');
    return module.runAutomationJob;
  }
  if (type === 'task.due') {
    const module = await import('./tasks');
    return module.runTaskDueJob;
  }
  if (type === 'referral.notification') {
    const module = await import('./referrals');
    return (job) => { module.runReferralNotificationJob(job); };
  }
  return undefined;
}

function redactFailure(value: string) {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[phone]')
    .replace(/(?:\/[A-Za-z0-9._-]+){2,}/g, '[path]')
    .slice(0, 2_000);
}

function finish(job: DomainJobDoc, patch: Partial<DomainJobDoc>, deadLetterError?: string): DomainJobDoc {
  const upserts: Array<{ collection: string; doc: Doc; expectedRevision: number | null; expectedOrgId: string }> = [
    {
      collection: 'domainJobs',
      doc: { ...job, ...patch, leaseOwner: undefined, leaseUntil: undefined } as DomainJobDoc,
      expectedRevision: Number(job.revision ?? 0),
      expectedOrgId: job.orgId,
    },
  ];
  if (deadLetterError) {
    const at = nowIso();
    upserts.push({
      collection: 'deadLetters',
      doc: {
        id: `dead_${job.id}`, orgId: job.orgId, sourceType: 'job', sourceId: job.id, sourceKind: job.type,
        redactedFailure: redactFailure(deadLetterError), firstFailedAt: at, lastFailedAt: at,
        attempts: job.attempts, status: 'open', createdAt: at,
      } as DeadLetterDoc,
      expectedRevision: null,
      expectedOrgId: job.orgId,
    });
  }
  const committed = commitBatch({ upserts });
  return committed.upserts.find((row) => row.id === job.id) as DomainJobDoc;
}

export function deadLettersFor(orgId: string, status: 'open' | 'resolved' | 'all' = 'open'): DeadLetterDoc[] {
  return listAllByOrg<DeadLetterDoc>('deadLetters', orgId)
    .filter((row) => status === 'all' || row.status === status)
    .sort((a, b) => b.lastFailedAt.localeCompare(a.lastFailedAt));
}

export function retryDeadLetter(input: {
  orgId: string;
  id: string;
  expectedRevision: number;
  actor: string;
  reason: string;
}): { deadLetter: DeadLetterDoc; job: DomainJobDoc } {
  const reason = input.reason.trim();
  if (reason.length < 12) throw new Error('a retry reason of at least 12 characters is required');
  const deadLetter = get<DeadLetterDoc>('deadLetters', input.id);
  if (!deadLetter || deadLetter.orgId !== input.orgId) throw new Error('dead letter not found');
  if (deadLetter.status !== 'open') throw new Error('dead letter is already resolved');
  if (Number(deadLetter.revision ?? 0) !== input.expectedRevision) throw new Error('dead letter changed after it was loaded');
  if (deadLetter.sourceType !== 'job') throw new Error('this dead-letter source cannot be retried automatically');
  const job = get<DomainJobDoc>('domainJobs', deadLetter.sourceId);
  if (!job || job.orgId !== input.orgId) throw new Error('source job not found');
  if (job.status !== 'failed') throw new Error('source job is no longer failed');
  const at = nowIso();
  const committed = commitBatch({ upserts: [
    {
      collection: 'domainJobs',
      doc: {
        ...job, status: 'queued', runAt: at, attempts: 0, lastError: undefined,
        leaseOwner: undefined, leaseUntil: undefined, completedAt: undefined,
      },
      expectedRevision: Number(job.revision ?? 0), expectedOrgId: input.orgId,
    },
    {
      collection: 'deadLetters',
      doc: {
        ...deadLetter, status: 'resolved', resolvedAt: at, resolvedBy: input.actor,
        resolution: `Retry approved: ${redactFailure(reason)}`,
      },
      expectedRevision: input.expectedRevision, expectedOrgId: input.orgId,
    },
  ] }).upserts;
  return {
    job: committed.find((row) => row.id === job.id) as DomainJobDoc,
    deadLetter: committed.find((row) => row.id === deadLetter.id) as DeadLetterDoc,
  };
}

export function resolveDeadLetter(input: {
  orgId: string;
  id: string;
  expectedRevision: number;
  actor: string;
  resolution: string;
}): DeadLetterDoc {
  const resolution = input.resolution.trim();
  if (resolution.length < 12) throw new Error('a resolution of at least 12 characters is required');
  const deadLetter = get<DeadLetterDoc>('deadLetters', input.id);
  if (!deadLetter || deadLetter.orgId !== input.orgId) throw new Error('dead letter not found');
  if (deadLetter.status !== 'open') throw new Error('dead letter is already resolved');
  if (Number(deadLetter.revision ?? 0) !== input.expectedRevision) throw new Error('dead letter changed after it was loaded');
  return commitBatch({ upserts: [{
    collection: 'deadLetters',
    doc: { ...deadLetter, status: 'resolved', resolvedAt: nowIso(), resolvedBy: input.actor, resolution: redactFailure(resolution) },
    expectedRevision: input.expectedRevision, expectedOrgId: input.orgId,
  }] }).upserts[0] as DeadLetterDoc;
}

export async function runDueDomainJobs(orgId: string, options: { workerId?: string; limit?: number; now?: number } = {}) {
  const workerId = options.workerId ?? `${process.pid}:${newId('worker_')}`;
  const now = options.now ?? Date.now();
  const jobs = claimDueDomainJobs(orgId, workerId, options.limit ?? 10, now);
  const result = { claimed: jobs.length, completed: 0, retried: 0, failed: 0, missingHandler: 0 };
  for (const job of jobs) {
    try {
      const handler = await resolveHandler(job.type);
      if (!handler) {
        result.missingHandler += 1;
        throw new Error(`no handler is registered for job type ${job.type}`);
      }
      await handler(job);
      finish(job, { status: 'completed', completedAt: nowIso(), lastError: undefined });
      result.completed += 1;
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
      const exhausted = job.attempts >= job.maxAttempts;
      const delayMinutes = Math.min(12 * 60, 2 ** Math.min(job.attempts, 10));
      finish(job, {
        status: exhausted ? 'failed' : 'retry',
        runAt: exhausted ? job.runAt : new Date(Date.now() + delayMinutes * 60_000).toISOString(),
        lastError: redactFailure(message),
      }, exhausted ? message : undefined);
      if (exhausted) result.failed += 1;
      else result.retried += 1;
    }
  }
  return result;
}
